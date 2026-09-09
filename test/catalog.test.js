import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  CATALOG_PROBES,
  EFFORT_ORDER,
  diffRow,
  enumAfter,
  interpretCatalog,
  mergeCatalog,
  orderEfforts,
  perModel,
  renderTomlBlock,
  spliceTomlBlock,
  stripMeta,
  TOML_BEGIN,
  TOML_END,
} from "../src/catalog.js"
import { HARNESS_CATALOG } from "../src/harness-catalog.generated.js"
import { HARNESSES } from "../src/harnesses.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const FIXTURES = path.join(ROOT, "test", "fixtures", "catalog")
const fixture = (id) => JSON.parse(readFileSync(path.join(FIXTURES, `${id}.json`), "utf8"))

// Every probe result below is captured output from the CLI in that harness's E2B
// template (scripts/harness-catalog.mjs --from=box --write). They are fixtures on
// purpose: CI has none of these installed, and the point of the parse rules is that
// they read RESULTS. Nothing here spawns or fetches.

test("the probe table covers every harness behind a shipped template, and nothing else", () => {
  assert.deepEqual(Object.keys(CATALOG_PROBES).sort(), Object.keys(HARNESSES).sort())
  for (const [id, spec] of Object.entries(CATALOG_PROBES)) {
    assert.ok(spec.probes.version?.cmd, `${id}: every row asks the binary its version`)
    assert.ok(["efforts", "modes", null].includes(spec.needs), `${id}: needs is efforts, modes or null`)
    assert.equal(typeof spec.parse, "function")
    for (const [name, p] of Object.entries(spec.probes)) {
      assert.ok((p.cmd && !p.url) || (p.url && !p.cmd), `${id}.${name}: a command or a URL, not both`)
      // The rule that makes this output safe to paste: no probe line carries a value
      // that looks like a secret or expands one onto a command line.
      if (p.cmd) assert.doesNotMatch(p.cmd, /sk-|fk-|xai-|Bearer|API_KEY=/i, `${id}.${name}: no credential material on a command line`)
    }
  }
})

test("there is a fixture for every harness, captured from its template", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort()
  assert.deepEqual(files, Object.keys(CATALOG_PROBES).sort())
  for (const id of files) {
    const fx = fixture(id)
    assert.equal(fx.harness, id)
    assert.equal(fx.probedFrom, "box", `${id}: the committed fixture was read off the template, not a laptop`)
    assert.deepEqual(Object.keys(fx.probes).sort(), Object.keys(CATALOG_PROBES[id].probes).sort(), `${id}: one result per probe`)
  }
})

test("every fixture parses into a usable row, in the shape the plugin reads", () => {
  for (const id of Object.keys(CATALOG_PROBES)) {
    const row = interpretCatalog(id, fixture(id).probes)
    assert.ok(row, `${id}: the captured output parses`)
    assert.match(row.version, /^\d+\.\d+\.\d+/, `${id}: a version`)
    const spec = CATALOG_PROBES[id]
    if (spec.needs) {
      const words = row[spec.needs]
      assert.ok(Array.isArray(words) && words.length >= 3, `${id}: at least three ${spec.needs}`)
      assert.equal(new Set(words).size, words.length, `${id}: no duplicate words`)
      if (spec.needs === "efforts") {
        assert.deepEqual(words, orderEfforts(words), `${id}: written in EFFORT_ORDER`)
      }
    }
    if (row.models) {
      assert.ok(row.models.length > 0)
      assert.equal(row.modelsFrom, spec.modelsFrom)
      for (const m of row.models) {
        assert.ok(typeof m.id === "string" && m.id.trim() === m.id && m.id, `${id}: a bare, trimmed id`)
        if (m.efforts) assert.deepEqual(m.efforts, orderEfforts(m.efforts), `${id}/${m.id}: ordered`)
        if (m.default) assert.ok(m.efforts?.includes(m.default), `${id}/${m.id}: the default is on its own list`)
      }
      assert.equal(new Set(row.models.map((m) => m.id)).size, row.models.length, `${id}: no duplicate ids`)
    } else {
      assert.equal(row.modelsFrom, null)
    }
  }
})

// What each harness-specific rule is FOR, pinned against its own fixture. These are
// structural claims about the mechanism, not the vendor's current word list.
test("codex: the bundled catalog, listed models only, efforts per model with a default", () => {
  const row = interpretCatalog("codex", fixture("codex").probes)
  const hidden = JSON.parse(fixture("codex").probes.catalog.stdout).models.filter((m) => m.visibility !== "list")
  for (const h of hidden) assert.ok(!row.models.some((m) => m.id === h.slug), `${h.slug} is hidden in codex's own picker`)
  assert.ok(row.models.every((m) => m.efforts && m.default), "every listed model says what it takes and what it starts at")
  assert.deepEqual(row.efforts, orderEfforts(row.models.flatMap((m) => m.efforts)), "the scale is the union")
})

test("grok: the cache the authenticated `grok models` wrote, hidden models dropped, per-model efforts", () => {
  const fx = fixture("grok").probes
  const row = interpretCatalog("grok", fx)
  const cache = JSON.parse(fx.cache.stdout)
  assert.equal(row.models.length, Object.values(cache.models).filter((m) => !m.info?.hidden).length)
  assert.ok(row.models.every((m) => m.efforts))
  // Without the cache (unauthenticated), the flat set still comes off the rejection.
  const flat = interpretCatalog("grok", { ...fx, cache: { stdout: "", stderr: "cat: no such file", status: 1 } })
  assert.ok(flat, "the rejection oracle alone is enough for a scale")
  assert.deepEqual(flat.efforts, row.efforts)
  assert.ok(flat.models.every((m) => !m.efforts), "ids from `grok models`, no per-model detail")
})

test("droid: the handshake's availableModels, and the LIVE union rather than the syntactic enum", () => {
  const fx = fixture("droid").probes
  const row = interpretCatalog("droid", fx)
  const syntactic = enumAfter(`${fx.efforts.stdout}\n${fx.efforts.stderr}`, /Allowed values:\s*([^\n]+)/)
  assert.ok(syntactic.includes("dynamic"), "the flag accepts `dynamic`")
  assert.ok(!row.efforts.includes("dynamic"), "no listed model takes it, so the scale does not offer it")
  assert.ok(perModel(row), "droid is the harness where a flat row lies")
  assert.ok(row.models.some((m) => m.efforts.length === 1), "some model takes exactly one word")
  // Handshake gone (an older protocol): the two rejection oracles still give a row.
  const fallback = interpretCatalog("droid", { ...fx, catalog: { stdout: "", stderr: "", status: 1 } })
  assert.deepEqual(fallback.efforts, syntactic)
  assert.ok(fallback.models.length > 10 && fallback.models.every((m) => !m.efforts))
})

test("amp: modes are the scale; its --reasoning-effort words are recorded and never mixed in", () => {
  const row = interpretCatalog("amp", fixture("amp").probes)
  assert.ok(row.modes.includes("low") && row.modes.includes("high"))
  assert.ok(!row.modes.some((m) => /-|\s/.test(m)), "the parenthetical's prose never leaks into the modes")
  assert.ok(row.efforts, "amp's own effort vocabulary is kept")
  assert.ok(row.efforts.some((e) => !row.modes.includes(e)), "and it is a different vocabulary")
})

test("prime: `<provider>/<model>` ids split at the first slash, thinking flag carried", () => {
  const row = interpretCatalog("prime", fixture("prime").probes)
  assert.ok(row.models.every((m) => m.id.includes("/")))
  assert.ok(row.models.some((m) => m.id.split("/").length > 2), "a provider whose model ids themselves contain a slash")
  assert.ok(!row.models.some((m) => m.id.startsWith("provider/")), "the header row is not a model")
})

test("claude: efforts off the CLI's rejection, models off models.dev's anthropic provider", () => {
  const fx = fixture("claude").probes
  const row = interpretCatalog("claude", fx)
  assert.ok(row.models.every((m) => m.id.startsWith("claude-")))
  assert.ok(row.models.some((m) => m.efforts) && row.models.some((m) => !m.efforts), "models.dev says which models take an effort at all")
  // The model column is optional: a registry outage must not lose the scale.
  const noReg = interpretCatalog("claude", { ...fx, models: { stdout: "", stderr: "fetch failed", status: null } })
  assert.deepEqual(noReg.efforts, row.efforts)
  assert.equal(noReg.models, null)
})

test("muse and opencode: a scale with no model list, and a version with nothing else", () => {
  const muse = interpretCatalog("muse", fixture("muse").probes)
  assert.ok(muse.efforts.length >= 5)
  assert.equal(muse.models, null)
  const oc = interpretCatalog("opencode", fixture("opencode").probes)
  assert.equal(oc.efforts, null)
  assert.equal(oc.models, null)
})

test("a probe that did not answer is a null row, never an empty scale", () => {
  for (const id of Object.keys(CATALOG_PROBES)) {
    assert.equal(interpretCatalog(id, {}), null, `${id}: nothing in, nothing out`)
    const fx = fixture(id).probes
    assert.equal(interpretCatalog(id, { ...fx, version: { stdout: "", stderr: "not found", status: 127 } }), null, `${id}: no version, no row`)
    const spec = CATALOG_PROBES[id]
    if (spec.needs === "efforts") {
      const blank = Object.fromEntries(Object.keys(fx).map((k) => [k, k === "version" ? fx[k] : { stdout: "", stderr: "", status: 1 }]))
      assert.equal(interpretCatalog(id, blank), null, `${id}: a version with no words is not a row`)
    }
  }
  assert.equal(interpretCatalog("not-a-harness", fixture("claude").probes), null)
})

test("orderEfforts and enumAfter: the vendor's order and quoting never reach the table", () => {
  assert.deepEqual(orderEfforts(["xhigh", "high", "medium", "low"]), ["low", "medium", "high", "xhigh"])
  assert.deepEqual(orderEfforts(["max", "max", "  low "]), ["low", "max"])
  assert.deepEqual(orderEfforts(["zzz", "high", "aaa"]), ["high", "zzz", "aaa"], "unknown words keep their own order, after the known ones")
  assert.equal(orderEfforts([]), null)
  assert.equal(orderEfforts(["", "Not A Word"]), null)
  assert.deepEqual(enumAfter("Valid values: low, medium, high, xhigh, max.", /Valid values:\s*([^.\n]+)/), ["low", "medium", "high", "xhigh", "max"])
  assert.deepEqual(enumAfter("expected none|minimal|low", /expected\s+([a-z|]+)/), ["none", "minimal", "low"])
  assert.deepEqual(enumAfter("Expected 'none' | 'off', received", /Expected (.+), received/), ["none", "off"])
  assert.equal(enumAfter("nothing here", /Valid values:\s*([^.\n]+)/), null)
  assert.equal(EFFORT_ORDER[0], "none")
  assert.equal(EFFORT_ORDER.at(-1), "ultra")
})

// --- the committed module is what the fixtures say -----------------------------------

test("src/harness-catalog.generated.js is exactly what the fixtures parse to (rerun the script if not)", () => {
  for (const id of Object.keys(CATALOG_PROBES)) {
    const want = interpretCatalog(id, fixture(id).probes)
    const have = stripMeta(HARNESS_CATALOG[id])
    assert.deepEqual(
      have,
      want,
      `${id}: the generated row has drifted from its fixture, run \`node scripts/harness-catalog.mjs --from=fixture --write\``,
    )
    assert.equal(HARNESS_CATALOG[id].probedFrom, "box")
    assert.ok(HARNESS_CATALOG[id].probedAt)
    assert.equal(HARNESS_CATALOG[id].stale, undefined, `${id}: a shipped row is never stale`)
  }
})

test("config/config.example.toml carries the rendered <catalog> block verbatim", () => {
  const toml = readFileSync(path.join(ROOT, "config", "config.example.toml"), "utf8")
  const block = renderTomlBlock(HARNESS_CATALOG)
  assert.ok(block.startsWith(TOML_BEGIN) && block.endsWith(TOML_END))
  assert.ok(toml.includes(block), "the example config's table is the generated one, run the script with --write")
  assert.ok(block.split("\n").every((l) => l.startsWith("#")), "every line is a TOML comment")
  assert.ok(block.split("\n").every((l) => l.length <= 170), "no line runs off a review pane")
  // Splicing is idempotent and only ever touches what sits between the sentinels.
  assert.equal(spliceTomlBlock(toml, block), toml)
  const other = spliceTomlBlock(`before\n${TOML_BEGIN}\nold\n${TOML_END}\nafter`, block)
  assert.equal(other, `before\n${block}\nafter`)
  assert.throws(() => spliceTomlBlock("no sentinels here", block), /sentinels/)
})

// --- what a refresh does with what it read ---------------------------------------------

test("mergeCatalog: a read row replaces, a failed probe keeps the committed row and marks it stale", () => {
  const meta = { probedFrom: "box", probedAt: "2026-09-10T00:00:00.000Z", templates: { claude: { name: "p/claude", buildID: "b2", updatedAt: "x" } } }
  const fresh = {
    claude: { row: { version: "9.9.9", efforts: ["low"], models: null, modelsFrom: null } },
    codex: { row: null, reason: "sandbox timed out" },
  }
  const out = mergeCatalog(HARNESS_CATALOG, fresh, meta)
  assert.equal(out.claude.version, "9.9.9")
  assert.equal(out.claude.probedAt, meta.probedAt)
  assert.deepEqual(out.claude.template, meta.templates.claude)
  assert.equal(out.codex.version, HARNESS_CATALOG.codex.version, "not blanked")
  assert.deepEqual(out.codex.efforts, HARNESS_CATALOG.codex.efforts)
  assert.deepEqual(out.codex.stale, { since: meta.probedAt, reason: "sandbox timed out" })
  assert.deepEqual(stripMeta(out.grok), stripMeta(HARNESS_CATALOG.grok), "a harness not probed this run is carried over untouched")
  assert.equal(out.grok.stale, undefined)
  // A replay carries the capture's provenance, not the transport's.
  const replay = mergeCatalog({}, { muse: { row: { version: "1.0.0", efforts: ["low"], models: null, modelsFrom: null }, probedFrom: "box", probedAt: "2026-09-09T00:00:00.000Z" } }, { probedFrom: "fixture" })
  assert.equal(replay.muse.probedFrom, "box")
  assert.equal(replay.muse.probedAt, "2026-09-09T00:00:00.000Z")
  // The stale mark clears on the next successful read.
  const again = mergeCatalog(out, { codex: { row: stripMeta(HARNESS_CATALOG.codex) } }, meta)
  assert.equal(again.codex.stale, undefined)
  // A stale row renders as such.
  assert.match(renderTomlBlock(out), /codex.*\(stale\)/)
  assert.match(renderTomlBlock(out), /kept from an earlier run, probe failed 2026-09-10: sandbox timed out/)
})

test("diffRow: says what moved, in words a PR body can carry", () => {
  const a = { version: "1.0.0", efforts: ["low", "high"], models: [{ id: "m1", efforts: ["low"] }, { id: "m2" }], modelsFrom: "x" }
  assert.deepEqual(diffRow(a, a), [])
  assert.deepEqual(diffRow(a, { ...a, probedAt: "later", probedFrom: "box" }), [], "provenance is not drift")
  assert.deepEqual(diffRow(a, { ...a, version: "1.1.0" }), ["version 1.0.0 → 1.1.0"])
  assert.deepEqual(diffRow(a, { ...a, efforts: ["low", "medium", "high"] }), ["efforts +medium"])
  assert.deepEqual(diffRow(a, { ...a, efforts: ["low"] }), ["efforts -high"])
  assert.deepEqual(diffRow(a, { ...a, models: [{ id: "m1", efforts: ["low"] }, { id: "m3" }] }), ["models +m3 -m2"])
  assert.deepEqual(diffRow(a, { ...a, models: [{ id: "m1", efforts: ["low", "high"] }, { id: "m2" }] }), ["per-model efforts changed: m1"])
  assert.deepEqual(diffRow(undefined, a), ["new row"])
  assert.deepEqual(diffRow(a, undefined), ["row gone"])
  const many = { ...a, models: [...a.models, ...["a", "b", "c", "d", "e", "f"].map((id) => ({ id }))] }
  assert.match(diffRow(a, many)[0], /\+a \+b \+c \+d \+2 more/)
})
