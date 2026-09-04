# herdr-e2b command reference

Ground truth: `bin/e2b-box`, `bin/e2b-fleet`, `bin/e2b-bench`, `bin/e2b-dash` at
this repo's root. When behavior here and the binary disagree, trust `--help` /
the script header — then fix this file.

## Contents

- [Identity & state](#identity--state)
- [e2b-box](#e2b-box) — session / files / lifecycle / inspect
- [e2b-fleet](#e2b-fleet) — create / kill, full flag grammar
- [e2b-bench](#e2b-bench)
- [e2b-dash](#e2b-dash)
- [herdr actions & keybindings](#herdr-actions--keybindings)
- [Configuration](#configuration)
- [Env overrides](#env-overrides)

## Identity & state

- A box's identity is the FOLDER you run from (folder name + path hash) — not the
  branch. Two same-named folders never share a box; a repo on `main` doesn't key as
  "main". The mirrored root is `$PWD`, never the git toplevel.
- State dir: `${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/e2b-dev.herdr-e2b}`
  - `boxes/<key>.json` — per-box record (status, sandboxId, url, template)
  - `boxes/<key>.log` — provisioning log (`e2b-box logs` tails it)
  - `fleets/<slug>.log` — fleet per-member report (what `create` prints)
  - `bench/<slug>/` — grading verdicts (ADR-0005: a bench run is an entity)
- Config file: `~/.config/herdr/plugins/config/e2b-dev.herdr-e2b/config.toml`
  (or `$HERDR_PLUGIN_CONFIG_DIR/config.toml`).
- Fleet members are found by BRANCH PREFIX `e2b/<slug>-` — nothing about a fleet is
  persisted as an object (ADR-0001). Branch shape: `e2b/<slug>-<template>-<rand4>`, where `<template>` is the template's
  LAST path segment — `ondrejs-project/herdr-agents` gives `…-herdr-agents-<rand4>`.
  Two roster entries that would collapse to the same name are refused, naming both.

## e2b-box

`e2b-box` with no command = `open`. `-t/--template NAME` is parsed globally for the
creating verbs (`open`, `up`): what a NEW box boots from; otherwise a branch rule
(`[[template_rules]]`) decides, else a picker asks (tty) / config default.

### session

| command | effect |
|---|---|
| `e2b-box open [-t NAME]` | boot or reconnect this worktree's box, then attach a shell. Exit 130 if the template picker is aborted. |
| `e2b-box up [-t NAME]` | same provisioning, but backgrounded — you stay in the local shell |
| `e2b-box shell` | attach to an EXISTING box; never creates one (exit 1 if none) |
| `e2b-box exec <cmd> [--timeout-ms N]` | run one command inside the box over the SDK, print output. The orchestrator's probe. No length limit, no pty. |

### files

| command | effect |
|---|---|
| `e2b-box sync` | upload the current worktree into the box (local → box). Provisions a fresh (billable) box if none is tracked — it says so first. |
| `e2b-box pull [--force]` | download the box's project dir back over this folder (box → local). Aborts on a dirty or non-git tree unless `--force`. |

### lifecycle

| command | effect |
|---|---|
| `e2b-box pause` | freeze the box — filesystem AND memory kept, billing clock stops |
| `e2b-box resume` | thaw a paused box, same sandbox id |
| `e2b-box kill` | destroy the box; worktree and branch untouched |

### inspect

| command | effect |
|---|---|
| `e2b-box status` | this worktree's record as JSON. Note: status is last-known — a "ready" box may have idle-timed-out; `open` reconciles. |
| `e2b-box list` | table of every tracked box: BOX / STATUS / TEMPLATE / SANDBOX / URL |
| `e2b-box url` | the forwarded preview URL (port from `server_port`, default 3000) |
| `e2b-box logs` | `tail -f` the provisioning log |

### pass-throughs

- `e2b-box fleet …` → `e2b-fleet` (exec, flags forwarded untouched)
- `e2b-box dash` / `e2b-box dash toggle` → `e2b-dash` / `e2b-dash-toggle`

## e2b-fleet

Fan the CURRENT CHECKOUT's HEAD out into N members: worktree + branch + herdr
workspace + box + agent per template. Must run inside a git repo. Uncommitted
changes are warned about and left behind — members start clean (ADR-0003).

### grammar

```
e2b-fleet                                      # pickers (slug, roster) → board  [human]
e2b-fleet [create] <slug> [flags]              # named up front; `create` optional
e2b-fleet kill <slug> [--prune-branches] [--force] [--dry-run]
```

Presentation rule: a tty gets the live board; no tty (agent/script/CI) gets
foreground provisioning + per-member summary + exit code. Same command line.
Exit 0 only when every member came up.

### create flags

| flag | meaning |
|---|---|
| `<slug>` / `--slug` / `-s` | fleet name; sanitized into a legal git ref component; becomes `e2b/<slug>-…` branch prefix — the fleet's only identity |
| `--agents a,b,c` / `-a` | the roster, comma-separated (spaces after commas forgiven). `--agents all` = whole configured roster. |
| `--all` | same as `--agents all` |
| `--template NAME` / `-t` | one roster entry at a time (repeatable; duplicate = one member). Honest spelling for a control arm: `-t base` boots a box with NO agent when `[fleet.agents]` maps it to `""`. |
| `--task TEXT` | ONE instruction delivered to every member's agent at launch. One argv element — quote once; the text travels via a file in the box (`~/.herdr-e2b-task.md`), so length/quoting are safe. Optional: no task = ready boxes with idle agents. |
| `--dry-run` / `-n` | print every herdr/box command the run would execute; create nothing; exit 0 |
| `--force` / `-f` | allow a roster name the config has never heard of (template exists only on E2B) |
| `--no-dashboard` | tty but want the summary + exit code instead of the board |
| `--dashboard` | legacy, force the board (pickers imply it now) |

Agent-per-template launch commands come from `[fleet.agents]` config over shipped
defaults (all "don't ask permission" flags, verified per vendor):
`claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`,
`grok --always-approve`, `amp --dangerously-allow-all` (task via stdin pipe),
`opencode --auto --prompt`, `prime-agent`, `muse --yolo`, bare `droid`. Mapping a template to `""`
= plain shell, no agent.

### kill

| command | effect |
|---|---|
| `e2b-fleet kill <slug>` | kill every member's box, remove every member's worktree, KEEP every branch |
| `… --prune-branches` | delete branches too — refuses any branch whose commits exist nowhere else |
| `… --prune-branches --force` | override that refusal, and allow removing dirty checkouts. Destroys work — explicit user ask only. |
| `… --dry-run` | print the teardown plan |

Batch semantics: members provision concurrently; one failure leaves the rest alone;
nothing rolls back — a failed member keeps its branch and worktree.

## e2b-bench

Grade a fleet: run one held-out check inside every member's box.

```
e2b-bench                                      # list graded runs on disk
e2b-bench <slug>                               # show the board for a graded run
e2b-bench <slug> --grade 'npm test'            # run the check, then show it
e2b-bench <slug> -g 'pytest -q' --timeout-ms 600000
```

- Members found by branch prefix, never a stored list (ADR-0005).
- Verdicts: `$STATE_DIR/bench/<slug>/`.
- No tty needed — prints a table, meant to be piped/redirected/CI'd.
- Exit codes: `0` every member measured AND passed · `1` any failed or unreachable · `2` usage error.
- The check runs INSIDE each box via `e2b-box exec`, already cwd'd to the member's
  project dir (`/home/user/project`) — so `npm test` means what it means locally;
  the whole command is one shell string, so `cd sub && npm test` reaches a subdir.

## e2b-dash

Full-screen Ratatui board of every tracked box with per-box open/sync/pull/kill.
Needs a real tty — refuses otherwise, so agents use `e2b-box list`/`status` instead.
`e2b-box dash toggle` is the bindable spelling: closes an open board instead of
stacking, picks placement from the layout.

## herdr actions & keybindings

Actions (`herdr plugin action invoke <id> --plugin e2b-dev.herdr-e2b`): `open`, `fleet`,
`sync`, `pull`, `status`, `pause`, `resume`, `kill`, `dashboard`, `dashboard-toggle`.
Suggested bindings (herdr config `[[keys.command]]`):

| key | action | CLI equivalent |
|---|---|---|
| `prefix+shift+e` | `open` | `e2b-box open` |
| `prefix+shift+f` | `fleet` | `e2b-box fleet <slug> -a … --task "…"` |
| `prefix+shift+d` | `dashboard-toggle` | `e2b-box dash toggle` |

`worktree.removed` event → box killed automatically (no orphaned billable boxes);
this is what wires fleet-member teardown to `herdr worktree remove` for free.

## Configuration

`config.toml` keys that matter when composing commands:

- `[sandbox] template` — default template (`base` shipped); `templates = [...]` —
  the picker/roster menu (claude, codex, opencode, amp, grok, droid, prime, muse, base)
- `[[sandbox.template_rules]] pattern/template` — per-branch template overrides
- `[fleet] base` — ref members branch from ("" = invoking checkout's HEAD),
  `prefix` (default `e2b`), `default_roster` — pre-ticked picker rows
- `[fleet.agents] <template> = "cmd"` — agent launch command override ("" = no agent)
- `[fleet.seed] <template> = "sh"` — first-run-state seeding override
- `[templates.<name>.env]` — env injected into that template's boxes (API keys live here)
- `[sandbox] timeout_ms` (1h default), `auto_pause`, `auto_resume`, `project_path`
  (default `/home/user/project`), `server_port` (default 3000)

## Env overrides

| var | effect |
|---|---|
| `HERDR_E2B_FLEET_TASK_WAIT` | seconds to wait for task delivery (default 120) |
| `HERDR_E2B_FLEET_AGENT_WAIT` | seconds to wait for the agent to take the pane (default 90) |
| `HERDR_E2B_NODE` | path to node ≥ 22 when PATH's won't do |
| `HERDR_E2B_STATE_DIR` / `HERDR_PLUGIN_STATE_DIR` | relocate state |
| `E2B_API_KEY` / `E2B_DOMAIN` | cluster credentials — resolved once, same precedence for every verb (`od-e2b-region` skill switches clusters) |
