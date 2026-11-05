import { z } from "zod";
import { Id, NonNegInt, Port, SingleIp } from "./primitives.js";

/** PLAN-ADDENDUM-MONITOR §3 流量中繼資料事件（strict，多欄／缺欄整份拒絕）。 */
export const FlowMetadataEventSchema = z.strictObject({
  flow_id: z.uuid(),
  app_id: Id,
  ts: z.iso.datetime({ offset: true }),
  src_ip: SingleIp,
  dst_ip: SingleIp,
  src_port: Port,
  dst_port: Port,
  protocol: z.enum(["tcp", "udp"]),
  bytes_in: NonNegInt,
  bytes_out: NonNegInt,
  packets: NonNegInt,
  duration_ms: NonNegInt,
});

export type FlowMetadataEvent = z.infer<typeof FlowMetadataEventSchema>;
