import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/**
 * B2：驗證 acquireSchemaLock 還原 statement_timeout 的成敗路徑。
 * 不匯出生產函式；在 openDb 所用的同一條 migrate client 上攔截 query／release（仿 TxClient 注入）。
 */
const SCHEMA_LOCK = 872_364_201;
const LOCK_TIMEOUT_SETTING = "5000ms";
const MIGRATE_ADVISORY_LOCK_FAILED =
  "無法在時限內取得資料庫遷移協調鎖，已拒絕啟動；請確認沒有其他實例或長時間作業佔用鎖後再重試";
const MIGRATE_TIMEOUT_RESTORE_FAILED =
  "無法還原資料庫語句時限設定，已拒絕啟動；請確認資料庫連線正常後再重試";

function queryText(q: unknown): string {
  if (typeof q === "string") return q;
  if (q !== null && typeof q === "object" && "text" in q) return String((q as { text: unknown }).text);
  return "";
}

function isShowTimeout(sql: string): boolean {
  return /^\s*SHOW\s+statement_timeout\s*$/i.test(sql);
}

function isSetTimeoutConfig(sql: string): boolean {
  return /set_config\(\s*'statement_timeout'/i.test(sql);
}

type QueryRun = (sql?: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

type ClientHook = {
  onQuery?: (info: { sql: string; params: unknown[] | undefined; run: QueryRun }) => Promise<{ rows: Array<Record<string, unknown>> }>;
  onRelease?: (arg: unknown) => void;
};

const uninstalls: Array<() => void> = [];

function installClientHook(hook: ClientHook): void {
  const origConnect = pg.Pool.prototype.connect;
  const connect = origConnect as unknown as (this: pg.Pool) => Promise<pg.PoolClient>;
  pg.Pool.prototype.connect = function (this: pg.Pool, ...args: unknown[]) {
    if (typeof args[0] === "function") {
      return (origConnect as unknown as (this: pg.Pool, cb: unknown) => unknown).call(this, args[0]);
    }
    return connect.call(this).then((client) => {
      const origQuery = client.query.bind(client) as QueryRun;
      const origRelease = client.release.bind(client);
      client.query = ((...qargs: unknown[]) => {
        const sql = queryText(qargs[0]);
        const params = Array.isArray(qargs[1]) ? (qargs[1] as unknown[]) : undefined;
        const run: QueryRun = (s, p) => {
          if (s === undefined) return origQuery(...(qargs as [string, unknown[]?]));
          return origQuery(s, p);
        };
        if (hook.onQuery) return hook.onQuery({ sql, params, run });
        return run();
      }) as typeof client.query;
      client.release = ((arg?: Error | boolean) => {
        hook.onRelease?.(arg);
        return origRelease(arg);
      }) as typeof client.release;
      return client;
    });
  } as typeof pg.Pool.prototype.connect;
  uninstalls.push(() => {
    pg.Pool.prototype.connect = origConnect;
  });
}

afterEach(() => {
  while (uninstalls.length > 0) uninstalls.pop()!();
});

async function settleOpenDb(): Promise<{ ok: true; db: Db } | { ok: false; err: unknown }> {
  try {
    const db = await openDb(requireDatabaseUrl());
    return { ok: true, db };
  } catch (err) {
    return { ok: false, err };
  }
}

describe("acquireSchemaLock 還原 statement_timeout", () => {
  it.fails("取鎖成功但還原失敗 → 拒絕啟動並給出專屬中文訊息", async () => {
    installClientHook({
      onQuery: async ({ sql, params, run }) => {
        if (isSetTimeoutConfig(sql) && params?.[0] !== LOCK_TIMEOUT_SETTING) {
          throw new Error("injected");
        }
        return run();
      },
    });
    const outcome = await settleOpenDb();
    if (outcome.ok) await outcome.db.close().catch(() => {});
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && (outcome.err as Error).message).toBe(MIGRATE_TIMEOUT_RESTORE_FAILED);
    expect(MIGRATE_TIMEOUT_RESTORE_FAILED).not.toBe(MIGRATE_ADVISORY_LOCK_FAILED);
  });

  it("取鎖成功後，同一條 client 上 SHOW statement_timeout 等於取鎖前基準值", async () => {
    let baseline: string | undefined;
    let afterRestore: string | undefined;
    installClientHook({
      onQuery: async ({ sql, params, run }) => {
        if (isShowTimeout(sql) && baseline === undefined) {
          const r = await run();
          baseline = String(r.rows[0]!.statement_timeout);
          return r;
        }
        if (isSetTimeoutConfig(sql) && params?.[0] !== LOCK_TIMEOUT_SETTING) {
          const r = await run();
          const shown = await run("SHOW statement_timeout");
          afterRestore = String(shown.rows[0]!.statement_timeout);
          return r;
        }
        return run();
      },
    });
    const outcome = await settleOpenDb();
    if (outcome.ok) await outcome.db.close().catch(() => {});
    else throw outcome.err;
    expect(baseline).toEqual(expect.any(String));
    expect(afterRestore).toBe(baseline);
  });

  it("取鎖失敗且還原也失敗時，仍拋取鎖的原錯（不是還原錯）", async () => {
    const holder = new pg.Client({ connectionString: requireDatabaseUrl() });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK]);
    installClientHook({
      onQuery: async ({ sql, params, run }) => {
        if (isSetTimeoutConfig(sql) && params?.[0] !== LOCK_TIMEOUT_SETTING) {
          throw new Error("injected");
        }
        return run();
      },
    });
    try {
      const outcome = await settleOpenDb();
      if (outcome.ok) await outcome.db.close().catch(() => {});
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && (outcome.err as Error).message).toBe(MIGRATE_ADVISORY_LOCK_FAILED);
      expect((outcome.ok === false && (outcome.err as Error).message) || "").not.toBe(MIGRATE_TIMEOUT_RESTORE_FAILED);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK]).catch(() => {});
      await holder.end().catch(() => {});
    }
  }, 20_000);

  it.fails("遷移連線以 release(true) 丟棄，不還回 pool", async () => {
    const releases: unknown[] = [];
    installClientHook({ onRelease: (arg) => { releases.push(arg); } });
    const outcome = await settleOpenDb();
    if (outcome.ok) await outcome.db.close().catch(() => {});
    else throw outcome.err;
    expect(releases).toContain(true);
  });
});
