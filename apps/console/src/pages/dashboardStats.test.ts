import { describe, expect, it } from "vitest";
import type { ListedEntry } from "../review/types";
import { summarizeListed, taipeiStartOfDayMs } from "./dashboardStats";

function entry(partial: Partial<ListedEntry> & Pick<ListedEntry, "entry_id" | "source">): ListedEntry {
  return {
    ip: "198.51.100.1",
    confidence: 0.9,
    case_id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-11-16T00:00:00Z",
    expires_at: "2026-11-18T00:00:00Z",
    approved_by: partial.source === "auto" ? "system:auto" : "operator1",
    approved_at: "2026-11-16T00:00:00Z",
    revoked_at: null,
    ...partial,
  };
}

describe("taipeiStartOfDayMs", () => {
  it("以 Asia/Taipei 日界，而非 UTC 午夜", () => {
    // 2026-11-17 00:30 台北 = 2026-11-16T16:30:00Z
    const start = taipeiStartOfDayMs(Date.parse("2026-11-16T16:30:00Z"));
    expect(start).toBe(Date.parse("2026-11-16T16:00:00Z"));
  });
});

describe("summarizeListed", () => {
  const now = "2026-11-16T16:30:00Z";

  it("合計全部列，並只把今日（台北）核准列入今日自動／人工", () => {
    const rows = [
      entry({ entry_id: "today-auto", source: "auto", approved_at: "2026-11-16T16:10:00Z" }),
      entry({ entry_id: "today-manual", source: "manual", approved_at: "2026-11-16T16:20:00Z" }),
      entry({ entry_id: "yesterday", source: "auto", approved_at: "2026-11-16T15:59:00Z" }),
    ];
    expect(summarizeListed(rows, now)).toEqual({
      total: 3,
      todayAuto: 1,
      todayManual: 1,
      expiringWithin24h: 0,
    });
  });

  it("24 小時內到期只計尚未到期者", () => {
    const rows = [
      entry({
        entry_id: "soon",
        source: "auto",
        approved_at: "2026-11-16T16:10:00Z",
        expires_at: "2026-11-17T10:00:00Z",
      }),
      entry({
        entry_id: "later",
        source: "manual",
        approved_at: "2026-11-16T16:10:00Z",
        expires_at: "2026-11-17T18:00:00Z",
      }),
      entry({
        entry_id: "past",
        source: "auto",
        approved_at: "2026-11-15T00:00:00Z",
        expires_at: "2026-11-16T16:00:00Z",
      }),
    ];
    expect(summarizeListed(rows, now).expiringWithin24h).toBe(1);
    expect(summarizeListed([], now)).toEqual({
      total: 0,
      todayAuto: 0,
      todayManual: 0,
      expiringWithin24h: 0,
    });
  });
});
