# 應用語意防禦 — 驗收清單

本檔彙整各階段**已落地的驗收測試／契約**與**尚未寫成測試的待辦**。  
資安每次必查的平面分離表見倉庫根目錄 `SECURITY-CHECKLIST-PLANE-SEPARATION.md`（P1–P5）；本清單偏產品／測試完成度，不取代該表。

**不修改 `PLAN.md`。** 路徑與角色以各套件 `test/README.md` 為測試面契約。

---

## 第 2 階段（管理平面：console／control-api）— 已記錄

| 狀態 | 項目 | 依據／位置 |
| --- | --- | --- |
| 已測 | 登入／登出／`/api/session/me`；Cookie `sd_session`（HttpOnly／Secure／SameSite=Strict） | `apps/control-api/test/session-cookie.test.ts` 等 |
| 已測 | 角色授權與空資料 GET；未登入 401、角色不符 403；app_owner 隔離 | `roles-access`、`app-owner-isolation`、`authz-and-login-rate` |
| 已測 | 登入錯誤不可枚舉；速率鍵 username＋來源位址；不存在帳號同計；trustProxy 預設不吃偽 XFF | `authz-and-login-rate`、`trust-proxy-rate` |
| 已測（紅） | 同一 `DATABASE_URL` 上 close 後重建仍見 session／指派 | `persistence-rebuild.test.ts`；契約見 `apps/control-api/test/README.md` |
| 已測（紅） | 兩 `buildApp` 實例共用登入失敗計數（3+2→429） | `multi-instance-rate.test.ts` |
| 已測（紅） | 滑動閒置（注入 `now`） | `sliding-idle.test.ts` |
| 已測（紅） | **管理／流量平面分離（管理側）**：只綁 `management` 埠；無代理／轉發；非 `/api` 路徑 404 且 sentinel 0 命中 | `plane-separation.test.ts` |
| 契約 | `buildApp`：`databaseUrl`／`now`／`management`／`loginRateLimit`／`idleTimeoutMs`／`trustProxy`；環境 `DATABASE_URL`（`scripts/with-pg.mjs`） | `apps/control-api/test/README.md` |

控制台 E2E／頁面空狀態等以 `apps/console` 測試與閘門紀錄為準（本表不逐條重列）。

---

## 第 4 階段（流量平面：gateway-adapter／入口）— 待辦（尚無自動測試）

下列對齊平面分離 P2／P4／P5 與使用者（經總召）要求；**標記為 pending**，待入口實作後補紅／綠燈，**現階段不要當成已通過**。

| 狀態 | 項目 | 對齊 |
| --- | --- | --- |
| **pending** | 在**入口（ingress）埠**上，`/api/*` 與 `/login`（及管理路徑）一律 **404／拒絕**，不得進入管理功能 | P2 |
| **pending** | 入口**不暴露寫入端點**供外界建立／修改限制（僅拉取／載入已簽名限制；傳輸 TLS） | P4 |
| **pending** | **control-api 已停止**時，入口仍執行**已載入、已簽名**的限制，不得因管理平面不可用而放行或清空 | P5 |

---

## 維護

- 新增紅燈／綠燈驗收時：更新對應階段列與連結。
- 第 4 階段測試落地後：將上表 pending 改為「已測」並指向測試檔。
