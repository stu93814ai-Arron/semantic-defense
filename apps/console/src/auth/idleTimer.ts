export type IdleTimer = {
  touch: () => void;
  stop: () => void;
};

type TimerId = ReturnType<typeof globalThis.setTimeout>;

export type IdleTimerOptions = {
  timeoutMs: number;
  onIdle: () => void;
  setTimer?: (fn: () => void, ms: number) => TimerId;
  clearTimer?: (id: TimerId) => void;
};

/** 讀取閒置逾時；VITE_IDLE_TIMEOUT_MS 僅測試／建置覆寫，預設 30 分。 */
export function resolveIdleTimeoutMs(
  env: Record<string, string | undefined> = {},
): number {
  const raw = env.VITE_IDLE_TIMEOUT_MS ?? env.IDLE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

/**
 * 客戶端閒置計時：逾時呼叫 onIdle（導回登入）。
 * 伺服器 idle 仍為權威；此計時避免過期 session 殘留 UI。
 */
export function startIdleTimer(opts: IdleTimerOptions): IdleTimer {
  const setTimer = opts.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => globalThis.clearTimeout(id));
  let id: TimerId | undefined;

  const arm = () => {
    if (id !== undefined) clearTimer(id);
    id = setTimer(() => {
      id = undefined;
      opts.onIdle();
    }, opts.timeoutMs);
  };

  arm();
  return {
    touch: arm,
    stop: () => {
      if (id !== undefined) clearTimer(id);
      id = undefined;
    },
  };
}
