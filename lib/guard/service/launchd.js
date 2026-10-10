/**
 * macOS 注册器：把 guard.js 注册为用户级 LaunchAgent。
 *
 * 为什么用 LaunchAgent（~/Library/LaunchAgents）而不是 LaunchDaemon：
 *   - 服务跑在用户登录会话里，才能拿到用户的 HOME、nvm 的 node、~/.dsh 配置；
 *     系统级 Daemon 以 root 运行，这些全都看不到；
 *   - 自启只在用户登录后需要，无需系统级权限，装/卸都不必 sudo。
 *
 * 守护语义靠 plist 的 KeepAlive.SuccessfulExit=false 表达：
 *   退出码 0 → 视为正常结束，不重启（用户主动停止）；
 *   退出码非 0 → 视为崩溃，立即重启。
 * 这与 guard.js 的退出码约定严格对应，也与既有 3080 生产守护语义一致。
 *
 * 本模块已在本机 macOS 12.7.6 实测通过。
 *
 * @module dsh-restart-autostart/guard/service/launchd
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 平台标识。 */
export const platform = 'darwin';

/** 本机实测状态：macOS 已完整验证。 */
export const verified = true;

/** LaunchAgents 目录。 */
const AGENT_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

/**
 * 把命令输出压成一行 —— launchctl 的 stderr 常带换行和一句 "Try …" 提示，
 * 原样塞进 UI 提示会很难看。
 * @param text - 原始输出。
 * @returns 单行文本。
 */
function oneLine(text) {
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

/**
 * 生成 launchd 的 Label（同时作为 plist 文件名）。
 *
 * 按端口生成而非固定名，是为了让「3080 生产守护」与「3081 开发自启」在同一台机器上
 * 并存且互不覆盖——这是路 B 方案的核心前提。
 * @param port - 服务端口。
 * @returns Label 字符串。
 */
export function unitId(port) {
  return `com.dsh.restartautostart.${port}`;
}

/**
 * plist 文件绝对路径。
 * @param port - 服务端口。
 * @returns plist 路径。
 */
export function plistPath(port) {
  return path.join(AGENT_DIR, `${unitId(port)}.plist`);
}

/**
 * 当前用户的 GUI 登录域（`gui/<uid>`）。
 *
 * LaunchAgent 必须**显式**注册到这个域。legacy 的 `launchctl load` 会把 job 注册到
 * *调用者当时所在的域*：从终端直接跑 dsh 时恰好就是 gui/<uid>，但从 IDE / 编辑器的
 * 内嵌终端、或其它 XPC 上下文启动时就会落到别的域 —— 于是「勾了自启」，登录后却不生效，
 * 而 UI 还会显示已启用。显式给域就没这个问题。
 * @returns 域字符串；拿不到 uid 时为 null。
 */
function loginDomain() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid === null ? null : `gui/${uid}`;
}

/**
 * 单个 job 在域内的目标（`gui/<uid>/<label>`），供 bootout 使用。
 * @param port - 服务端口。
 * @returns 目标字符串；拿不到 uid 时为 null。
 */
function jobTarget(port) {
  const domain = loginDomain();
  return domain === null ? null : `${domain}/${unitId(port)}`;
}

/**
 * 把 bootstrap 失败翻译成可执行的说明。
 *
 * exit 5（EIO）不等于「plist 写错了」：plist 已经落盘，`launchctl print <domain>`
 * 也照样可读（域本身可达），只有**写入**被拒 —— 实测从这种上下文里 bootstrap 一个
 * 仅含 `/bin/echo` 的对照 plist 同样返回 5，可见与 plist 内容无关；再跑
 * `launchctl print pid/$$` 会得到 `Operation not permitted`，说明当前进程根本不在
 * 登录域内。宿主由桌面应用 / IDE 拉起时就是这种上下文，而 dsh 的「跟随系统启动」
 * 开关正是在宿主进程里执行的，于是必然失败 —— 这是环境限制，不是插件缺陷。
 *
 * 对用户而言要紧的是分清两件事：
 *   - 「随系统重启」的承诺：**已兑现**，plist 进了 ~/Library/LaunchAgents，
 *     下次登录 launchd 会自动加载；
 *   - 「本会话内即时生效（崩溃即拉起）」：没能做到，需换一个具备登录域的宿主上下文。
 * 所以这里仍然如实返回 ok:false（不复刻 legacy `load` 的假成功），但把原因和
 * 补救命令一并写清楚。
 * @param out - `{ code, stdout, stderr }`。
 * @param domain - 登录域字符串。
 * @param plist - plist 绝对路径。
 * @returns 单行说明文本。
 */
function bootstrapFailure(out, domain, plist) {
  const raw = oneLine(out.stderr || out.stdout);
  if (out.code === 5) {
    // 这里刻意不贴原始 stderr：它是 "Bootstrap failed: 5: Input/output error / Try
    // re-running the command as root for richer errors."，既不说明原因也给出错误指引
    // （本条目的问题与 root 无关），贴上去只会淹掉真正有用的补救命令。
    return (
      `条目已写入 ${plist}，但无法即时注册：${domain} 拒绝写入（EIO 5）。` +
      `常见原因是 dsh 宿主由桌面应用 / IDE 启动，进程不在登录域内。` +
      `「随系统重启」已生效于下次登录；若要在本次会话内立即生效，` +
      `请在系统「终端」里执行 launchctl bootstrap ${domain} ${plist}，再重启 dsh。`
    );
  }
  return `bootstrap 失败（exit ${out.code}）：${raw}`;
}

/**
 * 生成 plist 内容。
 *
 * 设计要点：
 *   - ProgramArguments 直接调 node guard.js，不经 /bin/sh（与另两平台统一，且更易排障）；
 *   - node 用 process.execPath（当前正在跑的这一个），不硬编码 nvm 版本号；
 *     若 nvm 升级把这个路径删掉了，由**宿主侧** {@link reconcile} 在下次宿主启动时
 *     回写纠正 —— 不能指望守护自修：那个 node 正是启动守护所需的东西，
 *     路径没了守护连进程都起不来（详见 guard.js 文件头）；
 *   - StandardOutPath/StandardErrorPath 指向插件自己的日志目录，
 *     与生产的 guard.log 分开，排障时不会混淆。
 * @param port - 服务端口。
 * @param options - `{ node, guard, logDir }` 绝对路径。
 * @returns plist XML 文本。
 */
export function plistContent(port, options) {
  const { node, guard, logDir } = options;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${unitId(port)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node}</string>
        <string>${guard}</string>
        <string>--port</string>
        <string>${port}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, `autostart-${port}.out.log`)}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, `autostart-${port}.err.log`)}</string>
</dict>
</plist>
`;
}

/**
 * 查询条目是否已注册（只读，不修改任何东西）。
 * @param port - 服务端口。
 * @returns 是否已注册。
 */
export function isRegistered(port) {
  return fs.existsSync(plistPath(port));
}

/**
 * 列出本机已存在的自启条目端口（只扫文件名，不读内容）。
 *
 * 用来提示「端口漂移导致条目堆积」：用户先在 3080 勾选、后来换了端口又勾一次，
 * 就会留下两条条目 —— 开机时 launchd 各拉起一个守护，两者抢端口、抢凭据锁。
 * @returns 端口号数组（升序）。
 */
export function listPorts() {
  let names = [];
  try {
    names = fs.readdirSync(AGENT_DIR);
  } catch {
    return []; // 目录不存在 = 一个条目都没有
  }
  const ports = [];
  for (const name of names) {
    const match = name.match(/^com\.dsh\.restart\.(\d+)\.plist$/);
    if (match) ports.push(Number(match[1]));
  }
  return ports.sort((a, b) => a - b);
}

/**
 * 启用：写入 plist，并显式注册到 GUI 登录域。
 *
 * 用 `bootstrap <domain> <plist>` 而非 legacy 的 `load <plist>`，两个理由：
 *   ① `load` 不带域，注册到哪取决于调用者上下文（见 {@link loginDomain}）；
 *   ② **`load` 失败时退出码仍是 0**（只在 stderr 打印 `Load failed`），
 *      于是上层靠退出码判成败就会静默误报「已启用」。实测 `bootstrap` 失败返回 5，
 *      退出码可靠 —— 用它才能真的知道注册成功没有。
 * 注意：plist 一旦落盘，就已决定「下次登录是否自启」，注册只影响「本会话是否即时生效」。
 * 因此注册失败（尤其 exit 5）时仍返回 ok:false，但由 {@link bootstrapFailure} 讲清
 * 哪一半已达成、哪一半没达成，而不是丢一句 EIO。
 * @param port - 服务端口。
 * @param options - `{ node, guard, logDir }` 绝对路径。
 * @param run - 同步执行命令的函数 `(cmd, args) => { code, stdout, stderr }`。
 * @returns `{ ok, detail }`。
 */
export function enable(port, options, run) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const domain = loginDomain();
  if (domain === null) {
    return { ok: false, detail: '无法确定登录域（process.getuid 不可用）' };
  }
  const plist = plistPath(port);
  fs.writeFileSync(plist, plistContent(port, options), 'utf8');
  // 先 bootout 同名旧条目，否则 bootstrap 会撞 "already bootstrapped"。
  // 条目不存在时 bootout 返回 3（No such process）—— 属正常，忽略。
  run('launchctl', ['bootout', jobTarget(port)]);
  const out = run('launchctl', ['bootstrap', domain, plist]);
  if (out.code !== 0) {
    return { ok: false, detail: bootstrapFailure(out, domain, plist) };
  }
  return { ok: true, detail: `已写入并注册到 ${domain}：${plist}` };
}

/**
 * 停用：从 GUI 登录域注销，并删除 plist。
 * @param port - 服务端口。
 * @param options - 未使用，仅为与另两平台保持统一签名。
 * @param run - 同步执行命令的函数。
 * @returns `{ ok, detail }`。
 */
export function disable(port, options, run) {
  const target = jobTarget(port);
  // 先注销再动文件：job 可能还加载着，而 plist 已被手删过。
  // 3 = No such process，表示本就没加载 —— 对「停用」而言已是目标状态，不算失败。
  if (target !== null) {
    const out = run('launchctl', ['bootout', target]);
    if (out.code !== 0 && out.code !== 3) {
      return {
        ok: false,
        detail: `bootout 失败（exit ${out.code}）：${oneLine(out.stderr || out.stdout)}`,
      };
    }
  }
  const plist = plistPath(port);
  if (!fs.existsSync(plist)) {
    return { ok: true, detail: '条目本就不存在' };
  }
  fs.rmSync(plist, { force: true });
  return { ok: true, detail: `已移除 ${plist}` };
}

/**
 * 从 plist 文本中取出 ProgramArguments 的前两项（node 与运行体路径）。
 *
 * 不引 XML 解析器：本文件的形状由 {@link plistContent} 独家生成，正则够用且零依赖。
 * @param text - plist 文本。
 * @returns `[node, guard]`；解析不出时为空数组。
 */
function readProgramArguments(text) {
  const array = text.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!array) return [];
  return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1].trim());
}

/**
 * 收敛条目：把**已经失效**的路径改回当前运行时的值。
 *
 * 针对的正是 nvm 升级那个场景：旧 node 目录被删掉后，launchd 到点会去 exec 一个
 * 不存在的二进制，job 静默失败（没有日志、没有提示），而界面上仍写着「已启用」——
 * 自启就此永久失效，却从外部完全看不出来。
 *
 * 只修「记录值已不存在」这一种情况；若记录值仍然存在（例如只是换了默认版本、
 * 旧版本还留着），一律不动 —— 它跑得起来，没有理由制造无意义的改写与 mtime 抖动。
 * @param port - 服务端口。
 * @param options - 期望的 `{ node, guard, logDir }` 绝对路径。
 * @param run - 同步执行命令的函数。
 * @returns `{ ok, changed, healed, detail }`；`healed` 为被回写的字段名。
 */
export function reconcile(port, options, run) {
  const plist = plistPath(port);
  let text;
  try {
    text = fs.readFileSync(plist, 'utf8');
  } catch {
    return { ok: true, changed: false, healed: [], detail: '条目不存在，无需收敛' };
  }
  const [node, guard] = readProgramArguments(text);
  const healed = [];
  if (node !== undefined && node !== options.node && !fs.existsSync(node)) healed.push('node');
  if (guard !== undefined && guard !== options.guard && !fs.existsSync(guard)) healed.push('guard');
  if (healed.length === 0) {
    return { ok: true, changed: false, healed: [], detail: '条目路径有效' };
  }

  // 回写直接复用 enable()：写文件 + 重新注册这两件事它已经做全，别在两处各写一遍。
  const result = enable(port, options, run);
  const detail =
    `条目里的 ${healed.join(' / ')} 路径已失效，已按当前值回写（node=${options.node}）` +
    (result.ok ? '' : `；但重新注册失败：${result.detail}`);
  return { ok: result.ok, changed: true, healed, detail };
}
