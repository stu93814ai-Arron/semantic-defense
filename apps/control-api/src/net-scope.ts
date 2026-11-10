import { BlockList, isIP } from "node:net";

/**
 * B5（資安，high）：自動上榜只收全域單播（公網）位址。排除清單是常數、不可注入。
 * 內嵌 v4（::ffff:0:0/96、64:ff9b::/96、64:ff9b:1::/48、2002::/16）先取出再依 v4 規則判；並排除 fec0::/10。
 */
const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const NON_PUBLIC_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128], ["::1", 128], ["fe80::", 10], ["fec0::", 10], ["fc00::", 7], ["ff00::", 8], ["2001:db8::", 32],
];

const NON_PUBLIC = new BlockList();
for (const [a, p] of NON_PUBLIC_V4) NON_PUBLIC.addSubnet(a, p, "ipv4");
for (const [a, p] of NON_PUBLIC_V6) NON_PUBLIC.addSubnet(a, p, "ipv6");

function hextets(part: string | undefined): number[] | null {
  if (!part) return [];
  const out: number[] = [];
  for (const x of part.split(":").filter((s) => s.length > 0)) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(x)) return null;
    out.push(Number.parseInt(x, 16));
  }
  return out;
}

function rewriteV4Tail(addr: string): string | null {
  if (!addr.includes(".")) return addr;
  const i = addr.lastIndexOf(":");
  if (i < 0) return null;
  const v4 = addr.slice(i + 1);
  if (isIP(v4) !== 4) return null;
  const [a, b, c, d] = v4.split(".").map((x) => Number(x));
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return `${addr.slice(0, i + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

function groupsToBytes(groups: number[]): Uint8Array | null {
  if (groups.length !== 8) return null;
  const [a, b, c, d, e, f, g, h] = groups;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  if (e === undefined || f === undefined || g === undefined || h === undefined) return null;
  return Uint8Array.of(
    a >> 8, a & 0xff, b >> 8, b & 0xff, c >> 8, c & 0xff, d >> 8, d & 0xff,
    e >> 8, e & 0xff, f >> 8, f & 0xff, g >> 8, g & 0xff, h >> 8, h & 0xff,
  );
}

/** 把 IPv6 展開成 16 bytes；含末段點分十進位。失敗回 null。 */
function ipv6ToBytes(addr: string): Uint8Array | null {
  const s = rewriteV4Tail(addr);
  if (s === null) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = hextets(halves[0]);
  if (!left) return null;
  if (halves.length === 1) return groupsToBytes(left);
  const right = hextets(halves[1]);
  if (!right) return null;
  const mid = 8 - left.length - right.length;
  if (mid < 0) return null;
  return groupsToBytes([...left, ...Array<number>(mid).fill(0), ...right]);
}

function v4At(dv: DataView, i: number): string {
  return `${dv.getUint8(i)}.${dv.getUint8(i + 1)}.${dv.getUint8(i + 2)}.${dv.getUint8(i + 3)}`;
}

function viewOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function zeros(dv: DataView, start: number, n: number): boolean {
  for (let i = 0; i < n; i++) if (dv.getUint8(start + i) !== 0) return false;
  return true;
}

function fromMapped(dv: DataView): string | null {
  if (!zeros(dv, 0, 10) || dv.getUint8(10) !== 0xff || dv.getUint8(11) !== 0xff) return null;
  return v4At(dv, 12);
}

function fromNat96(dv: DataView): string | null {
  if (dv.getUint16(0) !== 0x0064 || dv.getUint16(2) !== 0xff9b || !zeros(dv, 4, 8)) return null;
  return v4At(dv, 12);
}

function fromNat48(dv: DataView): string | null {
  if (dv.getUint16(0) !== 0x0064 || dv.getUint16(2) !== 0xff9b || dv.getUint16(4) !== 0x0001) return null;
  return `${dv.getUint8(6)}.${dv.getUint8(7)}.${dv.getUint8(9)}.${dv.getUint8(10)}`;
}

function from6to4(dv: DataView): string | null {
  if (dv.getUint16(0) !== 0x2002) return null;
  return v4At(dv, 2);
}

/** 依指定前綴取出內嵌 v4；對不上前綴則 null。64:ff9b:1::/48 依 RFC 6052（略過 u 位元組）。 */
function embeddedV4(addr: string): string | null {
  const b = ipv6ToBytes(addr);
  if (!b) return null;
  const dv = viewOf(b);
  return fromMapped(dv) ?? fromNat96(dv) ?? fromNat48(dv) ?? from6to4(dv);
}

function isPublicV4(addr: string): boolean {
  return isIP(addr) === 4 && !NON_PUBLIC.check(addr, "ipv4");
}

/** ip：單一位址，可帶 /32、/128。不是合法位址、內嵌 v4 非公網、或落在排除清單 → false。 */
export function isGlobalUnicast(ip: string): boolean {
  const addr = ip.split("/")[0]!;
  const v = isIP(addr);
  if (v === 0) return false;
  if (v === 6) {
    const inner = embeddedV4(addr);
    if (inner !== null && !isPublicV4(inner)) return false;
  }
  return !NON_PUBLIC.check(addr, v === 6 ? "ipv6" : "ipv4");
}
