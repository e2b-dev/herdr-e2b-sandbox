import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import TOML from "@iarna/toml"

import { buildPlan, renderAuthToml, writeAuthFile, formatPlan } from "../src/harness-auth.js"

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

test("a key found in a file is stored as a value", () => {
  const plan = buildPlan([row({ id: "codex", state: "authenticated", source: "file" })], {
    readText: (p) => (p.endsWith("/.codex/auth.json") ? '{"OPENAI_API_KEY":"sk-oai-from-file"}' : null),
  })
  assert.equal(plan.entries.length, 1)
  assert.deepEqual(plan.entries[0], {
    id: "codex",
    template: "codex",
    kind: "value",
    boxVar: "OPENAI_API_KEY",
    value: "sk-oai-from-file",
    from: "~/.codex/auth.json",
  })
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

test("values and forwarded names land in tables a config loader can read", () => {
  const plan = buildPlan(
    [
      row({ id: "claude", state: "authenticated", source: "env", hostVar: "ANTHROPIC_API_KEY" }),
      row({ id: "codex", state: "authenticated", source: "file" }),
    ],
    { readText: () => '{"OPENAI_API_KEY":"sk-oai-from-file"}' },
  )
  const parsed = TOML.parse(renderAuthToml(plan))
  assert.deepEqual(parsed.templates.codex.env, { OPENAI_API_KEY: "sk-oai-from-file" })
  assert.deepEqual(parsed.templates.claude.forward, { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" })
  // The forwarded row must not also appear as a value.
  assert.equal(parsed.templates.claude.env, undefined)
})

test("a value carrying quotes and braces survives the round trip", () => {
  // opencode's box variable is a whole auth.json inline, so the value written is
  // itself JSON — the one place a stored value is not a flat token.
  const plan = buildPlan([row({ id: "opencode", state: "authenticated", source: "file" })], {
    readText: () => '{"anthropic": {"type": "api", "key": "sk-x"}}',
  })
  const parsed = TOML.parse(renderAuthToml(plan))
  assert.deepEqual(JSON.parse(parsed.templates.opencode.env.OPENCODE_AUTH_CONTENT), {
    anthropic: { type: "api", key: "sk-x" },
  })
})

test("an oauth entry beside an api key is dropped, never forwarded", () => {
  // ADR 0006 will not carry a token cache. opencode's auth.json can hold both
  // kinds at once, and forwarding the file whole would have put an access/refresh
  // pair into a box the moment one api entry sat beside it.
  const plan = buildPlan([row({ id: "opencode", state: "authenticated", source: "file" })], {
    readText: () =>
      JSON.stringify({
        openai: { type: "oauth", access: "at-secret", refresh: "rt-secret" },
        anthropic: { type: "api", key: "sk-x" },
      }),
  })
  const written = renderAuthToml(plan)
  assert.doesNotMatch(written, /rt-secret/)
  assert.doesNotMatch(written, /at-secret/)
  assert.match(written, /sk-x/)
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

test("a session is recorded with its expiry, and the real refresh token is not", () => {
  const exp = Math.floor(Date.now() / 1000) + 240 * HOUR
  const plan = buildPlan([sessionRow], { readText: () => sessionFile(exp) })
  assert.equal(plan.entries.length, 1)
  const e = plan.entries[0]
  assert.equal(e.kind, "session")
  assert.equal(e.boxVar, "CODEX_AUTH_JSON")
  assert.equal(e.expires, new Date(exp * 1000).toISOString())
  // ADR 0007's rule, and the one that must never regress: the copy cannot revoke
  // the login it came from.
  assert.ok(!e.value.includes("rt-REAL-SECRET-MUST-NOT-LEAK"), "the real refresh token was copied")
  assert.match(JSON.parse(e.value).tokens.refresh_token, /placeholder/i)
  // Present, though — codex refuses to deserialize the file without the field.
  assert.ok(JSON.parse(e.value).tokens.refresh_token)
  assert.equal(JSON.parse(e.value).tokens.access_token, jwt(exp))
})

test("the rendered file keeps the real refresh token out and the expiry in", () => {
  const exp = Math.floor(Date.now() / 1000) + 240 * HOUR
  const body = renderAuthToml(buildPlan([sessionRow], { readText: () => sessionFile(exp) }))
  assert.ok(!body.includes("rt-REAL-SECRET-MUST-NOT-LEAK"))
  assert.match(body, /\[templates\.codex\.session\]/)
  assert.match(body, /var = "CODEX_AUTH_JSON"/)
  assert.match(body, /expires = /)
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
