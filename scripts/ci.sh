#!/usr/bin/env bash
# 本機 CI：任一步驟失敗即紅燈（exit != 0）
# 必跑（步驟 1）上限 600 秒；E2E（步驟 8）不在必跑清單，另計上限 600 秒，仍為閘門阻擋項。
set -euo pipefail
cd "$(dirname "$0")/.."
step(){ echo "::: $1"; shift; local t=$SECONDS; "$@"; echo "    （$((SECONDS-t)) 秒）"; }
[ -d node_modules ] || pnpm install --frozen-lockfile
step "1/8 必跑測試×2＋FLAKY 偵測＋覆蓋率≥70%（上限 10 分鐘，含拋棄式 Postgres）" timeout 600 node scripts/tests.mjs
step "2/8 型別檢查" pnpm run typecheck
step "3/8 原始碼掃描＋圈複雜度（eslint，含 TSX/React）" pnpm run lint --max-warnings=0
step "4/8 重複碼（jscpd）" pnpm run dup
step "5/8 依賴漏洞（≥high 擋，其餘記錄）" pnpm run audit
step "6/8 秘密/權杖掃描（gitleaks）" pnpm run secrets
step "7/8 第三方套件清單（CycloneDX＋licenses）" pnpm run sbom
if [ "${SKIP_E2E:-0}" = 1 ]; then echo "::: 8/8 E2E 略過（SKIP_E2E=1）"; else step "8/8 E2E（Playwright，非必跑，上限 10 分鐘）" pnpm run e2e; fi
echo "CI GREEN"
