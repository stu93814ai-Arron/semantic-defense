# 2026-11-18 ci 步驟 1 鎖競態（ci-lock）

分支 team-a-ci-lock，基底 main 1b22e95。本文件不改 PLAN.md、contracts、apps/console，無依賴變更。

## 背景

整疊 68bfdf1（acct-norm＋audit-exc）的正式 ci 連續兩次在步驟 1（必跑測試第一次、帶 coverage）被 `timeout 600` 砍掉。
不計分診斷 ci（同 68bfdf1、30 秒 sidecar，證據 `ae-drv-diag2-{static,ci,sidecar}.txt`）重現了逾時，且阻擋鏈指向 main 上既有的測試競態，不是 acct-norm 或 audit-exc 帶進來的。

## 阻擋鏈（診斷 sidecar 最後一輪，逾時前約 30 秒）

| 後端 | 狀態 | 持有 | 等待 | 被誰擋 |
|---|---|---|---|---|
| T（seed） | active，`TRUNCATE TABLE alert_outbox, audit_events, thresholds, allowlist_entries, …`，約 7 分鐘 | SEED_LOCK（872364202，session advisory）；alert_outbox、audit_events、thresholds 的 AccessExclusive | **看不到任何未授予的鎖、無 wait_event** | — |
| J（判定 tick） | `SELECT … thresholds` waiting | allowlist_entries 的 ShareLock（lockAllowlistShare） | thresholds 的 AccessShare | T |
| M1（某測試的 openDb） | `CREATE INDEX` waiting，約 6 分鐘 | SCHEMA_LOCK（872364201） | audit_events 的 ShareLock | T |
| M2…M10（之後各測試的 openDb） | `SELECT pg_advisory_lock` waiting | — | SCHEMA_LOCK | M1 → 依序排隊 |

T 開著的 TRUNCATE 擋住 J 與 M1；M1 在 SCHEMA_LOCK 下無時限等 audit_events，之後每個 buildApp／openDb 都排在 SCHEMA_LOCK 後面，直到步驟 1 的 600 秒用完。

## 成因與修法

A 組領航員裁示（未經使用者確認）：三項一起修，各有確定性重現測試（`apps/control-api/test/ci-lock-race.test.ts`）。

1. **seed 期間判定 timer 已在跑。** judge-auto.test.ts（約 :247、:525）、judge-tick.test.ts（約 :181）以 `judgeIntervalMs: 20` 呼叫 bootJudgeApp；buildApp 內 hookTimers 先啟 setInterval，bootJudgeApp 之後才 seedPhase2Fixtures（TRUNCATE … CASCADE）。tick 在 seed 中途觸發，與 TRUNCATE 互搶 allowlist_entries／thresholds。
   - 修法（只改測試輔助，不改正式 buildApp 啟動順序）：要排程時，bootJudgeApp 先用不排程的 app 重建 fixtures、關掉，再開真正的 app。
   - 測試：假 setInterval；測試先握 SEED_LOCK，讓 seed 卡住，再看此時已排程的 timer 數；修前為 1，修後為 0，seed 完成後為 1。
2. **SEED_LOCK 泄漏。** seedPhase2Fixtures 以 `app.db.query`（pg.Pool）分別送出 pg_advisory_lock、TRUNCATE、pg_advisory_unlock；三者可能落在不同連線，unlock 落空（回 false），session 鎖留在借出 lock 的那條連線上，直到 pool 關閉。
   - 修法：整段在 `db.withSession()` 內，同一條連線 lock → TRUNCATE → 種子 → unlock。
   - 測試：假 Db 把第一個查詢（lock）分到連線 A、其餘分到 B（模擬 pool），seed 後查 pg_locks；修前 A 仍持有 SEED_LOCK，修後沒有。
3. **遷移語句無 lock_timeout。** apps/control-api/src/db.ts 的 migrate 在 SCHEMA_LOCK 下逐條執行 SCHEMA_STATEMENTS；`CREATE INDEX IF NOT EXISTS` 即使索引已存在也要先取表的 ShareLock，表被鎖就無限等，SCHEMA_LOCK 也一直握著。
   - 修法（正式啟動行為）：每條遷移語句各自在短交易內 `SET LOCAL lock_timeout = '5s'`（比照 acct-norm 5633f6c）；逾時（55P03）即拒絕啟動，訊息「無法在時限內取得資料表的鎖以套用結構遷移，已拒絕啟動；請確認沒有長時間交易佔用資料表後再重試」，不含 IP、時間戳、憑證、URL、SQL 或例外字串；SCHEMA_LOCK 於 finally 釋放。
   - 測試：另一交易以 ACCESS EXCLUSIVE 鎖住 audit_events，openDb 必須在 9 秒內以上述訊息失敗，且之後沒有人持有 SCHEMA_LOCK；修前 openDb 卡住（9 秒時仍握 SCHEMA_LOCK）。

駕駛員自行決定（交 A 組領航員）：
- lock_timeout 套用到**全部** SCHEMA_STATEMENTS，不只 CREATE INDEX。`ALTER TABLE … ADD COLUMN IF NOT EXISTS` 即使欄位已存在也要取 ACCESS EXCLUSIVE，會擋所有 SELECT，風險比 CREATE INDEX 更大。若只要 CREATE INDEX，可在 runSchemaStatement 前加判斷收窄。
- 修法 1 只在 judgeIntervalMs 或 alertDeliverIntervalMs > 0 時走「先 seed 再開 app」，其餘 bootJudgeApp 呼叫維持原路徑（不多開一次 app）。
- 修法 3 的訊息不寫表名，與 acct-norm 的「帳號資料表」不同，因為遷移語句涵蓋多張表。

## 突變（暫時改動後還原，皆轉紅）

- 拿掉 migrate 的 `SET LOCAL lock_timeout` → ③ 紅（openDb 9 秒仍卡住）。
- seedPhase2Fixtures 改回 pool.query（1b22e95 版）→ ② 紅（SEED_LOCK 仍被持有）。
- bootJudgeApp 改回先開 app（含 timer）再 seed（1b22e95 版）→ ① 紅（seed 期間 timer 數為 1）。

## 未證實

- **TRUNCATE 為何一直 active 約 7 分鐘卻看不到未授予的鎖：未證實。**
  探查（`cl-drv-truncate-probe.txt`，未入庫）：一條連線先握 allowlist_entries 的 SHARE（模擬 tick），另一條跑同一句 TRUNCATE，再讓前者 SELECT thresholds。結果 TRUNCATE 顯示 `wait_event=Lock/relation`、allowlist_entries 的 AccessExclusive `granted=false`，約 1 秒（deadlock_timeout）後被 40P01 中止，tick 繼續。
  也就是說，單純的重量級鎖循環會被死結偵測解開，且一定看得到未授予的鎖；ci 中看到的狀態（active、無 wait_event、無未授予的鎖、0% CPU）不是這種情況。可能與 coverage 下的 fast-path 鎖轉移或其他非重量級等待有關，目前沒有證據。
- 修法 1 消除了 tick 與 seed 的重疊，修法 3 讓遷移在 5 秒內失敗而不是排長龍；即使上述機制未明，ci 也應從「必逾時」變成「通過或可觀測的紅」。是否完全消除，要等整疊正式 ci 驗證。

## 另切：強化清單

A 組領航員裁示（未經使用者確認）：以下第 4 項不在本切片，列入強化清單另切：
- CI 覆寫 `SD_FLOW_INDEX_TIMEOUT_MS`（遠小於步驟預算），讓 flow-store 的 CREATE INDEX CONCURRENTLY 先失敗，而不是吃光 600 秒。
- 評估在 CONCURRENTLY 前釋放 FLOW_SCHEMA_LOCK（packages/flow-store/src/write.ts）；涉及 flow-store 啟動語意，需另行裁示。

## 合入路線（尚未執行）

A 組領航員裁示（未經使用者確認）：本切片先交 A 審；之後排成 1b22e95 → ci-lock → acct-norm 4 顆 → audit-exc 1 顆（新分支 team-a-lock-acct-audit），整疊 strict rebase -x、range-diff、jscpd，再跑一次正式 ci 10/10（保留 30 秒 sidecar），證據前綴 cl-drv-*。資安在 ci-lock 審查時介入。

## 第三段與送資安前加固

軟體大總召裁示（未經使用者確認）：用 `statement_timeout` 限住 advisory lock 等待，不得只設 `lock_timeout`。本節其後的還原失敗拒啟、`release(true)`、cancel、xact 鎖等，仍為 A 組領航員裁示（未經使用者確認）。

本段疊在 ci-lock 第三段 tip b646999 之後，屬加固與測試衛生，**不是**對 ci 步驟 1 持續卡住的解釋或修復證明。無法證明能解決 diag4 所見的 20 秒 Vitest 逾時與約 53 秒 SEED_LOCK 外洩。重點整疊與正式 ci＋sidecar 仍等總召，不在本切片自行開跑。

### SCHEMA_LOCK 取鎖用 statement_timeout（57014）

軟體大總召裁示（未經使用者確認）：`pg_advisory_lock(SCHEMA_LOCK)` 在 `migrate` 裡於交易外執行。`SET LOCAL lock_timeout` 只在交易內有效，因此不能包住這句取鎖。改為只對取鎖那一句設定 `statement_timeout = 5s`（取到或失敗後立刻還原）；逾時 SQLSTATE 為 57014，映成固定中文 `MIGRATE_ADVISORY_LOCK_FAILED`，與遷移語句的 `lock_timeout`／55P03／`MIGRATE_LOCK_FAILED` 區分。

邊角：取鎖當下若已授予卻同時收到 57014，session 仍可能握著 SCHEMA_LOCK，而 `locked` 不會被設為 true，`migrate` 的 `finally` 不會 unlock。openDb 失敗路徑會 `client.release(true)` 並 `pool.end()`。依 node-pg，`release(true)` 丟棄該 client（結束後端 session），PostgreSQL 會在 session 結束時釋放 session advisory lock；這是依賴的清理路徑，不是對所有驅動版本與錯誤形況的保證。

A 組領航員裁示（未經使用者確認）：還原 `statement_timeout`：取鎖成功但還原失敗則拒啟（固定中文 `MIGRATE_TIMEOUT_RESTORE_FAILED`，不繼續帶 5 秒限制跑遷移）；取鎖本身失敗時仍拋原錯（含 57014 映成的訊息），還原錯不得蓋掉原錯。遷移連線在成功與失敗路徑一律 `release(true)`，不還回 app pool。因此每次啟動都會丟棄一條遷移連線。非 57014 的取鎖／啟動錯誤仍拋原錯（既有行為）。

### SEED_LOCK 改為交易級鎖

A 組領航員裁示（未經使用者確認）：`seedPhase2Fixtures` 改在 `db.tx` 內 `pg_advisory_xact_lock(SEED_LOCK)`，與 TRUNCATE／INSERT 同一筆交易；COMMIT／ROLLBACK 自動釋放，不必（也不可在他連線）手動 unlock。密碼 `argon2.hash` 在取鎖前算完，避免持鎖期間做 CPU 密集運算。這是**正向的行為變更**：整段 seed 現在是單一交易。`app.ts` 仍 re-export，`docs/demo/start-server.ts` 的 `doSeed` 呼叫點不變。

### 測試 hung 清理用 cancel、不用 terminate

A 組領航員裁示（未經使用者確認）：`ci-lock-race` 在 openDb 競賽回 `hung` 時不得 `await opening`（會把 9 秒斷言拖成 20 秒逾時）。清理只用 `pg_cancel_backend`。曾試 `pg_terminate_backend`，node-pg 會對已中斷的 socket 拋出未接住的 `ECONNRESET`，Vitest 記為 unhandled error。

可寫進檢討的限制（H2a 已收緊，見文末）：舊版 `cancelForeignBackends` 會取消「目前測試庫上、非本測試已登錄連線」的全部後端。`advisory()` 當時查 `pg_locks` 未再依資料庫過濾。

### 測試接縫

還原成敗與 `release(true)` 的測試（`apps/control-api/test/schema-lock-restore.test.ts`）不新導出生產函式，只攔截 `openDb` 所用 migrate client 的 `query`／`release`，並在同一條 client 上於還原後、release 前 `SHOW statement_timeout`。

## 強化切片 H2a

分支 `team-a-harden-h2a`，rebase 到 `main` 的 `92936d2`（`74799fe` 加上閘門紀錄檔 `.ci/e2e-seconds`、`.ci/required-seconds`、`.ci/gate-history.csv`，沒有程式或測試）。不改契約、不加依賴、不加功能。五項都是軟體大總召裁示（未經使用者確認）。下面的寫法是 A 組領航員裁示（未經使用者確認）。

### 取鎖以 held 判斷（K6、K8）

`acquireSchemaLock` 結尾是 `if (!held) throw lockErr ?? new Error(MIGRATE_ADVISORY_LOCK_FAILED)`。取鎖那句若拋錯，57014 仍映成固定中文；其他錯誤留在 `lockErr`，原樣再拋，不繼續遷移。沒有記下的錯誤但鎖也沒拿到，同樣拒絕啟動。`migrate` 只在 `acquireSchemaLock` 成功返回後把 `locked` 設為 true，只有這時才釋放 `SCHEMA_LOCK`，沒取到鎖不會呼叫 `pg_advisory_unlock`。失敗路徑仍由 `openDb` 的 `release(true)` 丟掉遷移連線。

測試在 `schema-lock-restore.test.ts`。注入 `08006`／`57P01`：啟動失敗、訊息是原錯、沒有後續 `CREATE TABLE`、沒有 `pg_advisory_unlock`。臨時突變（不提交）：catch 只留下 57014 時，K6 看到 `openDb` 成功；拿掉 `if (locked)` 時，K8 看到 unlock 被呼叫。

### 只處理本庫、且是本專案的連線

`advisory()` 增加 `pg_locks.database = (SELECT oid FROM pg_database WHERE datname = current_database())`。同一把數字鍵在別的資料庫不會出現在結果裡。本庫的持有者仍會出現。

`cancelForeignBackends` 只取消同時符合下列條件的後端：

1. `pg_stat_activity.datname = current_database()`。其他資料庫不列、不 cancel。
2. `backend_type = 'client backend'`，不是這條探測連線，也不在本測試已用 `client()` 登錄的 pid。
3. `pg_locks` 有一筆屬於該 pid 的 advisory 鎖：`objid` 為本檔的 `SCHEMA_LOCK`（872364201）、`objsubid = 1`，且 `database` 等於 `current_database()` 的 oid。持有或等待都算。

第 3 點是「本專案連線」的辨識。這把鎖只用在 control-api 的 `migrate`。sensor-ingest 與單純的 `pg_sleep` 沒有這把鎖，即使連在同一個 `sd_ci` 也不會被取消。其他資料庫上的同號 advisory 鎖，`datname` 與 `pg_locks.database` 都對不上。

測試建立 `sd_h2a_foreign`，在那邊取同一把 `SCHEMA_LOCK`，確認 `advisory()` 只含本庫持有者。另測：取消不會打到該庫，也不會取消本庫上沒有這把鎖的 `pg_sleep`；未登錄、正在等本庫這把鎖的後端仍會被 `pg_cancel_backend`。

### 帳號掃描與約束同一交易（U2）

`ensureUsernameNormalized` 在缺索引或 CHECK 時，於同一筆交易裡 `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`、掃描、建立唯一索引與 CHECK，然後才 `COMMIT`。測試在掃描那句返回之後，用另一條連線插入 `Bad Name`（`lock_timeout` 300ms，另有 `statement_timeout` 1s，測試本身 20s）。鎖還在時應得到 `55P03`。掃描與 `ADD CONSTRAINT` 的 `pg_current_xact_id()` 必須相同。掃描後先 `COMMIT` 再重開交易的突變會讓兩個交易 id 不同，測試轉紅。

### 非 55P03 的遷移錯誤（U6）

`runSchemaStatement` 把 `55P03` 映成固定中文；其他錯誤執行 `throw err`，啟動失敗。測試在 `CREATE TABLE IF NOT EXISTS users` 注入 `42601`／`schema-non-55P03`，`openDb` 必須以該錯誤失敗。拿掉這個 `throw err` 的突變（不提交）在空庫上會改以 `relation "users" does not exist` 失敗，訊息不再是注入的 `schema-non-55P03`，測試轉紅。

### unlock 不得蓋掉原錯

`migrate` 先記下遷移錯誤，再釋放 `SCHEMA_LOCK`。unlock 失敗時，若原錯是 `Error` 且還沒有 `cause`，把 unlock 錯誤放在 `cause`，然後仍拋原來的那個物件。啟動訊息不把驅動例外拼進去。沒有原錯時，unlock 錯誤本身讓啟動失敗。`openDb` 的失敗路徑仍呼叫 `release(true)`。測試同時注入結構語句錯誤與 unlock 錯誤：訊息維持結構語句的原文，`cause` 是 unlock 錯誤，且 `release` 收到 `true`。
