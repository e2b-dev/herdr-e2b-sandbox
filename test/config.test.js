// Unit tests for config resolution. Pure functions take a cfg object, so they run
// offline with no E2B call; the two that read a file are handed a path to a fixture
// under the OS temp dir, and never the developer's own config.
import { test } from "node:test"
import assert from "node:assert/strict"
import TOML from "@iarna/toml"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  resolveTemplate,
  resolveLifecycle,
  resolveCredentials,
  readCliConfig,
  templateRuleMatches,
  templateChoices,
  fleetTemplateChoices,
  resolveFleet,
  resolveEnvConfig,
  resolveEnv,
  describeRegion,
  resolveAuthConfig,
  readAuthConfig,
  discoveredSources,
  unresolvedForwards,
} from "../src/config.js"

test("resolveTemplate: no rules → default template", () => {
  const cfg = { template: "base", templateRules: [] }
  assert.equal(resolveTemplate("main", cfg), "base")
  assert.equal(resolveTemplate("", cfg), "base")
  assert.equal(resolveTemplate(undefined, cfg), "base")
})

test("resolveTemplate: first matching rule wins, else default", () => {
  const cfg = {
    template: "base",
    templateRules: [
      { pattern: "^e2b/cc/", template: "claude" },
      { pattern: "^e2b/", template: "opencode" },
    ],
  }
  assert.equal(resolveTemplate("e2b/cc/feature", cfg), "claude") // first match wins
  assert.equal(resolveTemplate("e2b/other", cfg), "opencode") // second rule
  assert.equal(resolveTemplate("feature/x", cfg), "base") // no rule → default
})

test("resolveTemplate: a bad regex is skipped, not fatal", () => {
  const cfg = {
    template: "base",
    templateRules: [
      { pattern: "[unterminated", template: "broken" },
      { pattern: "^feat/", template: "codex" },
    ],
  }
  assert.equal(resolveTemplate("feat/x", cfg), "codex")
  assert.equal(resolveTemplate("main", cfg), "base")
})

test("templateRuleMatches: only a matching rule counts as decided", () => {
  const cfg = { template: "base", templateRules: [{ pattern: "^bench/cc/", template: "claude" }] }
  assert.equal(templateRuleMatches("bench/cc/x", cfg), true)
  assert.equal(templateRuleMatches("feature/x", cfg), false)
  assert.equal(templateRuleMatches("", cfg), false)
  // A bad regex must not decide (or throw) — it's skipped, same as resolveTemplate.
  assert.equal(templateRuleMatches("x", { template: "base", templateRules: [{ pattern: "[", template: "y" }] }), false)
})

test("templateChoices: configured list + rule templates + default, deduped in order", () => {
  const cfg = {
    template: "base",
    templates: ["base", "opencode"],
    templateRules: [
      { pattern: "^bench/cc/", template: "claude" },
      { pattern: "^bench/cx/", template: "codex" },
      { pattern: "^other/", template: "opencode" }, // already listed → not repeated
    ],
  }
  assert.deepEqual(templateChoices(cfg), ["base", "opencode", "claude", "codex"])
  // Nothing configured → just the default, which the picker treats as "don't ask".
  assert.deepEqual(templateChoices({ template: "base", templates: [], templateRules: [] }), ["base"])
})

test("resolveLifecycle: default (nothing configured) → pause with a full memory snapshot", () => {
  // The default is a box you can come back to: paused, memory intact, woken on
  // the next connect. The snapshot kind is stated explicitly — the SDK's default
  // happens to agree today, but this call is the contract, not their default.
  assert.deepEqual(resolveLifecycle({}), {
    onTimeout: { action: "pause", keepMemory: true },
    autoResume: true,
  })
  assert.deepEqual(resolveLifecycle({ autoPause: true, autoResume: true, keepMemory: true }), {
    onTimeout: { action: "pause", keepMemory: true },
    autoResume: true,
  })
})

test("resolveLifecycle: auto_pause off → kill at the timeout, as before", () => {
  assert.deepEqual(resolveLifecycle({ autoPause: false }), { onTimeout: "kill" })
  // Killing has no snapshot, so the other keys can't soften it.
  assert.deepEqual(resolveLifecycle({ autoPause: false, keepMemory: false, autoResume: true }), {
    onTimeout: "kill",
  })
})

test("resolveLifecycle: filesystem-only snapshot needs auto_resume off", () => {
  assert.deepEqual(resolveLifecycle({ keepMemory: false, autoResume: false }), {
    onTimeout: { action: "pause", keepMemory: false },
    autoResume: false,
  })
})

test("resolveLifecycle: filesystem-only + auto-resume is rejected before the API", () => {
  // The SDK/API refuses this pair (a cold-boot snapshot can't be woken by
  // traffic); reject it here with a message that names both keys and the fix.
  for (const cfg of [{ keepMemory: false }, { keepMemory: false, autoResume: true }]) {
    assert.throws(() => resolveLifecycle(cfg), /keep_memory.*auto_resume|auto_resume.*keep_memory/s)
  }
})

test("resolveLifecycle: autoResume alone still defaults sensibly", () => {
  assert.deepEqual(resolveLifecycle({ autoResume: false }), {
    onTimeout: { action: "pause", keepMemory: true },
    autoResume: false,
  })
})

// --- the [fleet] block -------------------------------------------------------
// Fleet keeps no state (ADR-0001), so config is the only place these can come
// from. An unset key must yield the documented default, not undefined: the empty
// base means "the invoking checkout's HEAD", and `prefix` ends up inside a branch
// name, where an empty string would produce "/slug-claude-ab12".

test("resolveFleet: nothing configured → documented defaults", () => {
  // `agents` is the one key that is NOT empty by default — the shipped
  // skip-approvals commands live there and are asserted separately below.
  for (const r of [resolveFleet(), resolveFleet({})]) {
    assert.equal(r.base, "")
    assert.equal(r.prefix, "e2b")
    assert.deepEqual(r.roster, [])
    assert.deepEqual(r.seeds, {})
  }
})

test("resolveFleet: base and prefix are trimmed, blanks fall back", () => {
  const r = resolveFleet({ base: "  origin/main  ", prefix: " bench " })
  assert.equal(r.base, "origin/main")
  assert.equal(r.prefix, "bench")
  // Whitespace-only is not a choice — it's an empty key with a typo in it.
  assert.equal(resolveFleet({ base: "   ", prefix: "   " }).base, "")
  assert.equal(resolveFleet({ base: "   ", prefix: "   " }).prefix, "e2b")
  assert.equal(resolveFleet({ prefix: 7 }).prefix, "e2b")
})

test("resolveFleet: default_roster is a clean list of template names", () => {
  assert.deepEqual(resolveFleet({ default_roster: [" claude ", "codex"] }).roster, ["claude", "codex"])
  // A template appears in a roster at most once, and junk entries are dropped.
  assert.deepEqual(resolveFleet({ default_roster: ["claude", "claude", "", 3, null] }).roster, ["claude"])
  // Not a list → no roster, rather than a crash at picker time.
  assert.deepEqual(resolveFleet({ default_roster: "claude" }).roster, [])
})

test("resolveFleet: [fleet.agents] maps a template to the command that starts it", () => {
  const r = resolveFleet({ agents: { claude: "claude", codex: " codex --yolo ", base: "" } })
  assert.equal(r.agents.claude, "claude")
  assert.equal(r.agents.codex, "codex --yolo") // trimmed
  assert.equal(r.agents.base, "")
  // An empty command is meaningful — "plain shell, no agent" — so it survives,
  // while a non-string value is dropped as unusable and leaves the default alone.
  const junk = resolveFleet({ agents: { a: 1, b: null, c: "" } }).agents
  assert.equal(junk.c, "")
  assert.equal(Object.prototype.hasOwnProperty.call(junk, "a"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(junk, "b"), false)
  // Not a table at all → the shipped defaults, never an empty map.
  assert.equal(resolveFleet({ agents: "nope" }).agents.claude, "claude --dangerously-skip-permissions")
})

test("resolveFleet: [fleet.seed] maps a template to its first-run seeding command", () => {
  const r = resolveFleet({ seed: { mine: " my-cli --auth $MY_KEY ", claude: "" } })
  // Empty is meaningful here too — "seed nothing for this template", which must NOT
  // fall back to the shipped default (that lookup lives in src/fleet-seed.js).
  assert.deepEqual(r.seeds, { mine: "my-cli --auth $MY_KEY", claude: "" })
  assert.deepEqual(resolveFleet({ seed: { a: 1, b: null, c: "" } }).seeds, { c: "" })
  assert.deepEqual(resolveFleet({ seed: "nope" }).seeds, {})
})

// --- credentials: key + cluster must resolve as a PAIR -----------------------
// The bug these guard: a key from one source and a domain from another provision
// a box on the wrong cluster and *succeed*, because the mismatched pair is only
// ever caught by a 401 that never comes.

const CLI = { apiKey: "e2b_cli", domain: "e2b-juliett.dev" }

test("resolveCredentials: env wins over everything", () => {
  const r = resolveCredentials({
    env: { E2B_API_KEY: "e2b_env", E2B_DOMAIN: "e2b.dev" },
    secrets: { e2b_api_key: "e2b_cfg" },
    sandbox: { region: "eu" },
    cli: CLI,
  })
  assert.equal(r.apiKey, "e2b_env")
  assert.equal(r.domain, "e2b.dev")
  assert.equal(r.keySource, "env")
  assert.equal(r.credWarning, null)
})

test("resolveCredentials: CLI login supplies key AND cluster together", () => {
  const r = resolveCredentials({ cli: CLI })
  assert.equal(r.apiKey, "e2b_cli")
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.equal(r.keySource, "cli")
  assert.equal(r.domainSource, "cli")
})

test("resolveCredentials: a config key does NOT borrow the CLI's cluster", () => {
  const r = resolveCredentials({ secrets: { e2b_api_key: "e2b_cfg" }, cli: CLI })
  assert.equal(r.apiKey, "e2b_cfg")
  assert.equal(r.domain, null, "must fall back to the SDK default, not the CLI's cluster")
  assert.equal(r.domainSource, "sdk-default")
  assert.match(r.credWarning, /e2b-juliett\.dev/)
  assert.match(r.credWarning, /\[secrets\]/, "names the source the key actually came from")
})

test("resolveCredentials: same key in both places → the CLI's cluster is safe to use", () => {
  const r = resolveCredentials({ secrets: { e2b_api_key: CLI.apiKey }, cli: CLI })
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.equal(r.credWarning, null)
})

test("resolveCredentials: an explicit region silences the mismatch", () => {
  const r = resolveCredentials({
    secrets: { e2b_api_key: "e2b_cfg" },
    sandbox: { region: "eu" },
    cli: CLI,
  })
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.equal(r.credWarning, null)
})

test("resolveCredentials: nothing configured → nulls, never a hardcoded host", () => {
  const r = resolveCredentials()
  assert.equal(r.apiKey, null)
  assert.equal(r.domain, null)
  assert.equal(r.keySource, null)
})

test("readCliConfig: a missing or unparseable login is empty, never a throw", () => {
  assert.deepEqual(readCliConfig("/nonexistent/e2b/config.json"), {})
  assert.deepEqual(readCliConfig("/etc/hosts"), {})
})

// --- the herdr daemon's env is frozen, so it must not win ------------------
// herdr is long-lived: whatever E2B_* it inherited at launch never changes, and
// every plugin command inherits that snapshot. Switching regions afterwards has
// to take effect, so daemon-spawned commands demote the ambient values.

const DAEMON = { HERDR_PLUGIN_ID: "e2b-dev.herdr-e2b" }

test("resolveCredentials: a stale daemon E2B_DOMAIN loses to the CLI login", () => {
  const r = resolveCredentials({
    env: { ...DAEMON, E2B_DOMAIN: "e2b-juliett.dev", E2B_API_KEY: "e2b_old" },
    cli: { apiKey: "e2b_now", domain: "e2b.dev" },
  })
  assert.equal(r.domain, "e2b.dev", "must follow the current login, not herdr's launch env")
  assert.equal(r.apiKey, "e2b_now")
  assert.equal(r.domainSource, "cli")
  assert.match(r.credWarning, /stale E2B_DOMAIN/)
})

test("resolveCredentials: outside the daemon, an exported env still wins", () => {
  const r = resolveCredentials({
    env: { E2B_DOMAIN: "e2b-juliett.dev", E2B_API_KEY: "e2b_shell" },
    cli: { apiKey: "e2b_now", domain: "e2b.dev" },
  })
  assert.equal(r.domain, "e2b-juliett.dev", "a shell export is a decision just made")
  assert.equal(r.apiKey, "e2b_shell")
  assert.equal(r.credWarning, null)
})

test("resolveCredentials: daemon env is still a last resort when nothing else resolves", () => {
  const r = resolveCredentials({
    env: { ...DAEMON, E2B_DOMAIN: "e2b-juliett.dev", E2B_API_KEY: "e2b_only" },
  })
  assert.equal(r.apiKey, "e2b_only")
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.equal(r.domainSource, "env")
})

test("resolveCredentials: an explicit region still beats the CLI login", () => {
  const r = resolveCredentials({
    env: { ...DAEMON, E2B_DOMAIN: "e2b-juliett.dev" },
    sandbox: { region: "us" },
    cli: { apiKey: "e2b_now", domain: "e2b.dev" },
  })
  assert.equal(r.domain, null, "region us wins, and its answer is no domain")
  assert.equal(r.domainSource, "config")
})

// ── [sandbox.env] / [templates.<name>.env] ────────────────────────────────────

test("resolveEnvConfig: shared and per-template tables are read separately", () => {
  const r = resolveEnvConfig({
    sandbox: { env: { TZ: "Europe/Prague" }, template: "base" },
    templates: {
      claude: { env: { ANTHROPIC_API_KEY: "sk-ant-x" } },
      codex: { env: { OPENAI_API_KEY: "sk-y" } },
    },
  })
  assert.deepEqual(r.envShared, { TZ: "Europe/Prague" })
  assert.deepEqual(r.envByTemplate.claude, { ANTHROPIC_API_KEY: "sk-ant-x" })
  assert.deepEqual(r.envByTemplate.codex, { OPENAI_API_KEY: "sk-y" })
})

test("resolveEnvConfig: nothing configured → empty tables, never undefined", () => {
  const r = resolveEnvConfig()
  assert.deepEqual(r.envShared, {})
  assert.deepEqual(r.envByTemplate, {})
  assert.deepEqual(resolveEnvConfig({ sandbox: {}, templates: {} }).envByTemplate, {})
})

test("resolveEnvConfig: TOML numbers and booleans are stringified, structure is dropped", () => {
  // The SDK takes string values only, but a port or a flag is a reasonable thing
  // to write in this table — stringify those rather than silently losing them.
  const r = resolveEnvConfig({
    sandbox: { env: { PORT: 3000, DEBUG: true, NESTED: { a: 1 }, LIST: ["a"], "  ": "blank" } },
  })
  assert.deepEqual(r.envShared, { PORT: "3000", DEBUG: "true" })
})

test("resolveEnvConfig: a template section with no env contributes no entry", () => {
  // Otherwise resolveEnv would merge an empty object and report "something to
  // inject" for a template the user never gave any env.
  const r = resolveEnvConfig({ templates: { claude: {}, codex: { env: {} } } })
  assert.deepEqual(r.envByTemplate, {})
})

test("resolveEnv: the template's table is merged over the shared one", () => {
  const cfg = {
    envShared: { TZ: "UTC", SHARED: "yes" },
    envByTemplate: { claude: { TZ: "Europe/Prague", ANTHROPIC_API_KEY: "sk-ant-x" } },
  }
  assert.deepEqual(resolveEnv(cfg, "claude"), {
    TZ: "Europe/Prague",
    SHARED: "yes",
    ANTHROPIC_API_KEY: "sk-ant-x",
  })
})

test("resolveEnv: a box only gets its own template's credential", () => {
  // The whole point of keying by template: booting `base` must not hand it the
  // key for an agent it doesn't ship.
  const cfg = {
    envShared: {},
    envByTemplate: { claude: { ANTHROPIC_API_KEY: "sk-ant-x" }, codex: { OPENAI_API_KEY: "sk-y" } },
  }
  assert.deepEqual(resolveEnv(cfg, "codex"), { OPENAI_API_KEY: "sk-y" })
  assert.equal(resolveEnv(cfg, "base"), undefined)
})

test("resolveEnv: nothing to inject → undefined, so the create call can omit envs", () => {
  assert.equal(resolveEnv({ envShared: {}, envByTemplate: {} }, "claude"), undefined)
  assert.equal(resolveEnv({}, "claude"), undefined)
  assert.equal(resolveEnv(undefined, "claude"), undefined)
})

// ── the generated auth.toml, and the full precedence ladder ───────────────────
// `e2b-box auth` writes it, the loader reads it, and it sits UNDER everything the
// user wrote. These pin the reading and the ladder; test/harness-auth.test.js pins
// the writing.

test("resolveAuthConfig: a discovered value lands in the same shape as the user's own table", () => {
  const r = resolveAuthConfig({
    templates: {
      codex: { env: { OPENAI_API_KEY: "sk-from-a-file" } },
      claude: { forward: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" } },
    },
  })
  assert.deepEqual(r.envDiscovered, { codex: { OPENAI_API_KEY: "sk-from-a-file" } })
  assert.deepEqual(r.envForward, { claude: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" } })
})

test("resolveAuthConfig: a forward entry is a variable NAME, so only strings survive", () => {
  // A number or a table is not a variable name, and `env=""` on a sandbox is a
  // syntax error rather than a lookup. Neither may become one.
  const r = resolveAuthConfig({
    templates: { amp: { forward: { AMP_API_KEY: "AMP_API_KEY", A: 3, B: { c: 1 }, C: "  ", "  ": "X" } } },
  })
  assert.deepEqual(r.envForward, { amp: { AMP_API_KEY: "AMP_API_KEY" } })
})

test("resolveAuthConfig: nothing in the file → empty tables, never undefined", () => {
  assert.deepEqual(resolveAuthConfig(), { envDiscovered: {}, envForward: {}, envSession: {} })
  assert.deepEqual(resolveAuthConfig({ templates: { claude: {} } }).envDiscovered, {})
})

/** A fresh directory under the OS temp dir. Fixtures only — no test here ever
 * reads or writes the developer's own config. */
const tmpdir = () => mkdtempSync(path.join(os.tmpdir(), "herdr-e2b-auth-"))

test("readAuthConfig: an absent generated file resolves to nothing and does not throw", () => {
  const r = readAuthConfig(path.join(os.tmpdir(), "herdr-e2b-no-such-auth.toml"))
  assert.deepEqual(r, { envDiscovered: {}, envForward: {}, envSession: {} })
})

test("readAuthConfig: a malformed generated file resolves to nothing and does not throw", () => {
  // The established habit: an unparseable auxiliary file must never take the CLI
  // down. A half-written auth.toml is a bad discovery run, not a broken plugin.
  const file = path.join(tmpdir(), "auth.toml")
  writeFileSync(file, "[templates.claude.env\nANTHROPIC_API_KEY = ")
  assert.deepEqual(readAuthConfig(file), { envDiscovered: {}, envForward: {}, envSession: {} })
})

test("readAuthConfig: a written generated file is read back into the resolved shape", () => {
  const file = path.join(tmpdir(), "auth.toml")
  // All three sub-tables in one file, so the reader is pinned against the shape
  // `renderAuthToml` actually emits rather than against one kind at a time.
  writeFileSync(file, '[templates.codex.env]\nOPENAI_API_KEY = "sk-from-a-file"\n[templates.claude.forward]\nANTHROPIC_API_KEY = "ANTHROPIC_API_KEY"\n[templates.grok.session]\nvar = "GROK_AUTH_JSON"\nvalue = "{payload}"\nexpires = "2099-01-01T00:00:00.000Z"\n')
  assert.deepEqual(readAuthConfig(file), {
    envDiscovered: { codex: { OPENAI_API_KEY: "sk-from-a-file" } },
    envForward: { claude: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" } },
    envSession: { grok: { var: "GROK_AUTH_JSON", value: "{payload}", expires: "2099-01-01T00:00:00.000Z" } },
  })
})

// What the `open` picker draws beside each template. Reading only — the picker may
// never probe, so these pin that the annotation is a function of the generated file
// and nothing else.

test("discoveredSources: a stored value reads as `file`, a forwarded name as `env`", () => {
  // The two sub-tables ARE the two sources: `env` holds a value copied out of a
  // harness's own config file, `forward` holds a variable name seen in the shell.
  const cfg = {
    envDiscovered: { codex: { OPENAI_API_KEY: "sk-from-a-file" } },
    envForward: { claude: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" } },
  }
  assert.deepEqual(discoveredSources(cfg), { codex: "file", claude: "env" })
})

test("discoveredSources: a template with no entry gets no source, so the picker says nothing", () => {
  // `auth` never ran, or the harness is not in the table. Either way the picker has
  // nothing true to say about it, and a mark would be a claim rather than a finding.
  const cfg = { envDiscovered: { codex: { OPENAI_API_KEY: "x" } }, envForward: {} }
  assert.equal(discoveredSources(cfg).base, undefined)
  assert.equal(discoveredSources(cfg).claude, undefined)
})

test("discoveredSources: nothing discovered at all → nothing to annotate, never a throw", () => {
  assert.deepEqual(discoveredSources({}), {})
  assert.deepEqual(discoveredSources(), {})
})

test("discoveredSources: forwarding wins when a template has both, exactly as resolveEnv does", () => {
  // The annotation names the source of the value that would actually be INJECTED,
  // and resolveEnv puts a forwarded name over a stored one. Nothing emits both
  // today; this pins the two functions to the same tie-break for when something does.
  const cfg = {
    envDiscovered: { claude: { ANTHROPIC_API_KEY: "sk-copied-when-auth-ran" } },
    envForward: { claude: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" } },
  }
  assert.equal(discoveredSources(cfg).claude, "env")
})

test("resolveEnv: the whole ladder, in one place", () => {
  // shipped default < discovered < the user's shared table < the user's template
  // table. Four rungs, one variable each, plus one variable every rung sets — so
  // the order is asserted and not merely the presence of each.
  const cfg = {
    templateEnvDefaults: { claude: { SHIPPED: "default", LADDER: "1-shipped" } },
    envDiscovered: { claude: { DISCOVERED: "found", LADDER: "2-discovered" } },
    envForward: { claude: { FORWARDED: "HOST_NAME", LADDER_FWD: "HOST_LADDER" } },
    envShared: { SHARED: "mine", LADDER: "3-shared" },
    envByTemplate: { claude: { PER_TEMPLATE: "mine too", LADDER: "4-per-template" } },
  }
  assert.deepEqual(resolveEnv(cfg, "claude", { HOST_NAME: "forwarded-value", HOST_LADDER: "2-forwarded" }), {
    SHIPPED: "default",
    DISCOVERED: "found",
    FORWARDED: "forwarded-value",
    LADDER_FWD: "2-forwarded",
    SHARED: "mine",
    PER_TEMPLATE: "mine too",
    LADDER: "4-per-template",
  })
})

test("resolveEnv: a hand-written value beats a discovered one, from either user table", () => {
  // The promise the whole feature rests on. Both user tables are checked because
  // a discovered value that only loses to ONE of them is an override that cannot
  // override in the other.
  const discovered = { envDiscovered: { claude: { ANTHROPIC_API_KEY: "sk-discovered" } } }
  const forwarded = { envForward: { claude: { ANTHROPIC_API_KEY: "HOST_KEY" } } }
  const host = { HOST_KEY: "sk-from-the-shell" }
  const mine = { ANTHROPIC_API_KEY: "sk-mine" }

  assert.equal(resolveEnv({ ...discovered, envByTemplate: { claude: mine } }, "claude", host).ANTHROPIC_API_KEY, "sk-mine")
  assert.equal(resolveEnv({ ...discovered, envShared: mine }, "claude", host).ANTHROPIC_API_KEY, "sk-mine")
  assert.equal(resolveEnv({ ...forwarded, envByTemplate: { claude: mine } }, "claude", host).ANTHROPIC_API_KEY, "sk-mine")
  assert.equal(resolveEnv({ ...forwarded, envShared: mine }, "claude", host).ANTHROPIC_API_KEY, "sk-mine")
})

test("resolveEnv: a forwarded variable is read from the map passed in, not the process", () => {
  // The reason the signature changed. If this ever reads process.env, precedence
  // stops being pinnable by a test and starts depending on who ran the suite.
  const cfg = { envForward: { droid: { FACTORY_API_KEY: "FACTORY_API_KEY" } } }
  const before = process.env.FACTORY_API_KEY
  process.env.FACTORY_API_KEY = "sk-from-the-process"
  try {
    assert.deepEqual(resolveEnv(cfg, "droid", { FACTORY_API_KEY: "sk-from-the-map" }), {
      FACTORY_API_KEY: "sk-from-the-map",
    })
    assert.equal(resolveEnv(cfg, "droid", {}), undefined)
    assert.equal(resolveEnv(cfg, "droid"), undefined)
  } finally {
    // Restored rather than deleted: this suite must leave the environment exactly
    // as it found it, and a developer with a real FACTORY_API_KEY exported is not
    // a reason for a later test to see a different machine.
    if (before === undefined) delete process.env.FACTORY_API_KEY
    else process.env.FACTORY_API_KEY = before
  }
})

test("resolveEnv: a forwarded name beats a stored value for the same box variable", () => {
  // Both are discovery, so neither can beat a user table — this only settles which
  // half of the discovered rung wins. The forwarded one does: it reads this run's
  // environment, while the stored one is a copy from whenever `auth` last ran.
  const cfg = {
    envDiscovered: { claude: { ANTHROPIC_API_KEY: "sk-copied-when-auth-ran" } },
    envForward: { claude: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" } },
  }
  assert.equal(
    resolveEnv(cfg, "claude", { ANTHROPIC_API_KEY: "sk-in-the-shell-now" }).ANTHROPIC_API_KEY,
    "sk-in-the-shell-now",
  )
  // …and a name that resolves to nothing falls back to the stored value rather
  // than blanking it.
  assert.equal(resolveEnv(cfg, "claude", {}).ANTHROPIC_API_KEY, "sk-copied-when-auth-ran")
})

test("resolveEnv: the box gets the BOX variable, looked up under the HOST one", () => {
  // They differ for three of the seven harnesses. Getting this backwards produces
  // a box that looks configured and is not: codex authenticates from CODEX_API_KEY
  // here, and its box needs OPENAI_API_KEY.
  const cfg = { envForward: { codex: { OPENAI_API_KEY: "CODEX_API_KEY" } } }
  assert.deepEqual(resolveEnv(cfg, "codex", { CODEX_API_KEY: "sk-codex" }), { OPENAI_API_KEY: "sk-codex" })
})

test("resolveEnv: a forwarded name that holds nothing injects nothing", () => {
  // An empty string is not a credential, and injecting one is worse than injecting
  // none — the agent starts, reads it, and fails somewhere further from the cause.
  const cfg = { envForward: { amp: { AMP_API_KEY: "AMP_API_KEY" } } }
  assert.equal(resolveEnv(cfg, "amp", { AMP_API_KEY: "" }), undefined)
  assert.equal(resolveEnv(cfg, "amp", { AMP_API_KEY: "   " }), undefined)
  assert.equal(resolveEnv(cfg, "amp", { OTHER: "x" }), undefined)
})

test("resolveEnv: discovery for another template never reaches this box", () => {
  const cfg = {
    envDiscovered: { claude: { ANTHROPIC_API_KEY: "sk-ant" } },
    envForward: { codex: { OPENAI_API_KEY: "CODEX_API_KEY" } },
  }
  assert.equal(resolveEnv(cfg, "base", { CODEX_API_KEY: "sk-codex" }), undefined)
})

test("loadConfig: a box boots from the generated file the way it boots from config.toml", () => {
  // The loader wiring, end to end — the one thing the pure functions above cannot
  // prove. A child process, because the config dir is resolved once at import.
  const dir = tmpdir()
  writeFileSync(
    path.join(dir, "auth.toml"),
    '[templates.codex.env]\nOPENAI_API_KEY = "sk-discovered"\n[templates.claude.forward]\nANTHROPIC_API_KEY = "ANTHROPIC_API_KEY"\n[templates.amp.forward]\nAMP_API_KEY = "AMP_API_KEY"\n',
  )
  writeFileSync(path.join(dir, "config.toml"), '[templates.amp.env]\nAMP_API_KEY = "sk-hand-written"\n')

  const script =
    "const { loadConfig, resolveEnv } = await import(process.argv[1]);" +
    "const cfg = loadConfig();" +
    "console.log(JSON.stringify({" +
    '  codex: resolveEnv(cfg, "codex", {}),' +
    '  claude: resolveEnv(cfg, "claude", { ANTHROPIC_API_KEY: "sk-forwarded" }),' +
    '  amp: resolveEnv(cfg, "amp", { AMP_API_KEY: "sk-from-the-shell" }),' +
    "}))"
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, fileURLToPath(new URL("../src/config.js", import.meta.url))],
    { encoding: "utf8", env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir } },
  )
  const got = JSON.parse(out)
  assert.equal(got.codex.OPENAI_API_KEY, "sk-discovered", "a stored value reaches the box")
  assert.equal(got.claude.ANTHROPIC_API_KEY, "sk-forwarded", "a recorded NAME is forwarded from the given environment")
  // amp's shipped default still rides along, and the hand-written key still wins.
  assert.deepEqual(got.amp, { AMP_EXECUTOR: "sandbox", AMP_API_KEY: "sk-hand-written" })
})

// --- [fleet.agents]: unattended by default ------------------------------------
// A fleet member is an agent working with nobody watching the pane, in a
// disposable cloud sandbox. One that stops on its first permission prompt has
// produced nothing to compare, so the shipped commands carry each vendor's
// skip-approvals flag. These assert the exact strings because a typo in one is
// invisible until a member sits there waiting.

test("resolveFleet: every shipped agent starts unattended", () => {
  const { agents } = resolveFleet()
  assert.equal(agents.claude, "claude --dangerously-skip-permissions")
  assert.equal(agents.codex, "codex --dangerously-bypass-approvals-and-sandbox")
  assert.equal(agents.grok, "grok --always-approve")
  assert.equal(agents.amp, "amp --dangerously-allow-all")
  // Trailing `--prompt` is load-bearing: the fleet appends its task positionally,
  // and opencode's positional is a project DIRECTORY, not a prompt.
  assert.equal(agents.opencode, "opencode --auto --prompt")
})

test("resolveFleet: a template with no verified flag is not given an invented one", () => {
  // droid ships no default: fleet_agent_cmd falls back to the bare template name,
  // which is right where the CLI IS named after the template — a guessed flag
  // would just fail to start.
  const { agents } = resolveFleet()
  for (const t of ["droid", "base"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(agents, t), false, `${t} should have no default`)
  }
})

test("resolveFleet: prime is mapped because its CLI is not named after its template", () => {
  // The fallback is the template name, and prime's binary is `prime-agent` — the
  // bare fallback produced `bash: prime: command not found` in a live member.
  // Mapped to the binary and nothing else: no approve flag has been verified.
  const { agents } = resolveFleet()
  assert.equal(agents.prime, "prime-agent")
})

test("resolveFleet: [fleet.agents] merges OVER the defaults, per template", () => {
  // Overriding one agent must not empty the table for the others.
  const { agents } = resolveFleet({ agents: { claude: "claude --permission-mode plan" } })
  assert.equal(agents.claude, "claude --permission-mode plan")
  assert.equal(agents.codex, "codex --dangerously-bypass-approvals-and-sandbox")
})

test("resolveFleet: an empty command still switches a shipped default off", () => {
  // "plain shell, no agent" is what a control arm needs, so it has to beat a default.
  const { agents } = resolveFleet({ agents: { claude: "" } })
  assert.equal(agents.claude, "")
  assert.equal(agents.amp, "amp --dangerously-allow-all")
})

test("resolveEnv: amp gets the welcome-splash skip, and a user can still override it", () => {
  // Amp's "Welcome to Amp / Space to continue" splash has no settings-file switch;
  // the binary reads `process.env.AMP_EXECUTOR === "sandbox"` as an official skip.
  // Shipped as a default so an amp member is usable without anyone configuring it.
  const cfg = { templateEnvDefaults: { amp: { AMP_EXECUTOR: "sandbox" } } }
  assert.equal(resolveEnv(cfg, "amp").AMP_EXECUTOR, "sandbox")
  // Only amp, and only when nothing else claims the name — a default you cannot
  // override is not a default.
  assert.equal(resolveEnv(cfg, "claude"), undefined)
  assert.equal(
    resolveEnv({ ...cfg, envByTemplate: { amp: { AMP_EXECUTOR: "local" } } }, "amp").AMP_EXECUTOR,
    "local",
  )
})

test("fleetTemplateChoices: a fleet is agents only — the plain default is not a member", () => {
  // A fleet is several coding agents on one checkout, so a box with no agent in it
  // is a shell nobody asked for. `base` is also the one template whose name is not
  // a CLI, so a member built from it typed `base` into a sandbox shell and waited
  // for a TUI that never came.
  const cfg = { template: "base", templates: ["claude", "codex", "base"], templateRules: [] }
  assert.deepEqual(fleetTemplateChoices(cfg), ["claude", "codex"])
  // Filtered by the CONFIGURED default, not the literal "base", so someone whose
  // plain image is called something else gets the same treatment.
  const mine = { template: "plain", templates: ["plain", "claude"], templateRules: [] }
  assert.deepEqual(fleetTemplateChoices(mine), ["claude"])
  // And the box picker is untouched — one plain box is a fine thing to want.
  assert.deepEqual(templateChoices(cfg), ["claude", "codex", "base"])
})

// --- regions: a name a person picks, resolved to the domain the code speaks ---
// ADR-0006. `region` is sugar; every other module keeps receiving a domain, and
// box records are unchanged.

test("resolveCredentials: region 'eu' resolves to the EU domain", () => {
  const r = resolveCredentials({ sandbox: { region: "eu" }, secrets: { e2b_api_key: "e2b_cfg" } })
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.equal(r.domainSource, "config")
})

test("resolveCredentials: region 'us' means NO domain, and does not borrow the CLI's", () => {
  // The US region's correct value is absent — the SDK defaults to e2b.app and the
  // CLI to e2b.dev, so no single string is right for both. Naming US while logged
  // into the EU must not keep provisioning in the EU.
  const r = resolveCredentials({ sandbox: { region: "us" }, cli: CLI })
  assert.equal(r.domain, null)
  assert.equal(r.domainSource, "config")
})

test("resolveCredentials: an unknown region fails, naming the valid ones", () => {
  assert.throws(() => resolveCredentials({ sandbox: { region: "apac" } }), (e) => {
    assert.match(e.message, /apac/)
    assert.match(e.message, /us/)
    assert.match(e.message, /eu/)
    return true
  })
})

test("resolveCredentials: region is case- and space-insensitive", () => {
  assert.equal(resolveCredentials({ sandbox: { region: " EU " } }).domain, "e2b-juliett.dev")
})

test("resolveCredentials: no region behaves exactly as before", () => {
  const r = resolveCredentials({ cli: CLI })
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.equal(r.domainSource, "cli")
})

// --- a namespaced template's config keys, exactly as the example documents ---
// `<project>/<template>` contains a `/`, so its TOML table header must be quoted.
// Unquoted the table simply never matches the template, the box boots with no
// credential, and the agent opens on its sign-in screen — a silent failure worth
// pinning against the documented spelling rather than trusting prose.

test("config: a quoted namespaced [templates.<name>.env] reaches that template", () => {
  const file = TOML.parse(
    '[sandbox.env]\nTZ = "Europe/Prague"\n' +
      '[templates."ondrejs-project/herdr-agents".env]\nANTHROPIC_API_KEY = "sk-ant-x"\n',
  )
  const cfg = resolveEnvConfig({ sandbox: file.sandbox, templates: file.templates })
  assert.deepEqual(resolveEnv(cfg, "ondrejs-project/herdr-agents"), {
    TZ: "Europe/Prague",
    ANTHROPIC_API_KEY: "sk-ant-x",
  })
  // The bare alias is a DIFFERENT key — the plugin never composes or strips a
  // prefix, so a table written for one name does not leak to the other.
  assert.deepEqual(resolveEnv(cfg, "herdr-agents"), { TZ: "Europe/Prague" })
})

test("config: a quoted namespaced [fleet.agents] key reaches that template", () => {
  const file = TOML.parse(
    '[fleet.agents]\nclaude = "claude --x"\n' +
      '"ondrejs-project/herdr-agents" = "claude --dangerously-skip-permissions"\n',
  )
  const fleet = resolveFleet(file.fleet)
  assert.equal(
    fleet.agents["ondrejs-project/herdr-agents"],
    "claude --dangerously-skip-permissions",
  )
})

// --- one API key per region -------------------------------------------------
// A key belongs to exactly one region, and herdr cannot see a shell-level region
// switch — so config.toml IS the switch here. Holding both keys means changing
// `region` moves the credential with it, and the pair can never fall out of step.

test("resolveCredentials: region 'eu' picks the EU key", () => {
  const r = resolveCredentials({
    sandbox: { region: "eu" },
    secrets: { e2b_api_key_us: "e2b_us", e2b_api_key_eu: "e2b_eu" },
  })
  assert.equal(r.apiKey, "e2b_eu")
  assert.equal(r.domain, "e2b-juliett.dev")
})

test("resolveCredentials: no key for the active region falls back to the single key", () => {
  const r = resolveCredentials({
    sandbox: { region: "eu" },
    secrets: { e2b_api_key: "e2b_plain", e2b_api_key_us: "e2b_us" },
  })
  assert.equal(r.apiKey, "e2b_plain", "the US key must not be used for the EU region")
})

test("resolveCredentials: the other region's key is never used, for any input", () => {
  // The whole reason to store both is that only one can ever be right. If the
  // wrong one could leak through, holding both would be worse than holding one.
  const secrets = { e2b_api_key_us: "e2b_us", e2b_api_key_eu: "e2b_eu" }
  assert.equal(resolveCredentials({ sandbox: { region: "us" }, secrets }).apiKey, "e2b_us")
  assert.equal(resolveCredentials({ sandbox: { region: "eu" }, secrets }).apiKey, "e2b_eu")
  // No region named at all is the US region, so it is the US key.
  assert.equal(resolveCredentials({ secrets }).apiKey, "e2b_us")
})

test("resolveCredentials: env E2B_API_KEY still beats every config key", () => {
  const r = resolveCredentials({
    env: { E2B_API_KEY: "e2b_env" },
    sandbox: { region: "eu" },
    secrets: { e2b_api_key_eu: "e2b_eu", e2b_api_key: "e2b_plain" },
  })
  assert.equal(r.apiKey, "e2b_env")
  assert.equal(r.keySource, "env")
})

test("resolveCredentials: with no key anywhere, nothing changes", () => {
  const r = resolveCredentials({ sandbox: { region: "eu" } })
  assert.equal(r.apiKey, null)
  assert.equal(r.keySource, null)
})

test("resolveCredentials: a region pins the domain, so nothing is a guess", () => {
  // The "cluster is a guess" warning exists for a config key whose region is
  // unknown. Naming a region answers that question outright — warning here would
  // tell the user to pin something they just pinned.
  const r = resolveCredentials({
    sandbox: { region: "eu" },
    secrets: { e2b_api_key: "e2b_cfg" },
    cli: { apiKey: "e2b_cli", domain: "e2b.dev" },
  })
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.equal(r.credWarning, null)
})

test("resolveCredentials: the guess warning names the key line it wants edited", () => {
  const r = resolveCredentials({
    secrets: { e2b_api_key_us: "e2b_us" },
    cli: { apiKey: "e2b_cli", domain: "e2b-juliett.dev" },
  })
  assert.match(r.credWarning, /e2b_api_key_us/, "names the region key, not the plain one")
})

// --- a configured REGION and the frozen daemon env --------------------------
// Only `domain` was ever covered against herdr's frozen environment. `region` is
// the key users are now told to reach for, so it needs the same guarantees —
// and it is the one most likely to be written while a stale E2B_DOMAIN is
// already in herdr's launch snapshot, because that is exactly the moment someone
// switches region.

test("resolveCredentials: a configured region beats a daemon-inherited E2B_DOMAIN", () => {
  const r = resolveCredentials({
    env: { ...DAEMON, E2B_DOMAIN: "e2b-juliett.dev" },
    sandbox: { region: "us" },
    secrets: { e2b_api_key: "e2b_cfg" },
  })
  // The strongest case: config says US, whose answer is NO domain, while the
  // frozen env says EU. Config must win, and win all the way to null.
  assert.equal(r.domain, null)
  assert.equal(r.domainSource, "config")
})

test("resolveCredentials: the stale-domain warning names what was ignored and what was used", () => {
  const r = resolveCredentials({
    env: { ...DAEMON, E2B_DOMAIN: "e2b.dev" },
    sandbox: { region: "eu" },
    secrets: { e2b_api_key: "e2b_cfg" },
  })
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.match(r.credWarning, /stale E2B_DOMAIN/)
  assert.match(r.credWarning, /e2b\.dev/, "names the value it ignored")
  assert.match(r.credWarning, /e2b-juliett\.dev/, "names the value it used instead")
})

test("resolveCredentials: region 'us' under the daemon says so in the warning", () => {
  // US resolves to no domain at all, so the warning has to describe the absence
  // rather than print an empty one.
  const r = resolveCredentials({
    env: { ...DAEMON, E2B_DOMAIN: "e2b-juliett.dev" },
    sandbox: { region: "us" },
  })
  assert.match(r.credWarning, /the SDK default/)
})

test("resolveCredentials: outside the daemon, an exported E2B_DOMAIN still beats a region", () => {
  // A shell export in a command you just typed is a decision you just made, and
  // stays above the config file — the demotion applies only to herdr's snapshot.
  const r = resolveCredentials({
    env: { E2B_DOMAIN: "e2b.dev" },
    sandbox: { region: "eu" },
    secrets: { e2b_api_key: "e2b_cfg" },
  })
  assert.equal(r.domain, "e2b.dev")
  assert.equal(r.domainSource, "env")
  assert.equal(r.credWarning, null)
})

test("resolveCredentials: no region and no inherited domain is unchanged", () => {
  const r = resolveCredentials({
    env: { ...DAEMON },
    cli: { apiKey: "e2b_cli", domain: "e2b-juliett.dev" },
  })
  assert.equal(r.domain, "e2b-juliett.dev")
  assert.equal(r.domainSource, "cli")
  assert.equal(r.credWarning, null)
})

// --- naming the region in a message -----------------------------------------
// "template 'x' not found" is the signature symptom of asking the WRONG region,
// so the region is the missing half of that diagnosis.

test("describeRegion: a named region is named, by its name", () => {
  assert.equal(describeRegion("e2b-juliett.dev"), "EU (e2b-juliett.dev)")
})

test("describeRegion: no domain is the default region, said out loud", () => {
  // US resolves to no domain at all, so there is nothing to print — but "" in a
  // sentence reads as a bug, and the user still needs to know where we looked.
  assert.equal(describeRegion(null), "US (the default region)")
  assert.equal(describeRegion(undefined), "US (the default region)")
  assert.equal(describeRegion(""), "US (the default region)")
})

test("describeRegion: a host that names no region is printed as itself", () => {
  // A host outside the two regions has no name to give, and inventing one would be
  // worse than the host.
  assert.equal(describeRegion("your-own-e2b-host.example"), "your-own-e2b-host.example")
})

// --- US is one environment reachable at two hostnames -----------------------
// api.e2b.app is the current production host and the SDK's default; api.e2b.dev
// is the older name kept on a compatibility path. Both answer, and both are the
// same environment — not two regions. So pinning either by hand is still US, and
// must still select the US key.

test("describeRegion: a US hostname is named as US, not printed raw", () => {
  assert.equal(describeRegion("e2b.app"), "US (e2b.app)")
  assert.equal(describeRegion("e2b.dev"), "US (e2b.dev)")
})

test("resolveCredentials: [sandbox] domain is rejected, and names the region to use", () => {
  // Ignoring it would move every box of an existing EU user to US without a word.
  assert.throws(() => resolveCredentials({ sandbox: { domain: "e2b-juliett.dev" } }), (e) => {
    assert.match(e.message, /no longer a config key/)
    assert.match(e.message, /region = "eu"/, "names the exact replacement")
    return true
  })
  // A host with no region name still errors, pointing at the two that exist.
  assert.throws(
    () => resolveCredentials({ sandbox: { domain: "your-own-e2b-host.example" } }),
    /region = "us" or "eu"/,
  )
})

// ── ADR 0007: a discovered session outranks the user's own table ───────────────
// The one place discovery is allowed to beat a hand-written value, so it is pinned
// here rather than left to inspection — and so is every way it must NOT.

const sessionCfg = (expires) => ({
  envByTemplate: { codex: { OPENAI_API_KEY: "sk-hand-written" } },
  envSession: { codex: { var: "CODEX_AUTH_JSON", value: "{session}", expires } },
})
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString()

test("a live session beats the user's own [templates.<name>.env]", () => {
  const env = resolveEnv(sessionCfg(inDays(9)), "codex", {})
  assert.equal(env.CODEX_AUTH_JSON, "{session}")
  // The hand-written key is still delivered — it is outranked for the box's choice
  // of credential, not deleted from the environment.
  assert.equal(env.OPENAI_API_KEY, "sk-hand-written")
})

test("an EXPIRED session is not injected at all", () => {
  const env = resolveEnv(sessionCfg(inDays(-1)), "codex", {})
  assert.equal(env.CODEX_AUTH_JSON, undefined)
  // ...and the hand-written value it would have outranked still reaches the box, so
  // an expired session degrades to a working credential rather than a sign-in screen.
  assert.equal(env.OPENAI_API_KEY, "sk-hand-written")
})

test("a session with an unparseable expiry is treated as expired", () => {
  assert.equal(resolveEnv(sessionCfg("not a date"), "codex", {}).CODEX_AUTH_JSON, undefined)
})

test("prefer = 'env' takes the precedence back", () => {
  const cfg = { ...sessionCfg(inDays(9)), templatePrefer: { codex: "env" } }
  assert.equal(resolveEnv(cfg, "codex", {}).CODEX_AUTH_JSON, undefined)
  assert.equal(resolveEnv(cfg, "codex", {}).OPENAI_API_KEY, "sk-hand-written")
})

test("prefer applies only to the template it names", () => {
  const cfg = {
    templatePrefer: { claude: "env" },
    envSession: { codex: { var: "CODEX_AUTH_JSON", value: "{s}", expires: inDays(9) } },
  }
  assert.equal(resolveEnv(cfg, "codex", {}).CODEX_AUTH_JSON, "{s}")
})

test("resolveAuthConfig refuses a session missing any of var/value/expires", () => {
  const partial = { templates: { codex: { session: { var: "V", value: "x" } } } }
  assert.deepEqual(resolveAuthConfig(partial).envSession, {})
})

test("resolveEnvConfig reads prefer only for the exact value 'env'", () => {
  const t = { codex: { prefer: "env" }, claude: { prefer: "session" }, grok: { prefer: "ENV " } }
  assert.deepEqual(resolveEnvConfig({ templates: t }).templatePrefer, { codex: "env" })
})

test("discoveredSources tells a live session from a dead one", () => {
  assert.equal(discoveredSources({ envSession: { codex: { expires: inDays(9) } } }).codex, "session")
  assert.equal(
    discoveredSources({ envSession: { codex: { expires: inDays(-1) } } }).codex,
    "session-expired",
  )
})

// ── 08: a forwarded name that resolves to nothing must be nameable ─────────────
// The failure this catches arrives disguised as success — `auth` says `key found`,
// the box boots unauthenticated, and nothing connects the two.

test("unresolvedForwards names a recorded variable the environment does not hold", () => {
  const cfg = { envForward: { grok: { XAI_API_KEY: "XAI_API_KEY" } } }
  assert.deepEqual(unresolvedForwards(cfg, "grok", {}), ["XAI_API_KEY"])
  assert.deepEqual(unresolvedForwards(cfg, "grok", { XAI_API_KEY: "xai-live" }), [])
})

test("unresolvedForwards treats a blank value as missing", () => {
  // An empty credential fails further from its cause than an absent one: the agent
  // boots, reads it, and dies authenticating.
  const cfg = { envForward: { grok: { XAI_API_KEY: "XAI_API_KEY" } } }
  assert.deepEqual(unresolvedForwards(cfg, "grok", { XAI_API_KEY: "   " }), ["XAI_API_KEY"])
})

test("unresolvedForwards names the HOST variable, which is what the user must export", () => {
  // Three harnesses are found under one name and injected under another; telling
  // the user to export the box's name would send them to fix the wrong thing.
  const cfg = { envForward: { codex: { OPENAI_API_KEY: "CODEX_API_KEY" } } }
  assert.deepEqual(unresolvedForwards(cfg, "codex", {}), ["CODEX_API_KEY"])
})

test("unresolvedForwards is silent for a template with nothing forwarded", () => {
  assert.deepEqual(unresolvedForwards({ envForward: { grok: {} } }, "claude", {}), [])
  assert.deepEqual(unresolvedForwards({}, "grok", {}), [])
})
