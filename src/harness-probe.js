// Spawns the probes and prints the report. The thin, impure half of harness
// detection — every decision it makes about what a probe MEANT lives next door in
// src/harnesses.js, which is pure and is where the tests are.
//
// Read-only by design: this file finds things out and formats them, and nothing in
// it opens a file for writing. Deciding what to KEEP and putting it on disk is
// src/harness-auth.js, which is the entry point bin/e2b-box runs — so the probe
// itself stays something that can be called from anywhere without wondering what it
// will change.
import { spawn } from "node:child_process"

import { HARNESSES, interpretProbe, readHarnessFile, remedyFor } from "./harnesses.js"

// A ceiling rather than a guess: ticket 07 has the installer calling this, and an
// installer that appears to stall is an installer people kill.
//
// Raised from three seconds when the table went from one harness to seven. Warm, the
// whole report lands in about two seconds — but four of these probes reach the
// network, and on a COLD machine (first run after an install, which is precisely when
// the installer calls this) fourteen spawns contending at once pushed codex, amp and
// droid past three seconds and printed `?` for three harnesses that work fine. A
// wrong answer is worse than a slower one, and the answer is only wrong in the
// direction that tells the user to go set a variable they already have.
export const PROBE_TIMEOUT_MS = 5000

/**
 * Run one command and hand back what happened. Never throws, never inherits a tty.
 *
 * Two properties here are not optional, and both come from observed behaviour rather
 * than caution:
 *
 *   · stdin is /dev/null. One shipped harness, with no credential, opens a browser
 *     and blocks on stdin forever. A timeout does not undo a browser that has already
 *     been opened, so the probe must never be ABLE to ask.
 *   · `shell: false`, so the binary is resolved on PATH by exec and not by the user's
 *     interactive shell. On a real machine two of these binaries were shell functions,
 *     and one of them strips the very variable this plugin is looking for — probing
 *     through the shell would have reported the opposite of the truth.
 */
export function runProbe(bin, args, { timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env,
      })
    } catch {
      resolve({ notFound: true })
      return
    }

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))

    child.on("error", (err) => resolve({ notFound: err.code === "ENOENT", stdout, stderr }))
    child.on("close", (status, signal) =>
      resolve({ status, stdout, stderr, timedOut: signal === "SIGKILL" }),
    )
  })
}

/**
 * The file tie-break: a probe that says "signed in" without saying HOW is not the
 * last word.
 *
 * Three harnesses answer that way while keeping a plain key in their own config
 * file. Codex names which credential it used, so its parse rule decides alone; amp
 * and prime do not, so the file has to be consulted before a row can be called
 * `no-key`. Separate from `interpretProbe` because that one is pure over a probe
 * RESULT and must stay runnable with no filesystem; separate from `probeHarness`
 * because that one spawns binaries and this needs testing without them.
 *
 * Only ever an upgrade, and only from `login`. A row that already resolved from the
 * environment keeps `env` — that is the surface the user controls most directly, and
 * relabelling it would misreport where a box's credential came from. A harness with
 * no reader is untouched, which is what keeps droid and claude out.
 *
 * @param {object} row              a row as interpretProbe returns it, plus `id`
 * @param {object} opts             { readFile }
 */
export function resolveFromFile(row, { readFile = readHarnessFile } = {}) {
  const h = HARNESSES[row.id]
  if (!h?.valueFile || row.state !== "no-key" || row.source !== "login") return row
  let value = null
  try {
    const text = readFile(h.valueFile.path)
    value = text == null ? null : h.valueFile.read(text)
  } catch {
    value = null // malformed is the same as absent — never a guess, never a throw
  }
  return value ? { ...row, state: "authenticated", source: "file" } : row
}

/**
 * Probe one harness: is the binary here, and what does its auth probe say.
 *
 * The version probe is what answers "installed" — a missing binary fails at spawn
 * with ENOENT, which is the spawn-probe rule ADR 0006 asks for and is why no
 * file-existence check appears anywhere in this file.
 */
export async function probeHarness(id, { timeoutMs = PROBE_TIMEOUT_MS, env = process.env, readFile = readHarnessFile } = {}) {
  const h = HARNESSES[id]
  if (!h) return { id, ...interpretProbe(id, { env }) }

  const version = await runProbe(h.bin, h.versionArgs, { timeoutMs, env })
  if (version.notFound) return { id, ...interpretProbe(id, { notFound: true, env }) }

  const auth = await runProbe(h.bin, h.authArgs, { timeoutMs, env })
  const row = resolveFromFile({ id, ...interpretProbe(id, { ...auth, env }) }, { readFile })
  // A borrowed session has a clock on it, and the report has to show it. Only the
  // EXPIRY is attached — never the payload, which is a live account credential and
  // has no business on a row that gets passed around and formatted.
  if (row.source === "session" && h.sessionFile) {
    const text = readFile(h.sessionFile.path)
    row.expires = (text == null ? null : h.sessionFile.read(text))?.expires ?? null
  }
  return row
}

/**
 * Every known harness at once. Concurrent because the table holds seven of these,
 * and seven sequential worst-cases is not a command anyone waits for.
 */
export async function probeAll({ timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  return Promise.all(Object.keys(HARNESSES).map((id) => probeHarness(id, { timeoutMs, env })))
}

/**
 * One line per harness. The states have to be told apart at a glance, so each gets
 * its own marker rather than a colour: `?` for unknown is the important one — it must
 * never be mistaken for a harness the user does not have.
 *
 * Rows are labelled by HARNESS, not by template. They are different nouns (CONTEXT.md)
 * and this command is reporting on what is installed here, not on what a box boots.
 */
export function formatRow(r) {
  const [mark, note] = describe(r)
  return `${mark} ${r.id.padEnd(10)} ${note}`
}

// What to tell the user to do about a row with no borrowable key. One rule, in the
// table, so this report and the write plan next door cannot disagree about it.
const remedy = (r) => remedyFor(r.id, r.hostVar)

/** "in 9 days" / "in 4 hours" / "expired". Coarse on purpose: the exact second a
 * borrowed session dies is not a thing anyone acts on, and a countdown that reads
 * like a precise promise invites treating it as one. */
export function untilExpiry(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now
  if (!Number.isFinite(ms)) return "expiry unknown"
  if (ms <= 0) return "expired"
  const hours = Math.floor(ms / 3600000)
  if (hours < 1) return "expires in under an hour"
  if (hours < 48) return `expires in ${hours} hour${hours === 1 ? "" : "s"}`
  return `expires in ${Math.floor(hours / 24)} days`
}

function describe(r) {
  if (r.state === "authenticated") {
    // A borrowed SESSION is not a key and must not read as one: it expires, and it
    // is the whole account rather than a scoped credential (ADR 0007). Saying when
    // it dies is the difference between a report and a promise.
    if (r.source === "session") {
      const when = r.expires ? untilExpiry(r.expires) : "expiry unknown"
      return when === "expired"
        ? ["[   ]", `signed in, but the borrowed session EXPIRED — sign in again, then re-run this command`]
        : ["[ok ]", `signed-in session (${when})`]
    }
    // A key with no local harness is still a key. The box needs the credential, not
    // the binary — so say the credential is usable and mention the absence as an
    // aside, rather than reporting the row as nothing.
    return r.installed
      ? ["[ok ]", `key found (${r.source})`]
      : ["[ok ]", `not installed here, but ${r.hostVar} is set — a box can still use it`]
  }
  if (!r.installed) return ["[ - ]", "not installed"]
  if (r.state === "unknown") return ["[ ? ]", `probe did not answer — ${remedy(r)} to be sure`]
  if (r.source === "login") {
    return ["[   ]", `signed in, but not a key this plugin can use — ${remedy(r)}`]
  }
  return ["[   ]", `no key — ${remedy(r)}`]
}

export function formatReport(rows) {
  const lines = rows.map(formatRow)
  const borrowable = rows.filter((r) => r.state === "authenticated").length
  lines.push("")
  // "can see", not "can borrow": whether a credential can actually be RECORDED is
  // the write plan's question, and one harness resolves authenticated from a
  // variable whose name cannot be known. Answering that question here made the two
  // halves of `e2b-box auth` contradict each other in the same screenful.
  lines.push(`${borrowable} of ${rows.length} harnesses have a credential this plugin can see.`)
  return lines.join("\n")
}
