# 資安檢查表：第 3 階段 packages/contracts（monitor 新契約）

對照：`PLAN-ADDENDUM-MONITOR.md` §3。範圍：`a8fb95e` → `08eacb1`（含於 `d608599` 祖先鏈）。

## 結論

**准予合併（APPROVE with residuals）** — 契約層無阻擋項。  
審查員：資安審查員　時間：2026-11-05（Asia/Taipei）  
請求來源：B 組領航員交叉審通過後轉簽；作者 A 組駕駛員。

## 檢查結果

| 項目 | 結果 |
| --- | --- |
| FlowMetadata：strict；拒 payload／URL／headers | PASS |
| src/dst 單一 IP（拒 CIDR／zone）；port／protocol／非負整數 | PASS |
| 保留 7 天 | N/A（儲存層） |
| 黑名單：canonical、前綴下限、主機位、保留位址、auto 僅 /32／/128 | PASS |
| 黑名單：confidence、時間窗、approved_by↔source | PASS |
| 快照：version≥1、hex64、base64url 格式 | PASS（不驗證簽章／雜湊＝合約層意圖） |
| 白名單：v4≥/8 v6≥/32、拒 mapped／非 canonical／保留、expires | PASS |
| ParseResult 失敗不回原文 | PASS |
| Id 1–128 charset | PASS |
| 新欄位無密鑰／密碼 | PASS |
| `pnpm exec vitest run`（packages/contracts） | **331** 測全綠 |

## FlowMetadata `SingleIp` vs 黑／白名單路徑（領航員特別問）

| 形態 | FlowMetadata `SingleIp` | 黑／白名單 `ip-cidr` |
| --- | --- | --- |
| IPv4-mapped（`::ffff:…`） | **接受** | **拒絕** |
| 非 RFC5952 canonical IPv6 | **接受** | **拒絕** |

PLAN §3 對 FlowMetadata 只要求「單一 IPv4／IPv6」；canonical／mapped 明文寫在黑／白名單。契約層不直接造成黑／白名單繞過。  
**非阻擋殘留**：ingest／matcher 若用原始字串比對，可能形狀混淆；建議在 Phase 3 接收／比對落地前 harden `SingleIp`（或共用 host 正規化）並補負向測。

## 非阻擋殘留

1. `SingleIp` 與黑／白名單不對稱（上表）。
2. `reason` 自由文字無 unicode／控制字元拒斥；UI／稽核須自行編碼。
3. `NonNegInt`、`entries[]`、`signature` 長度無上限；後續 ingest 須限流。
4. 快照不驗章／不驗 sha256（EDL 階段負責）。

