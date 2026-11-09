import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

/** 資安 R1：req.url 的 query（如 ?token=sdst_…）不得進 log；request log 與 5xx log 都只記 path。僅用假 token 字串。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const SECRET = "fakeQuerySecretMarker1111111111111111111111";
const QS = `?token=sdst_aaaaaaaa-2222-4333-8444-55555555beef.${SECRET}&x=1`;
async function boot(lines: string[]): Promise<ControlApi> {
  app = await buildApp({
    idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(),
    logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } },
    beforeReady: (a) => { a.get("/api/__qs_boom", { config: { roles: "public" } }, async () => { throw new Error("boom"); }); },
  });
  return app;
}
const urls = (lines: string[]) => lines.map((l) => JSON.parse(l) as { req?: { url?: string }; url?: string })
  .flatMap((x) => [x.req?.url, x.url]).filter((u): u is string => typeof u === "string");

describe("control-api log 不記 query", () => {
  it("401：?token=… 不進 log；request log 的 url 只有 path", async () => {
    const lines: string[] = [];
    await boot(lines);
    const r = await app.inject({ method: "GET", url: `/api/thresholds${QS}` });
    expect(r.statusCode).toBe(401);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain("token=");
    expect(urls(lines)).toContain("/api/thresholds");
  });

  it("5xx：?token=… 不進 request log 與 error log", async () => {
    const lines: string[] = [];
    await boot(lines);
    const r = await app.inject({ method: "GET", url: `/api/__qs_boom${QS}` });
    expect(r.statusCode).toBe(500);
    expect(lines.some((l) => (JSON.parse(l) as { level: number }).level >= 50)).toBe(true);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(urls(lines).every((u) => u === "/api/__qs_boom")).toBe(true);
  });
});
