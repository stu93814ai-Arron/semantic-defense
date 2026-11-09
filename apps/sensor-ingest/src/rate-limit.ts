import { isIP } from "node:net";

/**
 * 未授權來源 IP 速率限制（記憶體內、每 IP）。
 * - 僅計入認證失敗（401：缺／壞格式／找不到／錯 secret）
 * - 403（allowlist）與成功不計；有效 token 的請求完全不查限流（guard 先驗 Bearer）
 * - 來源 IP＝socket.remoteAddress（不讀 X-Forwarded-For）
 * - 約 AUTH_FAIL_LIMIT／AUTH_FAIL_WINDOW_MS → 429；窗口過後恢復 401
 * - 計數鍵（authFailKey）：IPv4 以 /32；IPv4-mapped IPv6（::ffff:a.b.c.d）視同 IPv4；其餘 IPv6 以 /64（大小寫、展開寫法皆正規化）
 * - Map 上限 maxKeys（預設 AUTH_FAIL_MAX_KEYS）：滿時先清已過窗的 key；仍滿則淘汰最久未活動、尚未達 429 的 key；
 *   封鎖中的 key 永不淘汰；若全是封鎖中的 key，新 key 不追蹤（照常走 Bearer 認證，不直接 429）。
 */

export const AUTH_FAIL_LIMIT = 30;
export const AUTH_FAIL_WINDOW_MS = 60_000;
export const AUTH_FAIL_MAX_KEYS = 10_000;

/** IPv6 文字 → 8 個 16-bit 數值；非法 → null。 */
function ipv6Words(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    if (isIP(v4[2]!) !== 4) return null;
    const [a, b, c, d] = v4[2]!.split(".").map(Number) as [number, number, number, number];
    s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => parseInt(h, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const words = halves.length === 2 ? [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail] : head;
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** 速率限制計數鍵：IPv4 → 原位址；IPv4-mapped → IPv4；IPv6 → 前 64 位元（/64）；無法解析 → 原字串。 */
export function authFailKey(ip: string): string {
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return ip;
  const w = ipv6Words(ip.replace(/%.*$/, ""));
  if (!w) return ip;
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
    return [w[6]! >> 8, w[6]! & 0xff, w[7]! >> 8, w[7]! & 0xff].join(".");
  }
  return `${w.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

export type AuthFailLimiter = {
  /** 若窗口內失敗次數已達上限 → "limited"。 */
  check(ip: string, now: number): "ok" | "limited";
  /** 記一筆認證失敗（僅 401 路徑呼叫）。 */
  recordFail(ip: string, now: number): void;
  /** 目前追蹤的 key 數（測試／觀測用）。 */
  size(): number;
};

/** 建立 per-IP 失敗計數器；時鐘由呼叫端注入。Map 依「最後活動」排序（recordFail 會移到尾端）。 */
export function createAuthFailLimiter(opts: { maxKeys?: number } = {}): AuthFailLimiter {
  const maxKeys = opts.maxKeys ?? AUTH_FAIL_MAX_KEYS;
  const hits = new Map<string, number[]>();

  const prune = (ip: string, now: number): number[] => {
    const cutoff = now - AUTH_FAIL_WINDOW_MS;
    const kept = (hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) hits.delete(ip);
    else hits.set(ip, kept);
    return kept;
  };

  /** 為新 key 騰出空間；騰不出（全是封鎖中）→ false。 */
  const makeRoom = (now: number): boolean => {
    if (hits.size < maxKeys) return true;
    for (const ip of [...hits.keys()]) prune(ip, now);
    if (hits.size < maxKeys) return true;
    for (const [ip, ts] of hits) {
      if (ts.length < AUTH_FAIL_LIMIT) {
        hits.delete(ip);
        return true;
      }
    }
    return false;
  };

  return {
    check(addr, now) {
      const ip = authFailKey(addr);
      return prune(ip, now).length >= AUTH_FAIL_LIMIT ? "limited" : "ok";
    },
    recordFail(addr, now) {
      const ip = authFailKey(addr);
      const kept = prune(ip, now);
      hits.delete(ip);
      if (kept.length === 0 && !makeRoom(now)) return;
      kept.push(now);
      hits.set(ip, kept);
    },
    size: () => hits.size,
  };
}
