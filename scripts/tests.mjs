// 必跑測試：跑兩次比對每個測試結果；時過時不過者標為 FLAKY，寫入 .ci/flaky.json 並移出必跑清單
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from "node:fs";
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

/** 檔案路徑加完整測試名稱。同名不同檔不算同一筆。 */
export function failureIdentity(file, fullName) {
  const name = String(file ?? "").replace(`${process.cwd()}/`, "");
  return `${name} > ${fullName}`;
}

function reportShapeBad(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return true;
  return !Array.isArray(report.testResults);
}

function hasUnhandled(report) {
  const errors = report.unhandledErrors;
  return Array.isArray(errors) && errors.length > 0;
}

function suiteLevelFailure(report) {
  for (const file of report.testResults) {
    if (!file || file.status !== "failed") continue;
    const rows = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    if (!rows.some((row) => row && row.status === "failed")) return true;
  }
  return false;
}

function failedIdentities(report) {
  const ids = [];
  for (const file of report.testResults) {
    const rows = Array.isArray(file && file.assertionResults) ? file.assertionResults : [];
    for (const row of rows) {
      if (row && row.status === "failed") ids.push(failureIdentity(file.name, row.fullName));
    }
  }
  return ids;
}

function explainedFailures(report, otherRound, flaky) {
  const ids = failedIdentities(report);
  let explained = 0;
  for (const id of ids) {
    if (flaky.has(id) && otherRound.get(id) === "passed") explained += 1;
  }
  return { seen: ids.length, explained };
}

/** 非成功時，逐筆以檔案＋完整名稱對上 FLAKY 才放行。suite 錯誤與 unhandled 一律失敗。 */
export function round2ReportFails(exitFail, report, otherRound, flaky) {
  if (reportShapeBad(report) || hasUnhandled(report) || suiteLevelFailure(report)) return true;
  if (!exitFail && report.success === true) return false;
  const reported = Number(report.numFailedTests) || 0;
  if (reported === 0) return true;
  const detail = explainedFailures(report, otherRound, flaky);
  return detail.seen !== reported || detail.explained !== reported;
}

function readJson(path) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 路徑是固定報告檔或測試暫存
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 報告不存在、解析失敗，或修改時間早於本輪開始，都不是這輪的結果。 */
export function loadRoundReport(path, startedAt) {
  let mtime = -1;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同上
    mtime = statSync(path).mtimeMs;
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (mtime + 2000 < startedAt) return { ok: false, reason: "stale" };
  const report = readJson(path);
  if (!report || typeof report !== "object" || Array.isArray(report)) return { ok: false, reason: "parse" };
  return { ok: true, report };
}

function run(i, cov) {
  const out = `reports/vitest-run${i}.json`;
  discardReport(out);
  const args = ["scripts/with-pg.mjs", "npx", "vitest", "run", "--reporter=json", "--reporter=./scripts/vitest-live-reporter.mjs", `--outputFile=${out}`];
  if (cov) args.push("--coverage");
  let covFail = false;
  const startedAt = Date.now();
  try { execFileSync("node", args, { stdio: "inherit" }); } catch { covFail = true; }
  const loaded = loadRoundReport(out, startedAt);
  if (!loaded.ok) return { m: new Map(), exitFail: true, ok: false, numFailedTests: 0, report: null };
  const r = loaded.report;
  const m = new Map();
  const files = Array.isArray(r.testResults) ? r.testResults : [];
  for (const f of files) {
    const rows = Array.isArray(f && f.assertionResults) ? f.assertionResults : [];
    for (const t of rows) m.set(failureIdentity(f.name, t.fullName), t.status);
  }
  return { m, exitFail: covFail, ok: r.success, numFailedTests: Number(r.numFailedTests) || 0, report: r };
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
  if (!a.report || !b.report) {
    console.error(formatPartial("reports"));
    console.log("❌ 第 2 輪報告不存在、解析失敗，或是開跑前的舊檔");
    process.exit(1);
  }
  const { flaky, failed, total } = finish(a, b, loadPrev());
  writeFileSync(".ci/flaky.json", JSON.stringify([...flaky].sort(), null, 2) + "\n");
  logNames("⚠️  FLAKY（已移出必跑清單，須修好再放回）：", flaky);
  logNames("❌ 必跑測試失敗：", failed);
  console.log(`必跑測試：${total} 筆，失敗 ${failed.length}，FLAKY ${flaky.size}`);
  const covOnlyFail = coverageFailed(a, failed);
  if (covOnlyFail) console.log("❌ 覆蓋率低於 70% 門檻");
  if (total === 0) console.log("❌ 沒有任何必跑測試");
  const explained = flakyExplainedCount(b.m, a.m, flaky);
  const byReport = round2ReportFails(b.exitFail, b.report, a.m, flaky);
  const byCount = round2ExitContradicts(b.exitFail, b.ok, b.numFailedTests, explained);
  const round2Lie = byReport || byCount;
  if (round2Lie) console.log("❌ 第 2 輪退出碼非 0 或報告不是成功，且失敗沒有全部對上 FLAKY");
  process.exit(mustStop(failed.length, covOnlyFail, total, round2Lie) ? 1 : 0);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) main();
