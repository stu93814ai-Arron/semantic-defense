import { describe, expect, it } from "vitest";
import {
  parseCaseSummary,
  parseConstraintDraft,
  parseRequestEvent,
} from "../src/index.js";
import { loadFixture } from "./helpers/loadFixture.js";

/**
 * 驗收準則 2：三份契約的列舉限制。
 * - 請求事件 response_class：read | write | auth | admin
 * - 案件摘要 from_family / to_family / privileged_target：同上家族詞彙
 * - 限制草案 subject.type：actor | session；action：log | deny
 *   from_state / to_state：與 response_class 同一家族詞彙
 */

const validEvent = () => loadFixture<Record<string, unknown>>("events/normal-read.json");
const validCase = () =>
  loadFixture<Record<string, unknown>>("cases/same-intent-read-to-admin.json");

const validDraft = (): Record<string, unknown> => ({
  app_id: "orders-app",
  route_family: "orders",
  from_state: "read",
  to_state: "admin",
  subject: { type: "actor", id: "actor-42" },
  action: "deny",
  expires_at: "2026-11-05T13:00:00Z",
});

const FAMILY = ["read", "write", "auth", "admin"] as const;

describe("準則2：三份契約列舉限制", () => {
  describe("請求事件 response_class", () => {
    it.each(FAMILY)("接受合法值 %s", (value) => {
      const result = parseRequestEvent({ ...validEvent(), response_class: value });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.response_class).toBe(value);
      }
    });

    it("拒絕非法 response_class", () => {
      for (const bad of ["delete", "READ", "Execute", "", "admin ", 1, null]) {
        const result = parseRequestEvent({
          ...validEvent(),
          response_class: bad,
        });
        expect(result.ok).toBe(false);
      }
    });
  });

  describe("案件摘要家族欄位", () => {
    it("拒絕非法 from_family / to_family / privileged_target", () => {
      const base = validCase();
      const transitions = base.transitions as Record<string, unknown>[];

      expect(
        parseCaseSummary({
          ...base,
          transitions: [{ ...transitions[0], from_family: "superuser" }],
        }).ok,
      ).toBe(false);

      expect(
        parseCaseSummary({
          ...base,
          transitions: [{ ...transitions[0], to_family: "root" }],
        }).ok,
      ).toBe(false);

      expect(
        parseCaseSummary({
          ...base,
          privileged_target: "everything",
        }).ok,
      ).toBe(false);
    });

    it("接受合法家族列舉組合", () => {
      const result = parseCaseSummary(validCase());
      expect(result.ok).toBe(true);
    });
  });

  describe("限制草案 subject.type 與 action", () => {
    it.each(["actor", "session"] as const)("接受 subject.type=%s", (type) => {
      const result = parseConstraintDraft({
        ...validDraft(),
        subject: { type, id: "x" },
      });
      expect(result.ok).toBe(true);
    });

    it("拒絕非法 subject.type", () => {
      for (const bad of ["user", "role", "Actor", "", null]) {
        const result = parseConstraintDraft({
          ...validDraft(),
          subject: { type: bad, id: "x" },
        });
        expect(result.ok).toBe(false);
      }
    });

    it.each(["log", "deny"] as const)("接受 action=%s", (action) => {
      const result = parseConstraintDraft({ ...validDraft(), action });
      expect(result.ok).toBe(true);
    });

    it("拒絕非法 action", () => {
      for (const bad of ["allow", "block", "DENY", "", null]) {
        const result = parseConstraintDraft({ ...validDraft(), action: bad });
        expect(result.ok).toBe(false);
      }
    });

    it("拒絕非法 from_state / to_state", () => {
      expect(
        parseConstraintDraft({ ...validDraft(), from_state: "unknown" }).ok,
      ).toBe(false);
      expect(
        parseConstraintDraft({ ...validDraft(), to_state: "sudo" }).ok,
      ).toBe(false);
    });
  });

  it("列舉錯誤以 ok:false 回傳，絕不拋例外", () => {
    expect(() =>
      parseRequestEvent({ ...validEvent(), response_class: "nope" }),
    ).not.toThrow();
    expect(() =>
      parseConstraintDraft({ ...validDraft(), action: "allow" }),
    ).not.toThrow();
  });
});
