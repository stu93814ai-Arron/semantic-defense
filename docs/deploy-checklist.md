# 部署前檢查（A 組）

每次部署前逐項確認。條目編號沿用資安退回編號。

## R9

**啟動時已用 CONCURRENTLY 建立 `flow_events_group_ms`**：`ensureFlowSchema` 會自動 `CREATE INDEX CONCURRENTLY`（`statement_timeout` 預設 10 分鐘，可用環境變數 `SD_FLOW_INDEX_TIMEOUT_MS`（毫秒、正整數，上限 2147483647）覆寫；無效值或超過上限在啟動時拋錯）。一般不必再手動建索引。

若啟動失敗或逾時：檢查是否留下 INVALID 索引，先 `DROP INDEX CONCURRENTLY flow_events_group_ms`（不得在交易內），再重試或再啟動一次。

## R15：flow_events.ts_ms 遷移與 ts_ms 為 NULL 的舊列

**升級順序（Q4）**：所有 sensor-ingest 實例都升級完，才升級判定（control-api）。

- sensor-ingest 新版啟動時跑遷移（`packages/flow-store/src/write.ts` 的 `ensureFlowSchema`），補 `ts_ms` 欄並分批回填。
- 滾動升級期間，舊版 ingest 寫入的列 ts 合法但 `ts_ms` 為 NULL：若該列 `received_at` 落後表內最新 `received_at`（`received_at <= now`）不超過 `PENDING_BACKFILL_MAX_LAG_MS`（10 分鐘），新版判定 cursor 會停在該列之前（log `{pending_backfill:n}`），回填補上後再判定分組。全部 ingest 升級完後再重啟一次 sensor-ingest，即可補齊。
- **回填結束後才出現的可轉換 NULL**（例如舊版 ingest／restore）：若最早一筆待回填列的 `received_at` 已落後最新 `received_at` 超過 10 分鐘，判定會略過該列、不計分組，與毒列相同，並計 `{stale_pending:n}`、寫一行 error（只含筆數，不含 IP／ts）。上限內行為不變。沒有定期回填，需再啟動 ingest 才會補 `ts_ms`。lag 基準是最新 `received_at` 而不是 wall-clock now，以免首次回填時歷史列全部被當成過期而永久略過。
- **超過 lag 上限而被略過的列永遠不會再被判定**（cursor 已越過，不會倒退；之後回填補上 `ts_ms` 也不會重判）。因此若首次升級的回填本身跑超過 10 分鐘，期間舊版 ingest 寫入的可轉換 NULL 列可能被略過。若升級順序沒守住，新版判定的 cursor 已越過某些列之後，舊版 ingest 才寫入 `ts_ms` 為 NULL 的列，這些列下次啟動會被回填，但同樣不會再被判定。**A 組領航員裁示（未經使用者確認）**。此情況會觸發 R16 的 `stale_pending` 告警（payload 只帶筆數）。收到該告警時，維運應查看 `GET /api/health` 的 `judge.stale_pending_total` 與當次告警筆數、確認 ingest／回填是否已完成，並決定是接受這批略過（無法靠把 cursor 倒退來重判），或從備份／來源重送這些 flow。務必先升完所有 ingest。

**每次啟動的成本（Q2）**：

- 回填依 `(received_at, sensor_id, flow_id)` 分批（每批 1000），各為短交易、只拿列鎖；只對可轉換的列寫入 `ts_ms`。
- 遷移持有 session 級 `pg_advisory_lock(872364210)`（`FLOW_SCHEMA_LOCK`），結束後在 finally 釋放。多個 sensor-ingest 同時啟動會依序等待。
- 部署前先估量（只讀；這兩句已在測試庫實際執行）：

```sql
SELECT count(*) AS total, count(*) FILTER (WHERE ts_ms IS NULL) AS null_ts FROM flow_events;

-- (a) 毒列：ts_ms 為 NULL 且無法換算
SELECT count(*) AS poison_unconvertible
FROM flow_events
WHERE ts_ms IS NULL AND flow_ts_ms(ts) IS NULL;

-- (b) 待回填：ts_ms 為 NULL 但可換算
SELECT count(*) AS pending_backfill
FROM flow_events
WHERE ts_ms IS NULL AND flow_ts_ms(ts) IS NOT NULL;
```

任何清理之前必須先備份或匯出（例如 `pg_dump --table=flow_events` 或 `COPY flow_events TO ...`）。是否刪除由部署者依上述計數決定，本檢查表不代為刪除。

- 毒列清理（僅說明）：`DELETE FROM flow_events WHERE ts_ms IS NULL AND flow_ts_ms(ts) IS NULL;`
- 待回填列應優先重啟已升級的 sensor-ingest，讓 `ensureFlowSchema` 回填 `ts_ms`；不要先刪，刪了就不會被判定。

**無法換算的舊列（毒列）**（A 組領航員裁示（未經使用者確認，2026-11-10））：Postgres 不收的 ts（0000 年、offset 超過 ±15:59、infinity 等）回填時會跳過、不重寫，`ts_ms` 維持 NULL。判定不分組、計 `{null_ts}`、cursor 照常前進，**不影響判定結果**。未手動清理時，7 天保留期到期後由 `purgeExpired` 清掉。判定 log `judge tick skipped rows without ts_ms {null_ts:n}` 持續出現時，表示還有這類列。


## R16：對 tick 連敗與 cursor 落後設告警

資安提出（11/9 第二批殘留；未併入 R15 本文）。判定行程是 control-api；健康檢查為 `GET /api/health`（`platform_admin`）的 `judge` 物件（主控台不改）：`tick_fail_streak`（連續失敗次數）、`cursor_lag_seconds`（表內 `max(received_at)` 減 cursor，無事件為 0）、`stale_pending_total`（累計略過的待回填筆數）。告警重用 `alert_outbox` 與既有 `SD_ALERT_*` 通道選擇；未設定通道時不寫 outbox，health 仍更新。payload 與錯誤只含 kind、error_class、數字與時間，不含 IP、SQL 或例外原文。

| 變數 | 預設 | 說明 |
|---|---|---|
| `SD_JUDGE_TICK_FAIL_ALERT_N` | 3（**A 組領航員建議**；有效範圍 3–5） | 判定 tick 連續失敗達 N 次時入列一筆 `tick_fail`（每一輪連敗只告一次）；恢復後計數歸零，新一輪再告。無效值在啟動時拋錯。 |
| `SD_JUDGE_CURSOR_LAG_MS` | 600000（與 `PENDING_BACKFILL_MAX_LAG_MS`／10 分鐘對齊；須為正整數） | cursor 落後超過此門檻時，每個落後段落入列一筆 `cursor_lag`。無效值在啟動時拋錯。 |

`stale_pending` 見上方 R15：判定成功且本 tick 略過待回填列時，每個略過段落入列一筆（比照 cursor 落後），只帶筆數。成功 tick 且本段 stale 為 0 時重置，之後再略過會再告。收到該告警時的處置見 R15「超過 lag 上限而被略過的列」。

## R-B（已解決）：啟動遷移不再以 ACCESS EXCLUSIVE 鎖住整段回填

**已合入**：欄位已存在則跳過 ALTER；DDL 短交易設 `lock_timeout` 5s（逾時即失敗）；先以 `CREATE INDEX CONCURRENTLY` 建立 `flow_events_group_ms`（`statement_timeout` 預設 10min，可用 `SD_FLOW_INDEX_TIMEOUT_MS` 覆寫（上限 2147483647；超過或無效值在啟動時拋錯）；若有 INVALID 索引會先 `DROP INDEX CONCURRENTLY`），再 `DROP INDEX CONCURRENTLY` 舊 `flow_events_group`；回填分批且毒列不重寫。回填期間其他實例的 INSERT 與判定 SELECT 只碰到列鎖。多實例同時啟動時，`try_lock` 輪詢等待 `SD_FLOW_SCHEMA_LOCK_WAIT_MS`（預設 30 分鐘，逾時即失敗）；等待期間每 30 秒 `log.warn` 一次，物件只含 `waited_ms`。判定對超過 10 分鐘 lag 的待回填列計 `{stale_pending}` 並放行 cursor（見 R15）。

**首次升級啟動較久**：回填在 `ensureFlowSchema` 內跑完，本實例才 `listen`，會阻擋本實例啟動（要等回填結束才接流量）。後續啟動通常只剩毒列，會很快。

## R-C：首次升級的鎖、表大小與舊 infinity 列

(a) **舊索引 `flow_events_group` 啟動時在新建 `flow_events_group_ms` 之後，才用 `DROP INDEX CONCURRENTLY` 移除**（`statement_timeout` 預設 10 分鐘，與建新索引相同，可用 `SD_FLOW_INDEX_TIMEOUT_MS` 覆寫，上限 2147483647；超過或無效值在啟動時拋錯）。一般不必再手動刪。若失敗或逾時，再執行 `DROP INDEX CONCURRENTLY IF EXISTS flow_events_group`（不得在交易內）並重試。

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

## 告警推送（環境變數與外部監控）

上線後必須把 control-api 的 `GET /api/health`（`platform_admin`，內含告警未送達筆數、`last_failed_at`（`max(failed_at)`，不是 `next_attempt_at`）與近 24 小時 `purged`（讀自 `alert.purged` 稽核，重啟後仍在））接到外部監控，不得只靠本機 log。外部監控必須把 `/api/health` 非 200 視為告警。即使暫時未啟用任何通道，也要先接好監控，以免日後開啟通道時沒有告警。

通道彼此獨立：該通道的啟用變數未設或 trim 後為空則關閉；一旦啟用，必備變數缺失或無效時 control-api 拒絕啟動（錯誤不含 URL、主機、憑證或位址）。私網覆寫只能用該通道的 CIDR 清單，不得使用全局開關。

| 通道 | 啟用（未設＝關） | 啟用時必備 | 可選 |
|---|---|---|---|
| Email | `SD_ALERT_EMAIL_TO` | `SD_ALERT_EMAIL_SMTP_HOST`、`SD_ALERT_EMAIL_FROM` | `SD_ALERT_EMAIL_SMTP_PORT`（預設 587）、`SD_ALERT_EMAIL_USERNAME`、`SD_ALERT_EMAIL_PASSWORD`、`SD_ALERT_EMAIL_IMPLICIT_TLS`（僅接受未設或 `1`；`1`＝隱式 TLS）、`SD_ALERT_SMTP_ALLOW_PLAINTEXT`（僅接受未設或 `1`；必須為 `1` 才允許明文，此時禁止帳密）、`SD_ALERT_SMTP_ALLOW_CIDRS` |
| Webhook | `SD_ALERT_WEBHOOK_URL`（僅 https、禁止 userinfo；整段 URL 視為密鑰） | `SD_ALERT_WEBHOOK_HMAC_SECRET`（至少 32 bytes） | `SD_ALERT_WEBHOOK_ALLOW_CIDRS` |
| Syslog | `SD_ALERT_SYSLOG_HOST` | `SD_ALERT_SYSLOG_PORT`、`SD_ALERT_SYSLOG_TRANSPORT`（僅 `tcp` 或 `tls`；`udp` 啟動即 throw） | `SD_ALERT_SYSLOG_ALLOW_CIDRS`、`SD_ALERT_SYSLOG_HOSTNAME`、`SD_ALERT_SYSLOG_APP_NAME` |

`SD_ALERT_EMAIL_TO` 與 `SD_ALERT_EMAIL_FROM` 必須是不含顯示名稱的嚴格 ASCII 位址；含 CR、LF、NUL、非 ASCII 或多個 `@` 時啟動即 throw。`SD_ALERT_SMTP_ALLOW_PLAINTEXT` 與 `SD_ALERT_EMAIL_IMPLICIT_TLS` 除未設或恰好為 `1` 外，啟動即 throw。Syslog TIMESTAMP 為 RFC 3339 UTC，PROCID／MSGID 為 `-`。volume／breaker 告警 payload 為 `{delivery_id, kind, at}`。憑證、SMTP 密碼與 webhook URL／HMAC 不得寫入 log、稽核、outbox 或錯誤物件。

## A 組領航員裁示（未經使用者確認）（告警推送測試清單 §2 與 §9）

A 組領航員裁示（未經使用者確認）：測試清單 `/workspace/exec-a-logs/push-design-tests.md` 的 §9 優先於 §2。§2 僅保留以下對本機假伺服器的行為測試：伺服器未宣告 STARTTLS 則發送必須失敗（`requireTLS`）；自簽或主機名不符的憑證必須失敗；明文 opt-in 模式不送 AUTH；dot-stuffing；位址含 CRLF 或格式不正確則拒絕。不撰寫協定內部測試（重新送 EHLO、pipelining、行或總量上限）；那些是 nodemailer 的職責。測試清單本文未改。
