#!/usr/bin/env bash
# Playwright E2E（apps/console）。上限 ${E2E_TIMEOUT:-600} 秒；實測秒數寫入 .ci/e2e-seconds（放置規則見 scripts/required.sh）。
# retries=1：重試後才過者 Playwright 標 flaky → 記入 .ci/flaky-e2e.json，印 FLAKY 通知。
set -uo pipefail
cd "$(dirname "$0")/.."
CFG=$(ls apps/console/playwright.config.* 2>/dev/null | head -1)
if [ -z "$CFG" ]; then echo "e2e: 尚無 apps/console/playwright.config.*，略過"; exit 0; fi
mkdir -p reports .ci
pnpm exec playwright install chromium >/dev/null
T=${E2E_TIMEOUT:-600}
# 每個 webServer 各挑一個空閒埠（PM 核准），避免多個 worktree 同時跑 E2E 時互相衝突
if [ -z "${E2E_PORT:-}" ] || [ -z "${E2E_IDLE_PORT:-}" ]; then
  read -r E2E_PORT E2E_IDLE_PORT < <(node -e '
const net=require("node:net");const get=()=>new Promise(r=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>r(p))})});
(async()=>{const a=await get();let b=await get();while(b===a)b=await get();console.log(a,b)})();')
fi
export E2E_PORT E2E_IDLE_PORT; echo "e2e: 連接埠 chromium=$E2E_PORT、chromium-idle=$E2E_IDLE_PORT"
# 保險：同一台機器上的 E2E 依序執行（最多等 ${E2E_LOCK_WAIT:-600} 秒）
exec 9>"${E2E_LOCK_FILE:-/tmp/semantic-defense-e2e.lock}"
if ! flock -w "${E2E_LOCK_WAIT:-600}" 9; then echo "❌ e2e: 等待其他 E2E 執行逾時"; exit 1; fi
t0=$SECONDS
PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/reports/e2e.json" timeout "$T" node scripts/with-pg.mjs pnpm exec playwright test -c "$CFG" --retries=1 --reporter=line,json
rc=$?
d=$((SECONDS-t0)); [ $rc -eq 124 ] && d=$((T+1)); echo $d > .ci/e2e-seconds; echo "e2e: ${d} 秒"
[ -f reports/e2e.json ] && node -e '
let r; try{r=JSON.parse(require("fs").readFileSync("reports/e2e.json","utf8"));}catch{process.exit(0)}
const fl=[];const walk=s=>{(s.specs||[]).forEach(sp=>sp.tests.forEach(x=>{if(x.status==="flaky")fl.push(sp.file+" > "+sp.title)}));(s.suites||[]).forEach(walk)};
(r.suites||[]).forEach(walk);
require("fs").writeFileSync(".ci/flaky-e2e.json",JSON.stringify(fl,null,2)+"\n");
fl.forEach(f=>console.log("⚠️  FLAKY E2E："+f));'
[ $rc -eq 124 ] && echo "❌ E2E 超過 ${T} 秒（下次依規則移出必跑）"
exit $rc
