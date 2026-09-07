import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

test("popup exit preserves its last frame and hidden cursor until Herdr removes it; pane exit restores the shell", (t) => {
  if (!existsSync(path.join(root, "tui/target/release/e2b-dash")) || spawnSync("python3", ["-c", "import pty"]).status !== 0) {
    t.skip("requires the dashboard build and Python's pty module")
    return
  }
  const result = spawnSync("python3", ["-", root], {
    encoding: "utf8",
    timeout: 15000,
    input: String.raw`
import fcntl, os, pathlib, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, time
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='dash-close-') as temp:
    env = dict(os.environ, TERM='xterm-256color', HERDR_PLUGIN_STATE_DIR=temp, HERDR_PLUGIN_CONFIG_DIR=temp)
    env.pop('E2B_DASH_POPUP', None)
    version = ('v' + re.search(r'^version = "([^"]+)"', (root / 'herdr-plugin.toml').read_text(), re.M)[1]).encode()
    for popup, version_in_border in [(False, False), (True, False), (True, True)]:
        if version_in_border: env['HERDR_POPUP_VERSION'] = version.decode()[1:]
        else: env.pop('HERDR_POPUP_VERSION', None)
        for key in [b'q', b'\x1b']:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 140, 0, 0))
            command = [str(root / 'bin/e2b-popup'), '--render'] if popup else [str(root / 'bin/e2b-dash')]
            process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
            os.close(slave)
            output = b''
            try:
                deadline = time.monotonic() + 3
                while b'config paths' not in output and time.monotonic() < deadline:
                    if select.select([master], [], [], 0.02)[0]: output += os.read(master, 65536)
                assert b'config paths' in output, 'Dashboard did not draw its first frame'
                assert b'\x1b[?1049h' in output, 'Dashboard never entered its alternate screen'
                assert (b'herdr-e2b-sandbox' in output) != popup, 'Popup repeats its border title in the dashboard header'
                assert (version in output) != version_in_border, 'Version must move out of the dashboard only when Herdr supplies it in the border'
                os.write(master, key)
                closing = b''
                deadline = time.monotonic() + 3
                # Drain the PTY while waiting: a redraw can otherwise block exit.
                while time.monotonic() < deadline:
                    if select.select([master], [], [], 0.02)[0]:
                        try:
                            chunk = os.read(master, 65536)
                        except OSError:
                            break
                        if not chunk: break
                        closing += chunk
                    elif process.poll() is not None: break
                process.wait(timeout=1)
                assert process.returncode == 0
                if popup:
                    assert b'\x1b[?1049l' not in closing, 'Popup exposes a blank primary screen before Herdr can remove it'
                    assert b'\x1b[?25h' not in closing, 'Popup flashes the cursor before Herdr can remove it'
                else:
                    assert b'\x1b[?1049l' in closing, 'Pane exit did not restore the shell screen'
                    assert b'\x1b[?25h' in closing, 'Pane exit did not restore the shell cursor'
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=2)
                os.close(master)
`,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})
