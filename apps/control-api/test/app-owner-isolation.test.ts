import { afterEach, describe, expect, it } from "vitest";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { cookieHeader, login } from "./helpers/session.js";

/** 準則2：app_owner 換別人的 appId，API 看不到。 */

let app: ControlApi;

afterEach(async () => {
  if (app) await app.close();
});

describe("準則2：應用負責人跨應用隔離", () => {
  it("owner1 讀 app-beta 為 403 或 404，且本文不含 beta 內容", async () => {
    app = await buildApp({ idleTimeoutMs: 60_000 });
    await seedPhase2Fixtures(app);
    const r = await login(app, { username: "owner1", password: "pass-owner-1" });
    expect(r.status).toBe(200);
    const headers = cookieHeader(r.cookie!);

    for (const url of ["/api/apps/app-beta", "/api/apps/app-beta/map"]) {
      const res = await app.inject({ method: "GET", url, headers });
      expect([403, 404]).toContain(res.statusCode);
      const body = res.body ?? "";
      expect(body.toLowerCase()).not.toContain("app-beta-secret");
    }

    const own = await app.inject({
      method: "GET",
      url: "/api/apps/app-alpha",
      headers,
    });
    expect(own.statusCode).toBe(200);
  });
});
