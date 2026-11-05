# control-api 第 2 階段測試面契約

本目錄只寫紅燈驗收測試。實作須滿足下列測試可呼叫的表面；**不**新增 PLAN 未列的產品欄位。

## 技術（總召選定）

- Fastify + Postgres；測試用 **PGlite**（記憶體／檔案均可，須 <10 分鐘跑完）
- 密碼：**argon2**
- 工作階段：伺服器端 session；Cookie 名 **`sd_session`**；屬性 **HttpOnly; Secure; SameSite=Strict**
- 閒置逾時：由 `buildApp` 組態 **`idleTimeoutMs`** 控制（測試可設極短）

## 工廠與種子

```ts
import { buildApp, seedPhase2Fixtures } from "../src/app.js";

const app = await buildApp({
  idleTimeoutMs: 50,          // 測試用短閒置
  loginRateLimit: { maxFailures: 5, windowMs: 60_000 },
});
await seedPhase2Fixtures(app); // 固定帳號／應用（見下）
// Fastify inject：
await app.inject({ method: "POST", url: "/api/session/login", payload: {...} });
await app.close();
```

`buildApp` 回傳已註冊路由的 Fastify 實例（或同等具 `.inject` / `.close` 者）。

## 種子帳號（測試固定）

| username | password | role | 指派應用 |
| --- | --- | --- | --- |
| `operator1` | `pass-operator-1` | `operator` | — |
| `owner1` | `pass-owner-1` | `app_owner` | `app-alpha` |
| `owner2` | `pass-owner-2` | `app_owner` | `app-beta` |
| `admin1` | `pass-admin-1` | `platform_admin` | — |

## HTTP 表面（對齊 PLAN 頁／角色；路徑為測試面約定）

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

## 登入錯誤與速率

- 未知帳號與密碼錯誤：**同一**繁中訊息 `帳號或密碼錯誤`（不揭露帳號是否存在）
- 連續失敗達 **`loginRateLimit.maxFailures`（預設 5）** → **429**，訊息仍不得用於枚舉帳號

## 空資料 API

第 2 階段尚無業務資料時，允許角色呼叫上表 GET 應 **200**，本文為空清單或空物件（由實作決定形狀），不得 5xx。
