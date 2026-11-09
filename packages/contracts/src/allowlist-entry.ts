import { z } from "zod";
import { assertAllowlistCidr } from "./ip-cidr.js";
import { Id, Reason, Rfc3339 } from "./primitives.js";

function expiresAfterCreated(createdAt: string, expiresAt: string | null): boolean {
  return expiresAt === null || Date.parse(expiresAt) > Date.parse(createdAt);
}

/** PLAN-ADDENDUM-MONITOR §3 白名單項目（cidr 可比黑名單寬）。 */
export const AllowlistEntrySchema = z
  .strictObject({
    entry_id: z.uuid(),
    cidr: z.string().refine(assertAllowlistCidr, { message: "allowlist_cidr" }),
    reason: Reason,
    created_by: Id,
    created_at: Rfc3339,
    expires_at: z.union([Rfc3339, z.null()]),
  })
  .refine((e) => expiresAfterCreated(e.created_at, e.expires_at), {
    message: "expires_after_created",
    path: ["expires_at"],
  });

export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;
