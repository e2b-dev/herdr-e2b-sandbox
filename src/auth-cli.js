import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
import { parseArgs } from "node:util"
import { createInterface } from "node:readline/promises"
import { loadConfig, resolveEnv } from "./config.js"
import { CONFIG_PATH, AUTH_PATH, CONNECTIONS_DIR } from "./config-paths.js"
import { runProbe } from "./harness-probe.js"
import { HARNESSES, readHarnessFile } from "./harnesses.js"
import {
  classifySubscription, connectionId, connectionMaterial, localAccountLabel, readConnections,
  removeConnection, saveConnection, selectConnection, suggestedConnectionId, validSetupToken,
} from "./connections.js"

const HELP = `e2b-box auth — coding-agent connections

  auth                            interactive auth manager (table when piped)
  auth discover [--yes]            report and save discovered sources
  auth --yes                      save discovery without opening the manager
  auth connect claude [--user]     run Claude setup-token and save privately
  auth connect claude --token-stdin --yes
                                  accept an existing token over stdin
  auth connect codex [--user]      borrow the current local Codex session
  auth connect <agent> --name ID   choose a connection name
  auth list [--json]               list connections without reading tokens
  auth explain --template NAME [--connection ID] [--json]
                                  show selection without launching a box
  auth check ID [--json]           check local availability and known expiry
  auth reconnect ID               replace token / recheck session source
  auth disconnect ID [--yes]      remove local connection and stored tokens

  --user                          personal access (default), even on a Team plan
  --org NAME                      reserved; shared organization service required
  --yes, -y                       accept the displayed destination
  --token-stdin                   Claude token input; never put tokens in argv

Connect makes the only connection for that agent its default for NEW boxes.
Manager: arrows/j/k, numbers, Enter for actions; f config, a auth.toml,
s save discovery, r refresh, q/Esc quit. File opening uses dashboard.config_opener.
With several connections, select --connection ID or templates.<name>.connection.
Local subscription detection does not verify a newly authorized account.
Claude names use the detected organization (e.g. claude-e2b), personal for Pro/Max,
or local when unknown. --name overrides this; names never grant shared access.
Check validates local material, not provider acceptance; it makes no model call.
Codex borrowing excludes its real refresh token and lasts until bearer expiry.
Reconnect/disconnect do not change or revoke credentials already inside a box.
`

function output(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2))
  else for (const [label, detail] of Object.entries(value)) console.log(`  ${label.padEnd(15)} ${detail ?? "unknown"}`)
}

async function confirm(message, yes) {
  if (yes) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Confirmation needs a terminal; use --yes to accept this destination.")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (!/^y(es)?$/i.test((await rl.question(`\n  ${message} [y/N] `)).trim())) throw new Error("Cancelled. Nothing was changed.")
  } finally { rl.close() }
}

async function captureToken() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Claude login needs a terminal. Use --token-stdin --yes for an existing setup-token.")
  const bridge = fileURLToPath(new URL("../bin/lib/capture-setup-token.py", import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [bridge, "claude", "setup-token"], { stdio: ["inherit", "inherit", "inherit", "pipe"] })
    let result = ""
    child.stdio[3].on("data", (data) => { result += data; if (result.length > 8192) child.kill() })
    child.on("error", () => reject(new Error("Interactive capture requires python3. Alternatively use claude setup-token, then auth connect claude --token-stdin --yes.")))
    child.on("close", (code) => {
      try {
        const { token } = JSON.parse(result)
        if (code !== 0 || !validSetupToken(token)) throw new Error()
        resolve(token)
      } catch { reject(new Error("Claude setup-token did not complete. Nothing was saved.")) }
    })
  })
}

async function detectClaude() {
  const probe = await runProbe("claude", ["auth", "status"])
  try { return classifySubscription(JSON.parse(probe.stdout)) } catch { return classifySubscription() }
}

function parse(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, yes: { type: "boolean", short: "y" },
    user: { type: "boolean" }, org: { type: "string" }, name: { type: "string" },
    "token-stdin": { type: "boolean" }, json: { type: "boolean" },
    template: { type: "string", short: "t" }, connection: { type: "string" },
  } })
  return { values, positionals }
}

async function main() {
  const { values: options, positionals } = parse(process.argv.slice(2))
  if (options.help || positionals[0] === "help") { console.log(HELP); return }
  const [verb, target, ...rest] = positionals
  const allowed = {
    connect: ["yes", "user", "org", "name", "token-stdin"],
    reconnect: ["yes", "token-stdin"], disconnect: ["yes"],
    list: ["json"], check: ["json"], explain: ["json", "template", "connection"],
    preflight: ["template", "connection"],
  }
  if (!allowed[verb]) throw new Error("Unknown auth command. Run e2b-box auth --help.")
  if (rest.length || (["list", "explain", "preflight"].includes(verb) ? target : !target)) throw new Error("Unexpected or missing argument. Run e2b-box auth --help.")
  for (const key of Object.keys(options)) if (!allowed[verb].includes(key)) throw new Error(`--${key} is not supported by auth ${verb}.`)
  if (options.org !== undefined) throw new Error("Organization sharing needs a shared service, which is not configured. Use --user; Team/Enterprise details are detected separately.")
  const records = readConnections()

  if (verb === "list") {
    const rows = records.map((c) => ({ id: c.id, agent: c.harness, owner: "Only you", method: c.method,
      detectedSubscription: c.detected?.subscription || "unknown", detectedOrganization: c.detected?.organization || null,
      detectionSource: c.detected?.source || null, localAccount: localAccountLabel(c.harness, c.detected),
      status: c.method === "setup-token" && c.expiresAt && Date.parse(c.expiresAt) <= Date.now() ? "expired" : "configured",
      expiresAt: c.expiresAt || null }))
    if (options.json) console.log(JSON.stringify(rows, null, 2))
    else if (!rows.length) console.log("No connections. Run e2b-box auth connect claude or e2b-box auth discover.")
    else {
      console.log("CONNECTION             AGENT    ACCESS     METHOD             LOCAL ACCOUNT            STATUS")
      for (const c of rows) console.log(`${c.id.padEnd(22)} ${c.agent.padEnd(8)} ${c.owner.padEnd(10)} ${c.method.padEnd(18)} ${c.localAccount.padEnd(24)} ${c.status}`)
      console.log("\nLocal account describes the login detected at setup, not a verified connection account. Access is separate from the subscription plan. Use auth check ID for local readiness.")
    }
    return
  }

  if (verb === "explain" || verb === "preflight") {
    if (!options.template) throw new Error("--template NAME is required.")
    const cfg = { ...loadConfig(), selectedConnection: options.connection }
    const selected = selectConnection(cfg, options.template)
    if (verb === "preflight") {
      resolveEnv(cfg, options.template, process.env)
      if (selected) output({ Connection: selected.id, Access: "Only you", Method: selected.method })
    } else {
      output({ selected: selected?.id || null, template: options.template, owner: selected?.owner || null,
        method: selected?.method || "existing discovery/config",
        reason: options.connection ? "explicit --connection" : cfg.templateConnections?.[options.template] ? "template configuration" : selected ? "only personal connection for this agent" : "no managed connection; existing precedence applies",
        expiresAt: selected?.expiresAt || null,
        ...(selected ? { localAccount: localAccountLabel(selected.harness, selected.detected), access: "Only you",
          sourcePath: selected.path || path.join(CONNECTIONS_DIR, `${selected.id}.json`),
          accountNote: "Local login detected at setup; connection account unverified." } : {}),
        configPath: CONFIG_PATH, discoveryPath: AUTH_PATH,
        providerVerified: false,
      }, options.json)
    }
    return
  }

  if (verb !== "connect") connectionId(target)
  const existing = records.find((c) => c.id === target)
  if (verb !== "connect" && !existing) throw new Error(`Unknown connection '${target}'.`)
  if (verb === "check") {
    const material = connectionMaterial(existing)
    output({ connection: existing.id, status: "locally-ready", expiresAt: material.expiresAt,
      providerVerified: false, detail: "Credential available; provider acceptance has not been tested." }, options.json)
    return
  }
  if (verb === "disconnect") {
    await confirm(`Remove local connection '${target}'? Existing boxes retain their credentials.`, options.yes)
    removeConnection(target)
    console.log(`Removed ${target}. Existing boxes and the provider login were not changed.`)
    return
  }

  const harness = verb === "reconnect" ? existing.harness : target
  if (!["claude", "codex"].includes(harness)) throw new Error("Managed connections currently support claude and codex. Use auth discover for other agents.")
  if (options["token-stdin"] && harness !== "claude") throw new Error("--token-stdin is only supported for Claude setup-token.")
  const detected = harness === "claude" ? await detectClaude() : undefined
  const id = connectionId(verb === "reconnect" ? existing.id : options.name ?? suggestedConnectionId(harness, detected))
  if (verb === "connect" && records.some((c) => c.id === id)) throw new Error(`Connection '${id}' already exists. Run e2b-box auth reconnect ${id}.`)
  output({ Connection: id, ...(detected ? { "Local account": localAccountLabel(harness, detected) } : {}),
    Access: "Only you", Method: harness === "claude" ? "Claude setup-token" : "Borrowed Codex session" })
  if (detected) console.log("  Account check   Local login detected; connection account unverified.")
  if (verb === "connect" && !options.name && detected) console.log("  Name source     Local account suggestion; use --name to choose another.")
  if (harness === "codex") console.log("  Refresh token   Not copied; boxes use this session only until its bearer expires.")
  await confirm("Save this connection as the default when it is the only one for this agent?", options.yes)
  let record = { id, harness, detected, method: harness === "claude" ? "setup-token" : "borrowed-session" }
  let token
  if (harness === "claude") {
    const startedAt = Date.now()
    token = options["token-stdin"] ? readFileSync(0, "utf8").trim() : await captureToken()
    if (!validSetupToken(token)) throw new Error("Expected a Claude setup-token value; nothing was saved.")
    // Pasted tokens have an unknown mint time. Never invent a one-year expiry.
    record.expiresAt = options["token-stdin"] ? null : new Date(startedAt + 365 * 86400000).toISOString()
  } else {
    const source = existing?.path || (process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME, "auth.json") : HARNESSES.codex.sessionFile.path)
    record.path = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : path.resolve(source)
    const probeEnv = { ...process.env, CODEX_HOME: path.dirname(record.path) }
    delete probeEnv.OPENAI_API_KEY
    delete probeEnv.CODEX_API_KEY
    const probe = await runProbe("codex", ["login", "status"], {
      env: probeEnv,
    })
    if (probe.status !== 0 || !/Logged in using ChatGPT/i.test(`${probe.stdout}\n${probe.stderr}`)) throw new Error("Sign in locally with codex first, then connect again.")
    record.expiresAt = connectionMaterial(record, { readFile: readHarnessFile }).expiresAt
  }
  record = saveConnection(record, token, { replace: verb === "reconnect" })
  console.log(`\n✓ Saved ${record.id} (configured; provider acceptance unverified).`)
  console.log(`  Inspect: e2b-box auth explain --template ${harness} --connection ${id}`)
  console.log("  Changes apply to new boxes. Existing boxes keep their credentials.")
}

main().catch((error) => {
  // parseArgs embeds the offending argv in its errors; never echo an accidental token.
  console.error(`e2b-box auth: ${error.code?.startsWith("ERR_PARSE_ARGS") ? "Invalid arguments. Run e2b-box auth --help." : error.message}`)
  process.exitCode = 1
})
