import { captureActivity, installKillSnapshot, reportDir, setReportDir, startActivityLoop, writeRunning, writeUnhandledCount } from "./live-report.mjs";

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
  onTestRunEnd(_testModules, unhandledErrors) {
    const path = process.env.UNHANDLED_REPORT;
    if (path) writeUnhandledCount(path, Array.isArray(unhandledErrors) ? unhandledErrors.length : 0);
    this.stop?.();
  }
}
