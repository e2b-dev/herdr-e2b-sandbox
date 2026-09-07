import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"

const exec = promisify(execFile)
const download = fileURLToPath(new URL("../src/download.js", import.meta.url))
const box = fileURLToPath(new URL("../bin/e2b-box", import.meta.url))
const preload = new URL("./fixtures/download-sandbox.mjs", import.meta.url).href

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "herdr-download-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dest = path.join(root, "worktree")
  const config = path.join(root, "config")
  const state = path.join(root, "state")
  const home = path.join(root, "home")
  await Promise.all([mkdir(dest), mkdir(config), mkdir(home), mkdir(path.join(state, "boxes"), { recursive: true })])
  const reads = path.join(root, "reads")
  const settings = path.join(root, "fixture.json")
  await writeFile(reads, "")
  await writeFile(settings, JSON.stringify({ files, reads }))
  await writeFile(path.join(config, "config.toml"), "[upload]\nbatch_size = 2\n")
  await writeFile(path.join(state, "boxes/probe.json"), JSON.stringify({ sandboxId: "fake-test-box", status: "ready" }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(E2B_|HERDR_|XDG_|GIT_|NODE_OPTIONS$)/.test(key)))
  Object.assign(env, {
    HOME: home,
    HERDR_PLUGIN_STATE_DIR: state,
    HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_E2B_NODE: process.execPath,
    HERDR_TEST_DOWNLOAD_FIXTURE: settings,
    E2B_API_KEY: "fake-test-key",
    NODE_OPTIONS: `--import=${preload}`,
    KEY: "probe",
  })
  const run = (command, args) => new Promise((resolve) => {
    const child = execFile(command, args, { cwd: dest, env }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
    child.stdin.end()
  })
  return {
    dest,
    reads,
    git: (...args) => exec("git", ["-C", dest, ...args], { env }),
    pull: (...args) => run(box, ["pull", ...args]),
    download: (check = false) => run(process.execPath, [download, JSON.stringify({ key: "probe", destRoot: dest, check })]),
  }
}

test("a transient read failure in the safety check aborts without overwriting local edits", async (t) => {
  const f = await fixture(t, [{ path: "dirty.txt", data: "remote change", error: "transient read failure", failOnce: true }])
  await f.git("init", "-q")
  await writeFile(path.join(f.dest, "dirty.txt"), "baseline")
  await f.git("add", "dirty.txt")
  await f.git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "baseline")
  await writeFile(path.join(f.dest, "dirty.txt"), "local edit")

  const first = await f.pull()
  assert.equal(first.code, 1)
  assert.match(first.stderr, /aborted.*non-interactive/)
  assert.equal(await readFile(path.join(f.dest, "dirty.txt"), "utf8"), "local edit")
  assert.equal(await readFile(f.reads, "utf8"), "dirty.txt\n", "the actual download must not run after a failed check")

  const retry = await f.pull()
  assert.equal(retry.code, 1)
  assert.match(retry.stderr, /would overwrite uncommitted local edits in: dirty.txt/)
  assert.equal(await readFile(path.join(f.dest, "dirty.txt"), "utf8"), "local edit")
  assert.equal((await f.pull("--force")).code, 0)
  assert.equal(await readFile(path.join(f.dest, "dirty.txt"), "utf8"), "remote change")
})

test("read and write failures do not stop the same or subsequent batches or count as downloads", async (t) => {
  const f = await fixture(t, [
    { path: "unreadable.txt", error: "remote read denied" },
    { path: "first.txt", data: "first batch" },
    { path: "collision", data: "cannot replace a directory" },
    { path: "last.txt", data: "second batch" },
  ])
  await mkdir(path.join(f.dest, "collision"))
  const result = await f.pull("--force")
  assert.equal(result.code, 1)
  assert.equal(await readFile(path.join(f.dest, "first.txt"), "utf8"), "first batch")
  assert.equal(await readFile(path.join(f.dest, "last.txt"), "utf8"), "second batch")
  assert.match(result.stdout, /pull incomplete.*2 file\(s\) pulled.*2 failed/)
  assert.doesNotMatch(result.stdout, /[+~] (collision|unreadable.txt)/)
  assert.match(result.stderr, /unreadable.txt.*remote read denied/)
  assert.match(result.stderr, /collision.*EISDIR/)
  assert.doesNotMatch(result.stderr, /unsafe path/)
})

test("destination preparation failure is reported and later batches still download", async (t) => {
  const f = await fixture(t, [
    { path: "parent/child.txt", data: "blocked by a file" },
    { path: "middle.txt" },
    { path: "last.txt" },
  ])
  await writeFile(path.join(f.dest, "parent"), "keep this file")
  const result = await f.download()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /parent\/child.txt.*(EEXIST|ENOTDIR)/)
  assert.equal(await readFile(path.join(f.dest, "last.txt"), "utf8"), "remote content")
  assert.equal(await readFile(path.join(f.dest, "parent"), "utf8"), "keep this file")
})

test("all failed reads report an incomplete pull instead of claiming the local tree matches", async (t) => {
  const f = await fixture(t, [{ path: "unreadable.txt", error: "remote read denied" }])
  const result = await f.download()
  assert.equal(result.code, 1)
  assert.match(result.stdout, /pull incomplete.*0 file\(s\) pulled.*1 failed/)
  assert.doesNotMatch(result.stdout, /local already matches/)
})

test("successful writes, identical files and unsafe skips keep their existing classifications", async (t) => {
  const f = await fixture(t, [
    { path: "new.txt", data: "new" },
    { path: "changed.txt", data: "updated" },
    { path: "same.txt", data: "identical" },
    { path: "link.txt", data: "must not follow" },
  ])
  await writeFile(path.join(f.dest, "changed.txt"), "old")
  await writeFile(path.join(f.dest, "same.txt"), "identical")
  await symlink(path.join(f.dest, "same.txt"), path.join(f.dest, "link.txt"))
  const result = await f.download()
  assert.equal(result.code, 0)
  assert.equal(result.stderr, "")
  assert.match(result.stdout, /pulled 2 file\(s\): 1 new, 1 overwritten, 1 unchanged.*1 skipped/)
  assert.match(result.stdout, /link.txt.*skipped — unsafe path\/symlink/)
  assert.equal(await readFile(path.join(f.dest, "changed.txt"), "utf8"), "updated")
  assert.equal(await readFile(path.join(f.dest, "same.txt"), "utf8"), "identical")
})
