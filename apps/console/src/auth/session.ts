import type { SessionUser } from "../roles";

export type LoginOutcome =
  | { ok: true; role: SessionUser["role"] }
  | { ok: false; message: string };

export type LoginResultLike =
  | { ok: true; user: SessionUser }
  | { ok: false; message: string };

/** 將 api login 結果轉成 AuthProvider 可用結果。 */
export function loginOutcomeFrom(result: LoginResultLike): LoginOutcome {
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, role: result.user.role };
}

export {
  resolveIdleTimeoutMs,
  startIdleTimer,
  type IdleTimer,
  type IdleTimerOptions,
} from "./idleTimer";
