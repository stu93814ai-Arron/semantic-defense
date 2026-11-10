import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { BlocklistEntrySchema, parseCidr, type BlocklistEntry } from "@semantic-defense/contracts";
import type { Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import { enqueueAlerts, type AlertChannel } from "./alert-outbox.js";
import { loadThresholds, type WarnLog } from "./thresholds.js";
import { insertActiveBlocklistEntry } from "./blocklist-store.js";
import { breakerTripped, lockAllowlistShare, lockAuto, maybeEnqueueVolume } from "./auto-breaker.js";
import { isGlobalUnicast } from "./net-scope.js";

/**
 * ④ source=auto 寫入邊界（內部函式，不開 HTTP）。觸發條件（命中次數）在 auto-trigger.ts；冷卻只在 opts.gates 開時檢查。
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
  | { status: "already_listed" }
  | { status: "cooldown"; revoked_at: number }
  | { status: "breaker" }
  | { status: "not_public" };

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

/** 冷卻：同一 canonical IP（完全相同；涵蓋它的 /24 不算）在這段時間內被撤回過（auto 或 manual）就不自動上榜。 */
export const AUTO_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/**
 * gates：E3.A 觸發才有的閘門（冷卻＋熔斷共用一個選項；A 組領航員裁定 11-09 第 4 點）。
 * 判定 tick 開（帶 breakerPerHour）；測試用的 §7 包裝（test/helpers/auto-list.ts）關，§7 原行為不變。
 */
export type AutoListOpts = { log?: WarnLog; gates?: false | { breakerPerHour: number }; afterShare?: () => Promise<void>; alertChannels?: readonly AlertChannel[] };

async function lastRevokedWithin(q: Queryable, ip: string, now: number): Promise<number | null> {
  const r = await q.query<{ revoked_at: string }>(
    "SELECT revoked_at FROM blocklist_entries WHERE ip = $1 AND revoked_at > $2 ORDER BY revoked_at DESC LIMIT 1",
    [ip, now - AUTO_COOLDOWN_MS]);
  return r.rows[0] ? Number(r.rows[0].revoked_at) : null;
}

/*
 * 全域鎖順序（A 覆核）：先 LOCK TABLE allowlist_entries IN SHARE MODE（lockAllowlistShare），再 AUTO_LOCK（lockAuto）。
 * 會拿 AUTO_LOCK 的路徑（autoListInTx、tick 的 recoverBreakerIfOpen）都照這個順序；新增呼叫端也必須先 SHARE，避免和白名單寫入形成死結。
 * 兩把鎖都持有到 tx 結束（判定 tick 即 tick commit）。
 */
/** 拿任何鎖之前的位址檢查：非法 → invalid_ip；B5 非公網（常數排除清單）→ not_public。 */
function scopeOf(raw: string): { ip: string } | { reject: AutoListResult } {
  const ip = hostCidr(raw);
  if (ip === null) return { reject: { status: "invalid_ip" } };
  return isGlobalUnicast(ip) ? { ip } : { reject: { status: "not_public" } };
}


/** SHARE 之後可選測試掛勾（tick 的 afterAllowlistShare）；不影響鎖順序。 */
async function lockShareThen(q: Queryable, then?: () => Promise<void>): Promise<void> {
  await lockAllowlistShare(q);
  if (then !== undefined) await then();
}

/**
 * tx 內版本（計畫 §7；判定 tick 在自己的 tx 裡呼叫）。白名單在這裡以 SHARE 鎖重新檢查：
 * tick 早先讀的白名單只用來決定要不要開案，不能當上榜依據（A 組領航員裁定 11-09）。
 * opts.log：門檻 fail-closed 時的 warn 去處（呼叫端傳 tick／app 的 logger）。
 */
async function maybeVolume(q: Queryable, opts: AutoListOpts, now: number): Promise<void> {
  if (!opts.gates) return;
  await maybeEnqueueVolume(q, opts.gates.breakerPerHour, now, opts.alertChannels ?? []);
}

async function recordAutoList(q: Queryable, entry: { entry_id: string; ip: string; confidence: number; case_id: string; expires_at: string }, now: number, channels: readonly AlertChannel[] | undefined): Promise<void> {
  const auditId = await writeAudit(q, { action: "blacklist.auto_list", actor: "system:auto", sensor_id: null, at: now,
    detail: { entry_id: entry.entry_id, ip: entry.ip, confidence: entry.confidence, case_id: entry.case_id, expires_at: entry.expires_at } });
  await enqueueAlerts(q, { channels: channels ?? [], kind: "auto_list", now, auditId, entryId: entry.entry_id, caseId: entry.case_id });
}

export async function autoListInTx(q: Queryable, input: AutoListInput, now: number, opts: AutoListOpts = {}): Promise<AutoListResult> {
  const scoped = scopeOf(input.ip);
  if ("reject" in scoped) return scoped.reject;
  const { ip } = scoped;
  // 順序（A 組領航員裁定 11-09 第 2 點）：白名單（SHARE 鎖）→ below_auto → 冷卻 → AUTO_LOCK → 熔斷 → 寫入（冷卻、熔斷見 commit 10、11）
  await lockShareThen(q, opts.afterShare);
  if (await allowlisted(q, ip, now)) return { status: "allowlisted" };
  const { auto } = await loadThresholds(q, opts.log);
  if (!(input.confidence >= auto)) return { status: "below_auto_threshold" };
  if (opts.gates) {
    const revokedAt = await lastRevokedWithin(q, ip, now);
    if (revokedAt !== null) return { status: "cooldown", revoked_at: revokedAt };
  }
  await lockAuto(q);
  if (opts.gates && (await breakerTripped(q, opts.gates.breakerPerHour, now, opts.log, opts.alertChannels))) return { status: "breaker" };
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
  await recordAutoList(q, entry, now, opts.alertChannels);
  await maybeVolume(q, opts, now);
  return { status: "listed", entry };
}
