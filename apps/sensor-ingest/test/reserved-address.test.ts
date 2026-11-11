import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REJECTION_COUNT_WINDOW_MS } from "@semantic-defense/flow-store/write";
import { buildIngest, openTestDb, seedToken } from "./helpers.js";

/** A 組領航員裁示（未經使用者確認）；落在總召 §21:09 R10 範圍內。 */
let db: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => { db = await openTestDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

const T0 = 1_800_000_000_000;
const ERR = { error: "位址為保留或文件範圍" };
const base = {
  app_id: "app-1", ts: "2027-01-15T07:00:00Z", src_port: 51234, dst_port: 443,
  protocol: "tcp", bytes_in: 10, bytes_out: 20, packets: 3, duration_ms: 5,
};
const flow = (over: Record<string, unknown> = {}) => ({ flow_id: randomUUID(), src_ip: "64.0.113.5", dst_ip: "10.0.0.1", ...base, ...over });

async function setup(opts: { apps?: string[]; now?: () => number; lines?: string[] } = {}) {
  const logger = opts.lines
    ? { level: "info" as const, stream: { write: (l: string) => { opts.lines!.push(l); } } }
    : false;
  const app = await buildIngest({ db, requireHttps: false, now: opts.now ?? (() => T0), logger });
  const t = await seedToken(db, ["10.0.0.0/8"], false, opts.apps ?? ["app-1"]);
  const post = (payload: object, extra?: { auth?: boolean; remoteAddress?: string }) =>
    app.inject({
      method: "POST", url: "/v1/flows", payload,
      headers: extra?.auth === false ? {} : { authorization: `Bearer ${t}` },
      remoteAddress: extra?.remoteAddress ?? "10.1.2.3",
    });
  const health = () => app.inject({ method: "GET", url: "/v1/health",
    headers: { authorization: `Bearer ${t}` }, remoteAddress: "10.1.2.3" });
  return { app, sensorId: t.slice(5, 41), post, health };
}
const n = async (table: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

describe("R10 ingest 拒收保留／文件範圍位址", () => {
  const REJECTED = [
    ["src loopback", { src_ip: "127.0.0.1" }],
    ["dst loopback v6", { dst_ip: "::1" }],
    ["src link-local", { src_ip: "169.254.1.1" }],
    ["dst link-local v6", { dst_ip: "fe80::1" }],
    ["src multicast", { src_ip: "224.0.0.1" }],
    ["dst multicast v6", { dst_ip: "ff02::1" }],
    ["src broadcast", { src_ip: "255.255.255.255" }],
    ["src unspecified /8", { src_ip: "0.1.2.3" }],
    ["dst unspecified v6", { dst_ip: "::" }],
    ["src Class E", { src_ip: "240.0.0.1" }],
    ["src TEST-NET-1", { src_ip: "192.0.2.1" }],
    ["dst TEST-NET-2", { dst_ip: "198.51.100.1" }],
    ["src TEST-NET-3", { src_ip: "203.0.113.1" }],
    ["src 2001:db8", { src_ip: "2001:db8::1" }],
    ["dst 3fff", { dst_ip: "3fff::1" }],
  ] as const;

  it.each(REJECTED)("%s → 400 固定文案，不入庫、不帶 issues 或位址", async (_n, over) => {
    const { app, post } = await setup();
    const f = flow(over);
    const r = await post(f);
    expect([r.statusCode, r.json()]).toEqual([400, ERR]);
    expect(r.json()).not.toHaveProperty("issues");
    expect(JSON.stringify(r.json())).not.toContain(Object.values(over)[0]);
    expect(await n("flow_events")).toBe(0);
    await app.close();
  });

});

describe("R10 ingest 拒絕列與可見計數", () => {
  it("RFC1918、ULA、以及不在清單的 100::/64、2001:2::/48、198.18/15 仍收", async () => {
    const { app, post } = await setup();
    const ok = [
      flow({ src_ip: "10.0.0.8", dst_ip: "192.168.1.1" }),
      flow({ src_ip: "172.16.0.9", dst_ip: "fc00::1" }),
      flow({ src_ip: "100::1", dst_ip: "10.0.0.1" }),
      flow({ src_ip: "2001:2::1", dst_ip: "198.18.0.1" }),
      flow({ src_ip: "64.0.113.5", dst_ip: "10.0.0.1" }),
    ];
    for (const f of ok) expect((await post(f)).statusCode, f.src_ip).toBe(201);
    expect(await n("flow_events")).toBe(ok.length);
    await app.close();
  });

  it("src 與 dst 都保留 → 只寫一列 flow_rejections（每請求一列），reason=reserved", async () => {
    const { app, sensorId, post } = await setup();
    expect((await post(flow({ src_ip: "127.0.0.1", dst_ip: "192.0.2.1" }))).statusCode).toBe(400);
    const rej = await db.query<{ sensor_id: string; at: string; reason: string }>(
      "SELECT sensor_id, at, reason FROM flow_rejections");
    expect(rej.rows).toEqual([{ sensor_id: sensorId, at: String(T0), reason: "reserved" }]);
    expect(rej.rows[0]!.reason).not.toMatch(/\d|:/);
    await app.close();
  });

  it("未認證請求絕不寫 flow_rejections（認證之後才檢查）", async () => {
    const { app, post } = await setup();
    const r = await post(flow({ src_ip: "127.0.0.1" }), { auth: false });
    expect(r.statusCode).toBe(401);
    expect(await n("flow_rejections")).toBe(0);
    await app.close();
  });

  it("順序：格式之後、綁定 403 之前（與 ts 上下限同段）；保留又未綁定 → 400 且 reason=reserved", async () => {
    const { app, post } = await setup({ apps: ["app-1"] });
    const r = await post(flow({ app_id: "app-other", src_ip: "192.0.2.1" }));
    expect([r.statusCode, r.json()]).toEqual([400, ERR]);
    expect(await n("flow_rejections")).toBe(1);
    expect((await db.query<{ reason: string }>("SELECT reason FROM flow_rejections")).rows[0]!.reason).toBe("reserved");
    await app.close();
  });

  it("health 顯示 24h reserved 計數；窗口外不計；log 只記數量不含位址", async () => {
    const lines: string[] = [];
    const now = { t: T0 };
    const { app, post, health } = await setup({ now: () => now.t, lines });
    expect((await health()).json()).toMatchObject({ ok: true, reserved_rejected_24h: 0 });
    expect((await post(flow({ src_ip: "192.0.2.1" }))).statusCode).toBe(400);
    expect((await health()).json()).toMatchObject({ reserved_rejected_24h: 1 });
    now.t = T0 + REJECTION_COUNT_WINDOW_MS + 1;
    expect((await health()).json()).toMatchObject({ reserved_rejected_24h: 0 });
    const text = lines.join("\n");
    expect(text).toContain('"reserved":1');
    expect(text).not.toContain("192.0.2.1");
    expect(text).not.toContain("64.0.113");
    await app.close();
  });

  it("health reserved_rejected_24h 只計本 sensor，其他 sensor 的拒絕不計", async () => {
    const app = await buildIngest({ db, requireHttps: false, now: () => T0, logger: false });
    const tA = await seedToken(db, ["10.0.0.0/8"], false, ["app-1"]);
    const tB = await seedToken(db, ["10.0.0.0/8"], false, ["app-1"]);
    const headers = (t: string) => ({ authorization: `Bearer ${t}` });
    const rejected = await app.inject({
      method: "POST", url: "/v1/flows", payload: flow({ src_ip: "192.0.2.1" }),
      headers: headers(tB), remoteAddress: "10.1.2.3",
    });
    expect(rejected.statusCode).toBe(400);
    const health = (t: string) => app.inject({
      method: "GET", url: "/v1/health", headers: headers(t), remoteAddress: "10.1.2.3",
    });
    expect((await health(tA)).json()).toMatchObject({ reserved_rejected_24h: 0 });
    expect((await health(tB)).json()).toMatchObject({ reserved_rejected_24h: 1 });
    await app.close();
  });
});
