import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { ControlApi } from "./helpers/app.js";
import { buildApp } from "./helpers/app.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { LOCK_TEST_TIMEOUT_MS, holdAllowlistInsert, lockGuardedUrl } from "./helpers/locks.js";
import { PENDING_IP_RE, PENDING_NOW as NOW, bootPending, closeAfterEach, pendingOps } from "./helpers/pending.js";
import { APPROVE_CAP_MESSAGE, resolveApprovePerHour } from "../src/approve-guard.js";

/** 核准上限（A 組領航員裁示，未經使用者確認）：每個 operator 滑動 1 小時內成功核准數達上限後回 429。 */
let app: ControlApi;
const logs = closeAfterEach(() => app);
const { op, seedCase, approve, reject, caseRow, expectNoIp } = pendingOps(() => app, logs);
const HOUR = 60 * 60_000;

let seq = 0;
/** 直接寫入 n 筆 entry（計數來源），IP 用 64.1.x.y 依序遞增，與案件 IP 不衝突。 */
async function seedManual(n: number, over: { actor?: string; at?: number; source?: string } = {}): Promise<void> {
  const at = over.at ?? NOW - 10 * 60_000;
  await app.db.query(
    `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at)
     SELECT gen_random_uuid(), '64.1.' || ((g + $5::int) / 250) || '.' || ((g + $5::int) % 250 + 1) || '/32',
            $4, 0.8, gen_random_uuid(), $2::bigint, $2::bigint + 86400000, $3, $2::bigint
     FROM generate_series(1, $1::int) g`,
    [n, at, over.actor ?? "operator1", over.source ?? "manual", seq],
  );
  seq += n;
}

describe("SD_APPROVE_PER_HOUR 解析", () => {
  it("未設定或空字串 → 50；1–200 整數照用；其餘啟動時拋錯", () => {
    expect(resolveApprovePerHour({})).toBe(50);
    expect(resolveApprovePerHour({ SD_APPROVE_PER_HOUR: " " })).toBe(50);
    expect(resolveApprovePerHour({ SD_APPROVE_PER_HOUR: "1" })).toBe(1);
    expect(resolveApprovePerHour({ SD_APPROVE_PER_HOUR: "200" })).toBe(200);
    for (const bad of ["0", "201", "-1", "1.5", "abc", "1e2x", "Infinity"]) {
      expect(() => resolveApprovePerHour({ SD_APPROVE_PER_HOUR: bad })).toThrow(/SD_APPROVE_PER_HOUR/);
    }
    expect(resolveApprovePerHour({ SD_APPROVE_PER_HOUR: "abc" }, 7)).toBe(7);
    expect(() => resolveApprovePerHour({}, 0)).toThrow(/approvePerHour/);
    expect(() => resolveApprovePerHour({}, 201)).toThrow(/approvePerHour/);
  });

  it("buildApp 選項無效 → 啟動失敗；有效 → 啟動 log 只記數字", async () => {
    await expect(buildApp({ databaseUrl: requireDatabaseUrl(), approvePerHour: 0 })).rejects.toThrow(/approvePerHour/);
    app = await bootPending({ approvePerHour: 7 }, logs);
    const line = logs.find((l) => l.includes("approve guard"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ approve_per_hour: 7 });
  });
});

describe("核准上限", () => {
  it("窗內 manual（同一 operator）達上限 → 429，案件仍 open、不上榜；窗外、他人、auto 不計", async () => {
    app = await bootPending({ approvePerHour: 3 }, logs);
    await seedManual(2);
    await seedManual(1, { at: NOW - HOUR });
    await seedManual(2, { actor: "operator9" });
    await seedManual(2, { source: "auto", actor: "system:auto" });
    const c = await op();
    expect((await approve(c, await seedCase())).statusCode).toBe(200);
    const id = await seedCase({ ip: "64.0.113.8/32" });
    const r = await approve(c, id);
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: APPROVE_CAP_MESSAGE });
    expect(r.headers["retry-after"]).toBeUndefined();
    expect((await caseRow(id)).state).toBe("open");
    const n = await app.db.query<{ n: string }>("SELECT count(*) AS n FROM blocklist_entries WHERE source = 'manual' AND approved_by = 'operator1'");
    expect(Number(n.rows[0]!.n)).toBe(4);
    await expectNoIp(r.json());
  });

  it("超過上限時先回 429：不存在的案件、已核准的案件都不透露狀態；非 UUID 仍 404；退回不受限", async () => {
    app = await bootPending({ approvePerHour: 1 }, logs);
    await seedManual(1);
    const c = await op();
    expect((await approve(c, randomUUID())).statusCode).toBe(429);
    expect((await approve(c, await seedCase({ state: "approved", resolvedBy: "operator1", resolvedAt: NOW - 1000 }))).statusCode).toBe(429);
    expect((await approve(c, "nope")).statusCode).toBe(404);
    expect((await reject(c, await seedCase())).statusCode).toBe(204);
  });

  it("被擋的嘗試不計入：上限 2，最舊一筆滑出窗後，先前的 429 不佔名額", async () => {
    let clock = NOW;
    app = await bootPending({ approvePerHour: 2, now: () => clock }, logs);
    await seedManual(1, { at: NOW - HOUR + 1000 });
    await seedManual(1);
    const c = await op();
    const id = await seedCase();
    expect((await approve(c, id)).statusCode).toBe(429);
    expect((await approve(c, id)).statusCode).toBe(429);
    clock = NOW + 1000;
    expect((await approve(c, id)).statusCode).toBe(200);
  });

  it("並發：49 筆後第 50、51 筆同時到，只能一個 200、另一個 429", async () => {
    app = await bootPending({ databaseUrl: lockGuardedUrl() }, logs);
    await seedManual(49);
    const c = await op();
    const ids = [await seedCase({ ip: "64.0.114.1/32" }), await seedCase({ ip: "64.0.114.2/32" })];
    // 屏障：外部 tx 先握白名單寫鎖，兩個請求都卡在 SHARE；放行後兩者同時開跑。
    // 計數之後、上榜之前用 pg_sleep 拉長，沒有 actor 鎖時兩者必定都看到 49。
    const admin = new pg.Client({ connectionString: lockGuardedUrl() });
    await admin.connect();
    await admin.query(`CREATE FUNCTION ag_slow_case() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER ag_slow_case BEFORE UPDATE ON blacklist_cases
      FOR EACH ROW WHEN (NEW.ip LIKE '64.0.114.%') EXECUTE FUNCTION ag_slow_case()`);
    try {
      const hold = await holdAllowlistInsert("10.99.0.0/16", NOW);
      const pending = ids.map((id) => approve(c, id));
      await waitShareWaiters(admin, 2);
      await hold.commit();
      const codes = (await Promise.all(pending)).map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 429]);
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS ag_slow_case ON blacklist_cases");
      await admin.query("DROP FUNCTION IF EXISTS ag_slow_case()");
      await admin.end();
    }
    expect(logs.join("\n")).not.toMatch(PENDING_IP_RE);
  }, LOCK_TEST_TIMEOUT_MS);
});

async function waitShareWaiters(db: pg.Client, n: number): Promise<void> {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const r = await db.query("SELECT 1 FROM pg_locks WHERE relation = 'allowlist_entries'::regclass AND mode = 'ShareLock' AND NOT granted");
    if (r.rows.length >= n) return;
  }
  throw new Error("share waiters not reached");
}
