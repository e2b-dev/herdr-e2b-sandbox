import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// What is installed on THIS machine, and which of its credentials a box may borrow.
//
// A **harness** is the coding CLI installed locally (`claude`, `codex`, …). A
// **template** is the E2B image. They are not the same noun: a template ships an
// agent, a harness is that same agent installed here, and this file is the only
// place the two are mapped to each other.
//
// Governed by docs/adr/0006: detection is a spawn-the-binary probe, reads are
// limited to environment variables and a harness's own DOCUMENTED config file, and
// no Keychain item or OAuth token cache is ever opened. The per-harness facts below
// were established against vendor source and live binaries — see
// docs/research/0002-harness-detection-and-credentials.md. Do not re-derive them and
// do not guess a row: a harness that is not in this table is simply not detected.
//
// Same shape as src/fleet-seed.js and for the same reason: a shipped data table
// beside a PURE function. `interpretProbe` never spawns anything — it takes a probe's
// RESULT — so every parse rule is testable on a machine with none of these installed,
// which is the machine CI runs on.

/**
 * Terminal escape sequences, gone before anything is matched.
 *
 * Two of these harnesses paint the terminal in the same stream they answer in: amp
 * restores the cursor and the kitty keyboard protocol on its way out of an error,
 * and opencode colours the whole of `auth list`. Matching raw bytes happens to work
 * for both today only because the escapes fall outside the words being matched —
 * an accident that stops being true the first time a vendor moves one.
 */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const stripAnsi = (s) => String(s || "").replace(CSI, "")

/**
 * The first line with anything on it. `grok models` answers on line one and then
 * prints its model catalogue underneath, so the answer has to be taken off the top
 * rather than searched for in the whole output.
 */
const firstLine = (s) =>
  stripAnsi(s)
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) || ""

/**
 * hostVar vs boxVar: the variable a credential is found under HERE is not always
 * the variable a box needs. They are equal for five of the eight and deliberately
 * not for the other three — codex authenticates from one name and its box wants
 * another, opencode has no single name at all, and prime accepts a whole registry
 * of them. Collapsing the two fields would be wrong for three rows out of eight.
 *
 * `source` is where ADR 0009's boundary shows up in the data:
 *
 *   env   — a variable in the environment holds it; the NAME is recorded and the
 *           value is forwarded at create time, never written down
 *   file  — the harness's own DOCUMENTED plain-key file holds it
 *   login — the harness works, but from a store this plugin will not open
 *
 * Only the first two are borrowable, which is why `login` is `no-key` and not
 * `authenticated`: reporting otherwise would promise a box a value we cannot hand it.
 */
// Two paths are named rather than inlined because they are read TWICE below —
// once as the documented location the report points at, once as the file
// `e2b-box auth` actually opens when a probe says the credential is in a file.
// Two literals would be two things to keep in step.
/**
 * Read one of the documented config paths in this table, tilde and all.
 *
 * Lives here beside the paths it reads so there is exactly one implementation of
 * "the narrowest read ADR 0009 allows" — the probe needs it for a session's expiry
 * and the write plan needs it for the payload, and two readers would be two places
 * for the boundary to drift. Absent or unreadable is null, never a throw: a file
 * that is not there is an answer.
 */
export const readHarnessFile = (p) => {
  try {
    const abs = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p
    return readFileSync(abs, "utf8")
  } catch {
    return null
  }
}

const AMP_SECRETS = "~/.local/share/amp/secrets.json"
const PRIME_CONFIG = "~/.prime/config.json"
const CODEX_AUTH_JSON = "~/.codex/auth.json"
const CODEX_KEY_FIELD = "OPENAI_API_KEY"

/**
 * What goes where a borrowed session's refresh token used to be (ADR 0010).
 *
 * The refresh token is single-use: two holders that both rotate invalidate each
 * other, so a copy that carried the real one could log the user out of their own
 * machine. Nothing in a box reads it while the access token is live — but the field
 * cannot simply be dropped, because codex requires it to deserialize the file at all
 * (`missing field refresh_token`, before any network call).
 *
 * So it is present, obviously fake, and says so in its own value: whoever opens a
 * borrowed auth.json must not spend a minute wondering whether this is live.
 */
const REFRESH_PLACEHOLDER = "herdr-e2b-placeholder-not-a-real-refresh-token"

/** A JWT's `exp`, as an ISO string. Null for anything that is not a readable JWT —
 * an unreadable expiry is not an excuse to treat a token as immortal, so callers
 * refuse the session rather than guess. Signature is NOT verified: the box's own
 * request is what validates the token, and this only needs to know when to stop
 * offering it. */
const jwtExpiry = (token) => {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString())
    return Number.isFinite(claims?.exp) ? new Date(claims.exp * 1000).toISOString() : null
  } catch {
    return null
  }
}

/**
 * A Codex subscription login, read out of the file it already sits in, ready to be
 * handed to a box (ADR 0010).
 *
 * Returns null for every shape that is not a live borrowable session — an API-key
 * file, a missing access token, an expiry that cannot be read — because a partial
 * session is worse than none: it authenticates nothing and reports as though it did.
 *
 * @returns {{value: string, expires: string}|null} value is the file a box should get
 */
const readCodexSession = (text) => {
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (j?.auth_mode !== "chatgpt" || !j?.tokens?.access_token) return null
  const expires = jwtExpiry(j.tokens.access_token)
  if (!expires) return null
  return {
    value: JSON.stringify({ ...j, tokens: { ...j.tokens, refresh_token: REFRESH_PLACEHOLDER } }),
    expires,
  }
}
const GROK_AUTH_JSON = "~/.grok/auth.json"

/**
 * A grok browser login (`grok login`), read out of ~/.grok/auth.json, ready to be
 * handed to a box whole (ADR 0011).
 *
 * VERBATIM — including the REAL refresh token, which is the one thing
 * `readCodexSession` above must never copy. The difference is measured, not
 * assumed: xAI's refresh grant was exercised twice off the same refresh token
 * (auth.x.ai/oauth2/token, 2026-08-26) and both calls answered 200 — the token is
 * multi-use, so a box refreshing for itself rotates nothing and cannot log the
 * laptop out. That multi-use refresh half is also the whole point of borrowing:
 * the access bearer lives SIX HOURS (measured iat→exp), which ADR 0010's own
 * arithmetic rejects as a credential — it is the file's ability to re-mint that
 * makes a grok box outlast any wall codex's 10-day bearer merely postpones.
 *
 * The recorded expiry is still the BEARER's, deliberately conservative: a laptop
 * that has not run grok in six hours yields a file whose only live half is the
 * refresh token, and promising a box a credential on the strength of an opaque
 * token with no readable expiry is the guess this table never makes. The cost is
 * one graceful degradation — use grok locally and the next box borrows fresh.
 *
 * The file is a map keyed by "<issuer>::<client_id>"; the first OIDC entry that
 * still has both halves is the session. Anything else — an empty map, an entry
 * missing its key or refresh token, an unreadable expiry — is null, never a guess.
 *
 * @returns {{value: string, expires: string}|null} value is the file a box should get
 */
const readGrokSession = (text) => {
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null
  const entry = Object.values(j).find((e) => e?.auth_mode === "oidc" && e?.key && e?.refresh_token)
  if (!entry) return null
  const at = new Date(String(entry.expires_at ?? "")).getTime()
  const expires = Number.isFinite(at) ? new Date(at).toISOString() : jwtExpiry(entry.key)
  if (!expires) return null
  return { value: text, expires }
}

const OPENCODE_AUTH_JSON = "~/.local/share/opencode/auth.json"

export const HARNESSES = {
  claude: {
    template: "claude",
    bin: "claude",
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    hostVar: "ANTHROPIC_API_KEY",
    boxVar: "ANTHROPIC_API_KEY",
    // The only row with TWO credential variables, and they are not alternatives to
    // each other so much as one per KIND of account. ANTHROPIC_API_KEY is a Console
    // key (API usage billing); CLAUDE_CODE_OAUTH_TOKEN is the long-lived token
    // `claude setup-token` mints against a Pro/Max/Team subscription, documented for
    // exactly this — "CI pipelines and scripts where browser login isn't available"
    // — and ranked above the keychain credential it is standing in for.
    //
    // Recording only the key is what put a subscription user (which is most of them)
    // in front of a sign-in screen with the report claiming nothing was wrong: their
    // machine has no ANTHROPIC_API_KEY to find and never will, so discovery had
    // nothing to look for and the remedy it printed named a variable Claude Code
    // would reject the token under. Both names are searched, and whichever one holds
    // a credential is forwarded under ITS OWN name — a token pasted into
    // ANTHROPIC_API_KEY does not authenticate anything.
    envVars: [
      { hostVar: "ANTHROPIC_API_KEY", boxVar: "ANTHROPIC_API_KEY" },
      { hostVar: "CLAUDE_CODE_OAUTH_TOKEN", boxVar: "CLAUDE_CODE_OAUTH_TOKEN" },
    ],
    // Which of the two `advice` below actually produces, so the paste block and the
    // sentence next to it cannot recommend different variables.
    remedyVar: "CLAUDE_CODE_OAUTH_TOKEN",
    // The row that cannot be discovered, so its remedy has to carry the whole answer.
    // Claude keeps its subscription login in the macOS Keychain, which no path here
    // opens (ADR 0010) — and unlike codex, borrowing it would not help much anyway:
    // measured on a real login, the access token had about FOUR HOURS left, against
    // codex's ten days. A box handed that meets a sign-in screen mid-task, which is
    // the failure this whole feature exists to remove. `claude setup-token` mints a
    // long-lived token instead, and it is pasted like any other value — so the advice
    // names it rather than leaving "set ANTHROPIC_API_KEY" to imply the user should
    // go hunting for a key that lasts.
    advice: "run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN to it (a Console API key goes in ANTHROPIC_API_KEY instead)",
    // No plain-key config file exists: on macOS the credential is in the Keychain,
    // which ADR 0009 puts out of scope. The environment is the only readable surface.
    keyFile: null,
    // Claude Code is the only harness that answers this question properly: JSON on
    // stdout with a meaningful exit code, and `apiKeySource` carrying the variable's
    // NAME and never its value — the exact shape ADR 0009 asks for. Every other
    // harness needs a scrappier rule of its own, which is why this lives in the table.
    parse: ({ stdout, env }) => {
      let j
      try {
        j = JSON.parse(stdout || "")
      } catch {
        return null // unreadable — the caller decides that means `unknown`
      }
      if (j.apiKeySource && env[j.apiKeySource]) {
        return { state: "authenticated", source: "env", hostVar: j.apiKeySource }
      }
      // A long-lived token from `claude setup-token`, exported as
      // CLAUDE_CODE_OAUTH_TOKEN. Claude Code reports it as its own `authMethod`
      // rather than through `apiKeySource` — that field is for API keys — so the
      // branch above cannot see it however it is spelled. Confirmed against the
      // environment for the same reason every other named variable is: a method name
      // is not proof the value is still there to forward.
      if (j.authMethod === "oauth_token" && env.CLAUDE_CODE_OAUTH_TOKEN) {
        return { state: "authenticated", source: "env", hostVar: "CLAUDE_CODE_OAUTH_TOKEN" }
      }
      // Logged in by a route whose credential lives somewhere ADR 0009 will not read.
      // `login` is recorded so the report can say WHY nothing was borrowed.
      if (j.loggedIn === true) return { state: "no-key", source: "login" }
      if (j.loggedIn === false) return { state: "no-key", source: null }
      return null
    },
  },

  codex: {
    template: "codex",
    bin: "codex",
    versionArgs: ["--version"],
    authArgs: ["login", "status"],
    // The one row where the two names are furthest apart. Codex authenticates from
    // the environment with CODEX_API_KEY; OPENAI_API_KEY is only the FIELD NAME
    // inside auth.json — which is why src/fleet-seed.js writes that file rather than
    // exporting a variable, and why `[templates.codex.env] OPENAI_API_KEY` is right
    // for a box and would be wrong for a host. That entry looks wrong and is not:
    // the first-run seed runs for every box, not only fleet members. Leave it alone.
    hostVar: "CODEX_API_KEY",
    boxVar: "OPENAI_API_KEY",
    keyFile: { path: CODEX_AUTH_JSON, field: CODEX_KEY_FIELD },
    // `source: "file"` above is a claim about WHERE the credential is; this is how
    // it is fetched from there. Read only when the probe already said `file`, only
    // from this documented path, and only for the field named in `keyFile` — the
    // narrowest read ADR 0009 allows, and the reason a value may be written down at
    // all: it is already sitting in a plaintext file this user owns.
    valueFile: { path: CODEX_AUTH_JSON, read: (text) => JSON.parse(text)?.[CODEX_KEY_FIELD] || null },
    // The `session` counterpart of valueFile, and the only row that has one. Same
    // file, same ADR 0009-narrow read; a different shape comes out because a box
    // authenticated by a subscription needs the FILE, not a variable — so `boxVar`
    // here names the variable that CARRIES that file, which src/fleet-seed.js writes
    // into ~/.codex/auth.json inside the box.
    sessionFile: { path: CODEX_AUTH_JSON, boxVar: "CODEX_AUTH_JSON", read: readCodexSession },
    // Every branch goes to STDERR — `eprintln!` throughout codex-rs/cli/src/login.rs
    // — so a stdout-only capture reads a working install as logged out. The exit
    // code is meaningful too (0/1), but the text is stricter and already implies it.
    //
    // Matched per LINE: codex prefixes a PATH-aliases warning whenever it cannot
    // write its helper binaries, so anchoring at the start of the output would miss
    // the answer sitting on line two.
    parse: ({ stderr }) => {
      const out = stripAnsi(stderr)
      if (/^Logged in using an API key\b/m.test(out)) {
        return { state: "authenticated", source: "file" }
      }
      // "Logged in using ChatGPT" — a subscription, and borrowable since ADR 0010.
      // Its access token is in the same auth.json, is a fixed-expiry bearer, and
      // rotates nothing once its refresh half is replaced by a placeholder. OpenAI's
      // "not across concurrent jobs" rule guards the rotating half, which is exactly
      // the half `readCodexSession` refuses to copy.
      if (/^Logged in using ChatGPT\b/m.test(out)) {
        return { state: "authenticated", source: "session" }
      }
      // Some other login this table has no reader for — say so rather than guess.
      if (/^Logged in using /m.test(out)) return { state: "no-key", source: "login" }
      if (/^Not logged in\b/m.test(out)) return { state: "no-key", source: null }
      return null
    },
  },

  grok: {
    template: "grok",
    bin: "grok",
    versionArgs: ["--version"],
    // `grok models` is offline and exits 0 either way — the first line of stdout is
    // the whole answer.
    authArgs: ["models"],
    hostVar: "XAI_API_KEY",
    boxVar: "XAI_API_KEY",
    keyFile: { path: "~/.grok/config.toml", field: "[model.<id>] api_key" },
    // The grok.com counterpart of codex's ChatGPT login (ADR 0011). Same pointer
    // discipline; the read itself is the one that ships the file verbatim — see
    // readGrokSession for why grok's refresh token travels where codex's must not.
    sessionFile: { path: GROK_AUTH_JSON, boxVar: "GROK_AUTH_JSON", read: readGrokSession },
    // Exit code says NOTHING here: 0 authenticated, 0 logged out. Only the shape of
    // line one distinguishes them.
    //
    // The `grok` on PATH is often a zsh function that runs `env -u XAI_API_KEY grok`
    // when ~/.grok/auth.json exists — probing through a shell would strip the very
    // variable being looked for and report the opposite of the truth. src/harness-probe.js
    // spawns with shell:false for exactly this.
    parse: ({ stdout, env }) => {
      const line = firstLine(stdout)
      // Grok names the variable it used, so it is read the same way Claude Code's
      // `apiKeySource` is: take the NAME, then confirm it is really in the
      // environment. A name we cannot confirm is not an answer.
      const named = /^You are using ([A-Z][A-Z0-9_]*)\.?$/.exec(line)
      if (named) {
        return env[named[1]]
          ? { state: "authenticated", source: "env", hostVar: named[1] }
          : null
      }
      // A grok.com browser login — borrowable since ADR 0011: its auth.json is a
      // plain file, and its refresh token is measured multi-use, so the whole file
      // travels and the box re-mints its own six-hour bearers.
      if (/^You are logged in with grok\.com\.?$/.test(line)) {
        return { state: "authenticated", source: "session" }
      }
      // Some other login this table has no reader for — say so rather than guess.
      if (/^You are logged in with /.test(line)) return { state: "no-key", source: "login" }
      if (/^You are not authenticated\.?$/.test(line)) return { state: "no-key", source: null }
      return null
    },
  },

  opencode: {
    template: "opencode",
    bin: "opencode",
    versionArgs: ["--version"],
    authArgs: ["auth", "list"],
    // The only row with no host variable at all, and it is not an omission: opencode
    // resolves providers from a registry of ~190 distinct variable names. There is no
    // single name to look for, so it looks for none — the plugin does not guess.
    hostVar: null,
    // A box gets auth.json inline instead, with zero disk state, which is the right
    // shape for an ephemeral sandbox. Undocumented, so this pins us to observed
    // behaviour rather than a contract.
    boxVar: "OPENCODE_AUTH_CONTENT",
    keyFile: { path: "~/.config/opencode/opencode.json", field: "provider.<id>.options.apiKey" },
    // Two different files, and the distinction matters. `keyFile` above is the
    // documented plain-key CONFIG file; this is opencode's own credential store,
    // and it is the one `auth list` counts and the one `boxVar` forwards inline.
    // Recording only `keyFile` would point the writer at a file the probe never
    // looked in.
    //
    // The odd one out in a second way: `boxVar` is not a key, it is a whole
    // auth.json, so the "value" read out of the file is a FILE — rebuilt here
    // rather than copied, because an entry opencode labels `oauth` is a token
    // cache and ADR 0009 will not carry one. Forwarding the file whole would put
    // an access/refresh pair into auth.toml and then into a box the moment ONE
    // api-kind entry sat beside it, which is the refresh race the ADR exists to
    // refuse. Providers dropped here are simply unauthenticated in the box.
    valueFile: {
      path: OPENCODE_AUTH_JSON,
      read: (text) => {
        const all = JSON.parse(text)
        const api = Object.fromEntries(
          Object.entries(all).filter(([, cred]) => cred && cred.type === "api"),
        )
        return Object.keys(api).length ? JSON.stringify(api) : null
      },
    },
    // The report has nowhere to point the user, so it says what to do instead.
    // Names auth.json rather than the `keyFile` above on purpose: they are two
    // different files, and auth.json is the one `boxVar` forwards.
    advice: "sign in with `opencode auth login` using an API key — a box is handed those entries",
    // Exit code says nothing, and the output is coloured, so it is stripped first.
    // The two counts say how much there is; the per-credential lines say what KIND,
    // and the kind is what decides borrowability — opencode labels each entry `api`
    // or `oauth`, and an oauth entry is a token cache, which ADR 0009 puts out of
    // reach however convenient auth.json would be to forward. Counting credentials
    // without reading their labels would report a browser-only sign-in as a key.
    //
    // Worth knowing what this does NOT see: `auth list` ignores config-file keys, so
    // it can print `0 credentials` on a fully working install. That is a false
    // negative the plugin accepts rather than reading a file it was told not to.
    parse: ({ stdout }) => {
      const lines = stripAnsi(stdout)
        .split("\n")
        .map((l) => l.trim())
      const creds = Number(/(\d+) credentials?\b/.exec(lines.join("\n"))?.[1])
      const vars = Number(/(\d+) environment variables?\b/.exec(lines.join("\n"))?.[1])
      if (!Number.isFinite(creds) && !Number.isFinite(vars)) return null
      // The Environment section lists variable NAMES, which never end in a bare
      // `api`, so this cannot pick one of those up by accident.
      const keys = lines.filter((l) => /\sapi$/.test(l)).length
      if (keys > 0) return { state: "authenticated", source: "file" }
      if (vars > 0) return { state: "authenticated", source: "env" }
      if (creds > 0) return { state: "no-key", source: "login" }
      return { state: "no-key", source: null }
    },
  },

  amp: {
    template: "amp",
    bin: "amp",
    versionArgs: ["--version"],
    // NOT `amp threads list`: with no credential it opens a browser and blocks on
    // stdin forever, and a timeout does not close a browser that has already opened.
    // `amp usage` fails in under a second and, when authenticated, names the account.
    authArgs: ["usage"],
    hostVar: "AMP_API_KEY",
    boxVar: "AMP_API_KEY",
    // ~/.local/share/amp/secrets.json — a plaintext key in amp's own data dir, keyed
    // by the server it belongs to (`apiKey@https://ampcode.com/`). Undocumented by
    // the vendor, which is why ADR 0009 originally left it alone; ADR 0010 restated
    // the boundary as credential-STORE versus file, and a plain JSON file the user
    // owns is the same category as codex's auth.json, not the same as a Keychain.
    //
    // The URL suffix is the wrinkle: amp's server is configurable, so the key name is
    // not fixed. Exact match on the default server first, then a sole `apiKey@` entry
    // — and nothing at all when several are present, because picking one of two
    // servers' keys is the guess this table does not make.
    keyFile: { path: AMP_SECRETS, field: "apiKey@https://ampcode.com/" },
    valueFile: {
      path: AMP_SECRETS,
      read: (text) => {
        const j = JSON.parse(text)
        if (typeof j?.["apiKey@https://ampcode.com/"] === "string") return j["apiKey@https://ampcode.com/"]
        const keys = Object.keys(j || {}).filter((k) => k.startsWith("apiKey@") && typeof j[k] === "string")
        return keys.length === 1 ? j[keys[0]] : null
      },
    },
    parse: ({ stdout, stderr }) => {
      if (/^Signed in as /m.test(stripAnsi(stdout))) return { state: "no-key", source: "login" }
      if (/Invalid or missing API key/.test(stripAnsi(stderr))) return { state: "no-key", source: null }
      return null
    },
  },

  droid: {
    template: "droid",
    bin: "droid",
    versionArgs: ["--version"],
    // `droid auth` is not a subcommand — `droid [prompt...]` swallows it and launches
    // the TUI. `computer list` is the offline read that answers instead.
    authArgs: ["computer", "list"],
    hostVar: "FACTORY_API_KEY",
    boxVar: "FACTORY_API_KEY",
    // ~/.factory/auth.v2.* is encrypted. Out of scope by construction.
    keyFile: null,
    // Exit code IS meaningful here (0/1), which is what carries the authenticated
    // branch: droid answers 0 with a list that may legitimately be empty, so the
    // presence of output cannot be the test.
    parse: ({ status, stderr }) => {
      if (/No authenticated user/.test(stripAnsi(stderr))) return { state: "no-key", source: null }
      if (status === 0) return { state: "no-key", source: "login" }
      return null
    },
  },

  prime: {
    template: "prime",
    // The one template whose CLI is not named after it.
    bin: "prime-agent",
    // Writes its version to STDERR. Harmless — installedness is decided by whether
    // the spawn found a binary at all, not by which stream answered.
    versionArgs: ["--version"],
    // NOT `prime whoami`: it writes user_id back into config.json, so it is a write
    // dressed as a read. `model list` is offline and changes nothing.
    authArgs: ["model", "list"],
    hostVar: "PRIME_API_KEY",
    boxVar: "PRIME_API_KEY",
    keyFile: { path: PRIME_CONFIG, field: "api_key" },
    // The field the row above already names, now actually read. Source-established
    // rather than vendor-documented (docs.primeintellect.ai has no prime-agent page
    // at all), so it is read as narrowly as every other: this one field, this one
    // path, and a miss degrades the row to no-key rather than throwing.
    valueFile: { path: PRIME_CONFIG, read: (text) => JSON.parse(text)?.api_key || null },
    // PRIME_API_KEY is prime's OWN key (Prime Inference), and it is the only one
    // recorded, but it is not the only one prime accepts: its shipped
    // docs/providers.md tables about twenty provider variables — ANTHROPIC_API_KEY,
    // OPENAI_API_KEY, GEMINI_API_KEY and the rest — any of which will start it.
    // None of them is listed here, because each belongs to a DIFFERENT provider and
    // would have to reach a box under its own name: treating one as a stand-in for
    // PRIME_API_KEY would hand a box an Anthropic key labelled as a Prime one.
    // Exit 0 either way, and every branch on stderr — both halves of this row's
    // awkwardness at once.
    //
    // A listed model means SOME provider resolved, which is not the same as prime
    // having a key this plugin can borrow: the registry above means the credential
    // could belong to any of a dozen providers, and it may equally have come from
    // another harness's file. `login` is the honest reading — it works, we cannot
    // hand it on — and the environment check upstream is what catches the real key.
    parse: ({ stdout, stderr }) => {
      const out = `${stripAnsi(stderr)}\n${stripAnsi(stdout)}`
      if (/^No models available\b/m.test(out)) return { state: "no-key", source: null }
      if (/^provider\s+model\b/m.test(out)) return { state: "no-key", source: "login" }
      return null
    },
  },

  muse: {
    template: "muse",
    bin: "muse",
    versionArgs: ["--version"],
    // Muse Code has no status subcommand: `muse auth` is `auth set` and nothing
    // else, and `muse login` starts a device-code flow. So the probe is a headless
    // run aimed at a loopback port nothing listens on. `exec` resolves its
    // credential BEFORE it opens a model stream, and with none it refuses in about
    // 0.1s with "missing meta credentials"; with one it reaches the dead URL, fails
    // four transport retries in about two seconds and exits 1. Either way nothing
    // leaves the machine and nothing is spent, and `--no-session-log` keeps the run
    // off disk. Both branches measured on 1.0.2 (docs/research/0002). No `--yolo`
    // here on purpose: a probe that trusts the cwd is a probe that loads its rules.
    authArgs: ["exec", "--no-session-log", "--max-model-steps", "1", "--base-url", "http://127.0.0.1:9", "herdr-e2b auth probe"],
    hostVar: "META_API_KEY",
    boxVar: "META_API_KEY",
    // ~/.config/muse/auth.json is a POINTER, not a store. On macOS its `providers.meta`
    // entry reads `{mechanism: "oauth", storage: "keychain"}` and the token itself is
    // in the Keychain, which ADR 0009 puts out of reach: the same shape as Claude
    // Code, and the reason a Muse browser login is `no-key` here rather than a
    // borrowable session (ADR 0010). A key saved with `muse auth set` lands in the
    // same Keychain. On Linux the same file carries `access_token` inline (the vendor
    // launcher reads it from there for its own downloads), but that schema has not
    // been seen on a real login and is not read.
    keyFile: null,
    // Meta documents the precedence: META_API_KEY, then a stored key, then the browser
    // login. So the variable is not a workaround for the Keychain, it is the first
    // thing Muse looks at.
    advice: "set META_API_KEY (a Meta API key outranks the browser login, which lives in the Keychain)",
    // Every branch on stderr, exit 1 either way; only the text tells them apart.
    parse: ({ stderr }) => {
      const out = stripAnsi(stderr)
      if (/^missing meta credentials\b/m.test(out)) return { state: "no-key", source: null }
      // Past the credential check and into the dead transport: SOMETHING authenticated
      // it, and the environment check upstream already ruled out META_API_KEY, so it
      // is a stored login or a stored key, both of which sit in the Keychain.
      if (/transport error\b.*127\.0\.0\.1:9\b/.test(out)) return { state: "no-key", source: "login" }
      return null
    },
  },
}

/**
 * Every environment variable this harness can be authenticated by, primary first,
 * as `{hostVar, boxVar}` pairs.
 *
 * Seven rows out of eight have exactly one, which is why the table states it as the
 * two plain fields and this synthesises the pair for them. Claude Code has two, and
 * they are not interchangeable spellings of one credential: a Console key and a
 * subscription token authenticate different accounts and each is only accepted under
 * its own name. Anything that asks "is this harness authenticated" or "what does its
 * box get" has to ask over the whole list or it will miss half the users.
 */
export function credentialVars(h) {
  if (Array.isArray(h?.envVars) && h.envVars.length) return h.envVars
  return h?.hostVar ? [{ hostVar: h.hostVar, boxVar: h.boxVar }] : []
}

/**
 * The box variable that carries what was found under `hostVar` here.
 *
 * Falls back to the row's own `boxVar` for a name the table does not list — a probe
 * may report a variable of its own (grok names the one it used), and that is the
 * pre-existing answer for those.
 */
export function boxVarForHost(h, hostVar) {
  return credentialVars(h).find((v) => v.hostVar === hostVar)?.boxVar || h?.boxVar || null
}

/**
 * The box variable `remedyFor`'s advice actually produces — what a paste block for
 * this harness should name. Equal to `boxVar` everywhere except claude, whose advice
 * mints a token that ANTHROPIC_API_KEY would reject.
 */
export function remedyVarFor(h) {
  return h?.remedyVar || h?.boxVar || null
}

/**
 * What to tell the user to do about a harness with no borrowable key.
 *
 * Normally "set <VAR>", but opencode resolves providers from a registry of ~190
 * names and has no single variable to name, so its row carries a sentence of its
 * own. Lives here rather than in either caller because the report and the write
 * plan both need it and had drifted into opposite precedence — one preferring the
 * advice, the other the variable — which stays invisible only while opencode is
 * the sole row with advice AND no variable.
 */
export function remedyFor(id, hostVar = null) {
  const h = HARNESSES[id]
  if (h?.advice) return h.advice
  const v = hostVar || h?.hostVar
  return v ? `set ${v}` : "no credential variable is known for this harness"
}

/**
 * The harness a template ships, as `{id, ...row}` — or null for a template no row
 * claims. The only reverse lookup over this table: everything else asks "what did
 * this harness find", and a fleet asks "what does this member's box want".
 *
 * Null is the answer for `base`, for a template somebody configured themselves, and
 * for a harness this table does not know. All three mean the same thing to a caller
 * — there is no variable to name — and naming one anyway is the guess ADR 0009
 * forbids.
 */
export function harnessForTemplate(template) {
  const t = String(template ?? "").trim()
  if (!t) return null
  for (const [id, h] of Object.entries(HARNESSES)) {
    if (h.template === t) return { id, ...h }
  }
  return null
}

/**
 * Read one harness's probe result.
 *
 * `state` answers a narrower question than "does the harness work": it is whether
 * this plugin can authenticate a BOX from what is on this machine. A harness signed
 * in with a subscription works fine and is still `no-key`, because its token is not
 * something ADR 0009 lets us borrow.
 *
 *   authenticated — a credential exists that a box can be given
 *   no-key        — the harness is installed and nothing borrowable was found
 *   unknown       — the probe could not be read (timed out, or output made no sense)
 *
 * `unknown` is never collapsed into "not installed". A harness the user owns must
 * not disappear because its probe misbehaved.
 *
 * Pure. Takes results, not a spawner.
 *
 * @param {string} id                    key into HARNESSES
 * @param {object} probe                 { status, stdout, stderr, env, timedOut }
 * @returns {{installed: boolean, state: string, source: string|null, hostVar: string|null}}
 */
export function interpretProbe(id, probe = {}) {
  const h = HARNESSES[id]
  if (!h) return { installed: false, state: "unknown", source: null, hostVar: null }

  const env = probe.env || {}
  const installed = !probe.notFound

  // Probe OR environment — never the probe alone, and never the binary either. What
  // a box needs is the CREDENTIAL; the local harness is only where we go looking for
  // it. So a variable sitting in the environment is borrowable whether the binary
  // answered, hung, answered unreadably, or was never installed at all. Checked
  // before anything else, so nothing can mask a key that is plainly there.
  // Every variable this row accepts, primary first, so a harness with two of them
  // is found under whichever one the user actually has. `find` and not a filter:
  // the first hit is the answer, and a box needs one credential, not both.
  const found = credentialVars(h).find((v) => env[v.hostVar])
  if (found) {
    return { installed, state: "authenticated", source: "env", hostVar: found.hostVar }
  }

  // Absent and unknown are different sentences. A binary that is not here is a fact;
  // a probe that would not answer is an admission. Never print one as the other.
  // (`no-key` here is the literal truth — nothing borrowable was found — and the
  // absence itself is carried by `installed`, which is the field the report reads.)
  if (!installed) return { installed: false, state: "no-key", source: null, hostVar: h.hostVar }

  // A probe that never answered is read as nothing at all, explicitly. Letting this
  // fall through to the parse rule would reach the same answer today only because an
  // empty string fails to parse — an accident, and one that would quietly stop being
  // true for the first harness whose empty output happens to be meaningful.
  if (probe.timedOut) return { installed: true, state: "unknown", source: null, hostVar: h.hostVar }

  // Everything above is universal; the rule below belongs to this harness alone. It
  // lives in the table because harnesses do not answer alike — two of them report on
  // stderr, three exit 0 whether or not a credential exists, and two paint the
  // terminal mid-sentence. A rule that returns nothing means "I could not read
  // this", which is `unknown` — never a guess.
  const read = h.parse ? h.parse({ ...probe, env }) : null
  if (!read) return { installed: true, state: "unknown", source: null, hostVar: h.hostVar }

  return { installed: true, hostVar: h.hostVar, ...read }
}
