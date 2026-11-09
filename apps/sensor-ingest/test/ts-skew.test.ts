import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RETENTION_MS } from "@semantic-defense/flow-store/write";
import { buildIngest, openTestDb, seedToken } from "./helpers.js";

/** 成案流程 Q3：ts 超前收到時間 >5 分鐘 → 400 拒收（不入庫、不寫 flow_rejections）；剛好 5 分鐘仍收；遲到照存。 */
let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

async function setup() {
  const app = await buildIngest({ db, requireHttps: false, now: () => NOW });
  const t = await seedToken(db, ["10.0.0.0/8"]);
  const send = (ts: string, app_id = "app-1") => app.inject({
    method: "POST", url: "/v1/flows", headers: { authorization: `Bearer ${t}` }, remoteAddress: "10.9.9.9",
    payload: { flow_id: randomUUID(), app_id, ts, src_ip: "198.51.100.7", dst_ip: "10.0.0.2", src_port: 40000,
      dst_port: 8443, protocol: "tcp", bytes_in: 1, bytes_out: 2, packets: 1, duration_ms: 1 },
  });
  return { app, send };
}
const n = async (table: string) => Number((await db.query<{ c: string }>(`SELECT count(*) AS c FROM ${table}`)).rows[0]!.c);

describe("ts 超前拒收", () => {
  it("ts = now+5m+1ms → 400 {error:'ts 超前接收時間'}，不入 flow_events、不寫 flow_rejections", async () => {
    const { app, send } = await setup();
    const r = await send(at(NOW + 5 * MIN + 1));
    expect([r.statusCode, r.json()]).toEqual([400, { error: "ts 超前接收時間" }]);
    expect([await n("flow_events"), await n("flow_rejections")]).toEqual([0, 0]);
    await app.close();
  });

  it("ts = now+5m（剛好）→ 201；ts = now−6m（遲到）→ 201 照存", async () => {
    const { app, send } = await setup();
    expect((await send(at(NOW + 5 * MIN))).statusCode).toBe(201);
    expect((await send(at(NOW - 6 * MIN))).statusCode).toBe(201);
    expect(await n("flow_events")).toBe(2);
    await app.close();
  });

  it("帶時區偏移的 ts 以絕對時間比較：+08:00 寫法超前 5m+1s → 400", async () => {
    const { app, send } = await setup();
    const local = new Date(NOW + 5 * MIN + 1000 + 8 * 60 * MIN).toISOString().replace("Z", "+08:00");
    expect((await send(local)).statusCode).toBe(400);
    await app.close();
  });

  it("順序（A 裁定）：超前又 app_id 未綁定 → 400（先於綁定 403），不寫 flow_rejections", async () => {
    const { app, send } = await setup();
    const r = await send(at(NOW + 10 * MIN), "app-unbound");
    expect([r.statusCode, r.json()]).toEqual([400, { error: "ts 超前接收時間" }]);
    expect(await n("flow_rejections")).toBe(0);
    await app.close();
  });
});

describe("ts 下限：早於 now − RETENTION_MS（7 天）→ 400（資安退回 B2）", () => {
  const OLD = { error: "ts 早於保留期限" };
  it("剛好 now−7d → 201（與超前的比較一致：差值 > 上限才拒，等於上限照收）", async () => {
    const { app, send } = await setup();
    expect((await send(at(NOW - RETENTION_MS))).statusCode).toBe(201);
    await app.close();
  });

  it("now−7d−1ms 與 0000-01-01T00:00:00Z → 400，不入 flow_events、不寫 flow_rejections", async () => {
    const { app, send } = await setup();
    for (const ts of [at(NOW - RETENTION_MS - 1), "0000-01-01T00:00:00Z"]) {
      const r = await send(ts);
      expect([r.statusCode, r.json()], ts).toEqual([400, OLD]);
    }
    expect([await n("flow_events"), await n("flow_rejections")]).toEqual([0, 0]);
    await app.close();
  });

  it("順序：太舊又 app_id 未綁定 → 400（與超前同一處，先於綁定 403），不寫 flow_rejections", async () => {
    const { app, send } = await setup();
    const r = await send("0000-01-01T00:00:00Z", "app-unbound");
    expect([r.statusCode, r.json()]).toEqual([400, OLD]);
    expect(await n("flow_rejections")).toBe(0);
    await app.close();
  });
});
