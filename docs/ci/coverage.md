# 覆蓋率核心範圍（CORE_COVERAGE_INCLUDE）

門檻：lines／branches／functions／statements 各 ≥70%（v8），定義於 `vitest.config.ts`。

## control-api（A 組 11-09）
`apps/control-api/src/**/*.ts` 全部納入（成案、判定 tick、自動上榜、熔斷、白名單、稽核…）。原本只有 `auth.ts`／`authz.ts` 等授權檔；那幾條保留不刪（移除須經整合守門員）。
納入前後（同一 commit 基底、1248 筆測試）：lines 95.04%（710/747）→ 96.49%（1240/1285）、branches 88.2% → 89.9%、functions 96.74% → 97.15%、statements 91.63% → 94.11%。

## console（PM 裁示）
納入的是邏輯模組（`.ts`），不納入純 view 元件（`.tsx`）：
- `apps/console/src/api.ts`：API client 的錯誤處理（401/404/429）
- `apps/console/src/roles.ts`：權限與路由閘門
- `apps/console/src/theme/theme.ts`：主題切換邏輯（localStorage＋預設值）

如果邏輯寫在 `.tsx` 元件裡，不要把 view 加進來；請 B 組把邏輯抽成同目錄的 `.ts` 模組，再把那個檔明確加進清單。

## 第 3 階段慣例
黑白名單審核頁的決策邏輯一律放在 `apps/console/src/review/**/*.ts`，會自動納入覆蓋率核心。
同目錄的 `*.tsx` 視為 view，不納入。測試檔（`*.test.*`）照樣排除。

## 變更規則（軟體大總召裁示，2026-11-05）

- **新增**：各組可自行把邏輯 `.ts` 檔加進 `vitest.config.ts` 的 `CORE_COVERAGE_INCLUDE`（例：B 組 `f40fe8a` 加入 `apps/console/src/auth/idleTimer.ts`）。
- **移除檔案或調低門檻（70%）**：只能由整合守門員提交，且須事先取得軟體大總召核准；其他人提交的此類變更視為違規，閘門紀錄會標註並通知 PM。
