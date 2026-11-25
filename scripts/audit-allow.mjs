// 完整依賴掃描（含 dev）的 high/critical 判定。正式例外清單目前是空的 Object.freeze([])。
// 空清單不會因為到期日失敗。以後的例外必須有真實的 YYYY-MM-DD 到期日（Asia/Taipei，當天起失效）和理由。
// 格式不對、不是真實日期、已到期，或到期日晚於今天加 90 天，就失敗。不從環境變數或命令列讀例外。
// 例外的公告 id 若不在這次掃描，只印警告，不讓 ci 失敗。
// picomatch GHSA-fc5q-39xc-vjpf 已移除：summary 為
// 「Withdrawn Advisory: picomatch vulnerable to ReDoS through single-branch repeated extglobs」，
// withdrawn_at 2026-11-18T15:38:56Z，first_patched_version 是 null。
// 軟體大總召裁示（未經使用者確認）：同意移除，不續期。見 docs/decisions/2026-11-18-audit-exception-picomatch.md。
// high／critical 沒有命中未過期且帶理由的例外就擋下。
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXCEPTIONS = Object.freeze([]);
const NO_FIX = new Set(["", "<0.0.0"]);
const SKIP = new Set(["info", "low", "moderate"]), GATED = new Set(["high", "critical"]);
const sevOf = a => String(a.severity ?? "").toLowerCase();
const MAX_EXC_DAYS = 90;
const reasonOf = exc => (typeof exc?.reason === "string" && exc.reason.trim() !== "" ? exc.reason.trim() : null);
const excName = exc => `${exc?.module ?? "?"} ${exc?.id ?? "?"}`;

function versionOk(v, maxVersion) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m || !Array.isArray(maxVersion) || maxVersion.length < 3) return false;
  const [maj, min, pat] = m.slice(1).map(Number), [xMaj, xMin, xPat] = maxVersion;
  if (maj !== xMaj) return maj < xMaj;
  if (min !== xMin) return min < xMin;
  return pat <= xPat;
}

function matchesExc(exc, a) {
  const f = Array.isArray(a.findings) ? a.findings : [];
  return a.github_advisory_id === exc.id && a.module_name === exc.module && a.vulnerable_versions === exc.vulnerable
    && f.length > 0 && f.every(x => versionOk(x.version, exc.maxVersion)) && NO_FIX.has(a.patched_versions ?? "");
}

function isoParts(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function calendarOk(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function addIsoDays(iso, days) {
  const p = isoParts(iso);
  if (!p || !calendarOk(p[0], p[1], p[2])) return null;
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  dt.setUTCDate(dt.getUTCDate() + days);
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mo}-${day}`;
}

function expiryError(exc, today) {
  const name = excName(exc);
  const raw = exc?.expires;
  if (typeof raw !== "string" || raw === "") return `audit: ${name} 例外缺少到期日，拒絕放行`;
  const parts = isoParts(raw);
  if (!parts) return `audit: ${name} 例外到期日格式須為 YYYY-MM-DD，拒絕放行`;
  if (!calendarOk(parts[0], parts[1], parts[2])) return `audit: ${name} 例外到期日不是真實日期，拒絕放行`;
  if (!(today < raw)) return `audit: ${name} 例外已於 ${raw} 到期，請移除例外並升版`;
  const latest = addIsoDays(today, MAX_EXC_DAYS);
  if (!latest || raw > latest) return `audit: ${name} 例外到期日距今超過 90 天，拒絕放行`;
  return null;
}

function exceptionProblems(list, today) {
  const errors = [];
  for (const exc of list) {
    const expErr = expiryError(exc, today);
    if (expErr) errors.push(expErr);
    if (!reasonOf(exc)) errors.push(`audit: ${excName(exc)} 例外缺少理由，拒絕放行`);
  }
  return errors;
}

function staleWarnings(list, advs) {
  const ids = new Set(advs.map(a => a.github_advisory_id));
  return list.filter(exc => !ids.has(exc?.id)).map(exc => `audit: 警告 ${exc?.id ?? "?"} 已不在這次掃描，應移除此例外`);
}

const line = a => [a.severity, a.module_name, a.github_advisory_id, `${a.vulnerable_versions} → 修補 ${a.patched_versions}`, a.title,
  [...new Set((a.findings || []).flatMap(f => f.paths || []))].join(" ")].join("\t");

function advisoriesOf(scan) {
  if (!scan || typeof scan !== "object" || scan.error) return null;
  const a = scan.advisories;
  return a && typeof a === "object" && !Array.isArray(a) ? Object.values(a) : null;
}

function metadataConsistent(scan, advs) {
  const v = scan.metadata?.vulnerabilities;
  if (!v || !Number.isInteger(v.high) || !Number.isInteger(v.critical)) return false;
  return v.high + v.critical === advs.filter(a => GATED.has(sevOf(a))).length;
}

function judge(a, live, allowed, errors) {
  if (SKIP.has(sevOf(a))) return;
  const hit = live.find(exc => matchesExc(exc, a));
  if (GATED.has(sevOf(a)) && hit) allowed.push(`有期限例外（${hit.expires} 起失效，Asia/Taipei）\t${line(a)}`);
  else errors.push(`audit: 擋下 ${line(a)}`);
}

function finish(ok, allowed, lines, errors, warnings) {
  for (const w of warnings) console.warn(w);
  return { ok, allowed, lines, errors, warnings };
}

function liveOf(list, today) {
  return list.filter(exc => expiryError(exc, today) === null && reasonOf(exc));
}

/** @param {unknown} scan @param {string} today YYYY-MM-DD（Asia/Taipei） @param {readonly object[]} [exceptions] */
export function evaluateAudit(scan, today, exceptions = EXCEPTIONS) {
  const allowed = [], lines = [], errors = [];
  const list = Array.isArray(exceptions) ? exceptions : null;
  if (!list) errors.push("audit: 例外清單不是陣列");
  else errors.push(...exceptionProblems(list, today));
  const advs = advisoriesOf(scan);
  if (!advs) return finish(false, allowed, lines, [...errors, "audit: 無法解析 pnpm audit --json 輸出"], []);
  if (!metadataConsistent(scan, advs)) errors.push("audit: metadata 的 high/critical 數與 advisories 不符或缺少");
  const warnings = list ? staleWarnings(list, advs) : [];
  const live = list ? liveOf(list, today) : [];
  for (const a of advs) { lines.push(line(a)); judge(a, live, allowed, errors); }
  return finish(errors.length === 0, allowed, lines, errors, warnings);
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
