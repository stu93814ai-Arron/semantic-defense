/* eslint-disable security/detect-non-literal-fs-filename -- 路徑是 reports/ 或測試的 mkdtemp，非請求輸入 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import pg from "pg";

const ACTIVITY_SQL = `SELECT pid, application_name, state, wait_event_type, wait_event,
  EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) AS query_s, left(query, 2000) AS query
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid()`;
const LOCK_SQL = `SELECT l.pid, l.locktype, l.mode, l.granted, l.objid, l.relation::text AS rel
  FROM pg_locks l
  WHERE l.pid <> pg_backend_pid() AND (l.locktype = 'advisory' OR NOT l.granted)`;

let dir = "reports";
let killInstalled = false;

export function setReportDir(next) { dir = next; }
export function reportDir() { return dir; }

function atomicWrite(path, body) {
  writeFileSync(`${path}.tmp`, body);
  renameSync(`${path}.tmp`, path);
}

function failedSnap(snap) {
  return Boolean(snap && typeof snap.error === "string" && snap.error);
}

function previousIsGood(path) {
  if (!existsSync(path)) return false;
  try { return !JSON.parse(readFileSync(path, "utf8")).error; } catch { return false; }
}

function writeJson(reportDirName, name, snap) {
  mkdirSync(reportDirName, { recursive: true });
  atomicWrite(join(reportDirName, name), JSON.stringify({
    updatedAt: new Date().toISOString(), ...snap,
  }));
}

export function writeRunning(reportDirName, names) {
  writeJson(reportDirName, "vitest-live.json", { running: names });
}

export function writeSnapshot(reportDirName, snap) {
  const path = join(reportDirName, "pg-live.json");
  if (failedSnap(snap) && previousIsGood(path)) return;
  writeJson(reportDirName, "pg-live.json", snap);
}

/** TERM 快照另寫。失敗時留下上一份 pg-live.json，不把關機錯誤蓋上去。 */
export function writeTermSnapshot(reportDirName, snap) {
  writeJson(reportDirName, "pg-live-term.json", snap);
  if (!failedSnap(snap)) writeSnapshot(reportDirName, snap);
}

export function formatPartial(reportDirName) {
  const parts = ["::: 必跑被中斷，部分報告"];
  for (const name of ["vitest-live.json", "pg-live.json", "pg-live-term.json"]) {
    const path = join(reportDirName, name);
    if (!existsSync(path)) continue;
    parts.push(`--- ${name} ---`, readFileSync(path, "utf8"));
  }
  return parts.join("\n");
}

const QUERY_CAP = 200;
const ch = (query, i) => query.charAt(i);

function eatStandard(query, i) {
  let j = i + 1;
  while (j < query.length) {
    if (ch(query, j) === "'" && ch(query, j + 1) === "'") { j += 2; continue; }
    if (ch(query, j) === "'") return j + 1;
    j += 1;
  }
  return query.length;
}

function eatEscapeString(query, i) {
  if ((ch(query, i) !== "E" && ch(query, i) !== "e") || ch(query, i + 1) !== "'") return -1;
  let j = i + 2;
  while (j < query.length) {
    if (ch(query, j) === "\\" && j + 1 < query.length) { j += 2; continue; }
    if (ch(query, j) === "'") return j + 1;
    j += 1;
  }
  return query.length;
}

function eatDollar(query, i) {
  if (ch(query, i) !== "$") return null;
  const open = /^\$([A-Za-z0-9_]*)\$/.exec(query.slice(i));
  if (!open) return null;
  const close = `$${open[1]}$`;
  const from = i + open[0].length;
  const at = query.indexOf(close, from);
  return { next: at < 0 ? query.length : at + close.length, tag: open[1] };
}

function eatBlock(query, i) {
  let depth = 1;
  let j = i + 2;
  while (j < query.length && depth > 0) {
    if (ch(query, j) === "/" && ch(query, j + 1) === "*") { depth += 1; j += 2; continue; }
    if (ch(query, j) === "*" && ch(query, j + 1) === "/") { depth -= 1; j += 2; continue; }
    j += 1;
  }
  return { next: j, text: depth === 0 ? "/*?*/" : "/*?" };
}

function eatComment(query, i) {
  if (ch(query, i) === "-" && ch(query, i + 1) === "-") {
    let j = i + 2;
    while (j < query.length && ch(query, j) !== "\n") j += 1;
    return { next: j, text: "--?" };
  }
  if (ch(query, i) !== "/" || ch(query, i + 1) !== "*") return null;
  return eatBlock(query, i);
}

export function writeUnhandledCount(path, count) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, `${JSON.stringify({ count, startTime: Date.now() })}\n`);
}

function eatIdent(query, i) {
  if (ch(query, i) !== "\"") return -1;
  let j = i + 1;
  while (j < query.length) {
    if (ch(query, j) === "\"" && ch(query, j + 1) === "\"") { j += 2; continue; }
    if (ch(query, j) === "\"") return j + 1;
    j += 1;
  }
  return query.length;
}

function isDigit(c) {
  return c >= "0" && c <= "9";
}

function isHex(c) {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

function eatHex(query, i) {
  if (ch(query, i) !== "0" || (ch(query, i + 1) !== "x" && ch(query, i + 1) !== "X") || !isHex(ch(query, i + 2))) return -1;
  let j = i + 2;
  while (isHex(ch(query, j))) j += 1;
  return j;
}

function eatExponent(query, j) {
  const exp = ch(query, j);
  if (exp !== "e" && exp !== "E") return j;
  let k = j + 1;
  if (ch(query, k) === "+" || ch(query, k) === "-") k += 1;
  if (!isDigit(ch(query, k))) return j;
  while (isDigit(ch(query, k))) k += 1;
  return k;
}

function eatNumber(query, i) {
  if (i > 0 && /[A-Za-z0-9_$]/.test(ch(query, i - 1))) return -1;
  const hex = eatHex(query, i);
  if (hex >= 0) return hex;
  if (!isDigit(ch(query, i))) return -1;
  let j = i;
  while (isDigit(ch(query, j))) j += 1;
  if (ch(query, j) === "." && isDigit(ch(query, j + 1))) {
    j += 1;
    while (isDigit(ch(query, j))) j += 1;
  }
  return eatExponent(query, j);
}

function maskedSpan(query, i) {
  const comment = eatComment(query, i);
  if (comment) return comment;
  const dollar = eatDollar(query, i);
  if (dollar) return { next: dollar.next, text: `$${dollar.tag}$?$${dollar.tag}$` };
  const estr = eatEscapeString(query, i);
  if (estr >= 0) return { next: estr, text: `${ch(query, i)}'?'` };
  const ident = eatIdent(query, i);
  if (ident >= 0) return { next: ident, text: query.slice(i, ident) };
  if (ch(query, i) === "'") return { next: eatStandard(query, i), text: "'?'" };
  const num = eatNumber(query, i);
  if (num >= 0) return { next: num, text: "?" };
  return { next: i + 1, text: ch(query, i) };
}

/** 先遮註解、引號、E 字串、美元引號與數字，沒閉合就遮到結尾，最後才截到 200 字。 */
export function redactQuery(query) {
  const source = String(query ?? "");
  let out = "";
  for (let i = 0; i < source.length;) {
    const part = maskedSpan(source, i);
    out += part.text;
    i = part.next;
  }
  return out.slice(0, QUERY_CAP);
}

function redactActivity(rows) {
  return rows.map((row) => {
    if (!row || typeof row.query !== "string") return row;
    return { ...row, query: redactQuery(row.query) };
  });
}

export async function readServerSnapshot(query) {
  const activity = redactActivity((await query(ACTIVITY_SQL)).rows);
  const locks = (await query(LOCK_SQL)).rows;
  return { activity, locks };
}

export function snapshotClient(url) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
    query_timeout: 1000,
    application_name: "sd-live-report",
  });
  client.on("error", () => {});
  return client;
}

export async function captureActivity(url, open = snapshotClient) {
  if (!url) return { error: "DATABASE_URL unset", activity: [], locks: [] };
  const client = open(url);
  client.on("error", () => {});
  try {
    await client.connect();
    return await readServerSnapshot((sql) => client.query(sql));
  } finally {
    await client.end().catch(() => {});
  }
}

function errorSnap(err) {
  return { error: err instanceof Error ? err.message : String(err), activity: [], locks: [] };
}

export function installKillSnapshot(reportDirName, captureFn) {
  if (killInstalled) return;
  killInstalled = true;
  process.once("SIGTERM", () => {
    const kill = setTimeout(() => process.exit(143), 2500);
    kill.unref();
    Promise.resolve()
      .then(captureFn)
      .then((snap) => writeTermSnapshot(reportDirName, snap))
      .catch((err) => writeTermSnapshot(reportDirName, errorSnap(err)))
      .finally(() => process.exit(143));
  });
}

export function startActivityLoop(reportDirName, captureFn) {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    Promise.resolve()
      .then(captureFn)
      .then((snap) => writeSnapshot(reportDirName, snap))
      .catch((err) => writeSnapshot(reportDirName, errorSnap(err)))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
