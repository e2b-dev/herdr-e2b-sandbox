# Grok's refresh token is multi-use, so its session ships whole (amends 0010)

**Amends:** [0010 — a session in a file is borrowable](0010-a-session-in-a-file-is-borrowable-amending-0009.md)

ADR 0010 surveyed grok as "the key is the credential". That was true when it was
written; grok has since grown a browser login (`grok login`) that stores an OIDC
session in `~/.grok/auth.json` — a plain file, mode 600, well inside 0009's read
boundary. This ADR admits it, and it takes the one step 0010 explicitly refused for
codex: **the refresh token travels with the session.**

## The measurements

0010's test is bearer lifetime versus box lifetime: codex's 10-day bearer passed,
claude's 4.3-hour Keychain token failed. Grok's bearer, decoded from a live login
(2026-08-26): **six hours** (`iat`→`exp`, confirmed by the file's own `expires_at`).
By 0010's arithmetic alone, grok is out — a box handed the bearer meets a sign-in
screen before the day ends, and `supersedes` would have evicted the `XAI_API_KEY`
that still worked.

What 0010 could not assume — and this ADR measured — is the refresh half. Against
`https://auth.x.ai/oauth2/token` (public client, `client_id` + `refresh_token` only,
2026-08-26, live account):

- refresh grant → **200**, fresh 6-hour bearer, a NEW refresh token in the response;
- the SAME old refresh token, used again → **200 again**;
- the laptop's session: unaffected, before and after.

xAI's refresh tokens are **multi-use**. They do not rotate-invalidate. Two holders
rotate nothing away from each other, so the "two rotators and a laptop logged out"
failure — the entire reason 0010's placeholder rule exists — cannot happen here.

## Decision

`readGrokSession` ships `~/.grok/auth.json` **verbatim**, real refresh token
included. The box re-mints its own six-hour bearers exactly as the laptop does, so a
grok box has no expiry wall at all — it outlasts even codex's ten days. The
placeholder rule is not weakened: it stays mandatory for codex, whose refresh half
IS single-use, and for any future harness until its rotation behaviour is measured.

Everything else follows 0010 unchanged: the entry in `auth.toml` is a pointer (no
credential is ever written there), the session outranks hand-set values unless
`prefer = "env"`, `supersedes` keeps `XAI_API_KEY` out of a session-authenticated
box, and a real `XAI_API_KEY` in the environment still outranks the session at
discovery time — an exported key is a deliberate choice a session must not shadow.

The recorded expiry is the **bearer's**, deliberately conservative. The refresh
token is opaque and carries no readable expiry, and promising a box a credential on
the strength of a token we cannot age out is the guess this plugin never makes. The
cost: a laptop that has not run grok in six hours resolves the session as expired
and injects nothing — run grok once and the next box borrows fresh.

## Consequences

A grok box holds a credential that can mint bearers **indefinitely** — until the
user signs out of grok on the laptop or xAI revokes the grant. That is strictly more
blast radius than codex's fixed-expiry bearer, in exchange for strictly more
usefulness, and it rides on a measurement of third-party behaviour xAI can change
without notice. If a future grok login starts rotating refresh tokens, the symptom
will be boxes signing the laptop out — the moment that is observed, this ADR is
wrong and the placeholder rule reclaims grok. `prefer = "env"` remains the opt-out.
