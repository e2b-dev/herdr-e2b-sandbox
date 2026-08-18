# AGENTS.md

herdr plugin that mirrors a git worktree into an E2B sandbox. See `ARCHITECTURE.md`
for the codebase map, `CONTRIBUTING.md` for the dev loop.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/` — no GitHub round-trip. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, recorded as a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
