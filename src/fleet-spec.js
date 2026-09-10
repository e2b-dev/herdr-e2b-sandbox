// A saved launch recipe becomes the same member specs as the CLI's -t flags.
// It contains no fleet identity or runtime state (ADR 0001).
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CONFIG_DIR } from "./config-paths.js"
import { loadConfig } from "./config.js"
import { expandMemberSpecs } from "./fleet-name.js"
import { modelCatalog, effortsForModel } from "./effort.js"

export const PRESETS_DIR = path.join(CONFIG_DIR, "presets")
const presetName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function object(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Error(`${label}: unknown field '${key}'`)
  }
}

function text(value, label, optional = true) {
  if (value === undefined && optional) return ""
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} must be text without NUL bytes`)
  return value
}

export function fleetSpec(value, cfg = {}) {
  object(value, ["slug", "task", "members"], "fleet")
  const slug = text(value.slug, "slug")
  const task = text(value.task, "task")
  if (!Array.isArray(value.members) || !value.members.length) throw new Error("members must be a nonempty array")
  const specs = value.members.map((member, i) => {
    const label = `members[${i}]`
    object(member, ["template", "model", "reasoning", "count"], label)
    const template = text(member.template, `${label}.template`, false)
    const model = text(member.model, `${label}.model`)
    const reasoning = text(member.reasoning, `${label}.reasoning`)
    const count = member.count === undefined ? 1 : member.count
    if (!template || /[\s:*@|]/.test(template)) throw new Error(`${label}.template must be one template name`)
    if (model && /[\s:*@|]/.test(model)) throw new Error(`${label}.model must be one model id`)
    if (reasoning && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(reasoning)) throw new Error(`${label}.reasoning must be one effort word`)
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error(`${label}.count must be an integer from 1 to 20`)
    // Refuse a generated typo before any worktree exists, using the catalog
    // that also guards box creation. Omitted pins keep the template defaults.
    const catalog = modelCatalog(template, cfg)
    if (model && catalog && !catalog.models.some((m) => m.id === model)) throw new Error(`${label}: '${model}' is not a model ${template} lists`)
    const accepts = effortsForModel(template, model || cfg.templateModels?.[template]?.model, cfg)
    if (reasoning && accepts && !accepts.includes(reasoning)) throw new Error(`${label}: '${reasoning}' is not an effort ${template} accepts for this model (${accepts.join(", ")})`)
    return `${template}${model ? `:${model}` : ""}*${count}${reasoning ? `@${reasoning}` : ""}`
  })
  return { slug, task, specs }
}

export function presetPath(name, directory = PRESETS_DIR) {
  if (!presetName.test(name)) throw new Error("preset name must contain only letters, digits, underscores or hyphens, starting with a letter or digit")
  return path.join(directory, `${name}.json`)
}

export function listPresets(directory = PRESETS_DIR) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith(".json") && presetName.test(f.name.slice(0, -5)))
      .map((f) => f.name.slice(0, -5)).sort()
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, input] = process.argv.slice(2)
    if (mode === "--list") {
      process.stdout.write(listPresets().join("\n"))
    } else {
      if (!["--file", "--preset", "--rows"].includes(mode) || !input) throw new Error("use --file PATH, --preset NAME or --list")
      const file = mode === "--file" ? (input === "-" ? 0 : input) : presetPath(input)
      const spec = fleetSpec(JSON.parse(readFileSync(file, "utf8")), loadConfig())
      if (mode === "--rows") {
        process.stdout.write(`${spec.task.replace(/[\x00-\x1f\x7f]/g, " ")}\n`)
        for (const m of expandMemberSpecs(spec.specs)) process.stdout.write(`${m.template}|${m.model}|${m.effort}\n`)
      } else process.stdout.write(JSON.stringify(spec))
    }
  } catch (error) {
    process.stderr.write(`fleet specification: ${error.message}\n`)
    process.exitCode = 2
  }
}
