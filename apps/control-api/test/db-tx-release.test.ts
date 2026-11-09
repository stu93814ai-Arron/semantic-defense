import { describe, expect, it } from "vitest";
import { runTx } from "../src/db.js";

/** Db.tx 的連線歸還：ROLLBACK 失敗 → release(err) 丟棄連線；成功 → release()。外層一律拋原始錯誤。 */
function fakePool(opts: { rollbackFails: boolean; failOn?: "BEGIN" | "COMMIT" }) {
  const calls: string[] = [];
  const releases: unknown[][] = [];
  const rollbackErr = new Error("rollback failed");
  const stmtErr = new Error(`${opts.failOn ?? "none"} failed`);
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql === "ROLLBACK" && opts.rollbackFails) throw rollbackErr;
      if (sql === opts.failOn) throw stmtErr;
      return { rows: [] };
    },
    release: (...args: unknown[]) => { releases.push(args); },
  };
  return { pool: { connect: async () => client }, calls, releases, rollbackErr, stmtErr };
}

describe("runTx 連線歸還", () => {
  it("fn 拋錯且 ROLLBACK 也失敗：release 收到錯誤參數（丟棄連線），外層拋原始錯誤", async () => {
    const f = fakePool({ rollbackFails: true });
    const boom = new Error("boom");
    await expect(runTx(f.pool, async () => { throw boom; })).rejects.toBe(boom);
    expect(f.calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.releases).toHaveLength(1);
    expect(f.releases[0]).toHaveLength(1);
    expect(f.releases[0]![0]).toBeInstanceOf(Error);
  });

  it("fn 拋錯、ROLLBACK 成功：release() 不帶參數，外層拋原始錯誤", async () => {
    const f = fakePool({ rollbackFails: false });
    const boom = new Error("boom");
    await expect(runTx(f.pool, async () => { throw boom; })).rejects.toBe(boom);
    expect(f.calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.releases).toEqual([[]]);
  });

  it("成功：BEGIN → COMMIT，release() 不帶參數", async () => {
    const f = fakePool({ rollbackFails: false });
    expect(await runTx(f.pool, async () => 7)).toBe(7);
    expect(f.calls).toEqual(["BEGIN", "COMMIT"]);
    expect(f.releases).toEqual([[]]);
  });

  it.each(["BEGIN", "COMMIT"] as const)("護欄：%s 失敗 → 只 release 一次（ROLLBACK 成功 → 不帶參數），拋出原始錯誤", async (failOn) => {
    const f = fakePool({ rollbackFails: false, failOn });
    let ran = false;
    await expect(runTx(f.pool, async () => { ran = true; return 1; })).rejects.toBe(f.stmtErr);
    expect(ran).toBe(failOn === "COMMIT");
    expect(f.calls).toEqual(failOn === "BEGIN" ? ["BEGIN", "ROLLBACK"] : ["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(f.releases).toEqual([[]]);
  });

  it.each(["BEGIN", "COMMIT"] as const)("護欄：%s 失敗且 ROLLBACK 也失敗 → 只 release 一次且丟棄連線，拋出原始錯誤", async (failOn) => {
    const f = fakePool({ rollbackFails: true, failOn });
    await expect(runTx(f.pool, async () => 1)).rejects.toBe(f.stmtErr);
    expect(f.releases).toHaveLength(1);
    expect(f.releases[0]![0]).toBe(f.rollbackErr);
  });
});
