// How hard each agent can be asked to think, in that agent's own words, and which
// models it knows.
//
// `[templates.<name>] reasoning` (src/model-pin.js) pins ONE effort for every box a
// template boots. The pickers (`e2b-box open`'s template list, the fleet's roster
// table) let a human pick per box and per member instead, and to offer a list they
// need to know which words a harness accepts. That list lives here, once, so the
// roster picker, the single-box picker and the `--reasoning` flag's validation agree.
// (The bash-facing CLI is src/effort-cli.js: this module is imported by config.js,
// so a CLI here that loaded config.js would be a top-level-await import cycle,
// which Node 26 reports as "unsettled top-level await" and exits 13 - observed live.)
//
// The WORDS are not typed here. They are read off the CLI shipped in each harness's
// template by scripts/harness-catalog.mjs and committed to
// src/harness-catalog.generated.js (src/catalog.js has every parse rule and the
// reasons). This module used to hold them as literals, config.example.toml held a
// second copy, the tests a third, and the copies disagreed with each other and with
// the boxes within a week (docs/research/0003). What stays hand-written below is the
// plugin's OVERLAY: how a pin reaches the box (`via`), what the picker shows beside
// the value (`kind`), and the words the plugin declines to offer even though the CLI
// takes them. Refresh the facts with `npm run catalog -- --write`; never edit them.
//
// `kind` is what the picker shows beside the value: `native` (the harness reads it),
// `generic` (a hint the human applies in the UI), `none` (no scale, cell is blank).

import { HARNESSES, harnessForTemplate } from "./harnesses.js"
import { HARNESS_CATALOG } from "./harness-catalog.generated.js"
import { pinSupport } from "./model-pin.js"

/** The generic scale for a harness the plugin cannot set effort on. */
export const GENERIC_SCALE = ["minimal", "medium", "high", "ultra"]

/**
 * The plugin's half of each scale. `values` reads the catalog row (default: its
 * `efforts`); `omit` drops words the CLI accepts but the picker should not offer.
 */
const OVERLAY = {
  claude: { kind: "native", via: "CLAUDE_CODE_EFFORT_LEVEL" },
  codex: { kind: "native", via: "model_reasoning_effort (the model decides)" },
  grok: { kind: "native", via: "default_reasoning_effort" },
  // `none` and `dynamic` mean "let the model decide", not an effort; droid also
  // silently coerces a word the chosen model lacks to that model's default, so
  // `effortsForModel` is the check that matters for it.
  droid: { kind: "native", via: "reasoningEffort (each model a subset)", omit: ["none", "dynamic"] },
  prime: { kind: "native", via: "defaultThinkingLevel" },
  muse: { kind: "native", via: "reasoning_effort" },
  // amp has no reasoning knob the plugin writes; `--mode` picks model + prompt and
  // the shipped fleet command passes it, so its "effort" IS the mode. Its own
  // `--reasoning-effort` vocabulary is recorded in the catalog and never mixed in.
  amp: { kind: "native", via: "--mode", values: (row) => row?.modes },
  // Reasoning is a per-model VARIANT chosen in opencode's UI, not a setting the
  // plugin can write; the generic scale only reaches the box as HERDR_E2B_REASONING.
  opencode: { kind: "generic", via: "pick in opencode's UI", values: () => GENERIC_SCALE },
}

export const EFFORT_SCALES = Object.fromEntries(
  Object.entries(OVERLAY).map(([id, o]) => {
    const row = HARNESS_CATALOG[id]
    const raw = (o.values ? o.values(row) : row?.efforts) || []
    const values = raw.filter((v) => !(o.omit || []).includes(v))
    return [id, { kind: o.kind, values, via: o.via }]
  }),
)

/**
 * The harness behind a template, by name first and by its launch command second:
 * `[fleet.agents] "drew-claude" = "claude --dangerously-skip-permissions"` says what
 * a custom template runs, so its picker row can offer claude's scale and its box can
 * get claude's variables. Null when neither says.
 */
export function harnessHint(template, cfg = {}) {
  const t = String(template ?? "").trim()
  if (!t) return null
  const byName = harnessForTemplate(t)
  if (byName) return byName.id
  const cmd = String(cfg?.fleetAgents?.[t] ?? cfg?.runAgents?.[t] ?? "").trim()
  const bin = cmd.split(/\s+/)[0]?.replace(/^.*\//, "") || ""
  for (const [id, h] of Object.entries(HARNESSES)) if (h.bin === bin) return id
  return null
}

/** The scale a template's picker row offers: `{ harness, kind, values, via }`, or null. */
export function effortScale(template, cfg = {}) {
  const harness = harnessHint(template, cfg)
  const scale = harness ? EFFORT_SCALES[harness] : null
  return scale ? { harness, ...scale } : null
}

/** Is `value` something this template's harness accepts (or, for a generic scale, offers)? */
export function validEffort(template, value, cfg = {}) {
  const scale = effortScale(template, cfg)
  return !!scale && scale.values.includes(String(value ?? "").trim())
}

/**
 * The models a template's harness lists, `{ harness, from, models: [{ id, efforts?,
 * default? }] }`, or null when the harness enumerates none (muse, opencode) or the
 * template has no harness. `from` names the command or registry the ids came from.
 */
export function modelCatalog(template, cfg = {}) {
  const harness = harnessHint(template, cfg)
  const row = harness ? HARNESS_CATALOG[harness] : null
  return row?.models ? { harness, from: row.modelsFrom, models: row.models } : null
}

/**
 * The efforts ONE model takes, when the catalog knows that model; the harness's
 * whole scale when it does not (a model the catalog has not seen, a harness with a
 * flat scale). Same `omit` as the scale. This is the check droid needs: it accepts
 * any of its words at the flag and then quietly runs the model's default.
 */
export function effortsForModel(template, model, cfg = {}) {
  const scale = effortScale(template, cfg)
  if (!scale) return null
  const m = String(model ?? "").trim()
  const own = m ? modelCatalog(template, cfg)?.models.find((x) => x.id === m)?.efforts : null
  return own ? own.filter((v) => scale.values.includes(v)) : scale.values
}

/**
 * One picker row per fleet-eligible template: what the roster table draws.
 * `configured` is the `[templates.<name>] reasoning` pin when it is on the scale
 * (the cell opens there); "" when nothing is pinned or the pin is off-scale.
 *
 * `models` is the model cell's list: the catalog's ids, but only where the plugin
 * has a route to deliver the pick (src/model-pin.js `pinSupport`): amp lists 42
 * models and has no model setting, so its cell is blank; opencode has a route and
 * no finite list, so it is blank too and `[templates.opencode] model` stays the
 * way to say it. `model` is the configured pin when it is on that list.
 */
export function effortRows(templates, cfg = {}) {
  return templates.map((t) => {
    const scale = effortScale(t, cfg)
    const pinned = String(cfg?.templateModels?.[t]?.reasoning ?? "").trim()
    const catalog = scale && pinSupport(scale.harness).model ? modelCatalog(t, cfg) : null
    const models = catalog ? catalog.models.map((m) => m.id) : []
    const pinnedModel = String(cfg?.templateModels?.[t]?.model ?? "").trim()
    return {
      template: t,
      harness: scale?.harness ?? null,
      kind: scale?.kind ?? "none",
      values: scale?.values ?? [],
      via: scale?.via ?? "",
      configured: scale && scale.values.includes(pinned) ? pinned : "",
      models,
      model: models.includes(pinnedModel) ? pinnedModel : "",
    }
  })
}
