import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { BlocklistEntrySchema, assertIpOrCidr, isHostPrefix, type BlocklistEntry } from "@semantic-defense/contracts";
import type { Db, Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import { loadThresholds } from "./thresholds.js";
import { BLOCKLIST_COLS, toBlocklistEntry, type BlocklistRow } from "./blacklist.js";

/**
 * ④ source=auto 寫入邊界（內部函式，不開 HTTP）。不含觸發條件（命中次數、去重、冷卻、熔斷）。
 * 1. ip 只收 /32、/128（contracts ip-cidr 規則）→ 否則 invalid_ip。
 * 2. 同一 tx 內：鎖白名單（SHARE，擋並行新增／修改），讀目前 auto 門檻；confidence < auto → below_auto_threshold。
 * 3. 命中未到期白名單 → allowlisted（白名單永遠優先，不上榜）。
 * 4. 寫入黑名單項目（approved_by=system:auto、created_at=approved_at=now、expires_at=now+24h）
 *    與 blacklist.auto_list 稽核（信心、依據 case_id、時間）同一 tx。
 */
export const AUTO_LIST_TTL_MS = 24 * 60 * 60 * 1000;
export type AutoListInput = { ip: string; confidence: number; case_id: string };
export type AutoListResult =
  | { status: "listed"; entry: BlocklistEntry }
  | { status: "invalid_ip" }
  | { status: "below_auto_threshold" }
  | { status: "allowlisted" };

const addrOf = (s: string) => s.split("/")[0]!;
const family = (addr: string) => (isIP(addr) === 6 ? "ipv6" : "ipv4");

async function allowlisted(q: Queryable, ip: string, now: number): Promise<boolean> {
  const r = await q.query<{ cidr: string }>(
    "SELECT cidr FROM allowlist_entries WHERE expires_at IS NULL OR expires_at > $1", [now]);
  if (r.rows.length === 0) return false;
  const list = new BlockList();
  for (const { cidr } of r.rows) {
    const [addr, p] = cidr.split("/") as [string, string | undefined];
    const fam = family(addr);
    list.addSubnet(addr, p === undefined ? (fam === "ipv6" ? 128 : 32) : Number(p), fam);
  }
  const addr = addrOf(ip);
  return list.check(addr, family(addr));
}

export async function writeAutoBlocklistEntry(db: Db, input: AutoListInput, now: number): Promise<AutoListResult> {
  if (!assertIpOrCidr(input.ip) || !isHostPrefix(input.ip)) return { status: "invalid_ip" };
  return db.tx(async (q): Promise<AutoListResult> => {
    await q.query("LOCK TABLE allowlist_entries IN SHARE MODE");
    const { auto } = await loadThresholds(q);
    if (!(input.confidence >= auto)) return { status: "below_auto_threshold" };
    if (await allowlisted(q, input.ip, now)) return { status: "allowlisted" };
    const draft = BlocklistEntrySchema.parse({
      entry_id: randomUUID(), ip: input.ip, source: "auto", confidence: input.confidence, case_id: input.case_id,
      created_at: new Date(now).toISOString(), expires_at: new Date(now + AUTO_LIST_TTL_MS).toISOString(),
      approved_by: "system:auto", approved_at: new Date(now).toISOString(), revoked_at: null,
    });
    const r = await q.query<BlocklistRow>(
      `INSERT INTO blocklist_entries (${BLOCKLIST_COLS}) VALUES ($1,$2,'auto',$3,$4,$5,$6,'system:auto',$5,NULL)
       RETURNING ${BLOCKLIST_COLS}`,
      [draft.entry_id, draft.ip, draft.confidence, draft.case_id, now, now + AUTO_LIST_TTL_MS],
    );
    const entry = toBlocklistEntry(r.rows[0]!);
    await writeAudit(q, { action: "blacklist.auto_list", actor: "system:auto", sensor_id: null, at: now,
      detail: { entry_id: entry.entry_id, ip: entry.ip, confidence: entry.confidence, case_id: entry.case_id, expires_at: entry.expires_at } });
    return { status: "listed", entry };
  });
}
