# 2026-11-24 依賴評估 H3：minimatch GHSA-g3hv-75wg-m249、picomatch 例外

分支 `team-a-harden-h3`，基底 `team-a-harden-h2b`（`73bff8a`）。本評估疊在 #49 上，勿合入。

**軟體大總召裁示（未經使用者確認）**：評估 minimatch `GHSA-g3hv-75wg-m249`（moderate），並在 picomatch 例外到期前做出結論。有不破壞相容的修正版才升級；修正版要破壞性升級或沒有修正版就不升級。例外續期不由本切片決定。

調查時鐘：2026-11-24 17:36 UTC（Asia/Taipei 2026-11-25 01:36）。例外仍在有效期內。

## 調查（升級前，工作樹 `73bff8a`）

`pnpm audit` 原文只列一筆：

```
moderate  minimatch has potential denial of service via globparts amplification
Package   minimatch
Vulnerable versions  >=7.0.0 <11.0.1
Patched versions     >=11.0.1
Paths     .>typescript-eslint>@typescript-eslint/typescript-estree>minimatch
More info https://github.com/advisories/GHSA-g3hv-75wg-m249
1 vulnerabilities found
Severity: 1 moderate
```

`pnpm audit --json` 的 `metadata.vulnerabilities` 是 info 0、low 0、moderate 1、high 0、critical 0。唯一 advisory：`github_advisory_id` `GHSA-g3hv-75wg-m249`，`cves` `CVE-2026-118764`，`module_name` `minimatch`，`vulnerable_versions` `>=7.0.0 <11.0.1`，`patched_versions` `>=11.0.1`，finding 版本 `10.2.6`，路徑同上。沒有 picomatch。

`pnpm audit --prod`：`No known vulnerabilities found`。`--json` 的 high／critical／moderate 都是 0（正式相依 89）。

`pnpm why minimatch --prod -r` 與 `pnpm why picomatch --prod -r` 都沒有輸出。

## minimatch

### 公告與修正版

- GitHub Advisory `GHSA-g3hv-75wg-m249`（CVE-2026-118764），severity medium／npm audit moderate，未撤回。受影響 `>= 7.0.0, < 11.0.1`，first patched `11.0.1`。
- 公告描述的條件：呼叫端能提供 glob pattern，且 `optimizationLevel >= 2` 時，`firstPhasePreProcess` 對 `**/..` 放大 `globParts`，接著二次處理做兩兩比較，造成 CPU／記憶體消耗。
- npm 上 10 線最後一版是 `10.2.6`，沒有 `10.2.7`。修補從 `11.0.1` 起；調查時 latest 是 `11.0.9`。`11.0.0` 移除 `makeRe`、`Minimatch#regexp`、`AST`、`debug` 等，屬 major。
- `11.0.9` 的 engines 是 `node: 20 || >=22`。本 repo CI 固定 Node `22.23.4`。

### 依賴路徑（升級前）

兩條，都是 dev：

1. `minimatch@10.2.6`：`semantic-defense` devDependencies `typescript-eslint@8.72.1` → `@typescript-eslint/typescript-estree@8.72.1`（宣告 `minimatch@^10.2.2`）→ `minimatch@10.2.6`。這是 audit 唯一的 finding。
2. `minimatch@3.1.5`：`eslint@9.39.5`（宣告 `^3.1.5`）、`@eslint/config-array@0.21.2`、`@eslint/eslintrc@3.3.7`。`3.1.5 < 7.0.0`，不在公告範圍，audit 沒有列它。

正式相依（fastify、pg、argon2、nodemailer、zod、react）不拉 minimatch。

### 可觸及性

生產路徑不可觸及。依據：

- `pnpm why minimatch --prod -r` 無輸出；`pnpm audit --prod` 無已知漏洞。部署檢查表要求正式環境 `pnpm install --prod --frozen-lockfile`。
- `apps/`、`packages/` 原始碼沒有 import minimatch、picomatch、tinyglobby、fast-glob。
- 唯一呼叫在 dev 工具 `@typescript-eslint/typescript-estree` 的 `useProgramFromProjectService.js`：`minimatch(filePath, pattern, { dot: true })`。`pattern` 來自 parser 選項 `allowDefaultProject`，不是請求本文。選項只有 `{ dot: true }`，沒有 `optimizationLevel`。已安裝的 `10.2.6` 預設 `optimizationLevel = 1`，`>= 2` 才進入公告描述的放大路徑。
- 本 repo `eslint.config.js` 沒有設定 `allowDefaultProject`。

### 結論

有不破壞相容的修正版，已升級，沒有使用 pnpm overrides。

`typescript-eslint@8.73.0` 起，`@typescript-eslint/typescript-estree` 宣告 `minimatch@^11.0.1`。`8.74.0` 仍是 major 8，peer 仍是 `eslint@^8.57.0 || ^9.0.0 || ^10.0.0` 與 `typescript@>=4.8.4 <6.1.0`，涵蓋本 repo 的 eslint 9.39.5 與 typescript 5.9.3。根目錄原本就是 `typescript-eslint@^8.72.1`，把下限改成 `^8.74.0` 不換 major。`@typescript-eslint/typescript-estree@8.74.0` 的 `@typescript/native`（`npm:typescript@>=7.1.0-dev.20261009.1 || >=7.1.0-beta <7.1.0-dev`）是 optional peer（自 8.73.0 起），沒有安裝，也沒有 install script。

不把全部 `minimatch` override 到 11：那會把 eslint 9 的 `3.1.5` 一併換掉，而且 `8.72.1` 宣告的是 `^10.2.2`，不在它自己的相容範圍裡。

升級後 lock 解析 `minimatch@11.0.9`（另有 dev 傳遞 `@isaacs/nonrecursive-glob-match@1.1.0`），`minimatch@3.1.5` 仍留給 eslint；optional peer `@typescript/native` 沒有安裝，也沒有 install script。`pnpm audit` 與 `pnpm audit --json` 都是 0 筆（metadata 全 0，advisories `{}`）。`pnpm why minimatch --prod -r` 仍無輸出。

沒有既有的 minimatch 例外可刪。

## picomatch 例外

### 原始理由

`docs/decisions/2026-11-18-audit-exception-picomatch.md` 與 `scripts/audit-allow.mjs`（不用 `pnpm.auditConfig.ignoreGhsas`）：

- `GHSA-fc5q-39xc-vjpf`（CVE-2026-112366），當時為 high，single-branch repeated extglobs 的 ReDoS。受影響 `picomatch <=4.0.7`。當時 `patched_versions` 為 `<0.0.0`，沒有修補版。
- 只在 dev：typescript-eslint → tinyglobby／fdir、console 的 vite、vitest／vite。正式環境不安裝。輸入是 repo 內 glob 設定。
- 不設例外則 ci 第 6 步會因 high 失敗。

### 2026-11-30 與 12/01 是同一個政策

以下描述 H3b 移除例外之前的程式。

- `scripts/audit-allow.mjs` 的 `EXC.expires` 是 `2026-12-01`。`expired = !(today < "2026-12-01")`，Asia/Taipei。`2026-11-30` 仍放行，`2026-12-01` 起（含當天）失敗，訊息寫死。
- 放行紀錄寫「有效至 2026-11-30」。決策文件寫到期日 `2026-12-01`、最後有效日 `2026-11-30`。部署檢查表寫「至 2026-11-30」。
- 分支註記的 2026-11-30 是最後有效日；PM 說的 12/01 是開始失敗的那天。不是兩個不同的到期日。

### 現況

- GitHub Advisory 於 `2026-11-18T15:38:56Z` 撤回。summary：`Withdrawn Advisory: picomatch vulnerable to ReDoS through single-branch repeated extglobs`。說明是 not a security issue。`first_patched_version` 是 null。受影響範圍仍標 `<= 4.0.7`。
- npm latest 仍是 `4.0.7`（2026-08-24 發布）。沒有 `4.0.8` 或任何更新的修補版。
- 升級前的 `pnpm audit` 已不再列出這筆。升級後仍是 0 筆。
- `pnpm why picomatch -r` 仍只有 `picomatch@4.0.7`，經 `fdir@6.5.0`／`tinyglobby@0.2.17`：typescript-eslint、`@semantic-defense/console` 的 `vite@7.3.7`、vitest 的 `vite@8.3.6`。全部 devDependencies。`--prod` 無輸出。
- 專案程式沒有把不可信輸入傳進 picomatch。生產路徑不可觸及，依據與當初相同：只存在 lint、測試、Vite 建置，正式安裝不含 devDependencies。

### 結論

沒有修補版，不升級，不加 override。H3 當時不改 `scripts/audit-allow.mjs`；H3b 依後續裁示刪了例外程式，見下方。

殘餘：dev 工具鏈仍帶 `picomatch@4.0.7`。公告已撤回；上游不把它當漏洞，也沒有修補發布。本 repo 沒有把外部輸入當成 glob。正式環境載入不到這個套件。

### 待決（H3 當時）

H3 不續期，也沒有改例外程式。後續裁示見下方 H3b，這項待決已結束。

## H3b：例外已移除

軟體大總召裁示（未經使用者確認）：同意移除，不續期、也不放著讓它變紅。

移除理由與 GitHub API 一致：summary 是 `Withdrawn Advisory: picomatch vulnerable to ReDoS through single-branch repeated extglobs`，`withdrawn_at` 是 `2026-11-18T15:38:56Z`，`first_patched_version` 是 `null`。

`scripts/audit-allow.mjs` 的正式例外清單改為空陣列。清單是空的就不會因為到期而失敗。沒有 finding 的掃描在 2026-12-01（Asia/Taipei，含當天）之後可以通過。任何 high／critical，包括舊的 `GHSA-fc5q-39xc-vjpf`，在任何日期都擋下。新例外必須同時有到期日和理由；缺少任一項，或已到期，就失敗。例外的公告 id 若已不在這次掃描，印出含該 id 的警告並提示「應移除此例外」，不讓 ci 失敗。這些規則用測試注入的假例外證明，那筆不留在正式清單。沒有把 picomatch 升版，因為沒有修補版。

## 依賴提交

`311f2df` 只改 `package.json`、`pnpm-lock.yaml`（85 行新增、70 行刪除）。沒有 pnpm overrides，沒有改程式。

該提交上 `LC_ALL=C bash scripts/ci.sh` exit 0，十步都過：必跑 339 秒（statements 93.04%、branches 88.7%、functions 94.47%、lines 96.88%）；型別 12 秒；Vite 2 秒；eslint 3 秒；jscpd 總重複行 2.84%（793/27885），低於 3%；audit 印出 `No known vulnerabilities found`；gitleaks、邊界、SBOM（410 個元件）都過；E2E 已在必跑裡執行。
