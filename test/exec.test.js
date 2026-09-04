import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import test from "node:test"
import { promisify } from "node:util"

const pExecFile = promisify(execFile)

test("exec.js: invalid JSON payload emits JSON with error and ok:false on stdout", async () => {
  try {
    await pExecFile("node", ["src/exec.js", "not-a-json"])
    assert.fail("should have exited with non-zero")
  } catch (err) {
    assert.equal(err.code, 1)
    const out = JSON.parse(err.stdout.trim())
    assert.equal(out.ok, false)
    assert.equal(out.exitCode, null)
    assert.match(out.error, /invalid JSON payload/)
  }
})

test("exec.js: missing key and command emits JSON with error on stdout", async () => {
  try {
    await pExecFile("node", ["src/exec.js", "{}"])
    assert.fail("should have exited with non-zero")
  } catch (err) {
    assert.equal(err.code, 1)
    const out = JSON.parse(err.stdout.trim())
    assert.equal(out.ok, false)
    assert.match(out.error, /need a box key and a command/)
  }
})
