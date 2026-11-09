import type { FlowMetadataEvent } from "./flow-metadata-event.js";

/** E3.A ② 流量判定（純函式，不碰 DB）。規則：PM＋A 領航員定案。 */
export const FLOW_WINDOW_MS = 5 * 60 * 1000;
export const WEIGHTS = Object.freeze({ n: 0.15, u: 0.35, s: 0.3, h: 0.2 });
export const N_CAP = 20;
export const U_CAP = 30;
/** N 低於此值時 S、H 不計。 */
export const MIN_N_FOR_SH = 5;
export const SHORT_DURATION_MS = 100;
export const LOW_PACKET_MIN_U = 10;
export const LOW_PACKET_MEDIAN = 3;
export const CASE_THRESHOLD = 0.5;
export const AUTO_THRESHOLD = 0.9;
if (!(CASE_THRESHOLD <= AUTO_THRESHOLD)) throw new Error("CASE_THRESHOLD must be <= AUTO_THRESHOLD");

/** 可注入門檻（成案 case、自動 auto）；省略＝上列常數。讀自 control-api 的設定時須與管理面讀回值一致。 */
export type FlowThresholds = { readonly case: number; readonly auto: number };
const DEFAULT_FLOW_THRESHOLDS: FlowThresholds = Object.freeze({ case: CASE_THRESHOLD, auto: AUTO_THRESHOLD });

export type FlowReason = "n" | "u" | "s" | "h";
export type FlowFeatures = { n: number; u: number; s: number; h: boolean };
export type FlowScore = { confidence: number; open_case: boolean; reasons: FlowReason[] };
export type FlowVerdict = FlowScore & {
  app_id: string;
  src_ip: string;
  /** 對齊 epoch 的 5 分鐘固定窗起點（ISO）。 */
  window_start: string;
  n: number;
  u: number;
  s: number;
  h: boolean;
};

/** 分組鍵：目前只用 app_id；之後加 sensor 只需改這裡。 */
const groupKey = (f: FlowMetadataEvent, win: number) => JSON.stringify([f.app_id, f.src_ip, win]);

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  const hi = a.at(m) ?? 0;
  return a.length % 2 ? hi : ((a.at(m - 1) ?? 0) + hi) / 2;
};

/** 依特徵計分；confidence 四捨五入到 1e-9 以避免浮點誤差影響門檻比較。 */
export function scoreFeatures({ n, u, s, h }: FlowFeatures, thresholds: FlowThresholds = DEFAULT_FLOW_THRESHOLDS): FlowScore {
  const countSH = n >= MIN_N_FOR_SH;
  const parts: Record<FlowReason, number> = {
    n: WEIGHTS.n * Math.min(n, N_CAP) / N_CAP,
    u: WEIGHTS.u * Math.min(u, U_CAP) / U_CAP,
    s: countSH ? WEIGHTS.s * Math.min(Math.max(s, 0), 1) : 0,
    h: countSH && h ? WEIGHTS.h : 0,
  };
  const raw = parts.n + parts.u + parts.s + parts.h;
  const confidence = Math.min(1, Math.max(0, Math.round(raw * 1e9) / 1e9));
  const reasons = (Object.entries(parts) as [FlowReason, number][])
    .filter(([, v]) => v > 0)
    .map(([k]) => k);
  return { confidence, open_case: confidence >= thresholds.case, reasons };
}

/** 將 flows 依 (app_id, src_ip, 5 分鐘固定窗) 分組，每組輸出一筆判定；輸出依鍵排序。 */
export function judgeFlows(
  flows: readonly FlowMetadataEvent[], thresholds: FlowThresholds = DEFAULT_FLOW_THRESHOLDS,
): FlowVerdict[] {
  const groups = new Map<string, FlowMetadataEvent[]>();
  for (const f of flows) {
    const win = Math.floor(Date.parse(f.ts) / FLOW_WINDOW_MS);
    const k = groupKey(f, win);
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }
  return [...groups.keys()].sort().map((k) => {
    const g = groups.get(k)!;
    const [app_id, src_ip, win] = JSON.parse(k) as [string, string, number];
    const n = g.length;
    const u = new Set(g.map((f) => f.dst_port)).size;
    const short = g.filter((f) => f.duration_ms < SHORT_DURATION_MS && f.bytes_out === 0).length;
    const s = n >= MIN_N_FOR_SH ? short / n : 0;
    const h = n >= MIN_N_FOR_SH && u >= LOW_PACKET_MIN_U && median(g.map((f) => f.packets)) <= LOW_PACKET_MEDIAN;
    return {
      app_id, src_ip, window_start: new Date(win * FLOW_WINDOW_MS).toISOString(),
      n, u, s, h, ...scoreFeatures({ n, u, s, h }, thresholds),
    };
  });
}
