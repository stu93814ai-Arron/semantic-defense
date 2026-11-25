import { describe, expect, it } from "vitest";
import { expectOpenDbRejected, useClientHooks } from "./helpers/pg-client-hook.js";

/**
 * 軟體大總召裁示（未經使用者確認）：連線壞掉時 unlock 拋錯不得蓋掉遷移原錯。
 * A 組領航員裁示（未經使用者確認）：先記下原錯，unlock 錯誤只放在 cause；仍拒絕啟動，且 release(true)。
 * 實作後 it.fails 已改回 it()。原錯留在 message，unlock 錯誤在 cause。
 */
const { install } = useClientHooks();

describe("unlock 失敗不得蓋掉遷移原錯", () => {
  it("結構語句失敗且 unlock 也拋錯時，仍拋原錯、cause 為 unlock，並 release(true)", async () => {
    const releases: unknown[] = [];
    install({
      onQuery: async ({ sql, run }) => {
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS users")) {
          const err = new Error("schema-broke") as Error & { code?: string };
          err.code = "42601";
          throw err;
        }
        if (sql.includes("pg_advisory_unlock(")) throw new Error("unlock-broke");
        return run();
      },
      onRelease: (arg) => { releases.push(arg); },
    });
    const err = await expectOpenDbRejected() as Error & { cause?: unknown };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("schema-broke");
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe("unlock-broke");
    expect(releases).toContain(true);
  }, 15_000);

  // f2：遷移本身成功時，unlock 失敗仍須拒絕啟動。拿掉「failure !== undefined 則 failed」會讓 openDb 成功。
  it("遷移成功但 advisory unlock 失敗時仍拒絕啟動", async () => {
    const releases: unknown[] = [];
    install({
      onQuery: async ({ sql, run }) => {
        if (sql.includes("pg_advisory_unlock(")) throw new Error("unlock-after-ok");
        return run();
      },
      onRelease: (arg) => { releases.push(arg); },
    });
    const err = await expectOpenDbRejected() as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("unlock-after-ok");
    expect(releases).toContain(true);
  }, 15_000);
});
