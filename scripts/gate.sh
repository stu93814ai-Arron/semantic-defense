#!/usr/bin/env bash
# 合併閘門（PLAN.md「資安與合規」）；結果記入 .ci/gate-history.csv 以計算通過率
# 正式紀錄請用 scripts/gate-clean.sh（pnpm gate:clean [rev]）：乾淨 worktree 執行並一併提交 gate-history/e2e-seconds/required-seconds
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p .ci
start=$(date -Iseconds); rev=$(git rev-parse --short HEAD 2>/dev/null || echo none)
bash scripts/ci.sh; rc=$?
res=$([ $rc -eq 0 ] && echo pass || echo fail)
[ -f .ci/gate-history.csv ] || echo "time,rev,result" > .ci/gate-history.csv
echo "$start,$rev,$res" >> .ci/gate-history.csv
total=$(($(wc -l < .ci/gate-history.csv)-1)); ok=$(grep -c ',pass$' .ci/gate-history.csv)
echo "GATE: $res  (通過率 $ok/$total)"
exit $rc
