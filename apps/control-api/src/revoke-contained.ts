import type { Queryable } from "./db.js";
import { writeAudit } from "./audit.js";

/** 同一交易：撤回被 CIDR 完全包含且仍生效的封鎖，並為每筆寫 blacklist.revoke。無列則不寫稽核。 */
export async function revokeContainedBlocks(
  q: Queryable,
  opts: { cidr: string; allowlistEntryId: string; actor: string; at: number },
): Promise<void> {
  const revoked = await q.query<{ entry_id: string; ip: string; source: string; case_id: string }>(
    `UPDATE blocklist_entries SET revoked_at = $2, ended_at = COALESCE(ended_at, $2)
     WHERE revoked_at IS NULL AND ended_at IS NULL AND created_at <= $2 AND ip::inet <<= $1::inet
     RETURNING entry_id, ip, source, case_id`,
    [opts.cidr, opts.at],
  );
  for (const b of revoked.rows) {
    await writeAudit(q, {
      action: "blacklist.revoke", actor: opts.actor, sensor_id: null, at: opts.at,
      detail: { entry_id: b.entry_id, ip: b.ip, source: b.source, case_id: b.case_id, allowlist_entry_id: opts.allowlistEntryId },
    });
  }
}
