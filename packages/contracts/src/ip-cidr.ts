// 不引用 node 內建（瀏覽器入口 ./browser 會帶入本檔）；ipVersion 行為對齊 node:net isIP。
import { ipVersion } from "./ip-literal.js";

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

/** RFC 5952：小寫、無前導 0、壓縮最長零段（並列時取左側）。 */
function longestZeroRun(parts: readonly number[]): { start: number; len: number } {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (const [idx, value] of parts.entries()) {
    if (value === 0) {
      if (runStart < 0) runStart = idx;
      runLen += 1;
      continue;
    }
    if (runLen >= 2 && runLen > bestLen) {
      bestStart = runStart;
      bestLen = runLen;
    }
    runStart = -1;
    runLen = 0;
  }
  if (runLen >= 2 && runLen > bestLen) {
    bestStart = runStart;
    bestLen = runLen;
  }
  return { start: bestStart, len: bestLen };
}

function formatCanonicalIpv6(parts: number[]): string {
  const { start, len } = longestZeroRun(parts);
  const hex = (n: number) => n.toString(16);
  if (start < 0) return parts.map(hex).join(":");
  const head = parts.slice(0, start).map(hex).join(":");
  const tail = parts.slice(start + len).map(hex).join(":");
  return `${head}::${tail}`;
}

function isIpv4Mapped(parts: number[]): boolean {
  return (
    parts[0] === 0 &&
    parts[1] === 0 &&
    parts[2] === 0 &&
    parts[3] === 0 &&
    parts[4] === 0 &&
    parts[5] === 0xffff
  );
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

/** wide=true：白名單 IPv4 ≥/8、IPv6 ≥/32（仍拒 /0）。 */
function prefixInRange(version: 4 | 6, prefix: number, wide: boolean): boolean {
  if (prefix < 1) return false;
  if (version === 4) {
    const min = wide ? 8 : 24;
    return prefix >= min && prefix <= 32;
  }
  const min = wide ? 32 : 64;
  return prefix >= min && prefix <= 128;
}

/** 拒前導 0（如 024）；無斜線 → 主機前綴。 */
function parsePrefix(prefixTok: string | null, version: 4 | 6, wide: boolean): number | null {
  if (prefixTok === null) return version === 4 ? 32 : 128;
  if (!/^[1-9]\d*$/.test(prefixTok)) return null;
  const prefix = Number(prefixTok);
  if (!prefixInRange(version, prefix, wide)) return null;
  return prefix;
}

function checkV4(address: string, prefix: number): ParsedCidr | null {
  if (!hostBitsZeroV4(address, prefix) || reservedV4(address)) return null;
  return { version: 4, address, prefix };
}

function checkV6(address: string, prefix: number): ParsedCidr | null {
  const parts = expandIpv6(address);
  if (!parts) return null;
  // 強制字面 canonical：不符即拒，不改寫接受
  if (formatCanonicalIpv6(parts) !== address) return null;
  if (isIpv4Mapped(parts)) return null;
  if (!hostBitsZeroV6(parts, prefix) || reservedV6(parts)) return null;
  return { version: 6, address, prefix };
}

function parseCidrMode(raw: string, wide: boolean): ParsedCidr | null {
  if (typeof raw !== "string" || raw.includes("%") || raw.includes(" ")) return null;
  const slash = raw.indexOf("/");
  const address = slash === -1 ? raw : raw.slice(0, slash);
  const prefixTok = slash === -1 ? null : raw.slice(slash + 1);
  const version = ipVersion(address);
  if (version === 0) return null;
  const prefix = parsePrefix(prefixTok, version, wide);
  if (prefix === null) return null;
  return version === 4 ? checkV4(address, prefix) : checkV6(address, prefix);
}

/**
 * 黑名單用 IP／CIDR：無前綴 → /32|/128；IPv4 ≥/24；IPv6 ≥/64；
 * 拒 /0、主機位非零、保留、%、非 RFC5952、IPv4-mapped。
 */
export function parseCidr(raw: string): ParsedCidr | null {
  return parseCidrMode(raw, false);
}

/** 供 schema refine：合法且通過黑名單 IP 規則則 true。 */
export function assertIpOrCidr(raw: string): boolean {
  return parseCidr(raw) !== null;
}

/**
 * 白名單 CIDR：IPv4 ≥/8、IPv6 ≥/32；仍拒 /0、主機位非零、
 * 保留、%、非 canonical、IPv4-mapped。
 */
export function assertAllowlistCidr(raw: string): boolean {
  return parseCidrMode(raw, true) !== null;
}

/** auto 來源僅允許主機前綴 /32、/128（含無斜線寫法）。 */
export function isHostPrefix(raw: string): boolean {
  const p = parseCidr(raw);
  return p !== null && ((p.version === 4 && p.prefix === 32) || (p.version === 6 && p.prefix === 128));
}

/**
 * 流量紀錄用單一 IP：拒 /、%、空白；IPv6 須 RFC5952 canonical 且非 IPv4-mapped。
 * 與黑名單同一套字面規則，但**不**拒保留位址（流量紀錄非封鎖對象）。
 */
export function assertFlowSingleIp(raw: string): boolean {
  if (typeof raw !== "string" || raw.includes("/") || raw.includes("%") || raw.includes(" ")) return false;
  const version = ipVersion(raw);
  if (version === 4) return true;
  if (version !== 6) return false;
  const parts = expandIpv6(raw);
  if (!parts) return false;
  return formatCanonicalIpv6(parts) === raw && !isIpv4Mapped(parts);
}

/** A 組領航員裁示（未經使用者確認）；落在總召 §21:09 R10 範圍內。不含 100::/64、2001:2::/48、198.18/15。 */
const INGEST_RESERVED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
  ["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24],
];

function rewriteV4Tail(addr: string): string | null {
  if (!addr.includes(".")) return addr;
  const i = addr.lastIndexOf(":");
  if (i < 0) return null;
  const v4 = addr.slice(i + 1);
  if (ipVersion(v4) !== 4) return null;
  const [a, b, c, d] = v4.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return `${addr.slice(0, i + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

function mappedV4(addr: string): string | null {
  const s = rewriteV4Tail(addr);
  if (s === null) return null;
  const parts = expandIpv6(s);
  if (!parts || !isIpv4Mapped(parts)) return null;
  return `${parts[6]! >> 8}.${parts[6]! & 0xff}.${parts[7]! >> 8}.${parts[7]! & 0xff}`;
}

function reservedIngestV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return INGEST_RESERVED_V4.some(([base, bits]) => ((n ^ ipv4ToInt(base)) >>> (32 - bits)) === 0);
}

function reservedIngestV6(parts: number[]): boolean {
  if (parts.every((p) => p === 0)) return true;
  if (parts.slice(0, 7).every((p) => p === 0) && parts[7] === 1) return true;
  if ((parts[0]! & 0xffc0) === 0xfe80) return true;
  if ((parts[0]! & 0xff00) === 0xff00) return true;
  if (parts[0] === 0x2001 && parts[1] === 0xdb8) return true;
  return parts[0] === 0x3fff && (parts[1]! & 0xf000) === 0;
}

/**
 * ingest／hostCidr 共用的保留與文件範圍（含 ::ffff: 內嵌 v4）。
 * RFC1918 與 ULA 回 false。非法字串回 false。
 */
export function isReservedForIngest(ip: string): boolean {
  if (typeof ip !== "string" || ip.includes("/") || ip.includes("%") || ip.includes(" ")) return false;
  const inner = mappedV4(ip);
  if (inner !== null) return reservedIngestV4(inner);
  if (ipVersion(ip) === 4) return reservedIngestV4(ip);
  const parts = expandIpv6(ip);
  return parts !== null && reservedIngestV6(parts);
}
