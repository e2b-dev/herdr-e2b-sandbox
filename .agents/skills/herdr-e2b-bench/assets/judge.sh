#!/usr/bin/env bash
# bench/judge.sh — deal every member's diff face-down, so the two rows that need
# taste can be scored without knowing whose work is whose.
#
# ADR-0004 keeps judging OUT of the plugin on purpose: "rubrics, weighted scores,
# which diff is nicer… anything that needs taste is somebody else's job, and the
# exit code is the interface to it." This script is that somebody else. It lives
# in bench/, never in bin/, and it produces no verdict — it produces reading
# material and withholds the labels until you have finished scoring.
#
#   bench/judge.sh <slug>            pull each member's diff, deal it as A/B/C…
#   bench/judge.sh <slug> --reveal   print the mapping, after you have scored
#
# Why blind: the same diff scores differently when you already know which model
# wrote it, and this table's whole purpose is comparing models. The mapping is
# written to disk (nothing is unrecoverable) but the dealing prints only letters.
set -uo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  ldir="$(CDPATH= cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [ "${SOURCE#/}" = "$SOURCE" ] && SOURCE="$ldir/$SOURCE"
done
BENCH="$(CDPATH= cd -P "$(dirname "$SOURCE")" && pwd)"
E2B="${HERDR_E2B_BOX:-$BENCH/../bin/e2b-box}"

command -v jq >/dev/null || { echo "judge.sh: 'jq' not on PATH" >&2; exit 1; }

slug=""; reveal=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reveal) reveal=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "judge.sh: unknown option '$1'" >&2; exit 2 ;;
    *) [ -z "$slug" ] && { slug="$1"; shift; } || { echo "judge.sh: one slug" >&2; exit 2; } ;;
  esac
done
[ -n "$slug" ] || { echo "judge.sh: need a fleet slug — bench/judge.sh <slug>" >&2; exit 2; }

OUT="$BENCH/judged/$slug"
MAP="$OUT/mapping.json"

if [ "$reveal" -eq 1 ]; then
  [ -f "$MAP" ] || { echo "judge.sh: nothing dealt for '$slug' yet" >&2; exit 1; }
  jq -r 'to_entries[] | "  \(.key) = \(.value.template)   (\(.value.key))"' "$MAP"
  exit 0
fi

# Same member discovery as usage.sh and grade.rs: the branch prefix is the fleet's
# only identity (ADR-0001), and `list --json` is the contract over the records.
members=$("$E2B" list --json 2>/dev/null | jq -r --arg p "e2b/$slug-" '
  .[] | select((.branch // "") | startswith($p)) | [.key, (.template // "-")] | @tsv')
[ -n "$members" ] || { echo "judge.sh: no boxes on branches matching 'e2b/$slug-*'" >&2; exit 1; }

mkdir -p "$OUT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# The diff is the unstaged one, for the reason usage.sh explains: provision.js
# leaves the uploaded snapshot IN the index and never commits, so `git diff` is
# exactly what the agent changed. Concurrent, one exec per member.
while IFS=$'\t' read -r key template; do
  [ -n "$key" ] || continue
  (
    raw=$(KEY="$key" HERDR_PLUGIN_CONTEXT_JSON= "$E2B" exec --timeout-ms 300000 'git diff' 2>/dev/null)
    ok=$(printf '%s' "$raw" | jq -r '.ok // false' 2>/dev/null)
    if [ "$ok" = true ]; then printf '%s' "$raw" | jq -r '.stdout // ""' > "$TMP/$key.diff"
    else printf '(box unreachable — no diff pulled)\n' > "$TMP/$key.diff"; fi
  ) &
done <<< "$members"
wait

# Shuffle with $RANDOM rather than shuf/sort -R: neither is on a stock macOS, and
# a dealing that silently falls back to alphabetical order is worse than no
# dealing at all — alphabetical by template is the mapping.
keys=(); tpls=()
while IFS=$'\t' read -r key template; do
  [ -n "$key" ] && { keys+=("$key"); tpls+=("$template"); }
done <<< "$members"
n=${#keys[@]}
for ((i=n-1; i>0; i--)); do
  j=$((RANDOM % (i+1)))
  t="${keys[i]}"; keys[i]="${keys[j]}"; keys[j]="$t"
  t="${tpls[i]}"; tpls[i]="${tpls[j]}"; tpls[j]="$t"
done

letters=(A B C D E F G H I J K L M N O P Q R S T U V W X Y Z)
map="{}"
echo "dealt into $OUT/"
for ((i=0; i<n; i++)); do
  L="${letters[i]}"
  cp "$TMP/${keys[i]}.diff" "$OUT/$L.diff"
  lines=$(grep -c '' "$OUT/$L.diff" 2>/dev/null || echo 0)
  printf '  %s.diff  %s lines\n' "$L" "$lines"
  map=$(printf '%s' "$map" | jq --arg l "$L" --arg t "${tpls[i]}" --arg k "${keys[i]}" \
        '. + {($l): {template:$t, key:$k}}')
done
printf '%s' "$map" > "$MAP"

cat <<'RUBRIC'

score each letter on the two rows the exit code cannot answer, /5:

  fits the repo        5 = indistinguishable from the surrounding code — same bash
                           idiom, same helpers, comment density and voice matched
                       3 = correct but reads as a visitor: own style, own helpers
                       1 = reformatted or restructured code it did not need to touch

  no scope creep       5 = the asked-for change and nothing else
                       3 = one or two defensible extras (a test, a tidy-up)
                       1 = drive-by refactors, new files, unrelated "fixes"

then:  bench/judge.sh <slug> --reveal
RUBRIC
echo "  (mapping written to $MAP — do not open it until you have scored)" >&2
