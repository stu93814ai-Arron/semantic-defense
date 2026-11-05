/**
 * 測試只經由此面匯入實作。第 2 階段實作須匯出 buildApp / seedPhase2Fixtures。
 * 本檔不含業務邏輯；組態契約見 test/README.md。
 */
import {
  buildApp as buildAppImpl,
  seedPhase2Fixtures,
  type BuildAppOptions as ImplBuildAppOptions,
  type ControlApi,
} from "../../src/app.js";

export type { ControlApi };
export { seedPhase2Fixtures };

/**
 * 測試／實作共用組態。
 * - `databaseUrl`：接真實 Postgres（通常 `process.env.DATABASE_URL`，由 with-pg.mjs 提供）
 * - `now`：注入 epoch ms，供滑動閒置決定性測試
 * 實作須把這兩項納入正式 BuildAppOptions；此處先以轉型呼叫，讓紅燈測試可編譯。
 */
export type BuildAppOptions = ImplBuildAppOptions & {
  databaseUrl?: string;
  now?: () => number;
};

export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<ControlApi> {
  return buildAppImpl(opts as ImplBuildAppOptions);
}
