import { describe, expect, it } from "vitest";
import { ipOnAllowlist } from "./allowlistMatch";
import type { AllowlistItem } from "./types";

const item = (cidr: string): AllowlistItem => ({
  entry_id: `wl-${cidr}`,
  cidr,
  reason: "test",
  created_by: "admin1",
  created_at: "2026-11-05T00:00:00Z",
  expires_at: null,
});

describe("ipOnAllowlist IPv4／IPv6 CIDR 包含", () => {
  it("IPv4 精確與 CIDR 網段命中", () => {
    expect(ipOnAllowlist("203.0.113.10", [item("203.0.113.10")])).toBe(true);
    expect(ipOnAllowlist("203.0.113.50", [item("203.0.113.0/24")])).toBe(true);
    expect(ipOnAllowlist("203.0.114.1", [item("203.0.113.0/24")])).toBe(false);
  });

  it("IPv6 精確主機命中（含無斜線與 /128）", () => {
    expect(ipOnAllowlist("2001:db8::1", [item("2001:db8::1")])).toBe(true);
    expect(ipOnAllowlist("2001:db8::1", [item("2001:db8::1/128")])).toBe(true);
    expect(ipOnAllowlist("2001:db8::2", [item("2001:db8::1")])).toBe(false);
  });

  it("IPv6 CIDR 網段包含（非整串字串比對）", () => {
    expect(ipOnAllowlist("2001:db8::abcd", [item("2001:db8::/32")])).toBe(true);
    expect(ipOnAllowlist("2001:db8:1::1", [item("2001:db8::/32")])).toBe(true);
    expect(ipOnAllowlist("2001:db9::1", [item("2001:db8::/32")])).toBe(false);
    expect(ipOnAllowlist("2001:db8:0:1::1", [item("2001:db8::/48")])).toBe(true);
    expect(ipOnAllowlist("2001:db8:1::1", [item("2001:db8::/48")])).toBe(false);
  });

  it("IPv6 壓縮寫法與完整寫法視為同一主機", () => {
    expect(
      ipOnAllowlist("2001:0db8:0000:0000:0000:0000:0000:0001", [
        item("2001:db8::1"),
      ]),
    ).toBe(true);
  });
});
