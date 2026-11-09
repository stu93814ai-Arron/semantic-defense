import { describe, expect, it } from "vitest";
import { Rfc3339, parseFlowMetadataEvent } from "../src/index.js";
import { BlocklistEntrySchema } from "../src/browser.js";

/** 資安退回 B2：offset 只收 ±15:59（Postgres timestamptz 的上限）；超過的會讓下游 ts::timestamptz 拋錯。 */
const CASES = [
  ["Z", "2026-11-05T12:00:00Z", true],
  ["+15:59", "2026-11-05T12:00:00+15:59", true],
  ["-15:59", "2026-11-05T12:00:00-15:59", true],
  ["+00:00（毫秒）", "2026-11-05T12:00:00.123+00:00", true],
  ["+16:00", "2026-11-05T12:00:00+16:00", false],
  ["-16:00", "2026-11-05T12:00:00-16:00", false],
  ["+23:59", "2026-11-05T12:00:00+23:59", false],
  ["-23:59", "2026-11-05T12:00:00.5-23:59", false],
] as const;

describe("Rfc3339 offset 限 ±15:59", () => {
  it.each(CASES)("%s", (_n, v, ok) => {
    expect(Rfc3339.safeParse(v).success).toBe(ok);
  });
  it.each(CASES)("flow ts／./browser 的 BlocklistEntry.created_at 同步：%s", (_n, v, ok) => {
    const flow = { flow_id: "33333333-3333-4333-8333-333333333333", app_id: "app-1", ts: v, src_ip: "203.0.113.1", dst_ip: "10.0.0.1", src_port: 1, dst_port: 2,
      protocol: "tcp", bytes_in: 0, bytes_out: 0, packets: 0, duration_ms: 0 };
    expect(parseFlowMetadataEvent(flow).ok).toBe(ok);
    const entry = { entry_id: "22222222-2222-4222-8222-222222222222", ip: "203.0.113.1/32", source: "manual", confidence: 0.6,
      case_id: "11111111-1111-4111-8111-111111111111", created_at: v, expires_at: "2026-11-30T00:00:00Z",
      approved_by: "admin1", approved_at: "2026-11-30T00:00:00Z", revoked_at: null };
    expect(BlocklistEntrySchema.safeParse(entry).success).toBe(ok);
  });
});
