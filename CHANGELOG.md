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
