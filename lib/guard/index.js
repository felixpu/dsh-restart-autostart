/**
 * 重启守护 —— 「跟随系统启动」的宿主侧逻辑。
 *
 * 职责（本模块只管这些）：
 *   1. 提供查询/开关自启的能力；
 *   2. 把平台相关的注册动作**委派**给 service/ 下的对应模块；
 *   3. 组装状态对象，供前端渲染勾选框。
 *
 * 平台细节一律不在本文件里：
 *   service/launchd.js    macOS   LaunchAgent      ✅ 已实测
 *   service/systemd.js    Linux   systemd --user   ⚠️ 未实测
 *   service/winservice.js Windows Windows 服务     ⚠️ 未实测（且有已知阻塞）
 *
 * 端口与目录隔离（与既有 3080 生产守护并存，互不影响）：
 *   - 端口取自「当前宿主进程正在用的端口」，所以本插件只管自己这一份；
 *   - 所有落盘物统一放 ~/.dsh-restart-autostart/，不碰 ~/.dsh/ 与
 *     ~/Library/LaunchAgents/com.dsh.web.plist；
 *   - 条目标识按端口生成，因此同一台机器上多个端口可各有一份条目而不互相覆盖。
 *
 * @module dsh-restart-autostart/guard
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as launchd from './service/launchd.js';
import * as systemd from './service/systemd.js';
import * as winservice from './service/winservice.js';

/** 配置根目录：~/.dsh-restart-autostart/（用户目录下的点号目录）。 */
export const HOME_DIR = path.join(os.homedir(), '.dsh-restart-autostart');

/** 日志目录：~/.dsh-restart-autostart/logs/。 */
export const LOG_DIR = path.join(HOME_DIR, 'logs');

/** 收敛日志：只在真的改动了什么时才写一行。 */
const RECONCILE_LOG = path.join(LOG_DIR, 'reconcile.log');

/**
 * 运行体的稳定落点：`~/.dsh-restart-autostart/guard.mjs`。
 *
 * 注册文件（plist / .service / sc.exe 服务）里写的是**绝对路径**，所以它引用谁，
 * 谁就得长期稳定存在。若直接引用包内的 `lib/guard/guard.js`，路径会随安装方式漂移：
 *   - `link:` 依赖下 Node ESM 会对软链做 realpath —— `~/.dsh/profiles/<p>/node_modules/
 *     dsh-restart-autostart` 是个软链，realpath 后路径会落到开发仓库（本机实测即如此）；
 *   - 普通安装在 pnpm 重装、profile 布局变化、换 profile、插件升级后同样可能变。
 * 因此把运行体固定拷到本插件自己的家目录，注册文件只引用它 ——
 * 三平台于是收敛成同一对路径（node + 这一个文件），与安装方式彻底解耦。
 *
 * 用 `.mjs` 而非 `.js` 是硬要求：`~/.dsh-restart-autostart/` 下及其上层都没有 package.json，
 * 若叫 `.js`，Node 会按 CommonJS 解析，而运行体是纯 ESM（含 import 语句）→ 直接报错。
 */
export const RUNTIME_GUARD = path.join(HOME_DIR, 'guard.mjs');

/** 随包分发的那一份 guard 实现，仅作安装源，永不写进注册文件。 */
function packagedGuardPath() {
  return fileURLToPath(new URL('guard.js', import.meta.url));
}

/** 确保 ~/.dsh-restart-autostart/ 与 logs/ 存在。 */
function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * 把运行体安装（或刷新）到 {@link RUNTIME_GUARD}。
 *
 * 幂等：内容一致就不重写，避免无谓地改动 mtime。
 * 顺带赋 0755 —— launchd 直接执行它，权限不够会静默失败。
 * @returns 安装后的绝对路径。
 */
export function installGuardRuntime() {
  ensureDirs();
  const code = fs.readFileSync(packagedGuardPath(), 'utf8');
  let current = null;
  try {
    current = fs.readFileSync(RUNTIME_GUARD, 'utf8');
  } catch {
    // 目标不存在：正常情况，走下面的写入分支。
  }
  if (current !== code) {
    fs.writeFileSync(RUNTIME_GUARD, code, { mode: 0o755 });
  }
  return RUNTIME_GUARD;
}

/** 平台 → 注册器的映射。新增平台只需在此登记。 */
const REGISTRY = {
  darwin: launchd,
  linux: systemd,
  win32: winservice,
};

/**
 * 取当前平台的自启注册器。
 * @returns 注册器模块，平台不支持时为 undefined。
 */
function backend() {
  return REGISTRY[process.platform];
}

/**
 * 同步执行一条命令，返回退出码与输出。
 *
 * 自启注册/注销都是毫秒级操作，且需要立刻知道成败，故用同步执行简化流程。
 * 一律走 execFile 语义（不经 shell），既避免注入，也让 Windows 的 .exe 可直接调用。
 * @param command - 可执行文件。
 * @param args - 参数数组。
 * @returns `{ code, stdout, stderr }`。
 */
function run(command, args) {
  const out = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return {
    code: out.status ?? 1,
    stdout: out.stdout ?? '',
    stderr: out.stderr ?? '',
  };
}

/**
 * 自启注册文件里应当引用的 guard 运行体路径。
 *
 * 返回 {@link RUNTIME_GUARD}（`~/.dsh-restart-autostart/guard.mjs`）这个稳定落点，
 * **不是**包内的那一份 —— 后者会随 `link:` realpath / pnpm 重装 / 换 profile 漂移，
 * 写进注册文件后，下次开机 launchd 就会去执行一个不存在的文件。
 * 注册前请先调用 {@link installGuardRuntime} 确保它已就位。
 * @returns 运行体的绝对路径。
 */
export function guardScriptPath() {
  return RUNTIME_GUARD;
}

/**
 * 组装传给注册器的路径参数。
 * @returns `{ node, guard, logDir }` 绝对路径。
 */
function pathOptions() {
  return { node: process.execPath, guard: guardScriptPath(), logDir: LOG_DIR };
}

/**
 * 查询某端口当前是否有自启条目已注册（只读，不修改任何东西）。
 * @param port - 服务端口。
 * @returns 条目是否已注册。
 */
export function isRegistered(port) {
  const impl = backend();
  if (!impl) return false;
  // Windows 的 sc.exe 查询需要 run 注入，另两平台不需要。
  if (impl === winservice) return impl.isRegistered(port, run);
  return impl.isRegistered(port);
}

/**
 * 清理「其它端口」的自启条目，只保留 `keepPort`。
 *
 * 为什么需要：条目名里只有端口，没有 profile —— 用户先在 3080 勾选、后来换了端口
 * 又勾一次，就会留下两条。开机时 launchd 各拉起一个守护，两者抢同一个 dsh 端口、
 * 抢同一把 `.credentials.yaml` 写锁，正是那种「两套守护互相干扰」的死局。
 * 产品上按「一个用户只跑一个 dsh」约束，所以启用新端口时直接清掉旧的。
 * 各平台注册器把「枚举已有条目」实现为 `listPorts()`；未实现的平台返回空数组，
 * 于是这里什么都不做 —— 保守但安全。
 * @param keepPort - 要保留的端口。
 * @returns 被成功清理掉的端口数组（升序）。
 */
export function pruneOtherPorts(keepPort) {
  const impl = backend();
  if (!impl || typeof impl.listPorts !== 'function') return [];
  const removed = [];
  for (const port of impl.listPorts()) {
    if (port === keepPort) continue;
    if (impl.disable(port, pathOptions(), run).ok) removed.push(port);
  }
  return removed;
}

/**
 * 追加一行收敛日志；写不进去就放弃（日志失败不该影响主流程）。
 * @param line - 日志内容。
 */
function writeReconcileLog(line) {
  try {
    ensureDirs();
    fs.appendFileSync(RECONCILE_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // 忽略：收敛本身已经完成，日志只是留下的痕迹。
  }
}

/**
 * 读文件内容，读不到返回 null（用于比对「是否真的变了」）。
 * @param file - 绝对路径。
 * @returns 内容或 null。
 */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 收敛所有既有条目：把因运行时升级而**失效**的路径改回当前值，并刷新运行体。
 *
 * 为什么必须放在**宿主侧**，而不是守护自己去做：条目里记的 node 路径一旦被删
 * （nvm 升级后卸掉旧版本），launchd 连守护脚本都拉不起来，守护自然无从回写 —— 鸡生蛋。
 * 而宿主此刻必然跑在「当前 node」上，是唯一有能力把该路径改对的一方。
 * 挂载点是插件 apply()，即每次宿主启动时检查一次。
 *
 * 顺带刷新运行体：插件升级后 ~/.dsh-restart-autostart/guard.mjs 可能还是旧代码，而注册文件
 * 引用的正是它 —— 不刷新的话，重启后跑起来的仍是上一版守护。
 *
 * 只在真的发生改动时写日志，且**永不抛异常**：自愈失败不该拦住宿主把插件加载完。
 * @returns 各端口的收敛结果（含未动作者）；异常时为空数组。
 */
export function reconcileAll() {
  try {
    const impl = backend();
    if (!impl || typeof impl.listPorts !== 'function') return [];

    const bodyBefore = readOrNull(RUNTIME_GUARD);
    installGuardRuntime();
    if (readOrNull(RUNTIME_GUARD) !== bodyBefore) {
      writeReconcileLog(`运行体已刷新为当前插件版本：${RUNTIME_GUARD}`);
    }

    if (typeof impl.reconcile !== 'function') return [];
    const results = [];
    for (const port of impl.listPorts()) {
      const result = impl.reconcile(port, pathOptions(), run);
      results.push({ port, ...result });
      if (result.changed) writeReconcileLog(`端口 ${port}：${result.detail}`);
    }
    return results;
  } catch (error) {
    writeReconcileLog(`收敛异常：${error && error.stack ? error.stack : String(error)}`);
    return [];
  }
}

/**
 * 启用自启：委派给当前平台的注册器。
 * @param port - 服务端口。
 * @returns `{ ok, detail, pruned }`。
 */
export function enable(port) {
  const impl = backend();
  if (!impl) return { ok: false, detail: `不支持的平台：${process.platform}` };
  // 先把运行体落到稳定位置，再写注册文件 —— 顺序反了会注册出一个指向空路径的条目。
  installGuardRuntime();
  // 同一时刻只保留当前端口这一条。
  const pruned = pruneOtherPorts(port);
  const result = impl.enable(port, pathOptions(), run);
  const notes = [`运行体 ${RUNTIME_GUARD}`];
  if (pruned.length > 0) notes.push(`已清理其它端口条目：${pruned.join(', ')}`);
  // 把运行体路径回报给上层：条目一旦悬空，这是第一个该被检查的东西。
  return { ...result, detail: `${result.detail}；${notes.join('；')}`, pruned };
}

/**
 * 停用自启：委派给当前平台的注册器。
 * @param port - 服务端口。
 * @returns `{ ok, detail }`。
 */
export function disable(port) {
  const impl = backend();
  if (!impl) return { ok: false, detail: `不支持的平台：${process.platform}` };
  return impl.disable(port, pathOptions(), run);
}

/**
 * 汇总自启状态，供前端渲染勾选框。
 * @param port - 服务端口。
 * @returns 状态对象。
 */
export function status(port) {
  const impl = backend();
  return {
    ok: true,
    enabled: isRegistered(port),
    platform: process.platform,
    port,
    unit: impl ? impl.unitId(port) : null,
    homeDir: HOME_DIR,
    logDir: LOG_DIR,
    nodePath: process.execPath,
    guardPath: guardScriptPath(),
    supported: Boolean(impl),
    /**
     * 该平台注册器是否已在真机验证过。
     * macOS 为 true；Linux / Windows 为 false —— 前端据此显示「未实测」提示，
     * 避免让人误以为三平台都验证过了。
     */
    verified: impl ? impl.verified : false,
  };
}
