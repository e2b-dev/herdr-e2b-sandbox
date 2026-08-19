# Harness detection and credentials

Source material for `src/harnesses.js`. Established 2026-08-19 against vendor docs,
vendor source, and live binaries on one macOS 25.5.0 machine. Scoped by
[ADR 0009](../adr/0009-the-plugin-asks-a-harness-it-never-reads-its-credential-store.md):
detection is a spawn-the-binary probe, reads are limited to environment variables and a
harness's own documented config location, and no OAuth store or Keychain item is opened.

Versions probed: `claude` 2.1.235, `codex-cli` 0.147.0, `grok` 1.0.5, `opencode` 1.18.18,
`amp` 0.0.1787045288, `droid` 0.199.0, `prime-agent` 0.7.0 (`prime` 0.6.21). `gemini` was
not installed; its rows come from source and docs only.

## The table

| Harness | Version probe | Auth probe | Reads exit code? | Host env var | Box env var | Plain-key config file |
|---|---|---|---|---|---|---|
| claude | `claude --version` | `claude auth status` — JSON on stdout | yes, 0/1 | `ANTHROPIC_API_KEY` | same | none — Keychain on macOS |
| codex | `codex --version` | `codex login status` — **stderr** | yes, 0/1 | `CODEX_API_KEY` | `OPENAI_API_KEY` | `~/.codex/auth.json`, field `OPENAI_API_KEY` |
| grok | `grok --version` | `grok models` — first stdout line | **no, always 0** | `XAI_API_KEY` | same | `~/.grok/config.toml`, `[model.<id>] api_key` |
| opencode | `opencode --version` | `opencode auth list` | **no, always 0** | any of ~190 | `OPENCODE_AUTH_CONTENT` | `~/.config/opencode/opencode.json`, `provider.<id>.options.apiKey` |
| amp | `amp --version` | `amp usage` | yes, 0/1 | `AMP_API_KEY` | same | `~/.local/share/amp/secrets.json`, field `apiKey@<server>` — undocumented, but plaintext and now read (ADR 0010) |
| droid | `droid --version` | `droid computer list` | yes, 0/1 | `FACTORY_API_KEY` | same | none — `~/.factory/auth.v2.*`, encrypted |
| prime | `prime-agent --version` (**stderr**) | `prime-agent model list` | **no, always 0** | `PRIME_API_KEY` | same | `~/.prime/config.json`, `api_key` |
| gemini | `gemini --version` | **none exists** | n/a | `GEMINI_API_KEY` | same | none — OS keychain |

Host var and box var differ for three harnesses. Codex authenticates from the environment
with `CODEX_API_KEY`; `OPENAI_API_KEY` is only the field name *inside* `auth.json`, which
is why `src/fleet-seed.js:94` writes that file rather than exporting the variable, and why
`[templates.codex.env] OPENAI_API_KEY` is right for a box and wrong for a host. opencode
has no single variable at all. Prime accepts three.

## What the probes actually do

Exit codes are only meaningful for five of the eight. `grok models`, `opencode auth list`
and `prime-agent model list` exit 0 whether or not a credential exists, so those three are
parsed by output shape. `codex login status` writes every branch with `eprintln!`
(`openai/codex codex-rs/cli/src/login.rs:441-500`), so a stdout capture reads a working
install as logged out. `prime-agent --version` writes to stderr as well
(`packages/coding-agent/src/main.ts:1090`).

Two probes are unsafe and must not be used. `amp threads list` with no credential opens a
browser and blocks on stdin indefinitely; `amp usage` fails in under a second with
`Error: Invalid or missing API key` and, when authenticated, prints `Signed in as <email>`.
`prime whoami` writes `user_id` back into `config.json`
(`PrimeIntellect-ai/prime packages/prime/src/prime_cli/commands/whoami.py:20,35`) — it is
not a read. `droid auth` is not a subcommand at all; `droid [prompt...]` swallows it and
launches the TUI.

`codex login status` sets `enable_codex_api_key_env: false` (`login.rs:458`), deliberately
ignoring environment auth. A box with `CODEX_API_KEY` set works while the probe reports
`Not logged in`. Auth state is therefore *probe result OR environment presence*; neither
alone is sufficient.

Claude Code is the only harness that answers the question the way ADR 0009 wants:
`claude auth status` returns JSON carrying `apiKeySource: "ANTHROPIC_API_KEY"` — the
variable's name and never its value. One ambiguity: with both a live subscription login
and `ANTHROPIC_API_KEY` set it reports `authMethod: "claude.ai"` *and* a populated
`apiKeySource`, with `email` and `orgName` null. Reading `authMethod` alone is wrong.

## Probing safely

Probes must bypass the user's shell. On this machine `grok` and `droid` are zsh functions,
so `command -v` returns a bare name; the real binaries are `~/.grok/bin/grok` and
`~/.local/bin/droid`. The `grok` wrapper runs `env -u XAI_API_KEY grok` when
`~/.grok/auth.json` exists, which would make the plugin probe a stripped environment and
report the opposite of the truth.

Every probe needs `< /dev/null` as well as a timeout — a timeout alone does not stop Amp
from having already opened a browser.

## opencode

No single credential variable exists by design. Providers are resolved from a registry
mirrored at `https://models.opencode.ai/api.json` (~190 distinct variable names), looped at
`sst/opencode packages/opencode/src/provider/provider.ts:1552-1563`; 132 `*_API_KEY`-shaped
names are embedded in the shipped binary. Resolution order is config file, then
environment, then `auth.json` — which is why `opencode auth list` can print `0 credentials`
on a fully working box: it does not see config-file keys. `opencode models <provider>` is
the honest readiness check.

For a box, `OPENCODE_AUTH_CONTENT` carries `auth.json` inline as an environment variable
with zero disk state, which is the best fit for an ephemeral sandbox. It is undocumented,
so it pins the plugin to observed behaviour rather than a contract.

Two footguns: a bare `GITHUB_TOKEN`, `GITLAB_TOKEN` or `AWS_REGION` in the box environment
silently registers a provider; and opencode needs no credential to appear to work, because
unauthenticated OpenCode Zen autoloads with `apiKey: "public"` and serves seven free
models (`provider.ts:179-201`). `opencode run "hi"` exits 0 on a bare box, so a round-trip
proves nothing — which is why `scripts/verify-keys.mjs:47-49` checks for a word.

## Platform differences

Only two exist across all eight. Claude Code stores credentials in the macOS Keychain and
in `~/.claude/.credentials.json` on Linux and Windows. Gemini's *system* settings live at
`/Library/Application Support/GeminiCli/settings.json` versus `/etc/gemini-cli/settings.json`.
Everything else is `$HOME`-relative and identical — note that amp and opencode both use XDG
paths on macOS, not `~/Library/Application Support`.

## Gemini

Not currently shipped as a template here. It has no auth-status subcommand of any kind
(top-level commands are `mcp`, `extensions`, `skills`, `hooks`, `gemma`), no plain-key
config field, and `settings.json`'s `security.auth.selectedType` outranks every environment
variable — inverted relative to the other seven. `GEMINI_API_KEY` does authenticate a
headless box, so it satisfies the paste-a-value rule, but its row would be version-probe
only with auth status permanently unknown.

## Not established

- Which credential serves the request when Claude Code has both a subscription login and
  `ANTHROPIC_API_KEY`, interactively, before the one-time approval is answered.
- Grok's documented precedence. `README.md:105`, `docs/user-guide/02-authentication.md:54`
  and `README.md:1825` contradict each other; observed behaviour on 1.0.5 is that
  `XAI_API_KEY` wins.
- Why `prime-agent -p` returns HTTP 429 with no credentials configured.
- `~/.prime/config.json` and its `api_key` field are source-established only; the path is
  named nowhere on docs.primeintellect.ai, which has no `prime-agent` page at all.
- Exact `gemini --version` output and its stream — binary not installed.
- Whether Droid's `FACTORY_API_BASE_URL` / `FACTORY_API_ENDPOINT` / `FACTORY_RELAY_BASE_URL`
  binary strings are supported overrides. None is documented.
- opencode exit codes beyond the observed 0. `OPENCODE_MODEL` is not a real variable.
