// `e2b-box auth`: probe, show, ask once, write.
//
// src/harness-probe.js finds out what is here; this file decides what to KEEP and
// puts it on disk. The split is the same one the rest of the feature uses — the
// decisions are pure functions over probe results (`buildPlan`, `renderAuthToml`,
// `formatPlan`) and only `writeAuthFile` and the entry point below touch anything.
//
// The rule this file exists to enforce is ADR 0006's, and it is the one thing here
// worth getting right:
//
//   a value read out of a FILE      → stored, as a value
//   a value seen only in the SHELL  → the variable's NAME is stored, nothing else
//
// The second half is not caution. A key exported from a keychain-backed shell
// profile is already stored better than this plugin can store it, so writing the
// value down would be a downgrade performed for convenience. Forwarding those named
// variables at create time is ticket 04's job; here they only have to be recorded
// as names.
//
// The other half of the asymmetry is the confirmation. Findings are written; GAPS
// are printed and never prompted for. The paste happens in the user's own
// config.toml, which is what keeps "hand-written always wins" true rather than
// aspirational: auth.toml has exactly one writer, config.toml has exactly one
// editor, and they are not the same.
//
// Runnable directly, which is how bin/e2b-box calls it:
//   node src/harness-auth.js [--yes]
import { spawnSync } from "node:child_process"
import { createInterface } from "node:readline"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import TOML from "@iarna/toml"

import { AUTH_PATH, CONFIG_PATH } from "./config.js"
import { HARNESSES, readHarnessFile, remedyFor } from "./harnesses.js"
import { formatReport, probeAll, untilExpiry } from "./harness-probe.js"

// One reader for every documented path this feature touches — it lives in
// src/harnesses.js beside the paths themselves, so the probe and this write plan
// cannot drift apart about what "read a harness's own config file" means.
const readTextFile = readHarnessFile

/**
 * What a run of `e2b-box auth` would keep, and what it could not.
 *
 * Pure given `readText`, which is the only thing here that touches a disk — inject
 * it and every branch below is testable with no harness installed and no fixture
 * file, which is the machine CI runs on.
 *
 * @param {Array} rows        probe results, as src/harness-probe.js returns them
 * @param {object} opts       { readText }
 * @returns {{entries: Array, gaps: Array}}
 *   entries — what goes in the generated file: `value` (stored) or `forward` (named)
 *   gaps    — installed harnesses with nothing borrowable, and why
 */
export function buildPlan(rows, { readText = readTextFile } = {}) {
  const entries = []
  const gaps = []

  for (const r of rows) {
    const h = HARNESSES[r.id]
    if (!h) continue // a harness not in the table is not guessed at
    const gap = (why) => gaps.push({ id: r.id, template: h.template, installed: !!r.installed, hostVar: r.hostVar ?? h.hostVar, boxVar: h.boxVar, why })

    if (r.state !== "authenticated") {
      // Nothing to fix for a harness that is not here — the report already says so,
      // and a paste-block line for it would be noise pointing at a box that has no
      // agent to authenticate.
      if (!r.installed) continue
      gap(r.state === "unknown" ? "its probe did not answer" : "no credential this plugin may read")
      continue
    }

    if (r.source === "session") {
      // A subscription login, borrowed whole out of the file it already lives in
      // (ADR 0007). It differs from every other entry in two ways the rest of the
      // pipeline has to carry: it EXPIRES, and its refresh half is replaced by a
      // placeholder before it is written anywhere.
      const text = h.sessionFile ? readText(h.sessionFile.path) : null
      let session = null
      try {
        session = text == null ? null : h.sessionFile.read(text)
      } catch {
        session = null // malformed is the same as absent: report it, never guess
      }
      if (!session) {
        gap(`its session could not be read from ${h.sessionFile?.path || "a file"}`)
        continue
      }
      entries.push({
        id: r.id,
        template: h.template,
        kind: "session",
        boxVar: h.sessionFile.boxVar,
        value: session.value,
        expires: session.expires,
        from: h.sessionFile.path,
        // The key this session makes redundant. A box authenticated by the session
        // has no use for the API key as well, and an unused credential sitting in a
        // box's environment is blast radius bought for nothing — every process in
        // there can read it. Recorded by NAME so the resolver stays data-driven and
        // config.js does not have to import the harness table to know what to drop.
        supersedes: h.boxVar,
      })
      continue
    }

    if (r.source === "file") {
      // The value is already in plaintext in a file this user owns, so copying it
      // into another file this user owns is not a downgrade. Everything else is.
      const text = h.valueFile ? readText(h.valueFile.path) : null
      let value = null
      try {
        value = text == null ? null : h.valueFile.read(text)
      } catch {
        value = null // malformed is the same as absent: report it, never guess
      }
      if (!value) {
        gap(`its credential is in ${h.valueFile?.path || "a file"}, which could not be read`)
        continue
      }
      entries.push({ id: r.id, template: h.template, kind: "value", boxVar: h.boxVar, value, from: h.valueFile.path })
      continue
    }

    // source === "env" (or anything else that resolved authenticated): record the
    // NAME. No hostVar means no name to record — opencode resolves providers from a
    // registry of ~190 variables, and picking one would be the guess the plugin
    // promised not to make.
    const hostVar = r.hostVar || h.hostVar
    if (!hostVar) {
      gap("its credential has no single variable name to record")
      continue
    }
    entries.push({ id: r.id, template: h.template, kind: "forward", boxVar: h.boxVar, hostVar })
  }

  return { entries, gaps }
}

const HEADER = `# GENERATED by \`e2b-box auth\` — do not edit.
#
# Re-running that command rewrites this file from scratch; anything you type here
# is lost on the next run. Delete it to start over — nothing else reads it.
#
# It is merged UNDER your own config.toml, so a value you wrote by hand always
# wins over a value discovered here.
#
#   [templates.<t>.env]     a value, read out of a harness's own config file
#   [templates.<t>.session] a signed-in session borrowed from a harness's own file.
#                           Its \`supersedes\` names the API key it replaces, which is
#                           then NOT sent to the box at all: a credential the box
#                           cannot use is blast radius bought for nothing.
#                           It EXPIRES (see its \`expires\`), its single-use refresh
#                           token is replaced by an obvious placeholder so this copy
#                           can never revoke your login, and unlike everything else
#                           here it OUTRANKS your own [templates.<t>.env] — set
#                           \`prefer = "env"\` on that template to take it back.
#   [templates.<t>.forward] a variable NAME only. Its value stays in this machine's
#                           environment and is read there when a box is created —
#                           a key exported from a keychain-backed profile is
#                           already stored better than this file could store it.
`

/** The generated file's contents. Deterministic: the same discovery twice produces
 * the same bytes, so re-running is visibly a regeneration and not an accumulation. */
export function renderAuthToml(plan) {
  const templates = {}
  for (const e of plan.entries) {
    const t = (templates[e.template] ||= {})
    // Three sub-tables, one per kind, and `session` is its own rather than another
    // row in `env` because it carries an expiry and outranks the user's table
    // (ADR 0007). Folding it into `env` would lose both facts at the first read.
    if (e.kind === "session") {
      t.session = { var: e.boxVar, expires: e.expires, value: e.value }
      if (e.supersedes) t.session.supersedes = e.supersedes
    }
    else if (e.kind === "value") (t.env ||= {})[e.boxVar] = e.value
    else (t.forward ||= {})[e.boxVar] = e.hostVar
  }
  const body = Object.keys(templates).length ? TOML.stringify({ templates }) : ""
  return `${HEADER}${body ? `\n${body}` : "\n# Nothing borrowable was found on this machine.\n"}`
}

/**
 * What the user reads before answering. Two halves, and they are deliberately
 * different in kind: what will be WRITTEN, and what they can PASTE.
 *
 * Gaps print the box variable, not the host one — the paste goes into config.toml,
 * which configures a box. The report rows above print the host variable, because
 * that is what makes the next `e2b-box auth` find it. Both routes work and they are
 * not the same variable for three harnesses, so both are named rather than merged.
 */
export function formatPlan(plan, file = AUTH_PATH) {
  const out = []
  if (plan.entries.length) {
    out.push(`would write ${file}`)
    for (const e of plan.entries) {
      out.push(
        e.kind === "session"
          ? `  ${e.template.padEnd(10)} your signed-in session from ${e.from} — ${untilExpiry(e.expires)}; it beats [templates.${e.template}.env]${e.supersedes ? `, and ${e.supersedes} is then kept OUT of the box` : ""}`
          : e.kind === "value"
            ? `  ${e.template.padEnd(10)} ${e.boxVar} = the value in ${e.from}`
            : `  ${e.template.padEnd(10)} ${e.boxVar} = $${e.hostVar} from this shell, read at box-create time (not stored)`,
      )
    }
  } else {
    out.push(`nothing borrowable was found — ${file} would say so and hold no credentials`)
  }

  if (plan.gaps.length) {
    out.push("")
    out.push(`nothing to record for ${plan.gaps.map((g) => g.template).join(", ")} — fix any of`)
    out.push("these on this machine and re-run this command:")
    for (const g of plan.gaps) {
      // A gap is not always "no credential" — one harness is authenticated by a
      // variable whose name we cannot know, and saying "no credential" about a row
      // the table above marked `key found` would make the two halves of this output
      // contradict each other. The remedy comes from the table, so this line and the
      // report's own cannot drift into recommending different things.
      out.push(`  ${g.template.padEnd(10)} ${g.why} — ${remedyFor(g.id, g.hostVar)}`)
    }
    out.push("")
    out.push(`or set the box's own variable yourself in ${CONFIG_PATH}, which this command never touches:`)
    out.push("")
    for (const g of plan.gaps) {
      out.push(`  [templates.${g.template}.env]`)
      out.push(`  ${g.boxVar} = "…"`)
    }
  }
  return out.join("\n")
}

/**
 * Write it, at 0600, atomically, whatever was there before.
 *
 * Via a temp file and a rename for two reasons: a half-written credentials file is
 * worse than none, and `writeFileSync`'s mode is only applied when it CREATES the
 * file — an auth.toml left behind at 0644 by an older version would keep those
 * permissions forever otherwise.
 */
export function writeAuthFile(body, file = AUTH_PATH) {
  mkdirSync(path.dirname(file), { recursive: true })
  // Pid-suffixed like src/store.js's records: two `e2b-box auth` runs at once must
  // not hand each other a half-written temp file to rename.
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, body, { mode: 0o600 })
  // `mode` above is only honoured when writeFileSync CREATES the file, so a temp
  // left behind at 0644 by an interrupted run would carry those permissions
  // through the rename and onto the credentials file. Say it rather than assume it.
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return file
}

/** One question for the whole batch, never one per harness. Resolves false on
 * anything that is not a yes, including EOF — a closed stdin is not consent.
 *
 * The answer is resolved BEFORE the interface is closed, and this order is not
 * cosmetic: `rl.close()` emits `close` synchronously, so closing first lets the
 * EOF guard below settle the promise as a `no` and a typed `y` is thrown away. */
function confirm(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    rl.question(question, (answer) => {
      resolve(/^y(es)?$/i.test(answer.trim()))
      rl.close()
    })
    rl.on("close", () => resolve(false))
  })
}

/**
 * Which of these variable names a LOGIN SHELL cannot see.
 *
 * The asymmetry this exists for: herdr spawns plugin commands as `bash -lc`, which
 * reads ~/.profile and never a zsh rc. So a key exported from ~/.zshrc is visible to
 * `e2b-box auth` typed in a terminal and simply absent when herdr creates the box —
 * discovery reports `key found`, auth.toml records the name, and the box still opens
 * on a sign-in screen with nothing saying why. That is worse than never having found
 * it, because the report claims the opposite.
 *
 * Checked rather than guessed, so the warning cannot cry wolf at the majority whose
 * keys are in ~/.profile. One shell for the whole batch, and only NAMES cross the
 * boundary in either direction — the check asks whether each variable is set, never
 * what it holds, so no value is read back into this process or onto a command line.
 *
 * Any failure to run the shell answers "nothing is invisible": this is an advisory,
 * and an advisory that fires because a probe broke is noise.
 */
export function invisibleToLoginShell(names, { run = spawnSync } = {}) {
  const wanted = [...new Set(names)].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
  if (!wanted.length) return []
  const script = wanted.map((n) => `[ -n "\${${n}+x}" ] && echo ${n}`).join("; ")
  try {
    const r = run("bash", ["-lc", script], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
    if (r.error || typeof r.stdout !== "string") return []
    const seen = new Set(r.stdout.split("\n").map((l) => l.trim()).filter(Boolean))
    return wanted.filter((n) => !seen.has(n))
  } catch {
    return []
  }
}

/** The advisory itself, or "" when every forwarded name survives the trip. */
export function formatForwardWarning(plan, invisible) {
  if (!invisible.length) return ""
  const rows = plan.entries.filter((e) => e.kind === "forward" && invisible.includes(e.hostVar))
  if (!rows.length) return ""
  const out = [
    "",
    "warning: these were found in THIS shell but are invisible to a login shell,",
    "so a box herdr launches will not get them (herdr runs plugin commands as",
    "`bash -lc`, which reads ~/.profile and never a zsh rc):",
    "",
  ]
  for (const e of rows) out.push(`  ${e.template.padEnd(10)} $${e.hostVar}`)
  out.push("")
  out.push("fix either one, then re-run this command:")
  out.push("  · export them from ~/.profile instead of ~/.zshrc, or")
  out.push(`  · paste the box's own variable into ${CONFIG_PATH}, which always wins:`)
  out.push("")
  for (const e of rows) {
    out.push(`  [templates.${e.template}.env]`)
    out.push(`  ${e.boxVar} = "…"`)
  }
  return out.join("\n")
}

async function main(argv) {
  const yes = argv.includes("--yes") || argv.includes("-y")
  const unknown = argv.find((a) => a !== "--yes" && a !== "-y")
  if (unknown) {
    process.stderr.write(`e2b-box auth: unknown option '${unknown}' (only --yes, -y)\n`)
    return 2
  }

  const rows = await probeAll()
  const plan = buildPlan(rows)
  // Said at the moment the user is looking at the row it is about — the only moment
  // they can act on it without first debugging a box that came up unauthenticated.
  const warning = formatForwardWarning(
    plan,
    invisibleToLoginShell(plan.entries.filter((e) => e.kind === "forward").map((e) => e.hostVar)),
  )
  process.stdout.write(`${formatReport(rows)}\n\n${formatPlan(plan)}\n${warning ? `${warning}\n` : ""}`)

  // Not a terminal and no flag: report and stop. Guessing consent from a pipe is
  // how a scripted caller ends up with a file it never asked for — and the
  // installer, which is the caller that matters, passes --yes on purpose.
  if (!yes && !process.stdin.isTTY) {
    process.stdout.write(`\nnothing was written — this was not a terminal, so nothing was asked.\nre-run with --yes to write ${AUTH_PATH}.\n`)
    return 0
  }

  if (!yes && !(await confirm(`\nwrite ${AUTH_PATH}? [y/N] `))) {
    process.stdout.write("nothing was written.\n")
    return 0
  }

  writeAuthFile(renderAuthToml(plan), AUTH_PATH)
  process.stdout.write(`\nwrote ${AUTH_PATH} (mode 600). ${CONFIG_PATH} was not touched.\n`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await main(process.argv.slice(2))
}
