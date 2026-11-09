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

/**
 * 以 Unicode 類別擋（資安殘留 2）：Cc（C0／C1 控制字元）、Cf（格式字元：bidi、零寬 U+200B–200F、U+FEFF、U+00AD、
 * U+180E、U+FFF9–FFFB、tag 字元等）、Zl（U+2028）、Zp（U+2029）。另列 Lo 的填充字元 U+115F、U+3164，
 * 以及整段 tag 區 U+E0000–E007F（其中 U+E0000、U+E0002–E001F 未指派，不屬 Cf，須明列）。
 */
const CONTROL_OR_BIDI = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u3164]/u;
/** tag 區以 code point 比對（regex 寫 \u{E0000}-\u{E007F} 會被 security/detect-unsafe-regex 誤報）。 */
const hasTagChar = (s: string): boolean => [...s].some((c) => c.codePointAt(0)! >= 0xe0000 && c.codePointAt(0)! <= 0xe007f);

/** 未配對 surrogate → false（ES2024 String.prototype.isWellFormed；tsconfig lib 為 ES2022，故以型別轉接）。 */
const isWellFormed = (s: string): boolean => (s as unknown as { isWellFormed(): boolean }).isWellFormed();

/**
 * 人寫的理由文字（白名單 reason 等）：1–200 字，拒控制／bidi／不可見字元與未配對 surrogate；HTML 不擋，由輸出端跳脫。
 * 刻意：reason 擋 ZWJ（U+200D），所以 ZWJ 組合 emoji（如家庭圖示）會被拒；單一 emoji 仍可。
 * isWellFormed 屬 ES2024：console 端需 Chrome 111+、Safari 16.4+、Firefox 119+。
 */
export const Reason = z.string().min(1).max(200)
  .refine((s) => isWellFormed(s) && !CONTROL_OR_BIDI.test(s) && !hasTagChar(s), { message: "control_or_bidi_char" });
