// 完整依賴掃描（含 dev）的 high/critical 判定。唯一的有期限例外：picomatch GHSA-fc5q-39xc-vjpf
// （軟體大總召裁示（未經使用者確認），見 docs/decisions/2026-11-18-audit-exception-picomatch.md）。
// 五項全中才放行：GHSA 編號、套件名、vulnerable_versions 完全相同、每個 finding 版本 ≤4.0.7、上游仍無修補版。
// 2026-12-01（Asia/Taipei，含當天）起一律失敗。日期與編號寫死；不讀任何環境變數。
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EXC = { id: "GHSA-fc5q-39xc-vjpf", module: "picomatch", vulnerable: "<=4.0.7", maxVersion: [4, 0, 7], expires: "2026-12-01" };
export const EXPIRED_MSG = `audit: ${EXC.module} ${EXC.id} 例外已於 ${EXC.expires} 到期，請移除例外並升版`;
const NO_FIX = new Set(["", "<0.0.0"]);
const SKIP = new Set(["info", "low", "moderate"]), GATED = new Set(["high", "critical"]);
const sevOf = a => String(a.severity ?? "").toLowerCase();

function versionOk(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m) return false;
  const [maj, min, pat] = m.slice(1).map(Number), [xMaj, xMin, xPat] = EXC.maxVersion;
  return maj !== xMaj ? maj < xMaj : min !== xMin ? min < xMin : pat <= xPat;
}

function isAllowed(a) {
  const f = Array.isArray(a.findings) ? a.findings : [];
  return a.github_advisory_id === EXC.id && a.module_name === EXC.module && a.vulnerable_versions === EXC.vulnerable
    && f.length > 0 && f.every(x => versionOk(x.version)) && NO_FIX.has(a.patched_versions ?? "");
}

const line = a => [a.severity, a.module_name, a.github_advisory_id, `${a.vulnerable_versions} → 修補 ${a.patched_versions}`, a.title,
  [...new Set((a.findings || []).flatMap(f => f.paths || []))].join(" ")].join("\t");

function advisoriesOf(scan) {
  if (!scan || typeof scan !== "object" || scan.error) return null;
  const a = scan.advisories;
  return a && typeof a === "object" && !Array.isArray(a) ? Object.values(a) : null;
}

// metadata.vulnerabilities 的 high+critical 必須等於 advisories 中（正規化後）high/critical 的筆數
function metadataConsistent(scan, advs) {
  const v = scan.metadata?.vulnerabilities;
  if (!v || !Number.isInteger(v.high) || !Number.isInteger(v.critical)) return false;
  return v.high + v.critical === advs.filter(a => GATED.has(sevOf(a))).length;
}

/** @param {unknown} scan pnpm audit --json 的輸出  @param {string} today YYYY-MM-DD（Asia/Taipei） */
export function evaluateAudit(scan, today) {
  const expired = !(today < EXC.expires), allowed = [], lines = [];
  const errors = expired ? [EXPIRED_MSG] : [];
  const advs = advisoriesOf(scan);
  if (!advs) return { ok: false, allowed, lines, errors: [...errors, "audit: 無法解析 pnpm audit --json 輸出"] };
  if (!metadataConsistent(scan, advs)) errors.push("audit: metadata 的 high/critical 數與 advisories 不符或缺少");
  for (const a of advs) {
    lines.push(line(a));
    if (SKIP.has(sevOf(a))) continue;
    if (!expired && GATED.has(sevOf(a)) && isAllowed(a)) allowed.push(`有期限例外（有效至 2026-11-30，Asia/Taipei）\t${line(a)}`);
    else errors.push(`audit: 擋下 ${line(a)}`);
  }
  return { ok: errors.length === 0, allowed, lines, errors };
}

export function taipeiToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let scan = null;
  try { scan = JSON.parse(readFileSync("reports/audit.json", "utf8")); } catch { scan = null; }
  const r = evaluateAudit(scan, taipeiToday());
  const out = [...r.lines, ...r.allowed.map(l => `[允許] ${l}`)];
  writeFileSync("reports/audit-summary.txt", (out.join("\n") || "無已知漏洞") + "\n");
  console.log(out.join("\n") || "無已知漏洞");
  for (const e of r.errors) console.error(e);
  process.exit(r.ok ? 0 : 1);
}
