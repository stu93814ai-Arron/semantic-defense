/**
 * 未授權來源 IP 速率限制（記憶體內、每 IP）。
 * - 僅計入認證失敗（401：缺／壞格式／找不到／錯 secret）
 * - 403（allowlist）與成功不計
 * - 來源 IP＝socket.remoteAddress（不讀 X-Forwarded-For）
 * - 約 AUTH_FAIL_LIMIT／AUTH_FAIL_WINDOW_MS → 429；窗口過後恢復 401
 * - Map 上限 maxKeys（預設 AUTH_FAIL_MAX_KEYS）：滿時先清已過窗的 key；仍滿則淘汰最久未活動、尚未達 429 的 key；
 *   封鎖中的 key 永不淘汰；若全是封鎖中的 key，新 key 不追蹤（照常走 Bearer 認證，不直接 429）。
 */

export const AUTH_FAIL_LIMIT = 30;
export const AUTH_FAIL_WINDOW_MS = 60_000;
export const AUTH_FAIL_MAX_KEYS = 10_000;

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
    check(ip, now) {
      return prune(ip, now).length >= AUTH_FAIL_LIMIT ? "limited" : "ok";
    },
    recordFail(ip, now) {
      const kept = prune(ip, now);
      hits.delete(ip);
      if (kept.length === 0 && !makeRoom(now)) return;
      kept.push(now);
      hits.set(ip, kept);
    },
    size: () => hits.size,
  };
}
