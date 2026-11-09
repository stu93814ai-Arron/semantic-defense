import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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
type Row = { sensor_id: string; token_hash: string; revoked_at: string | null; allowed_cidrs: string[] };
const OK = { allowed_cidrs: ["10.0.0.0/8"], allowed_app_ids: ["app-alpha"] };
const TOKEN_RE = /^sdst_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rowOf = async (id: string) =>
  (await app.db.query<Row>("SELECT * FROM sensor_tokens WHERE sensor_id = $1", [id])).rows[0];

describe("感測器 token 發放", () => {
  it("admin 發放 201：token＝sdst_<sensor_id>.<256-bit secret>；DB 只存 secret 的 SHA-256；存 allowed_cidrs", async () => {
    await boot();
    const c = await admin();
    const res = await issue(c, { allowed_cidrs: ["10.0.0.0/8", "2001:db8::/32"], allowed_app_ids: ["app-alpha", "app-beta"] });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { sensor_id, token } = res.json() as { sensor_id: string; token: string };
    expect(sensor_id).toMatch(/^[0-9a-f-]{36}$/);
    const m = TOKEN_RE.exec(token)!;
    expect(m).not.toBeNull();
    expect(m[1]).toBe(sensor_id);
    expect(Buffer.from(m[2]!, "base64url")).toHaveLength(32);
    const row = (await rowOf(sensor_id))!;
    expect(row.token_hash).toBe(sha(m[2]!));
    expect(JSON.stringify(row)).not.toContain(m[2]!);
    expect(row.allowed_cidrs).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
    expect((row as Row & { allowed_app_ids: string[] }).allowed_app_ids).toEqual(["app-alpha", "app-beta"]);
    const b = (await issue(c, OK)).json() as { sensor_id: string; token: string };
    expect(b.sensor_id).not.toBe(sensor_id);
    expect(b.token).not.toBe(token);
  });

  it("GET 列表回 metadata＋allowed_cidrs，無 hash／明文", async () => {
    await boot();
    const c = await admin();
    const { sensor_id, token } = (await issue(c, OK)).json() as { sensor_id: string; token: string };
    const hash = (await rowOf(sensor_id))!.token_hash;
    const res = await app.inject({ method: "GET", url: "/api/sensors/tokens", headers: cookieHeader(c) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain(token.split(".")[1]!);
    expect(res.body).not.toContain(hash);
    expect(res.body).not.toContain("token_hash");
    const items = (res.json() as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!).sort()).toEqual(["allowed_app_ids", "allowed_cidrs", "created_at", "revoked_at", "sensor_id"]);
    expect(items[0]!.allowed_cidrs).toEqual(["10.0.0.0/8"]);
    expect(items[0]!.allowed_app_ids).toEqual(["app-alpha"]);
  });

  it("缺 allowed_cidrs／空陣列／非陣列／非法 CIDR／帶 label／多欄位 → 400，且不建列", async () => {
    await boot();
    const c = await admin();
    const bad: unknown[] = [
      undefined, {}, { allowed_cidrs: [] }, { allowed_cidrs: "10.0.0.0/8" },
      { allowed_cidrs: ["not-a-cidr"] }, { allowed_cidrs: [123] }, { allowed_cidrs: ["0.0.0.0/0"] },
      { allowed_cidrs: ["10.0.0.0/4"] }, { allowed_cidrs: ["10.0.0.1/8"] }, { allowed_cidrs: ["::ffff:10.0.0.0/104"] },
      { allowed_cidrs: ["10.0.0.0/8", "bad"] },
      { allowed_cidrs: ["10.0.0.0/8"] }, { ...OK, allowed_app_ids: [] }, { ...OK, allowed_app_ids: "app-alpha" },
      { ...OK, allowed_app_ids: ["bad id!"] }, { ...OK, allowed_app_ids: [""] }, { ...OK, allowed_app_ids: [1] },
      { allowed_app_ids: ["app-alpha"] },
      { label: "edge-1" }, { ...OK, label: "edge-1" }, { ...OK, extra: 1 },
    ];
    for (const p of bad) expect((await issue(c, p)).statusCode, JSON.stringify(p)).toBe(400);
    const n = await app.db.query<{ n: string }>("SELECT count(*) AS n FROM sensor_tokens");
    expect(n.rows[0]!.n).toBe("0");
  });
});

describe("感測器 token 查找", () => {
  it("findSensorByToken：先依 sensor_id 取列再比對 secret；錯 secret／錯格式／已撤銷 → null", async () => {
    await boot();
    const c = await admin();
    const { sensor_id, token } = (await issue(c, OK)).json() as { sensor_id: string; token: string };
    const { findSensorByToken } = await import("@semantic-defense/sensor-auth");
    expect(await findSensorByToken(app.db, token)).toEqual({ sensor_id, allowed_cidrs: ["10.0.0.0/8"], allowed_app_ids: ["app-alpha"] });
    const secret = token.split(".")[1]!;
    const flipped = (secret[0] === "A" ? "B" : "A") + secret.slice(1);
    for (const t of [`sdst_${sensor_id}.${flipped}`, `sdst_${sensor_id}`, secret, "",
      `sdst_00000000-0000-4000-8000-000000000000.${secret}`, `${token}x`]) {
      expect(await findSensorByToken(app.db, t)).toBeNull();
    }
    await app.inject({ method: "POST", url: `/api/sensors/tokens/${sensor_id}/revoke`, headers: cookieHeader(c) });
    expect(await findSensorByToken(app.db, token)).toBeNull();
  });
});

describe("感測器 token 授權", () => {
  it("匿名 401；operator／app_owner 403（發放、列表、撤銷）", async () => {
    await boot();
    const { sensor_id } = (await issue(await admin(), OK)).json() as { sensor_id: string };
    const reqs = [
      { method: "POST" as const, url: "/api/sensors/tokens" },
      { method: "GET" as const, url: "/api/sensors/tokens" },
      { method: "POST" as const, url: `/api/sensors/tokens/${sensor_id}/revoke` },
      { method: "PATCH" as const, url: `/api/sensors/tokens/${sensor_id}/apps`, payload: { allowed_app_ids: ["x"] } },
      { method: "GET" as const, url: "/api/audit" },
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
    const { sensor_id, token } = (await issue(c, OK)).json() as { sensor_id: string; token: string };
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

describe("感測器 token 撤銷稽核", () => {
  type Audit = { action: string; actor: string; sensor_id: string | null; detail: Record<string, unknown> };
  const audits = async () =>
    (await app.db.query<Audit>("SELECT action, actor, sensor_id, detail FROM audit_events ORDER BY id")).rows;
  const revoke = (c: string, id: string) =>
    app.inject({ method: "POST", url: `/api/sensors/tokens/${id}/revoke`, headers: cookieHeader(c) });

  it("撤銷成功寫一筆 sensor_token.revoke（actor＝username、sensor_id 正確），detail／回應不含 token／secret／hash", async () => {
    await boot();
    const c = await admin();
    const { sensor_id, token } = (await issue(c, OK)).json() as { sensor_id: string; token: string };
    const r = await revoke(c, sensor_id);
    expect(r.statusCode).toBe(204);
    const rows = (await audits()).filter((x) => x.action === "sensor_token.revoke");
    expect(rows.map((x) => [x.action, x.actor, x.sensor_id])).toEqual([["sensor_token.revoke", "admin1", sensor_id]]);
    const hash = (await rowOf(sensor_id))!.token_hash;
    const res = await app.inject({ method: "GET", url: "/api/audit", headers: cookieHeader(c) });
    for (const s of [token, token.split(".")[1]!, hash, "token_hash"]) {
      expect(JSON.stringify(rows[0]!.detail)).not.toContain(s);
      expect(r.body).not.toContain(s);
      expect(res.body).not.toContain(s);
    }
  });

  it("不存在（404）、重複撤銷（仍 204）、非 platform_admin（403）都不寫 revoke 稽核", async () => {
    await boot();
    const c = await admin();
    const { sensor_id } = (await issue(c, OK)).json() as { sensor_id: string };
    expect((await revoke(c, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    for (const [u, p] of [["operator1", "pass-operator-1"], ["owner1", "pass-owner-1"]] as const) {
      expect((await revoke(await cookieFor(u, p), sensor_id)).statusCode).toBe(403);
    }
    expect((await audits()).filter((x) => x.action === "sensor_token.revoke")).toEqual([]);
    expect((await revoke(c, sensor_id)).statusCode).toBe(204);
    expect((await revoke(c, sensor_id)).statusCode).toBe(204);
    expect((await audits()).filter((x) => x.action === "sensor_token.revoke")).toHaveLength(1);
  });

  it("稽核寫入失敗 → 撤銷一併不生效（同一交易）", async () => {
    await boot();
    const c = await admin();
    const { sensor_id } = (await issue(c, OK)).json() as { sensor_id: string };
    await app.db.exec("ALTER TABLE audit_events ADD CONSTRAINT t_no_revoke CHECK (action <> 'sensor_token.revoke') NOT VALID");
    try {
      expect((await revoke(c, sensor_id)).statusCode).toBe(500);
    } finally {
      await app.db.exec("ALTER TABLE audit_events DROP CONSTRAINT t_no_revoke");
    }
    expect((await rowOf(sensor_id))!.revoked_at).toBeNull();
  });
});

describe("感測器 app 綁定修改與稽核", () => {
  const patch = (c: string, id: string, payload: unknown) =>
    app.inject({ method: "PATCH", url: `/api/sensors/tokens/${id}/apps`, headers: cookieHeader(c), payload: payload as object });

  it("PATCH /api/sensors/tokens/:id/apps：200 後列表可見；非法 → 400；不存在 → 404", async () => {
    await boot();
    const c = await admin();
    const { sensor_id } = (await issue(c, OK)).json() as { sensor_id: string };
    const r = await patch(c, sensor_id, { allowed_app_ids: ["app-alpha", "app-gamma"] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ sensor_id, allowed_app_ids: ["app-alpha", "app-gamma"] });
    const list = await app.inject({ method: "GET", url: "/api/sensors/tokens", headers: cookieHeader(c) });
    expect((list.json() as { items: { allowed_app_ids: string[] }[] }).items[0]!.allowed_app_ids).toEqual(["app-alpha", "app-gamma"]);
    for (const bad of [undefined, {}, { allowed_app_ids: [] }, { allowed_app_ids: ["bad id!"] }, { allowed_app_ids: ["a"], x: 1 }]) {
      expect((await patch(c, sensor_id, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(c, "00000000-0000-4000-8000-000000000000", { allowed_app_ids: ["a"] })).statusCode).toBe(404);
    expect((await patch(c, "not-a-uuid", { allowed_app_ids: ["a"] })).statusCode).toBe(404);
  });

  it("已撤銷的 sensor PATCH apps → 404（同未知 sensor）；allowed_app_ids 不變；不寫 update_apps 稽核", async () => {
    await boot();
    const c = await admin();
    const { sensor_id } = (await issue(c, OK)).json() as { sensor_id: string };
    expect((await app.inject({ method: "POST", url: `/api/sensors/tokens/${sensor_id}/revoke`, headers: cookieHeader(c) })).statusCode).toBe(204);
    const r = await patch(c, sensor_id, { allowed_app_ids: ["app-beta"] });
    const unknown = await patch(c, "00000000-0000-4000-8000-000000000000", { allowed_app_ids: ["app-beta"] });
    expect(r.statusCode).toBe(404);
    expect(r.body).toBe(unknown.body);
    const row = (await app.db.query<{ allowed_app_ids: string[] }>(
      "SELECT allowed_app_ids FROM sensor_tokens WHERE sensor_id = $1", [sensor_id])).rows[0]!;
    expect(row.allowed_app_ids).toEqual(["app-alpha"]);
    const n = await app.db.query<{ n: string }>("SELECT count(*) AS n FROM audit_events WHERE action = 'sensor_token.update_apps'");
    expect(n.rows[0]!.n).toBe("0");
  });

  it("發放與修改寫入稽核；GET /api/audit 可見且不含 token／secret／hash", async () => {
    await boot();
    const c = await admin();
    const { sensor_id, token } = (await issue(c, OK)).json() as { sensor_id: string; token: string };
    await patch(c, sensor_id, { allowed_app_ids: ["app-beta"] });
    await patch(c, sensor_id, { allowed_app_ids: [] });
    const hash = (await rowOf(sensor_id))!.token_hash;
    const res = await app.inject({ method: "GET", url: "/api/audit", headers: cookieHeader(c) });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: Record<string, unknown>[] }).items;
    expect(items.map((x) => [x.action, x.actor, x.sensor_id])).toEqual([
      ["sensor_token.issue", "admin1", sensor_id],
      ["sensor_token.update_apps", "admin1", sensor_id],
    ]);
    for (const x of items) expect(typeof x.at).toBe("number");
    expect(items[1]!.detail).toEqual({ allowed_app_ids: ["app-beta"] });
    for (const s of [token, token.split(".")[1]!, hash, "token_hash"]) expect(res.body).not.toContain(s);
  });
});
