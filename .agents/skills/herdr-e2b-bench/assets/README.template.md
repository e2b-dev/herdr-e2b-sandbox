# bench — one task, every agent, one graded board

<One paragraph: what this benchmark asks and why that task.>

| file | what it is | who may see it |
| --- | --- | --- |
| `BENCH.md` | the brief every member's agent is handed | the agents |
| `grade.sh` | the held-out contract test | nobody until grade time |
| `usage.sh` | tokens, cost, wall clock, diff size, suite | nobody |
| `judge.sh` | deals every diff face-down for the two /5 rows | nobody |

None of the three scripts is committed. `e2b-box fleet` branches every member off
`HEAD` and warns that uncommitted files are not carried into the fleet — that
warning is the mechanism: an uncommitted `bench/` is in no member's worktree and
is uploaded to no box. `grade.sh` reaches a box only as the `--grade` string,
which is why it also works with no file of its own to be relative to.

`usage.sh` and `judge.sh` stay out for a softer reason: knowing which axes are
measured is a way to game them. `.gitignore` pins all three plus `judged/`.

**`BENCH.md` and this file are untracked, so a `git clean` takes them.** The
ignored scripts survive that; these two do not. Commit them, or keep a copy.

## Run it

```sh
node scripts/verify-keys.mjs                                          # 0. preflight
e2b-box fleet <slug> --agents claude,codex --task "$(cat bench/BENCH.md)"  # 1. fan out
e2b-bench <slug> --grade "$(cat bench/grade.sh)"                      # 3. grade
e2b-bench <slug>                                                      # 4. verdicts
bench/usage.sh <slug>                                                 # 5. the table
bench/judge.sh <slug> && bench/judge.sh <slug> --reveal               # 6. taste rows
e2b-box fleet kill <slug>                                             # 7. down
```

## Reading the grade

The verdict is the grader's exit code and nothing more — pass, fail, or "the box
could not be reached", which ADR-0004 keeps distinct on purpose: a dead sandbox
must never score as a failing agent.

<N> assertions. An untouched checkout scores `<measured floor>`; a reference
implementation scores `<measured ceiling>`. Both were measured — `bash
bench/grade.sh` shows the floor on the host.

## What each axis comes from

| axis | where it comes from |
| --- | --- |
| held-out test | `e2b-bench <slug> --grade "$(cat bench/grade.sh)"` |
| existing suite green | `usage.sh` → `npm test` in the box, reported not graded |
| tokens in / out / reasoning | `usage.sh` → `ccusage session --json` in the box |
| cost USD | same call, `totalCost` |
| wall clock | `usage.sh` → brief mtime → newest project-file mtime |
| diff size | `usage.sh` → `git diff --shortstat` in the box |
| judge /5 rows | `judge.sh` → blind dealing, scored by a human |

- **`npm test` is reported, never graded** — a second `--grade` on the same slug
  would overwrite the held-out verdicts (ADR-0005 makes the run id the slug).
- **`suite=no-deps` is a real result** — `node_modules` is never uploaded, so its
  absence means the agent never installed deps or ran the test the brief demanded.
- **Diff size rides on `src/provision.js:212`** — `git init` + `git add -A` and no
  commit, so the index is the uploaded snapshot and `git diff` is the agent's work.
  There is no HEAD, so `git diff --cached` is useless here (index vs empty tree = the
  whole repo, for every member).
- **`SUITE` has three environmental values** — `nodeNN` (template's Node is below the
  repo's floor), `execbit` (upload stripped the mode bit, `cli.test.sh` gets rc=126),
  and `no-deps`. Only `fail` is the agent's.
- **Compare `TOTAL` tokens, never `IN`** — harnesses cache input very differently.
- **Wall clock is to-last-write**, not "the agent finished" — nothing reports the
  latter for a TUI.

Missing is always `-`. Never estimated.
