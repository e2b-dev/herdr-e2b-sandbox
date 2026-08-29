import { spawn } from "node:child_process"
import { Template } from "e2b"

import { CONFIG_PATH } from "./config.js"

/** True if a repo-relative path matches an ignore entry — by exact match, path
 * prefix (`p/`), or any path segment equal to `p`. Shared by upload + download so
 * both apply the SAME ignore rules. */
export function isIgnored(rel, ignore) {
  const segs = rel.split("/")
  return ignore.some((p) => rel === p || rel.startsWith(`${p}/`) || segs.includes(p))
}

// Resolve the E2B key from env, plugin config ([secrets].e2b_api_key), or the
// `e2b` CLI login — see resolveCredentials() in config.js for the precedence.
// Pass the loaded config so config-dir keys work without touching the env.
export function requireApiKey(cfg) {
  // `cfg.apiKey` is the RESOLVED key (resolveCredentials, config.js): env-wins in
  // a shell you typed in, config/CLI first under the herdr daemon, and key+domain
  // always taken as a pair. Reading process.env here again used to undo all of
  // that — a daemon-spawned pull with a stale or foreign E2B_API_KEY in its env
  // sent that key to the box's cluster and got `Invalid API key … Cannot get the
  // team`, while the resolver had already picked the right one.
  const k = cfg?.apiKey
  if (!k) {
    throw new Error(
      "No E2B API key. Run `e2b auth login`, or set [secrets].e2b_api_key in " +
        `${CONFIG_PATH}, or export E2B_API_KEY. ` +
        "Get a key at https://e2b.dev/dashboard.",
    )
  }
  return k
}

/**
 * SDK connection options for one box. `domain` is passed EXPLICITLY rather than
 * left to the SDK's ambient `E2B_DOMAIN` lookup: herdr's server is long-lived,
 * so whatever env it started with is frozen and goes stale the moment you switch
 * regions. Prefer the domain stored on the box record — a box stays on the
 * cluster that created it — and fall back to the freshly resolved one.
 */
export function sdkConn(cfg, domain) {
  const d = domain || cfg?.domain
  return { apiKey: requireApiKey(cfg), ...(d ? { domain: d } : {}) }
}

/**
 * True when a failed create means the template ISN'T THERE — the only case where
 * silently booting `base` instead is the right answer.
 *
 * Verified against juliett: every miss at create time reads
 * `404: template '<name>' not found`, whether the name is bare or namespaced.
 *
 * The negative guard is the part worth keeping. `Template.exists()` — unlike
 * `Sandbox.create()` — rejects a foreign namespace with
 * `400: namespace 'e2b' must match your team 'ondrejs-project'`, yet
 * `Sandbox.create("e2b/base")` boots that same template without complaint. So
 * that 400 means "this endpoint can't tell you", never "no such template", and
 * anything treating it as missing would downgrade a working box to `base`.
 */
export function isMissingTemplateError(msg) {
  const s = String(msg ?? "")
  if (/namespace .* must match your team/i.test(s)) return false
  return /template|not\s*found|404|does not exist/i.test(s)
}

/**
 * Ask whether a template is there BEFORE trying to boot it. Three answers:
 * `true` (it is), `false` (it is not), `null` (could not tell).
 *
 * `false` is the ONLY answer allowed to skip a create, and everything else
 * degrades to `null`, because this probe is stricter than the thing it stands in
 * for. Measured on juliett: `Template.exists("e2b/base")` raises
 * `400: namespace 'e2b' must match your team '…'` while `Sandbox.create("e2b/base")`
 * boots that very template. A probe that read its own failure as "missing" would
 * swap a working box for `base` — the exact harm it exists to prevent, caused by
 * itself. Same for a network blip or an expired key: those mean "ask create
 * instead", never "the template is missing".
 *
 * The probe is an optimisation, so it may only ever save a doomed create. It may
 * never cost a box that would have booted.
 *
 * `exists` is injectable so the three answers can be tested without a network.
 */
export async function probeTemplate(name, conn, exists = Template.exists) {
  try {
    const answer = await exists(name, conn)
    return answer === true ? true : answer === false ? false : null
  } catch {
    return null // could not tell — let `Sandbox.create` be the judge
  }
}

/** Print the credential-mismatch warning (if any) once, to stderr. */
export function warnCredentials(cfg) {
  if (cfg?.credWarning) process.stderr.write(`  ! ${cfg.credWarning}\n`)
}

/** Best-effort herdr desktop notification; never throws. */
export function notify(title, body) {
  try {
    const p = spawn("herdr", ["notification", "show", title, "--body", body], {
      stdio: "ignore",
      detached: true,
    })
    p.on("error", () => {})
    p.unref()
  } catch {
    // herdr not on PATH — fine.
  }
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all --no-renames` → the files a
 * pull has to look at, and the ones it can only report.
 *
 * With a baseline commit in the box (ADR 0012) this is the whole question: what
 * differs from what the laptop sent. Every entry is `XY<space><path>\0`, two status
 * letters then the path — index side then worktree side. Anything with a `D` on
 * either side is gone from the box, and a pull that writes files in place has no
 * business deleting a local one over that, so those are handed back separately for
 * the caller to say out loud. `--no-renames` is what makes the format this simple:
 * a rename would otherwise carry a second NUL-terminated path.
 *
 * Pure, and tested: this decides which local files a pull touches.
 *
 * @returns {{ changed: string[], deleted: string[] }}
 */
export function parseStatusZ(stdout) {
  const changed = []
  const deleted = []
  for (const entry of String(stdout ?? "").split("\0")) {
    if (entry.length < 4 || entry[2] !== " ") continue
    const xy = entry.slice(0, 2)
    const rel = entry.slice(3)
    if (!rel || rel.endsWith("/")) continue
    ;(xy.includes("D") ? deleted : changed).push(rel)
  }
  return { changed, deleted }
}
