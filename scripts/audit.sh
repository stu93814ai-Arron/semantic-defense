#!/usr/bin/env bash
# 依賴漏洞：全部記錄到 reports/audit.json 與 reports/audit-summary.txt；只有 high/critical 擋
# 第一關：正式環境相依（--prod）沒有任何例外。第二關：完整掃描交給 scripts/audit-allow.mjs。
# 正式例外清單目前是空的。清單中的例外仍必須有到期日和理由；過期、缺到期日或缺理由就失敗。
# 例外的公告 id 若不在這次掃描，只印警告，不讓這一步失敗。
set -euo pipefail
cd "$(dirname "$0")/.."; mkdir -p reports
pnpm audit --prod --audit-level high || { echo "audit: 正式環境相依有 high/critical（無例外）" >&2; exit 1; }
pnpm audit --json > reports/audit.json || true
node scripts/audit-allow.mjs && echo "audit: 無未核准的 high/critical（允許項與非阻擋項見 reports/audit-summary.txt）"
