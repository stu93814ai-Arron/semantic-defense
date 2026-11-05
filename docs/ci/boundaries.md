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
- 唯一例外（PM 核准）：`deploy/gateway-adapter/**` 內名為 `CONSTRAINTS_PUBLISH_URL` 的設定鍵（每檔至多一次）可指向控制程序的簽章發布網址，且：
  - 必須是 `https://`；
  - 不得含帳密（`user:pass@`）；
  - 查詢參數名不得為 token／key／secret／sig／signature／auth／authorization／password／access_token／api_key 等（含 `x_api_key` 這類後綴）；
  - 不得含權杖形狀字串（Bearer／Basic、ghp_、glpat-、xox*-、sk-、AKIA…、JWT `eyJ…`、32 字以上的連續 base64／hex）。
  - 其他鍵名或其他行提到 control-api／console 仍為紅燈；此鍵出現在 `deploy/management/**` 也為紅燈。
- 根目錄與 `apps/**` 的 compose／Dockerfile／`*.k8s.yaml`／Procfile 同時提到兩平面 → 紅燈。
