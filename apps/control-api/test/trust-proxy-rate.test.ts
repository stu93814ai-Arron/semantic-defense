import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { login } from "./helpers/session.js";

/** 資安回歸：trustProxy 預設 false 時，偽造 X-Forwarded-For 不得開新速率桶。 */

let app: ControlApi;

afterEach(async () => {
  if (app) await app.close();
});

describe("trustProxy 預設關閉", () => {
  it("偽造 X-Forwarded-For 不能繞過登入 429", async () => {
    app = await buildApp({
      idleTimeoutMs: 60_000,
      loginRateLimit: { maxFailures: 5, windowMs: 60_000 },
      // 刻意不傳 trustProxy：預設 false
    });
    await seedPhase2Fixtures(app);

    const remoteAddress = "203.0.113.50";
    for (let i = 0; i < 5; i += 1) {
      const r = await login(
        app,
        { username: "operator1", password: "bad" },
        { remoteAddress },
      );
      expect(r.status).toBe(401);
    }
    const limited = await login(
      app,
      { username: "operator1", password: "bad" },
      { remoteAddress },
    );
    expect(limited.status).toBe(429);

    // 偽造新來源 IP；trustProxy=false 時 req.ip 仍為 remoteAddress，應繼續 429
    const spoofed = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "operator1", password: "bad" },
      remoteAddress,
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(spoofed.statusCode).toBe(429);
  });
});
