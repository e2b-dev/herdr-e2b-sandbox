// Answer bin/e2b-box's two questions before it boots a NEW sandbox: is the
// template already decided for this branch, and what should the picker offer?
// Printing it from here keeps the rule-matching logic in ONE place (config.js)
// instead of reimplementing regex rules in bash.
//
// Usage: node resolve-template.js [branch]
//        node resolve-template.js --fleet
// Prints:  <decided|ask>\t<resolved template>
//          <candidate>            (one per line, resolved template first)
//
// `--fleet` answers a different question — which templates may be MEMBERS — so it
// drops the plain default and does not hoist anything: a roster is a set, nothing
// in it is "the one you'd have booted anyway", and the list stays in the order the
// user configured (which puts the agents they care about first).
import {
  loadConfig,
  resolveTemplate,
  templateRuleMatches,
  templateChoices,
  fleetTemplateChoices,
} from "./config.js"

const branch = process.argv[2] || ""

if (branch === "--fleet") {
  const cfg = loadConfig()
  process.stdout.write(`ask\t\n${fleetTemplateChoices(cfg).join("\n")}\n`)
  process.exit(0)
}

// `--known` answers a THIRD question: which names does this config RECOGNISE —
// not which it would offer. The two differ, and the difference is the whole point:
// a template configured only in `[fleet.agents]` or `[fleet.seeds]` (your own box,
// whose CLI is named something else) is a perfectly legal roster entry that was
// never meant to show up in a picker. e2b-fleet spell-checks a roster against
// this, so anything the config has an opinion about has to be in it.
if (branch === "--known") {
  const cfg = loadConfig()
  const known = new Set([
    ...templateChoices(cfg),
    ...Object.keys(cfg.fleetAgents || {}),
    ...Object.keys(cfg.fleetSeeds || {}),
  ])
  process.stdout.write(`${[...known].join("\n")}\n`)
  process.exit(0)
}
const cfg = loadConfig()
const resolved = resolveTemplate(branch, cfg)
// A rule match means the branch already names its agent (bench/cc/* → claude);
// stopping to ask there would be a keypress tax on a decision already made.
const decided = templateRuleMatches(branch, cfg) ? "decided" : "ask"

// The default leads the menu and the picker opens on it, so Enter is always the
// top row — "the one I'd have booted anyway" without reading the list first.
// Everything else keeps the order you configured.
const choices = [resolved, ...templateChoices(cfg).filter((t) => t !== resolved)]
process.stdout.write(`${decided}\t${resolved}\n${choices.join("\n")}\n`)
