#!/usr/bin/env bash
# 整合守門員專用：把 team-a／team-b 快轉合入 main。用法：pnpm merge:team a|b [--deps-ok]
# 1) main 若只多了文件或 ci 提交（docs/**、*.md、.ci/**），自動把分支 rebase 到 main；有其他變更或衝突就停下來，請該組自己 rebase。
# 2) 改到 package.json／pnpm-lock.yaml 的提交必須是獨立的 deps: 提交，並經過審查（--deps-ok）。
# 3) 對分支跑完整閘門：紅燈不合入，在 main 記錄 fail。
# 4) 綠燈就 ff-only 合入（含依賴變更時先在主目錄 pnpm install --frozen-lockfile），在 main 記錄 pass；ff 失敗（閘門期間 main 前進）記錄 ff-failed，回到步驟 1 重試，最多 3 次。
set -euo pipefail
cd "$(dirname "$0")/.."
T=${1:?用法：merge-team.sh a|b [--deps-ok]}; B=team-$T; DEPS_OK=${2:-}; MAX=${MERGE_MAX_TRIES:-3}
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "必須在 main 目錄執行"; exit 1; }
DOCCI='^(docs/.*|.*\.md|\.ci/.*)$'

record() { # $1=rev $2=result
  local files=() out=$3
  for f in gate-history.csv e2e-seconds required-seconds; do [ -f "$out/$f" ] && cp "$out/$f" ".ci/$f" && files+=(".ci/$f"); done
  git add -- "${files[@]}"
  git -c user.name="整合守門員" -c user.email=ci@local commit -q -m "ci: 記錄 $1（$B）閘門結果（$2）" -- "${files[@]}"
  git log --oneline -1
}

# 分支目前 checkout 在哪個 worktree（沒有就用暫存 worktree 來 rebase）
wt_of() { git worktree list --porcelain | awk -v b="refs/heads/$B" '/^worktree /{w=substr($0,10)} $0=="branch " b {print w}'; }

auto_rebase() {
  git merge-base --is-ancestor main "$B" && return 0
  local base; base=$(git merge-base main "$B")
  local bad; bad=$(git diff --name-only "$base" main | grep -vE "$DOCCI" || true)
  if [ -n "$bad" ]; then echo "✗ main 有文件／ci 以外的新變更，請該組自己 git rebase main："; echo "$bad" | sed 's/^/    /'; return 1; fi
  local wt tmp=""; wt=$(wt_of)
  if [ -z "$wt" ]; then tmp=$(mktemp -d /tmp/sd-rebase-XXXX); git worktree add -q "$tmp" "$B"; wt=$tmp; fi
  if [ -n "$(git -C "$wt" status --porcelain --untracked-files=no)" ]; then
    echo "✗ $wt 有未提交的變更，無法自動 rebase，請該組先處理"; [ -n "$tmp" ] && git worktree remove --force "$tmp"; return 1; fi
  echo "↻ main 只多了文件／ci 提交，自動把 $B rebase 到 main（$wt）"
  if ! git -C "$wt" -c user.name="整合守門員" -c user.email=ci@local rebase -q main; then
    git -C "$wt" rebase --abort || true; [ -n "$tmp" ] && git worktree remove --force "$tmp"
    echo "✗ 自動 rebase 有衝突，已 abort，請該組自己 rebase"; return 1; fi
  [ -n "$tmp" ] && git worktree remove --force "$tmp"; return 0
}

check_deps() {
  local deps=0
  for c in $(git rev-list main.."$B"); do
    local files; files=$(git diff-tree --no-commit-id --name-only -r "$c")
    if echo "$files" | grep -qE '(^|/)(package\.json|pnpm-lock\.yaml)$'; then
      local subj other; subj=$(git log -1 --format=%s "$c")
      other=$(echo "$files" | grep -vE '(^|/)(package\.json|pnpm-lock\.yaml)$' || true)
      if [[ "$subj" != deps:* || -n "$other" ]]; then
        echo "✗ $(git log -1 --format='%h %s' "$c")：依賴變更必須是只改 package.json／pnpm-lock.yaml 的獨立 deps: 提交"; return 1; fi
      echo "! 需要審查的依賴提交：$(git log -1 --format='%h %s' "$c")"; deps=1
    fi
  done
  [ $deps -eq 0 ] || [ "$DEPS_OK" = --deps-ok ] || { echo "有依賴提交還沒審查：審查後加 --deps-ok 再執行"; return 1; }
}

for try in $(seq 1 "$MAX"); do
  echo "── 第 $try 次（共最多 $MAX 次）"
  auto_rebase || exit 1
  [ -n "$(git rev-list main.."$B")" ] || { echo "$B 沒有新提交"; exit 0; }
  check_deps || exit 1
  REV=$(git rev-parse --short "$B"); OUT=$(mktemp -d)
  rc=0; GATE_OUT="$OUT" bash "${MERGE_GATE_SCRIPT:-scripts/gate-clean.sh}" "$B" || rc=$?
  if [ $rc -ne 0 ]; then record "$REV" fail "$OUT"; rm -rf "$OUT"; echo "✗ $B（$REV）閘門紅燈，不合入"; exit $rc; fi
  if [ "$(git rev-parse --short "$B")" != "$REV" ]; then echo "✗ 閘門期間 $B 被改動（$REV → $(git rev-parse --short "$B")），不合入"; rm -rf "$OUT"; exit 1; fi
  PRE=$(git rev-parse HEAD)
  if git merge -q --ff-only "$B" 2>/dev/null; then
    # ff 帶進依賴變更時，先同步主目錄 node_modules，否則記錄提交的 pre-commit 型別檢查會找不到新依賴
    if git diff --name-only "$PRE" HEAD | grep -qE '(^|/)(package\.json|pnpm-lock\.yaml)$'; then
      echo "↻ 合入含依賴變更，主目錄執行 pnpm install --frozen-lockfile"; pnpm install --frozen-lockfile >/dev/null; fi
    record "$REV" pass "$OUT"; rm -rf "$OUT"; echo "✓ $B（$REV）已快轉合入 main"; exit 0; fi
  MH=$(git rev-parse --short main)
  sed -i "\$s/,pass\$/,ff-failed(main=$MH)/" "$OUT/gate-history.csv"
  record "$REV" "ff-failed，main=$MH" "$OUT"; rm -rf "$OUT"
  echo "⚠ 閘門綠燈，但期間 main 前進到 $MH，無法快轉，重試"
done
echo "✗ 重試 $MAX 次仍無法快轉合入，請稍後再執行"; exit 1
