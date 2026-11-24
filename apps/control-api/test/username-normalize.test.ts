import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { assertCreatableUsername, insertUser } from "../src/users.js";
import type { ControlApi } from "./helpers/app.js";
import { buildApp, seedPhase2Fixtures } from "./helpers/app.js";
import { truncatePhase2Tables, requireDatabaseUrl } from "./helpers/pg.js";
import {
  bootPending, closeAfterEach, pendingOps,
} from "./helpers/pending.js";
import { LOGIN_ERROR, login } from "./helpers/session.js";

/** 帳號正規化（A 組領航員裁示，未經使用者確認）：NFKC＋trim＋小寫為穩定鍵。 */
const FULLWIDTH_OPERATOR1 = "Ｏｐｅｒａｔｏｒ１";
const USERS_CHECK = "users_username_normalized";
const USERS_LOWER_IDX = "users_username_lower";

async function sessionUser(
  app: ControlApi, cookie: string,
): Promise<{ id: number; username: string }> {
  const sid = cookie.startsWith("sd_session=") ? cookie.slice("sd_session=".length) : cookie;
  const r = await app.db.query<{ id: number; username: string }>(
    "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1",
    [sid],
  );
  return r.rows[0]!;
}

async function restoreSchema(): Promise<void> {
  const url = requireDatabaseUrl();
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(
      "TRUNCATE TABLE alert_outbox, audit_events, thresholds, allowlist_entries, blocklist_entries, blacklist_cases, case_hits, judge_cursor, sensor_tokens, sessions, apps, users, login_failures RESTART IDENTITY CASCADE",
    );
  } finally {
    await c.end();
  }
  const db = await openDb(url);
  await db.exec("INSERT INTO auto_list_settings (id, enabled) VALUES (TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET enabled = FALSE");
  await db.close();
}

describe("核准上限合併大小寫分身", () => {
  let app: ControlApi;
  const logs = closeAfterEach(() => app);
  const { seedCase, approve, audits, caseRow } = pendingOps(() => app, logs);

  it("operator1 與 OPERATOR1 登入同一 id；上限 2 時第三次 429，approved_by 與稽核 actor 皆為 operator1", async () => {
    app = await bootPending({ approvePerHour: 2 }, logs);
    const a = await login(app, { username: "operator1", password: "pass-operator-1" });
    const b = await login(app, { username: "OPERATOR1", password: "pass-operator-1" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ua = await sessionUser(app, a.cookie!);
    const ub = await sessionUser(app, b.cookie!);
    expect(ua.id).toBe(ub.id);
    expect(ua.username).toBe("operator1");
    expect(ub.username).toBe("operator1");
    expect((await approve(a.cookie, await seedCase())).statusCode).toBe(200);
    expect((await approve(b.cookie, await seedCase({ ip: "64.0.113.8/32" }))).statusCode).toBe(200);
    const third = await seedCase({ ip: "64.0.113.9/32" });
    const r = await approve(a.cookie, third);
    expect(r.statusCode).toBe(429);
    expect((await caseRow(third)).state).toBe("open");
    const listed = await app.db.query<{ approved_by: string }>(
      "SELECT approved_by FROM blocklist_entries WHERE source = 'manual'",
    );
    expect(listed.rows.map((row) => row.approved_by)).toEqual(["operator1", "operator1"]);
    const actors = (await audits()).filter((x) => x.action === "blacklist.approve").map((x) => x.actor);
    expect(actors).toEqual(["operator1", "operator1"]);
  });
});

describe("建立帳號：正規化後撞名與保留前綴、字元集", () => {
  it("已有 operator1 時，Operator1 與全形 Ｏｐｅｒａｔｏｒ１ 都不得寫入", async () => {
    const db = await openDb(requireDatabaseUrl());
    try {
      await truncatePhase2Tables(db);
      await insertUser(db, { username: "Operator1", password_hash: "x", role: "operator" });
      const first = await db.query<{ username: string }>("SELECT username FROM users");
      expect(first.rows.map((row) => row.username)).toEqual(["operator1"]);
      await expect(insertUser(db, {
        username: "OPERATOR1", password_hash: "x", role: "operator",
      })).rejects.toThrow();
      await expect(insertUser(db, {
        username: FULLWIDTH_OPERATOR1, password_hash: "x", role: "operator",
      })).rejects.toThrow();
      const n = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM users",
      );
      expect(n.rows[0]!.n).toBe("1");
      const names = await db.query<{ username: string }>("SELECT username FROM users");
      expect(names.rows.map((row) => row.username)).toEqual(["operator1"]);
    } finally {
      await db.close();
    }
  });

  it("正規化後以 system: 開頭的名稱一律拒絕，且不寫入", async () => {
    const db = await openDb(requireDatabaseUrl());
    try {
      await truncatePhase2Tables(db);
      for (const username of ["System:Install", " system:auto ", "SYSTEM:FOO"]) {
        expect(() => assertCreatableUsername(username)).toThrow();
        await expect(insertUser(db, {
          username, password_hash: "x", role: "platform_admin",
        })).rejects.toThrow();
      }
      const n = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM users");
      expect(n.rows[0]!.n).toBe("0");
    } finally {
      await db.close();
    }
  });

  it("正規化後不符字元集的名稱拒絕建立", async () => {
    const db = await openDb(requireDatabaseUrl());
    try {
      await truncatePhase2Tables(db);
      for (const username of ["bad name!", "你好", "operator1!"]) {
        expect(() => assertCreatableUsername(username)).toThrow();
        await expect(insertUser(db, {
          username, password_hash: "x", role: "operator",
        })).rejects.toThrow();
      }
      const n = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM users");
      expect(n.rows[0]!.n).toBe("0");
    } finally {
      await db.close();
    }
  });
});

describe("登入與失敗計數走正規化名稱", () => {
  let app: ControlApi;
  afterEach(async () => { if (app) await app.close(); });

  it("同一來源下大小寫分身的失敗次數合併", async () => {
    app = await buildApp({
      idleTimeoutMs: 60_000,
      loginRateLimit: { maxFailures: 5, windowMs: 60_000 },
    });
    await seedPhase2Fixtures(app);
    const addr = "203.0.113.30";
    for (const username of ["operator1", "OPERATOR1", "Operator1", "operator1", "OPERATOR1"]) {
      const r = await login(app, { username, password: "bad" }, { remoteAddress: addr });
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.payload)).toContain(LOGIN_ERROR);
    }
    const limited = await login(app, { username: "OPERATOR1", password: "bad" }, { remoteAddress: addr });
    expect(limited.status).toBe(429);
    expect(JSON.stringify(limited.payload)).toContain(LOGIN_ERROR);
    const rows = await app.db.query<{ username: string; n: string }>(
      "SELECT username, failure_count::text AS n FROM login_failures",
    );
    expect(rows.rows).toEqual([{ username: "operator1", n: "5" }]);
  });

  it("字元集不符的登入走一般 401，訊息與未知帳號相同且不透露原因", async () => {
    app = await buildApp({
      idleTimeoutMs: 60_000,
      loginRateLimit: { maxFailures: 20, windowMs: 60_000 },
    });
    await seedPhase2Fixtures(app);
    const bad = await login(app, { username: "operator1!", password: "pass-operator-1" });
    const unknown = await login(app, { username: "no-such-user", password: "x" });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.bodyText).toBe(unknown.bodyText);
    expect(JSON.stringify(bad.payload)).toContain(LOGIN_ERROR);
    expect(JSON.stringify(bad.payload)).not.toMatch(/字元|charset|invalid|格式|正規化|username/i);
  });
});

describe("舊庫啟動掃描", () => {
  afterEach(async () => { await restoreSchema(); });

  it("未正規化或正規化後碰撞的列會拒絕啟動，錯誤只列帳號名", async () => {
    const url = requireDatabaseUrl();
    const db = await openDb(url);
    await db.exec(`ALTER TABLE users DROP CONSTRAINT IF EXISTS ${USERS_CHECK}`);
    await db.exec(`DROP INDEX IF EXISTS ${USERS_LOWER_IDX}`);
    await truncatePhase2Tables(db);
    await db.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1,'x','operator'), ($2,'x','operator'), ($3,'x','platform_admin')",
      ["operator1", "Operator1", "Admin1"],
    );
    await db.close();
    let msg = "";
    let started = false;
    try {
      await openDb(url);
      started = true;
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      msg = err instanceof Error ? err.message : "";
    }
    expect(started).toBe(false);
    expect(msg).toContain("operator1");
    expect(msg).toContain("Operator1");
    expect(msg).toContain("Admin1");
    expect(msg).not.toMatch(/password_hash|INSERT INTO|postgresql:\/\//i);
    expect(msg).not.toMatch(/platform_admin|\bx\b/);
  });

  it("已是小寫加 trim 但字元集不合法的列也拒絕啟動，錯誤只列帳號名", async () => {
    const url = requireDatabaseUrl();
    const db = await openDb(url);
    await db.exec(`ALTER TABLE users DROP CONSTRAINT IF EXISTS ${USERS_CHECK}`);
    await db.exec(`DROP INDEX IF EXISTS ${USERS_LOWER_IDX}`);
    await truncatePhase2Tables(db);
    await db.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1,'x','operator'), ($2,'x','operator'), ($3,'x','platform_admin')",
      ["op one", "你好", "operator2"],
    );
    await db.close();
    let msg = "";
    let started = false;
    try {
      const reopened = await openDb(url);
      started = true;
      await reopened.close();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      msg = err instanceof Error ? err.message : "";
    }
    expect(started).toBe(false);
    expect(msg).toContain("op one");
    expect(msg).toContain("你好");
    expect(msg).not.toContain("operator2");
    expect(msg).not.toMatch(/password_hash|INSERT INTO|postgresql:\/\//i);
    expect(msg).not.toMatch(/platform_admin|\bx\b/);
  });
});

/** 另一條連線鎖住 users；10 秒後保底釋放，確保受測啟動不會無限等待。 */
async function holdUsersLock(url: string): Promise<{ release: () => Promise<void> }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("BEGIN");
  await c.query("LOCK TABLE users IN ACCESS EXCLUSIVE MODE");
  let done = false;
  const release = async (): Promise<void> => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { await c.query("ROLLBACK"); } finally { await c.end(); }
  };
  const timer = setTimeout(() => { void release(); }, 10_000);
  return { release };
}

async function catalogHas(url: string): Promise<{ index: boolean; check: boolean }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const i = await c.query("SELECT 1 FROM pg_indexes WHERE tablename = 'users' AND indexname = $1", [USERS_LOWER_IDX]);
    const k = await c.query("SELECT 1 FROM pg_constraint WHERE conname = $1", [USERS_CHECK]);
    return { index: i.rows.length > 0, check: k.rows.length > 0 };
  } finally {
    await c.end();
  }
}

describe("啟動時 users 鎖：已具約束即略過，缺約束時 lock_timeout 內拒絕啟動", () => {
  afterEach(async () => { await restoreSchema(); });

  it("索引與 CHECK 都在時，users 被他連線鎖住仍於 2 秒內正常啟動", async () => {
    const url = requireDatabaseUrl();
    await (await openDb(url)).close();
    expect(await catalogHas(url)).toEqual({ index: true, check: true });
    const lock = await holdUsersLock(url);
    try {
      const t0 = Date.now();
      const db = await openDb(url);
      const elapsed = Date.now() - t0;
      await db.close();
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await lock.release();
    }
  }, 20_000);

  it("缺索引且 users 被鎖住時，於 lock_timeout 內拒絕啟動並給出清楚訊息", async () => {
    const url = requireDatabaseUrl();
    const db0 = await openDb(url);
    await db0.exec(`DROP INDEX IF EXISTS ${USERS_LOWER_IDX}`);
    await db0.close();
    const lock = await holdUsersLock(url);
    let msg = "";
    let started = false;
    const t0 = Date.now();
    try {
      const db = await openDb(url);
      started = true;
      await db.close();
    } catch (err) {
      msg = err instanceof Error ? err.message : "";
    } finally {
      await lock.release();
    }
    const elapsed = Date.now() - t0;
    expect(started).toBe(false);
    expect(elapsed).toBeLessThan(8_000);
    expect(msg).toContain("已拒絕啟動");
    expect(msg).not.toMatch(/LOCK|SELECT|lock_timeout|canceling|users/i);
  }, 20_000);
});

type QueryRun = (sql?: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

function queryText(q: unknown): string {
  if (typeof q === "string") return q;
  if (q !== null && typeof q === "object" && "text" in q) return String((q as { text: unknown }).text);
  return "";
}

/** 只包 openDb 的 migrate client。回傳解除安裝。 */
function installMigrateHook(
  onQuery: (info: { sql: string; run: QueryRun }) => Promise<{ rows: Array<Record<string, unknown>> }>,
): () => void {
  const origConnect = pg.Pool.prototype.connect;
  const connect = origConnect as unknown as (this: pg.Pool) => Promise<pg.PoolClient>;
  pg.Pool.prototype.connect = function (this: pg.Pool, ...args: unknown[]) {
    if (typeof args[0] === "function") {
      return (origConnect as unknown as (this: pg.Pool, cb: unknown) => unknown).call(this, args[0]);
    }
    return connect.call(this).then((client) => {
      const origQuery = client.query.bind(client) as QueryRun;
      client.query = ((...qargs: unknown[]) => {
        const sql = queryText(qargs[0]);
        const run: QueryRun = (s, p) => {
          if (s === undefined) return origQuery(...(qargs as [string, unknown[]?]));
          return origQuery(s, p);
        };
        return onQuery({ sql, run });
      }) as typeof client.query;
      return client;
    });
  } as typeof pg.Pool.prototype.connect;
  return () => { pg.Pool.prototype.connect = origConnect; };
}

async function readXact(run: QueryRun): Promise<string> {
  const r = await run("SELECT pg_current_xact_id()::text AS id");
  return String(r.rows[0]!.id);
}

async function readPid(run: QueryRun): Promise<number> {
  const r = await run("SELECT pg_backend_pid() AS pid");
  return Number(r.rows[0]!.pid);
}

async function holdsUsersLock(url: string, pid: number): Promise<boolean> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND relation = 'users'::regclass AND mode = 'ShareRowExclusiveLock' AND granted",
      [pid],
    );
    return r.rows.length > 0;
  } finally {
    await c.end();
  }
}

/** 另一條連線試著插入未正規化帳號。鎖還在應於 300ms 得到 55P03，不得卡住。 */
async function blockedInsertCode(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  let code = "timeout";
  try {
    await c.query("SET statement_timeout = '1s'");
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '300ms'");
    try {
      await c.query("INSERT INTO users (username, password_hash, role) VALUES ('Bad Name', 'x', 'operator')");
      code = "ok";
    } catch (err) {
      code = err !== null && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "error";
    }
    await c.query("ROLLBACK");
    return code;
  } finally {
    await Promise.race([c.end(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

describe("U2 掃描與加約束在同一交易並持有 users 鎖", () => {
  const uninstalls: Array<() => void> = [];
  afterEach(async () => {
    while (uninstalls.length > 0) uninstalls.pop()?.();
    await restoreSchema();
  });

  it("掃描當下擋住非法插入，且加約束仍是同一筆交易", async () => {
    const url = requireDatabaseUrl();
    const prep = await openDb(url);
    await prep.exec(`ALTER TABLE users DROP CONSTRAINT IF EXISTS ${USERS_CHECK}`);
    await prep.exec(`DROP INDEX IF EXISTS ${USERS_LOWER_IDX}`);
    await truncatePhase2Tables(prep);
    await prep.close();
    let scanXact = "";
    let alterXact = "";
    let insertCode = "";
    let lockHeld = false;
    uninstalls.push(installMigrateHook(async ({ sql, run }) => {
      if (sql.trim() === "SELECT username FROM users") {
        const rows = await run();
        scanXact = await readXact(run);
        lockHeld = await holdsUsersLock(url, await readPid(run));
        insertCode = await blockedInsertCode(url);
        return rows;
      }
      if (sql.includes(`ADD CONSTRAINT ${USERS_CHECK}`)) alterXact = await readXact(run);
      return run();
    }));
    const db = await openDb(url);
    await db.close();
    expect(lockHeld).toBe(true);
    expect(insertCode).toBe("55P03");
    expect(scanXact.length).toBeGreaterThan(0);
    expect(alterXact).toBe(scanXact);
    expect(await catalogHas(url)).toEqual({ index: true, check: true });
  }, 20_000);
});
