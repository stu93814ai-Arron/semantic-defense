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

## 角色可見頁（PLAN）

- `operator`：`/judgments*`、`/constraints`
- `app_owner`：`/apps/new`、`/apps/:appId/map`（僅己應用）
- `platform_admin`：`/admin/users`、`/audit`、`/versions`、`/health`

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
