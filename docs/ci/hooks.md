# Git hooks（兩組共用）

hook 都放在有納管的 `.githooks/`，透過 `core.hooksPath` 啟用，不需要新增任何依賴（不用 husky）。

## 安裝
- `pnpm install` 會透過 `prepare` 自動執行 `git config core.hooksPath .githooks`。
- 也可以手動執行 `pnpm hooks:install`。
- worktree 會共用同一個 repo 的 git config，所以設定一次就好；新 clone 下來要先跑一次 `pnpm install`。

## 內容
| hook | 做什麼 | 約略時間 |
|---|---|---|
| pre-commit | 只驗**暫存區（index）**：匯出 index → gitleaks → `pnpm typecheck` → `pnpm lint --max-warnings=0` | 約 8–12 秒 |
| pre-push | `pnpm typecheck` ＋ `pnpm lint --max-warnings=0`，和閘門步驟 2–3 相同 | 6–7 秒 |

pre-push 只是快速檢查，不會寫入 gate-history。正式紀錄仍然要跑 `pnpm gate:clean <rev>`。

## 注意
遠端庫已公開。推送到遠端時 pre-push 會跑型別檢查與 lint。完整閘門在 GitHub Actions（見 [github-actions.md](./github-actions.md)）。合入 `main` 的快轉契約、現況保護，以及尚未套用的修正，都寫在該檔。GitHub 的「必須線性歷史」不是快轉。

pre-commit 只檢查**暫存區（index）**的內容，不讀工作目錄未暫存的改動。實作方式：`git checkout-index -a --prefix=<tmpdir>/` 匯出 index 到暫存目錄；根目錄 `node_modules` 用 symlink，**`packages/*`／`apps/*` 的 `node_modules` 用 `cp -a` 複製**（保留 pnpm 相對連結，讓它們解析到暫存目錄內的 `packages/*`，而不是工作目錄；並排除 `node_modules/.vite` 快取（若 `.vite` 本身是 symlink，只 `rm -f` 刪連結，不跟隨、不因此拒絕提交））。若對套件 `node_modules` 也用 symlink，相對路徑會指回工作目錄的 src，index 隔離會失效。寫入／刪除暫存樹子路徑前會以 `realpath` 確認仍在 `$TMP` 內，避免 index 裡的 symlink（例如 `packages → /abs/path`）讓 `rm -rf`／`cp` 碰到樹外。`trap`＋`rm -rf "${TMP:?}"` 保證結束時刪掉暫存目錄。不用 `git stash`，因此不會碰到主目錄「禁止 stash」規則，也不會動到別人 worktree 既有的 stash 堆疊。

因此：已 `git add` 的紅碼會擋 commit；只存在工作目錄、尚未暫存的紅碼不會擋。跨套件改名（例如只暫存 contracts 匯出改名、依賴方未改）也會被擋下。請仍養成「要提交的變更都先 add」的習慣。


### 已知殘留（gitleaks 加白）
pre-commit 對暫存區做 gitleaks 目錄掃描時，**會遵循暫存區裡的** `.gitleaks.toml` **與** `gitleaks:allow` **註解**。因此提交者可以把這類設定一併 `git add`，替自己的 secret 加白——這點與改成 index-only **之前的舊版 hook 行為相同**（舊版掃工作目錄時同樣會吃到這些加白）。hook 內**先不改這段行為**；由 CI 的 GitHub Actions `quality` 與 `pnpm gate:clean`（正式 secrets 關卡）兜底。若日後要收緊 hook 端加白，另開變更。

## 測試
`scripts/test-precommit-index-only.sh`：拋棄式 stub 驗證 (a)–(d)；**(s)** `packages → 樹外`（SENTINEL 在 `contracts/node_modules/`，輸出須含 ❌；並以 (s0) 用舊版 c220b0b **驗證 (s) 判準本身**會不及格（非評價現行 hook））；**(v)** `.vite` 為樹外 symlink 時只刪連結、放行；真實 monorepo (r1)(r2)。trap：INT→130、TERM→143；只 `git worktree remove --force` 自己建的路徑（不做全域 prune）。

## `git commit -n`（跳過 hook）規範
- 只有緊急情況才可以使用。
- commit 訊息必須寫明跳過的原因，例如 `[skip-hooks: 原因]`。
- 事後要向軟體大總召回報。
- 跳過 hook 的 commit 仍然要通過正式閘門（`pnpm gate:clean`）。

## 各組專用 worktree（PM 裁示）
各組仍使用自己的 worktree（避免互相改到同一工作目錄）；pre-commit 已改為只驗 index，未暫存的改動不再互相擋住 commit：

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
# 開發 → git add → git commit（hook 只檢查暫存區／index）
git rebase main                          # 送合入前再同步一次，有衝突在這裡解決
# 通知整合守門員合入
```

### 合入（只由整合守門員執行，在 main 目錄）
```bash
pnpm merge:team a            # B 組換成 b；有 deps: 提交時，審查後加 --deps-ok
```
`scripts/merge-team.sh` 依序檢查和執行，最多重試 3 次（`MERGE_MAX_TRIES` 可調整）：
1. 目前必須在 `main`。
2. **自動 rebase（PM 裁示）**：如果分支建立之後，main 的新提交只改了 `docs/**`、`*.md` 或 `.ci/**`，就自動在該組的 worktree 把分支 rebase 到 main。
   - main 有其他檔案的變更、該組 worktree 有未提交的變更，或 rebase 發生衝突時，會停下來（衝突時先 `rebase --abort` 復原），請該組自己 rebase。
3. 改到 `package.json`／`pnpm-lock.yaml` 的提交必須是只改這兩類檔案的 `deps:` 提交，否則停下來。如果有 `deps:` 提交，沒加 `--deps-ok` 也會停下來。
4. 用 `GATE_OUT` 模式對分支跑完整閘門：只跑閘門、不提交。
   - 紅燈：不合入，在 main 記錄 `fail`。
   - 閘門期間分支被改動：不合入。
5. 綠燈時 `git merge --ff-only`，**合入之後**才在 main 記錄 `pass`。
6. 如果 ff 失敗（閘門期間 main 又前進），在 main 記錄 `ff-failed(main=<當時的 main HEAD>)`，回到步驟 2 重試。`ff-failed` 不計入通過率的分母。

不要直接對分支跑 `pnpm gate:clean team-x`：它會立刻在 `main` 提交紀錄，main 會多出一個分支沒有的提交，那組就得再 rebase 一次。請改用 `pnpm merge:team`。

## 不在 main 目錄使用 `git stash`
main 目錄（`/workspace/semantic-defense`）只給 CI 和閘門用，**禁止在這裡 `git stash`**。暫存工作請在自己組的 worktree 進行（`semantic-defense-a`、`-b`），或開自己的分支。
留在 main 目錄的 stash 會混進 `.ci` 紀錄和別人的檔案，之後很難分辨哪些是真的、該由誰處理。
