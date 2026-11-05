# 覆蓋率核心範圍（CORE_COVERAGE_INCLUDE）

門檻：lines／branches／functions／statements 各 ≥70%（v8），定義於 `vitest.config.ts`。

## console（PM 裁示）
納入的是邏輯模組（`.ts`），不納入純 view 元件（`.tsx`）：
- `apps/console/src/api.ts`：API client 的錯誤處理（401/404/429）
- `apps/console/src/roles.ts`：權限與路由閘門
- `apps/console/src/theme/theme.ts`：主題切換邏輯（localStorage＋預設值）

如果邏輯寫在 `.tsx` 元件裡，不要把 view 加進來；請 B 組把邏輯抽成同目錄的 `.ts` 模組，再把那個檔明確加進清單。

## 第 3 階段慣例
黑白名單審核頁的決策邏輯一律放在 `apps/console/src/review/**/*.ts`，會自動納入覆蓋率核心。
同目錄的 `*.tsx` 視為 view，不納入。測試檔（`*.test.*`）照樣排除。
