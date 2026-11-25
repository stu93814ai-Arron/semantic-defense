import pg from "pg";
import { afterEach, expect } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import { requireDatabaseUrl } from "./pg.js";

/**
 * openDb 遷移連線的 query／release 攔截。
 * 從 schema-lock-restore、migrate-unlock-mask、username-normalize 抽出；行為與原本各檔內聯的版本相同。
 */
export type QueryRun = (sql?: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

export type MigrateQueryInfo = {
  sql: string;
  params: unknown[] | undefined;
  run: QueryRun;
};

export type ClientHook = {
  onQuery?: (info: MigrateQueryInfo) => Promise<{ rows: Array<Record<string, unknown>> }>;
  onRelease?: (arg: unknown) => void;
};

export type HookOptions = { wrapRelease?: boolean };

export function queryText(q: unknown): string {
  if (typeof q === "string") return q;
  if (q !== null && typeof q === "object" && "text" in q) return String((q as { text: unknown }).text);
  return "";
}

/** 攔截下一條 pool.connect。回傳解除安裝。wrapRelease 預設 true；username 掃描原本不包 release，傳 false。 */
export function installClientHook(hook: ClientHook, opts?: HookOptions): () => void {
  const wrapRelease = opts?.wrapRelease !== false;
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
        const run: QueryRun = (s, p) => (
          s === undefined ? origQuery(...(qargs as [string, unknown[]?])) : origQuery(s, p)
        );
        if (hook.onQuery) return hook.onQuery({ sql, params, run });
        return run();
      }) as typeof client.query;
      if (wrapRelease) {
        client.release = ((arg?: Error | boolean) => {
          hook.onRelease?.(arg);
          return origRelease(arg);
        }) as typeof client.release;
      }
      return client;
    });
  } as typeof pg.Pool.prototype.connect;
  return () => {
    pg.Pool.prototype.connect = origConnect;
  };
}

/** 本檔每個測試結束都卸下攔截（與原本各測試檔的 afterEach 相同）。 */
export function useClientHooks(): { install: (hook: ClientHook, opts?: HookOptions) => void } {
  const uninstalls: Array<() => void> = [];
  afterEach(() => {
    while (uninstalls.length > 0) uninstalls.pop()?.();
  });
  return {
    install(hook, opts) {
      uninstalls.push(installClientHook(hook, opts));
    },
  };
}

export async function settleOpenDb(): Promise<{ ok: true; db: Db } | { ok: false; err: unknown }> {
  try {
    const db = await openDb(requireDatabaseUrl());
    return { ok: true, db };
  } catch (err) {
    return { ok: false, err };
  }
}

/**
 * 成功就關掉，並斷言 openDb 失敗。回傳那個錯誤（可能是 undefined）。
 * 等同原本的 settle、close、expect(ok).toBe(false)、if (ok) return。
 */
export async function expectOpenDbRejected(): Promise<unknown> {
  const outcome = await settleOpenDb();
  if (outcome.ok) await outcome.db.close().catch(() => {});
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return undefined;
  return outcome.err;
}
