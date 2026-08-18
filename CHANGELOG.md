# Changelog

All notable changes to herdr-e2b-sandbox are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The suggested keybindings are now the full set of three — `prefix+shift+e`
  (open), `prefix+shift+f` (fleet) and `prefix+shift+d` (dashboard) — and the
  README, the manifest and `install.sh` all say that `prefix+shift+d` takes over
  herdr's own `close_workspace`.

## [0.0.1] - 2026-08-18

Initial public release. A herdr plugin that mirrors a git worktree into an E2B
sandbox: `e2b-box` for a single box, `e2b-box fleet` for a branch-per-agent
fleet, and the `e2b-dash` TUI for watching them.

[Unreleased]: https://github.com/e2b-dev/herdr-e2b-sandbox/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/v0.0.1
