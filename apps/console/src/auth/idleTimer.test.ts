import { describe, expect, it, vi } from "vitest";
import { resolveIdleTimeoutMs, startIdleTimer } from "./idleTimer";

describe("resolveIdleTimeoutMs", () => {
  it("預設 30 分鐘", () => {
    expect(resolveIdleTimeoutMs({})).toBe(30 * 60_000);
    expect(resolveIdleTimeoutMs({ VITE_IDLE_TIMEOUT_MS: "0" })).toBe(30 * 60_000);
    expect(resolveIdleTimeoutMs({ VITE_IDLE_TIMEOUT_MS: "nope" })).toBe(30 * 60_000);
  });

  it("接受 VITE_IDLE_TIMEOUT_MS／IDLE_TIMEOUT_MS", () => {
    expect(resolveIdleTimeoutMs({ VITE_IDLE_TIMEOUT_MS: "50" })).toBe(50);
    expect(resolveIdleTimeoutMs({ IDLE_TIMEOUT_MS: "100" })).toBe(100);
  });
});

describe("startIdleTimer", () => {
  it("逾時觸發 onIdle；touch 重置；stop 取消", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const timer = startIdleTimer({ timeoutMs: 50, onIdle });
    vi.advanceTimersByTime(49);
    expect(onIdle).not.toHaveBeenCalled();
    timer.touch();
    vi.advanceTimersByTime(49);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();

    onIdle.mockClear();
    const t2 = startIdleTimer({ timeoutMs: 20, onIdle });
    t2.stop();
    vi.advanceTimersByTime(100);
    expect(onIdle).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
