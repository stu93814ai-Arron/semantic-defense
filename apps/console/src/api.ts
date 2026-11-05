import type { SessionUser } from "./roles";

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; status: number; message: string };

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export async function apiGet<T>(url: string): Promise<{ status: number; data: T | null }> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) {
    onUnauthorized?.();
    return { status: 401, data: null };
  }
  if (!res.ok) return { status: res.status, data: null };
  try {
    return { status: res.status, data: (await res.json()) as T };
  } catch {
    return { status: res.status, data: null };
  }
}

export async function fetchMe(): Promise<SessionUser | null> {
  const res = await fetch("/api/session/me", { credentials: "include" });
  if (res.status === 401) {
    onUnauthorized?.();
    return null;
  }
  if (!res.ok) return null;
  return (await res.json()) as SessionUser;
}

function parseLoginPayload(text: string): { error?: string; message?: string } & Partial<SessionUser> {
  try {
    return JSON.parse(text) as { error?: string; message?: string } & Partial<SessionUser>;
  } catch {
    return {};
  }
}

function failResult(
  status: number,
  payload: { error?: string; message?: string },
): LoginResult {
  if (status === 429) {
    const message = payload.error ?? payload.message ?? "登入次數過多，請稍後再試";
    const text = /稍後|次數|限制|太多次/.test(message)
      ? message
      : "登入次數過多，請稍後再試";
    return { ok: false, status: 429, message: text };
  }
  return {
    ok: false,
    status,
    message: payload.error ?? payload.message ?? "帳號或密碼錯誤",
  };
}

/** 同步登入：Playwright click 會等到 Cookie 寫入後才結束。 */
export function loginRequestSync(username: string, password: string): LoginResult {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/session/login", false);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.withCredentials = true;
  try {
    xhr.send(JSON.stringify({ username, password }));
  } catch {
    return { ok: false, status: 0, message: "帳號或密碼錯誤" };
  }
  const payload = parseLoginPayload(xhr.responseText);
  if (xhr.status < 200 || xhr.status >= 300) return failResult(xhr.status, payload);
  return {
    ok: true,
    user: {
      username: String(payload.username),
      role: payload.role as SessionUser["role"],
      appIds: Array.isArray(payload.appIds) ? payload.appIds : [],
    },
  };
}

export async function loginRequest(
  username: string,
  password: string,
): Promise<LoginResult> {
  return loginRequestSync(username, password);
}

export async function logoutRequest(): Promise<void> {
  await fetch("/api/session/logout", { method: "POST", credentials: "include" });
}
