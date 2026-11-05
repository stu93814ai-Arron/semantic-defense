# 第 1 階段資安檢查表（合併前／資安審查員）

依據：`PLAN.md`「不可更改」「契約」「階段 1」「軟體安全」。  
範圍：僅 `packages/contracts` 與測試。本階段不實作登入、簽章、入口、模型呼叫；下列項目若出現實作跡象，視為越界，應擋下合併。

審查員角色：合併前最後一關。本表每項必須「可驗證通過」才准合併；掃描通過不代表行為已存在。

**每次簽核另查：** [流量／管理平面分離](./SECURITY-CHECKLIST-PLANE-SEPARATION.md)（本階段以不得偷跑入口／不得混用 listen 為主）。

---

## A. 契約嚴格性（本階段必過）

| # | 檢查項 | 驗證方式 | 通過條件 |
| --- | --- | --- | --- |
| A1 | 請求事件只接受契約欄位：`event_id`, `app_id`, `ts`, `route_template`, `param_roles`, `response_class`, `session_id`, `actor_id`, `sensitive` | 對驗證器送入含任意多餘頂層欄位的物件 | 整份作廢／拒絕，不可靜默忽略後通過 |
| A2 | 案件摘要只接受契約欄位：`case_id`, `app_id`, `actor_id`, `session_id`, `transitions`, `privileged_target`, `normal_neighbor_count`；`transitions[]` 只准 `from_family`, `to_family`, `distance`, `count` | 同上，含巢狀多餘欄位 | 整份作廢 |
| A3 | 限制草案只接受契約欄位：`app_id`, `route_family`, `from_state`, `to_state`, `subject`, `action`, `expires_at`；`subject` 只准 `type`+`id` | 同上 | 整份作廢 |
| A4 | 簽名後限制的 `constraint_id`、`signed_at`、`signature` 不得由契約「草案」驗證路徑接受為合法草案輸入 | 把簽名欄位塞進草案輸入 | 草案驗證失敗 |
| A5 | `response_class` 枚舉只准 `read` \| `write` \| `auth` \| `admin` | 邊界值／其他字串 | 拒絕 |
| A6 | `subject.type` 只准 `actor` \| `session`；`action` 只准 `log` \| `deny` | 邊界值 | 拒絕 |
| A7 | 事件不得含參數值、本文、標頭、模型指示（含同義欄位名如 `params`、`body`、`headers`、`prompt`、`raw`） | 惡意／別名欄位測資 | 整份作廢 |
| A8 | 限制草案不得含下發指令、網址、自由文字說明欄位 | 多餘字串欄位測資 | 整份作廢 |
| A9 | 未知／錯誤型別（非 uuid／非 RFC3339／非約定型別）一律拒絕 | 型別錯測資 | 拒絕，不可寬鬆轉型後通過 |

---

## B. 參數原文不可還原（本階段必過）

| # | 檢查項 | 驗證方式 | 通過條件 |
| --- | --- | --- | --- |
| B1 | 假資料含「參數值試圖命令模型改變輸出」的一筆；該參數**原文**不得出現在任何合法事件物件 | 讀假資料 → 序列化事件 JSON → 全文搜尋該原文／明顯片段 | 零命中 |
| B2 | 同一原文不得出現在任何合法案件摘要 | 同上對摘要 | 零命中 |
| B3 | `param_roles` 僅含 `name`+`type`（角色／型別），不含值 | schema + 實例檢查 | 無 value／原文欄位 |
| B4 | `route_template` 僅模板（如 `/orders/{id}`），不得嵌入實際參數值 | 實例檢查 | 無具體值嵌入 |
| B5 | 從「所有可重複讀取的假事件 + 假摘要」集合，無法拼回該攻擊參數原文 | 審查假資料設計 + 字串搜尋 | 無法還原 |
| B6 | 測試／fixture 若需描述攻擊情境，攻擊原文只存在測試斷言字串或獨立註解資料源，且**不得**經由契約物件建構路徑流入事件／摘要 | 靜態檢查測資與工廠函式 | 契約物件路徑乾淨 |

---

## C. 模型輸入隔離（本階段預埋／越界擋）

| # | 檢查項 | 驗證方式 | 通過條件 |
| --- | --- | --- | --- |
| C1 | 規格聲明：案件摘要是**唯一**可送給意圖模型的物件；契約套件不得提供「把事件／原文餵給模型」的型別或轉換捷徑 | 讀匯出 API／型別 | 無此捷徑 |
| C2 | 本階段不得出現真實模型客戶端、提示組裝、或把自由文字拼進「擬模型輸入」 | 目錄與依賴檢查 | 無；僅契約與假資料 |
| C3 | 假資料中「帶指示的參數」僅用來證明**不會**進入事件／摘要，不得另開後門欄位保留原文給「之後模型用」 | 假資料審查 | 無後門欄位 |

---

## D. 權杖／金鑰位置（本階段預埋／越界擋）

| # | 檢查項 | 驗證方式 | 通過條件 |
| --- | --- | --- | --- |
| D1 | `packages/contracts` 與測試中無生產權杖、模型金鑰、簽章金鑰、入口權杖 | 密文掃描 + 人工抽查 | 零命中（測試用假值若出現須明顯標為 fake 且不可當真金鑰格式誤用） |
| D2 | 不得新增會暗示「金鑰放前端／放契約／放假資料」的常數或範例 | 程式與 README／註解 | 無 |
| D3 | 開發機器人／本階段產物不接觸生產權杖（依總計畫） | PR 說明與檔案 diff | 無秘密檔、無 `.env` 真值提交 |

---

## E. 權限檢查／簽章範圍（本階段：不實作，但禁止偷跑）

| # | 檢查項 | 驗證方式 | 通過條件 |
| --- | --- | --- | --- |
| E1 | 本階段不新增 `apps/*`、登入、角色、路由授權實作 | 目錄 diff | 僅 `packages/contracts`（及必要的 workspace 設定） |
| E2 | 本階段不實作簽章、不產生／驗證 `signature` | 程式搜尋 | 無簽章邏輯；契約可**定義**簽名後欄位型別，但不可宣稱已驗證 |
| E3 | 若型別有「已簽名限制」，文件／測試須標明：簽章範圍未來須涵蓋契約內全部欄位與 `expires_at`；本階段不做驗證器通過＝已簽名 | 註解／測試名稱 | 無誤導為已完成簽章安全 |

---

## F. 不可更改約束（本階段相關）

| # | 檢查項 | 通過條件 |
| --- | --- | --- |
| F1 | 契約欄位只准用 `PLAN.md` 所列；多出來的欄位整份作廢 | 與 A1–A8 一致，測試覆蓋「多餘即整份拒絕」 |
| F2 | 技術選型未擅自更換（契約層 TypeScript；未引入他種契約 runtime 取代） | 與計畫一致；若需變更須先停並詢問，不得在 PR 中偷換 |
| F3 | 未開始第 2+ 階段目錄／功能 | 無越階段提交 |

---

## G. 階段 1 驗收對齊（合併閘門）

| # | 計畫驗收原文 | 檢查表對應 |
| --- | --- | --- |
| G1 | 契約以外的欄位被拒絕 | A1–A9 |
| G2 | 從事件與案件摘要無法還原參數原文 | B1–B6 |
| G3 | 假資料可被測試重複讀取 | 測試兩次載入／匯出穩定；至少四筆（含三種路徑同意圖、平常 read↔write、帶指示參數且原文不進契約物件） |

---

## 合併前審查員簽核

- [ ] A 全過（契約嚴格拒絕多餘欄位）
- [ ] B 全過（無法從事件／摘要還原參數原文）
- [ ] C–E 無越界（模型／金鑰／權限／簽章未偷跑）
- [ ] F 未改「不可更改」
- [ ] G 與計畫三條驗收一致
- [ ] 依賴／密文掃描：無寫死權杖；高風險問題已處理（總計畫合併閘門）

**結論：** □ 准予合併　□ 退回（列出未過編號與證據）

審查員：資安審查員  
對象 PR／變更：______________  
日期（Asia/Taipei）：______________

---

## 簽核紀錄

### 2026-11-05（Asia/Taipei）— 准予合併（附殘留風險）

- 對象：`packages/contracts`，請求審 `21793dd`（父 `80c7738`）；審核當下 HEAD 因 CI 閘門紀錄成為 `b8514b5`（僅 `.ci/gate-history.csv` +1）。
- 差異相對 `9ffeda9..21793dd`：+386/−6，範圍僅 contracts fixtures/src/test。
- 測試：74 全綠；`pnpm run ci` GREEN；gitleaks 無洩漏。
- A／B／C／D／E／F／G：通過（A9 數值無下限為次要）。
- **R1（第 2 階段前必須修，不擋本階段）：** `app_id`／`actor_id`／`session_id`／`param_roles.name|type`／`route_family`／`subject.id` 為不限字元集與長度的自由字串；指示文字可經 `actor_id`／`session_id` 原樣進入案件摘要（未來模型輸入）。要求：識別欄固定格式（如 `^[A-Za-z0-9._:-]{1,64}$`），`param_roles.type` 改列舉，並補測試。
- **R2（建議同步修）：** `distance`／`count`／`normal_neighbor_count` 加 nonnegative；後兩者改 int。
- 結論：**准予合併**。

審查員：資安審查員

### 2026-11-05（Asia/Taipei）— R1／R2 收窄：准予合併（附後續）

- 對象程式：`fd782b5`（`packages/contracts/src/index.ts` +15/−12）；測試先前提交含 `test/r1-r2-narrowing.test.ts`。
- R1：`Id` = min1 max128 + `/^[A-Za-z0-9_.:-]+$/` 套用於 app_id／actor_id／session_id／param_roles.name／route_family／subject.id；`param_roles.type` = enum string|number|boolean。指示文句經 actor_id 實測被拒且錯誤不回原文。長度 128（非 64）可接受。
- R2：distance nonnegative；count／normal_neighbor_count = int nonnegative。解析路徑通過。
- 測試宣稱 201／201、ci GREEN（審查員抽核源碼與煙測通過）。
- **N1（第 2 階段前必修，不擋本次；由 A 組修，修完再簽）：** `toCaseSummary` 未驗證 `opts`／輸出，可回傳負 distance 或非整數 normal_neighbor_count。請對 opts 或輸出跑 `CaseSummarySchema`。
- **N3：** 程式收窄已單獨提交為 `fd782b5`；本檔簽核紀錄另以 docs commit 入庫。
- 結論：**准予合併**。

審查員：資安審查員

### 2026-11-05（Asia/Taipei）— N1 關閉：准予合併

- 對象：`c84ddf6`（`fix(contracts): N1 toCaseSummary 經 CaseSummarySchema 守門`）。
- 流程核對：空→`empty_events`；逐筆 `parseRequestEvent`（失敗原樣回）；`mixed_identity`；`OptsSchema`；最後 `return parseCaseSummary(draft)`。
- 煙測：`distance:-5`／`normal_neighbor_count:1.5` → `ok:false`；指示文句 `actor_id` → `invalid_format`；錯誤不回原文。
- 範圍：僅 contracts；契約嚴格性／非回顯／指示拒絕仍成立。
- 結論：**准予合併**；N1 殘留關閉。

審查員：資安審查員
