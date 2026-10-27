/**
 * 主程序升级的落地动作 —— 备份、npm 安装、L1 校验、待验证状态、回滚。
 *
 * 安全模型（这是整个功能的重点，改这里前先读完）：
 *
 *   dsh 的**主程序**（npm 全局包）与**插件树**（`~/.dsh/profiles/<name>`）在物理上
 *   是分开的。`npm i -g` 只替换主程序，插件目录一个字节都不会动。所以升级不会丢插件，
 *   真正的风险只有一个：**新主程序与某个第三方插件的 API 不再兼容，导致插件树加载失败、
 *   宿主起不来**。用户侧表现就是「点了一下升级，服务再也打不开了」。
 *
 *   针对这个风险设了三道闸：
 *     ① 升级前把主程序**代码**整体备份（跳过 849MB 的 node_modules，实际只有 ~120KB），
 *        并记下版本号与前缀 —— 回滚的两条路都有据可依；
 *     ② 装完先做 L1（`dsh --version` 必须等于目标版本），不等它就得先确认「装到了该装的地方」；
 *     ③ 通过后写 **pending 状态**再重启宿主。pending 的含义是「这次升级还没被证实健康」：
 *        - 宿主随后成功启动并执行到插件 apply() ⇒ 说明插件树加载完了 ⇒ 清除 pending（见 upgrade/index.js）；
 *        - 宿主连续起不来 ⇒ guard.js 读到 pending ⇒ 自动回滚（见 guard/guard.js）。
 *
 *   ③ 是整套设计的核心：**用真实的启动路径做健康判据**，而不是另起一个临时实例去"试跑"。
 *   临时实例会和正在运行的宿主共用 `~/.dsh`，争用同一把 `.credentials.yaml` 写锁，
 *   还可能撞端口 —— 那会引入假失败，比不做验证更糟。
 *
 * @module dsh-restart-autostart/upgrade/install
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { HOME_DIR, PKG, dshPackageDir, localVersion, prefixDir } from './version.js';

/** 备份根目录。 */
export const BACKUP_DIR = path.join(HOME_DIR, 'backups');

/**
 * 「升级待验证」状态文件。
 *
 * ⚠️ 这个路径与格式被 `guard/guard.js` **逐字复制**了一份（它是单文件运行体，
 * 由 guard/index.js 拷到 ~/.dsh-restart-autostart/guard.mjs 交给 launchd 执行，
 * 不能 import 本地模块）。改这里的文件名或字段名，必须同步改 guard.js 里那份，
 * 否则自动回滚会读不到状态，安全网直接失效。
 */
export const PENDING_FILE = path.join(HOME_DIR, 'upgrade-pending.json');

/** 保留的备份份数，超出后删最旧的。 */
const KEEP_BACKUPS = 3;

/** npm 安装超时。849MB 依赖解包在本机实测约 30~90s，给足余量。 */
const INSTALL_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * 执行一个子进程并收集输出（带超时与输出上限）。
 *
 * @param command - 可执行文件。
 * @param args - 参数数组。
 * @param options - `{ timeoutMs, env }`。
 * @returns `{ ok, code, output }`；`output` 是 stdout+stderr 合并后的尾部。
 */
function runProcess(command, args, { timeoutMs = 60000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) {
      resolve({ ok: false, code: -1, output: String(error && error.message ? error.message : error) });
      return;
    }

    let output = '';
    const collect = (chunk) => {
      output += chunk;
      // 只留尾部：npm 的成功日志能刷几千行，没必要全存内存。
      if (output.length > 200000) output = output.slice(-100000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, code, output });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish(false, -1);
    }, timeoutMs);

    child.on('error', (error) => {
      finish(false, -1);
      output += `\n${error && error.message ? error.message : String(error)}`;
    });
    child.on('close', (code) => finish(code === 0, code ?? -1));
  });
}

/**
 * 定位 npm 的 CLI 入口，优先用**目标前缀自带的那一份**。
 *
 * 用 PATH 上的 `npm` 有两个隐患：它可能属于另一个 node 运行时（装出来的 bin 软链
 * 会指向错误的 node），也可能被 IDE / 桌面应用拉起的残缺 PATH 挡住而根本找不到。
 * 直接用「当前 node + 该前缀的 npm-cli.js」两个隐患都没有。
 *
 * @returns `{ command, args, found }`：found 为 false 时退化成 PATH 上的 npm。
 */
function npmCli() {
  const prefix = prefixDir();
  const cli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    if (fs.statSync(cli).isFile()) {
      return { command: process.execPath, args: [cli], found: true, prefix };
    }
  } catch {
    // 该前缀没有 npm（例如用 corepack / pnpm 装的）：走回退分支。
  }
  return { command: 'npm', args: [], found: false, prefix };
}

/**
 * 构造装包用的环境。
 *
 * 只删两个**会真正改变运行时行为**的变量，其余原样保留（用户自己的 registry、
 * 代理、npmrc 都该照旧生效 —— 升级要联网，把代理删了反而装不动）：
 *   - `NODE_OPTIONS`：从 IDE / Agent shell 继承来的可能是 `--require <某 shim>`，
 *     那个 shim 依赖外部上下文，塞给 npm 的 node 进程会直接崩；
 *   - `ELECTRON_RUN_AS_NODE`：只对 Electron 有意义，留着会让 node 分支行为异常。
 *
 * @returns 供 spawn 使用的环境对象。
 */
function installEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 备份主程序代码。
 *
 * 只备份包自身的文件（~120KB），**跳过 `node_modules`** —— dsh 的依赖树有 849MB，
 * 复制它既慢又占盘，而依赖本来就能由 npm 按版本重建。真到需要用备份兜底那一步
 * （npm 上旧版本被 unpublish），缺依赖也仍比「主程序代码全没了」好得多。
 *
 * @param version - 当前版本（写进状态，回滚时直接用）。
 * @returns 备份目录绝对路径。
 */
export function backup(version) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_DIR, `dsh-${version}-${stamp}`);
  const source = dshPackageDir();

  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(source, path.join(dir, 'dsh'), {
    recursive: true,
    dereference: false,
    filter: (item) => path.basename(item) !== 'node_modules',
  });

  pruneBackups();
  return dir;
}

/** 只保留最近 {@link KEEP_BACKUPS} 份备份，避免长期占用磁盘。 */
function pruneBackups() {
  try {
    const entries = fs.readdirSync(BACKUP_DIR)
      .filter((entry) => entry.startsWith('dsh-'))
      .map((entry) => {
        const full = path.join(BACKUP_DIR, entry);
        return { full, at: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
    for (const stale of entries.slice(KEEP_BACKUPS)) {
      fs.rmSync(stale.full, { recursive: true, force: true });
    }
  } catch {
    // 清理失败不影响升级。
  }
}

/**
 * 安装指定版本到当前前缀。
 *
 * `--prefix` 是必需的，不是保险：不加它，npm 会装到「它自己认为的」全局前缀，
 * 而本机存在多套 node 时那个前缀很可能不是宿主正在用的这一个。
 *
 * @param version - 目标版本。
 * @returns `{ ok, output }`。
 */
export async function install(version) {
  const cli = npmCli();
  const args = [...cli.args, 'install', '-g', `${PKG}@${version}`, '--prefix', cli.prefix];
  const result = await runProcess(cli.command, args, {
    timeoutMs: INSTALL_TIMEOUT_MS,
    env: installEnv(),
  });
  return { ok: result.ok, output: result.output, prefix: cli.prefix };
}

/**
 * L1 校验：`dsh --version` 必须等于期望版本。
 *
 * 这一层只证明「装到了该装的地方、入口能被这一版 node 跑起来」，**不证明**插件树
 * 能加载 —— 后者要靠重启后的真实启动（见模块头部的 ③）。
 *
 * @param expect - 期望版本；传 null 只要求命令成功。
 * @returns `{ ok, detail }`。
 */
export async function verifyL1(expect) {
  const bin = path.join(dshPackageDir(), 'lib', 'bin.js');
  const result = await runProcess(process.execPath, [bin, '--version'], { timeoutMs: 30000 });
  const got = result.output.trim();
  if (!result.ok) {
    return { ok: false, detail: `dsh --version 失败（exit ${result.code}）：${got.slice(0, 300)}` };
  }
  if (typeof expect === 'string' && expect !== '' && got !== expect) {
    return { ok: false, detail: `期望 ${expect}，实际 ${got}` };
  }
  return { ok: true, detail: got };
}

/**
 * 读 pending 状态。读不到或格式不对返回 null。
 * @returns `{ from, to, prefix, backupDir, at }` 或 null。
 */
export function readPending() {
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    if (typeof data.to !== 'string' || typeof data.from !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 写入 pending 状态（「这次升级还没被证实」）。
 * @param pending - 状态对象。
 */
export function writePending(pending) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
}

/** 清除 pending 状态（升级已被证实健康，或已回滚）。 */
export function clearPending() {
  try {
    fs.rmSync(PENDING_FILE, { force: true });
  } catch {
    // 清不掉也无害：下次 apply 会再判一次版本是否匹配。
  }
}

/**
 * 回滚到 pending 里记录的 `from` 版本。
 *
 * 两步，顺序是刻意的：
 *   1. **先恢复备份代码** —— 纯本地复制 120KB，毫秒级，保证入口文件必然存在。
 *      先跑 npm 的话，一旦 npm 因断网失败，包里可能只剩半截（npm 会先删目录再解包），
 *      那时连 `dsh --version` 都跑不起来，回滚彻底失败。
 *   2. **再跑 npm 装回旧版** —— 让 849MB 依赖也回到与旧代码匹配的版本。
 *      npm 失败不回滚整个流程：代码已经回去了，多数补丁版本间依赖差异很小，
 *      宿主大概率仍能启动，比「什么都不做」强。
 *
 * @param pending - pending 状态对象。
 * @returns `{ ok, detail }`。
 */
export async function rollback(pending) {
  const target = dshPackageDir();
  const steps = [];

  if (typeof pending.backupDir === 'string' && pending.backupDir !== '') {
    const source = path.join(pending.backupDir, 'dsh');
    try {
      if (fs.statSync(source).isDirectory()) {
        fs.cpSync(source, target, {
          recursive: true,
          force: true,
          filter: (item) => path.basename(item) !== 'node_modules',
        });
        steps.push('已恢复备份代码');
      }
    } catch (error) {
      steps.push(`恢复备份代码失败：${error && error.message ? error.message : String(error)}`);
    }
  }

  const installed = await install(pending.from);
  steps.push(installed.ok ? `npm 已装回 ${pending.from}` : 'npm 装回失败（代码已恢复，依赖可能仍是新版）');

  const verified = await verifyL1(pending.from);
  const detail = `${steps.join('；')}；${verified.ok ? `L1 通过（${verified.detail}）` : `L1 失败：${verified.detail}`}`;
  // 只要代码回去了就清 pending：留着它会让 guard 每轮都重试回滚，反而卡住启动循环。
  if (steps.length > 0) clearPending();
  return { ok: verified.ok, detail, version: localVersion() };
}
