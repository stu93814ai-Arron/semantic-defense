/* eslint-disable security/detect-non-literal-fs-filename -- 測試：路徑來自暫存目錄與本套件 src 走訪，非外部輸入 */
import { request } from "node:https";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildIngest } from "../src/app.js";
import { openTestDb, seedToken, selfSignedCert } from "./helpers.js";

let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const IN = "10.1.2.3";

describe("sensor-ingest ③b 認證（requireHttps:false 以 inject 驗認證邏輯）", () => {
  it("無／錯格式／錯 secret／已撤銷 token → 401", async () => {
    const app = await buildIngest({ db, requireHttps: false });
    const good = await seedToken(db, ["10.0.0.0/8"]);
    const revoked = await seedToken(db, ["10.0.0.0/8"], true);
    const wrong = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    for (const headers of [{}, auth("nope"), auth(wrong), auth(revoked), { authorization: good }]) {
      const r = await app.inject({ method: "GET", url: "/v1/health", headers, remoteAddress: IN });
      expect(r.statusCode).toBe(401);
    }
    await app.close();
  });

  it("token 有效但來源 IP 不在 allowed_cidrs → 403；在內 → 200", async () => {
    const app = await buildIngest({ db, requireHttps: false });
    const t = await seedToken(db, ["10.0.0.0/8"]);
    const out = await app.inject({ method: "GET", url: "/v1/health", headers: auth(t), remoteAddress: "192.168.1.1" });
    expect(out.statusCode).toBe(403);
    const ok = await app.inject({ method: "GET", url: "/v1/health", headers: auth(t), remoteAddress: IN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, sensor_id: t.slice(5, 41) });
    await app.close();
  });

  it("X-Forwarded-For 不影響來源 IP 判定（不信任 proxy）", async () => {
    const app = await buildIngest({ db, requireHttps: false });
    const t = await seedToken(db, ["10.0.0.0/8"]);
    const r = await app.inject({ method: "GET", url: "/v1/health", headers: { ...auth(t), "x-forwarded-for": IN }, remoteAddress: "192.168.1.1" });
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  it("POST /v1/flows：payload 自報 sensor_id → 400；未自報 → 501（存入屬 ③c）", async () => {
    const app = await buildIngest({ db, requireHttps: false });
    const t = await seedToken(db, ["10.0.0.0/8"]);
    const bad = await app.inject({ method: "POST", url: "/v1/flows", headers: auth(t), remoteAddress: IN, payload: { sensor_id: "x", flows: [] } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/v1/flows", headers: auth(t), remoteAddress: IN, payload: { flows: [] } });
    expect(ok.statusCode).toBe(501);
    const noAuth = await app.inject({ method: "POST", url: "/v1/flows", remoteAddress: IN, payload: { sensor_id: "x" } });
    expect(noAuth.statusCode).toBe(401);
    await app.close();
  });

  it("未宣告路徑（含 /api、/login 探測）→ 404，不論有無 token", async () => {
    const app = await buildIngest({ db, requireHttps: false });
    const t = await seedToken(db, ["10.0.0.0/8"]);
    for (const url of ["/", "/api/session/login", "/api/sensors/tokens", "/login", "/v1/nope", "/v1/health/x"]) {
      for (const headers of [{}, auth(t)]) {
        const r = await app.inject({ method: "GET", url, headers, remoteAddress: IN });
        expect(r.statusCode, url).toBe(404);
      }
    }
    const r = await app.inject({ method: "POST", url: "/login", payload: {}, remoteAddress: IN });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("不發 session cookie", async () => {
    const app = await buildIngest({ db, requireHttps: false });
    const t = await seedToken(db, ["10.0.0.0/8"]);
    const r = await app.inject({ method: "GET", url: "/v1/health", headers: auth(t), remoteAddress: IN });
    expect(r.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });
});

describe("sensor-ingest ③b HTTPS 強制（預設 requireHttps:true）", () => {
  it("明文 HTTP（含偽造 x-forwarded-proto: https）→ 426", async () => {
    const app = await buildIngest({ db });
    const t = await seedToken(db, ["10.0.0.0/8"]);
    for (const extra of [{}, { "x-forwarded-proto": "https" }]) {
      const r = await app.inject({ method: "GET", url: "/v1/health", headers: { ...auth(t), ...extra }, remoteAddress: IN });
      expect(r.statusCode).toBe(426);
    }
    await app.close();
  });

  it("TLS 連線＋有效 token＋IP 在 allowlist → 200", async () => {
    const tls = selfSignedCert();
    const app = await buildIngest({ db, https: tls });
    const t = await seedToken(db, ["127.0.0.0/8"]);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const status = await new Promise<number>((ok, ko) => {
      const req = request({ host: "127.0.0.1", port, path: "/v1/health", ca: tls.cert, servername: "localhost", headers: auth(t) },
        (res) => { res.resume(); ok(res.statusCode ?? 0); });
      req.on("error", ko); req.end();
    });
    expect(status).toBe(200);
    await app.close();
  });
});

describe("boundaries：src 不含 /api、/login 路由字串", () => {
  it("靜態掃描", () => {
    const src = join(import.meta.dirname, "../src");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
    for (const f of walk(src)) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/['"`]\/(?:api|login)(?=[/'"`?:]|$)/m);
    }
  });
});
