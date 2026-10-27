/**
 * 假 dsh 入口 —— 给 guard 的退出分类做回归测试用（配合 guard-classify.test.sh）。
 *
 * 它**不监听任何端口**，只按 `GTEST_SCENARIO` 往 stderr 打印、按剧本退出，
 * 于是可以在不碰真 dsh、不碰 ~/.dsh、不碰线上端口的前提下，把守卫的每条分类路径都走一遍。
 *
 * 形态：
 *   race      打印 webserver 的 listen EADDRINUSE 后 exit 1  → 端口竞态
 *   ready     打印 hub 行 + 带 token 的访问地址后 exit 1     → 曾成功启动
 *   bootfail  打印别的插件抛错后 exit 1                      → 启动失败
 *   incompat  打印 dsh **真实**的启动诊断块（`Package: <包名>`）后 exit 1
 *             → 启动失败，且能让 guard 的 parseSuspects 解析出肇事插件
 *   slow      先沉默 GTEST_SLOW_MS（默认 65s）再打印 token 行、exit 1 → 慢启动
 *
 * ⚠️ 分支必须写成 if/else-if 链：`slow` 那条要靠 setTimeout 留住进程，若与别的分支平铺成
 * 一组 `if`，它会掉到文件末尾的兜底里被立刻 `process.exit(1)` 杀掉（现象是日志里出现
 * 「未知 scenario slow」，且守卫 0s 就判定退出）。
 */

const scenario = process.env.GTEST_SCENARIO || 'race';
const warn =
  '(node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n' +
  "(Use `node --trace-warnings ...` to show where the warning was created)\n";

function readyLines() {
  process.stderr.write('[hub] routes mounted (profile=web, loader=provided)\n');
  process.stderr.write('dsh web: http://127.0.0.1:3099/?token=FAKE_TOKEN_FOR_TEST\n');
}

if (scenario === 'race') {
  process.stderr.write(warn);
  process.stderr.write(
    'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): ' +
      'failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): ' +
      'listen EADDRINUSE: address already in use 127.0.0.1:3099\n',
  );
  process.exit(1);
} else if (scenario === 'ready') {
  process.stderr.write(warn);
  readyLines();
  process.exit(1);
} else if (scenario === 'bootfail') {
  process.stderr.write(warn);
  process.stderr.write(
    'Error: dsh: plugin tree failed to load: failed to apply loader entry some-later-plugin: boom\n',
  );
  process.exit(1);
} else if (scenario === 'incompat') {
  // 与 dsh-app-boot 实际打印的启动诊断**逐字同形**：parseSuspects 依赖这两个格式，
  // 一旦 dsh 改了措辞，这条剧本应当随之失效 —— 那正是我们想被提醒的事。
  process.stderr.write(warn);
  process.stderr.write(
    'StartupError: 2 startup entries failed to load\n' +
      '  Failed plugins:\n' +
      '    Package: dsh-better-sidebar\n' +
      '    Package: @tr1v3r/dsh-ltm\n',
  );
  process.exit(1);
} else if (scenario === 'slow') {
  process.stderr.write(warn);
  setTimeout(() => {
    readyLines();
    process.exit(1);
  }, Number(process.env.GTEST_SLOW_MS || 65000));
} else {
  process.stderr.write('fake-dsh: 未知 scenario ' + scenario + '\n');
  process.exit(1);
}
