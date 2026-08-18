// Unit tests for config resolution — no E2B calls, no filesystem config.
// resolveTemplate/resolveLifecycle take a cfg object, so they're pure and offline.
import { test } from "node:test"
import assert from "node:assert/strict"
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
