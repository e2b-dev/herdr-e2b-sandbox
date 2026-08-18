# Task — add `--raw` to `e2b-box exec`

You are working in a checkout of **herdr-e2b**, a herdr plugin that mirrors a
local git worktree into an E2B sandbox. Read `README.md`, `ARCHITECTURE.md`,
`AGENTS.md`, `bin/e2b-box`, `src/exec.js`, `docs/adr/`, and `test/` before
writing anything.

## The gap

`e2b-box exec CMD` reaches a box non-interactively, but it was built for the
grader (ADR-0004): it buffers the whole run and prints **one JSON object**, and
its own exit status is 0/1 on that contract rather than the command's. Good for a
machine, useless for a human or a shell pipeline — you cannot see output as it
happens, and you cannot tell exit 1 "the command failed" from exit 1 "we never
reached the box".

Close that gap with a flag, not a new verb.

## Required behavior

```
e2b-box exec [--raw] [--timeout-ms N] <cmd>
```

1. **Without `--raw`, nothing changes.** One JSON object on stdout, same keys,
   same values, same exit status as today. This is a hard contract:
   `tui/src/grade.rs` parses it, and `e2b-bench` is built on it.
2. With `--raw`, the command's stdout goes to stdout and its stderr goes to
   stderr, **verbatim** — no JSON, no wrapper, no added prefixes.
3. With `--raw`, `e2b-box` **exits with the command's own exit code**.
4. `--raw` composes with `--timeout-ms N`, in either order, before or after the
   command.
5. `--raw` when we never measured the command — no sandbox tracked, box gone,
   box unreachable, or the timeout killed it — prints the reason on **stderr**
   and exits `1`. It must never print JSON in this mode, and never invent an exit
   code for a command that did not run. Keep whatever partial output a killed
   command did produce.
6. `exec --raw` with no command → usage on stderr, exit `2`.
7. `--raw` appears in the header comment block of `bin/e2b-box` and in its
   `usage:` output, listed with the other options.
8. `README.md` documents it alongside `exec`.

## Constraints

- Match the existing code exactly: same bash style, same helpers, same comment
  density and voice. Do not restructure or reformat anything you did not need to
  touch, and do not add dependencies.
- Honor the repo's existing invariants — the `HERDR_PLUGIN_CONTEXT_JSON` cwd
  rebasing, the record layout under `HERDR_PLUGIN_STATE_DIR`, the `KEY` override,
  the `projectPath` working directory, and the way credentials reach the SDK
  (`src/resolve-env.js` via `bin/lib/paths.sh`). Do not invent a second
  credential path.
- `src/exec.js` stays the only place the E2B SDK is called (ARCHITECTURE.md,
  "Three layers"). Do not call the SDK from bash and do not add a second Node
  entrypoint for this.
- The `ok:false` / `exitCode` distinction ADR-0004 rests on must survive: "we
  never measured it" and "it ran and failed" are different outcomes in both
  output modes.
- `npm test` must still pass, unchanged.
- Scope is this one flag. No refactors, no drive-by fixes, no new files.

## Done means

`npm test` green, and against a ready box:

```sh
e2b-box exec --raw 'echo hi; exit 3'   # prints: hi   → exit 3
e2b-box exec 'echo hi; exit 3'         # prints one JSON object → unchanged
```

Prefer printing output **as it arrives** rather than only at the end — that is
the point of the flag, and the SDK's `onStdout` / `onStderr` callbacks are how.
The held-out test grades the contract above offline; streaming is what a human
checks.

Leave the working tree with your change in it; do not commit, do not push, do not
open a PR.

You will be scored by a held-out test of the contract above, run inside your own
box; whether the existing suite still passes; and how well the change reads as
part of this codebase.
