/** Browser／Vite 用 node:net.isIP 最小相容實作（供 contracts ip-cidr）。 */
export function isIP(input: string): 0 | 4 | 6 {
  if (typeof input !== "string" || input.length === 0) return 0;
  if (isIpv4(input)) return 4;
  if (isIpv6(input)) return 6;
  return 0;
}

function isIpv4(input: string): boolean {
  const parts = input.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return false;
    if (Number(p) > 255) return false;
  }
  return true;
}

function hextetsOk(parts: string[]): boolean {
  return parts.every((part) => /^[0-9a-fA-F]{1,4}$/.test(part));
}

function splitHextets(side: string | undefined): string[] {
  if (!side) return [];
  return side.split(":");
}

function isIpv6(input: string): boolean {
  if (input.includes(".") || input.includes("%")) return false;
  const sides = input.split("::");
  if (sides.length > 2) return false;
  const doubled = sides.length === 2;
  const head = splitHextets(sides[0]);
  const tail = doubled ? splitHextets(sides[1]) : [];
  if (doubled && head.length + tail.length > 7) return false;
  if (!doubled && head.length !== 8) return false;
  return hextetsOk([...head, ...tail]);
}
