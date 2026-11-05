import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { LOGIN_ERROR, login } from "./helpers/session.js";

/** 準則5：未授權 API 401/403；準則6：登入速率與不可枚舉。 */

let app: ControlApi;

afterEach(async () => {
  if (app) await app.close();
});

describe("準則5：未授權 API", () => {
  it("未帶 Cookie 打受保護 API 為 401", async () => {
    app = await buildApp({ idleTimeoutMs: 60_000 });
    await seedPhase2Fixtures(app);
    for (const url of [
      "/api/session/me",
      "/api/judgments",
      "/api/admin/users",
      "/api/apps/app-alpha",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("準則6：登入失敗速率與訊息", () => {
  it("未知帳號與錯誤密碼回相同訊息", async () => {
    app = await buildApp({
      idleTimeoutMs: 60_000,
      loginRateLimit: { maxFailures: 20, windowMs: 60_000 },
    });
    await seedPhase2Fixtures(app);
    const unknown = await login(app, {
      username: "no-such-user",
      password: "x",
    });
    const wrong = await login(app, {
      username: "operator1",
      password: "wrong-password",
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const uMsg = JSON.stringify(unknown.payload);
    const wMsg = JSON.stringify(wrong.payload);
    expect(uMsg).toContain(LOGIN_ERROR);
    expect(wMsg).toContain(LOGIN_ERROR);
    expect(uMsg).toBe(wMsg);
  });

  it("連續失敗達上限回 429，訊息仍不枚舉帳號", async () => {
    app = await buildApp({
      idleTimeoutMs: 60_000,
      loginRateLimit: { maxFailures: 5, windowMs: 60_000 },
    });
    await seedPhase2Fixtures(app);
    for (let i = 0; i < 5; i += 1) {
      const r = await login(app, { username: "operator1", password: "bad" });
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.payload)).toContain(LOGIN_ERROR);
    }
    const limited = await login(app, { username: "operator1", password: "bad" });
    expect(limited.status).toBe(429);
    const body = JSON.stringify(limited.payload);
    expect(body).not.toMatch(/不存在|not found|unknown user/i);
    expect(body).not.toContain("operator1 存在");
  });
});
