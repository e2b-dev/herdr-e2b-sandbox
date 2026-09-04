// Pull the sandbox's project files back down into the local folder (reverse of the
// upload). git-aware in the sandbox (tracked + untracked, honors .gitignore), so
// build output/node_modules don't come back. Writes files in place; review the
// result with your local `git diff`.
//
// Usage: node download.js '{"key":"...","destRoot":"/abs/local/folder"}'
//        node download.js '{"key":"...","destRoot":"...","check":true}'
//   check: write nothing. Print, one per line, the files this pull WOULD overwrite
//          that also carry uncommitted local edits — the only way a pull loses work.
//          bin/e2b-box asks this before deciding whether a dirty tree needs a prompt.
import { writeFile, readFile, mkdir, appendFile, lstat, realpath } from "node:fs/promises"
import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import path from "node:path"
import { posix } from "node:path"
import { fileURLToPath } from "node:url"
import { Sandbox } from "e2b"

import { loadConfig } from "./config.js"
import { sdkConn, isIgnored, parseStatusZ } from "./shared.js"
import { readRecord, logPath } from "./store.js"

/** A remote-relative path we must never write to: absolute, or escaping via `..`.
 * (The symlink/realpath containment check lives in safeDest, which needs the FS.) */
export function relIsUnsafe(rel) {
  return path.isAbsolute(rel) || rel.split("/").includes("..")
}

// `parseStatusZ` lives in shared.js (upload.js reads the LOCAL status with it, pull
// the box's); re-exported so this stays its documented home for tests and readers.
export { parseStatusZ }

async function main({ key, destRoot, check = false }) {
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

  // Which files to look at. Two answers, and the box's git decides which applies:
  //
  //   baseline present — the upload was committed (ADR 0012), so `git status`
  //     against it IS the changed set: what the agent modified or added, .gitignore
  //     honored. Only those are read. Four files touched → four reads, not one per
  //     file in the repo — this is where a pull's time goes.
  //   no baseline — a box provisioned before the baseline existed, or a project dir
  //     that is not a repo. Fall back to listing everything and byte-comparing each
  //     file locally, exactly as before; slower, never wrong.
  //
  // NUL-delimited both ways so filenames with spaces/newlines survive (matches upload).
  // `commands.run` throws on a non-zero exit, so a missing HEAD (the `&&` chain
  // stops at rev-parse) lands in the catch and selects the full listing below.
  const status = await sandbox.commands
    .run(
      `cd '${projectPath}' && git rev-parse --verify -q HEAD >/dev/null 2>&1 && ` +
        "git status --porcelain=v1 -z --untracked-files=all --no-renames",
    )
    .catch(() => null)
  const viaStatus = status !== null
  let files
  let deleted = []
  if (viaStatus) {
    const parsed = parseStatusZ(status.stdout)
    files = parsed.changed
    deleted = parsed.deleted.filter((rel) => !isIgnored(rel, cfg.ignore))
  } else {
    const listed = await sandbox.commands.run(
      `cd '${projectPath}' && ` +
        "(git ls-files -z --cached --others --exclude-standard 2>/dev/null " +
        "|| find . -type f -not -path './.git/*' -printf '%P\\0')",
    )
    files = listed.stdout.split("\0").filter(Boolean)
  }
  files = files.filter((f) => !f.endsWith("/")).filter((rel) => !isIgnored(rel, cfg.ignore))

  // The precise question behind the clobber guard. "The tree is dirty" is the
  // coarse answer; the exact one is the intersection of what this pull would write
  // with what has uncommitted local edits — and only where the box's bytes actually
  // differ, since an identical file is never written. Names them and stops.
  if (check) {
    const dirty = new Set(await localDirty(destRoot))
    const atRisk = []
    for (const rel of files) {
      if (!dirty.has(rel) || relIsUnsafe(rel)) continue
      let data
      try {
        data = Buffer.from(await sandbox.files.read(posix.join(projectPath, rel), { format: "bytes" }))
      } catch {
        continue
      }
      let local = null
      try {
        local = await readFile(path.join(destRoot, rel))
      } catch {
        local = null
      }
      if (local === null || !local.equals(data)) atRisk.push(rel)
    }
    for (const rel of atRisk.sort()) console.log(rel)
    return
  }

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
        let data
        try {
          data = Buffer.from(await sandbox.files.read(posix.join(projectPath, rel), { format: "bytes" }))
        } catch {
          skipped.push(rel)
          return
        }
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
        try {
          await writeFile(dest, data)
        } catch {
          skipped.push(rel)
        }
      }),
    )
  }

  added.sort()
  overwritten.sort()
  skipped.sort()
  deleted.sort()
  for (const f of added) console.log(`  + ${f}  (new)`)
  for (const f of overwritten) console.log(`  ~ ${f}  (overwrote local)`)
  // Reported, never applied. Pull writes files in place and a delete is the one
  // write `git diff` cannot show you afterwards, so the box's deletions are named
  // here and left for you: `git rm` locally if the agent was right.
  for (const f of deleted) console.log(`  - ${f}  (deleted in sandbox — kept locally)`)
  for (const f of skipped) console.log(`  ! ${f}  (skipped — unsafe path/symlink)`)
  const changed = added.length + overwritten.length
  const tail =
    (deleted.length ? `, ${deleted.length} deleted in sandbox (kept)` : "") +
    (skipped.length ? `, ${skipped.length} skipped` : "")
  const how = viaStatus ? "changed since the baseline" : "every file, byte-compared"
  console.log(
    changed === 0
      ? `nothing to pull — local already matches the sandbox (${how}; ${unchanged} unchanged)${tail}`
      : `pulled ${changed} file(s): ${added.length} new, ${overwritten.length} overwritten, ${unchanged} unchanged (${how})${tail}`,
  )
  await log(
    `pull (${viaStatus ? "changed-set" : "full"}): ${added.length} new, ${overwritten.length} overwritten, ${unchanged} unchanged, ${deleted.length} deleted-in-box, ${skipped.length} skipped → ${destRoot}`,
  )
}

/** Paths with uncommitted local changes (modified, added, deleted, untracked). Empty
 * for a non-repo — the caller has already decided that case needs a prompt anyway. */
function localDirty(root) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([])
        const { changed, deleted } = parseStatusZ(stdout)
        resolve([...changed, ...deleted])
      },
    )
  })
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
  let input
  try {
    input = JSON.parse(process.argv[2] || "{}")
  } catch (err) {
    console.error(`download: invalid JSON payload: ${(err && err.message) || String(err)}`)
    process.exit(2)
  }
  if (!input || typeof input !== "object" || !input.key || !input.destRoot) {
    console.error("download: missing key/destRoot")
    process.exit(2)
  }
  main(input).catch((err) => {
    console.error((err && err.message) || String(err))
    process.exit(1)
  })
}
