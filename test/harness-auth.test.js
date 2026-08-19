import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import TOML from "@iarna/toml"

import { HARNESSES } from "../src/harnesses.js"

import {
  buildPlan,
  renderAuthToml,
  writeAuthFile,
  formatPlan,
  invisibleToLoginShell,
  formatForwardWarning,
} from "../src/harness-auth.js"

// Rows here are what src/harness-probe.js hands back — the SHAPE interpretProbe
// returns, hand-written so none of this needs a harness installed.
const row = (o) => ({ installed: true, state: "no-key", source: null, hostVar: null, ...o })

const noFiles = () => null

// --- store versus forward: the rule ADR 0006 fixes -----------------------------

test("a key found in the environment records the NAME and never the value", () => {
  const plan = buildPlan(
    [row({ id: "claude", state: "authenticated", source: "env", hostVar: "ANTHROPIC_API_KEY" })],
    { readText: noFiles },
  )
  assert.deepEqual(plan.entries, [
    {
      id: "claude",
      template: "claude",
      kind: "forward",
      boxVar: "ANTHROPIC_API_KEY",
      hostVar: "ANTHROPIC_API_KEY",
    },
  ])
  assert.doesNotMatch(renderAuthToml(plan), /sk-ant-secret/)
})

test("a key found in a file is recorded as a POINTER, not copied", () => {
  const plan = buildPlan([row({ id: "codex", state: "authenticated", source: "file" })], {
    readText: (p) => (p.endsWith("/.codex/auth.json") ? '{"OPENAI_API_KEY":"sk-oai-from-file"}' : null),
  })
  assert.equal(plan.entries.length, 1)
  assert.deepEqual(plan.entries[0], {
    id: "codex",
    template: "codex",
    kind: "value",
    boxVar: "OPENAI_API_KEY",
    path: "~/.codex/auth.json",
    harness: "codex",
    from: "~/.codex/auth.json",
  })
  // The file was read — that is how we know there is a key to point at — but the
  // key itself is not kept.
  assert.equal(plan.entries[0].value, undefined)
})

test("the box variable is what gets written, not the host variable", () => {
  // codex is the row where they are furthest apart: CODEX_API_KEY authenticates
  // this machine, OPENAI_API_KEY is what a box needs.
  const plan = buildPlan(
    [row({ id: "codex", state: "authenticated", source: "env", hostVar: "CODEX_API_KEY" })],
    { readText: noFiles },
  )
  assert.equal(plan.entries[0].boxVar, "OPENAI_API_KEY")
  assert.equal(plan.entries[0].hostVar, "CODEX_API_KEY")
})

// --- what must NOT be written --------------------------------------------------

test("a file-sourced key whose file cannot be read is a gap, not a guess", () => {
  const plan = buildPlan([row({ id: "codex", state: "authenticated", source: "file" })], {
    readText: noFiles,
  })
  assert.deepEqual(plan.entries, [])
  assert.equal(plan.gaps.length, 1)
  assert.match(plan.gaps[0].why, /could not be read/)
})

test("a file-sourced key whose file is malformed is a gap, and nothing throws", () => {
  const plan = buildPlan([row({ id: "codex", state: "authenticated", source: "file" })], {
    readText: () => "{not json",
  })
  assert.deepEqual(plan.entries, [])
  assert.equal(plan.gaps.length, 1)
})

test("an env-sourced harness with no variable name to record is skipped, never guessed", () => {
  // opencode resolves providers from a registry of ~190 variable names, so there
  // is no single name to forward. The plugin writes nothing rather than pick one.
  const plan = buildPlan(
    [row({ id: "opencode", state: "authenticated", source: "env", hostVar: null })],
    { readText: noFiles },
  )
  assert.deepEqual(plan.entries, [])
  assert.equal(plan.gaps.length, 1)
})

test("an installed harness with no readable credential is a gap naming its variables", () => {
  const plan = buildPlan([row({ id: "amp", state: "no-key", source: "login", hostVar: "AMP_API_KEY" })], {
    readText: noFiles,
  })
  assert.deepEqual(plan.entries, [])
  assert.equal(plan.gaps[0].installed, true)
  assert.equal(plan.gaps[0].hostVar, "AMP_API_KEY")
  assert.equal(plan.gaps[0].boxVar, "AMP_API_KEY")
})

test("a harness that is not installed is not a gap to paste — there is nothing to fix", () => {
  const plan = buildPlan([row({ id: "amp", installed: false, hostVar: "AMP_API_KEY" })], {
    readText: noFiles,
  })
  assert.deepEqual(plan.entries, [])
  assert.deepEqual(plan.gaps, [])
})

test("an unknown probe is reported, and writes nothing", () => {
  const plan = buildPlan([row({ id: "droid", state: "unknown", hostVar: "FACTORY_API_KEY" })], {
    readText: noFiles,
  })
  assert.deepEqual(plan.entries, [])
  assert.equal(plan.gaps.length, 1)
})

// --- the generated file --------------------------------------------------------

test("the generated file says it is generated and must not be hand-edited", () => {
  const body = renderAuthToml(buildPlan([], { readText: noFiles }))
  assert.match(body, /e2b-box auth/)
  assert.match(body, /do not edit/i)
})

test("pointers and forwarded names land in tables a config loader can read", () => {
  const plan = buildPlan(
    [
      row({ id: "claude", state: "authenticated", source: "env", hostVar: "ANTHROPIC_API_KEY" }),
      row({ id: "codex", state: "authenticated", source: "file" }),
    ],
    { readText: () => '{"OPENAI_API_KEY":"sk-oai-from-file"}' },
  )
  const body = renderAuthToml(plan)
  const parsed = TOML.parse(body)
  assert.deepEqual(parsed.templates.codex.file, {
    var: "OPENAI_API_KEY",
    path: "~/.codex/auth.json",
    harness: "codex",
  })
  assert.deepEqual(parsed.templates.claude.forward, { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" })
  // The forwarded row must not also appear as a pointer.
  assert.equal(parsed.templates.claude.file, undefined)
  // And the key itself is nowhere in the file.
  assert.ok(!body.includes("sk-oai-from-file"))
})

test("a pointer file holds no credential, whatever the harness's file contains", () => {
  // opencode's box variable is a whole auth.json inline — the largest value this
  // feature ever handled, and now the clearest demonstration that none of it lands.
  const plan = buildPlan([row({ id: "opencode", state: "authenticated", source: "file" })], {
    readText: () => '{"anthropic": {"type": "api", "key": "sk-x"}}',
  })
  const body = renderAuthToml(plan)
  assert.ok(!body.includes("sk-x"))
  assert.deepEqual(TOML.parse(body).templates.opencode.file.var, "OPENCODE_AUTH_CONTENT")
})

test("an oauth entry beside an api key is dropped by the reader, never forwarded", () => {
  // ADR 0006 will not carry a token cache. opencode's auth.json can hold both kinds
  // at once, and handing the file over whole would put an access/refresh pair into a
  // box the moment one api entry sat beside it. The filtering used to happen before
  // the value was written down; with a pointer it happens at box-create time, so it
  // is asserted on the READER, which is where it now lives.
  const read = HARNESSES.opencode.valueFile.read
  const out = read(
    JSON.stringify({
      openai: { type: "oauth", access: "at-secret", refresh: "rt-secret" },
      anthropic: { type: "api", key: "sk-x" },
    }),
  )
  assert.ok(!out.includes("rt-secret"))
  assert.ok(!out.includes("at-secret"))
  assert.ok(out.includes("sk-x"))
})

test("an auth.json holding nothing but oauth is a gap, not a forwarded token cache", () => {
  const plan = buildPlan([row({ id: "opencode", state: "authenticated", source: "file" })], {
    readText: () => JSON.stringify({ openai: { type: "oauth", refresh: "rt-secret" } }),
  })
  assert.deepEqual(plan.entries, [])
  assert.equal(plan.gaps.length, 1)
  assert.doesNotMatch(renderAuthToml(plan), /rt-secret/)
})

// --- writing it ----------------------------------------------------------------

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "herdr-e2b-auth-"))

test("the generated file is written at restrictive permissions", () => {
  const dir = tmp()
  const file = path.join(dir, "auth.toml")
  writeAuthFile("# hi\n", file)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("a file left behind at loose permissions is tightened, not trusted", () => {
  const dir = tmp()
  const file = path.join(dir, "auth.toml")
  writeFileSync(file, "stale\n", { mode: 0o644 })
  writeAuthFile("# hi\n", file)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("a temp file left behind by an interrupted run cannot loosen the permissions", () => {
  const dir = tmp()
  const file = path.join(dir, "auth.toml")
  writeFileSync(`${file}.tmp`, "interrupted\n", { mode: 0o644 })
  writeAuthFile("# hi\n", file)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("re-running regenerates the file rather than appending to it", () => {
  const dir = tmp()
  const file = path.join(dir, "auth.toml")
  const two = renderAuthToml(
    buildPlan(
      [
        row({ id: "claude", state: "authenticated", source: "env", hostVar: "ANTHROPIC_API_KEY" }),
        row({ id: "codex", state: "authenticated", source: "file" }),
      ],
      { readText: () => '{"OPENAI_API_KEY":"sk-oai"}' },
    ),
  )
  const one = renderAuthToml(
    buildPlan([row({ id: "claude", state: "authenticated", source: "env", hostVar: "ANTHROPIC_API_KEY" })], {
      readText: noFiles,
    }),
  )
  writeAuthFile(two, file)
  writeAuthFile(one, file)
  const after = readFileSync(file, "utf8")
  assert.equal(after, one)
  assert.doesNotMatch(after, /sk-oai/)
  // Two runs of the same discovery are byte-identical — nothing accumulates.
  writeAuthFile(one, file)
  assert.equal(readFileSync(file, "utf8"), one)
})

test("the config directory is created if it does not exist yet", () => {
  const file = path.join(tmp(), "nested", "auth.toml")
  writeAuthFile("# hi\n", file)
  assert.equal(readFileSync(file, "utf8"), "# hi\n")
})

// --- what the user is shown before being asked ----------------------------------

test("the plan tells the user which values are stored and which are only named", () => {
  const plan = buildPlan(
    [
      row({ id: "claude", state: "authenticated", source: "env", hostVar: "ANTHROPIC_API_KEY" }),
      row({ id: "codex", state: "authenticated", source: "file" }),
    ],
    { readText: () => '{"OPENAI_API_KEY":"sk-oai-secret"}' },
  )
  const shown = formatPlan(plan, "/tmp/auth.toml")
  assert.match(shown, /ANTHROPIC_API_KEY/)
  assert.match(shown, /OPENAI_API_KEY/)
  assert.doesNotMatch(shown, /sk-oai-secret/)
})

test("gaps are printed as something to paste, and are never prompted for", () => {
  const plan = buildPlan([row({ id: "amp", state: "no-key", source: null, hostVar: "AMP_API_KEY" })], {
    readText: noFiles,
  })
  const shown = formatPlan(plan, "/tmp/auth.toml")
  assert.match(shown, /\[templates\.amp\.env\]/)
  assert.match(shown, /AMP_API_KEY/)
})

// ── ADR 0007: a signed-in session in a file is borrowable ──────────────────────
// The whole point of these is that they need no codex installed: every case is a
// fabricated auth.json handed to the same reader the real probe uses.

const HOUR = 3600
const jwt = (exp) =>
  `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`
const sessionFile = (exp, extra = {}) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { access_token: jwt(exp), refresh_token: "rt-REAL-SECRET-MUST-NOT-LEAK", account_id: "acc" },
    ...extra,
  })
const sessionRow = { id: "codex", installed: true, state: "authenticated", source: "session" }

test("a session is recorded as a POINTER — no token material is written down", () => {
  const exp = Math.floor(Date.now() / 1000) + 240 * HOUR
  const plan = buildPlan([sessionRow], { readText: () => sessionFile(exp) })
  assert.equal(plan.entries.length, 1)
  const e = plan.entries[0]
  assert.equal(e.kind, "session")
  assert.equal(e.boxVar, "CODEX_AUTH_JSON")
  assert.equal(e.path, "~/.codex/auth.json")
  assert.equal(e.harness, "codex")
  assert.equal(e.supersedes, "OPENAI_API_KEY")
  // The file was still READ — that is how we know there is a session to point at,
  // and what to tell the user about its expiry — but nothing from it is kept.
  assert.equal(e.expires, new Date(exp * 1000).toISOString())
  assert.equal(e.value, undefined)
})

test("the rendered file contains no credential material at all", () => {
  const exp = Math.floor(Date.now() / 1000) + 240 * HOUR
  const src = sessionFile(exp)
  const body = renderAuthToml(buildPlan([sessionRow], { readText: () => src }))
  const tokens = JSON.parse(src).tokens
  // Stronger than "the refresh token is not copied": NOTHING is. A pointer cannot
  // leak a token, cannot go stale, and cannot be a second copy of a live secret.
  assert.ok(!body.includes(tokens.refresh_token), "refresh token leaked")
  assert.ok(!body.includes(tokens.access_token), "access token leaked")
  assert.match(body, /\[templates\.codex\.session\]/)
  assert.match(body, /path = "~\/\.codex\/auth\.json"/)
  assert.match(body, /harness = "codex"/)
  // ...and no snapshot of the expiry either, because a snapshot disagrees with the
  // file an hour later. Freshness is read at box-create time or not at all.
  assert.ok(!/expires = /.test(body), "an expiry snapshot was written")
})

test("a session whose expiry cannot be read is refused, not guessed at", () => {
  const bad = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "not-a-jwt" } })
  const plan = buildPlan([sessionRow], { readText: () => bad })
  assert.equal(plan.entries.length, 0)
  assert.equal(plan.gaps.length, 1)
})

test("an api-key auth.json is not mistaken for a session", () => {
  const apikey = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" })
  assert.equal(buildPlan([sessionRow], { readText: () => apikey }).entries.length, 0)
})

// ── 08: a name the login shell cannot see ─────────────────────────────────────
// The shell is injected, so these run identically on a machine where every key IS
// visible — which is most machines, and is exactly why the real check must be a
// check and not an assumption.

const fakeShell = (visible) => () => ({ stdout: visible.join("\n") })

test("invisibleToLoginShell names only what the login shell cannot see", () => {
  const run = fakeShell(["IN_PROFILE"])
  assert.deepEqual(invisibleToLoginShell(["IN_PROFILE", "ONLY_IN_ZSHRC"], { run }), ["ONLY_IN_ZSHRC"])
})

test("invisibleToLoginShell says nothing when the probe cannot run", () => {
  // An advisory that fires because its own probe broke is noise, and noise here
  // teaches people to ignore the one case that matters.
  assert.deepEqual(invisibleToLoginShell(["X"], { run: () => ({ error: new Error("nope") }) }), [])
  assert.deepEqual(invisibleToLoginShell(["X"], { run: () => { throw new Error("boom") } }), [])
})

test("invisibleToLoginShell refuses a name that is not a shell identifier", () => {
  // The names come from a generated file; one carrying a `;` would otherwise be
  // spliced straight into the script this builds.
  let script = null
  invisibleToLoginShell(["GOOD", "BAD; rm -rf /"], { run: (_b, a) => ((script = a[1]), { stdout: "" }) })
  assert.ok(!script.includes("rm -rf"))
  assert.ok(script.includes("GOOD"))
})

test("the warning names the variable, the template, and both fixes", () => {
  const plan = { entries: [{ kind: "forward", template: "grok", boxVar: "XAI_API_KEY", hostVar: "XAI_API_KEY" }] }
  const out = formatForwardWarning(plan, ["XAI_API_KEY"])
  assert.match(out, /invisible to a login shell/)
  assert.match(out, /\$XAI_API_KEY/)
  assert.match(out, /~\/\.profile/)
  assert.match(out, /\[templates\.grok\.env\]/)
})

test("nothing invisible → no warning at all", () => {
  const plan = { entries: [{ kind: "forward", template: "grok", boxVar: "X", hostVar: "X" }] }
  assert.equal(formatForwardWarning(plan, []), "")
  // ...and a name that is invisible but was never forwarded is not our business.
  assert.equal(formatForwardWarning(plan, ["SOMETHING_ELSE"]), "")
})
