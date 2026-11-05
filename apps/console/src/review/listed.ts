import type { Decision, ListedEntry, SourceFilter } from "./types";

export function filterListed(
  entries: ListedEntry[],
  filter: SourceFilter,
): ListedEntry[] {
  return entries.filter((e) => {
    if (e.revoked_at !== null) return false;
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
