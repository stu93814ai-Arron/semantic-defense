import { isIP } from "node:net";
import { describe, expect, it } from "vitest";
import { ipVersion } from "../src/ip-literal.js";

describe("ipVersion（純 TS）與 node:net isIP 行為一致", () => {
  const CORPUS = [
    "1.2.3.4", "0.0.0.0", "255.255.255.255", "01.2.3.4", "1.2.3.04", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.4 ", " 1.2.3.4",
    "1.2.3.4/24", "", ".", "1..2.3", "1.2.3.", "-1.2.3.4", "1e1.2.3.4", "0x1.2.3.4",
    "::", "::1", "1::", "0::0", "2001:db8::1", "2001:DB8::1", "2001:0db8:0000:0000:0000:0000:0000:0001", "1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::", "::2:3:4:5:6:7:8", "1::2::3", ":::", ":1::", "1:", ":1", "1:2:3:4:5:6:7", "00000::1",
    "12345::", "g::1", "::ffff:1.2.3.4", "::1.2.3.4", "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4", "::ffff:01.2.3.4",
    "::ffff:1.2.3", "1.2.3.4::", "::1.2.3.4:1", "fe80::1%eth0", "fe80::1%", "::1%1", "1.2.3.4%eth0", "2001:db8::/64",
  ];
  it.each(CORPUS)("%j", (s) => {
    expect(ipVersion(s)).toBe(isIP(s));
  });

  it("隨機字串 5000 筆一致", () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const alpha = "0123456789abcdefABCDEFg:.";
    for (let i = 0; i < 5000; i++) {
      let s = "";
      const len = rnd(24);
      for (let j = 0; j < len; j++) s += alpha[rnd(alpha.length)]!;
      expect([s, ipVersion(s)]).toEqual([s, isIP(s)]);
    }
  });

  it("結構化隨機（hextet／內嵌 IPv4／::／zone 組合）5000 筆一致，且涵蓋 4、6、0", () => {
    let seed = 777;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const OK = ["0", "1", "db8", "ffff", "FFFF", "0000", "1.2.3.4"];
    const BAD = ["00000", "12345", "g", "", "255.0.0.1", "01.2.3.4", "1.2.3"];
    const tok = () => (rnd(6) === 0 ? BAD : OK)[rnd(7)]!;
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const n = 1 + rnd(9);
      let s = "";
      for (let j = 0; j < n; j++) s += (j === 0 ? "" : rnd(4) === 0 ? "::" : ":") + tok();
      if (rnd(10) === 0) s += rnd(2) ? "%eth0" : "%";
      seen.add(isIP(s));
      expect([s, ipVersion(s)]).toEqual([s, isIP(s)]);
    }
    expect([...seen].sort()).toEqual([0, 4, 6]);
  });
});
