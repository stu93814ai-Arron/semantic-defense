import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { BlocklistEntrySchema, parseCidr, type BlocklistEntry } from "@semantic-defense/contracts";
import type { Db, Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import { loadThresholds } from "./thresholds.js";
import { insertActiveBlocklistEntry } from "./blocklist-store.js";

/**
 * ④ source=auto 寫入邊界（內部函式，不開 HTTP）。不含觸發條件（命中次數、去重、冷卻、熔斷）。
 * 1. ip 只收 /32、/128（contracts ip-cidr 規則，IPv6 須已是 canonical 小寫）→ 否則 invalid_ip。
 *    存放一律正規化為 `<address>/32` 或 `<address>/128`（單一 IP 與帶前綴寫法存成同一值）。
 * 2. 同一 tx 內：鎖白名單（SHARE，擋並行新增／修改），讀目前 auto 門檻；confidence < auto → below_auto_threshold。
 * 3. 命中未到期白名單 → allowlisted（白名單永遠優先，不上榜）。
 * 4. 經 insertActiveBlocklistEntry 寫入（同 IP 已有生效列 → already_listed：不延長、不寫稽核）；
 *    黑名單項目 approved_by=system:auto、created_at=approved_at=now、expires_at=now+24h
 *    與 blacklist.auto_list 稽核（信心、依據 case_id、時間）同一 tx。
 */
export const AUTO_LIST_TTL_MS = 24 * 60 * 60 * 1000;
export type AutoListInput = { ip: string; confidence: number; case_id: string };
export type AutoListResult =
  | { status: "listed"; entry: BlocklistEntry }
  | { status: "invalid_ip" }
  | { status: "below_auto_threshold" }
  | { status: "allowlisted" }
  | { status: "already_listed" };

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

/** 主機前綴正規化：合法 /32、/128（含無前綴）→ `<canonical address>/<prefix>`；否則 null。 */
export function hostCidr(raw: string): string | null {
  const p = parseCidr(raw);
  if (!p || p.prefix !== (p.version === 4 ? 32 : 128)) return null;
  return `${p.address}/${p.prefix}`;
}

export async function writeAutoBlocklistEntry(db: Db, input: AutoListInput, now: number): Promise<AutoListResult> {
  const ip = hostCidr(input.ip);
  if (ip === null) return { status: "invalid_ip" };
  return db.tx(async (q): Promise<AutoListResult> => {
    await q.query("LOCK TABLE allowlist_entries IN SHARE MODE");
    const { auto } = await loadThresholds(q);
    if (!(input.confidence >= auto)) return { status: "below_auto_threshold" };
    if (await allowlisted(q, ip, now)) return { status: "allowlisted" };
    const draft = BlocklistEntrySchema.parse({
      entry_id: randomUUID(), ip, source: "auto", confidence: input.confidence, case_id: input.case_id,
      created_at: new Date(now).toISOString(), expires_at: new Date(now + AUTO_LIST_TTL_MS).toISOString(),
      approved_by: "system:auto", approved_at: new Date(now).toISOString(), revoked_at: null,
    });
    const entry = await insertActiveBlocklistEntry(q, {
      entry_id: draft.entry_id, ip: draft.ip, source: "auto", confidence: draft.confidence, case_id: draft.case_id,
      created_at: now, expires_at: now + AUTO_LIST_TTL_MS, approved_by: "system:auto", approved_at: now,
    }, now);
    if (!entry) return { status: "already_listed" };
    await writeAudit(q, { action: "blacklist.auto_list", actor: "system:auto", sensor_id: null, at: now,
      detail: { entry_id: entry.entry_id, ip: entry.ip, confidence: entry.confidence, case_id: entry.case_id, expires_at: entry.expires_at } });
    return { status: "listed", entry };
  });
}
