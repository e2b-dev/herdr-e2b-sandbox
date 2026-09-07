import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { classifySubscription, connectionMaterial, readConnections, removeConnection, saveConnection, selectConnection, suggestedConnectionId } from "../src/connections.js"
import { resolveEnv } from "../src/config.js"
import { unauthenticatedMembers } from "../src/fleet-auth.js"
import { seedCommand } from "../src/fleet-seed.js"
import { buildPlan, buildSummary, formatPlan, formatSummary, renderAuthToml } from "../src/harness-auth.js"
import { HARNESSES } from "../src/harnesses.js"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TOKEN = `sk-ant-oat01-${"fabricated-token-".repeat(4)}`
const replacement = `sk-ant-oat01-${"replacement-token-".repeat(4)}`
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "e2b-connections-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const claude = (id = "claude-personal") => ({ id, harness: "claude", method: "setup-token" })

test("subscription plan determines account classification, never sharing", () => {
  for (const plan of ["pro", "max"]) assert.equal(classifySubscription({ subscriptionType: plan }).classification, "personal")
  for (const plan of ["team", "enterprise"]) assert.equal(classifySubscription({ subscriptionType: plan }).classification, "organization")
  assert.equal(classifySubscription({ orgId: "personal-org-id", orgName: "A person's organization" }).classification, "unknown")
  assert.equal(classifySubscription({ subscriptionType: "future-plan" }).classification, "unknown")
  assert.equal(classifySubscription({ subscriptionType: "team", orgName: "E2B" }).source, "local-login")
})

test("suggested names distinguish organization plans, personal plans, and unknown logins", () => {
  const suggest = (status) => suggestedConnectionId("claude", classifySubscription(status))
  assert.equal(suggest({ subscriptionType: "team", orgName: "E2B" }), "claude-e2b")
  assert.equal(suggest({ subscriptionType: "enterprise", orgName: "Ondřej's ../ Team" }), "claude-ondrej-s-team")
  assert.equal(suggest({ subscriptionType: "team", orgName: "公司" }), "claude-team")
  assert.equal(suggest({ subscriptionType: "enterprise" }), "claude-enterprise")
  assert.equal(suggest({ subscriptionType: "max", orgName: "Personal workspace" }), "claude-personal")
  assert.equal(suggest({ orgName: "E2B" }), "claude-local")
  assert.equal(suggest(), "claude-local")
  assert.equal(suggest({ subscriptionType: "team", orgName: "a".repeat(100) }).length, 64)
})

test("private token storage, metadata-only reads, and explicit replacement", (t) => {
  const directory = fixture(t)
  const first = saveConnection(claude(), TOKEN, { directory })
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  for (const file of readdirSync(directory)) assert.equal(statSync(path.join(directory, file)).mode & 0o777, 0o600)
  assert.ok(!readFileSync(path.join(directory, `${first.id}.json`), "utf8").includes(TOKEN))
  assert.ok(!JSON.stringify(readConnections(directory)).includes(TOKEN))
  assert.equal(connectionMaterial(first, { directory }).env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN)
  assert.throws(() => saveConnection(claude(), replacement, { directory }), /already exists/)
  const next = saveConnection(claude(), replacement, { directory, replace: true })
  assert.notEqual(next.revision, first.revision)
  assert.equal(connectionMaterial(next, { directory }).env.CLAUDE_CODE_OAUTH_TOKEN, replacement)
  assert.equal(connectionMaterial(first, { directory }).env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN)
  removeConnection(first.id, directory)
  assert.deepEqual(readdirSync(directory), [])
})

test("auth overview credits the selected connection, and blocks broken or ambiguous selections without fallback", (t) => {
  const directory = fixture(t)
  const first = saveConnection({ ...claude(), detected: classifySubscription({ subscriptionType: "team", orgName: "E2B" }) }, TOKEN, { directory })
  const rows = [{ id: "claude", installed: true, state: "no-key", source: "login" }]
  const plan = buildPlan(rows)
  const cfg = { connections: [first], connectionsDir: directory, envByTemplate: { claude: { ANTHROPIC_API_KEY: "competing-key" } } }
  const summary = buildSummary(rows, plan, cfg)
  assert.equal(summary[0].mark, "ok")
  assert.match(summary[0].method, /connection claude-personal/)
  assert.match(formatSummary(summary), /OAuth token.*claude-personal.*Configured/)
  assert.match(summary[0].method, /Claude Team · E2B/)
  assert.doesNotMatch(formatPlan(plan, "/fixture/auth.toml", summary), /claude setup-token|\[templates.claude.env\]/)
  assert.doesNotMatch(renderAuthToml(plan), /sk-ant-oat01|claude-personal/)
  const ambiguous = buildSummary(rows, plan, { ...cfg, connections: [first, { ...first, id: "work" }] })
  assert.equal(ambiguous[0].mark, "no")
  assert.match(ambiguous[0].method, /Several connections/)
  const explicit = buildSummary(rows, plan, { ...cfg, connections: [first, { ...first, id: "work" }], templateConnections: { claude: first.id } })
  assert.equal(explicit[0].mark, "ok")
  const missing = buildSummary(rows, plan, { ...cfg, templateConnections: { claude: "gone" } })
  assert.equal(missing[0].mark, "no")
  assert.match(missing[0].method, /Unknown connection/)
  const expired = buildSummary(rows, plan, { ...cfg, connections: [{ ...first, expiresAt: "2000-01-01" }] })
  assert.equal(expired[0].mark, "no")
  assert.match(expired[0].method, /expired.*No fallback/)
  rmSync(path.join(directory, `${first.id}.${first.revision}.secret`))
  const unavailable = buildSummary(rows, plan, cfg)
  assert.equal(unavailable[0].mark, "no")
  assert.match(unavailable[0].method, /unavailable/)
  for (const result of [summary, ambiguous, missing, expired, unavailable]) {
    assert.ok(!JSON.stringify(result).includes(TOKEN))
    assert.ok(!JSON.stringify(result).includes("competing-key"))
  }
})

test("failed writes leave the previous connection intact and release the lock", (t) => {
  const directory = fixture(t)
  const record = saveConnection(claude(), TOKEN, { directory })
  assert.throws(() => saveConnection(claude(), "not-a-token", { directory, replace: true }), /Expected/)
  assert.deepEqual(readConnections(directory), [record])
  assert.equal(readdirSync(directory).length, 2)
  assert.throws(() => saveConnection({ ...claude(), method: "unknown" }, TOKEN, { directory }), /Invalid/)
  assert.equal(readdirSync(directory).length, 2)
  assert.throws(() => saveConnection(claude("../escape"), TOKEN, { directory }), /Connection names/)
})

test("a selected connection removes competing auth and preserves unrelated env", (t) => {
  const directory = fixture(t)
  const record = saveConnection(claude(), TOKEN, { directory })
  const cfg = { connections: [record], connectionsDir: directory, templatePrefer: { claude: "env" },
    envShared: { ANTHROPIC_API_KEY: "old-key", ANTHROPIC_AUTH_TOKEN: "old-gateway", ANTHROPIC_BASE_URL: "https://old.invalid", KEEP_ME: "yes" },
    envByTemplate: { claude: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_PROFILE: "old-profile" } } }
  assert.deepEqual(resolveEnv(cfg, "claude"), { KEEP_ME: "yes", CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
  assert.deepEqual(unauthenticatedMembers([{ template: "claude", label: "member" }], cfg), [])
  assert.equal(resolveEnv(cfg, "base").CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.throws(() => resolveEnv({ ...cfg, selectedConnection: record.id }, "base"), /not template/)
  assert.deepEqual(resolveEnv({ ...cfg, selectedConnection: record.id }, "drew-claude"), { KEEP_ME: "yes", CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
  const custom = { ...cfg, templateConnections: { "drew-claude": record.id } }
  assert.match(seedCommand("drew-claude", {}, record.harness), /CLAUDE_CODE_OAUTH_TOKEN/)
  assert.equal(seedCommand("drew-claude", { "drew-claude": "" }, record.harness), "")
  assert.equal(seedCommand("drew-claude", { "drew-claude": "custom seed" }, record.harness), "custom seed")
  assert.deepEqual(unauthenticatedMembers([{ template: "drew-claude", label: "member" }], custom), [])
  assert.throws(() => unauthenticatedMembers([{ template: "drew-claude", label: "member" }], { ...custom, templateConnections: { "drew-claude": "missing" } }), /Unknown connection/)
})

test("explicit and configured selections fail closed; multiple defaults are ambiguous", () => {
  const records = [claude("personal"), claude("work")]
  assert.throws(() => selectConnection({ connections: records }, "claude"), /Several connections/)
  assert.equal(selectConnection({ connections: records, selectedConnection: "work" }, "claude").id, "work")
  assert.equal(selectConnection({ connections: records, templateConnections: { claude: "work" } }, "claude").id, "work")
  assert.throws(() => selectConnection({ connections: records, selectedConnection: "gone" }, "claude"), /Unknown connection/)
  assert.throws(() => selectConnection({ connections: records, selectedConnection: "" }, "claude"), /Connection names/)
  assert.throws(() => selectConnection({ connections: records, templateConnections: { claude: "gone" } }, "claude"), /Unknown connection/)
  assert.equal(selectConnection(undefined, "claude"), null)
})

test("expired or missing selected tokens cannot fall back to an API key", (t) => {
  const directory = fixture(t)
  const record = saveConnection({ ...claude(), expiresAt: "2000-01-01T00:00:00Z" }, TOKEN, { directory })
  const cfg = { connections: [record], connectionsDir: directory, envShared: { ANTHROPIC_API_KEY: "bill-me" } }
  assert.throws(() => resolveEnv(cfg, "claude"), /expired/)
  const noExpiry = { ...record, expiresAt: null }
  rmSync(path.join(directory, `${record.id}.${record.revision}.secret`))
  assert.throws(() => resolveEnv({ ...cfg, connections: [noExpiry] }, "claude"), /unavailable/)
  assert.equal(readConnections(directory).length, 1, "metadata remains listable when its secret is unavailable")
})

test("Codex rereads the source, excludes refresh token, and rejects expired sessions", () => {
  const expires = Date.now() + 60000
  const access = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000) })).toString("base64url")}.signature`
  const source = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: access, refresh_token: "real-refresh-fixture", id_token: "id" } })
  const record = { id: "codex-personal", harness: "codex", method: "borrowed-session", path: "/fixture/auth.json" }
  const material = connectionMaterial(record, { readFile: () => source })
  assert.ok(material.env.CODEX_AUTH_JSON.includes(access))
  assert.ok(!material.env.CODEX_AUTH_JSON.includes("real-refresh-fixture"))
  assert.throws(() => connectionMaterial(record, { readFile: () => source, now: expires + 1000 }), /fresh local Codex login/)
})

function cliEnv(t) {
  const root = fixture(t)
  const bins = path.join(root, "bin")
  mkdirSync(bins)
  writeFileSync(path.join(bins, "claude"), '#!/bin/sh\nprintf \'%s\\n\' \'{"loggedIn":true,"subscriptionType":"team","orgName":"E2B","orgId":"test-org"}\'\n', { mode: 0o755 })
  return { ...process.env, HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_STATE_DIR: path.join(root, "state"),
    HERDR_PLUGIN_CONTEXT_JSON: "", PATH: `${bins}:${process.env.PATH}`, E2B_API_KEY: "", E2B_DOMAIN: "" }
}
function cli(env, args, input) {
  return spawnSync(path.join(ROOT, "bin/e2b-box"), args, { env, input, encoding: "utf8", timeout: 15000 })
}

test("bare auth and auth discover show saved Claude access without asking for setup or changing the connection", (t) => {
  const env = cliEnv(t)
  env.HOME = env.XDG_CONFIG_HOME = env.XDG_DATA_HOME = env.CODEX_HOME = env.HERDR_PLUGIN_CONFIG_DIR
  for (const h of Object.values(HARNESSES)) {
    if (h.bin !== "claude") writeFileSync(path.join(env.HERDR_PLUGIN_CONFIG_DIR, "bin", h.bin), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  }
  const connected = cli(env, ["auth", "connect", "claude", "--name", "claude-personal", "--token-stdin", "--yes"], TOKEN)
  assert.equal(connected.status, 0, connected.stderr)
  const directory = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "connections")
  const before = readConnections(directory)
  for (const args of [["auth"], ["auth", "discover", "--yes"]]) {
    const result = cli(env, args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\| Claude\s+\| OAuth token\s+\| claude-personal\s+\| Configured/)
    assert.doesNotMatch(result.stdout, /claude setup-token|auth connect claude|hand-set|\x1b/)
    assert.ok(!result.stdout.includes(TOKEN))
  }
  assert.deepEqual(readConnections(directory), before)
  assert.equal(connectionMaterial(before[0], { directory }).env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN)
  assert.ok(!readFileSync(path.join(env.HERDR_PLUGIN_CONFIG_DIR, "auth.toml"), "utf8").includes(TOKEN))
})

test("CLI connect/list/explain/check/reconnect/disconnect keep token values off output", (t) => {
  const env = cliEnv(t)
  const connected = cli(env, ["auth", "connect", "claude", "--token-stdin", "--yes"], TOKEN)
  assert.equal(connected.status, 0, connected.stderr)
  assert.match(connected.stdout, /Claude Team · E2B/)
  const listing = cli(env, ["auth", "list", "--json"])
  assert.equal(cli(env, ["--json", "auth", "list"]).stdout, listing.stdout)
  const rows = JSON.parse(listing.stdout)
  assert.equal(rows[0].owner, "Only you")
  assert.equal(rows[0].detectedSubscription, "team")
  assert.equal(rows[0].id, "claude-e2b")
  assert.equal(rows[0].localAccount, "Claude Team · E2B")
  assert.match(connected.stdout, /Access\s+Only you/)
  assert.match(connected.stdout, /connection account unverified/)
  const explain = cli(env, ["auth", "explain", "--template", "claude", "--json"])
  assert.equal(JSON.parse(explain.stdout).selected, "claude-e2b")
  const check = cli(env, ["auth", "check", "claude-e2b", "--json"])
  assert.equal(JSON.parse(check.stdout).providerVerified, false)
  const reconnect = cli(env, ["auth", "reconnect", "claude-e2b", "--token-stdin", "--yes"], replacement)
  assert.equal(reconnect.status, 0, reconnect.stderr)
  const disconnected = cli(env, ["auth", "disconnect", "claude-e2b", "--yes"])
  assert.equal(disconnected.status, 0, disconnected.stderr)
  for (const result of [connected, listing, explain, check, reconnect, disconnected]) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN))
    assert.ok(!`${result.stdout}${result.stderr}`.includes(replacement))
  }
  assert.deepEqual(JSON.parse(cli(env, ["auth", "list", "--json"]).stdout), [])
})

test("explicit names and legacy IDs survive reconnect; name collisions never replace credentials", (t) => {
  const env = cliEnv(t)
  const named = cli(env, ["auth", "connect", "claude", "--name", "claude-personal", "--token-stdin", "--yes"], TOKEN)
  assert.equal(named.status, 0, named.stderr)
  const reconnected = cli(env, ["auth", "reconnect", "claude-personal", "--token-stdin", "--yes"], replacement)
  assert.equal(reconnected.status, 0, reconnected.stderr)
  const directory = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "connections")
  const [record] = readConnections(directory)
  assert.equal(record.id, "claude-personal")
  assert.equal(record.owner, "personal")
  const listing = cli(env, ["auth", "list"])
  assert.match(listing.stdout, /LOCAL ACCOUNT/)
  assert.match(listing.stdout, /Claude Team · E2B/)
  const duplicate = cli(env, ["auth", "connect", "claude", "--name", "claude-personal", "--token-stdin", "--yes"], TOKEN)
  assert.notEqual(duplicate.status, 0)
  assert.match(duplicate.stderr, /already exists.*auth reconnect claude-personal/)
  assert.equal(connectionMaterial(record, { directory }).env.CLAUDE_CODE_OAUTH_TOKEN, replacement)
  assert.equal(readConnections(directory).length, 1)
})

test("CLI refuses sharing, unconfirmed intake, invalid flags, and existing-box changes", (t) => {
  const env = cliEnv(t)
  assert.notEqual(cli(env, ["auth", "connect", "claude", "--org", "e2b", "--yes"], TOKEN).status, 0)
  assert.notEqual(cli(env, ["auth", "connect", "claude", "--token-stdin"], TOKEN).status, 0)
  const invalid = cli(env, ["auth", "connect", "claude", "--token", TOKEN])
  assert.notEqual(invalid.status, 0)
  assert.ok(!invalid.stderr.includes(TOKEN))
  assert.notEqual(cli(env, ["auth", "list", "--yes"]).status, 0)
  mkdirSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "boxes"), { recursive: true })
  writeFileSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "boxes", "test.json"), JSON.stringify({ sandboxId: "fixture", status: "ready" }))
  const existing = cli({ ...env, KEY: "test" }, ["up", "-t", "claude", "--connection", "claude-personal"])
  assert.equal(existing.status, 1)
  assert.match(existing.stderr, /retains its existing credentials/)
  const missing = cli({ ...env, KEY: "new" }, ["up", "-t", "claude", "--connection", "missing"])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Unknown connection/)
  assert.deepEqual(readdirSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "boxes")), ["test.json"])
})

test("Codex connect honors CODEX_HOME and reconnect stays pinned to the original source", (t) => {
  const env = cliEnv(t)
  const sourceDir = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "codex-profile")
  mkdirSync(sourceDir)
  const exp = Math.floor(Date.now() / 1000) + 86400
  const bearer = `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`
  writeFileSync(path.join(sourceDir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: bearer, refresh_token: "refresh-fixture" } }))
  writeFileSync(path.join(env.HERDR_PLUGIN_CONFIG_DIR, "bin", "codex"), '#!/bin/sh\n[ -z "$CODEX_API_KEY" ] && [ -s "$CODEX_HOME/auth.json" ] || exit 1\necho "Logged in using ChatGPT" >&2\n', { mode: 0o755 })
  const connected = cli({ ...env, CODEX_HOME: sourceDir, CODEX_API_KEY: "unused-key" }, ["auth", "connect", "codex", "--yes"])
  assert.equal(connected.status, 0, connected.stderr)
  const directory = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "connections")
  const [record] = readConnections(directory)
  assert.equal(record.path, path.join(sourceDir, "auth.json"))
  assert.deepEqual(readdirSync(directory), ["codex-personal.json"])
  assert.ok(!JSON.stringify(record).includes(bearer))
  assert.ok(!connectionMaterial(record).env.CODEX_AUTH_JSON.includes("refresh-fixture"))
  const reconnected = cli({ ...env, CODEX_HOME: path.join(sourceDir, "not-the-source") }, ["auth", "reconnect", "codex-personal", "--yes"])
  assert.equal(reconnected.status, 0, reconnected.stderr)
})

test("explicit selection reaches the worker without putting the token in its arguments or record", async (t) => {
  const env = cliEnv(t)
  assert.equal(cli(env, ["auth", "connect", "claude", "--token-stdin", "--yes"], TOKEN).status, 0)
  const workerInput = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "worker-input.json")
  const wrapper = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "node-wrapper")
  writeFileSync(wrapper, `#!/bin/sh\ncase "$1" in\n */src/provision.js) printf '%s' "$2" > "$WORKER_INPUT" ;;\n *) exec "$REAL_NODE" "$@" ;;\nesac\n`, { mode: 0o755 })
  const launched = cli({ ...env, KEY: "fresh", HERDR_E2B_NODE: wrapper, REAL_NODE: process.execPath, WORKER_INPUT: workerInput }, ["up", "-t", "drew-claude", "--template-any", "--connection", "claude-e2b"])
  assert.equal(launched.status, 0, launched.stderr)
  let payload
  for (let attempt = 0; attempt < 30; attempt++) {
    try { payload = readFileSync(workerInput, "utf8"); break } catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
  }
  assert.equal(JSON.parse(payload).connection, "claude-e2b")
  assert.equal(JSON.parse(payload).template, "drew-claude")
  assert.ok(!payload.includes(TOKEN))
  assert.ok(!readFileSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "boxes", "fresh.json"), "utf8").includes(TOKEN))
})

test("PTY capture redacts split token output and sends the token only on fd 3", (t) => {
  if (spawnSync("python3", ["-c", "import pty"]).status !== 0) return t.skip("python3 unavailable")
  const root = fixture(t)
  const script = path.join(root, "fake.py")
  writeFileSync(script, `import os, time\ns=${JSON.stringify(`Before\n\u001b[32m${TOKEN}\u001b[0m\nAfter\n`)}\nfor c in s:\n os.write(1,c.encode()); time.sleep(.001)\n`)
  const result = spawnSync("python3", [path.join(ROOT, "bin/lib/capture-setup-token.py"), "python3", script], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"], timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Before/)
  assert.match(result.stdout, /\[token captured\]/)
  assert.match(result.stdout, /After/)
  assert.ok(!result.stdout.includes(TOKEN))
  assert.ok(!result.stderr.includes(TOKEN))
  assert.equal(JSON.parse(result.output[3]).token, TOKEN)
})

test("interactive connect drives the harness and saves the captured token without showing it", (t) => {
  if (spawnSync("python3", ["-c", "import pty"]).status !== 0) return t.skip("python3 unavailable")
  const env = cliEnv(t)
  const fake = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "bin", "claude")
  writeFileSync(fake, `#!/usr/bin/env python3\nimport json,sys\nif sys.argv[1:]==['auth','status']:\n print(json.dumps({'subscriptionType':'team','orgName':'E2B'}))\nelse:\n print('Authorize in your browser')\n print(${JSON.stringify(TOKEN)})\n`, { mode: 0o755 })
  const driver = `import pty,sys,os,select
pid,fd=pty.fork()
if pid==0: os.execv(sys.argv[1],sys.argv[1:])
status=None
while True:
 if select.select([fd],[],[],.1)[0]:
  try: data=os.read(fd,65536)
  except OSError: data=b''
  if data: os.write(1,data)
  elif status is not None: break
 elif status is not None: break
 if status is None:
  done,result=os.waitpid(pid,os.WNOHANG)
  if done: status=result
os.close(fd)
sys.exit(os.waitstatus_to_exitcode(status))`
  const result = spawnSync("python3", ["-c", driver, path.join(ROOT, "bin/e2b-box"), "auth", "connect", "claude", "--yes"], {
    env, encoding: "utf8", timeout: 15000,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN))
  assert.match(result.stdout, /Saved claude-e2b/)
  const directory = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "connections")
  const [record] = readConnections(directory)
  assert.equal(record.owner, "personal")
  assert.equal(record.detected.classification, "organization")
  assert.equal(connectionMaterial(record, { directory }).env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN)
})
