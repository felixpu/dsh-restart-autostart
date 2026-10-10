/**
 * Linux 注册器：把 guard.js 注册为 systemd 用户级服务。
 *
 * ⚠️ 未在真机验证 —— 本模块的代码路径从未在 Linux 上实际执行过。
 *    逻辑依据 systemd 官方文档编写，但存在以下未能实测的风险点：
 *      - 不同发行版的 systemd 版本对 Restart=on-failure 的行为差异；
 *      - loginctl enable-linger 在部分容器/精简系统上不可用（无 logind）；
 *      - 非 systemd 发行版（如 Alpine 用 OpenRC）直接不可用。
 *    在 Linux 上首次启用后，请检查 `systemctl --user status <unit>` 与
 *    `~/.dsh-restart-autostart/logs/autostart-<port>.log` 确认行为符合预期。
 *
 * 为什么用「用户级」服务（--user）而非系统级：
 *   与 macOS 选 LaunchAgent 同理——服务需要用户的 HOME、nvm 的 node、~/.dsh 配置。
 *   系统级 unit 默认以 root 运行，这些都拿不到。
 *
 * 守护语义靠 Restart=on-failure 表达：非 0 退出才重启，对应 guard.js 的退出码约定。
 *
 * ⚠️ linger 的关键作用：systemd 用户实例默认在用户注销后被回收，导致「无人登录时
 *    服务不运行」。enable-linger 让用户实例在注销后继续存活，这是自启真正生效的前提。
 *    若调用方跳过这一步，勾选框在 UI 上显示已启用，但重启后实际不会起来。
 *
 * @module dsh-restart-autostart/guard/service/systemd
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 平台标识。 */
export const platform = 'linux';

/** 本机未实测，前端据此显示提示。 */
export const verified = false;

/** systemd 用户级 unit 目录。 */
const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');

/**
 * 生成 unit 名（同时作为文件名）。
 * @param port - 服务端口。
 * @returns unit 名。
 */
export function unitId(port) {
  return `dsh-restart-autostart-${port}`;
}

/**
 * unit 文件绝对路径。
 * @param port - 服务端口。
 * @returns unit 文件路径。
 */
export function unitPath(port) {
  return path.join(UNIT_DIR, `${unitId(port)}.service`);
}

/**
 * 生成 unit 内容。
 *
 * Type=simple 而非 forking：guard.js 前台常驻，不自我 daemon 化，
 * 这样 systemd 能直接跟踪其生命周期。
 * @param port - 服务端口。
 * @param options - `{ node, guard, logDir }` 绝对路径。
 * @returns unit 文本。
 */
export function unitContent(port, options) {
  const { node, guard, logDir } = options;
  return `[Unit]
Description=DSH Web autostart guard (port ${port})
After=network.target

[Service]
Type=simple
ExecStart=${node} ${guard} --port ${port}
Restart=on-failure
RestartSec=2
Environment=DSH_HOME=${path.join(os.homedir(), '.dsh')}
Environment=DSH_TELEMETRY_DISABLED=1
StandardOutput=append:${path.join(logDir, `autostart-${port}.out.log`)}
StandardError=append:${path.join(logDir, `autostart-${port}.err.log`)}

[Install]
WantedBy=default.target
`;
}

/**
 * 查询条目是否已注册（只读）。
 * @param port - 服务端口。
 * @returns 是否已注册。
 */
export function isRegistered(port) {
  return fs.existsSync(unitPath(port));
}

/**
 * 列出本机已存在的自启条目端口（只扫文件名，不读内容）。
 *
 * 与 macOS 侧同义：用于在启用新端口时清理旧条目，避免换端口后堆积多条、
 * 开机时各拉起一个守护去抢端口和凭据锁。
 * @returns 端口号数组（升序）。
 */
export function listPorts() {
  let names = [];
  try {
    names = fs.readdirSync(UNIT_DIR);
  } catch {
    return []; // 目录不存在 = 一个条目都没有
  }
  const ports = [];
  for (const name of names) {
    const match = name.match(/^dsh-restart-autostart-(\d+)\.service$/);
    if (match) ports.push(Number(match[1]));
  }
  return ports.sort((a, b) => a - b);
}

/**
 * 启用：写入 unit、重载、启用并立即启动。
 *
 * enable-linger 失败不视为致命错误（部分系统无 logind），但会在 detail 中提示，
 * 因为这意味着「无人登录时服务可能不运行」。
 * @param port - 服务端口。
 * @param options - `{ node, guard, logDir }` 绝对路径。
 * @param run - 同步执行命令的函数。
 * @returns `{ ok, detail }`。
 */
export function enable(port, options, run) {
  fs.mkdirSync(UNIT_DIR, { recursive: true });
  const unit = unitPath(port);
  fs.writeFileSync(unit, unitContent(port, options), 'utf8');
  run('systemctl', ['--user', 'daemon-reload']);
  const out = run('systemctl', ['--user', 'enable', '--now', `${unitId(port)}.service`]);
  if (out.code !== 0) {
    return { ok: false, detail: `systemctl enable 失败：${out.stderr.trim() || out.stdout.trim()}` };
  }
  // linger 让用户级实例在注销后继续存活，是「无人登录也能自启」的前提。
  const linger = run('loginctl', ['enable-linger', os.userInfo().username]);
  const lingerNote =
    linger.code === 0
      ? ''
      : `（提示：enable-linger 失败，无人登录时可能不会自启：${linger.stderr.trim()}）`;
  return { ok: true, detail: `已写入并启用 ${unit}${lingerNote}` };
}

/**
 * 停用：停止、禁用并删除 unit。
 * @param port - 服务端口。
 * @param options - 未使用，仅为统一签名。
 * @param run - 同步执行命令的函数。
 * @returns `{ ok, detail }`。
 */
export function disable(port, options, run) {
  const unit = unitPath(port);
  run('systemctl', ['--user', 'disable', '--now', `${unitId(port)}.service`]);
  if (!fs.existsSync(unit)) {
    return { ok: true, detail: '条目本就不存在' };
  }
  fs.rmSync(unit, { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  return { ok: true, detail: `已移除 ${unit}` };
}

/**
 * 从 unit 文本中取出 ExecStart 的 node 与运行体路径。
 * @param text - unit 文本。
 * @returns `[node, guard]`；解析不出时为空数组。
 */
function readExecStart(text) {
  const match = text.match(/^ExecStart=(\S+)\s+(\S+)/m);
  return match ? [match[1], match[2]] : [];
}

/**
 * 收敛条目：把**已经失效**的路径改回当前运行时的值。
 *
 * 与 macOS 侧同义：换 node 版本后旧目录被删，systemd 会以 `status=203/EXEC` 起不来
 * （`systemctl --user status` 里看得到，但平时没人会去翻），界面上却仍写着「已启用」。
 * 只修「记录值已不存在」的情况；仍然存在的路径一律不动。
 *
 * ⚠️ 本平台未实测（见文件头）。
 * @param port - 服务端口。
 * @param options - 期望的 `{ node, guard, logDir }` 绝对路径。
 * @param run - 同步执行命令的函数。
 * @returns `{ ok, changed, healed, detail }`。
 */
export function reconcile(port, options, run) {
  const unit = unitPath(port);
  let text;
  try {
    text = fs.readFileSync(unit, 'utf8');
  } catch {
    return { ok: true, changed: false, healed: [], detail: '条目不存在，无需收敛' };
  }
  const [node, guard] = readExecStart(text);
  const healed = [];
  if (node !== undefined && node !== options.node && !fs.existsSync(node)) healed.push('node');
  if (guard !== undefined && guard !== options.guard && !fs.existsSync(guard)) healed.push('guard');
  if (healed.length === 0) {
    return { ok: true, changed: false, healed: [], detail: '条目路径有效' };
  }

  const result = enable(port, options, run);
  const detail =
    `条目里的 ${healed.join(' / ')} 路径已失效，已按当前值回写（node=${options.node}）` +
    (result.ok ? '' : `；但重新启用失败：${result.detail}`);
  return { ok: result.ok, changed: true, healed, detail };
}
