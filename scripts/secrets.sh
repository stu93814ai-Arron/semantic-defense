#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
GL=tools/bin/gitleaks
if [ ! -x "$GL" ]; then
  mkdir -p tools/bin
  curl -sSL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz | tar xz -C tools/bin gitleaks
fi
# 工作目錄（含未提交檔）＋ git 歷史
"$GL" dir . --no-banner --redact -v --exit-code 1 --max-target-megabytes 5 2>&1 | grep -v node_modules || true
"$GL" dir . --no-banner --redact --exit-code 1 >/dev/null 2>&1
if git rev-parse HEAD >/dev/null 2>&1; then "$GL" git . --no-banner --redact --exit-code 1; fi
echo "secrets: OK"
