# The plugin signs in itself and stores what the vendor mints (extends 0013)

**Extends:** [0013 — connections select one credential before a box is created](0013-connections-select-one-credential-before-a-box-is-created.md)
**Informed by:** [0010](0010-a-session-in-a-file-is-borrowable-amending-0009.md), [0011](0011-groks-refresh-token-is-multi-use-so-its-session-ships-whole.md), [0014](0014-amps-refresh-token-rotates-so-its-session-is-not-borrowable.md)

Every credential this plugin has handled so far is one it **found**: a variable in
the shell, a key in a harness's config file, a session a harness left on disk. That
is the right default, and it has a ceiling. A found session belongs to the laptop's
own CLI, so the plugin may only copy it under rules that keep the two from rotating
each other out (0010's placeholder, 0011's measured multi-use), and a harness whose
session is short-lived and rotating (amp, 0014) offers nothing to copy at all.

replicas-cli takes the other road for the same problem: it runs each vendor's OAuth
flow **itself**, with the public client id that vendor's CLI ships, and keeps the
result on its own server. This ADR takes the first half of that and drops the
server: `e2b-box auth connect <harness>` signs in as the plugin and stores what
comes back as a connection (0013), under `connections/`, mode 600, one file per
revision.

## What is stored is what the vendor mints, not the session

The session that a sign-in yields is not the artifact. What each vendor hands out
*after* the sign-in is:

| harness | sign-in | stored | why |
|---|---|---|---|
| muse | Meta device flow (`auth.meta.com/oidc/device`) | the **Muse API key** Meta mints for the account (`api.meta.ai/muse-code/key`) | a key: no refresh, no expiry to track, N boxes at once. It is what `muse login` stores for itself. |
| amp | none: the plugin opens `ampcode.com/settings/security` and takes the **access token** (`sgamp_…`) the human pastes | that token | 0014: amp's OAuth session is a five-minute bearer with a rotating refresh token, and the page that shows the access token reads it through a remote function that accepts only the browser's cookie session and demands a *recent* sign-in (`REAUTH_REQUIRED`), measured 2026-09-09. No CLI-held credential passes that gate, by design, so the plugin's own device sign-in would buy nothing. One paste, once. |
| codex | Codex CLI's PKCE flow against `auth.openai.com`, client `app_EMoamEEZ73f0CkXaXp7hrann` | the **auth.json** of a second, plugin-owned ChatGPT login, real refresh token included | the plugin is that chain's *only* custodian: boxes get 0010's placeholder copy, `~/.codex` is never read or written, and `auth reconnect` refreshes without a browser while the chain is alive. |

claude keeps `setup-token` (0013): a one-year token beats anything an OAuth bearer
offers. grok keeps its borrowed session (0011). droid, prime and opencode have API
keys and no OAuth to run.

## Custody, in one sentence per harness

A rotating refresh token has exactly one legitimate holder. For muse and amp the
answer is "nobody": what is stored refreshes nothing. For codex the holder is the
plugin, and only two verbs ever touch it, `auth reconnect` (refresh, then browser if
the grant fails) and `auth connect --oauth` (a new chain). Provisioning reads the
stored bearer synchronously and, when it has expired, says *reconnect* rather than
refreshing behind the user's back: a box create must stay a pure read of config and
connections, which is what keeps `explain`, `preflight` and the fleet's pre-flight
honest about what a box will get.

## Consequences

- One browser approval per harness per machine, once. Nothing is scraped from the
  laptop's own logins, so signing out of a vendor's CLI locally does not affect a
  connection, and vice versa.
- Client ids are public clients copied from shipped CLIs. A vendor that rotates
  its client id, changes a redirect, or gates its device flow breaks `connect`
  loudly and nothing else; existing connections keep working until their material
  expires.
- amp is the honest exception: `auth connect amp` is a paste, because the token
  lives behind an identity re-check in the browser. The measurements that rule out
  every automated route are recorded in `src/oauth.js` so the question is not
  reopened by the next reader.
- The flows are exercised by `test/oauth.test.js` against a scripted server; the
  connections by `test/connections.test.js`. No test signs in anywhere.
