# packages/contracts 假資料規格

本目錄只服務第 1 階段驗收。假資料必須可被測試**重複讀取**且結果一致。契約物件（事件、案件摘要、限制草案）**不得**承載參數原文、請求本文、標頭或模型指示。

實作尚未存在時，驗收測試會因匯入公開 API 失敗而全紅；假資料本身不依賴實作。

## 測試燈號說明

未實作公開 API 時，依賴 `parseRequestEvent`／`parseCaseSummary`／`parseConstraintDraft`／`toCaseSummary` 的案例應為紅燈。僅靜態讀取假資料、不呼叫上述 API 的檢查（目前約 17 筆）為**非 TDD 紅燈項**：它們驗證假資料本身可重複讀取且不含攻擊原文，即使實作未完成也可以（且應該）通過。

## 目錄约定

| 路徑 | 用途 |
| --- | --- |
| `events/*.json` | 合法（或預期經解析後合法）的**請求事件**契約物件 |
| `cases/*.json` | 合法**案件摘要**契約物件 |
| `meta/instruction-attack-raw.json` | **非契約物件**。僅記錄「參數值試圖命令模型」的原文，供測試斷言搜尋用；不得經由 `parseRequestEvent` / `parseCaseSummary` / `toCaseSummary` 流入契約 |

## 至少四筆情境（對齊 PLAN.md 階段 1）

### 1–3. 同一意圖、三種路徑模板

同一 `app_id` / `actor_id` / `session_id` 下，三種不同 `route_template` 的讀取，再走向管理匯出，應收成**同一種**轉移：`from_state=read` → `to_state=admin`（摘要見 `cases/same-intent-read-to-admin.json`）。

| 檔案 | 說明 |
| --- | --- |
| `events/same-intent-a-read.json` | 模板 `/orders/{id}`，`response_class=read` |
| `events/same-intent-b-read.json` | 模板 `/api/v1/orders/{orderId}`，`response_class=read` |
| `events/same-intent-c-read.json` | 模板 `/me/orders/{id}`，`response_class=read` |
| `events/same-intent-admin-export.json` | 模板 `/admin/exports`，`response_class=admin`，`sensitive=true` |
| `cases/same-intent-read-to-admin.json` | 對應案件摘要：單一 transition `read`→`admin` |

### 4. 平常操作（只在 read 與 write 之間）

| 檔案 | 說明 |
| --- | --- |
| `events/normal-read.json` | `/orders/{id}`，`response_class=read` |
| `events/normal-write.json` | `/orders/{id}`，`response_class=write` |
| `cases/normal-read-write.json` | 摘要僅含 `read`↔`write` 轉移，無 `admin` |

### 5. 帶指示的參數（原文不得進事件／摘要）

| 檔案 | 說明 |
| --- | --- |
| `meta/instruction-attack-raw.json` | 欄位 `attack_text`：試圖命令模型改輸出的參數原文；另含 `forbidden_substrings` 供斷言 |
| `events/instruction-attempt-sanitized.json` | 攻擊情境收成的**合法事件**：只有 `param_roles`（name+type），**無**參數值；全文不得出現 `attack_text` |
| `cases/instruction-attempt-sanitized.json` | 對應案件摘要；全文不得出現 `attack_text` |

## 契約欄位（僅准 PLAN.md 所列）

### 請求事件

`event_id`, `app_id`, `ts`, `route_template`, `param_roles`（元素僅 `name`+`type`）, `response_class`（`read`\|`write`\|`auth`\|`admin`）, `session_id`, `actor_id`, `sensitive`

不得出現：參數值、本文、標頭、模型指示，或任何契約外欄位（多一欄整份作廢）。

### 案件摘要

`case_id`, `app_id`, `actor_id`, `session_id`, `transitions`（元素僅 `from_family`, `to_family`, `distance`, `count`）, `privileged_target`, `normal_neighbor_count`；其中 `from_family`／`to_family`／`privileged_target` 只准 `read`｜`write`｜`auth`｜`admin`（**此限制為總召對 PLAN 的解讀**）

這是唯一可送給意圖模型的物件。

### 限制草案

`app_id`, `route_family`, `from_state`, `to_state`, `subject`（僅 `type`+`id`；`type` 為 `actor`｜`session`）, `action`（`log`｜`deny`）, `expires_at`；其中 `from_state`／`to_state` 只准 `read`｜`write`｜`auth`｜`admin`（**此限制為總召對 PLAN 的解讀**）

不得含下發指令、網址、自由文字說明。`constraint_id` / `signed_at` / `signature` 屬簽名後欄位，不得被草案解析接受。

## 家族／狀態列舉（總召解讀）

`from_family`、`to_family`、`privileged_target`、`from_state`、`to_state` 只准 `read`｜`write`｜`auth`｜`admin`（與 `response_class` 相同；轉移由 `response_class` 衍生）。**此限制為總召對 PLAN 的解讀。**

## 公開 API（測試只打這些，不打 zod）

- `parseRequestEvent(input)` → `{ ok: true, value } | { ok: false, errors }`（不拋例外）
- `parseCaseSummary(input)` → 同上
- `parseConstraintDraft(input)` → 同上
- `toCaseSummary(events)` → 由事件列產生摘要（測試用來證明無法還原參數原文）

## 重複讀取

測試會對同一路徑 `readFile`／`JSON.parse` 兩次以上，要求 deep equal。假資料檔不得依賴亂數、時間戳產生器或單次讀取副作用。
