# 2026-11-11 待審核准／退回（Asia/Taipei）

以下皆為 A 組領航員裁示（未經使用者確認）。

## 行為

1. `GET /api/blacklist/pending` 只回 `state=open` 且尚未到期（`expires_at > now`）的案件，欄位嚴格對應契約 `PendingCandidate`。
2. 核准（`POST /api/blacklist/pending/:caseId/approve`）無請求本文；成功回應重用既有 `BlocklistEntry`，不新增欄位。`created_at` 與 `approved_at` 皆為核准當下的 app 時鐘；`source=manual`；有效期 24 小時。
3. 退回（`POST /api/blacklist/pending/:caseId/reject`）不收本文，成功為 204 無本文；稽核不寫理由。
4. 不加速率限制。（已由 `2026-11-17-approve-guard.md` 取代：核准改為每個 operator 每小時有上限。）
5. 管理面回應可以照契約帶 ip；新寫的 `blacklist.approve`／`blacklist.reject` 稽核與 log 不得出現 IP。
6. **人工核准不受冷卻期限制。** 白名單一定要擋：核准當下以 `LOCK TABLE allowlist_entries IN SHARE MODE` 重查，命中則整筆交易回滾、不上榜。
7. 僅 `operator` 可列表、核准與退回。路徑參數只接受小寫 UUID，大寫視為不存在（404）。
8. 本片不改 `apps/console`。

## 追蹤項

1. **大寫 UUID 不放寬**：目前路徑參數只接受小寫 UUID。若之後要接受大寫，須另裁示並改契約與實作。
2. **既有含 IP 的稽核列不清**：歷史列（例如 `blacklist.revoke`，以及既有的 `blacklist.auto_list`）的 `detail` 仍可能含 ip。本片新寫的核准／退回稽核已不含 IP。清理歷史列須另開工作，避免在稽核表做破壞性更新。
