// Unit tests for the attach-or-create decision — pure data in, instruction out.
// No sandbox, no SDK: the record's terminal fields, a process listing, and the
// pane's dimensions are all literals here, which is the whole reason the
// decision lives in its own module (spec: the only new seam of ADR-0008).
import { test } from "node:test"
import assert from "node:assert/strict"
import { planAttach } from "../src/attach-plan.js"

const KEY = "mybox-abc123"
const PANE = { cols: 120, rows: 30 }
// A terminal of this box's own: right pid, right marker.
const OURS = { pid: 42, cmd: "/bin/bash", args: ["-i", "-l"], envs: { HERDR_E2B_TERMINAL: KEY } }

test("no terminal on record yet → create, and it is NOT a loss", () => {
  // A fresh box has never had a terminal; saying "yours is gone" would be a lie.
  const plan = planAttach({}, [OURS], PANE, KEY)
  assert.deepEqual(plan, { action: "create", reason: "none" })
})

test("a recorded terminal, present and correctly marked → attach", () => {
  const plan = planAttach({ terminalPid: 42, terminalCols: 100, terminalRows: 40 }, [OURS], PANE, KEY)
  assert.equal(plan.action, "attach")
  assert.equal(plan.pid, 42)
})

test("a recorded terminal whose process is absent → create, as a loss", () => {
  const plan = planAttach({ terminalPid: 42, terminalCols: 120, terminalRows: 30 }, [], PANE, KEY)
  assert.deepEqual(plan, { action: "create", reason: "died" })
})

test("the pid exists but carries the wrong marker or none → create, never attach", () => {
  // Pids get recycled: a matching number proves nothing. Trusting one would
  // eventually hand a user someone else's process with no error at all.
  const stranger = { pid: 42, cmd: "sleep", args: ["1000"], envs: { HERDR_E2B_TERMINAL: "other-box" } }
  const unmarked = { pid: 42, cmd: "sleep", args: ["1000"], envs: {} }
  const noEnvs = { pid: 42, cmd: "sleep", args: ["1000"] }
  for (const proc of [stranger, unmarked, noEnvs]) {
    const plan = planAttach({ terminalPid: 42, terminalCols: 120, terminalRows: 30 }, [proc], PANE, KEY)
    assert.deepEqual(plan, { action: "create", reason: "recycled" }, `for ${JSON.stringify(proc.envs)}`)
  }
})

test("geometry changed → a single one-way resize to the pane's size", () => {
  // One resize is one SIGWINCH is one complete frame (research q8) — the nudge
  // and the fit are the same call.
  const plan = planAttach({ terminalPid: 42, terminalCols: 100, terminalRows: 40 }, [OURS], PANE, KEY)
  assert.deepEqual(plan.resize, [{ cols: 120, rows: 30 }])
})

test("geometry unchanged → resize away and back, ending on the pane's size", () => {
  // Same size = no SIGWINCH = a blank frame forever. The detour exists to make
  // the signal fire; it must end exactly where it started.
  const plan = planAttach({ terminalPid: 42, terminalCols: 120, terminalRows: 30 }, [OURS], PANE, KEY)
  assert.equal(plan.resize.length, 2)
  assert.deepEqual(plan.resize[1], { cols: 120, rows: 30 })
  assert.notDeepEqual(plan.resize[0], plan.resize[1])
  assert.ok(plan.resize[0].rows >= 1 && plan.resize[0].cols >= 1, "the detour size must be a real size")
})

test("a record with a pid but no recorded geometry still attaches, with a definite plan", () => {
  // Records written before geometry was tracked: unknown ≠ equal, so the safe
  // read is "changed" — one resize to the pane, which also repaints.
  const plan = planAttach({ terminalPid: 42 }, [OURS], PANE, KEY)
  assert.equal(plan.action, "attach")
  assert.deepEqual(plan.resize, [{ cols: 120, rows: 30 }])
})
