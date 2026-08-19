import test from "node:test"
import assert from "node:assert/strict"
import { runProbe, probeAll, formatRow } from "../src/harness-probe.js"
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
