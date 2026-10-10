#!/bin/sh
# dsh-restart-autostart 守护 · 退出分类回归测试
#
# 跑法：  sh packages/dsh-restart-autostart/test/guard-classify.test.sh
# 依赖：  node 在 PATH；被测运行体默认 ~/.dsh-restart-autostart/guard.mjs（可用 DSH_RESTART_GUARD 覆盖）
# 影响面：只在测试端口上动 ~/.dsh-restart-autostart/logs/autostart-<port>.{log,count}（跑完删掉）；
#         不碰真 dsh、不碰 ~/.dsh、不碰线上端口。整轮约 70s（slow 那条要等 65s）。
#
# 原理：guard.js 的 locateDsh() 按
#         dirname(process.execPath)/../lib/node_modules/@deepseek-ai/dsh/lib/bin.js
#       推导 dsh 入口。所以只要用一个**硬链接到真 node** 的副本去跑 guard，
#       就能把入口引到临时假树，由 fake-dsh.js 按剧本演出各种退出形态。
#       这一招的价值在于：它跑的是**线上那份运行体**，而不是把判据复刻一份来测。
set -u

PORT="${GTEST_PORT:-3099}"
GUARD="${DSH_RESTART_GUARD:-$HOME/.dsh-restart-autostart/guard.mjs}"
SLOW_MS="${GTEST_SLOW_MS:-65000}"
ROOT="${TMPDIR:-/tmp}/dsh-guard-test.$$"
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/.dsh-restart-autostart/logs/autostart-$PORT.log"
CNT="$HOME/.dsh-restart-autostart/logs/autostart-$PORT.count"
pass=0
fail=0
STANDBY_PID=""
SQUAT_PID=""

# 防呆：这两个端口上跑着真服务，跑测试会把它的日志与计数覆盖掉。
case "$PORT" in
  3080 | 3081)
    echo "拒绝在端口 $PORT 上跑测试（会覆盖真实服务的日志与计数）。用 GTEST_PORT 指定测试端口。"
    exit 2
    ;;
esac

cleanup() {
  [ -n "$STANDBY_PID" ] && kill "$STANDBY_PID" 2>/dev/null
  [ -n "$SQUAT_PID" ] && kill "$SQUAT_PID" 2>/dev/null
  rm -rf "$ROOT"
  rm -f "$LOG" "$CNT"
}
trap cleanup EXIT INT TERM

[ -f "$GUARD" ] || {
  echo "找不到运行体 $GUARD —— 先在设置里启用一次「跟随系统启动」，或设 DSH_RESTART_GUARD 指到包内 lib/guard/guard.js。"
  exit 2
}

mkdir -p "$ROOT/bin" "$ROOT/lib/node_modules/@deepseek-ai/dsh/lib"
if ! ln -f "$(command -v node)" "$ROOT/bin/node" 2>/dev/null; then
  cp "$(command -v node)" "$ROOT/bin/node" || exit 2
fi
cp "$HERE/fake-dsh.js" "$ROOT/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="$ROOT/bin/node"

# check <名称> <scenario> <期望日志片段> <期望计数>
# 每轮先把计数垫成 2，以便看清分类是「不改 / 清零 / +1」。
check() {
  name="$1"
  scen="$2"
  want_line="$3"
  want_cnt="$4"
  printf '2' >"$CNT"
  : >"$LOG"
  GTEST_SCENARIO="$scen" GTEST_SLOW_MS="$SLOW_MS" "$NODE" "$GUARD" --port "$PORT" >/dev/null 2>&1
  got_cnt="$(cat "$CNT" 2>/dev/null)"
  if grep -qF "$want_line" "$LOG" && [ "$got_cnt" = "$want_cnt" ]; then
    echo "PASS  $name（计数 2 → $got_cnt）"
    pass=$((pass + 1))
  else
    echo "FAIL  $name"
    echo "      期望：计数 $want_cnt，日志含「$want_line」"
    echo "      实际：计数 $got_cnt，日志尾两行如下"
    tail -2 "$LOG" | sed 's/^/        /'
    fail=$((fail + 1))
  fi
}

check "race      端口被外来实例占" race "非本实例启动失败，不计入失败次数" 2
check "ready     起来了但非零退出" ready "曾成功启动，属运行期退出" 0
check "bootfail  插件树加载失败" bootfail "未成功启动，属启动失败" 3
check "slow      65s 才落 token" slow "就绪标记晚于" 0

# standby：端口先被占住。守护会永远守候，故起来后手动收掉，只验它有没有把
# 「占用者可能不是我自己的 dsh」这个前提写进日志（这是 2026-09-26 补的可观测性）。
printf '2' >"$CNT"
: >"$LOG"
node -e "const s=require('net').createServer();s.listen($PORT,'127.0.0.1');setTimeout(()=>process.exit(0),20000)" &
SQUAT_PID=$!
sleep 1
"$NODE" "$GUARD" --port "$PORT" >/dev/null 2>&1 &
STANDBY_PID=$!
sleep 3
kill "$STANDBY_PID" 2>/dev/null
STANDBY_PID=""
kill "$SQUAT_PID" 2>/dev/null
SQUAT_PID=""
if grep -qF "本守护分不清占用者是不是 dsh" "$LOG"; then
  echo "PASS  standby   待命日志讲清了占用者身份未知"
  pass=$((pass + 1))
else
  echo "FAIL  standby   待命日志没带上占用者身份未知的前提"
  tail -2 "$LOG" | sed 's/^/        /'
  fail=$((fail + 1))
fi

echo "----------------------------------------"
echo "$pass 通过 / $fail 失败"
[ "$fail" -eq 0 ] || exit 1
