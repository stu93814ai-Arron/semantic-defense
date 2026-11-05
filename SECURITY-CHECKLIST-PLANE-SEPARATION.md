# 每次簽核必查：流量平面與管理平面分離

依據：使用者要求（經軟體大總召轉達，2026-11-05）；對齊 `PLAN.md`「入口配接：獨立程序，與控制程序分開部署」及階段 4／軟體安全相關條款。

**凡合併前資安簽核，無論第幾階段，本表皆須過目。** 該階段尚未實作的平面，改查「不得偷跑／不得混入」；已實作的平面須可驗證通過。

## 定義

| 平面 | 組成 | 職責 |
| --- | --- | --- |
| 流量平面 | `apps/gateway-adapter`（入口） | 收應用事件、載入並執行**已簽名**限制 |
| 管理平面 | `apps/console`、`apps/control-api` | 登入、角色、案件、核准、簽名、稽核、地圖 |

## 檢查項

| # | 檢查項 | 驗證方式 | 通過條件 |
| --- | --- | --- | --- |
| P1 | 入口與 console／control-api 為**不同程序**、**不同埠**、**不同部署設定** | 讀啟動入口、套件腳本、部署設定、程序樹 | 不共用同一 Node／伺服器程序；不在同一套件內「順便」起對方的 listen |
| P2 | 流量入口埠上**絕不**提供管理路由或 API | 對入口埠探測 `/api/*`、`/login`、管理路徑；讀路由表 | 無管理路由；不得 200／302 到管理功能 |
| P3 | 管理介面／control-api **不接收應用流量**（不充當反向代理／事件入口） | 讀 control-api／console 路由與責任邊界 | 無「收應用請求並套用限制」的路徑 |
| P4 | 入口只以 **TLS** 從控制程序**拉取**已簽名限制；**不開放寫入端點**供外界建立／改限制 | 讀入口客戶端與路由；嘗試 POST／PUT 限制 | 僅拉取／載入簽名產物；無未授權寫入；傳輸 TLS |
| P5 | 管理平面停掉時，入口仍依已載入之已簽名限制執行 | 停 control-api／console 後打流量平面回歸 | 既有限制仍執行；不因管理平面不可用而放行或清空限制 |

## 階段適用

| 階段 | 本表怎麼用 |
| --- | --- |
| 1（contracts） | 不得出現 gateway／console 伺服器混用；契約層不得引入共用 listen |
| 2（登入／console／control-api） | 管理平面成型：確認無應用流量入口；尚無 gateway 時 P2／P4／P5 以「不得偷跑入口」查 |
| 3（應用接入） | 同上；事件寫入屬管理／控制路徑，不得接到流量入口埠 |
| 4（gateway-adapter） | **P1–P5 全數必過** |
| 5–8 | 每次合併重跑與變更相關的 P 項；管理平面故障不得改變入口已載入限制（P5） |

## 簽核欄（每次合併填）

- 對象變更／SHA：______________
- P1–P5：□ 全過　□ 本階段 N/A 項：____　□ 未過（編號）：____
- 結論：□ 准予合併　□ 退回
- 審查員：資安審查員　日期（Asia/Taipei）：______________

## 2026-11-05（Asia/Taipei）— 41983f7 **退回**（資安審查員）

- 對象：`41983f7`（僅此 SHA；**不含**另件 `06af858` Postgres）。
- 測試複核：with-pg control-api **17／17**；`pnpm boundaries` OK；無 `apps/gateway-adapter`；`deploy/` 尚無混用檔。
- P1：PASS（`management` 單 listener，測試驗證 addresses length=1）
- P2：本階段 N/A（尚無入口；不得偷跑 — PASS）
- P3：PASS（非管理路徑 404、不轉發 sentinel）
- P4：本階段 N/A（尚無入口拉取 — PASS）
- P5：本階段 N/A（尚無入口 — PASS）
- **預設拒絕（Phase2）：FAIL／阻擋**

### 阻擋項（必須修）
1. `authz.ts`：`if (roles === undefined) return` 把「已掛載但漏設 `config.roles`」變成**未登入亦可 200**（實測獨立 Fastify＋同一 preHandler：`GET /api/poc-open` → 200）。
2. 與先前 Phase2「preHandler 預設拒絕」衝突；且 `FastifyContextConfig.roles?` 仍為可選、**無**紅燈測鎖「已掛必有 roles」。
3. 可區分：已掛路徑有 `req.routeOptions.url`；未掛 404 的 meta 無 url。應對**已掛＋roles undefined → 401／403**，僅未匹配路徑才放行給 `setNotFoundHandler`。

### 非阻擋殘留（通過後仍註）
1. 登入空 body → 401，計入 `username=""`＋ip 速率桶（實測 3 次後同桶 429）；其他 username 不受該桶影響。
2. 建議紅燈測：掃／註冊後斷言每個已掛路由必有 `config.roles`；型別改為必填（去掉 `?` 或路由封裝強制）。

- 結論：**退回** — 平面分離 P 項本階段可過，但同 commit 的授權回歸不可合併。
- 審查員：資安審查員　日期（Asia/Taipei）：2026-11-05

## 相關

- [EDL／mirror 正式檢查表](./SECURITY-CHECKLIST-EDL-MIRROR.md)

## 2026-11-05（Asia/Taipei）— a578354 待複簽（A 已通過，B／資安審中）

- 對象：`41983f7`＋`a578354`（修預設拒絕）。
- 修復：`request.is404` 先放行；已掛缺／不符 roles → 未登入 401、已登入 403；紅燈測 `authz-route-roles`（全路由非空 roles、無 roles 探針、未掛 404）。
- with-pg control-api 10／20 綠。
- 空 body 登入＝失敗登入（計 `username=""`＋ip）見上節非阻擋殘留，仍請複簽註明。

### 2026-11-05（Asia/Taipei）— a578354 **准予合併**（複簽）

- 對象：`41983f7`＋`a578354`（不含 Postgres）。
- 修復確認：`request.is404` → 404；已掛缺／不符 roles → 未登入 401、已登入 403；已無 `roles === undefined` 放行。
- 紅燈：`authz-route-roles`；with-pg control-api **10 檔／20 測全綠**（非 10/20 通過率）。
- P1–P5 本階段適用項 PASS；預設拒絕 PASS。
- 非阻擋：空 body 登入計入 `username=""` 桶；型別 `roles?` 仍可選（runtime＋onRoute 已鎖）。
- 結論：**准予合併**。

審查員：資安審查員
