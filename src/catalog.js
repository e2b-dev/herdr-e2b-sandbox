// What each harness's CLI offers: the model ids it knows and the words it takes for
// "how hard to think", read off the binary shipped in that harness's TEMPLATE.
//
// Two tables used to be typed by hand from a laptop (`EFFORT_SCALES` in
// src/effort.js, the template table in config/config.example.toml) and they had
// already drifted from each other and from the boxes by the day they were compared
// (docs/research/0003-model-and-effort-catalogs.md). The templates ship older CLIs
// than a developer's machine, in every case measured but one, so a laptop is the
// wrong oracle: `muse --help` on the box has no `max`, the box's `amp` has no
// per-model efforts key, and a row "verified against the CLI" was verified against
// the wrong CLI. What a box will accept is decided by the binary IN the box, so that
// is what gets asked.
//
// No registry answers this. models.dev knows every model id and, for a few
// providers, each model's effort values, but `ultra`, `dynamic`, `off` and `none`
// are words the coding CLIs invented and appear in no registry at all: registries
// are keyed by inference provider, this table by coding-agent CLI. So model ids
// come from the CLI where the CLI enumerates them (codex, grok, droid, amp, prime)
// and from models.dev where it does not (claude); efforts always come from the CLI.
// Five of eight print their own vocabulary when fed a sentinel value, which is the
// ADR 0009 spawn-the-binary shape applied to a different question.
//
// Same shape as src/harnesses.js and for the same reason: a shipped data table beside
// a PURE function. `interpretCatalog` never spawns and never fetches, it reads probe
// RESULTS, so every parse rule is testable from captured output on a machine with
// none of these installed. The spawning lives in scripts/harness-catalog.mjs, which
// boots the template, runs each probe, and writes what it read into
// src/harness-catalog.generated.js (committed, never hand-edited) and the table in
// config/config.example.toml. Two rules that script keeps and this module makes
// possible: a failed probe never blanks a row (`mergeCatalog` keeps the committed one
// and marks it stale), and a credential is never on a command line (every probe here
// runs unauthenticated, or reads a variable the box already has).

/**
 * The words in the order every scale is written: nothing, then more. Every harness
 * spells its own subset, and two print theirs descending, so a generated row would
 * otherwise flip order with the vendor's whim. Unknown words keep their own order
 * after these.
 */
export const EFFORT_ORDER = ["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

const text = (p) => `${p?.stdout ?? ""}\n${p?.stderr ?? ""}`
const uniq = (xs) => [...new Set(xs)]
const json = (p) => {
  try {
    return JSON.parse(String(p?.stdout ?? ""))
  } catch {
    return null
  }
}

/** An effort word as a CLI prints one: lowercase letters, digits, dashes. */
const isWord = (s) => /^[a-z][a-z0-9-]*$/.test(s)

/** `values` sorted by EFFORT_ORDER, de-duplicated; `null` for nothing usable. */
export function orderEfforts(values) {
  const words = uniq((values || []).map((v) => String(v ?? "").trim()).filter(isWord))
  if (!words.length) return null
  const rank = (w) => (EFFORT_ORDER.includes(w) ? EFFORT_ORDER.indexOf(w) : EFFORT_ORDER.length + words.indexOf(w))
  return words.sort((a, b) => rank(a) - rank(b))
}

/**
 * The comma- or pipe-separated list that follows `re`'s first capture in `s`,
 * as ordered effort words. This is how a rejection message is read: "Valid values:
 * low, medium, high." → ["low", "medium", "high"].
 */
export function enumAfter(s, re) {
  const m = String(s ?? "").match(re)
  if (!m?.[1]) return null
  return orderEfforts(m[1].split(/[,|]/).map((w) => w.trim().replace(/^'|'$/g, "").replace(/^and\s+/, "")))
}

/** The union of every model's efforts, ordered; `null` when no model names any. */
export function unionEfforts(models) {
  return orderEfforts((models || []).flatMap((m) => m.efforts || []))
}

/** Does at least one model take a different set than the union? (Then a flat row lies.) */
export function perModel(row) {
  const all = row?.efforts || []
  return !!row?.models?.some((m) => m.efforts && (m.efforts.length !== all.length || m.efforts.some((e) => !all.includes(e))))
}

/** models.dev's `api.json`: one provider's models as catalog rows, with each model's effort values when it has any. */
function modelsDev(p, provider) {
  const j = json(p)
  const models = j?.[provider]?.models
  if (!models || typeof models !== "object") return null
  const rows = Object.values(models)
    .filter((m) => m?.id)
    .map((m) => {
      const eff = (m.reasoning_options || []).find((o) => o?.type === "effort")?.values
      const ordered = orderEfforts(eff)
      return { id: String(m.id), ...(ordered ? { efforts: ordered } : {}) }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  return rows.length ? rows : null
}

/** The first `x.y.z[-tag]` in a `--version` answer, or null. */
export function versionIn(s) {
  return String(s ?? "").match(/\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?/)?.[0] ?? null
}

// The droid handshake. Factory's own envelope, not plain JSON-RPC and not ACP: every
// field below is required (`type`, the literal `factoryApiVersion`, a STRING id,
// `machineId`) and the two `--*-format` flags must both be given. It scaffolds
// ~/.factory and opens a session, so it runs against a throwaway HOME. Verified to
// return the full model list with no credential at all.
const DROID_HELLO = JSON.stringify({
  jsonrpc: "2.0",
  factoryApiVersion: "1.0.0",
  type: "request",
  id: "1",
  method: "droid.initialize_session",
  params: { cwd: "/tmp", machineId: "herdr-e2b-catalog" },
})
const THROWAWAY_HOME = 'H="$(mktemp -d)"; export HOME="$H";'

/**
 * Per harness: the probes to run (in this order: grok's cache is written by the
 * probe before it) and the pure rule that reads their results.
 *
 *   probes.<name>   { cmd }  a shell line run in the box's login shell, or
 *                   { url }  an unauthenticated GET; `trim` reduces a large answer
 *                   to the fields `parse` reads before it is saved as a fixture.
 *   needs           which field a usable row must carry: "efforts", "modes" or null.
 *   modelsFrom      where the model column comes from, for the docs; null = not
 *                   enumerable (muse has no pinnable model; opencode's universe is
 *                   all of models.dev and its own `models` lists only CONFIGURED
 *                   providers, 7 lines on a clean HOME against 439 with keys, so a
 *                   box probe would delete 432 valid ids).
 *   parse(results)  → { efforts, models, modes? } or null when the row cannot be
 *                   trusted. `efforts` is the flat set the CLI accepts (what a pin may
 *                   say); each model may carry its own `efforts` and `default`.
 *
 * Every rule reads stdout AND stderr and ignores the exit code: the rejection
 * oracles exit non-zero by design, and droid's `Invalid model` exits 0.
 */
export const CATALOG_PROBES = {
  claude: {
    needs: "efforts",
    modelsFrom: "models.dev (anthropic)",
    probes: {
      version: { cmd: "claude --version" },
      // An empty prompt: the CLI validates --effort, warns with the valid set, and
      // then dies for want of input: exit 1, no session, no tokens.
      efforts: { cmd: `claude -p --effort __probe__ ""` },
      models: {
        url: "https://models.dev/api.json",
        trim: (s) => JSON.stringify({ anthropic: JSON.parse(s).anthropic }),
      },
    },
    parse: ({ efforts, models }) => {
      const e = enumAfter(text(efforts), /Valid values:\s*([^.\n]+)/)
      return e ? { efforts: e, models: modelsDev(models, "anthropic") } : null
    },
  },
  codex: {
    needs: "efforts",
    modelsFrom: "codex debug models --bundled",
    probes: {
      version: { cmd: "codex --version" },
      // `--bundled` is the catalog compiled into this binary, offline. Without it
      // codex silently falls back to the same thing when unauthenticated, so asking
      // for it outright is the honest version of the same answer.
      catalog: {
        cmd: "codex debug models --bundled",
        trim: (s) =>
          JSON.stringify({
            models: (JSON.parse(s).models || []).map((m) => ({
              slug: m.slug,
              visibility: m.visibility,
              default_reasoning_level: m.default_reasoning_level,
              supported_reasoning_levels: (m.supported_reasoning_levels || []).map((l) => ({ effort: l.effort })),
            })),
          }),
      },
    },
    parse: ({ catalog }) => {
      const j = json(catalog)
      if (!Array.isArray(j?.models)) return null
      // `visibility: "list"` is what codex's own picker shows; hidden slugs are
      // retired or internal.
      const models = j.models
        .filter((m) => m?.slug && m.visibility === "list")
        .map((m) => {
          const eff = orderEfforts((m.supported_reasoning_levels || []).map((l) => l?.effort))
          return { id: String(m.slug), ...(eff ? { efforts: eff } : {}), ...(m.default_reasoning_level ? { default: m.default_reasoning_level } : {}) }
        })
      const efforts = unionEfforts(models)
      return efforts ? { efforts, models } : null
    },
  },
  grok: {
    needs: "efforts",
    modelsFrom: "~/.grok/models_cache.json after `grok models`",
    probes: {
      version: { cmd: "grok --version" },
      // Needs a credential: the catalog is team-scoped and fetched on the first
      // authenticated command, which writes the cache the next probe reads. The box
      // has XAI_API_KEY in its environment; nothing here names its value.
      models: { cmd: "grok models" },
      cache: { cmd: 'cat "$HOME/.grok/models_cache.json"' },
      // A non-empty prompt on purpose: the empty-prompt guard runs BEFORE effort
      // validation, so `-p ""` would pass every value.
      efforts: { cmd: "grok --reasoning-effort __probe__ -p x" },
    },
    parse: ({ models, cache, efforts }) => {
      const j = json(cache)
      if (j?.models && typeof j.models === "object") {
        const rows = Object.entries(j.models)
          .filter(([, m]) => !m?.info?.hidden)
          .map(([id, m]) => {
            const list = m?.info?.reasoning_efforts || []
            const eff = orderEfforts(list.map((e) => e?.value))
            const def = list.find((e) => e?.default)?.value
            return { id, ...(eff ? { efforts: eff } : {}), ...(def ? { default: def } : {}) }
          })
        const all = unionEfforts(rows)
        if (all) return { efforts: all, models: rows }
      }
      // No cache (unauthenticated, or an older grok): the flat set from the
      // rejection and whatever ids `grok models` listed.
      const e = enumAfter(text(efforts), /use one of:\s*([^\n;]+)/)
      if (!e) return null
      const ids = uniq([...text(models).matchAll(/^\s+[*-]\s+(\S+)/gm)].map((m) => m[1]))
      return { efforts: e, models: ids.length ? ids.map((id) => ({ id })) : null }
    },
  },
  droid: {
    needs: "efforts",
    modelsFrom: "droid.initialize_session (stream-jsonrpc)",
    probes: {
      version: { cmd: "droid --version" },
      catalog: {
        cmd: `${THROWAWAY_HOME} printf '%s\\n' '${DROID_HELLO}' | droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`,
        // Only the response that carries the models, and only the fields read.
        trim: (s) => {
          for (const line of String(s).split("\n")) {
            try {
              const o = JSON.parse(line)
              if (o?.type === "response" && Array.isArray(o.result?.availableModels)) {
                return JSON.stringify({
                  type: "response",
                  result: {
                    availableModels: o.result.availableModels.map((m) => ({
                      id: m.id,
                      supportedReasoningEfforts: m.supportedReasoningEfforts,
                      defaultReasoningEffort: m.defaultReasoningEffort,
                      deprecated: m.deprecated,
                    })),
                  },
                })
              }
            } catch {}
          }
          return s
        },
      },
      efforts: { cmd: `${THROWAWAY_HOME} droid exec --reasoning-effort __bogus__ x` },
      models: { cmd: `${THROWAWAY_HOME} droid exec --model __bogus__ x` },
    },
    parse: ({ catalog, efforts, models }) => {
      let rows = null
      for (const line of text(catalog).split("\n")) {
        let o
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        if (o?.type === "response" && Array.isArray(o.result?.availableModels)) {
          rows = o.result.availableModels
            .filter((m) => m?.id)
            .map((m) => {
              const eff = orderEfforts(m.supportedReasoningEfforts)
              return {
                id: String(m.id),
                ...(eff ? { efforts: eff } : {}),
                ...(m.defaultReasoningEffort ? { default: m.defaultReasoningEffort } : {}),
                ...(m.deprecated ? { deprecated: true } : {}),
              }
            })
          break
        }
      }
      // The live union, not the syntactic enum: droid accepts nine words at the
      // flag and then silently coerces one no model supports (`dynamic`, today) to
      // the model's default, exit 0. A word no model takes is not a choice.
      const live = unionEfforts(rows)
      if (live) return { efforts: live, models: rows }
      const e = enumAfter(text(efforts), /Allowed values:\s*([^\n]+)/)
      if (!e) return null
      const ids = text(models).match(/Available built-in models:\s*\n\s*([^\n]+)/)?.[1]
      return { efforts: e, models: ids ? ids.split(",").map((s) => ({ id: s.trim() })).filter((m) => m.id) : null }
    },
  },
  amp: {
    needs: "modes",
    modelsFrom: "amp plugins show-agent-options --json",
    probes: {
      version: { cmd: "amp --version" },
      options: {
        cmd: "amp plugins show-agent-options --json",
        trim: (s) =>
          JSON.stringify({
            models: (JSON.parse(s).models || []).map((m) => ({
              id: m.id,
              capabilities: m.capabilities?.efforts ? { efforts: m.capabilities.efforts } : {},
            })),
          }),
      },
      help: { cmd: "amp --help" },
      // amp's own --reasoning-effort vocabulary, from its rejection. Recorded, and
      // kept APART from the modes: `ultra` is a mode only, `xhigh`/`max` efforts
      // only, and `low|medium|high` mean different things in each. Never unioned.
      efforts: { cmd: "amp config model-providers check-access --provider-model a/b --reasoning-effort bogus-zzz" },
    },
    parse: ({ options, help, efforts }) => {
      // "Set the agent mode (low, medium, high, ultra, or a plugin mode by key or
      // label, case-insensitive)": the bare words up to the first phrase.
      const inParens = text(help).match(/--mode <value>[\s\S]*?\(([^)]*)\)/)?.[1]
      const modes = []
      for (const w of (inParens || "").split(",").map((s) => s.trim())) {
        if (!/^[a-z]+$/.test(w)) break
        modes.push(w)
      }
      if (!modes.length) return null
      const j = json(options)
      const models = Array.isArray(j?.models)
        ? j.models
            .filter((m) => m?.id)
            .map((m) => {
              const eff = orderEfforts(m.capabilities?.efforts)
              return { id: String(m.id), ...(eff ? { efforts: eff } : {}) }
            })
        : null
      return { modes, efforts: enumAfter(text(efforts), /Allowed choices are\s*([^.\n]+)/), models }
    },
  },
  prime: {
    needs: "efforts",
    modelsFrom: "prime-agent model list",
    probes: {
      version: { cmd: "prime-agent --version" },
      help: { cmd: "prime-agent --help" },
      models: { cmd: "prime-agent model list" },
    },
    parse: ({ help, models }) => {
      const e = enumAfter(text(help), /--thinking <level>\s+Set reasoning:\s*([^\n]+)/)
      if (!e) return null
      // A table: `provider  model  context  max-out  thinking  images`. The id is
      // spelled the way the pin is: `<provider>/<model>`, split at the first slash.
      const rows = []
      for (const line of text(models).split("\n")) {
        const m = line.match(/^([a-z0-9][a-z0-9._-]*)\s+(\S+)\s+\S+\s+\S+\s+(yes|no)\b/i)
        if (!m || m[1] === "provider") continue
        rows.push({ id: `${m[1]}/${m[2]}`, ...(m[3].toLowerCase() === "yes" ? { reasoning: true } : {}) })
      }
      return { efforts: e, models: rows.length ? rows : null }
    },
  },
  muse: {
    needs: "efforts",
    modelsFrom: null,
    probes: {
      version: { cmd: "muse --version" },
      help: { cmd: "muse exec --help" },
      // clap validates the value before anything else happens: "invalid value
      // '__bogus__' … expected none|minimal|…". No config, no network.
      oracle: { cmd: "muse --reasoning-effort __bogus__" },
    },
    parse: ({ help, oracle }) => {
      const e = enumAfter(text(oracle), /expected\s+([a-z|]+)/) || enumAfter(text(help), /reasoning effort:\s*([a-z|]+)/i)
      return e ? { efforts: e, models: null } : null
    },
  },
  opencode: {
    needs: null,
    modelsFrom: null,
    probes: { version: { cmd: "opencode --version" } },
    // Reasoning is a per-model VARIANT picked in its UI, not a setting the plugin
    // writes (src/effort.js gives it the generic scale); its model universe is all
    // of models.dev. Only the version is worth reading.
    parse: () => ({ efforts: null, models: null }),
  },
}

/**
 * Read one harness's probe results into a catalog row, or null when they cannot be
 * trusted (no version, or the field the row needs is missing). Pure: takes results,
 * never a spawner. A null here is what makes `mergeCatalog` keep the committed row.
 *
 * @param {string} id       key into CATALOG_PROBES
 * @param {object} results  { <probe>: { stdout, stderr, status } }
 * @returns {{version:string, efforts:string[]|null, models:object[]|null, modelsFrom:string|null, modes?:string[]}|null}
 */
export function interpretCatalog(id, results = {}) {
  const spec = CATALOG_PROBES[id]
  if (!spec) return null
  const version = versionIn(text(results.version))
  if (!version) return null
  let parsed
  try {
    parsed = spec.parse(results)
  } catch {
    parsed = null
  }
  if (!parsed) return null
  const row = {
    version,
    efforts: parsed.efforts ?? null,
    ...(parsed.modes ? { modes: parsed.modes } : {}),
    models: parsed.models ?? null,
    modelsFrom: parsed.models ? spec.modelsFrom : null,
  }
  if (spec.needs && !row[spec.needs]?.length) return null
  return row
}

/** A row without its provenance, for comparing what the CLI said across runs. */
export function stripMeta(row) {
  if (!row) return null
  const { probedFrom, probedAt, template, stale, ...rest } = row
  return rest
}

/**
 * The next committed catalog: every harness the probes cover, taken from `fresh`
 * where a row was read and kept from `committed` where it was not.
 *
 * `fresh[id]` is `{ row, reason, probedFrom?, probedAt? }`: `row` null means the
 * probe failed and `reason` says how; the two provenance fields, when given, say
 * where THAT row came from (a fixture replay carries the box's, not "fixture"). A
 * failed probe never blanks a row: an unauthenticated run of the script would
 * otherwise empty every scale and turn every user's pin invalid at once. The kept
 * row is marked `stale: { since, reason }` so the report and the docs can say so.
 *
 * @param {object} committed   the current HARNESS_CATALOG
 * @param {object} fresh       { <id>: { row, reason, probedFrom, probedAt } }
 * @param {object} meta        { probedFrom, probedAt, templates: { <id>: { name, buildID, updatedAt } } }
 */
export function mergeCatalog(committed = {}, fresh = {}, meta = {}) {
  const out = {}
  const now = meta.probedAt ?? new Date().toISOString()
  for (const id of Object.keys(CATALOG_PROBES)) {
    const got = fresh[id]
    const template = meta.templates?.[id] ?? committed[id]?.template ?? null
    if (got?.row) {
      out[id] = { ...got.row, probedFrom: got.probedFrom ?? meta.probedFrom ?? "box", probedAt: got.probedAt ?? now, template }
    } else if (committed[id]) {
      const { stale, ...kept } = committed[id]
      out[id] = got ? { ...kept, template, stale: { since: now, reason: got.reason || "probe failed" } } : committed[id]
    }
  }
  return out
}

/** What changed between two rows of the same harness, as short phrases; [] when nothing did. */
export function diffRow(before, after) {
  const a = stripMeta(before)
  const b = stripMeta(after)
  if (!a) return b ? ["new row"] : []
  if (!b) return ["row gone"]
  const out = []
  if (a.version !== b.version) out.push(`version ${a.version} → ${b.version}`)
  const list = (name, x, y) => {
    const xs = x || []
    const ys = y || []
    const plus = ys.filter((v) => !xs.includes(v))
    const minus = xs.filter((v) => !ys.includes(v))
    if (plus.length || minus.length) out.push(`${name} ${[...plus.map((v) => `+${v}`), ...minus.map((v) => `-${v}`)].join(" ")}`)
    else if (xs.join(",") !== ys.join(",")) out.push(`${name} reordered`)
  }
  list("efforts", a.efforts, b.efforts)
  if (a.modes || b.modes) list("modes", a.modes, b.modes)
  const ids = (ms) => (ms || []).map((m) => m.id)
  const am = ids(a.models)
  const bm = ids(b.models)
  const plus = bm.filter((v) => !am.includes(v))
  const minus = am.filter((v) => !bm.includes(v))
  if (plus.length || minus.length) {
    const show = (xs, sign) => xs.slice(0, 4).map((v) => `${sign}${v}`).join(" ") + (xs.length > 4 ? ` ${sign}${xs.length - 4} more` : "")
    out.push(`models ${[show(plus, "+"), show(minus, "-")].filter(Boolean).join(" ")}`)
  } else {
    const changed = (b.models || []).filter((m) => {
      const o = (a.models || []).find((x) => x.id === m.id)
      return o && ((o.efforts || []).join(",") !== (m.efforts || []).join(",") || o.default !== m.default)
    })
    if (changed.length) out.push(`per-model efforts changed: ${changed.slice(0, 4).map((m) => m.id).join(", ")}${changed.length > 4 ? ` +${changed.length - 4} more` : ""}`)
  }
  return out
}

// --- what gets written -------------------------------------------------------------

/** Source of the committed module. JSON with 2-space indent, one export, a header that says who writes it. */
export function renderGeneratedModule(catalog, { probedAt = new Date().toISOString() } = {}) {
  const head = [
    "// GENERATED by scripts/harness-catalog.mjs. Do not edit, rerun:",
    "//   npm run catalog -- --write            (boots each template, the authoritative read)",
    "//   npm run catalog -- --from=fixture --write  (re-derives from test/fixtures/catalog)",
    "//",
    "// What each harness's CLI accepts, read off the binary in its E2B template: the",
    "// effort words a pin may say (`efforts`; amp's `modes`), the model ids it lists",
    "// (`models`, each with its own efforts and default where the CLI says so), the",
    "// version that answered, and the template build it was read from. src/effort.js",
    "// derives EFFORT_SCALES from this; config/config.example.toml's table is rendered",
    "// from it. Parse rules and the reasoning behind every field: src/catalog.js.",
    `// Last run: ${probedAt}`,
    "",
  ]
  return `${head.join("\n")}export const HARNESS_CATALOG = ${JSON.stringify(catalog, null, 2)}\n`
}

export const TOML_BEGIN = "# <catalog>"
export const TOML_END = "# </catalog>"

/** The first ids of `xs` that fit in `width` characters, at least one: "a, b, …". */
const examples = (xs, width = 36) => {
  const out = []
  for (const x of xs) {
    if (out.length && `${[...out, x].join(", ")}, …`.length > width) break
    out.push(x)
  }
  return out.length < xs.length ? `${out.join(", ")}, …` : out.join(", ")
}

/**
 * The comment table in config/config.example.toml, between the two sentinels: one
 * line per harness with the CLI version, the model column (count and first ids, or
 * why there is none) and the effort scale. Rendered as text and spliced in as
 * text: the file is nearly all comments, and re-stringifying TOML would drop them.
 */
export function renderTomlBlock(catalog) {
  const rows = Object.keys(CATALOG_PROBES)
    .filter((id) => catalog[id])
    .map((id) => {
      const r = catalog[id]
      const ids = (r.models || []).map((m) => m.id)
      let models
      if (id === "opencode") models = 'any models.dev "<provider>/<model>"'
      else if (id === "muse") models = "(no pinnable model: use --model in your agent command)"
      else if (id === "amp") models = ids.length ? `${ids.length} listed, no pin route: ${examples(ids, 24)}` : "(no pin route)"
      else models = ids.length ? `${ids.length}: ${examples(ids)}` : "(not enumerated)"
      let reasoning
      if (r.modes) reasoning = `--mode ${r.modes.join(" | ")} (amp's knob is the mode)`
      else if (r.efforts) reasoning = `${r.efforts.join(" | ")}${perModel(r) ? " (per model)" : ""}`
      else reasoning = "(not pinned: opencode does reasoning as per-model variants in its UI)"
      const cli = `${r.version}${r.stale ? " (stale)" : ""}`
      return [id, cli, models, reasoning]
    })
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length), ["template", "cli", "model"][i].length))
  const line = (cols) => `#   ${cols[0].padEnd(w[0])}  ${cols[1].padEnd(w[1])}  ${cols[2].padEnd(w[2])}  ${cols[3]}`.trimEnd()
  const stale = Object.entries(catalog).filter(([, r]) => r.stale)
  return [
    TOML_BEGIN,
    "# Generated by `npm run catalog -- --write` from the CLI shipped in each template.",
    "# Do not edit this block: rerun the script. Per-model detail is in",
    "# src/harness-catalog.generated.js.",
    line(["template", "cli", "model", "reasoning"]),
    ...rows.map(line),
    ...stale.map(([id, r]) => `#   (${id}: kept from an earlier run, probe failed ${r.stale.since.slice(0, 10)}: ${r.stale.reason})`),
    TOML_END,
  ].join("\n")
}

/** `text` with whatever sits between the sentinels replaced by `block`. Throws when the sentinels are missing. */
export function spliceTomlBlock(text, block) {
  const s = String(text)
  const i = s.indexOf(TOML_BEGIN)
  const j = s.indexOf(TOML_END)
  if (i < 0 || j < i) throw new Error(`config.example.toml: sentinels ${TOML_BEGIN} … ${TOML_END} not found`)
  return s.slice(0, i) + block + s.slice(j + TOML_END.length)
}
