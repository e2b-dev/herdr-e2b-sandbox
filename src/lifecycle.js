// Pause / resume an E2B sandbox via the SDK, so the `e2b` CLI is only ever needed
// for the interactive shell (sandbox connect) — same rule as kill.js.
// Usage: node lifecycle.js <pause|resume> <key> <sandboxId> [domain]
//
// Pausing snapshots the sandbox (filesystem AND memory) and stops the billing
// clock; resuming brings the same sandbox id back with its processes intact.
// The domain comes from the box's record: a box lives on ONE cluster, and
// pausing against the wrong one reports "not found" while the real box keeps
// running and billing.
//
// This owns the record's status field for both verbs, so the dashboard shows
// `paused` / `ready` without a re-provision.
import { Sandbox } from "e2b"

import { loadConfig } from "./config.js"
import { sdkConn } from "./shared.js"
import { writeRecord } from "./store.js"

const [op, key, sid, domain] = process.argv.slice(2)
if (op !== "pause" && op !== "resume") {
  console.error("usage: lifecycle.js <pause|resume> <key> <sandboxId> [domain]")
  process.exit(2)
}
if (!key || !sid) {
  console.error(`${op}: need a box key and a sandbox id`)
  process.exit(2)
}

const cfg = loadConfig()
const conn = sdkConn(cfg, domain)

try {
  if (op === "pause") {
    // Snapshotting memory is slower than an ordinary API call — give it room
    // rather than failing a pause that was actually in flight.
    const paused = await Sandbox.pause(sid, { ...conn, requestTimeoutMs: 120_000 })
    await writeRecord(key, { status: "paused", step: "paused" })
    console.log(paused ? `paused ${sid}` : `${sid} was already paused`)
  } else {
    // connect() resumes a paused sandbox (there is no separate resume call) and
    // re-arms the idle timeout, exactly like provision.js's reconnect path.
    await Sandbox.connect(sid, { ...conn, timeoutMs: cfg.sandboxTimeoutMs })
    await writeRecord(key, { status: "ready", step: "ready" })
    console.log(`resumed ${sid}`)
  }
} catch (e) {
  const msg = (e && e.message) || String(e)
  if (/not\s*found|404/i.test(msg)) {
    // Killed, or idle-timed-out past its paused snapshot's lifetime. Say so on
    // the record — a stale `ready`/`paused` row is worse than an honest one.
    await writeRecord(key, { status: "failed", step: "sandbox gone — 'e2b-box open' recreates" })
    console.error(`${op} ${sid} failed: sandbox is gone — 'e2b-box open' recreates it`)
    process.exit(1)
  }
  console.error(`${op} ${sid} failed: ${msg}`)
  process.exit(1)
}
