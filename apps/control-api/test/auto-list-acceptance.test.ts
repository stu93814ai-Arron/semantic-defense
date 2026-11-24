import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_API_PATHS } from "@semantic-defense/contracts";
import { runJudgeTick } from "../src/judge.js";
import { AUTOLIST_FIXTURE } from "./fixtures/autolist/profiles.js";
import {
  bindFixtureSensor, laterTickAt, scoreProfile, writeE3A, writeLater, writeSingle,
} from "./fixtures/autolist/write.js";
import type { ControlApi } from "./helpers/app.js";
import { HS_READY, T0, bootJudgeApp } from "./helpers/judge.js";
import { cookieHeader, login } from "./helpers/session.js";

/**
 * 自動上榜總開關驗收（A1）。
 * 管理面走既有 HTTP：GET/PUT /api/settings/auto-list、GET 待審與黑名單、POST 白名單。
 * 流量與感測器綁定由固定夾具直接寫入測試庫，不經種子 API。
 * 判定走 runJudgeTick（產品路徑；控制面沒有另開的送流量端點）。
 * 門檻：MONITOR ≥0.90 自動、0.50–0.90 待審、<0.50 不成案。
 * §2b：自動上榜還要 30 分鐘內 3 次高嚴重命中且至少 2 個來源；白名單不上榜；同 IP 一筆生效。
 * 交握未就緒（HANDSHAKE_EVIDENCE_READY=false）時 PUT 開啟回 409。
 * 要驗「開關打開之後會上榜」時，buildApp 與 tick 都把交握視為已就緒（僅 NODE_ENV=test 允許的覆寫）。
 */

const READY = { autoListHandshakeReady: true };
const BLOCKED = { error: "三向交握佐證尚未上線，暫不能開啟自動封鎖" };
const IPS = AUTOLIST_FIXTURE.publicIps;

let app: ControlApi | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

async function boot(handshakeReady: boolean): Promise<ControlApi> {
  app = await bootJudgeApp(handshakeReady ? READY : {});
  await bindFixtureSensor(app);
  return app;
}

async function session(api: ControlApi, username: "admin1" | "operator1"): Promise<string> {
  const password = username === "admin1" ? "pass-admin-1" : "pass-operator-1";
  const outcome = await login(api, { username, password });
  expect(outcome.status).toBe(200);
  return outcome.cookie!;
}

type Method = "GET" | "PUT" | "POST";
function call(api: ControlApi, method: Method, url: string, cookie: string, payload?: object) {
  const headers = cookieHeader(cookie);
  return payload === undefined
    ? api.inject({ method, url, headers })
    : api.inject({ method, url, headers, payload });
}

async function readEnabled(api: ControlApi, admin: string): Promise<boolean> {
  const res = await call(api, "GET", ADMIN_API_PATHS.autoList, admin);
  expect(res.statusCode).toBe(200);
  return (res.json() as { enabled: boolean }).enabled;
}

async function enableAuto(api: ControlApi, admin: string): Promise<void> {
  const res = await call(api, "PUT", ADMIN_API_PATHS.autoList, admin, { enabled: true });
  expect([res.statusCode, res.json()]).toEqual([200, { enabled: true }]);
}

type PendingItem = { ip: string; confidence: number };
type BlockItem = { ip: string; source: string; confidence: number; revoked_at: string | null };

async function lists(api: ControlApi, operator: string): Promise<{ pending: PendingItem[]; block: BlockItem[] }> {
  const pending = await call(api, "GET", ADMIN_API_PATHS.blacklistPending, operator);
  const block = await call(api, "GET", ADMIN_API_PATHS.blacklist, operator);
  expect(pending.statusCode).toBe(200);
  expect(block.statusCode).toBe(200);
  return {
    pending: (pending.json() as { items: PendingItem[] }).items,
    block: (block.json() as { items: BlockItem[] }).items,
  };
}

function byIp<T extends { ip: string }>(items: readonly T[], raw: string): T[] {
  const prefix = `${raw}/`;
  return items.filter((item) => item.ip.startsWith(prefix));
}

const tick = (at = T0) => runJudgeTick(app!.db, at, undefined, HS_READY);

describe("autoList 驗收夾具", () => {
  it("分數落在規格邊界，E3.A 夾具是三窗且兩個來源", () => {
    expect(scoreProfile("high")).toBe(1);
    expect(scoreProfile("exact-090")).toBe(0.9);
    expect(scoreProfile("exact-050")).toBe(0.5);
    expect(scoreProfile("just-below-090")).toBeLessThan(0.9);
    expect(scoreProfile("just-below-090")).toBeGreaterThanOrEqual(0.5);
    expect(scoreProfile("below-050")).toBeLessThan(0.5);
    expect(AUTOLIST_FIXTURE.e3a.map((window) => window.appId)).toEqual(["app-1", "app-2", "app-1"]);
    expect(AUTOLIST_FIXTURE.e3a.map((window) => window.minutesBefore)).toEqual([25, 15, 5]);
  });
});

describe("autoList 預設關閉與 0.90 邊界", () => {
  it("預設關閉：GET 為 false；高分且 E3.A 成立也只進待審、不上榜", async () => {
    const api = await boot(false);
    const admin = await session(api, "admin1");
    const operator = await session(api, "operator1");
    expect(await readEnabled(api, admin)).toBe(false);
    await writeE3A(api, IPS.off, "high");
    await tick();
    const { pending, block } = await lists(api, operator);
    expect(byIp(block, IPS.off)).toEqual([]);
    expect(byIp(pending, IPS.off).map((item) => item.confidence)).toEqual([1]);
  });

  it("開啟後剛好 0.90 且 E3.A 成立 → source=auto；單窗 0.90 只待審；同 IP 再命中仍一筆", async () => {
    const api = await boot(true);
    const admin = await session(api, "admin1");
    const operator = await session(api, "operator1");
    await enableAuto(api, admin);
    expect(await readEnabled(api, admin)).toBe(true);
    await writeE3A(api, IPS.boundary, "exact-090");
    await writeSingle(api, IPS.single, "exact-090");
    await tick();
    const first = await lists(api, operator);
    const listed = byIp(first.block, IPS.boundary);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ source: "auto", confidence: 0.9, revoked_at: null });
    expect(byIp(first.pending, IPS.boundary)).toEqual([]);
    expect(byIp(first.block, IPS.single)).toEqual([]);
    expect(byIp(first.pending, IPS.single).map((item) => item.confidence)).toEqual([0.9]);
    await writeLater(api, IPS.boundary, "exact-090");
    await tick(laterTickAt());
    const again = await lists(api, operator);
    expect(byIp(again.block, IPS.boundary)).toEqual(listed);
  });
});

describe("autoList 待審區間", () => {
  it("剛好 0.50 與略低於 0.90 只進待審；低於 0.50 不成案也不上榜", async () => {
    const api = await boot(true);
    const admin = await session(api, "admin1");
    const operator = await session(api, "operator1");
    await enableAuto(api, admin);
    const atCase = scoreProfile("exact-050");
    const belowAuto = scoreProfile("just-below-090");
    await writeSingle(api, IPS.caseLine, "exact-050");
    await writeE3A(api, IPS.belowAuto, "just-below-090");
    await writeSingle(api, IPS.belowCase, "below-050");
    await tick();
    const { pending, block } = await lists(api, operator);
    expect(byIp(block, IPS.caseLine)).toEqual([]);
    expect(byIp(block, IPS.belowAuto)).toEqual([]);
    expect(byIp(block, IPS.belowCase)).toEqual([]);
    expect(byIp(pending, IPS.caseLine).map((item) => item.confidence)).toEqual([atCase]);
    expect(byIp(pending, IPS.belowAuto).map((item) => item.confidence)).toEqual([belowAuto]);
    expect(byIp(pending, IPS.belowCase)).toEqual([]);
  });
});

describe("autoList 保留位址與交握", () => {
  it("本機與保留位址即使高分且 E3.A 成立也不進黑名單", async () => {
    const api = await boot(true);
    const admin = await session(api, "admin1");
    const operator = await session(api, "operator1");
    await enableAuto(api, admin);
    for (const ip of AUTOLIST_FIXTURE.skippedHosts) await writeE3A(api, ip, "high");
    for (const ip of AUTOLIST_FIXTURE.nonPublicHosts) await writeE3A(api, ip, "high");
    await tick();
    const { pending, block } = await lists(api, operator);
    for (const ip of AUTOLIST_FIXTURE.skippedHosts) {
      expect(byIp(pending, ip), ip).toEqual([]);
      expect(byIp(block, ip), ip).toEqual([]);
    }
    for (const ip of AUTOLIST_FIXTURE.nonPublicHosts) {
      expect(byIp(block, ip), ip).toEqual([]);
      expect(byIp(pending, ip), ip).toHaveLength(1);
    }
  });
});

describe("autoList 交握與白名單", () => {
  it("交握未完成時 PUT 開啟回 409，開關維持關閉", async () => {
    const api = await boot(false);
    const admin = await session(api, "admin1");
    const res = await call(api, "PUT", ADMIN_API_PATHS.autoList, admin, { enabled: true });
    expect([res.statusCode, res.json()]).toEqual([409, BLOCKED]);
    expect(await readEnabled(api, admin)).toBe(false);
  });

  it("白名單命中即使高分且 E3.A 成立也不進待審、不上榜", async () => {
    const api = await boot(true);
    const admin = await session(api, "admin1");
    const operator = await session(api, "operator1");
    await enableAuto(api, admin);
    const created = await call(api, "POST", ADMIN_API_PATHS.whitelist, admin, {
      cidr: `${IPS.allowlisted}/32`, reason: "驗收白名單", expires_at: null,
    });
    expect(created.statusCode).toBe(201);
    await writeE3A(api, IPS.allowlisted, "high");
    await tick();
    const { pending, block } = await lists(api, operator);
    expect(byIp(pending, IPS.allowlisted)).toEqual([]);
    expect(byIp(block, IPS.allowlisted)).toEqual([]);
  });
});
