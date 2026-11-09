#!/usr/bin/env bash
# 驗證 .githooks/pre-commit 只驗 index、不碰工作目錄／stash。
# 含：(1) 拋棄式 stub repo 快速案例 (a–d)＋(s) symlink 逃逸＋(v) .vite symlink
#     (2) 真實 monorepo workspace 跨套件案例（實際 pnpm/tsc，不用 stub）
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
HOOK="$ROOT/.githooks/pre-commit"
[ -x "$HOOK" ] || { echo "缺少可執行的 $HOOK"; exit 1; }

pass=0
fail=0
assert_eq() {
  local name=$1 want=$2 got=$3
  if [ "$want" = "$got" ]; then
    echo "PASS: $name"
    pass=$((pass+1))
  else
    echo "FAIL: $name (want=$want got=$got)"
    fail=$((fail+1))
  fi
}
assert_files_eq() {
  local name=$1 a=$2 b=$3
  if tail -n +2 "$a" | cmp -s - <(tail -n +2 "$b"); then
    echo "PASS: $name"
    pass=$((pass+1))
  else
    echo "FAIL: $name"
    diff -u <(tail -n +2 "$a") <(tail -n +2 "$b") || true
    fail=$((fail+1))
  fi
}

BASE=$(mktemp -d "${TMPDIR:-/tmp}/sd-pci-test-XXXXXX")
REAL=""
cleanup_all() {
  if [ -n "${REAL:-}" ] && [ -d "$REAL" ]; then
    git -C "$ROOT" worktree remove --force "$REAL" 2>/dev/null || true
    rm -rf "${REAL:?}" 2>/dev/null || true
  fi
  rm -rf "${BASE:?}" 2>/dev/null || true
}
trap cleanup_all EXIT
trap 'cleanup_all; exit 130' INT
trap 'cleanup_all; exit 143' TERM

# ======================== (1) stub repo ========================
REPO="$BASE/repo"
mkdir -p "$REPO/.githooks" "$REPO/scripts" "$BASE/bin"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email "pci-test@example.com"
git -C "$REPO" config user.name "pci-test"
git -C "$REPO" config core.hooksPath "$REPO/.githooks"
git -C "$REPO" config commit.gpgsign false

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
REAL_PATH="$PATH"
export PATH="$BASE/bin:$PATH"

install_hook_from() {
  # $1 = source hook path → write stub-patched copy to REPO/.githooks/pre-commit
  local src=$1
  {
    awk '
      BEGIN { skip=0 }
      /^VER=8\.21\.2$/ { skip=1; print "# test stub gitleaks"; print "gitleaks version >/dev/null 2>&1 || true"; print "echo \"secrets: OK\""; next }
      skip==1 && /^echo "secrets: OK"$/ { skip=0; next }
      skip==1 { next }
      { print }
    ' "$src"
  } > "$REPO/.githooks/pre-commit"
  chmod +x "$REPO/.githooks/pre-commit"
}

install_hook_from "$HOOK"
grep -q 'test stub gitleaks' "$REPO/.githooks/pre-commit" || { echo "hook patch failed"; exit 1; }
grep -q 'TMP_REAL' "$HOOK" || { echo "真實 hook 缺少 TMP_REAL"; exit 1; }

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

echo "---- stub cases ----"
# (a)
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

# (b)
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

# (c)
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

# (d)
echo red > "$REPO/FAIL.marker"
git -C "$REPO" add FAIL.marker
echo keep > "$REPO/UNTRACKED_KEEP.txt"
snapshot before-d
ec_d=$(run_hook)
assert_eq "(d) mid-fail rejects" 1 "$ec_d"
snapshot after-d
assert_files_eq "(d) restore WD/index/stash" "$BASE/snap-before-d.txt" "$BASE/snap-after-d.txt"
[ -f "$REPO/UNTRACKED_KEEP.txt" ] && { echo "PASS: (d) untracked kept"; pass=$((pass+1)); } || { echo "FAIL: (d) untracked lost"; fail=$((fail+1)); }
git -C "$REPO" reset -q HEAD
rm -f "$REPO/FAIL.marker" "$REPO/UNTRACKED_KEEP.txt"
git -C "$REPO" checkout -q -- . 2>/dev/null || true
git -C "$REPO" clean -fdq

# (s) 暫存區 packages → 樹外；SENTINEL 在 contracts/node_modules/ 以分辨修前修後
echo "---- symlink escape case ----"
setup_symlink_escape() {
  OUTSIDE=$(mktemp -d "${TMPDIR:-/tmp}/sd-pci-outside-XXXXXX")
  mkdir -p "$OUTSIDE/contracts/node_modules"
  echo 'SENTINEL_ALIVE' > "$OUTSIDE/contracts/node_modules/SENTINEL"
  rm -rf "$REPO/packages"
  ln -s "$OUTSIDE" "$REPO/packages"
  git -C "$REPO" add -A
  echo "$OUTSIDE"
}

# (s0) 判準校正：用舊版 c220b0b hook 跑同一套 (s) 判準，預期「不及格」
# （只證明判準能分辨修前行為；不評價現行 hook 好壞——現行由下面 (s)/(s1) 測）
OLD_HOOK_SRC=$(mktemp "$BASE/old-hook-XXXX")
git -C "$ROOT" show c220b0b:.githooks/pre-commit > "$OLD_HOOK_SRC"
OUTSIDE=$(setup_symlink_escape)
install_hook_from "$OLD_HOOK_SRC"
ec_old=$(run_hook)
old_sentinel_ok=0
[ -f "$OUTSIDE/contracts/node_modules/SENTINEL" ] && grep -q 'SENTINEL_ALIVE' "$OUTSIDE/contracts/node_modules/SENTINEL" && old_sentinel_ok=1
old_has_reject=0
grep -q '❌' "$BASE/hook.out" && old_has_reject=1 || true
# 舊版對本案例應「不及格」：SENTINEL 沒了，或沒有 ❌ 拒絕訊息，或兩者
if [ "$old_sentinel_ok" -eq 1 ] && [ "$old_has_reject" -eq 1 ] && [ "$ec_old" -ne 0 ]; then
  echo "FAIL: (s0) 判準校正失敗：舊版不應同時通過 SENTINEL＋❌＋非0（ec=$ec_old sentinel=$old_sentinel_ok reject=$old_has_reject）"
  fail=$((fail+1))
else
  echo "PASS: (s0) 判準校正：舊版 c220b0b 對 (s) 判準不及格（ec=$ec_old sentinel_ok=$old_sentinel_ok has_reject=$old_has_reject）"
  pass=$((pass+1))
fi
rm -rf "${OUTSIDE:?}"
git -C "$REPO" reset -q --hard HEAD 2>/dev/null || true
git -C "$REPO" clean -fdq

# (s1) 新版 hook
OUTSIDE=$(setup_symlink_escape)
install_hook_from "$HOOK"
ec_s=$(run_hook)
if [ "$ec_s" -ne 0 ]; then
  echo "PASS: (s) packages→outside symlink → reject (ec=$ec_s)"
  pass=$((pass+1))
else
  echo "FAIL: (s) expected non-zero, got 0"
  cat "$BASE/hook.out" || true
  fail=$((fail+1))
fi
if grep -q '❌' "$BASE/hook.out" && grep -q '指出暫存樹外\|拒絕' "$BASE/hook.out"; then
  echo "PASS: (s) output contains ❌ reject message"
  pass=$((pass+1))
else
  echo "FAIL: (s) missing ❌ reject message"
  cat "$BASE/hook.out" || true
  fail=$((fail+1))
fi
if [ -f "$OUTSIDE/contracts/node_modules/SENTINEL" ] && grep -q 'SENTINEL_ALIVE' "$OUTSIDE/contracts/node_modules/SENTINEL"; then
  echo "PASS: (s) SENTINEL still present under contracts/node_modules/"
  pass=$((pass+1))
else
  echo "FAIL: (s) SENTINEL missing or overwritten"
  fail=$((fail+1))
fi
rm -rf "${OUTSIDE:?}"
git -C "$REPO" reset -q --hard HEAD 2>/dev/null || true
git -C "$REPO" clean -fdq

# (v) .vite 為指向樹外的 symlink：只刪連結、不拒絕、樹外 SENTINEL 仍在
echo "---- .vite symlink case ----"
install_hook_from "$HOOK"
VITE_OUT=$(mktemp -d "${TMPDIR:-/tmp}/sd-pci-vite-XXXXXX")
echo 'VITE_SENTINEL_ALIVE' > "$VITE_OUT/VITE_SENTINEL"
mkdir -p "$REPO/packages/shared/node_modules"
ln -s "$VITE_OUT" "$REPO/packages/shared/node_modules/.vite"
# 不需 stage .vite（hook 從 WD 的 package nm 複製）
ec_v=$(run_hook)
if [ "$ec_v" -eq 0 ]; then
  echo "PASS: (v) .vite symlink → allow (ec=0)"
  pass=$((pass+1))
else
  echo "FAIL: (v) expected allow, got ec=$ec_v"
  cat "$BASE/hook.out" || true
  fail=$((fail+1))
fi
if [ -f "$VITE_OUT/VITE_SENTINEL" ] && grep -q 'VITE_SENTINEL_ALIVE' "$VITE_OUT/VITE_SENTINEL"; then
  echo "PASS: (v) VITE_SENTINEL still present"
  pass=$((pass+1))
else
  echo "FAIL: (v) VITE_SENTINEL destroyed"
  fail=$((fail+1))
fi
rm -rf "${VITE_OUT:?}"
rm -rf "$REPO/packages/shared/node_modules"
git -C "$REPO" clean -fdq

# ======================== (2) real workspace ========================
echo "---- real workspace cases ----"
export PATH="$REAL_PATH"
hash -r 2>/dev/null || true
command -v pnpm
[ -d "$ROOT/node_modules" ] || { echo "需要 $ROOT/node_modules"; exit 1; }
[ -d "$ROOT/packages/contracts" ] || { echo "需要 packages/contracts"; exit 1; }

REAL=$(mktemp -d "${TMPDIR:-/tmp}/sd-pci-real-XXXXXX")
git worktree add -q --detach "$REAL" HEAD
cp -f "$HOOK" "$REAL/.githooks/pre-commit"
chmod +x "$REAL/.githooks/pre-commit"
ln -s "$ROOT/node_modules" "$REAL/node_modules"
for d in "$ROOT"/packages/*/node_modules "$ROOT"/apps/*/node_modules; do
  [ -e "$d" ] || continue
  rel=${d#"$ROOT"/}
  mkdir -p "$REAL/$(dirname "$rel")"
  rm -rf "${REAL:?}/$rel"
  cp -a "$d" "$REAL/$rel"
done
resolved=$(realpath "$REAL/apps/console/node_modules/@semantic-defense/contracts")
case "$resolved" in
  "$REAL"/packages/contracts*) echo "PASS: (real) package nm 相對連結指向 REAL/packages"; pass=$((pass+1)) ;;
  *) echo "FAIL: (real) contracts 連結指到 $resolved"; fail=$((fail+1)) ;;
esac

ADMIN_SRC="$REAL/packages/contracts/src/admin-api.ts"
[ -f "$ADMIN_SRC" ] || { echo "缺少 $ADMIN_SRC"; exit 1; }

snap_real() {
  local label=$1
  {
    echo "=== $label ==="
    echo "-- status --"
    git -C "$REAL" status --porcelain=v1
    echo "-- stash --"
    git -C "$REAL" stash list || true
    echo "-- index --"
    git -C "$REAL" ls-files -s
    echo "-- admin-api.ts wd --"
    sha256sum "$ADMIN_SRC"
    echo "-- admin-api.ts index --"
    git -C "$REAL" show ":packages/contracts/src/admin-api.ts" | sha256sum
  } > "$BASE/rsnap-$label.txt"
}

run_real_hook() {
  set +e
  ( cd "$REAL" && bash .githooks/pre-commit ) >"$BASE/real-hook.out" 2>&1
  ec=$?
  set -e
  echo "$ec"
}

sed -i 's/export const ADMIN_API_PATHS/export const ADMIN_API_PATHS_RENAMED_FOR_PCI_TEST/' "$ADMIN_SRC"
sed -i 's/ADMIN_API_PATHS/ADMIN_API_PATHS_RENAMED_FOR_PCI_TEST/g' "$REAL/packages/contracts/test/admin-api.test.ts"
git -C "$REAL" add -- packages/contracts/src/admin-api.ts packages/contracts/test/admin-api.test.ts
git -C "$REAL" diff --cached --name-only | grep -q 'packages/contracts' || { echo "FAIL: r1 nothing staged"; fail=$((fail+1)); }
if git -C "$REAL" diff --cached --name-only | grep -E '^apps/'; then
  echo "FAIL: r1 apps staged"; fail=$((fail+1))
fi
snap_real before-r1
ec_r1=$(run_real_hook)
if [ "$ec_r1" -ne 0 ]; then
  echo "PASS: (r1) staged contracts rename, consumers stale → reject (ec=$ec_r1)"
  pass=$((pass+1))
else
  echo "FAIL: (r1) staged contracts rename, consumers stale → reject (want≠0 got=0)"
  fail=$((fail+1))
fi
if [ "$ec_r1" -ne 0 ]; then
  grep -E 'error TS|ADMIN_API_PATHS|typecheck' "$BASE/real-hook.out" | head -20 || true
fi
snap_real after-r1
assert_files_eq "(r1) WD/index/stash unchanged" "$BASE/rsnap-before-r1.txt" "$BASE/rsnap-after-r1.txt"

git -C "$REAL" reset -q --hard HEAD
git -C "$REAL" clean -fdq
cp -f "$HOOK" "$REAL/.githooks/pre-commit"
chmod +x "$REAL/.githooks/pre-commit"
if [ ! -e "$REAL/node_modules" ]; then
  ln -s "$ROOT/node_modules" "$REAL/node_modules"
fi
for d in "$ROOT"/packages/*/node_modules "$ROOT"/apps/*/node_modules; do
  [ -e "$d" ] || continue
  rel=${d#"$ROOT"/}
  if [ ! -e "$REAL/$rel" ]; then
    mkdir -p "$REAL/$(dirname "$rel")"
    cp -a "$d" "$REAL/$rel"
  fi
done

sed -i 's/export const ADMIN_API_PATHS/export const ADMIN_API_PATHS_WD_ONLY_BROKEN/' "$ADMIN_SRC"
git -C "$REAL" diff --name-only | grep -q 'admin-api.ts'
if git -C "$REAL" diff --cached --name-only | grep -q 'admin-api.ts'; then
  echo "FAIL: r2 unexpectedly staged"; fail=$((fail+1))
fi
snap_real before-r2
ec_r2=$(run_real_hook)
assert_eq "(r2) staged green, WD contracts red → allow" 0 "$ec_r2"
if [ "$ec_r2" -ne 0 ]; then
  echo "---- real-hook.out ----"; tail -40 "$BASE/real-hook.out"
fi
snap_real after-r2
assert_files_eq "(r2) WD/index/stash unchanged" "$BASE/rsnap-before-r2.txt" "$BASE/rsnap-after-r2.txt"
grep -q 'ADMIN_API_PATHS_WD_ONLY_BROKEN' "$ADMIN_SRC" && { echo "PASS: (r2) WD still broken"; pass=$((pass+1)); } || { echo "FAIL: (r2) WD restored unexpectedly"; fail=$((fail+1)); }

echo
echo "RESULT: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
