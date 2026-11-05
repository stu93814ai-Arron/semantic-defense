# sensor-ingest（流量平面，E3.A ③b）

獨立程序、獨立埠（預設 8443，見 `deploy/sensor/`）。只依賴 `@semantic-defense/sensor-auth`（token 解析／SHA-256＋timingSafeEqual／`findSensorByToken`／CIDR 判定）與共用 DB 表 `sensor_tokens`；不 import control-api／console。

## 認證順序（路由 preHandler）
1. HTTPS：`req.protocol !== "https"` → **426**。不信任 proxy（`trustProxy:false`），`x-forwarded-proto` 無效；生產以 `https: { key, cert }` 由本程序終結 TLS。
2. `Authorization: Bearer sdst_<sensor_id>.<secret>`；缺／錯／已撤銷 → **401**。
3. 來源 IP（socket remoteAddress，不讀 X-Forwarded-For）不在 `allowed_cidrs` → **403**。

未宣告路徑（含 `/api…`、`/login` 探測）一律 **404**，不經認證。無 session、無 cookie。

## 路由
- `GET /v1/health`：認證後探針，回 `{ ok, sensor_id }`。
- `POST /v1/flows`：payload 自報 `sensor_id` → **400**；其餘 → **501**（存入與 7 天清除屬 ③c）。

## 測試
`node scripts/with-pg.mjs pnpm exec vitest run --project sensor-ingest`。認證邏輯以 inject＋`requireHttps:false`；HTTPS 強制以預設設定 inject（426）及 openssl 自簽憑證的真實 TLS listen（200）驗證。測試表建於獨立 schema `sensor_ingest_test`。
