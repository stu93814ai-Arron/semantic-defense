import { describe, expect, it } from "vitest";
import { parseCidr } from "@semantic-defense/contracts";
import { hostCidr } from "../src/auto-blacklist.js";

/** A 組領航員裁示（未經使用者確認）；落在總召 §21:09 R10 範圍內。只加嚴 hostCidr，不改 parseCidr。 */
const CASES: Array<[string, string | null]> = [
  ["240.0.0.1", null], ["255.255.255.254", null],
  ["192.0.2.1", null], ["198.51.100.1", null], ["203.0.113.1", null],
  ["2001:db8::1", null], ["3fff::1", null],
  ["127.0.0.1", null], ["224.0.0.1", null], ["::1", null],
  ["10.0.0.1", "10.0.0.1/32"], ["192.168.1.1", "192.168.1.1/32"], ["fc00::1", "fc00::1/128"],
  ["64.0.113.20", "64.0.113.20/32"], ["2001:db9::1", "2001:db9::1/128"],
  ["100::1", "100::1/128"], ["2001:2::1", "2001:2::1/128"], ["198.18.0.1", "198.18.0.1/32"],
];

describe("hostCidr 排除 Class E 與文件範圍（剩餘 B5）", () => {
  it.each(CASES)("%s → %s", (ip, expected) => {
    expect(hostCidr(ip)).toBe(expected);
  });

  it("parseCidr 仍接受文件範圍與 Class E（契約未改）", () => {
    expect(parseCidr("192.0.2.1")).toEqual({ version: 4, address: "192.0.2.1", prefix: 32 });
    expect(parseCidr("240.0.0.1")).toEqual({ version: 4, address: "240.0.0.1", prefix: 32 });
    expect(parseCidr("2001:db8::1")).toEqual({ version: 6, address: "2001:db8::1", prefix: 128 });
  });
});
