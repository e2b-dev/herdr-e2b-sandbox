import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { CONNECTIONS_DIR } from "./config-paths.js"
import { HARNESSES, harnessForTemplate, readHarnessFile } from "./harnesses.js"

export function connectionId(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error("Connection names must use 1–64 lowercase letters, numbers, hyphens or underscores.")
  }
  return id
}

export function classifySubscription(status = {}) {
  const plan = typeof status.subscriptionType === "string" ? status.subscriptionType.toLowerCase() : null
  return {
    subscription: plan,
    classification: ["pro", "max"].includes(plan) ? "personal" : ["team", "enterprise"].includes(plan) ? "organization" : "unknown",
    organization: typeof status.orgName === "string" ? status.orgName : null,
    organizationId: typeof status.orgId === "string" ? status.orgId : null,
    source: "local-login",
  }
}

export function localAccountLabel(harness, detected) {
  if (harness !== "claude" || !detected) return "unknown"
  const plans = { team: "Team", enterprise: "Enterprise", pro: "Pro", max: "Max" }
  const plan = plans[detected.subscription] || detected.subscription || "plan unknown"
  return [`Claude ${plan}`, detected.organization].filter(Boolean).join(" · ")
}

export function suggestedConnectionId(harness, detected) {
  if (harness !== "claude") return connectionId(`${harness}-personal`)
  if (detected?.classification === "organization") {
    const organization = (detected.organization || "").normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    const suffix = organization || detected.subscription
    return connectionId(`claude-${suffix}`.slice(0, 64).replace(/-+$/g, ""))
  }
  return detected?.classification === "personal" ? "claude-personal" : "claude-local"
}

function validate(record) {
  connectionId(record?.id)
  if (record.version !== 1 || record.owner !== "personal" ||
      !/^[0-9a-f-]{36}$/.test(record.revision || "") ||
      !((record.harness === "claude" && record.method === "setup-token") ||
        (record.harness === "codex" && record.method === "borrowed-session" && typeof record.path === "string"))) {
    throw new Error(`Invalid connection '${record.id}'.`)
  }
  return record
}

export function readConnections(directory = CONNECTIONS_DIR) {
  let files
  try { files = readdirSync(directory) } catch (error) {
    if (error.code === "ENOENT") return []
    throw new Error("Cannot read the connections directory.")
  }
  return files.filter((file) => file.endsWith(".json")).sort().map((file) => {
    try {
      const record = validate(JSON.parse(readFileSync(path.join(directory, file), "utf8")))
      if (file !== `${record.id}.json`) throw new Error()
      return record
    } catch { throw new Error(`Cannot read connection metadata '${file}'. Repair or remove that file before continuing.`) }
  })
}

function secretPath(record, directory) {
  return path.join(directory, `${connectionId(record.id)}.${record.revision}.secret`)
}

export function validSetupToken(value) {
  return typeof value === "string" && /^sk-ant-oat01-[A-Za-z0-9_-]{32,}$/.test(value)
}

// Metadata is committed last. Readers see either the previous revision or the
// complete new one, and list/explain never have to open a secret file.
export function saveConnection(record, token, { directory = CONNECTIONS_DIR, replace = false } = {}) {
  connectionId(record.id)
  const next = validate({ ...record, version: 1, owner: "personal", revision: randomUUID(), updatedAt: new Date().toISOString() })
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const lock = path.join(directory, `${record.id}.lock`)
  try { mkdirSync(lock, { mode: 0o700 }) } catch {
    throw new Error(`Connection '${record.id}' is being changed. Retry after the other command finishes.`)
  }
  const destination = path.join(directory, `${record.id}.json`)
  const temporary = path.join(directory, `${record.id}.${next.revision}.tmp`)
  let committed = false
  try {
    if (!replace && existsSync(destination)) throw new Error(`Connection '${record.id}' already exists. Use auth reconnect ${record.id}.`)
    if (next.method === "setup-token") {
      if (!validSetupToken(token)) throw new Error("Expected a Claude setup-token value; nothing was saved.")
      writeFileSync(secretPath(next, directory), token, { mode: 0o600, flag: "wx" })
    }
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temporary, destination)
    committed = true
    // Keep old revisions until disconnect: a provisioner may already have read
    // their metadata. They are private, and never selected by a new reader.
    return next
  } finally {
    rmSync(temporary, { force: true })
    if (!committed) rmSync(secretPath(next, directory), { force: true })
    rmSync(lock, { recursive: true, force: true })
  }
}

export function removeConnection(id, directory = CONNECTIONS_DIR) {
  connectionId(id)
  const record = readConnections(directory).find((c) => c.id === id)
  if (!record) throw new Error(`Unknown connection '${id}'.`)
  const lock = path.join(directory, `${id}.lock`)
  try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error(`Connection '${id}' is being changed. Try again later.`) }
  try {
    rmSync(path.join(directory, `${id}.json`))
    for (const name of readdirSync(directory)) {
      if (name.startsWith(`${id}.`) && name.endsWith(".secret")) rmSync(path.join(directory, name))
    }
  } finally { rmSync(lock, { recursive: true, force: true }) }
}

export function selectConnection(cfg = {}, template) {
  cfg ||= {}
  const id = cfg.selectedConnection ?? cfg.templateConnections?.[template]
  const harness = harnessForTemplate(template)
  const harnessId = harness?.id
  const candidates = (cfg.connections || []).filter((c) => c.harness === harnessId)
  if (id !== undefined && id !== null) {
    connectionId(id)
    const found = (cfg.connections || []).find((c) => c.id === id)
    if (!found) throw new Error(`Unknown connection '${id}'. Run e2b-box auth list.`)
    if (template === "base" || (harnessId && found.harness !== harnessId)) throw new Error(`Connection '${id}' is for ${found.harness}, not template '${template}'.`)
    return found
  }
  if (candidates.length > 1) throw new Error(`Several connections match '${template}'. Choose --connection or set templates.${template}.connection.`)
  return candidates[0] || null
}

export function connectionMaterial(record, { directory = CONNECTIONS_DIR, readFile = readHarnessFile, now = Date.now() } = {}) {
  if (record.method === "setup-token") {
    if (record.expiresAt && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now)) {
      throw new Error(`Connection '${record.id}' has expired. Run e2b-box auth reconnect ${record.id}.`)
    }
    let token
    try { token = readFileSync(secretPath(record, directory), "utf8") } catch {
      throw new Error(`Credential for '${record.id}' is unavailable. Run e2b-box auth reconnect ${record.id}.`)
    }
    if (!validSetupToken(token)) throw new Error(`Credential for '${record.id}' is invalid. Reconnect it.`)
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, expiresAt: record.expiresAt || null }
  }
  let session
  try { session = HARNESSES.codex.sessionFile.read(readFile(record.path)) } catch { /* unreadable source */ }
  if (!session || Date.parse(session.expires) <= now) {
    throw new Error(`Connection '${record.id}' needs a fresh local Codex login. Sign in with codex, then run e2b-box auth reconnect ${record.id}.`)
  }
  return { env: { CODEX_AUTH_JSON: session.value }, expiresAt: session.expires }
}

export const CONFLICTING_AUTH = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_AUTH_JSON", "OPENAI_BASE_URL"],
}

export function applyConnection(record, env, options) {
  const result = { ...env }
  for (const variable of CONFLICTING_AUTH[record.harness]) delete result[variable]
  return { ...result, ...connectionMaterial(record, options).env }
}
