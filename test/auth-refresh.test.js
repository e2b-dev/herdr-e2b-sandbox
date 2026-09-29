import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { formatRefresh, refreshExitCode, refreshRows, rotateCodexChain } from "../src/auth-refresh.js"
import { connectionMaterial, readOauthSecret, saveConnection } from "../src/connections.js"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TOKEN = `sk-ant-oat01-${"fabricated-token-".repeat(4)}`
const NOW = Date.parse("2026-09-11T12:00:00Z")
const DAY = 86400000

const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString()
// A bearer whose only readable claim is `exp`; the reader never verifies it.
const jwt = (expiresAt) => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.parse(expiresAt) / 1000) })).toString("base64url")}.y`
const codexFile = (expiresAt) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(expiresAt), refresh_token: "real-refresh" } })
const grokFile = (expiresAt) => JSON.stringify({ default: { auth_mode: "oidc", key: jwt(expiresAt), refresh_token: "real-refresh", expires_at: expiresAt } })
const codexOauth = (id, expiresAt, directory) => saveConnection({ id, harness: "codex", method: "oauth" },
  { auth_mode: "chatgpt", tokens: { access_token: jwt(expiresAt), refresh_token: `refresh-${id}` } }, { directory })

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "e2b-refresh-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("bare refresh covers every connection and session, sorted, and only stale rows fail the exit code", async (t) => {
  const directory = fixture(t)
  const fresh = saveConnection({ id: "claude-work", harness: "claude", method: "setup-token", expiresAt: iso(300 * DAY) }, TOKEN, { directory })
  const soon = saveConnection({ id: "claude-personal", harness: "claude", method: "setup-token", expiresAt: iso(10 * DAY) }, TOKEN, { directory })
  const pasted = saveConnection({ id: "claude-pasted", harness: "claude", method: "setup-token", expiresAt: null }, TOKEN, { directory })
  const codex = saveConnection({ id: "codex-personal", harness: "codex", method: "borrowed-session", path: "/fixture/codex/auth.json" }, undefined, { directory })
  const muse = saveConnection({ id: "muse-personal", harness: "muse", method: "oauth" }, { kind: "api-key", META_API_KEY: "muse-key" }, { directory })
  const files = {
    "/fixture/codex/auth.json": codexFile(iso(-1 * DAY)),
    "~/.grok/auth.json": grokFile(iso(5 * 3600000)),
  }
  const cfg = {
    connections: [codex, fresh, soon, pasted, muse], connectionsDir: directory,
    envSession: { grok: { var: "GROK_AUTH_JSON", path: "~/.grok/auth.json", harness: "grok" }, codex: { var: "CODEX_AUTH_JSON", path: "/fixture/codex/auth.json", harness: "codex" } },
  }
  const rotate = async () => { throw new Error("must not rotate anything here") }
  const rows = await refreshRows(cfg, { readFile: (p) => files[p] ?? null, now: NOW, rotate })
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.status]), [
    ["claude-pasted", "connection", "unknown"],
    ["claude-personal", "connection", "expiring"],
    ["claude-work", "connection", "fresh"],
    ["codex-personal", "connection", "expired"],
    ["muse-personal", "connection", "fresh"],
    ["codex", "session", "expired"],
    ["grok", "session", "fresh"],
  ])
  assert.match(rows[1].action, /auth reconnect claude-personal/)
  assert.match(rows[3].action, /codex.*auth reconnect codex-personal/)
  assert.equal(rows[4].remaining, "no expiry (API key)")
  assert.match(rows[5].action, /codex login/)
  assert.equal(rows[6].remaining, "expires in 5 hours")
  assert.equal(refreshExitCode(rows), 1)
  assert.equal(refreshExitCode(rows.filter((r) => !["codex-personal", "codex"].includes(r.id))), 0)
  const text = formatRefresh(rows)
  assert.match(text, /^ROW\s+AGENT\s+KIND\s+STATUS\s+EXPIRES/)
  assert.match(text, /Nothing was changed/)
  assert.ok(!text.includes(TOKEN) && !text.includes("muse-key") && !JSON.stringify(rows).includes(TOKEN), "a report never carries a credential")
})

test("a plugin-owned codex chain is rotated only inside its last five days or when expired, and a dead chain points at reconnect", async (t) => {
  const directory = fixture(t)
  const young = codexOauth("codex-young", iso(8 * DAY), directory)
  const aging = codexOauth("codex-aging", iso(2 * DAY), directory)
  const dead = codexOauth("codex-dead", iso(-1 * DAY), directory)
  const rotated = []
  const rotate = async (record, dir) => {
    rotated.push(record.id)
    if (record.id === "codex-dead") throw new Error("codex refresh failed (400: invalid_grant) - sign in again with auth reconnect")
    // Real rotation is codexRefresh + rewriteOauthSecret; the row must reflect the rewritten secret.
    const body = JSON.stringify({ access_token: jwt(iso(10 * DAY)), refresh_token: "next" })
    await rotateCodexChain(record, dir, { fetch: async () => ({ ok: true, status: 200, text: async () => body }), now: () => NOW })
  }
  const rows = await refreshRows({ connections: [young, aging, dead], connectionsDir: directory }, { now: NOW, rotate })
  assert.deepEqual(rotated, ["codex-aging", "codex-dead"], "young chain left alone")
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(byId["codex-young"].status, "fresh")
  assert.equal(byId["codex-young"].rotated, undefined)
  assert.equal(byId["codex-aging"].rotated, true)
  assert.equal(byId["codex-aging"].remaining, "expires in 10 days")
  assert.equal(readOauthSecret(aging, directory).tokens.refresh_token, "next", "the secret file carries the new chain")
  assert.equal(byId["codex-dead"].status, "expired")
  assert.equal(byId["codex-dead"].rotated, false)
  assert.match(byId["codex-dead"].action, /invalid_grant.*auth reconnect codex-dead/)
  assert.equal(refreshExitCode(rows), 1)
  const text = formatRefresh(rows)
  assert.match(text, /codex-aging .* rotated /)
  assert.match(text, /Rotated 1 plugin-owned codex chain\./)
  assert.ok(!text.includes("refresh-") && !JSON.stringify(rows).includes("refresh-"), "no refresh token in the table or the JSON")
  assert.equal(connectionMaterial(aging, { directory, now: NOW }).expiresAt, iso(10 * DAY))
})

test("an ID narrows to one row, an unknown ID is an error, and opt-out is not stale", async (t) => {
  const directory = fixture(t)
  const files = { "~/.grok/auth.json": grokFile(iso(5 * 3600000)) }
  const cfg = { connections: [], connectionsDir: directory,
    envSession: { grok: { var: "GROK_AUTH_JSON", path: "~/.grok/auth.json", harness: "grok" } }, templatePrefer: { grok: "env" } }
  const [row] = await refreshRows(cfg, { id: "grok", readFile: (p) => files[p] ?? null, now: NOW })
  assert.equal(row.status, "opted-out")
  assert.equal(refreshExitCode([row]), 0)
  await assert.rejects(refreshRows(cfg, { id: "nope", readFile: () => null, now: NOW }), /Unknown connection or session 'nope'/)
  const missing = await refreshRows({ ...cfg, templatePrefer: {} }, { readFile: () => null, now: NOW })
  assert.equal(missing[0].status, "unavailable")
  assert.equal(refreshExitCode(missing), 1)
})

test("CLI: auth refresh takes no ID or one, rejects extras, and exits 1 on a stale row", (t) => {
  const root = fixture(t)
  mkdirSync(path.join(root, "state"), { recursive: true })
  const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_STATE_DIR: path.join(root, "state"), HERDR_PLUGIN_CONTEXT_JSON: "", E2B_API_KEY: "", E2B_DOMAIN: "" }
  const cli = (args) => spawnSync(path.join(ROOT, "bin/e2b-box"), args, { env, encoding: "utf8", timeout: 15000 })
  const empty = cli(["auth", "refresh"])
  assert.equal(empty.status, 0, empty.stderr)
  assert.match(empty.stdout, /Nothing to refresh/)
  const directory = path.join(root, "connections")
  saveConnection({ id: "claude-old", harness: "claude", method: "setup-token", expiresAt: iso(-1 * DAY) }, TOKEN, { directory })
  const stale = cli(["auth", "refresh", "--json"])
  assert.equal(stale.status, 1)
  const [row] = JSON.parse(stale.stdout)
  assert.equal(row.status, "expired")
  assert.ok(!stale.stdout.includes(TOKEN))
  assert.equal(cli(["auth", "refresh", "claude-old"]).status, 1)
  assert.match(cli(["auth", "refresh", "nope"]).stderr, /Unknown connection or session/)
  assert.match(cli(["auth", "refresh", "a", "b"]).stderr, /Unexpected or missing argument/)
  assert.match(cli(["auth", "refresh", "--yes"]).stderr, /not supported by auth refresh/)
})
