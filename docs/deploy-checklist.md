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

- sensor-ingest 新版啟動時跑遷移（`packages/flow-store/src/write.ts` 的 `ensureFlowSchema`），補 `ts_ms` 欄並分批回填。
- 滾動升級期間，舊版 ingest 寫入的列 ts 合法但 `ts_ms` 為 NULL：新版判定 cursor 會停在該列之前（log `{pending_backfill:n}`），回填補上後再判定分組。全部 ingest 升級完後再重啟一次 sensor-ingest，即可補齊。
- **已接受的缺口**：若順序沒守住，新版判定的 cursor 已越過某些列之後，舊版 ingest 才寫入 `ts_ms` 為 NULL 的列，這些列下次啟動會被回填，但**不會再被判定**（cursor 不會倒退）。這是已接受的缺口，所以務必先升完所有 ingest。

**每次啟動的成本（Q2）**：

- 回填依 `(received_at, sensor_id, flow_id)` 分批（每批 1000），各為短交易、只拿列鎖；只對可轉換的列寫入 `ts_ms`。
- 遷移持有 session 級 `pg_advisory_lock(872364210)`（`FLOW_SCHEMA_LOCK`），結束後在 finally 釋放。多個 sensor-ingest 同時啟動會依序等待。
- 部署前先估量：

```sql
SELECT count(*) AS total, count(*) FILTER (WHERE ts_ms IS NULL) AS null_ts FROM flow_events;
```

**無法換算的舊列（毒列）**（A 組領航員裁示 (2026-11-10)）：Postgres 不收的 ts（0000 年、offset 超過 ±15:59、infinity 等）回填時會跳過、不重寫，`ts_ms` 維持 NULL。判定不分組、計 `{null_ts}`、cursor 照常前進。本切片不刪除這些列；7 天保留期到期後由 `purgeExpired` 清掉。判定 log `judge tick skipped rows without ts_ms {null_ts:n}` 持續出現時，表示還有這類列。

## R-B（已解決）：啟動遷移不再以 ACCESS EXCLUSIVE 鎖住整段回填

**已合入**：欄位已存在則跳過 ALTER；DDL 短交易設 `lock_timeout` 5s（逾時即失敗）；`flow_events_group_ms` 以 `CREATE INDEX CONCURRENTLY` 建立（`statement_timeout` 10min；若有 INVALID 索引會先 `DROP INDEX CONCURRENTLY`），舊 `flow_events_group` 也以 CONCURRENTLY 刪除；回填分批且毒列不重寫。回填期間其他實例的 INSERT 與判定 SELECT 只碰到列鎖。

**首次升級啟動較久**：回填在 `ensureFlowSchema` 內跑完，本實例才 `listen`，會阻擋本實例啟動（要等回填結束才接流量）。後續啟動通常只剩毒列，會很快。

## R-C：首次升級的鎖、表大小與舊 infinity 列

(a) **啟動時的 DROP INDEX 與 ALTER 都拿 AccessExclusive**。部署前先在維護窗口手動移除舊索引，啟動時的 `DROP INDEX IF EXISTS` 就會跳過：

```sql
-- 不能在交易內執行
DROP INDEX CONCURRENTLY IF EXISTS flow_events_group;
```

(b) **首次回填會重寫整張表**：每一列都更新一次 `ts_ms`。預期表大小約翻倍（直到 VACUUM 回收），並產生大量 WAL。部署前確認磁碟與複寫／備份的 WAL 空間足夠。

(c) **舊列 ts 為 `infinity`／`-infinity`**：Postgres 對這兩個值換算 epoch 時丟 0A000（不在 22 類）。R-A 之後 `flow_ts_ms` 也吞 0A000 並回 NULL，所以這些列的 `ts_ms` 留 NULL、判定略過，處理方式同 R15「無法換算的舊列」。R-A 之前的版本遇到這種列會讓整個遷移回滾、ingest 起不來。

## R-D：小數 ≥7 位時 SQL 與 JS 可能差 1ms（已由使用者接受（2026-11-09 23:21，由 PM 轉達））

ts 的小數秒超過 6 位時，Postgres 解析時會捨入到微秒，JS `Date.parse` 則直接截到毫秒，兩者可能差 1ms。這只影響由 SQL 回填的舊列（新列由 ingest 用 JS 寫入），已由使用者接受（2026-11-09 23:21，由 PM 轉達），不另處理。

## 安裝時關鍵基礎設施白名單（SD_CRITICAL_ALLOWLIST）

上線前須填入 `SD_CRITICAL_ALLOWLIST`（逗號分隔的 CIDR），涵蓋管理平面、EDL 發布端、防火牆管理口與關鍵業務出口。

- 種子 IPv4 前綴須為 /16 或更窄，IPv6 須為 /48 或更窄；更寬的值會讓 control-api 無法啟動，錯誤訊息不含該 CIDR。
- 種子列（`created_by = system:install`）不可由 API 刪除，也不可設定到期。
- 若種子列缺失，重啟 control-api 會依當時的設定補回，並寫 `whitelist.create` 稽核（actor 為 `system:install`）；沒有新列則不寫。
- 從設定移除某個位址後，下次重啟會刪除對應種子列，寫入 `whitelist.delete` 稽核（actor 為 `system:install`），且不恢復先前因該種子撤回的封鎖。
- 未設定或空字串（trim 後為空）不會改動既有種子，也不會做撤回。
- 要清空全部種子必須明確設定 `SD_CRITICAL_ALLOWLIST=none`；會為每列寫 `whitelist.delete`。`none` 不得與 CIDR 混用，否則 control-api 無法啟動，錯誤訊息不含該值。
- 任何一次啟動若刪除了種子，會寫一筆 warn，只含刪除筆數，不含 IP 或 CIDR。

## 開啟使用者建立 API 前的追蹤事項

在任何使用者建立 API 開放前須完成：使用者名稱經 NFKC 正規化、trim、轉小寫；整個 `system:` 前綴保留；資料庫 CHECK。
