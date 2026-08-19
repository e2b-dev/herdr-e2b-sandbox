import test from "node:test"
import assert from "node:assert/strict"
import { runProbe, probeAll, resolveFromFile, formatRow } from "../src/harness-probe.js"
import { HARNESSES, interpretProbe } from "../src/harnesses.js"

// --- the two probe properties that are not optional ---------------------------

test("runProbe: a binary that does not exist reports notFound, it does not throw", () => {
  return runProbe("herdr-e2b-no-such-binary-anywhere", ["--version"]).then((r) => {
    assert.equal(r.notFound, true)
  })
})

test("runProbe: a command that outlives its timeout is killed and says so", async () => {
  // The real hazard this defends against: one shipped harness with no credential
  // opens a browser and waits on stdin forever.
  const r = await runProbe("sleep", ["10"], { timeoutMs: 150 })
  assert.equal(r.timedOut, true)
})

test("runProbe: a probe cannot read stdin, so it can never block asking for input", async () => {
  // `cat` with an inherited stdin would hang here forever. It exits immediately
  // because stdin is /dev/null.
  const r = await runProbe("cat", [], { timeoutMs: 2000 })
  assert.equal(r.timedOut, false)
  assert.equal(r.status, 0)
})

test("runProbe: stdout and stderr are captured separately", async () => {
  // One shipped harness writes its auth status only to stderr — a capture that
  // merged or dropped it would read a working install as logged out.
  const r = await runProbe("sh", ["-c", "echo out; echo err >&2"])
  assert.match(r.stdout, /out/)
  assert.match(r.stderr, /err/)
})

// --- the report tells the three states apart ----------------------------------

test("formatRow: unknown is never rendered as absent", () => {
  const unknown = formatRow({ id: "claude", installed: true, state: "unknown", source: null, hostVar: "ANTHROPIC_API_KEY" })
  const absent = formatRow({ id: "claude", installed: false, state: "no-key", source: null, hostVar: "ANTHROPIC_API_KEY" })
  assert.notEqual(unknown, absent)
  assert.doesNotMatch(unknown, /not installed/)
})

test("formatRow: every state that needs a variable set names it", () => {
  for (const state of [
    { installed: true, state: "no-key", source: null },
    { installed: true, state: "no-key", source: "login" },
    { installed: true, state: "unknown", source: null },
  ]) {
    const row = formatRow({ id: "claude", hostVar: "ANTHROPIC_API_KEY", ...state })
    assert.match(row, /ANTHROPIC_API_KEY/)
  }
})

test("formatRow: a borrowable credential says where it came from", () => {
  const row = formatRow({ id: "claude", installed: true, state: "authenticated", source: "env", hostVar: "ANTHROPIC_API_KEY" })
  assert.match(row, /env/)
})

test("a probe that really times out really lands on unknown", async () => {
  // The pure test for this asserts on a `timedOut` flag. This one earns it: a real
  // spawn, really killed, carried through interpretProbe to the state the user sees.
  const probe = await runProbe("sleep", ["10"], { timeoutMs: 150 })
  const r = interpretProbe("claude", { ...probe, env: {} })
  assert.equal(r.state, "unknown")
  assert.equal(r.installed, true)
})

// --- the seven arrive: probing stays cheap and stays honest --------------------

test("probeAll: every harness in the table gets a row, even with none installed", async () => {
  // The machine CI runs on. Seven binaries that are not there must still produce
  // seven rows, because a missing harness is a finding and not a gap.
  const rows = await probeAll({ timeoutMs: 500, env: {} })
  assert.equal(rows.length, Object.keys(HARNESSES).length)
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    Object.keys(HARNESSES).sort(),
  )
})

test("a harness that reports its version on stderr is still detected as installed", async () => {
  // prime-agent writes `--version` to stderr. Installedness is decided by whether
  // the spawn found a binary at all — never by which stream answered — so this has
  // to hold for a command that says nothing on stdout.
  const version = await runProbe("sh", ["-c", "echo 0.7.0 >&2"])
  assert.equal(version.notFound, undefined)
  assert.equal(version.stdout, "")
  assert.match(version.stderr, /0\.7\.0/)
  const r = interpretProbe("prime", {
    status: 0,
    stdout: "",
    stderr: "No models available. Use /login to log into a provider via OAuth or API key.\n",
    env: {},
  })
  assert.equal(r.installed, true)
})

test("formatRow: the harness with no credential variable is told what to do instead", () => {
  // "no key — set null" would be worse than saying nothing. opencode has no single
  // variable to name, so its row carries its own advice.
  const row = formatRow({ id: "opencode", installed: true, state: "no-key", source: null, hostVar: null })
  assert.doesNotMatch(row, /null/)
  assert.match(row, /opencode auth login/)
})

test("formatRow: every other row still names the variable to set", () => {
  for (const [id, h] of Object.entries(HARNESSES)) {
    if (!h.hostVar) continue
    const row = formatRow({ id, installed: true, state: "no-key", source: null, hostVar: h.hostVar })
    assert.match(row, new RegExp(h.hostVar), id)
  }
})

// ── the file tie-break: a probe that says "signed in" is not the last word ─────
// probeHarness does the IO, so the reader is injected and none of this needs amp,
// prime or codex installed.

const loginRow = (id) => ({ id, installed: true, state: "no-key", source: "login" })

test("a login-only probe is upgraded to `file` when the config file holds a key", () => {
  const r = resolveFromFile(loginRow("prime"), { readFile: () => '{"api_key":"pk-from-the-file"}' })
  assert.equal(r.state, "authenticated")
  assert.equal(r.source, "file")
})

test("an empty config file leaves the row exactly as the probe found it", () => {
  assert.equal(resolveFromFile(loginRow("prime"), { readFile: () => '{"api_key":""}' }).state, "no-key")
  assert.equal(resolveFromFile(loginRow("prime"), { readFile: () => null }).state, "no-key")
})

test("a malformed config file is absent, not a crash", () => {
  assert.equal(resolveFromFile(loginRow("prime"), { readFile: () => "not json at all" }).state, "no-key")
})

test("a row that already resolved from the environment is left alone", () => {
  // The env rung is checked first and must stay first: it is the surface the user
  // controls most directly, and re-labelling it `file` would misreport where a box's
  // credential actually came from.
  const envRow = { id: "prime", installed: true, state: "authenticated", source: "env" }
  assert.deepEqual(resolveFromFile(envRow, { readFile: () => '{"api_key":"x"}' }), envRow)
})

test("a harness with no reader is never upgraded, whatever the file says", () => {
  // droid and claude keep their credential in a store this plugin does not open.
  for (const id of ["droid", "claude"]) {
    assert.notEqual(resolveFromFile(loginRow(id), { readFile: () => '{"api_key":"nope"}' }).source, "file")
  }
})
