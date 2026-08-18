#!/usr/bin/env bash
# bench/usage.sh — the axes a pass/fail verdict does not carry.
#
# `e2b-bench` grades: pass, fail, or "the box could not be reached", and ADR-0004
# deliberately stops there — the plugin forms no opinion about better. A bench run
# still wants the mechanical columns around that verdict: tokens, cost, wall
# clock, diff size, and whether the existing suite survived. They live HERE, in
# bench/, precisely so a ccusage hiccup can never look like a failing agent.
#
#   bench/usage.sh <slug>              the table
#   bench/usage.sh <slug> --json       one JSON object per member, for a script
#   bench/usage.sh <slug> --install    run `npm ci` in a box that has no deps
#
# Everything is read from inside each member's box in ONE `e2b-box exec` per
# member, run concurrently — the same reason grade.rs grades concurrently. The
# host does all the parsing; the box only has to cat things.
set -uo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  ldir="$(CDPATH= cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [ "${SOURCE#/}" = "$SOURCE" ] && SOURCE="$ldir/$SOURCE"
done
DIR="$(CDPATH= cd -P "$(dirname "$SOURCE")/.." && pwd)"
source "$DIR/bin/lib/paths.sh"   # STATE_DIR — the held-out verdict lives there
# Overridable for the same reason e2b-fleet makes BOX_CLI overridable: the offline
# suite needs somewhere to point it that does not talk to E2B.
E2B="${HERDR_E2B_BOX:-$DIR/bin/e2b-box}"

for t in jq; do command -v "$t" >/dev/null || { echo "usage.sh: '$t' not on PATH" >&2; exit 1; }; done

slug=""; as_json=0; install_deps=0; timeout_ms=600000
while [ $# -gt 0 ]; do
  case "$1" in
    --json) as_json=1; shift ;;
    --install) install_deps=1; shift ;;
    --timeout-ms) timeout_ms="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "usage.sh: unknown option '$1'" >&2; exit 2 ;;
    *) [ -z "$slug" ] && { slug="$1"; shift; } || { echo "usage.sh: one slug" >&2; exit 2; } ;;
  esac
done
[ -n "$slug" ] || { echo "usage.sh: need a fleet slug — bench/usage.sh <slug>" >&2; exit 2; }

# Members come from the branch prefix and the box records, never a stored list —
# ADR-0001/0005. `list --json` is the documented contract over those records, so
# this does not reach into $STATE_DIR/boxes itself.
members=$("$E2B" list --json 2>/dev/null | jq -r --arg p "e2b/$slug-" '
  .[] | select((.branch // "") | startswith($p))
      | [.key, (.branch // ""), (.template // "-")] | @tsv')
[ -n "$members" ] || { echo "usage.sh: no boxes on branches matching 'e2b/$slug-*'" >&2; exit 1; }

# ── the in-box probe ────────────────────────────────────────────────────────
# Base64'd rather than quoted, for the reason fleet base64s a task: this is free
# text crossing argv, a JS string, bash and a shell, and every one of those is a
# chance to mangle it.
#
# Wall clock is bracketed by two mtimes the run itself leaves behind: the brief
# was written into the box immediately before the agent launched, and the newest
# file under the project is the agent's last edit. Not "when the agent decided it
# was done" — nothing reports that for a TUI — so it is labelled to-last-write.
#
# Diff size leans on what provision.js already did: `git init` + `git add -A` and
# NO commit, so the index IS the uploaded snapshot and the agent's work is exactly
# the unstaged diff. Read-only, no HEAD needed. If the agent staged its own work
# the unstaged diff shrinks, so the staged count is reported beside it — a large
# `staged` next to a tiny `diff` means the number is under-reporting, not that the
# agent changed nothing.
#
# `npm test` runs only when node_modules is present. node_modules is git-ignored
# and therefore never uploaded, so its absence means the agent never installed
# deps — which is signal about whether it verified its own work, not a defect
# here. --install opts into paying for `npm ci` first.
probe=$(cat <<'PROBE'
cd "${PROJECT_DIR:-$PWD}" 2>/dev/null || true
start=$(stat -c %Y "$HOME/.herdr-e2b-task.md" 2>/dev/null || echo "")
last=$(find . -path ./.git -prune -o -path ./node_modules -prune -o -type f -printf '%T@\n' 2>/dev/null \
       | sort -n | tail -1 | cut -d. -f1)
diff=$(git diff --shortstat 2>/dev/null | tr -d '\n')
# NOT reported: there is no way here to tell "the agent staged its work" from the
# baseline. provision.js runs `git add -A` with NO commit, so there is no HEAD and
# `git diff --cached` compares the index against the EMPTY TREE — it lists the whole
# repo (162 files) for every member, always. `git status --porcelain` is no better:
# every file reads as a staged addition for the same reason. The unstaged diff above is
# the only honest signal, and it is the agent's work exactly.
staged=0
if [ ! -d node_modules ] && [ "${INSTALL_DEPS:-0}" = 1 ]; then npm ci >/dev/null 2>&1 || true; fi
# A template shipping Node < 22 cannot pass this repo's suite no matter what the agent
# wrote: test/download.test.js imports the e2b SDK, which require()s an ESM-only chalk,
# and v20 dies with ERR_REQUIRE_ESM. Measured in the claude and codex templates (both
# v20.9.0). Reporting that as `fail` blames the agent for the image, so it gets its own
# value — the same reason the grader SKIPs its Node-dependent assertions.
if ! node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)' 2>/dev/null; then
  suite="node$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)"
elif [ -d node_modules ]; then
  out=$(npm test 2>&1)
  if [ $? -eq 0 ]; then suite=pass
  # rc 126 / "Permission denied" on bin/e2b-box is the stripped exec bit from upload,
  # not the agent's change: sandbox.files.write() carries no mode, so test/cli.test.sh
  # cannot invoke the script it is testing. Measured in the claude template, where the
  # node half passed and every CLI check returned 126.
  elif printf '%s' "$out" | grep -q 'Permission denied\|rc=126'; then suite=execbit
  else suite=fail; fi
else suite=no-deps; fi
printf '###META\nstart=%s\nlast=%s\nstaged=%s\nsuite=%s\ndiff=%s\n###CCUSAGE\n' \
  "$start" "$last" "$staged" "$suite" "$diff"
# One ccusage call, the unified `session` report: since v18-ish every agent's rows
# land in the same array with an `.agent` tag and a uniform `totalCost`, so the
# old per-harness cost-key mismatch (totalCost vs costUSD) is gone. Codex still
# breaks reasoning out under metadata.reasoningOutputTokens and nobody else does.
npx -y ccusage@latest session --json 2>/dev/null || true
PROBE
)
b64=$(printf %s "$probe" | base64 | tr -d '\n')

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
while IFS=$'\t' read -r key branch template; do
  [ -n "$key" ] || continue
  (
    out=$(KEY="$key" HERDR_PLUGIN_CONTEXT_JSON= "$E2B" exec --timeout-ms "$timeout_ms" \
      "PROJECT_DIR=\$PWD INSTALL_DEPS=$install_deps; printf %s '$b64' | base64 -d | bash" 2>/dev/null)
    printf '%s' "$out" > "$TMP/$key.json"
  ) &
done <<< "$members"
wait

# ── one row per member ──────────────────────────────────────────────────────
rows="$TMP/rows.jsonl"; : > "$rows"
while IFS=$'\t' read -r key branch template; do
  [ -n "$key" ] || continue
  raw=$(cat "$TMP/$key.json" 2>/dev/null)
  # exec's own contract first: ok:false is "never measured", and it must not be
  # laundered into a zero (ADR-0004's distinction, in a table this time).
  reached=$(printf '%s' "$raw" | jq -r '.ok // false' 2>/dev/null); : "${reached:=false}"
  body=$(printf '%s' "$raw" | jq -r '.stdout // ""' 2>/dev/null)
  meta=$(printf '%s' "$body" | sed -n '/^###META$/,/^###CCUSAGE$/p')
  cc=$(printf '%s' "$body" | sed -n '/^###CCUSAGE$/,$p' | tail -n +2)
  get() { printf '%s' "$meta" | sed -n "s/^$1=//p" | head -1; }
  # The held-out verdict, so one table carries every axis.
  verdict=$(jq -r '.verdict // "-"' "$STATE_DIR/bench/$slug/$key.json" 2>/dev/null); : "${verdict:=-}"
  usage_json=$(printf '%s' "$cc" | jq -c '
    (.session // []) as $s
    | { agents: ([$s[].agent] | unique | join(",")),
        input:   ([$s[].inputTokens]  | add // 0),
        cache:   ([($s[].cacheReadTokens // 0) + ($s[].cacheCreationTokens // 0)] | add // 0),
        output:  ([$s[].outputTokens] | add // 0),
        reason:  ([$s[].metadata.reasoningOutputTokens // 0] | add // 0),
        total:   ([$s[].totalTokens]  | add // 0),
        cost:    ([$s[].totalCost]    | add // 0) }' 2>/dev/null)
  [ -n "$usage_json" ] || usage_json='null'
  # Wall clock is subtracted HERE, in bash, not in jq: `"" | tonumber?` yields
  # nothing rather than null, and an empty branch inside an object constructor
  # takes the whole object with it — the row silently disappears instead of
  # reporting a missing timestamp. Cost an afternoon; worth the four lines.
  start=$(get start); last=$(get last); wall=null
  case "$start$last" in
    *[!0-9]*|"") ;;
    *) [ "$last" -ge "$start" ] 2>/dev/null && wall=$((last - start)) ;;
  esac
  jq -cn --arg key "$key" --arg tpl "$template" --arg br "$branch" --arg v "$verdict" \
        --arg reached "$reached" --arg suite "$(get suite)" --arg diff "$(get diff)" \
        --arg staged "$(get staged)" --argjson wall "$wall" \
        --argjson u "$usage_json" '
    {member:$tpl, key:$key, branch:$br, verdict:$v, reached:($reached=="true"),
     suite:(if $suite=="" then "-" else $suite end),
     diff:(if $diff=="" then "-" else $diff end), staged:($staged|tonumber? // 0),
     wallSeconds:$wall, usage:$u}' >> "$rows"
done <<< "$members"

if [ "$as_json" -eq 1 ]; then jq -s '.' "$rows"; exit 0; fi

# Missing is `-`, never a zero and never an estimate: a blank cell and a real
# zero are different facts, and the whole point of the table is comparing them.
n() { case "${1:-}" in ""|null) printf '%s' "-" ;; *) printf "%'d" "$1" ;; esac; }
# IN is UNCACHED input only, and harnesses differ wildly in how much of their input is
# cached — claude reported 88 uncached against 3.7M cached where codex reported 127k
# against 4.1M. Printing IN alone made claude look 1400x cheaper on input than it was,
# so CACHE is its own column and TOTAL is the number to compare across harnesses.
printf '%-10s %-9s %-8s %9s %11s %9s %9s %9s %8s %6s %s\n' \
  MEMBER VERDICT SUITE IN CACHE OUT REASONING TOTAL COST WALL DIFF
while IFS= read -r r; do
  eval "$(printf '%s' "$r" | jq -r '@sh "m=\(.member) v=\(.verdict) s=\(.suite) d=\(.diff) w=\(.wallSeconds // "") st=\(.staged) ok=\(.reached)
    i=\(.usage.input // "") ca=\(.usage.cache // "") o=\(.usage.output // "") rs=\(.usage.reason // "") tt=\(.usage.total // "") c=\(.usage.cost // "")"')"
  [ "$ok" = true ] || { v="unreached"; s="-"; }
  wall=$([ -n "$w" ] && printf '%dm%02ds' $((w/60)) $((w%60)) || printf '%s' "-")
  cost=$([ -n "$c" ] && [ "$c" != 0 ] && printf '$%.4f' "$c" || printf '%s' "-")
  printf '%-10s %-9s %-8s %9s %11s %9s %9s %9s %8s %6s %s\n' \
    "$m" "$v" "$s" "$(n "$i")" "$(n "$ca")" "$(n "$o")" "$(n "$rs")" "$(n "$tt")" "$cost" "$wall" "${d:--}"
done < "$rows"

cat >&2 <<'NOTE'

  verdict   the held-out test (e2b-bench). unreached = the box, not the agent.
  suite     npm test in the box. no-deps = deps never installed. nodeNN = the
            template ships Node NN and this repo needs >= 22. execbit = upload
            stripped the exec bit so cli.test.sh gets rc=126. Neither is the agent.
  IN/CACHE  uncached vs cached input. Harnesses cache very differently; compare TOTAL.
  reasoning broken out only by harnesses that report it; 0 means not broken out.
  wall      brief-written → last file write. Not "the agent decided it was done".
  diff      the agent's work: unstaged vs the snapshot left in the index by provision.
  -         not reported. Never estimated.
NOTE
