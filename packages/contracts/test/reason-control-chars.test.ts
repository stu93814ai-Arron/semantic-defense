import { describe, expect, it } from "vitest";
import { AllowlistCreateSchema, AllowlistEntrySchema, AllowlistUpdateSchema } from "../src/index.js";

/** reason 拒收 C0／C1 控制字元、bidi 控制字元、零寬／分隔／BOM 等不可見字元與未配對 surrogate；長度 1–200；`<script>` 不擋（輸出端跳脫）。 */
const BAD = [
  "\u0000", "\u0001", "\t", "\n", "\r", "\u001f", "\u007f", "\u0080", "\u0085", "\u009f",
  "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069",
  // 資安 R2：ALM、行／段分隔、BOM、零寬（ZWSP／ZWNJ／ZWJ）、WJ 與不可見運算子
  "\u061c", "\u2028", "\u2029", "\ufeff", "\u200b", "\u200c", "\u200d", "\u2060", "\u2061", "\u2062", "\u2063", "\u2064",
  // 資安殘留 2：Unicode 類別 Cc／Cf／Zl／Zp（軟連字號、蒙古文母音分隔、交錯註解、tag 字元）＋ Lo 的填充字元 U+115F、U+3164
  "\u00ad", "\u180e", "\ufff9", "\ufffa", "\ufffb", "\u{e0000}", "\u{e0001}", "\u{e0020}", "\u{e007f}", "\u115f", "\u3164",
  // 資安退回 R2：Hangul 填充 U+1160、半形填充 U+FFA0、組合字素連接 U+034F（Mn，不屬 Cf）；變體選擇符見下方逐一測
  "\u1160", "\uffa0", "\u034f",
  // 未配對 surrogate
  "\ud800", "\udbff", "\udc00", "\udfff",
];
const hex = (s: string) => `U+${s.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}`;
const ENTRY = {
  entry_id: "22222222-2222-4222-8222-222222222222", cidr: "10.0.0.0/8", reason: "ok", created_by: "admin1",
  created_at: "2026-11-09T00:00:00Z", expires_at: null,
};
const schemas = [
  ["AllowlistCreate", AllowlistCreateSchema, { cidr: "10.0.0.0/8", reason: "ok", expires_at: null }],
  ["AllowlistUpdate", AllowlistUpdateSchema, { reason: "ok", expires_at: null }],
  ["AllowlistEntry", AllowlistEntrySchema, ENTRY],
] as const;

describe.each(schemas)("%s.reason", (_n, schema, base) => {
  it.each(BAD.map((c) => [hex(c), c]))("拒收 %s（單獨、夾在中間）", (_h, c) => {
    expect(schema.safeParse({ ...base, reason: c }).success).toBe(false);
    expect(schema.safeParse({ ...base, reason: `辦公室${c}出口` }).success).toBe(false);
  });
  it("接受一般文字、中文、<script>、emoji、U+00A0；長度 1–200", () => {
    for (const r of ["辦公室出口", "<script>alert(1)</script>", "VPN 🔒", "a\u00a0b", "x".repeat(200), "x"]) {
      expect(schema.safeParse({ ...base, reason: r }).success, r).toBe(true);
    }
    expect(schema.safeParse({ ...base, reason: "" }).success).toBe(false);
    expect(schema.safeParse({ ...base, reason: "x".repeat(201) }).success).toBe(false);
  });
  it("U+E0000–E007F（tag 區）整段逐一拒收", () => {
    for (let cp = 0xe0000; cp <= 0xe007f; cp += 1) {
      expect(schema.safeParse({ ...base, reason: `a${String.fromCodePoint(cp)}b` }).success, hex(String.fromCodePoint(cp))).toBe(false);
    }
  });
  it.each([["U+FE00–FE0F", 0xfe00, 0xfe0f], ["U+E0100–E01EF", 0xe0100, 0xe01ef]] as const)("變體選擇符 %s 逐一拒收（資安退回 R2）", (_r, lo, hi) => {
    for (let cp = lo; cp <= hi; cp += 1) {
      const c = String.fromCodePoint(cp);
      expect(schema.safeParse({ ...base, reason: c }).success, hex(c)).toBe(false);
      expect(schema.safeParse({ ...base, reason: `a${c}b` }).success, hex(c)).toBe(false);
    }
  });
  it("刻意：擋 U+FE0F 會連帶擋掉帶 emoji 變體的寫法（❤️）；不帶變體的 ❤、🔒 仍接受", () => {
    expect(schema.safeParse({ ...base, reason: "\u2764\ufe0f" }).success).toBe(false);
    for (const r of ["\u2764", "VPN 🔒"]) expect(schema.safeParse({ ...base, reason: r }).success, r).toBe(true);
  });
  it("surrogate 順序顛倒（低位在前）→ 拒收；正常配對（emoji）→ 接受", () => {
    expect(schema.safeParse({ ...base, reason: "a\udc00\ud800b" }).success).toBe(false);
    expect(schema.safeParse({ ...base, reason: "a\ud83d\udd12b" }).success).toBe(true);
  });
  it("不依賴 String.prototype.isWellFormed（ES2024；舊瀏覽器沒有）：單獨高位、單獨低位拒收，配對 emoji 接受", () => {
    const proto = String.prototype as unknown as Record<string, unknown>;
    const saved = proto.isWellFormed;
    delete proto.isWellFormed;
    try {
      for (const r of ["x\ud83dy", "\ud83d", "\udd12x", "\ud83d\ud83d\udd12", "\ud83d\udd12\udd12"]) {
        expect(schema.safeParse({ ...base, reason: r }).success, JSON.stringify(r)).toBe(false);
      }
      for (const r of ["a\ud83d\udd12b", "🔒🔒", "😀 ok"]) expect(schema.safeParse({ ...base, reason: r }).success, r).toBe(true);
    } finally {
      proto.isWellFormed = saved;
    }
  });
});
