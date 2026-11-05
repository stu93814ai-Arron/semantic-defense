import { describe, expect, it } from "vitest";
import { loadFixture } from "./helpers/loadFixture.js";

/**
 * 驗收準則 4：假資料可被測試重複讀取（決定性）。
 */

const PATHS = [
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
  "meta/instruction-attack-raw.json",
] as const;

describe("準則4：假資料可重複讀取", () => {
  it.each(PATHS)("連續讀取兩次 deep equal：%s", (path) => {
    const first = loadFixture(path);
    const second = loadFixture(path);
    expect(second).toEqual(first);
  });

  it("同一意圖三種路徑模板與平常操作、指示情境檔案皆存在且穩定", () => {
    const a = loadFixture<Record<string, unknown>>("events/same-intent-a-read.json");
    const b = loadFixture<Record<string, unknown>>("events/same-intent-b-read.json");
    const c = loadFixture<Record<string, unknown>>("events/same-intent-c-read.json");
    const admin = loadFixture<Record<string, unknown>>(
      "events/same-intent-admin-export.json",
    );
    const summary = loadFixture<Record<string, unknown>>(
      "cases/same-intent-read-to-admin.json",
    );

    expect(new Set([a.route_template, b.route_template, c.route_template]).size).toBe(
      3,
    );
    expect(a.response_class).toBe("read");
    expect(b.response_class).toBe("read");
    expect(c.response_class).toBe("read");
    expect(admin.response_class).toBe("admin");

    const transitions = summary.transitions as Array<{
      from_family: string;
      to_family: string;
    }>;
    expect(transitions).toEqual([
      expect.objectContaining({ from_family: "read", to_family: "admin" }),
    ]);

    const again = loadFixture("cases/same-intent-read-to-admin.json");
    expect(again).toEqual(summary);
  });

  it("平常操作假資料僅描述 read／write 轉移且可重複讀取", () => {
    const first = loadFixture<Record<string, unknown>>("cases/normal-read-write.json");
    const second = loadFixture<Record<string, unknown>>("cases/normal-read-write.json");
    expect(second).toEqual(first);
    const transitions = first.transitions as Array<{
      from_family: string;
      to_family: string;
    }>;
    for (const t of transitions) {
      expect(["read", "write"]).toContain(t.from_family);
      expect(["read", "write"]).toContain(t.to_family);
      expect(t.from_family === "admin" || t.to_family === "admin").toBe(false);
    }
  });
});
