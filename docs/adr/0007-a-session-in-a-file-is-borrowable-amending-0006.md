# A session in a file is borrowable (amends ADR-0006)

**Amends:** [0006 — the plugin asks a harness, it never reads its credential store](0006-the-plugin-asks-a-harness-it-never-reads-its-credential-store.md)

ADR 0006 deferred subscription OAuth entirely and refused Codex OAuth inside a fleet.
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

**A discovered session is copied into `auth.toml`** as a third entry kind beside `env`
(a value) and `forward` (a name), following 0006's existing rule that a value already
sitting in a plaintext file the user owns may be written to another file the user owns.

This one has a cost 0006's other entries do not, and it is accepted deliberately rather
than overlooked: **a stored session expires.** A copy taken today is dead in ten days,
and a box created after that boots to a sign-in screen with nothing saying why. So the
expiry is recorded alongside the payload, and every surface that reports a discovered
credential — the `auth` report, the template chooser's mark, the fleet's
unauthenticated-member warning — reports an expired session as expired, naming
`e2b-box auth` as the refresh. An expiring credential that reports itself is a chore; one
that does not is a bug filed against the box.

The alternative — recording a pointer and re-reading the file at create time, so the
payload is always fresh and never duplicated — was considered and rejected: it is a new
mechanism where copying is an existing one.

**The box receives it the way it receives everything else.** The payload arrives as an
environment variable at `Sandbox.create`, and `src/fleet-seed.js` writes it into
`~/.codex/auth.json` inside the box. The seeded command carries the variable's **name**
and never its value, unchanged from today — so nothing secret enters a pane, the
scrollback, or herdr's session files.

## Precedence: a discovered session outranks a hand-written value

0006's ladder put everything discovered *below* both user tables, so a value written by
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
A per-template `prefer = "env"` opts out and restores 0006's ordering for that template.
Silently losing is the failure mode; losing with a documented way to say otherwise is a
policy.

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

Harnesses beyond codex are unassessed. Amp, droid and prime store credentials in
locations this ADR has not surveyed; each is a separate finding, and the rule above
decides them one at a time. A harness whose session is only in a credential store stays
out, permanently — that half of 0006 is not up for revision.
