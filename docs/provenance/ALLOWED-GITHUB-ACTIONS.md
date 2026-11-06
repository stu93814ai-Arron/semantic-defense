# 允許的 GitHub Actions（出處審查）

狀態：CI 就緒（2026-11-06）。  
只收本倉庫 workflow 實際引用、且已核對出處的動作。判定不明＝不允許。  
不收中國來源的動作、映像或下載鏡像。模型權重仍只依 [ALLOWED-MODELS.md](./ALLOWED-MODELS.md)。

## 判定規則

1. 動作必須來自已驗證的 GitHub 官方組織 `actions`（組織 id `44036562`，說明為 GitHub Actions，網站 `https://github.com/features/actions`）。
2. workflow 只寫完整 commit SHA，不寫浮動 tag。SHA 必須是該版 tag 所指的 commit，且為預設分支歷史上的祖先。
3. commit 的 GitHub 簽章驗證必須為 `verified: true`、`reason: valid`。
4. 不新增會上傳覆蓋率、日誌或權杖的第三方動作。秘密掃描沿用 `scripts/secrets.sh`（gitleaks 8.21.2，SHA-256 已寫在腳本內），不改用外部 gitleaks action。

## 允許列

| 動作 | 釘選 | tag | 出處 | 驗證（2026-11-06） |
| --- | --- | --- | --- | --- |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `v7.0.1` | GitHub 官方組織 `actions`（美國，GitHub） | tag 指向該 commit；`package.json` 版本 7.0.1；簽章 valid；`main` 比此 commit 超前 1、此 commit 不是分叉 |
| `actions/setup-node` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `v7.1.0` | 同上 | tag 指向該 commit；`package.json` 版本 7.1.0；簽章 valid；`main` 比此 commit 超前 1、此 commit 不是分叉 |

## 同次 CI 使用、但不是新依賴的工具鏈

| 工具 | 釘選 | 出處 | 說明 |
| --- | --- | --- | --- |
| GitHub-hosted runner | `ubuntu-24.04` | GitHub 提供的託管執行器（Ubuntu / Canonical） | 不使用自架 runner，不指定容器映像 |
| Node.js | `22.23.4` | `https://nodejs.org/dist/v22.23.4/`（OpenJS Foundation，美國） | 由 `actions/setup-node` 安裝。2026-11-06 對該目錄的 `SHASUMS256.txt` 取得 HTTP 200 |
| pnpm | `10.33.4` | `https://registry.npmjs.org/pnpm/10.33.4` | 維護者 `zkochan`、`pnpmuser`；授權 MIT；integrity `sha512-HGezs1my1AgRm6HtKJ80uPw8aHNBK+xv0mT73IJInlEPy+y5zp0i2ufzt2Jp2EQQRgFL3KU7mXnNelYa1jG4AA==`。經 Node 內建 corepack 安裝，不寫進 `package.json`，不新增依賴 |
| Playwright Chromium | 鎖檔內 `@playwright/test` 1.64.1 | Playwright 預設下載位址（不設定 `PLAYWRIGHT_DOWNLOAD_HOST`） | 只為滿足既有 `scripts/e2e.sh`；系統相依來自 Ubuntu 套件庫 |

## 變更紀錄

| 日期 | 說明 |
| --- | --- |
| 2026-11-06 | 初版：checkout v7.0.1、setup-node v7.1.0 |
