# 2026-11-17 自動上榜總開關（A1／A2）（Asia/Taipei）

需求：**使用者決定／需求（由軟體大總召轉達）**——自動上榜要有可由管理員切換的總開關。
以下細節除另有標示外，皆為 **A 組領航員裁示（未經使用者確認）**（設計調查 14 點全數核准）。
不改 `PLAN.md`、相依套件或 `apps/console`；契約只依 A1 新增本開關。

## 契約（A1）

- `ADMIN_API_PATHS.autoList = "/api/settings/auto-list"`。
- `AutoListSettingSchema = z.strictObject({ enabled: z.boolean() })`：GET 回應、PUT 請求與 PUT 回應同形；多欄、缺欄、非布林整份拒絕。
- 主入口與 `./browser` 都轉出 `AutoListSettingSchema`（console 日後直接引用）。

## 儲存

- 單列表 `auto_list_settings (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), enabled BOOLEAN NOT NULL DEFAULT FALSE)`，migrate 時 `INSERT … ON CONFLICT DO NOTHING` 種下預設列。
- **預設關閉、沒有環境變數。** 與 `auto_breaker` 分表，總開關與熔斷各自演進。
- 測試清理：`seedPhase2Fixtures`、`truncatePhase2Tables` 與帳號正規化測試的平行清表路徑，都把開關重設為 `false`（缺列則補回），避免 `enabled=true` 外洩到下一個測試。

## API（A2）

- 僅 `platform_admin`。未登入 401 `{"error":"未登入"}`；已登入但角色不符 403 `{"error":"權限不足"}`。
- GET：一般 `SELECT`，**不加** `FOR UPDATE`。
- PUT：以契約 schema 做 strict `safeParse`，失敗 400 `{"error":"請求格式錯誤"}`，不改值、不寫稽核。
  通過後在同一個交易裡 `SELECT … FOR UPDATE` 鎖列：
  - 值未變 → 200 回現值，**不寫稽核**。
  - 值變更 → `UPDATE` 並寫稽核 `settings.auto_list.update`，`actor` 是 session 裡已正規化的帳號名稱，`detail` 只有 `{ before: { enabled }, after: { enabled } }`。不含 IP、URL、請求內容或其他欄位（稽核列本身的 `at` 照舊）。
  - 稽核寫入失敗 → 整筆交易回滾，回 500 固定本文，開關維持原值。
- 切換開關**不會**重設、開啟或清空熔斷（`auto_breaker` 原樣保留）。

## 判定 tick

- 每個 tick 在取得 `JUDGE_LOCK` 之後讀一次開關（不是每個案件各讀一次），同一 tick 內所有案件共用該值。
- 讀取包在 `SAVEPOINT` 裡：讀失敗則 `ROLLBACK TO SAVEPOINT`，視為**關閉**（fail-closed），tick 照常開案、cursor 照常前進；缺列同樣視為關閉。
  log 只寫 `log.error({ error_class: "auto_list_setting_read" }, "auto-list setting read failed")`：固定錯誤碼與固定訊息，不含例外正文、SQL、IP 或 URL。
- `AUTO_LIST_ENABLED_DEFAULT`（`false`）保留，只作缺列／讀失敗時的 fallback，不再是生產開關。
- `buildApp({ autoListEnabled })` 與 `runJudgeTick` 的 `TickOpts.autoListEnabled` **只供測試覆寫**：有傳入就不讀 DB；生產不傳。

## 開、關的效果

- **關閉**：tick 仍開案、累加，案件留在待審；不評估 E3.A、不自動上榜、不寫 `blacklist.auto_list`／`auto_suppressed`／`auto_breaker_*`。不為「因關閉而略過」另寫逐案 log 或稽核。
- **關閉不撤銷既有的自動上榜項目**：已存在的 `source = 'auto'` 黑名單列不會被撤回，照原本的到期時間自然到期；需要提早移除時由操作者手動撤回。
- **開啟只影響之後的判定**：不回溯重跑過去的命中或待審案件；之後新的命中才會依 E3.A 評估。

## 與熔斷的關係

- 關閉期間熔斷**凍結**：不判恢復、不寫 `auto_breaker_close`，`opened_at` 原樣保留。
- 重新開啟後，**下一個 tick** 才補判熔斷是否恢復。
- 開關本身從不重設或清除熔斷；開啟後每小時超過上限（預設 50）仍照舊改走人工待審。
- 「熔斷獨立運作」解讀為：開關不開、不關、不清熔斷，熔斷機制本身不變。

## 與「生產預設 on」舊決定的關係

`2026-11-09-case-flow-addendum.md` 記有 **使用者決定（由軟體大總召轉達）**：前提 (a)–(e) 都合併後，生產預設改為 on。
本開關取代「之後把常數改成 on」的小切片（A 組領航員裁示，未經使用者確認）：生產唯一來源是 DB 列，預設 `false`；前提滿足後，由 `platform_admin` 經本 API 打開。
是否改為「migrate 種子預設 true」，仍待軟體大總召向使用者確認後另開切片，本片不做。

## 殘件（B 組，A 不改）

- `apps/console`：`adminApi` 用戶端、設定頁開關 UI（僅 `platform_admin` 可見與可改）、401／403／400 的載入與錯誤顯示，以及對應測試。
- 開發用 `phase2ApiPlugin` 是否要接這條路徑，請 B 組評估。

## 已知後續（駕駛員自行決定（交 A 組領航員））

- 讀失敗目前只有 log，沒有告警；是否加告警留待之後的切片決定。
