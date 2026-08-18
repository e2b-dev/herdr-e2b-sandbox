import { readFile, writeFile, mkdir, readdir, unlink, rename } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

// Keep this resolution IN SYNC with bin/lib/paths.sh and tui/src/main.rs so the
// writer (here), e2b-box, and the dashboard all agree on where records live.
const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  process.env.HERDR_E2B_STATE_DIR ||
  path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
    "herdr/plugins/herdr-e2b",
  )

export const BOXES_DIR = path.join(STATE_DIR, "boxes")

export function recordPath(key) {
  return path.join(BOXES_DIR, `${key}.json`)
}
export function logPath(key) {
  return path.join(BOXES_DIR, `${key}.log`)
}

export async function readRecord(key) {
  try {
    return JSON.parse(await readFile(recordPath(key), "utf8"))
  } catch {
    return null
  }
}

/**
 * Shallow-merge `patch` into the existing record and persist it atomically
 * (write temp + rename) so a concurrent reader — e.g. the e2b-box spinner
 * polling this file — never catches a half-written, unparseable file.
 */
export async function writeRecord(key, patch) {
  await mkdir(BOXES_DIR, { recursive: true })
  const prev = (await readRecord(key)) || {}
  const next = { ...prev, ...patch, key, updatedAt: new Date().toISOString() }
  const tmp = `${recordPath(key)}.tmp.${process.pid}`
  await writeFile(tmp, JSON.stringify(next, null, 2))
  await rename(tmp, recordPath(key))
  return next
}

export async function deleteRecord(key) {
  for (const p of [recordPath(key), logPath(key)]) {
    try {
      await unlink(p)
    } catch {
      // already gone
    }
  }
}

export async function listRecords() {
  try {
    const files = await readdir(BOXES_DIR)
    const out = []
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      const r = await readRecord(f.slice(0, -5))
      if (r) out.push(r)
    }
    return out
  } catch {
    return []
  }
}
