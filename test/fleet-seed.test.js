import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_SEEDS, seedCommand } from "../src/fleet-seed.js"

// --- which command a template is seeded with ---------------------------------
// Same key-presence rule as `[fleet.agents]`, and for the same reason: "seed
// nothing" is a choice a user can make, and a choice must not fall back to a
// default the moment it is spelled as the empty string.

test("seedCommand: a template with a shipped default gets it", () => {
  assert.equal(seedCommand("claude"), DEFAULT_SEEDS.claude)
  assert.equal(seedCommand("codex"), DEFAULT_SEEDS.codex)
})

test("seedCommand: a template nobody has verified a schema for seeds nothing", () => {
  // Inventing first-run state for `grok` or `amp` would write junk into somebody's
  // home directory, so an unknown template waits for `[fleet.seed]` to say what to run.
  assert.equal(seedCommand("grok"), "")
  assert.equal(seedCommand("base"), "")
  assert.equal(seedCommand(undefined), "")
})

test("seedCommand: [fleet.seed] overrides a default, and \"\" switches it off", () => {
  const seeds = { claude: "", mine: "my-cli auth --key $MY_API_KEY" }
  assert.equal(seedCommand("claude", seeds), "")
  assert.equal(seedCommand("mine", seeds), "my-cli auth --key $MY_API_KEY")
  // A template the override says nothing about still gets its default.
  assert.equal(seedCommand("codex", seeds), DEFAULT_SEEDS.codex)
})

// --- what a shipped command may contain --------------------------------------
// Each of these is a live failure mode, not a style rule.

test("every shipped seeding command is one typable line", () => {
  for (const [template, cmd] of Object.entries(DEFAULT_SEEDS)) {
    // `pane run` is send-text plus Enter: a newline would submit half a command.
    assert.ok(!cmd.includes("\n"), `${template}: contains a newline`)
    // It crosses a JS string, argv, bash and a pty — every backslash is one more
    // place an escape can be eaten on the way in.
    assert.ok(!cmd.includes("\\"), `${template}: contains a backslash`)
    // A backtick or a `${` would make the JS template literal it is written as
    // interpolate instead of quote.
    assert.ok(!cmd.includes("`") && !cmd.includes("${"), `${template}: interpolates in JS`)
  }
})

test("a shipped command reads its credential from a variable, never a value", () => {
  // The rule the whole ticket rests on: this text ends up in the pane, so it may
  // name `$ANTHROPIC_API_KEY` but must never be handed anything to spell out.
  assert.match(DEFAULT_SEEDS.claude, /\$ANTHROPIC_API_KEY/)
  assert.match(DEFAULT_SEEDS.codex, /\$OPENAI_API_KEY/)
  // …and each refuses to overwrite state a user has since changed. That is no longer
  // a file-existence check — the claude image ships a `.claude.json` of its own, so
  // the commands test STATE and merge (see fleet-seed.js). What every shipped command
  // must still have is the bail-out, and it says so in the pane when it takes it.
  for (const [template, cmd] of Object.entries(DEFAULT_SEEDS)) {
    assert.match(cmd, /leaving it alone/, `${template}: no no-clobber bail-out`)
  }
})
