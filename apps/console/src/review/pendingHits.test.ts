import { describe, expect, it } from "vitest";
import { formatPendingHits } from "./pendingHits";

describe("待審命中摘要（hit_count／last_hit_at）", () => {
  it("顯示累加次數與最後命中時間", () => {
    expect(
      formatPendingHits({ hit_count: 2, last_hit_at: "2026-11-05T01:00:00Z" }),
    ).toBe("命中 2 次；最後 2026-11-05T01:00:00Z");
    expect(
      formatPendingHits({ hit_count: 1, last_hit_at: "2026-11-05T00:00:00Z" }),
    ).toBe("命中 1 次；最後 2026-11-05T00:00:00Z");
  });
});
