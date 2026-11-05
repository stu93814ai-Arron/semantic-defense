#!/usr/bin/env bash
# 本機 CI：任一步驟失敗即紅燈（exit != 0）
# 必跑（步驟 1）上限 600 秒；E2E 依 scripts/required.sh 規則併入必跑或於步驟 8 另跑（兩者皆阻擋合併）。
set -euo pipefail
cd "$(dirname "$0")/.."
step(){ echo "::: $1"; shift; local t=$SECONDS; "$@"; echo "    （$((SECONDS-t)) 秒）"; }
[ -d node_modules ] || pnpm install --frozen-lockfile
step "1/9 必跑測試×2＋FLAKY 偵測＋覆蓋率≥70%（上限 10 分鐘，含拋棄式 Postgres；E2E 視規則）" timeout 600 bash scripts/required.sh
step "2/9 型別檢查" pnpm run typecheck
step "3/9 原始碼掃描＋圈複雜度（eslint，含 TSX/React）" pnpm run lint --max-warnings=0
step "4/9 重複碼（jscpd）" pnpm run dup
step "5/9 依賴漏洞（≥high 擋，其餘記錄）" pnpm run audit
step "6/9 秘密/權杖掃描（gitleaks）" pnpm run secrets
step "7/9 流量／管理平面依賴邊界與部署分離" pnpm run boundaries
step "8/9 第三方套件清單（CycloneDX＋licenses）" pnpm run sbom
if [ "${SKIP_E2E:-0}" = 1 ]; then echo "::: 9/9 E2E 略過（SKIP_E2E=1）"
elif [ "$(cat .ci/e2e-placement)" = gate ]; then step "9/9 E2E（Playwright，必跑外，上限 10 分鐘）" pnpm run e2e
else echo "::: 9/9 E2E 已於必跑中執行"; fi
echo "CI GREEN"
