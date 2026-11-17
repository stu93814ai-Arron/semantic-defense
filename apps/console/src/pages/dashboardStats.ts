import type { ListedEntry } from "../review/types";

export type ListedSummary = {
  total: number;
  todayAuto: number;
  todayManual: number;
  expiringWithin24h: number;
};

/** Asia/Taipei 無日光節約，日界為 UTC+8 午夜。 */
export function taipeiStartOfDayMs(nowMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return Date.parse(`${y}-${m}-${d}T00:00:00+08:00`);
}

export function summarizeListed(entries: ListedEntry[], nowIso: string): ListedSummary {
  const now = Date.parse(nowIso);
  const start = taipeiStartOfDayMs(now);
  const until = now + 24 * 60 * 60 * 1000;
  let todayAuto = 0;
  let todayManual = 0;
  let expiringWithin24h = 0;
  for (const e of entries) {
    const approved = Date.parse(e.approved_at);
    if (approved >= start && approved <= now) {
      if (e.source === "auto") todayAuto += 1;
      else todayManual += 1;
    }
    const exp = Date.parse(e.expires_at);
    if (exp > now && exp <= until) expiringWithin24h += 1;
  }
  return { total: entries.length, todayAuto, todayManual, expiringWithin24h };
}
