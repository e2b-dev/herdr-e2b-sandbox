import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fleetSpec, listPresets, presetPath } from "../src/fleet-spec.js"
import { expandMemberSpecs } from "../src/fleet-name.js"
import { modelCatalog, effortsForModel } from "../src/effort.js"

test("JSON preserves task text and expands each count without losing per-member pins", () => {
  const model = modelCatalog("codex").models[0].id
  const reasoning = effortsForModel("codex", model)[0]
  const task = "Fix the bug\nKeep `quotes` and $(literal text)."
  const spec = fleetSpec({ slug: "login", task, members: [
    { template: "codex", model, reasoning, count: 2 },
    { template: "codex", count: 1 },
  ] })
  assert.equal(spec.slug, "login")
  assert.equal(spec.task, task)
  assert.deepEqual(expandMemberSpecs(spec.specs), [
    { template: "codex", model, effort: reasoning },
    { template: "codex", model, effort: reasoning },
    { template: "codex", model: "", effort: "" },
  ])
})

test("a reusable roster needs neither a slug nor a task", () => {
  assert.deepEqual(fleetSpec({ members: [{ template: "claude" }] }), {
    slug: "", task: "", specs: ["claude*1"],
  })
})

test("invalid generated fields fail instead of silently using defaults", () => {
  for (const value of [null, [], {}, { members: [] }, { members: "codex" },
    { task: 42, members: [{ template: "codex" }] },
    { slug: "a\0b", members: [{ template: "codex" }] },
    { member: [], members: [{ template: "codex" }] }]) {
    assert.throws(() => fleetSpec(value))
  }
  for (const member of [null, "codex", {}, { template: "codex", effort: "high" },
    { template: "codex*2" }, { template: "codex", model: "x|y" },
    ...[0, 21, 1.5, "2", null].map((count) => ({ template: "codex", count }))]) {
    assert.throws(() => fleetSpec({ members: [member] }))
  }
})

test("model and per-model reasoning use the current catalog", () => {
  assert.throws(() => fleetSpec({ members: [{ template: "codex", model: "made-up-model" }] }), /not a model/)
  assert.throws(() => fleetSpec({ members: [{ template: "codex", reasoning: "made-up-effort" }] }), /not an effort/)
  const model = modelCatalog("grok").models.find((m) => m.efforts)
  assert.ok(model)
  const reasoning = effortsForModel("grok", model.id)[0]
  assert.doesNotThrow(() => fleetSpec({ members: [{ template: "grok", model: model.id, reasoning }] }))
})

test("preset names stay inside the presets directory and list without reading recipes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-presets-"))
  try {
    writeFileSync(path.join(dir, "compare.json"), "invalid JSON is diagnosed on selection")
    writeFileSync(path.join(dir, "fast.json"), "{}")
    writeFileSync(path.join(dir, "ignored.txt"), "")
    writeFileSync(path.join(dir, "bad name.json"), "")
    mkdirSync(path.join(dir, "directory.json"))
    assert.deepEqual(listPresets(dir), ["compare", "fast"])
    assert.equal(presetPath("compare", dir), path.join(dir, "compare.json"))
    for (const name of ["../escape", "/tmp/escape", "", "bad\nname"]) assert.throws(() => presetPath(name, dir))
    assert.deepEqual(listPresets(path.join(dir, "absent")), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
