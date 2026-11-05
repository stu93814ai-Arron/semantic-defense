import { describe, expect, it } from "vitest";
import {
  parseCaseSummary,
  parseRequestEvent,
  toCaseSummary,
} from "../src/index.js";
import { fixtureJsonText, loadFixture } from "./helpers/loadFixture.js";

/**
 * 驗收準則 5：帶指示參數不得進入事件或摘要。
 */

type AttackMeta = {
  attack_text: string;
  forbidden_substrings: string[];
  param_name: string;
};

describe("準則5：帶指示參數不得進入事件或摘要", () => {
  const meta = loadFixture<AttackMeta>("meta/instruction-attack-raw.json");

  it("若輸入事件夾帶指示參數值／本文，parseRequestEvent 必須拒絕", () => {
    const base = loadFixture<Record<string, unknown>>(
      "events/instruction-attempt-sanitized.json",
    );

    const poisonedVariants: Record<string, unknown>[] = [
      { ...base, params: { [meta.param_name]: meta.attack_text } },
      { ...base, body: meta.attack_text },
      { ...base, prompt: meta.attack_text },
      {
        ...base,
        param_roles: [
          { name: meta.param_name, type: "string", value: meta.attack_text },
        ],
      },
      {
        ...base,
        route_template: `/orders/${meta.attack_text}`,
      },
    ];

    for (const input of poisonedVariants) {
      const result = parseRequestEvent(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    }
  });

  it("消毒後的事件／摘要 fixture 全文零命中攻擊原文", () => {
    for (const path of [
      "events/instruction-attempt-sanitized.json",
      "cases/instruction-attempt-sanitized.json",
    ]) {
      const text = fixtureJsonText(path);
      expect(text.includes(meta.attack_text)).toBe(false);
      for (const s of meta.forbidden_substrings) {
        expect(text.includes(s)).toBe(false);
      }
    }
  });

  it("消毒事件經 parse 後，指示原文仍不得出現", () => {
    const result = parseRequestEvent(
      loadFixture("events/instruction-attempt-sanitized.json"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const blob = JSON.stringify(result.value);
    expect(blob.includes(meta.attack_text)).toBe(false);
  });

  it("消毒摘要經 parse 後，指示原文仍不得出現", () => {
    const result = parseCaseSummary(
      loadFixture("cases/instruction-attempt-sanitized.json"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const blob = JSON.stringify(result.value);
    expect(blob.includes(meta.attack_text)).toBe(false);
  });

  it("toCaseSummary 不得把指示原文帶進摘要", () => {
    const eventResult = parseRequestEvent(
      loadFixture("events/instruction-attempt-sanitized.json"),
    );
    expect(eventResult.ok).toBe(true);
    if (!eventResult.ok) return;
    const summary = toCaseSummary([eventResult.value]);
    const blob = JSON.stringify(summary);
    expect(blob.includes(meta.attack_text)).toBe(false);
    for (const s of meta.forbidden_substrings) {
      expect(blob.includes(s)).toBe(false);
    }
  });

  it("攻擊原文只存在 meta，不存在任何 events/ 或 cases/ 契約假資料", () => {
    const metaText = fixtureJsonText("meta/instruction-attack-raw.json");
    expect(metaText.includes(meta.attack_text)).toBe(true);

    for (const path of [
      "events/same-intent-a-read.json",
      "events/same-intent-b-read.json",
      "events/same-intent-c-read.json",
      "events/same-intent-admin-export.json",
      "events/normal-read.json",
      "events/normal-write.json",
      "events/instruction-attempt-sanitized.json",
      "cases/same-intent-read-to-admin.json",
      "cases/normal-read-write.json",
      "cases/instruction-attempt-sanitized.json",
    ]) {
      const text = fixtureJsonText(path);
      expect(text.includes(meta.attack_text)).toBe(false);
    }
  });
});
