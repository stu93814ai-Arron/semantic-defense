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

/** C0／C1 控制字元（含 \t \n \r、U+007F）與 bidi 控制字元（U+200E/200F、U+202A–202E、U+2066–2069）。 */
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** 人寫的理由文字（白名單 reason 等）：1–200 字，拒控制與 bidi 字元；HTML 不擋，由輸出端跳脫。 */
export const Reason = z.string().min(1).max(200).refine((s) => !CONTROL_OR_BIDI.test(s), { message: "control_or_bidi_char" });
