# GitHub Actions

workflow：`.github/workflows/ci.yml`。工作名稱是 `quality`（狀態檢查名稱用這一字）。  
動作出處見 [../provenance/ALLOWED-GITHUB-ACTIONS.md](../provenance/ALLOWED-GITHUB-ACTIONS.md)。

## 跑什麼

`pnpm run ci`，也就是 `scripts/ci.sh`。這是既有權威閘門，包含：

1. `pnpm install --frozen-lockfile`（工作流程先做一次；`ci.sh` 在沒有 `node_modules` 時會再做同一次）
2. 必跑測試跑兩次、FLAKY 偵測、覆蓋率門檻（lines／branches／functions／statements 各 ≥70%）
3. 型別檢查、eslint `--max-warnings=0`、jscpd、`pnpm audit`（high／critical 阻擋）
4. `scripts/secrets.sh`：gitleaks 掃工作目錄與 git 歷史（checkout `fetch-depth: 0`）
5. 平面邊界、CycloneDX SBOM
6. E2E：仍由 `scripts/e2e.sh` 挑兩個空閒埠，並用 `flock` 鎖 `/tmp/semantic-defense-e2e.lock`。CI 不設定 `E2E_PORT`／`E2E_IDLE_PORT`，不設 `SKIP_E2E=1`

`pnpm ci`（沒有 `run`）是 pnpm 的 clean-install，不會跑上述閘門，workflow 不使用它。

覆蓋率、門檻、安全測試都沒有放寬，也沒有關掉。Playwright 瀏覽器在呼叫 `pnpm run ci` 之前安裝，避免下載時間吃掉 `scripts/e2e.sh` 既有的秒數上限；秒數上限本身沒有改。

## 模型

CI 不呼叫 Grok、不呼叫本地推論端點、不讀取模型權杖。workflow 若發現 `GROK_API_KEY`、`XAI_API_KEY`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OLLAMA_HOST`、`OLLAMA_MODELS`、`INTENT_MODEL_URL`、`INTENT_MODEL_NAME`、`HUGGING_FACE_HUB_TOKEN`、`HF_TOKEN` 任一有值，直接失敗。套件只從 `https://registry.npmjs.org/` 安裝。

`GITHUB_TOKEN` 只有 `contents: read`。checkout 設 `persist-credentials: false`。不把秘密寫進日誌，不上傳 artifact。

## 有界時間

工作整體 `timeout-minutes: 45`。網路安裝另有步驟上限，且只重試一次；日誌只印步驟名稱與 UTC 時間，不印環境變數：

| 步驟 | 上限 | 重試 |
| --- | --- | --- |
| pin pnpm | 5 分鐘 | 1 次 |
| frozen install | 10 分鐘 | 1 次 |
| Playwright Chromium | 15 分鐘 | 1 次 |
| `pnpm run ci` | 25 分鐘 | 不重試 |

腳本內部的 600 秒必跑上限、E2E 秒數上限、覆蓋率 70%、gitleaks 都沒有放寬。步驟上限只用來讓沒有輸出的下載在整體 45 分鐘之前失敗。

## 整合契約

快轉的定義：`main` 的新 HEAD 等於已審查分支的 HEAD，提交 SHA 不變。執行點是 `git merge --ff-only` 之後的一般 `git push`（沒有 `--force`）。`scripts/merge-team.sh` 只更新執行它所在的本地 `main`，不推 origin，也不會因為遠端保護而空等；它印出「已快轉合入 main」時，只代表那個本地分支。不要把它讀成 `origin/main` 已經前進。

`quality` 是 GitHub Actions app id `15368` 的檢查名。覆蓋率、gitleaks、E2E 都在 `pnpm run ci` 裡面，不能為了合入而跳過。

### 現況（總召 2026-11-06 11:38 台北讀回，本檔不改設定）

已套在 `main` 的 classic protection：

- `allow_force_pushes=false`
- `allow_deletions=false`
- `required_status_checks`：`quality`，app id `15368`，`strict=true`
- `required_linear_history=true`
- `required_pull_request_reviews` 有設定，核准票數 0
- `enforce_admins=true`
- `restrictions=null`

這段是現況。下面的修正還沒套用。

### 不相容的是「必須經 PR」

要保留的是：必要檢查、禁止 force push、禁止刪除、管理員同樣受保護、已審 head 以 fast-forward-only 進入 `main`。

總召額外打開的 `required_pull_request_reviews`（必須經 PR，而且 `enforce_admins=true`）會拒絕所有直接推送，包括把 `main` 快轉到已審 SHA。GitHub 的合併按鈕沒有 fast-forward-only：merge commit 會被線性歷史拒絕，squash 與 rebase and merge 都會產生新 SHA。線性歷史只拒絕 merge commit，不是快轉。

建議只拿掉「必須經 PR」。其餘現況開關維持。完整 PUT 正文在 [main-ff-protection-proposal.json](./main-ff-protection-proposal.json)，`"status": "NOT_APPLIED"`。不要把該檔貼上的內容說成已經生效，也不要在推送同一個步驟裡關掉保護或加 bypass。

### 失敗即停

1. 該 SHA 上沒有 app id `15368` 的 `quality` success → 停止。
2. `origin/main` 不是該 SHA 的祖先 → 停止。不要為了製造快轉而去 rebase 或 squash。
3. `required_pull_request_reviews` 仍不是 `null` → 停止。不要改用 squash、rebase and merge 或 merge commit，也不要臨時關閉保護。
4. 修正套用之後，只做不含 `--force` 的快轉推送。推送被拒 → 停止，並用下面的回滾正文把保護貼回去。

### 總召套用後的驗證與回滾

套用前先 `GET` 保護並把回應存下來。讀回應與上一節現況一致；不一致就停止。套用後再 `GET`，預期是：force 與 delete 仍為 false、線性歷史仍為 true、`enforce_admins` 仍為 true、`quality`／15368／strict 仍在、`required_pull_request_reviews` 為 `null`。

回滾是把套用前存下來的那份 GET 正文原樣 `PUT` 回去。11:38 的讀回沒有給審查物件的其餘子欄位，所以不要用手寫的審查物件代替那份存檔。
