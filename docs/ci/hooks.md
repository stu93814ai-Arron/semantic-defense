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
