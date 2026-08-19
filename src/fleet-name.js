// Names for fleet members: the branch each member sits on, and the label its
// workspace wears.
//
// This is JavaScript and not bash on purpose. A fleet keeps no state (ADR-0001),
// so `<prefix>/<task-slug>-` IS the fleet's identity — every fleet-wide operation
// later globs on it. That makes ref-name sanitizing load-bearing, and a ref
// sanitizer in bash is the classic source of a bug that only shows up when a slug
// contains a slash. Pure functions here, `node --test` in test/fleet-name.test.js.
//
// Also runnable as bin/e2b-fleet's naming helper (see the CLI at the bottom):
//   node src/fleet-name.js <task-slug> <template>...
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "./config.js"

/** Longest a sanitized task slug may be. Long enough to stay readable in
 * `git branch`, short enough that the branch still fits a sidebar row. */
export const SLUG_MAX = 32

/** Environment override for the random suffix, so tests (and the dry run) can
 * assert exact branch names instead of matching a pattern. */
export const RAND_ENV = "HERDR_E2B_FLEET_RAND"

const RAND_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const RAND_LEN = 4
const DEFAULT_PREFIX = "e2b"

/**
 * Fold any human-typed text into one legal git ref component: lowercase,
 * `[a-z0-9]` only, single `-` between runs, none at either end, capped.
 * Everything git rejects (`~^:?*[\`, spaces, `..`, `@{`, a `.lock` suffix) is a
 * separator, so the result is legal by construction rather than by blocklist.
 * Returns "" when nothing usable survives — callers must treat that as a refusal.
 */
export function sanitizeSlug(raw, { max = SLUG_MAX } = {}) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // illegal chars AND separator runs, in one pass
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "") // the cap may have landed mid-separator
}

/** A prefix may be namespaced (`team/fleet`), so each component is sanitized and
 * empty ones are dropped; nothing usable falls back to the documented default. */
function sanitizePrefix(raw) {
  const parts = String(raw ?? "")
    .split("/")
    .map((p) => sanitizeSlug(p))
    .filter(Boolean)
  return parts.length ? parts.join("/") : DEFAULT_PREFIX
}

/**
 * The per-member suffix that keeps two runs of the same fleet from colliding.
 * Random for collision avoidance, not for secrecy — `$HERDR_E2B_FLEET_RAND`
 * pins it (filtered to the same alphabet; empty or junk-only means "no override").
 */
export function randomSuffix(env = process.env) {
  const forced = String(env?.[RAND_ENV] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  if (forced) return forced
  let out = ""
  for (let i = 0; i < RAND_LEN; i++) {
    out += RAND_ALPHABET[Math.floor(Math.random() * RAND_ALPHABET.length)]
  }
  return out
}

/**
 * The part of a template name that identifies it to a HUMAN: the last path
 * segment. `ondrejs-project/herdr-agents` -> `herdr-agents`.
 *
 * E2B namespaces a project's own templates as `<project>/<template>`, and every
 * member of one fleet carries the same project — so the prefix distinguishes
 * nothing here while costing a sidebar row its readability. Dropping it can make
 * two DIFFERENT templates share a label; that is a roster error, caught where a
 * roster exists (the CLI below), not silently disambiguated here.
 *
 * Returns "" when nothing usable survives, on the same contract as sanitizeSlug.
 */
export function templateSlug(template) {
  const segs = String(template ?? "")
    .split("/")
    .filter(Boolean)
  return sanitizeSlug(segs.length ? segs[segs.length - 1] : "")
}

/** `<slug>-<template>` — what the member's workspace is labelled, and later what
 * its agent is renamed to. Throws on an unusable slug or template. */
export function memberLabel(slug, template) {
  const s = sanitizeSlug(slug)
  if (!s) throw new Error(`task slug ${JSON.stringify(String(slug ?? ""))} has no usable characters`)
  const t = templateSlug(template)
  if (!t) throw new Error(`template ${JSON.stringify(String(template ?? ""))} has no usable characters`)
  return `${s}-${t}`
}

/**
 * One label per roster entry, in the order given — and a refusal when two entries
 * produce the same one.
 *
 * The roster already treats the same template twice as one member, not two. This
 * is that rule where the names, not the strings, are what match: `ondrejs-project/amp`
 * and `mpp/amp` are different templates that both label a member `<slug>-amp`.
 * Two workspaces wearing one name is worse than an error, because nothing on
 * screen says which is which and a fleet is read per member.
 */
export function memberLabels(slug, templates) {
  const seen = new Map() // label -> the template that claimed it
  const out = []
  for (const t of templates) {
    const label = memberLabel(slug, t)
    const claimed = seen.get(label)
    if (claimed !== undefined) {
      throw new Error(
        `templates ${JSON.stringify(claimed)} and ${JSON.stringify(t)} both name a member ` +
          `'${label}' — a roster can't hold two members with the same name. ` +
          "Drop one, or pick templates whose names differ after the last '/'.",
      )
    }
    seen.set(label, t)
    out.push(label)
  }
  return out
}

/** `<prefix>/<slug>-<template>-<rand4>` — the branch one member is created on. */
export function memberBranch(slug, template, { prefix = DEFAULT_PREFIX, rand, env = process.env } = {}) {
  return `${sanitizePrefix(prefix)}/${memberLabel(slug, template)}-${rand ?? randomSuffix(env)}`
}

// --- CLI ---------------------------------------------------------------------
// bin/e2b-fleet asks for the names rather than building them itself, so the
// sanitizing rules exist once. Line 1 is the header, then one row per member:
//
//   <configured [fleet] base>\t<sanitized slug>   (base "" = the caller's HEAD)
//   <template>\t<branch>\t<label>
//
// Exits 2 with a message on stderr when a name can't be built.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [slug, ...templates] = process.argv.slice(2)
  const cfg = loadConfig()
  try {
    if (!templates.length) throw new Error("no templates given")
    // Labels first, for the whole roster: a collision is a property of the SET,
    // so it has to be found before any member's branch is handed back — bash
    // creates worktrees from these rows as it reads them.
    const labels = memberLabels(slug, templates)
    const rows = templates.map((t, i) => {
      const branch = memberBranch(slug, t, { prefix: cfg.fleetPrefix })
      return `${t}\t${branch}\t${labels[i]}`
    })
    // memberBranch has already refused an unusable slug by here.
    process.stdout.write(`${cfg.fleetBase}\t${sanitizeSlug(slug)}\n${rows.join("\n")}\n`)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exit(2)
  }
}
