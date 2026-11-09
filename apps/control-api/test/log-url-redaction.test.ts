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

describe("control-api err serializer 去掉 query（資安殘留：reply-already-sent 的 err.message 帶完整 url）", () => {
  it("重複回應：?token=… 不進 log（含 err.message／stack）", async () => {
    const lines: string[] = [];
    app = await buildApp({
      idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(),
      logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } },
      beforeReady: (a) => { a.get("/api/__qs_twice", { config: { roles: "public" } }, async (_req, reply) => {
        await reply.send({ ok: 1 });
        return { ok: 2 };
      }); },
    });
    const r = await app.inject({ method: "GET", url: `/api/__qs_twice${QS}` });
    expect(r.statusCode).toBe(200);
    const errs = lines.filter((l) => l.includes("FST_ERR_REP_ALREADY_SENT"));
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs.join("\n")).toContain("/api/__qs_twice");
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain("token=");
  });
});

describe("control-api logMethod 處理直接傳 Error（A 組領航員修正 3）", () => {
  it("log.error(new Error(\"…/p?token=S\")) 與帶字串 msg 的寫法 → log 不含 S，path 仍在", async () => {
    const lines: string[] = [];
    app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(),
      logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } } });
    app.log.error(new Error(`fail at /p${QS}`));
    app.log.error(new Error(`fail at /q${QS}`), `while GET /q${QS}`);
    const out = lines.join("\n");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("token=");
    expect(out).toContain("fail at /p");
    expect(out).toContain("while GET /q");
  });
});

describe("control-api noQuery 遇到引號不中斷（資安退回 R1）", () => {
  it("/p?a\"b&token=SECRET：err.message、msg、stack 都不含 SECRET", async () => {
    const lines: string[] = [];
    app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(),
      logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } } });
    const e = new Error(`fail at /p?a"b&token=${SECRET}`);
    app.log.error(e);
    app.log.error({ err: e }, `while GET /p?a"b&token=${SECRET}`);
    type Rec = { msg?: string; err?: { message?: string; stack?: string } };
    const recs = lines.map((l) => JSON.parse(l) as Rec);
    const fields = recs.flatMap((r) => [r.msg, r.err?.message, r.err?.stack]);
    expect(fields.filter((f) => typeof f !== "string" || f.includes(SECRET))).toEqual([]);
    expect(recs.map((r) => r.msg)).toEqual(["fail at /p", "while GET /p"]);
  });

  it("path 內有未編碼的引號（/p\"x?token=SECRET）：err.message、msg、stack 都不含 SECRET", async () => {
    const lines: string[] = [];
    app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(),
      logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } } });
    const url = `/p"x?token=${SECRET}`;
    app.log.error(new Error(`fail at ${url}`));
    app.log.error({ err: new Error(`fail at ${url}`) }, `while GET ${url}`);
    const recs = lines.map((l) => JSON.parse(l) as { msg?: string; err?: { message?: string; stack?: string } });
    expect(recs.flatMap((r) => [r.msg, r.err?.message, r.err?.stack]).filter((f) => typeof f !== "string" || f.includes(SECRET))).toEqual([]);
    expect(recs.map((r) => r.msg)).toEqual(['fail at /p"x', 'while GET /p"x']);
  });

  it("asterisk-form（OPTIONS *?token=SECRET）：err.message、msg、stack 都不含 SECRET（R7）", async () => {
    const lines: string[] = [];
    app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(),
      logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } } });
    app.log.error(new Error(`bad target *?token=${SECRET}`));
    app.log.error({ err: new Error(`bad target *?token=${SECRET}`) }, `while OPTIONS *?token=${SECRET}`);
    const recs = lines.map((l) => JSON.parse(l) as { msg?: string; err?: { message?: string; stack?: string } });
    expect(recs.flatMap((r) => [r.msg, r.err?.message, r.err?.stack]).filter((f) => typeof f !== "string" || f.includes(SECRET))).toEqual([]);
    expect(recs.map((r) => r.msg)).toEqual(["bad target *", "while OPTIONS *"]);
  });
});
