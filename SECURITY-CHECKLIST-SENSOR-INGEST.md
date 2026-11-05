# 資安檢查表：apps/sensor-ingest（感測／中繼資料接收）

狀態：**正式**（2026-11-06 Asia/Taipei 更新）— 軟體大總召要求納入平面分離並補檢查項；PM 裁示補 `allowed_app_ids`／稽核／SI6.5–6.6。  
對齊：[SECURITY-CHECKLIST-PLANE-SEPARATION.md](./SECURITY-CHECKLIST-PLANE-SEPARATION.md)（P6）、`PLAN-ADDENDUM-MONITOR.md`。  
凡 `apps/sensor-ingest` 或感測器憑證／來源 allowlist 相關合併，簽核必過本表適用項；尚未實作時查「不得偷跑」。

## 產品定案（本表依據）

| 項目 | 定案 |
| --- | --- |
| 程序 | **獨立** `apps/sensor-ingest`；**獨立埠**；與 console／control-api／gateway／EDL **分開部署** |
| 傳輸 | **HTTPS only**（正式環境無明文 HTTP） |
| 來源 | **來源 IP allowlist**；非名單拒絕且不寫入中繼資料 |
| 憑證 | **感測器 token**：管理面由 **`platform_admin` 發放**；程序內／庫內**只存雜湊**；**可撤銷**；明文 token 只在發放當下給操作者一次 |
| App 綁定 | 發放時 **`platform_admin` 必填 `allowed_app_ids`（≥1）**；修改綁定亦僅 `platform_admin`；兩者皆須**寫稽核**。ingest 收到未綁定 `app_id` → **403**，日誌／拒絕表**只記 `sensor_id`＋時間**，不記 payload。E3.A 來源條件**只計**通過綁定檢查之 `app_id` |
| 路由 | **無管理路由**（無登入、無人員、無案件核准、無模式切換、無 token 發放 API） |
| 資料 | 只收契約 `FlowMetadata` 欄位；拒封包內容／URL／標頭／解密結果 |

---

## SI1. 平面與部署

| # | 檢查項 | 通過條件 |
| --- | --- | --- |
| SI1.1 | 獨立程序、獨立套件啟動入口、獨立 listen 埠 | 不與 control-api／console 同程序或同 listen |
| SI1.2 | 部署設定分開（不同服務／不同網路策略可證） | 文件或編排可對照 |
| SI1.3 | 程式庫／映像不含管理面私鑰、session 密鑰、或可還原之 token 明文 | 密文掃描＋設定審 |

## SI2. TLS

| # | 檢查項 | 通過條件 |
| --- | --- | --- |
| SI2.1 | 只提供 HTTPS；無正式明文 HTTP 收流量 | 部署／設定可證 |
| SI2.2 | TLS 1.2+；正式環境校驗憑證 | 無長期 insecure 開關進正式 |
| SI2.3 | 憑證與金鑰不進程式庫、前端、感測客戶端範本倉庫明文 | 秘密管理／環境變數 |

## SI3. 來源 IP allowlist

| # | 檢查項 | 通過條件 |
| --- | --- | --- |
| SI3.1 | 請求來源 IP 須在 allowlist；否則拒絕（建議 403／401，**不寫入** FlowMetadata） | 測非名單 IP |
| SI3.2 | Allowlist 變更僅管理平面授權角色（至少 `platform_admin`）；有稽核 | 越權 403；sensor-ingest 本身無改名單 API |
| SI3.3 | 信任代理／`X-Forwarded-For` 預設關閉或等同 control-api `trustProxy` 紀律；不得被客戶端偽造來源繞過 allowlist | 設定＋紅燈測 |

## SI4. 感測器 token（雜湊、可撤銷）

| # | 檢查項 | 通過條件 |
| --- | --- | --- |
| SI4.1 | 發放僅 `platform_admin`（管理面 API／UI）；其他角色 403 | 角色測 |
| SI4.2 | 儲存**只存不可逆雜湊**（如 argon2／同等）；DB／備份／日誌**無明文 token** | schema＋日誌掃描 |
| SI4.3 | 明文 token **僅發放回應出現一次**；之後無法再讀出 | API 契約測 |
| SI4.4 | **可撤銷**：撤銷後該 token 立即（或 ≤ 既定傳播延遲內）失效；ingest 拒絕 | 撤銷後再送 → 拒 |
| SI4.5 | Token 驗證與來源 IP allowlist **同時**滿足才接受；缺一不可 | 矩陣測 |
| SI4.6 | 失敗回應不回顯 token／雜湊／內部路徑；速率限制防撞庫 | 錯誤本體＋429 |
| SI4.7 | 發放必填 `allowed_app_ids`（≥1，契約 `Id`）；僅 `platform_admin`；寫入稽核（無 token／hash） | 角色測＋audit 列 |
| SI4.8 | 修改綁定（PATCH）僅 `platform_admin`；寫入稽核；其他角色 403 | 越權測＋audit 列 |
| SI4.9 | ingest：`app_id` 不在該 token 的 `allowed_app_ids` → **403**；**不寫** `flow_events`；拒絕紀錄／日誌**只含 `sensor_id`＋時間**（無 payload） | 紅燈測＋表／日誌抽樣 |
| SI4.10 | E3.A／後續來源條件只採用**已通過綁定檢查**寫入之 `app_id`（未綁定不得進案件／條件計算） | 對照產品定案；本階段以 ingest 閘門為證 |

## SI5. 無管理路由

| # | 檢查項 | 通過條件 |
| --- | --- | --- |
| SI5.1 | 無 `/login`、session cookie 登入、人員／角色管理 | 探測 |
| SI5.2 | 無案件核准、白名單寫入、模式切換、EDL 簽名私鑰操作 | 路由表＋探測 |
| SI5.3 | 無「發放／列出明文 token」端點在 **sensor-ingest 埠**（發放只在管理平面） | 探測 |

## SI6. 資料與契約

| # | 檢查項 | 通過條件 |
| --- | --- | --- |
| SI6.1 | 只接受 `FlowMetadataEventSchema`；多欄／缺欄／未知鍵整份拒絕；**禁止自報 `sensor_id`**（由 token 決定） | 契約測＋自報 → 400 |
| SI6.2 | 拒 payload、URL、標頭、TLS 明文等欄位 | 負向測 |
| SI6.3 | 日誌／稽核／拒絕表不含封包內容、token 明文、密碼 | 抽樣 |
| SI6.4 | IP 進入後續黑／白名單比對前須 **canonical 正規化**（或收緊 `SingleIp`），避免 IPv4-mapped／非 canonical 形狀混淆 | 對照 contracts 殘留 |
| SI6.5 | `flow_id` **每 sensor 各自唯一**（建議 PK `(sensor_id, flow_id)`）；跨 sensor 可重用；衝突回應不得洩露他 sensor 是否已佔用該 ID | schema＋跨 sensor 409 測 |
| SI6.6 | 保留期清除（若有）須可注入時鐘測；清除範圍不得越權刪他用途資料 | 清除測 |

## SI7. 與管理面故障模式

| # | 檢查項 | 通過條件 |
| --- | --- | --- |
| SI7.1 | 管理面短暫不可用時：不得改為「無 token 也可寫」；不得清空 allowlist 變全開 | 故障測 |
| SI7.2 | Token／allowlist 快取若有 TTL，撤銷後之上界可文件化且可測 | 文件＋測 |

## SI8. 簽核欄（每次相關合併填）

- 對象變更／SHA：______________
- SI1–SI7：□ 全過　□ 本階段 N/A：____　□ 未過：____
- 結論：□ 准予合併　□ 退回
- 審查員：資安審查員　日期（Asia/Taipei）：______________

## 變更紀錄

| 日期 | 說明 |
| --- | --- |
| 2026-11-05 | 初版：總召指示納入平面分離並補 token／allowlist／HTTPS／獨立埠／無管理路由檢查項 |
| 2026-11-06 | PM 裁示（經 A 組領航員轉達）：`allowed_app_ids` 發放／修改綁定＋稽核；未綁定 → 403 且不記 payload；E3.A 只計通過綁定之 app_id。並補 SI6.5／SI6.6（per-sensor `flow_id`、保留期） |
