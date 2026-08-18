# Task — <one line: the change being asked for>

You are working in a checkout of **herdr-e2b**, a herdr plugin that mirrors a
local git worktree into an E2B sandbox. Read `README.md`, `ARCHITECTURE.md`,
`AGENTS.md`, `<the files this task touches>`, `docs/adr/`, and `test/` before
writing anything.

## The gap

<What today's code cannot do, factually. Verify this is still true before shipping
the brief — a gap that has since been filled makes every agent argue with its own
instructions. Name the reason the gap exists if there is one: a contract built for
a machine, a verb that was never needed until now.>

## Required behavior

```
<the exact invocation>
```

1. <Numbered, checkable contract points. One idea each.>
2. <Include the boring ones — documented in the header comment block, in the
   `usage:` output, in `README.md` — they are cheap to check and they separate
   agents that finish from agents that stop at "it works on my machine".>
3. <Say what must NOT change, especially anything `e2b-bench` parses.>

## Constraints

- Match the existing code exactly: same bash style, same helpers, same comment
  density and voice. Do not restructure or reformat anything you did not need to
  touch, and do not add dependencies.
- Honor the repo's existing invariants — the `HERDR_PLUGIN_CONTEXT_JSON` cwd
  rebasing, the record layout under `HERDR_PLUGIN_STATE_DIR`, the `KEY` override,
  the `projectPath` working directory, and the way credentials reach the SDK
  (`src/resolve-env.js` via `bin/lib/paths.sh`). Do not invent a second
  credential path.
- `src/*.js` stays the only place the E2B SDK is called (ARCHITECTURE.md, "Three
  layers"). Do not call the SDK from bash and do not add a second Node entrypoint.
- The `ok:false` / `exitCode` distinction ADR-0004 rests on must survive: "we never
  measured it" and "it ran and failed" are different outcomes.
- `npm test` must still pass, unchanged.
- Scope is this one change. No refactors, no drive-by fixes, no new files.

## Done means

`npm test` green, and against a ready box:

```sh
<two lines showing the new behaviour and the unchanged behaviour side by side>
```

<Anything preferred but not gradable offline goes here, labelled as such — say the
held-out test grades the contract and a human checks the rest, rather than
pretending the harness measures it.>

Leave the working tree with your change in it; do not commit, do not push, do not
open a PR.

You will be scored by a held-out test of the contract above, run inside your own
box; whether the existing suite still passes; and how well the change reads as
part of this codebase.
