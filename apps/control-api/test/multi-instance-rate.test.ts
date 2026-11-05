import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl, truncatePhase2Tables } from "./helpers/pg.js";
import { LOGIN_ERROR, login } from "./helpers/session.js";

/**
 * LoginLimiter 計數須跨實例共用（同一 databaseUrl 上的兩個 buildApp）。
 * 3 + 2 次失敗後，第 6 次（任一侧）須 429，本文與單實例上限相同。
 */

let databaseUrl: string;
const apps: ControlApi[] = [];

beforeAll(() => {
  databaseUrl = requireDatabaseUrl();
});

afterEach(async () => {
  while (apps.length > 0) {
    const a = apps.pop();
    if (a) await a.close();
  }
});

const RATE = { maxFailures: 5, windowMs: 60_000 } as const;
const IP = "198.51.100.40";
const USER = "operator1";

async function boot(): Promise<ControlApi> {
  const a = await buildApp({
    databaseUrl,
    idleTimeoutMs: 60_000,
    loginRateLimit: RATE,
  });
  apps.push(a);
  return a;
}

describe("多實例：登入失敗計數共用", () => {
  it("實例 A 失敗 3 次、實例 B 失敗 2 次後，第 6 次 429 且本文一致", async () => {
    const a = await boot();
    await truncatePhase2Tables(a.db);
    await seedPhase2Fixtures(a);
    const b = await boot();

    for (let i = 0; i < 3; i += 1) {
      const r = await login(a, { username: USER, password: "bad" }, { remoteAddress: IP });
      expect(r.status).toBe(401);
    }
    for (let i = 0; i < 2; i += 1) {
      const r = await login(b, { username: USER, password: "bad" }, { remoteAddress: IP });
      expect(r.status).toBe(401);
    }

    const sixthOnA = await login(
      a,
      { username: USER, password: "bad" },
      { remoteAddress: IP },
    );
    expect(sixthOnA.status).toBe(429);
    expect(JSON.stringify(sixthOnA.payload)).toContain(LOGIN_ERROR);
    expect(sixthOnA.bodyText).not.toMatch(/不存在|not found|unknown user/i);

    const sixthOnB = await login(
      b,
      { username: USER, password: "bad" },
      { remoteAddress: IP },
    );
    expect(sixthOnB.status).toBe(429);
    expect(sixthOnB.bodyText).toBe(sixthOnA.bodyText);
  });
});
