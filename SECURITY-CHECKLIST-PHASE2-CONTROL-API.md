# 第 2 階段資安簽核 — apps/control-api

依據：`PLAN.md` 階段 2、軟體安全「身分與授權」。

## 2026-11-05（Asia/Taipei）— 准予合併

- 對象：`938f756`（`feat(control-api): 第 2 階段登入、伺服器端 session、角色授權與登入速率限制`），+326。
- Cookie `sd_session`：HttpOnly／Secure／SameSite=Strict；伺服器端 session 表＋滑動閒置；逾時 401。
- 登入：統一「帳號或密碼錯誤」；未知帳號仍跑 dummy argon2；速率 username＋ip（不存在也計）；`trustProxy` 預設 false，偽造 XFF 不能繞過 429。
- 授權：preHandler 預設拒絕；角色分路由；app_owner 以 `owner_id` 過濾，非己 **404**。
- 測試：5 檔／12 測綠；typecheck OK。緊急暫停屬第 4 階段（本階段 N/A）。
- 結論：**准予合併**（範圍：control-api API；console UI 另審）。

### 非阻擋殘留
1. `seedPhase2Fixtures` 仍自 `app.ts` re-export — 建議測試改直匯 `seed-phase2`。
2. `openDb()` 現為 PGlite — 上線前須同介面接 Postgres。
3. `LoginLimiter` 進程內 Map — 多實例需共享儲存。
4. 缺少「活動延長 TTL」專測（行為已在 loadSession）。

審查員：資安審查員

## 平面分離（每次必查）

見 [SECURITY-CHECKLIST-PLANE-SEPARATION.md](./SECURITY-CHECKLIST-PLANE-SEPARATION.md)。
本簽核範圍為管理平面 `control-api`：不得接收應用流量（P3）；入口尚未實作時 P2／P4／P5 以「不得在本套件偷跑 gateway listen／管理與流量混埠」查核。

## 2026-11-05（Asia/Taipei）— Postgres 改接待資安簽核（A／B 已通過）

- 對象：`06af858`＋`c03ef2a`（作者 A 組駕駛員）。
- `openDb(databaseUrl|DATABASE_URL)`：缺則啟動失敗；無 PGlite 後備（測試顯式注入）。
- Session：`UPDATE … AND last_seen > cutoff RETURNING` 原子滑動；過期不可被併發救回。
- `login_failures`：原子 UPSERT（username＋ip），支援多實例。
- Cookie／角色／速率語意維持既有簽核範圍。
- 驗證：with-pg control-api 9 檔／17 測綠；boundaries OK。

### 非阻擋殘留
1. `seedPhase2Fixtures` 仍自 `app.ts` re-export；已加 `NODE_ENV===production` 即 throw。正式入口勿設可呼叫 seed 之路徑；建議測試改直匯 `seed-phase2`。
2. 先前清單「PGlite／進程內 LoginLimiter／缺 TTL 專測」已由本輪 Postgres 改接與驗收測覆蓋——本輪簽核請改以本節為準。

### 資安簽核（2026-11-05，內容准予／合併附條件）
- 結論：**資安內容准予**；**合併阻擋**至連同 `1555245`（根 vitest control-api `fileParallelism: false`）且 `gate:clean` 轉綠。
- 說明：套件內 `pnpm --filter control-api test` 串行 17／17；根目錄並行會污染共用拋棄式 Postgres（約 7／17 失敗）。勿僅以套件內綠宣稱閘門綠。
- 另非阻擋：seed 仍靠 NODE_ENV＋app.ts re-export；`blocked()`／`fail()` 非單一原子決策。
