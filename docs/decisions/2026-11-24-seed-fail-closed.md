# 2026-11-24 seed 反向守門

分支 `cursor/seed-fail-closed-4a51`，基底 `team-a-ci-lock`（90d9391）。不改種子內容、不改 `db.ts` 的 SCHEMA_LOCK／statement_timeout、不加依賴。

軟體大總召裁示（未經使用者確認）：反向守門。以下正則、短路順序、拒絕訊息用詞、示範行程不自設許可旗標、再匯出去留，是駕駛員的技術選擇。

軟體大總召裁示（未經使用者確認）：production 一律拒絕，DEMO_SEED_ALLOW 只在非 production 生效。資安指出 `NODE_ENV=production` 與 `DEMO_SEED_ALLOW=1` 兩項誤設同時發生時，會清空 13 張表，並建立密碼公開的 `admin1`。因此 `NODE_ENV === "production"` 時直接拋下面那句固定訊息，連 `current_database()` 都不查；`DEMO_SEED_ALLOW=1` 不能把 production 改成放行。

## 守門

`seedPhase2Fixtures` 在 `argon2.hash`、`pg_advisory_xact_lock(SEED_LOCK)`、TRUNCATE 之前就決定放行或拒絕。`NODE_ENV` 正好是 `production` 時一律拒絕。其餘情況要兩個條件都成立才放行：

1. 環境：`NODE_ENV` 的值正好是 `test`，或（且不是 `production` 時）`DEMO_SEED_ALLOW` 的值正好是 `1`。
2. 這條連線的 `current_database()` 符合下方測試命名。

否則拋出固定的一句中文，不附 SQL、例外本文、資料庫名、URL、憑證：

`拒絕執行測試種子：未同時符合測試環境與測試資料庫命名，已中止且未改動任何資料`

環境不符時不送任何查詢。環境符合才讀庫名；讀取拋錯、結果不是字串、或空列，都改拋上面那句。`production` 不再是唯一會被擋下的寫法：未設、空字串、`prod`、`Production`、`Test`、帶空白的 `test` 都拒絕。

四個帳號、密碼、app 列與 TRUNCATE 清單維持原樣。雜湊仍在取鎖前算完。

## 測試命名

寫死的正則：

```text
/^(?:ci|flow_store_[a-z][a-z0-9_]*)$/
```

- `ci` 是完全比對。`scripts/with-pg.mjs` 在沒有既有 `DATABASE_URL` 時 `createDatabase("ci")`，連線路徑是 `/ci`。CI 用的就是這個派生庫名。
- `docs/demo/start-server.ts` 與 `docs/demo/phase2-api.md` 沒有另外指定庫名。示範命令是同一支 `with-pg.mjs` 包住 vitest，所以示範庫名也是 `ci`。`ci_extra`、`CI` 不放行。
- `flow_store_` 後面接一個小寫字母、再接小寫字母、數字或底線。`packages/flow-store/test/helpers.ts` 的 `openSchemaDb` 用呼叫端傳入的識別碼當資料庫名（該檔 `SQL_IDENT` 是 `/^[a-z_][a-z0-9_]*$/`）。實際呼叫點都是這個前綴：`flow_store_db_isolation`、`flow_store_backfill`、`flow_store_migration`、`flow_store_read_test`、`flow_store_schema_env`、`flow_store_schema_idx`、`flow_store_test`、`flow_store_testing_test`。後段比 `SQL_IDENT` 更緊，必須以小寫字母開頭，因此 `flow_store_`、`flow_store` 不放行。
- 不用「名稱裡有 test 就放行」。`contest`、`testdb`、`test`、`postgres`、`semantic_defense` 都拒絕。
- sensor-ingest 是在同一個 `ci` 庫上使用 schema `sensor_ingest_test`，不是另一個資料庫名，所以不另列。

若外層已經設定了不符合此正則的 `DATABASE_URL`，`with-pg.mjs` 不覆寫，種子會被拒絕。這是 fail closed，不是示範文件裡的啟動方式。

## 示範行程

`docs/demo/start-server.ts` 不寫入 `DEMO_SEED_ALLOW`。程式若在 `DEMO_SEED` 預設開啟時自己設成 `1`，旗標就不再是操作者的明示；那一行唯一會改變結果的情況，是外層 shell 已經把 `NODE_ENV` 設成 `production` 之類，而那正是該拒絕的場景。

`docs/demo/phase2-api.md` 的啟動指令都是 `with-pg.mjs` 包住 vitest，沒有自帶 `NODE_ENV`。vitest 在 `NODE_ENV` 未設時補上 `test`，庫名是 with-pg 的 `ci`，兩個條件都成立。因此沒有改 `phase2-api.md`，也沒有在那些指令前加上 `DEMO_SEED_ALLOW=1`。

## 再匯出

拿掉 `apps/control-api/src/app.ts` 的 `seedPhase2Fixtures` 再匯出。生產模組不再載入含明碼測試密碼的種子檔。

測試檔仍經 `apps/control-api/test/helpers/app.ts` 匯入（既有「測試只經此面」契約）。該 helper 改為直接 import `seed-phase2.ts`。`docs/demo/start-server.ts` 與 `apps/control-api/test/README.md` 的範例也改為直接 import `seed-phase2`。沒有改三十幾個測試檔的 import 路徑：那些檔案本來就不經過 `app.ts` 的路徑字面，改動會超過本切片需要的範圍，也會打破 helper 這層測試面。若審查者要測試檔自身改直匯，可以另切。

這取代 `docs/decisions/2026-11-18-ci-lock-race.md` 裡「`app.ts` 仍 re-export」那一句。`SECURITY-CHECKLIST-PHASE2-CONTROL-API.md` 建議測試改直匯的條目，由本文件接上；檢查表正文不改寫。
