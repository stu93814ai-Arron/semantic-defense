import { z } from "zod";
import { AllowlistEntrySchema } from "./allowlist-entry.js";
import { BlocklistEntrySchema } from "./blocklist-entry.js";
import { AUTO_THRESHOLD, CASE_THRESHOLD } from "./flow-verdict.js";
import { assertAllowlistCidr, assertIpOrCidr, isHostPrefix } from "./ip-cidr.js";
import { Reason, Rfc3339 } from "./primitives.js";

/**
 * 管理面 HTTP 契約（control-api ↔ console）：路徑常數與請求／回應本文。
 * 欄位只取自 PLAN-ADDENDUM-MONITOR §3／§7、V2 裁示；全部 strictObject，多欄位、缺欄位整份拒絕。
 * 角色（MONITOR §7a，A 組領航員裁示）：黑名單讀取／撤回、待審核准／退回＝operator；白名單 CRUD、門檻讀寫＝platform_admin。
 */
export const ADMIN_API_PATHS = Object.freeze({
  thresholds: "/api/thresholds",
  blacklist: "/api/blacklist",
  blacklistRevoke: "/api/blacklist/:entryId/revoke",
  blacklistPending: "/api/blacklist/pending",
  blacklistPendingApprove: "/api/blacklist/pending/:caseId/approve",
  blacklistPendingReject: "/api/blacklist/pending/:caseId/reject",
  whitelist: "/api/whitelist",
  whitelistEntry: "/api/whitelist/:entryId",
} as const);

const Unit = z.number().finite().min(0).max(1);

/** 門檻上下限（總召裁示）：case 0.30–1、auto 0.70–1，且 case < auto（嚴格）。 */
export const THRESHOLD_BOUNDS = Object.freeze({
  case: Object.freeze({ min: 0.3, max: 1 }),
  auto: Object.freeze({ min: 0.7, max: 1 }),
});

/** 只驗結構（strictObject、兩個有限數）；不驗上下限。control-api 用它區分「結構錯誤」與「數值被拒」。 */
export const ThresholdsShapeSchema = z.strictObject({ case: z.number().finite(), auto: z.number().finite() });

export type ThresholdsViolation =
  | "case_below_min" | "case_above_max" | "auto_below_min" | "auto_above_max" | "case_not_below_auto";

/** 結構合法的門檻違反哪條數值規則；全符合 → null。 */
export function thresholdsViolation(t: { case: number; auto: number }): ThresholdsViolation | null {
  const B = THRESHOLD_BOUNDS;
  if (t.case < B.case.min) return "case_below_min";
  if (t.case > B.case.max) return "case_above_max";
  if (t.auto < B.auto.min) return "auto_below_min";
  if (t.auto > B.auto.max) return "auto_above_max";
  if (!(t.case < t.auto)) return "case_not_below_auto";
  return null;
}

/** 成案／自動上榜門檻；結構同 ThresholdsShapeSchema，另須符合 THRESHOLD_BOUNDS 與 case < auto。GET 回應與 PUT 請求同形。 */
export const ThresholdsSchema = ThresholdsShapeSchema.superRefine((t, ctx) => {
  const v = thresholdsViolation(t);
  if (v) ctx.addIssue({ code: "custom", message: v, path: [v.startsWith("auto") ? "auto" : "case"] });
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

/** 預設門檻（MONITOR §7：0.50 成案、0.90 自動）＝ flow-verdict 常數。 */
export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({ case: CASE_THRESHOLD, auto: AUTO_THRESHOLD });

/**
 * 黑名單待審候選：以 case_id 為鍵；ip 只收 /32、/128。
 * confidence＝累加期間的最高分；hit_count＝累加次數（≥1）；last_hit_at＝最後一次命中的伺服器時間（A 裁定 Q10）。
 * 到期（created_at + 24h）、狀態等只在 DB，不進契約。
 */
export const PendingCandidateSchema = z.strictObject({
  ip: z.string().refine((s) => assertIpOrCidr(s) && isHostPrefix(s), { message: "host_prefix" }),
  confidence: Unit,
  case_id: z.uuid(),
  created_at: Rfc3339,
  hit_count: z.number().int().min(1),
  last_hit_at: Rfc3339,
});
export type PendingCandidate = z.infer<typeof PendingCandidateSchema>;
export const PendingCandidateListSchema = z.strictObject({ items: z.array(PendingCandidateSchema) });

/** 已上榜黑名單列表（GET blacklist）；撤回（POST blacklistRevoke）無本文，回應為更新後的黑名單項目。 */
export const BlocklistListSchema = z.strictObject({ items: z.array(BlocklistEntrySchema) });

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
