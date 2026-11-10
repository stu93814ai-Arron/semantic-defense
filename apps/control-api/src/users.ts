import type { Queryable } from "./db.js";
import type { Role } from "./auth.js";
import { CRITICAL_ALLOWLIST_ACTOR } from "./critical-allowlist.js";

/** 拒絕與安裝種子 actor 相同的使用者名稱，以免建立後無法刪除其白名單。 */
export function assertCreatableUsername(username: string): void {
  if (username === CRITICAL_ALLOWLIST_ACTOR) throw new Error("reserved username");
}

export async function insertUser(
  q: Queryable,
  row: { username: string; password_hash: string; role: Role },
): Promise<number> {
  assertCreatableUsername(row.username);
  const r = await q.query<{ id: number }>(
    "INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id",
    [row.username, row.password_hash, row.role],
  );
  return r.rows[0]!.id;
}
