/**
 * 持久化／多實例測試依賴真實 Postgres。
 * DATABASE_URL 由根目錄 `scripts/with-pg.mjs`（或 CI／本機既有連線）注入；
 * 測試須把同一字串傳入 buildApp({ databaseUrl })，不得假設單一 PGlite 生命週期。
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未設定：請以 `node scripts/with-pg.mjs …`（或匯出 DATABASE_URL）執行本測試",
    );
  }
  return url;
}

/** 清空第 2 階段表，讓共用 Postgres 上的案例可重跑。 */
export async function truncatePhase2Tables(db: {
  exec(sql: string): Promise<unknown>;
}): Promise<void> {
  await db.exec(
    "TRUNCATE TABLE audit_events, thresholds, allowlist_entries, sensor_tokens, sessions, apps, users RESTART IDENTITY CASCADE",
  );
}
