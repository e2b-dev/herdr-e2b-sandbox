import test from "node:test"
import assert from "node:assert/strict"
import { HARNESSES, interpretProbe } from "../src/harnesses.js"

// --- what the plugin can borrow ----------------------------------------------
// `state` answers one question only: can this plugin authenticate a box from what
// is on this machine? It is not "is the harness working" — a harness signed in
// with a subscription works perfectly and is still `no-key` here, because ADR 0009
// puts its credential store out of reach.

test("interpretProbe: a harness reporting an API key from the environment is borrowable", () => {
  const r = interpretProbe("claude", {
    status: 0,
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: "api_key",
      apiKeySource: "ANTHROPIC_API_KEY",
    }),
    stderr: "",
    env: { ANTHROPIC_API_KEY: "sk-ant-x" },
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "env")
  assert.equal(r.hostVar, "ANTHROPIC_API_KEY")
})

test("interpretProbe: a logged-out harness has no key to borrow", () => {
  const r = interpretProbe("claude", {
    status: 1,
    stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, null)
  // Still names the variable, so the report can tell the user what to set.
  assert.equal(r.hostVar, "ANTHROPIC_API_KEY")
})

test("interpretProbe: a subscription login is NOT borrowable", () => {
  // The harness works perfectly; its credential is in the macOS Keychain, which
  // ADR 0009 puts out of reach. Reporting this as `authenticated` would promise a
  // box a credential the plugin cannot actually hand it.
  const r = interpretProbe("claude", {
    status: 0,
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "someone@example.com",
    }),
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, "login")
  assert.equal(r.hostVar, "ANTHROPIC_API_KEY")
})

test("interpretProbe: a subscription TOKEN is borrowable, under its own name", () => {
  // The other half of the row above, and the one most claude users actually have:
  // `claude setup-token` mints a long-lived token for exactly this, and Claude Code
  // reports it as an `authMethod` rather than through `apiKeySource`, so the
  // API-key branch cannot see it.
  const r = interpretProbe("claude", {
    status: 0,
    stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }),
    stderr: "",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "env")
  assert.equal(r.hostVar, "CLAUDE_CODE_OAUTH_TOKEN")
})

test("interpretProbe: an authMethod with no variable behind it is not an answer", () => {
  // A method name is not proof the value is still there to forward — the token may
  // have come from a shell this process cannot see. Reporting `authenticated` here
  // is the failure the whole feature exists to remove: a box that boots on a
  // sign-in screen while the report claimed a credential was found.
  const r = interpretProbe("claude", {
    status: 0,
    stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth_token" }),
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, "login")
})

test("interpretProbe: a token in the environment is found with no probe at all", () => {
  // Same rule as the API key below it: the environment answers on its own. This is
  // the path that matters when herdr creates the box, where nothing is spawned.
  const r = interpretProbe("claude", { notFound: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } })
  assert.equal(r.state, "authenticated")
  assert.equal(r.hostVar, "CLAUDE_CODE_OAUTH_TOKEN")
})

test("interpretProbe: a probe that timed out is unknown, never 'no key'", () => {
  // The difference matters: `no-key` tells the user to go set a variable, which is
  // wrong and wastes their time if the key was there all along and the probe hung.
  const r = interpretProbe("claude", { timedOut: true, stdout: "", stderr: "", env: {} })
  assert.equal(r.state, "unknown")
  assert.equal(r.source, null)
})

test("interpretProbe: a timed-out probe still reports a key sitting in the environment", () => {
  // Probe OR environment — never the probe alone. What the plugin needs to know is
  // whether a value exists to hand a box, and the environment answers that on its
  // own whether or not the binary felt like replying.
  const r = interpretProbe("claude", {
    timedOut: true,
    stdout: "",
    stderr: "",
    env: { ANTHROPIC_API_KEY: "sk-ant-x" },
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "env")
  assert.equal(r.hostVar, "ANTHROPIC_API_KEY")
})

test("interpretProbe: output that makes no sense is unknown, not a guess", () => {
  const r = interpretProbe("claude", { status: 0, stdout: "not json at all", stderr: "", env: {} })
  assert.equal(r.state, "unknown")
})

test("interpretProbe: a binary that is not on the machine is reported absent, not unknown", () => {
  // Absent and unknown are different sentences to the user: one says "you do not
  // have this", the other says "you might, and I could not tell".
  const r = interpretProbe("claude", { notFound: true, env: {} })
  assert.equal(r.installed, false)
})

test("interpretProbe: an installed harness says so", () => {
  const r = interpretProbe("claude", { status: 1, stdout: "{}", stderr: "", env: {} })
  assert.equal(r.installed, true)
})

test("interpretProbe: a harness this plugin does not know is never guessed at", () => {
  const r = interpretProbe("some-cli-we-never-heard-of", { status: 0, stdout: "", env: {} })
  assert.equal(r.hostVar, null)
})

test("interpretProbe: a key in the environment is borrowable even with no local harness", () => {
  // The box needs the CREDENTIAL, not the local binary. Someone who has never
  // installed Claude Code but exports ANTHROPIC_API_KEY can still boot an
  // authenticated `claude` box, and refusing to notice that would throw away the
  // one thing this feature exists to find.
  const r = interpretProbe("claude", { notFound: true, env: { ANTHROPIC_API_KEY: "sk-ant-x" } })
  assert.equal(r.installed, false)
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "env")
})

// --- the awkward seven --------------------------------------------------------
// Claude Code above is the only harness that answers this question properly. Every
// case below is captured output from a real binary, both branches, on one macOS
// machine — see docs/research/0002-harness-detection-and-credentials.md. They are
// fixtures on purpose: CI has none of these installed, and that is the point.

test("the table covers every harness behind a shipped template, and nothing else", () => {
  // `base` ships no agent, so it has no harness. Gemini is deliberately absent —
  // it has no auth probe of any kind, so its row would be permanently unknown.
  assert.deepEqual(Object.keys(HARNESSES).sort(), [
    "amp",
    "claude",
    "codex",
    "droid",
    "grok",
    "opencode",
    "prime",
  ])
  for (const [id, h] of Object.entries(HARNESSES)) {
    assert.equal(h.template, id, `${id}: the template and the harness share a name here`)
  }
})

test("host variable and box variable differ exactly where the research says they do", () => {
  // Collapsing these into one field would be wrong for three of the seven, which
  // is why both are recorded even for the four where they are identical.
  assert.equal(HARNESSES.codex.hostVar, "CODEX_API_KEY")
  assert.equal(HARNESSES.codex.boxVar, "OPENAI_API_KEY")
  assert.equal(HARNESSES.opencode.hostVar, null)
  assert.equal(HARNESSES.opencode.boxVar, "OPENCODE_AUTH_CONTENT")
  for (const id of ["claude", "grok", "amp", "droid", "prime"]) {
    assert.equal(HARNESSES[id].hostVar, HARNESSES[id].boxVar, id)
  }
})

// --- codex: status on stderr, and a probe that ignores the environment ---------

test("interpretProbe: codex reports on stderr, so a stdout-only read would miss it", () => {
  const r = interpretProbe("codex", {
    status: 1,
    stdout: "",
    stderr: "Not logged in\n",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, null)
})

test("interpretProbe: codex's stderr is matched per line, not from the start", () => {
  // Real capture: codex prefixes a PATH-aliases warning when it cannot write its
  // helper binaries. Anchoring the match to the start of the output would read a
  // logged-out machine as unreadable.
  const r = interpretProbe("codex", {
    status: 1,
    stdout: "",
    stderr:
      'WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp/x"\nNot logged in\n',
    env: {},
  })
  assert.equal(r.state, "no-key")
})

test("interpretProbe: a codex API key in its own auth file is borrowable from that file", () => {
  const r = interpretProbe("codex", {
    status: 0,
    stdout: "",
    stderr: "Logged in using an API key - sk-fake-***l-key\n",
    env: {},
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "file")
})

test("interpretProbe: a codex subscription login IS borrowable, as a session", () => {
  // Reversed by ADR 0010. It used to be `no-key` on the grounds that OpenAI forbids
  // sharing auth.json across concurrent jobs — but that rule guards the single-use
  // refresh token, which src/harnesses.js replaces with a placeholder rather than
  // copying. What is left is a fixed-expiry bearer that rotates nothing.
  const r = interpretProbe("codex", {
    status: 0,
    stdout: "",
    stderr: "Logged in using ChatGPT\n",
    env: {},
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "session")
})

test("interpretProbe: a login this table has no reader for stays no-key", () => {
  // The catch-all below the ChatGPT branch. A future `Logged in using <something>`
  // must not be silently claimed as borrowable just because it says "Logged in".
  const r = interpretProbe("codex", {
    status: 0,
    stdout: "",
    stderr: "Logged in using Azure Entra\n",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, "login")
})

test("interpretProbe: a real CODEX_API_KEY still outranks a subscription session", () => {
  // The env check runs first and must keep doing so: an actual key the user set is
  // a deliberate choice, and a session must not shadow it.
  const r = interpretProbe("codex", {
    status: 0,
    stdout: "",
    stderr: "Logged in using ChatGPT\n",
    env: { CODEX_API_KEY: "sk-real" },
  })
  assert.equal(r.source, "env")
})

test("interpretProbe: codex says not-logged-in while the environment says otherwise", () => {
  // The case the whole 'probe OR environment' rule exists for. `codex login status`
  // sets enable_codex_api_key_env:false and deliberately ignores CODEX_API_KEY, so
  // it prints `Not logged in` on a machine where Codex works perfectly. Believing
  // the probe alone would report a working credential as missing.
  const r = interpretProbe("codex", {
    status: 1,
    stdout: "",
    stderr: "Not logged in\n",
    env: { CODEX_API_KEY: "sk-real" },
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "env")
  assert.equal(r.hostVar, "CODEX_API_KEY")
})

// --- grok, opencode, prime: exit 0 whether or not a credential exists ----------

test("interpretProbe: grok exits 0 logged out, so only the output shape says so", () => {
  const r = interpretProbe("grok", {
    status: 0,
    stdout: "You are not authenticated.\n\nDefault model: grok-4.6\n",
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, null)
})

test("interpretProbe: grok names the variable it is using, and it is checked", () => {
  const r = interpretProbe("grok", {
    status: 0,
    stdout: "You are using XAI_API_KEY.\n\nDefault model: grok-4.6\n",
    stderr: "",
    env: { XAI_API_KEY: "xai-x" },
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "env")
  assert.equal(r.hostVar, "XAI_API_KEY")
})

test("interpretProbe: a grok browser login IS borrowable, as a session", () => {
  // Reversed by ADR 0011. It was `no-key` while grok's six-hour bearer failed ADR
  // 0010's lifetime test — but the refresh token beside it is measured MULTI-USE,
  // so the whole file travels and the box re-mints bearers for itself.
  const r = interpretProbe("grok", {
    status: 0,
    stdout: "You are logged in with grok.com.\n\nDefault model: grok-4.6\n",
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "session")
})

test("interpretProbe: a real XAI_API_KEY still outranks a grok session", () => {
  // Same pin as codex's: the env check runs first, and a key the user set is a
  // deliberate choice a session must not shadow.
  const r = interpretProbe("grok", {
    status: 0,
    stdout: "You are logged in with grok.com.\n\nDefault model: grok-4.6\n",
    stderr: "",
    env: { XAI_API_KEY: "xai-real" },
  })
  assert.equal(r.source, "env")
})

test("interpretProbe: a grok login this table has no reader for stays no-key", () => {
  // The catch-all below the grok.com branch — a future `logged in with <idp>` must
  // not be silently claimed as borrowable just because it says "logged in".
  const r = interpretProbe("grok", {
    status: 0,
    stdout: "You are logged in with example-sso.org.\n\nDefault model: grok-4.6\n",
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, "login")
})

test("interpretProbe: opencode counts credentials, and exits 0 with none", () => {
  const r = interpretProbe("opencode", {
    status: 0,
    stdout: "\u001b[90m┬  Credentials\n│\n└  0 credentials\n\n",
    stderr: "\u001b[0m\n",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, null)
  // opencode has no single credential variable — ~190 provider names resolved from
  // a registry. Inventing one for the report would be a guess.
  assert.equal(r.hostVar, null)
})

test("interpretProbe: a plain key in opencode's own auth file is a borrowable source", () => {
  const r = interpretProbe("opencode", {
    status: 0,
    stdout:
      "┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n●  Anthropic \u001b[90mapi\n│\n└  1 credentials\n\n",
    stderr: "\u001b[0m\n",
    env: {},
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "file")
})

test("interpretProbe: an opencode credential is read by KIND, not just counted", () => {
  // opencode labels every entry `api` or `oauth`. Counting them would report this
  // machine as borrowable and hand ticket 03 an OAuth token to copy — the exact
  // thing ADR 0009 says is never read. One oauth entry is a login, not a key.
  const r = interpretProbe("opencode", {
    status: 0,
    stdout:
      "┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI \u001b[90moauth\n│\n└  1 credentials\n\n",
    stderr: "\u001b[0m\n",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, "login")
})

test("interpretProbe: a real key still wins over an opencode oauth entry beside it", () => {
  const r = interpretProbe("opencode", {
    status: 0,
    stdout:
      "┌  Credentials\n│\n●  Anthropic \u001b[90mapi\n│\n●  OpenAI \u001b[90moauth\n│\n└  2 credentials\n\n",
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "file")
})

test("interpretProbe: opencode reports provider variables it found in the environment", () => {
  const r = interpretProbe("opencode", {
    status: 0,
    stdout:
      "┬  Credentials\n│\n└  0 credentials\n\n┬  Environment\n│\n●  xAI \u001b[90mXAI_API_KEY\n│\n└  1 environment variables\n\n",
    stderr: "",
    env: { XAI_API_KEY: "xai-x" },
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "env")
})

test("interpretProbe: prime writes even its model list to stderr", () => {
  const r = interpretProbe("prime", {
    status: 0,
    stdout: "",
    stderr:
      "provider         model                  context  max-out  thinking  images\nopenai-codex     gpt-5.1                272K     128K     yes       yes\n",
    env: {},
  })
  // A provider answered, so prime runs — but from a credential this probe cannot
  // name and ADR 0009 will not go looking for. Saying `authenticated` here would
  // promise a box a value the plugin does not have.
  assert.equal(r.state, "no-key")
  assert.equal(r.source, "login")
})

test("interpretProbe: prime with no provider at all exits 0 and says so on stderr", () => {
  const r = interpretProbe("prime", {
    status: 0,
    stdout: "",
    stderr: "No models available. Use /login to log into a provider via OAuth or API key. See:\n",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, null)
})

test("interpretProbe: prime's own key in the environment beats its unhelpful probe", () => {
  const r = interpretProbe("prime", {
    status: 0,
    stdout: "",
    stderr: "No models available. Use /login to log into a provider via OAuth or API key.\n",
    env: { PRIME_API_KEY: "pk-x" },
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "env")
  assert.equal(r.hostVar, "PRIME_API_KEY")
})

// --- amp and droid: the exit code means something, and one paints the terminal --

test("interpretProbe: amp's error path is read through its terminal escape sequences", () => {
  // Captured verbatim: amp restores the cursor and the kitty keyboard protocol on
  // its way out, in the same stream as the message. Matching the raw bytes works
  // here by luck — the escapes trail the text — and would stop working the first
  // time a vendor moves them. Strip, then match.
  const r = interpretProbe("amp", {
    status: 1,
    stdout: "",
    stderr:
      "Error: Invalid or \u001b[?25hmissing API key. Run 'amp login' to authenticate.\n\u001b[=0u\u001b[<u\u001b[?25h",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, null)
})

test("interpretProbe: an amp sign-in is a login, not a borrowable key", () => {
  // Amp keeps it in ~/.local/share/amp/secrets.json, which is undocumented — ADR
  // 0006 limits file reads to a harness's own DOCUMENTED location.
  const r = interpretProbe("amp", {
    status: 0,
    stdout: "Signed in as someone@example.com\n**Amp Megawatt Subscription:** 0% other usage\n",
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, "login")
})

test("interpretProbe: droid's unauthenticated error is recognised", () => {
  const r = interpretProbe("droid", {
    status: 1,
    stdout: "",
    stderr: "Failed to list: No authenticated user with organization available\n",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, null)
})

test("interpretProbe: a droid that answers is signed in, but into an encrypted store", () => {
  const r = interpretProbe("droid", {
    status: 0,
    stdout: "dream-machine\t282db467-06f1-46e4-9767-2344f6df4d40 (this machine)\n",
    stderr: "",
    env: {},
  })
  assert.equal(r.state, "no-key")
  assert.equal(r.source, "login")
})

test("interpretProbe: a droid key in the environment is borrowable under its own name", () => {
  const r = interpretProbe("droid", {
    status: 1,
    stdout: "",
    stderr: "Failed to list: No authenticated user with organization available\n",
    env: { FACTORY_API_KEY: "fk-x" },
  })
  assert.equal(r.state, "authenticated")
  assert.equal(r.hostVar, "FACTORY_API_KEY")
})

// --- nothing installed, which is the machine CI runs on -----------------------

test("interpretProbe: every harness reports absent, not unknown, on a bare machine", () => {
  for (const id of Object.keys(HARNESSES)) {
    const r = interpretProbe(id, { notFound: true, env: {} })
    assert.equal(r.installed, false, id)
    assert.equal(r.state, "no-key", id)
  }
})

test("interpretProbe: output no harness would ever produce is unknown, never a guess", () => {
  for (const id of Object.keys(HARNESSES)) {
    // droid is the one row whose success branch is the EXIT CODE rather than a
    // phrase — `computer list` may legitimately print nothing — so an exit it does
    // not use is what makes it unreadable, not unrecognised text.
    const status = id === "droid" ? 2 : 0
    const r = interpretProbe(id, { status, stdout: "wat", stderr: "wat", env: {} })
    assert.equal(r.state, "unknown", id)
    assert.equal(r.source, null, id)
  }
})

test("interpretProbe: neither of the two unsafe probes is in the table", () => {
  // `amp threads list` opens a browser and blocks on stdin forever with no
  // credential; `prime whoami` writes user_id back into config.json, so it is a
  // write dressed as a read. Both were replaced by an offline command that fails
  // fast and still answers the question.
  assert.deepEqual(HARNESSES.amp.authArgs, ["usage"])
  assert.deepEqual(HARNESSES.prime.authArgs, ["model", "list"])
})

// ── amp and prime keep a plain key in their own config file ───────────────────
// Both probes answer "signed in" without saying how, so the FILE is the tie-break.
// Fixtures, not this machine: the reader is the thing under test.

test("amp reads its key from the default server's entry", () => {
  const f = HARNESSES.amp.valueFile
  assert.equal(f.read('{"apiKey@https://ampcode.com/":"amp-key"}'), "amp-key")
})

test("amp falls back to a sole entry when the server is not the default one", () => {
  // amp's server is configurable, so the key name is not fixed.
  assert.equal(HARNESSES.amp.valueFile.read('{"apiKey@https://amp.internal/":"self-hosted"}'), "self-hosted")
})

test("amp refuses to choose between two servers' keys", () => {
  // Picking one of two is the guess this table does not make — and handing a box the
  // wrong server's key fails at authentication, far from its cause.
  const two = '{"apiKey@https://amp.internal/":"a","apiKey@https://other/":"b"}'
  assert.equal(HARNESSES.amp.valueFile.read(two), null)
  // ...unless one of them IS the default, which is not a guess.
  const withDefault = '{"apiKey@https://ampcode.com/":"a","apiKey@https://other/":"b"}'
  assert.equal(HARNESSES.amp.valueFile.read(withDefault), "a")
})

test("amp ignores non-key entries in the same file", () => {
  assert.equal(HARNESSES.amp.valueFile.read('{"deviceId":"d","somethingElse":1}'), null)
})

test("prime reads api_key, and treats an empty one as absent", () => {
  assert.equal(HARNESSES.prime.valueFile.read('{"api_key":"pk-1","team_id":"t"}'), "pk-1")
  assert.equal(HARNESSES.prime.valueFile.read('{"api_key":"","team_id":"t"}'), null)
  assert.equal(HARNESSES.prime.valueFile.read('{"team_id":"t"}'), null)
})

test("droid and claude have no file reader, and must not grow one by accident", () => {
  // Both keep their credential in a store this plugin does not open — droid's is
  // encrypted beside its own key file, claude's is the macOS Keychain. ADR 0010
  // moved the OAuth line and deliberately left this one where it was.
  assert.equal(HARNESSES.droid.valueFile, undefined)
  assert.equal(HARNESSES.claude.valueFile, undefined)
})
