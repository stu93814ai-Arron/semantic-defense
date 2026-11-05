import { z } from "zod";
import { assertIpOrCidr, isHostPrefix } from "./ip-cidr.js";
import { Id, Rfc3339 } from "./primitives.js";

const ApprovedBy = z.union([z.literal("system:auto"), Id]);

function ts(s: string): number {
  return Date.parse(s);
}

function approvedByMatchesSource(source: "manual" | "auto", approvedBy: string): boolean {
  if (source === "auto") return approvedBy === "system:auto";
  return !approvedBy.startsWith("system:");
}

/** PLAN-ADDENDUM-MONITOR §3 黑名單項目（strict；時間與 IP 規則以 refine 執行）。 */
export const BlocklistEntrySchema = z
  .strictObject({
    entry_id: z.uuid(),
    ip: z.string().refine(assertIpOrCidr, { message: "ip_or_cidr" }),
    source: z.enum(["manual", "auto"]),
    confidence: z.number().finite().min(0).max(1),
    case_id: z.uuid(),
    created_at: Rfc3339,
    expires_at: Rfc3339,
    approved_by: ApprovedBy,
    approved_at: Rfc3339,
    revoked_at: z.union([Rfc3339, z.null()]),
  })
  .refine((e) => e.source !== "auto" || isHostPrefix(e.ip), {
    message: "auto_host_prefix",
    path: ["ip"],
  })
  .refine((e) => approvedByMatchesSource(e.source, e.approved_by), {
    message: "approved_by_source",
    path: ["approved_by"],
  })
  .refine((e) => ts(e.expires_at) > ts(e.created_at), {
    message: "expires_after_created",
    path: ["expires_at"],
  })
  .refine((e) => {
    const c = ts(e.created_at);
    const a = ts(e.approved_at);
    const x = ts(e.expires_at);
    return c <= a && a <= x;
  }, {
    message: "approved_window",
    path: ["approved_at"],
  })
  .refine((e) => e.revoked_at === null || ts(e.revoked_at) >= ts(e.created_at), {
    message: "revoked_after_created",
    path: ["revoked_at"],
  });

export type BlocklistEntry = z.infer<typeof BlocklistEntrySchema>;
