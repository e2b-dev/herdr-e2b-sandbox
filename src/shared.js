import { spawn } from "node:child_process"
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
  const k = process.env.E2B_API_KEY?.trim() || cfg?.apiKey
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
