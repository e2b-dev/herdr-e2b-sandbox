// The plugin's own terminal client: attach this pane to a tracked box's shell.
// Usage: node attach.js <key>       (needs a real TTY on stdin/stdout)
//
// This replaces `e2b sandbox connect` in `connect_shell` (ADR-0008). The E2B
// CLI always creates a brand-new PTY and offers no way back to an existing one,
// which is the limitation the in-box tmux existed to work around; owning the
// client is what makes reattaching to a paused box's terminal possible at all.
// It is also the plugin's first long-lived TTY-owning process — everything else
// in src/ prints JSON and exits — which is why the TTY guards in bin/e2b-box
// stay exactly where they are.
//
// The terminal is stamped at creation with HERDR_E2B_TERMINAL=<box key>, so it
// is identifiable from inside the box (`env`) and — via `commands.list()`'s
// ProcessInfo.envs — verifiable from outside before any future reattach: a bare
// pid is not proof of anything, because pids get recycled. The record remembers
// the pid as `terminalPid`.
//
// Exit codes are the contract with connect_shell — they replace the two-second
// stopwatch that used to GUESS "never attached" from how fast the CLI died:
//   0   clean exit — the shell ended because you ended it (exit / Ctrl-D)
//   10  never attached — the caller should reprovision and retry
//   11  the box is gone (killed / expired) — nothing to attach to
//   12  attached, then lost underneath you — it paused or hit its idle timeout
// These are internal to connect_shell; e2b-box's external exit codes don't change.
import { Sandbox, NotFoundError, CommandExitError } from "e2b"

import { loadConfig } from "./config.js"
import { sdkConn, warnCredentials } from "./shared.js"
import { readRecord, writeRecord } from "./store.js"

const NEVER_ATTACHED = 10
const BOX_GONE = 11
const LOST = 12

const key = process.argv[2]
if (!key) {
  process.stderr.write("attach.js: need a box key\n")
  process.exit(NEVER_ATTACHED)
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  // A raw-mode passthrough without a terminal has nothing to be raw ON. The
  // control plane guards this already; failing the same way keeps the contract.
  process.stderr.write("attach.js: needs an interactive terminal\n")
  process.exit(NEVER_ATTACHED)
}

const rec = await readRecord(key)
if (!rec?.sandboxId) {
  process.stderr.write(`attach.js: no sandbox tracked for '${key}'\n`)
  process.exit(NEVER_ATTACHED)
}

const cfg = loadConfig()
warnCredentials(cfg)
// The box's own cluster, never the ambient one — same rule as every other verb.
const conn = sdkConn(cfg, rec.domain)

let sandbox
try {
  // connect() re-arms the idle timeout and auto-resumes a paused box on its own,
  // so this attempt IS the liveness check the control plane relies on.
  sandbox = await Sandbox.connect(rec.sandboxId, { ...conn, timeoutMs: cfg.sandboxTimeoutMs })
} catch (e) {
  if (e instanceof NotFoundError) {
    process.stderr.write(`attach.js: sandbox ${rec.sandboxId} is gone\n`)
    process.exit(BOX_GONE)
  }
  // Transient (network / auth / rate-limit): we never attached, and the caller
  // may retry through the provisioning path, which knows how to reconnect.
  process.stderr.write(`attach.js: ${e?.message || e}\n`)
  process.exit(NEVER_ATTACHED)
}

const dims = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })

let handle
try {
  handle = await sandbox.pty.create({
    ...dims(),
    // 0 = the PTY has no lifetime of its own (the default reaps it after 60s).
    // Its shell must outlive this client — surviving a pause is the point.
    timeoutMs: 0,
    envs: { HERDR_E2B_TERMINAL: key },
    // Land in the project dir; the sourced ~/.herdr-e2b.sh cd's there too, but
    // the PTY's own cwd shouldn't depend on shell personalization having run.
    ...(rec.projectPath ? { cwd: rec.projectPath } : {}),
    onData: (data) => process.stdout.write(data),
  })
} catch (e) {
  process.stderr.write(`attach.js: couldn't open a terminal: ${e?.message || e}\n`)
  process.exit(NEVER_ATTACHED)
}

// The record remembers which terminal is the box's. Written after create so a
// failed create can't leave a pid on record that never existed.
await writeRecord(key, { terminalPid: handle.pid })

// Raw mode: every byte — including modified Enter (^[[13;2u and friends), ^C,
// ^Z — belongs to the box, not to this client. This is the property the in-box
// tmux could not offer: nothing between the keyboard and the agent re-encodes.
process.stdin.setRawMode(true)
process.stdin.resume()

// Keystrokes are sent one round-trip each (exactly what the E2B CLI did), and
// strictly in order: a chain, not a fan-out, so two quick keys can't race each
// other on the wire. Send failures are left for wait() to classify — a dying
// stream will end the session with the honest outcome either way.
let sendQ = Promise.resolve()
process.stdin.on("data", (data) => {
  sendQ = sendQ.then(() => sandbox.pty.sendInput(handle.pid, data)).catch(() => {})
})

// The pane resized → the box's terminal follows. The SIGWINCH this delivers is
// also what makes full-screen agents redraw.
process.stdout.on("resize", () => {
  sandbox.pty.resize(handle.pid, dims()).catch(() => {})
})

let code = 0
try {
  await handle.wait()
} catch (e) {
  // The shell exiting non-zero is still YOU closing the session — the close
  // prompt should follow, same as after a clean `exit`. Anything else means the
  // stream died under a session that was live: paused, timed out, or killed.
  code = e instanceof CommandExitError ? 0 : LOST
}

process.stdin.setRawMode(false)
process.stdin.pause()
await handle.disconnect().catch(() => {})
process.exit(code)
