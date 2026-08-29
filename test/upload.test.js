// The baseline commit is what turns "197 staged files" into "a repo the agent's
// work is a diff against" (ADR 0012). Its shape decides whether a sync can hide
// agent edits from pull, so the two shapes are pinned here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { baselineCommand } from "../src/upload.js"

const base = { projectPath: "/home/user/project", branch: "main", label: "repo", head: "abc123def456" }

test("baselineCommand: a fresh box inits on the branch, stages everything, commits", () => {
  const cmd = baselineCommand({ ...base, created: true, listPath: null })
  assert.match(cmd, /^cd '\/home\/user\/project' && /)
  assert.match(cmd, /git init -q -b 'main'/)
  assert.match(cmd, /git add -A/)
  assert.match(cmd, /commit -q --no-verify --allow-empty -m 'herdr-e2b: snapshot of repo @ main abc123def456'/)
  assert.doesNotMatch(cmd, /pathspec/)
})

test("baselineCommand: a sync stages ONLY the uploaded paths, so agent edits stay visible to pull", () => {
  const cmd = baselineCommand({ ...base, created: false, listPath: "/home/user/.herdr-e2b-uploaded" })
  assert.match(cmd, /git add --pathspec-from-file='\/home\/user\/.herdr-e2b-uploaded' --pathspec-file-nul/)
  assert.doesNotMatch(cmd, /git add -A/)
})

test("baselineCommand: pins its own identity and never fails the provision", () => {
  const cmd = baselineCommand({ ...base, created: true })
  assert.match(cmd, /-c user\.name=herdr-e2b -c user\.email=herdr-e2b@localhost commit/)
  assert.match(cmd, /\|\| true$/)
})

test("baselineCommand: no branch → main; no head → message without a sha; quotes stripped", () => {
  const cmd = baselineCommand({ projectPath: "/p", branch: "", label: "it's", head: "", created: true })
  assert.match(cmd, /git init -q -b 'main'/)
  assert.match(cmd, /-m 'herdr-e2b: snapshot of its @ main'/)
})

// --- planMirror: what a mirror upload writes, removes and commits ------------------
import { planMirror } from "../src/upload.js"

const NUL = "\0"
const tracked = ["README.md", "src/a.js", "src/b.js", ".env", "bin/tool"]
const IGN = [".env", "node_modules"]

test("planMirror: clean tree → everything kept, nothing written, ignored tracked file dropped", () => {
  const p = planMirror({ tracked, statusZ: "", ignore: IGN })
  assert.deepEqual(p.keep, ["README.md", "src/a.js", "src/b.js", "bin/tool"])
  assert.deepEqual(p.drop, [".env"])
  assert.deepEqual(p.changed, [])
  assert.deepEqual(p.deleted, [])
  assert.equal(p.count, 4)
})

test("planMirror: modified + untracked are written; deleted tracked is removed after the commit", () => {
  const statusZ = [" M src/a.js", "?? notes.md", " D src/b.js", "A  staged-new.js"].join(NUL) + NUL
  const p = planMirror({ tracked, statusZ, ignore: IGN })
  assert.deepEqual(p.changed, ["src/a.js", "notes.md", "staged-new.js"])
  assert.deepEqual(p.deleted, ["src/b.js"])
  assert.equal(p.count, 4 - 1 + 2) // keep − deleted + two files HEAD never had
})

test("planMirror: an ignored path never reaches the box, dirty or deleted", () => {
  const statusZ = [" M .env", " D .env", "?? node_modules/x.js"].join(NUL) + NUL
  const p = planMirror({ tracked, statusZ, ignore: IGN })
  assert.deepEqual(p.changed, [])
  assert.deepEqual(p.deleted, [])
  assert.deepEqual(p.drop, [".env"])
})

test("planMirror: a deletion of something HEAD never tracked is not a deletion", () => {
  const p = planMirror({ tracked, statusZ: " D ghost.txt" + NUL, ignore: IGN })
  assert.deepEqual(p.deleted, [])
})
