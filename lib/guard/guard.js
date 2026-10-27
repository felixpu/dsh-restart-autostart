#!/usr/bin/env node
/**
 * dsh-restart-autostart 守护脚本（跨平台 Node 实现）。
 *
 * 替代原有的 ~/.dsh/guard.sh。原 shell 版依赖 /bin/sh + lsof，两者在 Windows 上
 * 都不存在；Node 版把「找端口占用」「杀进程」「探活」都收敛到同一份代码，
 * 三平台共用一套逻辑。
 *
 * 与原 shell 版对齐的行为：
 *   1. 启动 dsh 后必须「等它结束」——脚本生命周期 = 服务生命周期，
 *      系统的守护机制（launchd KeepAlive / systemd Restart / SCM failure）才守护得到；
 *   2. 退出码 0 = 正常退出（手动停止），非 0 = 真崩溃，交给系统的失败重启策略处理；
 *   3. 连续启动失败达上限后以 0 退出，避免无限重启循环。
 *
 * 自修复能力（shell 版做不到）：
 *   1. dsh 入口不写死：每次启动都按「当前 node」重新探测（见 {@link locateDsh}），
 *      所以 nvm 升级换了 node 之后，条目里的 dsh 入口无需跟着改。
 *      ⚠️ 但**条目里记录的 node 路径本身，本脚本修不了** —— 那正是启动本脚本所需的东西：
 *      nvm 升过级、旧 node 目录已被删掉时，launchd 连本脚本都拉不起来，自然无从回写。
 *      这一半只能由宿主侧补（宿主一定跑在「当前 node」上）：见 guard/index.js 的
 *      {@link reconcileAll}，它在宿主启动时校验并回写条目。
 *   2. 启动前清理 dsh 的孤儿凭据锁（见 clearOrphanCredentialLock）。宿主每次被强杀
 *      都可能留下它，而 dsh 自身**永不**清理 —— 不接管这一步，一次强杀就能让 dsh
 *      永久起不来（报错还会伪装成「插件树加载失败」，极难定位）。
 *   3. **升级失败自动回滚**（见 rollbackPendingUpgrade）。插件的一键升级在重启宿主前
 *      会写下一份「待验证」状态；如果新版本起不来（典型是新主程序与某个第三方插件
 *      不再兼容），本脚本在放弃拉起之前会读到它，把主程序装回旧版本再重新进入启动
 *      循环。**这是「升级不会把服务搞挂」这条承诺的唯一兑现点** —— 插件本身在那个
 *      时刻已经随旧宿主一起消失了，没有第二个能救场的地方。
 *
 * 就绪判定的关键：**端口监听不代表启动成功**。唯一的完成信号是 dsh 打印的带 token
 * 访问地址（见 {@link READY_MARKER}）。
 *
 * ⚠️ 不要再写「dsh 先监听端口、后加载插件树」：真正 listen 的是
 * `@deepseek-ai/dsh-host-webserver`，而它本身就是插件树里的一个 loader entry ⇒
 * 监听发生在插件树加载**之内**；这棵树加载失败时，本实例**从未**绑上端口。
 * 2026-09-25 实测的那次「端口通 + 进程活 + 无 token」误判，端口持有者其实是
 * **另一个实例**（错误栈为 webserver 自己的 `listen EADDRINUSE`）——
 * 把别人的端口记在了失败实例头上。这条错误的因果链直接导致过误判。
 *
 * 判定时机同样关键：就绪与否**在子进程退出之后**用本轮日志段终审（见 main()）。
 * 任何「在固定窗口内一次性取值」的判定都会漏掉两类实例：慢启动的正常实例，
 * 以及致命证据比窗口更晚落盘的失败实例。
 *
 * 用法：node guard.js --port <port>
 *
 * @module dsh-restart-autostart/guard/guard
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** 配置根目录：~/.dsh-restart-autostart/。 */
const HOME_DIR = path.join(os.homedir(), '.dsh-restart-autostart');

/** 日志目录。 */
const LOG_DIR = path.join(HOME_DIR, 'logs');

/**
 * 连续启动失败上限；达到后放弃自动拉起，避免无限循环。
 *
 * 注意：这里统计的是「启动失败」，不是「崩溃次数」。只要本轮出现过就绪标记
 * （整棵插件树加载完成），就说明这次启动是成功的，之后的退出不计入——否则一个
 * 稳定运行但被反复重启的服务，会在几次重启后就被永久放弃拉起。
 * 判据**不能**换成「端口是否在监听」：端口上连到的可能是别的实例（见文件头）。
 */
const MAX_RETRY = 3;

/**
 * 就绪探测的轮询时长（毫秒）。
 *
 * 它只决定「轮询循环什么时候退出」，**不构成判定** —— 就绪与否在进程退出之后
 * 用本轮日志段终审（见 main()）。所以调大调小都不会改变结论，只是日志时机的差别。
 */
const READY_TIMEOUT_MS = 60_000;

/** 待命轮询的起始间隔（毫秒）。 */
const STANDBY_MIN_MS = 5_000;

/** 待命轮询的间隔上限（毫秒）—— 退避到此值后按固定频率探测，避免长期高频唤醒。 */
const STANDBY_MAX_MS = 60_000;

/** 待命心跳日志的最小间隔（秒）—— 长期守候时按此节奏留痕，不刷爆日志。 */
const STANDBY_HEARTBEAT_S = 300;

/**
 * dsh「真正启动完成」才会打印的标记行。
 *
 * 只有整棵插件树全部加载成功，dsh 才会打印带 token 的访问地址，形如：
 *   `dsh web: http://127.0.0.1:<port>/?token=<...>`
 *
 * 这是唯一的正证据。别用端口监听替代它：监听者只是树里的一个 entry，树加载失败时
 * 本实例根本没绑上端口，而端口上连到的可能是别人的实例。也别指望在固定窗口内一定
 * 能看到它 —— 慢启动实例会更晚。
 */
const READY_MARKER = 'dsh web: http://';

/**
 * 「端口已被别人占」的证据 —— 本轮日志段里出现它，说明内核拒绝了**我们**的绑定。
 *
 * 用来把「与外来实例抢端口的竞态」和「自己的插件树起不来」分开：前者不该记成启动
 * 失败，否则会把正确行为累计成故障，几轮之后误触 MAX_RETRY 把守护永久熔断。
 *
 * 用日志里现成的证据、而不是去查端口归属，是因为 lsof 在 Windows 上不存在，而本
 * 脚本刻意维持三平台同一份逻辑（见文件头与 {@link isPortListening} 的说明）。
 */
const PORT_TAKEN_MARKER = 'EADDRINUSE';

/**
 * 待命入口那句日志里必须带上的前提。
 *
 * 守护**分不清**端口占用者是谁：跨平台确认归属要 lsof（Windows 没有），而本脚本刻意维持
 * 三平台同一份逻辑。所以这里不下判断，只把两种可能摊开，让读日志的人自己对照。
 *
 * 不写这句的代价（2026-09-26 之前就是这样）：日志里只有「占用者退出后接管」，读起来像
 * 一切正常 —— 哪怕实情是「端口被别的程序占着，你的 dsh 永远不会被拉起来」。
 * 注意这是**可观测性**缺口、不是行为错误：端口被占时守候本身是对的语义，因为最常见的
 * 占用者就是用户自己手动起的另一个 dsh 实例，那时守候并接管理所当然。
 */
const PORT_BUSY_CAVEAT =
  '本守护分不清占用者是不是 dsh —— 若你的 dsh 并未在运行，说明该端口被别的程序占着，守护只会等它释放，不会替你把服务拉起来';

/**
 * 「正在启动」跨进程锁的文件路径。
 *
 * 堵的是一段**必然出现**的竞态：宿主被 kill 后，到新宿主真正 `listen` 之间约有 10 秒
 * 空窗（新宿主在加载整棵插件树）。这段空窗里端口是空的，于是本守护的预检、与 manual
 * 通道的重启脚本，会**双双认定「现在没人，我上」** —— 两边各加载一遍插件树，只有先
 * bind 的能活，输的那个留下一行 `EADDRINUSE` 后退出，日志表现为「服务在启动过程中退出」。
 * 更糟的是两边都可能是"正确执行"，所以它不像 bug，倒像随机故障。
 *
 * 约定：**谁在启动，谁持有这把锁。** manual 的重启脚本在动手前先把自己写进来，
 * spawn 出新宿主后立刻改写成新宿主的 pid（那时脚本本身即将退出，不能再当持有者）。
 * 本守护启动前若发现锁被一个**存活**的进程持有，就让路、转去等对方出结果。
 *
 * 判据是「锁里记的 pid 还活着没有」，**不是时长** —— 进程一死锁即自动失效，既不会有
 * 需要人工清理的孤儿锁（与 {@link clearOrphanCredentialLock} 同一套思路），也不必引入
 * 「等满 N 秒就假定安全」这类靠不住的时长启发式（本文件别处的注释已否定过这类判据）。
 *
 * ⚠️ 本文件是**自包含单文件**（会被 installGuardRuntime 整份拷成
 * `~/.dsh-restart-autostart/guard.mjs` 运行），不能 import 同目录其它模块。因此这把锁在
 * `lib/manual/restart.js` 的 RESTART_SCRIPT 里另有一份实现，两边的**路径与文件格式必须
 * 逐字一致**（纯十进制 pid，除行尾空白外无任何装饰）。
 * @param targetPort - 目标端口。
 * @returns 锁文件的绝对路径。
 */
function startingLockFile(targetPort) {
  return path.join(LOG_DIR, `starting-${targetPort}.lock`);
}

/**
 * 读「正在启动」锁，判断它是否被一个**存活**的进程持有。
 *
 * 读不到、内容不是合法 pid、或该 pid 已不存在 → 视为无人持有，并顺手清掉残留文件；
 * 探测到存活、或抛 EPERM（进程在但无权发信号）→ 视为有人正在启动。
 * @param targetPort - 目标端口。
 * @returns 持有者的 pid；无人持有时为 null。
 */
function startingLockHolder(targetPort) {
  const file = startingLockFile(targetPort);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      alive = Boolean(error) && error.code === 'EPERM';
    }
  }
  if (alive) return pid;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 清不掉也无妨：下一次判断照样得出「无人持有」。
  }
  return null;
}

/**
 * 把「有新宿主正在启动/已启动」登记进锁。
 *
 * 本守护自己拉起宿主时也要持锁 —— 否则这把锁只覆盖了 manual 通道，像 start.sh
 * 那样的第三方（以及将来任何新的拉起路径）看不到「守护正在启动」，照旧会插进来抢
 * 同一个端口。持锁后语义才完整：**锁存在且持有者活着 = 端口即将被/已经被占用**。
 *
 * 锁的持有者刻意登记为**新宿主**而不是本守护：
 *   - 宿主会活很久，覆盖「端口已绑上」之后的整段时间；
 *   - 宿主一退出（崩溃或被 kill），pid 随之消失，锁自动失效，下一轮循环的
 *     {@link startingLockHolder} 会把它当孤儿清掉 —— 不需要任何显式释放逻辑，
 *     也就不会有「忘了解锁」这种死锁。
 * @param targetPort - 目标端口。
 * @param pid - 新宿主的 pid。
 */
function writeStartingLock(targetPort, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(startingLockFile(targetPort), String(pid), 'utf8');
  } catch {
    // 写不进去不阻断启动：最坏退化成没有互斥，即本次修复之前的行为。
  }
}

/**
 * 让路期间的空转：等对方把宿主拉起来，或者它自己失败退出。
 *
 * **两个结束条件都必须判**，各自对应调用方的下一步动作：
 *   - 锁被释放（对方失败）→ 端口空着，回到 main 的循环由我们接管启动；
 *   - 端口被监听起来（对方成功）→ 回到 main 的循环转入待命。
 * 只看锁会死等：对方成功时锁随新宿主一直活着，永远等不到「锁被释放」。
 * @param targetPort - 目标端口。
 */
async function waitWhileStarting(targetPort) {
  let delay = STANDBY_MIN_MS;
  for (;;) {
    await sleep(delay);
    if (startingLockHolder(targetPort) === null) return;
    if (await isPortListening(targetPort)) return;
    delay = Math.min(delay * 2, STANDBY_MAX_MS);
  }
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { port: 3081 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) {
      args.port = Number(argv[i + 1]);
      i += 1;
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    args.port = 3081;
  }
  return args;
}

const { port } = parseArgs(process.argv.slice(2));

/** 计数文件：连续失败次数。 */
const COUNT_FILE = path.join(LOG_DIR, `autostart-${port}.count`);

/** 主日志文件。 */
const LOG_FILE = path.join(LOG_DIR, `autostart-${port}.log`);

/** 日志输出：同时追加到文件与 stderr（便于系统日志采集）。 */
const LOG = {
  /**
   * 追加一行日志（同时写文件与 stderr，便于系统日志采集）。
   * @param message - 日志正文。
   */
  write(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    } catch {
      // 日志失败不应影响守护本身。
    }
    process.stderr.write(line + '\n');
  },
};

/**
 * 探测端口是否已有监听者。
 *
 * 用 net.connect 而非 lsof：lsof 在 Windows 上不存在，connect 探测三平台通用。
 * ⚠️ 它只回答「有没有人在听」，**回答不了「在听的是不是我这次拉起的进程」** ——
 * 所以它不能用于就绪判定，只能用于「端口是否已被人占用」这类占用判断。
 * @param targetPort - 目标端口。
 * @returns 该端口当前是否可连接。
 */
function isPortListening(targetPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: targetPort });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

/** dsh 凭据文件的跨进程写锁，由 `@deepseek-ai/dsh-atomic-write` 创建。 */
const CREDENTIAL_LOCK = path.join(os.homedir(), '.dsh', '.credentials.yaml.lock');

/**
 * 清理 dsh 的孤儿凭据锁，返回被清理的路径（无孤儿时返回 null）。
 *
 * 为什么必须由守护来做：dsh 的 `@deepseek-ai/dsh-atomic-write` 用
 * `writeFile(lockPath, pid, { flag: 'wx' })` 实现跨进程写锁 —— 判据是「文件存在」，
 * 且源码注释明确 *orphan recovery is an operator action*，也就是 **dsh 永远不会
 * 自己清理残留锁**。宿主若在凭据原子写的中途被杀（open 成功、写入或 rm 之前），
 * 就会留下一个 **0 字节**锁文件；此后每次 boot 都在 `dsh-client-connection` 处等锁
 * 超时 → 整棵插件树加载失败 → 永不自愈，只能人工删锁。
 *
 * 「手动重启」是最高发的触发场景：它 SIGTERM 宿主，而优雅关闭流程里正好可能在写凭据。
 * 所以每次拉起 dsh 之前清一次，把这类故障消化在重启循环内部。
 *
 * 判据取锁文件的约定内容（持有者 pid），保守优先：
 *   - 读不到内容（空文件）      → 孤儿，清
 *   - pid 不存在（ESRCH）        → 孤儿，清
 *   - pid 存在 / EPERM（无权探测）→ 视为活锁，**不动**（宁可漏清，不可误删）
 * @returns 被清理的锁路径；未清理时为 null。
 */
function clearOrphanCredentialLock() {
  let raw;
  try {
    raw = fs.readFileSync(CREDENTIAL_LOCK, 'utf8').trim();
  } catch {
    return null; // 文件不存在 = 没有孤儿
  }
  const pid = Number(raw);
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      alive = error && error.code === 'EPERM';
    }
  }
  if (alive) return null;
  try {
    fs.rmSync(CREDENTIAL_LOCK, { force: true });
    return CREDENTIAL_LOCK;
  } catch {
    return null;
  }
}

/**
 * 读取「本轮启动新增的日志内容」（自 fromOffset 起，到文件当前末尾）。
 *
 * 日志是 append 的，必须按偏移量截断 —— 否则会命中上一轮遗留的 token 行或错误堆栈，
 * 把根本没起来的服务判成已就绪、或把上一轮的死因算到这一轮头上。
 * @param fromOffset - 本轮启动前日志文件的字节长度。
 * @returns 新增内容；读不到时为空串。
 */
function readLogSegment(fromOffset) {
  let fd;
  try {
    fd = fs.openSync(LOG_FILE, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= fromOffset) return '';
    const length = size - fromOffset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, fromOffset);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关不掉不影响判定结果。
      }
    }
  }
}

/**
 * 判断本轮启动是否**真正完成**（本轮日志段里出现了 {@link READY_MARKER}）。
 * @param fromOffset - 本轮启动前日志文件的字节长度。
 * @returns 新增内容里是否出现就绪标记。
 */
function hasReadySignal(fromOffset) {
  return readLogSegment(fromOffset).includes(READY_MARKER);
}

/**
 * 取日志文件当前字节长度（作为下一轮就绪判定的起点）。
 * @returns 文件长度；读不到时为 0。
 */
function logSize() {
  try {
    return fs.statSync(LOG_FILE).size;
  } catch {
    return 0;
  }
}

/** 等待若干毫秒。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 待命守候：端口被占用时不退出，占用者一旦退出就接管。
 *
 * 为什么不能像从前那样「等 60s 就让路 `exit 0`」：
 * 宿主第一次总是用户手动 `dsh web` 起来的 —— 插件装完才有本守护，守护不可能先于宿主存在。
 * 用户此时点「跟随系统启动」→ launchd 立即拉起本进程 → 端口必然已被占用。
 * 老逻辑走到这里就 `exit 0`，而 plist 的 `KeepAlive{SuccessfulExit=false}` 把 0 读作
 * 「用户主动停止，别再拉起」→ 于是「勾了自启却没有守护」会一直空窗到下次登录：
 * 界面上写着「已启用」，实际上没有任何人在守。
 *
 * 待命把这段空窗补上，代价是一个常驻的本进程（用户取消自启即终止它）。
 * 探测间隔按 5s→10s→…→60s 退避，稳定后每 60s 一次，开销可忽略。
 * @param targetPort - 目标端口。
 * @returns 端口释放后返回，由调用方继续走正常启动流程。
 */
async function standbyUntilFree(targetPort) {
  const startedAt = Date.now();
  let delay = STANDBY_MIN_MS;
  let lastHeartbeatS = 0;
  for (;;) {
    await sleep(delay);
    if (!(await isPortListening(targetPort))) {
      LOG.write(`待命结束：端口 ${targetPort} 已释放，接管启动`);
      return;
    }
    const waitedS = Math.round((Date.now() - startedAt) / 1000);
    if (waitedS - lastHeartbeatS >= STANDBY_HEARTBEAT_S) {
      lastHeartbeatS = waitedS;
      LOG.write(`待命中：端口 ${targetPort} 仍被占用（已守候 ${waitedS}s），占用者退出后自动接管`);
    }
    delay = Math.min(delay * 2, STANDBY_MAX_MS);
  }
}

/** 读取失败计数，非法值归零。 */
function readCount() {
  try {
    const raw = fs.readFileSync(COUNT_FILE, 'utf8').trim();
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 写入失败计数。
 * @param n - 计数值。
 */
function writeCount(n) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(COUNT_FILE, String(n), 'utf8');
  } catch {
    // 计数写入失败不阻断流程。
  }
}

/**
 * 定位 dsh 的入口。
 *
 * node 取 `process.execPath`（正在跑本脚本的那一个），不硬编码 nvm 版本号 ——
 * 于是 nvm 升级换 node 之后，条目里记录的 dsh 入口无需跟着改。
 * dsh 入口按「与 node 同级的 lib/node_modules」推导：nvm 与官方安装器都是这个布局，
 * 实测即 `~/.nvm/versions/node/<ver>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。
 * 探不到时不另找路径，仍旧返回该候选，让 dsh 自己报「不存在」—— 保留可诊断性。
 *
 * ⚠️ 本函数**修不了**条目里记录的 node 路径：那是启动本脚本的前提（见文件头），
 * 那一半由宿主侧的 reconcileAll() 负责。
 * @returns `{ node, dsh }` 绝对路径。
 */
function locateDsh() {
  const node = process.execPath;
  const dsh = path.join(
    path.dirname(node),
    '..',
    'lib',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  return { node, dsh: path.resolve(dsh) };
}

/* ── 升级回滚（一键升级的安全网）──────────────────────────────── */

/**
 * 「升级待验证」状态文件。
 *
 * ⚠️ 必须与 `lib/upgrade/install.js` 的 `PENDING_FILE` **逐字一致**。
 * 本文件是运行体：guard/index.js 会把它拷到 `~/.dsh-restart-autostart/guard.mjs`
 * 交给 launchd 直接执行，那一刻它和仓库里的 lib/ 已没有任何相对位置关系，
 * **不能 import 本地模块**。所以路径只能复制一份常量。改一边必须改两边，
 * 否则安全网会静默失效 —— 而且失效时没有任何报错，只是「升级挂了就挂了」。
 */
const UPGRADE_PENDING_FILE = path.join(HOME_DIR, 'upgrade-pending.json');

/** dsh 的 npm 包名（同样是复制，理由见上）。 */
const DSH_PKG = '@deepseek-ai/dsh';

/** 回滚时等 npm 的上限。装 849MB 依赖实测 30~90s，给足余量。 */
const ROLLBACK_NPM_TIMEOUT_MS = 180_000;

/**
 * 读「待验证」状态；读不到或格式不对返回 null。
 * @returns `{ from, to, prefix, backupDir, at }` 或 null。
 */
function readPendingUpgrade() {
  try {
    const data = JSON.parse(fs.readFileSync(UPGRADE_PENDING_FILE, 'utf8'));
    if (typeof data.to !== 'string' || typeof data.from !== 'string' || data.from === '') return null;
    return data;
  } catch {
    return null;
  }
}

/** 清掉「待验证」状态。 */
function clearPendingUpgrade() {
  try {
    fs.rmSync(UPGRADE_PENDING_FILE, { force: true });
  } catch {
    // 清不掉也无害：下一轮会再判一次版本。
  }
}

/**
 * 把主程序装回旧版本，返回是否回滚成功。
 *
 * 顺序是刻意的：**先恢复本地备份代码，再跑 npm**。
 * npm 装包时会先删目录再解包，一旦中途失败（断网、registry 抖动），包里可能只剩半截；
 * 那时连 `dsh --version` 都跑不起来，回滚就彻底没救了。先用 120KB 的备份副本把入口
 * 恢复成「至少能跑」的状态，再让 npm 去把依赖校准回来。
 *
 * npm 失败**不**判为回滚失败：代码已经回去了，补丁版本之间依赖差异通常很小，
 * 宿主大概率还能起来 —— 那也比「什么都不做、服务彻底挂掉」好。
 *
 * @param pending - 待验证状态对象（含 from / backupDir / prefix）。
 * @returns `{ ok, detail }`。
 */
function rollbackPendingUpgrade(pending) {
  const { node, dsh } = locateDsh();
  const pkgDir = path.dirname(path.dirname(dsh)); // .../@deepseek-ai/dsh
  const prefix = typeof pending.prefix === 'string' && pending.prefix !== ''
    ? pending.prefix
    : path.resolve(path.dirname(node), '..');
  const steps = [];

  // ① 恢复备份的主程序代码（跳过 node_modules，与备份时的过滤逐项对应）
  const source = typeof pending.backupDir === 'string' && pending.backupDir !== ''
    ? path.join(pending.backupDir, 'dsh')
    : '';
  try {
    if (source !== '' && fs.statSync(source).isDirectory()) {
      fs.cpSync(source, pkgDir, {
        recursive: true,
        force: true,
        filter: (item) => path.basename(item) !== 'node_modules',
      });
      steps.push('已恢复备份代码');
    } else {
      steps.push('备份目录不存在，跳过代码恢复');
    }
  } catch (error) {
    steps.push(`恢复备份代码失败：${error && error.message ? error.message : String(error)}`);
  }

  // ② npm 装回旧版，让依赖也回到匹配的版本
  let command = 'npm';
  const args = [];
  const npmCli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    if (fs.statSync(npmCli).isFile()) {
      command = node;
      args.push(npmCli);
    }
  } catch {
    // 该前缀没有 npm：退回 PATH 上的，至少还留一次机会。
  }
  args.push('install', '-g', `${DSH_PKG}@${pending.from}`, '--prefix', prefix);

  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const npmResult = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: ROLLBACK_NPM_TIMEOUT_MS,
    env,
    windowsHide: true,
  });
  steps.push(npmResult.status === 0
    ? `npm 已装回 ${pending.from}`
    : `npm 装回失败（status=${npmResult.status}），代码已恢复、依赖可能仍是新版`);

  // ③ 校验：只证明入口能跑、版本号对了。真正的健康判据是下一轮能否打出 token。
  const check = spawnSync(node, [dsh, '--version'], { encoding: 'utf8', timeout: 30_000 });
  const got = String(check.stdout ?? '').trim();
  const ok = check.status === 0 && got === pending.from;
  const detail = `${steps.join('；')}；${ok ? `L1 通过（${got}）` : `L1 失败（期望 ${pending.from}，实际 ${got || '无输出'}）`}`;

  // 无条件清掉：留着它会导致每一轮都重试回滚，把启动循环彻底卡死。
  clearPendingUpgrade();
  return { ok, detail };
}

/* ── 安全模式（隔离肇事插件，优先保住新版本）──────────────────── */

/**
 * 安全模式状态文件。
 *
 * ⚠️ 与 `lib/upgrade/index.js` 的 `SAFE_MODE_FILE` **逐字一致**（理由同 UPGRADE_PENDING_FILE）。
 */
const SAFE_MODE_FILE = path.join(HOME_DIR, 'safe-mode.json');

/** 守护始终拉起 `dsh web`，对应 profile 目录固定为 web。 */
const PROFILE_PACKAGE = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'package.json');

/**
 * 安全模式保留的 bundle。
 *
 * 规则不是「只留官方最小集」，而是 **官方前缀 + 本插件自己**：
 *
 * - `@deepseek-ai/*` 随主程序一起发布，属于官方配置，留着可以少丢功能；
 *   它们真出问题时的正确处理是**回滚 dsh**（`removed.length === 0` 会走这条），
 *   而不是靠安全模式硬撑。
 * - **本插件必须在保留名单里**。它自己也是 profile 里的一项第三方 bundle
 *   （`dsh-plugin-suite`），如果被一起摘掉，`safe-mode.json` 就没有任何界面能读到，
 *   「恢复插件」这个按钮将不存在 —— 恢复手段必须能在它要恢复的故障里活下来。
 *   这和 guard 本身放在磁盘上、不依赖宿主加载是同一个理由。
 *
 * 代价：万一肇事者正是本插件，安全模式会照样起不来，此时守卫会转而回滚 dsh
 * （见进安全模式失败的分支），用户仍然拿得回服务。
 */
const SAFE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** 官方包前缀：这些视为「官方配置」，安全模式不动。 */
const OFFICIAL_PREFIX = '@deepseek-ai/';

/** 提供「恢复插件」界面的包：安全模式必须留着它们，否则没人能把插件装回去。 */
const SELF_BUNDLES = ['dsh-plugin-suite', 'dsh-restart-autostart'];

/**
 * 读日志尾部，用于从失败现场解析肇事插件。
 *
 * 只读尾部：致命错误的诊断块永远是最后写进去的，整文件读没必要（长期运行的宿主
 * 日志可能有上百 MB）。
 * @param maxBytes - 最多读多少字节。
 * @returns 文本（读不到返回空串）。
 */
function readLogTail(maxBytes = 200_000) {
  try {
    const size = fs.statSync(LOG_FILE).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * 从失败日志里解析出「疑似肇事插件」的包名。
 *
 * 两种格式（都在 dsh-app-boot 里，实测）：
 *   致命：`    Package: <包名>`（startupDiagnostic 的 Failed plugins 段）
 *   告警：`<条目 id> (<包名>): <原因>`（activationDiagnostic 的逐条）
 *
 * 只收第三方：`@deepseek-ai/*` 是主程序自带的官方包，把它们当嫌疑人会让
 * 「安全模式要不要进」这个判断失真。
 * @param text - 日志文本。
 * @returns 包名数组（去重）。
 */
function parseSuspects(text) {
  const found = new Set();
  const source = String(text || '');
  for (const match of source.matchAll(/^\s*Package:\s*(\S+)\s*$/gm)) found.add(match[1]);
  for (const match of source.matchAll(/^\s*[\w./-]+\s+\(([^)\s]+)\):\s/gm)) {
    const name = match[1];
    if (name.includes('/') || name.startsWith('@') || name.startsWith('dsh-')) found.add(name);
  }
  return [...found].filter((name) => !name.startsWith('@deepseek-ai/'));
}

/** 读安全模式状态；未进入过返回 null。 */
function readSafeMode() {
  try {
    const data = JSON.parse(fs.readFileSync(SAFE_MODE_FILE, 'utf8'));
    if (data === null || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/** 写安全模式状态（失败即抛出，由调用方决定要不要继续）。 */
function writeSafeMode(state) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(SAFE_MODE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 进入安全模式：把 profile 的 `dsh.profile.bundles` 砍到「官方包 + 本插件」。
 *
 * 为什么改 package.json 而不是在 patch 里写 `disabled: true`：patch 要精确命中
 * 条目 id 与它的父级路径，第三方插件的树形结构各不相同，写一次错一次；
 * 而 bundles 是一个扁平数组，摘掉一个包名就完事 —— 这也是 dsh 自己的插件管理器
 * 启停插件的方式。
 *
 * 顺序刻意是「先写状态文件，再改 package.json」：反过来的话，一旦第二步失败，
 * 就出现「插件已被停用、但用户看不到停了哪些、也没法一键恢复」的黑箱状态。
 *
 * @param options - `{ pending, suspects, diagnostic }`。
 * @returns `{ ok, removed?, originalBundles?, reason? }`。
 */
function enterSafeMode({ pending, suspects, diagnostic }) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(PROFILE_PACKAGE, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `读不到 profile package.json：${error && error.message ? error.message : String(error)}` };
  }

  const bundles = pkg?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return { ok: false, reason: 'profile 里没有 dsh.profile.bundles' };

  const kept = (name) => name.startsWith(OFFICIAL_PREFIX) || SELF_BUNDLES.includes(name);
  const removed = bundles.filter((name) => !kept(name));
  // 已经是「官方 + 自身」⇒ 没得再砍。此时再进一次就是死循环，必须交回上层的回滚逻辑。
  if (removed.length === 0) return { ok: false, reason: 'bundles 已只剩官方包与本插件，安全模式救不了这一轮' };
  // 保留顺序原样：bundles 是**有序**的（顺序决定 patch 层叠），重排会改变覆盖关系。
  const keepBundles = bundles.filter(kept);
  // 兜底：profile 里连起始 bundle 都没有（被手工改过 / 模板不对）时不要在错误的
  // 配置上继续折腾，直接让上层走「回滚 dsh」——那才是能把服务救回来的动作。
  const missingBase = SAFE_BUNDLES.filter((name) => !keepBundles.includes(name));
  if (missingBase.length > 0) {
    return { ok: false, reason: `profile 缺少起始 bundle（${missingBase.join('、')}），安全模式不适用` };
  }

  try {
    writeSafeMode({
      at: new Date().toISOString(),
      from: pending === null ? null : pending.from,
      to: pending === null ? null : pending.to,
      removed,
      // 完整原样保存：恢复时直接整份写回，不依赖「按 removed 逐个插回」的顺序推断。
      originalBundles: bundles.slice(),
      suspects,
      diagnostic: String(diagnostic || '').slice(-4000),
    });
  } catch (error) {
    return { ok: false, reason: `写安全模式状态失败：${error && error.message ? error.message : String(error)}` };
  }

  try {
    // 另存一份原始文件，供用户手工恢复（比只看状态文件更直观）。
    fs.copyFileSync(PROFILE_PACKAGE, `${PROFILE_PACKAGE}.bak-before-safe-mode`);
    const next = JSON.parse(JSON.stringify(pkg));
    next.dsh.profile.bundles = keepBundles;
    fs.writeFileSync(PROFILE_PACKAGE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { ok: false, reason: `写入 profile package.json 失败：${error && error.message ? error.message : String(error)}` };
  }

  return { ok: true, removed, originalBundles: bundles.slice() };
}


/**
 * 沙箱 / Agent shell 会往 PATH 里注入的、对宿主有害或无意义的目录。
 *
 * 实测两种来源：
 *   - WorkBuddy 工具 shell：`…/app.asar.unpacked/cli/vendor/shim/safe-bin`
 *     以及 `~/.workbuddy/binaries/{node,python}/…` —— 后者会**抢在 nvm 前面**，
 *     让宿主的子进程拿到另一个 node（版本不同，排查时极具干扰性）；
 *   - 其它沙箱包装：`…/brokered-bin`。
 */
const SANDBOX_PATH_PATTERNS = [
  /app\.asar\.unpacked/,
  /(^|\/)safe-bin(\/|$)/,
  /(^|\/)brokered-bin(\/|$)/,
  /\/\.workbuddy\/binaries\//,
];

/**
 * 必须从宿主环境里剔除的变量。
 *
 * 代理类：若本守护是被 Agent / 沙箱 shell 间接带起来的，`process.env` 里可能带着
 * 「**只在那一次工具调用期间存在**」的 `HTTP_PROXY=http://127.0.0.1:<随机端口>`。
 * 它一旦传染给宿主，端口关闭后宿主**所有**出网请求瞬间 ECONNREFUSED
 * （details.durationMs 只有个位数毫秒）。表现为 IM 通道「暂时无法访问微信服务」，
 * 而走 127.0.0.1、被 NO_PROXY 覆盖的模型 provider **照常可用** ——
 * 「只有 IM 坏、模型好用」这个组合极易被误判成插件故障、甚至「该回滚版本了」。
 * 2026-09-27 实际发生过一次（当时是从 Agent 侧执行 start.sh 重启宿主）。
 */
const STRIPPED_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'CODEBUDDY_SERVICE_PROXY_URL',
  'CODEBUDDY_MCP_CONFIG',
  'WORKBUDDY_CONNECTOR_PROXY_FINGERPRINT',
];

/**
 * 构造交给宿主的环境变量。
 *
 * 为什么不能直接 `env: { ...process.env }`：
 *
 * 1. **launchd 给的环境是残缺的**。实测 `launchctl print` 的 default environment 为
 *    `PATH=/usr/bin:/bin:/usr/sbin:/sbin` —— 里面**没有 node bin 目录**。宿主自身用
 *    绝对路径拉起所以能跑，但它派生出去的**任何**子进程都继承这个残缺 PATH：
 *    子代理 / 插件 shell-out 想调 `claude`、`codex` 或用户自定义命令时会
 *    `command not found`，而报错发生在离这里很远的地方，追起来极难。
 *
 * 2. **反向的坑**：见 {@link STRIPPED_ENV_KEYS} 与 {@link SANDBOX_PATH_PATTERNS} ——
 *    同一个函数要同时防住「环境太贫」和「环境太脏」两种污染。
 *
 * ⇒ 交给宿主的环境必须**显式重建**：先删代理与沙箱残留，再补 node bin 与标准目录。
 * 注意只做「删可疑项 + 补缺失项」，**不整体覆盖 PATH** —— 用户自己终端里的
 * nvm / homebrew / java 等自定义路径要原样保留。
 *
 * @returns 供 spawn 使用的环境对象（是新对象，不复用 process.env）。
 */
function childEnv() {
  const env = { ...process.env };

  for (const key of STRIPPED_ENV_KEYS) delete env[key];

  const dirs = String(env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !SANDBOX_PATH_PATTERNS.some((re) => re.test(dir)));

  for (const dir of [
    path.dirname(process.execPath), // node 所在目录，保证子进程能调 node/包自带命令
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }

  env.PATH = dirs.join(path.delimiter);
  env.DSH_HOME = path.join(os.homedir(), '.dsh');
  env.DSH_TELEMETRY_DISABLED = '1';
  return env;
}

/**
 * 主流程：检查占用 → 启动 dsh → 轮询等就绪 → 等结束 → 退出时用本轮日志段终审并分类。
 */
async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // 等一个「可以启动」的时机。用循环而非顺序的 if：两种等待都可能反复出现
  // （等对方出结果 → 对方失败 → 我们接管 → 又被别的实例抢走 → 再等）。
  for (;;) {
    // 端口已被占用：转入待命，占用者退出后立刻接管（详见 standbyUntilFree 的说明）。
    if (await isPortListening(port)) {
      writeCount(0); // 端口被占不是启动失败，清掉历史计数
      LOG.write(
        `端口 ${port} 已被占用：转入待命守候，占用者退出后接管（取消「跟随系统启动」可终止守护）。注意：${PORT_BUSY_CAVEAT}`,
      );
      await standbyUntilFree(port);
      continue;
    }

    // 没人监听，但另一通道正在启动宿主：让路。
    // 此刻端口是空的（新宿主还在加载插件树），我们要也启动就是两个实例各加载一遍插件树、
    // 先 bind 的赢 —— 输的那个在本轮日志段里留下 EADDRINUSE 退出，看着像随机故障。
    // 让路不损失接管能力：对方失败则锁释放，下一轮循环由我们启动。
    const starting = startingLockHolder(port);
    if (starting !== null) {
      LOG.write(
        `检测到另一通道正在启动宿主（启动锁 ${startingLockFile(port)}，持有者 pid ${starting}）：本轮让路，等它出结果`,
      );
      await waitWhileStarting(port);
      continue;
    }

    break;
  }

  const failures = readCount();
  if (failures >= MAX_RETRY) {
    // 放弃之前按「代价从小到大」逐级降级，而不是一上来就把 dsh 回滚掉。
    // 走到这里时插件早已随旧宿主一起消失，除了本脚本没有第二个能救场的地方，
    // 所以这套降级必须留在守护里，不能指望插件。
    const pending = readPendingUpgrade();
    const segment = readLogTail();
    const suspects = parseSuspects(segment);

    /**
     * ① 先试安全模式：保住新版本，只把第三方插件摘出去。
     *
     * 为什么优先于回滚：回滚只能让服务回到旧版，肇事插件还在，下次升级必然再撞一次
     * —— 用户会被永久钉在旧版本上。而 dsh 的启动容错只对「非核心条目」生效
     * （见 app-boot 的 auditStartupEntries），一旦某个插件 patch 坏了核心条目，
     * 整树就会 fail-loud。安全模式把第三方 bundle 全摘掉、只留官方包与本插件，
     * 正好绕开这一类。
     *
     * 只在两种情况下启用，避免「主程序真坏了」时误动用户配置：
     *   - 有未验证的升级（说明刚换了版本，高度可疑）；
     *   - 日志里确实解析出第三方插件加载失败。
     */
    if (readSafeMode() === null && (pending !== null || suspects.length > 0)) {
      const entered = enterSafeMode({ pending, suspects, diagnostic: segment });
      if (entered.ok) {
        LOG.write(
          `已连续失败 ${failures} 次：进入安全模式，临时停用 ${entered.removed.length} 个第三方 bundle（${entered.removed.join('、')}）`,
        );
        LOG.write(
          suspects.length > 0
            ? `日志中解析到的第三方插件：${suspects.join('、')}`
            : '日志里未解析出具体插件名，按「整个第三方集」隔离',
        );
        LOG.write('保留当前 dsh 版本；重启后仍失败才会回滚主程序。可在插件的「设置 → 通用」里一键恢复');
        writeCount(0);
        process.exit(1);
      }
      LOG.write(`安全模式不可用：${entered.reason}`);
    }

    // ② 安全模式救不了（或已在安全模式）：回滚 dsh 主程序，这是最后一道。
    if (pending !== null) {
      LOG.write(
        `已连续失败 ${failures} 次，且存在未验证的升级 ${pending.from} → ${pending.to}：判定为新版本起不来，开始自动回滚`,
      );
      const result = rollbackPendingUpgrade(pending);
      LOG.write(`自动回滚${result.ok ? '成功' : '未完全成功'}：${result.detail}`);
      if (result.ok) {
        // 计数清零 + 非 0 退出：交回系统的失败重启策略，让本脚本被重新拉起，
        // 下一轮就用旧版本启动宿主。这里**不能**用 0 退出 —— 0 在 launchd
        // KeepAlive{SuccessfulExit:false} 语义下表示「正常结束，别再拉我」，
        // 服务会永远起不来，正好与回滚的目的相反。
        writeCount(0);
        LOG.write('已回到旧版本，重新进入启动循环');
        process.exit(1);
      }
      LOG.write('自动回滚未成功，需人工介入');
    }
    LOG.write(`已连续失败 ${failures} 次（上限 ${MAX_RETRY}），放弃自动拉起，需人工介入`);
    process.exit(0);
  }

  const { node, dsh } = locateDsh();
  if (!fs.existsSync(dsh)) {
    LOG.write(`找不到 dsh 入口：${dsh}（node=${node}），放弃启动`);
    process.exit(1);
  }

  // 拉起之前先清孤儿凭据锁：残留锁会让 dsh 每次 boot 都失败，且 dsh 永不自愈。
  const clearedLock = clearOrphanCredentialLock();
  if (clearedLock) {
    LOG.write(`清理孤儿凭据锁 ${clearedLock}（持有者已不存在；dsh 自身不清理残留锁）`);
  }

  LOG.write(`第 ${failures + 1} 次尝试启动，端口 ${port}，node=${node}`);

  const startedAt = Date.now();
  const logStart = logSize();
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(node, [dsh, 'web', '--port', String(port), '--no-open'], {
    cwd: HOME_DIR,
    stdio: ['ignore', logFd, logFd],
    // 环境必须**显式重建**，不能直接继承 process.env：
    // launchd 给的 PATH 缺 node bin（宿主的子进程会 command not found），
    // 而沙箱来源的 process.env 又可能带「只在那次调用期间存在」的死代理。
    // 两种污染都交给 childEnv() 处理，详见其文档注释。
    env: childEnv(),
    // 必须脱离本进程的会话/进程组。launchd 停一个 job 时是向**整个进程组**发信号，
    // 若宿主与守护同组，`launchctl unload`（用户点「取消跟随系统启动」走的就是它）
    // 会把宿主一并收走 —— 用户侧表现为「一取消自启，服务就被杀」，
    // 且守护来不及写退出日志，现象是「服务凭空消失」。
    // detached 后宿主自成会话，unload 只停守护、服务照常运行，
    // 这才是「取消自启」应有的语义：不再守护，但不中断服务。
    // 不影响父子关系：child.once('exit') 照常，崩溃自动拉起的能力不变。
    detached: true,
    // Windows 下 .cmd/.exe 需要 shell 才能正确解析；node 是 .exe，保持 false 更安全。
    windowsHide: true,
  });
  // 子进程已持有该 fd 的副本，父进程这份必须关掉，否则每轮重启泄漏一个句柄。
  fs.closeSync(logFd);

  // 登记锁：宿主会活很久，锁就一直有效，任何后来者（start.sh、插件的重启脚本、
  // 乃至下一轮的自己）看到活着的持有者都会让路。这是本守护参与互斥的那一半。
  writeStartingLock(port, child.pid);

  // 就绪探测：等 dsh 打印 token 行（见 {@link READY_MARKER}），而不是等端口监听 ——
  // 监听者是插件树里的一个 entry，端口通既不代表树加载成功，也不代表持有者是我们。
  // 这个循环只负责「早点记一行日志」和「别空转」；结论在下方退出环节做终审。
  const readyDeadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < readyDeadline) {
    if (hasReadySignal(logStart)) {
      ready = true;
      break;
    }
    // 子进程已退出（boot 失败会走到这里）→ 本轮不算就绪，不必干等到超时。
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (ready) {
    LOG.write(`服务已就绪（端口 ${port}，pid ${child.pid}）`);
  } else if (child.exitCode !== null) {
    LOG.write(`服务在启动过程中退出（端口 ${port}，pid ${child.pid}），未就绪`);
  } else {
    LOG.write(
      `尚未捕获就绪标记（端口 ${port}，pid ${child.pid}，已轮询 ${READY_TIMEOUT_MS / 1000}s）——进程仍在运行，继续等待，结论以退出时的日志段为准`,
    );
  }

  // 等待服务结束——这一步是「脚本生命周期 = 服务生命周期」的关键。
  // 一并取 signal：被信号杀死时 exitCode 是 null，过去用 `?? 1` 兜底会在日志里
  // 写成「exit 1」，把「被 SIGTERM 收走」误报成「自己崩溃退出」，误导排查。
  const { code, signal } = await new Promise((resolve) => {
    child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    // 若进程早已退出，exit 事件可能已经错过，这里补一次判断。
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });

  // 就绪终审：进程已退出，本轮日志段此刻才是完整的。
  // 慢启动实例的 token 行可能晚于 READY_TIMEOUT_MS 才落盘 —— 不在这里补扫一次，
  // 一个「起得来只是慢」的服务会被判成启动失败。这正是旧版靠「端口在监听」兜底
  // 想防、却防反了的那件事（旧兜底把 boot 失败的实例放行了，反而漏掉真凶）。
  // 能读到全量是因为 stdio 把子进程的 stdout/stderr 与守卫日志指向同一个文件，
  // 而对文件描述符的写是同步的：进程退出时它的输出必然已落盘。
  const segment = readLogSegment(logStart);
  if (!ready && segment.includes(READY_MARKER)) {
    ready = true;
    LOG.write(
      `服务已就绪（端口 ${port}，pid ${child.pid}）：就绪标记晚于 ${READY_TIMEOUT_MS / 1000}s 轮询窗口才落盘`,
    );
  }

  const aliveMs = Date.now() - startedAt;
  const aliveS = Math.round(aliveMs / 1000);
  /** 退出方式的可读描述（供日志与分类使用）。 */
  const how = signal ? `被信号 ${signal} 终止` : `exit ${code}`;

  if (code === 0) {
    writeCount(0);
    LOG.write(`服务正常退出（exit 0），存活 ${aliveS}s，计数清零`);
    process.exit(1); // 交回系统重启策略，实现「重启按钮/手动停止后自动拉起」
  }

  // 分类判据：本次是否**真正启动完成过**（ready 来自日志段里的 token 行，不是端口）。
  //   ready = true  → 服务起来过，这是运行期结束，不该累计失败计数
  //                   （否则反复重启会耗尽配额、把能跑的服务永久熔断）。
  //   ready = false → 压根没起来（boot 失败），这才是启动失败，需要累计并熔断。
  // 比「存活时长 >= 60s」准确：后者会把「启动失败但拖了 60s 才退」当成正常运行。
  if (ready) {
    writeCount(0);
    LOG.write(`服务结束（${how}），存活 ${aliveS}s（曾成功启动，属运行期退出），计数清零`);
    process.exit(1);
  }

  // 端口竞态：本轮段里有 EADDRINUSE ⇒ 内核拒绝了**我们**的绑定，端口当时被另一个
  // 实例占着。这不是「我们的启动失败」，按待命语义处理、不计失败 —— 否则会把正确
  // 行为累计成故障，几轮之后误触 MAX_RETRY 把守护永久熔断。下一轮开头的端口预检
  // 会转入待命，接管逻辑不受影响。
  if (segment.includes(PORT_TAKEN_MARKER)) {
    LOG.write(
      `服务退出（${how}），存活 ${aliveS}s：端口 ${port} 当时被另一实例占用（${PORT_TAKEN_MARKER}），非本实例启动失败，不计入失败次数`,
    );
    process.exit(1);
  }

  const next = readCount() + 1;
  writeCount(next);
  LOG.write(
    `服务快速退出（${how}），仅存活 ${aliveS}s（未成功启动，属启动失败），累计失败 ${next} 次`,
  );
  process.exit(1);
}

main().catch((error) => {
  LOG.write(`守护脚本异常：${error && error.stack ? error.stack : String(error)}`);
  process.exit(1);
});
