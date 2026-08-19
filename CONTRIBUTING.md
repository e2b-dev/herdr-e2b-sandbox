# Contributing to herdr-e2b

New here? [`ARCHITECTURE.md`](ARCHITECTURE.md) maps the codebase (the bash/Node/Rust
layers, the data flow, the state model, and the invariants worth checking).

## Dev setup

- Requirements: **Node ≥ 22**, **jq**, **git**. Optional: **Rust** (only to build
  the dashboard TUI from source).
- Local install into herdr: `herdr plugin link /path/to/herdr-e2b-sandbox && ./install.sh`.
- Install deps + run the checks: `npm install && npm test`.

## Tests

`npm test` is fully offline (no E2B calls, no API key) and runs:

- `node --test test/*.test.js` — pure helpers: config resolution
  (`resolveTemplate` / `resolveLifecycle`), the attach-or-create decision
  (`planAttach`), the `pull` path-safety guards
  (`isIgnored` / `relIsUnsafe`), harness probe interpretation
  (`interpretProbe`), which runs from captured probe output and so needs no
  coding CLI installed, and what `e2b-box auth` would then write (`buildPlan` /
  `renderAuthToml`), which takes its file reader as an argument for the same
  reason. Two exceptions read a file rather than take one: the generated
  `auth.toml` reader and the loader test that proves a box boots from it, which
  writes a fixture under the OS temp dir and spawns one child `node` — never the
  developer's own config.
- `test/cli.test.sh` — `bash -n` / `node --check` lint across the scripts, plus
  offline `e2b-box` behavior (the `no sandbox tracked` messages and the
  non-interactive `pull` abort-without-clobber path). The template picker's auth
  marks are covered from both ends: the menu `src/resolve-template.js` emits
  against a fixture `auth.toml`, and the frame `ask_template_tty` actually draws,
  read back off the forked pty.

Live E2B round-trips (provision / sync / pull / kill) are verified manually,
since they consume real sandbox time — use a throwaway git folder and kill the
box afterward. CI (`.github/workflows/ci.yml`) runs `npm test` on Ubuntu and
macOS across Node 22 and 24, and checks that `package.json` and
`herdr-plugin.toml` versions match.

## Releasing

1. Move the `[Unreleased]` items in `CHANGELOG.md` under a new
   `## [X.Y.Z] - YYYY-MM-DD` section (and update the compare links at the bottom).
2. Bump the version in **both** `package.json` and `herdr-plugin.toml` — CI and
   the release workflow both fail if they don't match the tag.
3. If the dashboard changed, rebuild the prebuilt binaries with
   `tui/build-prebuilt.sh` (needs `zig` + `cargo-zigbuild` for the Linux targets)
   and commit them.
4. Commit, then tag and push: `git tag vX.Y.Z && git push origin main --tags`.
5. `.github/workflows/release.yml` runs the tests, verifies the tag matches the
   versions, and publishes a GitHub Release with the changelog notes and the
   prebuilt dashboard binaries attached.
