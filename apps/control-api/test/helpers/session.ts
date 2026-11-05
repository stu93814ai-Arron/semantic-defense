import type { ControlApi } from "./app.js";

export const LOGIN_ERROR = "帳號或密碼錯誤";

export type LoginBody = { username: string; password: string };

export type LoginOptions = {
  remoteAddress?: string;
};

export async function login(
  app: ControlApi,
  body: LoginBody,
  opts: LoginOptions = {},
): Promise<{ status: number; cookie?: string; payload: unknown; bodyText: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/session/login",
    payload: body,
    remoteAddress: opts.remoteAddress,
  });
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  let payload: unknown = undefined;
  try {
    payload = res.json();
  } catch {
    payload = res.body;
  }
  return {
    status: res.statusCode,
    cookie: typeof raw === "string" ? raw.split(";")[0] : undefined,
    payload,
    bodyText: res.body ?? "",
  };
}

export function cookieHeader(cookie: string): { cookie: string } {
  return { cookie };
}
