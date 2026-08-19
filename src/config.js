import { readFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import TOML from "@iarna/toml"

// Plugin config dir. Prefer herdr's own HERDR_PLUGIN_CONFIG_DIR — the docs call
// it the place for "user-editable config such as .env files", and it is the only
// value herdr actually promises; the XDG path below is where it points today, not
// a contract. Keep IN SYNC with bin/lib/paths.sh and install.sh.
const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ||
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "herdr/plugins/config/e2b-dev.herdr-e2b",
  )

/** The config file itself. Exported so error messages can name the path the
 * plugin will actually read, not the one it used to hardcode. */
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.toml")

// Where the `e2b` CLI keeps its login (@e2b/cli USER_CONFIG_PATH — hardcoded
// there, no env override, no XDG). The SDK itself reads NOTHING from disk, so
// this file is our only fallback source for a key, and the only one that also
// knows which cluster you are logged into.
const CLI_CONFIG_PATH = path.join(os.homedir(), ".e2b", "config.json")

const DEFAULTS = {
  // Safe minimal default that always exists. For real work build a bigger
  // custom template (more disk/CPU + your toolchain) and set it here — see the
  // README "Recommended: a bigger custom template" and install.sh.
  template: "base",
  templateRules: [], // [{pattern, template}] per-branch overrides
  // The `open` picker's menu, in the order shown. Ships with the plugin so the
  // picker is useful out of the box; `[sandbox] templates` in config REPLACES it.
  // These are E2B's PUBLIC agent templates (https://e2b.dev/docs/agents) that
  // exist as real templates — the SDK integrations in those docs (LangChain,
  // CrewAI, Mastra, ADK, OpenAI Agents SDK, …) have nothing to boot. Templates
  // are per-cluster, so a name here can still 404 on yours; provisioning falls
  // back to `base` and says so. Re-check this list when E2B publishes new agent
  // templates — it is hand-maintained, not fetched.
  templates: [
    "claude",
    "codex",
    "opencode",
    "amp",
    "grok",
    "droid",
    "prime",
    // `pi` is deliberately absent: its template needs config of its own before it
    // is usable, so offering it in the picker only produces a box that can't work.
    // Add it back with `[sandbox] templates` once that config exists.
    // The fallback everyone can boot. Whichever template is the DEFAULT is hoisted
    // to the top of the chooser and pre-selected, so this position is just where
    // it sits when something else is the default.
    "base",
  ],
  // [fleet] — `e2b-fleet`'s side of the config. A fleet is a batch, not a tracked
  // object (ADR-0001), so these four keys are everything it knows about itself.
  fleetBase: "", // "" = branch members off the invoking checkout's HEAD
  fleetPrefix: "e2b", // <prefix>/<slug>-<template>-<rand4> — also the fleet's id
  fleetRoster: [], // templates pre-ticked in the roster picker (NOT a second template list)
  // template → the command that starts its agent ("" = plain shell, no agent).
  //
  // Each default carries that agent's "don't ask me about every tool call" flag,
  // because a fleet member is an agent working UNATTENDED in a disposable cloud
  // sandbox — nobody is watching the pane to approve an edit, and a member that
  // stops on its first permission prompt has produced nothing to compare. This is
  // the environment those flags are documented for; the same defaults would be
  // wrong on a laptop, which is why they live here and not in `e2b-box open`.
  //
  // Worth knowing what it does and does not buy: the box is isolated from your
  // machine, but it has network egress and holds the key we injected, so an agent
  // talked into something by the repo it is reading can still spend that key. The
  // protection is that the box is disposable and the key is scoped, not that the
  // agent is constrained.
  //
  // Flags verified against each vendor's own docs, not guessed. Every one is
  // overridable per template with `[fleet.agents]`; an agent nobody has verified a
  // flag for (droid, prime) is started bare rather than with an invented one.
  fleetAgents: {
    claude: "claude --dangerously-skip-permissions",
    // Bypasses the approval prompts AND Codex's own OS sandbox. The second half
    // is the point inside E2B: Codex sandboxing itself within a sandbox blocks
    // network and writes outside the workspace for no added safety.
    codex: "codex --dangerously-bypass-approvals-and-sandbox",
    grok: "grok --always-approve",
    amp: "amp --dangerously-allow-all",
    // Ends in `--prompt` ON PURPOSE: the fleet appends its task as one positional
    // argument, and opencode's default-command positional is a PROJECT DIRECTORY
    // (`opencode [project]`), so `opencode --auto "fix the bug"` means "cd into
    // ./fix the bug" and dies. A trailing `--prompt` makes the appended task the
    // flag's value instead, and a bare trailing `--prompt` (no task) parses as an
    // empty string and boots the TUI normally — both verified live on v1.18.18.
    opencode: "opencode --auto --prompt",
    // The one template whose CLI is NOT named after it: the binary is
    // `prime-agent` (customer-starter-templates/templates/prime/README.md), so
    // the name-yourself default produced `bash: prime: command not found`.
    // No approve flag is listed here because none has been verified — a made-up
    // one would just fail to launch, which is worse than an extra prompt.
    prime: "prime-agent",
  },
  // Environment a template's box needs to come up USABLE, merged UNDER anything
  // `[templates.<name>.env]` says, so a user can always override it. This is for
  // behaviour, never for credentials: a key belongs in the user's own config.
  //
  // amp: Amp opens on a full-screen "Welcome to Amp / Space to continue" splash
  // that no settings file switches off — its own `amp.showWelcome` is a command
  // to show it AGAIN, and the dismissal lives in internal state a fresh box has
  // never had. The binary reads
  //     welcomeDismissed: E.neoWelcomeDismissed || process.env.AMP_EXECUTOR === "sandbox"
  // so this is an official skip rather than a trick, and it also stops Amp
  // initialising MCP servers a box does not have. Live-verified in a box.
  templateEnvDefaults: {
    amp: { AMP_EXECUTOR: "sandbox" },
  },
  fleetSeeds: {}, // template → command that seeds its agent's first-run state ("" = none)
  sandboxTimeoutMs: 60 * 60 * 1000, // 1h
  autoPause: true, // onTimeout: pause (not kill) the sandbox; state preserved
  keepMemory: true, // only when autoPause: pause with a full memory snapshot (vs filesystem-only)
  autoResume: true, // only when autoPause: wake the sandbox on connect (vs explicit resume)
  projectPath: "/home/user/project", // E2B's conventional working dir
  serverPort: 3000,
  batchSize: 40,
  ignore: [
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    ".turbo",
    ".cache",
    "target",
    ".venv",
    "__pycache__",
    ".DS_Store",
    ".env",
    ".env.local",
  ],
}

/** Coerce to a positive integer, else the default (guards zero/negative/NaN — a
 * zero batch size would infinite-loop the upload/download chunkers). */
function posInt(v, dflt) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** Trim a config string, or fall back — a whitespace-only value is a typo'd
 * empty key, never a choice. */
function str(v, dflt) {
  return typeof v === "string" && v.trim() ? v.trim() : dflt
}

/**
 * Resolve the `[fleet]` block (and its `[fleet.agents]` sub-table) over the
 * defaults. Pure — takes the parsed section, so it is testable without disk.
 *
 * - `base`   the ref members branch from; "" means the invoking checkout's HEAD
 * - `prefix` the branch namespace, which IS the fleet id (ADR-0001), so it can
 *            never resolve to "" or the branch would start with "/"
 * - `roster` templates pre-ticked in the picker; it only marks rows in the
 *            existing `[sandbox] templates` list, it does not add any
 * - `agents` template → the command that starts that template's agent. An empty
 *            command is meaningful ("plain shell, no agent") and is kept.
 * - `seeds`  template → the shell command run INSIDE that template's box to seed
 *            its agent's first-run state, so a member arrives past the welcome
 *            wizard. Same empty-is-meaningful rule ("seed nothing"); src/fleet-seed.js
 *            owns the shipped defaults and merges this over them.
 */
export function resolveFleet(fleet = {}) {
  const f = fleet && typeof fleet === "object" ? fleet : {}
  const roster = Array.isArray(f.default_roster)
    ? [...new Set(f.default_roster.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()))]
    : DEFAULTS.fleetRoster
  // Config is merged OVER the shipped defaults, per template, so overriding
  // `claude` leaves `codex` on its default instead of emptying the table. An
  // entry set to "" still wins — that is the deliberate "plain shell, no agent"
  // a control arm needs, and it must be able to switch a default off.
  const agents = { ...DEFAULTS.fleetAgents }
  if (f.agents && typeof f.agents === "object" && !Array.isArray(f.agents)) {
    for (const [template, command] of Object.entries(f.agents)) {
      if (typeof command === "string") agents[template] = command.trim()
    }
  }
  const seeds = {}
  if (f.seed && typeof f.seed === "object" && !Array.isArray(f.seed)) {
    for (const [template, command] of Object.entries(f.seed)) {
      if (typeof command === "string") seeds[template] = command.trim()
    }
  }
  return {
    base: str(f.base, DEFAULTS.fleetBase),
    prefix: str(f.prefix, DEFAULTS.fleetPrefix),
    roster,
    agents,
    seeds,
  }
}

/**
 * Normalize one `env` table into a `{NAME: "value"}` map the SDK will accept.
 * Pure. TOML gives us numbers and booleans too; E2B env values must be strings,
 * so those are stringified rather than dropped (a port or a `true` is a
 * perfectly reasonable thing to put in this table). Anything structural — a
 * nested table, an array — has no string form and is skipped, and so is a blank
 * name: `env=` on a sandbox is a syntax error, not a variable.
 */
function envTable(raw) {
  const out = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  for (const [name, value] of Object.entries(raw)) {
    const key = String(name).trim()
    if (!key) continue
    const t = typeof value
    if (t === "string" || t === "number" || t === "boolean") out[key] = String(value)
  }
  return out
}

/**
 * The `[sandbox.env]` / `[templates.<name>.env]` pair, normalized. Pure — takes
 * the parsed sections, so it is testable without disk.
 *
 * Two tables rather than one because the two questions are different: "what does
 * every box need" (a proxy, a locale) versus "what does a box booted from THIS
 * image need" (the credential for the coding agent that image ships). Keyed by
 * template, not by agent: a Template is what a box boots from, and it is the
 * only thing we know about a box at create time. See CONTEXT.md.
 */
export function resolveEnvConfig({ sandbox = {}, templates = {} } = {}) {
  const byTemplate = {}
  if (templates && typeof templates === "object" && !Array.isArray(templates)) {
    for (const [template, section] of Object.entries(templates)) {
      const name = String(template).trim()
      if (!name) continue
      const env = envTable(section?.env)
      if (Object.keys(env).length) byTemplate[name] = env
    }
  }
  return { envShared: envTable(sandbox?.env), envByTemplate: byTemplate }
}

/**
 * The env a box booting from `template` should get: the shared table, with that
 * template's table merged over it. Returns `undefined` when there is nothing to
 * inject, so the create call can omit `envs` entirely rather than pass `{}`.
 *
 * Never persisted: this map goes to `Sandbox.create` and nowhere else. It is not
 * written to the box record and must not be logged — the record is world-readable
 * state and the log is `herdr plugin log list`.
 */
export function resolveEnv(cfg, template) {
  // Shipped defaults first, so the user's own tables win over them: an override
  // that cannot override is a default nobody can escape.
  const merged = {
    ...(cfg?.templateEnvDefaults?.[template] || {}),
    ...(cfg?.envShared || {}),
    ...(cfg?.envByTemplate?.[template] || {}),
  }
  return Object.keys(merged).length ? merged : undefined
}

/**
 * Read the `e2b` CLI login. Private, undocumented format (it carries its own
 * `version` and the CLI already ships a "config is deprecated" path), so every
 * field is optional and anything unparseable degrades to {} — a broken login
 * file must never take e2b-box down.
 *
 * The cluster is not stored as a field; it is derivable from the OAuth endpoint
 * (`https://auth.<domain>/oauth2/token`). That inference is the whole reason
 * this file is worth reading, so it is deliberately conservative: an endpoint
 * that doesn't look like `auth.<something>.<tld>` yields no domain rather than
 * a guess.
 */
export function readCliConfig(file = CLI_CONFIG_PATH) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {} // no login, unreadable, or not JSON — all the same to us
  }
  if (!raw || typeof raw !== "object") return {}
  const out = {}
  if (typeof raw.teamApiKey === "string" && raw.teamApiKey.trim()) {
    out.apiKey = raw.teamApiKey.trim()
  }
  const endpoint = raw.oauth?.token_endpoint
  if (typeof endpoint === "string") {
    try {
      const host = new URL(endpoint).hostname // auth.e2b-juliett.dev
      const domain = host.startsWith("auth.") ? host.slice(5) : ""
      if (domain.includes(".")) out.domain = domain
    } catch {
      // not a URL — no domain, no guess
    }
  }
  return out
}

/**
 * Resolve the API key and the cluster domain TOGETHER, from these sources:
 *
 *   1. env             `E2B_API_KEY` / `E2B_DOMAIN`   (explicit — always wins)
 *   2. plugin config   `[secrets].e2b_api_key_<region>`, else `[secrets].e2b_api_key`
 *                      / `[sandbox].region`
 *   3. `e2b` CLI login `~/.e2b/config.json`           (key + cluster, together)
 *
 * A key belongs to exactly one cluster, so key and domain must never be taken
 * from sources that disagree — that is precisely how you provision a box on the
 * wrong cluster and get a *successful* create instead of a 401. Hence the one
 * non-obvious rule: the CLI login's domain is used only when its key is the one
 * we ended up with. If the plugin config pins a different key, we keep that key,
 * fall through to the SDK default domain, and hand back a warning naming both.
 *
 * Pure — callers pass the sources in, so this is testable without touching disk.
 */
/**
 * The regions a user may name, and the domain each one means. Exactly two, and
 * they are the ONLY way to choose one (ADR-0007): there is no host to write by
 * hand, because a region is the thing a person picks and a host is a detail.
 *
 * `us` maps to **null**, not to "e2b.dev". The SDK defaults to `e2b.app` and the
 * `e2b` CLI to `e2b.dev`; no single string is correct for both, so absent is the
 * only correct value for the default region.
 */
const REGIONS = Object.freeze({ us: null, eu: "e2b-juliett.dev" })

/**
 * Which region a pinned `domain` belongs to, for a config that names a host
 * instead of a region.
 *
 * Written out rather than derived by reversing REGIONS, because the two tables
 * are not inverses of each other: a region resolves to ONE canonical domain,
 * but a region can be reached at more than one host. US production is served at
 * `api.e2b.app` — the current hostname and the SDK's default — and at
 * `api.e2b.dev`, the older name kept on a compatibility path. Both answer, and
 * both are the same environment, not two regions.
 *
 * Deriving this from REGIONS also silently dropped `us` altogether, since its
 * canonical domain is deliberately absent — so anyone pinning a US host by hand
 * got no region, and with it no `e2b_api_key_us`.
 */
const REGION_BY_DOMAIN = Object.freeze({
  "e2b.app": "us",
  "e2b.dev": "us",
  "e2b-juliett.dev": "eu",
})

/**
 * How to name a region in a message. A wrong-region request fails as
 * `template 'x' not found`, which reads as a missing template — so anything
 * reporting that has to say WHERE it looked.
 *
 * A domain with no region name is printed as itself: such a host has no name to
 * give, and inventing one would be worse than the host.
 */
export function regionForDomain(domain) {
  return (domain && REGION_BY_DOMAIN[domain]) || null
}

export function describeRegion(domain) {
  if (!domain) return "US (the default region)" // US resolves to no domain at all
  const name = REGION_BY_DOMAIN[domain]
  return name ? `${name.toUpperCase()} (${domain})` : domain
}

export function resolveCredentials({ env = {}, secrets = {}, sandbox = {}, cli = {} } = {}) {
  // Was this process spawned by the herdr daemon (an action, pane, or event) or
  // typed into a shell? herdr injects HERDR_PLUGIN_ID into every plugin command
  // and nothing else sets it, so it is a reliable marker.
  //
  // It matters because herdr is long-lived: whatever E2B_DOMAIN/E2B_API_KEY it
  // inherited at launch is frozen for the life of the process and every plugin
  // command inherits that snapshot. Switch regions afterwards and the daemon
  // still hands out the old cluster — env-wins would then pin the plugin to a
  // cluster you left hours ago, with no way to correct it short of restarting
  // herdr. So for daemon-spawned commands the ambient values drop to a last
  // resort, below the config file and the `e2b` CLI login, both of which are
  // read fresh on every run. A shell you typed in keeps env-wins: there the
  // export is a decision you just made.
  const fromDaemon = Boolean(env.HERDR_PLUGIN_ID || env.HERDR_PLUGIN_ROOT)
  const envKey = env.E2B_API_KEY?.trim() || null
  const envDomain = env.E2B_DOMAIN?.trim() || null
  // `[sandbox] domain` was the old way to choose a cluster and is gone (ADR-0007).
  // It must ERROR rather than be ignored: someone with `domain = "e2b-juliett.dev"`
  // who upgraded into a silent no-op would have every box quietly move to US,
  // which is precisely the failure regions exist to prevent.
  const staleDomain = typeof sandbox.domain === "string" ? sandbox.domain.trim() : null
  if (staleDomain) {
    const asRegion = REGION_BY_DOMAIN[staleDomain]
    throw new Error(
      `[sandbox] domain is no longer a config key (found '${staleDomain}' in ${CONFIG_PATH}). ` +
        (asRegion
          ? `Replace it with: region = "${asRegion}"`
          : `Choose a region instead: region = "${Object.keys(REGIONS).join('" or "')}"`) +
        ".",
    )
  }
  const cfgRegion = typeof sandbox.region === "string" ? sandbox.region.trim().toLowerCase() : null
  if (cfgRegion && !(cfgRegion in REGIONS)) {
    throw new Error(
      `Unknown [sandbox] region '${cfgRegion}' in ${CONFIG_PATH}. ` +
        `Valid regions: ${Object.keys(REGIONS).join(", ")}.`,
    )
  }

  // Which region's key applies. `region` if named, else the default — US.
  // Deliberately NOT read from the resolved domain: that would be circular, since
  // the resolved domain can come from the CLI login and whether that login is
  // usable depends on which key we just picked.
  const activeRegion = cfgRegion ?? "us"
  // Only the ACTIVE region's key is ever read, so the other region's credential
  // is never handed to a subprocess or an SDK call.
  const regionKeyName = activeRegion ? `e2b_api_key_${activeRegion}` : null
  const cfgRegionKey =
    regionKeyName && typeof secrets[regionKeyName] === "string" ? secrets[regionKeyName].trim() : null
  const cfgPlainKey = typeof secrets.e2b_api_key === "string" ? secrets.e2b_api_key.trim() : null
  const cfgKey = cfgRegionKey || cfgPlainKey
  // Which key the config actually gave us, so a warning can name the line to edit.
  const cfgKeyName = cfgRegionKey ? `[secrets].${regionKeyName}` : "[secrets].e2b_api_key"

  // Tier order: fresh sources first when the env can't be trusted to be fresh.
  const keyTiers = fromDaemon
    ? [[cfgKey, "config"], [cli.apiKey, "cli"], [envKey, "env"]]
    : [[envKey, "env"], [cfgKey, "config"], [cli.apiKey, "cli"]]
  const [apiKey, keySource] = keyTiers.find(([v]) => v) ?? [null, null]

  // The CLI's cluster is only trustworthy for the key we actually resolved.
  const cliDomainUsable = Boolean(cli.domain) && (keySource === "cli" || !apiKey || apiKey === cli.apiKey)
  const cliDomain = cliDomainUsable ? cli.domain : null
  // Tiers carry a `decided` flag rather than relying on the value being truthy,
  // because a tier must be able to answer "no domain" ON PURPOSE. `region = "us"`
  // is exactly that answer: its correct value is absent, and a plain null would
  // fall straight through to the CLI login's cluster — so naming your region US
  // while logged into the EU would silently keep provisioning in the EU.
  // The config tier is the region and nothing else — there is no host to pin.
  const cfgDomainResolved = cfgRegion ? REGIONS[cfgRegion] : null
  const cfgDecided = Boolean(cfgRegion)
  const domainTiers = fromDaemon
    ? [
        [cfgDomainResolved, "config", cfgDecided],
        [cliDomain, "cli", Boolean(cliDomain)],
        [envDomain, "env", Boolean(envDomain)],
      ]
    : [
        [envDomain, "env", Boolean(envDomain)],
        [cfgDomainResolved, "config", cfgDecided],
        [cliDomain, "cli", Boolean(cliDomain)],
      ]
  const [domain, domainSourceFound] = domainTiers.find(([, , decided]) => decided) ?? [null, null]
  const domainSource = domainSourceFound ?? "sdk-default"

  let warning = null
  if (domainSource !== "env" && envDomain && envDomain !== domain) {
    warning =
      `Ignoring a stale E2B_DOMAIN (${envDomain}) inherited from the herdr server — ` +
      `it is frozen at the value herdr launched with. Using ${domain ?? "the SDK default"} ` +
      `from your ${domainSource === "cli" ? "`e2b auth login`" : "plugin config"} instead.`
  } else if (domainSource !== "cli" && !cfgDecided && !envDomain && cli.domain && !cliDomainUsable) {
    // `cfgDecided`: naming a `region` answers the question outright, so warning
    // that the region is a guess would be telling the user to pin something they
    // have already pinned.
    //
    // Name the source we actually took the key from — "check your config" is
    // useless advice when the key came from the environment, and naming
    // `e2b_api_key` is useless when the key came from `e2b_api_key_eu`.
    const where = keySource === "env" ? "$E2B_API_KEY" : `${cfgKeyName} in config.toml`
    const fix =
      keySource === "env"
        ? "export E2B_DOMAIN alongside it"
        : `remove ${cfgKeyName} to follow your CLI login, or set [sandbox].region`
    warning =
      `E2B cluster is a guess: the key from ${where} is not the one \`e2b auth login\` saved ` +
      `(that login is on ${cli.domain}), so its cluster can't be assumed. ` +
      `Falling back to the SDK default — to pin it, ${fix}.`
  }

  return { apiKey, domain, keySource, domainSource, credWarning: warning }
}

/** Load config.toml (all keys optional) merged over the defaults above. */
export function loadConfig() {
  let file = {}
  try {
    file = TOML.parse(readFileSync(CONFIG_PATH, "utf8"))
  } catch {
    // No config file (or unreadable) — defaults are fine.
  }
  const sandbox = file.sandbox || {}
  const upload = file.upload || {}
  const secrets = file.secrets || {}
  const dashboard = file.dashboard || {}
  const fleet = resolveFleet(file.fleet)
  const env = resolveEnvConfig({ sandbox, templates: file.templates })
  return {
    // Default theme for the dashboard TUI (empty = let the TUI decide: a saved
    // choice, else "terminal"). See [dashboard] in config.example.toml.
    dashboardTheme: dashboard.theme ?? "",
    template: sandbox.template ?? DEFAULTS.template,
    sandboxTimeoutMs: posInt(sandbox.timeout_ms, DEFAULTS.sandboxTimeoutMs),
    autoPause: sandbox.auto_pause ?? DEFAULTS.autoPause,
    keepMemory: sandbox.keep_memory ?? DEFAULTS.keepMemory,
    autoResume: sandbox.auto_resume ?? DEFAULTS.autoResume,
    projectPath: sandbox.project_path ?? DEFAULTS.projectPath,
    serverPort: posInt(sandbox.server_port, DEFAULTS.serverPort),
    batchSize: posInt(upload.batch_size, DEFAULTS.batchSize),
    ignore: Array.isArray(upload.ignore) ? upload.ignore : DEFAULTS.ignore,
    // Per-branch template overrides: first matching rule wins, else `template`.
    templateRules: Array.isArray(sandbox.template_rules)
      ? sandbox.template_rules.filter((r) => r && r.pattern && r.template)
      : DEFAULTS.templateRules,
    // Menu for `e2b-box open`'s template picker (see templateChoices).
    templates: Array.isArray(sandbox.templates)
      ? sandbox.templates.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
      : DEFAULTS.templates,
    // [fleet] — how `e2b-fleet` names and bases its members. Flattened like the
    // rest of the config so callers read one object.
    fleetBase: fleet.base,
    fleetPrefix: fleet.prefix,
    fleetRoster: fleet.roster,
    fleetAgents: fleet.agents,
    // [fleet.seed] — template → the command that seeds its agent's first-run state
    // inside the box. Read through src/fleet-seed.js, which owns the defaults.
    fleetSeeds: fleet.seeds,
    // Env injected into a box at create time — `[sandbox.env]` for every box,
    // `[templates.<name>.env]` merged over it. Read with resolveEnv(cfg, template).
    envShared: env.envShared,
    envByTemplate: env.envByTemplate,
    // Shipped per-template env (behaviour, never credentials). Carried through
    // from DEFAULTS rather than read from the file: nothing in config.toml sets
    // it, and resolveEnv puts the user's own tables OVER it.
    templateEnvDefaults: DEFAULTS.templateEnvDefaults,
    // Key + cluster, resolved as a pair (env > plugin config > `e2b` CLI login).
    // `domain` is null when nothing resolved it — callers pass it to the SDK
    // only when set, so null means "SDK default", never a hardcoded host.
    ...resolveCredentials({
      env: process.env,
      secrets,
      sandbox,
      cli: readCliConfig(),
    }),
  }
}

/**
 * Map config to the SDK's `lifecycle` create option.
 * - default        → { onTimeout: { action: "pause", keepMemory: true }, autoResume: true }
 *   (the box pauses at the idle timeout with its memory intact, and the next
 *   connect wakes it — walking away costs nothing)
 * - auto_pause off → { onTimeout: "kill" } (sandbox dies at the timeout)
 * - keep_memory off → a filesystem-only snapshot: resuming cold-boots from disk,
 *   so it cannot be combined with auto_resume — the API refuses the pair, and we
 *   refuse it here with a message that names the keys instead of an HTTP error.
 *
 * The snapshot kind is always stated explicitly on the pause branch. The SDK's
 * default happens to be keepMemory: true today, but surviving a pause is the
 * feature here, so it is spelled out rather than inherited.
 */
export function resolveLifecycle(cfg) {
  if (cfg.autoPause === false) return { onTimeout: "kill" }
  const keepMemory = cfg.keepMemory !== false
  const autoResume = cfg.autoResume !== false
  if (!keepMemory && autoResume) {
    throw new Error(
      "keep_memory = false takes a filesystem-only snapshot, which resumes by cold-booting " +
        "from disk — it cannot be woken automatically, so it cannot be combined with " +
        "auto_resume. Set auto_resume = false alongside keep_memory = false in " +
        `${CONFIG_PATH}, or drop keep_memory to keep full memory snapshots.`,
    )
  }
  return { onTimeout: { action: "pause", keepMemory }, autoResume }
}

/** Resolve the E2B template for a branch: first matching rule, else default. */
export function resolveTemplate(branch, cfg) {
  for (const rule of cfg.templateRules) {
    try {
      if (new RegExp(rule.pattern).test(branch || "")) return rule.template
    } catch {
      // bad regex in config → skip this rule
    }
  }
  return cfg.template
}

/** True when a `template_rules` pattern decides this branch — i.e. the template
 * is already chosen and `e2b-box open` shouldn't stop to ask. */
export function templateRuleMatches(branch, cfg) {
  return cfg.templateRules.some((rule) => {
    try {
      return new RegExp(rule.pattern).test(branch || "")
    } catch {
      return false
    }
  })
}

/**
 * The picker's menu: `[sandbox] templates`, then every template named by a
 * `template_rules` entry, then the default. Rule templates are free candidates —
 * they're already spelled the way this cluster wants them — and the default is
 * always offered so "just boot the usual one" is one keypress.
 */
/**
 * The templates a FLEET may be built from: the same list, minus the plain default.
 *
 * A fleet is several coding agents working one checkout in parallel, so a box with
 * no agent in it is not a member — it is a shell nobody asked for. `base` is also
 * the one template whose name is not a CLI, so the "an agent is called after its
 * template" default typed `base` into a sandbox shell and waited 90s for a TUI that
 * was never coming.
 *
 * Filtered by `cfg.template` rather than by the literal string "base" so a user who
 * points the default at their own plain image gets the same treatment. `e2b-box`
 * keeps offering it: one plain box is a perfectly good thing to want.
 */
export function fleetTemplateChoices(cfg) {
  return templateChoices(cfg).filter((t) => t !== cfg.template)
}

export function templateChoices(cfg) {
  const seen = new Set()
  const out = []
  for (const t of [...cfg.templates, ...cfg.templateRules.map((r) => r.template), cfg.template]) {
    if (typeof t === "string" && t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}
