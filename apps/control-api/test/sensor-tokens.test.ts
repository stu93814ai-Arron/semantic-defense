import { afterEach, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/** E3.A ③(a)：感測器 token 發放／撤銷，僅 platform_admin，DB 只存雜湊。 */

let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl() });
  await seedPhase2Fixtures(app);
  return app;
}
async function cookieFor(username: string, password: string): Promise<string> {
  const r = await login(app, { username, password });
  expect(r.status).toBe(200);
  return r.cookie!;
}
const admin = () => cookieFor("admin1", "pass-admin-1");
async function issue(c: string, payload?: unknown) {
  return app.inject({ method: "POST", url: "/api/sensors/tokens", headers: cookieHeader(c), payload: payload as object });
}
type Row = { sensor_id: string; token_hash: string; revoked_at: string | null; label: string | null };
const rowOf = async (id: string) =>
  (await app.db.query<Row>("SELECT * FROM sensor_tokens WHERE sensor_id = $1", [id])).rows[0];

describe("感測器 token 發放", () => {
  it("admin 發放 201：回 sensor_id(uuid)＋一次性高熵 token；DB 只存 argon2 雜湊", async () => {
    await boot();
    const c = await admin();
    const res = await issue(c, { label: "edge-1" });
    expect(res.statusCode).toBe(201);
    const { sensor_id, token } = res.json() as { sensor_id: string; token: string };
    expect(sensor_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(token.length).toBeGreaterThanOrEqual(40);
    const row = (await rowOf(sensor_id))!;
    expect(row.token_hash).toMatch(/^\$argon2/);
    expect(row.token_hash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await argon2.verify(row.token_hash, token)).toBe(true);
    expect(row.label).toBe("edge-1");
    const res2 = await issue(c);
    expect(res2.statusCode).toBe(201);
    const b = res2.json() as { sensor_id: string; token: string };
    expect(b.sensor_id).not.toBe(sensor_id);
    expect(b.token).not.toBe(token);
  });

  it("GET 列表只回 metadata，無 hash／明文", async () => {
    await boot();
    const c = await admin();
    const { sensor_id, token } = (await issue(c, { label: "x" })).json() as { sensor_id: string; token: string };
    const hash = (await rowOf(sensor_id))!.token_hash;
    const res = await app.inject({ method: "GET", url: "/api/sensors/tokens", headers: cookieHeader(c) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain(hash);
    expect(res.body).not.toContain("token_hash");
    const items = (res.json() as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!).sort()).toEqual(["created_at", "label", "revoked_at", "sensor_id"]);
  });

  it("label 非字串或過長 → 400，且不建列", async () => {
    await boot();
    const c = await admin();
    expect((await issue(c, { label: 123 })).statusCode).toBe(400);
    expect((await issue(c, { label: "a".repeat(201) })).statusCode).toBe(400);
    expect((await issue(c, { label: "x", extra: 1 })).statusCode).toBe(400);
    const n = await app.db.query<{ n: string }>("SELECT count(*) AS n FROM sensor_tokens");
    expect(n.rows[0]!.n).toBe("0");
  });
});

describe("感測器 token 授權", () => {
  it("匿名 401；operator／app_owner 403（發放、列表、撤銷）", async () => {
    await boot();
    const { sensor_id } = (await issue(await admin())).json() as { sensor_id: string };
    const reqs = [
      { method: "POST" as const, url: "/api/sensors/tokens" },
      { method: "GET" as const, url: "/api/sensors/tokens" },
      { method: "POST" as const, url: `/api/sensors/tokens/${sensor_id}/revoke` },
    ];
    for (const r of reqs) expect((await app.inject(r)).statusCode).toBe(401);
    for (const [u, p] of [["operator1", "pass-operator-1"], ["owner1", "pass-owner-1"]] as const) {
      const c = await cookieFor(u, p);
      for (const r of reqs) expect((await app.inject({ ...r, headers: cookieHeader(c) })).statusCode).toBe(403);
    }
    expect((await rowOf(sensor_id))!.revoked_at).toBeNull();
  });
});

describe("感測器 token 撤銷", () => {
  it("撤銷 204、revoked_at 有值、列保留；再撤銷冪等且時間不變；不存在 404", async () => {
    await boot();
    const c = await admin();
    const { sensor_id, token } = (await issue(c)).json() as { sensor_id: string; token: string };
    const url = `/api/sensors/tokens/${sensor_id}/revoke`;
    const r1 = await app.inject({ method: "POST", url, headers: cookieHeader(c) });
    expect(r1.statusCode).toBe(204);
    const first = (await rowOf(sensor_id))!;
    expect(first.revoked_at).not.toBeNull();
    expect(first.sensor_id).toBe(sensor_id);
    const r2 = await app.inject({ method: "POST", url, headers: cookieHeader(c) });
    expect(r2.statusCode).toBe(204);
    expect((await rowOf(sensor_id))!.revoked_at).toBe(first.revoked_at);
    const r3 = await app.inject({
      method: "POST", url: "/api/sensors/tokens/00000000-0000-4000-8000-000000000000/revoke", headers: cookieHeader(c),
    });
    expect(r3.statusCode).toBe(404);
    for (const r of [r1, r2, r3]) {
      expect(r.body).not.toContain(token);
      expect(r.body).not.toContain(first.token_hash);
    }
    const bad = await app.inject({ method: "POST", url: "/api/sensors/tokens/not-a-uuid/revoke", headers: cookieHeader(c) });
    expect(bad.statusCode).toBe(404);
  });
});
