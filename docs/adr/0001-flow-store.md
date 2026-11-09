# ADR 0001：新增 packages/flow-store（flow_events 存放共用套件）

- 狀態：已核准
- 裁示來源：總召 2026-11-09 17:35
- 相關：成案流程切片計畫第 2 節、第 9 節 Q2

## 背景

`flow_events`（與 `flow_rejections`）原本由 sensor-ingest 的 `store.ts` 建表與寫入。成案流程的判定 tick 放在 control-api，需要讀同一張表。若 control-api 自己複製一份 DDL，兩邊結構可能不一致；若 control-api import sensor-ingest，會違反流量面／管理面分離。

## 決定

新增工作區套件 `@semantic-defense/flow-store`，兩個入口：

| 入口 | 檔案 | 內容 | 使用者 |
|---|---|---|---|
| `@semantic-defense/flow-store/write` | `src/write.ts` | DDL（`ensureFlowSchema`）、`insertFlow`、`purgeExpired`、`recordRejection` | 只有 sensor-ingest |
| `@semantic-defense/flow-store/read` | `src/read.ts` | 型別（`FlowDb`、`FlowEventRow`）、`RETENTION_MS`、查詢骨架（`flowEventsReady`） | control-api 判定 tick |

沒有根入口，使用端必須明寫要哪一個。

## 邊界

1. **兩個入口分開**：control-api（src 與 test）只能 import `./read`；唯讀入口不得直接或間接引入 `write.ts`。
2. **DDL 只有一處**：`flow_events`／`flow_rejections` 的 `CREATE TABLE`／`CREATE INDEX` 只在 `packages/flow-store/src/write.ts`。之後若要 migration，也只放在 flow-store。管理面不建這兩張表，判定 tick 以 `flowEventsReady` 防呆。
3. **部署獨立**：flow-store 是被各自打包進去的程式庫，不是服務。sensor-ingest（流量面）與 control-api（管理面）仍各自部署；flow-store 不依賴任何 app。
4. **不引入外部套件**：只用既有的 `pg`／`vitest`／`typescript` 等（已在 lockfile），邊界用 vitest 掃 import 檢查，不加 dependency-cruiser 或 eslint 外掛。

以上 1、2、4 由 `packages/flow-store/test/boundary.test.ts` 鎖住；平面依賴另由 `scripts/boundaries.mjs` 檢查。

## 影響

- deps commit 只含 package.json 與 pnpm-lock.yaml；exports 與 src 在下一個 commit。
- control-api 的測試若需要寫入 `flow_events`，不能走寫入入口；處理方式見下方補充。

## 補充：測試入口 `./testing`（A 組領航員 11-09）

- 新增第三個入口 `@semantic-defense/flow-store/testing`（`src/testing.ts`），只放測試用的建表與塞資料輔助（`createFlowTables`、`insertFlowEvents`）。它呼叫 `write.ts`，自己不寫任何 DDL，所以 DDL 仍只有 `write.ts` 一處。
- control-api 的測試用 `./testing` 建表、塞資料，仍不得 import `./write`。
- control-api 與 sensor-ingest 的產品碼（`src`）不得 import `./testing`。
- 以上由 `boundary.test.ts` 鎖住：exports 恰為三個入口、產品碼不 import `./testing`，並保留 control-api 不 import `./write` 的檢查。
- 這仍在總召 2026-11-09 17:35 的條件內：產品碼的邊界不變（control-api 產品碼只用 `./read`），DDL 只在一處，部署獨立，也沒有引入外部套件。
