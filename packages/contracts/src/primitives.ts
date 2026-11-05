import { isIP } from "node:net";
import { z } from "zod";

/** 契約共用 Id（app_id／actor 等；亦涵蓋 approved_by 的 system:auto）。 */
export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);

export const NonNegInt = z.number().int().nonnegative();

export const Port = z.number().int().min(1).max(65535);

/** RFC3339（含 offset）。 */
export const Rfc3339 = z.iso.datetime({ offset: true });

/** 單一 IPv4／IPv6；拒 CIDR（/）與 IPv6 zone（%）。 */
export const SingleIp = z.string().refine(
  (s) => !s.includes("/") && !s.includes("%") && isIP(s) !== 0,
  { message: "single_ip" },
);
