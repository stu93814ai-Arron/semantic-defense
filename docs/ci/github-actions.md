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

## 快轉與「線性歷史」不是同一件事

本倉庫的快轉只由 `scripts/merge-team.sh` 執行：`git merge --ff-only`。成功時 `main` 的新 HEAD 就是來源分支的 HEAD，提交 SHA 不變。本檔與 workflow 都不改這個腳本。

GitHub 沒有「只允許 fast-forward」的合併方式或分支規則。官方文件寫明：要開啟 `required_linear_history`，倉庫必須仍允許 squash 或 rebase 合併。這兩種都會產生新的提交 SHA，不是 `git merge --ff-only`。

| 設定 | 實際效果 | 是不是 fast-forward-only |
| --- | --- | --- |
| 禁止 force push（`allow_force_pushes: false`） | 拒絕改寫 `main` 上已有歷史的推送 | 否。只保證指標不後退。squash、rebase、merge commit 仍可把 `main` 往前移 |
| 禁止刪除分支（`allow_deletions: false`） | 拒絕刪除受保護分支 | 否。與合併方式無關 |
| 必須線性歷史（`required_linear_history`） | 拒絕把 merge commit 推上該分支 | 否。squash 與 rebase merge 仍算線性，而且 SHA 是新的 |
| 必須通過 `quality` | 經 PR 合併前，這次 CI 要綠 | 否。直接推送是否也要檢查，取決於方案是否允許分支保護，以及有沒有同時要求 PR |
| `scripts/merge-team.sh` 的 `git merge --ff-only` | 只有來源分支已包含 `main` 時才移動指標，SHA 不變 | 是。這是目前唯一的快轉執行點 |

因此：即使日後分支保護把「必須線性歷史」打開，也不能把它寫成「已經只能快轉」。
