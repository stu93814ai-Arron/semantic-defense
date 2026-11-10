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

## R-B（部署前必修，須在 default-on 切片之前合入）：每次啟動的遷移鎖住 flow_events

**現況問題**：

- `ALTER TABLE flow_events ADD COLUMN IF NOT EXISTS ts_ms` 即使欄位已存在也會拿 **ACCESS EXCLUSIVE** 鎖。這把鎖在同一個遷移交易裡持有到回填結束。
- 資安實測 1.2M 列：期間 flow_events 的 insert 等了 **17.8 秒**。判定的一般 SELECT 也會被擋（實測 **1.54 秒**）。
- 表從 **269MB 長到 643MB**：大部分來自首次回填重寫整表（到 **576MB**，見 R-C (b)）；之後每次啟動，永久為 NULL 的列（無法換算的 ts）又被 `UPDATE … WHERE ts_ms IS NULL` 重寫一次，只再多約 **67MB**。

**預定修法（三項都要做）**：

1. ALTER 前先查 `information_schema.columns`，欄位已存在就不執行 ALTER（不拿 ACCESS EXCLUSIVE）。
2. 回填移出 schema 交易，改成分批執行（每批有上限、各自 commit），不再整段持鎖。
3. 無法換算的列刪除，或另外標記（例如標記欄位），讓回填不再每次重寫它們。

**部署前**：修好之前不得部署到有實際流量的環境；修法合入後再移除本段。

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
