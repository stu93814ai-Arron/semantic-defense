# Git hooks（兩組共用）

hook 都放在有納管的 `.githooks/`，透過 `core.hooksPath` 啟用，不需要新增任何依賴（不用 husky）。

## 安裝
- `pnpm install` 會透過 `prepare` 自動執行 `git config core.hooksPath .githooks`。
- 也可以手動執行 `pnpm hooks:install`。
- worktree 會共用同一個 repo 的 git config，所以設定一次就好；新 clone 下來要先跑一次 `pnpm install`。

## 內容
| hook | 做什麼 | 約略時間 |
|---|---|---|
| pre-commit | gitleaks → `pnpm typecheck` → `pnpm lint --max-warnings=0` | 約 8–10 秒 |
| pre-push | `pnpm typecheck` ＋ `pnpm lint --max-warnings=0`，和閘門步驟 2–3 相同 | 6–7 秒 |

pre-push 只是快速檢查，不會寫入 gate-history。正式紀錄仍然要跑 `pnpm gate:clean <rev>`。

## 注意
目前這個 repo 沒有 remote，各組都是直接在本機 commit 到 main，所以 pre-push 實際上不會觸發，主要靠 pre-commit 把關（PM 核准）。

pre-commit 檢查的是**工作目錄的內容**，不是只看暫存區。如果別人有未提交、但會讓 lint 或 typecheck 失敗的檔案，也可能擋住你的 commit。遇到這種情況請先通知那個人。

## `git commit -n`（跳過 hook）規範
- 只有緊急情況才可以使用。
- commit 訊息必須寫明跳過的原因，例如 `[skip-hooks: 原因]`。
- 事後要向軟體大總召回報。
- 跳過 hook 的 commit 仍然要通過正式閘門（`pnpm gate:clean`）。

## 各組專用 worktree（PM 裁示）
hook 檢查的是整個工作目錄，如果大家共用一個目錄，就會互相擋住，所以每組使用自己的 worktree：

| 目錄 | 分支 | 用途 |
|---|---|---|
| `/workspace/semantic-defense` | `main` | 只給 CI 和閘門用（`pnpm gate:clean`），各組不要在這裡開發 |
| `/workspace/semantic-defense-a` | `team-a` | A 組（control-api、contracts） |
| `/workspace/semantic-defense-b` | `team-b` | B 組（console） |

- git 不允許同一個分支同時在兩個 worktree 裡 checkout，所以各組都不直接在 `main` 上工作。
- 所有 worktree 共用同一份 git config，`core.hooksPath=.githooks` 會自動生效。
- 每個 worktree 都要各自跑 `pnpm install --frozen-lockfile`。

### PM 裁示：整合規則
1. 只有整合守門員（CI）可以把 `team-a`／`team-b` 快轉合入 `main`，各組不要自己合入。
2. **衝突由後合入的那組解決**（`git rebase main`）。`package.json`／`pnpm-lock.yaml` 的變更必須是獨立提交，只改這兩類檔案，訊息以 `deps:` 開頭，並經過整合守門員審查後才能合入。
3. 合入前一定要先對分支跑閘門，**紅燈就不合入**。
4. `main` 只允許快轉（ff-only），不允許 merge commit。

**例外：純文件提交。** 客戶代表、資安審查員、設計師、驗收測試師如果只改 `docs/**/*.md` 和圖片檔，可以直接 commit 到 `main`。CI 事後會重跑閘門。

### 日常流程（各組）
```bash
cd /workspace/semantic-defense-a        # B 組用 -b，分支用 team-b
git rebase main                          # 先同步最新的 main
# 開發 → git commit（hook 只檢查這個目錄）
git rebase main                          # 送合入前再同步一次，有衝突在這裡解決
# 通知整合守門員合入
```

### 合入（只由整合守門員執行，在 main 目錄）
```bash
pnpm merge:team a            # B 組換成 b；有 deps: 提交時，審查後加 --deps-ok
```
`scripts/merge-team.sh` 依序檢查和執行：
1. 目前必須在 `main`。
2. 分支必須以最新的 `main` 為基底，否則停下來，請該組 rebase。
3. 改到 `package.json`／`pnpm-lock.yaml` 的提交必須是只改這兩類檔案的 `deps:` 提交，否則停下來。如果有 `deps:` 提交，沒加 `--deps-ok` 也會停下來。
4. 用 `GATE_OUT` 模式對分支跑 `gate-clean.sh`：只跑閘門、不提交。
5. 綠燈時 `git merge --ff-only`，**合入之後**才在 `main` 提交 ci 紀錄。紅燈時不合入，只在 `main` 記錄 fail。

ci 紀錄只會落在 `main`，不會落在各組分支。合入後各組只要 `git rebase main` 就能接上（分支本身就是 main 的祖先，等於快轉），不會影響之後的合入。

不要直接對分支跑 `pnpm gate:clean team-x`：它會立刻在 `main` 提交紀錄，main 會多出一個分支沒有的提交，那組就得再 rebase 一次。請改用 `pnpm merge:team`。
