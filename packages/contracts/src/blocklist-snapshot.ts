import { z } from "zod";
import { BlocklistEntrySchema } from "./blocklist-entry.js";
import { Rfc3339 } from "./primitives.js";

/** 64 位 hex（大小寫皆可；僅格式）。 */
const Hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/);

/** base64url（標準／URL 安全字元；可含 padding）。 */
const Base64Url = z.string().min(1).regex(/^[A-Za-z0-9_-]+={0,2}$/);

/** PLAN-ADDENDUM-MONITOR §3 黑名單快照簽名信封（只驗格式，不做簽名驗證）。 */
export const BlocklistSnapshotSchema = z.strictObject({
  version: z.number().int().min(1),
  generated_at: Rfc3339,
  entries: z.array(BlocklistEntrySchema),
  entries_sha256: Hex64,
  signature: Base64Url,
});

export type BlocklistSnapshot = z.infer<typeof BlocklistSnapshotSchema>;
