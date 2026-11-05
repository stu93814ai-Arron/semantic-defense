#!/usr/bin/env bash
# 每個工作區套件：有 typecheck 腳本就跑它（例如 console 的 tsc -b），否則有 tsconfig.json 就 tsc --noEmit
set -euo pipefail
cd "$(dirname "$0")/.."
for d in packages/*/ apps/*/; do
  [ -d "$d" ] || continue
  if node -e 'process.exit(require("./'"$d"'package.json").scripts?.typecheck?0:1)' 2>/dev/null; then
    echo "typecheck: $d（套件腳本）"; (cd "$d" && pnpm run -s typecheck)
  elif [ -f "$d/tsconfig.json" ]; then
    echo "typecheck: $d"; pnpm exec tsc --noEmit -p "$d"
  fi
done
