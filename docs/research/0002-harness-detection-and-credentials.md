# Harness detection and credentials

Source material for `src/harnesses.js`. Established 2026-08-19 against vendor docs,
vendor source, and live binaries on one macOS 25.5.0 machine. Scoped by
[ADR 0009](../adr/0009-the-plugin-asks-a-harness-it-never-reads-its-credential-store.md):
detection is a spawn-the-binary probe, reads are limited to environment variables and a
harness's own documented config location, and no OAuth store or Keychain item is opened.

Versions probed: `claude` 2.1.235, `codex-cli` 0.147.0, `grok` 1.0.5, `opencode` 1.18.18,
`amp` 0.0.1787045288, `droid` 0.199.0, `prime-agent` 0.7.0 (`prime` 0.6.21). `gemini` was
not installed; its rows come from source and docs only. `muse` 1.0.2 was added 2026-09-04
(the `muse` template shipped 0.2.1 the same day; both accept the flags used here).

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
| muse | `muse --version` | `muse exec --no-session-log --max-model-steps 1 --base-url http://127.0.0.1:9 …`, on **stderr** | no, 1 either way | `META_API_KEY` | same | none — `~/.config/muse/auth.json` is a pointer; the token is in the Keychain on macOS |

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

## Muse Code

Meta's coding agent (`dev.meta.ai/docs/muse-code`). The `muse` on PATH is a bash
launcher that self-updates in the background and `exec`s `muse-bin-<version>` beside
it; it is not a shell function, so `shell: false` finds the same thing the user runs.

No status subcommand exists. `muse auth` accepts only `auth set --api-key-stdin`, and
`muse login` starts a device-code flow, so neither is a probe. `muse exec` resolves its
credential before it opens a model stream, which makes a headless run against a
loopback port with no listener an offline probe with two readable branches, both on
stderr and both exit 1:

- no credential: `missing meta credentials: run \`muse login\` or set META_API_KEY, or
  save credentials at <config>/muse/auth.json`, in about 0.1s, before any request
- a credential: four `retrying meta model stream` lines and then `agent loop failed:
  model failed: transport error: error sending request for url
  (http://127.0.0.1:9/responses) (after 4 provider attempts)`, in about two seconds

`--no-session-log` keeps the run off disk (verified: the sessions directory did not
grow), `--max-model-steps 1` bounds it, and no `--yolo` is passed, so the probe never
trusts the directory it runs in. The logged-out branch was produced with an empty
`XDG_CONFIG_HOME`, which the launcher and the binary both honour for the config path.

Credential storage is the finding that decides the row. `~/.config/muse/auth.json`
after a browser login reads

```json
{"schema_version": 2, "providers": {"meta": {"mechanism": "oauth", "obtained_via": "device_code",
  "api_base_url": "https://api.meta.ai/v1", "user_full_name": "…", "user_email": "…", "storage": "keychain"}}}
```

so on macOS the file is a pointer and the token itself is a Keychain item, which ADR
0009 does not open. That puts Muse in Claude Code's category, not codex's or grok's:
the browser login is reported as `signed in, but not a key this plugin can use` and is
never borrowed as a session. A key saved with `muse auth set` goes to the same store.
The launcher's own `read_credential` expects `access_token` and `expires_at` inline in
the same `providers.meta` object, which is what the file holds where there is no
Keychain (Linux); that schema was not seen on a real login here and is not read.

Precedence is documented (`docs/muse-code/auth`): `META_API_KEY`, then a stored key,
then the stored browser login. So the variable a box is handed is not a workaround for
the Keychain, it is the first thing Muse consults, and `muse logout` leaves it alone.

Unattended posture is documented too (`docs/muse-code/permissions`): `--yolo` disables
approval and Muse's OS sandbox and trusts the workspace for the run, recommended only
for "a disposable, isolated container", which an E2B box is. The interactive surface
takes the task positionally (`muse [OPTIONS] [PROMPT]`); `exec` takes the same flag.

## Platform differences

Three exist across all nine. Muse Code stores its login in the macOS Keychain and inline
in `~/.config/muse/auth.json` on Linux, and the file itself records which (`storage`). Claude Code stores credentials in the macOS Keychain and
in `~/.claude/.credentials.json` on Linux and Windows. Gemini's *system* settings live at
`/Library/Application Support/GeminiCli/settings.json` versus `/etc/gemini-cli/settings.json`.
Everything else is `$HOME`-relative and identical — note that amp, opencode and muse all use
XDG paths on macOS, not `~/Library/Application Support`.

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
- The Linux shape of Muse's `auth.json` (`access_token` inline, per the launcher's reader)
  on a real login, and whether an API key saved with `muse auth set` is ever written to the
  file rather than the Keychain. Neither is read until seen.
- Whether the box's Muse launcher, whose background self-update downloads with a bearer
  from `auth.json`, ever needs one: with no file the update is skipped or 401s in the
  background and the installed binary runs regardless (`main()` in the launcher).
