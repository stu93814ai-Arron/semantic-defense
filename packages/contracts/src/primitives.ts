import { z } from "zod";
import { assertFlowSingleIp } from "./ip-cidr.js";

/** 契約共用 Id（app_id／actor 等；亦涵蓋 approved_by 的 system:auto）。 */
export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);

export const NonNegInt = z.number().int().nonnegative();

export const Port = z.number().int().min(1).max(65535);

/** RFC3339（含 offset）。 */
export const Rfc3339 = z.iso.datetime({ offset: true });

/** 單一 IPv4／IPv6；拒 CIDR（/）、zone（%）、非 RFC5952、IPv4-mapped；保留位址可過。 */
export const SingleIp = z.string().refine(assertFlowSingleIp, { message: "single_ip" });
