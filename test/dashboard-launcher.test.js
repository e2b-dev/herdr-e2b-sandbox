import { test } from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

test("native dashboard launch resolves its own actions and tool fallbacks with a minimal PATH", (t) => {
  if (spawnSync("python3", ["-c", "import pty"]).status !== 0) {
    t.skip("requires Python's pty module")
    return
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "dash-launcher-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const plugin = path.join(dir, "plugin with spaces")
  const home = path.join(dir, "home")
  const inherited = path.join(dir, "inherited tools")
  const system = path.join(dir, "system tools")
  for (const subdir of ["bin/lib", "tui/target/release"]) {
    mkdirSync(path.join(plugin, subdir), { recursive: true })
  }
  mkdirSync(path.join(home, ".local/bin"), { recursive: true })
  mkdirSync(inherited)
  mkdirSync(system)
  // Exclude any system jq so this tests fallback discovery on every machine.
  for (const command of ["dirname", "mkdir", "sed", "head"]) {
    const found = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "launcher-test", command], { encoding: "utf8" })
    assert.equal(found.status, 0, found.stderr)
    symlinkSync(found.stdout.trim(), path.join(system, command))
  }
  for (const file of ["e2b-dash", "lib/paths.sh"]) {
    copyFileSync(path.join(root, "bin", file), path.join(plugin, "bin", file))
  }
  writeFileSync(path.join(plugin, "herdr-plugin.toml"), 'version = "0.0.0"\n')
  writeFileSync(path.join(plugin, "tui/target/release/e2b-dash"), "#!/bin/sh\nexec e2b-box\n", { mode: 0o755 })
  writeFileSync(path.join(plugin, "bin/e2b-box"), '#!/bin/sh\nprintf "checkout-action "\nexec jq\n', { mode: 0o755 })
  writeFileSync(path.join(inherited, "e2b-box"), '#!/bin/sh\nprintf "wrong-checkout\\n"\n', { mode: 0o755 })
  writeFileSync(path.join(home, ".local/bin/jq"), '#!/bin/sh\nprintf "fallback-tool\\n"\n', { mode: 0o755 })
  writeFileSync(path.join(inherited, "jq"), '#!/bin/sh\nprintf "inherited-tool\\n"\n', { mode: 0o755 })

  for (const [launcherPath, expected] of [
    [system, "checkout-action fallback-tool"],
    [`${inherited}:${system}`, "checkout-action inherited-tool"],
  ]) {
    const result = spawnSync("python3", ["-", path.join(plugin, "bin/e2b-dash"), home, launcherPath], {
      encoding: "utf8",
      timeout: 5000,
      input: String.raw`
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
env = dict(os.environ, HOME=sys.argv[2], PATH=sys.argv[3], TERM='xterm-256color')
env.pop('HERDR_PLUGIN_STATE_DIR', None)
env.pop('HERDR_E2B_STATE_DIR', None)
env.pop('XDG_STATE_HOME', None)
process = subprocess.Popen(['/bin/bash', sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
output = b''
try:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        elif process.poll() is not None:
            break
    process.wait(timeout=1)
    assert process.returncode == 0, output
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
sys.stdout.buffer.write(output)
`,
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.equal(result.stdout.trim(), expected)
  }
})
