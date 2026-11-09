import type { Decision, ListedEntry, SourceFilter } from "./types";

function isExpired(entry: ListedEntry, now: string): boolean {
  return Date.parse(entry.expires_at) <= Date.parse(now);
}

/**
 * 已上榜清單篩選。排除已撤回；若提供 now，亦排除已到期。
 */
export function filterListed(
  entries: ListedEntry[],
  filter: SourceFilter,
  now?: string,
): ListedEntry[] {
  return entries.filter((e) => {
    if (e.revoked_at !== null) return false;
    if (now !== undefined && isExpired(e, now)) return false;
    if (filter === "all") return true;
    return e.source === filter;
  });
}

export function withdrawListed(
  entry: ListedEntry,
  ctx: { actorId: string; now: string },
): Decision<ListedEntry> {
  if (entry.revoked_at !== null) {
    return {
      ok: false,
      code: "already_revoked",
      message: "此項目已撤回",
    };
  }
  if (isExpired(entry, ctx.now)) {
    return {
      ok: false,
      code: "already_expired",
      message: "此項目已到期",
    };
  }
  const next: ListedEntry = { ...entry, revoked_at: ctx.now };
  return {
    ok: true,
    value: next,
    audit: {
      action: "blacklist.withdraw",
      actor_id: ctx.actorId,
      at: ctx.now,
      target_id: entry.entry_id,
      detail: entry.ip,
    },
  };
}
