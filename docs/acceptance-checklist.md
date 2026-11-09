# 應用語意防禦 — 驗收清單

本檔彙整各階段**已落地的驗收測試／契約**與**尚未寫成測試的待辦**。  
資安每次必查的平面分離表見倉庫根目錄 `SECURITY-CHECKLIST-PLANE-SEPARATION.md`（P1–P5）；本清單偏產品／測試完成度，不取代該表。

**不修改 `PLAN.md`。** 路徑與角色以各套件 `test/README.md` 為測試面契約。

---

## 第 2 階段（管理平面：console／control-api）— **已通過**

**驗收結論（總召關閉本階段）**：獨立驗收於 **`e996006`** 全量 `pnpm run ci` 綠燈（含 `scripts/with-pg.mjs` 真實 Postgres）；其後抽測 **`233e023`** control-api 20／20、主題 E2E 7／7 仍綠。

**簡證**：`必跑測試：386 筆，失敗 0，FLAKY 0`；覆蓋率 lines ≈98%；E2E 17 passed；`boundaries: OK`；輸出含 **`CI GREEN`**。API 演示腳本見 [`docs/demo/phase2-api.md`](./demo/phase2-api.md)。

| 狀態 | 項目 | 依據／位置 |
| --- | --- | --- |
| **通過** | 登入／登出／`/api/session/me`；Cookie `sd_session`（HttpOnly／Secure／SameSite=Strict） | `session-cookie`（API＋E2E）；手動 curl 見演示腳本 |
| **通過** | 三角色授權與空資料 GET；未登入 401、角色不符 403；無權限頁非空白 | `roles-access`、`roles-pages`、`routes-empty-states` |
| **通過** | app_owner 跨應用隔離（他應用 403／404且無內容） | `app-owner-isolation`、`app-owner-ui` |
| **通過** | 登入錯誤不可枚舉；速率 username＋IP；不存在帳號同計；trustProxy 預設不吃偽 XFF | `authz-and-login-rate`、`trust-proxy-rate`、`login-rate-limit` E2E |
| **通過** | 同一 `DATABASE_URL` 上 close／重建後 session／指派仍在 | `persistence-rebuild`；演示腳本「重啟」步驟（`DEMO_SEED=0`） |
| **通過** | 兩 `buildApp` 實例共用登入失敗計數（3+2→429） | `multi-instance-rate` |
| **通過** | 滑動閒置（注入 `now`）；閒置後須重登 | `sliding-idle`、`session-cookie` E2E；演示腳本短 `DEMO_IDLE_MS` |
| **通過** | **管理／流量平面分離（管理側）**：只綁 `management` 埠；無代理／轉發；非 `/api` → 404 | `plane-separation`；演示腳本 curl `/`、`/proxy` |
| **通過** | 北歐／義式主題切換、持久、非空白殼 | `apps/console/e2e/theme.spec.ts` |
| 契約 | `buildApp`：`databaseUrl`／`now`／`management`／`loginRateLimit`／`idleTimeoutMs`／`trustProxy`；環境 `DATABASE_URL`（`scripts/with-pg.mjs`） | `apps/control-api/test/README.md` |

### 已知 flaky（不擋第 2 階段關閉）

- **現象**：連跑多份 console E2E 時，`roles-pages`（operator 越權）偶發停在登入頁、找不到 `no-permission`（短 **`VITE_IDLE_TIMEOUT_MS=50`** 下 session 易先失效）。
- **處置**：**交 B 組**修復（拉長該案等待／登入後再探針／或隔離短閒置影響）；CI 全量與單獨重跑目前為綠。


---

## 第 3 階段（監看：新契約／中繼資料／判定／黑白名單）— **進行中**

規格來源：`PLAN-ADDENDUM-MONITOR.md` §3 契約、§7a 路由表、§8「第 3 階段驗收」（優先於 PLAN.md 原第 3 階段「應用接入」）。  
`/mode` 屬第 5 階段，本階段不測。

| 狀態 | 準則 | 來源 | 測試位置 |
| --- | --- | --- | --- |
| **已測** | 流量中繼資料／黑名單／快照／白名單契約：多欄、缺欄整份拒絕 | 附錄 §3、§8 A | `packages/contracts/test/flow-metadata-event.test.ts`、`blocklist-entry.test.ts`、`snapshot-allowlist.test.ts`；資安表 `SECURITY-CHECKLIST-PHASE3-CONTRACTS.md` |
| **已測** | 中繼資料接收只存契約欄位；拒 payload／URL／標頭；7 天清除（注入時鐘） | 附錄 §8 A | `apps/sensor-ingest/test/store.test.ts`（及 auth／binding） |
| **已測** | 假資料：可疑來源成案、正常流量不成案 | 附錄 §8 A | `packages/contracts/test/flow-verdict.test.ts` |
| **部分** | 信心達門檻→`source=auto`；未達→待審。門檻預設保守；僅 `platform_admin` 可調且寫稽核 | 附錄 §8 A | 常數／分數：`flow-verdict.test.ts`（`AUTO_THRESHOLD=0.9`）。**缺**：自動建列管線、門檻調整 API／UI／稽核（路徑未入 PLAN／附錄 → 待總召裁示） |
| **已測（單元）** | 白名單 IP 永不產生有效黑名單（人工核准路徑） | 附錄 §8 A／B | `apps/console/src/review/pending.test.ts`、`demoStore.test.ts`。**缺**：自動上榜路徑對白名單的驗收、以及管理面 API（目前為 console 記憶體 demoStore） |
| **紅燈中** | 預設到期 24 小時（`expires_at = created_at + 24h`） | 附錄 §3、§8 A | `apps/console/test/phase3-write-side-ttl.test.ts`（寫入端須以 `created_at` 加 24h） |
| **已測** | §7a 路由空狀態／角色／無權限（`/blacklist/review`、`/blacklist`、`/whitelist`；不含 `/mode`） | 附錄 §7a、§8 B | `apps/console/e2e/helpers/routes.ts`、`roles-pages.spec.ts`、`routes-empty-states.spec.ts`、`phase3-monitor-empty.spec.ts`（`a70cd6d`） |
| **已測（單元）** | 待審核准／退回；已上榜篩自動／人工；一鍵撤回；兩人同時核准只留一筆 | 附錄 §8 B | `apps/console/src/review/pending.test.ts`、`listed.test.ts`、`demoStore.test.ts`。**缺**：帶資料的 E2E（無 PLAN 規定的種子／API 面） |
| **已測＋E2E** | 白名單頁新增／刪除；格式錯誤擋下 | 附錄 §8 B | 單元：`allowlistForm.test.ts`；E2E：`apps/console/e2e/phase3-whitelist-ops.spec.ts` |
| **部分** | 核准白名單 IP 時提示並拒絕 | 附錄 §8 B | 單元已覆蓋；E2E 需待審種子（路徑／種子契約未入附錄 → 待裁示） |
| **部分** | 所有操作寫稽核；值班不能改白名單或門檻，直接呼叫 API 也被拒 | 附錄 §8 B | 畫面越權：`roles-pages`（`/whitelist`）。感測器 token API 角色：`sensor-tokens.test.ts`。**缺**：黑／白名單與門檻的 **HTTP API 路徑**（附錄未列，目前僅前端 demoStore） |

### 第 3 階段未決（阻擋補紅燈，須總召裁示）

1. 黑名單待審／已上榜／撤回、白名單 CRUD、自動上榜門檻調整的 **管理面 HTTP 路徑與本文契約**（附錄只列頁面路由 §7a）。
2. E2E 如何取得非空待審／已上榜種子（測試專用種子 API？固定 fixture 帳號？），以便補核准／退回／篩選／撤回／「白名單擋核准」E2E。
3. 「信心達門檻自動建立 `source=auto`」的寫入函式／服務邊界（contracts 純函式？control-api？），以及與白名單檢查的呼叫順序。
4. 門檻調整的 UI 路徑或 API；是否第 3 階段就要做，或僅後端預設常數。

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
- 第 3 階段補測或總召裁示後：更新上表狀態與「未決」清單。
- 第 4 階段測試落地後：將上表 pending 改為「已測」並指向測試檔。
