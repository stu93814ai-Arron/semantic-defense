import { buildApp, seedPhase2Fixtures, type ControlApi } from "./app.js";
import { requireDatabaseUrl } from "./pg.js";
import { login } from "./session.js";

/** 開 app、寫入第 2 階段帳號種子；now 為注入時鐘。 */
export async function bootWithPhase2(now: () => number, opts: { databaseUrl?: string } = {}): Promise<ControlApi> {
  const app = await buildApp({
    idleTimeoutMs: 60_000,
    databaseUrl: opts.databaseUrl ?? requireDatabaseUrl(),
    now,
  });
  await seedPhase2Fixtures(app);
  return app;
}

/** 登入成功才回 cookie；失敗直接丟（避免測試檔再寫一組相同的 expect）。 */
export async function requireLoginCookie(app: ControlApi, username: string, password: string): Promise<string> {
  const r = await login(app, { username, password });
  if (r.status !== 200 || !r.cookie) throw new Error("login did not return a session cookie");
  return r.cookie;
}
