import { isIP } from "node:net";

export type ParsedCidr = {
  version: 4 | 6;
  address: string;
  prefix: number;
};

function ipv4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return (((p[0]!) << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
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

function splitIpv6Sides(ip: string): { head: string[]; tail: string[]; doubled: boolean } | null {
  if (ip.includes(".") || ip.includes("%")) return null;
  const sides = ip.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] === "" || sides[0] === undefined ? [] : sides[0].split(":");
  const doubled = sides.length === 2;
  const tail = !doubled
    ? []
    : sides[1] === "" || sides[1] === undefined
      ? []
      : sides[1].split(":");
  return { head, tail, doubled };
}

function expandIpv6(ip: string): number[] | null {
  const sides = splitIpv6Sides(ip);
  if (!sides) return null;
  const { head, tail, doubled } = sides;
  if (doubled) {
    const filled = head.length + tail.length;
    if (filled > 8) return null;
    return partsToHextets([...head, ...Array(8 - filled).fill("0"), ...tail]);
  }
  return partsToHextets(head);
}

function ipv6ToBigInt(parts: number[]): bigint {
  return parts.reduce((acc, n) => (acc << 16n) + BigInt(n), 0n);
}

function hostBitsZeroV4(ip: string, prefix: number): boolean {
  if (prefix === 32) return true;
  const hostMask = 0xffffffff >>> prefix;
  return (ipv4ToInt(ip) & hostMask) === 0;
}

function hostBitsZeroV6(parts: number[], prefix: number): boolean {
  if (prefix === 128) return true;
  const hostMask = (1n << (128n - BigInt(prefix))) - 1n;
  return (ipv6ToBigInt(parts) & hostMask) === 0n;
}

function reservedV4(ip: string): boolean {
  const [a, b, c, d] = ip.split(".").map(Number) as [number, number, number, number];
  if (a === 127 || a === 0) return true;
  if (a >= 224 && a <= 239) return true;
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return a === 169 && b === 254;
}

function reservedV6(parts: number[]): boolean {
  if (parts.every((p) => p === 0)) return true;
  if (parts.slice(0, 7).every((p) => p === 0) && parts[7] === 1) return true;
  if ((parts[0]! & 0xff00) === 0xff00) return true;
  return (parts[0]! & 0xffc0) === 0xfe80;
}

function prefixInRange(version: 4 | 6, prefix: number): boolean {
  return version === 4 ? prefix >= 24 && prefix <= 32 : prefix >= 64 && prefix <= 128;
}

function parsePrefix(prefixTok: string | null, version: 4 | 6): number | null {
  if (prefixTok === null) return version === 4 ? 32 : 128;
  if (!/^\d+$/.test(prefixTok)) return null;
  const prefix = Number(prefixTok);
  if (prefix === 0 || !prefixInRange(version, prefix)) return null;
  return prefix;
}

function checkV4(address: string, prefix: number): ParsedCidr | null {
  if (!hostBitsZeroV4(address, prefix) || reservedV4(address)) return null;
  return { version: 4, address, prefix };
}

function checkV6(address: string, prefix: number): ParsedCidr | null {
  const parts = expandIpv6(address);
  if (!parts || !hostBitsZeroV6(parts, prefix) || reservedV6(parts)) return null;
  return { version: 6, address, prefix };
}

/**
 * 解析並檢查黑名單／白名單用 IP 或 CIDR。
 * 無前綴 → /32 或 /128；IPv4 ≥/24；IPv6 ≥/64；拒 /0、主機位非零、保留位址、%。
 */
export function parseCidr(raw: string): ParsedCidr | null {
  if (typeof raw !== "string" || raw.includes("%") || raw.includes(" ")) return null;
  const slash = raw.indexOf("/");
  const address = slash === -1 ? raw : raw.slice(0, slash);
  const prefixTok = slash === -1 ? null : raw.slice(slash + 1);
  const version = isIP(address) as 0 | 4 | 6;
  if (version === 0) return null;
  const prefix = parsePrefix(prefixTok, version);
  if (prefix === null) return null;
  return version === 4 ? checkV4(address, prefix) : checkV6(address, prefix);
}

/** 供 schema refine：合法且通過契約 IP 規則則 true。 */
export function assertIpOrCidr(raw: string): boolean {
  return parseCidr(raw) !== null;
}

/** auto 來源僅允許主機前綴 /32、/128（含無斜線寫法）。 */
export function isHostPrefix(raw: string): boolean {
  const p = parseCidr(raw);
  return p !== null && ((p.version === 4 && p.prefix === 32) || (p.version === 6 && p.prefix === 128));
}
