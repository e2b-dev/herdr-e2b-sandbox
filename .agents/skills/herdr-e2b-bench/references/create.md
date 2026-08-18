# create — authoring a benchmark task

You are writing two files (`bench/BENCH.md`, `bench/grade.sh`), copying three
(`usage.sh`, `judge.sh`, `README.md`), and then **calibrating** — measuring what the
grader scores on an untouched repo and on a correct implementation. Skipping
calibration is the main way a benchmark ends up meaningless.

## 1. Pick a task, then verify the gap is still real

A good task here is a real ~20–60 LoC gap in this repo, with hard conventions
around it, gradable offline. Candidates that fit: a missing flag on an existing
verb, a new small verb, a `prune`-style cleanup with judgment about what is unsafe
to delete.

**Verify the gap before writing a word of brief.** A task carried over from
elsewhere may describe a gap that has since been filled — this exact trap already
bit once: a brief claimed `e2b-box` "cannot run a command non-interactively" long
after `exec` shipped, which would have had every agent arguing with its own
instructions. Grep for the thing you are about to ask for:

```sh
grep -rn -- '--yourflag\|your-verb' bin/ src/ README.md
```

If it exists, either pick something else or rewrite the gap paragraph to say what is
actually missing.

Prefer tasks whose grading needs no network and no `e2b` CLI inside the box. The
offline toolkit below is what makes that possible.

## 2. Write BENCH.md

Use `assets/BENCH.template.md` as the shape. What each section is for:

- **Orientation** — name the repo and the files to read first. Agents inside a box
  have no git history (`.git` is not uploaded), so point at files, never `git log`.
- **The gap** — why the change is wanted, in terms of what today's code cannot do.
  This is the paragraph that goes stale; keep it factual about current behaviour.
- **Required behavior** — a numbered contract. Every numbered point should be
  something `grade.sh` can check, including the boring ones (documented in the
  header comment, in `usage:`, in `README.md`). Numbered points are what make
  pass/fail mechanical instead of a matter of taste.
- **Constraints** — the house rules: match the existing bash style, honor
  `HERDR_PLUGIN_CONTEXT_JSON` cwd rebasing, the `$STATE_DIR` record layout, the
  `KEY` override, one credential path via `src/resolve-env.js`, the E2B SDK only in
  `src/*.js`. `npm test` must still pass. Scope is the one change.
- **Protect the contracts your own harness depends on.** If the task touches
  anything `e2b-bench` parses — `exec`'s JSON above all — say so explicitly. An
  agent that "tidies up" that output breaks the grader measuring it, and catching
  that is one of the most discriminating assertions available.
- **Done means** — a concrete two-line demo, plus "leave the working tree with your
  change in it; do not commit, do not push, do not open a PR". The verdict is read
  from the box's unstaged diff, so a committed change reads as an empty diff.
- **How it is scored** — say only what is actually measured. Promising a rubric the
  harness does not compute invites agents to optimise for nothing.

Keep it honest about what is graded versus what a human checks. If part of the ask
cannot be asserted offline — streaming output as it arrives, for instance — say
that it is preferred and that a human checks it, rather than pretending.

## 3. Write grade.sh

Start from `assets/grade.template.sh`. It already has the header, the two-way
`ROOT` resolution, the `ok`/`bad`/`skip` helpers and the isolated state dir.

### The offline toolkit

Everything below runs with no sandbox and no network, which is why a grader can be
a plain script injected as a string.

| you want to check | how |
| --- | --- |
| the script is syntactically valid | `bash -n bin/e2b-box` |
| behaviour with no box tracked | `KEY=nobox "$E2B" <verb>` against an empty state dir |
| behaviour with a box in some state | write a record JSON into `$STATE_DIR/boxes/<key>.json` |
| a Node entrypoint's contract | `node src/exec.js '{"key":"absent","cmd":"pwd"}'` — it answers before touching the SDK |
| how a command reaches the sandbox | stub `e2b` on `PATH`, log its argv |
| how a flag reaches a Node entrypoint | stub node behind `HERDR_E2B_NODE`, log its argv |

The node stub must answer the version gate first, because `e2b_node()` probes it:

```sh
cat > "$STUB/node" <<'EOS'
#!/usr/bin/env bash
[ "${1:-}" = "-e" ] && exit 0
printf '%s\n' "$*" >> "$STUB_LOG"
exit 0
EOS
```

### Two things about a box that a grader must respect

Both were measured live, and both make a correct grader report every member as
failing — which is the worst possible failure, since it looks like a result.

**Scripts arrive non-executable.** `uploadSnapshot` writes files with
`sandbox.files.write()`, which does not carry the mode bit, so `bin/e2b-box` and
`test/cli.test.sh` land as `100644`. A direct `"$E2B" …` dies with `Permission
denied` in every box at once. Invoke through bash:

```sh
e2bbox() { bash "$E2B" "$@"; }
```

`bash -n` and the greps are unaffected — they only read the file. (The repo's own
`npm test` already survives this because `package.json` says `bash test/cli.test.sh`.)

**The agent templates ship Node v20, and the plugin needs ≥ 22.** `e2b-box exec` runs
a non-login shell, so no version-manager shim is on `PATH` — measured inside a claude
template: `node -v` → `v20.9.0`, and `e2b_node()` fails with `needs Node >= 22`. Any
assertion that has to cross into `src/*.js` therefore cannot pass in that box no
matter what the agent wrote. Probe once and **skip** those, never fail them:

```sh
NODE22=0
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)' 2>/dev/null; then NODE22=1; fi
```

Docking every member equally for the template's node is not a ranking, and a grader
that reports an environment limit as the agent's mistake is worse than no grader. The
same instinct as SKIPping a legitimate alternative implementation: no credit, no
penalty. Prefer designing the contract so most of it is checkable in bash.

**Related fairness note when judging diffs:** because the checkout arrives with the
exec bit stripped, an agent that wanted `npm test` green may have `chmod +x`'d the
scripts. Git tracks mode, so that shows up as mode-change entries in the diff — the
environment's doing, not scope creep.

**And do not try to measure "did the agent stage its work".** There is no HEAD in a
box (`git init` + `git add -A`, no commit), so `git diff --cached` compares the index
against the *empty tree* and lists the entire repo — 162 files for every member,
always. `git status --porcelain` is no better, for the same reason: every file reads as
a staged addition. The unstaged diff is the only honest signal, and it happens to be
exactly the agent's work.

### Four rules that decide whether the scores mean anything

**Anchor every grep to the shape of the line you want.** A bare `grep -q "run"`
against a usage block passed on an untouched repo, because the existing text
already said "run one command" and "keeps running" — two points for free. Anchor
to the real shape: `grep -qE '^  run( |$)'` for a verb line, `grep -qE '^ +--raw( |,|$)'`
for an option line.

**Gate follow-on assertions on the feature existing.** An unknown verb and an
unknown flag both exit 2, so "bare invocation exits 2" passes for free against an
untouched repo unless it is gated:

```sh
if [ "$HAS_FEATURE" -eq 1 ]; then ... ; else skip "… (nothing to test yet)"; fi
```

**SKIP a legitimate alternative, never FAIL it.** If the brief can be satisfied
two ways — through the `e2b` CLI or through the SDK, carrying a flag in the payload
or in the environment — a stub that never fires means "implemented differently",
not "implemented wrong". Skipping earns no credit and costs none, which is the
right price.

**Guard the contracts, and expect a non-zero floor.** Assertions that verify
untouched behaviour survives (exec still prints one JSON object; the default exit
status is unchanged) pass on a virgin repo by definition. That is correct — they
are regression guards, not progress markers. Just report the floor honestly instead
of pretending it is zero.

End on `[ "$FAIL" -eq 0 ]` so the exit code is the verdict, and print the tally.

## 4. Copy the three reusable files

```sh
cp assets/usage.sh assets/judge.sh bench/
chmod +x bench/usage.sh bench/judge.sh
```

Then write `bench/README.md` from `assets/README.template.md`, filling the task
paragraph and the measured floor/ceiling. Add the ignore block:

```sh
cat assets/gitignore-block.txt >> .gitignore
```

## 5. Calibrate — measure both ends, then revert

This is the step that makes the benchmark trustworthy, and it costs nothing but a
few minutes locally.

```sh
bash bench/grade.sh        # the floor: what an untouched repo scores
```

Then write a throwaway correct implementation, run it again, and confirm every
assertion can pass:

```sh
bash bench/grade.sh        # the ceiling: should be N passed, 0 failed, 0 skipped
git checkout -- <files you touched>
git status --short          # only bench/ and .gitignore should remain
```

A grader nobody can max out wastes a whole fleet. A grader that scores high on an
untouched repo cannot rank anything. Record both numbers in `bench/README.md` so
the next person does not have to re-derive them.

Finally, confirm the holdout: `git status --short` must show `bench/` as untracked
(or only `BENCH.md`/`README.md` tracked), and `git check-ignore -v bench/grade.sh`
must report the ignore rule.

## Watch out for

- **jq deletes an object when any branch yields nothing.** `jq -n --arg s "" '{w:(if ($s|tonumber?) then 1 else null end)}'`
  prints **nothing** and exits 0 — `"" | tonumber?` yields no values, and an empty
  branch inside an object constructor takes the whole object with it. Rows vanish
  silently instead of reporting a missing value. Do arithmetic on possibly-empty
  strings in bash, then pass the result in with `--argjson`.
- **`printf "%'d"` does not group without a grouping locale.** Harmless, but do not
  assume thousands separators appear.
- **Do not reach for `shuf` or `sort -R`** in anything that shuffles — neither is on
  a stock macOS, and a silent fallback to alphabetical order by template *is* the
  mapping you were trying to hide. `$RANDOM` in a Fisher–Yates loop is enough.
