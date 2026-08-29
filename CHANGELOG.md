# Changelog

All notable changes to herdr-e2b-sandbox are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/e2b-dev/herdr-e2b-sandbox/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.4.0
[0.3.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.3.0
[0.2.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.2.0
[0.1.0]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.1.0
