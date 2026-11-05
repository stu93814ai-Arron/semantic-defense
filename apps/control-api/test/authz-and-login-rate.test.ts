import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { LOGIN_ERROR, login } from "./helpers/session.js";

/** 準則5：未授權 API 401/403；準則6：登入速率與不可枚舉。 */

let app: ControlApi;

afterEach(async () => {
  if (app) await app.close();
});

async function bootLimited(): Promise<ControlApi> {
  app = await buildApp({
    idleTimeoutMs: 60_000,
    loginRateLimit: { maxFailures: 5, windowMs: 60_000 },
  });
  await seedPhase2Fixtures(app);
  return app;
}

/** 同一 remoteAddress 連續失敗 5 次後第 6 次應 429，回傳 bodyText。 */
async function sixthFailureBody(
  username: string,
  remoteAddress: string,
): Promise<string> {
  await bootLimited();
  for (let i = 0; i < 5; i += 1) {
    const r = await login(app, { username, password: "bad" }, { remoteAddress });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.payload)).toContain(LOGIN_ERROR);
  }
  const limited = await login(app, { username, password: "bad" }, { remoteAddress });
  expect(limited.status).toBe(429);
  expect(JSON.stringify(limited.payload)).toContain(LOGIN_ERROR);
  expect(limited.bodyText).not.toMatch(/不存在|not found|unknown user/i);
  const body = limited.bodyText;
  await app.close();
  app = null as unknown as ControlApi;
  return body;
}

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

describe("準則6：登入訊息不可枚舉", () => {
  it("未知帳號與錯誤密碼回相同訊息與本文", async () => {
    app = await buildApp({
      idleTimeoutMs: 60_000,
      loginRateLimit: { maxFailures: 20, windowMs: 60_000 },
    });
    await seedPhase2Fixtures(app);
    const unknown = await login(app, { username: "no-such-user", password: "x" });
    const wrong = await login(app, {
      username: "operator1",
      password: "wrong-password",
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(unknown.payload)).toContain(LOGIN_ERROR);
    expect(JSON.stringify(wrong.payload)).toContain(LOGIN_ERROR);
    expect(JSON.stringify(unknown.payload)).toBe(JSON.stringify(wrong.payload));
    expect(unknown.bodyText).toBe(wrong.bodyText);
  });
});

describe("準則6：登入速率限制", () => {
  it("既有帳號連續失敗達上限回 429，訊息不枚舉", async () => {
    await bootLimited();
    for (let i = 0; i < 5; i += 1) {
      const r = await login(app, { username: "operator1", password: "bad" });
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.payload)).toContain(LOGIN_ERROR);
    }
    const limited = await login(app, { username: "operator1", password: "bad" });
    expect(limited.status).toBe(429);
    expect(JSON.stringify(limited.payload)).not.toMatch(/不存在|not found|unknown user/i);
  });

  it("不存在帳號同樣計入速率；429 本文與既有帳號相同", async () => {
    const addr = "203.0.113.10";
    const unknownBody = await sixthFailureBody("ghost-user-xyz", addr);
    const existingBody = await sixthFailureBody("operator1", addr);
    expect(unknownBody).toBe(existingBody);
  });

  it("速率鍵為 username+來源：不同 remoteAddress 分開計數", async () => {
    await bootLimited();
    const user = "operator1";
    const a = "198.51.100.1";
    const b = "198.51.100.2";

    for (let i = 0; i < 5; i += 1) {
      expect(
        (await login(app, { username: user, password: "bad" }, { remoteAddress: a })).status,
      ).toBe(401);
    }
    expect(
      (await login(app, { username: user, password: "bad" }, { remoteAddress: a })).status,
    ).toBe(429);

    const firstB = await login(app, { username: user, password: "bad" }, { remoteAddress: b });
    expect(firstB.status).toBe(401);
    expect(JSON.stringify(firstB.payload)).toContain(LOGIN_ERROR);

    for (let i = 0; i < 4; i += 1) {
      expect(
        (await login(app, { username: user, password: "bad" }, { remoteAddress: b })).status,
      ).toBe(401);
    }
    expect(
      (await login(app, { username: user, password: "bad" }, { remoteAddress: b })).status,
    ).toBe(429);
  });
});
