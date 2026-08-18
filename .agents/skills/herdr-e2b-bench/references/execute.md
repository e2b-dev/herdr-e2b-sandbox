# execute — run the bench

Three commands. Ask only for the slug and roster if the user has not said them;
everything else has a default. Run, then report.

## Which task pair

Two briefs live in `bench/`, graded by two graders. Everything below is identical
either way — only the two filenames change.

| invoked as | brief | grader | agent time | grader time |
| --- | --- | --- | --- | --- |
| `execute` (default) | `bench/BENCH.md` | `bench/grade.sh` | ~1 hour | ~10s/box |
| `quick` | `bench/BENCH-quick.md` | `bench/grade-quick.sh` | ~5 min | ~1s/box |

Use `quick` when what is under test is the harness — a new agent, a new template,
a key that may not be signed in, a demo recording that cannot run for an hour. Use
the default when what is under test is the agents: the quick task is small enough
that the good agents bunch at the top.

`grade-quick.sh` is 13 assertions, all `node` over fixture strings — no E2B, no
network, no `jq`, no Node >= 22 gate, and nothing to SKIP. Floor and ceiling are
measured: untouched `5 passed, 8 failed`, reference implementation `13 passed`.
`usage.sh` reports `suite=no-deps` on a quick run, which is correct — that brief
asks for the agent's own `test/pane-parse.test.js`, not `npm test`.

Both graders are gitignored, both briefs are committed. Same held-out mechanics.

```sh
# 1. fan out — one box + one herdr tab per agent, each handed the brief
e2b-box fleet <slug> --agents claude,codex --task "$(cat bench/BENCH.md)"

# 2. grade — the held-out test, inside every member's box. ONCE per slug: the run id
#    IS the slug (ADR-0005), so a second --grade overwrites the verdicts.
e2b-bench <slug> --grade "$(cat bench/grade.sh)"   # bench/grade.sh must be FROZEN by now
#    quick: --task "$(cat bench/BENCH-quick.md)" and --grade "$(cat bench/grade-quick.sh)"

# 3. report
e2b-bench <slug>          # the graded board
bench/usage.sh <slug>     # tokens, cost, wall clock, diff size, suite
```

`--all` instead of `--agents a,b` races every agent the config knows. `--dry-run` on
step 1 prints every call and creates nothing.

**`e2b-bench` may not be on PATH even when `e2b-box` is.** `install.sh` links it
unconditionally, but an older install predates that, and `bench` is not a verb of
`e2b-box` the way `fleet` and `dash` are — so there is no fallback spelling. Use
`./bin/e2b-bench` from the repo root, or link it once:

```sh
command -v e2b-bench >/dev/null || ln -sf "$PWD/bin/e2b-bench" ~/.local/bin/e2b-bench
```

Worth doing before step 1, not after: a fleet that fans out and then cannot grade
has already spent every member's sandbox and tokens.

## The cluster trap — check this before you grade

**Ambient E2B env vars can point at a different cluster than the one your boxes live
on, and the failure looks exactly like "every agent failed".** Measured live: with
`E2B_DOMAIN=e2b-juliett.dev`, `E2B_API_URL=https://api.e2b-juliett.dev` and a juliett
`E2B_API_KEY` exported (dotenv managers such as mise re-apply these on every `cd`),
while the fleet's boxes were created under `e2b auth login` on prod:

- the member panes kept working — they connected earlier, on the right cluster
- `e2b sandbox list` reported **"No sandboxes found"**
- `e2b-box exec` reported **`sandbox … is gone`**
- `e2b-box list` still said `ready`, because that is the last known record, not a probe

So a grade run would have recorded `Error` / `unreached` for every member and the
report would have said both agents failed, while both had in fact done the work.
Nothing about it looks like a credentials problem.

Probe before grading, and scrub the ambient vars if the probe fails:

```sh
# does the SDK path actually reach a live box?
KEY=<any-member-key> e2b-box exec 'echo alive'

# if that says "is gone" while the pane is clearly alive, the cluster is wrong:
env -u E2B_DOMAIN -u E2B_API_URL -u E2B_API_KEY \
  e2b-bench <slug> --grade "$(cat bench/grade.sh)"
```

Scrub all three together. `E2B_API_URL` alone silently redirects every call, and an
`E2B_API_KEY` from another cluster authenticates fine against the wrong API — the
error you get is `Unauthorized … Cannot get the team`, which reads like a bad key and
is not one. With all three unset, the plugin falls back to the `e2b auth login`
store, which is the same credential the boxes were created with.

The record's own `domain` field is the tiebreaker: `domain=unset` means the box was
created on the login's default cluster, so ambient overrides can only take you away
from it.

## Waiting for the agents, without burning turns

Between step 1 and step 2 the agents work for **many minutes**. Three approaches
fail, and it is worth knowing why before reaching for any of them:

- `sleep 240 && …` exceeds the shell's command timeout.
- Slicing it into repeated `sleep 55 && cat <log>` is worse — every slice costs a
  full turn to learn nothing, and the sleeps stack up as orphaned background jobs.
- **`herdr agent wait --until idle` does not work on fleet members.** herdr sees no
  agent in a member's pane: the pane holds `e2b-box open`, and the agent itself runs
  *inside the sandbox*. `herdr pane list` reports those panes as `agent: -`,
  `agent_status: unknown`, so a lifecycle wait blocks until it times out. herdr's
  agent verbs work on local agents only — this is the same reason `e2b-fleet` types
  a member's task into its pane instead of using `agent prompt`.

**So do not block.** The honest move is to stop and come back: the boxes keep working
with the terminal closed (`auto_pause`, and `Sandbox.connect` resumes a paused box),
so an unattended gap costs nothing but wall-clock. Tell the user the fleet is up and
grade when they return.

When you do want a progress reading, ask the box, not the pane — the agent's writes
are the one signal that does not depend on interpreting a TUI:

```sh
e2b-box list                                              # every member's box + status
KEY=<member-key> e2b-box exec 'git diff --shortstat'      # has this agent written anything yet?
herdr pane read <member-pane> --lines 40                  # what its TUI is showing now
```

`git diff --shortstat` going from empty to non-empty is real progress. Do **not** try
to detect "finished" by grepping the TUI for a busy word — Claude Code prints
`esc to interrupt` while idle *and* while thinking, so the same string means both.

## Freeze the grader once the fleet is up

`--grade "$(cat bench/grade.sh)"` reads the file **at grade time**, so editing
`bench/grade.sh` while a run is in flight grades against whatever the file says at
that instant. Measured here: a two-minute window during a mid-fix edit was enough for
a grade run to record `fail` for both members with
`grep: e2bbox: No such file or directory` — verdicts produced entirely by a
half-written grader, indistinguishable in the board from agents that got it wrong.

So: calibrate the grader *before* fanning out, and treat it as frozen from step 1
until the report is done. If you must change it, the run it belongs to is void.

**The one exception to grading a slug only once.** The rule against a second `--grade`
protects *good* verdicts. Verdicts produced by a broken grader are not worth
protecting, and re-grading is the repair, not a mistake. Tell them apart by reading
what the run actually used:

```sh
BENCH="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/herdr-e2b/bench/<slug>"
jq -r '.grade' "$BENCH/run.json" | head -30      # the exact grader those verdicts came from
jq -r '.stderr' "$BENCH"/*.json | head           # identical errors across members = the grader
```

A verdict whose `stderr` is the same shell error on every member is a grader failure.
Fix the grader, then re-grade the same slug deliberately and say in the report that
you did.

**Do not go hunting for a variable-expansion bug.** The trap here is that the disk no
longer matches what ran, so the stored grade command and the file appear to disagree —
which looks exactly like something mangling `"$E2B"` on the way to the sandbox. It is
not: `bin/e2b-box` passes the command as one argv element (`jq --arg`), and
`tui/src/grade.rs` passes it as one arg too. Compare timestamps before theorising:

```sh
BENCH="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/herdr-e2b/bench/<slug>"
jq -r '.gradedAt' "$BENCH"/*.json      # when the verdict was taken
stat -f %m bench/grade.sh              # when the grader last changed (Linux: stat -c %Y)
```

If the mtime is newer than `gradedAt`, the grader changed under the run and there is
nothing else to find.

## Reading the table

| column | meaning |
| --- | --- |
| `VERDICT` | the held-out test. `unreached` is about the box, not the agent |
| `SUITE` | `npm test` in the box. `pass`/`fail` are the agent's; `no-deps`, `nodeNN` and `execbit` are the template's (see below) |
| `IN` | **uncached** input tokens only |
| `CACHE` | cached input (read + creation) |
| `OUT` / `REASONING` | output; reasoning is broken out only by harnesses that report it, `0` = not broken out |
| `TOTAL` | the number to compare across harnesses |
| `COST` | USD, from ccusage's `totalCost` |
| `WALL` | brief written → last file write. Not "the agent decided it was done" |
| `DIFF` | the agent's work: unstaged vs the snapshot provision left in the index |
| `-` | not reported. Never estimated |

**Never rank on `IN` alone.** Harnesses cache their input completely differently, and
the gap is not subtle — measured on one run: claude reported **88** uncached input
against 3.8M cached, while codex reported **127k** against 4.1M. Reading `IN` as
"input" made claude look ~1400× cheaper on input than it was. `TOTAL` is the
comparable figure; `COST` is the one that matters.

**Three `SUITE` values are the image's fault, not the agent's**, and all three were
measured live:

- `nodeNN` — the template ships Node NN and this repo needs ≥ 22.
  `test/download.test.js` imports the e2b SDK, which `require()`s an ESM-only chalk,
  so v20 dies with `ERR_REQUIRE_ESM` no matter what the agent wrote.
- `execbit` — upload strips the mode bit, so `test/cli.test.sh` cannot invoke the
  `bin/e2b-box` it is testing and every CLI check returns `rc=126 Permission denied`.
- `no-deps` — `node_modules` is git-ignored and never uploaded; the agent never ran
  `npm ci`. This one *is* about the agent: it never ran the test the brief demanded.

**Templates are not uniform, so members are not graded identically.** Measured on one
fleet: the claude image had `/usr/bin/node` **v22.23.1** while the codex image had
`/usr/local/bin/node` **v20.9.0**. The grader's Node-dependent assertions therefore
*ran* for claude and *skipped* for codex — 11 assertions versus 7. Pass/fail ranking
survives that, but the skip counts differ, so report them per member rather than
quoting one total. Check with:

```sh
KEY=<member> e2b-box exec 'node -v; command -v node'
```

Keep the three kinds of failure distinct when reporting — conflating them is the one
thing that makes a benchmark lie: the change failed the contract (`Fail`), the box
could not be reached (`unreached`), the agent never verified its own work
(`no-deps`).

## Optional

```sh
bench/judge.sh <slug> && bench/judge.sh <slug> --reveal   # blind-score the diffs /5
e2b-box fleet kill <slug>                                 # boxes + worktrees go, branches stay
```

## If something looks off

| symptom | cause |
| --- | --- |
| `no boxes on branches matching 'e2b/<slug>-*'` | wrong slug, or already killed |
| every member `unreached`, but the panes are alive | **cluster mismatch** — scrub `E2B_DOMAIN`, `E2B_API_URL`, `E2B_API_KEY` and re-grade (see above) |
| every member `unreached`, panes dead too | boxes really are gone; `e2b-box open` in a member's worktree recreates one |
| `e2b sandbox list` → "No sandboxes found" while boxes run | same cluster mismatch, seen from the CLI side |
| `Unauthorized … Cannot get the team` | a key from another cluster; unset it rather than replacing it |
| verdicts replaced by `npm test` results | a second `--grade` on the same slug overwrote them |
| a member idle at a sign-in screen | its key never worked — `node scripts/verify-keys.mjs` |
| the grader fails identically on every member | suspect the grader, not the agents: `bash bench/grade.sh` on the host, and read `run.json`'s `.grade` |
| verdicts came from an edit made mid-run | the grader is read at grade time; that run is void — fix it and re-grade the slug |
| `Permission denied` running `bin/e2b-box` in a box | upload strips the exec bit; the grader must invoke through `bash` |
| `needs Node >= 22` inside a box | templates ship v20 and `exec` is a non-login shell; those assertions should skip, not fail |
| `bench/BENCH.md` missing | a `git clean` took it; untracked goes, ignored stays |
| `e2b-bench: command not found` | older install; `ln -sf "$PWD/bin/e2b-bench" ~/.local/bin/` — and note `e2b-box bench` is not a thing |
| `Command timed out after 60 seconds` | a `sleep` used as a wait — don't wait; stop and grade when you come back |
| several stacked background `sleep` jobs | the same mistake, sliced up; stop waiting and come back instead |
| `herdr agent wait` on a member never returns | herdr sees no agent there — the agent runs in the sandbox, not the pane |
| every agent scores suspiciously high | `git check-ignore -q bench/grade.sh` — if it exits 1 the grader was committed into their worktrees |
