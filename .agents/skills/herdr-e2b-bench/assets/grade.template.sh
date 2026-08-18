#!/usr/bin/env bash
# HELD-OUT grader for the <task name> bench task (see BENCH.md).
#
# It is held out by never being committed: `e2b-box fleet` branches every member
# off HEAD, so an uncommitted bench/ is in no member's worktree and is never
# uploaded to any box. The grader reaches a box only at grade time, injected as
# the `--grade` command — which is also why it must survive having no file of its
# own to be relative to (see ROOT below).
#
# Offline by construction, in the style of the repo's own test/cli.test.sh:
# isolated HERDR_PLUGIN_STATE_DIR + KEY override, and stubs behind PATH /
# HERDR_E2B_NODE, so nothing here touches E2B or the network.
#
# Usage:  e2b-bench <slug> --grade "$(cat bench/grade.sh)"   grade every member
#         bash bench/grade.sh                               grade this checkout
set -uo pipefail
# Two ways in, so two ways to find the repo. As a FILE it is bench/grade.sh, one
# level down. Injected as a `--grade` string there is no BASH_SOURCE at all, and
# `e2b-box exec` has already put us at the box's projectPath — the repo root.
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  ROOT="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
else
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
E2B="$ROOT/bin/e2b-box"
# ALWAYS through bash, never `"$E2B"` directly. uploadSnapshot writes files with
# sandbox.files.write(), which does not carry the mode bit, so every script arrives
# in a box as 100644 and a direct invocation dies with "Permission denied" — on every
# member at once, which reads as "they all failed" rather than "the grader cannot
# run". `bash -n` and the greps below are unaffected; they only read the file.
e2bbox() { bash "$E2B" "$@"; }
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf '  skip %s\n' "$1"; }

for t in jq git node; do command -v "$t" >/dev/null || { echo "grade: '$t' not on PATH"; exit 1; }; done

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export HERDR_PLUGIN_STATE_DIR="$TMP/state"; mkdir -p "$HERDR_PLUGIN_STATE_DIR/boxes"
unset HERDR_PLUGIN_CONTEXT_JSON 2>/dev/null || true

is_json() { printf '%s' "$1" | jq -e . >/dev/null 2>&1; }

# Can this box run the plugin's Node entrypoints at all? The plugin needs Node >= 22
# (the e2b SDK require()s an ESM-only chalk), and the agent templates ship v20 with no
# version manager on a non-login shell's PATH. Assertions that must cross into
# src/*.js therefore cannot pass HERE no matter what the agent wrote — so they SKIP.
# Failing them instead would dock every member equally for the template's node, and a
# grader that reports an environment limit as an agent's mistake is worse than useless.
NODE22=0
if [ -n "${HERDR_E2B_NODE:-}" ] && "$HERDR_E2B_NODE" -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)' 2>/dev/null; then
  NODE22=1
elif command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)' 2>/dev/null; then
  NODE22=1
fi

echo "── contract: it lints ──"
bash -n "$E2B" 2>/dev/null && ok "bash -n e2b-box" || bad "bash -n e2b-box"

echo "── contract: the change is discoverable ──"
# Anchor to the SHAPE of the line, never a bare word: usage prose already contains
# most English words, and a bare grep hands out points against an untouched repo.
usage=$(e2bbox definitely-not-a-verb 2>&1)
if printf '%s' "$usage" | grep -qE '<^  verb( |$)  or  ^ +--flag( |,|$)>'; then
  HAS_FEATURE=1; ok "usage lists it"
else HAS_FEATURE=0; bad "usage lists it"; fi
grep -qE '^#.*<the thing>' "$E2B" && ok "header comment documents it" || bad "header comment documents it"
grep -q -- '<the thing>' "$ROOT/README.md" 2>/dev/null \
  && ok "README documents it" || bad "README documents it"

# ── regression guards ───────────────────────────────────────────────────────
# Contracts the harness itself depends on. These pass on an untouched repo by
# definition — that is correct, they are guards, not progress markers, and they
# are why the floor is not zero.
echo "── contract: what must not change ──"
# e.g. node src/exec.js '{"key":"absent","cmd":"pwd"}' answers before touching the SDK

# ── gated assertions ────────────────────────────────────────────────────────
# An unknown verb and an unknown flag both exit 2, so anything about "bad usage"
# passes for free unless it is gated on the feature actually existing.
echo "── contract: misuse is refused ──"
if [ "$HAS_FEATURE" -eq 1 ]; then
  : # assert here
else
  skip "misuse is refused (nothing to test yet)"
fi

# ── plumbing block ──────────────────────────────────────────────────────────
# Shadow a dependency and read its argv. A stub that never fires means the agent
# implemented it a different legitimate way, so SKIP — no credit, no penalty.
#   e2b CLI:  put a stub first on PATH
#   node:     point HERDR_E2B_NODE at a stub; it must answer the version probe:
#             [ "${1:-}" = "-e" ] && exit 0
echo "── plumbing ──"

printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
