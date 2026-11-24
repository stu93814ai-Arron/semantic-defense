import { judgeFlows, type FlowMetadataEvent } from "@semantic-defense/contracts";
import { insertFlowEvents } from "@semantic-defense/flow-store/testing";
import type { ControlApi } from "../../helpers/app.js";
import { DAY, MIN, T0 } from "../../helpers/judge.js";
import { AUTOLIST_FIXTURE, profileOf, type ProfileName } from "./profiles.js";

const DST = "1.1.1.1";
const RECEIVE_LAG_MS = 10_000;
let nextId = 1;

function flowId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** 依夾具特徵組出同一個 5 分鐘窗的流量。idStart 只保證 flow_id 不重複，不影響分數。 */
export function buildEvents(ip: string, ts: number, appId: string, name: ProfileName, idStart: number): FlowMetadataEvent[] {
  const profile = profileOf(name);
  const out: FlowMetadataEvent[] = [];
  for (let i = 0; i < profile.n; i++) {
    const short = i < profile.short;
    out.push({
      flow_id: flowId(idStart + i),
      app_id: appId,
      ts: new Date(ts).toISOString(),
      src_ip: ip,
      dst_ip: DST,
      src_port: 20_000 + i,
      dst_port: 1_000 + (i % profile.uniquePorts),
      protocol: "tcp",
      bytes_in: 40,
      bytes_out: short ? 0 : 400,
      packets: profile.packets,
      duration_ms: short ? 10 : 200,
    });
  }
  return out;
}

/** 契約 judgeFlows 對這個夾具給出的信心（驗收比對待審／黑名單用）。 */
export function scoreProfile(name: ProfileName): number {
  const sample = buildEvents("64.0.113.21", T0, "app-1", name, 900_000);
  const confidence = judgeFlows(sample)[0]?.confidence;
  if (confidence === undefined) throw new Error("fixture produced no verdict");
  return confidence;
}

export async function bindFixtureSensor(api: ControlApi): Promise<void> {
  await api.db.query(
    `INSERT INTO sensor_tokens (sensor_id, token_hash, created_by, created_at, revoked_at, allowed_cidrs, allowed_app_ids)
     VALUES ($1, 'fixture-hash-not-a-token', (SELECT min(id) FROM users), $2, NULL, '{0.0.0.0/0}', $3)`,
    [AUTOLIST_FIXTURE.sensorId, T0 - DAY, AUTOLIST_FIXTURE.allowedAppIds],
  );
}

async function writeAt(api: ControlApi, ip: string, name: ProfileName, at: number, appId: string): Promise<void> {
  const flows = buildEvents(ip, at, appId, name, nextId);
  nextId += flows.length;
  const inserted = await insertFlowEvents(api.db, flows.map((flow) => ({
    flow, sensorId: AUTOLIST_FIXTURE.sensorId, receivedAt: at + RECEIVE_LAG_MS,
  })));
  if (inserted !== flows.length) throw new Error("fixture insert dropped rows");
}

/** 三個窗、兩個 app，讓 E3.A 的次數與來源條件成立（分數仍由夾具決定）。 */
export async function writeE3A(api: ControlApi, ip: string, name: ProfileName): Promise<void> {
  for (const window of AUTOLIST_FIXTURE.e3a) {
    await writeAt(api, ip, name, T0 - window.minutesBefore * MIN, window.appId);
  }
}

/** 單一窗（T0 前 5 分鐘）：分數達成案門檻會進待審，但次數不足以自動上榜。 */
export async function writeSingle(api: ControlApi, ip: string, name: ProfileName): Promise<void> {
  await writeAt(api, ip, name, T0 - 5 * MIN, "app-1");
}

/** 已上榜之後的新窗（T0 之後），用來確認同 IP 不會再寫第二筆生效列。 */
export function laterTickAt(): number {
  return T0 + 5 * MIN + 20_000;
}

export async function writeLater(api: ControlApi, ip: string, name: ProfileName): Promise<void> {
  await writeAt(api, ip, name, T0 + 5 * MIN, "app-2");
}
