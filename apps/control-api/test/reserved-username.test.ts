import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { assertCreatableUsername, insertUser } from "../src/users.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

describe("使用者名稱不得為 system:install", () => {
  it("校驗與寫入路徑都拒絕該名稱，且不寫入 users 表", async () => {
    expect(() => assertCreatableUsername("system:install")).toThrow();
    const db = await openDb(requireDatabaseUrl());
    try {
      await expect(insertUser(db, {
        username: "system:install", password_hash: "x", role: "platform_admin",
      })).rejects.toThrow();
      const n = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM users WHERE username = $1",
        ["system:install"],
      );
      expect(n.rows[0]!.n).toBe("0");
    } finally {
      await db.close();
    }
  });
});
