import { isIP } from "node:net";
import { z } from "zod";

/** 與 RequestEvent app_id 規則一致。 */
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const NonNegInt = z.number().int().nonnegative();
const Port = z.number().int().min(1).max(65535);

/** 單一 IPv4／IPv6；拒 CIDR（含 /）。保留位址檢查屬後續 commit。 */
const SingleIp = z.string().refine(
  (s) => !s.includes("/") && isIP(s) !== 0,
  { message: "single_ip" },
);

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
