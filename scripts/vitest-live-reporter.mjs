import { captureActivity, installKillSnapshot, reportDir, setReportDir, startActivityLoop, writeRunning, writeUnhandledCount } from "./live-report.mjs";

function isSuiteNode(node) {
  return Boolean(node) && (node.type === "module" || node.type === "suite");
}

function ownSuiteErrors(node) {
  if (typeof node.errors !== "function") return null;
  const errors = node.errors();
  return Array.isArray(errors) ? errors.length : null;
}

function suiteKids(node) {
  const list = node.children;
  if (!list || typeof list.array !== "function") return null;
  const kids = list.array();
  return Array.isArray(kids) ? kids : null;
}

/** 模組與巢狀 suite 的 errors()。assertion 失敗在 test 上，不計入。讀不到就回 null，呼叫端不寫檔。 */
export function countSuiteErrors(testModules) {
  if (!Array.isArray(testModules)) return null;
  let total = 0;
  const stack = [...testModules];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (!isSuiteNode(node)) continue;
    const owned = ownSuiteErrors(node);
    if (owned === null) return null;
    total += owned;
    const kids = suiteKids(node);
    if (!kids) return null;
    for (const kid of kids) stack.push(kid);
  }
  return total;
}

const running = new Map();

export function resetLiveReporter() { running.clear(); }

function label(test) {
  const file = test.module && test.module.moduleId ? test.module.moduleId : "";
  const name = test.fullName || test.name || "";
  return file ? `${file} > ${name}` : String(name);
}

/** vitest 主行程：每個測試一開始就寫檔。外層 timeout 殺掉行程時，檔案還在。 */
export default class LiveReporter {
  onInit() {
    const dir = process.env.LIVE_REPORT_DIR || "reports";
    setReportDir(dir);
    installKillSnapshot(dir, () => captureActivity(process.env.DATABASE_URL));
    this.stop = startActivityLoop(dir, () => captureActivity(process.env.DATABASE_URL));
  }
  onTestCaseReady(test) {
    running.set(test.id || label(test), label(test));
    writeRunning(reportDir(), [...running.values()]);
  }
  onTestCaseResult(test) {
    running.delete(test.id || label(test));
    writeRunning(reportDir(), [...running.values()]);
  }
  onTestRunEnd(testModules, unhandledErrors) {
    const path = process.env.UNHANDLED_REPORT;
    if (path) writeUnhandledCount(path, Array.isArray(unhandledErrors) ? unhandledErrors.length : 0);
    const suitePath = process.env.SUITE_REPORT;
    if (suitePath) {
      const count = countSuiteErrors(testModules);
      if (typeof count === "number") writeUnhandledCount(suitePath, count);
    }
    this.stop?.();
  }
}
