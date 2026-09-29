// `e2b-box auth refresh [ID]`: one row per credential a box could be handed, saying
// how long it has left, rotating the ones this plugin is allowed to rotate, and
// naming the remedy for the rest. Bare `refresh` covers everything (managed
// connections AND discovered sessions), and an ID narrows it to one row.
//
// Rotation happens in exactly one place: a codex connection made with `--oauth`,
// whose refresh chain the plugin alone holds (ADR 0015). Everything else is a
// report, because the plugin either owns no refresh half (claude setup-token,
// muse and amp keys) or must not touch the one that exists (a borrowed codex
// session, ADR 0010). Grok's multi-use grant and delivery into running boxes are
// separate issues: see .scratch/auth-refresh/spec.md.
import { HARNESSES, readHarnessFile } from "./harnesses.js"
import { connectionMaterial, readOauthSecret, rewriteOauthSecret } from "./connections.js"
import { codexRefresh } from "./oauth.js"
import { untilExpiry } from "./harness-probe.js"

// A claude setup-token has no refresh half: the only remedy is a new token, and
// a year-long token that is about to run out deserves a heads-up before it fails.
const EXPIRING_SOON_MS = 30 * 86400000

// A plugin-owned codex bearer lives about ten days and a box made from it dies
// when it does. Rotating once it is inside its second half keeps every new box
// on a bearer with at least five days ahead, without minting on every cron tick.
const CODEX_ROTATE_UNDER_MS = 5 * 86400000

/** Rows that leave a NEW box unauthenticated. `opted-out` is deliberate and `unknown`
 * (a pasted token with no readable mint time) is not evidence, so neither counts. */
export const STALE = new Set(["expired", "unavailable"])

// `soonMs` is the early-warning window. Only a setup-token gets one: a borrowed
// bearer lives hours or days by design and renews itself the next time the laptop
// runs its harness, so "expiring" would be its permanent, meaningless state.
function status(expiresAt, now, soonMs = 0) {
  if (!expiresAt) return "unknown"
  const ms = Date.parse(expiresAt) - now
  if (!Number.isFinite(ms)) return "unknown"
  if (ms <= 0) return "expired"
  return ms < soonMs ? "expiring" : "fresh"
}

function describe(record, { directory, readFile, now }) {
  const base = { id: record.id, harness: record.harness, kind: "connection", method: record.method }
  let material
  try {
    material = connectionMaterial(record, { directory, readFile, now })
  } catch (error) {
    // connectionMaterial already names the remedy in its message; carry it verbatim
    // rather than inventing a second phrasing of "reconnect this".
    return { ...base, status: /expired|fresh local/.test(error.message) ? "expired" : "unavailable", expiresAt: record.expiresAt || null,
      remaining: untilExpiry(record.expiresAt, now), action: error.message }
  }
  // A muse or amp connection is an API key the vendor minted: nothing expires and
  // nothing refreshes, which is the point of storing that rather than a session.
  if (record.method === "oauth" && record.harness !== "codex") {
    return { ...base, status: "fresh", expiresAt: null, remaining: "no expiry (API key)", action: "none" }
  }
  const s = status(material.expiresAt, now, record.method === "setup-token" ? EXPIRING_SOON_MS : 0)
  const action = record.method === "setup-token" && s === "expiring"
    ? `Run e2b-box auth reconnect ${record.id} before it expires (setup-tokens have no refresh half).`
    : "none"
  return { ...base, status: s, expiresAt: material.expiresAt, remaining: untilExpiry(material.expiresAt, now), action }
}

/** True when this row's chain is the plugin's to rotate and is due for it. */
function dueForRotation(record, row, now) {
  if (record.method !== "oauth" || record.harness !== "codex") return false
  if (row.status === "expired") return true
  return row.status === "fresh" && Date.parse(row.expiresAt) - now < CODEX_ROTATE_UNDER_MS
}

async function connectionRow(record, { directory, readFile, now, rotate }) {
  const row = describe(record, { directory, readFile, now })
  if (!dueForRotation(record, row, now)) return row
  try {
    await rotate(record, directory)
  } catch (error) {
    // The chain is dead (revoked, or rotated by something else). Only a browser
    // sign-in brings it back, and that is reconnect's job, never a cron's.
    return { ...row, rotated: false, action: `${error.message}. Run e2b-box auth reconnect ${record.id} (it opens a browser only when the refresh fails).` }
  }
  return { ...describe(record, { directory, readFile, now }), rotated: true }
}

function sessionRow(template, pointer, { readFile, now, templatePrefer }) {
  const h = HARNESSES[pointer.harness]
  const base = { id: template, harness: pointer.harness, kind: "session", method: "discovered-session", path: pointer.path }
  const login = `Sign in locally (${pointer.harness} login), then a new box borrows the fresh session.`
  if (templatePrefer?.[template] === "env") {
    return { ...base, status: "opted-out", expiresAt: null, remaining: "not used", action: `prefer = "env" is set for ${template}; boxes use the configured key instead.` }
  }
  if (!h?.sessionFile?.read) return { ...base, status: "unavailable", expiresAt: null, remaining: "expiry unknown", action: `This build has no session reader for ${pointer.harness}.` }
  let session = null
  try {
    const text = readFile(pointer.path)
    session = text == null ? null : h.sessionFile.read(text)
  } catch { session = null }
  if (!session) return { ...base, status: "unavailable", expiresAt: null, remaining: "expiry unknown", action: `Could not read a session at ${pointer.path}. ${login}` }
  const s = status(session.expires, now)
  return { ...base, status: s, expiresAt: session.expires, remaining: untilExpiry(session.expires, now), action: s === "expired" ? login : "none" }
}

/** The one real rotation: codex's refresh grant, then the secret rewritten in place. */
export async function rotateCodexChain(record, directory, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const next = await codexRefresh(readOauthSecret(record, directory), { fetch, now })
  rewriteOauthSecret(record, next, directory)
}

/**
 * Every row `auth refresh` reports, connections first then sessions, each sorted
 * by id. `id` narrows to one connection or one session template and throws when
 * neither exists. `readFile`, `now` and `rotate` are injected so the whole table
 * is testable off fixtures and a scripted refresh.
 */
export async function refreshRows(cfg = {}, { id = null, readFile = readHarnessFile, now = Date.now(), rotate = rotateCodexChain } = {}) {
  const connections = [...(cfg.connections || [])].sort((a, b) => a.id.localeCompare(b.id))
  const sessions = Object.entries(cfg.envSession || {}).sort(([a], [b]) => a.localeCompare(b))
  const known = new Set([...connections.map((c) => c.id), ...sessions.map(([t]) => t)])
  if (id !== null && !known.has(id)) throw new Error(`Unknown connection or session '${id}'. Run e2b-box auth refresh to see every row.`)
  const rows = []
  for (const c of connections) {
    if (id === null || c.id === id) rows.push(await connectionRow(c, { directory: cfg.connectionsDir, readFile, now, rotate }))
  }
  for (const [template, pointer] of sessions) {
    if (id === null || template === id) rows.push(sessionRow(template, pointer, { readFile, now, templatePrefer: cfg.templatePrefer }))
  }
  return rows
}

/** Exit status for the verb: 1 when any row would leave a new box unauthenticated. */
export function refreshExitCode(rows) {
  return rows.some((r) => STALE.has(r.status)) ? 1 : 0
}

export function formatRefresh(rows) {
  if (!rows.length) return "Nothing to refresh. Run e2b-box auth connect claude or e2b-box auth discover first."
  const lines = ["ROW                    AGENT    KIND         STATUS      EXPIRES"]
  for (const r of rows) {
    lines.push(`${r.id.padEnd(22)} ${r.harness.padEnd(8)} ${r.kind.padEnd(12)} ${(r.rotated ? "rotated" : r.status).padEnd(11)} ${r.remaining}`)
    if (r.action !== "none") lines.push(`${"".padEnd(23)}${r.action}`)
  }
  const rotated = rows.filter((r) => r.rotated).length
  lines.push("", rotated
    ? `Rotated ${rotated} plugin-owned codex chain${rotated === 1 ? "" : "s"}. Nothing else was changed, and no running box was touched.`
    : "Nothing was changed. Only a codex connection made with --oauth is ever rotated here; no running box was touched.")
  return lines.join("\n")
}
