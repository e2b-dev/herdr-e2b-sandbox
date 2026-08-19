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
 * the variable a box needs. They are equal for four of the seven and deliberately
 * not for the other three — codex authenticates from one name and its box wants
 * another, opencode has no single name at all, and prime accepts a whole registry
 * of them. Collapsing the two fields would be wrong for three rows out of seven.
 *
 * `source` is where ADR 0006's boundary shows up in the data:
 *
 *   env   — a variable in the environment holds it; the NAME is recorded and the
 *           value is forwarded at create time, never written down
 *   file  — the harness's own DOCUMENTED plain-key file holds it
 *   login — the harness works, but from a store this plugin will not open
 *
 * Only the first two are borrowable, which is why `login` is `no-key` and not
 * `authenticated`: reporting otherwise would promise a box a value we cannot hand it.
 */
export const HARNESSES = {
  claude: {
    template: "claude",
    bin: "claude",
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    hostVar: "ANTHROPIC_API_KEY",
    boxVar: "ANTHROPIC_API_KEY",
    // No plain-key config file exists: on macOS the credential is in the Keychain,
    // which ADR 0006 puts out of scope. The environment is the only readable surface.
    keyFile: null,
    // Claude Code is the only harness that answers this question properly: JSON on
    // stdout with a meaningful exit code, and `apiKeySource` carrying the variable's
    // NAME and never its value — the exact shape ADR 0006 asks for. Every other
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
      // Logged in by a route whose credential lives somewhere ADR 0006 will not read.
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
    keyFile: { path: "~/.codex/auth.json", field: "OPENAI_API_KEY" },
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
      // "Logged in using ChatGPT" — a subscription. Its token is in auth.json too,
      // but ADR 0006 defers OAuth entirely, and inside a fleet OpenAI documents that
      // this file must not be shared across concurrent jobs. Not borrowable.
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
    // documented plain-key CONFIG file; `authFile` is opencode's own credential
    // store, and it is the one `auth list` counts and the one `boxVar` forwards
    // inline. Recording only `keyFile` would point ticket 03 at a file the probe
    // never looked in.
    authFile: "~/.local/share/opencode/auth.json",
    // The report has nowhere to point the user, so it says what to do instead.
    // Names auth.json rather than the `keyFile` above on purpose: they are two
    // different files, and auth.json is the one `boxVar` forwards.
    advice: "sign in with `opencode auth login` — a box is handed that auth.json whole",
    // Exit code says nothing, and the output is coloured, so it is stripped first.
    // The two counts say how much there is; the per-credential lines say what KIND,
    // and the kind is what decides borrowability — opencode labels each entry `api`
    // or `oauth`, and an oauth entry is a token cache, which ADR 0006 puts out of
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
    // ~/.local/share/amp/secrets.json exists but is undocumented, and ADR 0006 limits
    // file reads to a harness's own DOCUMENTED location. The environment is the only
    // borrowable surface.
    keyFile: null,
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
    keyFile: { path: "~/.prime/config.json", field: "api_key" },
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
}

/**
 * Read one harness's probe result.
 *
 * `state` answers a narrower question than "does the harness work": it is whether
 * this plugin can authenticate a BOX from what is on this machine. A harness signed
 * in with a subscription works fine and is still `no-key`, because its token is not
 * something ADR 0006 lets us borrow.
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
  if (h.hostVar && env[h.hostVar]) {
    return { installed, state: "authenticated", source: "env", hostVar: h.hostVar }
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
