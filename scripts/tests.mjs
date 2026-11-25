// 必跑測試：跑兩次比對每個測試結果；時過時不過者標為 FLAKY，寫入 .ci/flaky.json 並移出必跑清單
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatPartial } from "./live-report.mjs";

export function discardReport(out) {
  rmSync(out, { force: true });
}

/** 非成功且 numFailedTests 為 0，或可解釋的 FLAKY 筆數對不上報告失敗數，就判失敗。 */
export function round2ExitContradicts(exitFail, reportOk, numFailedTests, explained = 0) {
  if (!exitFail && reportOk === true) return false;
  const reported = Number(numFailedTests) || 0;
  if (reported === 0) return true;
  return explained !== reported;
}

/** 本輪 failed、另一輪 passed、且已標成 FLAKY 的筆數。對不到的失敗不算。 */
export function flakyExplainedCount(thisRound, otherRound, flaky) {
  let n = 0;
  for (const [name, status] of thisRound) {
    if (status !== "failed") continue;
    if (flaky.has(name) && otherRound.get(name) === "passed") n += 1;
  }
  return n;
}

function run(i, cov) {
  const out = `reports/vitest-run${i}.json`;
  discardReport(out);
  const args = ["scripts/with-pg.mjs", "npx", "vitest", "run", "--reporter=json", "--reporter=./scripts/vitest-live-reporter.mjs", `--outputFile=${out}`];
  if (cov) args.push("--coverage");
  let covFail = false;
  try { execFileSync("node", args, { stdio: "inherit" }); } catch { covFail = true; }
  let raw;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- out 由本檔固定樣板產生，非外部輸入
    raw = readFileSync(out, "utf8");
  } catch (err) {
    console.error(formatPartial("reports"));
    throw err;
  }
  const r = JSON.parse(raw);
  const m = new Map();
  for (const f of r.testResults) for (const t of f.assertionResults) m.set(`${f.name.replace(process.cwd() + "/", "")} > ${t.fullName}`, t.status);
  return { m, exitFail: covFail, ok: r.success, numFailedTests: Number(r.numFailedTests) || 0 };
}

function finish(a, b, prev) {
  const flaky = new Set(prev);
  for (const [k, s] of a.m) if (b.m.get(k) !== s) flaky.add(k);
  const failed = [...a.m].filter(([k, s]) => !flaky.has(k) && (s !== "passed" || b.m.get(k) !== "passed")).map(([k]) => k);
  const total = a.m.size - [...a.m.keys()].filter((k) => flaky.has(k)).length;
  return { flaky, failed, total };
}

function loadPrev() {
  if (!existsSync(".ci/flaky.json")) return [];
  return JSON.parse(readFileSync(".ci/flaky.json", "utf8"));
}

function logNames(prefix, names) {
  for (const name of names) console.log(`${prefix}${name}`);
}

function coverageFailed(runResult, failed) {
  return runResult.exitFail && failed.length === 0 && [...runResult.m.values()].every((status) => status === "passed");
}

function mustStop(failedCount, covOnlyFail, total, round2Lie) {
  return failedCount > 0 || covOnlyFail || total === 0 || round2Lie;
}

function main() {
  mkdirSync("reports", { recursive: true }); mkdirSync(".ci", { recursive: true });
  const a = run(1, true), b = run(2, false);
  const { flaky, failed, total } = finish(a, b, loadPrev());
  writeFileSync(".ci/flaky.json", JSON.stringify([...flaky].sort(), null, 2) + "\n");
  logNames("⚠️  FLAKY（已移出必跑清單，須修好再放回）：", flaky);
  logNames("❌ 必跑測試失敗：", failed);
  console.log(`必跑測試：${total} 筆，失敗 ${failed.length}，FLAKY ${flaky.size}`);
  const covOnlyFail = coverageFailed(a, failed);
  if (covOnlyFail) console.log("❌ 覆蓋率低於 70% 門檻");
  if (total === 0) console.log("❌ 沒有任何必跑測試");
  const explained = flakyExplainedCount(b.m, a.m, flaky);
  const round2Lie = round2ExitContradicts(b.exitFail, b.ok, b.numFailedTests, explained);
  if (round2Lie) console.log("❌ 第 2 輪退出碼非 0 或報告不是成功，且失敗沒有全部對上 FLAKY");
  process.exit(mustStop(failed.length, covOnlyFail, total, round2Lie) ? 1 : 0);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) main();
