import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl, truncatePhase2Tables } from "./helpers/pg.js";
import { cookieHeader, login } from "./helpers/session.js";

/**
 * 準則：使用者／角色／應用指派／session 須落在可共用的 Postgres。
 * close + 同一 databaseUrl 再 buildApp 後，資料與 cookie session 仍有效。
 * 不得依賴單一 PGlite 程序內記憶體生命週期。
 */

let databaseUrl: string;
let app: ControlApi | undefined;

beforeAll(() => {
  databaseUrl = requireDatabaseUrl();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe("持久化：同一 DATABASE_URL 上 close 後重建", () => {
  it("重建後種子帳號仍可登入，且舊 session cookie 仍可通過 /api/session/me", async () => {
    app = await buildApp({ databaseUrl, idleTimeoutMs: 60_000 });
    await truncatePhase2Tables(app.db);
    await seedPhase2Fixtures(app);

    const first = await login(app, {
      username: "owner1",
      password: "pass-owner-1",
    });
    expect(first.status).toBe(200);
    expect(first.cookie).toBeTruthy();

    const meBefore = await app.inject({
      method: "GET",
      url: "/api/session/me",
      headers: cookieHeader(first.cookie!),
    });
    expect(meBefore.statusCode).toBe(200);
    expect(meBefore.json()).toMatchObject({
      username: "owner1",
      role: "app_owner",
    });

    await app.close();
    app = undefined;

    // 同一 DB、新進程視角的 buildApp（實作須接 databaseUrl，非拋棄式記憶體庫）
    app = await buildApp({ databaseUrl, idleTimeoutMs: 60_000 });

    const meAfter = await app.inject({
      method: "GET",
      url: "/api/session/me",
      headers: cookieHeader(first.cookie!),
    });
    expect(meAfter.statusCode).toBe(200);
    expect(meAfter.json()).toMatchObject({
      username: "owner1",
      role: "app_owner",
    });

    const again = await login(app, {
      username: "owner1",
      password: "pass-owner-1",
    });
    expect(again.status).toBe(200);

    const owned = await app.inject({
      method: "GET",
      url: "/api/apps/app-alpha",
      headers: cookieHeader(again.cookie!),
    });
    expect(owned.statusCode).toBe(200);
  });
});
