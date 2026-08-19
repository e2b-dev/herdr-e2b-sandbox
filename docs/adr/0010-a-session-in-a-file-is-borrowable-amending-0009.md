# A session in a file is borrowable (amends ADR 0009)

**Amends:** [0009 — the plugin asks a harness, it never reads its credential store](0009-the-plugin-asks-a-harness-it-never-reads-its-credential-store.md)

ADR 0009 deferred subscription OAuth entirely and refused Codex OAuth inside a fleet.
Both of those clauses are overturned here. **Everything else in 0006 stands** — the
Keychain is still never opened, detection is still a spawn-the-binary probe, and reads
are still limited to environment variables and a harness's own documented config
location.

That last rule is the point. It already permits reading `~/.codex/auth.json`, and the
plugin already reads it — for the `OPENAI_API_KEY` field. The refusal was never about
*where* the credential lived; it was about the credential being OAuth. So the boundary
0006 actually drew is kept and the blanket deferral is dropped:

> A **session** stored in a file the plugin may already read is borrowable.
> A session stored in the OS credential store is not.

Codex qualifies. Claude does not, and its route stays `claude setup-token` — a
first-party one-year token the user pastes, never a Keychain read.

## Why the fleet refusal was wrong

0006 refused Codex OAuth in a fleet because OpenAI documents that `auth.json` must not
be shared "across concurrent jobs or multiple machines". That is true, and it protects
the **refresh token**, which is single-use: two holders that both rotate invalidate each
other. It says nothing about the access token, which is a fixed-expiry bearer that
rotates nothing.

Established on a live box (`iev2hkphfmxwyidw698ch`, 2026-08-19), against codex 0.148.0:

- The access token carries a **10-day** lifetime (`iat`→`exp`), not the hour a session
  token would imply.
- `refresh_token` is a **required struct field, not a required credential**. Omitting it
  fails at parse time — `missing field refresh_token` — before any network call. A
  placeholder satisfies the deserializer and is never read while the access token lives.
- With a placeholder refresh token and `OPENAI_API_KEY` unset in the box, `codex exec`
  ran and answered. `codex doctor` reported `stored auth mode: chatgpt`,
  `stored ChatGPT tokens: true`, `stored API key: false`.

So a borrowed copy holds a bearer that expires on a clock and rotates nothing. N boxes
race nothing, and they cannot invalidate the laptop's session. The concurrency rule is
satisfied by *not shipping the rotating half*, rather than by serialising a fleet — which
0006 correctly said would defeat the point of a fleet.

## What is written down

**The refresh token is replaced by an obvious placeholder, never copied.** It is the only
half that can revoke the user's own session, and nothing in a box needs it. The value
written must be visibly fake, so that whoever opens the file next cannot mistake it for a
live credential.

**Nothing in `auth.toml` is a credential.** Every file-sourced entry — a session and a
plain key alike — is recorded as a **pointer**: the variable to set, the path to read,
and which harness row owns the transform. The file is read when a box is created.

This reverses an earlier draft of this ADR, which copied the payload in and argued that
"copying is an existing mechanism where a pointer is a new one". That was true and it
was the wrong trade. Copying meant a live access token existed twice on disk, a
recorded expiry that disagreed with the file an hour later, and a generated file that
had to be guarded as tightly as the credentials it held. Pointing costs one injected
reader and removes all three:

- no second copy of a live credential exists anywhere;
- nothing can go stale, because there is no snapshot to age — the expiry is computed
  from the file at the moment it is used, so the report, the chooser's mark and the box
  itself cannot disagree;
- a credential the user rotates in the harness is picked up with no re-run;
- `auth.toml` stops being a secrets file: paths and variable names only.

What a pointer cannot survive is the user signing out or moving the file, which
resolves to no credential — correctly, since there is no longer one to borrow.

**The box receives it the way it receives everything else.** The payload — read from
the pointer moments earlier — arrives as an environment variable at `Sandbox.create`, and `src/fleet-seed.js` writes it into
`~/.codex/auth.json` inside the box. The seeded command carries the variable's **name**
and never its value, unchanged from today — so nothing secret enters a pane, the
scrollback, or herdr's session files.

## Precedence: a discovered session outranks a hand-written value

0009's ladder put everything discovered *below* both user tables, so a value written by
hand always won. A discovered session is the one exception, and it sits at the top:

```
shipped template defaults
  → discovered value (auth.toml env)
  → [sandbox.env]
  → [templates.<name>.env]
  → discovered SESSION          ← new, and above the user's own table
```

This is a real reversal of "a value you wrote by hand is never silently ignored", and it
will look like a bug to whoever reads it next. It is deliberate: the machine's live
session is the credential the user is actually working under, and being handed a
months-old pasted key instead — while signed in — is the surprise this feature exists to
remove.

The cost is that a typed value can now lose, so it must be able to win back explicitly.
A per-template `prefer = "env"` opts out and restores 0009's ordering for that template.
Silently losing is the failure mode; losing with a documented way to say otherwise is a
policy.

## The key a session replaces does not travel

When a session authenticates a box, the API key for that same harness is removed from
what the box is given — whichever rung supplied it, including the user's own
`[templates.<name>.env]`. The box cannot use both, and an unusable credential sitting
in a box's environment is blast radius bought for nothing: every process in there can
read it, and the box has network egress.

The session records the variable it replaces (`supersedes`) rather than the resolver
consulting the harness table, so precedence stays data-driven and `config.js` keeps
knowing nothing about harnesses.

Only when the session actually won. An expired session, or one opted out of with
`prefer = "env"`, suppresses nothing — that is exactly the case where the key is the
fallback, and removing it would turn a degraded box into an unauthenticated one.

This applies only to harnesses that HAVE a session. For amp, prime, grok and opencode
the key is the credential, and nothing here changes what they are sent.

## Consequences

A box can now hold a **subscription session** rather than a scoped API key, and the two
are not equivalent in blast radius. A session is the whole account for as long as it is
valid, it cannot be revoked individually — killing it means signing out everywhere — and
on a Team plan it belongs to the organisation rather than to the user who ran
`e2b-box auth`. A box has network egress. That trade is now the plugin's default where a
session is found, and it is the reason `prefer = "env"` exists.

`e2b-box auth` gains a source tag distinguishing a session from a key, because "authenticated"
now covers two things with different lifetimes and different consequences, and a report
that renders them identically is hiding the part that matters.

The other harnesses have since been surveyed, and the rule above decided all four
without needing to be bent:

| harness | where the credential lives | verdict |
|---|---|---|
| amp | `~/.local/share/amp/secrets.json`, plaintext | borrowable — a plain file, read as a value |
| prime | `~/.prime/config.json`, plaintext `api_key` | borrowable — a plain file, read as a value |
| droid | `~/.factory/auth.v2.file`, ciphertext, key file beside it | **out** |
| claude | macOS Keychain (`Claude Code-credentials`) | **out** |

Amp and prime needed nothing from this ADR — they are 0009's original "a value already
in a plaintext file the user owns", and only ever lacked a reader.

Droid and claude are the boundary doing its job. Droid's store is encrypted; the key
sits next to it, so it is decryptable, and decrypting it anyway would make this plugin
the owner of a format Factory can change without notice.

Claude's is the Keychain, and it earns a longer note because `stablyai/orca` reads
exactly that item and makes it work — reconstructing the scoped service name from
`sha256(CLAUDE_CONFIG_DIR).slice(0,8)` and owning the OAuth refresh itself. So the
question "why not do what orca does" has an answer beyond the rule, and the answer is
arithmetic. Measured on a live login (2026-08-19): the Keychain blob is
`{claudeAiOauth:{accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes,
subscriptionType, rateLimitTier}}`, and the access token had **4.3 hours** left against
codex's **10 days**. The codex trick — ship the bearer, placeholder the refresh — works
there precisely because ten days outlasts any box. Four hours does not: a box handed
that meets a sign-in screen mid-task, which is the failure this feature exists to
remove, merely postponed.

Making it useful would mean the box refreshing for itself, which means shipping the
real refresh token, which means two rotators and a laptop logged out of its own
session. Orca can hold that safely only because it runs claude locally and defers its
refresh while a PTY is live; a box is remote and unobservable, which is the one part of
0009's original reasoning that survives contact with the evidence.

So claude's route stays `claude setup-token` — a first-party long-lived token, pasted
like every other value this plugin accepts. Not a consolation prize: one year against
four hours. The report names that command rather than leaving "set ANTHROPIC_API_KEY"
to imply a key the user has to go and find.

A harness whose credential is only in a credential store stays out, permanently. That
half of 0006 is not up for revision, and the survey above did not need it to be.
