/* eslint-disable security/detect-non-literal-fs-filename -- 路徑是 reports/ 或測試的 mkdtemp，非請求輸入 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

export function writeRunning(reportDirName, names) {
  mkdirSync(reportDirName, { recursive: true });
  atomicWrite(join(reportDirName, "vitest-live.json"), JSON.stringify({
    running: names, updatedAt: new Date().toISOString(),
  }));
}

export function writeSnapshot(reportDirName, snap) {
  mkdirSync(reportDirName, { recursive: true });
  atomicWrite(join(reportDirName, "pg-live.json"), JSON.stringify({
    updatedAt: new Date().toISOString(), ...snap,
  }));
}

export function formatPartial(reportDirName) {
  const parts = ["::: 必跑被中斷，部分報告"];
  for (const name of ["vitest-live.json", "pg-live.json"]) {
    const path = join(reportDirName, name);
    if (!existsSync(path)) continue;
    parts.push(`--- ${name} ---`, readFileSync(path, "utf8"));
  }
  return parts.join("\n");
}

export async function readServerSnapshot(query) {
  const activity = (await query(ACTIVITY_SQL)).rows;
  const locks = (await query(LOCK_SQL)).rows;
  return { activity, locks };
}

export async function captureActivity(url) {
  if (!url) return { error: "DATABASE_URL unset", activity: [], locks: [] };
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
    query_timeout: 1000,
    application_name: "sd-live-report",
  });
  await client.connect();
  try {
    return await readServerSnapshot((sql) => client.query(sql));
  } finally {
    await client.end().catch(() => {});
  }
}

export function installKillSnapshot(reportDirName, captureFn) {
  if (killInstalled) return;
  killInstalled = true;
  process.once("SIGTERM", () => {
    const kill = setTimeout(() => process.exit(143), 2500);
    kill.unref();
    Promise.resolve()
      .then(captureFn)
      .then((snap) => writeSnapshot(reportDirName, snap))
      .catch((err) => writeSnapshot(reportDirName, { error: err instanceof Error ? err.message : String(err), activity: [], locks: [] }))
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
      .catch((err) => writeSnapshot(reportDirName, { error: err instanceof Error ? err.message : String(err), activity: [], locks: [] }))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
