// 必跑測試：跑兩次。只有同一筆一輪 failed、另一輪 passed 才寫入 .ci/flaky.json。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
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

/** 非成功時，逐筆以檔案＋完整名稱對上 FLAKY 才放行。suite 錯誤一律失敗。 */
export function round2ReportFails(exitFail, report, otherRound, flaky) {
  if (reportShapeBad(report) || suiteLevelFailure(report)) return true;
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

function fileMtime(path) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 路徑是固定報告檔或測試暫存
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/** 未處理錯誤筆數檔。讀不到、解析失敗或修改時間早於本輪開始都不是這輪的結果。 */
export function loadUnhandled(path, startedAt) {
  const mtime = fileMtime(path);
  if (mtime < 0) return { ok: false, reason: "missing", count: 0 };
  if (mtime + 2000 < startedAt) return { ok: false, reason: "stale", count: 0 };
  const body = readJson(path);
  const count = body && body.count;
  if (!Number.isInteger(count) || count < 0) return { ok: false, reason: "parse", count: 0 };
  return { ok: true, count };
}

export function unhandledFails(loaded) {
  return !loaded || loaded.ok !== true || loaded.count > 0;
}

function run(i, cov) {
  const out = `reports/vitest-run${i}.json`;
  const unhandledOut = `reports/unhandled-run${i}.json`;
  discardReport(out);
  discardReport(unhandledOut);
  const args = ["scripts/with-pg.mjs", "npx", "vitest", "run", "--reporter=json", "--reporter=./scripts/vitest-live-reporter.mjs", `--outputFile=${out}`];
  if (cov) args.push("--coverage");
  let exitFail = false;
  const startedAt = Date.now();
  const env = { ...process.env, UNHANDLED_REPORT: unhandledOut };
  try { execFileSync("node", args, { stdio: "inherit", env }); } catch { exitFail = true; }
  const loaded = loadRoundReport(out, startedAt);
  const unhandled = loadUnhandled(unhandledOut, startedAt);
  if (!loaded.ok) return { m: new Map(), exitFail: true, ok: false, numFailedTests: 0, report: null, unhandled, startedAt };
  const r = loaded.report;
  const m = new Map();
  const files = Array.isArray(r.testResults) ? r.testResults : [];
  for (const f of files) {
    const rows = Array.isArray(f && f.assertionResults) ? f.assertionResults : [];
    for (const t of rows) m.set(failureIdentity(f.name, t.fullName), t.status);
  }
  return { m, exitFail, ok: r.success, numFailedTests: Number(r.numFailedTests) || 0, report: r, unhandled, startedAt };
}

function isFlakyPair(left, right) {
  return (left === "failed" && right === "passed") || (left === "passed" && right === "failed");
}

/** 只有同一筆一輪 failed、另一輪 passed 才是 FLAKY。缺席與 skipped 留在失敗清單。 */
export function classifyRounds(round1, round2) {
  const flaky = [];
  const failed = [];
  const keys = new Set([...round1.keys(), ...round2.keys()]);
  for (const key of keys) {
    const left = round1.get(key);
    const right = round2.get(key);
    if (isFlakyPair(left, right)) flaky.push(key);
    else if (left !== "passed" || right !== "passed") failed.push(key);
  }
  return { flaky, failed };
}

function finish(a, b) {
  const { flaky: names, failed } = classifyRounds(a.m, b.m);
  const flaky = new Set(names);
  const total = a.m.size - [...a.m.keys()].filter((k) => flaky.has(k)).length;
  return { flaky, failed, total };
}

function logNames(prefix, names) {
  for (const name of names) console.log(`${prefix}${name}`);
}

function pctMeets(bucket, floor) {
  return Boolean(bucket) && typeof bucket.pct === "number" && Number.isFinite(bucket.pct) && bucket.pct >= floor;
}

function summaryShapeBad(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return true;
  return !summary.total || typeof summary.total !== "object";
}

/** 摘要缺、壞、少欄位，或 pct 不是達標的數字，都算覆蓋率不足。 */
export function coverageBelow(summary, floor = 70) {
  if (summaryShapeBad(summary)) return true;
  const total = summary.total;
  if (!pctMeets(total.lines, floor) || !pctMeets(total.statements, floor)) return true;
  return !pctMeets(total.functions, floor) || !pctMeets(total.branches, floor);
}

/** 摘要不存在、解析失敗、修改時間或 startTime 早於本輪開始，都不是這輪的結果。 */
export function loadCoverageSummary(path, startedAt) {
  const mtime = fileMtime(path);
  if (mtime < 0) return { ok: false, reason: "missing" };
  if (mtime + 2000 < startedAt) return { ok: false, reason: "stale" };
  const summary = readJson(path);
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return { ok: false, reason: "parse" };
  if (typeof summary.startTime === "number" && summary.startTime + 2000 < startedAt) return { ok: false, reason: "stale" };
  return { ok: true, summary };
}

export function round1ExitMessage(summaryIsFail, exitIsFail) {
  if (summaryIsFail) return "覆蓋率低於 70% 門檻";
  if (exitIsFail) return "第 1 輪退出碼非 0";
  return "";
}

function unexplainedExit(runResult, failed, summaryFail) {
  if (summaryFail || failed.length > 0) return false;
  return Boolean(runResult.exitFail) && [...runResult.m.values()].every((status) => status === "passed");
}

function exitNotes(summaryFail, exitFail, unhandled, total) {
  const notes = [];
  const exitNote = round1ExitMessage(summaryFail, exitFail);
  if (exitNote) notes.push(`❌ ${exitNote}`);
  if (unhandled) notes.push("❌ 第 1 輪有未處理錯誤");
  if (total === 0) notes.push("❌ 沒有任何必跑測試");
  return notes;
}

/** 第 1 輪未處理錯誤與覆蓋率不足獨立失敗，不會被 FLAKY 吸收。 */
export function gateStops(flags) {
  if (flags.unhandled || flags.coverageFail) return true;
  return flags.failedCount > 0 || flags.total === 0 || flags.round2Lie;
}

function judge(a, b) {
  const { flaky, failed, total } = finish(a, b);
  const coverage = loadCoverageSummary("reports/coverage/coverage-summary.json", a.startedAt);
  const summaryFail = !coverage.ok || coverageBelow(coverage.summary);
  const exitFail = unexplainedExit(a, failed, summaryFail);
  const unhandled = unhandledFails(a.unhandled) || unhandledFails(b.unhandled);
  const notes = exitNotes(summaryFail, exitFail, unhandled, total);
  const explained = flakyExplainedCount(b.m, a.m, flaky);
  const byReport = round2ReportFails(b.exitFail, b.report, a.m, flaky);
  const byCount = round2ExitContradicts(b.exitFail, b.ok, b.numFailedTests, explained);
  const round2Lie = byReport || byCount;
  if (round2Lie) notes.push("❌ 第 2 輪退出碼非 0 或報告不是成功，且失敗沒有全部對上 FLAKY");
  const stop = gateStops({ failedCount: failed.length, coverageFail: summaryFail || exitFail, unhandled, total, round2Lie });
  return { flaky, failed, total, notes, stop };
}

function main() {
  mkdirSync("reports", { recursive: true }); mkdirSync(".ci", { recursive: true });
  const a = run(1, true), b = run(2, false);
  if (!a.report || !b.report) {
    console.error(formatPartial("reports"));
    console.log("❌ 第 2 輪報告不存在、解析失敗，或是開跑前的舊檔");
    process.exit(1);
  }
  const { flaky, failed, total, notes, stop } = judge(a, b);
  writeFileSync(".ci/flaky.json", JSON.stringify([...flaky].sort(), null, 2) + "\n");
  logNames("⚠️  FLAKY（已移出必跑清單，須修好再放回）：", flaky);
  logNames("❌ 必跑測試失敗：", failed);
  console.log(`必跑測試：${total} 筆，失敗 ${failed.length}，FLAKY ${flaky.size}`);
  for (const line of notes) console.log(line);
  process.exit(stop ? 1 : 0);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) main();
