import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";

/**
 * 滑動閒置：活動須刷新 last_seen。
 * 時鐘由 buildApp({ now }) 注入（勿依賴真實 sleep），以便決定性驗證延長與逾時。
 */

let app: ControlApi | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe("滑動閒置逾時（注入 now）", () => {
  it("活動延長閒置窗；超過 idleTimeoutMs 無活動後 /me 為 401", async () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const idleTimeoutMs = 100;

    app = await buildApp({ idleTimeoutMs, now });
    await seedPhase2Fixtures(app);

    const r = await login(app, {
      username: "operator1",
      password: "pass-operator-1",
    });
    expect(r.status).toBe(200);

    clock += 40;
    const mid = await app.inject({
      method: "GET",
      url: "/api/session/me",
      headers: cookieHeader(r.cookie!),
    });
    expect(mid.statusCode).toBe(200);

    clock += 40;
    const still = await app.inject({
      method: "GET",
      url: "/api/session/me",
      headers: cookieHeader(r.cookie!),
    });
    expect(still.statusCode).toBe(200);

    clock += idleTimeoutMs + 1;
    const expired = await app.inject({
      method: "GET",
      url: "/api/session/me",
      headers: cookieHeader(r.cookie!),
    });
    expect(expired.statusCode).toBe(401);

    const judgments = await app.inject({
      method: "GET",
      url: "/api/judgments",
      headers: cookieHeader(r.cookie!),
    });
    expect(judgments.statusCode).toBe(401);
  });
});
