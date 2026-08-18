// Pull the sandbox's project files back down into the local folder (reverse of the
// upload). git-aware in the sandbox (tracked + untracked, honors .gitignore), so
// build output/node_modules don't come back. Writes files in place; review the
// result with your local `git diff`.
//
// Usage: node download.js '{"key":"...","destRoot":"/abs/local/folder"}'
import { writeFile, readFile, mkdir, appendFile, lstat, realpath } from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import { posix } from "node:path"
import { fileURLToPath } from "node:url"
import { Sandbox } from "e2b"

import { loadConfig } from "./config.js"
import { sdkConn, isIgnored } from "./shared.js"
import { readRecord, logPath } from "./store.js"

/** A remote-relative path we must never write to: absolute, or escaping via `..`.
 * (The symlink/realpath containment check lives in safeDest, which needs the FS.) */
export function relIsUnsafe(rel) {
  return path.isAbsolute(rel) || rel.split("/").includes("..")
}

async function main({ key, destRoot }) {
  const cfg = loadConfig()
  const log = async (msg) => {
    try {
      await appendFile(logPath(key), `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
      // best effort
    }
  }

  const rec = await readRecord(key)
  if (!rec?.sandboxId) {
    console.error(`no sandbox for '${key}'`)
    process.exit(1)
  }
  const projectPath = rec.projectPath || "/home/user/project"
  // The box's own cluster, not whatever this shell currently resolves to.
  const sandbox = await Sandbox.connect(rec.sandboxId, {
    ...sdkConn(cfg, rec.domain),
    timeoutMs: cfg.sandboxTimeoutMs,
  })

  // List the sandbox's files (git-aware; fall back to find for a non-repo sandbox
  // dir). NUL-delimited so filenames with spaces/newlines survive (matches upload).
  const listed = await sandbox.commands.run(
    `cd '${projectPath}' && ` +
      "(git ls-files -z --cached --others --exclude-standard 2>/dev/null " +
      "|| find . -type f -not -path './.git/*' -printf '%P\\0')",
  )
  let files = listed.stdout
    .split("\0")
    .filter(Boolean)
    .filter((f) => !f.endsWith("/"))
    .filter((rel) => !isIgnored(rel, cfg.ignore))

  // Never write outside the worktree. Reject traversal, refuse to follow a
  // symlink at the destination, and verify the (real) parent dir stays inside
  // the worktree root — so a pre-existing local symlink can't redirect a write.
  const rootReal = await realpath(destRoot)
  async function safeDest(rel) {
    if (relIsUnsafe(rel)) return null
    const dest = path.join(destRoot, rel)
    try {
      if ((await lstat(dest)).isSymbolicLink()) return null // don't follow it
    } catch {
      // doesn't exist — fine
    }
    await mkdir(path.dirname(dest), { recursive: true })
    const parentReal = await realpath(path.dirname(dest))
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) return null
    return dest
  }

  // Classify each file against the local copy: new / overwritten / unchanged.
  // Only write what actually differs (so unchanged files aren't touched), and
  // report exactly what changed — the "message in case of overwrites".
  const added = []
  const overwritten = []
  const skipped = []
  let unchanged = 0
  const batchSize = cfg.batchSize > 0 ? cfg.batchSize : 40
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async (rel) => {
        const dest = await safeDest(rel)
        if (!dest) {
          skipped.push(rel)
          return // unsafe path (traversal / symlink) — never write it
        }
        const data = Buffer.from(await sandbox.files.read(posix.join(projectPath, rel), { format: "bytes" }))
        let local = null
        try {
          local = await readFile(dest)
        } catch {
          local = null // doesn't exist locally
        }
        if (local === null) {
          added.push(rel)
        } else if (!local.equals(data)) {
          overwritten.push(rel)
        } else {
          unchanged += 1
          return // identical — leave it alone
        }
        await writeFile(dest, data)
      }),
    )
  }

  added.sort()
  overwritten.sort()
  skipped.sort()
  for (const f of added) console.log(`  + ${f}  (new)`)
  for (const f of overwritten) console.log(`  ~ ${f}  (overwrote local)`)
  for (const f of skipped) console.log(`  ! ${f}  (skipped — unsafe path/symlink)`)
  const changed = added.length + overwritten.length
  console.log(
    changed === 0
      ? `nothing to pull — local already matches the sandbox (${unchanged} files)${skipped.length ? `, ${skipped.length} skipped` : ""}`
      : `pulled ${changed} file(s): ${added.length} new, ${overwritten.length} overwritten, ${unchanged} unchanged${skipped.length ? `, ${skipped.length} skipped` : ""}`,
  )
  await log(`pull: ${added.length} new, ${overwritten.length} overwritten, ${unchanged} unchanged, ${skipped.length} skipped → ${destRoot}`)
}

// Script entry — only when run directly (node download.js '<json>'), so tests can
// import the pure helpers (relIsUnsafe) above without triggering the CLI's argv
// parsing / process.exit. Realpath BOTH sides: Node realpath-resolves the main
// module, so comparing against a raw path.resolve would mismatch under a symlinked
// invocation path and silently turn this into a no-op.
let invokedDirectly = false
try {
  invokedDirectly =
    !!process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {
  invokedDirectly = false
}
if (invokedDirectly) {
  const input = JSON.parse(process.argv[2] || "{}")
  if (!input.key || !input.destRoot) {
    console.error("download: missing key/destRoot")
    process.exit(2)
  }
  main(input).catch((err) => {
    console.error((err && err.message) || String(err))
    process.exit(1)
  })
}
