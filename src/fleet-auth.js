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
import { credentialVars, harnessForTemplate, remedyFor, remedyVarFor } from "./harnesses.js"

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
    const resolved = resolveEnv(cfg, m.template, env)
    // A member is authenticated by EITHER variable. A borrowed session arrives under
    // its own name (`sessionFile.boxVar`) rather than the key's, so checking only
    // `boxVar` would warn about a member that comes up perfectly signed in — the
    // false alarm that teaches people to ignore this warning. An expired session
    // never reaches here: resolveEnv drops it, so the member correctly reads as
    // unauthenticated and gets named.
    // EVERY variable that would authenticate this member, not just the row's
    // primary one: claude accepts a Console key or a subscription token under two
    // different names, and a warning that only knew the first one told a properly
    // configured member it would start on a sign-in screen.
    //
    // Blank is missing. An empty credential is the failure that shows up furthest
    // from its cause — the agent boots, reads it and dies authenticating, which
    // reads as a broken key rather than an absent one.
    const boxVars = credentialVars(h).map((v) => v.boxVar)
    if (h.sessionFile) boxVars.push(h.sessionFile.boxVar)
    if (boxVars.some((v) => typeof resolved?.[v] === "string" && resolved[v].trim())) continue
    // The variable the remedy actually produces — the same one `e2b-box auth`'s own
    // gap block prints, so the two places a user is told what to set agree.
    gaps.push({ label: m.label, template: m.template, boxVar: remedyVarFor(h) })
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

/**
 * The note `e2b-box open` prints for ONE box, or "" when it has a credential.
 *
 * The fleet's warning exists because nobody is in front of a member. This one exists
 * for the opposite reason: somebody IS in front of it, and a sign-in screen in a
 * sandbox is still a dead end — the browser flow needs a browser, and the box has
 * none. Without this the first sign is the agent itself saying `Not logged in`,
 * minutes later, with nothing on screen connecting that to a variable this machine
 * never had.
 *
 * Same question as the fleet's, asked over one member: not "did `e2b-box auth` find
 * something" but "was this box handed anything", which is the only version of the
 * question whose answer is visible from outside the box.
 */
export function formatBoxAuthNote(template, cfg = {}, env = {}, file = CONFIG_PATH) {
  const [gap] = unauthenticatedMembers([{ template, label: String(template ?? "") }], cfg, env)
  if (!gap) return ""
  const h = harnessForTemplate(template)
  return [
    `  ! no credential in this box — ${template} will open on a sign-in screen it cannot finish here.`,
    `    ${remedyFor(h?.id)}, then \`e2b-box auth\`; or set ${gap.boxVar} in ${file}`,
  ].join("\n")
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
  // `--box <template>` is the single-box note bin/e2b-box prints on attach; without
  // it this reads a member plan off stdin, which is what bin/e2b-fleet wants.
  const boxAt = process.argv.indexOf("--box")
  if (boxAt !== -1) {
    if (cfg) process.stdout.write(formatBoxAuthNote(process.argv[boxAt + 1] || "", cfg, process.env))
    process.exit(0)
  }
  const members = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([template, , label]) => template && label)
    .map(([template, , label]) => ({ template, label }))
  if (cfg) process.stdout.write(formatFleetAuthWarning(unauthenticatedMembers(members, cfg, process.env)))
}
