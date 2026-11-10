import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildIngest, openTestDb, seedToken } from "./helpers.js";

/**
 * 資安退回 B2 補：只加測試、不改 src，釘住 ts 的日期／時間驗證（contracts Rfc3339）。
 * 每筆用自己的測試時鐘：now 設在該 ts 附近（ts 落在保留期 7 天內、也不超前 5 分鐘），
 * 所以被拒只可能來自格式驗證（斷言 error 為「請求格式錯誤」而非 ts 上下限）；閏年 02-29 同理配一個 2028-02-29 的時鐘。
 */
let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

async function post(ts: string, nowIso: string) {
  const app = await buildIngest({ db, requireHttps: false, now: () => Date.parse(nowIso) });
  const t = await seedToken(db, ["10.0.0.0/8"]);
  const r = await app.inject({
    method: "POST", url: "/v1/flows", headers: { authorization: `Bearer ${t}` }, remoteAddress: "10.9.9.9",
    payload: { flow_id: randomUUID(), app_id: "app-1", ts, src_ip: "198.51.99.8", dst_ip: "10.0.0.3", src_port: 40001,
      dst_port: 443, protocol: "udp", bytes_in: 3, bytes_out: 4, packets: 2, duration_ms: 7 },
  });
  await app.close();
  return r;
}

describe("ts 日期／時間不存在 → 400 格式錯誤", () => {
  it.each([
    ["02-30", "2027-02-30T12:00:00Z", "2027-03-01T00:00:00Z"],
    ["04-31", "2027-04-31T12:00:00Z", "2027-05-01T00:00:00Z"],
    ["非閏年 02-29", "2027-02-29T12:00:00Z", "2027-03-01T00:00:00Z"],
    ["24:00:00", "2027-01-15T24:00:00Z", "2027-01-15T23:59:00Z"],
    ["秒數 :60", "2027-01-15T23:59:60Z", "2027-01-16T00:00:00Z"],
  ])("%s（%s）", async (_n, ts, now) => {
    const r = await post(ts, now);
    expect([r.statusCode, r.json<{ error: string }>().error]).toEqual([400, "請求格式錯誤"]);
  });

  it("閏年 02-29（2028-02-29T12:00:00Z，時鐘 2028-02-29T12:30:00Z）→ 201", async () => {
    expect((await post("2028-02-29T12:00:00Z", "2028-02-29T12:30:00Z")).statusCode).toBe(201);
  });
});
