import { describe, expect, it } from "vitest";
import { AllowlistCreateSchema, AllowlistEntrySchema, AllowlistUpdateSchema } from "../src/index.js";

/** reason 拒收 C0／C1 控制字元與 bidi 控制字元；長度 1–200；`<script>` 不擋（輸出端跳脫）。 */
const BAD = [
  "\u0000", "\u0001", "\t", "\n", "\r", "\u001f", "\u007f", "\u0080", "\u0085", "\u009f",
  "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069",
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
});
