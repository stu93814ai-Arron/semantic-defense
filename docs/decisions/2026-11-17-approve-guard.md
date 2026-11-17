# 2026-11-17 人工核准防護（Asia/Taipei）

除特別標示「使用者決定（由軟體大總召轉達）」或「軟體大總召裁示（未經使用者確認）」者外，以下皆為 A 組領航員裁示（未經使用者確認）。

本文件取代 `2026-11-11-bl-pending.md` 第 4 點「不加速率限制」，依據 `PLAN.md:238`「登入與核准有速率限制」。

## 核准上限

1. 每個 operator 滑動 1 小時內，成功的人工核准（`blocklist_entries` 中 `source='manual' AND approved_by=操作者`）達上限後，再核准回 429 `{ error: "核准次數已達上限，請稍後再試" }`，不帶 `Retry-After`，不含 IP、數字或帳號。
2. 上限由環境變數 `SD_APPROVE_PER_HOUR` 設定。預設 50 為**軟體大總召裁示（未經使用者確認）**；範圍 1–200 的整數為 A 組領航員裁示（未經使用者確認）；無效值讓 control-api 啟動失敗。`buildApp({ approvePerHour })` 僅供測試注入。啟動時記一行 log，只含數字（以及內網開關值）；不寫設定稽核。
3. 只計 approve；被擋的嘗試不計入。退回不設上限。
4. 檢查順序：路徑參數 UUID 格式（否則 404）→ 白名單 SHARE 鎖 → 每個 operator 一把 `pg_advisory_xact_lock(872364215, hashtext(actor))` → 計數判上限 → 條件式 UPDATE 與其他 409。超限後不再透露案件狀態（不存在或已核准的案件同樣回 429）。核准不拿 `AUTO_LOCK`。
5. 計數用 partial index `blocklist_manual_approver ON blocklist_entries (approved_by, created_at) WHERE source='manual'`。撤回過的 entry 仍計入（上限管的是核准動作）。
6. 窗口用 app 時鐘；多實例間的時鐘偏差只會讓窗口邊界差幾秒。

## 位址範圍

7. **使用者決定（由軟體大總召轉達）**：內網（RFC1918 `10/8`、`172.16/12`、`192.168/16`，CGNAT `100.64/10`，ULA `fc00::/7`）人工核准時**預設可封鎖**。管理員可把 `SD_APPROVE_INTERNAL_SCOPE` 設成 `none`、`v4` 或 `v6`，當作「禁止封鎖內網」的開關：`none` 兩者都禁止，`v4` 只允許內網 v4，`v6` 只允許 ULA，`all`（預設）兩者都允許。預設值只放在 `APPROVE_INTERNAL_SCOPE_DEFAULT` 一個常數；之後只改該常數與本文件、部署檢查表。無效值讓 control-api 啟動失敗。沒有請求參數，也沒有設定表。
8. 這與 `PLAN-ADDENDUM-MONITOR.md:61`「接受私有位址」一致：契約接受私有位址，核准政策預設也允許封鎖內網，只有管理員明確關閉時才擋。
9. **使用者決定（由軟體大總召轉達）**：「永遠不可核准」（never）的位址不受開關影響，一律擋下，回 409 `{ error: "此位址不可核准" }`。never 為 `isGlobalUnicast` 判為非公網、且不屬於第 7 點內網的所有位址，包括回環、link-local、多播、廣播、未指定位址、文件範圍、`198.18/15`（基準測試）、`192.0.0/24`，以及內嵌私網或保留 v4 的 IPv6（`::ffff:`、`64:ff9b::/96`、`64:ff9b:1::/48`、`2002::/16`）。
10. 內網被開關禁止時回 409 `{ error: "內網位址不可核准" }`。白名單先判：命中白名單一律 409「已在白名單」，開關不影響。
11. **使用者決定（由軟體大總召轉達）**：設備自身（本機、管理端、感測器）靠白名單擋，部署時必須把管理端、感測器和系統位址加進 `SD_CRITICAL_ALLOWLIST` 或白名單。本片不另外自動加擋。設備自身位址依使用者決定（由軟體大總召轉達）靠白名單擋；583caa3 原寫「一律拒絕」，已由 2645da5 更正。
12. **行為變更**：`198.18/15` 與 `192.0.0/24` 不在判定端 `hostCidr` 的排除清單內，以前可以成為待審案件並被人工核准上榜；本片起這兩段一律不可核准（never）。
13. 分類由 `net-scope.ts` 的 `approveScope(ip)` 提供：`public`（必須等於 `isGlobalUnicast`，測試以表格鎖住一致）、`internal_v4`、`internal_v6`、`never`。

## 被擋時的稽核

14. 上限（429）、內網（409）或 never（409）擋下時，主交易回滾後另開一筆短交易寫 `blacklist.approve_blocked`，`detail` 只有 `{ case_id, reason }`，`reason` 只會是 `cap`、`internal_scope`、`never_scope`；不含 IP。
15. 去重：`cap` 同一 operator 1 小時內最多一筆；`internal_scope`／`never_scope` 同一案件、同一 reason 1 小時內最多一筆。各有一個 partial index。
16. 「只在成功時寫稽核」仍適用於 approve／reject 本身；其他 409（已核准、已到期、白名單等）與 404 仍不寫稽核。
17. 被擋稽核的短交易若失敗，該請求回 500，回應本文固定為 `{ error: "伺服器錯誤" }`，案件仍未上榜。錯誤由全域錯誤處理器經 `safeErr` 寫 log（`apps/control-api/src/errors.ts:26-31`、`:79`），另記 method 與只含 path 的 url：PG 錯誤（帶 `severity`）只記 name、code、table、constraint、column；非 PG 錯誤記 name、message、code、stack，其中 message 與 stack 經 err serializer 去掉 URL query（`errors.ts:50-53`），但仍可能含例外文字（見追蹤項 7）。

## 告警

18. 新增兩個告警 kind：`approve_cap`、`approve_volume`。kind CHECK 改由 `ALERT_KINDS` 產生；`ensureAlertKindCheck` 只有在既有約束已包含全部 kind 時才跳過，舊庫啟動時會升級。
19. payload 只有 `kind`、`at`（入列時間）、`delivery_id`，不含帳號與 IP。排序與 `breaker_open` 同級。
20. `approve_cap`：在 cap 被擋稽核的同一筆短交易內入列，與該稽核同一去重（每個 operator 每小時一次）。
21. `approve_volume`（「異常量」只有兩個條件）：單一 operator 滑動 1 小時核准數 ≥ ceil(0.8 × 上限)，或全體人工核准 ≥ 100／小時。在成功核准的交易內判；單列表 `approve_guard.volume_held` 旗標讓每段只告一次，低於門檻後的下一次核准解除旗標。沒有短窗突增或退回量告警。
22. 告警入列在核准交易內；outbox 寫入失敗會讓核准一起失敗（與 `auto_list` 現況相同）。

## 測試

23. 稽核回滾測試（資安 B4）：以 DEFERRABLE INITIALLY DEFERRED 約束觸發器（只對哨兵 IP）讓 COMMIT 在稽核寫入後失敗，approve 與 reject 的稽核都必須跟著回滾。

## 追蹤項

1. 全域沒有人工上榜總量上限；`approve_volume` 只告警、不擋。
2. 退回沒有上限。
3. `approveScope` 尚未特別處理 Teredo `2001::/32`、6to4 relay `192.88.99.0/24`、SRv6 SID `5f00::/16`、`2001::/23` 其餘 IETF 協定指派段（目前依 `isGlobalUnicast` 判定）；另開 net-scope 切片，需資安確認。
4. 帳號名正規化已落地（見 `docs/decisions/2026-11-17-acct-norm.md` 與部署檢查表「帳號名稱正規化（啟動掃描）」）。大小寫／NFKC 分身合併計入每人核准上限；舊庫若有碰撞、未正規化或字元集不合法的名稱，啟動掃描會拒絕啟動，須由管理員手動修正。本系統不回填舊稽核列。
5. 主控台尚未顯示 429 與內網／never 的 409 訊息，需 B 組另開切片。
6. 上限與內網開關的設定變更不寫稽核，只記啟動 log。
7. 非 PG 錯誤的 message/stack 可能含例外文字，與「日誌不含例外字串」原則有落差，待裁示。
