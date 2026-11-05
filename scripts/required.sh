#!/usr/bin/env bash
# 必跑清單（外層由 ci.sh 以 timeout 600 包住）。
# E2E 放置規則（PM 決定，確定性）：
#   依 .ci/e2e-seconds（上次實測 E2E 秒數）與 .ci/required-seconds（上次實測單元測試秒數）：
#   - 無紀錄，或 e2e ≤180 且 required+e2e ≤600 → E2E 併入必跑（本次以 timeout 180 執行）
#   - 否則 → E2E 移出必跑，由 ci.sh 第 8 步另跑（上限 600 秒，仍阻擋合併）
#   E2E 在必跑中超過 180 秒 → 本次紅燈，並記錄 181，下次自動移出。
set -uo pipefail
cd "$(dirname "$0")/.."; mkdir -p .ci
e2e=$(cat .ci/e2e-seconds 2>/dev/null || echo 0); req=$(cat .ci/required-seconds 2>/dev/null || echo 0)
if [ "$e2e" -le 180 ] && [ $((req + e2e)) -le 600 ]; then place=required; else place=gate; fi
echo "$place" > .ci/e2e-placement
echo "E2E 放置：$place（上次 E2E ${e2e}s、必跑 ${req}s）"
t=$SECONDS; node scripts/tests.mjs; rc=$?; echo $((SECONDS-t)) > .ci/required-seconds
[ $rc -ne 0 ] && exit $rc
if [ "$place" = required ] && [ "${SKIP_E2E:-0}" != 1 ]; then E2E_TIMEOUT=180 bash scripts/e2e.sh; exit $?; fi
exit 0
