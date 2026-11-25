import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { type ClientHook, expectOpenDbRejected, settleOpenDb, useClientHooks } from "./helpers/pg-client-hook.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

const DB_SRC = join(dirname(fileURLToPath(import.meta.url)), "../src/db.ts");

/**
 * B2：驗證 acquireSchemaLock 還原 statement_timeout 的成敗路徑。
 * 不匯出生產函式；在 openDb 所用的同一條 migrate client 上攔截 query／release（仿 TxClient 注入）。
 */
const SCHEMA_LOCK = 872_364_201;
const LOCK_TIMEOUT_SETTING = "5000ms";
const MIGRATE_ADVISORY_LOCK_FAILED =
  "無法在時限內取得資料庫遷移協調鎖，已拒絕啟動；請確認沒有其他實例或長時間作業佔用鎖後再重試";
const MIGRATE_TIMEOUT_RESTORE_FAILED =
  "無法還原資料庫語句時限設定，已拒絕啟動；請確認資料庫連線正常後再重試";

const { install: installClientHook } = useClientHooks();

function isShowTimeout(sql: string): boolean {
  return /^\s*SHOW\s+statement_timeout\s*$/i.test(sql);
}

function isSetTimeoutConfig(sql: string): boolean {
  return /set_config\(\s*'statement_timeout'/i.test(sql);
}

const failRestore: NonNullable<ClientHook["onQuery"]> = async ({ sql, params, run }) => {
  if (isSetTimeoutConfig(sql) && params?.[0] !== LOCK_TIMEOUT_SETTING) {
    throw new Error("injected");
  }
  return run();
};

describe("acquireSchemaLock 還原 statement_timeout", () => {
  it("取鎖成功但還原失敗 → 拒絕啟動並給出專屬中文訊息", async () => {
    installClientHook({
      onQuery: failRestore,
    });
    const err = await expectOpenDbRejected();
    expect((err as Error).message).toBe(MIGRATE_TIMEOUT_RESTORE_FAILED);
    expect(MIGRATE_TIMEOUT_RESTORE_FAILED).not.toBe(MIGRATE_ADVISORY_LOCK_FAILED);
  });

  it("取鎖成功後，同一條 client 上 SHOW statement_timeout 等於取鎖前基準值", async () => {
    let baseline: string | undefined;
    let afterRestore: string | undefined;
    installClientHook({
      onQuery: async ({ sql, params, run }) => {
        if (isShowTimeout(sql) && baseline === undefined) {
          const r = await run();
          baseline = String(r.rows[0]!.statement_timeout);
          return r;
        }
        if (isSetTimeoutConfig(sql) && params?.[0] !== LOCK_TIMEOUT_SETTING) {
          const r = await run();
          const shown = await run("SHOW statement_timeout");
          afterRestore = String(shown.rows[0]!.statement_timeout);
          return r;
        }
        return run();
      },
    });
    const outcome = await settleOpenDb();
    if (outcome.ok) await outcome.db.close().catch(() => {});
    else throw outcome.err;
    expect(baseline).toEqual(expect.any(String));
    expect(afterRestore).toBe(baseline);
  });

  it("取鎖失敗且還原也失敗時，仍拋取鎖的原錯（不是還原錯）", async () => {
    const holder = new pg.Client({ connectionString: requireDatabaseUrl() });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK]);
    installClientHook({
      onQuery: failRestore,
    });
    try {
      const err = await expectOpenDbRejected();
      expect((err as Error).message).toBe(MIGRATE_ADVISORY_LOCK_FAILED);
      expect(((err as Error).message) || "").not.toBe(MIGRATE_TIMEOUT_RESTORE_FAILED);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK]).catch(() => {});
      await holder.end().catch(() => {});
    }
  }, 20_000);

  it("遷移連線以 release(true) 丟棄，不還回 pool", async () => {
    const releases: unknown[] = [];
    installClientHook({ onRelease: (arg) => { releases.push(arg); } });
    const outcome = await settleOpenDb();
    if (outcome.ok) await outcome.db.close().catch(() => {});
    else throw outcome.err;
    expect(releases).toContain(true);
  });
});

/**
 * K6／K8（軟體大總召裁示，未經使用者確認；寫法為 A 組領航員裁示，未經使用者確認）。
 * 非 57014 的取鎖錯誤必須原樣拒絕啟動，不得在沒鎖時繼續遷移；沒取到鎖不得 unlock。
 */
describe("K6／K8 取 SCHEMA_LOCK 失敗", () => {
  it("取鎖發生非 57014 錯誤時拒絕啟動，且不繼續執行遷移語句", async () => {
    const seen: string[] = [];
    installClientHook({
      onQuery: async ({ sql, run }) => {
        seen.push(sql);
        if (sql.includes("pg_advisory_lock(")) {
          const err = new Error("lock-boom") as Error & { code?: string };
          err.code = "08006";
          throw err;
        }
        return run();
      },
    });
    const err = await expectOpenDbRejected();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("lock-boom");
    expect(seen.some((sql) => sql.includes("CREATE TABLE"))).toBe(false);
  }, 15_000);

  it("沒取到鎖時不呼叫 pg_advisory_unlock，並以 release(true) 結束遷移連線", async () => {
    const seen: string[] = [];
    const releases: unknown[] = [];
    installClientHook({
      onQuery: async ({ sql, run }) => {
        seen.push(sql);
        if (sql.includes("pg_advisory_lock(")) {
          const err = new Error("no-lock") as Error & { code?: string };
          err.code = "57P01";
          throw err;
        }
        return run();
      },
      onRelease: (arg) => { releases.push(arg); },
    });
    await expectOpenDbRejected();
    expect(seen.some((sql) => sql.includes("pg_advisory_unlock("))).toBe(false);
    expect(releases).toContain(true);
  }, 15_000);

  // 實作後 it.fails 已改回 it()。undefined 留在 lockErr，if (!held) 拋遷移協調鎖訊息。
  it("取鎖以 undefined reject 時仍拒絕啟動，且不繼續遷移", async () => {
    // K6：if (lockErr) throw lockErr 會放行 undefined；if (!held) 仍拒絕（A 組領航員裁示，未經使用者確認）。
    const seen: string[] = [];
    installClientHook({
      onQuery: async ({ sql, run }) => {
        seen.push(sql);
        if (sql.includes("pg_advisory_lock(") && !sql.includes("unlock")) return Promise.reject(undefined);
        return run();
      },
    });
    const err = await expectOpenDbRejected();
    expect((err as Error).message).toBe(MIGRATE_ADVISORY_LOCK_FAILED);
    expect(seen.some((sql) => sql.includes("CREATE TABLE"))).toBe(false);
  }, 15_000);
});

/**
 * A 組領航員裁示（未經使用者確認）：migrate 用 failure !== undefined 會吞掉 throw undefined。
 * SHOW statement_timeout 在 acquireSchemaLock 的 try 之外，reject(undefined) 直接進 migrate 的 catch。
 */
describe("throw undefined 也必須拒絕啟動", () => {
  // 實作後 it.fails 已改回 it()。布林旗標在 catch 到 undefined 時仍為 true（A 組領航員裁示，未經使用者確認）。
  it("第一句 SHOW statement_timeout 以 undefined reject 時 openDb 失敗，錯誤是 undefined", async () => {
    installClientHook({
      onQuery: async ({ sql, run }) => {
        if (isShowTimeout(sql)) return Promise.reject(undefined);
        return run();
      },
    });
    expect(await expectOpenDbRejected()).toBeUndefined();
  }, 15_000);
});

/**
 * U6（軟體大總召裁示，未經使用者確認）：非 55P03 的遷移錯誤必須拒絕啟動。
 * runSchemaStatement 在 55P03 以外仍 throw。拿掉該 throw 時本測試轉紅。
 */
describe("U6 非 55P03 的遷移錯誤拒絕啟動", () => {
  it("結構語句拋出 42601 時 openDb 失敗，錯誤原樣拋出", async () => {
    installClientHook({
      onQuery: async ({ sql, run }) => {
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS users")) {
          const err = new Error("schema-non-55P03") as Error & { code?: string };
          err.code = "42601";
          throw err;
        }
        return run();
      },
    });
    const err = await expectOpenDbRejected();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("schema-non-55P03");
    expect((err as { code?: string }).code).toBe("42601");
  }, 15_000);
});

/**
 * 實作後 it.fails 已改回 it()。errorCode 在取鎖註解之前；undefined 不讀 .code。
 */
describe("errorCode 的位置與 auto_list_settings 遷移", () => {
  it("errorCode 寫在取鎖註解之前，遷移與帳號鎖都用它讀 code", () => {
    const src = readFileSync(DB_SRC, "utf8");
    const codeAt = src.indexOf("function errorCode");
    const docAt = src.indexOf("pg_advisory_lock(SCHEMA_LOCK) 在交易外");
    const fnAt = src.indexOf("async function acquireSchemaLock");
    expect(codeAt).toBeGreaterThan(-1);
    expect(docAt).toBeGreaterThan(codeAt);
    expect(fnAt).toBeGreaterThan(docAt);
    expect(src.slice(docAt, fnAt)).not.toContain("function errorCode");
    expect(src).not.toContain("(err as { code?: string }).code");
  });

  it("auto_list_settings 遷移語句以 undefined reject 時，錯誤仍是 undefined", async () => {
    installClientHook({
      onQuery: async ({ sql, run }) => {
        if (sql.includes("CREATE TABLE IF NOT EXISTS auto_list_settings")) return Promise.reject(undefined);
        return run();
      },
    });
    expect(await expectOpenDbRejected()).toBeUndefined();
  }, 15_000);
});

describe("openDb 成功不得被當成 undefined 失敗", () => {
  // 實作後 it.fails 已改回 it()。成功路徑直接丟出，不能回傳 undefined。
  it("openDb 成功時直接丟出，不回傳 undefined", async () => {
    await expect(expectOpenDbRejected()).rejects.toThrow("openDb 應該失敗");
  }, 15_000);
});
