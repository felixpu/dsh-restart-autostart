/**
 * 手动重启 —— 把「停旧宿主 → 等端口释放 → 拉起 dsh web」这件事做完。
 *
 * 与 guard/ 的分工：
 *   manual/  用户点按钮时的一次性重启（本模块），不留任何常驻物；
 *   guard/   开机自启与崩溃守护，落盘为系统条目并由系统机制守护。
 *
 * 两者共用同一个事实：「怎么在本平台正确拉起 dsh web」。该事实体现在本模块的
 * RESTART_SCRIPT 与 guard/guard.js 各自的启动分支中，且**必须两边一致**：
 *   - 参数：`--port <port> --no-open`；
 *   - 可执行文件：都用「当前 node」推导出的**绝对路径**（见 RESTART_SCRIPT 的 locateDsh）。
 *     历史上本模块用的是裸 `dsh`，依赖 PATH —— 而宿主完全可能由 IDE / 桌面应用拉起，
 *     那样 PATH 里没有 dsh，`spawn` 直接 ENOENT；父进程又把它 drop 在 stdio ignore 里，
 *     连一行报错都没有，用户侧只看到「点了没反应、也起不来」。这与守卫的行为不一致，
 *     且是所有启动失败里最不可诊断的一种。
 *
 * 两边还必须做同一件收尾动作：**拉起 dsh 之前清掉孤儿凭据锁**（见 RESTART_SCRIPT
 * 里的 clearOrphanLock）。本模块正是高发触发点 —— 它 SIGTERM 宿主，而宿主的优雅
 * 关闭流程里可能正好在写凭据，锁没清掉就会让下一次启动永久失败。
 *
 * @module dsh-restart-autostart/manual/restart
 */
import { spawn } from 'node:child_process';

/**
 * 跨平台宿主重启脚本（以 `node -e` 运行，独立于宿主进程）。
 *
 * 流程：按端口找出监听进程 → 逐个终止 → 轮询等待端口释放（最多约 5s）→
 * 以 detached 方式重新拉起 `dsh web --port <port> --no-open`，日志追加到
 * `~/.dsh/logs/dsh-web-<port>.log`。
 *
 * 带 `--no-open` 的原因：`dsh web` 默认在启动末尾调用浏览器打开 UI，这是为
 * 「终端里手动敲命令启动」设计的。但重启走的是同一条启动路径，会导致每次点
 * 按钮都多开一个标签页；重启时用户本来就有页面开着，故显式关闭该行为，
 * 由前端轮询到服务恢复后自己 `location.reload()` 刷新当前页。
 *
 * 不能用 /bin/sh：Windows 无此路径；必须 detached：本插件所在的宿主进程随即
 * 被 kill，重启必须在宿主之外继续执行。
 */
const RESTART_SCRIPT = String.raw`const C = require('node:child_process')
const F = require('node:fs')
const P = require('node:path')
const O = require('node:os')
const win = process.platform === 'win32'
const port = Number(process.argv[1])

/**
 * 清理 dsh 的孤儿凭据锁（dsh 自身永不清理）。
 *
 * dsh 的 atomic-write 用 wx 独占创建 <credentials>.lock 当写锁，靠「文件存在」判
 * 占用，且不回收残留锁。宿主若在凭据原子写的中途被杀，就会留下 0 字节锁，此后每次
 * boot 都在 dsh-client-connection 处超时失败、永不自愈 —— 报错还会伪装成
 * 「插件树加载失败」，极难定位。手动重启正是高发触发点，故拉起新宿主前先清一次。
 *
 * 判据取锁里记录的持有者 pid：读不到或已不存在 → 孤儿，清掉；
 * 能探测到存活（或 EPERM 无权探测）→ 视为活锁，不动。
 *
 * 返回值与 guard/guard.js 的同名逻辑保持一致：清理了返回锁路径，未清理返回 null。
 * 本模块不消费返回值，统一只为两边行为可预期。
 */
function clearOrphanLock() {
  const lock = P.join(O.homedir(), '.dsh', '.credentials.yaml.lock')
  let raw = ''
  try { raw = String(F.readFileSync(lock, 'utf8')).trim() } catch (e) { return null }
  let alive = false
  const pid = Number(raw)
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); alive = true } catch (e) { alive = !!(e && e.code === 'EPERM') }
  }
  if (alive) return null
  try { F.rmSync(lock, { force: true }) } catch (e) { return null }
  return lock
}

function findPids() {
  if (win) {
    const out = C.spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
    const found = []
    for (const line of String(out.stdout || '').split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const addr = parts[1] || ''
      if (!addr.endsWith(':' + port)) continue
      const pid = parts[parts.length - 1]
      if (pid && /\d+/.test(pid)) found.push(pid)
    }
    return found
  }
  const out = C.spawnSync('lsof', ['-ti', 'tcp:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return String(out.stdout || '').split(/\s+/).filter(Boolean)
}

for (const pid of findPids()) {
  try {
    if (win) C.spawnSync('taskkill', ['/pid', pid, '/t', '/f'])
    else process.kill(Number(pid), 'SIGTERM')
  } catch {}
}

let tries = 0
;(function waitForStop() {
  if (findPids().length === 0 || ++tries > 20) return startHost()
  setTimeout(waitForStop, 250)
})()

/**
 * 定位 dsh 的入口 —— 与 guard/guard.js 的 locateDsh 同一套推导，两边必须一致。
 *
 * node 取 process.execPath：本脚本由 triggerRestart 用**宿主自己的 node** 拉起
 * （spawn(process.execPath, ['-e', ...])），所以这里的 execPath 就是宿主的 node；
 * dsh 入口按「与 node 同级的 lib/node_modules」推导（nvm / 官方安装器都是这个布局）。
 *
 * 不用裸 dsh：那依赖 PATH。宿主由终端启动时 PATH 里有 dsh（所以手动重启多半能成），
 * 但由 IDE / 桌面应用拉起时 PATH 往往没有，spawn 直接 ENOENT，而父进程 stdio 是 ignore，
 * 失败连一行日志都不会留下。
 */
function locateDsh() {
  const node = process.execPath
  const dsh = P.resolve(P.join(P.dirname(node), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  return { node, dsh }
}

function startHost() {
  // 旧宿主刚被 SIGTERM 收走，此刻最容易残留凭据锁 —— 拉起新的之前先清。
  clearOrphanLock()
  const dir = P.join(O.homedir(), '.dsh', 'logs')
  F.mkdirSync(dir, { recursive: true })
  const fd = F.openSync(P.join(dir, 'dsh-web-' + port + '.log'), 'a')

  /**
   * 往 dsh 自己的日志里补一行本插件的说明。
   *
   * 写进同一个文件是刻意的：用户/排查者只会去看 dsh-web-<port>.log，把「谁拉起的、
   * 用哪个入口、失败原因」写在这里，才不需要再去别处找。
   */
  const note = (msg) => {
    try { F.writeSync(fd, '[' + new Date().toISOString() + '] [dsh-restart-autostart] ' + msg + '\n') } catch (e) {}
  }

  const { node, dsh } = locateDsh()
  // 回退判据用同步 existsSync，而不是等 spawn 的 error 事件：
  // 事件是异步的，本脚本随后就退出，靠它记录有丢日志的风险（正是要消灭的「静默失败」）。
  let fallback = false
  try { fallback = !F.existsSync(dsh) } catch (e) { fallback = true }
  if (fallback) {
    note('未找到 dsh 入口 ' + dsh + '（由 node=' + node + ' 推导），回退为 PATH 里的 dsh')
  }

  const cmd = fallback ? 'dsh' : node
  const args = fallback
    ? ['web', '--port', String(port), '--no-open']
    : [dsh, 'web', '--port', String(port), '--no-open']
  const child = C.spawn(cmd, args, {
    detached: true,
    // 仅回退分支需要 shell：Windows 上 PATH 里的 dsh 是 .cmd，不经 shell 解析不了；
    // 正常分支的 cmd 是 node（.exe），保持 false 更安全。
    shell: fallback && win,
    stdio: ['ignore', fd, fd],
  })
  child.on('error', function (err) {
    note('拉起新宿主失败（' + cmd + '）：' + (err && err.message ? err.message : String(err)))
  })
  note('已拉起新宿主（node=' + node + '，dsh=' + (fallback ? 'PATH 里的 dsh' : dsh) + '）')
  child.unref()
}`;

/**
 * 发起一次重启：孵化 detached 子进程，随即返回（不等待结果）。
 *
 * 之所以不等待：本插件所在的宿主进程马上会被该子进程 kill，等待毫无意义。
 * 调用方应据此告诉前端「已受理」，由前端轮询 /health 判断何时真正恢复。
 * @param port - 宿主的服务端口。
 */
export function triggerRestart(port) {
  spawn(process.execPath, ['-e', RESTART_SCRIPT, String(port)], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}
