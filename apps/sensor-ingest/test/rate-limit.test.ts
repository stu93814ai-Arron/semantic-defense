import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildIngest } from "../src/app.js";
import { AUTH_FAIL_LIMIT, AUTH_FAIL_MAX_KEYS, AUTH_FAIL_WINDOW_MS, createAuthFailLimiter } from "../src/rate-limit.js";
import { openTestDb, seedToken } from "./helpers.js";

let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

const T0 = 1_800_000_000_000;
const BAD = { authorization: `Bearer sdst_${randomUUID()}.${"A".repeat(43)}` };
const get = (app: Awaited<ReturnType<typeof buildIngest>>, ip: string, headers: Record<string, string> = BAD) =>
  app.inject({ method: "GET", url: "/v1/health", headers, remoteAddress: ip });

describe("未授權來源 IP 速率限制", () => {
  it("常數：每 60s 30 次", () => {
    expect(AUTH_FAIL_LIMIT).toBe(30);
    expect(AUTH_FAIL_WINDOW_MS).toBe(60_000);
  });

  it("同 IP 30 次壞 token 皆 401，第 31 次 429；換 IP 不受影響；XFF 無效；窗口過後恢復 401", async () => {
    let now = T0;
    const app = await buildIngest({ db, requireHttps: false, now: () => now });
    for (let i = 0; i < 30; i++) expect((await get(app, "10.0.0.1")).statusCode).toBe(401);
    expect((await get(app, "10.0.0.1")).statusCode).toBe(429);
    expect((await get(app, "10.0.0.1", {})).statusCode).toBe(429);
    expect((await get(app, "10.0.0.2", { ...BAD, "x-forwarded-for": "10.0.0.1" })).statusCode).toBe(401);
    now = T0 + AUTH_FAIL_WINDOW_MS - 1;
    expect((await get(app, "10.0.0.1")).statusCode).toBe(429);
    now = T0 + AUTH_FAIL_WINDOW_MS;
    expect((await get(app, "10.0.0.1")).statusCode).toBe(401);
    await app.close();
  });

  it("403（IP 不在 allowlist）與成功不計入失敗窗口", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    const t = await seedToken(db, ["10.0.0.0/8"]);
    const ok = { authorization: `Bearer ${t}` };
    for (let i = 0; i < 40; i++) {
      expect((await get(app, "10.0.0.9", ok)).statusCode).toBe(200);
      expect((await get(app, "192.168.0.9", ok)).statusCode).toBe(403);
    }
    expect((await get(app, "192.168.0.9")).statusCode).toBe(401);
    await app.close();
  });

  it("不存在 sensor 與錯 secret 的 401 body 完全相同", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    const t = await seedToken(db, ["10.0.0.0/8"]);
    const wrong = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    const a = await get(app, "10.0.0.3");
    const b = await get(app, "10.0.0.3", { authorization: `Bearer ${wrong}` });
    expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
    expect(a.body).toBe(b.body);
    expect(a.json()).toEqual({ error: "未授權" });
    await app.close();
  });
});

describe("失敗計數 Map 上限與過期清理", () => {
  const MAX = 4;
  const block = (l: ReturnType<typeof createAuthFailLimiter>, ip: string, now: number) => {
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) l.recordFail(ip, now);
  };

  it("常數：AUTH_FAIL_MAX_KEYS = 10_000（預設）", () => {
    expect(AUTH_FAIL_MAX_KEYS).toBe(10_000);
  });

  it("Map 滿時先清掉已過窗的 key（size 下降）", () => {
    const l = createAuthFailLimiter({ maxKeys: MAX });
    for (let i = 0; i < MAX; i++) l.recordFail(`10.0.0.${i}`, T0);
    expect(l.size()).toBe(MAX);
    l.recordFail("10.0.1.1", T0 + AUTH_FAIL_WINDOW_MS);
    expect(l.size()).toBe(1);
  });

  it("MAX＋1 個 IP 失敗後 size <= MAX，淘汰的是最舊的未封鎖 key", () => {
    const l = createAuthFailLimiter({ maxKeys: MAX });
    block(l, "10.0.0.1", T0);
    for (let i = 0; i < AUTH_FAIL_LIMIT - 1; i++) l.recordFail("10.0.0.2", T0 + 1);
    l.recordFail("10.0.0.3", T0 + 2);
    l.recordFail("10.0.0.4", T0 + 3);
    l.recordFail("10.0.0.5", T0 + 4);
    expect(l.size()).toBeLessThanOrEqual(MAX);
    l.recordFail("10.0.0.2", T0 + 5);
    expect(l.check("10.0.0.2", T0 + 5)).toBe("ok");
    expect(l.check("10.0.0.1", T0 + 5)).toBe("limited");
    expect(l.size()).toBeLessThanOrEqual(MAX);
  });

  it("A 已 429，用新 IP 把 Map 灌滿後 A 仍是 429", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0, authFailMaxKeys: MAX });
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) await get(app, "10.0.0.1");
    expect((await get(app, "10.0.0.1")).statusCode).toBe(429);
    for (let i = 0; i < MAX * 3; i++) expect((await get(app, `10.9.0.${i}`)).statusCode).toBe(401);
    expect((await get(app, "10.0.0.1")).statusCode).toBe(429);
    await app.close();
  });

  it("全部 key 都在封鎖中：新 IP 不被追蹤，照常走認證（401／200），不回 429", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0, authFailMaxKeys: 2 });
    for (const ip of ["10.0.0.1", "10.0.0.2"]) for (let i = 0; i < AUTH_FAIL_LIMIT; i++) await get(app, ip);
    for (let i = 0; i < AUTH_FAIL_LIMIT + 5; i++) expect((await get(app, "10.0.0.3")).statusCode).toBe(401);
    const t = await seedToken(db, ["10.0.0.0/8"]);
    expect((await get(app, "10.0.0.3", { authorization: `Bearer ${t}` })).statusCode).toBe(200);
    expect((await get(app, "10.0.0.1")).statusCode).toBe(429);
    await app.close();
  });
});
