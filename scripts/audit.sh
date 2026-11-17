#!/usr/bin/env bash
# 依賴漏洞：全部記錄到 reports/audit.json 與 reports/audit-summary.txt；只有 high/critical 擋
# 第一關：正式環境相依（--prod）沒有任何例外。第二關：完整掃描交給 scripts/audit-allow.mjs，
# 只允許其中寫死的單一有期限例外（docs/decisions/2026-11-18-audit-exception-picomatch.md）。
set -euo pipefail
cd "$(dirname "$0")/.."; mkdir -p reports
pnpm audit --prod --audit-level high || { echo "audit: 正式環境相依有 high/critical（無例外）" >&2; exit 1; }
pnpm audit --json > reports/audit.json || true
node scripts/audit-allow.mjs && echo "audit: 無未核准的 high/critical（允許項與非阻擋項見 reports/audit-summary.txt）"
