import { describe, expect, it } from "vitest";
import {
  parseCaseSummary,
  parseConstraintDraft,
  parseRequestEvent,
} from "../src/index.js";
import { loadFixture } from "./helpers/loadFixture.js";

/**
 * 驗收準則 1：契約以外的欄位被拒絕（多一欄整份作廢）。
 * 對齊 PLAN.md「契約欄位只准用本檔所列」與 SECURITY A1–A4、A7–A8。
 */

const validEvent = () => loadFixture<Record<string, unknown>>("events/normal-read.json");
const validCase = () =>
  loadFixture<Record<string, unknown>>("cases/normal-read-write.json");
const validDraft = (): Record<string, unknown> => ({
  app_id: "orders-app",
  route_family: "orders",
  from_state: "read",
  to_state: "admin",
  subject: { type: "actor", id: "actor-42" },
  action: "deny",
  expires_at: "2026-11-05T13:00:00Z",
});

describe("準則1：契約外欄位被拒", () => {
  it("parseRequestEvent：頂層多餘欄位整份拒絕且不拋例外", () => {
    const input = { ...validEvent(), body: "secret-body" };
    const result = parseRequestEvent(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("parseRequestEvent：params / headers / prompt / raw 等別名欄位整份拒絕", () => {
    for (const extra of [
      { params: { id: "x" } },
      { headers: { authorization: "t" } },
      { prompt: "do something" },
      { raw: "..." },
      { param_values: { id: "x" } },
    ]) {
      const result = parseRequestEvent({ ...validEvent(), ...extra });
      expect(result.ok).toBe(false);
    }
  });

  it("parseRequestEvent：param_roles 元素含 value 等契約外欄位整份拒絕", () => {
    const input = {
      ...validEvent(),
      param_roles: [{ name: "id", type: "string", value: "should-not-exist" }],
    };
    const result = parseRequestEvent(input);
    expect(result.ok).toBe(false);
  });

  it("parseCaseSummary：頂層多餘欄位整份拒絕", () => {
    const result = parseCaseSummary({
      ...validCase(),
      model_hint: "block harder",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("parseCaseSummary：transitions 元素多餘欄位整份拒絕", () => {
    const base = validCase();
    const transitions = base.transitions as Record<string, unknown>[];
    const result = parseCaseSummary({
      ...base,
      transitions: [{ ...transitions[0], note: "extra" }],
    });
    expect(result.ok).toBe(false);
  });

  it("parseConstraintDraft：頂層多餘欄位（含指令／網址／說明）整份拒絕", () => {
    for (const extra of [
      { instruction: "block now" },
      { url: "https://evil.example/hook" },
      { rationale: "free text" },
      { message: "deny please" },
    ]) {
      const result = parseConstraintDraft({ ...validDraft(), ...extra });
      expect(result.ok).toBe(false);
    }
  });

  it("parseConstraintDraft：subject 多餘欄位整份拒絕", () => {
    const result = parseConstraintDraft({
      ...validDraft(),
      subject: { type: "actor", id: "actor-42", role: "admin" },
    });
    expect(result.ok).toBe(false);
  });

  it("parseConstraintDraft：簽名後欄位不得被草案路徑接受", () => {
    for (const extra of [
      { constraint_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      { signed_at: "2026-11-05T12:30:00Z" },
      { signature: "sig-fake" },
    ]) {
      const result = parseConstraintDraft({ ...validDraft(), ...extra });
      expect(result.ok).toBe(false);
    }
  });
});
