import { describe, expect, it } from "vitest";
import {
  parseCaseSummary,
  parseRequestEvent,
  toCaseSummary,
} from "../src/index.js";
import { fixtureJsonText, loadFixture } from "./helpers/loadFixture.js";

/**
 * 驗收準則 3：從事件與案件摘要無法還原參數原文。
 */

type AttackMeta = {
  attack_text: string;
  forbidden_substrings: string[];
};

function assertNoLeak(serialized: string, meta: AttackMeta) {
  expect(serialized.includes(meta.attack_text)).toBe(false);
  for (const s of meta.forbidden_substrings) {
    expect(serialized.includes(s)).toBe(false);
  }
}

describe("準則3：事件／案件摘要無法還原參數原文", () => {
  const meta = loadFixture<AttackMeta>("meta/instruction-attack-raw.json");

  it("假事件 JSON 本身不含攻擊參數原文", () => {
    const text = fixtureJsonText("events/instruction-attempt-sanitized.json");
    assertNoLeak(text, meta);
  });

  it("假案件摘要 JSON 本身不含攻擊參數原文", () => {
    const text = fixtureJsonText("cases/instruction-attempt-sanitized.json");
    assertNoLeak(text, meta);
  });

  it("parseRequestEvent 成功值序列化後仍不含參數原文", () => {
    const input = loadFixture("events/instruction-attempt-sanitized.json");
    const result = parseRequestEvent(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    assertNoLeak(JSON.stringify(result.value), meta);
    for (const role of result.value.param_roles) {
      expect(Object.keys(role).sort()).toEqual(["name", "type"]);
      expect(role).not.toHaveProperty("value");
    }
  });

  it("parseCaseSummary 成功值序列化後仍不含參數原文", () => {
    const input = loadFixture("cases/instruction-attempt-sanitized.json");
    const result = parseCaseSummary(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    assertNoLeak(JSON.stringify(result.value), meta);
  });

  it("toCaseSummary(events) 產出不得含參數原文或可還原片段", () => {
    const events = [
      loadFixture("events/same-intent-a-read.json"),
      loadFixture("events/same-intent-b-read.json"),
      loadFixture("events/same-intent-c-read.json"),
      loadFixture("events/same-intent-admin-export.json"),
      loadFixture("events/instruction-attempt-sanitized.json"),
    ];
    const parsed = events.map((e) => {
      const r = parseRequestEvent(e);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      return r.value;
    });
    const summary = toCaseSummary(parsed);
    assertNoLeak(JSON.stringify(summary), meta);
  });

  it("route_template 僅為模板，不嵌入攻擊原文", () => {
    const input = loadFixture<Record<string, unknown>>(
      "events/instruction-attempt-sanitized.json",
    );
    const result = parseRequestEvent(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route_template).toBe("/orders/{id}");
    assertNoLeak(result.value.route_template, meta);
  });
});
