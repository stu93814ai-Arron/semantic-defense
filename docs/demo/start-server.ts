/**
 * 第 2 階段 API 演示用啟動器（非正式生產入口）。
 * 用法見 phase2-api.md：外層須由 scripts/with-pg.mjs 注入 DATABASE_URL。
 *
 * DEMO_SEED=0 → 不重播種子（用於「重啟後 session 仍在」演示；勿在空庫上使用）。
 */
import { it } from "vitest";
import {
  buildApp,
  seedPhase2Fixtures,
} from "../../apps/control-api/src/app.ts";

it("demo: start control-api on management port", async () => {
  const host = process.env.DEMO_HOST ?? "127.0.0.1";
  const port = Number(process.env.DEMO_PORT ?? "8787");
  const idleTimeoutMs = Number(process.env.DEMO_IDLE_MS ?? "15000");
  const doSeed = process.env.DEMO_SEED !== "0";

  const app = await buildApp({
    management: { host, port },
    idleTimeoutMs,
    loginRateLimit: { maxFailures: 5, windowMs: 60_000 },
  });
  if (doSeed) await seedPhase2Fixtures(app);

  const addr = app.addresses()[0] as { address: string; port: number };
  console.log(
    `DEMO_READY base=http://${addr.address}:${addr.port} idleTimeoutMs=${idleTimeoutMs} seed=${doSeed ? "yes" : "no"}`,
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      void app.close().finally(resolve);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}, 3_600_000);
