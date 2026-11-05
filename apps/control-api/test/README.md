# control-api 第 2 階段測試面契約

本目錄只寫紅燈驗收測試。實作須滿足下列測試可呼叫的表面；**不**新增 PLAN 未列的產品欄位。

## 技術（總召選定／已確認）

- Fastify + **Postgres**；CI／本機測試以根目錄 `scripts/with-pg.mjs` 起拋棄式 Postgres 並注入 **`DATABASE_URL`**
- 單測若未傳 `databaseUrl`，實作可暫用嵌入式（如 PGlite）做隔離；**持久化／多實例測試必須走真實 Postgres**，不得依賴單一 PGlite 生命週期裝持久化
- 密碼：**argon2**
- 工作階段：伺服器端 session；Cookie 名 **`sd_session`**；屬性 **HttpOnly; Secure; SameSite=Strict**
- 閒置逾時：由 `buildApp` 組態 **`idleTimeoutMs`** 控制（測試可設極短）
- **權威閒置判定在伺服器端**；前端 `VITE_IDLE_TIMEOUT_MS` **僅測試建置**用來縮短 E2E 等待，不得取代伺服器逾時
- **緊急暫停（emergency stop）獨立 API 延至第 4 階段**；本階段只涵蓋登入／角色／空狀態與上表 GET

## 環境與 `buildApp` 組態契約

| 來源 | 鍵 | 說明 |
| --- | --- | --- |
| 環境 | `DATABASE_URL` | 由 `node scripts/with-pg.mjs <cmd…>` 注入（或本機／CI 既有連線）。已存在時 with-pg **不覆寫**。 |
| `buildApp` | `databaseUrl?: string` | 測試持久化／多實例時**必須**傳入（通常 `process.env.DATABASE_URL`）。實作以此開啟 Postgres、跑 migrations／schema；`close()` 後以**同一** URL 再 `buildApp` 須看到同一資料。 |
| `buildApp` | `idleTimeoutMs?: number` | 伺服器端滑動閒置窗（ms）。 |
| `buildApp` | `now?: () => number` | 可選時鐘（epoch ms）。滑動閒置測試用此推進時間；省略則 `Date.now()`。 |
| `buildApp` | `loginRateLimit?: { maxFailures; windowMs }` | 登入失敗上限；計數須落在**共用儲存**（同一 `databaseUrl` 上多實例可見），不得只活在單一程序記憶體。 |
| `buildApp` | `trustProxy?: boolean` | 預設 `false`；僅可信反向代理後開啟。 |

建議執行（與根 `test:once` 相同包裝）：

```bash
node scripts/with-pg.mjs pnpm exec vitest run apps/control-api
# 或套件內：在已匯出 DATABASE_URL 的 shell 中 vitest run
```

```ts
import { buildApp, seedPhase2Fixtures } from "../src/app.js";

const databaseUrl = process.env.DATABASE_URL!; // with-pg.mjs 提供

const app = await buildApp({
  databaseUrl,                 // 持久化／多實例必填
  idleTimeoutMs: 50,           // 測試用短閒置
  now: () => clockMs,          // 滑動閒置決定性時鐘
  loginRateLimit: { maxFailures: 5, windowMs: 60_000 },
});
await seedPhase2Fixtures(app); // 固定帳號／應用（見下）
// Fastify inject（可帶 remoteAddress 模擬來源）：
await app.inject({
  method: "POST",
  url: "/api/session/login",
  payload: { username, password },
  remoteAddress: "198.51.100.1",
});
await app.close();
// 同一 databaseUrl 再 buildApp → users／apps／sessions／登入失敗計數仍在
```

`buildApp` 回傳已註冊路由的 Fastify 實例（或同等具 `.inject` / `.close`／`.db` 者）。

### 持久化與多實例期望

1. **重建**：`close()` 後以同一 `databaseUrl` 新 `buildApp`（不重播種子亦可）→ 既有 `sd_session` 仍可通過 `/api/session/me`，角色與應用指派仍在。
2. **多實例速率**：兩個 `buildApp({ databaseUrl, loginRateLimit })` 共用失敗計數；例如 A 失敗 3 次、B 失敗 2 次後，第 6 次（任一侧）**429**，本文與單實例達上限相同。
3. **滑動閒置**：經 `now` 推進；有活動須刷新 `last_seen`，超過 `idleTimeoutMs` 無活動 → 401。

## 種子帳號（測試固定）

| username | password | role | 指派應用 |
| --- | --- | --- | --- |
| `operator1` | `pass-operator-1` | `operator` | — |
| `owner1` | `pass-owner-1` | `app_owner` | `app-alpha` |
| `owner2` | `pass-owner-2` | `app_owner` | `app-beta` |
| `admin1` | `pass-admin-1` | `platform_admin` | — |

## HTTP 表面（對齊 PLAN 頁／角色；路徑為測試面約定，總召已確認）

| 方法 | 路徑 | 允許角色 |
| --- | --- | --- |
| POST | `/api/session/login` | 公開；body `{ username, password }` |
| POST | `/api/session/logout` | 已登入 |
| GET | `/api/session/me` | 已登入 |
| GET | `/api/admin/users` | `platform_admin` |
| GET | `/api/apps/:appId` | 該應用之 `app_owner` |
| GET | `/api/apps/:appId/map` | 該應用之 `app_owner` |
| GET | `/api/judgments` | `operator` |
| GET | `/api/judgments/history` | `operator` |
| GET | `/api/judgments/:caseId` | `operator` |
| GET | `/api/constraints` | `operator` |
| GET | `/api/audit` | `platform_admin` |
| GET | `/api/versions` | `platform_admin` |
| GET | `/api/health` | `platform_admin` |

未登入 → **401**；已登入但角色不符或非己應用 → **403**。

## 登入錯誤與速率（總召已確認）

- 未知帳號與密碼錯誤：**同一**繁中訊息 `帳號或密碼錯誤`（不揭露帳號是否存在）；**回應本文須位元組一致**
- 連續失敗達 **`loginRateLimit.maxFailures`（預設 5）／`windowMs`（預設 60s）** → **429**
- **計數鍵：`username` + 來源位址**（inject 以 `remoteAddress` 模擬）。不存在的 username 與既有帳號**同一套計數與 429 本文**
- 不同 `remoteAddress`、同一 username → **分開計數**
- **跨實例**：同一 `databaseUrl` 上多個 `buildApp` 實例須看到同一計數（見上）
- **回應時間一致性**（未知帳號不得明顯快於既有帳號以致可枚舉）：列為**審查項**，不寫易碎的自動時間斷言；實作審查時抽樣比較中位數即可

## 空資料 API

第 2 階段尚無業務資料時，允許角色呼叫上表 GET 應 **200**，本文為空清單或空物件（由實作決定形狀），不得 5xx。
