#!/usr/bin/env bash
# 必跑被 SIGTERM 打斷時印出仍在跑的測試與最近的 pg 快照。目錄可覆寫（測試傳入）。
d=${1:-reports}
echo "::: 必跑被中斷，部分報告"
if [ -f "$d/vitest-live.json" ]; then
  echo "--- vitest-live ---"
  cat "$d/vitest-live.json"
fi
if [ -f "$d/pg-live.json" ]; then
  echo "--- pg-live ---"
  cat "$d/pg-live.json"
fi
if [ -f "$d/pg-live-term.json" ]; then
  echo "--- pg-live-term ---"
  cat "$d/pg-live-term.json"
fi
