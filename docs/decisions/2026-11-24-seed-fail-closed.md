# 2026-11-24 seed 反向守門

分支 `cursor/seed-fail-closed-4a51`，基底 `team-a-ci-lock`（90d9391）。不改種子內容、不改 `db.ts` 的 SCHEMA_LOCK／statement_timeout、不加依賴。

軟體大總召裁示（未經使用者確認）：反向守門。以下正則、短路順序、拒絕訊息用詞、示範靠 vitest 的 NODE_ENV=test、再匯出去留，是駕駛員的技術選擇。

軟體大總召裁示（未經使用者確認）：production 一律拒絕。資安指出 `NODE_ENV=production` 與當時的許可變數同時誤設時，會清空 13 張表，並建立密碼公開的 `admin1`。

軟體大總召裁示（未經使用者確認）：拿掉 DEMO_SEED_ALLOW，只留 NODE_ENV==='test' 加測試庫名。這個旗標沒有合法使用者，而且大小寫不同的 production 寫法（`Production`、`prod`、前後空白）可以靠它繞過「production 一律拒絕」。程式不再讀取該變數。放行只剩 `NODE_ENV` 正好是 `test`，且 `current_database()` 符合下方測試命名；其餘一律拒絕，環境不符時不查庫名。

## 強化（team-a-harden-h1）

基底 `team-a-autolist-2611`（14534a2）。不改種子內容、不加契約欄位、不改依賴。

軟體大總召裁示（未經使用者確認）：三項一起做。正則、再驗位置、檔案所在目錄是 A 組領航員裁示（未經使用者確認）。

1. 測試庫名改用專案前綴。正則改為 `/^(?:sd_ci|sd_flow_store_[a-z][a-z0-9_]*)$/`。`scripts/with-pg.mjs` 在沒有既有 `DATABASE_URL` 時 `createDatabase("sd_ci")`。flow-store 測試庫改為 `sd_flow_store_*`。舊名 `ci` 與 `flow_store_*` 拒絕。
2. 在 seed 交易內、取 `SEED_LOCK` 之前，用同一個交易客戶端再驗一次 `current_database()`。不符就用同一句拒絕訊息中止，不取鎖、不 TRUNCATE。
3. `seed-phase2.ts` 從 `apps/control-api/src/` 移到 `apps/control-api/test-support/`。正式編譯只含 `src/`，產物不含種子檔與測試密碼。`test/helpers/app.ts` 與 `docs/demo/start-server.ts` 改從新位置匯入。

以下各節是這個狀態。

## 守門

`seedPhase2Fixtures` 在 `argon2.hash`、`pg_advisory_xact_lock(SEED_LOCK)`、TRUNCATE 之前就決定放行或拒絕。進入交易之後、取 `SEED_LOCK` 之前，再用同一個交易客戶端做一次相同檢查。兩個條件都成立才放行：

1. 環境：`NODE_ENV` 的值正好是 `test`。沒有其他環境變數可以放行。
2. 這條連線的 `current_database()` 符合下方測試命名。

否則拋出固定的一句中文，不附 SQL、例外本文、資料庫名、URL、憑證：

`拒絕執行測試種子：未同時符合測試環境與測試資料庫命名，已中止且未改動任何資料`

環境不符時不送任何查詢。環境符合才讀庫名；讀取拋錯、結果不是字串、或空列，都改拋上面那句。`production` 不再是唯一會被擋下的寫法：未設、空字串、`prod`、`Production`、`Test`、帶空白的 `test` 都拒絕。

四個帳號、密碼、app 列與 TRUNCATE 清單維持原樣。雜湊仍在取鎖前算完。

交易內的第二次檢查走該筆 `db.tx` 的 client，不另開連線。庫名不符、讀取拋錯、結果不是字串或空列，都拋上面那句；此時交易裡還沒有 `pg_advisory_xact_lock` 與 TRUNCATE。外層檢查已經拒絕時不會進交易。

## 測試命名

寫死的正則：

```text
/^(?:sd_ci|sd_flow_store_[a-z][a-z0-9_]*)$/
```

- `sd_ci` 是完全比對。`scripts/with-pg.mjs` 在沒有既有 `DATABASE_URL` 時 `createDatabase("sd_ci")`，連線路徑是 `/sd_ci`。CI 與示範用的就是這個派生庫名。Postgres 角色仍是 `ci`，比對的是資料庫名，不是角色名。
- 舊名 `ci` 必須拒絕。`sd_ci_extra`、`SD_CI`、`sd_CI` 也不放行。
- `docs/demo/start-server.ts` 與 `docs/demo/phase2-api.md` 沒有另外指定庫名。示範命令是同一支 `with-pg.mjs` 包住 vitest，所以示範庫名也是 `sd_ci`。
- `sd_flow_store_` 後面接一個小寫字母、再接小寫字母、數字或底線。`packages/flow-store/test/helpers.ts` 的 `openSchemaDb` 用呼叫端傳入的識別碼當資料庫名（該檔 `SQL_IDENT` 是 `/^[a-z_][a-z0-9_]*$/`）。實際呼叫點都是這個前綴：`sd_flow_store_db_isolation`、`sd_flow_store_backfill`、`sd_flow_store_migration`、`sd_flow_store_read_test`、`sd_flow_store_schema_env`、`sd_flow_store_schema_idx`、`sd_flow_store_test`、`sd_flow_store_testing_test`。後段必須以小寫字母開頭，因此 `sd_flow_store_`、`sd_flow_store`、`sd_flow_store_1`、`sd_flow_store_Test` 不放行。舊名 `flow_store_*`（沒有 `sd_`）拒絕。
- 不用「名稱裡有 test 就放行」。`contest`、`testdb`、`test`、`postgres`、`semantic_defense` 都拒絕。
- sensor-ingest 是在同一個 `sd_ci` 庫上使用 schema `sensor_ingest_test`，不是另一個資料庫名，所以不另列。

若外層已經設定了不符合此正則的 `DATABASE_URL`，`with-pg.mjs` 不覆寫，種子會被拒絕。這是 fail closed，不是示範文件裡的啟動方式。

## 示範行程

示範不靠許可變數。`docs/demo/start-server.ts` 不讀取、不設定種子許可。`docs/demo/phase2-api.md` 的啟動指令都是 `with-pg.mjs` 包住 vitest，沒有自帶 `NODE_ENV`。vitest 在 `NODE_ENV` 未設時補上 `test`，庫名是 with-pg 的 `sd_ci`，兩個條件都成立。啟動器改從 `apps/control-api/test-support/seed-phase2.ts` 匯入。

## 再匯出

拿掉 `apps/control-api/src/app.ts` 的 `seedPhase2Fixtures` 再匯出。生產模組不再載入含明碼測試密碼的種子檔。

種子檔現在在 `apps/control-api/test-support/seed-phase2.ts`，不在 `src/`。正式編譯只納入 `src/`，產物沒有 `seed-phase2`、`seedPhase2Fixtures` 與測試密碼。

測試檔仍經 `apps/control-api/test/helpers/app.ts` 匯入（既有「測試只經此面」契約）。該 helper 直接 import `test-support/seed-phase2.ts`。`docs/demo/start-server.ts` 也從這個路徑匯入。`apps/control-api/test/README.md` 的範例改為同一路徑。沒有改三十幾個測試檔的 import 路徑：那些檔案本來就經 helper，不經過 `app.ts` 的路徑字面。若審查者要測試檔自身改直匯，可以另切。

這取代 `docs/decisions/2026-11-18-ci-lock-race.md` 裡「`app.ts` 仍 re-export」那一句。`SECURITY-CHECKLIST-PHASE2-CONTROL-API.md` 建議測試改直匯的條目，由本文件接上；檢查表正文不改寫。
