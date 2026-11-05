#!/usr/bin/env bash
# Playwright E2E（apps/console）。非必跑清單，閘門另計上限 600 秒。
# retries=1：重試後才過者 Playwright 標 flaky → 記入 .ci/flaky-e2e.json，印 FLAKY 通知。
set -uo pipefail
cd "$(dirname "$0")/.."
CFG=$(ls apps/console/playwright.config.* 2>/dev/null | head -1)
if [ -z "$CFG" ]; then echo "e2e: 尚無 apps/console/playwright.config.*，略過"; exit 0; fi
mkdir -p reports .ci
pnpm exec playwright install chromium >/dev/null
PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/reports/e2e.json" timeout 600 node scripts/with-pg.mjs pnpm exec playwright test -c "$CFG" --retries=1 --reporter=line,json
rc=$?
[ -f reports/e2e.json ] && node -e '
let r; try{r=JSON.parse(require("fs").readFileSync("reports/e2e.json","utf8"));}catch{process.exit(0)}
const fl=[];const walk=s=>{(s.specs||[]).forEach(sp=>sp.tests.forEach(x=>{if(x.status==="flaky")fl.push(sp.file+" > "+sp.title)}));(s.suites||[]).forEach(walk)};
(r.suites||[]).forEach(walk);
require("fs").writeFileSync(".ci/flaky-e2e.json",JSON.stringify(fl,null,2)+"\n");
fl.forEach(f=>console.log("⚠️  FLAKY E2E："+f));'
[ $rc -eq 124 ] && echo "❌ E2E 超過 600 秒"
exit $rc
