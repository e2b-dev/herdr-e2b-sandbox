# The plugin grades a fleet (supersedes ADR-0002)

**Supersedes:** [0002 — the plugin spawns fleets; it does not judge them](0002-the-plugin-spawns-fleets-it-does-not-judge-them.md)

ADR-0002 drew the line at "every member is a running worktree with a booted box"
and left comparing what they produced to whatever harness wanted it — naming the
`harness-bench` skill, which would "keep its task, grader, and judge and rewrite
only its spawn phase to call `fleet`". That rewrite never happened, and the reason
it never happened is the reason this ADR reverses it.

## What actually happened

By the time `fleet` shipped, the skill was ~3,200 lines across 17 scripts. Lining
its verbs up against the plugin's:

| skill | plugin |
| --- | --- |
| `setup` `configure` `boot` `run` | `e2b-fleet` |
| `teardown` | `e2b-fleet down` |
| `watch` `status` | the dashboard |
| `pull` | `e2b-box pull` |
| `agents` | `[fleet.agents]` |
| `grade` `judge` `report` `usage` | — |

Roughly 2,600 of those 3,200 lines were duplicates of verbs the plugin had grown.
The seam ADR-0002 protected was no longer between two systems; it ran through the
middle of one, with the smaller half stranded outside.

The cost was not hypothetical. To route each member to the right image the skill
appended `[[sandbox.template_rules]]` mapping `^bench/<slug>/` into the plugin's
own `config.toml` — one tool writing its private vocabulary into another tool's
config, rules that outlive the run and that the plugin never needed (`fleet`
passes `-t`). Opening that file months later, `bench/` was unexplainable. That is
what an artificial seam costs: not a missing feature, but coupling that leaks
across it in whatever shape fits.

## The decision

Grading moves in. The plugin runs the held-out check inside each member's box,
records a verdict per member, and shows the fleet as a graded board.

## Why the original objection no longer holds

ADR-0002's argument was that grading "needs a rubric, a held-out test, and an
opinion about what better means, none of which belong to a tool whose job is
mirroring a worktree into a sandbox." Two of those three are inputs, not
opinions: the held-out test is a **command the user supplies**, and the verdict is
**its exit code**. The plugin forms no opinion about what better means — it runs
what it is given and reports what happened. Ranking beyond pass/fail, rubrics, and
LLM judging stay out, and that is where the line now sits.

The mechanism is also already ours. Running a command in a box needs the E2B SDK,
which is JavaScript-only, so it could only ever have lived in `src/*.js`
(`exec.js`). An external harness grading a box had to shell back through this
plugin anyway; the seam was costing coupling and buying nothing.

## What stays out

Rubrics, LLM judges, weighted scores, "which diff is nicer". A verdict here is
pass, fail, or the box could not be reached. Anything that needs taste is
somebody else's job, and the exit code is the interface to it.

## Consequences

- A bench run is persisted state, which ADR-0001 did not allow for fleets. See
  [0005](0005-a-bench-run-is-an-entity.md).
- `fleet` is unchanged and still useful with nothing to grade: three agents, one
  task, pick the diff you like. Grading is a verb you point at a fleet, not a
  thing a fleet does.
- The distinction `exec.js` draws — box unreachable versus command failed — is
  load-bearing here. A crashed sandbox must never score as a failing agent.
