# console 第 2 階段 E2E 測試面契約

技術（總召選定）：**React + Vite + react-router**；介面**繁體中文**；E2E：**Playwright**。

本目錄之上的 `e2e/` 為紅燈驗收。實作須提供可 `pnpm dev`（vite :5173）的前端，並與 `control-api` 登入／Cookie 行為一致。

## PLAN 路由（皆須存在）

| 路徑 | 說明 |
| --- | --- |
| `/login` | 登入 |
| `/admin/users` | 人員與角色 |
| `/apps/new` | 應用接入 |
| `/apps/:appId/map` | 應用地圖 |
| `/judgments` | 待判斷 |
| `/judgments/:caseId` | 單一判斷 |
| `/judgments/history` | 判斷紀錄 |
| `/constraints` | 生效限制（含緊急暫停入口） |
| `/audit` | 稽核 |
| `/versions` | 版本與影子流量 |
| `/health` | 平台健康 |

## 監看模式路由（PLAN-ADDENDUM-MONITOR.md §7a，提交 `96f29d9`）

附錄路由表**優先於** PLAN.md「角色與路由」表。E2E 已納入第 3 階段三條；**不含**第 5 階段 `/mode`（總召裁示）。

| 路徑 | 說明 | 角色 | 階段 |
| --- | --- | --- | --- |
| `/blacklist/review` | 黑名單待審（核准／退回） | `operator` | 3 |
| `/blacklist` | 已上榜黑名單（可撤銷） | `operator` | 3 |
| `/whitelist` | 白名單維護 | `platform_admin` | 3 |
| `/mode` | 模式切換（本階段**不**測） | `platform_admin` | 5 |

## 角色可見頁（PLAN ＋ 附錄第 3 階段）

- `operator`：`/judgments*`、`/constraints`、`/blacklist/review`、`/blacklist`
- `app_owner`：`/apps/new`、`/apps/:appId/map`（僅己應用）
- `platform_admin`：`/admin/users`、`/audit`、`/versions`、`/health`、`/whitelist`

未授權路由 → **無權限**頁（`data-testid="no-permission"`），**不是**空白頁。

## 空狀態

每個有資料的頁在尚無資料時須顯示明確繁中空狀態：

- 容器：`data-testid="empty-state"`
- 可見文字須匹配：`尚無|沒有|尚不|暫無`（繁中），不得為空白 `main`／空白根節點

應用根節點：`data-testid="app-shell"`（所有 PLAN 路由在掛載後可見）。

## 登入表單

- `data-testid="login-username"`
- `data-testid="login-password"`
- `data-testid="login-submit"`
- 錯誤：`data-testid="login-error"`，文案含 `帳號或密碼錯誤`

種子帳號與 API 相同（見 `apps/control-api/test/README.md`）。

## Cookie

工作階段 Cookie 名 `sd_session`：HttpOnly，故 **`document.cookie` 讀不到**；Playwright `context.cookies()` 可見且 `httpOnly === true`。

## 開發伺服器

實作完成後 `pnpm dev` 應啟動 Vite。目前 Playwright `webServer` 暫以空靜態目錄佔位，使案例可執行並紅燈；合併實作時改回 Vite。

## 總召已確認

- Cookie 名 `sd_session`；登入 body 用 `username`
- 短閒置 E2E 可用 **`VITE_IDLE_TIMEOUT_MS`（僅測試建置）**；**伺服器端 idle 為權威**
- 緊急暫停獨立 API **延至第 4 階段**
