import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUTH_FAIL_LIMIT, AUTH_FAIL_MAX_KEYS, AUTH_FAIL_WINDOW_MS, authFailKey, createAuthFailLimiter } from "../src/rate-limit.js";
import { buildIngest, openTestDb, seedToken } from "./helpers.js";

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

describe("有效 token 的感測器不受來源限流影響（先驗 Bearer，再查限流）", () => {
  const blockIp = async (app: Awaited<ReturnType<typeof buildIngest>>, ip: string) => {
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) expect((await get(app, ip)).statusCode).toBe(401);
    expect((await get(app, ip)).statusCode).toBe(429);
  };

  it("IPv4：攻擊者在同一 IP 打到 429 後，有效 token 從同一 IP 仍 200；無效 token 仍 429", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    const ok = { authorization: `Bearer ${await seedToken(db, ["10.0.0.0/8"])}` };
    await blockIp(app, "10.0.0.7");
    expect((await get(app, "10.0.0.7", ok)).statusCode).toBe(200);
    expect((await get(app, "10.0.0.7")).statusCode).toBe(429);
    expect((await get(app, "10.0.0.7", {})).statusCode).toBe(429);
    await app.close();
  });

  it("IPv6：攻擊者在同一 /64 打到 429 後，同 /64 的有效感測器 POST /v1/flows 仍 201；無效 token 仍 429", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    const ok = { authorization: `Bearer ${await seedToken(db, ["2001:db8:1:2::/64"])}` };
    await blockIp(app, "2001:db8:1:2::bad");
    expect((await get(app, "2001:db8:1:2::5", ok)).statusCode).toBe(200);
    const flow = await app.inject({
      method: "POST", url: "/v1/flows", remoteAddress: "2001:db8:1:2::5", headers: ok,
      payload: { flow_id: randomUUID(), app_id: "app-1", ts: "2027-01-15T07:00:00Z", src_ip: "64.0.113.5", dst_ip: "10.0.0.1",
        src_port: 51234, dst_port: 443, protocol: "tcp", bytes_in: 10, bytes_out: 20, packets: 3, duration_ms: 5 },
    });
    expect(flow.statusCode).toBe(201);
    expect((await get(app, "2001:db8:1:2::bad")).statusCode).toBe(429);
    await app.close();
  });

  it("有效 token 的成功請求不計數：成功多次後，無效 token 仍要到第 31 次才 429", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    const ok = { authorization: `Bearer ${await seedToken(db, ["10.0.0.0/8"])}` };
    for (let i = 0; i < 10; i++) expect((await get(app, "10.0.0.8")).statusCode).toBe(401);
    for (let i = 0; i < 50; i++) expect((await get(app, "10.0.0.8", ok)).statusCode).toBe(200);
    for (let i = 10; i < AUTH_FAIL_LIMIT; i++) expect((await get(app, "10.0.0.8")).statusCode).toBe(401);
    expect((await get(app, "10.0.0.8")).statusCode).toBe(429);
    await app.close();
  });

  it("有效 token 但來源不在 allowlist：維持 403、不查也不計限流（封鎖中的 IP 也是 403）", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    const ok = { authorization: `Bearer ${await seedToken(db, ["10.0.0.0/8"])}` };
    await blockIp(app, "192.168.0.7");
    expect((await get(app, "192.168.0.7", ok)).statusCode).toBe(403);
    for (let i = 0; i < 40; i++) expect((await get(app, "192.168.0.8", ok)).statusCode).toBe(403);
    expect((await get(app, "192.168.0.8")).statusCode).toBe(401);
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

describe("計數鍵：IPv4 /32、IPv6 /64", () => {
  const hammer = async (app: Awaited<ReturnType<typeof buildIngest>>, ips: string[], n: number) => {
    for (let i = 0; i < n; i++) expect((await get(app, ips[i % ips.length]!)).statusCode).toBe(401);
  };

  it("IPv6 同一 /64 共用計數：::1 與 ::ffff 合計 30 次後第 31 次 429；不同 /64 仍 401", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    await hammer(app, ["2001:db8:1:2::1", "2001:db8:1:2::ffff"], AUTH_FAIL_LIMIT);
    expect((await get(app, "2001:db8:1:2::1")).statusCode).toBe(429);
    expect((await get(app, "2001:db8:1:2::abcd")).statusCode).toBe(429);
    expect((await get(app, "2001:db8:1:3::1")).statusCode).toBe(401);
    await app.close();
  });

  it("IPv4 維持 /32：10.0.0.1 與 10.0.0.2 各自獨立", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    await hammer(app, ["10.0.0.1"], AUTH_FAIL_LIMIT);
    expect((await get(app, "10.0.0.1")).statusCode).toBe(429);
    expect((await get(app, "10.0.0.2")).statusCode).toBe(401);
    await app.close();
  });

  it("IPv4-mapped（::ffff:10.0.0.1）視同 10.0.0.1", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
    await hammer(app, ["::ffff:10.0.0.1", "10.0.0.1"], AUTH_FAIL_LIMIT);
    expect((await get(app, "10.0.0.1")).statusCode).toBe(429);
    expect((await get(app, "::ffff:10.0.0.1")).statusCode).toBe(429);
    expect((await get(app, "::ffff:10.0.0.2")).statusCode).toBe(401);
    await app.close();
  });

  it("鍵正規化：非 canonical IPv6（全展開、大寫）歸同一 /64；mapped → IPv4", () => {
    const k = authFailKey("2001:db8:1:2::1");
    expect(authFailKey("2001:0DB8:0001:0002:0000:0000:0000:0001")).toBe(k);
    expect(authFailKey("2001:DB8:1:2:FFFF:FFFF:FFFF:FFFF")).toBe(k);
    expect(authFailKey("2001:db8:1:3::1")).not.toBe(k);
    expect(authFailKey("::ffff:10.0.0.1")).toBe(authFailKey("10.0.0.1"));
    expect(authFailKey("::FFFF:0a00:0001")).toBe(authFailKey("10.0.0.1"));
    expect(authFailKey("10.0.0.1")).not.toBe(authFailKey("10.0.0.2"));
    expect(authFailKey("::1")).not.toBe(authFailKey("10.0.0.1"));
  });
});
