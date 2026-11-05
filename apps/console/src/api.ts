import type { SessionUser } from "./roles";

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

async function readError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error ?? body.message;
  } catch {
    return undefined;
  }
}

export async function apiGet<T>(url: string): Promise<ApiGetResult<T>> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 401) {
    onUnauthorized?.();
    return { status: 401, data: null };
  }
  if (res.status === 429) {
    const error = (await readError(res)) ?? "帳號或密碼錯誤，請稍後再試";
    return { status: 429, data: null, error };
  }
  if (res.status === 404) {
    const error = await readError(res);
    return { status: 404, data: null, error };
  }
  if (!res.ok) {
    const error = await readError(res);
    return { status: res.status, data: null, error };
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
  const body = (await res.json()) as { username?: string; role?: SessionUser["role"] };
  if (!body.username || !body.role) return null;
  return { username: body.username, role: body.role };
}

function parseError(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    return body.error ?? body.message;
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
    const body = JSON.parse(xhr.responseText) as {
      username?: string;
      role?: SessionUser["role"];
    };
    if (!body.username || !body.role) return null;
    return { username: body.username, role: body.role };
  } catch {
    return null;
  }
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
    return { ok: false, status: 0, message: "帳號或密碼錯誤" };
  }
  if (xhr.status === 429) {
    // 後端原文已含「請稍後再試」，UI 原樣顯示、不改寫
    const msg = parseError(xhr.responseText) ?? "帳號或密碼錯誤，請稍後再試";
    return { ok: false, status: 429, message: msg };
  }
  if (xhr.status < 200 || xhr.status >= 300) {
    const msg = parseError(xhr.responseText) ?? "帳號或密碼錯誤";
    return { ok: false, status: xhr.status, message: msg };
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
