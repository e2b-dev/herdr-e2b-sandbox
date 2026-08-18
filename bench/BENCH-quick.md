# Task — add `--json` to `pane-parse panes`

You are working in a checkout of **herdr-e2b**, a herdr plugin that mirrors a
local git worktree into an E2B sandbox. This is a small, contained task: read
`src/pane-parse.js` and `bin/e2b-dash-toggle` (the only caller) before writing
anything. You do not need the rest of the repo.

## The gap

`node src/pane-parse.js panes <title>` prints one line of three space-separated
fields — `<focused_pane> <dashboard_pane> <tab_pane_ids>` — with `-` for anything
absent, because its caller is a keybinding that does `read -r a b c`. That shape
is perfect for a shell and lossy for everything else: `-` is both "no pane" and
"a pane literally named -", and the tab list is one comma-joined field a JSON
consumer has to re-split.

Close that gap with a flag, not a new mode.

## Required behavior

```
node src/pane-parse.js panes [--json] <title>
```

1. **Without `--json`, nothing changes.** Same one line, same three fields, same
   `-` placeholders, same `- - -` for empty or malformed stdin, same exit `0`.
   This is a hard contract: `bin/e2b-dash-toggle` runs inside a keybinding and
   must never get a second line or a missing field.
2. With `--json`, stdout is **one JSON object** and nothing else, with exactly
   these keys:
   - `focused` — the focused pane's `pane_id`, or `null`
   - `dashboard` — the `pane_id` of the pane whose `label` is `<title>`, or `null`
   - `tab` — an **array** of the `pane_id`s sharing the focused pane's tab,
     `[]` when there is no focused pane
3. `--json` works in either order: before or after `<title>`.
4. Empty or malformed stdin stays an ordinary outcome in both modes — no throw,
   exit `0`, and `--json` prints `{"focused":null,"dashboard":null,"tab":[]}`.
5. `procs` is untouched, and an unknown mode still prints its message on
   **stderr** and exits `2` — never JSON.
6. `--json` appears in the header comment block of `src/pane-parse.js`, in the
   `panes` line of the Modes list.
7. Add `test/pane-parse.test.js` covering both modes, in the style of
   `test/fleet-name.test.js` (`node:test` + `node:assert/strict`, no deps). It
   must pass with `node --test test/pane-parse.test.js`.

## Constraints

- Match the existing code exactly: same style, same comment density and voice.
  Do not restructure or reformat anything you did not need to touch.
- No dependencies, no new files other than the test.
- `process.exit()` still must not truncate a pipe mid-write — the file says why.
- Scope is this one flag plus its test. No refactors, no drive-by fixes.

## Done means

```sh
echo '{"result":{"panes":[{"pane_id":"p1","tab_id":"t1","focused":true},{"pane_id":"p2","tab_id":"t1","label":"e2b-dash"}]}}' \
  | node src/pane-parse.js panes e2b-dash          # p1 p2 p1,p2      (unchanged)
echo '{"result":{"panes":[{"pane_id":"p1","tab_id":"t1","focused":true},{"pane_id":"p2","tab_id":"t1","label":"e2b-dash"}]}}' \
  | node src/pane-parse.js panes --json e2b-dash   # {"focused":"p1","dashboard":"p2","tab":["p1","p2"]}
node --test test/pane-parse.test.js                # green
```

Leave the working tree with your change in it; do not commit, do not push, do not
open a PR. You do not need to run `npm install` or the full `npm test`.

You will be scored by a held-out test of the contract above, run inside your own
box; whether your own test file passes; and how well the change reads as part of
this codebase.
