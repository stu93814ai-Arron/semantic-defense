import type { FlowMetadataEvent } from "@semantic-defense/contracts";
import { ensureFlowSchema, insertFlow, type FlowDb } from "./write.js";

/**
 * flow-store 測試入口（@semantic-defense/flow-store/testing；A 組領航員 11-09 裁示）。
 * 只放測試用的建表與塞資料輔助；DDL 仍只在 write.ts，這裡呼叫寫入入口，自己不寫 CREATE。
 * control-api 的測試可用；任何 app 的產品碼（src）不得 import（boundary.test 鎖住）。
 */

/** 建 flow_events／flow_rejections（委派 ensureFlowSchema，可重複呼叫）。 */
export async function createFlowTables(db: FlowDb): Promise<void> {
  await ensureFlowSchema(db);
}

export type FlowSeed = { flow: FlowMetadataEvent; sensorId: string; receivedAt: number };

/** 依序寫入 flow_events，回實際新增筆數（同 sensor 重複 flow_id 不計，與 insertFlow 相同）。 */
export async function insertFlowEvents(db: FlowDb, seeds: readonly FlowSeed[]): Promise<number> {
  let n = 0;
  for (const s of seeds) if (await insertFlow(db, s.flow, s.sensorId, s.receivedAt)) n += 1;
  return n;
}
