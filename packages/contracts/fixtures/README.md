# contracts 假資料

第 1 階段驗收；可重複讀取。契約物件不含參數原文／本文／標頭／模型指示。
`events/same-intent-*`→`cases/same-intent-read-to-admin`；`normal-*`→read↔write；`*-sanitized` 消毒版；`meta/instruction-attack-raw` 非契約、僅供斷言。列舉限 read|write|auth|admin。

僅靜態讀取假資料、不呼叫公開 API 的檢查為**非 TDD 紅燈項**。

## R1：識別字串收窄（總召／資安）

PLAN.md 標為 `uuid` 的欄位必須為 UUID 格式，非法格式整份拒絕：

- 請求事件：`event_id`
- 案件摘要：`case_id`

其餘識別／名稱類自由字串採安全字元白名單與長度上限（**本階段驗收選定**）：

- **正則：** `/^[A-Za-z0-9_.:-]+$/`
- **最大長度：** `128`（至少 1；空字串拒絕）
- **套用欄位：** `app_id`、`actor_id`、`session_id`、`subject.id`、`route_family`、`param_roles[].name`

`param_roles[].type` 只准列舉：`string`｜`number`｜`boolean`。

拒絕案例（測試覆蓋）：空白、換行、引號、角括號、提示詞／指令風格文字、超長（>128）、空字串。

## R2：數值非負與整數（總召／資安）

案件摘要：

- `distance`、`count`、`normal_neighbor_count` 必須 **≥ 0**
- `count`、`normal_neighbor_count` 必須為**整數**（拒絕 `-1`、`1.5`；若執行期可傳入則亦拒 `NaN`／`Infinity`）

本目錄假資料已符合 R1／R2（UUID、白名單識別字、非負整數計數）。
