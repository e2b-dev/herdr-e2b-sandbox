#!/usr/bin/env bash
# Everything that has to be true before `git tag v<version>` is pushed.
#
# The release workflow hard-fails on three of these (tag↔version mismatch, an empty
# CHANGELOG section, a red test run) and only discovers them AFTER spending several
# minutes cross-compiling three dashboard binaries. Checking them here costs seconds
# and means a tag is never pushed into a run that cannot succeed.
#
# Reports every check rather than stopping at the first failure — the whole picture
# is what tells you whether this is one typo or the wrong branch entirely.
#
# usage: release-preflight.sh <version> [--skip-tests]
set -uo pipefail

ver="${1:?usage: release-preflight.sh <version> [--skip-tests]}"
skip_tests=false
[ "${2:-}" = "--skip-tests" ] && skip_tests=true

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$root"

fails=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails+1)); }
note() { printf '       %s\n' "$1"; }

echo "release preflight for v$ver"
echo

branch=$(git branch --show-current)
[ "$branch" = "main" ] && ok "on main" || bad "on '$branch', not main — a release is cut from main"

if [ -z "$(git status --porcelain)" ]; then ok "working tree clean"
else bad "working tree dirty — commit or stash first"; note "$(git status --short | head -5)"; fi

git fetch -q origin main 2>/dev/null || true
local_sha=$(git rev-parse HEAD 2>/dev/null)
remote_sha=$(git rev-parse origin/main 2>/dev/null)
[ "$local_sha" = "$remote_sha" ] \
  && ok "in sync with origin/main" \
  || bad "local main and origin/main differ — pull (or push) before tagging"

pkg=$(node -p "require('$root/package.json').version" 2>/dev/null || echo "?")
man=$(awk -F'"' '/^version[[:space:]]*=/ {print $2; exit}' herdr-plugin.toml 2>/dev/null || echo "?")
if [ "$pkg" = "$ver" ] && [ "$man" = "$ver" ]; then
  ok "package.json and herdr-plugin.toml both read $ver"
else
  bad "version mismatch — package.json=$pkg herdr-plugin.toml=$man wanted=$ver"
  note "CI's version-check job and the release workflow both fail on this"
fi

if grep -q "^## \[$ver\]" CHANGELOG.md; then
  ok "CHANGELOG has a [$ver] section"
  lines=$(bash scripts/changelog-notes.sh "$ver" 2>/dev/null | grep -c . || true)
  [ "${lines:-0}" -gt 0 ] \
    && ok "release notes extract ($lines non-empty lines)" \
    || bad "changelog-notes.sh produced nothing — the workflow errors on an empty section"
else
  bad "no '## [$ver]' section in CHANGELOG.md"
  note "the [Unreleased] heading gets renamed to '## [$ver] - YYYY-MM-DD'"
fi

# An [Unreleased] HEADING is expected and healthy — it is where the next contributor's
# bullet goes, and without one they land it inside a published version's notes. What
# must not survive is unreleased CONTENT: bullets sitting under that heading are items
# this release is about to claim but would not actually list.
if grep -q "^## \[Unreleased\]" CHANGELOG.md; then
  body=$(awk '/^## \[Unreleased\]/{f=1;next} f&&/^## \[/{exit} f&&/^[-*] /{print}' CHANGELOG.md | grep -c . || true)
  [ "${body:-0}" -eq 0 ] \
    && ok "[Unreleased] is present and empty — ready for the next cycle" \
    || bad "[Unreleased] still holds ${body} bullet(s) — they belong under [$ver]"
else
  bad "no [Unreleased] heading — the next contributor's bullet would land inside a published section"
fi

if git rev-parse "v$ver" >/dev/null 2>&1; then
  bad "tag v$ver already exists locally — a tag is not re-pointed, pick the next version"
elif git ls-remote --tags origin "refs/tags/v$ver" 2>/dev/null | grep -q .; then
  bad "tag v$ver already exists on origin"
else
  ok "tag v$ver is free"
fi

if $skip_tests; then
  note "skipped: npm test (--skip-tests)"
elif npm test >/tmp/release-preflight-test.log 2>&1; then
  ok "npm test green"
else
  bad "npm test failed — see /tmp/release-preflight-test.log"
  note "$(tail -3 /tmp/release-preflight-test.log)"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "all clear — safe to: git tag v$ver && git push origin main --tags"
  exit 0
fi
echo "$fails check(s) failed — do not tag yet"
exit 1
