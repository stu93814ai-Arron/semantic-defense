# 部署前檢查（A 組）

每次部署前逐項確認。條目編號沿用資安退回編號。

## R9

**啟動時建索引會擋寫入**：`ensureFlowSchema` 啟動時用非 concurrent 的 `CREATE INDEX IF NOT EXISTS`，本切片新增 `flow_events_group_ms`。大表上建索引期間會擋住 flow_events 的寫入，同時持有 advisory lock、並跑回填。

- 部署前先估 flow_events 的量（見 R15 的估量 SQL）。
- 量大時，在維護窗口手動先建索引，再啟動新版；啟動時的 `IF NOT EXISTS` 就會跳過：

```sql
-- 不能在交易內執行
CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_events_group_ms
  ON flow_events (sensor_id, app_id, src_ip, ts_ms);
```

- 若 CONCURRENTLY 中途失敗會留下 INVALID 索引，需先 `DROP INDEX CONCURRENTLY flow_events_group_ms` 再重建。
- 之後任何新增的索引都比照辦理。

## R15：flow_events.ts_ms 遷移與 ts_ms 為 NULL 的舊列

**升級順序（Q4）**：所有 sensor-ingest 實例都升級完，才升級判定（control-api）。

- sensor-ingest 新版啟動時跑遷移（`packages/flow-store/src/write.ts` 的 `ensureFlowSchema`），補 `ts_ms` 欄並回填。
- 滾動升級期間，舊版 ingest 寫入的列 ts 合法但 `ts_ms` 為 NULL：新版判定 tick 會略過（只計 `{null_ts:n}`），下一次 sensor-ingest 啟動時由回填補上。全部 ingest 升級完後再重啟一次 sensor-ingest，即可補齊。
- **已接受的缺口**：若順序沒守住，新版判定的 cursor 已越過某些列之後，舊版 ingest 才寫入 `ts_ms` 為 NULL 的列，這些列下次啟動會被回填，但**不會再被判定**（cursor 不會倒退）。這是已接受的缺口，所以務必先升完所有 ingest。

**每次啟動的成本（Q2）**：

- 回填 `UPDATE flow_events SET ts_ms = flow_ts_ms(ts) WHERE ts_ms IS NULL` 每次啟動都跑。`ts_ms` 沒有索引，這是 flow_events 的全表掃描（量受 7 天保留期限制）。
- 整段遷移在一個交易內，持有 `pg_advisory_xact_lock(872364210)`（`FLOW_SCHEMA_LOCK`）直到交易結束。多個 sensor-ingest 同時啟動會依序等待。
- 部署前先估量：

```sql
SELECT count(*) AS total, count(*) FILTER (WHERE ts_ms IS NULL) AS null_ts FROM flow_events;
```

**無法換算的舊列**：Postgres 不收的 ts（0000 年、offset 超過 ±15:59 等）回填後仍為 NULL，判定永遠不會分組。判定 log `judge tick skipped rows without ts_ms {null_ts:n}` 持續出現時，表示有這類列。本切片不自動刪除，7 天保留期到期後會由 `purgeExpired` 清掉。在那之前，每次啟動的回填都會對這些毒列跑一次沒有效果的 UPDATE，會產生少量 bloat，可接受。若要提前清理（需人工確認）：

```sql
-- 先看筆數與 sensor 分布（不看 ts／IP 內容）
SELECT sensor_id, count(*) FROM flow_events WHERE ts_ms IS NULL GROUP BY sensor_id;
-- 確認已跑過最新回填（重啟 sensor-ingest）後仍為 NULL 才刪
DELETE FROM flow_events WHERE ts_ms IS NULL;
```
