#!/bin/sh
# dsh-restart-autostart 守护 · 安全模式回归测试
#
# 跑法：  sh test/guard-safe-mode.test.sh
# 依赖：  node 在 PATH。被测运行体默认包内 lib/guard/guard.js（可用 DSH_RESTART_GUARD 覆盖）。
#
# 影响面：**全部在临时假 HOME 里**（$TMPDIR/dsh-safe-test.$$），不碰真 ~/.dsh、
#         不碰真 ~/.dsh-restart-autostart、不碰任何真实端口（只用 $GTEST_PORT 做一次占用探测）。
#
# 它在验什么：dsh 升级后新版本起不来时，守卫应当**先牺牲第三方插件**、而不是直接
# 回滚主程序 —— 顺序错了用户的插件集就白丢了。四条断言：
#
#   1. 进安全模式：只摘第三方，官方包与「本插件自己」留下；
#   2. 「本插件自己」必须在保留名单里，否则恢复入口随之消失（2026-10 修过一次）；
#   3. 已在安全模式时再连败：不再改 profile，放弃拉起（退出码 0）；
#   4. clearSafeMode() 能把 bundles 按**原始顺序**整份写回，并清掉状态文件。
#
# 为什么第 4 条要单测：bundles 是**有序**的（顺序决定 patch 层叠）。「把摘掉的逐个插回」
# 会静默改变顺序 —— 服务起得来，但覆盖关系反了，是那种几个月后才发现的错。
set -u

PORT="${GTEST_PORT:-3097}"
GUARD="${DSH_RESTART_GUARD:-$(cd "$(dirname "$0")/.." && pwd)/lib/guard/guard.js}"
PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${TMPDIR:-/tmp}/dsh-safe-test.$$"

# 假 HOME 里的三个关键文件。路径格式必须与 guard.js 的常量一致。
FAKE_HOME="$ROOT/home"
PROFILE="$FAKE_HOME/.dsh/profiles/web/package.json"
STATE_DIR="$FAKE_HOME/.dsh-restart-autostart"
LOG_FILE="$STATE_DIR/logs/autostart-$PORT.log"
CNT_FILE="$STATE_DIR/logs/autostart-$PORT.count"
SAFE_FILE="$STATE_DIR/safe-mode.json"
pass=0
fail=0

cleanup() {
  # 万一守卫在后台待命（端口被占时它会一直守），连端口一起收掉。
  pkill -f "guard.js --port $PORT" 2>/dev/null
  pkill -f "guard.mjs --port $PORT" 2>/dev/null
  rm -rf "$ROOT"
}
trap cleanup EXIT INT TERM

[ -f "$GUARD" ] || { echo "找不到守卫 $GUARD"; exit 2; }

# ── 假世界：dsh 入口树 + 假 HOME + 一份「第三方插件很多」的 profile ────────────
mkdir -p "$ROOT/bin" "$ROOT/lib/node_modules/@deepseek-ai/dsh/lib" \
  "$FAKE_HOME/.dsh/profiles/web" "$STATE_DIR/logs"
if ! ln -f "$(command -v node)" "$ROOT/bin/node" 2>/dev/null; then
  cp "$(command -v node)" "$ROOT/bin/node" || exit 2
fi
cp "$HERE/fake-dsh.js" "$ROOT/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="$ROOT/bin/node"

# bundles 顺序刻意混排官方与第三方：能验证「保留后顺序不变」。
cat >"$PROFILE" <<'JSON'
{
  "name": "dsh-profile-web",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-better-sidebar",
        "@deepseek-ai/dsh-experimental-terminal-bundle",
        "dsh-plugin-suite",
        "@tr1v3r/dsh-ltm"
      ]
    }
  }
}
JSON
cp "$PROFILE" "$ROOT/original.json"

# 让守卫读到「上一次启动失败的现场」。这段与 dsh-app-boot 的实际输出同形。
seed_log() {
  cat >"$LOG_FILE" <<'TXT'
[2026-10-27T02:00:00.000Z] 启动宿主：node lib/bin.js web --port 3097
StartupError: 2 startup entries failed to load
  Failed plugins:
    Package: dsh-better-sidebar
    Package: @tr1v3r/dsh-ltm
TXT
}

# 预置失败计数为 MAX_RETRY（3），守卫一进循环就走降级分支，不必真去拉 dsh。
run_guard() {
  printf '3' >"$CNT_FILE"
  APP=1 HOME="$FAKE_HOME" GTEST_SCENARIO=incompat \
    "$NODE" "$GUARD" --port "$PORT" >/dev/null 2>&1
  echo $?
}

# ── 断言 1 + 2：进入安全模式 ────────────────────────────────────────────────
seed_log
code="$(run_guard)"
if [ "$code" = "1" ] && [ -f "$SAFE_FILE" ]; then
  echo "PASS  enter     连败 3 次后进入安全模式（退出码 1，交回系统重拉）"
  pass=$((pass + 1))
else
  echo "FAIL  enter     期望退出码 1 且写出 safe-mode.json，实际退出码 $code"
  sed 's/^/        /' "$LOG_FILE" 2>/dev/null
  fail=$((fail + 1))
fi

# 一条断言查三件事：官方包留下、本插件（dsh-plugin-suite）留下、第三方被摘且顺序不变。
verdict="$("$NODE" -e '
const fs = require("fs");
const profile = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const now = profile.dsh.profile.bundles;
const want = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-experimental-terminal-bundle", "dsh-plugin-suite"];
const removed = state.removed || [];
const problems = [];
if (JSON.stringify(now) !== JSON.stringify(want)) problems.push("保留集/顺序不对：" + JSON.stringify(now));
if (!now.includes("dsh-plugin-suite")) problems.push("本插件被一起摘掉了 —— 恢复入口会消失");
if (!removed.includes("dsh-better-sidebar") || !removed.includes("@tr1v3r/dsh-ltm")) {
  problems.push("第三方没有被摘：" + JSON.stringify(removed));
}
if ((state.originalBundles || []).length !== 6) problems.push("originalBundles 没存全量快照");
if (!(state.suspects || []).includes("dsh-better-sidebar")) problems.push("suspects 没解析出肇事插件");
console.log(problems.length === 0 ? "OK" : problems.join(" | "));
' "$PROFILE" "$SAFE_FILE" 2>&1)"
if [ "$verdict" = "OK" ]; then
  echo "PASS  isolate   只摘第三方，官方包与本插件保留，顺序不变，快照完整"
  pass=$((pass + 1))
else
  echo "FAIL  isolate   $verdict"
  fail=$((fail + 1))
fi

# ── 断言 3：已在安全模式再连败 → 放弃拉起，且不再动 profile ────────────────
before="$(cat "$PROFILE")"
seed_log
code="$(run_guard)"
after="$(cat "$PROFILE")"
if [ "$code" = "0" ] && [ "$before" = "$after" ] && grep -qF "放弃自动拉起" "$LOG_FILE"; then
  echo "PASS  give-up   已在安全模式又连败：不再改 profile，退出码 0 放弃拉起"
  pass=$((pass + 1))
else
  echo "FAIL  give-up   期望退出码 0 且 profile 不变，实际退出码 $code（profile 有变化：$([ "$before" = "$after" ] && echo 否 || echo 是)）"
  tail -3 "$LOG_FILE" | sed 's/^/        /'
  fail=$((fail + 1))
fi

# ── 断言 4：clearSafeMode() 按原始顺序整份写回 ──────────────────────────────
restore="$(HOME="$FAKE_HOME" "$NODE" --input-type=module -e '
import fs from "node:fs";
const mod = await import(process.argv[1]);
const result = mod.clearSafeMode();
const profile = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const original = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const same = JSON.stringify(profile.dsh.profile.bundles)
  === JSON.stringify(original.dsh.profile.bundles);
const cleared = !fs.existsSync(process.argv[4]);
console.log(result.ok && same && cleared ? "OK" : `ok=${result.ok} same=${same} cleared=${cleared} detail=${result.detail || ""}`);
' "$PKG_ROOT/lib/upgrade/index.js" "$PROFILE" "$ROOT/original.json" "$SAFE_FILE" 2>&1)"
if [ "$restore" = "OK" ]; then
  echo "PASS  restore   恢复插件：bundles 按原始顺序整份写回，状态文件已清"
  pass=$((pass + 1))
else
  echo "FAIL  restore   $restore"
  fail=$((fail + 1))
fi

echo "----------------------------------------"
echo "$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ] || exit 1
