import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/**
 * 軟體大總召裁示（未經使用者確認）：連線壞掉時 unlock 拋錯不得蓋掉遷移原錯。
 * A 組領航員裁示（未經使用者確認）：先記下原錯，unlock 錯誤只放在 cause；仍拒絕啟動，且 release(true)。
 * 實作後 it.fails 已改回 it()。原錯留在 message，unlock 錯誤在 cause。
 */
type QueryRun = (sql?: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

type ClientHook = {
  onQuery?: (info: { sql: string; run: QueryRun }) => Promise<{ rows: Array<Record<string, unknown>> }>;
  onRelease?: (arg: unknown) => void;
};

function queryText(q: unknown): string {
  if (typeof q === "string") return q;
  if (q !== null && typeof q === "object" && "text" in q) return String((q as { text: unknown }).text);
  return "";
}

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
        const run: QueryRun = (s, p) => {
          if (s === undefined) return origQuery(...(qargs as [string, unknown[]?]));
          return origQuery(s, p);
        };
        if (hook.onQuery) return hook.onQuery({ sql, run });
        return run();
      }) as typeof client.query;
      client.release = ((arg?: Error | boolean) => {
        hook.onRelease?.(arg);
        return origRelease(arg);
      }) as typeof client.release;
      return client;
    });
  } as typeof pg.Pool.prototype.connect;
  uninstalls.push(() => { pg.Pool.prototype.connect = origConnect; });
}

afterEach(() => {
  while (uninstalls.length > 0) uninstalls.pop()?.();
});

async function settleOpenDb(): Promise<{ ok: true; db: Db } | { ok: false; err: unknown }> {
  try {
    return { ok: true, db: await openDb(requireDatabaseUrl()) };
  } catch (err) {
    return { ok: false, err };
  }
}

describe("unlock 失敗不得蓋掉遷移原錯", () => {
  it("結構語句失敗且 unlock 也拋錯時，仍拋原錯、cause 為 unlock，並 release(true)", async () => {
    const releases: unknown[] = [];
    installClientHook({
      onQuery: async ({ sql, run }) => {
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS users")) {
          const err = new Error("schema-broke") as Error & { code?: string };
          err.code = "42601";
          throw err;
        }
        if (sql.includes("pg_advisory_unlock(")) throw new Error("unlock-broke");
        return run();
      },
      onRelease: (arg) => { releases.push(arg); },
    });
    const outcome = await settleOpenDb();
    if (outcome.ok) await outcome.db.close().catch(() => {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.err).toBeInstanceOf(Error);
    const err = outcome.err as Error & { cause?: unknown };
    expect(err.message).toBe("schema-broke");
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe("unlock-broke");
    expect(releases).toContain(true);
  }, 15_000);
});
