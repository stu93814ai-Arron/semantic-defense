/**
 * 未授權來源 IP 速率限制（記憶體內、每 IP）。
 * - 僅計入認證失敗（401：缺／壞格式／找不到／錯 secret）
 * - 403（allowlist）與成功不計
 * - 來源 IP＝socket.remoteAddress（不讀 X-Forwarded-For）
 * - 約 AUTH_FAIL_LIMIT／AUTH_FAIL_WINDOW_MS → 429；窗口過後恢復 401
 */

export const AUTH_FAIL_LIMIT = 30;
export const AUTH_FAIL_WINDOW_MS = 60_000;

export type AuthFailLimiter = {
  /** 若窗口內失敗次數已達上限 → "limited"。 */
  check(ip: string, now: number): "ok" | "limited";
  /** 記一筆認證失敗（僅 401 路徑呼叫）。 */
  recordFail(ip: string, now: number): void;
};

/** 建立 per-IP 失敗計數器；時鐘由呼叫端注入。 */
export function createAuthFailLimiter(): AuthFailLimiter {
  const hits = new Map<string, number[]>();

  const prune = (ip: string, now: number): number[] => {
    const cutoff = now - AUTH_FAIL_WINDOW_MS;
    const kept = (hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) hits.delete(ip);
    else hits.set(ip, kept);
    return kept;
  };

  return {
    check(ip, now) {
      return prune(ip, now).length >= AUTH_FAIL_LIMIT ? "limited" : "ok";
    },
    recordFail(ip, now) {
      const kept = prune(ip, now);
      kept.push(now);
      hits.set(ip, kept);
    },
  };
}
