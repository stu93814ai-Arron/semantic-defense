# contracts 假資料

第 1 階段驗收用；可重複讀取、結果一致。契約物件不得含參數原文、本文、標頭或模型指示。

| 路徑 | 用途 |
| --- | --- |
| `events/same-intent-{a,b,c}-read.json` + `same-intent-admin-export.json` | 同一意圖、三種路徑模板，收成 read→admin（`cases/same-intent-read-to-admin.json`） |
| `events/normal-{read,write}.json` | 平常操作，只在 read↔write（`cases/normal-read-write.json`） |
| `events/`、`cases/instruction-attempt-sanitized.json` | 帶指示參數情境的消毒後契約物件，不含攻擊原文 |
| `meta/instruction-attack-raw.json` | **非契約**：攻擊原文與 `forbidden_substrings`，僅供斷言搜尋 |

契約欄位以 PLAN.md 為準；家族／狀態列舉限 `read|write|auth|admin`（總召解讀）。
