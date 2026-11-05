import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";

/**
 * 授權契約：
 * - 已掛路由皆須明確 roles（含 public）
 * - 已掛但缺 roles → fail closed（401／403）
 * - 未掛路徑 → 404（preHandler 見 is404 即放行 notFoundHandler）
 */

let app: ControlApi | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

function rolesNonEmpty(roles: unknown): boolean {
  if (roles === "public" || roles === "any") return true;
  return Array.isArray(roles) && roles.length > 0;
}

describe("授權：已掛路由 roles 與 fail-closed", () => {
  it("onRoute 稽核：所有已掛路由皆有非空 roles（公開為 roles:\"public\"）", async () => {
    app = await buildApp({ idleTimeoutMs: 60_000 });
    const audit = app.authRouteAudit;
    expect(audit.length).toBeGreaterThan(0);
    for (const route of audit) {
      expect(
        rolesNonEmpty(route.roles),
        `${route.method} ${route.url} 缺少非空 roles`,
      ).toBe(true);
    }
    expect(audit.some((r) => r.roles === "public")).toBe(true);
  });

  it("臨時掛無 roles 路由：未登入 401、已登入 403", async () => {
    app = await buildApp({
      idleTimeoutMs: 60_000,
      beforeReady: (a) => {
        a.get("/api/__probe_no_roles", async () => ({ ok: true }));
      },
    });
    await seedPhase2Fixtures(app);

    const anon = await app.inject({ method: "GET", url: "/api/__probe_no_roles" });
    expect(anon.statusCode).toBe(401);

    const r = await login(app, {
      username: "operator1",
      password: "pass-operator-1",
    });
    expect(r.status).toBe(200);
    const authed = await app.inject({
      method: "GET",
      url: "/api/__probe_no_roles",
      headers: cookieHeader(r.cookie!),
    });
    expect(authed.statusCode).toBe(403);
  });

  it("未宣告路徑仍 404（不論是否登入）", async () => {
    app = await buildApp({ idleTimeoutMs: 60_000 });
    await seedPhase2Fixtures(app);
    const anon = await app.inject({ method: "GET", url: "/definitely-not-mounted" });
    expect(anon.statusCode).toBe(404);

    const r = await login(app, {
      username: "operator1",
      password: "pass-operator-1",
    });
    expect(r.status).toBe(200);
    const authed = await app.inject({
      method: "GET",
      url: "/definitely-not-mounted",
      headers: cookieHeader(r.cookie!),
    });
    expect(authed.statusCode).toBe(404);
  });
});
