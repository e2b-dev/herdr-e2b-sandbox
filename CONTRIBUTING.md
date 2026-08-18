# Contributing to herdr-e2b

New here? [`ARCHITECTURE.md`](ARCHITECTURE.md) maps the codebase (the bash/Node/Rust
layers, the data flow, the state model, and the invariants worth checking).

## Dev setup

- Requirements: **Node ≥ 22**, **jq**, **git**. Optional: **Rust** (only to build
  the dashboard TUI from source).
- Local install into herdr: `herdr plugin link /path/to/herdr-e2b && ./install.sh`.
- Install deps + run the checks: `npm install && npm test`.

## Tests

`npm test` is fully offline (no E2B calls, no API key) and runs:

- `node --test test/*.test.js` — pure helpers: config resolution
  (`resolveTemplate` / `resolveLifecycle`) and the `pull` path-safety guards
  (`isIgnored` / `relIsUnsafe`).
- `test/cli.test.sh` — `bash -n` / `node --check` lint across the scripts, plus
  offline `e2b-box` behavior (the `no sandbox tracked` messages and the
  non-interactive `pull` abort-without-clobber path).

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
