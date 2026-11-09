import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { safeErr } from "../src/errors.js";
import { buildIngest, openTestDb, seedToken } from "./helpers.js";

/** sensor-ingest 5xx：固定 body、不外洩 DB 原文；錯誤寫 log，log 不含 body 或 Authorization。 */
let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

const T0 = 1_800_000_000_000;
const flow = () => ({
  flow_id: randomUUID(), app_id: "app-1", ts: "2027-01-15T07:00:00Z", src_ip: "203.0.113.5", dst_ip: "10.0.0.1",
  src_port: 51234, dst_port: 443, protocol: "tcp", bytes_in: 10, bytes_out: 20, packets: 3, duration_ms: 5,
});

describe("sensor-ingest 5xx 錯誤處理", () => {
  it("DB 錯誤觸發的 500：body 固定、不含原文／約束名／表名；寫 error log；log 不含 token 與 body", async () => {
    const lines: string[] = [];
    const app = await buildIngest({ db, requireHttps: false, now: () => T0,
      logger: { level: "info", stream: { write: (l: string) => { lines.push(l); } } } });
    const token = await seedToken(db, ["10.0.0.0/8"]);
    await db.query("ALTER TABLE flow_events ADD CONSTRAINT t_leak_probe CHECK (bytes_in < 0) NOT VALID");
    const f = flow();
    const r = await app.inject({ method: "POST", url: "/v1/flows", remoteAddress: "10.1.2.3",
      headers: { authorization: `Bearer ${token}` }, payload: f });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: "伺服器錯誤" });
    for (const leak of ["t_leak_probe", "flow_events", "violates", "constraint", "23514"]) expect(r.body).not.toContain(leak);
    const errs = lines.map((l) => JSON.parse(l) as { level: number; err?: Record<string, unknown> }).filter((x) => x.level >= 50);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.err).toMatchObject({ code: "23514", constraint: "t_leak_probe" });
    const all = lines.join("\n");
    expect(all).not.toContain(token.split(".")[1]!);
    expect(all).not.toContain(String(f.flow_id));
    await app.close();
  });

  it("safeErr：pg 錯誤只留 code／table／constraint／column，不留 message／detail／stack（可能含請求值）", () => {
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "req-value-abc"'), {
      severity: "ERROR", code: "22P02", detail: "Failing row contains (req-value-abc)", table: "flow_events", constraint: undefined, column: "flow_id",
    });
    const out = JSON.stringify(safeErr(pgErr));
    expect(out).not.toContain("req-value-abc");
    expect(safeErr(pgErr)).toMatchObject({ code: "22P02", table: "flow_events", column: "flow_id" });
    const plain = safeErr(new Error("boom"));
    expect(plain).toMatchObject({ name: "Error", message: "boom" });
  });
});
