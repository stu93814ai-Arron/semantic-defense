import { z } from "zod";
import { FLOW_WINDOW_MS, MIN_N_FOR_SH } from "./flow-verdict.js";
import { Id, NonNegInt, Port, Rfc3339 } from "./primitives.js";

const Reason = z.enum(["n", "u", "s", "h"]);
const Unit01 = z.number().finite().min(0).max(1);
const PosCount = NonNegInt.refine((n) => n >= 1, { message: "min_1" });

const TopDstPort = z.strictObject({
  port: Port,
  count: PosCount,
});

const PortRanges = z.strictObject({
  well_known: NonNegInt,
  registered: NonNegInt,
  dynamic: NonNegInt,
});

const Dist = z.strictObject({
  min: NonNegInt,
  median: NonNegInt,
  max: NonNegInt,
});

function ordered(d: { min: number; median: number; max: number }): boolean {
  return d.min <= d.median && d.median <= d.max;
}

function sortedDescByCount(rows: readonly { count: number }[]): boolean {
  return rows.every((row, i, all) => i === 0 || (all.at(i - 1)?.count ?? 0) >= row.count);
}

function uniqueReasons(rs: readonly string[]): boolean {
  return new Set(rs).size === rs.length;
}

function uniquePorts(rows: readonly { port: number }[]): boolean {
  return new Set(rows.map((r) => r.port)).size === rows.length;
}


type Feat = { n: number; u: number; s: number; h: boolean; reasons: readonly string[] };

function reasonsMatchFeatures(v: Feat): boolean {
  const has = (r: string) => v.reasons.includes(r);
  return (
    (!has("n") || v.n > 0) &&
    (!has("u") || v.u > 0) &&
    (!has("s") || (v.s > 0 && v.n >= MIN_N_FOR_SH)) &&
    (!has("h") || (v.h && v.n >= MIN_N_FOR_SH))
  );
}

/** PLAN-ADDENDUM-MONITOR：監看成案摘要（意圖模型唯一輸入；strict，禁 IP／自由文字／原 id）。 */
export const MonitorCaseSummarySchema = z
  .strictObject({
    case_id: Id,
    window_start: Rfc3339,
    window_end: Rfc3339,
    n: NonNegInt,
    u: NonNegInt,
    s: Unit01,
    h: z.boolean(),
    confidence: Unit01,
    reasons: z.array(Reason),
    top_dst_ports: z.array(TopDstPort).max(5),
    port_ranges: PortRanges,
    app_count: PosCount,
    sensor_count: PosCount,
    bytes_out: Dist,
    packets: Dist,
    src_scope: z.enum(["private", "public"]),
  })
  .refine(
    (v) => Date.parse(v.window_end) - Date.parse(v.window_start) === FLOW_WINDOW_MS,
    { message: "window_5m", path: ["window_end"] },
  )
  .refine((v) => uniqueReasons(v.reasons), { message: "reasons_unique", path: ["reasons"] })
  .refine((v) => sortedDescByCount(v.top_dst_ports), {
    message: "top_dst_ports_desc",
    path: ["top_dst_ports"],
  })
  .refine((v) => uniquePorts(v.top_dst_ports), {
    message: "top_dst_ports_unique",
    path: ["top_dst_ports"],
  })
  .refine(
    (v) => v.top_dst_ports.reduce((sum, row) => sum + row.count, 0) <= v.n,
    { message: "top_dst_ports_sum", path: ["top_dst_ports"] },
  )
  .refine((v) => v.u <= v.n, { message: "u_le_n", path: ["u"] })
  .refine((v) => v.top_dst_ports.length === Math.min(v.u, 5), {
    message: "top_dst_ports_len",
    path: ["top_dst_ports"],
  })
  .refine(
    (v) =>
      v.port_ranges.well_known + v.port_ranges.registered + v.port_ranges.dynamic === v.n,
    { message: "port_ranges_sum", path: ["port_ranges"] },
  )
  .refine((v) => ordered(v.bytes_out), { message: "bytes_out_order", path: ["bytes_out"] })
  .refine((v) => ordered(v.packets), { message: "packets_order", path: ["packets"] })
  .refine((v) => reasonsMatchFeatures(v), {
    message: "reasons_features",
    path: ["reasons"],
  });

export type MonitorCaseSummary = z.infer<typeof MonitorCaseSummarySchema>;
