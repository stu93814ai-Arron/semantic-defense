import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BlocklistEntrySchema } from "@semantic-defense/contracts";
import { AUTO_LIST_TTL_MS } from "../src/auto-blacklist.js";
import type { ControlApi } from "./helpers/app.js";
import { PENDING_HOST, PENDING_IP_RE, PENDING_NOW, bootPending, pendingOps } from "./helpers/pending.js";

/** 待審核准正向流程與權限：operator、成功回 BlocklistEntry、created_at＝核准當下、冷卻不擋、稽核與 log 不含 IP。 */
let app: ControlApi;
const logs: string[] = [];
afterEach(async () => { if (app) await app.close(); logs.length = 0; });

const NOW = PENDING_NOW;
const HOST = PENDING_HOST;
const IP_RE = PENDING_IP_RE;

const boot = async (): Promise<ControlApi> => (app = await bootPending({}, logs));
const { as, op, approve, seedCase, audits, caseRow } = pendingOps(() => app);

describe("POST /api/blacklist/pending/:caseId/approve（正向與權限）", () => {
  it("operator 核准成功：200 回 BlocklistEntry；created_at＝核准當下；案件轉 approved；稽核與 log 不含 IP", async () => {
    await boot();
    const id = await seedCase({ conf: 0.8, hits: 3 });
    const r = await approve(await op(), id);
    expect(r.statusCode).toBe(200);
    expect(BlocklistEntrySchema.safeParse(r.json()).success).toBe(true);
    const iso = new Date(NOW).toISOString();
    expect(r.json()).toMatchObject({
      ip: HOST, source: "manual", confidence: 0.8, case_id: id,
      created_at: iso, approved_at: iso, approved_by: "operator1",
      expires_at: new Date(NOW + AUTO_LIST_TTL_MS).toISOString(), revoked_at: null,
    });
    expect(await caseRow(id)).toEqual({ state: "approved", resolved_by: "operator1", resolved_at: String(NOW) });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "blacklist.approve", actor: "operator1" });
    expect(a[0]!.detail).toEqual({ case_id: id, entry_id: (r.json() as { entry_id: string }).entry_id });
    expect(JSON.stringify(a)).not.toMatch(IP_RE);
    expect(logs.join("\n")).not.toMatch(IP_RE);
  });

  it("冷卻期不擋人工核准：同 IP 剛被撤回仍可核准上榜", async () => {
    await boot();
    await app.db.query(
      `INSERT INTO blocklist_entries (entry_id, ip, source, confidence, case_id, created_at, expires_at, approved_by, approved_at, revoked_at, ended_at)
       VALUES ($1,$2,'auto',0.95,$3,$4,$5,'system:auto',$4,$6,$6)`,
      [randomUUID(), HOST, randomUUID(), NOW - 30 * 60_000, NOW + AUTO_LIST_TTL_MS, NOW - 5 * 60_000],
    );
    const id = await seedCase();
    const r = await approve(await op(), id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ip: HOST, source: "manual", case_id: id, revoked_at: null });
    expect(JSON.stringify(await audits())).not.toMatch(IP_RE);
    expect(logs.join("\n")).not.toMatch(IP_RE);
  });

  it("不存在／非 uuid／大寫 uuid → 404，不寫稽核", async () => {
    await boot();
    const c = await op();
    expect((await approve(c, randomUUID())).statusCode).toBe(404);
    expect((await approve(c, "nope")).statusCode).toBe(404);
    const id = await seedCase();
    expect((await approve(c, id.toUpperCase())).statusCode).toBe(404);
    expect(await caseRow(id)).toMatchObject({ state: "open", resolved_at: null });
    expect(await audits()).toEqual([]);
    expect((await approve(c, "nope")).json()).toEqual({ error: "查無待審案件" });
    expect(JSON.stringify(logs)).not.toMatch(IP_RE);
  });

  it("platform_admin、app_owner 403；匿名 401；案件不變、不寫稽核", async () => {
    await boot();
    const id = await seedCase();
    for (const [u, p] of [["admin1", "pass-admin-1"], ["owner1", "pass-owner-1"]] as const) {
      expect((await approve(await as(u, p), id)).statusCode, u).toBe(403);
    }
    expect((await approve(undefined, id)).statusCode).toBe(401);
    expect(await caseRow(id)).toMatchObject({ state: "open", resolved_at: null });
    expect(await audits()).toEqual([]);
    expect(logs.join("\n")).not.toMatch(IP_RE);
  });
});
