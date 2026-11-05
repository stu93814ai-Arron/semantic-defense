#!/usr/bin/env bash
# 整合守門員專用：把 team-a／team-b 快轉合入 main。用法：pnpm merge:team a|b [--deps-ok]
# 1) 分支必須以 main 為基底；2) 改到 package.json／pnpm-lock.yaml 的提交必須是獨立的 deps: 提交，並經過審查（--deps-ok）；
# 3) 對分支跑閘門，紅燈就不合入（並在 main 記錄 fail）；4) 綠燈時 ff-only 合入，再在 main 記錄 pass。
set -euo pipefail
cd "$(dirname "$0")/.."
T=${1:?用法：merge-team.sh a|b [--deps-ok]}; B=team-$T; DEPS_OK=${2:-}
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "必須在 main 目錄執行"; exit 1; }
git merge-base --is-ancestor main "$B" || { echo "$B 沒有以最新 main 為基底：請該組先 git rebase main"; exit 1; }
[ -n "$(git rev-list main.."$B")" ] || { echo "$B 沒有新提交"; exit 0; }
deps=0
for c in $(git rev-list main.."$B"); do
  files=$(git diff-tree --no-commit-id --name-only -r "$c")
  if echo "$files" | grep -qE '(^|/)(package\.json|pnpm-lock\.yaml)$'; then
    subj=$(git log -1 --format=%s "$c")
    other=$(echo "$files" | grep -vE '(^|/)(package\.json|pnpm-lock\.yaml)$' || true)
    if [[ "$subj" != deps:* || -n "$other" ]]; then
      echo "✗ $(git log -1 --format='%h %s' "$c")：依賴變更必須是只改 package.json／pnpm-lock.yaml 的獨立 deps: 提交"; exit 1
    fi
    echo "! 需要審查的依賴提交：$(git log -1 --format='%h %s' "$c")"; deps=1
  fi
done
[ $deps -eq 0 ] || [ "$DEPS_OK" = --deps-ok ] || { echo "有依賴提交還沒審查：審查後加 --deps-ok 再執行"; exit 1; }
REV=$(git rev-parse --short "$B"); OUT=$(mktemp -d)
rc=0; GATE_OUT="$OUT" bash scripts/gate-clean.sh "$B" || rc=$?
if [ $rc -eq 0 ]; then git merge --ff-only "$B"; fi
files=(); for f in gate-history.csv e2e-seconds required-seconds; do [ -f "$OUT/$f" ] && cp "$OUT/$f" ".ci/$f" && files+=(".ci/$f"); done
git add -- "${files[@]}"
git -c user.name="整合守門員" -c user.email=ci@local commit -q -m "ci: 記錄 $REV（$B）閘門結果（$([ $rc -eq 0 ] && echo pass || echo fail)）" -- "${files[@]}"
git log --oneline -1; rm -rf "$OUT"
[ $rc -eq 0 ] && echo "✓ $B（$REV）已快轉合入 main" || echo "✗ $B 閘門紅燈，不合入"
exit $rc
