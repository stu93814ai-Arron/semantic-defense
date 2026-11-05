#!/usr/bin/env bash
# 在乾淨 worktree 對指定提交（預設 HEAD）跑合併閘門，不動主工作目錄其他檔案。
# 跑完後把 .ci/gate-history.csv、.ci/e2e-seconds、.ci/required-seconds 帶回主目錄，
# 以同一個 ci 提交（只按路徑）記錄。用法：bash scripts/gate-clean.sh [rev]
# GATE_OUT=<dir>：不提交，只把三個紀錄檔複製到 <dir>（給 merge-team.sh 在 ff 之後再記錄）。
set -uo pipefail
cd "$(dirname "$0")/.."; MAIN=$PWD
REV=$(git rev-parse --short "${1:-HEAD}"); WT=$(mktemp -d /tmp/sd-gate-XXXX)
git worktree add -q --detach "$WT" "$REV"
# 帶入主目錄最新的度量紀錄（決定 E2E 放置）
for f in gate-history.csv e2e-seconds required-seconds; do [ -f ".ci/$f" ] && mkdir -p "$WT/.ci" && cp ".ci/$f" "$WT/.ci/$f"; done
( cd "$WT" && pnpm install --frozen-lockfile >/dev/null 2>&1 && bash scripts/gate.sh ); rc=$?
if [ -n "${GATE_OUT:-}" ]; then
  mkdir -p "$GATE_OUT"; for f in gate-history.csv e2e-seconds required-seconds; do [ -f "$WT/.ci/$f" ] && cp "$WT/.ci/$f" "$GATE_OUT/$f"; done
  git worktree remove --force "$WT"; exit $rc
fi
files=()
for f in gate-history.csv e2e-seconds required-seconds; do
  [ -f "$WT/.ci/$f" ] && cp "$WT/.ci/$f" ".ci/$f" && files+=(".ci/$f")
done
git worktree remove --force "$WT"
git add -- "${files[@]}"
git -c user.name="整合守門員" -c user.email=ci@local commit -q -m "ci: 記錄 $REV 閘門結果（$([ $rc -eq 0 ] && echo pass || echo fail)）" -- "${files[@]}" && git log --oneline -1
exit $rc
