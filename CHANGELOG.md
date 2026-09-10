# Changelog

All notable changes to herdr-e2b-sandbox are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fleet presets

- Launch a generated JSON fleet with `fleet create --file PATH` (or `-` for stdin).
  Named recipes in `presets/` beside config.toml work with `--preset NAME` and are
  listed by `fleet presets`. Each saves templates, models, reasoning, counts and
  an optional slug/task. CLI flags override saved values; `--dry-run` validates.
- In the fleet roster, p / Shift+P applies saved presets to editable cells before
  launch. Cached startup and existing navigation remain unchanged. ADR 0018.

### Performance

- Warm both picker caches in the background at startup, after installation and
  when a workspace opens, so the first opening can use the cached frame too.
- Escape closes picker popups immediately and still dismisses a dropdown in
  place. An Enter pressed during refresh can be cancelled with Escape; it no
  longer blocks on the resolver. Shift+Tab moves backward through cells and
  fleet text fields without closing the popup.
- Box and fleet popup pickers paint their cached input before starting Node, then
  refresh the rows in place. Every reopen resolves current config, catalog, branch
  and auth input before accepting a choice. Cold openings keep the existing picker
  path, with the cache write running alongside the first frame. ADR 0017.

### Added

- **The harness catalog is generated, not typed.** `npm run catalog -- --write` boots
  one throwaway sandbox per shipped agent template, asks the CLI in it which effort
  words it accepts (its own rejection message, fed a sentinel) and which models it
  lists (`codex debug models --bundled`, droid's `initialize_session` handshake,
  grok's cache, amp's agent options, `prime-agent model list`; models.dev for
  claude), and writes what it read into `src/harness-catalog.generated.js`, the
  `<catalog>` block in `config/config.example.toml`, and `test/fixtures/catalog/`.
  `src/effort.js` now derives every scale from that module instead of holding
  literals: the two hand-kept copies had already drifted from each other (codex
  `minimal` in one, `max` in the other; droid seven words against nine) and from
  the boxes, which ship different CLI versions than a laptop. Per-model efforts and
  defaults are carried too (`modelCatalog`, `effortsForModel`), which is the only
  check that exists for droid, whose CLI accepts any of its words and silently runs
  the model's default. `--check` (the default) exits 2 on drift; a failed probe keeps
  the committed row and marks it stale, never blanks it; no credential is ever on a
  command line. The release skill runs it before tagging. ADR 0016.
- **A model cell in both pickers.** `e2b-box open`'s template list and the fleet's
  roster table gain a model cell between the template and the effort, listing
  the catalog for every harness the plugin can pin a model on (claude, codex, grok,
  droid, prime); a long list scrolls, `s` in the roster gives each instance its own
  model, and the cell opens on `[templates.<name>] model`. The same choice from a
  script: `e2b-box open --model claude-opus-5` and the fleet spec
  `NAME[:MODEL][*N][@EFFORT]` (`claude:claude-opus-5*2`). A per-box model is checked
  against the catalog before anything is created, and a per-box effort against
  that model's own list, which is the only check that exists for droid.
- **The pickers live in the popup.** The `open` and `fleet` actions put their
  questions in the same floating overlay the dashboard uses, centered: template,
  model and effort for one box; slug, task and roster for a fleet. The overlay is
  for choosing, never for running: `open` closes it and boots the box in a pane
  below the pane you pressed the key in (`e2b-box pick`, `e2b-box-open`'s
  `--template/--reasoning/--model` hand-off, `E2B_TEMPLATE` / `E2B_REASONING` /
  `E2B_MODEL`), and `fleet` turns it into the dashboard while the members
  provision. Tab now walks every cell and then on to the next row, and shift-tab
  (or ←) walks the same path backwards, off a row's first column onto the last cell
  of the row above; taking or leaving a cell's list keeps the focus on that cell,
  so what just changed is what is highlighted (←/shift-tab back to the template
  column, then enter). Cells are plain text, reverse video alone marks the focused
  one (the ‹ › chevrons are gone), the roster's column titles sit over their cells
  and the member count's title is `count`, and a cell's list unfolds as a dropdown
  right under its row at the cell's column, pushing the rows below down, instead
  of at the foot of the table. Like the dashboard, the overlay's first frame is the
  screen itself: nothing is drawn ahead of the picker, the frame's centering is
  sticky so an opened list never shifts the table, and a box whose template is
  already settled hands off without drawing a picker.
- **A fleet shows on the board before its boxes exist.** e2b-fleet writes a
  `pending` placeholder record per member the moment the plan is final (creating
  its worktree, then starting its box), so the dashboard the fleet pickers turn
  into is never empty while worktrees and panes come up. The placeholder leaves
  when the member's own record lands, when the member fails, or after 60s at most;
  the dashboard refuses every verb on it but kill.

### Fixed

- `src/harnesses.js` cited ADR 0006 (region is sugar over domain) for the
  spawn-the-binary rule; that rule is ADR 0009.

- A fleet of all eight shipped agents came up with five members broken (observed
  live, fleet `test`, 2026-09-08); each fix is the one its harness asked for:
  - **opencode** opened on an image model with no tool use even though
    `[templates.opencode] model` was set: the TUI only picks a model it can find in
    the provider's list, and on a fresh box that list is the snapshot bundled into
    the binary until models.dev is fetched, so a model newer than the template was
    unknown at the first launch. The pin now also declares the model under its
    provider in `OPENCODE_CONFIG_CONTENT`, so it exists fetch or no fetch.
  - **amp** borrowed the OAuth session `amp login` leaves in `secrets.json` and
    booted a member amp refuses ("holds an OAuth session token, which is
    short-lived"). A JWT under `apiKey@…` is no longer read as a key; the member is
    named before the fleet is created, with the remedy: an access token from
    ampcode.com/settings/security in `AMP_API_KEY`. Not borrowed the way grok's
    session is, on purpose: amp's bearer lives five minutes and its refresh token
    rotates-invalidates, measured in ADR 0014.
  - **droid** opened on "Auto (Off) · all actions require approval": the
    interactive `droid` takes its Autonomy Level from settings.json, not from a
    flag (`--auto` belongs to `droid exec`). The droid seed now also writes
    `sessionDefaultSettings.autonomyLevel = "high"` when nothing set it, the
    unattended default claude and codex members already get.
  - A fleet named an **opencode** member as "will start unauthenticated" and then
    booted it signed in: opencode forwards a whole auth.json under its box variable
    and has no host variable, so the pre-flight check never looked at the one
    variable it actually had.
  - **grok** rejected `reasoning = "max"` ("Invalid reasoning effort"): grok 1.0.13
    accepts `low | medium | high | xhigh`. The example config says so; `max` was
    never on its scale.
  - **claude** and **codex** failed on their pinned models ("does not support this
    model; version 2.1.251 or newer is required", "requires a newer version of
    Codex"): not this plugin, stale EU template images. Rebuilt on juliett with
    Claude Code 2.1.265 and codex 0.153.4. Worth knowing: the public agent
    templates go stale on a cluster, and a model pin is the first thing that
    notices.

### Changed

- The shipped default template is `muse` (Meta's Muse Code), not `base`: a new box
  with nothing configured boots an agent ready to work instead of an empty image.
  `base` stays in the picker, stays the create-time fallback for a template that is
  not on your cluster, and is still excluded from fleet rosters. A fleet roster now
  drops templates that are agentless (`base`, or `[fleet.agents] <name> = ""`)
  rather than whatever `[sandbox] template` names, so the default is a member.
  `[sandbox] template = "base"` restores the old behaviour.

### Added

- The pickers choose **effort** and **how many**. `e2b-box open`'s template list
  grew a ‹ effort › cell per row (→/tab focuses it, enter opens the harness's own
  words as a list from `src/effort.js`; it opens on the `[templates.<name>]
  reasoning` pin), and the fleet's roster is now a table: in or out, effort, count,
  with `s` unfolding one row per instance so members of one template can think
  differently. Both pickers redraw in place instead of clearing the screen, so
  moving the cursor no longer flashes. From a
  script: `e2b-box open -t grok --reasoning xhigh`, and fleet member specs
  `NAME[*N][@EFFORT]` (`-t 'codex*3@ultra'`, `--agents codex*3@ultra,grok@xhigh`).
  A repeated `-t codex` is two members now, not one: instances get numbered labels
  and branches (`t-21-codex-2`). An effort the harness does not accept fails the
  box before it is created, naming the accepted words. opencode gets a generic
  scale that only reaches the box as `HERDR_E2B_REASONING` (its reasoning is a
  per-model UI variant); amp's picked effort becomes its `--mode`.

- `e2b-box auth connect muse | amp`, and `auth connect codex --oauth`: the plugin
  signs in with the vendor's own OAuth flow (the public client its CLI ships) and
  stores what the vendor mints as a connection under `connections/` (ADR 0015).
  muse keeps the Muse API key Meta mints; codex keeps a second, plugin-owned
  ChatGPT login whose refresh token only `auth reconnect` ever uses, so boxes still
  get the placeholder copy and `~/.codex` is never touched. amp has no OAuth route
  (its access token sits behind a recent-sign-in gate in the browser, measured), so
  `auth connect amp` opens ampcode.com/settings/security and stores the token you
  paste (`--token-stdin` for scripts). Flows in `src/oauth.js`, tested against a
  scripted server; nothing in the suite signs in anywhere.

- `[templates.<name>] model = "…"` and `reasoning = "…"`: pin which model a
  template's agent uses and how hard it thinks, for every box booted from it
  (`open`, `fleet`, `run`). Delivered the way each harness reads its defaults
  (`src/model-pin.js`): claude and opencode through their environment
  (`ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`, `OPENCODE_CONFIG_CONTENT`),
  codex, grok, droid, prime and muse through their own config file, written right
  after the first-run seed and never over a key that is already set. Every pinned
  box also carries `HERDR_E2B_MODEL` / `HERDR_E2B_REASONING` for your own launch
  commands. `[templates.<name>.env]` still wins for the same variable.

- `e2b-box run` drives every shipped agent template headless: `grok`
  (`--prompt-file`), `droid` (`droid exec -f`), `muse` (`muse exec --prompt-file`)
  and `prime` (`prime-agent -p`) join `claude`, `codex`, `opencode` and `amp` in
  `DEFAULT_RUN_AGENTS`, each with its vendor's skip-approvals flag, verified off the
  CLIs' own `--help`. Only `base` and a user's own template still need `[run.agents]`.

### Fixed

- A discovered prime key now travels with the account's team id: `PRIME_TEAM_ID` is
  read out of `~/.prime/config.json` at create time beside `PRIME_API_KEY`, so a box
  bills the team rather than an empty personal balance (`402 Insufficient balance`
  inside the box, fine on the laptop). A hand-written `[templates.prime.env]` value
  still wins.

- `e2b-box run`, the headless verb (#47): boot or re-sync this checkout's box,
  write the task into it as a file, start the template's agent in its
  non-interactive mode and wait for it to exit, pull what changed back, optionally
  commit and push the local branch (`--push`, `--remote`, `-m`), pause the box
  (`--kill` destroys it, `--keep` leaves it running), and exit 0 only when every
  step landed. `--task` takes the text, a file to read,
  or `-` for stdin; `--timeout-ms` bounds the agent (30 min default), `--force`
  is `pull`'s, `--dry-run` prints the plan, `--json`
  prints one result object with the deciding `status`. `claude`, `codex`,
  `opencode` and `amp` ship verified headless commands (`src/run-agent.js`);
  other templates are refused by name until `[run.agents]` maps them.
  `docs/headless-run.md` is the guide, with a GitHub Actions example.

### Fixed

- Enter in the popup dashboard opens the box in a regular pane split below the
  pane the popup floats over, then closes the popup, instead of running the
  sandbox shell inside the overlay (whose terminal herdr discards on close).
  `e2b-popup` records the pane it was summoned over as `E2B_DASH_ORIGIN_PANE`
  and the TUI hands it to `e2b-box-open --target-pane … --cwd … --box …`, which
  now takes those flags; the zoomed and split dashboards still open inline.
  `[dashboard].popup_open` chooses where that pane goes: `below` (default),
  `right`, `above`, `left` or `tab`.

### Changed

- Relicensed from MIT to Apache-2.0, matching the rest of the e2b-dev org, with
  the copyright holder corrected from the scaffold's to FoundryLabs, Inc.
  `package.json` carries the `Apache-2.0` SPDX id and the README's License
  section points at `LICENSE`.

## [0.5.0] - 2026-09-07

### Fixed

- `pull` finishes every batch even when one remote file is unreadable or a local
  write fails: each failure is reported per file, only successful writes count
  as new or overwritten, and an incomplete pull exits 1 instead of claiming the
  local tree matches the box. (#36)

- Attach plans clamp pane dimensions to positive integers: missing, nonpositive
  or nonfinite columns/rows default independently to 80/24 before they reach PTY
  creation or resizing. (#35)

- `exec` always emits its JSON result: malformed input, invalid timeouts, and
  configuration or credential failures return one object with `ok: false` and
  `exitCode: null` instead of crashing before the grader can read it. (#34)

- Concurrent record writes in one process no longer share a temporary path;
  each write gets its own tempfile, removed again if the write or rename fails.
  (#33)

- Closing the popup keeps its last frame and hidden cursor intact until Herdr
  removes the overlay, preventing an intermediate blank-screen/cursor flash.

- Native Herdr popup bindings can use `e2b-popup --render` to bypass the
  action/CLI round trip. Reopened dashboards reuse cached theme and region
  immediately, then refresh settings in the background.

- Dashboard/popups paint before configuration and region resolution finishes.
  Startup reads display settings once in the background; periodic region checks
  also run off the UI thread so they cannot interrupt painting or keyboard input.

### Changed

- The popup border shows a GitHub icon and `herdr-e2b-sandbox`; its dashboard
  header omits the repeated project name.

- Config openers use the current user's Herdr config folder as the editor root
  and working directory, with the selected config file passed separately.

- The sandbox open and fleet creation actions always open and focus a new pane
  below the invoking pane. Fleet creation continues into the dashboard there.

- `e2b-box auth` now combines saved connections, config, and discovery in a compact
  ASCII table with explicit OAuth/API-key labels. Selected connections are credited correctly, setup advice appears
  only when needed, and unavailable connections cannot appear ready through a
  fallback key. Long details wrap; pipes and `NO_COLOR` use plain text.

### Added

- Interactive `e2b-box auth`: select an agent to connect, reconnect, inspect auth,
  or open config files using the dashboard's opener. Explicit discovery and
  non-interactive calls retain their report/save behavior.

- `e2b-popup` / `e2b-box popup`: the dashboard in a centered Herdr popup over
  the existing panes, with the same UI and controls. Also available as the
  `popup` plugin action for keybindings. Herdr settings offer independently
  bindable `e2b-dash (pane view)` and `e2b-popup (overlay view)` actions.

- Claude connection names use the detected organization (such as `claude-e2b`)
  for Team/Enterprise accounts. Setup and list distinguish the local account
  from connection access; existing connection IDs remain unchanged.

- Dashboard `C` config-path picker: Enter opens the active `config.toml`,
  `auth.toml`, or saved connections directory; `c` copies its path, including
  when there are no boxes. `[dashboard].config_opener` selects a custom shell
  command, with the plugin directory and selected path passed as arguments.

- Named personal coding-agent connections: `auth connect`, `list`, `explain`,
  `check`, `reconnect`, and `disconnect`. Claude uses first-party setup-token
  capture with token redaction; Codex borrows its local session without its real
  refresh token. Claude subscription type and organization are detected as local
  account metadata. `open`/`up --connection ID` selects one method for a new box
  and removes competing auth variables. Existing discovery remains available as
  `auth` or `auth discover`; organization sharing requires a future shared service.

- **Muse Code is a template.** `muse`, E2B's public template for Meta's coding agent, is in
  the `open` picker and the fleet roster, and `e2b-box auth` detects the local install. A
  member starts as `muse --yolo`, the posture Meta documents for "a disposable, isolated
  container": approvals off, Muse's own OS sandbox off (inside an E2B box that sandbox only
  blocks network and out-of-tree writes, the same reason Codex's is bypassed), and the
  workspace trusted for the run, so no first-run seed is needed. The credential is
  `META_API_KEY`, forwarded under its own name; Meta documents it as outranking any stored
  login, so a box handed the variable never sees a sign-in screen.
  What is deliberately NOT borrowed is the browser login. Muse's `~/.config/muse/auth.json`
  is a pointer whose `storage` field reads `keychain` on macOS; the token itself sits where
  ADR 0009 does not look, exactly as Claude Code's does. A signed-in Muse therefore reports
  `signed in, but not a key this plugin can use` and names the variable to set, rather than
  becoming a borrowable session the way codex (ADR 0010) and grok (ADR 0011) did.
  Muse has no status subcommand, so the probe is a headless `exec` aimed at a loopback port
  nothing listens on: an unauthenticated install refuses before it opens a stream, an
  authenticated one fails its transport in about two seconds, and neither sends a byte off
  the machine, spends a token, or writes a session log. Findings in
  `docs/research/0002-harness-detection-and-credentials.md`.

## [0.4.0] - 2026-08-29

### Fixed

- **A daemon-spawned command no longer sends the shell's stale key.** `requireApiKey`
  read `process.env.E2B_API_KEY` before the resolved key, undoing the resolver's
  daemon rule (config and CLI login first, env last, key and domain as a pair): a
  keybinding or action running with a US key frozen in herdr's env, against a box
  in the EU, got `Invalid API key … Cannot get the team` while `resolveCredentials`
  had already chosen the right key. It now trusts the resolved key alone.

### Changed

- **The box's git reads like the laptop's** (ADR 0012). A fresh box used to get `git
  init` and `git add -A` and stop there: a repo with a staged index and no commit, so
  `git status` in the box read as every file being new (`main +197`), and `git diff
  HEAD`, `git log` and `git blame` had nothing to work with. Now the laptop's `HEAD`
  tree arrives as one `git archive` tarball and is committed as the baseline,
  `herdr-e2b: snapshot of <label> @ <branch> <sha>`, and only the files that differ
  from HEAD locally are written on top, uncommitted; files deleted locally are removed.
  A clean local `main` opens as a clean `main`; a dirty one opens with the same
  modified and untracked files. Staging is not carried over. A folder with no commits
  gets the old full upload, committed. A sync commits only the tracked paths, never the
  agent's own work. Side effect: upload is one tarball plus the dirty set instead of one
  write per file.
- **The pull clobber guard names the files at stake, and only fires when there are
  some.** "The tree is dirty" stopped every pull from the dashboard's `p` (no TTY, so
  no prompt), even when the agent's files and your uncommitted files did not overlap.
  The guard now asks the box which files the pull would actually overwrite and
  intersects that with your local uncommitted changes: none in common → the pull runs
  and says so; some → the prompt (or the non-interactive abort) lists them, with
  "commit/stash them, or re-run with --force". A non-git folder, or a box that cannot be
  reached, still gets the old coarse answer.
- **The ready banner reads like the dashboard row.** `e2b-box open` used to print a
  sentence per fact and a long one about what to type when. It now prints one header
  (`● <label> · <template> · <region>`), an aligned block of the three things you copy
  (sandbox, preview, project), and a two-line attach note. The `attaching a shell in the
  sandbox` marker `e2b-fleet` waits on is unchanged. The `(run: cd …)` hint is gone; the
  shell lands in the project already. The on-close prompt (`left sandbox '…'`) takes
  the same shape: a header line, one choice per line with its key in bold brackets, a
  bare `›` prompt.
- **`prefix+shift+p` pulls, and tells you what landed.** The `pull` action now runs
  `bin/e2b-box-pull`: the same guarded `e2b-box pull`, then a herdr notification in
  the bottom-right with the files that came down (or the files it refused to overwrite,
  or the error), and an `r` sent to a reviewr pane in the current tab so the diff
  redraws now rather than on its next poll. An action's own output goes to the plugin
  log, which is why a toast was needed. A `pulling…` toast lands the instant the key
  does; herdr shows one notification at a time, so the result toast waits for the slot. The suggested binding is `prefix+shift+p`,
  herdr's `rename_pane` by default; move that first.
- **Leaving a box uses the same arrow chooser as booting one.** The on-close
  question (pull / kill / leave, plus resume for a paused box) is drawn by
  `lib/chooser.sh` like the template picker: ↑/↓ or a number to move, Enter to take
  the row, or its letter outright. q/Esc leave the box alone. Kill asks once more,
  since one keypress is enough to choose but not to lose a box.
- **The pane is named after the template while a box shell is attached.** Inside
  herdr, `e2b-box open` renames its pane to the box's template (`drew-claude`) and
  puts the old label back, or clears it, when the shell exits.
- **`pull` reads only what changed.** With a baseline to ask about, pull takes the
  box's `git status` as its file list instead of reading every file over the SDK and
  byte-comparing each one locally; four files touched is four reads. Files the agent
  deleted in the box are now named in the output (`- path  (deleted in sandbox — kept
  locally)`) and left alone. A box provisioned before this release has no baseline and
  gets the old full pull, unchanged.

## [0.3.0] - 2026-08-26

### Added

- **The board names the plugin version it is running.** The header's right side now reads
  `theme: … · v0.3.0`, the version in the corner. It answers the question a plugin loaded
  from a working tree raises constantly — is this the build I just made? — which nothing on
  screen used to answer, and which otherwise takes reading `herdr plugin list`, checking
  which directory it points at, and comparing a binary's mtime against its source. The
  number is resolved from `herdr-plugin.toml`, the same manifest herdr's own marketplace
  reads, so the board and herdr can never disagree about what is installed. A pane too
  narrow for both drops the theme first and keeps the version, which stays anchored in the
  corner rather than sliding left. With no version to resolve the header simply omits it: a
  missing version costs nothing, a wrong one misleads.

## [0.2.0] - 2026-08-26

### Added

- **The dashboard names each box's template.** A `TEMPLATE` column sits beside
  `SANDBOX`, reading the template the sandbox actually booted from its record —
  which decides whether the agent you wanted is even installed in there.
  A box that fell back to `base` because its template was not built on this
  cluster is marked `base ⚠` in amber, so a silent downgrade is visible on the
  board instead of only in the create-time log. The column is fixed-width and
  never gives way; `BRANCH` is still the one that yields on a narrow pane.

### Changed

- **The dashboard header names a region, not a host.** `region eu` instead of
  `cluster e2b-juliett.dev` — a region is what you pick, a hostname is how it
  happens to be served, and the header now reads the way `[sandbox] region` and
  the error messages already do. US says `us` rather than going blank: US
  production resolves to no domain at all, so "nothing pinned" and "US" were
  always the same state. An unrecognised host still prints as itself.
- **`STATUS` is the last column and `STEP` is gone.** The two said `ready`
  beside `ready` on every settled box; the step only ever carried news while a
  box was provisioning or after it failed, so it rides in the STATUS cell now
  (`◐ provisioning · uploading 210/540 files`) and is dropped when it repeats the
  status or is the step's own idle value. Column order is
  `NAME · BRANCH · TEMPLATE · SANDBOX · FILES · STATUS`, which puts the three
  facts about the sandbox itself together and gives the growing cell the width
  left over.
- **The theme moved to the right of the header**, where the cluster used to sit,
  and the region took its place beside the title. The region is a fact about
  where your boxes go and never gives way; the theme is a preference and is
  dropped first on a narrow pane, after the title has shortened.

### Fixed

- **A `config.toml` credential change now takes effect without restarting herdr.**
  Commands spawned by the daemon demote the ambient `E2B_*` variables they inherited
  so the config can win — but the pre-flight only consulted the resolver when one of
  those variables was *empty*, so a daemon that inherited both never reached the
  demotion at all and kept using a stale key and region. It is now invoked whenever
  `HERDR_PLUGIN_ID` or `HERDR_PLUGIN_ROOT` says a daemon is the caller.

## [0.1.0] - 2026-08-26

### Added

- **A grok browser login is borrowable, refresh token included (ADR 0011).**
  `grok login` stores an OIDC session in `~/.grok/auth.json`; `e2b-box auth` now
  records it as a pointer and a box receives the file verbatim. Unlike codex's,
  grok's refresh token is measured multi-use — re-using an old token after a new
  one was issued still answers 200 — so shipping it cannot log the laptop out,
  and the box re-mints its own six-hour bearers with no expiry wall. A real
  `XAI_API_KEY` in the environment still outranks the session at discovery, and
  `prefer = "env"` still opts a template out.
- **`e2b-box auth` closes with a summary table.** One row per provider naming
  the credential a box will actually get and where it comes from: a signed-in
  session, a value hand-set in `[templates.<t>.env]` (your `config.toml` is now
  read for display — still never written), a key-file pointer, or a variable
  forwarded from the shell. A credential the report can see but a box cannot
  receive is marked as a warning instead of a tick.
- **`e2b-box auth` finds the credentials already on your machine.** It reads all
  seven harnesses behind a shipped template (`claude`, `codex`, `grok`,
  `opencode`, `amp`, `droid`, `prime`), each with a rule written against that
  binary's real output, and leaves anything it does not recognise alone rather
  than guessing. It asks once for the whole batch, then writes `auth.toml` beside
  your `config.toml` at mode `0600`, regenerated whole on every run. `--yes`
  skips the question for a scripted install. With no terminal and no flag it
  reports and writes nothing. It never edits your `config.toml`.
- **`auth.toml` stores no credentials.** Each discovered credential is a pointer,
  naming the variable to set and the file to read, resolved when a box is
  created. Nothing goes stale, a key you rotate in the harness is picked up
  without re-running discovery, and the file needs no guarding.
- **Boxes boot with what it found.** The config loader reads `auth.toml` and a
  box gets its template's credential with nothing configured. A recorded variable
  name resolves from `e2b-box`'s own environment at create time, and the box
  receives the variable it needs, which is not always the one the credential was
  found under. Anything you wrote by hand still wins. The order is shipped
  defaults, then discovered, then `[sandbox.env]`, then `[templates.<name>.env]`.
  An absent or malformed `auth.toml` means no discovery, not a broken CLI.
- **`amp` and `prime` read the key in their own config file**
  (`~/.local/share/amp/secrets.json`, `~/.prime/config.json`), taking the report
  from three harnesses to five. This is the existing rule about a value already
  sitting in a plaintext file you own. Both simply lacked a reader. amp names its
  key after the server it belongs to, so the reader takes the default server's
  entry and refuses when several are present rather than picking one.
- **`droid` and `claude` stay out, and ADR 0010 records why.** droid's store is
  encrypted. claude's is the macOS Keychain, which this plugin opens on no path.
  Claude's route is still `claude setup-token`.
- **A box can boot into a signed-in session instead of a pasted key.**
  `e2b-box auth` records a Codex subscription login from its own `auth.json`, and
  the codex row changes from "signed in, but not a key this plugin can use" to
  "signed-in session (expires in 8 days)". Per ADR 0010 the single-use refresh
  token is never copied, and a visible placeholder goes in its place, so a
  borrowed copy cannot revoke the login it came from. Unlike everything else
  discovered, a session outranks your own `[templates.<name>.env]`. Set
  `prefer = "env"` on a template to take that back. Expiry is recorded, and the
  report, the picker mark and the fleet warning all render an expired session as
  expired. An expired session is never injected, so a box falls back to whatever
  credential still works instead of to a sign-in screen.
- **When a session authenticates a box, the API key it replaces is not sent**,
  whichever rung supplied it, including your own `[templates.<name>.env]`. A box
  signed in by the session cannot use that key, and an unusable credential in a
  box costs exposure for nothing. An expired or opted-out session suppresses
  nothing, because that is when the key is the fallback.
- **The template picker marks what each template has.** `key (file)` for a
  credential stored in a harness's own config, `key (env)` for one forwarded by
  name from your shell. You learn a box will open on a sign-in screen before
  spending a minute creating it. It annotates and never filters, so a template
  with no credential keeps its place on the menu. It reads the generated file
  only and spawns no probe, and a template it found nothing for is drawn with no
  mark rather than a misleading one.
- **`e2b-fleet` warns before launching a member that will hit a sign-in screen.**
  One warning for the whole roster, naming each affected member, its template and
  the variable to set, followed by a block you can paste into your `config.toml`.
  Then it launches. This is a warning and not a gate, the same way a dirty
  worktree is (ADR 0003). A member you configured by hand counts as
  authenticated, and a member with nothing to authenticate is left out. Nothing
  on that path spawns a harness binary.
- **`install.sh` runs discovery once on a fresh install**, so a first box comes up
  authenticated without reading the config reference. It shells out to
  `e2b-box auth --yes`, one discovery implementation with a second entry point,
  and passes the flag because `herdr plugin install` has no terminal and a
  scripted install must not stall on a question. It prompts for no harness
  credential and cannot fail the install. No harness installed, every probe
  timing out, or no Node 22 yet each produce a report and a successful install. A
  machine that already has an `auth.toml` is left alone, and every run says how to
  refresh it after installing a new harness.
- **`e2b-box auth` checks whether a variable recorded by name is visible to a
  login shell**, and says so when it is not. herdr runs plugin commands as
  `bash -lc`, which reads `~/.profile` and never a zsh rc, so a key exported only
  from `~/.zshrc` was found at discovery and absent at box creation. The report
  said `key found` and the box still opened on a sign-in screen. The warning names
  the variable, the template and both fixes. It is a real check, not a blanket
  caveat, so it stays quiet on machines where the key does survive.
- **A forwarded name that cannot be resolved at create time is named in the
  provisioning log** at the moment it goes missing, instead of being dropped
  silently. The box is still created, because an unauthenticated box is what was
  asked for and is still useful.
- **Pick a region by name.** `[sandbox] region = "us" | "eu"` is the only way to
  say where a box runs (ADR 0007). `us` is the default and needs no configuration,
  resolving to the SDK's own default, `https://api.e2b.app`. `eu` resolves to
  `https://api.e2b-juliett.dev`. An unrecognised region errors naming the two,
  never a silent fallthrough. `us` pins no host on purpose, because US also
  answers at `e2b.dev`, an older name for the same environment that the `e2b` CLI
  still defaults to, so naming either would put one tool at odds with its own
  default for nothing.
- **One API key per region.** `[secrets] e2b_api_key_us` and `e2b_api_key_eu` may
  sit beside the single `e2b_api_key`, so changing region moves the credential
  with it. A key belongs to exactly one region, and the mismatch reports as
  `Invalid API key … Cannot get the team`, which reads like a broken credential
  when only the destination is wrong. Only the active region's key is ever read.
- **A template existence check before the sandbox is created**, so a missing
  template is reported in about 50ms rather than after a boot has to fail first.
  It fails open. Anything short of a definite "no" falls through to the create,
  because the check is stricter than creating is and must never cost a box that
  would have booted.

### Changed

- **Boxes pause at the idle timeout by default** (`auto_pause = true`) instead of
  being killed, with a full memory snapshot, so the running agent and everything
  in memory are still there when `e2b-box open` wakes it. Set
  `auto_pause = false` for the old kill-at-timeout behaviour. A new
  `[sandbox] keep_memory` key picks the snapshot kind. `keep_memory = false`
  gives a filesystem-only snapshot that cold-boots on resume, must be paired with
  `auto_resume = false`, and is otherwise rejected with an error naming both keys
  before anything reaches the API. The closing messages after you leave a box now
  describe what that box will do at its timeout, read from its record.
- **The plugin owns the terminal, and the in-box tmux is gone** (ADR 0008).
  Opening a box attaches through the plugin's own PTY client (`src/attach.js`)
  instead of `e2b sandbox connect`. Raw mode end to end, so shift, ctrl and
  alt+Enter reach the agent byte for byte, and no multiplexer is installed into
  or configured in any box. The terminal is stamped `HERDR_E2B_TERMINAL=<box key>`
  and its pid recorded on the box record. The client reports outcomes by exit code
  (clean, never attached, box gone, attached then lost), replacing the old
  two-second timing heuristic.
- **Reopening a box puts you back on the screen you left.** The client reattaches
  to the box's own terminal, verified by its marker and never by a bare pid, then
  nudges a repaint with a resize. One resize when the pane's geometry differs from
  the terminal's, away and back when it does not. Your agent comes back mid-task
  with its frame intact. The scrollback above the frame is not stored anywhere and
  does not return, and the client says so once, only when reattaching. A terminal
  that died, or whose pid was recycled, yields a fresh one and announces it. The
  attach-or-create decision is a pure module (`src/attach-plan.js`) with offline
  tests.
- **The record tells the truth about a paused box.** A box that pauses underneath
  an attached session has `paused` written to its record by the terminal client on
  the way out, from one `getInfo` at the moment of loss, with no poll and no
  reconciler, so the dashboard stops showing a frozen box as ready. The readiness
  spinner treats `paused` as a settled state, so a box that pauses mid-boot ends
  the wait with "resumes it and continues" instead of spinning to the twenty-minute
  cap. Listing boxes makes no network call it did not make before.
- **A configured region outranks an `E2B_DOMAIN` that the herdr server inherited
  at launch**, while still losing to one exported in a command you typed. herdr is
  long-lived and freezes its environment, so without this the setting would have
  been a no-op in the situation it exists for.
- **A fleet member is named after its template's last path segment.** A member
  booted from `ondrejs-project/herdr-agents` lands on
  `e2b/<slug>-herdr-agents-<rand4>` rather than
  `e2b/<slug>-ondrejs-project-herdr-agents-<rand4>`. Every member of a fleet
  shares the project half, so it added length without telling them apart. A roster
  holding two templates that would name the same member is refused, naming both.
- **The `base` fallback message names the region** as well as the template.
  `template 'x' not found` is the signature symptom of asking the wrong region,
  and reads as a missing template unless it says where it looked.
- **The README and config example document using your own project's templates**:
  the full `<project>/<template>` form, the quoting a `/` requires in a TOML table
  key, that template names are per-region and so not portable between them, and
  that the EU listing omits public templates, so absence there is not evidence a
  template is missing.
- **The suggested keybindings are the full set of three**, `prefix+shift+e`
  (open), `prefix+shift+f` (fleet) and `prefix+shift+d` (dashboard). The README,
  the manifest and `install.sh` all say that `prefix+shift+d` takes over herdr's
  own `close_workspace`.

### Removed

- **`[sandbox] domain` is gone.** A region is what you choose, and the host it
  resolves to is the plugin's business. An old `domain` key is an error naming the
  region to replace it with, rather than an ignored line, because silently
  dropping it would move an EU user's boxes to US without a word. Box records
  still carry a domain, which is internal state pinning a box to where it was
  born, and `E2B_DOMAIN` plus the domain inferred from `e2b auth login` both still
  work, since neither is part of this plugin's config surface.
- **The undocumented `[sandbox] tmux` opt-out key**, along with the mechanism it
  gated.

### Fixed

- **A Claude subscription is no longer invisible to discovery.** `claude` was
  searched for under `ANTHROPIC_API_KEY` and nothing else, so a machine signed in
  with Pro, Max or Team — which is most of them — had nothing to find, and the
  remedy printed beside that result named the variable a `claude setup-token`
  token is *rejected* under. Both `ANTHROPIC_API_KEY` and
  `CLAUDE_CODE_OAUTH_TOKEN` are now searched, and whichever one holds a credential
  is forwarded to the box under its own name. The advice, the paste block and the
  fleet's warning all name the token, because that is what the advice produces.
- **A box with no credential in it says so, on the way in.** `e2b-box open`
  printed the sandbox, the preview URL and nothing about the fact that the agent
  it just booted had been handed no credential — the first sign was the agent
  itself answering `Not logged in`, several minutes later, in a sandbox with no
  browser to finish a sign-in flow in. The box details now carry the same note the
  fleet prints before it launches, naming the variable and the remedy. Silent when
  the box has a credential, and never a gate.
- **A fleet member's worktree is trusted for mise before a shell opens in it.**
  mise keys config trust to the absolute path, so every fresh member checkout was
  untrusted and every shell in it — the box's own pane first — opened on
  `mise ERROR … are not trusted` for a `mise.toml` the base ref already carried.
  The fleet chose that path, so the fleet trusts it. No mise, no config, or a mise
  that refuses, and the member still boots.
- **A broken plugin config no longer reports itself as a missing API key.** The
  credential pre-flight ran its resolver with stderr and the exit code both
  discarded, so a fatal config error such as a mistyped region degraded into the
  generic "No E2B API key" several calls later, sending you to check a credential
  that was fine.
- **An exported key and a configured region no longer point at different
  clusters.** The key and the domain were resolved separately, in two places, so
  each could be answered by a different source. A key exported for US with
  `region = "eu"` in config sent the US key to the EU cluster, which the API
  rejects as `Invalid API key … Cannot get the team`, a message that blames the
  credential when only the pairing is wrong. Nothing warned, because nothing
  compared the two. A source naming both halves now settles it: the environment
  when `E2B_DOMAIN` is exported beside the key, the config when a region is named
  and the file holds a key. The `e2b` CLI login is deliberately not promoted,
  since adopting it would swap the account a config key pinned. A split that
  survives is now stated out loud, naming each source.

- **`e2b-fleet` no longer blames the task slug for every naming failure.** That
  was accurate while an unusable slug was the only way to fail, but the naming
  helper prints its own reason on stderr directly above, and a second guessed
  cause could contradict it.
- **`amp` no longer flickers between `key found (file)` and `probe did not
  answer`.** When its probe exceeds the timeout but its config file plainly holds
  a key, the file settles it. A credential that is there does not become uncertain
  because a binary was slow.

## [0.0.1] - 2026-08-18

Initial public release. A herdr plugin that mirrors a git worktree into an E2B
sandbox: `e2b-box` for a single box, `e2b-box fleet` for a branch-per-agent
fleet, and the `e2b-dash` TUI for watching them.

[Unreleased]: https://github.com/e2b-dev/herdr-e2b-sandbox/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.5.0
[0.4.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.4.0
[0.3.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.3.0
[0.2.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.2.0
[0.1.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.1.0
