import { z } from "zod";
import { AllowlistEntrySchema } from "./allowlist-entry.js";
import { BlocklistEntrySchema } from "./blocklist-entry.js";
import { AUTO_THRESHOLD, CASE_THRESHOLD } from "./flow-verdict.js";
import { assertAllowlistCidr, assertIpOrCidr, isHostPrefix } from "./ip-cidr.js";
import { Rfc3339 } from "./primitives.js";

/**
 * 管理面 HTTP 契約（control-api ↔ console）：路徑常數與請求／回應本文。
 * 欄位只取自 PLAN-ADDENDUM-MONITOR §3／§7、V2 裁示；全部 strictObject，多欄位、缺欄位整份拒絕。
 * 角色（MONITOR §7a，A 組領航員裁示）：黑名單讀取／撤回＝operator；白名單 CRUD、門檻讀寫＝platform_admin。
 */
export const ADMIN_API_PATHS = Object.freeze({
  thresholds: "/api/thresholds",
  blacklist: "/api/blacklist",
  blacklistRevoke: "/api/blacklist/:entryId/revoke",
  blacklistPending: "/api/blacklist/pending",
  whitelist: "/api/whitelist",
  whitelistEntry: "/api/whitelist/:entryId",
} as const);

const Unit = z.number().finite().min(0).max(1);

/** 成案／自動上榜門檻；須 0 ≤ case ≤ auto ≤ 1。GET 回應與 PUT 請求同形。 */
export const ThresholdsSchema = z
  .strictObject({ case: Unit, auto: Unit })
  .refine((t) => t.case <= t.auto, { message: "case_le_auto", path: ["case"] });
export type Thresholds = z.infer<typeof ThresholdsSchema>;

/** 預設門檻（MONITOR §7：0.50 成案、0.90 自動）＝ flow-verdict 常數。 */
export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({ case: CASE_THRESHOLD, auto: AUTO_THRESHOLD });

/** 黑名單待審候選：以 case_id 為鍵；欄位取自黑名單項目；ip 只收 /32、/128。 */
export const PendingCandidateSchema = z.strictObject({
  ip: z.string().refine((s) => assertIpOrCidr(s) && isHostPrefix(s), { message: "host_prefix" }),
  confidence: Unit,
  case_id: z.uuid(),
  created_at: Rfc3339,
});
export type PendingCandidate = z.infer<typeof PendingCandidateSchema>;
export const PendingCandidateListSchema = z.strictObject({ items: z.array(PendingCandidateSchema) });

/** 已上榜黑名單列表（GET blacklist）；撤回（POST blacklistRevoke）無本文，回應為更新後的黑名單項目。 */
export const BlocklistListSchema = z.strictObject({ items: z.array(BlocklistEntrySchema) });

const Reason = z.string().min(1).max(200);
const ExpiresAt = z.union([Rfc3339, z.null()]);

/** 白名單新增：entry_id、created_by、created_at 由伺服端填；回應為白名單項目。 */
export const AllowlistCreateSchema = z.strictObject({
  cidr: z.string().refine(assertAllowlistCidr, { message: "allowlist_cidr" }),
  reason: Reason,
  expires_at: ExpiresAt,
});
export type AllowlistCreate = z.infer<typeof AllowlistCreateSchema>;

/** 白名單修改：cidr 不可改；reason、expires_at 皆必填（整份取代）。 */
export const AllowlistUpdateSchema = z.strictObject({ reason: Reason, expires_at: ExpiresAt });
export type AllowlistUpdate = z.infer<typeof AllowlistUpdateSchema>;

export const AllowlistListSchema = z.strictObject({ items: z.array(AllowlistEntrySchema) });
