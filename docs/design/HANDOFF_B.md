# B 組交接：設計 v1.0（北歐預設、可切義式）

完整規格：`docs/design/DESIGN_SYSTEM.md`（第 7 節 tokens、第 8 節主題切換、第 9 節對比）。

## 1. Tokens 套用
- 新增 `apps/console/src/styles/tokens.css`，內容直接複製 DESIGN_SYSTEM.md 第 7 節的 CSS 區塊（含 `--color-wood-*`）；在 `main.tsx` 匯入一次。
- `index.html`：`<html lang="zh-Hant" data-theme="nordic">`，`<head>` 最前面放第 8 節的防閃爍腳本。
- 元件只引用 `var(--color-*)`、`--radius-*`、`--font-*`，不寫死色碼。狀態用 `data-state` / `data-tone`，不在 JSX 裡判斷顏色。
- 字型：`@fontsource/noto-sans-tc`、`@fontsource/noto-serif-tc`、`@fontsource/cormorant-garamond`、`@fontsource/playfair-display`（新增依賴前先照 PLAN.md 詢問）。

## 2. 頁面 ↔ mockup（D 為準，E 為切換後樣子）
| 路徑 | mockup |
|---|---|
| `/login` | `direction-d-login.png` / `direction-e-login.png` |
| `/judgments` | `direction-d-judgments.png` / `direction-e-judgments.png` |
| `/judgments/:caseId` 正常（倒數中） | `direction-d-judgment.png` / `-e-` |
| 逾時 >7 秒 | `direction-d-judgment-timeout.png` / `-e-` |
| 兩人同時核准 | `direction-d-judgment-conflict.png` / `-e-` |
| 限制已到期／已撤回 | `direction-d-judgment-expired.png` / `-e-` |
HTML 原始檔在 `docs/design/mockups/direction-*.html`，可直接開瀏覽器量尺寸。其他頁（判斷紀錄、生效限制等）沿用同一套側欄、卡片、表格、橫幅元件。

## 3. 狀態對照
| 狀態 | data-state | 橫幅 tone | 標籤 | 按鈕 |
|---|---|---|---|---|
| 載入 | `loading` | — | — | 骨架 |
| 空 | `empty` | — | — | — |
| 入口連不上 | `gateway-down` | warning | — | 重試 |
| 無權限 | `forbidden` | neutral 整頁 | — | — |
| AI 撰寫中 0–7 秒 | `pending` | — | info「AI 撰寫中」 | 核准停用、退回可用 |
| 建議就緒 | `ready` | — | success | 核准＋退回 |
| 逾時 >7 秒 | `timeout` | warning「已超過七秒」 | warning「逾時」 | 核准停用、「手動退回」可用 |
| 他人先核准 | `conflict` | danger「已由他人核准」 | danger | 全停用，顯示生效版本 |
| 已到期／已撤回 | `expired` / `revoked` | neutral | neutral | 全停用，唯讀 |
風險標籤：高 danger、中 warning、低 info。停用按鈕需 `aria-disabled` 並說明原因。

## 4. 主題切換驗收清單
- [ ] 無 `localStorage['sd.theme']` 時為北歐（`data-theme="nordic"`）。
- [ ] 切到義式立即生效並寫入 `sd.theme="italian"`；重新整理仍為義式且首屏不閃。
- [ ] 亂值或 localStorage 不可用時回北歐、不報錯。
- [ ] `role="radiogroup"` + `role="radio"` + `aria-checked`；roving tabindex。
- [ ] ←→↑↓ Home End 可切換，Space/Enter 可選，focus 環可見。
- [ ] D 在側欄底部、E 在頂欄右側、登入頁右上角都有。
- [ ] 兩主題下文字對比 ≥ 4.5:1（以 `mockups/contrast.md` 色值為準）；切換不改版面尺寸。
