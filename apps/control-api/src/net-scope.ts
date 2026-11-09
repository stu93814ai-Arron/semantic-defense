import { BlockList, isIP } from "node:net";

/**
 * B5（資安，high）：自動上榜只收全域單播（公網）位址。排除清單是常數、不可注入。
 * IPv4-mapped（::ffff:a.b.c.d）依映射的 IPv4 分類（node:net BlockList 對 ipv6 查詢會比對 ipv4 規則）。
 */
const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const NON_PUBLIC_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128], ["::1", 128], ["fe80::", 10], ["fc00::", 7], ["ff00::", 8], ["2001:db8::", 32],
];

const NON_PUBLIC = new BlockList();
for (const [a, p] of NON_PUBLIC_V4) NON_PUBLIC.addSubnet(a, p, "ipv4");
for (const [a, p] of NON_PUBLIC_V6) NON_PUBLIC.addSubnet(a, p, "ipv6");

/** ip：單一位址，可帶 /32、/128。不是合法位址或落在排除清單 → false。 */
export function isGlobalUnicast(ip: string): boolean {
  const addr = ip.split("/")[0]!;
  const v = isIP(addr);
  if (v === 0) return false;
  return !NON_PUBLIC.check(addr, v === 6 ? "ipv6" : "ipv4");
}
