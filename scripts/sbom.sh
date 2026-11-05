#!/usr/bin/env bash
set -euo pipefail
# cdxgen 以 dlx 固定版本執行，不進專案依賴樹（其相依 body-parser 有 high 漏洞，會污染 audit）
cd "$(dirname "$0")/.."; mkdir -p reports
FETCH_LICENSE=false pnpm dlx @cyclonedx/cdxgen@12.9.0 -t pnpm --required-only --no-recurse -o reports/sbom.cdx.json . >/dev/null
pnpm licenses list --prod --json > reports/third-party.json
node -e 'const s=require("./reports/sbom.cdx.json");console.log(`SBOM ${s.bomFormat} ${s.specVersion}：${s.components.length} 個元件`)'
