# 2026-11-24 B1：管理介面自動上榜開關（console）（Asia/Taipei）

來源：**軟體大總召裁示（未經使用者確認）**，經 B 組領航員轉達。後端規格見 `2026-11-17-auto-list-setting.md`（A1／A2）；本片只做其「殘件（B 組）」的 console 部分，不改 `apps/control-api`、`db.ts`、`PLAN.md` 或相依套件。

設計稿：**無專屬設計稿，沿用設計系統。** 總召裁示：「七張已核准設計稿」指 `docs/design/mockups/console-*`（login、dashboard、blocklist-review、case-detail、alerts-health、ai-chat-case、ai-history）；七張皆無白名單頁、判定設定區塊、開關或確認對話框，規格以上述決策文件加 `DESIGN_SYSTEM.md` 為準。

## 做了什麼

- `adminApi.getAutoList／putAutoList`（`ADMIN_API_PATHS.autoList`、`AutoListSettingSchema`）；`reviewSource` 直通，不回退 demo。
- `AutoListSwitch`：只在 `platform_admin` 時渲染並呼叫 GET（畫面顯示，不是授權；授權由後端判斷）。顯示值一律以 GET 為準，PUT 後不論成敗都重新 GET；載入中與 GET 失敗不顯示開／關。
- 關→開跳確認對話框（`role=alertdialog`、`aria-modal`、焦點在「取消」、Tab 循環、Esc 關閉並還焦點）；開→關不確認。
- 錯誤沿用 adminApi：409／403／401 顯示後端字串（截斷 200 字），5xx 固定前端文案。目前 PUT `{enabled:true}` 一律 409，畫面顯示後端中文說明，開關維持 GET 讀回的關閉。
- 位置：既有 `/whitelist` 門檻區塊改為「判定設定」區塊，內含開關與原門檻編輯器。掛載與改標題集中在單一 commit，日後若改位置只需動該 commit 的內容（`WhitelistThresholdSection`、`ThresholdEditor` 標題層級、`WhitelistPage` 傳入角色）。

## 與設計稿差異（每行一項）

- 七張 console-* 設計稿皆無白名單頁，「判定設定」區塊版面自訂（沿用 card）
- 設計稿無自動上榜開關，開關外觀（role=switch，52×30，圓角取 --radius-control：北歐膠囊、義式方角）自訂
- 設計稿無確認對話框，對話框沿用 card／btn／btn-primary，背板遮罩 rgb(0 0 0 / 45%) 為自訂值
- 原門檻區塊標題「成案／自動上榜門檻」由 h2 降為 h3，置於「判定設定」h2 之下，且不再自成一張 card
- 寫入後重讀期間開關以 aria-disabled 停用（焦點留在開關）並保留上次 GET 值（設計稿無此狀態）
- GET 失敗時顯示錯誤字串並提供「重新讀取」按鈕（設計稿無此狀態）

## 未做／待決

- 開發用 `phase2ApiPlugin` 未接 `/api/settings/auto-list`：dev／e2e 無後端時開關區顯示錯誤（404 字串），不給示範值。是否要接由總召決定。
- 開關區沒有 e2e；`/whitelist` 相關 e2e 屬驗收測試師。
