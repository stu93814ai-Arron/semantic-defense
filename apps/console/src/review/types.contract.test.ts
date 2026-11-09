import { describe, expect, it } from "vitest";
import {
  AllowlistEntrySchema,
  BlocklistEntrySchema,
  PendingCandidateSchema,
} from "@semantic-defense/contracts/browser";
import type { AllowlistItem, ListedEntry, PendingCandidate } from "./types";

describe("console 類型對齊 contracts（欄位形狀）", () => {
  it("PendingCandidate 核心欄位可過 PendingCandidateSchema", () => {
    const c: PendingCandidate = {
      ip: "203.0.113.10/32",
      confidence: 0.55,
      case_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-11-05T00:00:00Z",
      hit_count: 1,
      last_hit_at: "2026-11-05T00:00:00Z",
      candidate_id: "legacy",
    };
    expect(
      PendingCandidateSchema.safeParse({
        ip: c.ip,
        confidence: c.confidence,
        case_id: c.case_id,
        created_at: c.created_at,
        hit_count: c.hit_count,
        last_hit_at: c.last_hit_at,
      }).success,
    ).toBe(true);
  });

  it("ListedEntry 在 entry_id 為 UUID 時可過 BlocklistEntrySchema", () => {
    const e: ListedEntry = {
      entry_id: "22222222-2222-4222-8222-222222222222",
      ip: "203.0.113.10/32",
      source: "manual",
      confidence: 0.55,
      case_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-11-05T00:00:00Z",
      expires_at: "2026-11-06T01:00:00Z",
      approved_by: "operator1",
      approved_at: "2026-11-05T01:00:00Z",
      revoked_at: null,
    };
    expect(BlocklistEntrySchema.safeParse(e).success).toBe(true);
  });

  it("AllowlistItem 在 entry_id 為 UUID 時可過 AllowlistEntrySchema", () => {
    const a: AllowlistItem = {
      entry_id: "33333333-3333-4333-8333-333333333333",
      cidr: "203.0.113.0/24",
      reason: "夥伴",
      created_by: "admin1",
      created_at: "2026-11-05T00:00:00Z",
      expires_at: null,
    };
    expect(AllowlistEntrySchema.safeParse(a).success).toBe(true);
  });
});
