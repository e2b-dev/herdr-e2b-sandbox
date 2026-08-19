#!/usr/bin/env bash
# Offline tests for the e2b-box CLI: lint + exit-code/behavior assertions that
# don't touch E2B (they exercise the paths that return BEFORE any SDK call).
# Run via `npm test` or directly. Requires bash, jq, git, and node >= 22 on PATH.
set -uo pipefail
ROOT="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2B="$ROOT/bin/e2b-box"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
# A skip is not a pass and must never be a failure: the pty coverage below needs
# a real python3, and on a factory-fresh Mac /usr/bin/python3 is a Command Line
# Tools stub. Reporting it as red would train people to ignore this suite.
skip() { SKIP=$((SKIP+1)); printf '  skip %s\n' "$1"; }

for t in jq git node; do command -v "$t" >/dev/null || { echo "cli.test: '$t' not on PATH"; exit 1; }; done

echo "── lint: bash -n ──"
for f in "$ROOT"/bin/e2b-box "$ROOT"/bin/e2b-box-open "$ROOT"/bin/e2b-fleet "$ROOT"/bin/e2b-fleet-open \
         "$ROOT"/bin/e2b-dash "$ROOT"/bin/e2b-dash-toggle "$ROOT"/bin/e2b-bench \
         "$ROOT"/bin/e2b-domain "$ROOT"/bin/teardown-worktree "$ROOT"/bin/lib/*.sh "$ROOT"/install.sh; do
  if bash -n "$f" 2>/dev/null; then ok "bash -n $(basename "$f")"; else bad "bash -n $(basename "$f")"; fi
done
echo "── lint: node --check ──"
for f in "$ROOT"/src/*.js; do
  if node --check "$f" 2>/dev/null; then ok "node --check $(basename "$f")"; else bad "node --check $(basename "$f")"; fi
done

echo "── repo: package-lock.json is the only lockfile ──"
# A bun lockfile is a second source of dependency truth: `bun install` can
# resolve versions `npm ci` never would, so "works here" stops implying
# "works there". install.sh and both workflows run `npm ci`.
tracked_bun="$(git -C "$ROOT" ls-files -- '*bun.lock' '*bun.lockb')"
[ -z "$tracked_bun" ] \
  && ok "no bun lockfile is tracked" || bad "bun lockfile tracked: $(printf '%s' "$tracked_bun" | tr '\n' ' ')"
if git -C "$ROOT" check-ignore -q bun.lock && git -C "$ROOT" check-ignore -q bun.lockb; then
  ok "bun lockfiles are gitignored"
else
  bad "bun lockfiles not gitignored — a 'git add -A' could stage one"
fi

# Isolated state dir so we never see or touch real box records.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export HERDR_PLUGIN_STATE_DIR="$TMP/state"; mkdir -p "$HERDR_PLUGIN_STATE_DIR/boxes"
unset HERDR_PLUGIN_CONTEXT_JSON 2>/dev/null || true

echo "── behavior: no tracked box ──"
out=$(KEY=nobox "$E2B" url 2>&1); rc=$?
{ [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "no sandbox tracked"; } \
  && ok "url with no box → message + exit 1" || bad "url with no box (rc=$rc, out=$out)"

out=$(KEY=nobox "$E2B" status 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "no sandbox tracked"; } \
  && ok "status with no box → message + exit 0" || bad "status with no box (rc=$rc)"

for v in pause resume; do
  out=$(KEY=nobox "$E2B" "$v" 2>&1); rc=$?
  { [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "nothing to $v"; } \
    && ok "$v with no box → message + exit 1" || bad "$v with no box (rc=$rc, out=$out)"
done

out=$(KEY=nobox "$E2B" open --template 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "needs a template name"; } \
  && ok "open --template with no value → exit 2" || bad "open --template with no value (rc=$rc, out=$out)"

out=$("$E2B" list 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "no sandboxes"; } \
  && ok "list empty → 'no sandboxes'" || bad "list empty (rc=$rc)"

# Asking a command what it does must never provision anything. This is the one
# property in the suite worth proving mechanically rather than by reading the
# dispatch: the failure mode it guards against is a BILLABLE box, and it came
# back once already — `open --help` used to fall through to `open` because the
# help arm only ever looked at $1.
echo "── behavior: help is free (never boots a box) ──"
for form in "--help" "-h" "help"; do
  out=$("$E2B" $form 2>/dev/null); rc=$?
  { [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "^e2b-box —"; } \
    && ok "$form → usage on stdout, exit 0" || bad "$form (rc=$rc)"
done

before=$(ls -1 "$HERDR_PLUGIN_STATE_DIR/boxes" | wc -l | tr -d ' ')
for v in open up pull sync exec status list wait doctor auth; do
  out=$("$E2B" "$v" --help 2>/dev/null); rc=$?
  { [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "^e2b-box —"; } \
    && ok "$v --help → usage, exit 0" || bad "$v --help (rc=$rc)"
done
after=$(ls -1 "$HERDR_PLUGIN_STATE_DIR/boxes" | wc -l | tr -d ' ')
[ "$before" = "$after" ] \
  && ok "no --help path wrote a box record ($after records, unchanged)" \
  || bad "a --help path created state ($before → $after)"

# A flag before the verb must not be able to hide the question — this regressed
# once, when the leading-flag lift ran ahead of the help check and `-t x --help`
# came out as "unknown command --help".
out=$("$E2B" -t claude --help 2>/dev/null); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "^e2b-box —"; } \
  && ok "leading flags don't swallow --help" || bad "-t claude --help (rc=$rc)"

out=$("$E2B" --version 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qE '^herdr-e2b [0-9]+\.[0-9]+'; } \
  && ok "--version → 'herdr-e2b <semver>', exit 0" || bad "--version (rc=$rc, out=$out)"

echo "── behavior: the verbs people arrive already knowing ──"
out=$("$E2B" ls 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "no sandboxes"; } \
  && ok "ls → list" || bad "ls → list (rc=$rc, out=$out)"
out=$(KEY=nobox "$E2B" rm 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "cleared 'nobox'"; } \
  && ok "rm → kill" || bad "rm → kill (rc=$rc, out=$out)"
for pair in "unpause:nothing to resume" "attach:"; do
  v=${pair%%:*}
  out=$(KEY=nobox "$E2B" "$v" 2>&1)
  printf '%s' "$out" | grep -q "unknown command" \
    && bad "$v is not aliased (out=$out)" || ok "$v is a known verb"
done

# `stop` and `start` are deliberately NOT aliases — agentbox's `stop` preserves
# disk without freezing, a state we don't have, so guessing would do a different
# thing than the word promises. They must be answered, not silently obeyed.
for pair in "stop:pause" "start:resume"; do
  v=${pair%%:*}; want=${pair##*:}
  out=$("$E2B" "$v" 2>&1); rc=$?
  { [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "did you mean '$want'"; } \
    && ok "$v → named, not aliased: suggests '$want'" || bad "$v hint (rc=$rc)"
done
out=$("$E2B" stat 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "did you mean 'status'"; } \
  && ok "a typo gets a suggestion (stat → status)" || bad "typo suggestion (rc=$rc)"

echo "── behavior: --box addresses another box from anywhere ──"
printf '{"key":"other","label":"other","worktreePath":"%s","status":"ready"}\n' "$TMP" \
  > "$HERDR_PLUGIN_STATE_DIR/boxes/other.json"
for order in "--box other status" "status --box other"; do
  # shellcheck disable=SC2086
  out=$("$E2B" $order --json 2>/dev/null); rc=$?
  { [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e '.key == "other"' >/dev/null; } \
    && ok "e2b-box $order --json" || bad "e2b-box $order (rc=$rc, out=$out)"
done
out=$("$E2B" --box ghost pull 2>&1); rc=$?
{ [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "no box 'ghost'"; } \
  && ok "--box with an unknown key refuses before touching the tree" \
  || bad "--box ghost pull (rc=$rc, out=$out)"
rm -f "$HERDR_PLUGIN_STATE_DIR/boxes/other.json"

echo "── behavior: --json is a contract, including when empty ──"
out=$("$E2B" list --json 2>/dev/null); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e 'type == "array" and length == 0' >/dev/null; } \
  && ok "list --json with nothing tracked → [] (not silence)" || bad "list --json empty (rc=$rc, out=$out)"
out=$(KEY=nobox "$E2B" status --json 2>/dev/null); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e '.tracked == false and .key == "nobox"' >/dev/null; } \
  && ok "status --json for an untracked box is still JSON" || bad "status --json untracked (rc=$rc, out=$out)"

# A miss is where someone is most lost, so it has to point somewhere. With other
# boxes on disk, the message must name both the way to see them and the way to
# act on one.
printf '{"key":"other","label":"other","worktreePath":"%s"}\n' "$TMP" \
  > "$HERDR_PLUGIN_STATE_DIR/boxes/other.json"
out=$(KEY=nobox "$E2B" url 2>&1); rc=$?
{ [ "$rc" -eq 1 ] \
  && printf '%s' "$out" | grep -q "e2b-box list" \
  && printf '%s' "$out" | grep -q -- "--box"; } \
  && ok "a miss names 'e2b-box list' and --box" || bad "miss cross-reference (rc=$rc, out=$out)"
rm -f "$HERDR_PLUGIN_STATE_DIR/boxes/other.json"

out=$(KEY=nobox "$E2B" wait 2>&1); rc=$?
{ [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "nothing to wait for"; } \
  && ok "wait with no box → exit 1, not a 20-minute hang" || bad "wait untracked (rc=$rc, out=$out)"
out=$(KEY=nobox "$E2B" wait --timeout-ms 0 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "positive integer"; } \
  && ok "wait --timeout-ms 0 → exit 2" || bad "wait --timeout-ms 0 (rc=$rc, out=$out)"

# A paused box is a SETTLED state, not an unknown one worth spinning on: with
# auto-pause the default, a box pausing mid-boot is reachable, and it used to
# leave the user watching the spinner to the twenty-minute cap.
printf '{"key":"pausedbox","label":"pausedbox","status":"paused","sandboxId":"sbx_p1"}\n' \
  > "$HERDR_PLUGIN_STATE_DIR/boxes/pausedbox.json"
out=$(KEY=pausedbox "$E2B" wait --timeout-ms 3000 2>&1); rc=$?
{ [ "$rc" -eq 1 ] \
  && printf '%s' "$out" | grep -qi "paused" \
  && ! printf '%s' "$out" | grep -q "timed out"; } \
  && ok "wait on a paused box → says paused immediately, doesn't spin to the cap" \
  || bad "wait on paused box (rc=$rc, out=$out)"
# ...and the machine-readable shape says the same thing: "timeout" must not
# swallow a settled state a scripted caller would branch on.
out=$(KEY=pausedbox "$E2B" wait --timeout-ms 3000 --json 2>/dev/null); rc=$?
{ [ "$rc" -eq 1 ] && printf '%s' "$out" | jq -e '.ok == false and .status == "paused"' >/dev/null; } \
  && ok "wait --json on a paused box → status \"paused\", not \"timeout\"" \
  || bad "wait --json on paused box (rc=$rc, out=$out)"
rm -f "$HERDR_PLUGIN_STATE_DIR/boxes/pausedbox.json"

out=$("$E2B" doctor 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "state dir"; } \
  && ok "doctor reports and exits 0 even with warnings" || bad "doctor (rc=$rc)"

# `auth` reports which local harnesses a box could borrow a credential from, then
# asks ONCE before writing what it found. What is installed on the machine running
# this suite is not a fixture, so the assertions are about SHAPE — a row per known
# harness, and what does or does not reach disk. The parse rules themselves are
# unit-tested in test/harnesses.test.js and the plan in test/harness-auth.test.js,
# where no harness needs to be installed at all.
#
# Every invocation here redirects stdin from /dev/null on purpose. `auth` prompts
# on a terminal, and a developer running this suite from one would otherwise sit at
# a question nobody is there to answer. The prompt itself is covered further down,
# through a real pty, which is the only honest way to cover it.
echo "── behavior: auth reports harnesses, and asks before writing ──"
out=$("$E2B" auth </dev/null 2>&1); rc=$?
# The expected rows come from the table itself, not from a list copied into this
# file — a copy would go stale the moment an eighth harness lands, and go stale
# silently, which is the failure a shell suite is worst at noticing.
known=$(node -e 'import(process.argv[1]).then(m=>console.log(Object.keys(m.HARNESSES).join(" ")))' "$ROOT/src/harnesses.js")
missing=""; n=0
for h in $known; do
  n=$((n + 1))
  printf '%s' "$out" | grep -q "^\[.*\] *$h " || missing="$missing $h"
done
{ [ "$rc" -eq 0 ] && [ -z "$missing" ] && [ "$n" -gt 0 ]; } \
  && ok "auth prints a row per known harness, exit 0" || bad "auth (rc=$rc, missing:$missing, out=$out)"
# Whatever this machine has, no row may be silently dropped and none invented.
printf '%s' "$out" | grep -q "of $n harnesses" \
  && ok "auth counts every harness in the table" || bad "auth harness count (want $n, out=$out)"
printf '%s' "$out" | grep -q "nothing was written" \
  && ok "auth says it wrote nothing" || bad "auth omitted the nothing-was-written promise"

# Consent inferred from a pipe is not consent: with no terminal and no --yes, the
# command reports and stops. This is also what keeps the installer honest — ticket
# 07 passes the flag deliberately rather than getting a write by accident.
cfgdir="$TMP/config"; mkdir -p "$cfgdir"
cfg_before=$(ls -1A "$cfgdir" | wc -l | tr -d ' ')
HERDR_PLUGIN_CONFIG_DIR="$cfgdir" "$E2B" auth </dev/null >/dev/null 2>&1
cfg_after=$(ls -1A "$cfgdir" | wc -l | tr -d ' ')
[ "$cfg_before" = "$cfg_after" ] \
  && ok "auth with no tty and no --yes writes nothing" || bad "auth created config state ($cfg_before → $cfg_after)"

# A key in the environment is borrowable and must be reported as such — and the
# report must never contain the value, only the variable's name.
out=$(ANTHROPIC_API_KEY=sk-ant-test-not-real "$E2B" auth </dev/null 2>&1)
# Two truthful phrasings, because the row depends on whether the HARNESS is here:
# "key found (env)" when it is, and "not installed here, but ... is set" when it is
# not. CI has no claude, so asserting only the first tested the developer's laptop
# rather than the behaviour. What must hold either way is that the credential is
# seen and reported as usable.
printf '%s' "$out" | grep -qE "key found|a box can still use it" \
  && ok "auth sees a credential in the environment" || bad "auth missed an env credential (out=$out)"
printf '%s' "$out" | grep -q "sk-ant-test-not-real" \
  && bad "auth PRINTED A SECRET VALUE" || ok "auth never prints a credential's value"

# --yes is the installer's door: no question, and the file lands.
ydir="$TMP/auth-yes"; mkdir -p "$ydir"
out=$(ANTHROPIC_API_KEY=sk-ant-test-not-real HERDR_PLUGIN_CONFIG_DIR="$ydir" "$E2B" auth --yes </dev/null 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && [ -f "$ydir/auth.toml" ]; } \
  && ok "auth --yes writes the generated file without asking" || bad "auth --yes (rc=$rc, out=$out)"
[ ! -e "$ydir/config.toml" ] \
  && ok "auth never writes the user's own config.toml" || bad "auth touched config.toml"
mode=$(ls -l "$ydir/auth.toml" | cut -c1-10)
[ "$mode" = "-rw-------" ] \
  && ok "the generated file is written at restrictive permissions" || bad "auth.toml mode is $mode, want -rw-------"
grep -qi "GENERATED by .e2b-box auth" "$ydir/auth.toml" && grep -qi "do not edit" "$ydir/auth.toml" \
  && ok "the generated file says it is generated and must not be hand-edited" \
  || bad "auth.toml header (got: $(head -1 "$ydir/auth.toml"))"
# The value of a variable found in the ENVIRONMENT is never written down — only its
# name. This is ADR 0006's rule, and it is the one that has to hold on a real
# machine and not only in a unit test.
grep -q "sk-ant-test-not-real" "$ydir/auth.toml" \
  && bad "auth.toml STORED A SECRET FROM THE ENVIRONMENT" \
  || ok "an env-sourced credential is recorded by name, never by value"
grep -q '^ANTHROPIC_API_KEY = "ANTHROPIC_API_KEY"$' "$ydir/auth.toml" \
  && ok "an env-sourced credential records the variable name to forward" \
  || bad "auth.toml missed the forwarded name ($(cat "$ydir/auth.toml"))"

# The other half of ADR 0006's rule, and the half a stub cannot prove: a value
# sitting in a harness's own plaintext file IS copied, because copying it makes no
# new kind of exposure. Driven against the real binary with a fabricated HOME, so
# nothing here reads the developer's own ~/.codex. Skipped when codex is not
# installed — what this machine has is not a fixture.
if command -v codex >/dev/null 2>&1; then
  fh="$TMP/file-home"; mkdir -p "$fh/.codex" "$fh/cfg"
  printf '{"OPENAI_API_KEY":"sk-fake-file-value","auth_mode":"apikey"}' > "$fh/.codex/auth.json"
  env -u OPENAI_API_KEY -u CODEX_API_KEY HOME="$fh" HERDR_PLUGIN_CONFIG_DIR="$fh/cfg" \
    "$E2B" auth --yes </dev/null >/dev/null 2>&1
  grep -q '^OPENAI_API_KEY = "sk-fake-file-value"$' "$fh/cfg/auth.toml" \
    && ok "a credential found in a harness's own file is stored as a value" \
    || bad "file-sourced value not stored (got: $(cat "$fh/cfg/auth.toml" 2>/dev/null))"
else
  skip "file-sourced value stored as a value (codex not installed here)"
fi
# Re-running regenerates rather than appends. Counted rather than compared
# byte-for-byte: what must not happen is a row arriving twice, and a probe that
# answers differently between two runs is a real thing this suite should not turn
# into a red build.
ANTHROPIC_API_KEY=sk-ant-test-not-real HERDR_PLUGIN_CONFIG_DIR="$ydir" "$E2B" auth -y </dev/null >/dev/null 2>&1
dupes=$(grep -c '^\[templates\.claude\.forward\]$' "$ydir/auth.toml")
[ "$dupes" = "1" ] \
  && ok "re-running regenerates the file rather than appending to it" || bad "auth.toml has $dupes claude sections after two runs"
# A discovery that finds one fewer thing must LOSE the row, not keep it around.
env -u ANTHROPIC_API_KEY HERDR_PLUGIN_CONFIG_DIR="$ydir" "$E2B" auth -y </dev/null >/dev/null 2>&1
grep -q "ANTHROPIC_API_KEY" "$ydir/auth.toml" \
  && bad "a stale row survived a regeneration" || ok "a regeneration drops what is no longer found"

out=$("$E2B" auth --nope </dev/null 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "unknown option"; } \
  && ok "auth rejects a flag it does not know → exit 2" || bad "auth --nope (rc=$rc, out=$out)"

# What the `open` picker draws beside each template. Asserted here rather than in a
# unit test because the two halves have to agree across a process boundary: the node
# side emits `<template>\t<mark>` and bash cuts the columns apart. Driven with a
# fabricated config dir, so what this machine actually has installed cannot decide
# whether the suite is green.
echo "── behavior: the template picker annotates what auth discovered ──"
TAB=$(printf '\t')
pdir="$TMP/pick-auth"; ndir="$TMP/pick-noauth"; mkdir -p "$pdir" "$ndir"
# The menu is pinned by a fixture rather than left to the shipped defaults, so an
# eighth public template later cannot turn this block red for the wrong reason.
for d in "$pdir" "$ndir"; do
  printf '[sandbox]\ntemplate = "base"\ntemplates = ["claude", "codex", "amp", "base"]\n' > "$d/config.toml"
done
cat > "$pdir/auth.toml" <<'TOML'
[templates.codex.env]
OPENAI_API_KEY = "sk-from-a-file"
[templates.claude.forward]
ANTHROPIC_API_KEY = "ANTHROPIC_API_KEY"
TOML
menu=$(HERDR_PLUGIN_CONFIG_DIR="$pdir" node "$ROOT/src/resolve-template.js" "" 2>&1 | tail -n +2)
printf '%s\n' "$menu" | grep -q "^claude${TAB}key (env)$" \
  && ok "a forwarded credential is annotated with its source" || bad "claude annotation (menu=$menu)"
printf '%s\n' "$menu" | grep -q "^codex${TAB}key (file)$" \
  && ok "a stored credential is annotated with its source" || bad "codex annotation (menu=$menu)"
# The whole point of annotating rather than filtering: a template the plugin cannot
# authenticate is still on the menu, and it is not moved out of the way either.
printf '%s\n' "$menu" | grep -q "^amp${TAB}$" \
  && ok "an unauthenticated template is still offered, with no annotation" || bad "amp row (menu=$menu)"
want=$(HERDR_PLUGIN_CONFIG_DIR="$ndir" node "$ROOT/src/resolve-template.js" "" | tail -n +2 | cut -f1)
[ "$(printf '%s\n' "$menu" | cut -f1)" = "$want" ] \
  && ok "the menu is neither filtered nor reordered by what was discovered" \
  || bad "the annotation changed the menu itself (with=$(printf '%s' "$menu" | cut -f1 | tr '\n' ' '), without=$(printf '%s' "$want" | tr '\n' ' '))"
# The picker reads the generated file and nothing else — no probe is spawned on the
# create path, which is the constraint `auth` being a separate subcommand exists for.
[ "$(printf '%s\n' "$menu" | grep -c "key (")" = "2" ] \
  && ok "only what the generated file holds is annotated" || bad "extra annotations (menu=$menu)"
# The mark names a SOURCE, never a secret: the picker draws on a shared pane and its
# frame ends up in a scrollback the box's shell then takes over.
printf '%s\n' "$menu" | grep -q "sk-from-a-file" \
  && bad "the picker PRINTED A CREDENTIAL VALUE" || ok "the picker names a source, never a value"
# No generated file at all is the state every machine starts in: every template is
# still offered, and nothing carries a mark.
nmenu=$(HERDR_PLUGIN_CONFIG_DIR="$ndir" node "$ROOT/src/resolve-template.js" "" 2>&1); nrc=$?
{ [ "$nrc" -eq 0 ] && [ -n "$(printf '%s\n' "$nmenu" | tail -n +2)" ] \
  && ! printf '%s\n' "$nmenu" | grep -q "key ("; } \
  && ok "no generated file → the full menu, no annotations, exit 0" \
  || bad "picker with no auth.toml (rc=$nrc, out=$nmenu)"
# Writer and reader, end to end and through the real file. `e2b-box auth` decides
# which sub-table a finding lands in and the picker infers the source back out of
# it; nothing else pins those two to each other, so a rename on either side would
# otherwise make the mark quietly lie rather than fail.
edir="$TMP/pick-e2e"; mkdir -p "$edir"
printf '[sandbox]\ntemplate = "base"\ntemplates = ["claude", "base"]\n' > "$edir/config.toml"
ANTHROPIC_API_KEY=sk-ant-test-not-real HERDR_PLUGIN_CONFIG_DIR="$edir" "$E2B" auth --yes </dev/null >/dev/null 2>&1
emenu=$(HERDR_PLUGIN_CONFIG_DIR="$edir" node "$ROOT/src/resolve-template.js" "" 2>&1 | tail -n +2)
printf '%s\n' "$emenu" | grep -q "^claude${TAB}key (env)$" \
  && ok "what auth wrote is what the picker marks, through the real file" \
  || bad "auth → picker round trip (menu=$emenu, file=$(cat "$edir/auth.toml" 2>/dev/null))"

# `connect` takes the sandbox id `list` prints, because that is the id the CLI
# underneath takes. An id we don't track is still attachable, but the cluster is
# then a guess — and a wrong cluster looks exactly like a deleted sandbox, so it
# has to be said out loud rather than reported as "not found".
echo "── behavior: connect names a sandbox by its id ──"
out=$("$E2B" connect a b 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "one sandbox at a time"; } \
  && ok "connect takes one id" || bad "connect two ids (rc=$rc, out=$out)"
out=$("$E2B" connect i0000nope 2>&1); rc=$?
{ [ "$rc" -eq 1 ] \
  && printf '%s' "$out" | grep -q "isn't a box this plugin tracks" \
  && printf '%s' "$out" | grep -q "E2B_DOMAIN="; } \
  && ok "connect to an untracked id names the cluster caveat" \
  || bad "connect untracked (rc=$rc, out=$out)"
for v in shell attach; do
  out=$(KEY=nobox "$E2B" "$v" 2>&1)
  printf '%s' "$out" | grep -q "unknown command" \
    && bad "$v no longer reaches connect" || ok "$v still attaches"
done

# The other three binaries answer the same two questions the same way. e2b-dash
# is checked through its wrapper on purpose: help has to work on a machine that
# never built the TUI, and in a pipe, which is where both other checks bail out.
echo "── behavior: every binary answers --help and --version the same way ──"
for b in e2b-dash e2b-bench; do
  bin="$ROOT/bin/$b"
  [ -x "$bin" ] || { skip "$b not present"; continue; }
  # e2b-bench is a wrapper around a Rust binary that a fresh checkout has not
  # built yet, and its "not built" path exits 1 before parsing a single flag.
  # Skipping is honest; asserting here would test cargo, not the CLI.
  if [ "$b" = e2b-bench ] && [ ! -x "$ROOT/tui/target/release/e2b-bench" ]; then
    skip "$b --help/--version (binary not built)"; continue
  fi
  out=$("$bin" --help 2>/dev/null); rc=$?
  { [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "^$b —"; } \
    && ok "$b --help → usage on stdout, exit 0" || bad "$b --help (rc=$rc)"
  out=$("$bin" --version 2>/dev/null); rc=$?
  { [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qE '^herdr-e2b [0-9]+\.[0-9]+'; } \
    && ok "$b --version" || bad "$b --version (rc=$rc, out=$out)"
done

# The board as data. Two members, one of each verdict, so the tally and the exit
# code are both exercised: --json must change the rendering and nothing else —
# an orchestrator comparing runs reads this instead of regexing an aligned table.
if [ -x "$ROOT/bin/e2b-bench" ] && [ -x "$ROOT/tui/target/release/e2b-bench" ]; then
  bdir="$HERDR_PLUGIN_STATE_DIR/bench/demo"; mkdir -p "$bdir"
  echo '{"id":"demo","grade":"npm test","startedAt":"1"}' > "$bdir/run.json"
  echo '{"key":"d1","label":"demo-claude","template":"claude","verdict":"pass","exitCode":0,"ms":4200}' > "$bdir/d1.json"
  echo '{"key":"d2","label":"demo-codex","template":"codex","verdict":"fail","exitCode":1,"ms":9000}' > "$bdir/d2.json"
  out=$("$ROOT/bin/e2b-bench" demo --json 2>/dev/null); rc=$?
  if printf '%s' "$out" | jq -e '.tally == {pass:1,fail:1,error:0,total:2}' >/dev/null 2>&1; then
    ok "e2b-bench --json → run + results + tally"
  else
    bad "e2b-bench --json (rc=$rc, out=$(printf '%s' "$out" | head -3))"
  fi
  [ "$rc" -eq 1 ] \
    && ok "e2b-bench --json keeps the exit code (1 when a member failed)" \
    || bad "e2b-bench --json exit code (rc=$rc, want 1)"
  rm -rf "$HERDR_PLUGIN_STATE_DIR/bench"
fi

echo "── behavior: exec (the grader's only path into a box) ──"
# Usage errors stay plain text on stderr like every other verb — they happen
# before there is a measurement to report.
out=$(KEY=nobox "$E2B" exec 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "needs a command"; } \
  && ok "exec with no command → exit 2" || bad "exec with no command (rc=$rc, out=$out)"

out=$(KEY=nobox "$E2B" exec 'npm test' 'npm run lint' 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "ONE command"; } \
  && ok "exec with two commands → exit 2 (quote it)" || bad "exec with two commands (rc=$rc, out=$out)"

out=$(KEY=nobox "$E2B" exec --timeout-ms 'npm test' 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "positive integer"; } \
  && ok "exec --timeout-ms with a non-number → exit 2" || bad "exec --timeout-ms non-number (rc=$rc, out=$out)"

# An untracked box is the grader's "never measured" case, and it must arrive as
# the JSON contract (ok:false, no exit code) rather than a bare message: anything
# unparseable reads to tui/src/grade.rs as a broken helper, not a missing box.
out=$(KEY=nobox "$E2B" exec 'npm test' 2>/dev/null); rc=$?
{ [ "$rc" -eq 1 ] \
  && [ "$(printf '%s' "$out" | jq -r '.ok')" = "false" ] \
  && [ "$(printf '%s' "$out" | jq -r '.exitCode')" = "null" ] \
  && printf '%s' "$out" | jq -e '.error | test("no sandbox tracked")' >/dev/null; } \
  && ok "exec with no box → {ok:false, exitCode:null} + exit 1" || bad "exec with no box (rc=$rc, out=$out)"

echo "── behavior: pull safety (dirty tree, non-interactive → abort, no clobber) ──"
REPO="$TMP/repo"; mkdir -p "$REPO"
( cd "$REPO" && git init -q -b main && printf 'v1\n' > f.txt \
  && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
# Fake a ready record for this box (KEY override), so pull reaches the safety gate.
printf '{"key":"pullbox","label":"repo","status":"ready","sandboxId":"idummy","url":"https://x","projectPath":"/home/user/project"}\n' \
  > "$HERDR_PLUGIN_STATE_DIR/boxes/pullbox.json"
# Make the tree dirty.
printf 'LOCAL UNCOMMITTED WORK\n' > "$REPO/f.txt"
before="$(cat "$REPO/f.txt")"
out=$(cd "$REPO" && KEY=pullbox "$E2B" pull < /dev/null 2>&1); rc=$?
after="$(cat "$REPO/f.txt")"
{ [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "aborted (non-interactive)" && [ "$before" = "$after" ]; } \
  && ok "pull dirty+non-interactive → aborts, file untouched" \
  || bad "pull dirty+non-interactive (rc=$rc, changed=$([ "$before" = "$after" ] && echo no || echo YES))"

echo "── fleet: the dry run is the plan, and nothing else ──"
# The dry run is e2b-fleet's testable seam: it exercises config resolution, the
# picker bypass, base-ref resolution and per-member naming in ONE process with no
# herdr and no E2B. $HERDR_E2B_FLEET_RAND pins the random branch suffix so these
# assertions can be exact instead of fuzzy.
FLEET="$ROOT/bin/e2b-fleet"
FREPO="$TMP/fleet-repo"; mkdir -p "$FREPO"
( cd "$FREPO" && git init -q -b main && printf 'v1\n' > f.txt \
  && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init )
FBASE=$(git -C "$FREPO" rev-parse HEAD)
# HERDR_WORKSPACE_ID is unset here on purpose: the source workspace a member
# hangs off is read from the environment, so a suite run from inside herdr would
# otherwise assert against whatever pane happened to start it. The workspace form
# gets its own test below, with the id pinned.
fleet() { ( cd "$FREPO" && env -u HERDR_WORKSPACE_ID HERDR_E2B_FLEET_RAND=ab12 "$FLEET" "$@" 2>&1 ); }

out=$(fleet --slug "Login Fix" -t claude --dry-run); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx \
      "    herdr worktree create --cwd $FREPO --branch e2b/login-fix-claude-ab12 --base $FBASE --label login-fix-claude --no-focus" \
  && printf '%s\n' "$out" | grep -qx \
      "    herdr pane run <root pane of the new workspace> $ROOT/bin/e2b-box open -t claude" \
  && printf '%s' "$out" | grep -q "nothing was created"; } \
  && ok "dry run prints the worktree create (unfocused, no --path) + box open plan" \
  || bad "dry-run plan (rc=$rc, out=$out)"

# The fleet lands where it was launched. herdr groups worktree workspaces under a
# source, and `--cwd` picks that source by repo key — whichever workspace already
# claims the repo — so a fleet fired from a second workspace on the same repo
# would materialise under the first one. Naming our own workspace pins it.
out=$( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_WORKSPACE_ID=wTEST \
       "$FLEET" --slug login-fix -t claude --dry-run 2>&1 ); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx \
      "    herdr worktree create --workspace wTEST --branch e2b/login-fix-claude-ab12 --base $FBASE --label login-fix-claude --no-focus" \
  && ! printf '%s' "$out" | grep -q -- "--cwd"; } \
  && ok "dry run sources members from the launching workspace, not the repo key" \
  || bad "workspace-sourced worktree create (rc=$rc, out=$out)"

# No --path: the user's herdr [worktrees] directory decides where members land.
out=$(fleet --slug "Login Fix" -t claude --dry-run)
printf '%s' "$out" | grep -q -- "--path" \
  && bad "dry run passes --path — that overrides the user's [worktrees] directory" \
  || ok "dry run passes no --path to herdr"

{ [ "$(git -C "$FREPO" worktree list | wc -l | tr -d ' ')" = "1" ] \
  && [ -z "$(git -C "$FREPO" branch --list 'e2b/*')" ]; } \
  && ok "dry run creates no branch and no worktree" \
  || bad "dry run created something: $(git -C "$FREPO" branch --list 'e2b/*')"

# Members start clean (ADR-0003) — the drop is warned about, never silent, and
# never a blocker.
printf 'scratch\n' > "$FREPO/untracked.txt"
out=$(fleet --slug login-fix -t claude -n); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "1 uncommitted file"; } \
  && ok "a dirty invoking tree warns with the count and continues" || bad "dirty warning (rc=$rc, out=$out)"
rm -f "$FREPO/untracked.txt"

echo "── fleet: a member that will land on a sign-in screen is named first ──"
# The one place a missing credential actually costs something. In `open` it is an
# annoyance — the user is sitting in front of the box and can sign in. In a fleet it
# is a member that never starts work, discovered minutes later in a pane that is now
# stuck. So it is said BEFORE launch, once, naming the member, its template and the
# exact variable — and then the fleet flies (ADR 0003's shape, as for a dirty tree).
AUTHCFG="$TMP/fleet-auth-cfg"; mkdir -p "$AUTHCFG"
authfleet() { ( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_PLUGIN_CONFIG_DIR="$AUTHCFG" "$FLEET" "$@" 2>&1 ); }

rm -f "$AUTHCFG/config.toml" "$AUTHCFG/auth.toml"
out=$(authfleet --slug signin -t claude -t codex -t base -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qE "signin-claude +claude +ANTHROPIC_API_KEY" \
  && printf '%s\n' "$out" | grep -qE "signin-codex +codex +OPENAI_API_KEY" \
  && printf '%s\n' "$out" | grep -q '\[templates.claude.env\]' \
  && printf '%s' "$out" | grep -q "nothing was created"; } \
  && ok "an unauthenticated member is named with its template and its box variable" \
  || bad "fleet auth warning content (rc=$rc, out=$out)"

# One warning for the batch. Three members, two of them affected, and the block is
# emitted once — a roster of seven scrolling past as seven warnings is how a warning
# stops being read. `base` is not in it: a plain image has no agent to sign in.
{ [ "$(printf '%s\n' "$out" | grep -c 'will start unauthenticated')" -eq 1 ] \
  && printf '%s\n' "$out" | grep -q '2 members will start unauthenticated' \
  && ! printf '%s\n' "$out" | grep -q 'signin-base .*_API_KEY'; } \
  && ok "one warning for the roster, and a template needing no credential is left out" \
  || bad "fleet auth warning shape (out=$out)"

# A credential the user wrote by hand IS a credential — the check is what reaches
# Sandbox.create, not what `e2b-box auth` happened to discover. Printing the remedy
# at somebody who already took it is how a warning becomes noise.
printf '[templates.claude.env]\nANTHROPIC_API_KEY = "sk-ant-x"\n[templates.codex.env]\nOPENAI_API_KEY = "sk-oai-x"\n' > "$AUTHCFG/config.toml"
out=$(authfleet --slug allset -t claude -t codex -n); rc=$?
{ [ "$rc" -eq 0 ] && ! printf '%s\n' "$out" | grep -q 'will start unauthenticated'; } \
  && ok "a fully authenticated roster says nothing at all" \
  || bad "authenticated roster warned anyway (rc=$rc, out=$out)"

# What `e2b-box auth` generated counts too, and it is the same check: auth.toml is
# merged UNDER config.toml by the loader, so both arrive as one resolved env.
rm -f "$AUTHCFG/config.toml"
printf '[templates.claude.env]\nANTHROPIC_API_KEY = "sk-ant-discovered"\n' > "$AUTHCFG/auth.toml"
out=$(authfleet --slug found -t claude -n); rc=$?
rm -f "$AUTHCFG/auth.toml"
{ [ "$rc" -eq 0 ] && ! printf '%s\n' "$out" | grep -q 'will start unauthenticated'; } \
  && ok "a credential discovered into auth.toml authenticates the member too" \
  || bad "discovered credential warned anyway (rc=$rc, out=$out)"

# NOTHING on this path may spawn a harness binary. That is the whole reason `auth` is
# a subcommand you run on purpose, and a fleet creates several boxes at once — a
# probe here would put the cost back exactly where it was designed out of. Proved
# mechanically rather than by reading the code, because the failure is invisible.
PROBEDIR="$TMP/fleet-no-probe"; mkdir -p "$PROBEDIR"
for b in claude codex grok opencode amp droid prime; do
  printf '#!/bin/sh\necho "%s" >> "%s/spawned"\n' "$b" "$PROBEDIR" > "$PROBEDIR/$b"
  chmod +x "$PROBEDIR/$b"
done
out=$( cd "$FREPO" && PATH="$PROBEDIR:$PATH" HERDR_E2B_FLEET_RAND=ab12 \
       HERDR_PLUGIN_CONFIG_DIR="$AUTHCFG" "$FLEET" --slug noprobe -t claude -t codex -n 2>&1 ); rc=$?
{ [ "$rc" -eq 0 ] && [ ! -f "$PROBEDIR/spawned" ]; } \
  && ok "the fleet path spawns no harness binary" \
  || bad "the fleet probed: $(cat "$PROBEDIR/spawned" 2>/dev/null)"

# [fleet] base and prefix come from config, so the branch namespace and the ref
# members fork from are both the user's to choose.
FCFG="$TMP/fleet-home/.config/herdr/plugins/config/e2b-dev.herdr-e2b"; mkdir -p "$FCFG"
printf '[fleet]\nbase = "main"\nprefix = "bench/x"\n' > "$FCFG/config.toml"
out=$( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 XDG_CONFIG_HOME="$TMP/fleet-home/.config" \
       "$FLEET" --slug login-fix -t claude -n 2>&1 ); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s' "$out" | grep -q -- "--branch bench/x/login-fix-claude-ab12" \
  && printf '%s' "$out" | grep -q -- "--base main"; } \
  && ok "[fleet] base and prefix from config reach the plan" || bad "[fleet] config (rc=$rc, out=$out)"

# HERDR_PLUGIN_CONFIG_DIR is herdr's own — the XDG path is only where it points
# today, so the injected value has to win. Both are set here, and only the
# HERDR_PLUGIN_CONFIG_DIR prefix may reach the plan.
PCFG="$TMP/fleet-plugincfg"; mkdir -p "$PCFG"
printf '[fleet]\nprefix = "frm/plugindir"\n' > "$PCFG/config.toml"
out=$( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 \
       XDG_CONFIG_HOME="$TMP/fleet-home/.config" HERDR_PLUGIN_CONFIG_DIR="$PCFG" \
       "$FLEET" --slug login-fix -t claude -n 2>&1 ); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s' "$out" | grep -q -- "--branch frm/plugindir/login-fix-claude-ab12" \
  && ! printf '%s' "$out" | grep -q -- "bench/x"; } \
  && ok "HERDR_PLUGIN_CONFIG_DIR wins over the XDG config path" \
  || bad "HERDR_PLUGIN_CONFIG_DIR precedence (rc=$rc, out=$out)"

# An unknown [sandbox] region must reach the user as ITSELF. The bash layer
# resolves credentials through a node helper whose stderr it used to discard, so
# a typo'd region degraded into the generic "No E2B API key" — a message naming
# the wrong problem. The env is cleared because the credential lookup is skipped
# entirely when E2B_API_KEY is already exported.
RCFG="$TMP/bad-region"; mkdir -p "$RCFG"
printf '[sandbox]\nregion = "apac"\n' > "$RCFG/config.toml"
out=$( cd "$FREPO" && env -u E2B_API_KEY -u E2B_DOMAIN HERDR_PLUGIN_CONFIG_DIR="$RCFG" \
       bash -c 'source "$1/bin/lib/paths.sh"; ensure_e2b_env' _ "$ROOT" 2>&1 )
{ printf '%s' "$out" | grep -q "apac" \
  && printf '%s' "$out" | grep -q "us, eu" \
  && ! printf '%s' "$out" | grep -qi "at resolveCredentials"; } \
  && ok "an unknown region is reported by name, not as a stack trace" \
  || bad "unknown region message (out=$out)"

# A project's own template is namespaced `<project>/<name>`, and the project half
# is shared by every member of a fleet — so the member is named after the last
# segment only. Asserted through the plan because the label is what herdr shows.
NSCFG="$TMP/ns-templates"; mkdir -p "$NSCFG"
printf '[sandbox]\ntemplates = ["ondrejs-project/amp", "mpp/amp", "claude"]\n' > "$NSCFG/config.toml"
out=$( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_PLUGIN_CONFIG_DIR="$NSCFG" \
       "$FLEET" --slug fix-auth -t ondrejs-project/amp -t claude -n 2>&1 ); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s' "$out" | grep -q -- "--branch e2b/fix-auth-amp-ab12" \
  && printf '%s' "$out" | grep -q -- "--label fix-auth-amp" \
  && ! printf '%s' "$out" | grep -q -- "ondrejs-project-amp"; } \
  && ok "a namespaced template is named by its last segment" \
  || bad "namespaced template naming (rc=$rc, out=$out)"

# Dropping the project half can make two DIFFERENT templates claim one member
# name. Two workspaces called fix-auth-amp are worse than a refusal, so the
# roster is rejected before anything is created, naming both entries — and bash
# must not append a guessed cause that contradicts it.
out=$( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_PLUGIN_CONFIG_DIR="$NSCFG" \
       "$FLEET" --slug fix-auth -t ondrejs-project/amp -t mpp/amp -n 2>&1 ); rc=$?
{ [ "$rc" -eq 2 ] \
  && printf '%s' "$out" | grep -q "ondrejs-project/amp" \
  && printf '%s' "$out" | grep -q "mpp/amp" \
  && printf '%s' "$out" | grep -q "fix-auth-amp" \
  && ! printf '%s' "$out" | grep -q "herdr worktree create" \
  && ! printf '%s' "$out" | grep -q "task slug can't become"; } \
  && ok "a roster whose members would share a name is refused, naming both" \
  || bad "roster label collision (rc=$rc, out=$out)"

# A roster holds a template at most once (CONTEXT.md), so a repeated -t is one
# member — and the plan keeps first-seen order, which is what makes it assertable.
out=$(fleet --slug dup -t claude -t claude -t codex -n); rc=$?
creates=$(printf '%s\n' "$out" | grep -c 'herdr worktree create' || true)
{ [ "$rc" -eq 0 ] && [ "$creates" -eq 2 ] \
  && [ "$(printf '%s\n' "$out" | grep -c 'e2b/dup-claude-ab12')" -eq 1 ] \
  && printf '%s\n' "$out" | grep -q "collapsed 1 duplicate" \
  && [ "$(printf '%s\n' "$out" | grep -n 'member dup-claude' | cut -d: -f1)" \
       -lt "$(printf '%s\n' "$out" | grep -n 'member dup-codex' | cut -d: -f1)" ]; } \
  && ok "a template given twice is one member, in first-seen order" \
  || bad "duplicate template collapse (rc=$rc, creates=$creates, out=$out)"

echo "── fleet: create is the one-liner, and it plans the same fleet ──"
# `create` exists so an agent or a script has one unambiguous line to type, and the
# only thing it may change is HOW the fleet is asked for — never WHAT gets built.
# So the assertion is equality with the flag form, byte for byte.
flagged=$(fleet --slug login-fix -t claude -t codex --task "port it" -n)
created=$(fleet create login-fix -t claude -t codex --task "port it" -n)
[ "$flagged" = "$created" ] \
  && ok "create <slug> plans exactly what --slug plans" \
  || bad "create parity (flagged=$flagged, created=$created)"

# The slug may still be flagged under `create` — `kill` takes a positional and the
# spawn took a flag, and a verb that accepted only one of them would be a third
# grammar to remember.
created_s=$(fleet create -s login-fix -t claude -t codex --task "port it" -n)
[ "$flagged" = "$created_s" ] \
  && ok "create -s NAME is the same as create NAME" \
  || bad "create -s parity (created_s=$created_s)"

# Still refused, and the message names the flag it was probably missing: a bare
# sentence after the slug is nearly always a task that lost its --task.
out=$(fleet create login-fix second -t claude -n); rc=$?
{ [ "$rc" -eq 2 ] \
  && printf '%s' "$out" | grep -q "'login-fix' is the slug, so what is 'second'" \
  && printf '%s' "$out" | grep -q -- "--task"; } \
  && ok "create takes one slug — a second positional names --task" \
  || bad "create second positional (rc=$rc, out=$out)"

# Help is scoped to the subcommand you were using: the whole manual in answer to
# a question about `kill` buries the four lines that would have helped.
out=$(fleet kill t-23 --all 2>&1); rc=$?
{ [ "$rc" -eq 2 ] \
  && printf '%s' "$out" | grep -q "belongs to .* create" \
  && ! printf '%s' "$out" | grep -q -- "--no-dashboard"; } \
  && ok "a create flag on kill says where it lives, and shows only kill" \
  || bad "kill misplaced flag (rc=$rc, out=$out)"

out=$(fleet kill --help 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && ! printf '%s' "$out" | grep -q -- "--agents"; } \
  && ok "kill --help is the kill half only" || bad "kill --help (rc=$rc)"

out=$(fleet --help 2>&1); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s' "$out" | grep -q -- "--agents" \
  && printf '%s' "$out" | grep -q -- "--prune-branches"; } \
  && ok "bare --help still shows both halves" || bad "fleet --help (rc=$rc)"

# `create` is optional — a terminal decides the board, not the verb, so making the
# word compulsory only taxed the common case. A bare slug means the same with or
# without it.
bare=$(fleet login-fix -t claude -t codex --task "port it" -n)
[ "$flagged" = "$bare" ] \
  && ok "a bare slug needs no create in front of it" || bad "bare slug (bare=$bare)"

# What must NOT become a slug is a mistyped flag: the leading dash is the whole
# test, and without it a typo would silently name the fleet instead of failing.
out=$(fleet --agnets claude -n); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "unknown argument '--agnets'"; } \
  && ok "a mistyped flag is an error, never the fleet's name" \
  || bad "mistyped flag (rc=$rc, out=$out)"

# `--all` is the spelling people reach for, and `-a --all` is what they type when
# they reach for both. getopt would read that second one as an agent NAMED --all.
n_roster=$(node "$ROOT/src/resolve-template.js" --fleet | tail -n +2 | grep -c '[^[:space:]]')
allflag=$(fleet everyone --all -n)
[ "$(printf '%s\n' "$allflag" | grep -c '^  member ')" -eq "$n_roster" ] \
  && ok "--all is --agents all" || bad "--all (out=$allflag)"
dashaflag=$(fleet everyone -a --all -n)
[ "$allflag" = "$dashaflag" ] \
  && ok "-a --all is honoured rather than planning an agent called '--all'" \
  || bad "-a --all (out=$dashaflag)"

# Any OTHER flag in the roster's place is the list having been left out entirely.
out=$(fleet everyone -a --task "hi" -n); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "wants the roster"; } \
  && ok "-a followed by another flag is refused, not guessed" \
  || bad "-a with a flag value (rc=$rc, out=$out)"

echo "── fleet: members start their own agent ──"
# Which command starts a member's agent is `[fleet.agents]`, and the dry run is
# where it can be read without a herdr, a box, or an agent. The config dir is
# pinned to a fixture so these never read the machine's real config.
ACFG="$TMP/fleet-agents-cfg"; mkdir -p "$ACFG"
afleet() { ( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_PLUGIN_CONFIG_DIR="$ACFG" "$FLEET" "$@" 2>&1 ); }

# No `[fleet.agents]` at all: a template runs its SHIPPED command, which carries
# that agent's skip-approvals flag — a member works unattended in a disposable
# box, and one that stops on its first permission prompt produces nothing to
# compare.
rm -f "$ACFG/config.toml"
out=$(afleet --slug auto -t claude -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "    herdr pane run <that pane, once its sandbox shell is up> claude --dangerously-skip-permissions"; } \
  && ok "dry run shows the auto-start: the shipped unattended command" \
  || bad "default agent command (rc=$rc, out=$out)"

# A template nobody has verified a flag for still starts — bare, never with an
# invented flag that would just fail to launch.
out=$(afleet --slug auto -t droid -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "    herdr pane run <that pane, once its sandbox shell is up> droid"; } \
  && ok "a template with no shipped flag falls back to its own name" \
  || bad "unflagged template default (rc=$rc, out=$out)"

# A custom template whose CLI is named something else, and a flag-carrying
# override: the whole line is typed as one string, so quoting survives.
printf '[fleet.agents]\nclaude = "claude --resume"\nmine = "my-cli --go"\n' > "$ACFG/config.toml"
out=$(afleet --slug over -t claude -t mine -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "    herdr pane run <that pane, once its sandbox shell is up> claude --resume" \
  && printf '%s\n' "$out" | grep -qx "    herdr pane run <that pane, once its sandbox shell is up> my-cli --go"; } \
  && ok "[fleet.agents] overrides the command per template" \
  || bad "agent command override (rc=$rc, out=$out)"

# The control arm. An empty command is a CHOICE — a plain shell — so it must not
# read as a failure anywhere: no agent step in the plan, nothing on stderr, exit 0.
printf '[fleet.agents]\nbase = ""\n' > "$ACFG/config.toml"
out=$(afleet --slug ctl -t base -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "no agent for base" \
  && ! printf '%s\n' "$out" | grep -q "sandbox shell is up" \
  && ! printf '%s\n' "$out" | grep -q "agent rename" \
  && ! printf '%s\n' "$out" | grep -qiE 'error|warn|✗|⚠'; } \
  && ok 'a template mapped to "" gets a plain shell — no agent step, no error' \
  || bad "agentless template (rc=$rc, out=$out)"
rm -f "$ACFG/config.toml"

echo "── fleet: one task reaches every member ──"
# The fleet task is typed once and handed to each member's agent as that member
# comes up. A member's agent runs inside its VM, where herdr's agent detection
# cannot see it, so delivery is send-text plus an Enter of its own — typed into the
# agent's prompt exactly the way the user would. Readable in the dry run without a
# herdr, from the same argv builders the spawn calls.
printf '[fleet.agents]\nbase = ""\n' > "$ACFG/config.toml"
out=$(afleet --slug task-run -t claude -t base --task 'ship the login fix' -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "writes the brief to .*herdr-e2b-task.md over the SDK" \
  && printf '%s\n' "$out" | grep -qx \
      "    herdr pane run <that pane, once its sandbox shell is up> claude --dangerously-skip-permissions \"\$(cat \$HOME/.herdr-e2b-task.md)\"" \
  && ! printf '%s\n' "$out" | grep -q 'send-text' \
  && ! printf '%s\n' "$out" | grep -q 'send-keys' \
  && printf '%s\n' "$out" | grep -q "the fleet task is not sent to base" \
  && printf '%s' "$out" | grep -q "nothing was created"; } \
  && ok "the brief is written in and the agent is STARTED with it — nothing is typed" \
  || bad "dry-run delivery (rc=$rc, out=$out)"
rm -f "$ACFG/config.toml"

# The task is optional (a fleet of ready boxes is a thing you can ask for), and
# an absent one must not leave a delivery step in the plan to wonder about.
out=$(afleet --slug notask -t claude -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && ! printf '%s\n' "$out" | grep -q 'agent prompt' \
  && ! printf '%s\n' "$out" | grep -qi 'fleet task'; } \
  && ok "no --task → no delivery step in the plan at all" \
  || bad "dry run with no task (rc=$rc, out=$out)"

# The auto-start is gated on a string e2b-box prints just before it hands the
# pane to `e2b sandbox connect`. If that line ever changes, every member would
# wait out the boot timeout instead — so the two are pinned together here.
{ grep -q 'attaching a shell in the sandbox' "$ROOT/bin/e2b-box" \
  && grep -q 'attaching a shell in the sandbox' "$FLEET"; } \
  && ok "e2b-fleet waits for the line e2b-box actually prints before the shell" \
  || bad "the box-shell marker drifted between bin/e2b-box and bin/e2b-fleet"

echo "── fleet: --agents says the roster once ──"
# The roster is a set, so it is named once. What must hold is that the two
# spellings build the SAME fleet — a second way to say a thing that quietly means
# something else is worse than not having it.
tflag=$(fleet create login-fix -t claude -t codex -n)
aflag=$(fleet create login-fix --agents claude,codex -n)
[ "$tflag" = "$aflag" ] \
  && ok "--agents a,b plans exactly what -t a -t b plans" \
  || bad "--agents parity (tflag=$tflag, aflag=$aflag)"

# The same roster, parsed by the OLDEST bash on this machine. macOS ships 3.2 as
# /bin/bash and CI runs there, so bash-4-only syntax is invisible to a developer
# with a modern bash on PATH and red on every mac. `local -` was exactly that: it
# died with `local: '-': not a valid identifier` AND left `set -f` on for the rest
# of the run, so the failure was a wrong plan rather than a clean error.
# Skipped, never faked, where /bin/bash is not the old one — it still runs, it just
# proves less.
if [ -x /bin/bash ]; then
  bver=$(/bin/bash -c 'echo "$BASH_VERSION"' 2>/dev/null)
  out=$( cd "$FREPO" && env -u HERDR_WORKSPACE_ID HERDR_E2B_FLEET_RAND=ab12 \
         /bin/bash "$FLEET" create login-fix --agents claude,codex -n 2>&1 ); rc=$?
  { [ "$rc" -eq 0 ] && [ "$out" = "$aflag" ]; } \
    && ok "the roster parses the same on /bin/bash ${bver%%(*}" \
    || bad "/bin/bash ${bver%%(*} plans a different fleet (rc=$rc, out=$out)"
fi

# `--agents "claude, codex"` is what a person types, so the space after the comma
# is forgiven rather than turned into a template named ' codex'.
spaced=$(fleet create login-fix --agents "claude, codex" -n)
[ "$spaced" = "$aflag" ] \
  && ok "whitespace around a comma is trimmed" || bad "--agents spacing (spaced=$spaced)"

# `all` is the roster the picker offers — every configured template except the
# plain default, which is the same list and the same rule as screen two.
out=$(fleet create everyone --agents all -n); rc=$?
want=$(node "$ROOT/src/resolve-template.js" --fleet | tail -n +2 | grep -c '[^[:space:]]')
got=$(printf '%s\n' "$out" | grep -c '^  member ')
{ [ "$rc" -eq 0 ] && [ "$got" -eq "$want" ] && [ "$want" -gt 1 ]; } \
  && ok "--agents all is one member per configured template ($want)" \
  || bad "--agents all (rc=$rc, got=$got, want=$want)"

# Mixing the two spellings is one roster, and the dedupe still applies across them.
out=$(fleet create mixed -t claude --agents claude,codex -n)
{ [ "$(printf '%s\n' "$out" | grep -c '^  member ')" -eq 2 ] \
  && printf '%s\n' "$out" | grep -q "collapsed 1 duplicate"; } \
  && ok "-t and --agents are one roster, deduped across both" || bad "mixed roster (out=$out)"

echo "── fleet: a roster name nobody configured is refused ──"
# An unknown name used to plan fine and only fail minutes later, when its box tried
# to boot. It is caught before anything exists, and the refusal names the list.
out=$(fleet create typo --agents clade,codex -n); rc=$?
{ [ "$rc" -eq 2 ] \
  && printf '%s' "$out" | grep -q "no template named 'clade'" \
  && printf '%s' "$out" | grep -q "configured: claude" \
  && ! printf '%s' "$out" | grep -q "herdr worktree create"; } \
  && ok "an unknown agent is refused, with the configured list" \
  || bad "unknown agent refusal (rc=$rc, out=$out)"

# The escape hatch: `[sandbox] templates` is a menu, not a registry, so a template
# that exists on the cluster and in no config of yours has to remain launchable.
out=$(fleet create insist --agents my-private-box -n --force); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q "member insist-my-private-box"; } \
  && ok "--force allows a name no config mentions" || bad "--force roster (rc=$rc, out=$out)"

# The check reads what the config RECOGNISES, not what the picker OFFERS: a
# template configured only in [fleet.agents] is a real one, deliberately kept out
# of the menu, and refusing it would refuse the case that block exists for.
KCFG="$TMP/fleet-knowncfg"; mkdir -p "$KCFG"
printf '[fleet.agents]\nmine = "my-cli --go"\n' > "$KCFG/config.toml"
out=$( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_PLUGIN_CONFIG_DIR="$KCFG" \
       "$FLEET" create known --agents mine -n 2>&1 ); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q "member known-mine"; } \
  && ok "a template named only in [fleet.agents] is a known name" \
  || bad "[fleet.agents] template known (rc=$rc, out=$out)"

echo "── fleet: refusals create nothing ──"
out=$(fleet --slug "!!!" -t claude -n); rc=$?
{ [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "slug" && ! printf '%s' "$out" | grep -q "herdr worktree create"; } \
  && ok "a slug that sanitizes to nothing → message, no plan, non-zero" || bad "unsanitizable slug (rc=$rc, out=$out)"

out=$(fleet --slug login-fix -n); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "no templates"; } \
  && ok "no -t → exit 2" || bad "no templates (rc=$rc, out=$out)"

# The refusal names the verb that fixes it: a caller with no tty can't be asked,
# so it has to be told the one line that always works.
out=$(fleet -t claude -n); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "no slug" \
    && printf '%s' "$out" | grep -q "create <slug>"; } \
  && ok "no slug → exit 2, pointing at create" || bad "no slug (rc=$rc, out=$out)"

out=$(fleet --slug login-fix -t); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "needs a template name"; } \
  && ok "-t with no value → exit 2" || bad "-t with no value (rc=$rc, out=$out)"

out=$(fleet --slug login-fix -t claude --bogus -n); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "unknown argument"; } \
  && ok "an unknown flag → exit 2" || bad "unknown flag (rc=$rc, out=$out)"

# A herdr that answers nothing. Deliberately NOT a mock of herdr's CLI (which
# would drift): the refusal only needs the worktree probe to fail, so the stub
# has no surface at all. HERDR_BIN_PATH is what pane_herdr prefers, so this also
# keeps the assertions identical on a machine with no herdr installed.
FSTUB="$TMP/fake-herdr/herdr"; mkdir -p "$(dirname "$FSTUB")"
printf '#!/bin/sh\nexit 127\n' > "$FSTUB"; chmod +x "$FSTUB"

out=$( cd "$FREPO" && env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID \
         -u HERDR_PLUGIN_ID -u HERDR_PLUGIN_ROOT HERDR_BIN_PATH="$FSTUB" "$FLEET" --slug login-fix -t claude 2>&1 ); rc=$?
{ [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "herdr session" && printf '%s' "$out" | grep -q "0\.7\.0"; } \
  && ok "outside a herdr session → refuses, names the version" || bad "outside herdr (rc=$rc, out=$out)"

out=$( cd "$FREPO" && HERDR_ENV=1 HERDR_BIN_PATH="$FSTUB" "$FLEET" --slug login-fix -t claude 2>&1 ); rc=$?
{ [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "no worktree API" && printf '%s' "$out" | grep -q "0\.7\.0"; } \
  && ok "a herdr without the worktree API → refuses, names the version" || bad "old herdr (rc=$rc, out=$out)"

{ [ "$(git -C "$FREPO" worktree list | wc -l | tr -d ' ')" = "1" ] \
  && [ -z "$(git -C "$FREPO" branch --list 'e2b/*')" ]; } \
  && ok "every refusal left the repo untouched" \
  || bad "a refusal created something: $(git -C "$FREPO" branch --list 'e2b/*')"

echo "── fleet: a roster becomes N members in parallel ──"
# Batch semantics (per-member success, an N/M summary, a non-zero exit when any
# member failed) live BELOW the dry run, so they need a herdr that answers. This
# stub is deliberately tiny — two subcommands, canned JSON, nothing created
# anywhere — rather than a model of herdr's CLI that would drift from it. It is
# what lets the concurrency and the reporting be asserted with no worktree, no
# workspace and no box in sight.
# A stand-in for e2b-box. The spawn now CALLS the box CLI directly to write a
# member's brief into its sandbox over the SDK, so the offline suite needs one
# that records the call instead of reaching E2B. It writes the decoded brief to
# $STUB_TASK_OUT, which is what proves the text survived the trip byte for byte.
mk_box_stub() { # $1 = dest
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<'BOXSTUB'
#!/bin/sh
if [ "$1" = exec ]; then
  echo "EXEC ${KEY:-nokey}" >> "${STUB_LOG:-/dev/null}"
  # A box that cannot be written to: the brief never lands, and the member must
  # come up WITHOUT it rather than the run claiming it was delivered.
  [ -n "${STUB_BOX_FAIL:-}" ] && exit 1
  # The real call is `printf %s '<b64>' | base64 -d > $HOME/...`; run just the
  # decode so the suite can compare what would have landed in the box.
  if [ -n "${STUB_TASK_OUT:-}" ]; then
    printf %s "$2" | sed -e "s/^printf %s '//" -e "s/' | base64 -d.*$//" | base64 -d > "$STUB_TASK_OUT" 2>/dev/null
  fi
  exit 0
fi
exit 0
BOXSTUB
  chmod +x "$1"
}

mk_herdr_stub() { # $1 = dest, $2 = "ok" | "fail" (how `worktree create` answers)
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<STUB
#!/bin/sh
case "\$1 \$2" in
  "worktree list")   echo '{"result":{"type":"worktree_list"}}'; exit 0 ;;
  # The member's checkout, which the spawn needs to address that member's BOX
  # (its record is keyed by path) when it writes the brief in.
  "workspace list")  printf '{"result":{"workspaces":[{"workspace_id":"w1","worktree":{"checkout_path":"%s"}}]}}\n' "\${STUB_WT_PATH:-/tmp/stub-wt}"; exit 0 ;;
  "worktree create")
    sleep "\${STUB_DELAY:-0}"
    [ "$2" = fail ] && { echo "stub refuses" >&2; exit 1; }
    echo '{"result":{"workspace":{"workspace_id":"w1"},"root_pane":{"pane_id":"p1"}}}'; exit 0 ;;
  # \$4 is the whole command line for the agent (typed as one argument) and the
  # e2b-box path for the box, so logging just it distinguishes the two calls.
  "pane run")         echo "RUN \$3 :: \$4" >> "\${STUB_LOG:-/dev/null}"
                      echo '{"result":{}}'; exit 0 ;;
  "pane wait-output") echo '{"result":{"type":"output_matched"}}'; exit 0 ;;
  # Raw terminal text, not JSON — that is what herdr answers. The default is the
  # sandbox's own prompt, i.e. "the agent has NOT taken this pane", so a stub run
  # only reaches the typed-delivery path when a test says the TUI is up.
  # A pane shows what was typed into it and stops showing it once Enter submits
  # it — which is exactly what delivery is confirmed against, so the stub has to
  # model it rather than print a fixed screen.
  "pane read")        printf '%s\n' "\${STUB_PANE_TAIL:-[e2b:stub] ~/project \\\$ }"
                      [ -n "\${STUB_TYPED:-}" ] && [ -f "\$STUB_TYPED" ] && cat "\$STUB_TYPED"
                      exit 0 ;;
  # Typed delivery, for the members herdr never adopts. Same split as the real
  # thing: the text, then the Enter that submits it. The text goes to a file so a
  # task with newlines in it can be compared byte for byte.
  "pane send-text")   echo "TEXT \$3" >> "\${STUB_LOG:-/dev/null}"
                      [ -n "\${STUB_TASK_OUT:-}" ] && printf '%s' "\$4" > "\$STUB_TASK_OUT"
                      [ -n "\${STUB_TYPED:-}" ] && printf '%s' "\$4" > "\$STUB_TYPED"
                      echo '{"result":{}}'; exit 0 ;;
  # Enter submits: the prompt stops holding the text, which is how the caller
  # tells a delivered task from one sitting unsent in the box.
  "pane send-keys")   echo "KEYS \$3 \$4" >> "\${STUB_LOG:-/dev/null}"
                      [ -n "\${STUB_TYPED:-}" ] && rm -f "\$STUB_TYPED"
                      echo '{"result":{}}'; exit 0 ;;
  # herdr answers agent_not_found (with exit 0) until its scrape adopts the
  # agent, which is exactly the "never appeared" case when STUB_AGENT is unset.
  "agent get")
    if [ -n "\${STUB_AGENT:-}" ]; then
      printf '{"result":{"agent":{"agent":"%s","pane_id":"%s"}}}\n' "\$STUB_AGENT" "\$3"; exit 0
    fi
    echo '{"error":{"code":"agent_not_found","message":"stub: no agent"}}'; exit 0 ;;
  "agent rename")     echo "RENAME \$3 \$4" >> "\${STUB_LOG:-/dev/null}"
                      echo '{"result":{}}'; exit 0 ;;
  # The fleet task. \$3 is the target it was addressed to (an agent NAME once the
  # rename landed); \$4 is the text, written to a file rather than the log so a
  # task with newlines in it can be compared byte for byte.
  "agent prompt")     echo "PROMPT \$3" >> "\${STUB_LOG:-/dev/null}"
                      [ -n "\${STUB_TASK_OUT:-}" ] && printf '%s' "\$4" > "\$STUB_TASK_OUT"
                      echo '{"result":{}}'; exit 0 ;;
esac
case "\$1" in pane) echo '{"result":{}}'; exit 0 ;; esac
echo '{"error":{"message":"stub: unhandled"}}'; exit 1
STUB
  chmod +x "$1"
}
mk_box_stub "$TMP/box-stub"
mk_herdr_stub "$TMP/herdr-ok/herdr" ok
mk_herdr_stub "$TMP/herdr-fail/herdr" fail
STUB_DELAY=0     # seconds the stub's `worktree create` blocks for
STUB_LOG=""      # file the stub appends its `pane run` / `agent rename` calls to
STUB_AGENT=""    # non-empty → the stub's `agent get` reports an agent of that name
STUB_TASK_OUT="" # file the stub writes the prompted task text to, verbatim
spawn() { # $1 = stub dir, rest = flags
  local stub="$1"; shift
  # All three waits run at zero here: the point of these tests is what gets
  # reported, and a real deadline would only make the suite slow. The agent wait is
  # the one a caller can raise — readiness needs two polls to confirm, so the test
  # that asserts a member IS ready cannot run it at zero.
  ( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_ENV=1 STUB_DELAY="$STUB_DELAY" \
      STUB_LOG="$STUB_LOG" STUB_AGENT="$STUB_AGENT" STUB_TASK_OUT="$STUB_TASK_OUT" \
      STUB_TYPED="${STUB_TYPED:-}" \
      HERDR_PLUGIN_CONFIG_DIR="$ACFG" \
      HERDR_E2B_FLEET_SHELL_WAIT=1 HERDR_E2B_FLEET_TASK_WAIT=0 \
      HERDR_E2B_FLEET_AGENT_WAIT="${HERDR_E2B_FLEET_AGENT_WAIT:-0}" \
      HERDR_E2B_BOX="$TMP/box-stub" STUB_BOX_FAIL="${STUB_BOX_FAIL:-}" \
      HERDR_BIN_PATH="$TMP/$stub/herdr" "$FLEET" "$@" 2>&1 )
}

out=$(spawn herdr-ok --slug ok-run -t claude -t codex); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "✓ ok-run-claude" \
  && printf '%s\n' "$out" | grep -q "✓ ok-run-codex" \
  && printf '%s\n' "$out" | grep -qx "2/2 up"; } \
  && ok "every member up → one line each + '2/2 up' + exit 0" \
  || bad "all-members-up report (rc=$rc, out=$out)"

# …and the live path launches after saying it. The warning is not a gate: the user
# may be about to configure that credential, or may not care about that member.
rm -f "$PROBEDIR/spawned"
out=$(PATH="$PROBEDIR:$PATH" spawn herdr-ok --slug unauth -t claude); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qE "unauth-claude +claude +ANTHROPIC_API_KEY" \
  && printf '%s\n' "$out" | grep -qx "1/1 up" \
  && [ ! -f "$PROBEDIR/spawned" ]; } \
  && ok "a member with no credential is named, the fleet launches anyway, and nothing probed" \
  || bad "unauthenticated member blocked the launch (rc=$rc, probed=$(cat "$PROBEDIR/spawned" 2>/dev/null), out=$out)"

out=$(spawn herdr-fail --slug bad-run -t claude -t codex); rc=$?
{ [ "$rc" -ne 0 ] \
  && printf '%s\n' "$out" | grep -q "✗ bad-run-claude" \
  && printf '%s\n' "$out" | grep -q "✗ bad-run-codex" \
  && printf '%s\n' "$out" | grep -qx "0/2 up" \
  && printf '%s\n' "$out" | grep -q "were kept"; } \
  && ok "every member failed → '0/2 up', kept branches, non-zero exit" \
  || bad "all-members-failed report (rc=$rc, out=$out)"

# Concurrency, measured rather than asserted structurally: three members whose
# worktree call blocks for a second finish in about a second, not three.
STUB_DELAY=1
start=$SECONDS
out=$(spawn herdr-ok --slug par-run -t claude -t codex -t base); rc=$?
elapsed=$((SECONDS - start))
STUB_DELAY=0
{ [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -qx "3/3 up" && [ "$elapsed" -le 2 ]; } \
  && ok "3 members × a 1s provision finish in ${elapsed}s (serial would be 3)" \
  || bad "members are not provisioned concurrently (rc=$rc, elapsed=${elapsed}s, out=$out)"

# The auto-start end to end against the stub: the command is TYPED into the
# member's pane (herdr's `agent start` would refuse it — the pane is running the
# sandbox connection), then the adopted agent is renamed <task-slug>-<template>.
STUB_LOG="$TMP/stub-calls.log"; : > "$STUB_LOG"
STUB_AGENT=claude
out=$(spawn herdr-ok --slug det -t claude); rc=$?
STUB_AGENT=""
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "✓ det-claude" \
  && printf '%s\n' "$out" | grep -q "named det-claude" \
  && grep -qx "RUN p1 :: claude --dangerously-skip-permissions" "$STUB_LOG" \
  && grep -qx "RENAME p1 det-claude" "$STUB_LOG"; } \
  && ok "the agent is typed into the member's pane, then renamed det-claude" \
  || bad "agent auto-start (rc=$rc, log=$(cat "$STUB_LOG"), out=$out)"

# An agent that never appears: reported, box left running, member still up —
# because the box booting is what the member promised. Never killed, never retried.
: > "$STUB_LOG"
out=$(spawn herdr-ok --slug undet -t claude); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "1/1 up" \
  && printf '%s\n' "$out" | grep -q "still showed the sandbox shell" \
  && printf '%s\n' "$out" | grep -q "Box left running" \
  && ! grep -q RENAME "$STUB_LOG" \
  && ! grep -qE 'TEXT|KEYS' "$STUB_LOG" \
  && ! printf '%s\n' "$out" | grep -qiE 'kill|remove|rolled back'; } \
  && ok "an agent that never takes the pane is reported, its box left running, the member still up" \
  || bad "undetected agent (rc=$rc, log=$(cat "$STUB_LOG"), out=$out)"

# The control arm again, this time live: nothing is typed at all.
printf '[fleet.agents]\nbase = ""\n' > "$ACFG/config.toml"
: > "$STUB_LOG"
out=$(spawn herdr-ok --slug ctl2 -t base); rc=$?
rm -f "$ACFG/config.toml"
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "1/1 up" \
  && printf '%s\n' "$out" | grep -q "no agent for base" \
  && [ "$(grep -c '^RUN ' "$STUB_LOG")" -eq 1 ] \
  && ! grep -q RENAME "$STUB_LOG" \
  && ! printf '%s\n' "$out" | grep -qE '✗|⚠'; } \
  && ok 'an agentless member types nothing beyond the box — no error, still up' \
  || bad "agentless member (rc=$rc, log=$(cat "$STUB_LOG"), out=$out)"

# Delivery end to end. The text is deliberately hostile — a newline, both quote
# kinds, backticks and a $(…) — because it crosses argv, a background subshell
# and herdr's CLI, and story 38 says a real brief must arrive as written.
HARD_TASK=$'fix the login bug\nit\'s "urgent": see `git log` and $(pwd)'
STUB_TASK_OUT="$TMP/stub-task.txt"
: > "$STUB_LOG"; rm -f "$STUB_TASK_OUT"
STUB_AGENT=claude
out=$(spawn herdr-ok --slug deliver -t claude --task "$HARD_TASK"); rc=$?
STUB_AGENT=""
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "1/1 up" \
  && printf '%s\n' "$out" | grep -q "fleet task delivered to deliver-claude" \
  && grep -qx "PROMPT deliver-claude" "$STUB_LOG" \
  && [ -f "$STUB_TASK_OUT" ] && [ "$(cat "$STUB_TASK_OUT")" = "$HARD_TASK" ]; } \
  && ok "the task reaches the renamed agent with newlines, quotes and backticks intact" \
  || bad "task delivery (rc=$rc, log=$(cat "$STUB_LOG"), got=$(cat "$STUB_TASK_OUT" 2>/dev/null))"

# A member whose agent never settles: the task is reported undelivered and the
# box is LEFT RUNNING — the box booting is what the member promised, so this can
# never fail the member, kill anything, or turn its ✓ into a ✗.
: > "$STUB_LOG"; rm -f "$STUB_TASK_OUT"
out=$( STUB_BOX_FAIL=1 spawn herdr-ok --slug undeliv -t claude --task 'do the thing' ); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "1/1 up" \
  && printf '%s\n' "$out" | grep -q "fleet task NOT delivered" \
  && printf '%s\n' "$out" | grep -q "Box left running" \
  && ! grep -qE 'PROMPT|TEXT|KEYS' "$STUB_LOG" && [ ! -f "$STUB_TASK_OUT" ] \
  && ! printf '%s\n' "$out" | grep -qiE 'kill|remove|rolled back|✗'; } \
  && ok "a task that could not be delivered is reported, its box left running, the member up" \
  || bad "undelivered task (rc=$rc, log=$(cat "$STUB_LOG"), out=$out)"

# The path every REAL member takes. Nothing is typed into the agent: the brief is
# written into the box over the SDK and the agent is STARTED with it, because an
# agent that has drawn its first frame is not yet reading input — droid turned
# `say hello-world` into `o-world` on every attempt, three fleets running. An
# argument cannot be half-swallowed, so there is nothing here to time or retry.
: > "$STUB_LOG"; rm -f "$STUB_TASK_OUT"
out=$( STUB_PANE_TAIL='> Try "fix lint errors"' HERDR_E2B_FLEET_AGENT_WAIT=5 \
       spawn herdr-ok --slug typed -t claude --task "$HARD_TASK" ); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "1/1 up" \
  && printf '%s\n' "$out" | grep -q "fleet task delivered" \
  && grep -q '^EXEC ' "$STUB_LOG" \
  && grep -q 'RUN p1 :: claude --dangerously-skip-permissions "\$(cat ' "$STUB_LOG" \
  && ! grep -qE 'TEXT|KEYS' "$STUB_LOG" \
  && [ -f "$STUB_TASK_OUT" ] && [ "$(cat "$STUB_TASK_OUT")" = "$HARD_TASK" ]; } \
  && ok "the brief reaches the box intact and the agent is started holding it" \
  || bad "brief delivery (rc=$rc, log=$(cat "$STUB_LOG"), got=$(cat "$STUB_TASK_OUT" 2>/dev/null))"

# The control arm with a task on the table: skipped with a note, nothing sent,
# and nothing that reads as a failure — story 31.
printf '[fleet.agents]\nbase = ""\n' > "$ACFG/config.toml"
: > "$STUB_LOG"; rm -f "$STUB_TASK_OUT"
out=$(spawn herdr-ok --slug ctl4 -t base --task 'do the thing'); rc=$?
rm -f "$ACFG/config.toml"
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "1/1 up" \
  && printf '%s\n' "$out" | grep -q "fleet task skipped for base" \
  && ! grep -q PROMPT "$STUB_LOG" && [ ! -f "$STUB_TASK_OUT" ] \
  && ! printf '%s\n' "$out" | grep -qE '✗|⚠'; } \
  && ok "an agentless member is skipped with a note, not an error, and gets nothing sent" \
  || bad "agentless member with a task (rc=$rc, log=$(cat "$STUB_LOG"), out=$out)"
STUB_TASK_OUT=""
STUB_LOG=""

echo "── fleet: members arrive past the welcome wizard ──"
# A member's credential arrives in its box as an environment variable, but a fresh
# sandbox has no first-run STATE, so the agent runs its wizard anyway. The seeding
# step writes that state inside the box, just before the agent command is typed.
#
# The fixture config below holds a key whose value must appear NOWHERE in anything
# the host sends — the pane, and therefore the scrollback and herdr's session files,
# only ever carry the variable's name.
SCFG="$TMP/fleet-seed-cfg"; mkdir -p "$SCFG"
SEED_KEY="sk-ant-secret-head-TAILTAILTAILTAIL2020"  # …the last 20 chars are the tail
scfg() { printf '%s' "$1" > "$SCFG/config.toml"; }   # rewrite the whole fixture config
scfg "$(printf '[templates.claude.env]\nANTHROPIC_API_KEY = "%s"\n[templates.codex.env]\nOPENAI_API_KEY = "sk-oai-secret-head-value"\n' "$SEED_KEY")"
sfleet() { ( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_PLUGIN_CONFIG_DIR="$SCFG" "$FLEET" "$@" 2>&1 ); }

out=$(sfleet --slug seedy -t claude -t codex -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && [ "$(printf '%s\n' "$out" | grep -c 'seeded by the box as it provisions')" -eq 2 ] \
  && printf '%s\n' "$out" | grep -q 'nothing was created'; } \
  && ok "dry run names the seeding per template without making it a herdr call" \
  || bad "dry-run seeding plan (rc=$rc, out=$out)"

# The seeding is written into the box over the SDK, never typed, because `pane run`
# truncates at 1024 bytes and the claude command is longer than that. Nothing about
# it may appear in a plan of herdr calls — not the command, and least of all a key.
{ ! printf '%s\n' "$out" | grep -q 'hasCompletedOnboarding' \
  && ! printf '%s\n' "$out" | grep -q 'ANTHROPIC_API_KEY' \
  && ! printf '%s\n' "$out" | grep -q 'secret-head'; } \
  && ok "no seeding command, and no key, reaches the plan at all" \
  || bad "the dry run leaked the seeding into the plan (out=$out)"

# A control arm is untouched: no agent means nothing to arrive past a wizard for.
scfg "$(printf '[fleet.agents]\nclaude = ""\n')"
out=$(sfleet --slug seedctl -t claude -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "no agent for claude" \
  && ! printf '%s\n' "$out" | grep -q 'seeded by the box' \
  && ! printf '%s\n' "$out" | grep -qiE 'error|warn|✗|⚠'; } \
  && ok "a template mapped to \"\" is seeded nothing — the control arm stays untouched" \
  || bad "control-arm seeding (rc=$rc, out=$out)"

# A custom template with its own agent brings its own seeding; "" turns a shipped
# default off. Both are `[fleet.seed]`, keyed by template like `[fleet.agents]`.
scfg "$(printf '[fleet.agents]\nmine = "my-cli --go"\n[fleet.seed]\nmine = "my-cli auth --key $MY_API_KEY"\nclaude = ""\n')"
out=$(sfleet --slug seedcfg -t mine -t claude -n); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "(mine is seeded by the box as it provisions" \
  && ! printf '%s\n' "$out" | grep -q "(claude is seeded by the box" \
  && printf '%s\n' "$out" | grep -qx "    herdr pane run <that pane, once its sandbox shell is up> claude --dangerously-skip-permissions"; } \
  && ok "[fleet.seed] adds a custom template's seeding and \"\" switches a default off" \
  || bad "[fleet.seed] override (rc=$rc, out=$out)"

# The shipped commands themselves, EXECUTED. They are POSIX sh, so the highest seam
# available without a box is a throwaway $HOME. Read straight from the module that
# owns them — the plan no longer carries them, because the box writes them itself.
SEED_CLAUDE=$(node "$ROOT/src/fleet-seed.js" claude)
SEED_CODEX=$(node "$ROOT/src/fleet-seed.js" codex)

# The box runs these from a FILE now, so length is no longer a constraint — but a
# `[fleet.seed]` command a user writes still has to survive being one shell line, and
# a shipped one that grew a newline would be a silent behaviour change.
{ [ -n "$SEED_CLAUDE" ] && [ "$SEED_CLAUDE" = "${SEED_CLAUDE%%$'\n'*}" ] \
  && [ -n "$SEED_CODEX" ] && [ "$SEED_CODEX" = "${SEED_CODEX%%$'\n'*}" ]; } \
  && ok "each seeding command is a single line" \
  || bad "a seeding command spans more than one line"

# The reason the whole thing moved off the pane. `herdr pane run` truncates at 1024
# bytes: the claude command was cut mid-`node -e`, the next typed line was appended to
# the stump, and the box ran `node -echo …` (observed live, test-9 and test-10). This
# asserts the command is genuinely past that ceiling, so nobody "simplifies" it back
# into a `pane run` and rediscovers the same bug.
[ "${#SEED_CLAUDE}" -gt 1024 ] \
  && ok "the claude seeding is past pane run's 1024-byte ceiling — it must not be typed" \
  || bad "claude seeding is ${#SEED_CLAUDE} bytes — re-check whether typing it is safe again"

SHOME="$TMP/seed-home"
seed_run() { # $1 = command, $2 = home, rest = NAME=value env for the box
  local c="$1" h="$2"; shift 2
  mkdir -p "$h/project"
  ( cd "$h/project" && env -i HOME="$h" PATH="$PATH" "$@" sh -c "$c" 2>&1 )
}

rm -rf "$SHOME"
seed_out=$(seed_run "$SEED_CLAUDE" "$SHOME/claude-key" ANTHROPIC_API_KEY="$SEED_KEY")
{ [ -f "$SHOME/claude-key/.claude.json" ] \
  && jq -e '.hasCompletedOnboarding == true and .theme == "dark"' "$SHOME/claude-key/.claude.json" >/dev/null \
  && jq -e '.bypassPermissionsModeAccepted == true' "$SHOME/claude-key/.claude.json" >/dev/null \
  && jq -e '.customApiKeyResponses.approved == ["TAILTAILTAILTAIL2020"]' "$SHOME/claude-key/.claude.json" >/dev/null \
  && ! grep -q 'secret-head' "$SHOME/claude-key/.claude.json"; } \
  && ok "claude's state is written in the box: onboarding done, the key's last 20 chars approved" \
  || bad "claude seeding (out=$seed_out, file=$(cat "$SHOME/claude-key/.claude.json" 2>/dev/null))"

# No key configured for this template: the member still gets past the wizard, is told
# once that it is unauthenticated, and nothing pretends to be a credential.
seed_out=$(seed_run "$SEED_CLAUDE" "$SHOME/claude-nokey")
{ printf '%s\n' "$seed_out" | grep -q "no ANTHROPIC_API_KEY in this box" \
  && [ "$(printf '%s\n' "$seed_out" | grep -c 'ANTHROPIC_API_KEY')" -eq 1 ] \
  && jq -e '.hasCompletedOnboarding == true and .customApiKeyResponses == null' \
       "$SHOME/claude-nokey/.claude.json" >/dev/null; } \
  && ok "a keyless template still arrives past the wizard and says so once" \
  || bad "keyless claude seeding (out=$seed_out)"

# The disclaimer is a SECOND gate behind the first, so a box that was onboarded but
# never shown it — every member created before this key was seeded — must still be
# merged rather than skipped. This is the case the bail-out has to get right: it
# leaves the user's own settings alone (theme stays "mine") and adds only the flag
# that `--dangerously-skip-permissions` is otherwise stopped by.
mkdir -p "$SHOME/claude-onboarded"
printf '{"hasCompletedOnboarding":true,"theme":"mine"}' > "$SHOME/claude-onboarded/.claude.json"
seed_out=$(seed_run "$SEED_CLAUDE" "$SHOME/claude-onboarded" ANTHROPIC_API_KEY="$SEED_KEY")
jq -e '.bypassPermissionsModeAccepted == true and .theme == "mine"' \
   "$SHOME/claude-onboarded/.claude.json" >/dev/null \
  && ok "an onboarded box still gets the bypass disclaimer accepted, keeping its own settings" \
  || bad "bypass merge (out=$seed_out, file=$(cat "$SHOME/claude-onboarded/.claude.json"))"

# A resumed member: every gate already answered, so the file is the user's, whatever
# they have changed in it since. The bail-out tests BOTH flags — a file carrying only
# one of them is the merge case above, not this one.
mkdir -p "$SHOME/claude-again"
printf '{"theme":"mine","hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}' \
  > "$SHOME/claude-again/.claude.json"
before_again=$(cat "$SHOME/claude-again/.claude.json")
seed_out=$(seed_run "$SEED_CLAUDE" "$SHOME/claude-again" ANTHROPIC_API_KEY="$SEED_KEY")
{ [ "$(cat "$SHOME/claude-again/.claude.json")" = "$before_again" ] \
  && printf '%s\n' "$seed_out" | grep -q "leaving it alone"; } \
  && ok "state a user has since changed is left alone, and the box says why" \
  || bad "no-clobber (out=$seed_out, file=$(cat "$SHOME/claude-again/.claude.json"))"

# Codex reads its credential from a FILE, not from the environment — an OPENAI_API_KEY
# sitting unused in the box is exactly the sign-in menu this ticket exists to remove.
seed_out=$(seed_run "$SEED_CODEX" "$SHOME/codex-key" OPENAI_API_KEY="sk-oai-inside-the-box")
{ jq -e '.auth_mode == "apikey" and .OPENAI_API_KEY == "sk-oai-inside-the-box"' \
      "$SHOME/codex-key/.codex/auth.json" >/dev/null \
  && ! jq -e 'has("tokens") or has("last_refresh")' "$SHOME/codex-key/.codex/auth.json" >/dev/null; } \
  && ok "codex is authenticated through ~/.codex/auth.json, with no faked OAuth fields" \
  || bad "codex seeding (out=$seed_out, file=$(cat "$SHOME/codex-key/.codex/auth.json" 2>/dev/null))"

seed_out=$(seed_run "$SEED_CODEX" "$SHOME/codex-nokey")
{ printf '%s\n' "$seed_out" | grep -q "no codex credential in this box" \
  && [ ! -e "$SHOME/codex-nokey/.codex/auth.json" ]; } \
  && ok "codex with no credential writes no auth file at all — it just says it is unauthenticated" \
  || bad "keyless codex seeding (out=$seed_out)"

# ADR 0007: a borrowed session goes in verbatim, and it OUTRANKS the api-key branch.
# Both variables are set here on purpose — that is the case where the precedence is
# the whole behaviour, and the one a fallback written the other way round would pass.
SESSION_JSON='{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":"at-borrowed","refresh_token":"herdr-e2b-placeholder-not-a-real-refresh-token","account_id":"acc"}}'
seed_out=$(seed_run "$SEED_CODEX" "$SHOME/codex-session" CODEX_AUTH_JSON="$SESSION_JSON" OPENAI_API_KEY="$SEED_KEY")
{ [ -f "$SHOME/codex-session/.codex/auth.json" ] \
  && jq -e '.auth_mode == "chatgpt" and .tokens.access_token == "at-borrowed"' "$SHOME/codex-session/.codex/auth.json" >/dev/null \
  && ! grep -q 'secret-head' "$SHOME/codex-session/.codex/auth.json"; } \
  && ok "a borrowed session is seeded verbatim and beats the api key beside it" \
  || bad "session seeding (out=$seed_out, file=$(cat "$SHOME/codex-session/.codex/auth.json" 2>/dev/null))"
[ "$(stat -f '%Lp' "$SHOME/codex-session/.codex/auth.json" 2>/dev/null || stat -c '%a' "$SHOME/codex-session/.codex/auth.json" 2>/dev/null)" = "600" ] \
  && ok "a seeded session file is written at restrictive permissions" \
  || bad "session auth.json mode is not 600"

# A resumed box already signed in with a session has no OPENAI_API_KEY string in its
# auth.json, so the old "does this file mention the key" guard would have overwritten
# a live login on every reconnect. The guard is now "is there a file at all".
seed_out=$(seed_run "$SEED_CODEX" "$SHOME/codex-session" CODEX_AUTH_JSON='{"auth_mode":"chatgpt","tokens":{"access_token":"at-SECOND-RUN"}}')
{ printf '%s\n' "$seed_out" | grep -q "already authenticated" \
  && jq -e '.tokens.access_token == "at-borrowed"' "$SHOME/codex-session/.codex/auth.json" >/dev/null; } \
  && ok "a box already holding a session is left alone on the second run" \
  || bad "session seeding clobbered an existing login (out=$seed_out)"

# opencode's problem is an updater, not a wizard: it updates itself in the background
# and drops a modal over the pane whenever a release lands, which can be long after
# startup and right on top of the prompt a task is being typed into. The seeding turns
# that off — and must keep the rest of the file, because a model, providers and MCP
# servers live in it too.
SEED_OPENCODE=$(node "$ROOT/src/fleet-seed.js" opencode)
mkdir -p "$SHOME/opencode-cfg/.config/opencode"
printf '{"model":"anthropic/claude-opus-4-5","autoupdate":true,"mcp":{"x":1}}' \
  > "$SHOME/opencode-cfg/.config/opencode/opencode.json"
seed_out=$(seed_run "$SEED_OPENCODE" "$SHOME/opencode-cfg")
jq -e '.autoupdate == false and .model == "anthropic/claude-opus-4-5" and .mcp.x == 1' \
   "$SHOME/opencode-cfg/.config/opencode/opencode.json" >/dev/null \
  && ok "opencode's self-updater is switched off without disturbing the rest of its config" \
  || bad "opencode seeding (out=$seed_out, file=$(cat "$SHOME/opencode-cfg/.config/opencode/opencode.json"))"

# …and a box already carrying the switch is left alone, like every other seeding.
seed_out=$(seed_run "$SEED_OPENCODE" "$SHOME/opencode-cfg")
printf '%s\n' "$seed_out" | grep -q "leaving it alone" \
  && ok "opencode seeding is a no-op the second time" \
  || bad "opencode no-clobber (out=$seed_out)"

# End to end against the herdr stub. The seeding is NOT here — the box writes it over
# the SDK while it provisions — so what this asserts is the absence: a member comes up
# with nothing about its first-run state, and no key, ever handed to herdr. That is
# the property the whole thing moved off the pane to get.
printf '[templates.claude.env]\nANTHROPIC_API_KEY = "%s"\n' "$SEED_KEY" > "$ACFG/config.toml"
STUB_LOG="$TMP/stub-seed.log"; : > "$STUB_LOG"
STUB_AGENT=claude
out=$(spawn herdr-ok --slug seedlive -t claude); rc=$?
STUB_AGENT=""; STUB_LOG=""; rm -f "$ACFG/config.toml"
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -qx "1/1 up" \
  && ! grep -q 'ANTHROPIC_API_KEY' "$TMP/stub-seed.log" \
  && ! grep -q 'hasCompletedOnboarding' "$TMP/stub-seed.log" \
  && ! grep -q 'secret-head' "$TMP/stub-seed.log"; } \
  && ok "a member is driven without its seeding, or its key, ever reaching herdr" \
  || bad "live seeding (rc=$rc, log=$(cat "$TMP/stub-seed.log"), out=$out)"

{ [ "$(git -C "$FREPO" worktree list | wc -l | tr -d ' ')" = "1" ] \
  && [ -z "$(git -C "$FREPO" branch --list 'e2b/*')" ]; } \
  && ok "the spawn tests created no branch and no worktree" \
  || bad "the spawn tests created something: $(git -C "$FREPO" branch --list 'e2b/*')"

echo "── fleet: the board takes the pane BEFORE the members are away ──"
# A roster takes minutes and the pane that launched it is the worst place to spend
# them. The board must come up first and the members provision behind it, so what
# this asserts is that the dashboard ran while the per-member report went to the
# fleet log instead of the pane.
#
# Driven here through the legacy `--dashboard`, which is the point: the flag is no
# longer documented, but an installed herdr-plugin.toml still passes it and must
# keep landing on the board. (What a human gets — the pickers implying the board
# with no flag at all — needs a tty, and is asserted through a pty further down.)
DASH_MARK="$TMP/dash-ran"; rm -f "$DASH_MARK"
FAKE_DASH="$TMP/fake-dash"
printf '#!/usr/bin/env bash\nprintf started > "%s"\n' "$DASH_MARK" > "$FAKE_DASH"; chmod +x "$FAKE_DASH"
FLEET_LOG="$HERDR_PLUGIN_STATE_DIR/fleets/boarded.log"; rm -f "$FLEET_LOG"
out=$( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 HERDR_ENV=1 STUB_DELAY="$STUB_DELAY" \
       HERDR_PLUGIN_CONFIG_DIR="$ACFG" HERDR_E2B_DASH="$FAKE_DASH" \
       HERDR_E2B_FLEET_SHELL_WAIT=1 HERDR_E2B_FLEET_AGENT_WAIT=0 HERDR_E2B_FLEET_TASK_WAIT=0 \
       HERDR_BIN_PATH="$TMP/herdr-ok/herdr" \
       "$FLEET" --slug boarded -t claude --dashboard 2>&1 ); rc=$?
{ [ "$rc" -eq 0 ] && [ -f "$DASH_MARK" ]; } \
  && ok "--dashboard execs the board rather than waiting on the members" \
  || bad "--dashboard did not reach the board (rc=$rc, out=$out)"

# The header and the pointer belong in the pane; the report does not — the board
# owns the pane from the exec on, so anything printed after it would be painted over.
{ printf '%s\n' "$out" | grep -q "fleet 'boarded'" \
  && printf '%s\n' "$out" | grep -q "provisioning behind the board" \
  && ! printf '%s\n' "$out" | grep -q "1/1 up"; } \
  && ok "--dashboard prints the plan and the log path, never the per-member report" \
  || bad "--dashboard pane output (out=$out)"

# Detached, not dropped: the members still get provisioned and still get reported.
for _ in $(seq 1 50); do grep -q 'done (rc=' "$FLEET_LOG" 2>/dev/null && break; sleep 0.1; done
{ [ -f "$FLEET_LOG" ] \
  && grep -q "✓ boarded-claude" "$FLEET_LOG" \
  && grep -qx "1/1 up" "$FLEET_LOG" \
  && grep -q "done (rc=0)" "$FLEET_LOG"; } \
  && ok "the per-member report lands in the fleet log behind the board" \
  || bad "fleet log (log=$(cat "$FLEET_LOG" 2>/dev/null))"

# …and so does the unauthenticated-member warning. The pane carried it a moment
# before the exec, but the board then owns the screen for the whole provisioning
# run — which is precisely the window in which "this member will never start work"
# is worth reading. Behind the board, the log is the pane.
{ grep -q "will start unauthenticated" "$FLEET_LOG" \
  && grep -qE "boarded-claude +claude +ANTHROPIC_API_KEY" "$FLEET_LOG"; } \
  && ok "the sign-in warning reaches the fleet log too, not only the pane the board covers" \
  || bad "fleet log auth warning (log=$(cat "$FLEET_LOG" 2>/dev/null))"

echo "── bench: the launcher's refusals, and members found by branch ──"
# The Rust binary has its own tests; these cover the shell wrapper and the two
# refusals that must happen BEFORE anything reaches E2B. All offline: every path
# below returns before a single `e2b-box exec`.
BENCH="$ROOT/bin/e2b-bench"
BENCH_BIN="$ROOT/tui/target/release/e2b-bench"
if [ ! -x "$BENCH_BIN" ]; then
  skip "bench: e2b-bench not built (cd tui && cargo build --release)"
else
  BSTATE="$TMP/bench-state"; mkdir -p "$BSTATE/boxes"
  bench() { ( HERDR_PLUGIN_STATE_DIR="$BSTATE" "$BENCH" "$@" 2>&1 ); }

  out=$(bench); rc=$?
  { [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "no graded runs yet"; } \
    && ok "bench with nothing recorded → says so, exit 0" || bad "bench empty (rc=$rc, out=$out)"

  out=$(bench nosuch); rc=$?
  { [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "nothing recorded for 'nosuch'"; } \
    && ok "bench <unknown slug> → exit 1, names the slug" || bad "bench unknown (rc=$rc, out=$out)"

  # A slug matching no member must never read as a clean 0/0 run.
  out=$(bench nosuch --grade true); rc=$?
  { [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "no boxes belong to a fleet"; } \
    && ok "bench --grade with no members → refuses, never reports an empty pass" \
    || bad "bench no members (rc=$rc, out=$out)"

  for bad_flag in "--grade" "--timeout-ms"; do
    out=$(bench x "$bad_flag"); rc=$?
    { [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "e2b-bench: $bad_flag needs"; } \
      && ok "bench $bad_flag with no value → exit 2" || bad "bench $bad_flag (rc=$rc, out=$out)"
  done

  # Members come from the BRANCH, not from a stored list (ADR-0005) — and a member
  # whose box isn't up is refused before a command is spent, because a table of
  # 'box unreachable' is true and useless.
  printf '{"key":"b1","status":"ready","sandboxId":"s1","branch":"e2b/grademe-claude-ab12"}\n' > "$BSTATE/boxes/b1.json"
  printf '{"key":"b2","status":"provisioning","sandboxId":"s2","branch":"e2b/grademe-codex-ab12"}\n' > "$BSTATE/boxes/b2.json"
  out=$(bench grademe --grade true); rc=$?
  { [ "$rc" -eq 1 ] \
    && printf '%s' "$out" | grep -q "1 member(s) are not ready" \
    && printf '%s' "$out" | grep -q "grademe-codex" \
    && ! printf '%s' "$out" | grep -q "grademe-claude .*not ready"; } \
    && ok "bench refuses while a member is still provisioning, naming only that one" \
    || bad "bench not-ready guard (rc=$rc, out=$out)"

  # Nothing was recorded by a refused grade — no run.json, no results.
  [ ! -d "$BSTATE/bench/grademe" ] \
    && ok "a refused grade writes no run directory" \
    || bad "refused grade left $BSTATE/bench/grademe"
fi

echo "── fleet: down is a glob, and it keeps the branches ──"
# A fleet is a batch, not an entity (ADR-0001) — there is nothing to look up, so
# `down` globs `<prefix>/<slug>-*` over the local branches. That makes it the one
# verb that deletes on a pattern, so the fixture below deliberately parks
# look-alikes next to the real members: a neighbouring slug, a branch under the
# same namespace that isn't shaped like a member, and a member with no box.
#
# Everything here happens inside $TMP: fabricated repo, fabricated worktrees,
# fabricated box records with no sandboxId (so `e2b-box kill` clears the record
# without an SDK call). No real worktree is removed and no real box is killed.
# $FSTUB (a herdr that answers nothing) keeps the herdr probe failing, so removal
# goes through plain git rather than whatever herdr the runner has installed.
DREPO="$TMP/down-repo"; mkdir -p "$DREPO"
dgit() { git -C "$DREPO" -c user.email=t@t -c user.name=t "$@"; }
( cd "$DREPO" && git init -q -b main && printf 'v1\n' > f.txt \
  && git -c user.email=t@t -c user.name=t add -A \
  && git -c user.email=t@t -c user.name=t commit -qm init )
dgit worktree add -q "$TMP/dwt-claude" -b e2b/login-fix-claude-ab12
dgit worktree add -q "$TMP/dwt-codex"  -b e2b/login-fix-codex-cd34
dgit branch e2b/login-fix-grok-ef56       # a member whose checkout is already gone
dgit branch e2b/login-fix-notes           # same namespace, not a member's shape
dgit branch e2b/other-run-claude-gh78     # a different fleet entirely

# git's own idea of where a branch is checked out — the same lookup the verb
# does, so the fabricated record's worktreePath matches whatever git resolved.
dwt_path() {
  dgit worktree list --porcelain \
    | awk -v w="branch refs/heads/$1" '/^worktree /{p=substr($0,10)} $0==w{print p; exit}'
}
printf '{"key":"downbox","label":"dwt-claude","status":"ready","branch":"e2b/login-fix-claude-ab12","worktreePath":"%s"}\n' \
  "$(dwt_path e2b/login-fix-claude-ab12)" > "$HERDR_PLUGIN_STATE_DIR/boxes/downbox.json"

# The verb is `kill`, matching `e2b-box kill`. Everything below drives it that way.
down() { ( cd "$DREPO" && HERDR_BIN_PATH="$FSTUB" "$FLEET" kill "$@" 2>&1 ); }

# `down` is what shipped, so it keeps working — unadvertised, but not broken for
# anyone who put it in a script.
alias_out=$( cd "$DREPO" && HERDR_BIN_PATH="$FSTUB" "$FLEET" down login-fix --dry-run 2>&1 )
printf '%s\n' "$alias_out" | grep -q "member(s) match" \
  && ok "the old \`down\` verb still tears a fleet down" \
  || bad "down alias no longer works (out=$alias_out)"

# One CLI: `e2b-box fleet …` is the way in, and everything it prints has to name
# itself that way — a tool that tells you to run a command you did not type is one
# you stop trusting. The roster matters here too: e2b-box has its own `-t` parser,
# and it must not swallow the two templates meant for the fleet.
out=$( cd "$FREPO" && HERDR_E2B_FLEET_RAND=ab12 env -u HERDR_WORKSPACE_ID \
       "$ROOT/bin/e2b-box" fleet --dry-run -s viabox -t claude -t codex 2>&1 ); rc=$?
{ [ "$rc" -eq 0 ] \
  && [ "$(printf '%s\n' "$out" | grep -c '^  member ')" -eq 2 ] \
  && printf '%s\n' "$out" | grep -q 'member viabox-claude' \
  && printf '%s\n' "$out" | grep -q 'member viabox-codex'; } \
  && ok "e2b-box fleet passes a whole roster through — its own -t parser doesn't eat it" \
  || bad "e2b-box fleet roster passthrough (rc=$rc, out=$out)"

out=$( cd "$FREPO" && "$ROOT/bin/e2b-box" fleet 2>&1 ); rc=$?
{ [ "$rc" -ne 0 ] \
  && printf '%s\n' "$out" | grep -q 'e2b-box fleet' \
  && ! printf '%s\n' "$out" | grep -qE '(^|[^-])e2b-fleet'; } \
  && ok "invoked as e2b-box fleet, it never tells you to run e2b-fleet" \
  || bad "fleet CLI naming (rc=$rc, out=$out)"

out=$(down login-fix --dry-run); rc=$?
{ [ "$rc" -eq 0 ] \
  && [ "$(printf '%s\n' "$out" | grep -c '^  member e2b/login-fix-')" -eq 3 ] \
  && printf '%s\n' "$out" | grep -q "member e2b/login-fix-grok-ef56" \
  && ! printf '%s\n' "$out" | grep -q "member e2b/other-run" \
  && ! printf '%s\n' "$out" | grep -q "member e2b/login-fix-notes"; } \
  && ok "down globs <prefix>/<slug>-* — 3 members, no neighbouring slug, no stray" \
  || bad "down glob (rc=$rc, out=$out)"

printf '%s\n' "$out" | grep -q "not shaped like fleet members" \
  && printf '%s\n' "$out" | grep -q "· e2b/login-fix-notes" \
  && ok "a branch under the namespace that isn't a member's shape is named and left alone" \
  || bad "stray branch not reported (out=$out)"

# The box goes through `e2b-box kill` and the worktree through a real removal —
# neither is reimplemented here, and the dry run is where you can see that.
{ printf '%s\n' "$out" | grep -q "KEY=downbox $ROOT/bin/e2b-box kill" \
  && printf '%s\n' "$out" | grep -q "git worktree remove $(dwt_path e2b/login-fix-codex-cd34)" \
  && printf '%s' "$out" | grep -q "dry run — nothing was removed"; } \
  && ok "down --dry-run prints the box kill and the worktree removal it would run" \
  || bad "down dry-run plan (out=$out)"



{ [ "$(dgit worktree list | wc -l | tr -d ' ')" = "3" ] \
  && [ "$(dgit for-each-ref --format='%(refname:short)' 'refs/heads/e2b/*' | wc -l | tr -d ' ')" = "5" ] \
  && [ -f "$HERDR_PLUGIN_STATE_DIR/boxes/downbox.json" ] \
  && [ -d "$TMP/dwt-claude" ]; } \
  && ok "down --dry-run removed nothing — worktrees, branches and the box record all still there" \
  || bad "down --dry-run removed something"

# A member booted from a namespaced template is named by the template's LAST
# segment, so its branch is e2b/<slug>-herdr-agents-<rand4>, not
# e2b/<slug>-ondrejs-project-herdr-agents-<rand4>. Teardown globs on
# <prefix>/<slug>- and shape-checks the -<rand4> tail, so it still matches — but
# nothing pinned that, and the naming change is exactly what could break it.
dgit branch e2b/ns-run-herdr-agents-ij90
out=$(down ns-run --dry-run); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "member e2b/ns-run-herdr-agents-ij90" \
  && ! printf '%s\n' "$out" | grep -q "not shaped like fleet members"; } \
  && ok "down still finds a member booted from a namespaced template" \
  || bad "down namespaced member (rc=$rc, out=$out)"


out=$(down no-such-fleet); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "no members match e2b/no-such-fleet-\*"; } \
  && ok "a slug matching nothing says so and exits 0" || bad "empty match (rc=$rc, out=$out)"

out=$(down login-fix); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "✓ e2b/login-fix-claude-ab12 — box killed, worktree removed, branch kept" \
  && printf '%s\n' "$out" | grep -qx "3/3 torn down" \
  && [ ! -f "$HERDR_PLUGIN_STATE_DIR/boxes/downbox.json" ] \
  && [ ! -d "$TMP/dwt-claude" ] && [ ! -d "$TMP/dwt-codex" ]; } \
  && ok "down kills each member's box and removes each member's worktree" \
  || bad "down teardown (rc=$rc, out=$out)"

# A member whose box is already gone must not wedge the command — its worktree
# still goes, and the run still succeeds.
{ printf '%s\n' "$out" | grep -q "✓ e2b/login-fix-codex-cd34 — box already gone, worktree removed" \
  && printf '%s\n' "$out" | grep -q "✓ e2b/login-fix-grok-ef56 — box already gone, worktree already gone"; } \
  && ok "a member with no box (or no checkout) is still cleaned up and still counts as up" \
  || bad "already-gone member (out=$out)"

# The branches are the only thing the run produced, so they survive — and the
# summary has to SAY so rather than leave it to be discovered.
{ [ "$(dgit for-each-ref --format='%(refname:short)' 'refs/heads/e2b/login-fix-*' | wc -l | tr -d ' ')" = "4" ] \
  && printf '%s\n' "$out" | grep -q "branches kept — the only thing the run produced" \
  && printf '%s\n' "$out" | grep -qx "  e2b/login-fix-grok-ef56" \
  && printf '%s\n' "$out" | grep -q -- "--prune-branches"; } \
  && ok "branches survive by default and the summary lists every one it kept" \
  || bad "branches not kept/printed (out=$out)"

echo "── fleet: --prune-branches refuses commits that exist nowhere else ──"
# Two members off the same base: one that never committed (deleting its branch
# loses nothing) and one holding a commit that is on no other ref at all.
dgit branch e2b/prune-me-claude-ab12
dgit worktree add -q "$TMP/dwt-work" -b e2b/prune-me-codex-cd34
( cd "$TMP/dwt-work" && printf 'agent work\n' > f.txt \
  && git -c user.email=t@t -c user.name=t commit -qam "work only this branch has" )

out=$(down prune-me --prune-branches); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "e2b/prune-me-claude-ab12 — .*branch deleted (merged into HEAD)" \
  && [ -z "$(dgit for-each-ref --format='%(refname:short)' 'refs/heads/e2b/prune-me-claude-*')" ]; } \
  && ok "--prune-branches deletes a branch whose commits are already in the base" \
  || bad "--prune-branches on a merged branch (rc=$rc, out=$out)"

{ printf '%s\n' "$out" | grep -q "e2b/prune-me-codex-cd34 — .*branch KEPT: it holds commits that exist nowhere else" \
  && printf '%s\n' "$out" | grep -q "branches kept because they hold commits that exist nowhere else" \
  && printf '%s\n' "$out" | grep -q -- "--prune-branches --force" \
  && [ -n "$(dgit for-each-ref --format='%(refname:short)' 'refs/heads/e2b/prune-me-codex-*')" ]; } \
  && ok "--prune-branches refuses a branch holding unique commits and names the escape hatch" \
  || bad "--prune-branches did not refuse unique commits (out=$out)"

out=$(down prune-me --prune-branches --force); rc=$?
{ [ "$rc" -eq 0 ] \
  && printf '%s\n' "$out" | grep -q "branch deleted (forced)" \
  && [ -z "$(dgit for-each-ref --format='%(refname:short)' 'refs/heads/e2b/prune-me-*')" ]; } \
  && ok "--force deletes the branch the refusal was protecting" \
  || bad "--prune-branches --force (rc=$rc, out=$out)"

# Nothing outside the globbed fleets was ever a candidate.
{ [ -n "$(dgit for-each-ref --format='%(refname:short)' 'refs/heads/e2b/other-run-claude-gh78')" ] \
  && [ -n "$(dgit for-each-ref --format='%(refname:short)' 'refs/heads/e2b/login-fix-notes')" ]; } \
  && ok "a neighbouring fleet and a non-member branch survived every down" \
  || bad "down deleted something outside its glob"

echo "── behavior: cluster mismatch names machine-neutral remedies ──"
# The domain-pinned-box guard in provision.js throws BEFORE any SDK call, so a
# crafted record (box on one cluster, credentials resolving to another) provokes
# it offline. provision.js reports a failure through the record's `step` — what
# the dashboard and `e2b-box logs` show the user — so assert there.
mkdir -p "$TMP/home/.config"
mismatch_step() { # $1 = E2B_DOMAIN for the run ("" → key's cluster unknowable)
  printf '{"key":"clusterbox","label":"repo","status":"ready","sandboxId":"idummy","domain":"e2b-juliett.dev","projectPath":"/home/user/project"}\n' \
    > "$HERDR_PLUGIN_STATE_DIR/boxes/clusterbox.json"
  # Fabricated $HOME/$XDG_CONFIG_HOME: no `e2b auth login` and no plugin config,
  # so only the env below resolves the cluster. HERDR_PLUGIN_ID is unset because
  # the daemon marker demotes env below those (now absent) sources.
  ( cd "$REPO" && env -u E2B_DOMAIN -u HERDR_PLUGIN_ID ${1:+E2B_DOMAIN="$1"} \
      HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/home/.config" \
      E2B_API_KEY=e2b_dummy KEY=clusterbox "$E2B" sync >/dev/null 2>&1 )
  jq -r '.step' "$HERDR_PLUGIN_STATE_DIR/boxes/clusterbox.json"
}

step=$(mismatch_step "e2b.dev")
{ printf '%s' "$step" | grep -q "resolves to e2b.dev" \
  && printf '%s' "$step" | grep -q 'e2b auth login` against e2b-juliett.dev' \
  && printf '%s' "$step" | grep -q 'export E2B_DOMAIN=e2b-juliett.dev' \
  && printf '%s' "$step" | grep -q '\[sandbox\] region = "eu"' \
  && printf '%s' "$step" | grep -q 'e2b-box kill'; } \
  && ok "a box in another region → login/env/region/kill remedies" \
  || bad "known-but-different cluster remedies (step=$step)"

step=$(mismatch_step "")
{ printf '%s' "$step" | grep -q "cluster is unknown" \
  && printf '%s' "$step" | grep -q 'e2b auth login` against e2b-juliett.dev' \
  && printf '%s' "$step" | grep -q 'export E2B_DOMAIN=e2b-juliett.dev' \
  && printf '%s' "$step" | grep -q '\[sandbox\] region = "eu"' \
  && printf '%s' "$step" | grep -q 'e2b-box kill'; } \
  && ok "an unknown region → login/env/region/kill remedies" \
  || bad "unknown cluster remedies (step=$step)"

# `e2b-region` is one developer's personal zsh function; it exists on no other
# machine, so it must never reach runtime code or anything a user reads.
hits=$(grep -rIl "e2b-region" "$ROOT/bin" "$ROOT/src" "$ROOT/tui" "$ROOT/config" \
  "$ROOT/docs" "$ROOT/install.sh" "$ROOT/README.md" 2>/dev/null)
[ -z "$hits" ] && ok "no 'e2b-region' in runtime code or user-facing text" \
  || bad "'e2b-region' leaked into: $(printf '%s' "$hits" | tr '\n' ' ')"

echo "── installer: release-asset fetch ──"
# install.sh's download path, exercised without running the installer (which
# links into ~/.local/bin). Sourcing just the helpers keeps this offline and
# side-effect free; the network cases assert only that failure is CLEAN.
inst_helpers() {
  DIR="$ROOT" CANONICAL_REPO="tomasvarga/herdr-e2b"
  eval "$(sed -n '/^release_repos() {/,/^}$/p;/^plugin_version() {/,/^}$/p;/^fetch_asset() {/,/^}$/p' "$ROOT/install.sh")"
}

( inst_helpers
  v=$(plugin_version)
  man=$(grep -E '^version' "$ROOT/herdr-plugin.toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
  [ -n "$v" ] && [ "$v" = "$man" ]
) && ok "plugin_version matches the manifest" || bad "plugin_version"

( inst_helpers
  # The canonical repo is always a candidate, so a fork with no releases still
  # resolves a binary; an override replaces the list entirely.
  release_repos | tail -1 | grep -qx "tomasvarga/herdr-e2b" \
    && [ "$(HERDR_E2B_RELEASE_REPO=me/mine release_repos)" = "me/mine" ]
) && ok "release_repos: canonical last, env overrides" || bad "release_repos"

( inst_helpers
  # Unresolvable host: must decline non-zero AND leave no partial file behind —
  # a half-written 'binary' would be installed and then fail to exec.
  out="$TMP/dash-dl"
  HERDR_E2B_RELEASE_REPO="unreachable-host-xyz/nope" fetch_asset e2b-dash-darwin-universal "$out" 2>/dev/null
  [ $? -ne 0 ] && [ ! -e "$out" ]
) && ok "fetch_asset: unreachable release → declines, no partial file" || bad "fetch_asset unreachable"

echo "── installer: harness discovery on first run ──"
# install.sh's harness_discovery, lifted out the same way fetch_asset is above —
# running the real installer would link into ~/.local/bin and rebuild the TUI.
# Driven against a STUB e2b-box for the contract assertions (what is called, with
# which flags, and what a failure does), because none of those may depend on what
# this machine happens to have installed. The real CLI is used once, at the end,
# for the one claim a stub cannot make.
# Run it the way install.sh does — under the installer's own shell options. Not
# decoration: `harness_discovery` ends in an `echo`, so it returns 0 whatever
# happened, and an rc assertion outside `set -e` is unfalsifiable. Inside it, a
# non-zero anywhere in the function aborts before the trailing `echo reached`, so
# `reached` in the output is the real claim "this would not have failed an
# install". Every case below is run through here for that reason.
run_discovery() (
  set -euo pipefail
  eval "$(sed -n '/^harness_discovery() {/,/^}$/p' "$ROOT/install.sh")"
  harness_discovery "$@" 2>&1
  echo "reached"
)

STUB="$TMP/stub-e2b-box"
cat > "$STUB" <<'SH'
#!/usr/bin/env bash
{ printf 'argv=%s\n' "$*"; printf 'cfgdir=%s\n' "${HERDR_PLUGIN_CONFIG_DIR:-}"; } >> "$DISC_LOG"
printf '%s\n' "${STUB_OUT:-2 of 7 harnesses have a credential this plugin can see.}"
exit "${STUB_RC:-0}"
SH
chmod +x "$STUB"

# A fresh machine: discovery runs, and it runs the subcommand rather than
# reimplementing it. --yes is the whole reason a build step with no TTY gets a
# file at all, so it is asserted literally.
d="$TMP/disc-fresh"; mkdir -p "$d"
# Its own name: STUB_LOG above belongs to the herdr stub and is still live.
export DISC_LOG="$TMP/disc-calls.log"; : > "$DISC_LOG"
out=$( run_discovery "$d" "$STUB" )
{ printf '%s' "$out" | grep -qx reached && grep -qx "argv=auth --yes" "$DISC_LOG"; } \
  && ok "first run calls 'e2b-box auth --yes'" || bad "first-run discovery (log=$(cat "$DISC_LOG"), out=$out)"
grep -qx "cfgdir=$d" "$DISC_LOG" \
  && ok "discovery writes into the config dir the installer reported" || bad "discovery config dir ($(cat "$DISC_LOG"))"
printf '%s' "$out" | grep -q "^  2 of 7 harnesses" \
  && ok "the installer reports what discovery found, in its own indented style" || bad "discovery report not relayed (out=$out)"
printf '%s' "$out" | grep -q "re-run 'e2b-box auth' after installing a new harness" \
  && ok "the installer says how to re-run discovery later" || bad "no re-run hint (out=$out)"

# A machine with nothing installed is not an error, it is a finding.
d="$TMP/disc-empty"; mkdir -p "$d"; : > "$DISC_LOG"
out=$( STUB_OUT="0 of 7 harnesses have a credential this plugin can see." run_discovery "$d" "$STUB" )
{ printf '%s' "$out" | grep -qx reached && printf '%s' "$out" | grep -q "0 of 7 harnesses"; } \
  && ok "no harnesses installed → reported, install still succeeds" || bad "empty machine (out=$out)"

# The claim the ticket turns on: discovery may not fail the install. A crashing
# subcommand, a missing Node, every probe timing out — all arrive here, and under
# `set -e` an unguarded non-zero assignment would abort before `reached` is
# printed. That word is the assertion; the reported text is the courtesy.
d="$TMP/disc-fail"; mkdir -p "$d"; : > "$DISC_LOG"
out=$( STUB_RC=1 STUB_OUT="needs Node >= 22" run_discovery "$d" "$STUB" )
printf '%s' "$out" | grep -qx reached \
  && ok "a discovery failure does not abort a 'set -e' install" || bad "set -e aborts on discovery failure (out=$out)"
printf '%s' "$out" | grep -q "discovery did not finish" \
  && ok "a discovery failure is reported rather than swallowed" || bad "discovery failure unreported (out=$out)"
printf '%s' "$out" | grep -q "needs Node >= 22" \
  && ok "a failed discovery still shows what the subcommand said" || bad "failure output swallowed (out=$out)"

# Re-running the installer on a configured machine: the generated file has one
# writer, and re-install is not it.
d="$TMP/disc-again"; mkdir -p "$d"; printf 'stale\n' > "$d/auth.toml"; : > "$DISC_LOG"
out=$( run_discovery "$d" "$STUB" )
{ printf '%s' "$out" | grep -qx reached && [ ! -s "$DISC_LOG" ] && [ "$(cat "$d/auth.toml")" = "stale" ]; } \
  && ok "re-install with an auth.toml already there probes nothing and rewrites nothing" \
  || bad "re-install re-ran discovery (log=$(cat "$DISC_LOG"), out=$out)"
printf '%s' "$out" | grep -q "already discovered" \
  && ok "re-install says the credentials are already discovered" || bad "no already-discovered line (out=$out)"

# One secret is asked for by this installer and it is the E2B key. A harness
# credential is DISCOVERED or pasted into config.toml by hand — never prompted
# for here, where it would land in a file this script does not own. Asserted
# against the source because the property IS "this script contains no second
# prompt"; running the installer to find out would link into ~/.local/bin.
reads=$(grep -cE '^[[:space:]]*read([[:space:]]|$)' "$ROOT/install.sh")
[ "$reads" = "1" ] && ok "the installer prompts for exactly one secret (the E2B key)" \
  || bad "install.sh has $reads read prompts — a harness credential prompt crept in"

# The one claim a stub cannot make. The block above proves the installer never
# CREATES a config.toml; this proves it never edits one that was already there,
# which is the ticket's "does not clobber the user's own config" and the only
# reason to pay for a real probe sweep here. Compared with `cmp` against a saved
# copy rather than a hash: a hash tool missing from the preflight would compare
# "" with "" and pass silently, which is the worst way for this to be wrong.
# auth.toml's mode is asserted once already, against the verb itself — this path
# runs the same binary, so re-asserting it would buy nothing.
d="$TMP/disc-real"; mkdir -p "$d"
printf '[sandbox]\ntemplate = "mine"\n' > "$d/config.toml"
cp "$d/config.toml" "$TMP/disc-real-config.before"
out=$( run_discovery "$d" "$E2B" </dev/null )
{ printf '%s' "$out" | grep -qx reached && cmp -s "$d/config.toml" "$TMP/disc-real-config.before"; } \
  && ok "installer-driven discovery never touches the user's own config.toml" \
  || bad "config.toml changed during discovery (out=$out)"
[ -f "$d/auth.toml" ] \
  && ok "the real subcommand ran through the installer and left its generated file" \
  || bad "no auth.toml after install-time discovery (out=$out)"
unset DISC_LOG

echo "── environment: a user's exported CDPATH must not break path resolution ──"
# bash's `cd` PRINTS the resolved dir when CDPATH is set, so an unguarded
# ROOT="$(cd … && pwd)" captures two lines and every path built from it points at
# nothing. Real symptom: `$PLUGIN_DIR/src/*.js` "Cannot find module".
out=$(CDPATH="$TMP:$HOME" KEY=nobox "$E2B" status 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && ! printf '%s' "$out" | grep -q "Cannot find module"; } \
  && ok "status survives an exported CDPATH" || bad "CDPATH breaks path resolution (rc=$rc, out=$out)"

echo "── parser: pane-parse.js, the dash-toggle's contract with herdr ──"
# The toggle runs from a keybinding, where a crash is invisible and a short line
# silently leaves `read -r focus_pane pane_pane tab_list` holding stale values.
# So the contract is asserted literally: one line, three space-separated fields,
# "-" for every absent value — including when herdr says nothing usable at all.
PARSE="$ROOT/src/pane-parse.js"
TITLE="e2b dashboard"
parses() {
  local name="$1" json="$2" want="$3" got
  got=$(printf '%s' "$json" | node "$PARSE" panes "$TITLE" 2>/dev/null)
  [ "$got" = "$want" ] && ok "$name" || bad "$name (want '$want', got '$got')"
}

parses "focused pane + tab mate + dashboard pane → all three fields" \
  '{"result":{"panes":[
     {"pane_id":"p1","tab_id":"t1","focused":true},
     {"pane_id":"p2","tab_id":"t1"},
     {"pane_id":"p9","tab_id":"t2","label":"e2b dashboard"}]}}' \
  'p1 p9 p1,p2'
parses "no dashboard pane → middle field is '-'" \
  '{"result":{"panes":[{"pane_id":"p1","tab_id":"t1","focused":true}]}}' \
  'p1 - p1'
parses "no focused pane → focus and tab list are '-', dashboard still found" \
  '{"result":{"panes":[{"pane_id":"p9","tab_id":"t2","label":"e2b dashboard"}]}}' \
  '- p9 -'
parses "empty pane list → all placeholders" '{"result":{"panes":[]}}' '- - -'
parses "malformed JSON → all placeholders" 'not json at all' '- - -'
parses "empty input (herdr not running) → all placeholders" '' '- - -'

got=$(printf '%s' '{"result":{"process_info":{"foreground_processes":[{"name":"zsh"},{"name":"claude"}]}}}' \
  | node "$PARSE" procs 2>/dev/null | tr '\n' ',')
[ "$got" = "zsh,claude," ] && ok "procs → one process name per line" || bad "procs (got '$got')"

got=$(printf '%s' '{"result":{}}' | node "$PARSE" procs 2>/dev/null); rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$got" ]; } \
  && ok "procs with no process info → silence, exit 0 (pane counts as busy)" \
  || bad "procs with no process info (rc=$rc, got '$got')"

# python3 on a fresh Mac is a Command Line Tools stub that pops a GUI installer.
grep -q python3 "$ROOT/bin/e2b-dash-toggle" \
  && bad "e2b-dash-toggle still references python3" \
  || ok "e2b-dash-toggle references no python3"
echo "── discovery: node version managers ──"
PATHS_LIB="$ROOT/bin/lib/paths.sh"
REAL_NODE="$(command -v node)"
# process.versions.node is non-writable, so a stub can't just assign it — but it
# IS configurable. Redefining it lets each stub run the REAL discovery JS while
# claiming a fabricated version, instead of mocking the version check away.
FAKEVER="$TMP/fakever.js"
cat > "$FAKEVER" <<'JS'
Object.defineProperty(process.versions, 'node', { value: process.env.STUB_NODE_VERSION, configurable: true })
JS

# stub_node <path> <version> — an executable that behaves like node <version>.
stub_node() {
  mkdir -p "$(dirname "$1")"
  printf '#!/usr/bin/env bash\nSTUB_NODE_VERSION=%s exec %s -r %s "$@"\n' "$2" "$REAL_NODE" "$FAKEVER" > "$1"
  chmod +x "$1"
}
# An old node on PATH: the real-world trigger for fallback discovery (herdr's
# daemon launches under v20), and it stops the runner's own node from answering.
stub_node "$TMP/oldnode/node" 18.20.0
mkdir -p "$TMP/nosys"

# Resolve e2b_node against a fabricated $HOME with the system probe dirs aimed at
# an empty tree, so ONLY the fabricated version-manager layout can satisfy it.
discover_node() {
  ( export HOME="$1" HERDR_E2B_SYS_BIN_DIRS="$TMP/nosys" PATH="$TMP/oldnode:$PATH"
    unset HERDR_E2B_NODE XDG_DATA_HOME
    source "$PATHS_LIB" 2>/dev/null
    e2b_node )
}

# One fabricated home per layout: mise, fnm (XDG + macOS), volta, asdf, nvm.
while IFS='|' read -r name rel; do
  [ -n "$name" ] || continue
  H="$TMP/home-$name"; stub_node "$H/$rel" 22.11.0
  got=$(discover_node "$H")
  [ "$got" = "$H/$rel" ] \
    && ok "discovery finds $name node" || bad "discovery misses $name node (got '$got')"
done <<'LAYOUTS'
mise|.local/share/mise/installs/node/22.11.0/bin/node
fnm-xdg|.local/share/fnm/node-versions/v22.11.0/installation/bin/node
fnm-macos|Library/Application Support/fnm/node-versions/v22.11.0/installation/bin/node
volta|.volta/bin/node
asdf|.asdf/installs/nodejs/22.11.0/bin/node
nvm|.nvm/versions/node/v22.11.0/bin/node
LAYOUTS

# Glob order is lexicographic (v9 sorts after v22), so "newest" has to come from
# comparing versions, not from whichever candidate the loop happened to see last.
H="$TMP/home-newest"
stub_node "$H/.local/share/mise/installs/node/22.11.0/bin/node" 22.11.0
stub_node "$H/.asdf/installs/nodejs/24.3.1/bin/node" 24.3.1
stub_node "$H/.nvm/versions/node/v9.11.2/bin/node" 9.11.2
got=$(discover_node "$H")
[ "$got" = "$H/.asdf/installs/nodejs/24.3.1/bin/node" ] \
  && ok "newest qualifying node wins across managers" || bad "newest node not chosen (got '$got')"

# Sub-22 candidates must stay rejected — extra probes must not widen the gate.
H="$TMP/home-toolold"; stub_node "$H/.volta/bin/node" 20.19.0
got=$(discover_node "$H"); rc=$?
{ [ "$rc" -ne 0 ] && [ -z "$got" ]; } \
  && ok "node < 22 in a manager dir is rejected" || bad "sub-22 node accepted (rc=$rc, got='$got')"

# The distro path can't be fabricated, so assert it's in the probe list itself.
cands=$( unset XDG_DATA_HOME; source "$PATHS_LIB" 2>/dev/null; e2b_bin_candidates node )
printf '%s\n' "$cands" | grep -qx '/usr/bin/node' \
  && ok "distro /usr/bin/node is probed" || bad "distro /usr/bin/node not probed"

# The e2b CLI gets the same probes: node in one layout, the CLI in another, so
# this exercises the fallback loop rather than the node-and-CLI-share-a-dir case.
H="$TMP/home-e2bcli"
stub_node "$H/.local/share/mise/installs/node/22.11.0/bin/node" 22.11.0
mkdir -p "$H/.asdf/installs/nodejs/22.11.0/bin"
printf '#!/bin/sh\necho stub-e2b\n' > "$H/.asdf/installs/nodejs/22.11.0/bin/e2b"
chmod +x "$H/.asdf/installs/nodejs/22.11.0/bin/e2b"
got=$( export HOME="$H" HERDR_E2B_SYS_BIN_DIRS="$TMP/nosys" PATH="$TMP/oldnode:/usr/bin:/bin"
       unset HERDR_E2B_NODE XDG_DATA_HOME
       source "$PATHS_LIB" 2>/dev/null
       ensure_e2b_path && command -v e2b )
[ "$got" = "$H/.asdf/installs/nodejs/22.11.0/bin/e2b" ] \
  && ok "ensure_e2b_path finds an asdf-installed e2b CLI" || bad "e2b CLI not found in manager dir (got '$got')"

echo "── discovery: giving up names the override ──"
H="$TMP/home-empty"; mkdir -p "$H"
got=$(discover_node "$H"); rc=$?
{ [ "$rc" -ne 0 ] && [ -z "$got" ]; } \
  && ok "no candidate → e2b_node fails" || bad "e2b_node succeeded with no candidate (got '$got')"

# ...and the user sees the escape hatch at the moment discovery fails.
out=$( export HOME="$H" HERDR_E2B_SYS_BIN_DIRS="$TMP/nosys" PATH="$TMP/oldnode:$PATH"
       unset HERDR_E2B_NODE XDG_DATA_HOME
       KEY=nobox "$E2B" sync 2>&1 ); rc=$?
{ [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "HERDR_E2B_NODE"; } \
  && ok "sync with no usable node → message names HERDR_E2B_NODE" \
  || bad "sync give-up message (rc=$rc, out=$out)"

echo "── chooser: both pickers, driven through a real pty ──"
# bin/lib/chooser.sh only ever runs on a terminal, so the only honest way to
# cover it is to give it one: a forked pty, keystrokes written in, the chosen
# value read back off stdout. This is the module's first coverage beyond a lint,
# and it guards the extraction (`ask_template_tty` must behave exactly as it did
# inside e2b-box) as much as the multi-select added beside it.
#
# python3 is used ONLY here, only for pty.fork, and never on the plugin's own
# runtime path — bin/ has no python dependency and must not grow one.
pty_python() {
  local py; py=$(command -v python3 2>/dev/null) || return 1
  [ -n "$py" ] || return 1
  # /usr/bin/python3 on macOS is a Command Line Tools SHIM. On a machine without
  # CLT, RUNNING it pops a GUI installer or dies in xcrun — so decide by
  # inspection first and only execute something we already believe is real.
  if [ "$(uname -s)" = Darwin ] && [ "$py" = /usr/bin/python3 ]; then
    local dev; dev=$(xcode-select -p 2>/dev/null) || return 1
    [ -n "$dev" ] && [ -x "$dev/usr/bin/python3" ] || return 1
  fi
  "$py" -c 'import pty, select' >/dev/null 2>&1 || return 1
  printf '%s' "$py"
}

if PY=$(pty_python); then
  cat > "$TMP/ptycheck.py" <<'PYCHECK'
import os, pty, select, sys, time

REPO, OUT, BASH = sys.argv[1], sys.argv[2], sys.argv[3]
CHOOSER = REPO + "/bin/lib/chooser.sh"
MENU = "\"$(printf 'claude\\ncodex\\nbase')\""

def drain(fd, quiet=0.05, limit=4.0, sink=None):
    """Read until the child has been silent long enough to have finished its
    redraw (keeps the whole sweep about a second instead of a fixed sleep per
    keystroke), or until it closes the pty. `sink` collects what was drawn, which
    is the only way to assert on a picker's SCREEN rather than on what it returned."""
    end = time.time() + limit
    last = time.time()
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.03)
        if r:
            try:
                chunk = os.read(fd, 65536)
                if not chunk:
                    return False
            except OSError:
                return False
            if sink is not None:
                sink.append(chunk)
            last = time.time()
        elif time.time() - last > quiet:
            return True
    return True

def run(script, keys, sink=None):
    if os.path.exists(OUT):
        os.remove(OUT)
    pid, fd = pty.fork()
    if pid == 0:
        os.execv(BASH, [BASH, "-c", "source %s; %s" % (CHOOSER, script)])
    drain(fd, sink=sink)
    for k in keys:
        os.write(fd, k)
        drain(fd, sink=sink)
    deadline = time.time() + 6
    while time.time() < deadline:
        if os.waitpid(pid, os.WNOHANG)[0]:
            break
        if not drain(fd, quiet=0.1, limit=0.4, sink=sink):
            break
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except (ChildProcessError, OSError):
        pass
    try:
        with open(OUT) as f:
            return f.read().strip()
    except OSError:
        return "<no output>"

def call(expr, prefix=""):
    # The result is captured the way the CLIs capture it (stdout), so the UI has
    # to have gone to /dev/tty — which is exactly the property worth proving.
    return '%sout=$(%s); rc=$?; printf "%%s|rc=%%s\\n" "$out" "$rc" > "%s"' % (prefix, expr, OUT)

PICK = call("ask_template_tty demo codex %s 3" % MENU)
# The same menu with the auth annotations `e2b-box auth` discovered, one line per
# row: a forwarded name, a stored value, and a template with nothing found — which
# is the third state and must draw no mark at all.
MARKS = "\"$(printf 'key (env)\\nkey (file)\\n')\""
PICKANN = call("ask_template_tty demo codex %s 3 %s" % (MENU, MARKS))
ROST = call("ask_roster_tty demo %s 3 codex" % MENU)
VALID = 'alnum() { case "$1" in *[a-zA-Z0-9]*) return 0;; esac; return 1; }; '
SLUG = call("ask_slug_tty '' alnum", VALID)
# The same screen with the optional fleet-task field on. Two lines come back —
# the slug, then the task — so an empty task is an empty second line, which the
# capture below strips exactly as the caller's own $(…) does.
SLUGTASK = call("ask_slug_tty '' alnum task", VALID)

cases = [
    ("single: enter takes the resolved default row, not row 1", PICK, [b"\r"], "codex|rc=0"),
    # Annotating must not change what the picker RETURNS — same keys, same answer.
    ("single: an annotated menu still returns the row you took", PICKANN, [b"\r"], "codex|rc=0"),
    ("single: an unannotated row is still selectable", PICKANN, [b"3"], "base|rc=0"),
    ("single: j moves down",                     PICK, [b"j", b"\r"], "base|rc=0"),
    ("single: k moves up",                       PICK, [b"k", b"\r"], "claude|rc=0"),
    ("single: a number jumps straight to a row", PICK, [b"1"], "claude|rc=0"),
    # q and esc ABORT — they used to take the default, which booted a sandbox the
    # user never chose from a keypress that means "get me out of here".
    ("single: q aborts, choosing nothing",       PICK, [b"q"], "|rc=2"),
    ("single: down arrow moves down",            PICK, [b"\x1b[B", b"\r"], "base|rc=0"),
    ("single: up arrow wraps around",            PICK, [b"\x1b[A", b"\x1b[A", b"\r"], "base|rc=0"),
    ("single: bare esc aborts, choosing nothing", PICK, [b"\x1b"], "|rc=2"),
    ("roster: enter launches the pre-ticked default roster", ROST, [b"\r"], "codex|rc=0"),
    ("roster: space unticks, and an empty roster can't launch",
     ROST, [b" ", b"\r", b" ", b"\r"], "codex|rc=0"),
    ("roster: space ticks a second template",    ROST, [b"j", b" ", b"\r"], "codex\nbase|rc=0"),
    ("roster: a number toggles that row",        ROST, [b"1", b"\r"], "claude\ncodex|rc=0"),
    ("roster: q aborts, choosing nothing",       ROST, [b"q"], "|rc=2"),
    ("roster: bare esc aborts",                  ROST, [b"\x1b"], "|rc=2"),
    ("slug: typed text comes back raw",          SLUG,
     [b"L", b"o", b"g", b"i", b"n", b" ", b"F", b"i", b"x", b"\r"], "Login Fix|rc=0"),
    ("slug: backspace deletes",                  SLUG, [b"a", b"b", b"\x7f", b"c", b"\r"], "ac|rc=0"),
    ("slug: text that sanitizes to nothing is refused",
     SLUG, [b"!", b"\r", b"a", b"\r"], "!a|rc=0"),
    ("slug: esc aborts",                         SLUG, [b"\x1b"], "|rc=2"),
    ("slug+task: the task field is optional — enter with it empty sends nothing",
     SLUGTASK, [b"a", b"\r"], "a|rc=0"),
    ("slug+task: tab moves to the fleet task, enter launches with it",
     SLUGTASK, [b"a", b"\t", b"g", b"o", b"\r"], "a\ngo|rc=0"),
    ("slug+task: the arrows switch fields and backspace edits the one you're in",
     SLUGTASK, [b"a", b"\x1b[B", b"g", b"x", b"\x7f", b"o", b"\x1b[A", b"b", b"\r"],
     "ab\ngo|rc=0"),
]

for name, script, keys, want in cases:
    got = run(script, keys)
    verdict = "ok" if got == want else "FAIL"
    detail = name if got == want else "%s (got %r, want %r)" % (name, got, want)
    print("%s|%s" % (verdict, detail))
    sys.stdout.flush()

# What was DRAWN, not what came back. The annotation has no other observable
# effect, so the only honest check is to read the frame off the pty.
sink = []
run(PICKANN, [b"\r"], sink=sink)
screen = b"".join(sink).decode("utf-8", "replace")
for name, want, present in [
    ("a discovered credential is drawn beside its template", "key (env)", True),
    ("the source tag distinguishes a stored value from a forwarded name", "key (file)", True),
    ("a template with nothing discovered is drawn with no mark", "base", True),
]:
    hit = (want in screen) == present
    print("%s|%s" % ("ok" if hit else "FAIL", name if hit else "%s (screen=%r)" % (name, screen[-400:])))
    sys.stdout.flush()
# Three states, told apart: two annotated rows and one bare one. `base` is the bare
# row, so nothing may follow its name but the row's own padding.
bare = [ln for ln in screen.split("\r\n") if "base" in ln and "template name" not in ln]
hit = bool(bare) and all("key (" not in ln for ln in bare)
print("%s|%s" % ("ok" if hit else "FAIL",
                 "an unauthenticated template is offered without a misleading mark"
                 if hit else "an unauthenticated template drew a mark (got %r)" % bare))
sys.stdout.flush()
PYCHECK
  while IFS='|' read -r verdict detail; do
    [ -n "$verdict" ] || continue
    [ "$verdict" = ok ] && ok "$detail" || bad "$detail"
  done < <("$PY" "$TMP/ptycheck.py" "$ROOT" "$TMP/pick.out" "$BASH" 2>&1)
else
  skip "chooser pty coverage — no usable python3 (a fresh Mac's /usr/bin/python3 is a CLT stub)"
fi

# A fake node that intercepts the plugin's own entry points — attach.js exits
# with a chosen code, provision.js does nothing — and hands everything else to
# the real node (so e2b_node's version gate still passes). The same
# fabricated-toolchain lever the discovery tests use.
FAKE_NODE="$TMP/attach-node/node"; mkdir -p "$TMP/attach-node"
cat > "$FAKE_NODE" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in
  */attach.js)    echo "[attach-stub]"; exit "\${STUB_ATTACH_RC:-0}" ;;
  */provision.js) exit 0 ;;
esac; done
exec "$REAL_NODE" "\$@"
EOF
chmod +x "$FAKE_NODE"

echo "── provisioning: the record rewrite carries the terminal forward ──"
# provision_from_cwd REPLACES the record wholesale, and reopening a PAUSED box
# always comes through it — dropping terminalPid there meant every pause →
# reopen silently created a fresh terminal instead of reattaching (found live,
# fleet accept05). Fabricate a paused record with a terminal, let `up`
# reprovision through the stubbed provision.js, and the terminal must survive.
ASTATE2="$TMP/carry-state"; mkdir -p "$ASTATE2/boxes" "$TMP/carry-wd"
printf '%s\n' '{"key":"carrybox","label":"carrybox","status":"paused","sandboxId":"sbx_carry1","template":"base","terminalPid":42,"terminalCols":120,"terminalRows":30}' \
  > "$ASTATE2/boxes/carrybox.json"
out=$(cd "$TMP/carry-wd" && HERDR_E2B_NODE="$FAKE_NODE" HERDR_PLUGIN_STATE_DIR="$ASTATE2" \
      KEY=carrybox "$E2B" up 2>&1); rc=$?
if jq -e '.terminalPid == 42 and .terminalCols == 120 and .terminalRows == 30 and .sandboxId == "sbx_carry1"' \
     "$ASTATE2/boxes/carrybox.json" >/dev/null 2>&1; then
  ok "reprovisioning keeps terminalPid + geometry alongside sandboxId"
else
  bad "record rewrite dropped the terminal (rc=$rc, record=$(cat "$ASTATE2/boxes/carrybox.json" 2>/dev/null))"
fi
rm -rf "$ASTATE2"

echo "── connect_shell: the client's exit codes drive the branches ──"
# src/attach.js reports what happened by exit code — 0 clean · 10 never attached
# · 11 box gone · 12 attached-then-lost — replacing the old two-second stopwatch.
# Each branch is asserted offline with the fake node above, driven through a
# real pty because connect_shell only attaches to one.
if PY=$(pty_python); then
  ASTATE="$TMP/attach-state"; mkdir -p "$ASTATE/boxes" "$TMP/attach-wd"
  printf '%s\n' '{"key":"attachbox","label":"attachbox","status":"ready","sandboxId":"sbx_stub123","projectPath":"/home/user/project"}' \
    > "$ASTATE/boxes/attachbox.json"
  cat > "$TMP/ptyattach.py" <<'PYATTACH'
import os, pty, select, sys, time

BASH, CMD = sys.argv[1], sys.argv[2]

def drain(fd, quiet=0.2, limit=8.0):
    end, last = time.time() + limit, time.time()
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.03)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            sys.stdout.write(chunk.decode("utf-8", "replace"))
            last = time.time()
        elif time.time() - last > quiet:
            return

pid, fd = pty.fork()
if pid == 0:
    os.execv(BASH, [BASH, "-c", CMD])
drain(fd)
# Answer the close prompt if one came up; canonical-mode ptys buffer the input,
# so sending it when there is no prompt is harmless.
try:
    os.write(fd, b"L\r")
except OSError:
    pass
deadline, status = time.time() + 20, None
while time.time() < deadline:
    p, st = os.waitpid(pid, os.WNOHANG)
    if p:
        status = st
        break
    drain(fd, quiet=0.3, limit=1.0)
try:
    os.close(fd)
except OSError:
    pass
if status is None:
    try:
        os.kill(pid, 9)
        _, status = os.waitpid(pid, 0)
    except OSError:
        status = 0
print("\n[rc=%d]" % (os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128))
PYATTACH
  attach_case() { # $1 = the stub's exit code; output on stdout
    "$PY" "$TMP/ptyattach.py" "$BASH" \
      "cd \"$TMP/attach-wd\" && STUB_ATTACH_RC=$1 WAIT_MAX_ITERS=3 \
       HERDR_E2B_NODE=\"$FAKE_NODE\" HERDR_PLUGIN_STATE_DIR=\"$ASTATE\" \
       KEY=attachbox \"$E2B\" connect" 2>&1 | tr -d '\r'
  }

  out=$(attach_case 0)
  case "$out" in
    *"[attach-stub]"*) ok "the shell is attached by the plugin's client, not the e2b CLI" ;;
    *) bad "attach.js never ran (got: $(printf '%s' "$out" | tail -3))" ;;
  esac
  case "$out" in
    *"left sandbox 'attachbox'"*"left running"*) ok "clean exit → the unchanged pull/kill/leave prompt" ;;
    *) bad "clean exit didn't reach the close prompt (got: $(printf '%s' "$out" | tail -3))" ;;
  esac

  out=$(attach_case 12)
  case "$out" in
    *"stopped — paused, or it hit its idle timeout"*"left running"*)
      ok "attached-then-lost → the disconnect notice, then the close prompt" ;;
    *) bad "lost-underneath branch (got: $(printf '%s' "$out" | tail -4))" ;;
  esac

  out=$(attach_case 11)
  case "$out" in
    *"is gone (killed)"*) ok "box gone → the gone message" ;;
    *) bad "box-gone branch (got: $(printf '%s' "$out" | tail -3))" ;;
  esac
  case "$out" in
    *reprovisioning*|*"left sandbox"*) bad "a gone box must not reprovision or offer the close prompt" ;;
    *"[rc=0]"*) ok "box gone → says so and exits cleanly, no reprovision" ;;
    *) bad "box-gone exit (got: $(printf '%s' "$out" | tail -3))" ;;
  esac

  out=$(attach_case 10)
  case "$out" in
    *"wasn't reachable — reprovisioning"*) ok "never attached → the reprovision branch, no stopwatch" ;;
    *) bad "never-attached branch (got: $(printf '%s' "$out" | tail -4))" ;;
  esac
else
  skip "connect_shell exit-code coverage — no usable python3"
fi

echo "── auth: one confirmation for the whole batch, driven through a real pty ──"
# The question `auth` asks only exists on a terminal, so the only honest way to
# cover it is to give it one. The non-tty arm is asserted far above (report, then
# stop); this is the arm where a human answers, and both answers matter: no must
# leave the config dir exactly as it found it, and yes must produce the file.
#
# The prompt is waited FOR rather than slept past — the probes ahead of it reach
# the network and take seconds, and a fixed sleep would answer a question that had
# not been asked yet. (It did, the first time this was written.)
if PY=$(pty_python); then
  # One driver, both answers. It reports three facts from a single run — whether it
  # was asked, how many times, and whether the file appeared — because a second
  # near-identical script drifts, and because each run pays for a full probe sweep.
  cat > "$TMP/authpty.py" <<'PYAUTH'
import os, pty, select, sys, time

E2B, CFG, ANSWER = sys.argv[1], sys.argv[2], sys.argv[3].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execve(E2B, [E2B, "auth"], dict(os.environ, HERDR_PLUGIN_CONFIG_DIR=CFG))
buf, sent, end = b"", False, time.time() + 60
while time.time() < end:
    if not select.select([fd], [], [], 0.2)[0]:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    buf += chunk
    if not sent and b"[y/N]" in buf:
        os.write(fd, ANSWER + b"\r")
        sent = True
try:
    os.close(fd)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except (ChildProcessError, OSError):
    pass
print("%s asked=%d %s" % ("asked" if sent else "never-asked",
                          buf.count(b"[y/N]"),
                          "wrote" if os.path.exists(os.path.join(CFG, "auth.toml")) else "nothing"))
PYAUTH
  for answer in n y; do
    adir="$TMP/auth-pty-$answer"; mkdir -p "$adir"
    res=$("$PY" "$TMP/authpty.py" "$E2B" "$adir" "$answer" 2>&1)
    [ "$answer" = n ] && want="asked asked=1 nothing" || want="asked asked=1 wrote"
    [ "$res" = "$want" ] \
      && ok "auth asks once for the whole batch and, answered '$answer', ${want##* }" \
      || bad "auth pty '$answer' (got '$res', want '$want')"
  done
else
  skip "auth confirmation pty coverage — no usable python3"
fi

echo "── fleet: answering the pickers is what asks for the board ──"
# The board used to be a flag only the pane entrypoint passed. It is now inferred:
# somebody who answered a picker screen is sitting here watching, so the pane
# becomes the board. That inference needs a real terminal to exist at all — no
# tty, no pickers, no board — so it is asserted the only honest way, through a pty.
#
# The counter-case is asserted without one, just above and below: every
# fully-specified command line still runs in the foreground and still returns its
# exit code, which is the property `create` is named after.
if PY=$(pty_python); then
  DASH_MARK2="$TMP/dash-ran-picked"; rm -f "$DASH_MARK2"
  FAKE_DASH2="$TMP/fake-dash-picked"
  printf '#!/usr/bin/env bash\nprintf started > "%s"\n' "$DASH_MARK2" > "$FAKE_DASH2"
  chmod +x "$FAKE_DASH2"
  cat > "$TMP/ptyboard.py" <<'PYBOARD'
import os, pty, select, sys, time

BASH, CMD = sys.argv[1], sys.argv[2]
# What to type once the first screen has drawn. Empty for a command line that
# named everything: there is no picker to answer, and the board is inferred from
# the terminal alone.
KEYS = sys.argv[3].encode() if len(sys.argv) > 3 else b""

def drain(fd, quiet=0.15, limit=6.0):
    """Read until the child has been quiet long enough to have finished drawing.
    What it read is echoed to stdout so a failure here has the pane to show."""
    end, last = time.time() + limit, time.time()
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.03)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            sys.stdout.write(chunk.decode("utf-8", "replace"))
            last = time.time()
        elif time.time() - last > quiet:
            return

pid, fd = pty.fork()
if pid == 0:
    os.execv(BASH, [BASH, "-c", CMD])
drain(fd)                      # the slug screen has drawn
if KEYS:
    os.write(fd, KEYS)         # name it; -t already answered the roster

# Then WAIT — never on quiet. Between the answer and the exec the fleet resolves
# names, probes herdr and forks the provisioning job, and every one of those is a
# silence longer than a redraw pause. Closing the pty on one of them hangs the
# child up before it can reach the board, which reads exactly like the bug this
# test is here to catch.
deadline = time.time() + 30
while time.time() < deadline:
    if os.waitpid(pid, os.WNOHANG)[0]:
        break
    drain(fd, quiet=0.5, limit=1.0)
try:
    os.close(fd)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except (ChildProcessError, OSError):
    pass
PYBOARD
  "$PY" "$TMP/ptyboard.py" "$BASH" \
    "cd \"$FREPO\" && HERDR_E2B_FLEET_RAND=ab12 HERDR_ENV=1 STUB_DELAY=\"$STUB_DELAY\" \
     HERDR_PLUGIN_CONFIG_DIR=\"$ACFG\" HERDR_E2B_DASH=\"$FAKE_DASH2\" \
     HERDR_E2B_FLEET_SHELL_WAIT=1 HERDR_E2B_FLEET_AGENT_WAIT=0 HERDR_E2B_FLEET_TASK_WAIT=0 \
     HERDR_BIN_PATH=\"$TMP/herdr-ok/herdr\" \"$FLEET\" -t claude" "boarded2
" >"$TMP/ptyboard.out" 2>&1
  [ -f "$DASH_MARK2" ] \
    && ok "a fleet that had to ask becomes the board, with no --dashboard anywhere" \
    || bad "picker-implied board never reached the dashboard ($(tr -d '\r' <"$TMP/ptyboard.out" | tail -5))"

  # …and so does the short line nobody had to be asked about. `fleet <slug>
  # --agents claude` at a terminal is the same human in the same pane, so it must
  # reach the board too — and the pane must NOT get the per-member wall, which is
  # the thing that scrolls the roster away just as it comes up.
  DASH_MARK3="$TMP/dash-ran-typed"; rm -f "$DASH_MARK3"
  FAKE_DASH3="$TMP/fake-dash-typed"
  printf '#!/usr/bin/env bash\nprintf started > "%s"\n' "$DASH_MARK3" > "$FAKE_DASH3"
  chmod +x "$FAKE_DASH3"
  "$PY" "$TMP/ptyboard.py" "$BASH" \
    "cd \"$FREPO\" && HERDR_E2B_FLEET_RAND=ab12 HERDR_ENV=1 STUB_DELAY=\"$STUB_DELAY\" \
     HERDR_PLUGIN_CONFIG_DIR=\"$ACFG\" HERDR_E2B_DASH=\"$FAKE_DASH3\" \
     HERDR_E2B_FLEET_SHELL_WAIT=1 HERDR_E2B_FLEET_AGENT_WAIT=0 HERDR_E2B_FLEET_TASK_WAIT=0 \
     HERDR_BIN_PATH=\"$TMP/herdr-ok/herdr\" \"$FLEET\" typedout --agents claude" \
    >"$TMP/ptytyped.out" 2>&1
  typed_pane=$(tr -d '\r' <"$TMP/ptytyped.out")
  [ -f "$DASH_MARK3" ] \
    && ok "a fully-typed fleet at a terminal becomes the board too" \
    || bad "typed-line board never reached the dashboard ($(printf '%s' "$typed_pane" | tail -5))"
  case "$typed_pane" in
    *"up in pane"*|*"/1 up"*) bad "the per-member report went to the pane the board owns" ;;
    *"behind the board"*) ok "the pane says where the run went instead of printing it" ;;
    *) bad "no board handoff line in the pane ($(printf '%s' "$typed_pane" | tail -5))" ;;
  esac
else
  skip "picker-implied board — no usable python3"
fi

echo
if [ "$SKIP" -gt 0 ]; then
  echo "cli.test: $PASS passed, $FAIL failed, $SKIP skipped"
else
  echo "cli.test: $PASS passed, $FAIL failed"
fi
[ "$FAIL" -eq 0 ]
