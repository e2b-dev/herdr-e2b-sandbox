#!/usr/bin/env bash
# Live end-to-end check of `e2b-box run` (the headless verb, #47). NOT part of
# `npm test`: it boots real sandboxes (three, ~1 minute, killed on the way out) and
# needs an E2B key plus a credential the agent template can use.
#
#   E2B_API_KEY=… test/e2e-run.sh              # claude template (default)
#   E2E_TEMPLATE=codex test/e2e-run.sh         # any template with a headless command
#
# What it proves, in order, against a throwaway repo with a bare "remote":
#   1. a usage error (template with no headless agent) creates nothing
#   2. --dry-run is the plan and only the plan
#   3. the happy path: dirty-tree snapshot in, agent runs to completion, the result
#      is pulled home, committed WITH the pre-existing dirty file, pushed to the
#      remote, the box PAUSED (the default), exit 0, stdout exactly one JSON object
#   4. --timeout-ms kills a runaway agent: status agent-unmeasured, exit 1; --kill
#      destroys the box
#   5. the clobber guard: an agent edit to a file that ALSO has uncommitted local
#      edits aborts the pull, the box is paused (never killed) with the work still
#      in it, exit 1; a --force --kill re-run resumes it and brings the edit home
#   6. no box left tracked at the end
set -uo pipefail
ROOT="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2B="$ROOT/bin/e2b-box"
TPL="${E2E_TEMPLATE:-claude}"
AGENT_MS="${E2E_AGENT_TIMEOUT_MS:-600000}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
for t in jq git node; do command -v "$t" >/dev/null || { echo "e2e-run: '$t' not on PATH"; exit 1; }; done

# Own state dir so this never touches your real box records; your CONFIG dir is
# kept on purpose (that is where the template's credential comes from).
TMP="$(mktemp -d)"
export HERDR_PLUGIN_STATE_DIR="$TMP/state"; mkdir -p "$HERDR_PLUGIN_STATE_DIR/boxes"
unset HERDR_PLUGIN_CONTEXT_JSON KEY 2>/dev/null || true
REPO="$TMP/repo"; REMOTE="$TMP/remote.git"; OUT="$TMP/out"; mkdir -p "$OUT"
cleanup() {
  # Whatever happened above, no billable box may outlive this script.
  ( cd "$REPO" 2>/dev/null && "$E2B" kill >/dev/null 2>&1 ) || true
  rm -rf "$TMP"
}
trap cleanup EXIT

git init -q --bare "$REMOTE"
mkdir -p "$REPO"; cd "$REPO"
git init -q -b main
git config user.email e2e@herdr-e2b.test; git config user.name "herdr-e2b e2e"
printf '# e2e\n\nA throwaway repo for `e2b-box run`.\n' > README.md
printf 'tracked v1\n' > tracked.txt
git add -A && git commit -qm init && git remote add origin "$REMOTE" && git push -q -u origin main
# The dirty tree the snapshot must carry: one tracked file modified, one untracked.
printf 'tracked v2 (uncommitted)\n' > tracked.txt
printf 'local scratch\n' > scratch.txt

echo "── 1. a usage error never boots a box ──"
out=$("$E2B" run -t base --task 'anything' 2>&1); rc=$?
{ [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "no headless agent command"; } \
  && ok "run -t base → refused by name, exit 2" || bad "run -t base (rc=$rc, out=$out)"
[ "$(ls -1 "$HERDR_PLUGIN_STATE_DIR/boxes" | wc -l | tr -d ' ')" = 0 ] \
  && ok "no record written" || bad "a record was written by a refusal"

echo "── 2. --dry-run is the plan ──"
printf 'Create a file named HELLO.md whose only content is the line: hello from the box\nDo not touch any other file. Do not commit.\n' > GOAL.md
out=$("$E2B" run -t "$TPL" --task GOAL.md --push --dry-run --json 2>/dev/null); rc=$?
{ [ "$rc" -eq 0 ] && [ "$(printf '%s' "$out" | jq -r '.dryRun')" = true ] \
  && [ "$(printf '%s' "$out" | jq -r '.template')" = "$TPL" ] \
  && [ "$(printf '%s' "$out" | jq -r '.taskBytes')" = "$(printf '%s' "$(cat GOAL.md)" | wc -c | tr -d ' ')" ] \
  && [ "$(printf '%s' "$out" | jq -r '.push')" = true ]; } \
  && ok "plan names template, task size, push" || bad "dry-run (rc=$rc, out=$out)"
[ "$(ls -1 "$HERDR_PLUGIN_STATE_DIR/boxes" | wc -l | tr -d ' ')" = 0 ] \
  && ok "dry-run created nothing" || bad "dry-run wrote a record"

echo "── 3. happy path: task in, branch out ──"
"$E2B" run -t "$TPL" --task GOAL.md --push -m 'e2e: agent result' --timeout-ms "$AGENT_MS" --json \
  > "$OUT/3.json" 2> "$OUT/3.err"; rc=$?
[ "$rc" -eq 0 ] && ok "exit 0" || { bad "exit $rc"; sed 's/^/       /' "$OUT/3.err"; }
[ "$(wc -l < "$OUT/3.json" | tr -d ' ')" = 1 ] && jq -e . "$OUT/3.json" >/dev/null 2>&1 \
  && ok "stdout is exactly one JSON object" || bad "stdout: $(cat "$OUT/3.json")"
j() { jq -r "$1" "$OUT/3.json" 2>/dev/null; }
[ "$(j .ok)" = true ] && [ "$(j .status)" = done ] && ok "ok:true status:done" || bad "status $(j .status): $(j .error)"
[ "$(j .agent.exitCode)" = 0 ] && ok "agent exit 0" || bad "agent exit $(j .agent.exitCode)"
[ "$(j .pull.ok)" = true ] && ok "pull ok" || bad "pull: $(j .pull.output)"
[ "$(j .push.ok)" = true ] && [ "$(j .push.branch)" = main ] && ok "push ok on main" || bad "push: $(jq -c .push "$OUT/3.json")"
[ "$(j .box)" = paused ] && ok "box paused (the default)" || bad "box: $(j .box)"
[ "$("$E2B" status --json | jq -r '.status')" = paused ] && ok "record says paused, so 'e2b-box open' can put you back" || bad "record: $("$E2B" status --json)"
[ -f HELLO.md ] && grep -q 'hello from the box' HELLO.md && ok "agent's file came home" || bad "HELLO.md missing/wrong: $(cat HELLO.md 2>/dev/null)"
[ -z "$(git status --porcelain)" ] && ok "tree clean after the commit" || bad "tree dirty: $(git status --porcelain | tr '\n' ' ')"
git show --stat HEAD --format= | grep -q 'scratch.txt' && ok "pre-existing untracked file rode in the commit" || bad "scratch.txt not in the commit"
[ "$(git show HEAD:tracked.txt)" = "tracked v2 (uncommitted)" ] && ok "pre-existing modified file rode in the commit (snapshot was dirty)" || bad "tracked.txt: $(git show HEAD:tracked.txt)"
[ "$(git rev-parse HEAD)" = "$(git -C "$REMOTE" rev-parse main)" ] && ok "remote main == local HEAD" || bad "remote not updated"
grep -q 'were already uncommitted before the run' "$OUT/3.err" && ok "the dirty tree was named on stderr" || bad "no dirty-tree note"
"$E2B" kill >/dev/null 2>&1 && [ "$(ls -1 "$HERDR_PLUGIN_STATE_DIR/boxes" | wc -l | tr -d ' ')" = 0 ] \
  && ok "e2b-box kill ends the paused box" || bad "kill of the paused box failed"

echo "── 4. --timeout-ms kills a runaway agent; --kill destroys the box ──"
"$E2B" run -t "$TPL" --task 'Wait patiently for 10 minutes, then create SLOW.md. Do nothing else.' --timeout-ms 1500 --kill --json \
  > "$OUT/4.json" 2> "$OUT/4.err"; rc=$?
j() { jq -r "$1" "$OUT/4.json" 2>/dev/null; }
[ "$rc" -eq 1 ] && ok "exit 1" || bad "exit $rc"
[ "$(j .status)" = agent-unmeasured ] && [ "$(j .agent.ok)" = false ] && ok "status agent-unmeasured, agent.ok:false" || bad "status $(j .status): $(j .error)"
printf '%s' "$(j .agent.error)" | grep -q 'timed out' && ok "error names the bound" || bad "agent.error: $(j .agent.error)"
[ "$(j .box)" = killed ] && ok "--kill: box killed even after a failed agent" || bad "box: $(j .box)"
[ "$(ls -1 "$HERDR_PLUGIN_STATE_DIR/boxes" | wc -l | tr -d ' ')" = 0 ] && ok "no record left" || bad "record left after --kill"
[ "$(j .push)" = null ] && ok "no push attempted" || bad "push attempted after a failed agent"

echo "── 5. the clobber guard never destroys the box ──"
# The agent will change README.md; so does the laptop, uncommitted, while the run
# is in flight (here: before it, which the snapshot faithfully carries; the box
# copy then diverges from the local one the moment the agent edits it).
printf '\nlocal edit that must survive\n' >> README.md
# --kill on purpose: a pull that did not complete must downgrade it to a pause.
"$E2B" run -t "$TPL" --task 'Append the line "edited in the box" to README.md. Touch nothing else. Do not commit.' --timeout-ms "$AGENT_MS" --kill --json \
  > "$OUT/5.json" 2> "$OUT/5.err"; rc=$?
j() { jq -r "$1" "$OUT/5.json" 2>/dev/null; }
[ "$rc" -eq 1 ] && ok "exit 1" || bad "exit $rc"
[ "$(j .status)" = pull-failed ] && ok "status pull-failed" || bad "status $(j .status): $(j .error)"
[ "$(j .agent.exitCode)" = 0 ] && ok "(the agent itself succeeded)" || bad "agent exit $(j .agent.exitCode)"
[ "$(j .box)" = paused ] && [ -n "$(j .sandboxId)" ] && ok "--kill downgraded to pause: box $(j .sandboxId) kept with the work in it" || bad "box: $(j .box)"
printf '%s' "$(j .pull.output)" | grep -q 'README.md' && ok "pull named the file at stake" || bad "pull output: $(j .pull.output)"
grep -q 'local edit that must survive' README.md && ! grep -q 'edited in the box' README.md \
  && ok "local README.md untouched" || bad "README.md was clobbered"
[ "$(ls -1 "$HERDR_PLUGIN_STATE_DIR/boxes/"*.json 2>/dev/null | wc -l | tr -d ' ')" = 1 ] && ok "record kept for the retry" || bad "no record kept"
# --force is the consent; the box is paused, so this resumes and re-syncs it (which
# re-uploads the LOCAL README, so the agent's edit is redone) and force-pulls.
"$E2B" run -t "$TPL" --task 'Append the line "edited in the box" to README.md. Touch nothing else. Do not commit.' --timeout-ms "$AGENT_MS" --force --kill --json \
  > "$OUT/5b.json" 2> "$OUT/5b.err"; rc=$?
j() { jq -r "$1" "$OUT/5b.json" 2>/dev/null; }
[ "$rc" -eq 0 ] && [ "$(j .status)" = done ] && ok "--force on the paused box → resumed, done, exit 0" || bad "--force run: status $(j .status): $(j .error)"
grep -q 'edited in the box' README.md && ok "agent's edit came home under --force" || bad "README.md missing the box edit"
[ "$(j .box)" = killed ] && ok "--kill: box killed" || bad "box: $(j .box)"

echo "── 6. nothing left running ──"
[ "$("$E2B" list --json | jq 'length')" = 0 ] && ok "e2b-box list is empty" || { bad "boxes still tracked"; "$E2B" list; }

echo
echo "e2e-run ($TPL): $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
