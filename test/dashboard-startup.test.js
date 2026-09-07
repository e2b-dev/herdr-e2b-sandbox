import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"

test("dashboard paints before settings resolve, and a quick Enter still uses the configured opener", (t) => {
  const binary = path.resolve(import.meta.dirname, "../tui/target/release/e2b-dash")
  if (!existsSync(binary) || spawnSync("python3", ["-c", "import pty"]).status !== 0) {
    t.skip("requires the dashboard build and Python's pty module")
    return
  }
  const result = spawnSync("python3", ["-", binary], {
    encoding: "utf8",
    timeout: 10000,
    input: String.raw`
import fcntl, json, os, pathlib, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, time
with tempfile.TemporaryDirectory(prefix='dash-startup-') as temp:
    root = pathlib.Path(temp)
    (root / 'boxes').mkdir()
    config = root / 'config with spaces'
    config.mkdir()
    helper = root / 'settings'
    helper.write_text('#!/bin/sh\nwhile [ ! -e "$RELEASE" ]; do sleep 0.02; done\ncat "$SETTINGS"\n')
    helper.chmod(0o755)
    (root / 'settings.json').write_text(json.dumps({'theme':'terminal', 'domain':'e2b.dev', 'opener':'printf "%s" "$2" > "$OPEN_LOG"'}))
    env = dict(os.environ, TERM='xterm-256color', SHELL='/bin/sh', HERDR_PLUGIN_STATE_DIR=str(root / 'state'), HERDR_PLUGIN_CONFIG_DIR=str(config), E2B_DASH_SETTINGS_CMD=str(helper), E2B_DASH_DOMAIN_CMD=str(helper), E2B_DASH_PLUGIN_DIR=str(root), RELEASE=str(root / 'release'), SETTINGS=str(root / 'settings.json'), OPEN_LOG=str(root / 'opened'))
    env.pop('E2B_DASH_CONFIG_OPENER', None)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 140, 0, 0))
    process = subprocess.Popen([sys.argv[1], str(root / 'boxes')], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    output = b''
    try:
        deadline = time.monotonic() + 2
        while b'config paths' not in output and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]: output += os.read(master, 65536)
        assert b'config paths' in output, 'First frame waited for the blocked settings/region resolver'
        os.write(master, b'C\r')
        (root / 'release').touch()
        deadline = time.monotonic() + 2
        while not (root / 'opened').exists() and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]: os.read(master, 65536)
        assert (root / 'opened').read_text() == str(config / 'config.toml')
        os.write(master, b'q')
        process.wait(timeout=2)
        assert process.returncode == 0
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait()
        os.close(master)
`,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})

test("reopened dashboard paints cached appearance before settings resolve, then refreshes it", (t) => {
  const binary = path.resolve(import.meta.dirname, "../tui/target/release/e2b-dash")
  if (!existsSync(binary) || spawnSync("python3", ["-c", "import pty"]).status !== 0) {
    t.skip("requires the dashboard build and Python's pty module")
    return
  }
  const result = spawnSync("python3", ["-", binary], {
    encoding: "utf8",
    timeout: 10000,
    input: String.raw`
import fcntl, json, os, pathlib, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, time
with tempfile.TemporaryDirectory(prefix='dash-reopen-') as temp:
    root = pathlib.Path(temp)
    (root / 'boxes').mkdir()
    helper = root / 'settings'
    helper.write_text('#!/bin/sh\nwhile [ ! -e "$RELEASE" ]; do sleep 0.02; done\ncat "$SETTINGS"\n')
    helper.chmod(0o755)
    settings = root / 'settings.json'
    settings.write_text(json.dumps({'theme':'dracula', 'domain':'e2b-juliett.dev', 'opener':''}))
    release = root / 'release'
    release.touch()
    env = dict(os.environ, TERM='xterm-256color', HERDR_PLUGIN_STATE_DIR=temp, HERDR_PLUGIN_CONFIG_DIR=str(root / 'config'), E2B_DASH_SETTINGS_CMD=str(helper), RELEASE=str(release), SETTINGS=str(settings))
    for key in ['E2B_DASH_THEME', 'E2B_DOMAIN', 'E2B_DASH_DOMAIN_CMD']:
        env.pop(key, None)
    for reopen in [False, True]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 140, 0, 0))
        process = subprocess.Popen([sys.argv[1], str(root / 'boxes')], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        os.close(slave)
        output = b''
        def until(marker):
            global output
            deadline = time.monotonic() + 2
            while marker not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.02)[0]: output += os.read(master, 65536)
            assert marker in output, 'Missing dashboard output: ' + repr(marker)
        try:
            until(b'config paths')
            if reopen:
                assert b'dracula' in output and b'region eu' in re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output), 'Reopened first frame lost the configured appearance while settings were blocked'
                settings.write_text(json.dumps({'theme':'nord', 'domain':'e2b.dev', 'opener':''}))
                output = b''
                release.touch()
                until(b'nord')
                assert b'region us' in re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output), 'Fresh settings did not replace the cached region'
            else:
                until(b'dracula')
            os.write(master, b'q')
            process.wait(timeout=2)
            assert process.returncode == 0
        finally:
            # Release the helper before cleanup even on the expected red run.
            release.touch()
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=2)
            os.close(master)
        release.unlink()
`,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})
