// Run one command inside a tracked sandbox and report what happened, as JSON.
// Usage: node exec.js '{"key":"...","cmd":"npm test","timeoutMs":900000}'
//
// This is the only way anything reaches a box non-interactively, and the reason
// it exists is the grader: `e2b-bench` shells out to `e2b-box exec` because the
// E2B SDK is JavaScript-only (ARCHITECTURE.md, "Three layers"), so Rust may
// drive a measurement but never take one.
//
// The contract is ONE JSON object on stdout, and the distinction it draws is
// load-bearing (ADR-0004): `ok:false` means we never measured the command — the
// box was unreachable, gone, or the run outlived its bound. `ok:true` means the
// command ran and `exitCode` is its own verdict. A crashed sandbox must never
// read as a failing test, so nothing here ever invents an exit code.
import { Sandbox } from "e2b"

import { loadConfig } from "./config.js"
import { sdkConn, warnCredentials } from "./shared.js"
import { readRecord } from "./store.js"

/** The one line this process is allowed to put on stdout, then it's done. */
function emit(out) {
  console.log(JSON.stringify({ ok: false, exitCode: null, stdout: "", stderr: "", error: "", ...out }))
  // 0 only when the command itself passed: `e2b-box exec 'npm test'` should be
  // usable in a shell `&&` chain, and the grader reads the JSON either way.
  process.exit(out.ok && out.exitCode === 0 ? 0 : 1)
}

const payload = JSON.parse(process.argv[2] || "{}")
const key = payload.key
const cmd = payload.cmd
const timeoutMs = Number(payload.timeoutMs) || 15 * 60 * 1000
if (!key || !cmd) {
  emit({ error: "exec.js: need a box key and a command" })
}

const rec = await readRecord(key)
if (!rec?.sandboxId) {
  emit({ error: `no sandbox tracked for '${key}'` })
}

const cfg = loadConfig()
warnCredentials(cfg)
const conn = sdkConn(cfg, rec.domain)

let sandbox
try {
  // connect() also RESUMES a paused box (there is no separate resume call) and
  // re-arms its idle timeout — grading a fleet you paused overnight should just
  // work, the same way `e2b-box open` reconciles.
  sandbox = await Sandbox.connect(rec.sandboxId, { ...conn, timeoutMs: cfg.sandboxTimeoutMs })
} catch (e) {
  const msg = (e && e.message) || String(e)
  emit({
    error: /not\s*found|404/i.test(msg)
      ? `sandbox for '${key}' is gone — 'e2b-box open' recreates it`
      : `could not reach the sandbox for '${key}': ${msg}`,
  })
}

// Where the worktree was uploaded, so a check reads like it does locally
// (`npm test`, not `cd /home/user/project && npm test`). Older records predate
// the field; provision.js's default is the same string.
const cwd = rec.projectPath || cfg.projectPath

// Started in the background and awaited by hand: `requestTimeoutMs` bounds the
// handshake, not the run, and a held-out test suite is exactly the thing that
// hangs. On the bound we KILL the process — leaving a runaway suite burning the
// box would poison every later grade of the same member.
let handle
try {
  handle = await sandbox.commands.run(cmd, { cwd, background: true })
} catch (e) {
  emit({ error: `could not start the command in '${key}': ${(e && e.message) || String(e)}` })
}

let timedOut = false
const bound = setTimeout(() => {
  timedOut = true
  handle.kill().catch(() => {})
}, timeoutMs)

try {
  const r = await handle.wait()
  clearTimeout(bound)
  emit({ ok: true, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, error: r.error || "" })
} catch (e) {
  clearTimeout(bound)
  if (timedOut) {
    // Not a failure of the command — a failure to measure it. Keep the output it
    // did produce: it is usually where the hang is.
    emit({
      stdout: e?.stdout || "",
      stderr: e?.stderr || "",
      error: `timed out after ${timeoutMs}ms — the command was killed`,
    })
  }
  // A non-zero exit arrives as CommandExitError, which carries the same fields
  // as a result. That is the command's verdict, so it is `ok:true`.
  if (typeof e?.exitCode === "number") {
    emit({ ok: true, exitCode: e.exitCode, stdout: e.stdout || "", stderr: e.stderr || "", error: e.error || "" })
  }
  emit({ error: `command failed to run in '${key}': ${(e && e.message) || String(e)}` })
}
