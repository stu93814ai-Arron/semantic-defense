/* eslint-disable security/detect-non-literal-fs-filename -- 路徑是 reports/ 或測試的 mkdtemp，非請求輸入 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const ACTIVITY_SQL = `SELECT pid, application_name, state, wait_event_type, wait_event,
  EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) AS query_s, left(query, 200) AS query
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
const QUOTED = /'(?:[^']|'')*'/g;

export function redactQuery(query) {
  const masked = String(query ?? "").replace(QUOTED, "'?'");
  return masked.length > QUERY_CAP ? masked.slice(0, QUERY_CAP) : masked;
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
