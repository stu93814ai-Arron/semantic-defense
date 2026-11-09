import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildIngest, openTestDb, seedToken } from "./helpers.js";

/** 資安 R1：req.url 的 query（如 ?token=sdst_…）不得進 log；request log 與 5xx log 都只記 path。僅用假 token 字串。 */
let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

const SECRET = "fakeQuerySecretMarker0000000000000000000000";
const QS = `?token=sdst_aaaaaaaa-2222-4333-8444-55555555beef.${SECRET}&x=1`;
async function boot(lines: string[]) {
  return buildIngest({ db, requireHttps: false, now: () => 1_800_000_000_000,
    logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } } });
}
const urls = (lines: string[]) => lines.map((l) => JSON.parse(l) as { req?: { url?: string }; url?: string })
  .flatMap((x) => [x.req?.url, x.url]).filter((u): u is string => typeof u === "string");

describe("sensor-ingest log 不記 query", () => {
  it("401：?token=… 不進 log；request log 的 url 只有 path", async () => {
    const lines: string[] = [];
    const app = await boot(lines);
    const r = await app.inject({ method: "GET", url: `/v1/health${QS}`, remoteAddress: "10.1.2.3" });
    expect(r.statusCode).toBe(401);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain("token=");
    expect(urls(lines)).toContain("/v1/health");
    await app.close();
  });

  it("5xx：?token=… 不進 request log 與 error log", async () => {
    const lines: string[] = [];
    const app = await boot(lines);
    const token = await seedToken(db, ["10.0.0.0/8"]);
    await db.query("ALTER TABLE flow_events ADD CONSTRAINT t_qs_probe CHECK (bytes_in < 0) NOT VALID");
    const r = await app.inject({ method: "POST", url: `/v1/flows${QS}`, remoteAddress: "10.1.2.3",
      headers: { authorization: `Bearer ${token}` }, payload: { flow_id: randomUUID(), app_id: "app-1",
        ts: "2026-11-05T12:00:00Z", src_ip: "203.0.113.5", dst_ip: "10.0.0.1", src_port: 1, dst_port: 2, protocol: "tcp",
        bytes_in: 10, bytes_out: 20, packets: 3, duration_ms: 5 } });
    expect(r.statusCode).toBe(500);
    expect(lines.some((l) => (JSON.parse(l) as { level: number }).level >= 50)).toBe(true);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(urls(lines).every((u) => u === "/v1/flows")).toBe(true);
    await app.close();
  });
});
