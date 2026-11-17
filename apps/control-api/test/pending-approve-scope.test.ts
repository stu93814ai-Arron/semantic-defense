import { describe, expect, it } from "vitest";
import type { ControlApi } from "./helpers/app.js";
import { bootPending, closeAfterEach, pendingOps } from "./helpers/pending.js";
import { APPROVE_INTERNAL_SCOPE_DEFAULT, resolveApproveInternalScope } from "../src/approve-guard.js";

/**
 * 核准位址範圍：內網（RFC1918、CGNAT、ULA）預設可封鎖（使用者決定，由軟體大總召轉達），
 * 管理員以 SD_APPROVE_INTERNAL_SCOPE 改成 none／v4／v6 禁止封鎖內網；never 類任何設定都擋。
 * 被擋回 409（不含 IP），寫 approve_blocked {case_id, reason}，同一案件每小時一筆。
 */
let app: ControlApi;
const logs = closeAfterEach(() => app);
const { op, seedCase, approve, audits, caseRow } = pendingOps(() => app, logs);
const V4 = "10.20.30.40/32";
const V4_RE = /10\.20\.30\.40/;
const CGNAT = "100.64.7.8/32";
const V6 = "fd12:3456::9/128";
const V6_RE = /fd12:3456/i;
const NEVER = ["198.18.0.5/32", "192.0.0.8/32"];
const INTERNAL_MSG = "內網位址不可核准";
const NEVER_MSG = "此位址不可核准";

async function tryApprove(ip: string): Promise<{ status: number; body: unknown; id: string }> {
  const id = await seedCase({ ip });
  const r = await approve(await op(), id);
  return { status: r.statusCode, body: r.json(), id };
}

async function expectBlocked(ip: string, error: string, reason: string): Promise<void> {
  const { status, body, id } = await tryApprove(ip);
  expect(status).toBe(409);
  expect(body).toEqual({ error });
  expect((await caseRow(id)).state).toBe("open");
  const rows = (await audits()).filter((a) => a.detail.case_id === id);
  expect(rows).toEqual([{ action: "blacklist.approve_blocked", actor: "operator1", detail: { case_id: id, reason } }]);
  const active = await app.db.query("SELECT 1 FROM blocklist_entries WHERE case_id = $1", [id]);
  expect(active.rows).toEqual([]);
}

function expectNoTestIp(): void {
  const all = logs.join("\n");
  for (const re of [V4_RE, V6_RE, /100\.64\.7\.8/, /198\.18\.0\.5/, /192\.0\.0\.8/]) expect(all).not.toMatch(re);
}

describe("SD_APPROVE_INTERNAL_SCOPE 解析", () => {
  it("預設常數為 all；none／v4／v6／all 照用；其餘啟動時拋錯", async () => {
    expect(APPROVE_INTERNAL_SCOPE_DEFAULT).toBe("all");
    expect(resolveApproveInternalScope({})).toBe("all");
    expect(resolveApproveInternalScope({ SD_APPROVE_INTERNAL_SCOPE: " " })).toBe("all");
    for (const v of ["none", "v4", "v6", "all"] as const) expect(resolveApproveInternalScope({ SD_APPROVE_INTERNAL_SCOPE: v })).toBe(v);
    for (const bad of ["NONE", "v4,v6", "true", "off"]) {
      expect(() => resolveApproveInternalScope({ SD_APPROVE_INTERNAL_SCOPE: bad })).toThrow(/SD_APPROVE_INTERNAL_SCOPE/);
    }
    expect(resolveApproveInternalScope({ SD_APPROVE_INTERNAL_SCOPE: "none" }, "v6")).toBe("v6");
    app = await bootPending({}, logs);
    expect(JSON.parse(logs.find((l) => l.includes("approve guard"))!)).toMatchObject({ approve_internal_scope: "all" });
  });
});

describe("核准位址範圍", () => {
  it("預設（all）：RFC1918、CGNAT、ULA 都可核准上榜", async () => {
    app = await bootPending({}, logs);
    for (const ip of [V4, CGNAT, V6]) expect((await tryApprove(ip)).status).toBe(200);
    expectNoTestIp();
  });

  it("none：內網 v4／v6 都 409 並寫 internal_scope 稽核；同一案件 1 小時內只一筆；公網仍可核准", async () => {
    app = await bootPending({ approveInternalScope: "none" }, logs);
    await expectBlocked(V4, INTERNAL_MSG, "internal_scope");
    await expectBlocked(CGNAT, INTERNAL_MSG, "internal_scope");
    await expectBlocked(V6, INTERNAL_MSG, "internal_scope");
    const again = (await audits()).length;
    const id = (await app.db.query<{ case_id: string }>("SELECT case_id FROM blacklist_cases WHERE ip = $1", [V4])).rows[0]!.case_id;
    expect((await approve(await op(), id)).statusCode).toBe(409);
    expect(await audits()).toHaveLength(again);
    expect((await tryApprove("64.0.113.7/32")).status).toBe(200);
    expectNoTestIp();
  });

  it("v4 只放行內網 v4；v6 只放行 ULA", async () => {
    app = await bootPending({ approveInternalScope: "v4" }, logs);
    expect((await tryApprove(V4)).status).toBe(200);
    await expectBlocked(V6, INTERNAL_MSG, "internal_scope");
    await app.close();
    app = await bootPending({ approveInternalScope: "v6" }, logs);
    expect((await tryApprove(V6)).status).toBe(200);
    await expectBlocked(V4, INTERNAL_MSG, "internal_scope");
  });

  it("never（198.18/15、192.0.0/24）在 all 之下仍 409，寫 never_scope 稽核", async () => {
    app = await bootPending({ approveInternalScope: "all" }, logs);
    for (const ip of NEVER) await expectBlocked(ip, NEVER_MSG, "never_scope");
    expectNoTestIp();
  });

  it("白名單永遠優先：none 之下內網位址在白名單 → 409 已在白名單，不寫 approve_blocked", async () => {
    app = await bootPending({ approveInternalScope: "none" }, logs);
    await app.db.query("INSERT INTO allowlist_entries VALUES (gen_random_uuid(), '10.20.0.0/16', 'office', 'admin1', 0, NULL)");
    const { status, body } = await tryApprove(V4);
    expect(status).toBe(409);
    expect(body).toEqual({ error: "已在白名單" });
    expect((await audits()).filter((a) => a.action === "blacklist.approve_blocked")).toEqual([]);
  });
});
