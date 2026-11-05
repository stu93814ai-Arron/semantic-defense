// 必跑測試：跑兩次比對每個測試結果；時過時不過者標為 FLAKY，寫入 .ci/flaky.json 並移出必跑清單
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
mkdirSync("reports", { recursive: true }); mkdirSync(".ci", { recursive: true });
function run(i, cov) {
  const out = `reports/vitest-run${i}.json`;
  const args = ["scripts/with-pg.mjs", "npx", "vitest", "run", "--reporter=json", `--outputFile=${out}`];
  if (cov) args.push("--coverage");
  let covFail = false;
  try { execFileSync("node", args, { stdio: "inherit" }); } catch { covFail = true; }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- out 由本檔固定樣板產生，非外部輸入
  const r = JSON.parse(readFileSync(out, "utf8"));
  const m = new Map();
  for (const f of r.testResults) for (const t of f.assertionResults) m.set(`${f.name.replace(process.cwd() + "/", "")} > ${t.fullName}`, t.status);
  return { m, exitFail: covFail, ok: r.success };
}
const a = run(1, true), b = run(2, false);
const prev = existsSync(".ci/flaky.json") ? JSON.parse(readFileSync(".ci/flaky.json", "utf8")) : [];
const flaky = new Set(prev);
for (const [k, s] of a.m) if (b.m.get(k) !== s) flaky.add(k);
writeFileSync(".ci/flaky.json", JSON.stringify([...flaky].sort(), null, 2) + "\n");
for (const k of flaky) console.log(`⚠️  FLAKY（已移出必跑清單，須修好再放回）：${k}`);
const failed = [...a.m].filter(([k, s]) => !flaky.has(k) && (s !== "passed" || b.m.get(k) !== "passed")).map(([k]) => k);
for (const k of failed) console.log(`❌ 必跑測試失敗：${k}`);
const total = a.m.size - [...a.m.keys()].filter(k => flaky.has(k)).length;
console.log(`必跑測試：${total} 筆，失敗 ${failed.length}，FLAKY ${flaky.size}`);
const covOnlyFail = a.exitFail && failed.length === 0 && [...a.m.values()].every(s => s === "passed");
if (covOnlyFail) console.log("❌ 覆蓋率低於 70% 門檻");
if (total === 0) console.log("❌ 沒有任何必跑測試");
process.exit(failed.length || covOnlyFail || total === 0 ? 1 : 0);
