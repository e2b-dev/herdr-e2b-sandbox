#!/usr/bin/env bash
# Merge-readiness verdict for every open PR in this repo.
#
# The point is that "can I merge this?" has five different answers and `gh pr list`
# alone shows none of them clearly. A PR can be MERGEABLE and still unmergeable
# (red CI), and it can be BLOCKED and perfectly fine (a review ruleset on a
# solo-authored repo). Both were live traps in this repo, so the verdict is computed
# here once rather than re-derived by eye every release.
#
# Verdicts:
#   READY  — not a draft, no conflicts, every check completed green
#   WAIT   — checks still running; ask again in a minute, do not merge
#   HOLD   — a human has to decide: draft, conflicts, red CI, or no CI at all
#
# usage: pr-status.sh [--json]
set -euo pipefail

FIELDS='number,title,isDraft,mergeable,mergeStateStatus,author,headRefName,headRepositoryOwner,statusCheckRollup,reviewDecision,url'

raw=$(gh pr list --state open --limit 50 --json "$FIELDS")
me=$(gh api user --jq .login 2>/dev/null || echo "")
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "")

# How far each head has drifted behind main, and how old its newest finished check is.
# A PR can be fully green against a base that has since moved — the checks passed, but
# never against the tree that would actually ship. GitHub reports that PR as MERGEABLE
# and its rollup as green, so nothing in the API surfaces it. One compare call per PR
# does, and for a release sweep it matters: the release would claim those tests covered
# what shipped when they never ran against it.
drift="{}"
if [ -n "$repo" ]; then
  drift=$(jq -r '.[] | "\(.headRefName)\t\(.headRepositoryOwner.login // "")"' <<<"$raw" | while IFS=$'\t' read -r br owner; do
    [ -n "$br" ] || continue
    # A fork's branch is only addressable as owner:branch — a bare name resolves to a
    # branch of this repo that usually does not exist, which is how an outside
    # contribution silently reports "not behind" and looks fresher than it is.
    ref="$br"
    [ -n "$owner" ] && [ "$owner" != "${repo%%/*}" ] && ref="$owner:$br"
    b=$(gh api "repos/$repo/compare/main...$ref" --jq '.behind_by' 2>/dev/null || true)
    case "$b" in ''|*[!0-9]*) b=null ;; esac
    jq -cn --arg br "$br" --argjson b "$b" '{($br): $b}'
  done | jq -s 'add // {}')
fi

verdicts=$(jq -r --arg me "$me" --argjson drift "$drift" '
  map({
    number, title, url,
    branch: .headRefName,
    author: .author.login,
    mine: (.author.login == $me),
    review: (.reviewDecision // "NONE"),
    # Only checks that have actually finished count as evidence. A rollup entry with
    # no conclusion is in flight, and treating in-flight as green is how a red build
    # gets merged.
    checks_total: (.statusCheckRollup // [] | length),
    checks_failed: (.statusCheckRollup // [] | map(select(.conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "CANCELLED" or .state == "FAILURE" or .state == "ERROR")) | length),
    checks_running: (.statusCheckRollup // [] | map(select((.status // "COMPLETED") != "COMPLETED")) | length),
    draft: .isDraft,
    conflicts: (.mergeable != "MERGEABLE"),
    behind: ($drift[.headRefName] // null),
    # Age of the newest finished check. A green run from last week proves less than a
    # green run from an hour ago, and says so out loud rather than in a timestamp
    # nobody reads.
    checks_age_days: (
      (.statusCheckRollup // [] | map(.completedAt // empty) | max) as $t
      | if $t == null then null else ((now - ($t | fromdateiso8601)) / 86400 | floor) end)
  })
  | map(. + {
      verdict: (
        if .draft then "HOLD"
        elif .conflicts then "HOLD"
        elif .checks_total == 0 then "HOLD"
        elif .checks_failed > 0 then "HOLD"
        elif .checks_running > 0 then "WAIT"
        elif (.behind // 0) > 0 then "STALE"
        else "READY" end),
      reason: (
        if .draft then "draft"
        elif .conflicts then "conflicts with main — rebase or merge main in"
        elif .checks_total == 0 then "no checks ran — nothing proves this is safe"
        elif .checks_failed > 0 then "\(.checks_failed) check(s) failed"
        elif .checks_running > 0 then "\(.checks_running) check(s) still running"
        elif (.behind // 0) > 0 then "green, but \(.behind) commit(s) behind main — CI never saw the tree that would ship\(if .checks_age_days != null and .checks_age_days > 1 then " (checks are \(.checks_age_days)d old)" else "" end)"
        else "green\(if .checks_age_days != null and .checks_age_days > 1 then ", though checks are \(.checks_age_days)d old" else "" end)" end)
    })
' <<<"$raw")

if [ "${1:-}" = "--json" ]; then
  printf '%s\n' "$verdicts"
  exit 0
fi

count=$(jq 'length' <<<"$verdicts")
if [ "$count" -eq 0 ]; then
  echo "no open PRs — nothing to sweep"
  exit 0
fi

printf '%-8s %-6s %-7s %s\n' "VERDICT" "PR" "AUTHOR" "TITLE / WHY"
printf '%-8s %-6s %-7s %s\n' "-------" "--" "------" "-----------"
jq -r '.[] | "\(.verdict)\t#\(.number)\t\(if .mine then "you" else .author end)\t\(.title)\n\t\t\t↳ \(.reason)\(if .review != "APPROVED" and .review != "NONE" then " · review: \(.review)" else "" end)"' <<<"$verdicts" \
  | awk -F'\t' '{ if (NF>3) printf "%-8s %-6s %-7s %s\n", $1, $2, $3, $4; else printf "%-8s %-6s %-7s %s\n", "", "", "", $4 }'

echo
printf 'ready: %s   stale base: %s   waiting on CI: %s   needs a decision: %s\n' \
  "$(jq '[.[]|select(.verdict=="READY")]|length' <<<"$verdicts")" \
  "$(jq '[.[]|select(.verdict=="STALE")]|length' <<<"$verdicts")" \
  "$(jq '[.[]|select(.verdict=="WAIT")]|length' <<<"$verdicts")" \
  "$(jq '[.[]|select(.verdict=="HOLD")]|length' <<<"$verdicts")"
