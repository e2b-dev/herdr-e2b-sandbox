# herdr-e2b

[![CI](https://github.com/e2b-dev/herdr-e2b-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/e2b-dev/herdr-e2b-sandbox/actions/workflows/ci.yml)

A [herdr](https://herdr.dev) plugin that sends your branch — **as it sits on
disk right now, uncommitted changes and all** — into a fresh
[E2B](https://e2b.dev) cloud sandbox. No push, no clone, no credentials but the
ones you put there. Works from any checkout; a herdr worktree additionally
tears its sandbox down when the worktree is removed.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/delegate-dark.png">
  <img alt="How your branch reaches a sandbox" src="assets/delegate.png">
</picture>

## Two things it is for

**1 · Delegate this branch.** You are on a branch, you want the work done
somewhere that isn't your laptop. `e2b-box` uploads the checkout, boots a box
from a template that already ships a coding agent, and drops you in its shell.
`pull` brings the diff home.

**2 · Race a fleet, then grade it.** One task, one box per agent, all at once —
Claude Code, Codex, Grok, OpenCode, Amp, Droid, Prime and Muse Code work the same starting
point in parallel, and `e2b-bench` runs one held-out check inside every box to
say which of them actually did it. Best-of-N, or one harness's feature you can't
get from the others.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/fleet-dark.png">
  <img alt="One task, several agents, one grade" src="assets/fleet.png">
</picture>

## Install

```bash
herdr plugin install e2b-dev/herdr-e2b-sandbox   # build step links e2b-box onto PATH
./install.sh                                     # prompts for your E2B API key, chmod 600
```

Needs **herdr ≥ 0.7.0**, **Node ≥ 22**, **jq**, the `e2b` CLI on PATH, and an
[E2B API key](https://e2b.dev/dashboard). The key goes in `[secrets].e2b_api_key`
in the plugin config (`~/.config/herdr/plugins/config/e2b-dev.herdr-e2b/config.toml`), or
in `E2B_API_KEY`, which wins if both are set.

On first run the installer also runs `e2b-box auth` once — it reports which coding
harnesses are installed on this machine and records the credentials a box may
borrow, so your first box comes up authenticated instead of on the agent's own
sign-in screen. It asks for no harness credential and cannot fail the install: a
machine with no harnesses installed just gets a report. Install a new harness
later and re-run `e2b-box auth` yourself; nothing probes on its own.

`e2b-box auth` opens an interactive table in a terminal: use arrows or `j/k`,
numbers to jump, and Enter for agent actions. Connect/reconnect Claude or Codex,
inspect authentication, or open the config files. `f` opens API-key/template config,
`a` opens generated `auth.toml`, `s` saves discovery after confirmation, `r` refreshes,
and `q`/Esc exits without saving. File opening uses `[dashboard].config_opener`.

`auth discover` retains the report-and-save prompt; `auth --yes` saves without a
menu. Piped output remains a compact ASCII table with agent, auth method (OAuth token,
OAuth session, or API key), source, and status. The overview combines saved connections,
manual configuration, and discovered credentials, and shows setup steps only
where needed. Missing, expired, or ambiguous selected connections require attention;
the report never substitutes a lower-priority key. “Configured” describes local
credential availability, not verified authentication inside a box. Saving discovery
updates only `auth.toml`; your config and connections stay unchanged. Use
`auth explain --template NAME` for paths and account details. Narrow terminals
omit secondary columns; TTY colors respect `NO_COLOR`.

For a named connection you explicitly choose for new boxes:

```sh
e2b-box auth connect claude --name work     # browser approval, token captured privately
e2b-box auth connect codex                  # borrow your local subscription session
e2b-box auth list
e2b-box auth explain --template claude
e2b-box up -t claude --connection work
```

Claude's local subscription type and organization are detected automatically;
Team/Enterprise membership does not enable sharing. Connections currently have
personal access. `--org` requires a future shared service. Local account metadata
is labeled separately because a browser authorization can select another account.
Without `--name`, a detected Team/Enterprise organization suggests a name such as
`claude-e2b`; Pro/Max suggests `claude-personal`, and an unknown plan suggests
`claude-local`. A Team/Enterprise plan without a usable organization name uses
`claude-team` or `claude-enterprise`. The preview and list show `Local account`
(for example, `Claude Team · E2B`) separately from `Access: Only you`. Existing IDs
stay unchanged, including when reconnected; use the ID shown by `auth list`.

Interactive Claude capture requires Python 3 and the Claude CLI. An existing
setup-token can also be supplied through `auth connect claude --token-stdin --yes`
using a secret manager or another private pipe. Never put a token in command
arguments. Metadata and token files live under `$CONFIG_DIR/connections/`, protected
by directory/file permissions (0700/0600); the token files are not encrypted.

`auth check ID` checks local availability and known expiry without making a model
request. `auth reconnect ID` replaces the local credential; `auth disconnect ID`
removes it. Existing boxes keep their credentials until explicitly recreated.
Codex borrowing excludes the real refresh token and lasts until bearer expiry.

The only connection for a harness becomes its default. With several connections
(`auth connect claude --name work`), choose `--connection work`, or set
`connection = "work"` under `[templates.claude]` in `config.toml`. A selected
connection removes competing auth environment variables. If it is unavailable,
the command fails instead of selecting another billing account. Without any named
connection, the existing discovery/config precedence continues to apply.
`auth discover` is an explicit alias for the original `auth` command.

For a custom template such as `drew-claude`, explicitly choose its connection:
`e2b-box up -t drew-claude --connection claude-personal`, or add this to `config.toml`:

```toml
[templates.drew-claude]
connection = "claude-personal"
```

That binding also selects the harness's onboarding seed, unless the template has
its own `[fleet.seed]` override. Template names are never guessed from substrings.

Bind the three verbs you press (`prefix+e` is herdr's own `edit_scrollback` —
stay off it):

```toml
[[keys.command]]
key = "prefix+shift+e"                                          # one box, this checkout
command = "herdr plugin action invoke open --plugin e2b-dev.herdr-e2b"

[[keys.command]]
key = "prefix+shift+f"                                          # a fleet, off this checkout
command = "herdr plugin action invoke fleet --plugin e2b-dev.herdr-e2b"

[[keys.command]]
key = "prefix+shift+p"                                          # pull the box's changes down
command = "herdr plugin action invoke pull --plugin e2b-dev.herdr-e2b"

[[keys.command]]
key = "prefix+shift+d"                                          # the board, every box
command = "herdr plugin action invoke dashboard-toggle --plugin e2b-dev.herdr-e2b"
```

`prefix+shift+e` opens the template picker and sandbox shell in a new pane below
the invoking pane. `prefix+shift+f` opens fleet creation below it, then shows the
dashboard there. Both focus the new pane, like `prefix+-`.

`prefix+shift+p` is herdr's own `rename_pane` out of the box; move it first
(`rename_pane = "alt+r"` in the `[keys]` table) or the pull never fires. The pull
reports as a herdr notification and refuses to overwrite uncommitted local edits,
naming the files when it does.
`prefix+shift+d` is herdr's own `close_workspace` out of the box — this takes it
over. Keep that verb by moving it first (`close_workspace = "prefix+shift+x"` in
the `[keys]` table), or give the board a different key.

> Local dev: `herdr plugin link /path/to/herdr-e2b-sandbox && ./install.sh`.

## Quick start

```bash
cd ~/some/checkout
e2b-box                             # pick a template, boot, land in the box's shell
e2b-box exec 'npm test'             # …or run one command and get JSON back
e2b-box pull                        # bring the box's changes down
e2b-box run -t claude --task GOAL.md --push --json        # headless: task in, branch out

e2b-fleet                           # name a task, tick a roster, watch the board
e2b-bench login-fix --grade 'npm test'
```

Nothing goes to the cloud on its own — you decide which checkouts go up:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/lifecycle-dark.png">
  <img alt="The loop you press: keybind, chooser, boot, shell, and on close pull, leave or kill" src="assets/lifecycle.png">
</picture>

## Agents, templates and keys

A template ships the agent, not its credential. Give each template the key its
own agent reads and every box boots ready to work — keyed by template, so a
`base` box gets nothing:

```toml
[templates.claude.env]
CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-…"   # `claude setup-token`, on a subscription
# ANTHROPIC_API_KEY = "sk-ant-…"             # …or a Console key, if that is what you have
[templates.codex.env]
OPENAI_API_KEY = "sk-…"

[sandbox.env]                    # optional — every box, whatever it booted from
HTTPS_PROXY = "http://proxy.internal:3128"

[templates.opencode]             # optional: which model, how hard it thinks
model = "openrouter/qwen/qwen3.8-max-0902"
[templates.codex]
model = "gpt-5.4"
reasoning = "high"
```

`model` and `reasoning` pin what a template's agent runs, for every box booted
from it (`open`, `fleet`, `run`), in the harness's own way: claude and opencode
read a variable, codex, grok, droid, prime and muse get their config file written
right after the first-run seed. An agent left alone runs whatever its provider
ranks first, which on an OpenRouter key was an image model. Per-harness keys and
what each can pin are in `config.example.toml`.

| Agent | Template | Key it reads | Started unattended as |
| --- | --- | --- | --- |
| Claude Code | `claude` | `CLAUDE_CODE_OAUTH_TOKEN` (a `claude setup-token` token, on a Pro/Max/Team subscription) or `ANTHROPIC_API_KEY` (a Console key) | `claude --dangerously-skip-permissions` |
| Codex | `codex` | `OPENAI_API_KEY` | `codex --dangerously-bypass-approvals-and-sandbox` |
| Grok | `grok` | `XAI_API_KEY` | `grok --always-approve` |
| OpenCode | `opencode` | whichever provider key you point it at | `opencode --auto --prompt` |
| Amp | `amp` | `AMP_API_KEY` | `amp --dangerously-allow-all` |
| Droid | `droid` | `FACTORY_API_KEY` | `droid` |
| Prime | `prime` | `PRIME_API_KEY`, or an `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` you already pay for | `prime-agent` |
| Muse Code | `muse` | `META_API_KEY` (a Meta API key; it outranks the browser login, which sits in the Keychain and is not borrowed) | `muse --yolo` |
| — | `base` | — | nothing (a control arm) |

These are E2B's public [agent templates](https://e2b.dev/docs/agents); names are
per **region** (`e2b template list`), and one that isn't built in yours falls back
to `base` and says so. Keys are passed to `Sandbox.create` at **create** time
only — never baked into an image, never written to the box record or the log.
Rotating one means `e2b-box kill` and open again.

Three things follow from a fleet member being unattended:

- **Skip-approval flags are the default**, because nobody is watching the pane
  to approve an edit. Right in a disposable box, wrong on a laptop. A box is
  isolated but not a cage — it has network egress and holds your key, so the
  protection is a short-lived box and a scoped key. Override per template in
  `[fleet.agents]`; `""` means "plain shell, start nothing".
- **First-run state is seeded** just before the agent is typed, so a member
  arrives at a prompt instead of a welcome wizard — `~/.claude.json`,
  `~/.codex/auth.json`, droid's trusted folders, opencode's autoupdate. The
  command sent to the pane names the **variable**, never its value, so nothing
  secret lands in the scrollback. Shipped for `claude`, `codex`, `droid` and
  `opencode`; add your own with `[fleet.seed]`.
- **`config.toml` is a plaintext secret file.** `chmod 600` it.

### Picking a template

`--template NAME` (or `E2B_TEMPLATE`) decides what a **new** box boots from; with
neither, a `[[sandbox.template_rules]]` branch pattern decides; with no rule
either, you get the chooser:

```
  E2B template for my-worktree

   ▸ [1] muse                     default
     [2] claude
     [3] codex
     [4] opencode
     [5] amp
     [6] grok
     [7] droid
     [8] prime
     [9] base

  ↑/↓ · j/k move   enter confirm   number jumps   t type a name   q default
```

`t` takes any name, so the menu is a shortcut and not a whitelist. `muse` (Meta's
Muse Code) is the shipped default; `base` is E2B's minimal image, fine for trying
the flow or a plain shell, tight on disk for real work. For that, [build a custom template](https://e2b.dev/docs/sandbox-template) with your
toolchain and roomier resources, and point `[sandbox].template` at it.

> **Regions are named, not spelled as hosts.** `[sandbox] region = "us" | "eu"`
> is the whole surface; there is no `domain` key. `us` is the default and
> resolves to `https://api.e2b.app`, `eu` to `https://api.e2b-juliett.dev`. US
> also answers at `e2b.dev` — an older name for the same environment — which is
> exactly why the plugin picks the host and you pick the region.

#### Your own project's templates

A template you build lands in your E2B **project**, and E2B names it
`<project>/<template>` — `ondrejs-project/herdr-agents`. Use that whole name
wherever a template name goes: `--template`, `[sandbox] template`, the roster,
the `t` prompt above. The plugin never composes the project half for you and
never turns a bare name into a namespaced one, so write it out.

```toml
[sandbox]
region    = "eu"                                    # us (default) or eu
templates = ["ondrejs-project/herdr-agents", "claude", "base"]

# A `/` in the name means the table header must be QUOTED:
[templates."ondrejs-project/herdr-agents".env]
ANTHROPIC_API_KEY = "sk-ant-…"

[fleet.agents]
"ondrejs-project/herdr-agents" = "claude --dangerously-skip-permissions"
```

Unquoted, TOML reads the `/` as part of a bare key, the table never matches, and
the box boots with no credential — the agent then opens on its sign-in screen,
which a fleet member cannot answer for itself.

Two things `e2b template list` will not tell you:

- **Names are per region.** The same project name can exist in both regions
  owning different templates, so a `templates` list is not portable — changing
  `region` means revisiting it.
- **In the EU the listing omits public templates**, returning only your
  project's own. A public name missing there is not evidence it is missing:
  `claude`, `codex`, `opencode`, `amp`, `droid` and `base` all resolve in the EU
  regardless.

Get the project half wrong and E2B names the project you actually belong to:

```
400: namespace 'e2b' must match your team 'ondrejs-project'
```

A member of a fleet is named after the template's **last segment**, so
`ondrejs-project/herdr-agents` gives the branch `e2b/<slug>-herdr-agents-<rand4>`
— the project half is shared by every member, so it only costs a sidebar row its
readability. Two roster entries that would claim the same name are refused.

## Commands

### `e2b-box` — one box, this checkout

```
open [-t NAME]        boot or reconnect this checkout's box, then attach
up [-t NAME]          same, but the box boots behind you
connect [<id>]        attach to a box that already exists
exec <cmd>            run one command inside the box, print its output
run --task TEXT       headless: boot, hand the task to the box's agent, wait,
                      pull the result, [--push], tear down; exit 0 only if all landed
sync                  upload this checkout into the box    local → box
pull [--force]        download the box's project dir back  box → local
pause · resume        freeze / thaw — state kept, billing clock stopped
kill                  destroy the box; checkout and branch stay
status · list         this checkout's box · every tracked box
url · logs            forwarded URL · follow the provisioning log
wait · doctor         block until ready · check node, CLI, credentials, state
dash [toggle]         the live board of every tracked box
```

`--json` on `list`/`status`/`wait`/`run`, `--timeout-ms N` on `exec`/`wait`/`run`,
`-b KEY` to act on another box. `status`/`list` show the **last known** state; `open`
reconciles with E2B and reprovisions a box that idle-timed-out.

#### `e2b-box run`: headless, for a cron or a delivery lane

`open` and `fleet` need a pane and a human in it; `exec` runs one command. `run`
is the verb with neither: it boots this checkout's box (or re-syncs the tracked
one so it sees the current tree), writes the task into the box as a file, starts
the template's agent in its **non-interactive** mode and waits for it to exit,
pulls what changed back into this checkout, and **pauses** the box, so `e2b-box
open` can put you back in the run nobody watched (`--kill` destroys it instead,
`--keep` leaves it running). Exit 0 means every step landed; anything else is 1,
with the step that failed in `status`.

```bash
e2b-box run -t claude --task 'fix the login redirect loop'
e2b-box run -t codex  --task GOAL.md --push --json           # a file: read it; commit + push this branch
cat GOAL.md | e2b-box run -t amp --task - --timeout-ms 3600000   # `-`: stdin
e2b-box run -t claude --task GOAL.md --dry-run               # the plan, nothing created
```

`--task` takes the text itself, the path of a file to read, or `-` for stdin.
The full contract, the box lifecycle and a GitHub Actions example live in
[docs/headless-run.md](docs/headless-run.md).

- **Templates**: every shipped agent template (`claude`, `codex`, `opencode`,
  `amp`, `grok`, `droid`, `muse`, `prime`) has a verified headless command; `base`
  (the default) and your own templates are refused by name until `[run.agents]`
  maps them, see `config.example.toml`.
- **`--push`** commits everything the pull left different on the **local** branch
  and pushes it to `--remote` (`origin`). The box holds a baseline and no history
  (ADR 0012), so the branch with the real history is the one on this machine. A
  tree that was dirty before the run is part of the snapshot the agent worked
  from, and so part of the commit; `run` says so.
- **Clobber guard** is `pull`'s: a file the agent changed that also carries
  uncommitted local edits aborts the pull and the run fails as `pull-failed`;
  the box is never killed then, even under `--kill`, so nothing is lost.
  `--force` overrides.
- **`--json`** prints one object: `{ok, key, sandboxId, template, status, agent:
  {ok, exitCode, stdout, stderr, error}, pull, push, box, elapsedMs, error}`.
  `status` is `done`, or the step that decided otherwise: `boot-failed`,
  `task-failed`, `agent-unmeasured` (never ran to a verdict: unreachable, or
  killed at `--timeout-ms`), `agent-failed` (exited non-zero), `pull-failed`,
  `push-failed`, `teardown-failed`. `box` is what the box is now: `paused`,
  `killed` or `running`.

### `e2b-fleet` — one base ref, one box per template

```bash
e2b-fleet                                          # two screens: slug + task, then the roster
e2b-fleet login-fix --agents claude,codex          # …or say it outright
e2b-fleet login-fix --all --task "fix the login redirect loop"
e2b-fleet login-fix --agents claude -n             # --dry-run: print the plan, create nothing
e2b-fleet kill login-fix [--prune-branches]        # boxes and worktrees gone, branches kept
```

Per template and all at once: a worktree on a fresh branch
`e2b/<slug>-<template>-<rand4>` off your current HEAD, opened as an ordinary
herdr workspace, with its own box booted from its own template, its agent started
inside it, and the task handed over the moment *that* agent settles.

- **A terminal is what asks for the board.** With a tty the pane you launched
  from becomes a live board of the roster while it provisions (the per-member
  report goes to `$STATE_DIR/fleets/<slug>.log`); `--no-dashboard` keeps the
  report instead. Without a tty — an agent, a script, CI — members provision in
  the foreground and the exit code is 0 only if every one came up. `e2b-box
  fleet …` is the same grammar for a script to call.
- **Members start clean.** A member is a fresh worktree off the base ref, so
  uncommitted work where you launched from is *not* carried in. The one place
  `fleet` behaves unlike `open`.
- **Nothing is rolled back.** A failed member keeps its branch and its worktree.
- **Members are ordinary worktrees and boxes** — `sync`, `pull`, `pause`,
  `resume`, `kill` all work, and removing one's worktree kills its box.
- **The fleet is its branch prefix.** Nothing is stored anywhere:
  `git branch --list 'e2b/login-fix-*'` is the member list, and it is what `kill`
  globs. `--prune-branches` deletes the branches too, refusing any whose commits
  are neither merged nor pushed unless you `--force`.

`[fleet]` sets `base`, `prefix` and `default_roster`; `[fleet.agents]` maps a
template to the command that starts its agent.

### `e2b-bench` — grade the fleet

Three agents worked the same task; now decide which one did it. One held-out
check per member, and the verdict is its exit code — no rubric, no LLM judge
([ADR-0004](docs/adr/0004-the-plugin-grades-a-fleet-superseding-0002.md)).

```bash
e2b-bench login-fix --grade 'npm test'    # run the check in every member, print the board
e2b-bench login-fix                       # re-read a run already graded
e2b-bench                                 # list the graded runs on disk
```

```
bench 'login-fix'
  check: npm test

  MEMBER                     TEMPLATE   VERDICT       TIME  DETAIL
  login-fix-claude           claude     ✓ pass       1m04s
  login-fix-codex            codex      ✗ fail         52s  exit 1  2 failing
  login-fix-grok             grok       ! error         3s  sandbox is gone

  1/3 passed  ·  1 never measured (box unreachable)
```

**`error` is not `fail`** — an unreachable box, or one that outlived
`--timeout-ms` (15m default), never produced a measurement, and folding that into
"failed" would blame an agent for a dead sandbox. The exit code is 0 only when
every member was measured and passed, so CI can gate on it. Verdicts persist in
`$STATE_DIR/bench/<slug>/` and outlive the fleet
([ADR-0005](docs/adr/0005-a-bench-run-is-an-entity.md)). Needs the Rust
toolchain: `(cd tui && cargo build --release)`, which `./install.sh` does
whenever `cargo` is on PATH.

### `e2b-dash` — the board

A live TUI of every tracked box. Run `e2b-dash`, open the **dashboard** pane, or
press `prefix+shift+d` (bound in [Install](#install)).

Run `e2b-popup` (or `e2b-box popup`) to show the same dashboard in a centered
overlay, at 90% width and 85% height, with the current panes visible behind it.
It uses the same dashboard binary and controls. `q` or `Esc` from the main board
closes the popup and returns to your panes.

`Enter` (or `o`) in the popup opens the selected box in a regular pane and closes
the popup, because the overlay's terminal is discarded when it closes. By default
that pane is a split below the pane the popup floats over; `[dashboard].popup_open`
moves it: `"below"` (default), `"right"`, `"above"`, `"left"` (a split on that side
of the pane) or `"tab"` (a new tab). Herdr itself splits right or down only, so
`above` and `left` split and then swap the new pane with the one you were in.

Both views are independently keybindable in Herdr settings: **e2b-dash (pane
view)** uses the `dashboard` action, and **e2b-popup (overlay view)** uses `popup`.
You can keep both shortcuts in your Herdr `config.toml`, for example:

```toml
[[keys.command]]
key = "prefix+shift+d"
command = "herdr plugin action invoke dashboard --plugin e2b-dev.herdr-e2b"

[[keys.command]]
key = "prefix+ctrl+d"
type = "shell"
command = 'exec "$HOME/.local/bin/e2b-popup"'
```

The popup border shows ` herdr-e2b-sandbox` (the GitHub glyph uses a Nerd Font),
leaving more room for the count and region in the dashboard header. Herdr builds
that supply `HERDR_POPUP_VERSION` show the version on the top-right border; older
builds keep it in the dashboard header. The shortcut
uses the plugin popup entrypoint so Herdr can display that title. The first frame
reuses the last resolved theme and region while fresh settings load in the
background. Box records are read fresh, and config commands are never cached.

Choose unused keys or replace existing bindings; these are separate actions,
so assigning one does not change the other. Existing `dashboard-toggle`
bindings continue to use the pane view.

```
↑/↓ move · ↵/o open · w worktree · s sync · p pull · z pause/resume
x kill · c copy id · C config paths · r refresh · T theme · q quit
```

Press `C` (Shift+C) to choose a config path, then `Enter` to open it with the
shell's `open` on macOS (`xdg-open` on Linux), or `c` to copy its path:
`config.toml` for templates and manually configured API keys, `auth.toml` for
discovered credential sources, or `connections/` for saved agent connections.
The picker uses the active config directory and works with no boxes. `Esc`
closes it. Paths can be copied before the files exist.

Set `[dashboard].config_opener` to customize how Enter opens a path. It runs in
your interactive shell with the Herdr config folder as both the working directory
and `$1`, and the selected path as `$2`. The folder resolves to
`$XDG_CONFIG_HOME/herdr`, or `$HOME/.config/herdr` when XDG is unset. For example, to open a new editor window:

```toml
[dashboard]
config_opener = 'code --new-window "$1" "$2"'
```

`E2B_DASH_CONFIG_OPENER` overrides this setting. With neither set, the picker
uses your shell's `open` on macOS or `xdg-open` on Linux.

The header names the **region** a new box would land on (`us` / `eu`, resolved the
same way every other verb resolves it, re-asked while the board is open) with the
current theme right-aligned beside it. A `⚠` after the region means the list is not
all one cluster — those boxes can't be reached from here.

Columns are `NAME · BRANCH · TEMPLATE · SANDBOX · FILES · STATUS`. `TEMPLATE` is
the template the box actually booted; `base ⚠` in amber means the requested one was
not built on this cluster and `base` booted instead. `BRANCH` is read live from the
worktree's `HEAD` and is dropped on a pane too narrow for it. `STATUS` comes last
and carries the provisioning step when there is one to carry
(`◐ provisioning · uploading 210/540 files`).

`sync`/`pull`/`kill` confirm first and name the exact worktree. `w` jumps to the
row's local worktree, focusing that herdr workspace if it is already open. `T`
cycles `terminal · solarized-light · tokyo-night · dracula · nord · gruvbox`;
`[dashboard].theme` sets a default. `install.sh` builds it with Rust when you
have it, otherwise downloads the published binary — offline or on an unsupported
arch it skips, because the dashboard is optional.

### herdr actions

`open`, `fleet`, `sync`, `pull`, `status`, `pause`, `resume`, `kill` and
`dashboard` are registered as herdr actions, acting on the **focused pane's**
checkout:

```bash
herdr plugin action invoke sync --plugin e2b-dev.herdr-e2b
```

`open` and `fleet` hand off to a pane — an action has no terminal of its own, so
it can't host a shell or draw a chooser. One-shot verbs print to
`herdr plugin log list --plugin e2b-dev.herdr-e2b`.

## How code gets in

File selection follows git: `git ls-files --cached --others --exclude-standard` —
tracked files **including uncommitted edits**, plus untracked files, honoring
`.gitignore`. Build output, caches and `node_modules` never go up. `.git` is
skipped and the box runs `git init -b <branch>`; `[upload].ignore` is an extra
filter on top (it keeps `.env` out even if tracked) and the only filter for
non-git folders. Symlinks are skipped.

## Configuration

Copy `config/config.example.toml` to
`~/.config/herdr/plugins/config/e2b-dev.herdr-e2b/config.toml`. Every key is optional and
that file documents all of them — region, template, branch rules, timeout,
auto-pause, per-template env, fleet roster, agents and seeds.

## Limits

- **Sync is on demand.** `sync` pushes up, `pull` brings down — writing only
  files that differ, never deleting local-only files, prompting (or aborting when
  headless) on a dirty tree unless `--force`. Review with `git diff`.
- **One box per checkout**, keyed by the folder's absolute path — no git needed;
  a plain folder works too.
- **Removing a worktree kills its box.** Cost control, intentional.
- **Boxes pause at the idle timeout** (`[sandbox].timeout_ms`, default 1h — the
  free-tier cap): a full memory snapshot, so billing stops and `open` puts you
  back with everything still running. Works on the free tier.
  `[sandbox].auto_pause = false` restores kill-at-timeout for throwaway boxes.

## License

Apache-2.0. See [LICENSE](LICENSE).
