import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RETENTION_MS, flowEventsReady, type FlowDb } from "../src/read.js";
import { ensureFlowSchema } from "../src/write.js";
import { openSchemaDb } from "./helpers.js";

/** 唯讀入口最小骨架：判定 tick 開頭的 to_regclass 防呆。獨立 schema，不與其他測試互相清表。 */
let h: Awaited<ReturnType<typeof openSchemaDb>>;
let db: FlowDb;
beforeAll(async () => { h = await openSchemaDb("flow_store_read_test"); db = h.db; });
afterAll(async () => { await h?.close(); });

describe("flow-store/read", () => {
  it("flowEventsReady：表不存在 → false；ensureFlowSchema 後 → true", async () => {
    expect(await flowEventsReady(db)).toBe(false);
    await ensureFlowSchema(db);
    expect(await flowEventsReady(db)).toBe(true);
  });

  it("RETENTION_MS 與寫入端相同（7 天）", () => {
    expect(RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
