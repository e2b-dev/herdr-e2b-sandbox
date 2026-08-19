import test from "node:test"
import assert from "node:assert/strict"
import { formatFleetAuthWarning, unauthenticatedMembers } from "../src/fleet-auth.js"

// The question this module answers is NOT "did `e2b-box auth` find a credential"
// but "will this member's box be handed one" — the full resolveEnv ladder, because
// a member configured by hand is authenticated and warning about it would be a lie.

const member = (template, label) => ({ template, label: label || `t-1-${template}` })

// --- nothing configured ------------------------------------------------------

test("a roster with no credential anywhere warns per member, naming the BOX variable", () => {
  const gaps = unauthenticatedMembers([member("claude"), member("codex")], {}, {})
  assert.deepEqual(gaps, [
    { label: "t-1-claude", template: "claude", boxVar: "ANTHROPIC_API_KEY" },
    // Not CODEX_API_KEY: the variable a box needs is not the one this machine is
    // searched under, and they differ for three of the seven harnesses.
    { label: "t-1-codex", template: "codex", boxVar: "OPENAI_API_KEY" },
  ])
})

test("a template no harness ships is never warned about", () => {
  // `base` is a plain image with no agent in it, and `mine` is somebody's own
  // template. Neither has a credential to be missing, and the plugin never guesses
  // a variable name for a row that is not in the table.
  assert.deepEqual(unauthenticatedMembers([member("base"), member("mine")], {}, {}), [])
})

// --- every rung of the ladder counts -----------------------------------------

test("a value discovered by `e2b-box auth` authenticates the member", () => {
  const cfg = { envDiscovered: { claude: { ANTHROPIC_API_KEY: "sk-ant-x" } } }
  assert.deepEqual(unauthenticatedMembers([member("claude")], cfg, {}), [])
})

test("a forwarded NAME authenticates the member only when this shell holds it", () => {
  const cfg = { envForward: { claude: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" } } }
  assert.deepEqual(unauthenticatedMembers([member("claude")], cfg, { ANTHROPIC_API_KEY: "sk-ant-x" }), [])
  // Recorded in auth.toml, unset here: resolveEnv injects nothing, so the box gets
  // nothing, so this is exactly the member the warning exists for.
  assert.deepEqual(unauthenticatedMembers([member("claude")], cfg, {}), [
    { label: "t-1-claude", template: "claude", boxVar: "ANTHROPIC_API_KEY" },
  ])
})

test("a credential the user wrote by hand authenticates the member", () => {
  // Either of the user's own tables. This is the whole reason the check reads the
  // resolved env rather than the generated file: `[templates.<t>.env]` is the remedy
  // the warning itself prints, and printing it at somebody who already took it would
  // make the warning noise.
  const perTemplate = { envByTemplate: { claude: { ANTHROPIC_API_KEY: "sk-ant-x" } } }
  assert.deepEqual(unauthenticatedMembers([member("claude")], perTemplate, {}), [])
  const shared = { envShared: { ANTHROPIC_API_KEY: "sk-ant-x" } }
  assert.deepEqual(unauthenticatedMembers([member("claude")], shared, {}), [])
})

test("a shipped default that is not a credential does not authenticate anything", () => {
  // amp ships AMP_EXECUTOR=sandbox. A template with an env table is not a template
  // with a key, so the box variable is what gets looked at and nothing else.
  const cfg = { templateEnvDefaults: { amp: { AMP_EXECUTOR: "sandbox" } } }
  assert.deepEqual(unauthenticatedMembers([member("amp")], cfg, {}), [
    { label: "t-1-amp", template: "amp", boxVar: "AMP_API_KEY" },
  ])
})

test("a blank credential is a missing one", () => {
  // An empty key is the failure that shows up furthest from its cause: the agent
  // boots, reads it, and dies authenticating — which reads as a broken key rather
  // than an absent one.
  const cfg = { envByTemplate: { claude: { ANTHROPIC_API_KEY: "   " } } }
  assert.deepEqual(unauthenticatedMembers([member("claude")], cfg, {}), [
    { label: "t-1-claude", template: "claude", boxVar: "ANTHROPIC_API_KEY" },
  ])
})

// --- the warning itself ------------------------------------------------------

test("the warning names each member, its template and its variable — once", () => {
  const text = formatFleetAuthWarning(
    [
      { label: "t-1-claude", template: "claude", boxVar: "ANTHROPIC_API_KEY" },
      { label: "t-1-codex", template: "codex", boxVar: "OPENAI_API_KEY" },
    ],
    "/tmp/config.toml",
  )
  for (const s of ["t-1-claude", "claude", "ANTHROPIC_API_KEY", "t-1-codex", "codex", "OPENAI_API_KEY"]) {
    assert.ok(text.includes(s), `warning omits ${s}`)
  }
  // One warning for the batch, not one per member: exactly one ⚠️ in the whole block.
  assert.equal(text.split("⚠️").length - 1, 1)
  // And it is a warning, not a refusal.
  assert.match(text, /not a refusal/)
})

test("the warning ends in a block the user can paste into their own config", () => {
  const text = formatFleetAuthWarning(
    [{ label: "t-1-codex", template: "codex", boxVar: "OPENAI_API_KEY" }],
    "/tmp/config.toml",
  )
  assert.match(text, /\[templates\.codex\.env\]\n\s*OPENAI_API_KEY = "…"/)
  assert.match(text, /\/tmp\/config\.toml/)
  // The other route out, named because it is the one that needs no lookup at all.
  assert.match(text, /e2b-box auth/)
})

test("an authenticated roster says nothing at all", () => {
  assert.equal(formatFleetAuthWarning([]), "")
})

test("a member with no agent is never warned about", () => {
  // `[fleet.agents] claude = ""` is the control arm: the pane stays a plain shell,
  // and a shell has no sign-in screen to land on. Key presence, not truthiness —
  // an UNMAPPED template runs an agent named after itself, so reading this by
  // truthiness would silence the whole roster instead of this one member.
  const cfg = { fleetAgents: { claude: "" } }
  assert.deepEqual(unauthenticatedMembers([member("claude"), member("codex")], cfg, {}), [
    { label: "t-1-codex", template: "codex", boxVar: "OPENAI_API_KEY" },
  ])
  const mapped = { fleetAgents: { claude: "claude --resume" } }
  assert.equal(unauthenticatedMembers([member("claude")], mapped, {}).length, 1)
  // Exactly empty, not trimmed-empty. bin/e2b-fleet gates the same value on
  // `[ -n "$agent_cmd" ]`, so a template mapped to " " has something typed into it,
  // and calling that member agentless here would be the one member nobody warned.
  const blank = { fleetAgents: { claude: " " } }
  assert.equal(unauthenticatedMembers([member("claude")], blank, {}).length, 1)
})
