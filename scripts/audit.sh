#!/usr/bin/env bash
# 依賴漏洞：全部記錄到 reports/audit.json 與 reports/audit-summary.txt；只有 high/critical 擋
set -uo pipefail
cd "$(dirname "$0")/.."; mkdir -p reports
pnpm audit --json > reports/audit.json || true
node -e '
const a=JSON.parse(require("fs").readFileSync("reports/audit.json"));
const L=Object.values(a.advisories||{}).map(v=>`${v.severity}\t${v.module_name}\t${v.github_advisory_id}\t${v.vulnerable_versions} → 修補 ${v.patched_versions}\t${v.title}\t${[...new Set(v.findings.flatMap(f=>f.paths))].join(" ")}`);
require("fs").writeFileSync("reports/audit-summary.txt",(L.join("\n")||"無已知漏洞")+"\n");
console.log(L.join("\n")||"無已知漏洞");'
pnpm audit --audit-level high >/dev/null && echo "audit: 無 high/critical（非阻擋項見 reports/audit-summary.txt）"
