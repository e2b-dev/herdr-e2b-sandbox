import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { authMenuActions } from "../src/auth-menu.js"
import { HARNESSES } from "../src/harnesses.js"
import { classifySubscription, saveConnection, readConnections } from "../src/connections.js"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const TOKEN = `sk-ant-oat01-${"fake-menu-token-".repeat(4)}`
const REPLACEMENT = `sk-ant-oat01-${"new-menu-token-".repeat(4)}`
const DRIVER = String.raw`import os,pty,select,sys,time,json,fcntl,termios,struct,re
steps=json.loads(sys.argv[1]); pid,fd=pty.fork()
if pid==0:
 fcntl.ioctl(1,termios.TIOCSWINSZ,struct.pack('HHHH',28,100,0,0))
 os.execv(sys.argv[2],sys.argv[2:])
buf=b''; seen=b''; deadline=time.monotonic()+25; index=0; status=None
try:
 while time.monotonic()<deadline:
  if select.select([fd],[],[],.1)[0]:
   try: data=os.read(fd,65536)
   except OSError: data=b''
   if not data: break
   buf+=data; seen+=data
   plain=re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]',b'',seen)
   if index<len(steps) and steps[index]['wait'].encode() in plain:
    os.write(fd,steps[index]['send'].encode()); index+=1; seen=b''
  done,value=os.waitpid(pid,os.WNOHANG)
  if done: status=value; break
 if status is None:
  done,value=os.waitpid(pid,os.WNOHANG)
  if done: status=value
 if status is None: os.kill(pid,15); _,status=os.waitpid(pid,0)
 print(json.dumps({'steps':index,'code':os.waitstatus_to_exitcode(status),'output':buf.decode(errors='replace'),'canonical':bool(termios.tcgetattr(fd)[3]&termios.ICANON)}))
finally: os.close(fd)
`

function fixture(t) {
  if (spawnSync("python3", ["-c", "import pty"]).status !== 0) { t.skip("python3 unavailable"); return }
  const root = mkdtempSync(path.join(os.tmpdir(), "auth menu-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bins = path.join(root, "bin")
  mkdirSync(bins)
  mkdirSync(path.join(root, "herdr"))
  for (const h of Object.values(HARNESSES)) writeFileSync(path.join(bins, h.bin), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  writeFileSync(path.join(bins, "claude"), `#!/usr/bin/env python3\nimport sys,json\nif sys.argv[1:]==['auth','status']:\n print(json.dumps({'loggedIn':True,'subscriptionType':'team','orgName':'E2B'}))\nelse:\n print(${JSON.stringify(REPLACEMENT)})\n`, { mode: 0o755 })
  const directory = path.join(root, "connections")
  const record = saveConnection({ id: "claude-work", harness: "claude", method: "setup-token",
    detected: classifySubscription({ subscriptionType: "team", orgName: "E2B" }) }, TOKEN, { directory })
  writeFileSync(path.join(root, "config.toml"), `[dashboard]\nconfig_opener = 'printf "%s\\n" "$1" "$2" "$PWD" > "$OPEN_CAPTURE"'\n`)
  const env = { PATH: `${bins}:${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root,
    HERDR_PLUGIN_CONFIG_DIR: root, HERDR_PLUGIN_STATE_DIR: path.join(root, "state"),
    TERM: "xterm-256color", NO_COLOR: "1", SHELL: "/bin/sh", OPEN_CAPTURE: path.join(root, "opened") }
  return { root, directory, record, env }
}

function drive(f, steps) {
  const result = spawnSync("python3", ["-c", DRIVER, JSON.stringify(steps), process.execPath,
    path.join(ROOT, "src/harness-auth.js")], { env: f.env, encoding: "utf8", timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  const observed = JSON.parse(result.stdout)
  assert.equal(observed.steps, steps.length, observed.output)
  assert.equal(observed.code, 0, observed.output)
  assert.equal(observed.canonical, true, "raw mode must be restored")
  assert.equal(observed.output.split("\x1b[?1049h").length, observed.output.split("\x1b[?1049l").length)
  assert.ok(!observed.output.includes(TOKEN))
  assert.ok(!observed.output.includes(REPLACEMENT))
  return observed.output
}

test("auth actions offer reconnect per saved account and only supported connect flows", () => {
  const connections = [{ id: "work", harness: "claude" }, { id: "personal", harness: "claude" }]
  const actions = authMenuActions("claude", connections)
  assert.deepEqual(actions.filter((a) => a.id === "reconnect").map((a) => a.connection), ["work", "personal"])
  assert.ok(actions.some((a) => a.id === "connect"))
  const droid = authMenuActions("droid", connections)
  assert.ok(!droid.some((a) => a.id === "connect" || a.id === "reconnect"))
  assert.ok(droid.some((a) => a.id === "config"))
})

test("auth manager navigates with arrows, j/k and numbers; Escape backs out without saving", (t) => {
  const f = fixture(t); if (!f) return
  drive(f, [
    { wait: "enter actions", send: "\x1b[B" },
    { wait: "> | 2", send: "k" },
    { wait: "> | 1", send: "6" },
    { wait: "> | 6", send: "\r" },
    { wait: "droid authentication", send: "\x1b" },
    { wait: "enter actions", send: "\x03" },
  ])
  assert.equal(existsSync(path.join(f.root, "auth.toml")), false)
  assert.equal(readConnections(f.directory)[0].revision, f.record.revision)
})

test("auth manager opens the configured editor and saves discovery only after an explicit action", (t) => {
  const f = fixture(t); if (!f) return
  drive(f, [
    { wait: "enter actions", send: "f" },
    { wait: "Opened config.toml", send: "s" },
    { wait: "[y/N]", send: "y\r" },
    { wait: "Saved discovery to auth.toml", send: "q" },
  ])
  assert.deepEqual(readFileSync(path.join(f.root, "opened"), "utf8").trim().split("\n"), [
    path.join(f.root, "herdr"), path.join(f.root, "config.toml"), realpathSync(path.join(f.root, "herdr")),
  ])
  assert.ok(!readFileSync(path.join(f.root, "auth.toml"), "utf8").includes(TOKEN))
  assert.equal(readConnections(f.directory)[0].revision, f.record.revision)
})

test("auth manager hands the terminal to reconnect and returns with the updated connection", (t) => {
  const f = fixture(t); if (!f) return
  drive(f, [
    { wait: "enter actions", send: "\r" },
    { wait: "Reconnect claude-work", send: "\r" },
    { wait: "[y/N]", send: "y\r" },
    { wait: "Press Enter to return", send: "\r" },
    { wait: "enter actions", send: "q" },
  ])
  const updated = readConnections(f.directory)[0]
  assert.equal(updated.id, "claude-work")
  assert.notEqual(updated.revision, f.record.revision)
  assert.equal(readFileSync(path.join(f.directory, `${updated.id}.${updated.revision}.secret`), "utf8"), REPLACEMENT)
})

test("opening absent discovery offers save without creating an auth file", (t) => {
  const f = fixture(t); if (!f) return
  drive(f, [
    { wait: "enter actions", send: "a" },
    { wait: "Press s to save discovery first", send: "q" },
  ])
  assert.equal(existsSync(path.join(f.root, "auth.toml")), false)
})

test("connecting another account asks for a distinct name and preserves the existing connection", (t) => {
  const f = fixture(t); if (!f) return
  drive(f, [
    { wait: "enter actions", send: "\r" },
    { wait: "Connect new claude account", send: "2" },
    { wait: "> [2]", send: "\r" },
    { wait: "New connection name", send: "claude-other\r" },
    { wait: "[y/N]", send: "y\r" },
    { wait: "Press Enter to return", send: "\r" },
    { wait: "enter actions", send: "q" },
  ])
  const records = readConnections(f.directory)
  assert.equal(records.length, 2)
  assert.equal(records.find((c) => c.id === "claude-work").revision, f.record.revision)
  assert.ok(records.some((c) => c.id === "claude-other"))
})
