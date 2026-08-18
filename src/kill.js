// Kill an E2B sandbox via the SDK, so the `e2b` CLI is only ever needed for the
// interactive shell (sandbox connect). Best-effort: a sandbox that's already gone is
// treated as success. Usage: node kill.js <sandboxId> [domain]
//
// The domain comes from the box's record (e2b-box passes it): killing has to go
// to the cluster that holds the box, or it "succeeds" against the wrong cluster
// and leaves a live, billable sandbox behind.
import { Sandbox } from "e2b"

import { loadConfig } from "./config.js"
import { sdkConn } from "./shared.js"

const sid = process.argv[2]
const domain = process.argv[3]
if (!sid) process.exit(0)

const conn = sdkConn(loadConfig(), domain)
try {
  // Bound the request so a teardown hook can't hang on a flaky network.
  // Sandbox.kill returns false (doesn't throw) when the box is already gone
  // (idle-timed-out / never existed); only an explicit false means "not killed".
  const res = await Sandbox.kill(sid, { ...conn, requestTimeoutMs: 15000 })
  console.log(res === false ? `sandbox ${sid} already gone` : `killed ${sid}`)
} catch (e) {
  const msg = (e && e.message) || String(e)
  // Already gone (idle-timed-out / never existed) — nothing to do.
  if (/not\s*found|404/i.test(msg)) {
    console.log(`sandbox ${sid} already gone`)
    process.exit(0)
  }
  console.error(`kill ${sid} failed: ${msg}`)
  process.exit(1)
}
