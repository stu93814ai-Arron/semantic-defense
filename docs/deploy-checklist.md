# 部署前檢查（A 組）

每次部署前逐項確認。條目編號沿用資安退回編號。

## R9

（沿用既有 R9 條目；本檔由 ts_ms 切片建立，R9 內容待補入同一清單。）

## R15：flow_events.ts_ms 遷移與 ts_ms 為 NULL 的舊列

**升級順序（Q4）**：先升級 sensor-ingest，再升級 control-api。

- sensor-ingest 新版啟動時跑遷移（`packages/flow-store/src/write.ts` 的 `ensureFlowSchema`），補 `ts_ms` 欄並回填。
- 滾動升級期間，舊版 ingest 寫入的列 ts 合法但 `ts_ms` 為 NULL：新版判定 tick 會略過（只計 `{null_ts:n}`），下一次 sensor-ingest 啟動時由回填補上。全部 ingest 升級完後再重啟一次 sensor-ingest，即可補齊。

**每次啟動的成本（Q2）**：

- 回填 `UPDATE flow_events SET ts_ms = flow_ts_ms(ts) WHERE ts_ms IS NULL` 每次啟動都跑。`ts_ms` 沒有索引，這是 flow_events 的全表掃描（量受 7 天保留期限制）。
- 整段遷移在一個交易內，持有 `pg_advisory_xact_lock(872364210)`（`FLOW_SCHEMA_LOCK`）直到交易結束。多個 sensor-ingest 同時啟動會依序等待。
- 部署前先估量：

```sql
SELECT count(*) AS total, count(*) FILTER (WHERE ts_ms IS NULL) AS null_ts FROM flow_events;
```

**無法換算的舊列**：Postgres 不收的 ts（0000 年、offset 超過 ±15:59 等）回填後仍為 NULL，判定永遠不會分組。判定 log `judge tick skipped rows without ts_ms {null_ts:n}` 持續出現時，表示有這類列。本切片不自動刪除，7 天保留期到期後會由 `purgeExpired` 清掉。若要提前清理（需人工確認）：

```sql
-- 先看筆數與 sensor 分布（不看 ts／IP 內容）
SELECT sensor_id, count(*) FROM flow_events WHERE ts_ms IS NULL GROUP BY sensor_id;
-- 確認已跑過最新回填（重啟 sensor-ingest）後仍為 NULL 才刪
DELETE FROM flow_events WHERE ts_ms IS NULL;
```
