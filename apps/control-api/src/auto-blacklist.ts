import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { BlocklistEntrySchema, parseCidr, type BlocklistEntry } from "@semantic-defense/contracts";
import type { Db, Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import { loadThresholds, type WarnLog } from "./thresholds.js";
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
 * now：呼叫端必須傳 buildApp 注入的 clock（與撤回同一個；資安殘留 5），不得自行 Date.now()。
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

/** 讀一次未到期白名單，回判斷函式：ip（單一位址，可帶 /32、/128）是否落在其中（CIDR 包含）。判定 tick 每個 tick 讀一次。 */
export async function loadAllowlist(q: Queryable, now: number): Promise<(ip: string) => boolean> {
  const r = await q.query<{ cidr: string }>(
    "SELECT cidr FROM allowlist_entries WHERE expires_at IS NULL OR expires_at > $1", [now]);
  if (r.rows.length === 0) return () => false;
  const list = new BlockList();
  for (const { cidr } of r.rows) {
    const [addr, p] = cidr.split("/") as [string, string | undefined];
    const fam = family(addr);
    list.addSubnet(addr, p === undefined ? (fam === "ipv6" ? 128 : 32) : Number(p), fam);
  }
  return (ip) => { const addr = addrOf(ip); return list.check(addr, family(addr)); };
}

const allowlisted = async (q: Queryable, ip: string, now: number): Promise<boolean> => (await loadAllowlist(q, now))(ip);

/** 主機前綴正規化：合法 /32、/128（含無前綴）→ `<canonical address>/<prefix>`；否則 null。 */
export function hostCidr(raw: string): string | null {
  const p = parseCidr(raw);
  if (!p || p.prefix !== (p.version === 4 ? 32 : 128)) return null;
  return `${p.address}/${p.prefix}`;
}

export type AutoListOpts = { log?: WarnLog };

/**
 * tx 內版本（計畫 §7；判定 tick 在自己的 tx 裡呼叫）。白名單在這裡以 SHARE 鎖重新檢查：
 * tick 早先讀的白名單只用來決定要不要開案，不能當上榜依據（A 裁定 11-09）。
 * opts.log：門檻 fail-closed 時的 warn 去處（呼叫端傳 tick／app 的 logger）。
 */
export async function autoListInTx(q: Queryable, input: AutoListInput, now: number, opts: AutoListOpts = {}): Promise<AutoListResult> {
  const ip = hostCidr(input.ip);
  if (ip === null) return { status: "invalid_ip" };
  // 順序（A 裁定 11-09 第 2 點）：白名單（SHARE 鎖）→ below_auto → 冷卻 → AUTO_LOCK → 熔斷 → 寫入（冷卻、熔斷見 commit 10、11）
  await q.query("LOCK TABLE allowlist_entries IN SHARE MODE");
  if (await allowlisted(q, ip, now)) return { status: "allowlisted" };
  const { auto } = await loadThresholds(q, opts.log);
  if (!(input.confidence >= auto)) return { status: "below_auto_threshold" };
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
}

/** 外層包裝：自己開 tx，行為與拆分前相同。 */
export async function writeAutoBlocklistEntry(
  db: Db, input: AutoListInput, now: number, log?: WarnLog,
): Promise<AutoListResult> {
  if (hostCidr(input.ip) === null) return { status: "invalid_ip" };
  return db.tx((q) => autoListInTx(q, input, now, { log }));
}
