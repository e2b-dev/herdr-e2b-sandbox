// Unit tests for config resolution — no E2B calls, no filesystem config.
// resolveTemplate/resolveLifecycle take a cfg object, so they're pure and offline.
import { test } from "node:test"
import assert from "node:assert/strict"
import TOML from "@iarna/toml"
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

test("resolveLifecycle: autoPause off → kill", () => {
  assert.deepEqual(resolveLifecycle({ autoPause: false }), { onTimeout: "kill" })
})

test("resolveLifecycle: autoPause on → pause + autoResume", () => {
  assert.deepEqual(resolveLifecycle({ autoPause: true, autoResume: true }), {
    onTimeout: "pause",
    autoResume: true,
  })
  assert.deepEqual(resolveLifecycle({ autoPause: true, autoResume: false }), {
    onTimeout: "pause",
    autoResume: false,
  })
  // autoResume defaults to true when unset
  assert.deepEqual(resolveLifecycle({ autoPause: true }), {
    onTimeout: "pause",
    autoResume: true,
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
    sandbox: { domain: "cfg.dev" },
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

test("resolveCredentials: an explicit [sandbox].domain silences the mismatch", () => {
  const r = resolveCredentials({
    secrets: { e2b_api_key: "e2b_cfg" },
    sandbox: { domain: "pinned.dev" },
    cli: CLI,
  })
  assert.equal(r.domain, "pinned.dev")
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

test("resolveCredentials: an explicit [sandbox].domain still beats the CLI login", () => {
  const r = resolveCredentials({
    env: { ...DAEMON, E2B_DOMAIN: "e2b-juliett.dev" },
    sandbox: { domain: "pinned.dev" },
    cli: { apiKey: "e2b_now", domain: "e2b.dev" },
  })
  assert.equal(r.domain, "pinned.dev")
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

test("resolveCredentials: an explicit domain outranks a region", () => {
  const r = resolveCredentials({ sandbox: { region: "eu", domain: "your-own-e2b-host.example" } })
  assert.equal(r.domain, "your-own-e2b-host.example")
})

test("resolveCredentials: an unknown region fails, naming the valid ones", () => {
  assert.throws(() => resolveCredentials({ sandbox: { region: "apac" } }), (e) => {
    assert.match(e.message, /apac/)
    assert.match(e.message, /us/)
    assert.match(e.message, /eu/)
    assert.match(e.message, /domain/, "points at the escape hatch for other clusters")
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

test("resolveCredentials: a domain that names a region picks that region's key", () => {
  // Someone who pinned the domain before regions existed gets the same behaviour
  // as someone who named the region — it is one table, read backwards.
  const r = resolveCredentials({
    sandbox: { domain: "e2b-juliett.dev" },
    secrets: { e2b_api_key_us: "e2b_us", e2b_api_key_eu: "e2b_eu" },
  })
  assert.equal(r.apiKey, "e2b_eu")
})

test("resolveCredentials: a domain naming no region borrows no region's key", () => {
  // A host outside the two regions. Silently reaching for the US key would send a
  // credential to a cluster it has no business on.
  const r = resolveCredentials({
    sandbox: { domain: "your-own-e2b-host.example" },
    secrets: { e2b_api_key_us: "e2b_us", e2b_api_key: "e2b_plain" },
  })
  assert.equal(r.apiKey, "e2b_plain")
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
