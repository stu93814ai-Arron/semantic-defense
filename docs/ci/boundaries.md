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


## sensor-ingest（流量平面，PM 裁示）
`apps/sensor-ingest` 是流量平面程序，部署在 `deploy/sensor/**`，使用自己的連接埠。

| 規則 | 內容 |
|---|---|
| (a) 依賴 | sensor-ingest 不得依賴 control-api 或 console，檢查套件名、相對或原始碼路徑、tsconfig paths 和 package.json 依賴。反過來，control-api 和 console 也不得依賴 sensor-ingest |
| (b) 管理平面設定 | `deploy/management/**`，以及 control-api、console 的設定檔（package.json、*.yaml、*.toml、.env*、Dockerfile、Procfile、vite.config），都不得出現 `sensor-ingest` 或 `deploy/sensor` |
| (c) 部署目錄 | `deploy/sensor/**` 和 `deploy/gateway-adapter/**` 一樣是流量平面部署目錄：不得指涉 control-api 或 console，也不適用 `CONSTRAINTS_PUBLISH_URL` 例外。單一部署檔不得同時指涉 sensor-ingest 和管理平面 |
| (d) 路由 | sensor-ingest 的原始碼不得出現以 `/api` 或 `/login` 開頭的路由字串（依 SI5.1：不提供管理 API 和登入）。這是靜態比對；測試檔和 `test/`、`e2e/` 目錄除外，因為探測用的字串可以出現在測試裡 |

- 即使 `apps/sensor-ingest` 還不存在，以上檢查也會通過。
- 夾具測試在 `scripts/test/boundaries.test.ts`，由 vitest 的 node project 執行，會計入必跑測試和 FLAKY 偵測。
