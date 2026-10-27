/**
 * dsh-restart-autostart —— DSH 进程控制插件（node 半身）。
 *
 * 三条功能线，各自一个子模块：
 *   manual/    手动重启   —— 用户点按钮时，一次性重启当前宿主进程；
 *   guard/     重启守护   —— 写入系统自启条目，开机拉起并在崩溃后自动重启；
 *   upgrade/   一键升级   —— 检查 dsh 主程序新版并安全升级（备份 → 安装 → 校验 → 重启 → 确认）。
 *
 * 本文件做五件事：启动时确认上次升级是否成功、收敛一次自启条目、解析请求、校验来源、把动作委派给上述子模块。
 * 平台细节在 guard/service/ 下，重启细节在 manual/restart.js 里，升级细节在 upgrade/ 里。
 *
 * 路由（全部同源）：
 *   GET  /dsh-restart-autostart/health                  存活探针（前端轮询判断服务是否恢复）
 *   POST /dsh-restart-autostart/restart                 手动重启
 *   GET  /dsh-restart-autostart/autostart/status        读取自启状态
 *   POST /dsh-restart-autostart/autostart/enable        启用自启
 *   POST /dsh-restart-autostart/autostart/disable       停用自启
 *   GET  /dsh-restart-autostart/upgrade/status          读取升级状态（前端轮询进度）
 *   POST /dsh-restart-autostart/upgrade/check           强制查一次 GitHub 最新版
 *   POST /dsh-restart-autostart/upgrade/start           发起升级（异步，立即 202）
 *   POST /dsh-restart-autostart/upgrade/rollback        回滚到上次升级前版本
 *   POST /dsh-restart-autostart/upgrade/safe-mode/clear 退出安全模式（装回被隔离的插件并重启）
 *
 * @module dsh-restart-autostart
 */
import * as guard from './guard/index.js';
import { triggerRestart } from './manual/restart.js';
import * as upgrade from './upgrade/index.js';

/** cordis 服务注入：注册路由要用 ctx.webServer。 */
export const inject = ['webServer'];

/** 插件名（与 cordis 条目名、client bundle id 一致）。 */
export const name = 'dsh-restart-autostart';

/** 默认回退端口：请求 Host 头解析失败时使用。 */
const FALLBACK_PORT = 7923;

/**
 * 仅接受本机同源 POST，拒绝跨站请求。
 *
 * 重启与改自启都是破坏性/敏感操作，必须挡住浏览器里的第三方页面（CSRF）。
 * 校验两点：请求方法为 POST；Origin（或 Referer 回退）的主机是本机回环地址。
 * @param request - 传入的 HTTP 请求。
 * @returns 是否为可信请求。
 */
function isTrustedPost(request) {
  if (request.method !== 'POST') return false;
  const raw = request.headers.origin ?? request.headers.referer ?? '';
  if (raw === '') return true; // 非浏览器客户端（curl 等）不发 Origin，放行。
  try {
    const { hostname } = new URL(raw);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * 读取请求体（这些路由不需要内容，但需把流读完以正常结束连接）。
 * @param request - 传入的 HTTP 请求。
 * @returns 请求体文本。
 */
function readBody(request) {
  return new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) request.destroy();
    });
    request.on('end', () => resolve(data));
    request.on('error', () => resolve(''));
  });
}

/**
 * 读取并解析 JSON 请求体；解析失败返回空对象。
 *
 * 升级接口把目标版本放在 body 里（可选）。这里对错误一律宽容 —— 传了非法 JSON
 * 就当作「没指定版本」，回退到缓存里的最新版，而不是让整个请求失败。
 * @param request - 传入的 HTTP 请求。
 * @returns 解析出的对象。
 */
async function readJsonBody(request) {
  const raw = await readBody(request);
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 发送 JSON 响应。
 * @param response - 传出响应。
 * @param status - HTTP 状态码。
 * @param payload - 可序列化的响应体。
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

/**
 * 从请求 Host 头解析端口（如 localhost:3080 → 3080）。
 * @param request - 传入的 HTTP 请求。
 * @returns 端口号。
 */
function portFromRequest(request) {
  const host = request.headers.host ?? '';
  const match = host.match(/:(\d+)$/);
  return match ? Number(match[1]) : FALLBACK_PORT;
}

/**
 * 插件入口：注册四组路由。
 * @param ctx - cordis 宿主上下文。
 */
export function apply(ctx) {
  // 第一件事：确认上一次升级到底成没成。
  // 能执行到这里就是最强的证据 —— 新宿主起来了，插件树也加载到最后了
  // （加载中途失败的话本插件根本跑不到这一行）。所以这是升级闭环的判定点，
  // 必须在任何别的动作之前做，且它内部永不抛异常。详见 upgrade.reconcileAfterBoot。
  upgrade.reconcileAfterBoot();

  // 开头先做一次自愈收敛：宿主必然跑在「当前 node」上，是唯一能把条目里那个因 nvm
  // 升级而失效的 node 路径改回来的一方（守护做不到 —— 那正是启动它所需的东西）。
  // 只在真的改动时才写日志，且内部已兜住异常，不会影响插件加载。详见 guard.reconcileAll。
  guard.reconcileAll();

  // ── 手动重启 ────────────────────────────────────────────────────────
  // 存活探针：前端重启后轮询它判断服务是否已恢复。只读、无副作用。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/health',
    handler: (_request, response) => {
      sendJson(response, 200, { ok: true });
    },
  }), 'dsh-restart-autostart: health route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/restart',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: 'restart requires a same-origin POST' });
        return;
      }
      await readBody(request);
      const port = portFromRequest(request);
      // 先把响应发出去再孵化重启子进程：该子进程随即会 kill 掉本宿主，
      // 若先孵化，响应可能来不及 flush 就被中断，前端会看到一次无谓的失败。
      sendJson(response, 200, { ok: true, port });
      triggerRestart(port);
    },
  }), 'dsh-restart-autostart: restart route');

  // ── 重启守护（跟随系统启动）─────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/autostart/status',
    handler: (request, response) => {
      sendJson(response, 200, guard.status(portFromRequest(request)));
    },
  }), 'dsh-restart-autostart: autostart status route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/autostart/enable',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: 'enable requires a same-origin POST' });
        return;
      }
      await readBody(request);
      const port = portFromRequest(request);
      const result = guard.enable(port);
      sendJson(response, result.ok ? 200 : 500, { ...result, ...guard.status(port) });
    },
  }), 'dsh-restart-autostart: autostart enable route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/autostart/disable',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: 'disable requires a same-origin POST' });
        return;
      }
      await readBody(request);
      const port = portFromRequest(request);
      const result = guard.disable(port);
      sendJson(response, result.ok ? 200 : 500, { ...result, ...guard.status(port) });
    },
  }), 'dsh-restart-autostart: autostart disable route');

  // ── 一键升级（dsh 主程序）─────────────────────────────────────────────
  // 只读：前端在设置面板打开时轮询它，所以必须便宜（只读盘，不联网）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/upgrade/status',
    handler: (_request, response) => {
      sendJson(response, 200, upgrade.status());
    },
  }), 'dsh-restart-autostart: upgrade status route');

  // 显式点「检查更新」才走这里：联网查询最长 10s，不能塞进轮询。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/upgrade/check',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: 'check requires a same-origin POST' });
        return;
      }
      await readBody(request);
      const result = await upgrade.check({ force: true });
      // check 内部已兜住异常，用 ok 字段表达成败；这里再叠一次最新状态省一次往返。
      sendJson(response, 200, { ...result, status: upgrade.status() });
    },
  }), 'dsh-restart-autostart: upgrade check route');

  // 发起升级：**必须立刻返回**。安装 849MB 依赖要几十秒，同步等会把请求拖死，
  // 而前端本来也不靠这个响应判断结果（它轮询 status，再靠 /health 等重启恢复）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/upgrade/start',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: 'upgrade requires a same-origin POST' });
        return;
      }
      const body = await readJsonBody(request);
      const port = portFromRequest(request);
      const to = typeof body.to === 'string' && body.to !== '' ? body.to : null;
      // restart 由这里注入而不是在 upgrade/ 里 import：升级模块不该知道「怎么重启」，
      // 否则两处启动逻辑迟早各自漂移（manual/restart 已经踩过这个坑）。
      const result = upgrade.startUpgrade({ to, restart: () => { triggerRestart(port); } });
      sendJson(response, result.ok ? 202 : 409, { ...result, status: upgrade.status() });
    },
  }), 'dsh-restart-autostart: upgrade start route');

  // 手动回滚：升级后某个插件明显不兼容、但宿主还起得来时用。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/upgrade/rollback',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: 'rollback requires a same-origin POST' });
        return;
      }
      await readBody(request);
      const result = await upgrade.rollbackNow();
      sendJson(response, result.ok ? 200 : 500, { ...result, status: upgrade.status() });
    },
  }), 'dsh-restart-autostart: upgrade rollback route');

  // 退出安全模式：把被隔离的第三方 bundle 装回去。
  // 恢复 bundles 只有重启才生效，所以这里成功即顺手重启 —— 让「恢复插件」是**一次点击**，
  // 而不是「点恢复 → 再自己去点重启」。若恢复后仍起不来，guard 会再次判定进安全模式，
  // 用户拿到的是一个起得来的服务，而不是一个需要人工救砖的现场。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart-autostart/upgrade/safe-mode/clear',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: 'clear safe mode requires a same-origin POST' });
        return;
      }
      const body = await readJsonBody(request);
      const port = portFromRequest(request);
      // 允许只恢复、不重启（?restart=false / body.restart=false）：万一用户想先手动看一眼
      // profile 改成了什么，可以不让宿主立刻消失。
      const shouldRestart = body.restart !== false;
      const result = upgrade.clearSafeMode();
      sendJson(response, result.ok ? 200 : 500, { ...result, restarting: result.ok && shouldRestart, status: upgrade.status() });
      if (result.ok && shouldRestart) triggerRestart(port);
    },
  }), 'dsh-restart-autostart: upgrade safe-mode clear route');
}
