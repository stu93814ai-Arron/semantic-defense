import type { Queryable } from "./db.js";
import type { Role } from "./auth.js";

/**
 * 正規化後的帳號名稱字元集。A 組領航員裁示（未經使用者確認）為 `^[a-z0-9_.:-]+$`；
 * 正規化已轉小寫，故與含 A–Z 的寫法等價。字母大小寫都收，是為了正規化被拿掉時
 * 不會在撞名檢查前就被字元集擋下（突變 A）。
 */
const USERNAME_CHARSET = /^[A-Za-z0-9_.:-]+$/;

/**
 * 帳號名稱正規化。A 組領航員裁示（未經使用者確認）：NFKC，再 trim，再轉小寫。
 * 只使用標準庫。
 */
export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLowerCase();
}

/** 正規化後是否為可查詢的帳號名稱（字元集）；不符者登入走一般失敗路徑。 */
export function hasUsernameCharset(username: string): boolean {
  return USERNAME_CHARSET.test(normalizeUsername(username));
}

/** 拒絕正規化後以 system: 開頭，或字元集不符的名稱。 */
export function assertCreatableUsername(username: string): void {
  const n = normalizeUsername(username);
  if (n.startsWith("system:")) throw new Error("reserved username");
  if (!USERNAME_CHARSET.test(n)) throw new Error("invalid username");
}

export async function insertUser(
  q: Queryable,
  row: { username: string; password_hash: string; role: Role },
): Promise<number> {
  assertCreatableUsername(row.username);
  const username = normalizeUsername(row.username);
  const r = await q.query<{ id: number }>(
    "INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id",
    [username, row.password_hash, row.role],
  );
  return r.rows[0]!.id;
}
