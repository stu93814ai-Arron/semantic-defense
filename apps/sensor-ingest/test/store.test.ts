import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildIngest } from "../src/app.js";
import { RETENTION_MS, ensureFlowSchema, purgeExpired } from "../src/store.js";
import { openTestDb, seedToken } from "./helpers.js";

let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

const IN = "10.1.2.3";
const T0 = 1_800_000_000_000;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const flow = (extra: Record<string, unknown> = {}) => ({
  flow_id: randomUUID(), app_id: "app-1", ts: "2026-11-05T12:00:00Z", src_ip: "203.0.113.5", dst_ip: "10.0.0.1",
  src_port: 51234, dst_port: 443, protocol: "tcp", bytes_in: 10, bytes_out: 20, packets: 3, duration_ms: 5, ...extra,
});
type Row = { flow_id: string; sensor_id: string; received_at: string; app_id: string };
const rows = () => db.query<Row>("SELECT flow_id, sensor_id, received_at, app_id FROM flow_events ORDER BY received_at");

async function setup(now: () => number = () => T0) {
  const app = await buildIngest({ db, requireHttps: false, now });
  const t = await seedToken(db, ["10.0.0.0/8"]);
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/v1/flows", headers: auth(t), remoteAddress: IN, payload: payload as object });
  return { app, t, sensorId: t.slice(5, 41), post };
}

describe("③c 存入 flow_events（單筆 body＝一個 FlowMetadataEvent）", () => {
  it("合法事件 → 201＋寫入，sensor_id 取自 token、received_at＝now", async () => {
    const { app, sensorId, post } = await setup();
    const f = flow();
    const r = await post(f);
    expect(r.statusCode).toBe(201);
    expect((await rows()).rows).toEqual([{ flow_id: f.flow_id, sensor_id: sensorId, received_at: String(T0), app_id: "app-1" }]);
    await app.close();
  });

  it("多欄（payload／url／headers）、缺欄、自報 sensor_id、陣列 → 400 且不寫入", async () => {
    const { app, post } = await setup();
    const missing: Record<string, unknown> = flow();
    delete missing.packets;
    for (const bad of [flow({ payload: "x" }), flow({ url: "/x" }), flow({ headers: {} }), missing, flow({ sensor_id: "x" }), [flow()], flow({ src_port: 70000 })]) {
      expect((await post(bad)).statusCode).toBe(400);
    }
    expect((await rows()).rows).toEqual([]);
    await app.close();
  });

  it("PK (sensor_id, flow_id)：不同 sensor 同 flow_id 皆 201；同 sensor 重複 → 409", async () => {
    const { app, sensorId, post } = await setup();
    const t2 = await seedToken(db, ["10.0.0.0/8"]);
    const f = flow();
    expect((await post(f)).statusCode).toBe(201);
    const r2 = await app.inject({ method: "POST", url: "/v1/flows", headers: auth(t2), remoteAddress: IN, payload: f });
    expect(r2.statusCode).toBe(201);
    expect((await post(f)).statusCode).toBe(409);
    expect((await rows()).rows.map((x) => x.sensor_id).sort()).toEqual([t2.slice(5, 41), sensorId].sort());
    await app.close();
  });

  it("token 撤銷後舊列保留且 sensor_id 不變；撤銷後新寫入 → 401", async () => {
    const { app, sensorId, post } = await setup();
    expect((await post(flow())).statusCode).toBe(201);
    await db.query("UPDATE sensor_tokens SET revoked_at = 1 WHERE sensor_id = $1", [sensorId]);
    expect((await post(flow())).statusCode).toBe(401);
    expect((await rows()).rows.map((x) => x.sensor_id)).toEqual([sensorId]);
    await app.close();
  });
});

describe("③c 7 天清除（年齡 ≥ 7d 刪）", () => {
  it("RETENTION_MS = 7 * 24 * 60 * 60 * 1000", () => {
    expect(RETENTION_MS).toBe(604_800_000);
  });

  it("剛好 7 天 → 刪；略少 → 留；略多 → 刪（purgeExpired 直接呼叫）", async () => {
    let now = T0;
    const { app, post } = await setup(() => now);
    const ids = new Map<string, string>();
    for (const [k, at] of [["more", T0 - 1], ["exact", T0], ["less", T0 + 1]] as const) {
      now = at; const f = flow(); ids.set(k, f.flow_id);
      expect((await post(f)).statusCode).toBe(201);
    }
    const deleted = await purgeExpired(db, T0 + RETENTION_MS);
    expect(deleted).toBe(2);
    expect((await rows()).rows.map((x) => x.flow_id)).toEqual([ids.get("less")]);
    await app.close();
  });

  it("寫入前自動清除過期列", async () => {
    let now = T0;
    const { app, post } = await setup(() => now);
    expect((await post(flow())).statusCode).toBe(201);
    now = T0 + RETENTION_MS;
    const f = flow();
    expect((await post(f)).statusCode).toBe(201);
    expect((await rows()).rows.map((x) => x.flow_id)).toEqual([f.flow_id]);
    await app.close();
  });

  it("flow_rejections：剛好 7 天 → 刪；略少 → 留；略多 → 刪（與 flow_events 同一 cutoff）", async () => {
    await ensureFlowSchema(db);
    const sid = "sensor-purge-rej";
    for (const at of [T0 - 1, T0, T0 + 1]) {
      await db.query("INSERT INTO flow_rejections (sensor_id, at) VALUES ($1,$2)", [sid, at]);
    }
    await purgeExpired(db, T0 + RETENTION_MS);
    const left = await db.query<{ at: string }>(
      "SELECT at FROM flow_rejections WHERE sensor_id = $1 ORDER BY at", [sid],
    );
    expect(left.rows.map((r) => Number(r.at))).toEqual([T0 + 1]);
  });
});
