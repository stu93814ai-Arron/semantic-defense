# 流量平面／管理平面分離檢查（`pnpm boundaries`）

依據 PLAN.md「入口配接：獨立程序，與控制程序分開部署」。

## 依賴邊界
- `apps/gateway-adapter`：只可依賴 `packages/contracts`、`packages/gate` 與外部 npm 套件。
- `apps/control-api`、`apps/console`：不可依賴 `apps/gateway-adapter`。
- 檢查：原始碼的 `import`／`export ... from`／`require()`／`import()`，以套件名、相對路徑、tsconfig `paths` 別名解析；以及各 app `package.json` 的四種依賴欄位（含 `workspace:`／`file:`／`link:`）。
- app 尚不存在時不檢查，直接通過。

## 部署設定約定（CI 暫定，待 PM 確認）
- 入口：`deploy/gateway-adapter/**`
- 管理平面（control-api、console）：`deploy/management/**`
- `deploy/` 下其他位置 → 紅燈。
- 入口目錄的檔案提到 control-api／console，或管理目錄的檔案提到 gateway-adapter → 紅燈。
- 根目錄與 `apps/**` 的 compose／Dockerfile／`*.k8s.yaml`／Procfile 同時提到兩平面 → 紅燈。
