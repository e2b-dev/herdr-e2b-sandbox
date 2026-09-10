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
//   node src/fleet-name.js <task-slug> <member-spec>...   (spec: template[:model][*N][@effort])
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
/**
 * One label per member. The same template N times is N INSTANCES and gets numbered
 * labels (`t-21-codex`, `t-21-codex-2`, `t-21-codex-3`) — the roster table's count
 * column and a repeated `-t codex` both mean "more of this one". Two DIFFERENT
 * templates that collapse to one label (`a/claude` and `b/claude`) are still a
 * refusal: numbering would hide which member is which.
 */
export function memberLabels(slug, templates) {
  const claimedBy = new Map() // base label -> the template that claimed it
  const counts = new Map() // base label -> instances seen so far
  const out = []
  for (const t of templates) {
    const label = memberLabel(slug, t)
    const claimed = claimedBy.get(label)
    if (claimed !== undefined && claimed !== t) {
      throw new Error(
        `templates ${JSON.stringify(claimed)} and ${JSON.stringify(t)} both name a member ` +
          `'${label}' — a roster can't hold two members with the same name. ` +
          "Drop one, or pick templates whose names differ after the last '/'.",
      )
    }
    claimedBy.set(label, t)
    const n = (counts.get(label) ?? 0) + 1
    counts.set(label, n)
    out.push(n === 1 ? label : `${label}-${n}`)
  }
  return out
}

/**
 * A member spec, the way `-t` and `--agents` take it: `template`, `template*3`,
 * `template@xhigh`, `template*3@xhigh` — N instances, each at that effort;
 * `template:model` pins the model the same way. Returns one `{ template, effort,
 * model }` per instance; effort and model are "" when the spec names none
 * (the template's `[templates.<name>] reasoning` pin, or the harness default, applies).
 * A count that is not 1..20 is refused: a typo should not boot twenty boxes.
 */
export function expandMemberSpec(spec) {
  // `:model` sits right after the template: a model id carries `/` and `.`
  // (`prime-inference/anthropic/claude-fable-5`) but never `:`, `*` or `@`, and a
  // template name never carries `:`, so the four parts cannot be confused.
  const m = /^(.*?)(?::([^:*@\s]+))?(?:\*(\d+))?(?:@([A-Za-z][A-Za-z0-9_-]*))?$/.exec(String(spec ?? "").trim())
  const template = m?.[1]?.trim() ?? ""
  if (!m || !template) throw new Error(`member spec ${JSON.stringify(String(spec ?? ""))} names no template`)
  const count = m[3] === undefined ? 1 : Number(m[3])
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error(`member spec ${JSON.stringify(spec)}: the count after '*' must be 1..20`)
  }
  return Array.from({ length: count }, () => ({ template, effort: m[4] ?? "", model: m[2] ?? "" }))
}

/** Every spec expanded, in order: the roster as a list of members. */
export function expandMemberSpecs(specs) {
  return specs.flatMap(expandMemberSpec)
}

/** `<prefix>/<slug>-<template>-<rand4>` — the branch one member is created on. */
export function memberBranch(slug, template, { prefix = DEFAULT_PREFIX, rand, env = process.env, label } = {}) {
  // `label` is the numbered one for a 2nd+ instance (`t-21-codex-2`), so instances
  // of one template never share a branch even when the suffix is pinned.
  return `${sanitizePrefix(prefix)}/${label ?? memberLabel(slug, template)}-${rand ?? randomSuffix(env)}`
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
  // Args are member SPECS (`codex:gpt-5.5*3@ultra`); one row per instance:
  //   <template>\t<branch>\t<label>\t<effort>\t<model>
  // An absent effort or model is written as `-`, never left empty: bash's `read`
  // with a tab IFS folds an empty middle field into its neighbour, and a member
  // with a model and no effort would come back with the model AS its effort.
  const [slug, ...specs] = process.argv.slice(2)
  const cfg = loadConfig()
  try {
    if (!specs.length) throw new Error("no templates given")
    const members = expandMemberSpecs(specs)
    // Labels first, for the whole roster: a collision is a property of the SET,
    // so it has to be found before any member's branch is handed back — bash
    // creates worktrees from these rows as it reads them.
    const labels = memberLabels(slug, members.map((m) => m.template))
    const rows = members.map((m, i) => {
      const branch = memberBranch(slug, m.template, { prefix: cfg.fleetPrefix, label: labels[i] })
      return `${m.template}\t${branch}\t${labels[i]}\t${m.effort || "-"}\t${m.model || "-"}`
    })
    // memberBranch has already refused an unusable slug by here.
    process.stdout.write(`${cfg.fleetBase}\t${sanitizeSlug(slug)}\n${rows.join("\n")}\n`)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exit(2)
  }
}
