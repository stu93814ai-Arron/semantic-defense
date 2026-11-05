import { describe, expect, it } from "vitest";
import { FLOW_WINDOW_MS, parseMonitorCaseSummary } from "../src/index.js";

type Obj = Record<string, unknown>;

const base = (): Obj => ({
  case_id: "case-monitor-1",
  window_start: "2026-11-05T12:00:00.000Z",
  window_end: "2026-11-05T12:05:00.000Z",
  n: 10,
  u: 3,
  s: 0.2,
  h: false,
  confidence: 0.55,
  reasons: ["n", "u"],
  top_dst_ports: [
    { port: 443, count: 5 },
    { port: 80, count: 3 },
    { port: 22, count: 2 },
  ],
  port_ranges: { well_known: 7, registered: 2, dynamic: 1 },
  app_count: 1,
  sensor_count: 1,
  bytes_out: { min: 0, median: 100, max: 1000 },
  packets: { min: 1, median: 5, max: 20 },
  src_scope: "private",
});

const patch = (p: Obj): Obj => ({ ...base(), ...p });

describe("MonitorCaseSummarySchema 合法與多欄", () => {
  it("合法完整 fixture → ok", () => {
    const r = parseMonitorCaseSummary(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.n).toBe(10);
      expect(r.value.src_scope).toBe("private");
    }
    expect(FLOW_WINDOW_MS).toBe(300_000);
    expect(
      Date.parse("2026-11-05T12:05:00.000Z") - Date.parse("2026-11-05T12:00:00.000Z"),
    ).toBe(FLOW_WINDOW_MS);
  });

  it.each([
    ["src_ip", { src_ip: "192.0.2.10" }],
    ["note", { note: "free text" }],
    ["app_id", { app_id: "orders-app" }],
    ["sensor_id", { sensor_id: "sensor-1" }],
  ] as const)("多欄 %s → 拒", (_n, extra) => {
    const r = parseMonitorCaseSummary(patch(extra));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.errors)).not.toMatch(/192\.0\.2\.10|free text|orders-app|sensor-1/);
    }
  });
});

describe("MonitorCaseSummarySchema 結構約束", () => {
  it("top_dst_ports >5 → 拒", () => {
    const ports = [1, 2, 3, 4, 5, 6].map((i) => ({ port: i, count: 10 - i }));
    const r = parseMonitorCaseSummary(
      patch({
        top_dst_ports: ports,
        n: 39,
        u: 6,
        port_ranges: { well_known: 39, registered: 0, dynamic: 0 },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("top_dst_ports 未按 count 降序 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        u: 2,
        top_dst_ports: [
          { port: 80, count: 2 },
          { port: 443, count: 5 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("port_ranges 加總 ≠ n → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({ port_ranges: { well_known: 1, registered: 1, dynamic: 1 } }),
    );
    expect(r.ok).toBe(false);
  });

  it("bytes_out min/median/max 順序錯 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({ bytes_out: { min: 10, median: 5, max: 20 } }),
    );
    expect(r.ok).toBe(false);
  });

  it("packets min/median/max 順序錯 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({ packets: { min: 1, median: 20, max: 10 } }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("MonitorCaseSummarySchema 時間與分數", () => {
  it("時間窗不是剛好 5 分鐘 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({ window_end: "2026-11-05T12:04:00.000Z" }),
    );
    expect(r.ok).toBe(false);
  });

  it("reasons 重複 → 拒", () => {
    expect(parseMonitorCaseSummary(patch({ reasons: ["n", "n"] })).ok).toBe(false);
  });

  it("reasons 不在清單 → 拒", () => {
    expect(parseMonitorCaseSummary(patch({ reasons: ["x"] })).ok).toBe(false);
  });

  it("confidence 超出 0..1 → 拒", () => {
    expect(parseMonitorCaseSummary(patch({ confidence: 1.1 })).ok).toBe(false);
    expect(parseMonitorCaseSummary(patch({ confidence: -0.01 })).ok).toBe(false);
  });

  it("app_count／sensor_count =0 → 拒", () => {
    expect(parseMonitorCaseSummary(patch({ app_count: 0 })).ok).toBe(false);
    expect(parseMonitorCaseSummary(patch({ sensor_count: 0 })).ok).toBe(false);
  });
});

describe("MonitorCaseSummarySchema 埠／u／count 一致性", () => {
  it("top_dst_ports port 重複 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        u: 2,
        top_dst_ports: [
          { port: 443, count: 5 },
          { port: 443, count: 3 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("top_dst_ports count 為 0 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        u: 1,
        top_dst_ports: [{ port: 443, count: 0 }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("top_dst_ports count 加總超過 n → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        n: 10,
        u: 2,
        port_ranges: { well_known: 10, registered: 0, dynamic: 0 },
        top_dst_ports: [
          { port: 443, count: 8 },
          { port: 80, count: 5 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("u 超過 n → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        n: 10,
        u: 11,
        port_ranges: { well_known: 10, registered: 0, dynamic: 0 },
        top_dst_ports: [
          { port: 443, count: 2 },
          { port: 80, count: 2 },
          { port: 22, count: 2 },
          { port: 53, count: 2 },
          { port: 25, count: 2 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("top_dst_ports 筆數 ≠ min(u,5) → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        u: 4,
        top_dst_ports: [
          { port: 443, count: 5 },
          { port: 80, count: 3 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("MonitorCaseSummarySchema reasons 與特徵一致", () => {
  it("reasons 含 h 但 h 為 false → 拒", () => {
    const r = parseMonitorCaseSummary(patch({ reasons: ["h"], h: false }));
    expect(r.ok).toBe(false);
  });

  it("reasons 含 h 但 n < 5 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        n: 4,
        u: 2,
        h: true,
        reasons: ["h"],
        port_ranges: { well_known: 4, registered: 0, dynamic: 0 },
        top_dst_ports: [
          { port: 443, count: 2 },
          { port: 80, count: 2 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("reasons 含 s 但 s 為 0 → 拒", () => {
    const r = parseMonitorCaseSummary(patch({ reasons: ["s"], s: 0 }));
    expect(r.ok).toBe(false);
  });

  it("reasons 含 s 但 n < 5 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        n: 4,
        u: 2,
        s: 0.5,
        reasons: ["s"],
        port_ranges: { well_known: 4, registered: 0, dynamic: 0 },
        top_dst_ports: [
          { port: 443, count: 2 },
          { port: 80, count: 2 },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("reasons 含 n 但 n 為 0 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        n: 0,
        u: 0,
        s: 0,
        h: false,
        reasons: ["n"],
        top_dst_ports: [],
        port_ranges: { well_known: 0, registered: 0, dynamic: 0 },
        bytes_out: { min: 0, median: 0, max: 0 },
        packets: { min: 0, median: 0, max: 0 },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("reasons 含 u 但 u 為 0 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        u: 0,
        reasons: ["u"],
        top_dst_ports: [],
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("MonitorCaseSummarySchema 成案下限", () => {
  it("n 為 0 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        n: 0,
        u: 0,
        s: 0,
        h: false,
        // 空 reasons：避開既有 reasonsMatchFeatures，專門驗證 n≥1
        reasons: [],
        top_dst_ports: [],
        port_ranges: { well_known: 0, registered: 0, dynamic: 0 },
        bytes_out: { min: 0, median: 0, max: 0 },
        packets: { min: 0, median: 0, max: 0 },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("u 為 0 → 拒", () => {
    const r = parseMonitorCaseSummary(
      patch({
        u: 0,
        reasons: ["n"],
        top_dst_ports: [],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("reasons 空陣列 → 拒", () => {
    const r = parseMonitorCaseSummary(patch({ reasons: [] }));
    expect(r.ok).toBe(false);
  });
});
