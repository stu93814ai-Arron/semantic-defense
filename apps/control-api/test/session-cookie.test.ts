import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";

/** 準則3：閒置逾時須重登；Cookie HttpOnly/Secure/SameSite=Strict。 */

let app: ControlApi;

afterEach(async () => {
  if (app) await app.close();
});

function setCookieHeaders(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return [raw];
  return [];
}

describe("準則3：工作階段 Cookie 與閒置逾時", () => {
  it("登入 Set-Cookie 含 HttpOnly、Secure、SameSite=Strict，名為 sd_session", async () => {
    app = await buildApp({ idleTimeoutMs: 60_000 });
    await seedPhase2Fixtures(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "operator1", password: "pass-operator-1" },
    });
    expect(res.statusCode).toBe(200);
    const cookies = setCookieHeaders(res);
    expect(cookies.length).toBeGreaterThan(0);
    const joined = cookies.join("\n");
    expect(joined).toMatch(/sd_session=/i);
    expect(joined.toLowerCase()).toContain("httponly");
    expect(joined.toLowerCase()).toContain("secure");
    expect(joined.toLowerCase()).toMatch(/samesite=strict/);
  });

  it("閒置逾時後 /api/session/me 與受保護 API 為 401", async () => {
    app = await buildApp({ idleTimeoutMs: 30 });
    await seedPhase2Fixtures(app);
    const r = await login(app, { username: "operator1", password: "pass-operator-1" });
    expect(r.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const me = await app.inject({
      method: "GET",
      url: "/api/session/me",
      headers: cookieHeader(r.cookie!),
    });
    expect(me.statusCode).toBe(401);
    const judgments = await app.inject({
      method: "GET",
      url: "/api/judgments",
      headers: cookieHeader(r.cookie!),
    });
    expect(judgments.statusCode).toBe(401);
  });
});
