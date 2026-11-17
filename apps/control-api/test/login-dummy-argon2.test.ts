import argon2 from "argon2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlApi } from "./helpers/app.js";
import { buildApp, seedPhase2Fixtures } from "./helpers/app.js";
import { LOGIN_ERROR, login } from "./helpers/session.js";

/**
 * 帳號正規化裁示第 8 點（A 組領航員裁示，未經使用者確認）：字元集不符的登入
 * 仍走 dummy argon2，時序與未知帳號相同。以 spy 計數 argon2.verify（呼叫原實作）。
 */
describe("登入失敗路徑仍執行 dummy argon2", () => {
  let app: ControlApi;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  async function verifyCallsFor(username: string): Promise<{ calls: number; bodyText: string }> {
    app = await buildApp({
      idleTimeoutMs: 60_000,
      loginRateLimit: { maxFailures: 20, windowMs: 60_000 },
    });
    await seedPhase2Fixtures(app);
    const spy = vi.spyOn(argon2, "verify");
    const r = await login(app, { username, password: "pass-operator-1" });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.payload)).toContain(LOGIN_ERROR);
    return { calls: spy.mock.calls.length, bodyText: r.bodyText };
  }

  it("字元集不符的名稱登入時 argon2.verify 恰呼叫一次", async () => {
    const bad = await verifyCallsFor("operator1!");
    expect(bad.calls).toBe(1);
  });

  it("對照：不存在的帳號登入時 argon2.verify 同樣恰呼叫一次，且回應相同", async () => {
    const unknown = await verifyCallsFor("no-such-user");
    expect(unknown.calls).toBe(1);
    await app.close();
    const bad = await verifyCallsFor("operator1!");
    expect(bad.bodyText).toBe(unknown.bodyText);
  });
});
