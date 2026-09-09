// Which models and effort words does each shipped agent template ACTUALLY accept?
//
//   node scripts/harness-catalog.mjs [template ...] [--check|--write] [--from=box|local|fixture]
//   npm run catalog -- --write
//
// One throwaway sandbox per template (the default, `--from=box`), booted with the
// env a fleet member would get, running that harness's own catalog probes: its
// version, the rejection message that lists its effort words, the command or file
// that lists its models (src/catalog.js, CATALOG_PROBES). What it read is compared
// with src/harness-catalog.generated.js and, with `--write`, written there, into the
// table in config/config.example.toml, and into test/fixtures/catalog/ so `npm test`
// re-derives the same rows offline.
//
// Why the box and not this machine: the template ships an older CLI than a laptop
// in every case measured but one (docs/research/0003), and the CLI in the box is
// the one that will accept or reject a pin. `--from=local` asks the binaries on
// PATH instead: quick, and wrong for the box whenever the two differ, so rows it
// writes are marked `probedFrom: "local"`. `--from=fixture` re-reads the captured
// output and writes nothing new about the world; it is how a parse-rule change is
// replayed and what test/catalog.test.js does.
//
// Exit codes: 0 nothing moved · 2 drift found (a finding, not an error: the world
// changed and the committed rows have not) · 1 usage, or a probe that could not be
// trusted. THE TWO RULES: a credential is never printed and never on a command line
// (probes run unauthenticated or read a variable the box already holds; this output
// is safe to paste into a PR), and a failed probe never blanks a row (the committed
// one is kept and marked stale, since an unauthenticated run must not empty every scale).
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  CATALOG_PROBES,
  diffRow,
  interpretCatalog,
  mergeCatalog,
  renderGeneratedModule,
  renderTomlBlock,
  spliceTomlBlock,
} from "../src/catalog.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GENERATED = path.join(ROOT, "src", "harness-catalog.generated.js")
const TOML = path.join(ROOT, "config", "config.example.toml")
const FIXTURES = path.join(ROOT, "test", "fixtures", "catalog")
const execFileP = promisify(execFile)

const usage = (code, msg) => {
  if (msg) console.error(`harness-catalog: ${msg}`)
  console.error("usage: node scripts/harness-catalog.mjs [template ...] [--check|--write] [--from=box|local|fixture]")
  process.exit(code)
}

let mode = "check"
let from = "box"
const names = []
for (const a of process.argv.slice(2)) {
  if (a === "--check" || a === "--write") mode = a.slice(2)
  else if (a.startsWith("--from=")) from = a.slice("--from=".length)
  else if (a === "-h" || a === "--help") usage(0)
  else if (a.startsWith("-")) usage(1, `unknown flag ${a}`)
  else names.push(a)
}
if (!["box", "local", "fixture"].includes(from)) usage(1, `--from must be box, local or fixture, not ${from}`)
const templates = names.length ? names : Object.keys(CATALOG_PROBES)
for (const t of templates) if (!CATALOG_PROBES[t]) usage(1, `no catalog probes for '${t}' (known: ${Object.keys(CATALOG_PROBES).join(", ")})`)

const committed = existsSync(GENERATED) ? (await import(GENERATED)).HARNESS_CATALOG : {}
const probedAt = new Date().toISOString()

// --- transports ---------------------------------------------------------------------
// Each returns { stdout, stderr, status }; `status` is null when the command never ran
// or never came back. Parse rules read stdout+stderr and ignore status on purpose.

const fetched = new Map()
async function get(url) {
  if (!fetched.has(url)) {
    fetched.set(
      url,
      fetch(url)
        .then(async (res) => ({ stdout: await res.text(), stderr: "", status: res.status }))
        .catch((e) => ({ stdout: "", stderr: String(e?.message || e), status: null })),
    )
  }
  return fetched.get(url)
}

// `/bin/sh -c`, not the user's shell: an interactive zsh here shadows two of these
// binaries with functions that rewrite their arguments.
async function runLocal(cmd) {
  try {
    const { stdout, stderr } = await execFileP("/bin/sh", ["-c", cmd], { timeout: 90000, maxBuffer: 64 << 20 })
    return { stdout, stderr, status: 0 }
  } catch (e) {
    return { stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(e?.message || e), status: typeof e?.code === "number" ? e.code : null }
  }
}

async function probeLocal(spec) {
  const out = {}
  for (const [name, p] of Object.entries(spec.probes)) out[name] = p.url ? await get(p.url) : await runLocal(p.cmd)
  return out
}

let box = null
async function boxDeps() {
  if (box) return box
  const [{ Sandbox }, { loadConfig, resolveEnv }, { seedCommand }] = await Promise.all([
    import("e2b"),
    import("../src/config.js"),
    import("../src/fleet-seed.js"),
  ])
  const cfg = loadConfig()
  if (!cfg.apiKey) usage(1, "no E2B API key (E2B_API_KEY, config.toml, or `e2b auth login`), needed for --from=box")
  const conn = { apiKey: cfg.apiKey, ...(cfg.domain ? { domain: cfg.domain } : {}) }
  box = { Sandbox, cfg, conn, resolveEnv, seedCommand }
  return box
}

async function runBox(sbx, cmd) {
  // droid installs to ~/.local/bin, which a non-interactive shell does not have on
  // PATH; harmless for the others.
  const line = `export PATH="$HOME/.local/bin:$PATH"; ${cmd}`
  try {
    const r = await sbx.commands.run(line, { timeoutMs: 120000, cwd: "/home/user" })
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.exitCode ?? 0 }
  } catch (e) {
    // A non-zero exit throws, with the output on the thrown object. Expected for
    // every rejection oracle.
    const r = e?.result
    return { stdout: r?.stdout ?? "", stderr: r?.stderr ?? (r ? "" : String(e?.message || e)), status: typeof r?.exitCode === "number" ? r.exitCode : null }
  }
}

async function probeBox(template, spec) {
  const { Sandbox, cfg, conn, resolveEnv, seedCommand } = await boxDeps()
  const envs = resolveEnv(cfg, template) || {}
  const sbx = await Sandbox.create(template, { ...conn, envs, timeoutMs: 600000 })
  try {
    // Exactly as src/provision.js seeds a member: codex reads its credential from
    // ~/.codex/auth.json, grok's cache only exists after an authenticated command.
    const seed = seedCommand(template, cfg.fleetSeeds)
    if (seed) {
      await sbx.files.write("/home/user/.herdr-e2b-seed.sh", `${seed}\n`)
      await sbx.commands.run('bash "$HOME/.herdr-e2b-seed.sh"', { cwd: "/home/user" }).catch(() => {})
    }
    const out = {}
    for (const [name, p] of Object.entries(spec.probes)) out[name] = p.url ? await get(p.url) : await runBox(sbx, p.cmd)
    return out
  } finally {
    await sbx.kill().catch(() => {})
  }
}

/**
 * Which build of each template is live, so a row can say which image it was read
 * from. The listing is this TEAM's templates: a name that resolves to the team's own
 * image (`ondrejs-project/claude` behind the alias `claude`) gets its build; a public
 * E2B template is not listed and gets none. Best-effort, never fatal.
 */
async function templateBuilds() {
  if (from !== "box") return {}
  const { cfg } = await boxDeps()
  try {
    const res = await fetch(`https://api.${cfg.domain || "e2b.app"}/templates`, { headers: { "X-API-KEY": cfg.apiKey } })
    if (!res.ok) return {}
    const list = await res.json()
    const out = {}
    for (const t of templates) {
      const hit = (Array.isArray(list) ? list : []).find(
        (x) => x?.templateID === t || (x?.aliases || []).includes(t) || (x?.names || []).includes(t),
      )
      if (hit) out[t] = { name: hit.names?.[0] ?? hit.aliases?.[0] ?? t, buildID: hit.buildID ?? null, updatedAt: hit.updatedAt ?? null }
    }
    return out
  } catch {
    return {}
  }
}

// --- fixtures -------------------------------------------------------------------------

const fixturePath = (id) => path.join(FIXTURES, `${id}.json`)
function readFixture(id) {
  const f = fixturePath(id)
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, "utf8"))
}
function writeFixture(id, spec, results, version) {
  const probes = {}
  for (const [name, r] of Object.entries(results)) {
    const trim = spec.probes[name]?.trim
    let stdout = r.stdout
    if (trim && r.stdout) {
      try {
        stdout = trim(r.stdout)
      } catch {}
    }
    probes[name] = { stdout, stderr: r.stderr, status: r.status }
  }
  mkdirSync(FIXTURES, { recursive: true })
  writeFileSync(fixturePath(id), `${JSON.stringify({ harness: id, version, probedFrom: from, capturedAt: probedAt, probes }, null, 2)}\n`)
}

// --- the run --------------------------------------------------------------------------

async function probe(id) {
  const spec = CATALOG_PROBES[id]
  try {
    if (from === "fixture") {
      const fx = readFixture(id)
      if (!fx) return { id, results: null, reason: `no fixture at test/fixtures/catalog/${id}.json` }
      // A replay says where the CAPTURE came from, not "fixture".
      return { id, results: fx.probes, probedFrom: fx.probedFrom, probedAt: fx.capturedAt }
    }
    const results = from === "box" ? await probeBox(id, spec) : await probeLocal(spec)
    return { id, results }
  } catch (e) {
    const body = `${e?.result?.stdout || e?.stdout || ""}${e?.result?.stderr || e?.stderr || ""}`.trim()
    const tail = body ? body.split("\n").filter(Boolean).slice(-3).join(" / ") : String(e?.message || e)
    return { id, results: null, reason: tail.slice(0, 240) }
  }
}

console.log(`reading ${templates.length} harness catalog(s) from ${from}${from === "box" ? ", one sandbox each, killed on the way out" : ""}\n`)
const [probed, builds] = await Promise.all([Promise.all(templates.map(probe)), templateBuilds()])

const fresh = {}
let failed = 0
let drifted = 0
const lines = []
for (const { id, results, reason, probedFrom: rowFrom, probedAt: rowAt } of probed) {
  const row = results ? interpretCatalog(id, results) : null
  if (!row) {
    failed++
    const why = reason || `probe output did not parse (${Object.keys(results || {}).join(", ")})`
    fresh[id] = { row: null, reason: why }
    const kept = committed[id] ? `; row kept from ${String(committed[id].probedAt || "").slice(0, 10) || "an earlier run"}, marked stale` : "; no committed row to keep"
    lines.push(`✗ ${id.padEnd(9)} ${why}${kept}`)
    continue
  }
  fresh[id] = { row, ...(rowFrom ? { probedFrom: rowFrom } : {}), ...(rowAt ? { probedAt: rowAt } : {}) }
  const diff = diffRow(committed[id], row)
  if (diff.length) drifted++
  const models = row.models ? `models ${row.models.length}` : "models -"
  const efforts = row.modes ? `modes ${row.modes.length}` : row.efforts ? `efforts ${row.efforts.length}` : "efforts -"
  const build = builds[id]?.buildID ? ` build ${String(builds[id].buildID).slice(0, 8)}` : ""
  lines.push(`${diff.length ? "~" : "✓"} ${id.padEnd(9)} ${row.version.padEnd(14)} ${efforts.padEnd(10)} ${models.padEnd(11)}${build}${diff.length ? `  drift: ${diff.join("; ")}` : ""}`)
  if (mode === "write" && from !== "fixture" && results) writeFixture(id, CATALOG_PROBES[id], results, row.version)
}
for (const l of lines) console.log(l)

const merged = mergeCatalog(committed, fresh, { probedFrom: from, probedAt, templates: builds })

if (mode === "write") {
  writeFileSync(GENERATED, renderGeneratedModule(merged, { probedAt }))
  const toml = readFileSync(TOML, "utf8")
  writeFileSync(TOML, spliceTomlBlock(toml, renderTomlBlock(merged)))
  console.log(`\nwrote ${path.relative(ROOT, GENERATED)}, the <catalog> block in ${path.relative(ROOT, TOML)}${from !== "fixture" ? `, ${path.relative(ROOT, FIXTURES)}/` : ""}`)
  if (from === "local") console.log("note: rows read from this machine's binaries are marked probedFrom: \"local\"; the template's CLI is the one that counts; rerun with --from=box before shipping")
} else {
  console.log(`\n${drifted ? `${drifted} row(s) drifted, rerun with --write to accept` : "no drift"}${failed ? `, ${failed} probe(s) failed` : ""}`)
}

process.exit(failed ? 1 : drifted && mode === "check" ? 2 : 0)
