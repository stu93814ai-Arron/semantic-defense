#!/usr/bin/env bash
# 驗證 .githooks/pre-commit 只驗 index、不碰工作目錄／stash。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
HOOK="$ROOT/.githooks/pre-commit"
[ -x "$HOOK" ] || { echo "缺少可執行的 $HOOK"; exit 1; }

BASE=$(mktemp -d "${TMPDIR:-/tmp}/sd-pci-test-XXXXXX")
cleanup() { rm -rf "$BASE" 2>/dev/null || true; }
trap cleanup EXIT

REPO="$BASE/repo"
mkdir -p "$REPO/.githooks" "$REPO/scripts" "$BASE/bin"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email "pci-test@example.com"
git -C "$REPO" config user.name "pci-test"
git -C "$REPO" config core.hooksPath "$REPO/.githooks"
git -C "$REPO" config commit.gpgsign false

# 假 gitleaks / pnpm
cat > "$BASE/bin/gitleaks" << 'GL'
#!/usr/bin/env bash
exit 0
GL
cat > "$BASE/bin/pnpm" << 'PN'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "run" ]; then
  shift
  [ "${1:-}" = "-s" ] && shift
  script=$1; shift || true
  [ "${1:-}" = "--" ] && shift || true
  root=$(pwd)
  case "$script" in
    typecheck) exec bash "$root/scripts/typecheck.sh" "$@" ;;
    lint) exec bash "$root/scripts/lint.sh" "$@" ;;
    *) echo "unknown script $script" >&2; exit 1 ;;
  esac
fi
echo "pnpm stub: $*" >&2
exit 1
PN
chmod +x "$BASE/bin/gitleaks" "$BASE/bin/pnpm"
export PATH="$BASE/bin:$PATH"

# 從真實 hook 產生測試用 hook：抽掉 gitleaks 下載段，改呼叫 PATH 上的 stub
{
  # shebang + 說明到 checkout-index 與 trap 保留；替換 secrets 段
  awk '
    BEGIN { skip=0 }
    /^VER=8\.21\.2$/ { skip=1; print "# test stub gitleaks"; print "gitleaks version >/dev/null 2>&1 || true"; print "echo \"secrets: OK\""; next }
    skip==1 && /^echo "secrets: OK"$/ { skip=0; next }
    skip==1 { next }
    { print }
  ' "$HOOK"
} > "$REPO/.githooks/pre-commit"
chmod +x "$REPO/.githooks/pre-commit"

# 確認 stub 有進去
grep -q 'test stub gitleaks' "$REPO/.githooks/pre-commit" || { echo "hook patch failed"; cat "$REPO/.githooks/pre-commit"; exit 1; }

cat > "$REPO/package.json" << 'JSON'
{
  "name": "pci-test",
  "private": true,
  "scripts": {
    "typecheck": "bash scripts/typecheck.sh",
    "lint": "bash scripts/lint.sh"
  }
}
JSON
cat > "$REPO/scripts/typecheck.sh" << 'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -f "$ROOT/FAIL.marker" ]; then
  echo "typecheck: FAIL (saw FAIL.marker)" >&2
  exit 1
fi
echo "typecheck: OK"
SH
cat > "$REPO/scripts/lint.sh" << 'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -f "$ROOT/FAIL.marker" ]; then
  echo "lint: FAIL (saw FAIL.marker)" >&2
  exit 1
fi
echo "lint: OK"
true
SH
chmod +x "$REPO/scripts/"*.sh

echo 'ok' > "$REPO/README.md"
mkdir -p "$REPO/packages/shared/src" "$REPO/node_modules"
echo 'export const x = 1' > "$REPO/packages/shared/src/index.ts"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "init green" --no-verify

snapshot() {
  local label=$1
  {
    echo "=== $label ==="
    echo "-- status --"
    git -C "$REPO" status --porcelain=v1
    echo "-- stash --"
    git -C "$REPO" stash list || true
    echo "-- index blob --"
    git -C "$REPO" ls-files -s
    echo "-- wd hash --"
    ( cd "$REPO" && find . -type f ! -path './.git/*' -print0 | sort -z | xargs -0 sha256sum )
  } > "$BASE/snap-$label.txt"
}

run_hook() {
  set +e
  ( cd "$REPO" && bash .githooks/pre-commit ) >"$BASE/hook.out" 2>&1
  ec=$?
  set -e
  echo "$ec"
}

pass=0
fail=0
assert_eq() {
  local name=$1 want=$2 got=$3
  if [ "$want" = "$got" ]; then
    echo "PASS: $name"
    pass=$((pass+1))
  else
    echo "FAIL: $name (want=$want got=$got)"
    echo "---- hook.out ----"; cat "$BASE/hook.out" || true
    fail=$((fail+1))
  fi
}
assert_files_eq() {
  local name=$1 a=$2 b=$3
  # 略過第一行標籤（before/after），比對 status／stash／index／wd
  if tail -n +2 "$a" | cmp -s - <(tail -n +2 "$b"); then
    echo "PASS: $name"
    pass=$((pass+1))
  else
    echo "FAIL: $name"
    diff -u <(tail -n +2 "$a") <(tail -n +2 "$b") || true
    fail=$((fail+1))
  fi
}

# (a) 暫存紅、WD 綠 → 拒絕
echo red > "$REPO/FAIL.marker"
git -C "$REPO" add FAIL.marker
rm -f "$REPO/FAIL.marker"
snapshot before-a
ec_a=$(run_hook)
assert_eq "(a) staged-red WD-green → reject" 1 "$ec_a"
snapshot after-a
assert_files_eq "(a) WD/index/stash unchanged" "$BASE/snap-before-a.txt" "$BASE/snap-after-a.txt"
git -C "$REPO" reset -q HEAD
rm -f "$REPO/FAIL.marker"
git -C "$REPO" checkout -q -- . 2>/dev/null || true
git -C "$REPO" clean -fdq

# (b) 暫存綠、WD 未暫存紅 → 允許
echo 'ok2' > "$REPO/README.md"
git -C "$REPO" add README.md
echo red > "$REPO/FAIL.marker"
snapshot before-b
ec_b=$(run_hook)
assert_eq "(b) staged-green WD-red → allow" 0 "$ec_b"
snapshot after-b
assert_files_eq "(b) WD/index/stash unchanged" "$BASE/snap-before-b.txt" "$BASE/snap-after-b.txt"
rm -f "$REPO/FAIL.marker"
git -C "$REPO" reset -q HEAD
git -C "$REPO" checkout -q -- README.md

# (c) 既有 stash 不變
echo stash-me > "$REPO/STASH.txt"
git -C "$REPO" add STASH.txt
git -C "$REPO" stash push -u -q -m "pci-preexisting"
stash_before=$(git -C "$REPO" stash list)
echo 'ok3' > "$REPO/README.md"
git -C "$REPO" add README.md
snapshot before-c
ec_c=$(run_hook)
assert_eq "(c) hook succeeds with preexisting stash" 0 "$ec_c"
stash_after=$(git -C "$REPO" stash list)
assert_eq "(c) stash list unchanged" "$stash_before" "$stash_after"
snapshot after-c
assert_files_eq "(c) WD/index unchanged" "$BASE/snap-before-c.txt" "$BASE/snap-after-c.txt"
git -C "$REPO" reset -q HEAD
git -C "$REPO" checkout -q -- README.md
git -C "$REPO" stash drop -q || true

# (d) 中途失敗仍還原
echo red > "$REPO/FAIL.marker"
git -C "$REPO" add FAIL.marker
echo keep > "$REPO/UNTRACKED_KEEP.txt"
snapshot before-d
ec_d=$(run_hook)
assert_eq "(d) mid-fail rejects" 1 "$ec_d"
snapshot after-d
assert_files_eq "(d) restore WD/index/stash" "$BASE/snap-before-d.txt" "$BASE/snap-after-d.txt"
[ -f "$REPO/UNTRACKED_KEEP.txt" ] && { echo "PASS: (d) untracked kept"; pass=$((pass+1)); } || { echo "FAIL: (d) untracked lost"; fail=$((fail+1)); }

echo
echo "RESULT: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
