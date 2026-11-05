# 第 2 階段資安簽核 — apps/console

依據：`PLAN.md` 階段 2、軟體安全「身分與授權」、[平面分離](./SECURITY-CHECKLIST-PLANE-SEPARATION.md)。

## 2026-11-05（Asia/Taipei）— 准予合併

- 對象：`1de5a8d`（UI＋config）、`5f21729`（Vite 開發／E2E control-api 模擬）。
- `sd_session`：HttpOnly／Secure／SameSite=Strict；前端 `document.cookie` 讀不到（e2e 覆蓋）。
- `sd_hint`：非 HttpOnly，僅 UI 啟動提示；授權以 `/api/session/me` 與後端為準（不得當授權依據）。
- 401→`/login`；角色不符→無權限頁（非空白）；登入錯誤統一文案（與 control-api 一致）。
- 模擬僅 `configureServer`（vite dev）；production build 未帶入 mock／假密碼。
- 平面：無 gateway-adapter 依賴；不收應用流量（P3）；P2／P4／P5 本階段以不得偷跑入口查（PASS）。
- Playwright 10／10 綠。
- 結論：**准予合併**。

### 非阻擋殘留
1. R-C1：mock 宜加 `apply: "serve"`／環境守衛，明示非 build／preview。
2. R-C2：正式部署須把 `/api/*` 反代到 control-api，不得用 vite dev／preview 當正式伺服器。
3. R-C3：伺服器 403 宜映到無權限頁（現多靠前端角色閘門）。
4. R-C4：長期可考慮拿掉 `sd_hint`，只等 `/me`。
5. R-C5：登入同步 XHR 為 Playwright 權宜，宜改回 async。

審查員：資安審查員
