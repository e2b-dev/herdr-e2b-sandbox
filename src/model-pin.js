// Which model a box's agent uses, and how hard it thinks: `[templates.<name>]
// model = "…"` and `reasoning = "…"` in config.toml, applied to EVERY box booted
// from that template, whether `open`, `fleet` or `run` booted it.
//
// Every harness has a default model and a default effort, and every harness lets a
// human change them in the TUI. A box has no human. Left alone, an agent picks
// whatever its vendor or its provider ranks first, which is how an opencode member
// on an OpenRouter key came up on an image model with no tool use (observed live,
// 2026-09-08). Pinning it in the launch command works for one verb at a time and
// has to be repeated in `[fleet.agents]` and `[run.agents]`; a plain `e2b-box open`
// followed by typing `opencode` gets neither. So the pin goes where the agent reads
// its defaults from, and the launch commands stay as they are.
//
// Two routes, one per harness, chosen by what that harness documents:
//   · ENV      the harness reads a variable at start (claude, opencode). Set on the
//              box at create time, beside the credential.
//   · FILE     the harness reads its own config file (codex, grok, droid, prime,
//              muse). A one-line command, run over the SDK right after the first-run
//              seed (src/fleet-seed.js), writes the keys into that file.
// Both routes read the SAME two variables, `HERDR_E2B_MODEL` and
// `HERDR_E2B_REASONING`, which are injected into every box whose template has a
// pin. That is also the hook for a user's own `[fleet.agents]` / `[run.agents]`
// command: `--model "$HERDR_E2B_MODEL"` works for any CLI the table below does not
// cover.
//
// THE RULES EVERY FILE COMMAND KEEPS, the same as the seeds: one line; POSIX sh
// plus `node -e` (every shipped agent template has Node); never clobber a key that
// is already set (a resumed box's file is the user's); a missing variable means
// "leave the default alone", never an empty string written into a config.
//
// Keys verified against each vendor's own docs or a file the CLI wrote itself:
//   claude    ANTHROPIC_MODEL, CLAUDE_CODE_EFFORT_LEVEL           (code.claude.com/docs/en/model-config)
//   opencode  OPENCODE_CONFIG_CONTENT, inline JSON, "model"         (opencode.ai/docs/config; reasoning is per-model
//             variants there, so it is not pinned)
//   codex     ~/.codex/config.toml  model, model_reasoning_effort  (codex-rs config)
//   grok      ~/.grok/config.toml   [models] default, default_reasoning_effort  (docs.x.ai/build/settings/reference;
//             grok 1.0.13 accepts low | medium | high | xhigh and rejects "max" with "Invalid reasoning effort")
//   droid     ~/.factory/settings.json  model, reasoningEffort     (docs.factory.ai/droid-cli/settings)
//   prime     ~/.prime/agent/settings.json  defaultProvider, defaultModel, defaultThinkingLevel
//             (settings-manager.js, 0.9.3; model is written as `<provider>/<model>`, split at the first `/`)
//   muse      ~/.config/muse/settings.json  reasoning_effort       (a file muse 1.0.3 wrote itself; no verified
//             model key, so `model` is reported and not written)
//   amp       nothing: amp has no model setting, only `--mode low|medium|high|ultra`

/** The two variables both routes read. Exported so tests and docs name the same strings. */
export const MODEL_VAR = "HERDR_E2B_MODEL"
export const REASONING_VAR = "HERDR_E2B_REASONING"

/** Templates whose harness reads the pin from the environment, and the variables it reads. */
const ENV_ROUTES = {
  claude: (model, reasoning) => ({
    ...(model ? { ANTHROPIC_MODEL: model } : {}),
    ...(reasoning ? { CLAUDE_CODE_EFFORT_LEVEL: reasoning } : {}),
  }),
  // "inject inline JSON as a final local-scope merge" (opencode's own description of
  // the variable), so it wins over the seeded ~/.config/opencode/opencode.json.
  //
  // The model is ALSO declared under its provider. opencode's TUI only selects a
  // model it can find in the provider's list, and on a fresh box that list is the
  // snapshot bundled into the binary until the models.dev fetch lands — so a model
  // newer than the template's opencode was unknown at the first launch and the TUI
  // fell back to whatever the provider ranked first (an image model with no tool
  // use; observed live, fleet test-opencode, 2026-09-08, while `opencode run` with
  // the same variable honoured the pin). A `provider.<id>.models.<model>` entry
  // makes the model exist in config, fetch or no fetch; an empty object is enough
  // (verified on 1.18.18: `opencode models openrouter` lists it, `run` uses it).
  opencode: (model) => {
    if (!model) return {}
    const i = model.indexOf("/")
    const provider = i > 0 ? { provider: { [model.slice(0, i)]: { models: { [model.slice(i + 1)]: {} } } } } : {}
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model, ...provider }) }
  },
}

// The file route. `M`/`R` are read inside the box; nothing here interpolates a value.
const NODE = "node -e"
const FILE_ROUTES = {
  codex:
    `mkdir -p "$HOME/.codex"; ${NODE} 'const fs=require("fs"),f=process.env.HOME+"/.codex/config.toml",NL=String.fromCharCode(10),m=process.env.${MODEL_VAR},r=process.env.${REASONING_VAR};let t="";try{t=fs.readFileSync(f,"utf8")}catch{}let add="";if(m&&!/^model *=/m.test(t))add+="model = "+JSON.stringify(m)+NL;if(r&&!/^model_reasoning_effort *=/m.test(t))add+="model_reasoning_effort = "+JSON.stringify(r)+NL;if(add){fs.writeFileSync(f,add+t);console.log("herdr-e2b: codex pinned"+(m?" to "+m:"")+(r?" at "+r+" effort":""))}else console.log("herdr-e2b: codex model/effort already set - leaving it alone")'`,
  // Top-level keys go BEFORE any [table] in TOML, hence prepend. The [models]
  // section is only created when absent: editing inside an existing one is not a
  // one-liner worth trusting, and a box that already has one was configured by hand.
  grok:
    `mkdir -p "$HOME/.grok"; ${NODE} 'const fs=require("fs"),f=process.env.HOME+"/.grok/config.toml",NL=String.fromCharCode(10),m=process.env.${MODEL_VAR},r=process.env.${REASONING_VAR};let t="";try{t=fs.readFileSync(f,"utf8")}catch{}if(!m&&!r)process.exit(0);if(t.includes("[models]")){console.log("herdr-e2b: grok already has a [models] section - leaving it alone");process.exit(0)}let s=(t&&!t.endsWith(NL)?NL:"")+"[models]"+NL;if(m)s+="default = "+JSON.stringify(m)+NL;if(r)s+="default_reasoning_effort = "+JSON.stringify(r)+NL;fs.writeFileSync(f,t+s);console.log("herdr-e2b: grok pinned"+(m?" to "+m:"")+(r?" at "+r+" effort":""))'`,
  droid:
    `mkdir -p "$HOME/.factory"; ${NODE} 'const fs=require("fs"),f=process.env.HOME+"/.factory/settings.json",m=process.env.${MODEL_VAR},r=process.env.${REASONING_VAR};let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}let w=false;if(m&&c.model===undefined){c.model=m;w=true}if(r&&c.reasoningEffort===undefined){c.reasoningEffort=r;w=true}if(w){fs.writeFileSync(f,JSON.stringify(c,null,2));console.log("herdr-e2b: droid pinned"+(m?" to "+m:"")+(r?" at "+r+" effort":""))}else if(m||r)console.log("herdr-e2b: droid model/effort already set - leaving it alone")'`,
  // prime keeps provider and model apart and its ids are bare (`gpt-6-astra`,
  // `z-ai/glm-5.2`), so the pin is spelled `<provider>/<model>` and split at the
  // FIRST slash: `prime-inference/z-ai/glm-5.2` is provider `prime-inference`.
  prime:
    `mkdir -p "$HOME/.prime/agent"; ${NODE} 'const fs=require("fs"),f=process.env.HOME+"/.prime/agent/settings.json",m=process.env.${MODEL_VAR},r=process.env.${REASONING_VAR};let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}let w=false;if(m&&c.defaultModel===undefined){const i=m.indexOf("/");if(i>0){c.defaultProvider=m.slice(0,i);c.defaultModel=m.slice(i+1)}else c.defaultModel=m;w=true}if(r&&c.defaultThinkingLevel===undefined){c.defaultThinkingLevel=r;w=true}if(w){fs.writeFileSync(f,JSON.stringify(c,null,2));console.log("herdr-e2b: prime pinned"+(m?" to "+m:"")+(r?" at "+r+" thinking":""))}else if(m||r)console.log("herdr-e2b: prime model/thinking already set - leaving it alone")'`,
  muse:
    `mkdir -p "$HOME/.config/muse"; ${NODE} 'const fs=require("fs"),f=process.env.HOME+"/.config/muse/settings.json",m=process.env.${MODEL_VAR},r=process.env.${REASONING_VAR};let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}if(m)console.log("herdr-e2b: muse has no verified settings key for a model - pass --model to it yourself");if(r&&c.reasoning_effort===undefined){if(c.schema_version===undefined)c.schema_version=1;c.reasoning_effort=r;fs.writeFileSync(f,JSON.stringify(c,null,2));console.log("herdr-e2b: muse pinned at "+r+" effort")}else if(r)console.log("herdr-e2b: muse reasoning_effort already set - leaving it alone")'`,
}

/** Normalize one `[templates.<name>]` section's pin. `null` when it pins nothing. */
export function normalizePin(section) {
  const model = String(section?.model ?? "").trim()
  const reasoning = String(section?.reasoning ?? "").trim()
  if (!model && !reasoning) return null
  return { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) }
}

/**
 * The environment a pinned template's box is created with: the two shared
 * variables plus the harness's own, when it reads one. `{}` for no pin.
 */
export function modelEnv(template, pin, harness = template) {
  if (!pin) return {}
  const { model = "", reasoning = "" } = pin
  // `harness` is the route key: a custom template that runs claude (src/effort.js
  // `harnessHint`) gets claude's variables, not just the two shared ones.
  const own = ENV_ROUTES[harness]?.(model, reasoning) || {}
  return {
    ...(model ? { [MODEL_VAR]: model } : {}),
    ...(reasoning ? { [REASONING_VAR]: reasoning } : {}),
    ...own,
  }
}

/**
 * The one-line command that writes the pin into the harness's config file inside
 * the box, or "" when the template has no file route (env-only, `amp`, `base`, a
 * user's own template) or nothing is pinned. The command reads the variables
 * `modelEnv` set, so it is only useful on a box created with them.
 */
export function pinCommand(template, pin, harness = template) {
  if (!pin) return ""
  return FILE_ROUTES[String(harness ?? template ?? "")] ?? ""
}

/** For docs, the picker and the refusal message: what a pin can do per template. */
export function pinSupport(template) {
  const t = String(template ?? "")
  if (t === "claude") return { model: true, reasoning: true, route: "env" }
  if (t === "opencode") return { model: true, reasoning: false, route: "env" }
  if (t === "muse") return { model: false, reasoning: true, route: "file" }
  if (t in FILE_ROUTES) return { model: true, reasoning: true, route: "file" }
  return { model: false, reasoning: false, route: null }
}
