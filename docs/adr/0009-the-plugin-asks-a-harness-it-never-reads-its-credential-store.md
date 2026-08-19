# The plugin asks a harness, it never reads its credential store

**Amended by:** [0010 — a session in a file is borrowable](0010-a-session-in-a-file-is-borrowable-amending-0009.md)
— which overturns the deferral of subscription OAuth and the fleet refusal below. The
Keychain rule, the probe-don't-scrape rule, and the limits on what may be read all stand.

`e2b-box auth` finds out which harnesses are installed by spawning each binary and
asking it — a version or whoami probe — never by parsing a credential file, and never
by touching the macOS Keychain. Where it needs a value it reads environment variables
and the harness's own documented config location, read-only; anything ambiguous is put
to the user rather than guessed. The rule that draws the boundary: if a harness cannot
be authenticated by the user pasting or approving a value into `config.toml`, it stays
out of scope.

This will look like an omission to whoever reads it next, because the prior art proves
the omission is a choice. `stablyai/orca` drives the Keychain with the `security` CLI,
reconstructs Claude Code's config-dir-scoped service name from a sha256 prefix, owns the
Anthropic OAuth refresh itself against `platform.claude.com` with the public client id,
and greps Google's OAuth client secret out of the installed `gemini-cli` bundle. All of
that works. `pingdotgg/t3code` does the opposite and reads no credential at all on any
platform — it spawns the binary in a controlled config dir and asks the CLI who it is
logged in as. Both are catalogued in `docs/research/0001-local-harness-auth-discovery.md`.

t3code's pattern wins here because orca's is a credential subsystem and this plugin is
not in that business. A scrape breaks whenever a vendor moves a file or renames a
Keychain item, and it takes the blame for the breakage; a probe breaks only when the CLI
itself stops answering. The refresh problem decides it: Anthropic's refresh token is
single-use, so any component that reads and rotates it races the CLI that also rotates
it — orca has to suppress its own refresh while a live `claude` PTY is running to avoid
invalidating the session. This plugin would race a PTY *inside a remote box*, where it
cannot see the other rotator at all.

## Consequences

A discovered value is never copied into a file that did not already hold it. `e2b-box
auth` writes a generated `$CONFIG_DIR/auth.toml` (mode `0600`), merged *under*
`config.toml` so a hand-written value always wins — but only for a value it read out of
a file in the first place. A key found in the shell environment records the variable's
**name** and nothing else, and is forwarded from `e2b-box`'s own environment at create
time. A key exported from a keychain-backed shell profile is already stored better than
this plugin can store it; writing the value down would be a downgrade performed in the
name of convenience.

Subscription OAuth discovery is deferred, not designed. When it is picked up, two rules
are already fixed by this decision. Claude goes through `claude setup-token` — a
first-party one-year non-interactive token, which the user pastes like any other value —
and never through a Keychain read. Codex OAuth is refused inside a fleet rather than
serialized around: OpenAI documents copying `~/.codex/auth.json` to a remote host, but
also that the same file must not be shared "across concurrent jobs or multiple
machines", and a fleet is N concurrent boxes by construction. Serializing a fleet to
satisfy a credential would defeat the thing a fleet is for.

The cost is that a harness the user has only ever signed into interactively cannot be
auto-authenticated. `e2b-box auth` reports that as a finding and names the variable to
set, which is the same place the user was before the feature — no worse, and now told
why.
