import { describe, expect, it } from "vitest";
import { nextIndex } from "./roving";

describe("nextIndex", () => {
  it("方向鍵循環；Home／End；無關鍵 null", () => {
    expect(nextIndex("ArrowRight", 0, 2)).toBe(1);
    expect(nextIndex("ArrowDown", 1, 2)).toBe(0);
    expect(nextIndex("ArrowLeft", 0, 2)).toBe(1);
    expect(nextIndex("ArrowUp", 1, 2)).toBe(0);
    expect(nextIndex("Home", 1, 2)).toBe(0);
    expect(nextIndex("End", 0, 2)).toBe(1);
    expect(nextIndex("Tab", 0, 2)).toBeNull();
    expect(nextIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
