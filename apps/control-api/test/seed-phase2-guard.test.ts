/**
 * seedPhase2Fixtures 反向守門（軟體大總召裁示：未同時符合環境與測試庫名就拒絕）。
 * 被拒絕時查詢軌跡不得出現 hash／lock／truncate（沒有 argon2.hash、沒有 SEED_LOCK、沒有清空表）。
 */
import argon2 from "argon2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { seedPhase2Fixtures } from "../src/seed-phase2.js";
import type { ControlApi } from "./helpers/app.js";

const REFUSED =
  "拒絕執行測試種子：未同時符合測試環境與測試資料庫命名，已中止且未改動任何資料";

const LEAKED = "LEAKED_DRIVER_ERROR";

/** with-pg 的 ci，以及 flow-store 測試實際開過的庫名。 */
const KNOWN_TEST_DATABASES = [
  "ci",
  "flow_store_db_isolation",
  "flow_store_backfill",
  "flow_store_migration",
  "flow_store_read_test",
  "flow_store_schema_env",
  "flow_store_schema_idx",
  "flow_store_test",
  "flow_store_testing_test",
] as const;

type Mode = "allow" | "refuse";

type Case = {
  title: string;
  nodeEnv?: string;
  demo?: string;
  db: string;
  mode: Mode;
  queryThrows?: boolean;
};

const CASES: Case[] = [
  { title: "NODE_ENV 未設時拒絕", db: "ci", mode: "refuse" },
  { title: "NODE_ENV=prod 時拒絕", nodeEnv: "prod", db: "ci", mode: "refuse" },
  { title: "NODE_ENV=Production 時拒絕", nodeEnv: "Production", db: "ci", mode: "refuse" },
  { title: "NODE_ENV=production 時拒絕", nodeEnv: "production", db: "ci", mode: "refuse" },
  { title: "NODE_ENV 空字串時拒絕", nodeEnv: "", db: "ci", mode: "refuse" },
  { title: "NODE_ENV=Test 時拒絕", nodeEnv: "Test", db: "ci", mode: "refuse" },
  { title: "NODE_ENV=test 帶空白時拒絕", nodeEnv: "test ", db: "ci", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 postgres 時拒絕", nodeEnv: "test", db: "postgres", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 contest 時拒絕", nodeEnv: "test", db: "contest", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 testdb 時拒絕", nodeEnv: "test", db: "testdb", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 test 時拒絕", nodeEnv: "test", db: "test", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 ci_extra 時拒絕", nodeEnv: "test", db: "ci_extra", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 CI 時拒絕", nodeEnv: "test", db: "CI", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 flow_store_ 時拒絕", nodeEnv: "test", db: "flow_store_", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 flow_store 時拒絕", nodeEnv: "test", db: "flow_store", mode: "refuse" },
  { title: "NODE_ENV=test 但資料庫名 semantic_defense 時拒絕", nodeEnv: "test", db: "semantic_defense", mode: "refuse" },
  { title: "DEMO_SEED_ALLOW=0 且 NODE_ENV 未設時拒絕", demo: "0", db: "ci", mode: "refuse" },
  { title: "DEMO_SEED_ALLOW=true 且 NODE_ENV 未設時拒絕", demo: "true", db: "ci", mode: "refuse" },
  { title: "DEMO_SEED_ALLOW=yes 且 NODE_ENV 未設時拒絕", demo: "yes", db: "ci", mode: "refuse" },
  { title: "DEMO_SEED_ALLOW 帶空白且 NODE_ENV 未設時拒絕", demo: "1 ", db: "ci", mode: "refuse" },
  { title: "DEMO_SEED_ALLOW 空字串且 NODE_ENV 未設時拒絕", demo: "", db: "ci", mode: "refuse" },
  { title: "DEMO_SEED_ALLOW=1 但資料庫名不符時拒絕", demo: "1", db: "postgres", mode: "refuse" },
  { title: "查詢目前資料庫名稱失敗時拒絕且不外洩例外", nodeEnv: "test", db: "ci", mode: "refuse", queryThrows: true },
  { title: "NODE_ENV=test 且資料庫名 ci 時放行", nodeEnv: "test", db: "ci", mode: "allow" },
  { title: "NODE_ENV=test 且 DEMO_SEED_ALLOW=0、庫名 ci 時放行", nodeEnv: "test", demo: "0", db: "ci", mode: "allow" },
  { title: "DEMO_SEED_ALLOW=1 且 NODE_ENV 未設、庫名 ci 時放行", demo: "1", db: "ci", mode: "allow" },
  { title: "NODE_ENV=test 且資料庫名 flow_store_read_test 時放行", nodeEnv: "test", db: "flow_store_read_test", mode: "allow" },
  { title: "DEMO_SEED_ALLOW=1 且庫名 flow_store_testing_test 時放行", demo: "1", db: "flow_store_testing_test", mode: "allow" },
];

/** NODE_ENV=production 時一律拒絕，不因 DEMO_SEED_ALLOW=1 而查庫或放行。 */
const PRODUCTION_HARD_REFUSE: Case[] = [
  { title: "production 且 DEMO_SEED_ALLOW=1 但庫名 contest 時拒絕", nodeEnv: "production", demo: "1", db: "contest", mode: "refuse" },
  { title: "DEMO_SEED_ALLOW=1 且 NODE_ENV=production、庫名 ci 時拒絕", nodeEnv: "production", demo: "1", db: "ci", mode: "refuse" },
  { title: "DEMO_SEED_ALLOW=1 且 NODE_ENV=production、庫名 flow_store_test 時拒絕", nodeEnv: "production", demo: "1", db: "flow_store_test", mode: "refuse" },
];

const origNode = process.env.NODE_ENV;
const origDemo = process.env.DEMO_SEED_ALLOW;

function setEnv(nodeEnv: string | undefined, demo: string | undefined): void {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (demo === undefined) delete process.env.DEMO_SEED_ALLOW;
  else process.env.DEMO_SEED_ALLOW = demo;
}

afterEach(() => {
  setEnv(origNode, origDemo);
  vi.restoreAllMocks();
});

function classify(sql: string): string {
  if (sql.includes("current_database")) return "current_database";
  if (sql.includes("pg_advisory_xact_lock")) return "lock";
  if (sql.startsWith("TRUNCATE")) return "truncate";
  if (sql.startsWith("INSERT INTO users")) return "insert-user";
  return "other";
}

function harness(trace: string[], databaseName: string, queryThrows: boolean): ControlApi {
  const query = async <T>(sql: string): Promise<{ rows: T[] }> => {
    const kind = classify(sql);
    if (kind === "current_database") {
      trace.push(kind);
      if (queryThrows) throw new Error(LEAKED);
      return { rows: [{ name: databaseName } as T] };
    }
    trace.push(kind);
    if (kind === "insert-user") return { rows: [{ id: 1 } as T] };
    return { rows: [] };
  };
  const db: Db = {
    query,
    exec: async () => undefined,
    close: async () => undefined,
    tx: (fn) => fn({ query }),
    withSession: (fn) => fn({ query }),
  };
  vi.spyOn(argon2, "hash").mockImplementation((async () => {
    trace.push("hash");
    return "hash";
  }) as unknown as typeof argon2.hash);
  return { db } as unknown as ControlApi;
}

function envOpensGate(c: Case): boolean {
  if (c.nodeEnv === "production") return false;
  return c.nodeEnv === "test" || c.demo === "1";
}

function expectAllowedOrder(trace: string[]): void {
  expect(trace[0]).toBe("current_database");
  const lastHash = trace.lastIndexOf("hash");
  const lockAt = trace.indexOf("lock");
  const truncAt = trace.indexOf("truncate");
  expect(trace.filter((step) => step === "hash")).toHaveLength(4);
  expect(lastHash).toBeGreaterThan(0);
  expect(lockAt).toBeGreaterThan(lastHash);
  expect(truncAt).toBeGreaterThan(lockAt);
}

async function expectRefused(c: Case, trace: string[], app: ControlApi): Promise<void> {
  const err = await seedPhase2Fixtures(app).then(
    () => ({ message: "沒有拒絕" }),
    (caught: unknown) => (caught instanceof Error ? caught : { message: "非 Error" }),
  );
  expect(err.message).toBe(REFUSED);
  expect(err.message).not.toContain(LEAKED);
  expect(trace).toEqual(envOpensGate(c) ? ["current_database"] : []);
}

async function runCase(c: Case): Promise<void> {
  vi.restoreAllMocks();
  setEnv(c.nodeEnv, c.demo);
  const trace: string[] = [];
  const app = harness(trace, c.db, c.queryThrows === true);
  try {
    if (c.mode === "allow") {
      await seedPhase2Fixtures(app);
      expectAllowedOrder(trace);
      return;
    }
    await expectRefused(c, trace, app);
  } finally {
    setEnv(origNode, origDemo);
    vi.restoreAllMocks();
  }
}

describe("seedPhase2Fixtures 反向守門", () => {
  for (const c of CASES) {
    it(c.title, () => runCase(c));
  }

  for (const c of PRODUCTION_HARD_REFUSE) {
    it(c.title, () => runCase(c));
  }

  it("NODE_ENV=test 時已知測試庫名全部放行", async () => {
    for (const db of KNOWN_TEST_DATABASES) {
      await runCase({ title: db, nodeEnv: "test", db, mode: "allow" });
    }
  });
});
