#!/usr/bin/env node
// PROTOTYPE — THROWAWAY. Not wired into the plugin; delete once the answer lands.
//
// ONE QUESTION: after a keepMemory pause + resume, does `pty.connect(pid)` plus a
// `pty.resize()` SIGWINCH nudge make an agent TUI repaint its full frame?
//
// Why it matters: envd keeps no scrollback (it drops PTY bytes when nobody is
// subscribed), so a re-attach lands on a blank screen in front of a live agent.
// A SIGWINCH repaint is the only thing that could put the frame back. If it works,
// the in-box tmux (src/provision.js:216-286) is redundant. If it doesn't, tmux stays.
// See .scratch/sbx-memory/research.md.
//
// Two follow-up questions live here too:
//   q7 --no-disconnect : pause while a PTY subscriber is STILL LIVE. envd gates its
//                        pump on HasSubscribers(); a subscriber whose TCP died under
//                        the pause could leave the pump writing into a dead channel
//                        and wedge the agent. Does it?
//   q8 --resize-to WxH : reconnect from a DIFFERENT terminal size, one one-way resize
//                        instead of the there-and-back nudge. Is one paint enough?
//
//   node src/prototype-pty-reattach-repaint.mjs up    [--template claude]
//   node src/prototype-pty-reattach-repaint.mjs back            # re-attach + nudge
//   node src/prototype-pty-reattach-repaint.mjs run   [--template claude]   # up + back
//   node src/prototype-pty-reattach-repaint.mjs kill

import { Sandbox } from "e2b"
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import path from "node:path"
import { loadConfig, resolveEnv } from "./config.js"
import { seedCommand } from "./fleet-seed.js"

const OUT = path.resolve(".scratch/sbx-memory/prototype-out")
const TAG = process.env.PROTO_TAG || "claude"
const stateFile = () => path.join(OUT, `state-${TAG}.json`)
const COLS = 120
const ROWS = 30
const MARKER = "ZZQ"
const PROMPT = `write a 12 line poem about a frozen virtual machine waking up. begin every line with the token ${MARKER}. no preamble.`
// --overflow: enough lines to push most of the poem off a 30-row viewport, which is
// where "repaint the current frame" and "give me my scrollback back" stop being the
// same thing.
const PROMPT_OVERFLOW = `write a 200 line poem about a frozen virtual machine waking up. begin every line with the token ${MARKER}. no preamble, no commentary.`

// A control process on its own PTY: it does nothing but announce every SIGWINCH it
// receives. Separates "the signal never arrived" from "the agent ignored it" — the
// two failure modes that look identical from a blank terminal.
const CONTROL_CMD =
  `node -e 'process.stdout.write("CTRL-READY\\n");` +
  `process.on("SIGWINCH",()=>process.stdout.write("CTRL-SIGWINCH "+process.stdout.columns+"x"+process.stdout.rows+"\\n"));` +
  `setInterval(()=>{},1e9)'`

// Pausing with a live subscriber kills the gRPC stream under the SDK's feet. That is
// the thing being measured, so the client must survive it rather than die of it.
process.on("unhandledRejection", (e) => console.log(`  [unhandledRejection] ${e?.message || e}`))

mkdirSync(OUT, { recursive: true })
const enc = new TextEncoder()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stripAnsi = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]/g, "")
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : dflt
}

// One collector per PTY: every byte is appended to a .raw file (so nothing is lost to
// terminal interpretation) and kept in memory for the phase-by-phase byte counts.
function collector(name) {
  name = `${TAG}-${name}`
  const raw = path.join(OUT, `${name}.raw`)
  writeFileSync(raw, "")
  const c = {
    chunks: [],
    bytes: 0,
    lastAt: 0,
    onData(d) {
      c.chunks.push(Buffer.from(d))
      c.bytes += d.length
      c.lastAt = Date.now()
      appendFileSync(raw, Buffer.from(d))
    },
    // Everything captured since the last mark(), as a string.
    mark() {
      const s = Buffer.concat(c.chunks).toString("utf8")
      c.chunks = []
      return s
    },
  }
  return c
}

// Wait until the stream has been quiet for `quietMs`, or `maxMs` elapses.
async function settle(c, quietMs = 2500, maxMs = 90000) {
  const start = Date.now()
  c.lastAt = Date.now()
  while (Date.now() - start < maxMs) {
    await sleep(250)
    if (Date.now() - c.lastAt > quietMs) return
  }
}

function report(label, text) {
  label = `${TAG}-${label}`
  const clean = stripAnsi(text)
  const markers = (clean.match(new RegExp(MARKER, "g")) || []).length
  const r = {
    label,
    bytes: Buffer.byteLength(text),
    printableChars: clean.replace(/\s/g, "").length,
    markerHits: markers,
    clearScreen: /\x1b\[[23]J|\x1b\[H|\x1b\[\d*;\d*H/.test(text),
    altScreen: /\x1b\[\?1049[hl]/.test(text),
    controlSigwinch: (clean.match(/CTRL-SIGWINCH/g) || []).length,
  }
  console.log(
    `  ${label.padEnd(26)} bytes=${String(r.bytes).padStart(7)}  printable=${String(
      r.printableChars,
    ).padStart(6)}  ${MARKER}x${r.markerHits}  cursor/clear=${r.clearScreen}  alt=${r.altScreen}` +
      (r.controlSigwinch ? `  SIGWINCH x${r.controlSigwinch}` : ""),
  )
  writeFileSync(path.join(OUT, `${label}.txt`), clean)
  return r
}

async function connectSandbox(cfg, id) {
  return Sandbox.connect(id, {
    apiKey: cfg.apiKey,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
    timeoutMs: cfg.sandboxTimeoutMs,
  })
}

async function up() {
  const cfg = loadConfig()
  const template = arg("template", "claude")
  console.log(`\n=== UP (template=${template}) ===`)

  const sbx = await Sandbox.create(template, {
    apiKey: cfg.apiKey,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
    timeoutMs: cfg.sandboxTimeoutMs,
    envs: resolveEnv(cfg, template),
    // The whole point: auto-pause with a full memory snapshot.
    lifecycle: { onTimeout: { action: "pause", keepMemory: true }, autoResume: false },
  })
  console.log(`sandbox ${sbx.sandboxId}`)

  const seed = seedCommand(template, cfg.fleetSeeds)
  if (seed) {
    console.log("seeding agent first-run state…")
    await sbx.commands.run(seed, { timeoutMs: 120000 }).catch((e) => console.log(`  seed: ${e.message}`))
  }

  // Control PTY first — cheap, and it proves the signal path independently.
  const ctrl = collector("control")
  const ctrlPty = await sbx.pty.create({ cols: COLS, rows: ROWS, timeoutMs: 0, onData: ctrl.onData })
  await sbx.pty.sendInput(ctrlPty.pid, enc.encode(CONTROL_CMD + "\n"))
  await settle(ctrl, 1500, 20000)

  // Agent PTY.
  const agent = collector("agent")
  const agentPty = await sbx.pty.create({ cols: COLS, rows: ROWS, timeoutMs: 0, onData: agent.onData })
  console.log(`ptys: agent=${agentPty.pid} control=${ctrlPty.pid}`)

  console.log(`launching ${template}…`)
  await sbx.pty.sendInput(agentPty.pid, enc.encode(`${template}\n`))
  await settle(agent, 3000, 90000)
  report("A1-agent-booted", agent.mark())

  const overflow = process.argv.includes("--overflow")
  console.log(`asking for the poem…${overflow ? " (overflow: 200 lines)" : ""}`)
  await sbx.pty.sendInput(agentPty.pid, enc.encode(overflow ? PROMPT_OVERFLOW : PROMPT))
  await sleep(1200)
  await sbx.pty.sendInput(agentPty.pid, enc.encode("\r"))
  await settle(agent, 6000, 240000)
  const before = report("A2-poem-rendered", agent.mark())

  // Drop the clients exactly as closing a laptop would — unless we are measuring what
  // happens when nobody does that (q7).
  const keepAttached = process.argv.includes("--no-disconnect")
  if (keepAttached) {
    console.log("NOT disconnecting — pausing with live subscribers (q7)…")
  } else {
    console.log("disconnecting clients…")
    await agentPty.disconnect().catch(() => {})
    await ctrlPty.disconnect().catch(() => {})
  }
  await sleep(1000)

  console.log("pausing with keepMemory: true…")
  const tPause = Date.now()
  let paused, pauseErr = null
  try {
    paused = await sbx.pause({ keepMemory: true })
  } catch (e) {
    pauseErr = e.message
    paused = false
  }
  console.log(`  pause() → ${paused} in ${Date.now() - tPause}ms${pauseErr ? ` (ERROR: ${pauseErr})` : ""}`)

  const st = stateFile()
  writeFileSync(
    st,
    JSON.stringify(
      {
        sandboxId: sbx.sandboxId,
        template,
        agentPid: agentPty.pid,
        controlPid: ctrlPty.pid,
        overflow,
        keepAttached,
        before,
      },
      null,
      2,
    ),
  )
  console.log(`state → ${st}`)
}

async function back() {
  const cfg = loadConfig()
  const template = arg("template", "claude")
  const st = JSON.parse(readFileSync(stateFile(), "utf8"))
  const waitS = Number(arg("wait", "0"))
  console.log(`\n=== BACK (sandbox=${st.sandboxId} agentPid=${st.agentPid}) ===`)
  if (waitS) {
    console.log(`waiting ${waitS}s while paused…`)
    await sleep(waitS * 1000)
  }

  console.log("resuming via Sandbox.connect…")
  const t0 = Date.now()
  const sbx = await connectSandbox(cfg, st.sandboxId)
  console.log(`  resumed in ${Date.now() - t0}ms`)

  const procs = await sbx.commands.list()
  const alive = (pid) => procs.some((p) => p.pid === pid)
  console.log(`  agent pid ${st.agentPid} alive: ${alive(st.agentPid)}`)
  console.log(`  control pid ${st.controlPid} alive: ${alive(st.controlPid)}`)
  writeFileSync(path.join(OUT, `processes-after-resume-${TAG}.json`), JSON.stringify(procs, null, 2))

  const agent = collector("agent-reattach")
  const ctrl = collector("control-reattach")
  const agentPty = await sbx.pty.connect(st.agentPid, { onData: agent.onData })
  const ctrlPty = await sbx.pty.connect(st.controlPid, { onData: ctrl.onData })

  // Phase B: bare re-attach, no nudge. Expect ~0 bytes — envd replays nothing.
  await sleep(4000)
  const b = report("B-reattach-no-nudge", agent.mark())
  report("B-control-no-nudge", ctrl.mark())

  // Phase C: the nudge. Either the there-and-back (geometry unchanged) or a single
  // one-way resize to a different size, which is what a real reconnect from another
  // terminal actually looks like (q8).
  const resizeTo = arg("resize-to", null)
  if (resizeTo) {
    const [c2, r2] = resizeTo.split("x").map(Number)
    console.log(`nudging: ONE one-way resize ${COLS}x${ROWS} → ${c2}x${r2} (q8)…`)
    await sbx.pty.resize(st.agentPid, { cols: c2, rows: r2 })
    await sbx.pty.resize(st.controlPid, { cols: c2, rows: r2 })
  } else {
    console.log("nudging: resize → SIGWINCH…")
    await sbx.pty.resize(st.agentPid, { cols: COLS, rows: ROWS - 1 })
    await sbx.pty.resize(st.controlPid, { cols: COLS, rows: ROWS - 1 })
    await sleep(1500)
    await sbx.pty.resize(st.agentPid, { cols: COLS, rows: ROWS })
    await sbx.pty.resize(st.controlPid, { cols: COLS, rows: ROWS })
  }
  await sleep(5000)
  const c = report("C-after-nudge", agent.mark())
  const cc = report("C-control-after-nudge", ctrl.mark())

  // Liveness probe: one keystroke into the agent's input box. If envd's pump were
  // wedged (the q7 risk) the TUI would go silent here even though the pid is alive.
  console.log("probing liveness with one keystroke…")
  await sbx.pty.sendInput(st.agentPid, enc.encode("x"))
  await sleep(2500)
  const probe = report("D-probe-keystroke", agent.mark())
  await sbx.pty.sendInput(st.agentPid, enc.encode("\u007f")).catch(() => {})

  await agentPty.disconnect().catch(() => {})
  await ctrlPty.disconnect().catch(() => {})

  console.log("\n--- VERDICT ---")
  console.log(`SIGWINCH crossed the pause boundary : ${cc.controlSigwinch > 0 ? "YES" : "NO"}`)
  console.log(`bare re-attach gave a frame         : ${b.printableChars > 40 ? "YES" : "NO"}`)
  console.log(`nudge produced a repaint            : ${c.printableChars > 40 ? "YES" : "NO"}`)
  console.log(`repaint contained the poem (${MARKER})   : ${c.markerHits > 0 ? `YES (x${c.markerHits})` : "NO"}`)
  console.log(`agent still accepts input           : ${probe.bytes > 0 ? "YES" : "NO"}`)
  console.log(`paused with a live subscriber       : ${st.keepAttached ? "YES (q7)" : "no"}`)
  console.log(`\ncompare: pre-pause frame had ${MARKER}x${st.before.markerHits}, ${st.before.printableChars} printable chars`)
  console.log(`dumps in ${OUT}`)
  writeFileSync(
    path.join(OUT, `verdict-${TAG}.json`),
    JSON.stringify(
      { before: st.before, bareReattach: b, afterNudge: c, control: cc, probe, keepAttached: !!st.keepAttached, resizeTo: arg("resize-to", null) },
      null,
      2,
    ),
  )
}

async function kill() {
  const cfg = loadConfig()
  const st = JSON.parse(readFileSync(stateFile(), "utf8"))
  await Sandbox.kill(st.sandboxId, { apiKey: cfg.apiKey, ...(cfg.domain ? { domain: cfg.domain } : {}) })
  console.log(`killed ${st.sandboxId}`)
}

const cmd = process.argv[2]
if (cmd === "up") await up()
else if (cmd === "back") await back()
else if (cmd === "run") {
  await up()
  await back()
} else if (cmd === "kill") await kill()
else {
  console.log(
    "usage: prototype-pty-reattach-repaint.mjs up|back|run|kill [--template claude]" +
      " [--wait 60] [--overflow] [--no-disconnect] [--resize-to 100x40]",
  )
  process.exit(1)
}
