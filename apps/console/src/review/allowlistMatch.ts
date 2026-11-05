import type { AllowlistItem } from "./types";

/** 簡易 IPv4 字串比對：精確 host 或同址（CIDR 完整實作後可擴充）。 */
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

function parsePrefix(cidr: string): { ip: string; prefix: number } | null {
  const [ip, raw] = cidr.split("/");
  if (!ip) return null;
  if (raw === undefined) return { ip, prefix: 32 };
  if (!/^\d{1,3}$/.test(raw)) return null;
  const prefix = Number(raw);
  if (prefix < 0 || prefix > 32) return null;
  return { ip, prefix };
}

/** 候選 IP 是否落在任一白名單 CIDR（目前支援 IPv4）。 */
export function ipOnAllowlist(ip: string, allowlist: AllowlistItem[]): boolean {
  const target = ipv4ToInt(ip);
  if (target === null) {
    return allowlist.some((a) => a.cidr === ip || a.cidr.startsWith(`${ip}/`));
  }
  for (const item of allowlist) {
    const parsed = parsePrefix(item.cidr);
    if (!parsed) continue;
    const base = ipv4ToInt(parsed.ip);
    if (base === null) continue;
    if (parsed.prefix === 32) {
      if (base === target) return true;
      continue;
    }
    const mask = parsed.prefix === 0 ? 0 : (~0 << (32 - parsed.prefix)) >>> 0;
    if ((base & mask) === (target & mask)) return true;
  }
  return false;
}
