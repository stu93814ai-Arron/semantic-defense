import { describe, expect, it } from "vitest";
import {
  AUTO_MIN_CONFIDENCE,
  REVIEW_MIN_CONFIDENCE,
  isPendingConfidence,
} from "./pendingBand";

describe("待審信心帶邊界（V2-DECISIONS §2／contracts CASE／AUTO）", () => {
  it("常數對齊 contracts 0.5／0.9", () => {
    expect(REVIEW_MIN_CONFIDENCE).toBe(0.5);
    expect(AUTO_MIN_CONFIDENCE).toBe(0.9);
  });

  it("0.50 含在待審；略低不含", () => {
    expect(isPendingConfidence(0.5)).toBe(true);
    expect(isPendingConfidence(0.499999999)).toBe(false);
  });

  it("0.90 不含在待審（自動上榜）；略低含", () => {
    expect(isPendingConfidence(0.9)).toBe(false);
    expect(isPendingConfidence(0.899999999)).toBe(true);
  });

  it("帶內典型值進待審", () => {
    expect(isPendingConfidence(0.55)).toBe(true);
    expect(isPendingConfidence(0.89)).toBe(true);
  });
});

describe("待審信心帶可讀取動態門檻", () => {
  it("未傳 thresholds 時仍用預設 0.5／0.9", () => {
    expect(isPendingConfidence(0.5)).toBe(true);
    expect(isPendingConfidence(0.9)).toBe(false);
  });

  it("傳入自訂 thresholds 時依 case／auto 判斷", () => {
    expect(isPendingConfidence(0.6, { case: 0.7, auto: 0.95 })).toBe(false);
    expect(isPendingConfidence(0.7, { case: 0.7, auto: 0.95 })).toBe(true);
    expect(isPendingConfidence(0.95, { case: 0.7, auto: 0.95 })).toBe(false);
  });
});
