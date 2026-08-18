# A fleet is a batch, not an entity

Fan-out (`fleet`) creates several worktrees at once, each with its own box, so one
base ref can be worked by several templates in parallel. We record **nothing** about
the fleet itself: no fleet file, no member list, no lifecycle. A fleet exists only as
the prefix its members' branch names share — `e2b/<task-slug>-<template>-<rand4>` —
so `e2b/<task-slug>-*` is a perfectly good fleet id whenever one is needed, and every
member stays an ordinary worktree that the existing per-worktree verbs already
understand.

## Considered options

A tracked fleet (a `fleet.json` with id, members, and status, plus `fleet status` /
`fleet down` operating on it) was rejected: it introduces a second source of truth
that can disagree with git and with the box records, and it can be orphaned by any
crash or by a member removed through plain `git worktree remove`. Deriving the same
answers from branch names and existing records cannot drift, because there is nothing
to drift from.

## Consequences

Anything fleet-wide is a glob, not a lookup, and is therefore only as reliable as the
branch-naming convention — a member renamed by hand leaves the fleet. Accepted: the
alternative is a file that lies. If per-fleet state is ever genuinely needed, the
branch prefix is the migration key.
