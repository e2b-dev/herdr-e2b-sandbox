# How t3code and orca find local harnesses and read their credentials

Both projects were read from source at the commits below. t3code and orca solve
the same surface problem — "run the coding agents the user already installed" —
and land on opposite answers about credentials. **t3code never reads a harness
credential at all.** It resolves the binary, points the CLI at a config directory
with an environment variable, and asks the CLI who it is logged in as. **orca
reads, rewrites, and in two cases refreshes them.** It drives the macOS Keychain
through the `security` CLI, keeps per-account copies of `.credentials.json` and
`auth.json` under its own `userData`, owns the Anthropic OAuth refresh against the
public Claude Code client id, and extracts Google's OAuth client secret out of the
installed gemini-cli bundle. Neither project moves any harness credential to a
remote machine: both run the agent on the host where the login already lives, and
orca's SSH runtime carries only orca's own relay credential. Neither project
contains a single line — code, comment, or doc — about provider terms of service.

Sources: `pingdotgg/t3code` at `2aa5f095fc3bb65c00cc4efce66a5473e2d4554a`
(2026-08-19), `stablyai/orca` at `4fc8b65792e0fefb62f9adc799859c1889d2c851`
(2026-08-19). Both public, both cloned shallow and read directly. Every claim
below carries a `owner/repo path:LINE` citation; claims without one are marked as
inference.

## t3code

Five drivers, no more (`pingdotgg/t3code docs/internals/providers.md:10`): `codex`,
`claudeAgent`, `cursor`, `grok`, `opencode`. The README states the model plainly —
"Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and
OpenCode. If they're set up on your computer, T3 Code can control them"
(`pingdotgg/t3code README.md:5`).

| Harness | Detection | Credential path read | Format | Refresh | OAuth-only behaviour |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Spawn `claude --version` (`Layers/ClaudeProvider.ts:845`), then an in-process Claude Agent SDK probe (`Layers/ClaudeProvider.ts:759`) | none | none | delegated to the CLI/SDK | normal path; reports plan name from `account.subscriptionType` |
| Codex | Spawn `codex app-server`, call `account/read` (`Layers/CodexProvider.ts:388`) | none | none | delegated to `codex` | normal path; reports `ChatGPT Plus/Pro/Team/…` from `account.planType` (`Layers/CodexProvider.ts:81`) |
| Cursor | Spawn `agent about`, parse the text (`Layers/CursorProvider.ts:801`) | none | none | delegated to `cursor-agent` | normal path; "Cursor Agent is not authenticated. Run `agent login`" on failure (`Layers/CursorProvider.ts:839`) |
| Grok | Spawn `grok --version` (`Layers/GrokProvider.ts:149`) | none | none | delegated to `grok` | auth is never determined — every Grok snapshot is `auth: { status: "unknown" }` (`Layers/GrokProvider.ts:309`) |
| OpenCode | Spawn `opencode --version` (`Layers/OpenCodeProvider.ts:354`), then ask the server for its provider inventory | none | none | delegated to `opencode` | authenticated iff the server reports ≥1 connected upstream provider (`Layers/OpenCodeProvider.ts:432`) |

Missing from this repo's list: t3code has no amp, droid, Prime, or Gemini driver.
It adds Cursor, which orca also has.

### Detection is a version probe, not a PATH scan

There is no `which`. Each provider has a `binaryPath` setting defaulting to the
bare command name (`packages/contracts/src/settings.ts:316` for `codex`, `:370`
for `claude`, `:416` for `cursor-agent`, `:453` for `grok`, `:479` for
`opencode`), and detection is "spawn it and see". `spawnAndCollect`
(`apps/server/src/provider/providerSnapshot.ts:73`) runs the command and maps a
Windows command-not-found exit into `ProviderCommandNotFoundError`; a POSIX
`ENOENT` surfaces as `PlatformError.reason._tag === "NotFound"`
(`providerSnapshot.ts:68`). Probe budgets are 4 s for a version probe and 10 s
for an auth probe, "auth status checks involve disk/network lookups and can be
slow on first run" (`providerSnapshot.ts:21`).

Cursor, Grok, and OpenCode ship disabled: "Off by default (like Grok and
OpenCode): the binding is not yet stable enough to probe on every install. Users
opt in from Settings" (`packages/contracts/src/settings.ts:410`).

### The credential is never touched — deliberately, and the comment says why

The single most useful line in either repo for this question is in t3code's Claude
environment builder (`apps/server/src/provider/Drivers/ClaudeHome.ts:27`):

```
// Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
// Overriding HOME also relocates the macOS login keychain lookup
// ($HOME/Library/Keychains), so the spawned CLI can't find its stored
// OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
// Claude Code at its config dir directly while leaving HOME (and the
// keychain) intact.
```

Multi-account Claude is therefore several `CLAUDE_CONFIG_DIR` values, each logged
in separately by the user with `CLAUDE_CONFIG_DIR=… claude auth login`
(`docs/user/providers-claude.md:77`), and t3code refuses to continue an existing
thread on a provider with a different config dir because "Claude Code keeps
account and local state across multiple files under its config directory"
(`docs/user/providers-claude.md:101`).

Multi-account Codex is a *shadow home*: both providers share one `CODEX_HOME` for
sessions and history, and the second one gets a `shadowHomePath` whose only real
file is `auth.json`. `CodexHomeLayout.ts` symlinks the shared directories
(`sessions`, `archived_sessions`, `sqlite`, `worktrees`, …
`Drivers/CodexHomeLayout.ts:20`) into the shadow home while `PRIVATE_ENTRY_NAMES`
keeps `auth.json` and `models_cache.json` as real files
(`Drivers/CodexHomeLayout.ts:31`). `ensureShadowAuthIsPrivate`
(`Drivers/CodexHomeLayout.ts:295`) hard-fails if `auth.json` in the shadow home is
a symlink. t3code creates the symlinks, but never opens `auth.json`.

Grok is the one place t3code looks at an auth-shaped value, and only at an
environment variable it did not read from disk: if `XAI_API_KEY` is set in the
provider's environment the ACP session declares auth method `xai.api_key`,
otherwise `cached_token` (`apps/server/src/provider/acp/GrokAcpSupport.ts:48`).
It also stamps `GROK_OAUTH2_REFERRER=t3code` on the spawn
(`acp/GrokAcpSupport.ts:15`).

### The one exception: telemetry identity

t3code does open two harness files, for a hashed anonymous id and nothing else.
`getTelemetryIdentifierForHome` documents its own order
(`apps/server/src/telemetry/Identify.ts:248`): `~/.codex/auth.json`'s
`tokens.account_id`, then `~/.claude.json`'s `userID`, then a generated UUID in
`~/.t3/telemetry/anonymous-id`. The schema it decodes with is two fields wide
(`telemetry/Identify.ts:13`) — it cannot see a token even if one is in the file —
and the value is SHA-256'd before use (`telemetry/Identify.ts:150`).

### Credentials t3code does own

Only its own. Provider "Environment variables" marked sensitive are stored as
server secrets and not returned to the client
(`docs/user/providers-claude.md:131`), which is how the OpenRouter path works
(`ANTHROPIC_AUTH_TOKEN` set on the provider, `ANTHROPIC_API_KEY` blanked —
`docs/user/providers-claude.md:126`). The OpenCode server password is stored
unencrypted and the settings form says so: "Stored in plain text on disk"
(`packages/contracts/src/settings.ts:501`). t3code's own pairing/session tokens
use an OAuth-shaped token-exchange model documented in
`docs/internals/environment-auth.md`, and on the desktop the connection catalog is
encrypted with Electron `safeStorage`
(`apps/desktop/src/app/DesktopConnectionCatalogStore.ts:401`) — that is the only
Keychain-adjacent code in the repo, and it holds t3code data, not harness data.

### Remote

t3code's three remote modes — desktop backend on all interfaces, headless `t3
serve`, and desktop-managed SSH launch (`docs/user/remote-access.md:38`) — all
move *control*, never credentials. SSH launch writes a launcher script under
`~/.t3/ssh-launch/<host-key>/` on the remote, starts a T3 server there, and
forwards the loopback port back (`docs/user/remote-access.md:141`). The remote
server uses whatever logins that machine already has. Nothing in
`apps/`, `packages/`, or `docs/` reads `~/.claude/.credentials.json` or the
`Claude Code-credentials` Keychain item (verified by grep across the repo; the
only `.credentials.json` hits are in a vendored AWS SSO provider under
`.repos/alchemy-effect/`).

## orca

orca launches 35 agents, enumerated in `stablyai/orca src/shared/tui-agent-config.ts:53`.
Credential handling exists for a much smaller set. The table covers the harnesses
this repo cares about plus the ones orca reads credentials for.

| Harness | Detection | Credential path read | Format | Refresh | OAuth-only behaviour |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `detectCmd: 'claude'` resolved on PATH (`shared/tui-agent-config.ts:55`) | macOS: Keychain `Claude Code-credentials` and `Claude Code-credentials-<sha8>` (`main/claude-accounts/keychain.ts:4`, `:91`). All platforms: `$CLAUDE_CONFIG_DIR/.credentials.json`, default `~/.claude/.credentials.json` (`main/claude-accounts/runtime-paths.ts:21`). Identity from `.claude.json`'s `oauthAccount` (`main/claude-accounts/runtime-auth-service.ts:1585`) | JSON `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes } }` (`main/claude-accounts/oauth-refresh.ts:17`) | **orca refreshes it itself** against `https://platform.claude.com/v1/oauth/token` with client id `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (`main/claude-accounts/oauth-refresh.ts:9`) | normal and expected path; the whole account-switcher is built for it |
| Codex | `detectCmd: 'codex'` (`shared/tui-agent-config.ts:86`) | `$CODEX_HOME/auth.json`, default `~/.codex/auth.json` (`main/rate-limits/codex-auth-presence.ts:63`, `main/codex-accounts/service.ts:1051`) | JSON, either `{ OPENAI_API_KEY: "…" }` or `{ tokens: { access_token, id_token, refresh_token } }` (`main/codex-accounts/managed-codex-auth-readiness.ts:181`) | delegated to `codex`; orca reads the refreshed file back (`main/codex-accounts/runtime-home-service.ts:1778`) | normal path; identity comes from the `id_token` JWT claims (`main/codex-accounts/codex-auth-identity.ts:164`) |
| Grok | `detectCmd: 'grok'` (`shared/tui-agent-config.ts:317`) | `$GROK_HOME/auth.json` (`main/rate-limits/grok-auth.ts:10`) | JSON keyed by issuer; preferred key `https://auth.x.ai`, entry has `key` (the bearer), `user_id`, `email`, `team_id`, `expires_at` (`main/rate-limits/grok-auth.ts:23`) | none — expiry is only compared against a 5-minute skew (`main/rate-limits/grok-auth.ts:135`) | read-only; a token-less file after `grok logout` reports `missing`, not an error (`main/rate-limits/grok-auth.ts:122`) |
| Gemini | `detectCmd: 'gemini'` (`shared/tui-agent-config.ts:166`); separately `which gemini` with hard-coded prefix fallbacks (`main/rate-limits/gemini-cli-oauth-extractor.ts:22`) | `~/.gemini/oauth_creds.json` (`main/rate-limits/gemini-oauth-sources.ts:8`), plus opencode's `auth.json` `google` entry (`gemini-oauth-sources.ts:31`) | `{ access_token, refresh_token, expiry_date }` (`gemini-oauth-sources.ts:12`) | **orca refreshes it itself** against `https://oauth2.googleapis.com/token`, using a client id/secret scraped out of the installed gemini-cli bundle (`gemini-oauth-sources.ts:92`, `gemini-cli-oauth-extractor.ts:63`) | read + rewrite; `saveGeminiCredentials` writes the rotated blob back to `~/.gemini/oauth_creds.json` (`gemini-oauth-sources.ts:80`) |
| OpenCode | `detectCmd: 'opencode'` (`shared/tui-agent-config.ts:121`) | `auth.json` under `$APPDATA`, `$XDG_DATA_HOME`, `~/.local/share/opencode/`, or `~/Library/Application Support/opencode/` (`gemini-oauth-sources.ts:31`) — read only for its `google` entry | JSON | n/a | opencode's own logins are never read; the opencode.ai *usage* fetcher needs a session cookie the user pastes from DevTools (`main/rate-limits/opencode-go-usage-fetcher.ts:118`) |
| Kimi | `detectCmd: 'kimi'` (`shared/tui-agent-config.ts:267`) | `<kimi home>/credentials/kimi-code.json` (`main/rate-limits/kimi-fetcher.ts:30`) | `{ access_token, … }` | **explicitly refused** — "Orca must NEVER refresh or rewrite that file" (`main/rate-limits/kimi-fetcher.ts:299`) | read-only |
| MiniMax | — | none | user-pasted `Cookie` header containing `_token` (`main/rate-limits/minimax-fetcher.ts:226`) | n/a | prompts the user for the cookie |
| amp | `detectCmd: 'amp'` (`shared/tui-agent-config.ts:190`) | none | — | — | orca only installs a status hook (`main/amp/hook-service.ts`) |
| droid (Factory) | `detectCmd: 'droid'` (`shared/tui-agent-config.ts:258`) | none — `~/.factory` is touched only for hook config (`main/droid/hook-service.ts:60`) | — | — | none |
| Prime | `detectCmd: 'prime-agent'` (`shared/tui-agent-config.ts:154`) | none — `.prime` appears only in the session scanner (`main/ai-vault/session-scanner-values.ts:165`) | — | — | none |
| Cursor / Copilot / Devin / Pi / Hermes / Antigravity / the rest | `detectCmd` per entry in `shared/tui-agent-config.ts` | none | — | — | none |

Harnesses orca supports that this repo's list misses: Cursor, Copilot, Devin, Pi,
OMP, Kimi, MiniMax, Mimo, Antigravity, Hermes, Aider, Goose, Crush, Cline, Kilo,
Kiro, Rovo, Trae, Qwen Code, Mistral Vibe, OpenClaw, OpenClaude, Autohand, Ante,
Codebuff, Continue, Augment, `claude-agent-teams`. Not one of them has credential
handling; they are `detectCmd` + `launchCmd` + prompt-injection mode and nothing
else.

### Detection is PATH resolution in-process, plus a bounded install-dir sweep

`detectInstalledAgents` (`src/main/ipc/preflight.ts:91`) probes every `detectCmd`
in `TUI_AGENT_CONFIG` at once. `isCommandOnPath` resolves against `PATH` with
`fs`, not a subprocess, and the comment explains the choice
(`src/main/ipc/preflight-command-exec.ts:85`):

```
// Why (#9297): resolve against PATH with fs instead of spawning one
// where/which subprocess per probe — privilege-management software gates
// each spawn and stalls startup.
```

Anything missed is retried against a fixed list of user install directories —
`~/.volta/bin`, `~/.fnm/aliases/default/bin`, `~/.local/share/mise/shims`,
`~/.local/bin`, `~/Library/pnpm`, `~/.yarn/bin`, `~/.bun/bin`, and the Windows
`AppData` equivalents (`src/shared/node-cli-command-resolution.ts:89`) — because
"detection may precede shell-PATH hydration"
(`src/shared/local-agent-install-dir-detection.ts:4`). The result is cached once
per app session (`src/main/ipc/preflight.ts:62`). No version probe is run for
detection. A few entries add conditions: `claude-agent-teams` requires `claude`
too and is unsupported on Windows and WSL
(`src/shared/tui-agent-config.ts:67`), and `trae` detects on `traecli` because the
unrelated bytedance CLI also installs `trae-cli`
(`src/shared/tui-agent-config.ts:107`).

Codex has a second, cheaper "is this signed in" probe: the existence of
`auth.json`. The comment gives the reason
(`src/main/rate-limits/codex-auth-presence.ts:51`):

```
// Why: the background quota poller spawns the real `codex` binary to read rate
// limits. For users who installed Codex but never signed in, that spawn can
// only fail — and worse, surfaces as an unexpected Codex process starting in
// the background. A signed-in Codex always writes an auth.json under its
// CODEX_HOME, so gating the fetch on that file keeps the poller silent until
// the user actually uses Codex.
```

### The Claude account switcher

This is the deep end. `ClaudeRuntimeAuthService`
(`src/main/claude-accounts/runtime-auth-service.ts:96`) keeps N logins on one
machine by physically swapping the *one* set of credentials Claude Code reads.

Per-account storage is `<userData>/claude-accounts/<accountId>/auth/`
(`src/main/claude-accounts/managed-auth-path.ts:8`) holding `.credentials.json`
and `oauth-account.json`, written `0600` and atomically
(`managed-auth-path.ts:74`), guarded by a `.orca-managed-claude-auth` marker file
containing the account id so orca will not read or overwrite a directory it does
not own (`managed-auth-path.ts:6`, `:86`). On macOS a second copy lives in the
Keychain under service `Orca Claude Code Managed Credentials`, account =
account id (`src/main/claude-accounts/keychain.ts:5`, `:70`).

On launch, `prepareForClaudeLaunch` (`runtime-auth-service.ts:113`) materialises
the selected account into the live locations:

- `writeRuntimeCredentials` writes `$CLAUDE_CONFIG_DIR/.credentials.json`, mode
  `0600`, atomically, skipping unchanged rewrites to dodge Windows `EPERM`
  contention (`runtime-auth-service.ts:1732`).
- On macOS, `writeActiveClaudeKeychainCredentialsForRuntime` writes *both* the
  config-dir-scoped Keychain item and the legacy unsuffixed one — "Claude Code
  2.1+ reads the scoped service, older builds the legacy unsuffixed one; runtime
  switching must satisfy both" (`runtime-auth-service.ts:424`). If the Keychain
  write throws, orca restores the previous snapshot and rethrows
  (`runtime-auth-service.ts:427`).
- `writeRuntimeOauthAccount` rewrites the `oauthAccount` key inside `~/.claude.json`
  (`runtime-auth-service.ts:1576`).

The scoped Keychain service name is reconstructed, not discovered
(`src/main/claude-accounts/keychain.ts:89`):

```
// Why: Claude Code 2.1+ scopes macOS Keychain credentials by config dir
// using the first 8 hex chars of sha256(CLAUDE_CONFIG_DIR).
const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
return `${ACTIVE_CLAUDE_SERVICE}-${suffix}`
```

Because the CLI also rotates tokens, orca runs a *read-back* pass before every
overwrite: it reads the scoped Keychain item, the legacy item, and the file,
discards candidates identical to its own last write, requires a positive identity
match against a managed account, and only adopts a candidate whose expiry or
rotated refresh token proves it is newer (`runtime-auth-service.ts:457`,
`:489`). An ambiguous candidate is refused outright — "Refusing ambiguous Claude
auth read-back" (`runtime-auth-service.ts:531`). When a live `claude` PTY is
running, orca defers its own refresh entirely, because a double rotation would
invalidate the copy the live session holds (`runtime-auth-service.ts:406`).

Adding an account runs the real CLI rather than doing OAuth itself: `claude auth
login --claudeai` into a temp `CLAUDE_CONFIG_DIR`, then `claude auth status
--json`, then capture, then delete the temp Keychain item and restore whatever
legacy item was there before (`src/main/claude-accounts/service.ts:601`, `:622`,
`:629`). The CLI path (`orca account add`) can also adopt a directory the user
already logged into, and on non-macOS it requires `.credentials.json` to be
present first (`src/main/claude-accounts/service.ts:221`).

The one thing orca does *not* delegate is refresh. `oauth-refresh.ts:4` states
the reasoning:

```
// Why: the OAuth client id and token endpoint are the public Claude Code
// values, verified against the installed `claude` binary (2.1.177) and the
// claude-swap reference tool. Orca owns the refresh so a single-use refresh
// token is rotated and persisted atomically, instead of being scraped back
// after the CLI rotates it (the lossy path that strands stale tokens).
```

It uses the same 5-minute expiry skew as the CLI (`oauth-refresh.ts:12`), keeps
the existing refresh token when the server does not rotate one
(`oauth-refresh.ts:103`), and returns `null` on any failure so the caller keeps
the old credentials (`oauth-refresh.ts:120`).

Environment hygiene is explicit: `CLAUDE_AUTH_ENV_VARS` lists
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`AWS_BEARER_TOKEN_BEDROCK` (`src/main/claude-accounts/environment.ts:1`), and
`applyClaudeEnvPatch` can strip all four plus any auth-looking
`ANTHROPIC_CUSTOM_HEADERS` before launch (`environment.ts:18`, `:47`) so an
ambient key cannot silently override the selected account.

### The Codex account switcher

Same shape, different mechanics. Each managed account gets a self-contained
`CODEX_HOME` under `<userData>/codex-accounts/`
(`src/main/codex-accounts/runtime-home-service.ts:1464`), and orca injects
`CODEX_HOME` into the PTY environment rather than editing `~/.codex`
(`runtime-home-service.ts:237`, called from `src/main/index.ts:1099`). Even with
no managed account selected, orca runs Codex against its own runtime home seeded
from the system default — "unmanaged sessions use an Orca-owned CODEX_HOME; seed
it once from system-default auth so terminals stay logged in without mutating
~/.codex" (`runtime-home-service.ts:889`). Because `codex` rotates its own
tokens inside that home, orca copies the refreshed `auth.json` back to `~/.codex`
(`runtime-home-service.ts:1778`). It never calls an OpenAI token endpoint; grep
for `grant_type` across the whole repo returns exactly two hits, Anthropic and
Google (`main/claude-accounts/oauth-refresh.ts:146`,
`main/rate-limits/gemini-oauth-sources.ts:104`).

### Where the credentials get used

For usage/rate-limit panels, orca calls provider APIs directly with the harness's
own token. The Claude fetcher hits `https://api.anthropic.com/api/oauth/usage`
(`src/main/rate-limits/claude-fetcher.ts:46`) with `Authorization: Bearer
<token>`, `anthropic-beta: oauth-2025-04-20`, and a spoofed CLI user agent —
"match the Claude Code CLI user-agent to stay aligned with the OAuth usage API
contract" (`claude-fetcher.ts:359`, constant at `:48`). Its credential search
order is scoped Keychain, legacy Keychain, then `.credentials.json`, and it
deliberately skips `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` because "those
are API keys that 401 on the OAuth usage endpoint" (`claude-fetcher.ts:205`).
When no token can be read, the fallback is not a prompt: orca spawns an
interactive `claude` in a hidden PTY, sends `/usage`, and screen-scrapes the TUI
(`src/main/rate-limits/claude-pty.ts:20`).

Gemini goes further and reconstructs the client credentials it needs: `which
gemini` (falling back to `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`,
`~/bin` — `gemini-cli-oauth-extractor.ts:36`), `realpath` the symlink, then
regex the installed package for `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`
(`gemini-cli-oauth-extractor.ts:63`), scanning the hash-named bundle chunks when
newer versions ship no `oauth2.js` (`gemini-cli-oauth-extractor.ts:143`).

### Remote

No harness credential leaves the host. Grep for `.credentials.json` or `auth.json`
across `src/main/ssh`, `src/main/runtime`, and `src/relay` returns nothing. The
Claude account selection target is `'host' | 'wsl'` and nothing else
(`src/main/claude-accounts/runtime-selection.ts:8`). The only credential the SSH
PTY environment carries is orca's own: `ORCA_RELAY_CREDENTIAL_FILE`
(`src/main/providers/ssh-pty-spawn-env.ts:26`).

Note for anyone grepping this repo: `src/main/ai-vault/` is a session-history
browser, not a credential store. Every file in it parses transcripts.

## Cross-cutting answers

**macOS Keychain.** Only orca. It shells out to `/usr/bin/security` via
`execFile` with a 3-second timeout, using `find-generic-password -s <service> -a
<user> -w` to read, `add-generic-password -U` to write, and
`delete-generic-password` to delete (`src/main/claude-accounts/keychain.ts:107`,
`:135`, `:146`). Account is `$USER || $USERNAME || 'user'`
(`keychain.ts:81`). Exit code 44 or a "could not be found" message is treated as
absent rather than an error (`keychain.ts:166`). All three functions no-op off
darwin (`keychain.ts:103`). No native binding, no keytar. t3code touches the
Keychain only through Electron `safeStorage` and only for its own data
(`apps/desktop/src/app/DesktopConnectionCatalogStore.ts:401`), and its Claude
driver goes out of its way to leave the harness Keychain lookup working
(`Drivers/ClaudeHome.ts:27`).

**Writing to the harness's own config.** t3code writes only symlinks, and only
inside a shadow `CODEX_HOME` the user configured
(`Drivers/CodexHomeLayout.ts:214`); it never writes a credential file. orca
writes plenty: `$CLAUDE_CONFIG_DIR/.credentials.json`
(`runtime-auth-service.ts:1748`), the `oauthAccount` key in `~/.claude.json`
(`runtime-auth-service.ts:1587`), both macOS Keychain items
(`runtime-auth-service.ts:424`), `~/.codex/auth.json` on read-back
(`runtime-home-service.ts:1778`), and `~/.gemini/oauth_creds.json` after a
refresh (`gemini-oauth-sources.ts:80`). It refuses to write Kimi's
(`kimi-fetcher.ts:299`).

**ToS / provider policy.** Neither project says anything. A grep for "terms of
service", "usage policy", "acceptable use", and "ToS" across both repos' source,
docs, and comments returns no hit that is about provider policy — t3code's only
match is a link to its own marketing-site terms page
(`apps/mobile/src/features/settings/lib/legal-document-url.ts:27`). There is no
warning, no docs note, no refusal, and no code comment about entitlement anywhere
in orca's credential machinery, including the file that spoofs the Claude Code
user agent and the one that extracts Google's OAuth client secret. The comments
in those files justify the mechanics; none raises the question of whether the
mechanics are permitted.

**Once at setup, or live.** Both are live. t3code re-probes on a schedule through
`providerStatusCache` / `providerMaintenance` and again on demand, and holds no
credential to go stale. orca re-reads on every launch —
`prepareForClaudeLaunch` calls `syncForCurrentSelection` before returning the
environment (`runtime-auth-service.ts:113`), and `prepareForCodexLaunch` runs on
each PTY spawn (`src/main/index.ts:1099`). Rate-limit fetches re-read the
credential each poll through `prepareForRateLimitFetch`
(`runtime-auth-service.ts:121`). The only caching is `lastWrittenCredentialsJson`
as a *comparison baseline* to detect that the CLI rotated the token behind orca's
back (`runtime-auth-service.ts:100`) — not a value that gets reused.

## Provider policy

This section reports what the vendors publish. It is a factual finding, not a
recommendation.

### Anthropic

**Consumer Terms of Service** (<https://www.anthropic.com/legal/consumer-terms>,
effective 2025-10-08). The copy served is the EEA/Switzerland version
(contracting entity Anthropic Ireland, Limited); a US-resident variant was not
retrievable at that URL and has not been verified. Under "2. Account creation
and access → Your Anthropic Account":

> You may not share your Account login information, Anthropic API key, or Account
> credentials with anyone else or make your Account available to anyone else.

Under "3. Use of our Services", in the prohibited-use list:

> Except when you are accessing our Services via an Anthropic API Key or where we
> otherwise explicitly permit it, to access the Services through automated or
> non-human means, whether through a bot, script, or otherwise.

Both clauses are person-shaped. Neither says anything about the subscriber moving
their own credential to a second machine they control. The automated-access bar
carries an explicit carve-out for what Anthropic "otherwise explicitly permit[s]",
which makes the Claude Code docs below load-bearing.

**Usage Policy** (<https://www.anthropic.com/legal/aup>, effective 2025-09-15) is
silent on credential sharing, account portability, remote machines, CI, and
automation. Its nearest clauses are anti-abuse ("Coordinate malicious activity
across multiple accounts to avoid detection", "Circumvent a ban through the use of
a different account").

**Commercial Terms** (<https://www.anthropic.com/legal/commercial-terms>,
effective 2025-06-17) govern API keys, not consumer plans, by their own preamble:
"Services under these Terms are not for consumer use. Our consumer offerings
(e.g., Claude.ai) are governed by our Consumer Terms of Service instead." D.5
("Service Account") contains no credential-sharing prohibition.

**Claude Code — Legal and compliance**
(<https://code.claude.com/docs/en/legal-and-compliance>, no published
effective date, retrieved 2026-08-19) is the most on-point Anthropic page. Under
"Authentication and credential use":

> OAuth authentication is intended exclusively for purchasers of Claude Free,
> Pro, Max, Team, and Enterprise subscription plans and is designed to support
> ordinary use of Claude Code and other native Anthropic applications. […]
> Anthropic does not permit third-party developers to offer Claude.ai login or to
> route requests through Free, Pro, or Max plan credentials on behalf of their
> users.

And under "Acceptable use": "Advertised usage limits for Pro and Max plans assume
ordinary, individual usage of Claude Code and the Agent SDK." The line drawn is
*who the credential serves*, not *where it runs*. The words "machine", "device",
"remote", "sandbox", and "CI" do not appear on the page, and "ordinary, individual
usage" is not defined.

**Claude Code — Authentication**
(<https://code.claude.com/docs/en/authentication>) documents the
opposite of a prohibition on automation:

> For CI pipelines, scripts, or other environments where interactive browser
> login isn't available, generate a one-year OAuth token with `claude setup-token`
> […] This token authenticates with your Claude subscription and requires a Pro,
> Max, Team, or Enterprise plan.

**Claude Code — GitHub Actions**
(<https://code.claude.com/docs/en/github-actions>): the quick-setup
flow "saves the credential as a repository secret, named `ANTHROPIC_API_KEY` for
an API key or `CLAUDE_CODE_OAUTH_TOKEN` for a subscription token", and "Quick
setup works with the Claude API and Claude subscriptions."

**Claude Code — Devcontainers**
(<https://code.claude.com/docs/en/devcontainer>) instructs storing "a
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` as a Codespaces secret", and
mounting a named volume at `~/.claude` with `CLAUDE_CONFIG_DIR` pointed at it so
the credential survives rebuilds. Its stated hazard is exfiltration, not
entitlement: "dev containers do not prevent a malicious project from exfiltrating
anything accessible inside the container, including the Claude Code credentials
stored in `~/.claude`."

**Claude Code — Sandbox environments**
(<https://code.claude.com/docs/en/sandbox-environments>): "Several
managed sandbox and remote execution services can host the container for you. The
same checklist applies as for any container you operate: review what is mounted
writable, what credentials and tokens are reachable inside it, and what the
network egress policy allows." It notes OAuth sign-in and token refresh need
`claude.ai` and `platform.claude.com` reachable, and that "Runs authenticated with
an API key can drop these two." It is framed as a security checklist and takes no
position on entitlement.

**Claude Code — IAM** (<https://code.claude.com/docs/en/iam>) confirms
the storage locations orca targets: "On macOS, credentials are stored in the
encrypted macOS Keychain. On Linux, credentials are stored in
`~/.claude/.credentials.json` with file mode `0600`." Nothing on that page says
the credential is machine-bound or that copying it is prohibited.

**Help centre.** "Use Claude Code with your Pro or Max plan" (updated 2026-06-11)
is silent on account sharing, second machines, remote/cloud use, CI, and
automation. "Use the Claude Agent SDK with your Claude plan" carries a rollback
banner ("Update June 15: We're pausing the changes […] For now, nothing has
changed") and, in the paused body, frames sharing as person-to-person ("Credits
belong to individual accounts. They can't be shared or pooled across teammates")
and steers scale to the API: "The Agent SDK monthly credit is sized for individual
experimentation and automation. Teams running shared production automation should
use Claude Platform with an API key." That is a "should", not a prohibition, and
the scheme is currently paused.

### OpenAI

**Terms of Use** (<https://openai.com/policies/terms-of-use/>, effective
2026-01-01), "Registration and access → Registration":

> You may not share your account credentials or make your account available to
> anyone else and are responsible for all activities that occur under your
> account.

The "What you cannot do" list has no general automated-access bar. The nearest
bullet is "Automatically or programmatically extract data or Output", which is a
scraping clause. There is no "only through interfaces we provide" clause in either
the US text or the Europe text
(<https://openai.com/policies/eu-terms-of-use/>, updated 2026-01-16), whose
registration clause is word-for-word identical.

**Usage Policies** (<https://openai.com/policies/usage-policies/>, effective
2025-10-29) is a harm taxonomy and is silent on credentials, portability, remote
machines, CI, and automation.

**Codex — Authentication** (<https://learn.chatgpt.com/docs/auth>, retrieved
2026-08-19) is the single most directly relevant first-party statement either
vendor publishes. Under "Login on headless devices → Fallback: Authenticate
locally and copy your auth cache":

> If you can complete the login flow on a machine with a browser, you can copy
> your cached credentials to the headless machine.
> 1. On a machine where you can use the browser-based login flow, run `codex login`.
> 2. Confirm the login cache exists at `~/.codex/auth.json`.
> 3. Copy `~/.codex/auth.json` to `~/.codex/auth.json` on the headless machine.

Literal `scp` and `docker cp` commands follow. The stated hazard is secret
handling: "Treat `~/.codex/auth.json` like a password: it contains access tokens.
Don't commit it, paste it into tickets, or share it in chat." A separate callout
under "Sign in with an API key" says "Use API key authentication for programmatic
Codex CLI workflows, such as CI/CD jobs. Don't expose Codex execution in untrusted
or public environments." The predecessor of this page in the `openai/codex` repo
(`docs/authentication.md`, removed in commit `ab753387cc`, 2026-01-02) said it
more bluntly: "Because the `auth.json` file is not tied to a specific host, once
you complete the authentication flow locally, you can copy the
`$CODEX_HOME/auth.json` file to the headless machine and then `codex` should
'just work' on that machine." That sentence does not survive verbatim into the
current page; the procedure does.

**Codex — Maintain Codex account auth in CI/CD**
(<https://learn.chatgpt.com/docs/auth/ci-cd-auth>) publishes a supported
subscription-in-automation workflow while preferring API keys: "The right way to
authenticate automation is with an API key. Use this guide only if you
specifically need to run the workflow as your Codex account." Its hard
operational constraint is concurrency, not location:

> * Use one `auth.json` per runner or per serialized workflow stream.
> * Do not share the same file across concurrent jobs or multiple machines.

### Where the terms are silent

- Whether a subscriber may run their own credential on a second machine they
  control. Both vendors' sharing clauses are worded against persons ("anyone
  else"), never against hosts or devices. Neither addresses this.
- Whether an ephemeral cloud sandbox counts as "your machine". Silent, both
  vendors. Anthropic's sandbox-environments page acknowledges managed sandbox
  services exist but assigns them no entitlement status.
- Any device-count or concurrent-session cap on Claude Pro/Max. Silent.
- Any definition of Anthropic's operative phrase "ordinary, individual usage". No
  examples, thresholds, or boundary cases.
- Whether Anthropic's consumer-terms automated-access bar is intended to reach
  Claude Code itself. The clause carves out what Anthropic "explicitly permit[s]",
  and Anthropic ships `claude setup-token` for CI, but no document connects the
  two.
- Whether a US-resident Anthropic consumer agreement differs from the
  EEA/Switzerland text retrieved.
- Whether OpenAI's "Don't expose Codex execution in untrusted or public
  environments" classifies a private single-tenant cloud sandbox as trusted.
- Any statement from either vendor that CI or automation *requires* an API key.
  Both express a preference; neither states a requirement, and both ship a
  first-party subscription path into automation.

## Open questions / not found

- **Whether orca's Claude OAuth client id is still current.** The code says it was
  "verified against the installed `claude` binary (2.1.177) and the claude-swap
  reference tool" (`oauth-refresh.ts:4`). That was not independently checked
  against a live Claude Code install, and the pinned user agent
  `claude-code/2.1.0` (`claude-fetcher.ts:48`) is already behind that.
- **Whether either project has ever handled a "no API key, only OAuth, and the
  user refuses" case.** The question does not arise: t3code never reads a
  credential, and orca treats subscription OAuth as the default. Neither has a
  refuse-or-prompt branch to describe. The only prompt-for-a-credential paths in
  orca are for MiniMax and opencode.ai session cookies, which are not harness
  logins.
- **Whether orca's Keychain reads trigger a macOS authorization prompt.** The code
  handles a 3-second timeout and treats "could not be found" as absent
  (`keychain.ts:166`) but has no branch for a user-denied Keychain access dialog.
  Whether the codesigned app is in the ACL of items written by the `claude` binary
  was not determined; that needs a runtime test, not a read.
- **Git history was not consulted.** Both clones are `--depth 1`, so no claim here
  is about when a behaviour was introduced or what preceded it.
- **orca's published docs site** (`onorca.dev/docs`) was not read; the doc
  directories in the repo (`docs/readme/`, `docs/reference/`) carry no credential
  material. If a user-facing warning about credential handling exists, it would be
  on the site rather than in the tree — unverified either way.
- **Amp, droid, and Prime credential formats were not established**, because
  neither project reads them. `~/.factory` and `.prime` appear in orca only for
  hook config and session scanning. Anyone extending this repo to those harnesses
  gets no prior art from either project.
- **No claim is made about how much of orca's machinery is load-bearing in
  practice.** The read-back, live-PTY deferral, and ambiguity-refusal logic is
  extensive enough that it clearly exists to fix real corruption, but the failure
  modes it guards against were inferred from its comments, not reproduced.
