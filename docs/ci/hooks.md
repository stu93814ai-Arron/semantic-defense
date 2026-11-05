# Git hooks（兩組共用）

hook 都放在有納管的 `.githooks/`，透過 `core.hooksPath` 啟用，不需要新增任何依賴（不用 husky）。

## 安裝
- `pnpm install` 會透過 `prepare` 自動執行 `git config core.hooksPath .githooks`。
- 也可以手動執行 `pnpm hooks:install`。
- worktree 會共用同一個 repo 的 git config，所以設定一次就好；新 clone 下來要先跑一次 `pnpm install`。

## 內容
| hook | 做什麼 | 約略時間 |
|---|---|---|
| pre-commit | `scripts/secrets.sh`（gitleaks） | 1–2 秒 |
| pre-push | `pnpm typecheck` ＋ `pnpm lint --max-warnings=0`，和閘門步驟 2–3 相同 | 6–7 秒 |

pre-push 只是快速檢查，不會寫入 gate-history。正式紀錄仍然要跑 `pnpm gate:clean <rev>`。

## 注意
目前這個 repo 沒有 remote，各組都是直接在本機 commit 到 main，沒有 push，所以 **pre-push 實際上不會觸發**。
要在 commit 時就擋下來，需要 PM 核准把同樣的檢查加到 pre-commit（目前沒有實作）。
