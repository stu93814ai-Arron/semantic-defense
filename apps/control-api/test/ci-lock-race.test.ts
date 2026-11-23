import argon2 from "argon2";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db, type Queryable } from "../src/db.js";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { bootJudgeApp } from "./helpers/judge.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/**
 * ci 步驟 1 卡住的三個成因（docs/decisions/2026-11-18-ci-lock-race.md；A 組領航員裁示，未經使用者確認）。
 * 全部以可控方式重現（持鎖／假計時器／固定連線分派），不依賴 20ms 競速。
 */
const SEED_LOCK = 872_364_202;
const SCHEMA_LOCK = 872_364_201;
const MIGRATE_LOCK_FAILED =
  "無法在時限內取得資料表的鎖以套用結構遷移，已拒絕啟動；請確認沒有長時間交易佔用資料表後再重試";
const MIGRATE_ADVISORY_LOCK_FAILED =
  "無法在時限內取得資料庫遷移協調鎖，已拒絕啟動；請確認沒有其他實例或長時間作業佔用鎖後再重試";

const clients: pg.Client[] = [];
const clientPids = new Map<pg.Client, number>();
let app: ControlApi | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  vi.useRealTimers();
  for (const c of clients.splice(0)) await c.end().catch(() => {});
  clientPids.clear();
});

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: requireDatabaseUrl() });
  await c.connect();
  const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  clients.push(c);
  clientPids.set(c, pid);
  return c;
}

/** 取消本測試已知連線以外、打在目前測試庫上的後端查詢（例如卡住的 openDb）。
 *  只用 pg_cancel_backend：pg_terminate_backend 會把 node-pg socket 打成未捕捉的 ECONNRESET。 */
async function cancelForeignBackends(): Promise<void> {
  const probe = await client();
  const keep = [...clientPids.values()];
  await probe.query(
    `SELECT pg_cancel_backend(a.pid)
     FROM pg_stat_activity a
     WHERE a.datname = current_database()
       AND a.backend_type = 'client backend'
       AND a.pid <> pg_backend_pid()
       AND NOT (a.pid = ANY($1::int[]))`,
    [keep],
  );
}

type OpenDbRace =
  | { kind: "opened"; db: Db }
  | { kind: "failed"; err: unknown }
  | { kind: "hung" };

async function raceOpenDb(opening: Promise<Db>, ms = 9_000): Promise<OpenDbRace> {
  opening.catch(() => {});
  return Promise.race([
    opening.then((db) => ({ kind: "opened" as const, db }), (err: unknown) => ({ kind: "failed" as const, err })),
    new Promise<Extract<OpenDbRace, { kind: "hung" }>>((r) => setTimeout(() => r({ kind: "hung" }), ms)),
  ]);
}

/** hung 時不得 await opening（那會把 9 秒競賽拖成 20 秒逾時）；先中止後端，再忽略後續 settle。 */
async function finishOpenDb(opening: Promise<Db>, outcome: OpenDbRace | undefined): Promise<void> {
  if (outcome?.kind === "opened") {
    await outcome.db.close().catch(() => {});
    return;
  }
  if (outcome?.kind === "failed") return;
  void opening.then((d) => d.close()).catch(() => {});
  await cancelForeignBackends();
}

/** 有誰持有（granted）或在等（!granted）某把 session advisory 鎖。 */
async function advisory(key: number, granted: boolean): Promise<number[]> {
  const probe = await client();
  const r = await probe.query<{ pid: number }>(
    "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND objsubid = 1 AND granted = $2",
    [key, granted]);
  return r.rows.map((x) => x.pid);
}

async function waitAdvisoryWaiter(key: number, timeoutMs = 5_000): Promise<boolean> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    if ((await advisory(key, false)).length > 0) return true;
  }
  return false;
}

describe("① 判定 timer 不得在 seed 期間就已啟動", () => {
  it("bootJudgeApp(judgeIntervalMs>0)：seed 卡在 SEED_LOCK 時沒有任何已排程 timer；seed 完才啟", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const holder = await client();
    await holder.query("SELECT pg_advisory_lock($1)", [SEED_LOCK]);
    const booting = bootJudgeApp({ judgeIntervalMs: 20 });
    let armedDuringSeed: number;
    try {
      expect(await waitAdvisoryWaiter(SEED_LOCK)).toBe(true);
      // 此時 seed（TRUNCATE 之前）被擋住；若已有 timer，推進時鐘就會在 seed 中途跑 tick
      armedDuringSeed = vi.getTimerCount();
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [SEED_LOCK]);
      app = await booting;
    }
    expect(armedDuringSeed).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("② SEED_LOCK 的 lock／TRUNCATE／unlock 必須在同一條連線", () => {
  it("pool 把第一個查詢分到 A、其餘分到 B 時，seed 結束後沒有任何連線持有 SEED_LOCK", async () => {
    app = await buildApp({ databaseUrl: requireDatabaseUrl() });
    const [a, b, s] = [await client(), await client(), await client()];
    let first = true;
    const on = (c: pg.Client): Queryable => ({
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await c.query(sql, params)).rows as T[] }),
    });
    // 模擬 pg.Pool：每次 query 各自借連線；第一個（pg_advisory_lock）落在 A，之後都落在 B
    const split: Db = {
      query: async <T>(sql: string, params?: unknown[]) => {
        const c = first ? a : b;
        first = false;
        return on(c).query<T>(sql, params);
      },
      exec: async (sql: string) => { first = false; await b.query(sql); },
      close: async () => {},
      tx: <T>(fn: (q: Queryable) => Promise<T>) => app!.db.tx(fn),
      withSession: <T>(fn: (q: Queryable) => Promise<T>) => fn(on(s)),
    };
    await seedPhase2Fixtures({ db: split } as unknown as ControlApi);
    expect(await advisory(SEED_LOCK, true)).toEqual([]);
  });
});

describe("③ 啟動遷移的 CREATE INDEX 遇到被鎖的表：時限內拒絕啟動並放掉 SCHEMA_LOCK", () => {
  it("audit_events 被另一交易 ACCESS EXCLUSIVE 鎖住 → openDb 於 lock_timeout（5s）內以中文訊息失敗", async () => {
    // 先確保表已存在（遷移冪等）
    await (await openDb(requireDatabaseUrl())).close();
    const holder = await client();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE");
    const started = Date.now();
    const opening = openDb(requireDatabaseUrl());
    let outcome: OpenDbRace | undefined;
    try {
      outcome = await raceOpenDb(opening);
      const elapsed = Date.now() - started;
      const schemaHolders = await advisory(SCHEMA_LOCK, true);
      expect(outcome.kind).toBe("failed");
      expect(outcome.kind === "failed" && (outcome.err as Error).message).toBe(MIGRATE_LOCK_FAILED);
      expect(elapsed).toBeLessThan(9_000);
      expect(schemaHolders).toEqual([]);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await finishOpenDb(opening, outcome);
    }
  }, 20_000);
});

describe("④ 啟動遷移取 SCHEMA_LOCK（advisory）被他人持有：時限內拒絕啟動", () => {
  it("另一連線持有 SCHEMA_LOCK → openDb 於 statement_timeout（5s）內以專屬中文訊息失敗", async () => {
    // 先確保表已存在（遷移冪等），再讓他人持有遷移協調鎖
    await (await openDb(requireDatabaseUrl())).close();
    const holder = await client();
    await holder.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK]);
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const started = Date.now();
    const opening = openDb(requireDatabaseUrl());
    let outcome: OpenDbRace | undefined;
    try {
      outcome = await raceOpenDb(opening);
      const elapsed = Date.now() - started;
      const schemaHolders = await advisory(SCHEMA_LOCK, true);
      expect(outcome.kind).toBe("failed");
      expect(outcome.kind === "failed" && (outcome.err as Error).message).toBe(MIGRATE_ADVISORY_LOCK_FAILED);
      expect(MIGRATE_ADVISORY_LOCK_FAILED).not.toBe(MIGRATE_LOCK_FAILED);
      expect(elapsed).toBeLessThan(9_000);
      expect(schemaHolders).toEqual([holderPid]);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK]).catch(() => {});
      await finishOpenDb(opening, outcome);
    }
  }, 20_000);
});

describe("⑤ seed 計算密碼雜湊時不持有 SEED_LOCK，且中途失敗後鎖立即釋放", () => {
  it.fails("argon2.hash 當下 pg_locks 沒有 SEED_LOCK；INSERT 失敗後亦無持有者", async () => {
    app = await buildApp({ databaseUrl: requireDatabaseUrl() });
    const orig = argon2.hash.bind(argon2);
    const heldDuringHash: number[][] = [];
    const spy = vi.spyOn(argon2, "hash").mockImplementation(((plain: string, opts?: Parameters<typeof argon2.hash>[1]) => {
      return (async () => {
        heldDuringHash.push(await advisory(SEED_LOCK, true));
        return orig(plain, opts);
      })();
    }) as typeof argon2.hash);
    try {
      await seedPhase2Fixtures(app);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      for (const holders of heldDuringHash) expect(holders).toEqual([]);

      const wrap = (q: Queryable): Queryable => ({
        query: async <T>(sql: string, params?: unknown[]) => {
          if (String(sql).startsWith("INSERT INTO users")) throw new Error("injected");
          return q.query<T>(sql, params);
        },
      });
      const db = app.db;
      const origTx = db.tx.bind(db);
      const origSession = db.withSession.bind(db);
      db.tx = <T>(fn: (q: Queryable) => Promise<T>) => origTx((q) => fn(wrap(q)));
      db.withSession = <T>(fn: (q: Queryable) => Promise<T>) => origSession((q) => fn(wrap(q)));
      await expect(seedPhase2Fixtures(app)).rejects.toThrow(/injected/);
      expect(await advisory(SEED_LOCK, true)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
