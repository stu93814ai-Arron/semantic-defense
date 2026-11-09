import type { AllowlistItem } from "./types";

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function partsToHextets(parts: string[]): number[] | null {
  if (parts.length !== 8) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    nums.push(parseInt(p, 16));
  }
  return nums;
}

function splitIpv6(ip: string): { head: string[]; tail: string[]; doubled: boolean } | null {
  if (ip.includes(".") || ip.includes("%")) return null;
  const sides = ip.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] === "" || sides[0] === undefined ? [] : sides[0].split(":");
  const doubled = sides.length === 2;
  const tail =
    !doubled || sides[1] === "" || sides[1] === undefined ? [] : sides[1].split(":");
  return { head, tail, doubled };
}

/** 展開 IPv6 為 8 個 hextet（含 ::）；失敗回 null。 */
export function expandIpv6(ip: string): number[] | null {
  const sides = splitIpv6(ip);
  if (!sides) return null;
  const { head, tail, doubled } = sides;
  if (!doubled) return partsToHextets(head);
  const filled = head.length + tail.length;
  if (filled > 8) return null;
  return partsToHextets([...head, ...Array(8 - filled).fill("0"), ...tail]);
}

function ipv6ToBigInt(parts: number[]): bigint {
  return parts.reduce((acc, n) => (acc << 16n) + BigInt(n), 0n);
}

function parsePrefix(cidr: string, max: number): { address: string; prefix: number } | null {
  const slash = cidr.indexOf("/");
  const address = slash === -1 ? cidr : cidr.slice(0, slash);
  if (!address) return null;
  if (slash === -1) return { address, prefix: max };
  const raw = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(raw)) return null;
  const prefix = Number(raw);
  if (prefix < 0 || prefix > max) return null;
  return { address, prefix };
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const target = ipv4ToInt(ip);
  if (target === null) return false;
  const parsed = parsePrefix(cidr, 32);
  if (!parsed) return false;
  const base = ipv4ToInt(parsed.address);
  if (base === null) return false;
  if (parsed.prefix === 32) return base === target;
  const mask = parsed.prefix === 0 ? 0 : (~0 << (32 - parsed.prefix)) >>> 0;
  return (base & mask) === (target & mask);
}

function ipv6PrefixMask(prefix: number): bigint {
  if (prefix === 0) return 0n;
  if (prefix === 128) return (1n << 128n) - 1n;
  return ((1n << BigInt(prefix)) - 1n) << (128n - BigInt(prefix));
}

function ipv6InCidr(ip: string, cidr: string): boolean {
  const targetParts = expandIpv6(ip);
  if (!targetParts) return false;
  const parsed = parsePrefix(cidr, 128);
  if (!parsed) return false;
  const baseParts = expandIpv6(parsed.address);
  if (!baseParts) return false;
  const mask = ipv6PrefixMask(parsed.prefix);
  return (ipv6ToBigInt(baseParts) & mask) === (ipv6ToBigInt(targetParts) & mask);
}


function ipFamily(ip: string): 0 | 4 | 6 {
  if (ipv4ToInt(ip) !== null) return 4;
  if (expandIpv6(ip) !== null) return 6;
  return 0;
}

/** 候選 IP 是否落在任一白名單 CIDR（IPv4 與 IPv6 皆做前綴包含判定）。 */
export function ipOnAllowlist(ip: string, allowlist: AllowlistItem[]): boolean {
  const fam = ipFamily(ip);
  if (fam === 0) return false;
  for (const item of allowlist) {
    const entryFam = ipFamily(item.cidr.split("/")[0] ?? "");
    if (entryFam !== fam) continue;
    if (fam === 4 && ipv4InCidr(ip, item.cidr)) return true;
    if (fam === 6 && ipv6InCidr(ip, item.cidr)) return true;
  }
  return false;
}
