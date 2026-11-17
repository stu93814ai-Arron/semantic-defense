import type { SessionUser } from "./roles";
import { parseMeBody } from "./roles";

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; status: number; message: string };

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export type ApiGetResult<T> = {
  status: number;
  data: T | null;
  /** 後端 error 原文（429／4xx JSON） */
  error?: string;
};

function pickStringError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as { error?: unknown; message?: unknown };
  if (typeof rec.error === "string") return rec.error;
  if (typeof rec.message === "string") return rec.message;
  return undefined;
}

async function readError(res: Response): Promise<string | undefined> {
  try {
    return pickStringError(await res.json());
  } catch {
    return undefined;
  }
}

function truncatedError(raw: string | undefined, fallback?: string): string | undefined {
  const text = raw ?? fallback;
  return text === undefined ? undefined : truncateBackendMessage(text);
}

export async function apiGet<T>(url: string): Promise<ApiGetResult<T>> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) {
    onUnauthorized?.();
    return { status: 401, data: null };
  }
  if (res.status === 429) {
    const error = truncatedError(await readError(res), "帳號或密碼錯誤，請稍後再試");
    return { status: 429, data: null, error };
  }
  if (res.status === 404) {
    return { status: 404, data: null, error: truncatedError(await readError(res)) };
  }
  if (!res.ok) {
    return { status: res.status, data: null, error: truncatedError(await readError(res)) };
  }
  try {
    return { status: res.status, data: (await res.json()) as T };
  } catch {
    return { status: res.status, data: null };
  }
}

export type FetchMeOptions = { quiet?: boolean };

export async function fetchMe(opts: FetchMeOptions = {}): Promise<SessionUser | null> {
  const res = await fetch("/api/session/me", { credentials: "include" });
  if (res.status === 401) {
    if (!opts.quiet) onUnauthorized?.();
    return null;
  }
  if (!res.ok) return null;
  return parseMeBody(await res.json());
}

function truncateBackendMessage(text: string): string {
  return text.length > 200 ? text.slice(0, 200) : text;
}

function parseError(text: string): string | undefined {
  try {
    return pickStringError(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function fetchMeSync(): SessionUser | null {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/api/session/me", false);
  xhr.withCredentials = true;
  try {
    xhr.send();
  } catch {
    return null;
  }
  if (xhr.status < 200 || xhr.status >= 300) return null;
  try {
    return parseMeBody(JSON.parse(xhr.responseText));
  } catch {
    return null;
  }
}


function loginFailure(status: number, responseText: string): LoginResult {
  if (status === 429) {
    // 後端原文（含「請稍後再試」）仍顯示，但與其他後端訊息同樣截斷至約 200 字。
    const msg = parseError(responseText) ?? "帳號或密碼錯誤，請稍後再試";
    return { ok: false, status, message: truncateBackendMessage(msg) };
  }
  if (status >= 500 || status === 0) {
    return { ok: false, status, message: "後端無法連線，請稍後再試" };
  }
  const raw = parseError(responseText) ?? "帳號或密碼錯誤";
  return { ok: false, status, message: truncateBackendMessage(raw) };
}

/** 同步登入：2xx 時 body 僅 {ok:true}，身分改打 /me。 */
export function loginRequestSync(username: string, password: string): LoginResult {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/session/login", false);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.withCredentials = true;
  try {
    xhr.send(JSON.stringify({ username, password }));
  } catch {
    return { ok: false, status: 0, message: "後端無法連線，請稍後再試" };
  }
  if (xhr.status < 200 || xhr.status >= 300) {
    return loginFailure(xhr.status, xhr.responseText);
  }
  const user = fetchMeSync();
  if (!user) return { ok: false, status: 401, message: "帳號或密碼錯誤" };
  return { ok: true, user };
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
