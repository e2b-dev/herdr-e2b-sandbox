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

import { planAttach, TERMINAL_MARKER } from "./attach-plan.js"
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// One-line notices about which terminal you're getting. The dashboard owns its
// own chrome, so it gets none of them — same rule as connect_shell's banner.
const say = (line) => {
  if (process.env.E2B_DASH !== "1") process.stdout.write(`${line}\n`)
}
const onData = (data) => process.stdout.write(data)

// Attach or create? Decided over data (src/attach-plan.js), not here: the
// listing is fetched only when a terminal is on record at all. A listing that
// can't be fetched reads as an empty one — creating a fresh terminal when the
// old one might have been fine is recoverable; attaching unverified is not.
const pane = dims()
let plan = { action: "create", reason: "none" }
if (rec.terminalPid) {
  const procs = await sandbox.commands.list().catch(() => [])
  plan = planAttach(rec, procs, pane, key)
}

let handle
if (plan.action === "attach") {
  // Say it before the frame lands: what comes back below is the CURRENT frame —
  // the scrollback above it was never stored anywhere, and a fake would have
  // holes exactly where the box worked unattended.
  say("  ⟳ reattaching to the terminal you left — its current frame comes back; the scrollback above it does not.")
  try {
    handle = await sandbox.pty.connect(plan.pid, { onData, timeoutMs: 0 })
  } catch {
    // The terminal died between the listing and the connect — the same loss as
    // finding it absent, so fall through to the same answer.
    plan = { action: "create", reason: "died" }
  }
  if (handle) {
    // The repaint nudge: a reattach alone produces zero bytes, ever. Each
    // resize delivers one SIGWINCH; full-screen programs redraw their frame in
    // response (research q4/q8: one signal, one complete frame). The
    // away-and-back pair (geometry unchanged) needs a beat between the two, or
    // a program that only samples its final size would see nothing change and
    // skip the repaint.
    //
    // Best-effort ON PURPOSE: we are attached — the one terminal this box has —
    // and a failed nudge is a missing repaint, not a lost terminal. Falling
    // back to create here would abandon a live subscription (its onData keeps
    // streaming) and stand up a SECOND terminal beside a possibly healthy one.
    // A blank frame self-heals: the next pane resize retries, and if the
    // stream really died, wait() below reports it as attached-then-lost.
    try {
      for (const [i, size] of plan.resize.entries()) {
        if (i > 0) await sleep(500)
        await sandbox.pty.resize(plan.pid, size)
      }
    } catch {
      // nothing — see above
    }
  }
}

if (!handle) {
  if (plan.reason !== "none") {
    // There WAS a terminal and this isn't it — say so, or a fresh shell where
    // an agent used to be reads as the agent having vanished.
    say(
      plan.reason === "recycled"
        ? "  ✚ the terminal on record isn't this box's own anymore (its pid was recycled) — starting a fresh one."
        : "  ✚ the terminal you left is gone — starting a fresh one.",
    )
  }
  try {
    handle = await sandbox.pty.create({
      ...pane,
      // 0 = the PTY has no lifetime of its own (the default reaps it after 60s).
      // Its shell must outlive this client — surviving a pause is the point.
      timeoutMs: 0,
      envs: { [TERMINAL_MARKER]: key },
      // Land in the project dir; the sourced ~/.herdr-e2b.sh cd's there too, but
      // the PTY's own cwd shouldn't depend on shell personalization having run.
      ...(rec.projectPath ? { cwd: rec.projectPath } : {}),
      onData,
    })
  } catch (e) {
    process.stderr.write(`attach.js: couldn't open a terminal: ${e?.message || e}\n`)
    process.exit(NEVER_ATTACHED)
  }
}

// The record remembers which terminal is the box's, and at what size it was
// last drawn — the size is what lets the next reattach pick the one-resize or
// away-and-back nudge. Written after create/attach so a failure can't leave a
// pid on record that never carried this box's marker.
await writeRecord(key, { terminalPid: handle.pid, terminalCols: pane.cols, terminalRows: pane.rows })

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
// also what makes full-screen agents redraw. The record follows too, so the
// next reattach compares against the size the terminal actually ended up at.
process.stdout.on("resize", () => {
  const size = dims()
  sandbox.pty.resize(handle.pid, size).catch(() => {})
  writeRecord(key, { terminalCols: size.cols, terminalRows: size.rows }).catch(() => {})
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

if (code === LOST) {
  // Correct the record on the way out. Only the explicit pause verb writes
  // `paused`, so a box that auto-paused underneath this session would keep
  // claiming `ready` — and this client is the only thing present at that
  // moment. One getInfo, acting on the loss we just observed, is not a
  // liveness poll; connect() can't be the probe here, because it would RESUME
  // the box and undo the very pause being recorded.
  try {
    const info = await Sandbox.getInfo(rec.sandboxId, { ...conn, requestTimeoutMs: 10_000 })
    if (info?.state === "paused") await writeRecord(key, { status: "paused" })
  } catch {
    // Gone or unreachable — nothing certain to write. The next open reconciles
    // through the provisioning worker, the single source of truth, as always.
  }
}

process.stdin.setRawMode(false)
process.stdin.pause()
await handle.disconnect().catch(() => {})
process.exit(code)
