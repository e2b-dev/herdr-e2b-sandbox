import test from "node:test"
import assert from "node:assert/strict"
import { EFFORT_SCALES, GENERIC_SCALE, effortRows, effortScale, effortsForModel, harnessHint, modelCatalog, validEffort } from "../src/effort.js"
import { HARNESS_CATALOG } from "../src/harness-catalog.generated.js"

// The words are not pinned here: they are read off each template's CLI into
// src/harness-catalog.generated.js (test/catalog.test.js proves the fixtures still
// produce that file). What this pins is the OVERLAY: that every scale is derived
// from the catalog the way src/effort.js says it is.
test("effort scales derive from the catalog, with the plugin's overlay applied", () => {
  assert.deepEqual(Object.keys(EFFORT_SCALES).sort(), Object.keys(HARNESS_CATALOG).sort())
  for (const id of ["claude", "codex", "grok", "prime", "muse"]) {
    assert.deepEqual(EFFORT_SCALES[id].values, HARNESS_CATALOG[id].efforts, `${id} is the CLI's own list, unfiltered`)
    assert.equal(EFFORT_SCALES[id].kind, "native")
  }
  // droid: the CLI's words minus the two that mean "let the model decide".
  assert.deepEqual(
    EFFORT_SCALES.droid.values,
    HARNESS_CATALOG.droid.efforts.filter((v) => v !== "none" && v !== "dynamic"),
  )
  assert.ok(EFFORT_SCALES.droid.values.length > 0)
  // amp: its modes, never its --reasoning-effort vocabulary.
  assert.deepEqual(EFFORT_SCALES.amp.values, HARNESS_CATALOG.amp.modes)
  assert.equal(EFFORT_SCALES.amp.via, "--mode")
  // opencode: the generic scale, whatever the catalog says.
  assert.equal(EFFORT_SCALES.opencode.kind, "generic")
  assert.deepEqual(EFFORT_SCALES.opencode.values, GENERIC_SCALE)
  for (const [id, s] of Object.entries(EFFORT_SCALES)) {
    assert.ok(s.values.length > 0, `${id} offers something`)
    assert.equal(new Set(s.values).size, s.values.length, `${id} has no duplicates`)
    assert.ok(s.via, `${id} says how the pin travels`)
  }
})

test("harnessHint: a shipped template by name, a custom one by the command it runs", () => {
  assert.equal(harnessHint("codex"), "codex")
  assert.equal(harnessHint("drew-claude", { fleetAgents: { "drew-claude": "claude --dangerously-skip-permissions" } }), "claude")
  assert.equal(harnessHint("mine", { fleetAgents: { mine: "/opt/bin/grok --always-approve" } }), "grok")
  assert.equal(harnessHint("mine", { fleetAgents: { mine: "my-cli --go" } }), null)
  assert.equal(harnessHint("base"), null)
  assert.equal(harnessHint(""), null)
})

test("effortScale and validEffort follow the hint; no hint means no scale", () => {
  assert.equal(effortScale("grok").harness, "grok")
  assert.equal(effortScale("base"), null)
  assert.equal(validEffort("grok", EFFORT_SCALES.grok.values.at(-1)), true)
  assert.equal(validEffort("grok", "__not_a_word__"), false)
  assert.equal(validEffort("opencode", "ultra"), true)
  assert.equal(validEffort("base", "high"), false)
})

test("modelCatalog: the CLI's list for a harness that has one, null for one that does not", () => {
  const droid = modelCatalog("droid")
  assert.equal(droid.harness, "droid")
  assert.ok(droid.models.length > 10)
  assert.ok(droid.models.every((m) => typeof m.id === "string" && m.id))
  assert.equal(modelCatalog("muse"), null, "muse has no pinnable model")
  assert.equal(modelCatalog("opencode"), null, "opencode's universe is models.dev, not a list")
  assert.equal(modelCatalog("base"), null)
  assert.equal(modelCatalog("mine", { fleetAgents: { mine: "codex" } }).harness, "codex")
})

test("effortsForModel: a model's own subset when the catalog knows it, the scale otherwise", () => {
  // Some droid model takes fewer words than the union, which is the whole point.
  const narrow = HARNESS_CATALOG.droid.models.find((m) => m.efforts && m.efforts.length < EFFORT_SCALES.droid.values.length)
  assert.ok(narrow, "the catalog has a droid model with a narrower scale")
  const own = effortsForModel("droid", narrow.id)
  assert.ok(own.length <= narrow.efforts.length)
  assert.ok(own.every((v) => EFFORT_SCALES.droid.values.includes(v)), "never offers a word the overlay omits")
  assert.deepEqual(effortsForModel("droid", "no-such-model"), EFFORT_SCALES.droid.values)
  assert.deepEqual(effortsForModel("droid", ""), EFFORT_SCALES.droid.values)
  assert.deepEqual(effortsForModel("muse", "anything"), EFFORT_SCALES.muse.values, "a flat scale is the answer for every model")
  assert.equal(effortsForModel("base", "x"), null)
})

test("effortRows: one row per template, opening on the configured pin only when it is on the scale", () => {
  const top = EFFORT_SCALES.grok.values.at(-1)
  const cfg = { templateModels: { grok: { reasoning: top }, codex: { reasoning: "__off_scale__" } }, fleetAgents: { mine: "claude" } }
  const rows = effortRows(["grok", "codex", "opencode", "mine", "base"], cfg)
  assert.deepEqual(rows.map((r) => [r.template, r.kind, r.configured]), [
    ["grok", "native", top],
    ["codex", "native", ""], // not on codex's scale, so the cell opens blank
    ["opencode", "generic", ""],
    ["mine", "native", ""],
    ["base", "none", ""],
  ])
  assert.deepEqual(rows[4].values, [])
  assert.equal(rows[3].harness, "claude")
})

test("effortRows: the model cell lists the catalog only where a pin can be delivered", () => {
  const droidModel = HARNESS_CATALOG.droid.models[1].id
  const cfg = { templateModels: { droid: { model: droidModel }, codex: { model: "not-a-listed-model" } } }
  const rows = Object.fromEntries(effortRows(["droid", "codex", "claude", "amp", "muse", "opencode", "base"], cfg).map((r) => [r.template, r]))
  assert.deepEqual(rows.droid.models, HARNESS_CATALOG.droid.models.map((m) => m.id))
  assert.equal(rows.droid.model, droidModel, "the pin opens the cell when it is on the list")
  assert.ok(rows.codex.models.length > 0)
  assert.equal(rows.codex.model, "", "a pin off the list opens the cell on default")
  assert.ok(rows.claude.models.every((id) => id.startsWith("claude-")))
  assert.deepEqual(rows.amp.models, [], "amp lists models and has no model setting: no cell")
  assert.deepEqual(rows.muse.models, [], "muse has no pinnable model")
  assert.deepEqual(rows.opencode.models, [], "opencode's universe is not a list")
  assert.deepEqual(rows.base.models, [])
  for (const r of Object.values(rows)) assert.ok(r.models.every((id) => !id.includes(",") && !id.includes("|")), `${r.template}: ids survive the | and , separators`)
})
