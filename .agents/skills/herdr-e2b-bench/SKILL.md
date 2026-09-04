---
name: herdr-e2b-bench
description: Build and run a coding-agent shootout in this repo — one task, N agents (claude, codex, opencode, amp, grok, droid, prime, muse), each in its own E2B sandbox, graded by a held-out test and compared on tokens, cost, wall clock and diff size. Takes one argument. `create` authors a new benchmark task: the brief (bench/BENCH.md), the held-out grader (bench/grade.sh), and the reusable measurement scripts (bench/usage.sh, bench/judge.sh, bench/README.md), then calibrates the grader by measuring its floor and its ceiling. `execute` drives an existing benchmark: fan out with e2b-box fleet, grade with e2b-bench, table with usage.sh, blind-judge with judge.sh, tear down. `quick` is `execute` on the fast task pair (bench/BENCH-quick.md + bench/grade-quick.sh) — ~5 minutes of agent time and a ~1s grader, for when you are testing the harness rather than the agents. Use this skill whenever the user mentions a bench, benchmark, shootout, race, "which agent is better", harness-bench, bench/BENCH.md, bench/grade.sh, held-out test, grading a fleet, best-of-n, or wants to compare coding agents on the same task, or says quick bench, fast bench, short bench, smoke bench, quick lap, or asks for a bench that does not take an hour — and also whenever they ask to add, change, calibrate, or score a benchmark task in this repo, or to run one for a demo recording. Prefer this over improvising e2b-fleet and e2b-bench calls by hand, because the held-out mechanics and the grader calibration are easy to get subtly wrong.
---

# herdr-e2b-bench — one task, N agents, one graded board

This repo can race coding agents against itself: `e2b-box fleet` fans one task out
to N agents in N sandboxes, `e2b-bench` runs a held-out check inside each box, and
two scripts in `bench/` supply everything a pass/fail verdict cannot carry.

Read the argument and go to the matching section. With no argument, ask which:
authoring a benchmark and running one are different jobs with different risks.

| argument | you are | read |
| --- | --- | --- |
| `create` | authoring a new benchmark task | [references/create.md](references/create.md) |
| `execute` | running one that already exists | [references/execute.md](references/execute.md) |
| `quick` | running the fast pair — same steps, quick files | [references/execute.md](references/execute.md) |

`quick` is `execute` with two filenames swapped; the "Which task pair" table at the
top of that reference is the whole difference. `execute` is three commands and a table — run them, report, done. `create` is an
ordered sequence where the order carries the safety, so work its headings in turn.

## What a benchmark is made of

Five files in `bench/`. Only two of them are per-task — that is the single most
useful thing to know before starting, because it turns "write a benchmark" into
"write a brief and a grader, copy three files".

| file | per-task? | what it is |
| --- | --- | --- |
| `BENCH.md` | **yes** | the brief handed to every agent |
| `grade.sh` | **yes** | the held-out test; its exit code is the verdict |
| `usage.sh` | no — copy from `assets/` | tokens, cost, wall clock, diff size, suite |
| `judge.sh` | no — copy from `assets/` | deals diffs face-down for the taste rows |
| `README.md` | mostly — fill the task paragraph | the runbook for whoever finds it later |

`assets/usage.sh` and `assets/judge.sh` are task-agnostic on purpose: they read box
records, run `ccusage` and `git diff` in the box, and know nothing about what the
task was. Copy them verbatim rather than regenerating them.

## The invariants that matter in both modes

These are the things that go wrong quietly. Everything else is recoverable.

**A held-out grader is held out by being uncommitted.** `e2b-box fleet` branches
every member off `HEAD` and prints `⚠️ N uncommitted file(s) will not be carried
into the fleet`. That warning *is* the mechanism — an uncommitted `bench/` is in no
member's worktree and is uploaded to no box. Confirm it with `git status --short`
before every run: anything committed is in every agent's context.

**Only the graders are secret.** `/bench/grade*.sh` must never be committed — a member
branches off `HEAD`, and an agent that can read the assertions is not being measured.
`usage.sh` and `judge.sh` are ignored for tidiness only: `bench/README.md` documents
every scored axis and is committed, so their contents reveal nothing. Do not spend
effort hiding the methodology; spend it on keeping the assertions out.

**`.gitignore` protects the scripts; nothing protects the brief.** A `git clean`
deletes untracked files and leaves ignored ones, so the ignored scripts survive and
an untracked `BENCH.md` does not. This has already happened once in this repo. Keep
`/bench/grade.sh`, `/bench/usage.sh`, `/bench/judge.sh` and `/bench/judged/` in
`.gitignore` (see `assets/gitignore-block.txt`), and either commit `BENCH.md` — it
is meant for the agents anyway — or accept that a clean takes it.

**The grader reaches a box as a string, not a file.** `e2b-bench <slug> --grade
"$(cat bench/grade.sh)"` ships the whole script as one argv element, which is what
keeps it out of every sandbox. It also means the script has no file of its own to
be relative to, so any path math must survive an empty `BASH_SOURCE`.

**Never grade the same slug twice.** ADR-0005 makes the bench run id the fleet
slug, so a second `--grade` on the same slug overwrites the held-out verdicts in
`$STATE_DIR/bench/<slug>/`. Anything else worth measuring — `npm test`, diff size —
belongs in `usage.sh` as a reported column, not as a second graded run.

**Grading a paused box just works.** `src/exec.js` connects with
`Sandbox.connect`, which resumes a paused box and re-arms its idle timeout, and
`auto_pause` is on. Close the lid and grade tomorrow; that is a property, not a
workaround.

**"Unreachable" and "failed" are different outcomes.** `e2b-box exec` returns
`ok:false` when it never measured the command and `ok:true` + a non-zero
`exitCode` when the command ran and failed. ADR-0004 rests on that split: a dead
sandbox must never score as a failing agent. Preserve it in anything you write —
`usage.sh` renders such a member as `unreached`, never as zeros.

## Repo facts worth not rediscovering

- **Roster** comes from `[templates.*.env]` in the user's plugin config; `--all`
  races every agent configured there, `--agents claude,codex` races a subset.
- **`.git` is not uploaded.** Each box gets a fresh `git init` + `git add -A` and
  **no commit**, so the index is the uploaded snapshot and `git diff` is exactly
  the agent's work — read-only, no HEAD needed (`src/provision.js:212`).
- **`node_modules` is git-ignored and never uploaded**, so `npm test` in a box
  fails until someone runs `npm ci`. `suite=no-deps` is a real result about the
  agent, not a defect in the harness.
- **A box needs `jq`, `git` and Node ≥ 22** for the grader to drive `bin/e2b-box`.
  No template ships the `e2b` CLI — prefer tasks that do not need it in the box.
- **`HERDR_E2B_BOX`** overrides the box CLI in `usage.sh`/`judge.sh`, which is how
  you test them offline against a stub instead of spending sandboxes.

## Before a run, if you have a reason to doubt

Not a gate — `execute` does not check anything, it runs. But two failures are
invisible at runtime and worth a command when something smells off:

```sh
git check-ignore -q bench/grade.sh || echo "grader NOT ignored — agents can read it"
node scripts/verify-keys.mjs        # a bad key does not fail at spawn; the agent just idles
```

A committed grader produces a table that looks completely valid, which is why
suspiciously high scores are the symptom to check it against.

## Exit codes you will meet that are not errors

Several checks here communicate through exit status, and reading them as command
failures leads to either a wasted fleet or a compromised benchmark.

| command | non-zero means |
| --- | --- |
| `git check-ignore <path>` | the path is **not** ignored — the holdout is off |
| `bash bench/grade.sh` | assertions failed — expected on an untouched repo, that is the floor |
| `e2b-box exec` | the command in the box failed, **or** the box was unreachable — read the JSON's `ok` to tell which |
| `e2b-bench <slug> --grade …` | some member failed or could not be reached |
