/**
 * 一键升级 —— 把「检查 → 备份 → 安装 → 校验 → 重启 → 确认」串成一条可观测的状态机。
 *
 * 这是插件里唯一会**改动 dsh 主程序**的地方，因此设计上有两条硬约束：
 *
 * 1. **不阻塞 HTTP。** 安装 849MB 依赖要几十秒，远超任何合理的请求超时。
 *    升级在后台跑，路由立刻返回 202，前端轮询 /upgrade/status 看阶段。
 * 2. **结果必须能跨进程存活。** 升级的最后一步是重启宿主 —— 本进程随即消失，
 *    内存在那一刻全丢。所以「成功」不能由这里判定，而由**重启后的新宿主**判定：
 *    新宿主加载到本插件的 apply() 时调用 {@link reconcileAfterBoot}，
 *    看到 pending 里记的 `to` 等于自己正在跑的版本，才算这次升级真的成了。
 *    反之宿主反复起不来，由 guard.js 读到 pending 自动回滚。
 *
 * 这条闭环的意义：判据是「服务真的起来了」，而不是「npm 说装好了」。
 * 后者在「装到了别的前缀」「依赖装坏」「插件不兼容」三种情况下都会骗人。
 *
 * @module dsh-restart-autostart/upgrade
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HOME_DIR,
  PKG,
  cmpVersion,
  dshPackageDir,
  latestRelease,
  localVersion,
  prefixDir,
  readCache,
} from './version.js';
import {
  backup,
  clearPending,
  install,
  readPending,
  rollback,
  verifyL1,
  writePending,
} from './install.js';

/** 升级流水账，长期保留（不在退出时清理，用于事后追查）。 */
const UPGRADE_LOG = path.join(HOME_DIR, 'logs', 'upgrade.log');

/** 最近一次结果，落盘以便重启后仍能告诉用户「上次升级怎么样了」。 */
const LAST_FILE = path.join(HOME_DIR, 'upgrade-last.json');

/**
 * 安全模式状态文件 —— 由 guard.js 在「新版本起不来」时写入。
 *
 * ⚠️ 与 `lib/guard/guard.js` 的 `SAFE_MODE_FILE` **逐字一致**（那边是运行体，
 * 不能 import 本模块，所以两边各存一份常量；改一边必须改两边）。
 */
const SAFE_MODE_FILE = path.join(HOME_DIR, 'safe-mode.json');

/**
 * 当前 profile 的 package.json —— 安全模式的隔离就写在这里的 `dsh.profile.bundles`。
 * 同样是 guard.js 里 PROFILE_PACKAGE 的镜像。
 */
const PROFILE_PACKAGE = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'package.json');

/** 进入这些阶段即视为「有升级在跑」，用来挡住并发点击。 */
const ACTIVE_PHASES = new Set(['backup', 'install', 'verify', 'restarting']);

/** 内存里的状态机。进程重启即重置，符合「一次升级一个生命周期」。 */
const task = {
  phase: 'idle',
  from: null,
  to: null,
  error: '',
  startedAt: 0,
  finishedAt: 0,
  lines: [],
  // 下面两项只用于落盘「最近一次结果」：升级成功后 pending 会被 apply() 清掉，
  // 那时若用户还想回滚（新版本能起、但某个插件功能异常），就只剩这份记录可依。
  backupDir: '',
  prefix: '',
};

/**
 * 追加一行流水账：同时进内存（给前端看实时进度）与日志文件（供事后追查）。
 * @param line - 日志内容。
 */
function note(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  task.lines.push(stamped);
  // 只留最近 120 行：一次失败可能刷出上百行 npm 输出，全留着没有意义。
  if (task.lines.length > 120) task.lines = task.lines.slice(-120);
  try {
    fs.mkdirSync(path.dirname(UPGRADE_LOG), { recursive: true });
    fs.appendFileSync(UPGRADE_LOG, `${stamped}\n`, 'utf8');
  } catch {
    // 日志失败不影响升级本身。
  }
}

/**
 * 切换阶段，并在进入终态时落盘「最近一次结果」。
 * @param phase - 目标阶段。
 * @param patch - 附带字段（from / to / error）。
 */
function setPhase(phase, patch = {}) {
  task.phase = phase;
  Object.assign(task, patch);
  if (phase === 'done' || phase === 'failed' || phase === 'rolled-back') {
    task.finishedAt = Date.now();
    saveLast();
  }
}

/** 把最近一次结果写盘；写不进去就算了，只是少一个提示。 */
function saveLast() {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(LAST_FILE, `${JSON.stringify({
      phase: task.phase,
      from: task.from,
      to: task.to,
      error: task.error,
      backupDir: task.backupDir,
      prefix: task.prefix,
      at: new Date(task.finishedAt || Date.now()).toISOString(),
    }, null, 2)}\n`, 'utf8');
  } catch {
    // 忽略。
  }
}

/** 读取上次结果。 */
function readLast() {
  try {
    return JSON.parse(fs.readFileSync(LAST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 读安全模式状态。未进入过（或文件损坏）返回 null。
 *
 * 安全模式由 **guard** 写入、由本模块消费与解除 —— 这是因为触发它的时刻宿主已经
 * 起不来，插件根本不在场；而解除它必须由用户从界面发起，只能在插件里做。
 * @returns `{ at, from, to, removed, originalBundles, suspects, diagnostic }` 或 null。
 */
export function safeMode() {
  try {
    const data = JSON.parse(fs.readFileSync(SAFE_MODE_FILE, 'utf8'));
    if (data === null || typeof data !== 'object' || !Array.isArray(data.removed)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 退出安全模式：把 `dsh.profile.bundles` 恢复成进入前的原始列表。
 *
 * 用状态文件里存的 **`originalBundles` 整份写回**，而不是「把 removed 逐个插回」：
 * bundles 是**有序**的（顺序决定 patch 层叠顺序），按名字插回必然丢失原始顺序，
 * 轻则行为变化、重则覆盖关系反转。
 *
 * 注意这不保证一定能起来 —— 肇事插件也一起回来了。若仍失败，guard 会再次判定
 * 并重新进入安全模式，用户不会因此得到一个起不来的服务。
 *
 * @returns `{ ok, detail, restored? }`。
 */
export function clearSafeMode() {
  const state = safeMode();
  if (state === null) return { ok: false, detail: '当前不在安全模式' };

  const original = state.originalBundles;
  if (!Array.isArray(original) || original.length === 0) {
    // 状态文件被改坏时不猜：宁可让用户手工处理，也不要写出一份可疑的 bundles。
    return { ok: false, detail: '安全模式状态里缺少原始 bundles 记录，请手工编辑 profile 的 package.json' };
  }

  try {
    const raw = fs.readFileSync(PROFILE_PACKAGE, 'utf8');
    const pkg = JSON.parse(raw);
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = original.slice();
    fs.writeFileSync(PROFILE_PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { ok: false, detail: `恢复 profile package.json 失败：${error && error.message ? error.message : String(error)}` };
  }

  try {
    fs.rmSync(SAFE_MODE_FILE, { force: true });
  } catch {
    // 删不掉也要往下走：bundles 已恢复，下次 guard 因状态文件存在而不进安全模式，
    // 用户还能再点一次。
  }

  note(`已退出安全模式，恢复 ${original.length} 个 bundle`);
  return { ok: true, detail: `已恢复 ${original.length} 个 bundle，需重启生效`, restored: original.length };
}

/** 取输出末尾若干行，用于错误提示（完整输出太长，前端放不下）。 */
function tail(text, lines = 6) {
  const parts = String(text ?? '').trim().split(/\r?\n/).filter((line) => line !== '');
  return parts.slice(-lines).join('\n');
}

/** 是否有升级正在跑。 */
export function isBusy() {
  return ACTIVE_PHASES.has(task.phase);
}

/**
 * 汇总升级相关的全部状态，供前端轮询。
 *
 * `hasUpdate` 为 null 表示**还不知道**（从未检查过，或缓存已过期且尚未成功查询），
 * 前端据此区分「没有新版」和「还没查」，避免把未知显示成「已是最新」。
 *
 * @returns 状态对象。
 */
export function status() {
  const current = localVersion();
  const cache = readCache();
  const hasCache = cache !== null && typeof cache.latest === 'string';
  const hasUpdate = hasCache && current !== null ? cmpVersion(cache.latest, current) > 0 : null;

  return {
    ok: true,
    current,
    latest: hasCache ? cache.latest : null,
    tag: hasCache ? cache.tag : null,
    publishedAt: hasCache ? cache.publishedAt : null,
    checkedAt: hasCache ? cache.checkedAt : null,
    hasUpdate,
    // 目标版本是「比当前新」才有意义；缓存里存着一个比当前旧的值（例如用户手动
    // 降级过）时不该继续提示升级。
    target: hasUpdate === true ? cache.latest : null,
    phase: task.phase,
    error: task.error,
    busy: isBusy(),
    // 本轮升级的起点（毫秒）。前端用它算「已等待 Ns」—— 只靠前端自己按下按钮时记时间，
    // 一旦用户中途刷新，秒数就会从 0 重来，看起来像刚开始，反而加剧「是不是卡住了」的疑虑。
    startedAt: task.startedAt || null,
    lines: task.lines.slice(-12),
    pending: readPending(),
    last: readLast(),
    // 安全模式：guard 在「新版本起不来」时写的状态。非 null 说明当前宿主跑的是
    // 官方最小集，第三方插件被临时停用了 —— UI 必须把这件事说清楚。
    safeMode: safeMode(),
    // 把实际安装路径暴露出来：排查「升级装到哪儿了」时这是第一个要看的东西。
    packageDir: dshPackageDir(),
    prefix: prefixDir(),
  };
}

/**
 * 查询 GitHub 最新版本。
 * @param force - true 时忽略 6 小时缓存强制联网。
 * @returns `{ ok, latest, tag, publishedAt, cached }`；失败时带 `error` 而不抛异常。
 */
export async function check({ force = false } = {}) {
  try {
    const info = await latestRelease({ force });
    note(`检查更新：GitHub 最新 ${info.latest}${info.cached ? '（缓存）' : ''}`);
    return { ok: true, ...info };
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    note(`检查更新失败：${detail}`);
    return { ok: false, error: detail };
  }
}

/**
 * 发起一次升级（异步执行，立即返回）。
 *
 * 调用方（路由）在拿到 `ok: true` 后应直接回 202，由前端轮询进度。
 * `restart` 由调用方注入 —— 升级模块不该知道「怎么重启」（那是 manual/ 的职责），
 * 这样两处的启动逻辑不会各自漂移。
 *
 * @param options - `{ to, restart }`：`to` 为目标版本（省略则用缓存里的最新版）。
 * @returns `{ ok, from?, to?, error? }`。
 */
export function startUpgrade({ to = null, restart }) {
  if (isBusy()) return { ok: false, error: '已有升级正在进行' };

  const current = localVersion();
  if (current === null) return { ok: false, error: '读不到当前 dsh 版本（主程序目录不存在？）' };

  const cache = readCache();
  const target = typeof to === 'string' && to !== '' ? to : (cache !== null ? cache.latest : null);
  if (target === null || target === '') return { ok: false, error: '还没有版本信息，请先检查更新' };

  const order = cmpVersion(target, current);
  if (order === 0) return { ok: false, error: `当前已是 ${current}` };
  if (order < 0) return { ok: false, error: `目标版本 ${target} 低于当前 ${current}，本功能不支持降级` };

  task.from = current;
  task.to = target;
  task.error = '';
  task.startedAt = Date.now();
  task.finishedAt = 0;
  task.lines = [];
  setPhase('backup', { from: current, to: target, error: '' });

  // 故意不 await：HTTP 响应必须先出去，否则安装几十秒会把请求拖死。
  void runUpgrade({ current, target, restart });
  return { ok: true, from: current, to: target };
}

/**
 * 升级主流程：备份 → 安装 → L1 → 写 pending → 重启。
 *
 * 任何一步失败都必须让状态机停在可解释的终态，并且**绝不把宿主置于半装状态**：
 *   - 安装失败 / L1 失败 ⇒ 立即回滚到旧版，不重启（旧进程还在跑，用户几乎无感）；
 *   - 全部通过 ⇒ 先写 pending 再重启，把「到底行不行」交给真实启动去回答。
 *
 * @param context - `{ current, target, restart }`。
 */
async function runUpgrade({ current, target, restart }) {
  let backupDir = '';
  let prefix = '';

  try {
    note(`开始升级 ${current} → ${target}`);
    backupDir = backup(current);
    task.backupDir = backupDir;
    note(`已备份主程序代码到 ${backupDir}`);

    setPhase('install');
    note(`执行 npm install -g ${PKG}@${target}`);
    const installed = await install(target);
    prefix = installed.prefix;
    task.prefix = prefix;
    if (!installed.ok) {
      note(`安装失败，输出尾部：\n${tail(installed.output)}`);
      await recover({ current, target, backupDir, prefix, reason: 'npm 安装失败' });
      return;
    }
    note(`已安装到前缀 ${prefix}`);

    setPhase('verify');
    const level1 = await verifyL1(target);
    if (!level1.ok) {
      note(`L1 校验失败：${level1.detail}`);
      await recover({ current, target, backupDir, prefix, reason: level1.detail });
      return;
    }
    note(`L1 通过：${level1.detail}`);

    writePending({ from: current, to: target, prefix, backupDir, at: new Date().toISOString() });
    note('已写入待验证状态；重启宿主以确认插件树可用');
    setPhase('restarting');

    // 先把响应相关的活干完再重启：restart() 最终会 kill 掉本进程。
    restart();
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    note(`升级异常：${detail}`);
    await recover({ current, target, backupDir, prefix, reason: detail });
  }
}

/**
 * 失败收尾：回滚到旧版并停在终态。
 *
 * 注意此时**没有写 pending**（写到那一步就说明已通过 L1），所以 guard 不会介入，
 * 回滚完全由本进程完成 —— 旧宿主还在跑，用户看到的只是一条错误提示。
 *
 * @param context - `{ current, target, backupDir, prefix, reason }`。
 */
async function recover({ current, target, backupDir, prefix, reason }) {
  setPhase('failed', { error: reason });
  note('尝试回滚到旧版本');
  const result = await rollback({
    from: current,
    to: target,
    backupDir,
    prefix,
    at: new Date().toISOString(),
  });
  note(`回滚结果（${result.ok ? '成功' : '失败'}）：${result.detail}`);
  if (result.ok) {
    setPhase('rolled-back', { error: reason });
    return;
  }
  // 回滚也没成：这是最坏情况，提示语里必须说清「需要人工介入」，别给假安心。
  setPhase('failed', { error: `${reason}；回滚未完全成功，需要人工介入` });
}

/**
 * 手动回滚到上一个版本（用户点「回滚」时用）。
 *
 * 两个来源，优先级有序：
 *   1. `upgrade-pending.json` —— 升级已装好但还没被新宿主证实，最准确的现场；
 *   2. `upgrade-last.json` 里的 done 记录 —— 升级成功后 pending 已被 apply() 清掉，
 *      但用户仍可能想退回去（典型：新版本起得来，某个第三方插件却功能异常）。
 *      没有这一条，「回滚」按钮在真正需要它的时候恰好是灰的。
 *
 * @returns `{ ok, detail? }`。
 */
export async function rollbackNow() {
  if (isBusy()) return { ok: false, detail: '升级正在进行，结束后再回滚' };

  let target = readPending();
  if (target === null) {
    const last = readLast();
    if (last !== null && last.phase === 'done' && typeof last.from === 'string' && last.from !== '') {
      target = {
        from: last.from,
        to: last.to,
        prefix: last.prefix,
        backupDir: last.backupDir,
        at: last.at,
      };
    }
  }
  if (target === null) return { ok: false, detail: '没有可回滚的升级记录' };

  note(`用户手动回滚 ${target.from} ← ${target.to}`);
  const result = await rollback(target);
  setPhase(result.ok ? 'rolled-back' : 'failed', {
    from: target.to,
    to: target.from,
    error: result.ok ? '' : result.detail,
  });
  note(`回滚结果：${result.detail}`);
  return result;
}

/**
 * 宿主启动后确认上一次升级是否真的成功 —— **升级闭环的判定点**。
 *
 * 在 apply() 里调用。能执行到这里，本身就是一个强证据：说明新宿主进程起来了、
 * 插件树加载到最后了（加载中途失败的话本插件根本跑不到）。
 *
 * 三种情形：
 *   - 有 pending 且 `to` 等于当前版本 ⇒ 升级成功，清 pending，返回 verified；
 *   - 有 pending 但版本不符 ⇒ 装到了别处或又被人改回去，清 pending 并报不一致
 *     （不清的话 guard 会在下次启动失败时回滚到一个早已不存在的状态）；
 *   - 无 pending ⇒ 普通启动，什么都不做。
 *
 * 这个函数**永不抛异常**：升级记账失败绝不能拦住宿主把插件加载完。
 *
 * @returns `{ verified, version, expect? }` 或 null。
 */
export function reconcileAfterBoot() {
  try {
    const pending = readPending();
    if (pending === null) return null;

    const current = localVersion();
    if (current === pending.to) {
      clearPending();
      setPhase('done', { from: pending.from, to: current, error: '' });
      note(`升级已验证：新宿主以 ${current} 启动（此前 ${pending.from}）`);
      // 在安全模式里启动 = 新版本能跑，但 guard 为此摘掉了若干插件。
      // 「升级成功」这句话在这种情形下只说了一半，必须把另一半也写进流水账，
      // 否则事后翻日志会以为一切都好。
      const degraded = safeMode();
      if (degraded !== null) {
        const count = Array.isArray(degraded.removed) ? degraded.removed.length : 0;
        note(`注意：当前处于安全模式，${count} 个第三方插件被临时停用，需在界面上「恢复插件」`);
      }
      return { verified: true, version: current, safeMode: degraded !== null };
    }

    clearPending();
    const detail = `升级未生效：期望 ${pending.to}，实际 ${current}`;
    setPhase('failed', { error: detail });
    note(detail);
    return { verified: false, version: current, expect: pending.to };
  } catch (error) {
    note(`升级记账异常：${error && error.message ? error.message : String(error)}`);
    return null;
  }
}
