import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BlocklistEntrySchema } from "@semantic-defense/contracts";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl } from "./helpers/pg.js";
import { writeAutoBlocklistEntry } from "../src/auto-blacklist.js";

/** ④ source=auto 寫入邊界（內部函式，不開 HTTP）：先查白名單、只收 /32／/128、須達自動門檻；與稽核同一 tx。 */
let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const NOW = Date.parse("2026-11-09T00:00:00Z");
const DAY = 24 * 3600_000;
async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW });
  await seedPhase2Fixtures(app);
  return app;
}
const allow = (cidr: string, expiresAt: number | null = null) => app.db.query(
  "INSERT INTO allowlist_entries (entry_id, cidr, reason, created_by, created_at, expires_at) VALUES ($1,$2,'r','admin1',$3,$4)",
  [randomUUID(), cidr, NOW - 1000, expiresAt]);
const count = async (t: string) => Number((await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);
const autoAudits = async () => (await app.db.query<{ actor: string; detail: Record<string, unknown> }>(
  "SELECT actor, detail FROM audit_events WHERE action = 'blacklist.auto_list' ORDER BY id")).rows;
const input = (ip: string, confidence = 0.95) => ({ ip, confidence, case_id: randomUUID() });

describe("writeAutoBlocklistEntry", () => {
  it("達門檻、不在白名單 → 上榜：source=auto、approved_by=system:auto、expires_at=created_at+24h；稽核含信心、依據、時間", async () => {
    await boot();
    const i = input("203.0.113.7");
    const r = await writeAutoBlocklistEntry(app.db, i, NOW);
    expect(r.status).toBe("listed");
    if (r.status !== "listed") return;
    expect(BlocklistEntrySchema.safeParse(r.entry).success).toBe(true);
    expect(r.entry).toMatchObject({
      ip: "203.0.113.7/32", source: "auto", confidence: 0.95, case_id: i.case_id, approved_by: "system:auto", revoked_at: null,
      created_at: new Date(NOW).toISOString(), approved_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + DAY).toISOString(),
    });
    expect(await count("blocklist_entries")).toBe(1);
    expect(await autoAudits()).toEqual([{ actor: "system:auto", detail: {
      entry_id: r.entry.entry_id, ip: "203.0.113.7/32", confidence: 0.95, case_id: i.case_id, expires_at: r.entry.expires_at } }]);
  });

  it.each(["203.0.113.7/32", "2001:db8::7", "2001:db8::7/128"])("接受主機前綴 %s", async (ip) => {
    await boot();
    expect((await writeAutoBlocklistEntry(app.db, input(ip), NOW)).status).toBe("listed");
  });
});

describe("writeAutoBlocklistEntry：ip 正規化", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7/32"], ["203.0.113.7/32", "203.0.113.7/32"],
    ["2001:db8::7", "2001:db8::7/128"], ["2001:db8::7/128", "2001:db8::7/128"], ["2001:db8:0:1::a", "2001:db8:0:1::a/128"],
  ])("ip 正規化：%s 存成 %s（DB 與回傳一致）", async (ip, stored) => {
    await boot();
    const r = await writeAutoBlocklistEntry(app.db, input(ip), NOW);
    expect(r.status === "listed" && r.entry.ip).toBe(stored);
    const rows = (await app.db.query<{ ip: string }>("SELECT ip FROM blocklist_entries")).rows;
    expect(rows).toEqual([{ ip: stored }]);
  });

  it("1.2.3.4 與 1.2.3.4/32 存成同一個值（去重延後：兩筆皆寫入）", async () => {
    await boot();
    await writeAutoBlocklistEntry(app.db, input("1.2.3.4"), NOW);
    await writeAutoBlocklistEntry(app.db, input("1.2.3.4/32"), NOW);
    const rows = (await app.db.query<{ ip: string }>("SELECT ip FROM blocklist_entries ORDER BY created_at")).rows;
    expect(rows.map((x) => x.ip)).toEqual(["1.2.3.4/32", "1.2.3.4/32"]);
  });
});

describe("writeAutoBlocklistEntry：拒絕與邊界", () => {
  it.each(["203.0.113.0/24", "2001:db8::/64", "127.0.0.1", "::ffff:203.0.113.7", "2001:DB8::7", "not-an-ip"])(
    "非 /32、/128 或非法 IP %s → invalid_ip，不寫入、不寫稽核", async (ip) => {
      await boot();
      expect(await writeAutoBlocklistEntry(app.db, input(ip), NOW)).toEqual({ status: "invalid_ip" });
      expect(await count("blocklist_entries")).toBe(0);
      expect(await autoAudits()).toEqual([]);
    });

  it("白名單命中（含 IPv4 /8、IPv6 /32 範圍）→ allowlisted，不上榜；過期白名單不算", async () => {
    await boot();
    await allow("10.0.0.0/8");
    await allow("2001:db8::/32");
    await allow("198.51.100.9", NOW - 1);
    expect(await writeAutoBlocklistEntry(app.db, input("10.20.30.40"), NOW)).toEqual({ status: "allowlisted" });
    expect(await writeAutoBlocklistEntry(app.db, input("2001:db8:1::5/128"), NOW)).toEqual({ status: "allowlisted" });
    expect(await count("blocklist_entries")).toBe(0);
    expect((await writeAutoBlocklistEntry(app.db, input("198.51.100.9"), NOW)).status).toBe("listed");
    expect((await writeAutoBlocklistEntry(app.db, input("11.0.0.1"), NOW)).status).toBe("listed");
  });

  it("信心未達目前 auto 門檻 → below_auto_threshold；門檻由設定讀取", async () => {
    await boot();
    expect(await writeAutoBlocklistEntry(app.db, input("203.0.113.8", 0.89), NOW)).toEqual({ status: "below_auto_threshold" });
    expect((await writeAutoBlocklistEntry(app.db, input("203.0.113.8", 0.9), NOW)).status).toBe("listed");
    await app.db.query("INSERT INTO thresholds (id, case_threshold, auto_threshold) VALUES (TRUE, 0.5, 0.97)");
    expect(await writeAutoBlocklistEntry(app.db, input("203.0.113.9", 0.95), NOW)).toEqual({ status: "below_auto_threshold" });
    expect(await count("blocklist_entries")).toBe(1);
  });

  it("稽核寫入失敗 → 拋錯，黑名單不寫入（同一 tx）", async () => {
    await boot();
    await app.db.exec("ALTER TABLE audit_events ADD CONSTRAINT t_no_auto CHECK (action <> 'blacklist.auto_list') NOT VALID");
    try {
      await expect(writeAutoBlocklistEntry(app.db, input("203.0.113.10"), NOW)).rejects.toThrow();
    } finally {
      await app.db.exec("ALTER TABLE audit_events DROP CONSTRAINT t_no_auto");
    }
    expect(await count("blocklist_entries")).toBe(0);
  });

  it("不開 HTTP：已掛路由中沒有任何 POST/PUT 寫入黑名單項目的路徑（只有撤回）", async () => {
    await boot();
    const writes = app.authRouteAudit.filter((r) => r.url.startsWith("/api/blacklist") && r.method !== "GET");
    expect(writes.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /api/blacklist/:entryId/revoke"]);
  });
});
