// `node src/effort-cli.js --fleet | <template>...` — the pickers' effort rows, for bash.
//
// One `|`-separated row per template:
//   <template>|<kind>|<value,value,…>|<configured>|<via>|<model,model,…>|<configured model>
// `|` and not TAB because bash's `read` with IFS=tab folds an EMPTY field (no
// configured effort) into its neighbour; `|` is not whitespace, so fields stay put.
// The two model fields came later and sit LAST, so a reader of the five-field
// shape (`read -r t k v c via`) keeps working: bash hands the extras to `via`,
// which only ever decorates a generic row. Model ids carry `/` and `.` but never
// `,` or `|` (src/harness-catalog.generated.js is the corpus).
//
// A file of its own, not a CLI block in src/effort.js: config.js imports effort.js
// (for `harnessHint`), so effort.js loading config.js back is an import cycle that a
// top-level await never settles (Node 26: "unsettled top-level await", exit 13).
import { fleetTemplateChoices, loadConfig } from "./config.js"
import { effortRows } from "./effort.js"

const cfg = loadConfig()
const args = process.argv.slice(2)
const names = args[0] === "--fleet" ? fleetTemplateChoices(cfg) : args
for (const r of effortRows(names, cfg)) {
  process.stdout.write(`${r.template}|${r.kind}|${r.values.join(",")}|${r.configured}|${r.via}|${r.models.join(",")}|${r.model}\n`)
}
