import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { MODEL_VAR, REASONING_VAR, modelEnv, normalizePin, pinCommand, pinSupport } from "../src/model-pin.js"

// --- the config shape -----------------------------------------------------------

test("normalizePin: trims, drops blanks, and is null when nothing is pinned", () => {
  assert.deepEqual(normalizePin({ model: "  openrouter/qwen/qwen3.8-max-0902 " }), { model: "openrouter/qwen/qwen3.8-max-0902" })
  assert.deepEqual(normalizePin({ reasoning: "high" }), { reasoning: "high" })
  assert.deepEqual(normalizePin({ model: "m", reasoning: "r" }), { model: "m", reasoning: "r" })
  for (const s of [undefined, null, {}, { model: "   " }, { model: "", reasoning: "" }, { env: { A: "b" } }]) {
    assert.equal(normalizePin(s), null, JSON.stringify(s))
  }
})

// --- the env route --------------------------------------------------------------

test("modelEnv: every pinned template gets the two shared variables", () => {
  for (const t of ["claude", "codex", "opencode", "amp", "grok", "droid", "muse", "prime", "base", "mine/own"]) {
    const env = modelEnv(t, { model: "m", reasoning: "r" })
    assert.equal(env[MODEL_VAR], "m", t)
    assert.equal(env[REASONING_VAR], "r", t)
  }
  assert.deepEqual(modelEnv("codex", { model: "gpt-5.4" }), { [MODEL_VAR]: "gpt-5.4" })
  assert.deepEqual(modelEnv("codex", { reasoning: "high" }), { [REASONING_VAR]: "high" })
})

test("modelEnv: claude reads its own variables", () => {
  assert.deepEqual(modelEnv("claude", { model: "claude-opus-5", reasoning: "high" }), {
    [MODEL_VAR]: "claude-opus-5",
    [REASONING_VAR]: "high",
    ANTHROPIC_MODEL: "claude-opus-5",
    CLAUDE_CODE_EFFORT_LEVEL: "high",
  })
  assert.equal(modelEnv("claude", { reasoning: "low" }).ANTHROPIC_MODEL, undefined)
})

test("modelEnv: opencode reads inline JSON config, model only", () => {
  const env = modelEnv("opencode", { model: "openrouter/qwen/qwen3.8-max-0902", reasoning: "high" })
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { model: "openrouter/qwen/qwen3.8-max-0902" })
  // Reasoning is per-model variants in opencode, so a reasoning-only pin sets no
  // opencode variable at all rather than an empty config.
  assert.equal(modelEnv("opencode", { reasoning: "high" }).OPENCODE_CONFIG_CONTENT, undefined)
})

test("modelEnv: no pin, no variables", () => {
  assert.deepEqual(modelEnv("claude", null), {})
  assert.deepEqual(modelEnv("claude", undefined), {})
})

// --- the file route -------------------------------------------------------------

test("pinCommand: file-route harnesses get a command, env-only and unknown ones do not", () => {
  const pin = { model: "m", reasoning: "r" }
  for (const t of ["codex", "grok", "droid", "prime", "muse"]) assert.ok(pinCommand(t, pin), t)
  for (const t of ["claude", "opencode", "amp", "base", "mine/own", "", undefined]) assert.equal(pinCommand(t, pin), "", String(t))
  assert.equal(pinCommand("codex", null), "")
})

test("every file-route command is one line, names the variables, carries no value", () => {
  for (const t of ["codex", "grok", "droid", "prime", "muse"]) {
    const cmd = pinCommand(t, { model: "SECRET-LOOKING-VALUE", reasoning: "xhigh" })
    assert.ok(!cmd.includes("\n"), `${t}: newline`)
    assert.ok(!cmd.includes("\\"), `${t}: backslash`)
    assert.ok(cmd.includes(MODEL_VAR) && cmd.includes(REASONING_VAR), `${t}: does not read the variables`)
    assert.ok(!cmd.includes("SECRET-LOOKING-VALUE") && !cmd.includes("xhigh"), `${t}: interpolates a value`)
  }
})

test("pinSupport: says what each template can pin", () => {
  assert.deepEqual(pinSupport("claude"), { model: true, reasoning: true, route: "env" })
  assert.deepEqual(pinSupport("opencode"), { model: true, reasoning: false, route: "env" })
  assert.deepEqual(pinSupport("codex"), { model: true, reasoning: true, route: "file" })
  assert.deepEqual(pinSupport("muse"), { model: false, reasoning: true, route: "file" })
  assert.deepEqual(pinSupport("amp"), { model: false, reasoning: false, route: null })
  assert.deepEqual(pinSupport("base"), { model: false, reasoning: false, route: null })
})

// --- the file-route commands, actually executed ---------------------------------
// Each runs against a fake HOME under the OS temp dir with the two variables set,
// exactly the way provision.js runs it in a box. This is the one place the shell
// is exercised rather than read, so a quoting slip fails here and not in a fleet.

function runPin(template, env, home = mkdtempSync(path.join(os.tmpdir(), "herdr-pin-"))) {
  const out = execFileSync("bash", ["-c", pinCommand(template, { model: "x", reasoning: "y" })], {
    env: { PATH: process.env.PATH, HOME: home, ...env },
    encoding: "utf8",
  })
  return { home, out }
}

test("codex: prepends model and effort to config.toml, once", () => {
  const { home, out } = runPin("codex", { [MODEL_VAR]: "gpt-5.4", [REASONING_VAR]: "high" })
  const f = path.join(home, ".codex/config.toml")
  assert.equal(readFileSync(f, "utf8"), 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n')
  assert.match(out, /pinned to gpt-5.4 at high effort/)
  // Second run: nothing to add, nothing rewritten.
  const again = runPin("codex", { [MODEL_VAR]: "other", [REASONING_VAR]: "low" }, home)
  assert.equal(readFileSync(f, "utf8"), 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n')
  assert.match(again.out, /leaving it alone/)
})

test("codex: keys land ABOVE an existing table, and a set key is not touched", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "herdr-pin-"))
  mkdirSync(path.join(home, ".codex"))
  writeFileSync(path.join(home, ".codex/config.toml"), 'model_reasoning_effort = "low"\n[projects."/p"]\ntrust_level = "trusted"\n')
  runPin("codex", { [MODEL_VAR]: "gpt-5.4", [REASONING_VAR]: "high" }, home)
  assert.equal(
    readFileSync(path.join(home, ".codex/config.toml"), "utf8"),
    'model = "gpt-5.4"\nmodel_reasoning_effort = "low"\n[projects."/p"]\ntrust_level = "trusted"\n',
  )
})

test("grok: creates a [models] section, and leaves an existing one alone", () => {
  const { home } = runPin("grok", { [MODEL_VAR]: "grok-build", [REASONING_VAR]: "high" })
  const f = path.join(home, ".grok/config.toml")
  assert.equal(readFileSync(f, "utf8"), '[models]\ndefault = "grok-build"\ndefault_reasoning_effort = "high"\n')
  const again = runPin("grok", { [MODEL_VAR]: "grok-4.5" }, home)
  assert.equal(readFileSync(f, "utf8"), '[models]\ndefault = "grok-build"\ndefault_reasoning_effort = "high"\n')
  assert.match(again.out, /leaving it alone/)
})

test("grok: appends after existing unrelated sections", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "herdr-pin-"))
  mkdirSync(path.join(home, ".grok"))
  writeFileSync(path.join(home, ".grok/config.toml"), "[cli]\nauto_update = false")
  runPin("grok", { [MODEL_VAR]: "grok-build" }, home)
  assert.equal(readFileSync(path.join(home, ".grok/config.toml"), "utf8"), '[cli]\nauto_update = false\n[models]\ndefault = "grok-build"\n')
})

test("droid: merges into settings.json without clobbering", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "herdr-pin-"))
  mkdirSync(path.join(home, ".factory"))
  writeFileSync(path.join(home, ".factory/settings.json"), JSON.stringify({ hooks: {}, reasoningEffort: "off" }))
  runPin("droid", { [MODEL_VAR]: "glm-5.2", [REASONING_VAR]: "max" }, home)
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, ".factory/settings.json"), "utf8")), {
    hooks: {},
    reasoningEffort: "off",
    model: "glm-5.2",
  })
})

test("prime: splits provider/model at the first slash, keeps a provider-less id whole", () => {
  const a = runPin("prime", { [MODEL_VAR]: "prime-inference/z-ai/glm-5.2", [REASONING_VAR]: "high" })
  assert.deepEqual(JSON.parse(readFileSync(path.join(a.home, ".prime/agent/settings.json"), "utf8")), {
    defaultProvider: "prime-inference",
    defaultModel: "z-ai/glm-5.2",
    defaultThinkingLevel: "high",
  })
  const b = runPin("prime", { [MODEL_VAR]: "gpt-6-astra" })
  assert.deepEqual(JSON.parse(readFileSync(path.join(b.home, ".prime/agent/settings.json"), "utf8")), { defaultModel: "gpt-6-astra" })
})

test("muse: pins reasoning, and says a model cannot be pinned", () => {
  const { home, out } = runPin("muse", { [MODEL_VAR]: "spark", [REASONING_VAR]: "high" })
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, ".config/muse/settings.json"), "utf8")), {
    schema_version: 1,
    reasoning_effort: "high",
  })
  assert.match(out, /no verified settings key for a model/)
  assert.match(out, /pinned at high effort/)
})

test("a pin with neither variable set writes nothing", () => {
  for (const t of ["codex", "grok", "droid", "prime", "muse"]) {
    const { home } = runPin(t, {})
    const files = ["codex/config.toml", ".codex/config.toml", ".grok/config.toml", ".factory/settings.json", ".prime/agent/settings.json", ".config/muse/settings.json"]
      .map((f) => path.join(home, f))
      .filter((f) => {
        try {
          readFileSync(f)
          return true
        } catch {
          return false
        }
      })
    assert.deepEqual(files, [], `${t}: wrote ${files.join(", ")}`)
  }
})
