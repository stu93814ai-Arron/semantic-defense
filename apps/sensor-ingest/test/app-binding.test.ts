import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildIngest, openTestDb, seedToken } from "./helpers.js";

let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

const T0 = 1_800_000_000_000;
const flow = (app_id: string) => ({
  flow_id: randomUUID(), app_id, ts: "2027-01-15T07:00:00Z", src_ip: "64.0.113.5", dst_ip: "10.0.0.1",
  src_port: 51234, dst_port: 443, protocol: "tcp", bytes_in: 10, bytes_out: 20, packets: 3, duration_ms: 5,
});

async function setup(apps: string[]) {
  const app = await buildIngest({ db, requireHttps: false, now: () => T0 });
  const t = await seedToken(db, ["10.0.0.0/8"], false, apps);
  const post = (payload: object) => app.inject({ method: "POST", url: "/v1/flows",
    headers: { authorization: `Bearer ${t}` }, remoteAddress: "10.1.2.3", payload });
  return { app, sensorId: t.slice(5, 41), post };
}
const count = async (table: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

describe("allowed_app_ids 綁定", () => {
  it("app_id 不在綁定清單 → 403、不入 flow_events；只記 sensor_id＋時間", async () => {
    const { app, sensorId, post } = await setup(["app-1"]);
    const f = flow("app-other");
    const r = await post(f);
    expect(r.statusCode).toBe(403);
    expect(await count("flow_events")).toBe(0);
    const rej = await db.query<Record<string, unknown>>("SELECT * FROM flow_rejections");
    expect(rej.rows).toEqual([{ id: "1", sensor_id: sensorId, at: String(T0) }]);
    expect(JSON.stringify(rej.rows)).not.toContain(f.flow_id);
    await app.close();
  });

  it("綁 2 個 app：兩者皆 201 入庫", async () => {
    const { app, post } = await setup(["app-1", "app-2"]);
    expect((await post(flow("app-1"))).statusCode).toBe(201);
    expect((await post(flow("app-2"))).statusCode).toBe(201);
    expect(await count("flow_events")).toBe(2);
    await app.close();
  });
});
