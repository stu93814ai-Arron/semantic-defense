# 2026-11-18 依賴漏洞有期限例外：picomatch GHSA-fc5q-39xc-vjpf（Asia/Taipei）

**軟體大總召裁示（未經使用者確認）**（例外規格由資安審查員提出、總召轉達）：只記一筆有期限的例外，條件寫死在程式裡，不改 `package.json`、`pnpm-lock.yaml`，不用 `pnpm.auditConfig.ignoreGhsas`。

**2026-11-24 已移除（H3b）。** 軟體大總召裁示（未經使用者確認）：同意移除，不續期、也不放著讓它在 2026-12-01 變紅。

移除理由（`curl -s https://api.github.com/advisories/GHSA-fc5q-39xc-vjpf`）：

- summary：`Withdrawn Advisory: picomatch vulnerable to ReDoS through single-branch repeated extglobs`
- withdrawn_at：`2026-11-18T15:38:56Z`
- first_patched_version：`null`（npm latest 仍是 4.0.7，沒有修補版可升）

`scripts/audit-allow.mjs` 的正式例外清單現在是空的。清單是空的就不會因為到期而失敗。high／critical 一律擋下。以後若再新增例外，每一筆必須同時有到期日和理由；缺少任一項，或已到期，就失敗。例外的公告 id 若已不在這次掃描，印出含該 id 的警告「應移除此例外」，不讓 ci 失敗。下面是當初設立這筆例外的紀錄，那些放行條件已經不再生效。再評估見 [2026-11-24-dep-eval-minimatch-picomatch.md](./2026-11-24-dep-eval-minimatch-picomatch.md)。

## 漏洞

- `GHSA-fc5q-39xc-vjpf`（CVE-2026-112366，high，ReDoS：single-branch repeated extglobs）。
- 受影響 `picomatch <=4.0.7`；本 repo 只有 `picomatch@4.0.7` 一個版本。上游目前沒有修補版（`patched_versions` 為 `<0.0.0`）。

## 引入路徑（只在 dev）

三條路徑，都經 `tinyglobby@0.2.17` 或 `fdir@6.5.0` 到 `picomatch@4.0.7`：

1. `typescript-eslint@8.72.1` → `@typescript-eslint/typescript-estree@8.72.1` → `tinyglobby` → `fdir`／`picomatch`（根目錄 devDependencies）。
2. `@semantic-defense/console` 的 `vite@7.3.7`（devDependencies）→ `tinyglobby`／`fdir`／`picomatch`。
3. `vitest@5.1.0` → `@vitest/mocker@5.1.0` → `vite@8.3.6` → `tinyglobby`／`fdir`／`picomatch`（各套件與根目錄的 devDependencies，含 `@vitest/coverage-v8`；vitest 也直接相依 picomatch）。

證據：`pnpm why picomatch --prod -r` 沒有任何輸出；`pnpm audit --prod --audit-level high` 回「No known vulnerabilities found」。不加 `--prod` 的 `pnpm why picomatch -r` 只列出上述 dev 路徑。完整輸出存於 `exec-a-logs/ghsa-picomatch-why.txt`。

## 理由

- picomatch 只出現在 lint、測試、建置工具中，輸入是 repo 內的 glob 設定，不是外部或使用者輸入。正式環境不安裝也不載入它（部署檢查表要求只裝正式相依）。
- 上游沒有修補版可升。不設例外的話，所有分支的 ci 第 6 步都會失敗。

## 作法

1. `scripts/audit.sh` 先跑 `pnpm audit --prod --audit-level high`，**沒有任何例外**，有 high/critical 就失敗。
2. 接著跑完整掃描 `pnpm audit --json`，交給 `scripts/audit-allow.mjs` 判定。high/critical 只有在下列五項**全部**成立時放行：
   - `github_advisory_id` 是 `GHSA-fc5q-39xc-vjpf`；
   - `module_name` 是 `picomatch`；
   - `vulnerable_versions` 恰為 `<=4.0.7`；
   - 每個 finding 的版本都 ≤4.0.7（無法解析的版本不放行）；
   - `patched_versions` 仍表示無修補版（`<0.0.0` 或空字串）。
3. 一出現修補版，例外自動失效。其他任何 high/critical 都失敗。沒有萬用字元，也不改成 `--audit-level critical`。
   - `severity` 先轉小寫；只有 `info`、`low`、`moderate` 可以略過，其他任何值（`HIGH`、`Critical`、`severe`、空字串、缺漏）都視為擋下，除非它正規化後是 high/critical 且符合上面五項。
   - 交叉核對：`metadata.vulnerabilities` 的 high＋critical 必須等於 advisories 中（正規化後）high/critical 的筆數；metadata 缺少或不一致就失敗（例如 advisories 為空、metadata 卻有 high）。advisories 不是物件（含陣列）也失敗。
4. 放行的項目以 `[允許]` 行寫入 `reports/audit-summary.txt`，留下紀錄。
5. 日期與編號寫死，不讀任何環境變數。今天的日期以 Asia/Taipei 計算。測試直接呼叫 `evaluateAudit(scan, today)`，並使用合成 JSON；測試檔是 `scripts/test/audit-allow.test.ts`，由 vitest 的 node project 執行。

## 到期

這段是移除前的行為。例外刪掉之後，空掃描不會再因為 2026-12-01 失敗。

- 到期日：**2026-12-01**（Asia/Taipei）。從當天起（含 12-01），不論漏洞是否還在，`scripts/audit.sh` 一律以固定訊息失敗：「audit: picomatch GHSA-fc5q-39xc-vjpf 例外已於 2026-12-01 到期，請移除例外並升版」。最後有效日是 2026-11-30。
- 到期或上游出修補版就移除例外並升版。
