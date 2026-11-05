import type { ControlApi } from "./app.js";

export const LOGIN_ERROR = "帳號或密碼錯誤";

export type LoginBody = { username: string; password: string };

export async function login(
  app: ControlApi,
  body: LoginBody,
): Promise<{ status: number; cookie?: string; payload: unknown }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/session/login",
    payload: body,
  });
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return {
    status: res.statusCode,
    cookie: typeof raw === "string" ? raw.split(";")[0] : undefined,
    payload: res.json(),
  };
}

export function cookieHeader(cookie: string): { cookie: string } {
  return { cookie };
}
