/**
 * 純 TS 的 IP 字面判定，行為對齊 node:net isIP（不引用 node 內建，供瀏覽器入口）。
 * 回傳 4／6／0。IPv4：四段十進位 0–255、無前導 0。IPv6：1–4 位十六進位、至多一個 `::`、
 * 末段可內嵌 IPv4、可帶非空 zone（`%…`）。對齊性由 test/ip-literal.test.ts 與 node:net 比對鎖住。
 */
const V4_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEXTET = /^[0-9a-fA-F]{1,4}$/;

function isV4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => V4_OCTET.test(p));
}

/** 去掉 zone（`%…`）；zone 為空 → null。 */
function stripZone(raw: string): string | null {
  const zone = raw.indexOf("%");
  if (zone === -1) return raw;
  return zone === raw.length - 1 ? null : raw.slice(0, zone);
}

function isV6(raw: string): boolean {
  const s = stripZone(raw);
  if (s === null) return false;
  const sides = s.split("::");
  if (sides.length > 2) return false;
  const groups = (side: string) => (side === "" ? [] : side.split(":"));
  const head = groups(sides[0]!);
  const tail = sides.length === 2 ? groups(sides[1]!) : [];
  // 內嵌 IPv4 只能是整個位址的最後一段（佔 2 個 hextet）
  const end = sides.length === 2 ? tail : head;
  let count = head.length + tail.length;
  if (end[end.length - 1]?.includes(".")) {
    if (!isV4(end.pop()!)) return false;
    count += 1;
  }
  if (![...head, ...tail].every((g) => HEXTET.test(g))) return false;
  return sides.length === 2 ? count <= 7 : count === 8;
}

export function ipVersion(s: string): 0 | 4 | 6 {
  if (isV4(s)) return 4;
  return s.includes(":") && isV6(s) ? 6 : 0;
}
