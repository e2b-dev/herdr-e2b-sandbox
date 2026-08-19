// Which fleet members will come up on a sign-in screen, and what to set so they
// don't.
//
// A missing credential is merely annoying for `open` — the user is sitting in front
// of the box and can sign in. In a fleet it is a member that never starts work, and
// it is found out minutes later in a pane that is now stuck: a fleet member's whole
// point is that it works without a human at it, and a sign-in prompt is the one
// question it cannot answer for itself.
//
// So the fleet warns, names what is affected, and launches — the shape ADR 0003
// already set for launching off a dirty worktree. Refusing was rejected there as too
// rigid and is rejected here for the same reason: the user may be about to configure
// that credential, or may not care about that member.
//
// NO PROBE. This reads config and nothing else. `e2b-box auth` is a deliberate,
// explicit subcommand precisely so that nothing spawns a harness binary on the
// box-creation path, and a fleet creates several boxes at once.
//
// Also runnable as bin/e2b-fleet's warning helper (see the CLI at the bottom):
//   printf '<template>\t<branch>\t<label>\n' | node src/fleet-auth.js
import path from "node:path"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { CONFIG_PATH, loadConfig, resolveEnv } from "./config.js"
import { harnessForTemplate } from "./harnesses.js"

/**
 * The members of `members` whose box will boot with no credential in it.
 *
 * The question asked is deliberately the LAST one rather than the first: not "did
 * `e2b-box auth` find something for this template" but "will `Sandbox.create` be
 * handed this template's box variable" — which is `resolveEnv`, the whole four-rung
 * ladder. A member the user configured by hand in `[templates.<t>.env]` is
 * authenticated, and warning about it would be printing its own remedy back at
 * somebody who has already taken it.
 *
 * A template no harness row claims yields nothing: `base` needs no credential, and
 * a template of the user's own has no variable this plugin could name.
 *
 * Pure — `cfg` is a loaded config and `env` is the environment forwarded names
 * resolve from, passed in rather than read off `process` for the same reason
 * `resolveEnv` takes it.
 *
 * @param {Array<{template: string, label: string}>} members  the roster, named
 * @param {object} cfg                                        loadConfig()'s result
 * @param {object} env                                        process.env, injected
 * @returns {Array<{label: string, template: string, boxVar: string}>}
 */
export function unauthenticatedMembers(members = [], cfg = {}, env = {}) {
  const gaps = []
  const agents = cfg?.fleetAgents || {}
  for (const m of members) {
    const h = harnessForTemplate(m?.template)
    if (!h?.boxVar) continue
    // A control arm has nothing to authenticate. `[fleet.agents] <t> = ""` is the
    // deliberate "this member is a plain shell", and a shell never sees a sign-in
    // screen. Looked up by KEY PRESENCE for the same reason bin/e2b-fleet and
    // src/fleet-seed.js do: an unmapped template runs an agent named after itself,
    // so falling back on truthiness would silence every member instead of this one.
    // Exactly empty, not trimmed-empty: bin/e2b-fleet gates the same value on
    // `[ -n "$agent_cmd" ]`, so a template mapped to " " DOES get something typed at
    // it, and a member this file called agentless while the fleet starts an agent in
    // it would be the one member nobody warned about.
    if (Object.prototype.hasOwnProperty.call(agents, m.template) && String(agents[m.template] ?? "") === "") {
      continue
    }
    const value = resolveEnv(cfg, m.template, env)?.[h.boxVar]
    // Blank is missing. An empty credential is the failure that shows up furthest
    // from its cause — the agent boots, reads it and dies authenticating, which
    // reads as a broken key rather than an absent one.
    if (typeof value === "string" && value.trim()) continue
    gaps.push({ label: m.label, template: m.template, boxVar: h.boxVar })
  }
  return gaps
}

/**
 * One warning for the whole roster, or "" when there is nothing to say.
 *
 * One block and not one line per member: a fleet is a batch, and N separate
 * warnings scrolling past is how a roster of seven becomes something nobody reads.
 *
 * The paste block at the end is the `auth` report's own, deliberately — that is the
 * remedy which needs no lookup and no re-run, and it goes in the file this plugin
 * never writes to. `e2b-box auth` is named first because it is the shorter fix when
 * the credential is already on this machine.
 */
export function formatFleetAuthWarning(gaps = [], file = CONFIG_PATH) {
  if (!gaps.length) return ""
  const unit = gaps.length === 1 ? "member" : "members"
  const w = Math.max(...gaps.map((g) => g.label.length))
  const t = Math.max(...gaps.map((g) => g.template.length))

  const out = [
    `⚠️  ${gaps.length} ${unit} will start unauthenticated — the agent opens on a sign-in`,
    "    screen, and a fleet member has nobody in front of it to answer one:",
    "",
  ]
  for (const g of gaps) out.push(`      ${g.label.padEnd(w)}  ${g.template.padEnd(t)}  ${g.boxVar}`)
  out.push("")
  out.push("    `e2b-box auth` borrows a credential from this machine, or set the box's")
  out.push(`    own variable yourself in ${file}:`)
  for (const g of gaps) {
    out.push("")
    out.push(`      [templates.${g.template}.env]`)
    out.push(`      ${g.boxVar} = "…"`)
  }
  out.push("")
  // Tense-neutral on purpose: the same block is printed by `--dry-run`, where
  // nothing is launching. What it has to say either way is that this is not a gate.
  out.push("    this is a warning, not a refusal — the fleet launches as asked.")
  return out.join("\n")
}

// --- CLI ---------------------------------------------------------------------
// bin/e2b-fleet asks for the warning rather than composing it, so the harness table
// stays out of bash and `node --test` can execute the wording.
//
// Reads the member plan src/fleet-name.js already produced — one `<template>\t
// <branch>\t<label>` line per member — off stdin, and prints the warning (empty
// output = nothing to warn about). A config it cannot read is no warning rather than
// a refusal, the same rule src/fleet-seed.js follows: a warning that could take a
// fleet down would be worse than the thing it warns about. bin/e2b-fleet reads only
// this process's stdout, so nothing it can do here stops the fleet either way.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let cfg = null
  try {
    cfg = loadConfig()
  } catch {
    // An unreadable config is not a warning, and least of all a refusal — the same
    // rule src/fleet-seed.js follows when it cannot read `[fleet.seed]`.
  }
  const members = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([template, , label]) => template && label)
    .map(([template, , label]) => ({ template, label }))
  if (cfg) process.stdout.write(formatFleetAuthWarning(unauthenticatedMembers(members, cfg, process.env)))
}
