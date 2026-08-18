# A bench run is an entity (a fleet still isn't)

**Qualifies:** [0001 — a fleet is a batch, not an entity](0001-a-fleet-is-a-batch-not-an-entity.md)

ADR-0001 records nothing about a fleet: it exists only as the branch prefix its
members share, so `e2b/<slug>-*` is the fleet id and nothing can drift because
there is nothing to drift from. It closes by naming its own escape hatch — "if
per-fleet state is ever genuinely needed, the branch prefix is the migration key."

Grading needs it, so this ADR takes that hatch, for **bench runs only**.

## Why a fleet can stay derivable and a bench run cannot

Everything ADR-0001 needs about a fleet is observable at the moment you ask.
Members? Glob the branches. Are they up? Read the box records. Where are they?
`git worktree list`. Nothing has to be remembered because nothing is *history* —
it's all present state, and re-deriving it is strictly more truthful than a file.

A verdict is not present state. "This member passed the held-out test at 14:02,
in 4m12s, on this command" is a thing that *happened*. It is not observable from
the box afterwards — the box has moved on, the agent kept working, the test may
pass now and not then. Re-running to find out is not re-derivation, it is a
different measurement. A run that cannot be recorded cannot be compared, and
comparison is the whole point.

So the rule ADR-0001 actually encodes is narrower than "no state": **don't persist
what you can observe.** A fleet is observable. A verdict is not.

## The decision

`$STATE_DIR/bench/<run-id>/` holds one `run.json` (the task, the grade command,
the base ref, when it started) and one `<member-key>.json` per member (verdict,
exit code, duration, output tails, when it was graded). One file per member,
written atomically, same shape and same reasons as the box records in
`$STATE_DIR/boxes/` — a per-member file needs no locking, cannot interleave two
half-written results, and a member that never finishes simply has no file.

The run id is the fleet's task slug. That is ADR-0001's migration key used exactly
as it was intended: the branch prefix is what ties a graded run to the members it
graded, so a bench run is a *view over* a fleet rather than a second registry of
one.

## What is deliberately not in the record

The member list. It stays derived from branches and box records, the ADR-0001 way,
and is re-globbed on every read. Writing it down would create the second source of
truth ADR-0001 rejected — a member removed with plain `git worktree remove` would
linger in the file forever. A result file is keyed by box key; if the member is
gone, its result is history about something that no longer exists, which is what
history is.

## Consequences

- A bench directory can outlive its fleet. That is intended: the verdicts are the
  artifact, the boxes were the means. Nothing kills them but the user.
- Results are append-only in practice; re-grading a member overwrites its file,
  and the run is whatever the files currently say.
- The dashboard is unaffected — it reads `boxes/`, and knows nothing about a
  bench. Teaching it the concept stays out of scope, same as fleets.
