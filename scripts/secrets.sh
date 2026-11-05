#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# gitleaks 固定版本＋SHA-256 校驗；快取於 ~/.cache/semantic-defense，乾淨 worktree 不必重新下載；下載重試 3 次
VER=8.21.2; SHA=5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/semantic-defense/gitleaks-$VER"; GL="$CACHE/gitleaks"
if [ ! -x "$GL" ]; then
  mkdir -p "$CACHE"; tgz="$CACHE/gl.tgz"
  for i in 1 2 3; do curl -fsSL --retry 2 -o "$tgz" "https://github.com/gitleaks/gitleaks/releases/download/v$VER/gitleaks_${VER}_linux_x64.tar.gz" && break; sleep 2; done
  echo "$SHA  $tgz" | sha256sum -c --quiet - || { echo "❌ gitleaks 下載校驗失敗"; rm -f "$tgz"; exit 1; }
  tar xzf "$tgz" -C "$CACHE" gitleaks && rm -f "$tgz"
fi
# 工作目錄（含未提交檔）＋ git 歷史
"$GL" dir . --no-banner --redact -v --exit-code 1 --max-target-megabytes 5 2>&1 | grep -v node_modules || true
"$GL" dir . --no-banner --redact --exit-code 1 >/dev/null 2>&1
if git rev-parse HEAD >/dev/null 2>&1; then "$GL" git . --no-banner --redact --exit-code 1; fi
echo "secrets: OK"
