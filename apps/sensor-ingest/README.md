# sensor-ingest（流量平面，E3.A ③b）

獨立程序、獨立埠（預設 8443，見 `deploy/sensor/`）。只依賴 `@semantic-defense/sensor-auth`（token 解析／SHA-256＋timingSafeEqual／`findSensorByToken`／CIDR 判定）與共用 DB 表 `sensor_tokens`；不 import control-api／console。

## 認證順序（路由 onRequest，先於 body 解析；bodyLimit 256KB，超過 → 413）
1. HTTPS：`req.protocol !== "https"` → **426**。不信任 proxy（`trustProxy:false`），`x-forwarded-proto` 無效；生產以 `https: { key, cert }` 由本程序終結 TLS。
2. `Authorization: Bearer sdst_<sensor_id>.<secret>`；缺／錯／已撤銷 → **401**。
3. 來源 IP（socket remoteAddress，不讀 X-Forwarded-For）不在 `allowed_cidrs` → **403**。

未宣告路徑（含 `/api…`、`/login` 探測）一律 **404**，不經認證。無 session、無 cookie。

## 路由
- `GET /v1/health`：認證後探針，回 `{ ok, sensor_id }`。
- `POST /v1/flows`：body＝單一 FlowMetadataEvent（contracts strict）。自報 `sensor_id`／多欄／缺欄 → **400**；`ts` 超前收到時間 >5 分鐘 → **400** `{error:"ts 超前接收時間"}`、早於 now − 7 天（RETENTION_MS）→ **400** `{error:"ts 早於保留期限"}`（兩者剛好等於上限仍收；皆先於 app_id 綁定檢查，不寫 `flow_rejections`；7 天內遲到照存）；`app_id` 不在 token 的 `allowed_app_ids` → **403**（只記 `flow_rejections(sensor_id, at)`，不記 payload、不入庫）；同 sensor 重複 `flow_id` → **409**（PK `(sensor_id, flow_id)`）；成功 → **201**。
  寫入表 `flow_events`：契約欄位＋`sensor_id`（取自 token）＋`received_at`（注入時鐘 now）。token 撤銷不刪舊列。

## ts_ms（判定分窗用）
- `flow_events.ts_ms`（BIGINT，可 NULL）＝`ts` 的 epoch ms，寫入時以 JS `Date.parse` 算（算不出 → NULL）。判定 tick 只讀 `ts_ms`，`ts_ms IS NULL` 的列不分組、只計數（log `{null_ts:n}`），cursor 照常前進。
- 啟動時 `ensureFlowSchema`（flow-store）在一個交易內、持有 advisory lock：補欄、建 `flow_ts_ms(TEXT)`（只吞 data_exception 與 feature_not_supported → NULL）、回填 `WHERE ts_ms IS NULL`、建索引 `flow_events_group_ms`、移除舊索引 `flow_events_group`。回填每次啟動都跑，會全表掃描 flow_events——見 `docs/deploy-checklist.md` R15。

## 保留期
年齡 ≥ 7 天（`now - received_at >= 7 * 24 * 60 * 60 * 1000`）即刪；每次寫入前執行，另 export `purgeExpired(db, now)`。

## 測試
`node scripts/with-pg.mjs pnpm exec vitest run --project sensor-ingest`。認證邏輯以 inject＋`requireHttps:false`；HTTPS 強制以預設設定 inject（426）及 openssl 自簽憑證的真實 TLS listen（200）驗證。測試表建於獨立 schema `sensor_ingest_test`。
