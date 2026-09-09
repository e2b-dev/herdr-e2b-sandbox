# Amp's refresh token rotates, so its session is not borrowable (applies 0010, contrasts 0011)

**Applies:** [0010 — a session in a file is borrowable](0010-a-session-in-a-file-is-borrowable-amending-0009.md)
**Contrasts:** [0011 — grok's refresh token is multi-use](0011-groks-refresh-token-is-multi-use-so-its-session-ships-whole.md)

`amp login` stores its browser session in `~/.local/share/amp/secrets.json`: an
access token under `apiKey@https://ampcode.com/` and a refresh token under
`oauth-refresh-token@https://ampcode.com/`. A plain file, mode 600, inside 0009's
read boundary. The question 0010 and 0011 ask of such a file is whether a box can
hold a copy without either dying early or logging the laptop out. For amp the
answer to both halves is no, and this ADR records the measurements so nobody
re-derives them.

## The measurements

Decoded from a live login (2026-09-09), the access token is a WorkOS AuthKit JWT
(`iss` `https://authapi.ampcode.com`, WorkOS `user_…` / `client_…` ids) with
`exp - iat` = **300 seconds**. Five minutes. 0010's bearer-lifetime test is not
close: a box handed the bearer alone is signed out before its first task finishes.
Amp itself says as much when the bearer is offered as `AMP_API_KEY`: "holds an
OAuth session token, which is short-lived".

So borrowing would rest entirely on the refresh half, exactly 0011's argument for
grok. Against `POST https://authapi.ampcode.com/user_management/authenticate`
(`grant_type=refresh_token`, `client_id`, `refresh_token`; live account,
2026-09-09):

- refresh grant with the laptop's token R0 → **200**, new bearer, a **new** refresh
  token R1;
- R0 again, two seconds later → **200** (a reuse grace window);
- R0 again, thirty seconds later → **400**;
- R1 → 200 and R2, R1 not tested further; every grant that succeeded rotated.

Amp's refresh tokens **rotate and invalidate**, with a grace window of seconds.
That is codex's shape (0010), not grok's (0011): two holders refreshing every five
minutes are two rotators, and the second one to refresh finds its token dead. With
the laptop and one box that is a coin toss per interval over who gets signed out;
with a fleet it is a certainty.

## Decision

Amp's session is **not borrowed**. `readHarnessFile` for amp (`HARNESSES.amp.valueFile`)
reads the `apiKey@…` entry as a key only when it is not a JWT; a JWT-shaped value
resolves to "signed in, nothing to borrow", and the remedy names the credential
that does work: an **access token** minted at
https://ampcode.com/settings/security#access-token and set as `AMP_API_KEY`
(`[templates.amp.env]`, or found by `e2b-box auth` once it is in the environment).
That token is long-lived, per-user, revocable, and refreshes nothing, so N boxes and
the laptop can hold it at once. `amp login`'s file is left exactly as it is.

The 0010 placeholder trick (ship the bearer, replace the refresh token) is not
taken either: it would produce a five-minute member, which is worse than a named
gap. 0011's verbatim rule stays reserved for a harness whose refresh grant has been
measured multi-use, and amp measured the opposite.

## Consequences

An amp fleet member needs one manual step per user, once. The plugin's job is to
say so precisely and early (the fleet pre-flight names the member, the template and
the variable before anything boots), never to reach for the session file and hope.
If amp ever ships long-lived bearers or non-rotating refresh tokens, this ADR is
what to re-measure against; until then the JWT check is the boundary.
