import { randomUUID } from "node:crypto";
import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { createFlowTables } from "@semantic-defense/flow-store/testing";
import { buildApp, seedPhase2Fixtures, type BuildAppOptions, type ControlApi } from "./app.js";
import { requireDatabaseUrl } from "./pg.js";
import type { TickOpts } from "../../src/judge.js";

/** 判定 tick 測試共用：固定時鐘、建 app＋seed、以 ./testing 入口重建 flow_events、flow 產生器。 */
export const T0 = Date.parse("2026-11-09T00:00:00Z");
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;

async function resetFixtures(app: ControlApi): Promise<void> {
  await seedPhase2Fixtures(app);
  await app.db.exec("DROP TABLE IF EXISTS flow_events, flow_rejections");
  await createFlowTables(app.db);
}

/**
 * 要排程（judgeIntervalMs／alertDeliverIntervalMs > 0）時，先用不排程的 app 重建 fixtures、關掉，
 * 再開真正的 app：seed 期間不會有 tick 與 TRUNCATE 互鎖（A 組領航員裁示，未經使用者確認；不改 buildApp 啟動順序）。
 */
export async function bootJudgeApp(opts: Partial<BuildAppOptions> = {}): Promise<ControlApi> {
  const base = { idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => T0 };
  const timed = (opts.judgeIntervalMs ?? 0) > 0 || (opts.alertDeliverIntervalMs ?? 0) > 0;
  if (timed) {
    const seeder = await buildApp({ ...base, databaseUrl: opts.databaseUrl ?? base.databaseUrl });
    try { await resetFixtures(seeder); } finally { await seeder.close(); }
    return buildApp({ ...base, ...opts });
  }
  const app = await buildApp({ ...base, ...opts });
  await resetFixtures(app);
  return app;
}

/**
 * 測試專用 tick 覆寫：三向交握佐證視為已就緒（生產固定 HANDSHAKE_EVIDENCE_READY=false）。
 * AUTO_ON＝明確開啟總開關且視為就緒；要驗自動上榜的 tick 測試用它。
 */
export const HS_READY = { autoListHandshakeReady: true } as unknown as TickOpts;
export const AUTO_ON: TickOpts = { autoListEnabled: true, ...HS_READY };

/** 可疑：打很多 port、短連線無回應、低封包（30 筆 → confidence 1.0）；正常：同 port、有回應 → 低分。 */
export const flowEvent = (src_ip: string, ts: number, dst_port: number, susp: boolean, app_id = "app-1"): FlowMetadataEvent => ({
  flow_id: randomUUID(), app_id, ts: new Date(ts).toISOString(), src_ip, dst_ip: "10.0.0.1",
  src_port: 50000, dst_port, protocol: "tcp", bytes_in: 10, bytes_out: susp ? 0 : 500,
  packets: susp ? 1 : 20, duration_ms: susp ? 10 : 2000,
});

/** partial index 測試共用：再 init 一次（IF NOT EXISTS 冪等），回 audit_events 上該 index 的定義（沒有 → undefined）。 */
export async function auditIndexDefAfterReinit(app: ControlApi, name: string): Promise<string | undefined> {
  const again = await buildApp({ databaseUrl: requireDatabaseUrl(), logger: false, judgeIntervalMs: 0 });
  await again.close();
  const r = await app.db.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_events' AND indexname = $1", [name]);
  return r.rows[0]?.indexdef;
}
