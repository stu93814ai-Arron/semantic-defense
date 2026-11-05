#!/usr/bin/env bash
# 本機 CI：任一步驟失敗即紅燈（exit != 0）
set -euo pipefail
cd "$(dirname "$0")/.."
step(){ echo "::: $1"; shift; "$@"; }
[ -d node_modules ] || pnpm install --frozen-lockfile
step "1/7 必跑測試（上限 10 分鐘）" timeout 600 npm test
step "2/7 型別檢查" pnpm run typecheck
step "3/7 原始碼掃描＋圈複雜度（eslint）" pnpm run lint --max-warnings=0
step "4/7 重複碼（jscpd）" pnpm run dup
step "5/7 依賴漏洞（pnpm audit ≥high 擋）" pnpm run audit
step "6/7 秘密/權杖掃描（gitleaks）" pnpm run secrets
step "7/7 第三方套件清單（SBOM）" pnpm run sbom
echo "CI GREEN"
