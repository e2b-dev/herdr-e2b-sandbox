# Architecture

A map of the codebase for reviewers. herdr-e2b mirrors a git worktree into an E2B
cloud sandbox on demand. This doc explains the layers, the data flow, the state
model, and the invariants worth checking during review.

## Three layers (and why)

```
┌─ herdr ─────────────────────────────────────────────────────────────┐
│  manifest (herdr-plugin.toml): actions · panes · events · build      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ invokes
        ┌───────▼────────┐   control plane (bash)      resolves node/e2b, TTY
        │  bin/e2b-box   │──────────────────────────►  handling, spinner, prompts
        │  bin/e2b-dash  │
        │  bin/e2b-fleet │──── herdr socket API ─────►  worktree create · pane run
        └───────┬────────┘     (never the E2B SDK)     N members, one per template
                │ shells out to
        ┌───────▼────────┐   data plane (Node ESM)     the ONLY place the E2B SDK
        │   src/*.js     │──────────────────────────►  is called (SDK is JS-only)
        └───────┬────────┘
                │ SDK
        ┌───────▼────────┐
        │  E2B sandbox   │   getHost() preview URL · files.write/read · commands.run
        └────────────────┘

        tui/ (Rust/Ratatui)  ─ optional dashboard + grader; both read the same
                               JSON records and shell back out to `e2b-box`.
```

**Why bash + Node + Rust:** E2B's SDK is **JavaScript-only** (no official Rust SDK),
so every sandbox call lives in `src/*.js` — that's the data plane. Bash (`bin/`) is
the control plane herdr actually invokes: it resolves a Node ≥22 and the `e2b` CLI
onto PATH (herdr itself may run on an older Node), handles TTY quirks, renders the
spinner, and runs the interactive shell. The Rust TUI is an optional dashboard that
reads the same state and delegates actions back to `e2b-box`.

## The core flow — `e2b-box open`

1. **herdr** invokes the `open` action/pane → `bin/e2b-box open`.
2. `e2b-box` resolves the worktree (from `$PWD`, or `HERDR_PLUGIN_CONTEXT_JSON`'s
   focused-pane cwd) and computes the **box key** = `<folder>-<sha8(abs path)>`.
3. **Optimistic connect** (only with a TTY): if a `ready` record already has a
   sandbox id, attach immediately via the plugin's terminal client
   (`src/attach.js`) — its connect attempt is itself the liveness check; a
   "never attached" exit falls through to (4).
4. Otherwise `provision_from_cwd` launches `src/provision.js` (detached, logging to
   the record's `.log`) with `op=ensure`:
   - reconnect to the tracked sandbox (auto-resumes a paused one), **or** create a
     fresh one on `NotFoundError` (a transient error rethrows — never a second box);
   - upload the worktree **only for a fresh box** (`uploadSnapshot`, git-aware);
   - `git init` + shell personalization; write `status: ready` + preview URL.
5. `spin_until_ready` polls the record (spinner on a TTY; quiet when headless) until
   `ready` / `failed` / timeout.
6. `connect_shell` prints the box details and attaches through `src/attach.js` —
   a raw PTY the client stamps with `HERDR_E2B_TERMINAL=<box key>` and records as
   `terminalPid`. The client reports what happened by exit code (0 clean · 10
   never attached → reprovision · 11 box gone · 12 attached-then-lost), and on a
   clean exit `e2b-box` offers **[p]ull / [k]ill / [L]eave**. Headless callers
   get instructions and exit (never a bare local shell).

`worktree.removed` (herdr event) → `bin/teardown-worktree` → `src/kill.js` (kills the
box; keeps the record if the kill fails, so nothing billable is silently orphaned).

## The second flow — `e2b-fleet`

Same base ref, N worktrees, N boxes — one per template on the **roster**. `fleet`
never touches the E2B SDK; it drives **herdr** and then reuses `open` per member.

1. **herdr** invokes the `fleet` action → `bin/e2b-fleet-open` → the pickers run in
   a real pane (`bin/e2b-fleet`, no flags), because an action has no terminal.
2. Two screens (`lib/chooser.sh`): the **task slug** plus the optional **fleet
   task** (`ask_slug_tty`, which also carries the dirty-tree warning) and the
   **roster** (`ask_roster_tty`, the same menu `open` offers, `[fleet]
   default_roster` pre-ticked). Aborting either one creates nothing. With
   `--slug`, `-t` and `--task` given, both screens are skipped.
3. `src/fleet-name.js` turns the slug + roster into one branch and label per member
   (`<prefix>/<slug>-<template>-<rand4>`). Bash never builds a ref name.
4. `--dry-run` prints exactly that plan and exits 0 — the feature's test seam.
5. Otherwise: a runtime probe that herdr answers `worktree list` (the version floor
   does **not** move for fleet), then every member is spawned **concurrently** —
   `herdr worktree create` (unfocused, no `--path`, so the user's `[worktrees]`
   directory decides layout), then `herdr pane run <root pane> e2b-box open -t <t>`.
6. Per member, once its box's sandbox shell appears: `src/fleet-seed.js` hands over
   one shell command that writes the agent's **first-run state** inside the box
   (`~/.claude.json`, `~/.codex/auth.json`) so it comes up at a prompt rather than a
   welcome wizard — typed first, because after the agent has read those files it is
   too late. That command carries the credential's **variable name and never its
   value**: the key is already in the box (`[templates.<name>.env]` → `envs`), so the
   box's own shell expands it and nothing secret enters the pane, the scrollback or
   herdr's session files. Then the `[fleet.agents]` command
   is **typed into that shell** (`herdr pane run` — `agent start` refuses a pane
   with a foreground command), herdr's screen-scrape detection adopts the agent,
   it is renamed `<slug>-<template>`, and the fleet task is delivered to it with
   `herdr agent prompt`. All of it is per member and **never barriered**: nobody
   waits for anybody else's agent. All of it is also best-effort *on top of* a
   member that is already up — every step is time-bounded
   (`HERDR_E2B_FLEET_{SHELL,AGENT,TASK}_WAIT`, seconds), and a step that doesn't
   land is reported with the box left running, never retried, never fatal.
7. One line per member, an `N/M up` summary, non-zero exit if any failed. **No
   rollback**: a failed member keeps its branch and its worktree. If the pickers
   ran, the pane then becomes `e2b-dash` — asking is what asks for the board, and
   `create` (everything named up front) therefore never boards.

`e2b-fleet kill <slug>` is the reverse verb, and the one place the plugin deletes
on a *pattern*: it globs `refs/heads/<prefix>/<slug>-*`, ignores matches that
aren't shaped like a member (`…-<rand4>`), and per member kills the box
(`e2b-box kill`) before removing the worktree (herdr's `worktree remove` when it
is still an open workspace, else plain git). Branches are **kept** and listed;
`--prune-branches` deletes only those already merged into the base or contained by
a remote ref, and `--force` overrides that. It deliberately skips the spawn path's
herdr preflight so a fleet stays teardownable from a plain shell.

A fleet is a batch, never a tracked object (`docs/adr/0001`): nothing is persisted,
and the shared branch prefix `<prefix>/<slug>-` *is* the fleet's identity. Members
are ordinary worktrees, so `sync`/`pull`/`pause`/`kill` and the `worktree.removed`
teardown all work on them with no fleet-aware variant.

## The third flow — `e2b-bench`

Grading a fleet: run **one held-out check** inside every member's box and record a
verdict each (`docs/adr/0004`). Rust drives the run; it never calls the SDK.

1. `bin/e2b-bench` resolves the binary and the credentials (the only two things
   the bash layer owes it), then execs `tui/target/release/e2b-bench`.
2. Members are re-derived the ADR-0001 way — box records whose `branch` matches
   the fleet's prefix — never from a stored list.
3. `grade.rs` grades them **concurrently**, one `e2b-box exec --timeout-ms N '<cmd>'`
   per member, addressed by `KEY` (with `HERDR_PLUGIN_CONTEXT_JSON` stripped, so a
   pane's context can't redirect a grade to another box).
4. `src/exec.js` connects (resuming a paused member), runs the command in the
   box's `projectPath`, and prints **one JSON object**: `{ok, exitCode, stdout,
   stderr, error}`. `ok:false` means *never measured* — unreachable, gone, or past
   the bound; `ok:true` means the command ran and its exit code is the verdict.
5. Each result is persisted the moment it exists (`$STATE_DIR/bench/<slug>/`), so an
   interrupted run keeps what it earned, then the board prints and the exit code
   composes: 0 only when every member was measured and passed.

The verdict vocabulary is deliberately three-valued — pass, fail, **error** — and
errors are never folded into failures: "2/4 passed" means something very different
when the other two never ran. Rubrics, LLM judging and ranking stay out
(`docs/adr/0004`, "What stays out").

## Component reference

### Control plane — `bin/`
| File | Responsibility |
| --- | --- |
| `e2b-box` | The CLI. Subcommands `open/up/shell/status/list/url/logs/sync/pull/exec/pause/resume/kill/doctor/auth`, plus `--template` on the creating verbs. Key derivation, optimistic connect, `spin_until_ready`, `connect_shell`, template selection (`pick_template`; the chooser itself lives in `lib/chooser.sh`), disconnect + on-close prompts, `pull` safety gate. |
| `e2b-box-open` | The `open` keybinding/action: runs the sandbox in the focused pane when it's an idle shell, else splits beside it. A herdr action has no terminal of its own, so it can host neither the shell nor the chooser. |
| `e2b-fleet` | The fleet verb: one base ref → N members, one per roster template. Two ways in — bare (two picker screens, then the board) and `create <slug>` (flags only; `-s`, `--agents a,b,c` / `all`, `--task`) — dedupe, the roster spell-check against `resolve-template.js --known` (`--force` overrides), the `--dry-run` plan, the herdr-version probe, concurrent spawn (background jobs + per-member result files), the per-member first-run seeding + agent auto-start + fleet-task delivery (`set_seed_argv` / `set_agent_argv` / `set_rename_argv` / `set_prompt_argv` — the plan and the real call share every builder, so they cannot drift), the `N/M up` summary. Also the `kill` verb: the branch glob, the conservative teardown, the kept-branch report. Drives herdr's socket API only — never the E2B SDK. |
| `e2b-fleet-open` | The `fleet` keybinding/action, shaped exactly like `e2b-box-open`: runs `e2b-fleet` in the focused pane when it's an idle shell, else opens the `fleet` pane beside it. |
| `e2b-dash` | Launcher for the Rust dashboard: resolves the prebuilt/built binary, seeds the theme, guards on a TTY, execs it. |
| `e2b-bench` | Launcher for the grader, thin on purpose: finds the binary and resolves the credentials the same way every other verb does, then execs it. No TTY guard — a grade is a report meant to be piped and run from CI. |
| `teardown-worktree` | `worktree.removed` handler — kills the box for the removed path (matched by stored `worktreePath`). |
| `lib/paths.sh` | Shared helpers: state-dir resolution, `e2b_node` (find Node ≥22), `ensure_e2b_path`/`ensure_e2b_key`, `sdk_kill`, `box_key`. |
| `lib/chooser.sh` | The full-screen pickers. `ask_template_tty` — one template for one box: arrows/`j`/`k`, number-jump, enter, `q` takes the default. `ask_slug_tty` — one line of text, with a caller-supplied validator function (so ref rules stay in `src/fleet-name.js`), esc aborts; asked for a third argument it also draws the optional **fleet task** field (tab/arrows switch, enter always launches) and prints slug and task as two lines.  `ask_roster_tty` — the multi-select roster: space toggles, number toggles, enter launches, an empty roster can't, `q`/esc abort. Self-contained bash — no state dir, no node — so any verb can source it. Finds the human in two steps: `/dev/tty`, else duplicated stdin (a herdr pane may run on a pty that isn't the controlling terminal). |
| `lib/pane.sh` | Pane plumbing shared by `e2b-box-open`, `e2b-fleet-open` and `e2b-dash-toggle`: `pane_herdr`, `pane_node`, `pane_query`, `pane_procs`, `pane_is_idle` (fails safe — unknown counts as busy). |

### Data plane — `src/` (ESM, uses `e2b` + `@iarna/toml`)
| File | Responsibility |
| --- | --- |
| `provision.js` | The worker. `ensure` (reconnect-or-create) / `sync` (ensure + always upload). Single source of truth for sandbox liveness. Persists the resolved template. |
| `upload.js` | `uploadSnapshot` — git-aware file selection (`git ls-files --cached --others --exclude-standard`, honoring `.gitignore`), additive, symlinks skipped, batched `sandbox.files.write`. |
| `download.js` | `pull` — reverse of upload. **Path-safety guards** (`relIsUnsafe`, `safeDest`) so a write can never escape the worktree. Only writes files that differ; reports each. |
| `kill.js` | `Sandbox.kill` (bounded), idempotent — "already gone" vs "killed". |
| `exec.js` | One command inside a tracked box → one JSON object on stdout (`{ok, exitCode, stdout, stderr, error}`). Started in the background and awaited by hand, because the SDK's `requestTimeoutMs` bounds the handshake, not the run; on the bound the process is **killed**. Draws the line the grader depends on: `ok:false` = never measured, `ok:true` = the command's own exit code. |
| `lifecycle.js` | `pause` / `resume` for a tracked box — `Sandbox.pause` (files + memory snapshot) and `Sandbox.connect` (the resume path; there is no separate resume call). Writes the record's `paused` / `ready` status for both (a box that pauses underneath an attached session gets its `paused` written by `attach.js` on the way out — the client is the only thing present at that moment). |
| `attach.js` | The terminal client (ADR-0008): reattaches to the box's recorded terminal when `attach-plan.js` proves it is the box's own (then nudges a repaint via resize), else creates a fresh raw-mode PTY stamped `HERDR_E2B_TERMINAL=<box key>` — pid + geometry recorded on the box record. The plugin's only long-lived TTY-owning process. Reports by exit code: 0 clean · 10 never attached · 11 box gone · 12 attached-then-lost — the contract `connect_shell` branches on. |
| `attach-plan.js` | The attach-or-create decision, pure: record's terminal fields + process listing + pane size → `{action: "attach", pid, resize}` or `{action: "create", reason}`. Validates the marker before trusting a pid (pids get recycled), and picks the repaint nudge: one resize when geometry differs, away-and-back when it doesn't. Covered by `test/attach-plan.test.js`. |
| `store.js` | The record model: atomic (temp+rename) shallow-merge `writeRecord`, `readRecord`, `listRecords`. Defines `BOXES_DIR`. |
| `config.js` | `loadConfig` (TOML over defaults, `posInt`-clamped), `resolveTemplate` (per-branch rules), `templateRuleMatches`/`templateChoices` (the chooser's menu; `templates` defaults ship the public agent templates), `resolveLifecycle` (auto_pause → SDK lifecycle), `resolveEnvConfig`/`resolveEnv` (`[sandbox.env]` + `[templates.<name>.env]` → the `envs` one box is created with; per-template so a box only ever holds its own agent's credential), `resolveCredentials` (key + cluster as a pair: env → config → `e2b` CLI login), `readCliConfig` (`~/.e2b/config.json`, defensive). |
| `shared.js` | `requireApiKey`, best-effort `notify` (herdr desktop notification). |
| `resolve-env.js` / `resolve-theme.js` | Tiny helpers the bash layer calls to print the credentials (`E2B_API_KEY` + `E2B_DOMAIN`) / theme (toml-only, run on any Node). |
| `resolve-template.js` | Answers the chooser's two questions for a branch: is the template already decided by a rule, and what should the menu offer (`templateChoices`, default first). `e2b-fleet` reads the same output, so the roster and `open`'s menu can never drift apart. |
| `fleet-name.js` | Fleet member naming, as pure functions: `sanitizeSlug` (fold any typed text into one legal ref component, `""` when nothing survives), `templateSlug` (a template's last path segment — `ondrejs-project/herdr-agents` -> `herdr-agents`, since the project half is shared by every member and only costs a sidebar row its readability), `memberLabel`, `memberLabels` (the whole roster at once, refusing two entries that would name one member), `memberBranch` (`<prefix>/<slug>-<template>-<rand4>`; `$HERDR_E2B_FLEET_RAND` pins the suffix for tests). Also a CLI that `bin/e2b-fleet` calls for the whole plan — bash never builds a ref name, because with no fleet state the branch prefix *is* the fleet id. |
| `harnesses.js` | Which coding CLIs are installed on the USER's machine and whether a box may borrow their credentials: `HARNESSES` (per harness — the binary, its version and auth probes, its own parse rule, the variable it uses **here** vs the one a **box** needs, and any documented plain-key file) for the seven harnesses behind a shipped template, and `interpretProbe`, which reads a probe's RESULT and never spawns anything. Pure, so every parse rule is testable with none of them installed. A harness resolves to `authenticated` / `no-key` / `unknown`, and `unknown` is never collapsed into "not installed". Bounded by ADR 0006: no Keychain, no OAuth cache, environment and documented config only. |
| `harness-probe.js` | The impure half of the above, and `e2b-box auth` itself: spawns the probes for all seven harnesses concurrently with a 5s ceiling, `shell: false` (so a shell function cannot answer for the binary) and stdin on `/dev/null` (one harness with no key opens a browser and blocks forever), then prints one row per harness. Read-only — it never writes. |
| `fleet-seed.js` | The first-run state a member's agent needs before it will work instead of asking questions: `DEFAULT_SEEDS` (the verified `~/.claude.json` / `~/.codex/auth.json` shapes, as one-line POSIX sh) and `seedCommand` (`[fleet.seed]` over those, by key presence, so `""` means "seed nothing"). The shell lives here rather than in bash so `node --test` can execute it. Every command names the credential's **variable**, computes what it needs (Claude approves a key by its last 20 characters) inside the box, and refuses to overwrite a file that already exists. |

### Grader — `bin/e2b-bench` + `tui/src/{bench,grade}.rs` + `tui/src/bin/e2b-bench.rs`
Runs one held-out check inside every member of a fleet and reports a verdict each.
Rust owns the whole interface and never touches the SDK: members are derived from
the box records (by branch — ADR-0005), grading shells out to `e2b-box exec`, and
results land in `$STATE_DIR/bench/<slug>/`. `bench.rs` is the record model and the
verdict rules, `grade.rs` the concurrent driver, the bin the CLI and the board.
`bin/e2b-bench` is thin for the same reason `e2b-dash` is: find the binary, resolve
the credentials once. Not a TUI — a grade finishes and leaves an artifact, so the
surface is a table you can pipe. See [ADR-0004](docs/adr/0004-the-plugin-grades-a-fleet-superseding-0002.md).

### Dashboard + grader — `tui/src/` (Rust, optional)
Dashboard (`e2b-dash`, Ratatui): `main.rs` (app + event loop + draw), `state.rs`
(record loading + shell-quoting), `theme.rs` (palette presets), `actions.rs`
(verbs → `e2b-box` commands). Shipped as committed prebuilt binaries; source build
is the fallback.

Grader (`bin/e2b-bench.rs`, not a TUI — a table on stdout): `bench.rs` (the run and
result model, member derivation from branches, tally) and `grade.rs` (concurrent
`e2b-box exec` per member, verdict mapping). It shares `state.rs` with the
dashboard, and has **no prebuilt** — it needs the Rust toolchain.

## State model — one JSON record per box

`$STATE_DIR/boxes/<key>.json` (+ `<key>.log`), where `STATE_DIR` resolves the same
way in `store.js`, `paths.sh`, and the TUI: `HERDR_PLUGIN_STATE_DIR` →
`HERDR_E2B_STATE_DIR` → XDG. `CONFIG_DIR` follows the same shape in `config.js`,
`paths.sh`, and `install.sh`: `HERDR_PLUGIN_CONFIG_DIR` → XDG. Both env vars are
herdr's own; the XDG paths are where they point today, not a contract — herdr
documents `HERDR_PLUGIN_CONFIG_DIR` as the home for user-editable config and
`HERDR_PLUGIN_STATE_DIR` for runtime state, and has no secrets API of its own.
Credentials therefore live in `$CONFIG_DIR/config.toml` (mode `0600`), never in
`HERDR_PLUGIN_ROOT` — that is a managed source checkout. The record is the contract between the writer
(`provision.js`), the reader (`e2b-box` spinner / `status` / `list`), and the
dashboard. Key fields: `key`, `label`, `status` (`provisioning`/`ready`/`failed`/`paused`),
`step`, `sandboxId`, `template`, `url`, `projectPath`, `worktreePath`, `files`,
`onTimeout` + `keepMemory` (the box's create-time lifecycle — what it does at its
idle timeout, which the close-time messages read instead of the current config),
`terminalPid` + `terminalCols`/`terminalRows` (the box's terminal and its last
drawn size, written by `attach.js`; what `attach-plan.js` decides reattach from).
Writes are atomic so a concurrent poll never reads a half-written file.

Grading adds the one other thing on disk: `$STATE_DIR/bench/<slug>/` with a
`run.json` (task, grade command, base ref, start) and one `<box-key>.json` per
member (verdict, exit code, duration, output tails). Same one-file-per-member
shape and the same reasons as the box records. A verdict is *history* — it is not
observable from the box afterwards — which is exactly why it is written down and a
fleet still isn't (`docs/adr/0005`). The member list is never stored.

## Invariants worth checking in review

- **No orphaned billable boxes.** A failed kill keeps the record (retryable);
  `provision_from_cwd` carries `sandboxId`, `template` and the terminal fields
  (`terminalPid`/`terminalCols`/`terminalRows` — a paused box reopens through it,
  and losing the pid there means a fresh terminal instead of a reattach) across
  its wholesale record rewrite; a transient reconnect error never creates a
  second box.
- **`pull` never escapes the worktree.** `relIsUnsafe` (traversal/absolute) +
  `safeDest` (won't follow a dest symlink; realpath-parent must stay within the
  root). Covered by `test/download.test.js`.
- **`pull` never silently clobbers.** Dirty/non-git tree → prompt (interactive) or
  abort (headless) unless `--force`. Covered by `test/cli.test.sh`.
- **Upload honors git/.gitignore.** Inside a repo it always trusts git (even an empty
  selection) — never FS-walks and leaks ignored files; the `ignore` list is an extra
  filter (keeps `.env` out even if tracked).
- **Liveness is reconciled before use.** Headless `open`/`shell` route through
  `ensure` (SDK reconnect/recreate) rather than trusting a possibly-stale `ready`.
- **Node/CLI resolution.** herdr may run on Node < 22; `e2b_node`/`ensure_e2b_path`
  find a ≥22 Node and the `e2b` CLI before any SDK/CLI call.

## Where to look for X

- *"Is a box ever leaked?"* → `bin/e2b-box` (`kill`, `provision_from_cwd`),
  `src/provision.js` (reconnect/create branch), `src/kill.js`, `bin/teardown-worktree`.
- *"Can pull damage local files?"* → `src/download.js` (`safeDest`/`relIsUnsafe`) +
  `bin/e2b-box` `pull` case.
- *"What gets uploaded?"* → `src/upload.js` (`gitFiles`, `isIgnored`).
- *"Which template does a new box boot?"* → `src/resolve-template.js` +
  `resolveTemplate`/`templateChoices` in `src/config.js`, chosen in `bin/e2b-box`
  (`pick_template`); the fallback-to-base path is in `src/provision.js`.
- *"Sandbox lifecycle / pause / template"* → `src/config.js`
  (`resolveLifecycle`/`resolveTemplate`) + `src/provision.js`; the explicit
  `pause`/`resume` verbs live in `src/lifecycle.js` (`z` in the dashboard).
- *"How do the CLI, worker, and TUI agree on state?"* → `src/store.js` +
  the `STATE_DIR` resolution note above.
- *"What does `fleet` actually run?"* → `bin/e2b-fleet` (`--dry-run` prints the
  whole plan without creating anything), `bin/e2b-fleet-open` for the action →
  pane hand-off, `bin/lib/chooser.sh` for the two screens, `src/fleet-name.js`
  for the branch names, and `resolveFleet` in `src/config.js` for `[fleet]`.
- *"Why did one fleet member fail and the others live?"* → `spawn_member` in
  `bin/e2b-fleet`: members run concurrently, each writes its own result file, and
  nothing is rolled back (`docs/adr/0001`, `docs/adr/0003`).
- *"Why didn't my fleet task arrive?"* → the tail of `spawn_member` in
  `bin/e2b-fleet`: `wait_for_box_shell` → `wait_for_agent` → `herdr agent prompt`,
  each bounded, each reporting through `task_undelivered` with the box left
  running. A template mapped to `""` in `[fleet.agents]` is skipped by design.
- *"Why is my member still showing a theme picker / a sign-in menu?"* →
  `src/fleet-seed.js` (does that template have a seeding command at all?) and the
  `fleet_seed_cmd` step in `spawn_member`, between the shell wait and the agent.
  `e2b-fleet --dry-run` prints the exact text the box is sent.
- *"How is a fleet torn down?"* → the `down` block at the top of `bin/e2b-fleet`
  (`dn_safe` is the "holds commits that exist nowhere else" judgement).
- *"Why did a member grade as `error` instead of `fail`?"* → `src/exec.js` decides
  it (`ok:false` = unreachable / gone / timed out), `Verdict::from_exec` in
  `tui/src/bench.rs` maps it, and a missing exit code is deliberately an error —
  never a silent pass.

## Tests

`npm test` is fully offline (no E2B, no key): `node --test test/*.test.js` covers the
pure logic (config resolution, pull path guards, fleet member naming, harness probe
interpretation — that last one runs from captured probe output, so it passes on a
machine with no coding CLI installed at all, which is every CI runner; its spawn
half is covered separately against `sleep` and `cat`, never a real harness);
`test/cli.test.sh` lints every script (`bash -n` / `node --check`) and asserts CLI
exit-code behavior, including `e2b-fleet --dry-run` (the plan is the seam) and the
batch semantics against a two-subcommand herdr stub that creates nothing.
`lib/chooser.sh` is driven through a forked **pty** — real keystrokes, real
`/dev/tty` — which is why that block reports a *skip*, never a failure, when
python3 is missing or is a macOS Command Line Tools stub. No test ever creates a
worktree or a box. Live E2B round-trips are verified by hand. CI runs this on
Ubuntu + macOS × Node 22/24.
