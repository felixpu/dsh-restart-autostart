/**
 * Windows 注册器：把守护注册为 Windows 服务。
 *
 * ⚠️ 未在真机验证 —— 本模块从未在 Windows 上执行过。
 *
 * ────────────────────────────────────────────────────────────────────────
 * ⚠️ 已知阻塞问题（未解决）：SCM 握手缺失
 * ────────────────────────────────────────────────────────────────────────
 * Windows 服务进程必须实现 Service Control Manager 的握手协议：
 *   进程启动后须在 30 秒内调用 StartServiceCtrlDispatcher() 注册 ServiceMain
 *   回调，并上报 SERVICE_RUNNING。普通 node 脚本不实现该协议。
 *
 * 本模块当前用 `sc.exe create` 直接注册 `node guard.js`，**这会失败**：
 *   SCM 在 30 秒内收不到握手 → 判定启动失败（错误 1053）
 *   → 按恢复策略反复重启 → 形成无限重启循环。
 *
 * 因此本模块在 Windows 上**尚不可用**。要真正可用，需二选一：
 *
 *   方案 A（推荐）：引入 node-windows / winser 之类的包装器。
 *     它们内含一个实现了 SCM 握手的小 exe，由它再拉起 node。
 *     代价：引入第三方依赖；安装服务需管理员权限。
 *
 *   方案 B：退回「任务计划程序」（schtasks）。
 *     代价：失去「无用户登录也运行」的能力，且无原生的失败重启语义。
 *
 * 在选定方案之前，Windows 平台的 enable() 会主动返回失败并说明原因，
 * 而不是留下一个会无限重启的坏服务。
 * ────────────────────────────────────────────────────────────────────────
 *
 * 另需注意「服务身份隔离」问题：Windows 服务默认以 LocalSystem 运行，此时
 *   HOME = C:\Windows\System32\config\systemprofile（不是用户目录）
 *   → 找不到 ~/.dsh 配置、找不到 nvm 安装的 node。
 * 因此所有路径都显式传绝对路径（node / guard / 日志目录），不依赖环境变量推断。
 *
 * @module dsh-restart-autostart/guard/service/winservice
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 平台标识。 */
export const platform = 'win32';

/** 本机未实测，且存在已知阻塞问题，前端据此显示提示。 */
export const verified = false;

/** 配置根目录：用户目录下的点号目录。 */
const HOME_DIR = path.join(os.homedir(), '.dsh-restart-autostart');

/**
 * 生成服务名。
 * @param port - 服务端口。
 * @returns 服务名。
 */
export function unitId(port) {
  return `dsh-restart-autostart-${port}`;
}

/**
 * SCM 握手是否已实现。当前恒为 false —— 见文件头说明。
 * @returns 始终返回 false。
 */
export function scmHandshakeImplemented() {
  return false;
}

/**
 * 查询条目是否已注册（只读）。
 * @param port - 服务端口。
 * @param run - 同步执行命令的函数。
 * @returns 是否已注册。
 */
export function isRegistered(port, run) {
  const out = run('sc.exe', ['query', unitId(port)]);
  return out.code === 0;
}

/**
 * 列出本机已存在的自启条目端口。
 *
 * **本平台暂未实现，恒返回空数组** —— 上层据此就什么也不清理，属安全的保守行为。
 * 要补齐得先 `sc.exe query` 枚举全部服务再按 `dsh-restart-autostart-` 前缀过滤，
 * 而本模块的 SCM 握手尚缺（见顶部说明），此刻补枚举没有意义。
 * @returns 恒为空数组。
 */
export function listPorts() {
  return [];
}

/**
 * 启用：注册并启动 Windows 服务。
 *
 * 当前实现会在真正调用 sc.exe 之前直接失败，因为缺少 SCM 握手会产出一个
 * 「启动失败并被无限重启」的坏服务——这比明确报错更糟。
 * @param port - 服务端口。
 * @param options - `{ node, guard, logDir }` 绝对路径。
 * @param run - 同步执行命令的函数。
 * @returns `{ ok: false, detail }`。
 */
export function enable(port, options, run) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const id = unitId(port);
  if (!scmHandshakeImplemented()) {
    return {
      ok: false,
      detail:
        `Windows 平台暂不可用：注册 Windows 服务需要实现 SCM 握手 ` +
        `（StartServiceCtrlDispatcher），当前 guard.js 未实现。` +
        `直接注册会被 SCM 判定启动失败（错误 1053）并无限重启。` +
        `需先选定方案：A) 引入 node-windows 类包装器（需管理员权限）；` +
        `B) 退回任务计划程序。服务名 ${id}，node=${options.node}。`,
    };
  }
  for (const [cmd, args] of serviceCommands(port, options)) {
    const out = run(cmd, args);
    if (out.code !== 0 && !/already exists|已存在/i.test(out.stderr + out.stdout)) {
      return { ok: false, detail: `${cmd} 失败：${out.stderr.trim() || out.stdout.trim()}` };
    }
  }
  const start = run('sc.exe', ['start', id]);
  if (start.code !== 0 && !/already been started|已经启动/i.test(start.stderr + start.stdout)) {
    return { ok: false, detail: `sc start 失败：${start.stderr.trim() || start.stdout.trim()}` };
  }
  return { ok: true, detail: `已注册并启动服务 ${id}` };
}

/**
 * 生成服务注册命令（仅在 SCM 握手实现后才可调用）。
 * @param port - 服务端口。
 * @param options - `{ node, guard }` 绝对路径。
 * @returns 命令数组，每项为 `[command, args]`。
 */
export function serviceCommands(port, options) {
  const id = unitId(port);
  return [
    [
      'sc.exe',
      [
        'create',
        id,
        'binPath=',
        `"${options.node}" "${options.guard}" --port ${port}`,
        'start=',
        'auto',
      ],
    ],
    ['sc.exe', ['description', id, `DSH Web autostart guard (port ${port})`]],
    // 崩溃恢复：前两次失败隔 2 秒重启，之后每 60 秒重试。对应 launchd 的 KeepAlive。
    ['sc.exe', ['failure', id, 'reset=', '86400', 'actions=', 'restart/2000/restart/2000/restart/60000']],
  ];
}

/**
 * 停用：停止并删除服务。
 * @param port - 服务端口。
 * @param options - 未使用，仅为统一签名。
 * @param run - 同步执行命令的函数。
 * @returns `{ ok, detail }`。
 */
export function disable(port, options, run) {
  const id = unitId(port);
  run('sc.exe', ['stop', id]);
  const out = run('sc.exe', ['delete', id]);
  if (out.code !== 0 && !/does not exist|不存在/i.test(out.stderr + out.stdout)) {
    return { ok: false, detail: `sc delete 失败：${out.stderr.trim() || out.stdout.trim()}` };
  }
  return { ok: true, detail: `已删除服务 ${id}` };
}

/**
 * 收敛条目：**本平台未实现，恒不动作**（不接收参数，与 {@link listPorts} 同样保守）。
 *
 * 要判失效得先能读回服务定义（`sc.exe qc` 解析 BINARY_PATH_NAME），而本模块连 SCM
 * 握手都还没有（见文件头），此刻补解析没有意义 —— 宁可什么都不做，也不误改一条
 * 我们看不全的服务定义。
 * @returns `{ ok, changed: false, healed: [], detail }`。
 */
export function reconcile() {
  return { ok: true, changed: false, healed: [], detail: 'Windows 平台未实现条目收敛' };
}
