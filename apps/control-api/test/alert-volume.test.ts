import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { autoListInTx } from "../src/auto-blacklist.js";
import { volumeThreshold } from "../src/auto-breaker.js";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });

const T0 = Date.parse("2026-11-11T00:00:00Z");
const HOUR = 60 * 60_000;

async function boot(): Promise<void> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => T0 });
  await seedPhase2Fixtures(app);
}

const kinds = async () =>
  (await app.db.query<{ kind: string }>("SELECT kind FROM alert_outbox WHERE kind IN ('volume','breaker_open') ORDER BY id")).rows.map((r) => r.kind);

async function listAt(ip: string, now: number, n: number): Promise<string> {
  const r = await app.db.tx((q) => autoListInTx(q, { ip, confidence: 0.95, case_id: randomUUID() }, now, {
    gates: { breakerPerHour: n }, alertChannels: ["webhook"],
  }));
  return r.status;
}

describe("volumeThreshold", () => {
  it("ceil(0.8N)，含 N=1 與 N=50", () => {
    expect(volumeThreshold(1)).toBe(1);
    expect(volumeThreshold(50)).toBe(40);
    expect(volumeThreshold(5)).toBe(4);
  });
});

describe("volume 與 breaker_open 告警", () => {
  it("剛好達到 ceil(0.8N) 入列一次；低於門檻再升回可再觸發；熔斷開啟另入列 breaker_open", async () => {
    await boot();
    const n = 5;
    const ips = ["64.0.113.21", "64.0.113.22", "64.0.113.23", "64.0.113.24", "64.0.113.25", "64.0.113.26"];
    expect(await listAt(ips[0]!, T0, n)).toBe("listed");
    expect(await listAt(ips[1]!, T0, n)).toBe("listed");
    expect(await listAt(ips[2]!, T0, n)).toBe("listed");
    expect(await kinds()).toEqual([]);
    expect(await listAt(ips[3]!, T0, n)).toBe("listed");
    expect(await kinds()).toEqual(["volume"]);
    expect(await listAt(ips[4]!, T0, n)).toBe("listed");
    expect(await kinds()).toEqual(["volume"]);
    expect(await listAt(ips[5]!, T0, n)).toBe("breaker");
    expect(await kinds()).toEqual(["volume", "breaker_open"]);
    const payloads = (await app.db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM alert_outbox WHERE kind IN ('volume','breaker_open') ORDER BY id")).rows.map((r) => r.payload);
    for (const p of payloads) {
      expect(Object.keys(p).sort()).toEqual(["at", "delivery_id", "kind"]);
      expect(p.at).toBe(T0);
      expect(JSON.stringify(p)).not.toMatch(/64\.0\.|https?:/i);
    }
  });

  it("N=1：上榜達門檻入列 volume；下一次開啟熔斷並入列 breaker_open", async () => {
    await boot();
    expect(await listAt("64.0.113.31", T0, 1)).toBe("listed");
    expect(await kinds()).toEqual(["volume"]);
    expect(await listAt("64.0.113.32", T0, 1)).toBe("breaker");
    expect(await kinds()).toEqual(["volume", "breaker_open"]);
  });

  it("數量降回門檻下再升上來時可以再觸發 volume", async () => {
    await boot();
    const n = 5;
    for (const ip of ["64.0.113.41", "64.0.113.42", "64.0.113.43", "64.0.113.44"]) {
      expect(await listAt(ip, T0, n)).toBe("listed");
    }
    expect(await kinds()).toEqual(["volume"]);
    expect(await listAt("64.0.113.45", T0 + HOUR + 1, n)).toBe("listed");
    expect(await kinds()).toEqual(["volume"]);
    for (const ip of ["64.0.113.46", "64.0.113.47", "64.0.113.48"]) {
      expect(await listAt(ip, T0 + HOUR + 1, n)).toBe("listed");
    }
    expect(await kinds()).toEqual(["volume", "volume"]);
  });
});
