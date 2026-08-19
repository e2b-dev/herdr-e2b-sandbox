# Changelog

All notable changes to herdr-e2b-sandbox are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `e2b-box auth` reports which coding harnesses are installed on your machine and
  whether a box can borrow their credentials, so the variable a template needs stops
  being something you have to look up.
- That report now covers all seven harnesses behind a shipped template — `claude`,
  `codex`, `grok`, `opencode`, `amp`, `droid` and `prime` — each read by a rule
  written against its own binary's real output. A harness this plugin does not know
  is left alone rather than guessed at.
- `e2b-box auth` now asks **once** for the whole batch and writes what it found to a
  generated `auth.toml` beside your `config.toml`, at mode `0600`, regenerated whole
  on every run. `--yes` skips the question for a scripted install; with no terminal
  and no flag it reports and writes nothing. Your own `config.toml` is never edited
  by it — a credential found in a harness's own file is stored as a value, while one
  found only in your shell records the variable's NAME and never its value.
- Boxes now boot from what that command found: the config loader reads `auth.toml`,
  and a box gets its template's discovered credential without you configuring
  anything. A recorded variable name is resolved from `e2b-box`'s own environment
  at create time, and the box is handed the variable **it** needs, which is not
  always the one it was found under. Anything you wrote by hand still wins — the
  order is shipped defaults, then discovered, then `[sandbox.env]`, then
  `[templates.<name>.env]` — and an absent or malformed `auth.toml` is simply no
  discovery rather than a broken CLI.
- The template picker in `e2b-box open` now marks each template with what
  `e2b-box auth` discovered for it — `key (file)` for a credential stored out of a
  harness's own config, `key (env)` for one forwarded by name from your shell — so
  you learn a box will open on a sign-in screen before you spend a minute creating
  it. It annotates and never filters: a template with no credential stays on the
  menu, in the same position, because it may be one you intend to configure later
  or a base image that needs none. The picker reads the generated file only and
  spawns no probe, and a template it found nothing for is drawn with no mark rather
  than a misleading one.
- `e2b-fleet` now warns before it launches a member that will come up on a sign-in
  screen. One warning for the whole roster, naming each affected member, its
  template and the exact variable to set, followed by the block you can paste
  straight into your own `config.toml`. Then it launches: this is a warning and not
  a gate, the same way a dirty worktree is (ADR 0003) — you may be about to
  configure that credential, or may not care about that member. A member you
  configured by hand counts as authenticated, and a member with nothing to
  authenticate — a plain image, a template of your own, an agentless control arm —
  is left out of it. Nothing on that path spawns a harness binary.
- `install.sh` now runs that discovery once on a fresh install, so a first box comes
  up authenticated without anyone reading the config reference. It shells out to
  `e2b-box auth --yes` — one discovery implementation, a second entry point into it
  — and passes the flag because `herdr plugin install` has no terminal and a
  scripted install must not stall on a question. It prompts for no harness
  credential, and it cannot fail the install: no harness installed, every probe
  timing out, or no Node >= 22 yet each produce a report and a successful install.
  A machine that already has a generated `auth.toml` is left alone, and every run
  says how to refresh it after installing a new harness.
- A box can now boot into the **signed-in session** on your machine rather than a
  pasted key. `e2b-box auth` records a Codex subscription login out of its own
  `auth.json`, and the codex row goes from "signed in, but not a key this plugin can
  use" to "signed-in session (expires in 8 days)". Per ADR 0007: the single-use
  refresh token is never copied — a visible placeholder goes in its place, so a
  borrowed copy can never revoke the login it came from — and unlike every other
  discovered thing a session **outranks** your own `[templates.<name>.env]`, with
  `prefer = "env"` on a template to take that back. It expires, so its expiry is
  recorded and the report, the chooser mark and the fleet warning all render an
  expired session as expired; an expired one is never injected, so a box falls back
  to whatever credential still works instead of to a sign-in screen. Claude is
  untouched — its credential is in the Keychain, which ADR 0007 does not reopen.
- When a borrowed session authenticates a box, the **API key it replaces is no longer
  sent** — whichever rung supplied it, including your own `[templates.<name>.env]`. A
  box signed in by the session cannot use the key, and an unusable credential in a
  box's environment is blast radius bought for nothing. An expired or opted-out
  session suppresses nothing, because that is precisely when the key is the fallback.
- `e2b-box auth` now checks whether a variable it recorded by NAME is visible to a
  **login shell**, and says so when it is not. herdr runs plugin commands as
  `bash -lc`, which reads `~/.profile` and never a zsh rc, so a key exported only
  from `~/.zshrc` was found at discovery and simply absent when the box was created —
  the report said `key found` and the box still opened on a sign-in screen. The
  warning names the variable, the template and both fixes. It is a real check rather
  than a blanket caveat, so it stays quiet on the machines where the key does survive.
- A forwarded name that cannot be resolved at box-create time is now named in the
  provisioning log at the moment it goes missing, instead of being dropped silently.
  The box is still created — an unauthenticated box is what was asked for and is
  still useful.
- **amp** and **prime** now hand a box the key already sitting in their own config
  file (`~/.local/share/amp/secrets.json`, `~/.prime/config.json`), taking the report
  from 3 of 7 harnesses to 5 of 7. No policy change — this is the original rule about
  a value already in a plaintext file you own; both simply lacked a reader. amp's key
  is named after the server it belongs to, so the reader takes the default server's
  entry and refuses when several are present rather than guessing which one a box
  should get.
- **droid** and **claude** are deliberately still out, and ADR 0007 now records why
  rather than leaving it open: droid's store is encrypted, and claude's is the macOS
  Keychain, which this plugin does not open on any path. Claude's route remains
  `claude setup-token`.
  (Nothing reads `auth.toml` yet; boxes start using it in the next change.)
- **Pick a region by name.** `[sandbox] region = "us" | "eu"` is the only way to
  say where a box runs (see `docs/adr/0007`). `us` is the default and needs no
  configuration at all — it resolves to the SDK's own default,
  `https://api.e2b.app`; `eu` resolves to `https://api.e2b-juliett.dev`. An
  unrecognised region is an error naming the two, never a silent fallthrough.
  `us` deliberately pins no host: US also answers at `e2b.dev`, an older name for
  the same environment that the `e2b` CLI still defaults to, so naming either
  would put one tool at odds with its own default for nothing.
- **One API key per region.** `[secrets] e2b_api_key_us` / `e2b_api_key_eu` may
  sit beside the single `e2b_api_key`, so changing region moves the credential
  with it. A key belongs to exactly one region, and the mismatch reports as
  `Invalid API key … Cannot get the team` — which reads like a broken credential
  when only the destination is wrong. Only the active region's key is ever read.
- **A template existence check before the sandbox is created**, so a missing
  template is reported in about 50ms rather than after a boot has to fail first.
  It fails open: anything short of a definite "no" falls through to the create,
  because the check is stricter than creating is and must never cost a box that
  would have booted.

### Removed

- **`[sandbox] domain` is gone.** A region is what you choose; the host it
  resolves to is the plugin's business. An old `domain` key is now an **error**
  naming the region to replace it with, rather than an ignored line — silently
  dropping it would have moved an EU user's boxes to US without a word. Box
  records still carry a domain (internal state pinning a box to where it was
  born), and `E2B_DOMAIN` plus the domain inferred from `e2b auth login` still
  work, since neither is part of this plugin's config surface.

### Changed

- **A configured region or domain now outranks an `E2B_DOMAIN` that the herdr
  server merely inherited at launch**, while still losing to one exported in a
  command you typed. herdr is long-lived and freezes its environment, so without
  this the new setting would have been a no-op in the situation it exists for.
- **A fleet member is named after its template's last path segment.** A member
  booted from `ondrejs-project/herdr-agents` lands on
  `e2b/<slug>-herdr-agents-<rand4>` rather than
  `e2b/<slug>-ondrejs-project-herdr-agents-<rand4>` — the project half is shared
  by every member of a fleet, so it only cost a sidebar row its readability. A
  roster holding two templates that would name the same member is now refused,
  naming both.
- **The `base` fallback message names the region** as well as the template.
  `template 'x' not found` is the signature symptom of asking the wrong region,
  and reads as a missing template unless it says where it looked.
- The README and the config example now document using your own project's
  templates: the full `<project>/<template>` form, the quoting a `/` requires in
  a TOML table key, that template names are per-region and so not portable
  between them, and that the EU listing omits public templates — absence there is
  not evidence a template is missing.
- **Boxes now pause at the idle timeout by default** (`auto_pause = true`) instead
  of being killed: a full memory snapshot, so the running agent and everything in
  memory are still there when `e2b-box open` wakes it. Set `auto_pause = false`
  for the old kill-at-timeout behaviour. A new `[sandbox] keep_memory` key picks
  the snapshot kind; `keep_memory = false` (filesystem-only, cold-boots on
  resume) must be paired with `auto_resume = false` and is otherwise rejected
  with an error naming both keys before anything reaches the API. The closing
  messages after you leave a box now describe what that box will actually do at
  its timeout, read from its record.
- **The plugin owns the terminal; the in-box tmux is gone** (ADR-0008). Opening
  a box attaches through the plugin's own PTY client (`src/attach.js`) instead
  of `e2b sandbox connect`: raw mode end to end, so shift/ctrl/alt+Enter reach
  the agent byte-for-byte, and no multiplexer is installed into (or configured
  in) any box. The terminal is stamped `HERDR_E2B_TERMINAL=<box key>` and its
  pid recorded on the box record. The client reports outcomes by exit code
  (clean · never attached · box gone · attached-then-lost), replacing the old
  two-second timing heuristic; the undocumented `[sandbox] tmux` opt-out key is
  removed along with the mechanism it gated.
- The suggested keybindings are now the full set of three — `prefix+shift+e`
  (open), `prefix+shift+f` (fleet) and `prefix+shift+d` (dashboard) — and the
  README, the manifest and `install.sh` all say that `prefix+shift+d` takes over
  herdr's own `close_workspace`.
  removed along with the mechanism it gated.
- **Reopening a box puts you back on the screen you left.** The client
  reattaches to the box's own terminal — verified by its marker, never by a
  bare pid — and nudges a repaint with a resize (one when the pane's geometry
  differs from the terminal's, away-and-back when it doesn't), so your agent
  comes back mid-task with its frame intact. The scrollback above the frame is
  not stored anywhere and does not return; the client says so, once, only when
  reattaching. A terminal that died (or whose pid was recycled) yields a fresh
  one, announced. The attach-or-create decision is a pure module
  (`src/attach-plan.js`) with offline tests.
- **The record tells the truth about a paused box.** A box that pauses
  underneath an attached session has `paused` written to its record by the
  terminal client on the way out (one `getInfo` at the moment of loss — no
  poll, no reconciler), so the dashboard stops showing a frozen box as ready.
  The readiness spinner treats `paused` as a settled state: a box that pauses
  mid-boot ends the wait with "resumes it and continues" instead of spinning
  to the twenty-minute cap. Listing boxes makes no network call it didn't
  make before.
- **Boxes now pause at the idle timeout by default** (`auto_pause = true`) instead
  of being killed: a full memory snapshot, so the running agent and everything in
  memory are still there when `e2b-box open` wakes it. Set `auto_pause = false`
  for the old kill-at-timeout behaviour. A new `[sandbox] keep_memory` key picks
  the snapshot kind; `keep_memory = false` (filesystem-only, cold-boots on
  resume) must be paired with `auto_resume = false` and is otherwise rejected
  with an error naming both keys before anything reaches the API. The closing
  messages after you leave a box now describe what that box will actually do at
  its timeout, read from its record.

### Fixed

- **A broken plugin config no longer reports itself as a missing API key.** The
  credential pre-flight ran its resolver with stderr and the exit code both
  discarded, so any fatal config error — a mistyped region, say — degraded into
  the generic "No E2B API key" several calls later, sending you to check a
  credential that was fine.
- **`e2b-fleet` no longer blames the task slug for every naming failure.** That
  was accurate while an unusable slug was the only way to fail, but the naming
  helper prints its own reason on stderr directly above, and a second guessed
  cause could contradict it.

## [0.0.1] - 2026-08-18

Initial public release. A herdr plugin that mirrors a git worktree into an E2B
sandbox: `e2b-box` for a single box, `e2b-box fleet` for a branch-per-agent
fleet, and the `e2b-dash` TUI for watching them.

[Unreleased]: https://github.com/e2b-dev/herdr-e2b-sandbox/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.0.1
