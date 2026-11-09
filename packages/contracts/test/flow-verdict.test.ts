import { describe, expect, it } from "vitest";
import {
  AUTO_THRESHOLD,
  CASE_THRESHOLD,
  FLOW_WINDOW_MS,
  WEIGHTS,
  judgeFlows,
  scoreFeatures,
  type FlowMetadataEvent,
} from "../src/index.js";

const T0 = Date.parse("2026-11-05T12:00:00.000Z");
let seq = 0;
const flow = (o: Partial<FlowMetadataEvent> & { at?: number } = {}): FlowMetadataEvent => {
  const { at = 0, ...rest } = o;
  seq += 1;
  return {
    flow_id: `550e8400-e29b-41d4-a716-${String(seq).padStart(12, "0")}`,
    app_id: "orders-app",
    ts: new Date(T0 + at).toISOString(),
    src_ip: "192.0.2.10",
    dst_ip: "198.51.100.20",
    src_port: 51234,
    dst_port: 443,
    protocol: "tcp",
    bytes_in: 800,
    bytes_out: 4000,
    packets: 20,
    duration_ms: 5000,
    ...rest,
  };
};
const scan = (n: number, extra: Partial<FlowMetadataEvent> = {}) =>
  Array.from({ length: n }, (_, i) =>
    flow({ dst_port: 1000 + i, bytes_in: 60, bytes_out: 0, packets: 1, duration_ms: 10, at: i * 1000, ...extra }));

describe("常數", () => {
  it("成案門檻 ≤ 自動門檻，權重總和 1", () => {
    expect(CASE_THRESHOLD).toBe(0.5);
    expect(AUTO_THRESHOLD).toBe(0.9);
    expect(CASE_THRESHOLD).toBeLessThanOrEqual(AUTO_THRESHOLD);
    expect(WEIGHTS.n + WEIGHTS.u + WEIGHTS.s + WEIGHTS.h).toBeCloseTo(1, 12);
    expect(FLOW_WINDOW_MS).toBe(300_000);
  });
});

describe("judgeFlows 假資料", () => {
  it("可疑：多埠短連低封包掃描 → 成案，reasons n/u/s/h", () => {
    const [v] = judgeFlows(scan(30));
    expect(v).toMatchObject({ app_id: "orders-app", src_ip: "192.0.2.10", open_case: true });
    expect(v!.confidence).toBe(1);
    expect(v!.reasons).toEqual(["n", "u", "s", "h"]);
    expect(v!.window_start).toBe(new Date(T0).toISOString());
  });
  it("正常：單一 dst:443、雙向 bytes、長 duration → 不成案", () => {
    const [v] = judgeFlows(Array.from({ length: 10 }, (_, i) => flow({ at: i * 1000 })));
    expect(v!.open_case).toBe(false);
    expect(v!.confidence).toBeCloseTo(0.15 * 10 / 20 + 0.35 / 30, 6);
    expect(v!.reasons).toEqual(["n", "u"]);
  });
  it("N<5：即使全為短連低封包也不計 S/H", () => {
    const [v] = judgeFlows(scan(4));
    expect(v!.reasons).toEqual(["n", "u"]);
    expect(v!.confidence).toBeCloseTo(0.15 * 4 / 20 + 0.35 * 4 / 30, 6);
    expect(v!.open_case).toBe(false);
  });
  it("短連需 bytes_out===0 且 duration<100", () => {
    const fs = [...scan(5, { duration_ms: 100 }), ...scan(5, { bytes_out: 1 })];
    expect(judgeFlows(fs)[0]!.reasons).not.toContain("s");
  });
  it("H：U≥10 且 packets 中位數 ≤3；中位數 4 不計", () => {
    expect(judgeFlows(scan(10, { packets: 3 }))[0]!.reasons).toContain("h");
    expect(judgeFlows(scan(10, { packets: 4 }))[0]!.reasons).not.toContain("h");
    expect(judgeFlows(scan(9, { packets: 1 }))[0]!.reasons).not.toContain("h");
  });
  it("5 分窗：窗外 flow 不進同組", () => {
    const fs = [...scan(5), flow({ at: FLOW_WINDOW_MS, dst_port: 9 })];
    const vs = judgeFlows(fs);
    expect(vs).toHaveLength(2);
    expect(vs.map((v) => v.n)).toEqual([5, 1]);
  });
  it("依 app_id＋src_ip 分組，輸出不含其他流量欄位", () => {
    const vs = judgeFlows([flow(), flow({ app_id: "b" }), flow({ src_ip: "2001:db8::1" })]);
    expect(vs).toHaveLength(3);
    expect(Object.keys(vs[0]!).sort()).toEqual(
      ["app_id", "confidence", "h", "n", "open_case", "reasons", "s", "src_ip", "u", "window_start"]);
    expect(JSON.stringify(vs)).not.toContain("198.51.100.20");
  });
  it("空輸入 → 空陣列；輸出排序穩定", () => {
    expect(judgeFlows([])).toEqual([]);
    const a = judgeFlows([flow({ app_id: "z" }), flow({ app_id: "a" })]).map((v) => v.app_id);
    expect(a).toEqual(["a", "z"]);
  });
});

describe("scoreFeatures 邊界 0.50／0.90", () => {
  const at = (n: number, u: number, s = 0, h = false) => scoreFeatures({ n, u, s, h });
  it("剛好 0.50 成案", () => {
    expect(at(20, 30).confidence).toBe(0.5);
    expect(at(20, 30).open_case).toBe(true);
  });
  it("略低不成案、略高成案", () => {
    expect(at(19, 30).confidence).toBeLessThan(0.5);
    expect(at(19, 30).open_case).toBe(false);
    expect(at(20, 30, 0.01).confidence).toBeGreaterThan(0.5);
    expect(at(20, 30, 0.01).open_case).toBe(true);
  });
  it("0.90 剛好／略低／略高（自動門檻供④）", () => {
    expect(at(20, 30, 1).confidence).toBeCloseTo(0.8, 12);
    expect(at(20, 30, 0, true).confidence).toBe(0.7);
    const exact = at(20, 30, 2 / 3, false).confidence;
    expect(exact).toBe(0.7);
    expect(at(20, 30, 1, true).confidence).toBe(1);
    expect(at(10, 30, 1, true).confidence).toBe(0.925);
    expect(at(10, 30, 1, true).confidence >= AUTO_THRESHOLD).toBe(true);
    expect(at(20, 30, 2 / 3, true).confidence).toBe(0.9);
    expect(at(20, 29, 2 / 3, true).confidence < AUTO_THRESHOLD).toBe(true);
  });
  it("N<5 時 S/H 不計；clamp 0..1", () => {
    expect(at(4, 4, 1, true).reasons).toEqual(["n", "u"]);
    expect(at(100, 100, 1, true).confidence).toBe(1);
    expect(at(0, 0).confidence).toBe(0);
    expect(at(0, 0).reasons).toEqual([]);
  });
});

describe("可注入門檻（thresholds；省略＝現行常數）", () => {
  it("未傳 thresholds：與傳入預設常數完全相同", () => {
    const flows = [...scan(20), flow({ src_ip: "192.0.2.11" })];
    expect(judgeFlows(flows)).toEqual(judgeFlows(flows, { case: CASE_THRESHOLD, auto: AUTO_THRESHOLD }));
    const f = { n: 20, u: 30, s: 0, h: false };
    expect(scoreFeatures(f)).toEqual(scoreFeatures(f, { case: CASE_THRESHOLD, auto: AUTO_THRESHOLD }));
  });

  it("open_case 依注入的 case 門檻判定（confidence 不變）", () => {
    const f = { n: 20, u: 30, s: 0, h: false }; // 0.15 + 0.35 = 0.50
    expect(scoreFeatures(f).open_case).toBe(true);
    const hi = scoreFeatures(f, { case: 0.6, auto: 0.9 });
    expect(hi).toEqual({ ...scoreFeatures(f), open_case: false });
    expect(scoreFeatures({ n: 4, u: 4, s: 0, h: false }, { case: 0.05, auto: 0.9 }).open_case).toBe(true);
    const [v] = judgeFlows(scan(30), { case: 1, auto: 1 });
    expect(v!.confidence).toBe(1);
    expect(v!.open_case).toBe(true);
    expect(judgeFlows(scan(3), { case: 1, auto: 1 })[0]!.open_case).toBe(false);
  });
});
