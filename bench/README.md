# bench — one task, every agent, one graded board

The benchmark task this repo races agents on, brought over from
`playground/harness-bench` now that spawning and grading both live in the plugin
([ADR-0004](../docs/adr/0004-the-plugin-grades-a-fleet-superseding-0002.md)).
The skill's ~3,200 lines are not brought over with it — `e2b-box fleet`,
`e2b-bench` and the two scripts here are what replaced them.

| file | what it is | who may see it |
| --- | --- | --- |
| `BENCH.md` | the brief every member's agent is handed | the agents |
| `grade.sh` | the held-out contract test | nobody until grade time |
| `BENCH-quick.md` | the ~5-minute brief, for a fast lap | the agents |
| `grade-quick.sh` | its held-out test, ~1s per box | nobody until grade time |
| `usage.sh` | tokens, cost, wall clock, diff size, suite | nobody |
| `judge.sh` | deals every diff face-down for the two /5 rows | nobody |

None of the three scripts is committed. `e2b-box fleet` branches every member off
`HEAD` and warns that uncommitted files are not carried into the fleet — that
warning is the mechanism: an uncommitted `bench/` is in no member's worktree and
is uploaded to no box. `grade.sh` reaches a box only as the `--grade` string,
which is why it also works with no file of its own to be relative to.

`usage.sh` and `judge.sh` are ignored for tidiness, not secrecy: the axis table below
is committed and names every scored axis, so their contents reveal nothing that is not
already public. The **graders** are the only real secret — `.gitignore` pins
`/bench/grade*.sh` so the quick one is covered too, plus `judged/`.

**`BENCH.md` and this file are untracked, so a `git clean` takes them** — and it
already did once, right after a `git pull`. The ignored scripts survive that;
these two do not. Commit them, or keep a copy, before any cleaning.

## The task

Add `--raw` to `e2b-box exec`. Today `exec` prints one JSON object and its exit
status is 0/1 on that contract — built for the grader (ADR-0004), useless to a
human. `--raw` passes the command's stdout/stderr through verbatim and exits with
the command's own code, while the JSON default stays byte-identical.

A flag, not a verb, and that is the point: `tui/src/grade.rs` parses `exec`'s
JSON, so the default path is a contract rather than a default. An agent that
"tidies up" the output while adding the flag breaks the thing grading it. Two of
the eleven assertions are regression guards on exactly that, which is why the
floor is not zero.

## The quick lap

`BENCH.md` is a real task and costs a real hour: `bin/e2b-box` is 1,009 lines, the
brief points at six files plus `docs/adr/`, and the agent is told to keep `npm test`
green — which means `npm ci` in the box before it can even check itself.

`BENCH-quick.md` is the same shape at a tenth of the size, for when what you are
testing is the harness (a new agent, a new template, a key that may not be signed
in) rather than the agents. Add `--json` to `pane-parse panes`: one 52-line pure
stdin→stdout filter, one caller, no SDK, no deps, no `npm install`, plus a
`test/pane-parse.test.js` of the agent's own. Five minutes of agent time.

`grade-quick.sh` is thirteen assertions and runs in about a second per box —
every one of them is a `node` call over a fixture string, so there is no E2B, no
network, no `jq`, and no Node >= 22 gate (`pane-parse.js` is plain ESM and never
touches the SDK, which is why nothing here has to SKIP the way the `--raw` grader
does on a template shipping Node 20).

Same floor logic, measured both ways: an untouched checkout scores `5 passed, 8
failed` — the five are regression guards on the one-line default, `procs`, and
the exit-2 path, because `bin/e2b-dash-toggle` does `read -r a b c` inside a
keybinding and an agent that "improves" that line while adding the flag breaks
its only caller. A reference implementation scores `13 passed`.

Swap two strings in the run below and nothing else changes:

```sh
e2b-box fleet quick-1 --agents claude,codex --task "$(cat bench/BENCH-quick.md)"
e2b-bench quick-1 --grade "$(cat bench/grade-quick.sh)"
```

`usage.sh` still works unchanged and will report `suite=no-deps`, which is the
honest answer here rather than a miss: the quick brief explicitly does not ask
for `npm install` or the full suite, and grades the agent's own test file instead.

## Run it

```sh
# 0. preflight — one throwaway box per template, each agent must answer for its KEY
node scripts/verify-keys.mjs

# 1. fan out — one box + one herdr tab per agent, each handed the brief
e2b-box fleet raw-1 --agents claude,codex --task "$(cat bench/BENCH.md)"

# 2. watch the tabs, or the board. Close the lid whenever — the boxes keep going.

# 3. grade — the held-out test, run inside every member's box at once
e2b-bench raw-1 --grade "$(cat bench/grade.sh)"

# 4. the board again, with verdicts
e2b-bench raw-1

# 5. everything the verdict does not carry, in one table
bench/usage.sh raw-1

# 6. the two rows that need taste — diffs dealt face-down, then the mapping
bench/judge.sh raw-1
bench/judge.sh raw-1 --reveal

# 7. down (members' branches survive; --prune-branches opts into deleting them)
e2b-box fleet kill raw-1
```

`--dry-run` on step 1 prints every herdr and box call and creates nothing. Swap
`--agents claude,codex` for `--all` to race every agent your config knows. Step 0
is not optional in spirit: a bad key does not fail at spawn — the member boots,
the box is green, and the agent sits on a sign-in screen its pane never shows you.

## Reading the grade

The verdict is the grader's exit code and nothing more — pass, fail, or "the box
could not be reached", which ADR-0004 keeps distinct on purpose: a dead sandbox
must never score as a failing agent. Rubrics, weighted scores and "which diff is
nicer" stay out; the exit code is the interface to whoever wants an opinion.

Eleven assertions. An untouched checkout scores `3 passed, 3 failed, 5 skipped`;
a reference implementation scores `11 passed`. Both were measured — `bash
bench/grade.sh` shows the floor on the host.

The plumbing block SKIPs rather than FAILs when its stub node never sees a
payload: carrying `--raw` some other way than through the exec.js payload is a
legitimate reading of the brief, so it earns no credit but costs none either.

## What each axis comes from

`e2b-bench` answers one question — did the held-out test pass — because ADR-0004
traded everything else away to get grading into the plugin at all. The rest lives
in `bench/`, and deliberately: a ccusage hiccup inside `grade.sh` would surface as
a failing agent, which is the exact confusion the `ok:false` / `exitCode` split
exists to prevent.

| axis | where it comes from |
| --- | --- |
| held-out test | `e2b-bench <slug> --grade "$(cat bench/grade.sh)"` |
| existing suite green | `usage.sh` → `npm test` in the box, reported not graded |
| tokens in / out / reasoning | `usage.sh` → `ccusage session --json` in the box |
| cost USD | same call, `totalCost` |
| wall clock | `usage.sh` → brief mtime → newest project-file mtime |
| diff size | `usage.sh` → `git diff --shortstat` in the box |
| judge /5 rows | `judge.sh` → blind dealing, scored by a human |

Four things that shape those numbers:

- **`npm test` is reported, never graded.** Running it as a second
  `e2b-bench <slug> --grade 'npm test'` would overwrite the held-out verdicts —
  ADR-0005 makes the run id the fleet slug, so a second grade of the same slug
  lands in the same directory. That is why it is a `usage.sh` column instead.
- **`suite=no-deps` is a real result.** `node_modules` is git-ignored and so never
  uploaded; if it is absent, the agent never installed deps and never ran the test
  the brief demanded. `--install` opts into paying for `npm ci` first.
- **Diff size rides on a detail of provisioning.** `src/provision.js:212` runs
  `git init` + `git add -A` and **never commits**, so the index *is* the uploaded
  snapshot and `git diff` is exactly the agent's work — read-only, no HEAD needed.
  An agent that stages its own changes shrinks that diff, so the row prints
  `(staged:N)` beside it: a big `staged` next to a small diff means the number is
  under-reporting, not that nothing happened.
- **Wall clock is `to-last-write`, not "the agent finished".** Nothing reports the
  latter for a TUI — harness-bench needed a pane watcher comparing whole frames,
  and specifically *not* grepping for a busy word, because Claude Code prints
  `esc to interrupt` while idle and while thinking. Two mtimes the run leaves
  behind are honest and need no watcher; the label says what they measure.

Missing is always `-`. Never estimated — a blank cell and a real zero are
different facts, and comparing them is the whole point.

## Sharp edges that still apply

- **`.git` is not uploaded.** Each box gets a fresh `git init`, so agents inside
  have no history to read. The brief asks for files, never `git log`.
- **Grading a paused box just works.** `auto_pause` is on, and `src/exec.js`
  connects with `Sandbox.connect`, which resumes a paused box and re-arms its
  idle timeout. Close the lid, grade in the morning — that is the demo beat, not
  a workaround.
- **A record can outlive its sandbox.** A manual kill leaves the record claiming
  `ready`; `exec` reports `sandbox for '<key>' is gone` rather than inventing a
  verdict, and `e2b-box open` in that member's worktree recreates it. `usage.sh`
  renders that member as `unreached`, never as zeros.
- **Do not `git worktree remove` a member before grading** — the
  `worktree.removed` event tears its box down by design. `fleet kill` is the verb.
- **A box needs `jq`, `git` and Node >= 22** — the grader drives `bin/e2b-box`,
  the same prereqs as the `npm test` the brief requires. Check one with
  `KEY=<member> e2b-box exec 'command -v jq git node'`. Nothing here needs the
  `e2b` CLI inside the box, which no template ships: this task lives on the SDK
  side of the seam, and the grader stubs node rather than the CLI.
- **ccusage's cost key is uniform again.** harness-bench had to try both
  `totals.totalCost` (claude) and `totals.costUSD` (codex), and reading only the
  first published every Codex cost as `n/a`. Verified against the current
  release: `session[]` rows carry `.agent` and a uniform `.totalCost` for claude,
  codex, droid, grok and opencode alike. Only `metadata.reasoningOutputTokens` is
  still codex-only — nobody else breaks thinking out of `outputTokens`, so a `0`
  there means "not broken out", never "did not think".

Edges harness-bench documented that this plugin has since absorbed: per-template
key injection (`[templates.*.env]` → `src/fleet-seed.js`, which turns
`OPENAI_API_KEY` into codex's `~/.codex/auth.json` rather than expecting
`CODEX_API_KEY`), the current codex flag
(`--dangerously-bypass-approvals-and-sandbox`), template routing by `--agents`
instead of `[[sandbox.template_rules]]` written into someone else's config, and
`auto_pause`.
