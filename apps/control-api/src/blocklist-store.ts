import type { BlocklistEntry } from "@semantic-defense/contracts";
import type { Queryable } from "./db.js";
import { BLOCKLIST_COLS, toBlocklistEntry, type BlocklistRow } from "./blacklist.js";

/**
 * 黑名單唯一生效寫入（成案流程 Q8／Q9）。所有寫入黑名單的路徑（自動、之後的人工核准）都走這裡，且須在呼叫端的 tx 內。
 * 1. sweep：同 IP 已過期但未結束的列設 ended_at = expires_at（過期列要等下次寫入才標 ended；讀取端仍須看 expires_at）。
 * 2. INSERT … ON CONFLICT (ip) WHERE ended_at IS NULL DO NOTHING：已有生效列 → 回 null，不延長、不中止 tx。
 * 並行：同鍵唯一索引檢查會等先寫者 commit，之後走 DO NOTHING；先寫者 rollback 則後寫者成功。
 */
export type BlocklistDraft = {
  entry_id: string; ip: string; source: "manual" | "auto"; confidence: number; case_id: string;
  created_at: number; expires_at: number; approved_by: string; approved_at: number;
};

export async function insertActiveBlocklistEntry(q: Queryable, d: BlocklistDraft, now: number): Promise<BlocklistEntry | null> {
  await q.query(
    "UPDATE blocklist_entries SET ended_at = expires_at WHERE ip = $1 AND ended_at IS NULL AND expires_at <= $2",
    [d.ip, now],
  );
  const r = await q.query<BlocklistRow>(
    `INSERT INTO blocklist_entries (${BLOCKLIST_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)
     ON CONFLICT (ip) WHERE ended_at IS NULL DO NOTHING RETURNING ${BLOCKLIST_COLS}`,
    [d.entry_id, d.ip, d.source, d.confidence, d.case_id, d.created_at, d.expires_at, d.approved_by, d.approved_at],
  );
  const row = r.rows[0];
  return row ? toBlocklistEntry(row) : null;
}
