import { randomUUID } from "node:crypto";
import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { createFlowTables } from "@semantic-defense/flow-store/testing";
import { buildApp, seedPhase2Fixtures, type BuildAppOptions, type ControlApi } from "./app.js";
import { requireDatabaseUrl } from "./pg.js";

/** 判定 tick 測試共用：固定時鐘、建 app＋seed、以 ./testing 入口重建 flow_events、flow 產生器。 */
export const T0 = Date.parse("2026-11-09T00:00:00Z");
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;

export async function bootJudgeApp(opts: Partial<BuildAppOptions> = {}): Promise<ControlApi> {
  const app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => T0, ...opts });
  await seedPhase2Fixtures(app);
  await app.db.exec("DROP TABLE IF EXISTS flow_events, flow_rejections");
  await createFlowTables(app.db);
  return app;
}

/** 可疑：打很多 port、短連線無回應、低封包（30 筆 → confidence 1.0）；正常：同 port、有回應 → 低分。 */
export const flowEvent = (src_ip: string, ts: number, dst_port: number, susp: boolean, app_id = "app-1"): FlowMetadataEvent => ({
  flow_id: randomUUID(), app_id, ts: new Date(ts).toISOString(), src_ip, dst_ip: "10.0.0.1",
  src_port: 50000, dst_port, protocol: "tcp", bytes_in: 10, bytes_out: susp ? 0 : 500,
  packets: susp ? 1 : 20, duration_ms: susp ? 10 : 2000,
});
