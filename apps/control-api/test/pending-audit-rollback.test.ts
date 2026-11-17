import { describe, expect, it } from "vitest";
import type { ControlApi } from "./helpers/app.js";
import {
  activeBlocklist, asOperator, bootPending, closeAfterEach, pendingAudits, pendingCase, pendingOps,
} from "./helpers/pending.js";

/**
 * 稽核與資料同交易（資安 B4）：稽核寫入之後讓 COMMIT 失敗，稽核必須跟著回滾。
 * 故障注入只用本地測試庫的 DEFERRABLE 約束觸發器，且只對哨兵 IP 生效。
 */
let app: ControlApi;
const logs = closeAfterEach(() => app);
const { approve, reject, seedCase } = pendingOps(() => app, logs);

const SENTINEL = "64.0.113.99/32";
const SENTINEL_RE = /64\.0\.113\.99/;
const INJECTED = "ag injected commit failure";

async function armCommitFailure(): Promise<void> {
  await app.db.exec(`
    CREATE OR REPLACE FUNCTION ag_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION '${INJECTED}'; END $$;
    DROP TRIGGER IF EXISTS ag_fail_entry ON blocklist_entries;
    DROP TRIGGER IF EXISTS ag_fail_case ON blacklist_cases;
    CREATE CONSTRAINT TRIGGER ag_fail_entry AFTER INSERT ON blocklist_entries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.ip = '${SENTINEL}') EXECUTE FUNCTION ag_fail_commit();
    CREATE CONSTRAINT TRIGGER ag_fail_case AFTER UPDATE ON blacklist_cases
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.ip = '${SENTINEL}' AND NEW.state = 'rejected') EXECUTE FUNCTION ag_fail_commit();`);
}

async function disarm(): Promise<void> {
  await app.db.exec(`
    DROP TRIGGER IF EXISTS ag_fail_entry ON blocklist_entries;
    DROP TRIGGER IF EXISTS ag_fail_case ON blacklist_cases;
    DROP FUNCTION IF EXISTS ag_fail_commit();`);
}

async function expectRolledBack(id: string, body: unknown): Promise<void> {
  expect(await pendingAudits(app)).toEqual([]);
  expect(await pendingCase(app, id)).toMatchObject({ state: "open", resolved_at: null });
  expect(await activeBlocklist(app)).toEqual([]);
  const text = `${JSON.stringify(body)}\n${logs.join("\n")}`;
  expect(text).not.toMatch(SENTINEL_RE);
  expect(text).not.toContain(INJECTED);
}

describe("稽核寫入後 COMMIT 失敗：稽核與資料一起回滾（B4）", () => {
  it("approve：500、無稽核、案件仍 open、未上榜；回應與 log 不含 IP 或例外原文", async () => {
    app = await bootPending({}, logs);
    const id = await seedCase({ ip: SENTINEL });
    await armCommitFailure();
    try {
      const r = await approve(await asOperator(app), id);
      expect(r.statusCode).toBe(500);
      await expectRolledBack(id, r.json());
    } finally {
      await disarm();
    }
  });

  it("reject：500、無稽核、案件仍 open；回應與 log 不含 IP 或例外原文", async () => {
    app = await bootPending({}, logs);
    const id = await seedCase({ ip: SENTINEL });
    await armCommitFailure();
    try {
      const r = await reject(await asOperator(app), id);
      expect(r.statusCode).toBe(500);
      await expectRolledBack(id, r.json());
    } finally {
      await disarm();
    }
  });
});
