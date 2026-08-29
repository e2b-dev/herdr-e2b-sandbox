// Unit tests for the security-critical pull guards — these gate what pull writes
// to local disk, so a regression here is a data-safety issue.
import { test } from "node:test"
import assert from "node:assert/strict"
import { relIsUnsafe } from "../src/download.js"
import { isIgnored } from "../src/shared.js"

const IGNORE = ["node_modules", ".env", ".git", "dist"]

test("isIgnored: exact match", () => {
  assert.equal(isIgnored(".env", IGNORE), true)
  assert.equal(isIgnored(".gitignore", IGNORE), false) // not ".git"
})

test("isIgnored: path prefix and segment match", () => {
  assert.equal(isIgnored("node_modules/react/index.js", IGNORE), true) // prefix
  assert.equal(isIgnored("packages/app/node_modules/x.js", IGNORE), true) // nested segment
  assert.equal(isIgnored("dist/bundle.js", IGNORE), true)
})

test("isIgnored: unrelated files pass", () => {
  assert.equal(isIgnored("src/index.js", IGNORE), false)
  assert.equal(isIgnored("README.md", IGNORE), false)
  assert.equal(isIgnored("environment.md", IGNORE), false) // not ".env"
})

test("relIsUnsafe: rejects path traversal", () => {
  assert.equal(relIsUnsafe("../etc/passwd"), true)
  assert.equal(relIsUnsafe("a/../../b"), true)
  assert.equal(relIsUnsafe("nested/../../../x"), true)
})

test("relIsUnsafe: rejects absolute paths", () => {
  assert.equal(relIsUnsafe("/etc/passwd"), true)
})

test("relIsUnsafe: allows ordinary relative paths", () => {
  assert.equal(relIsUnsafe("src/index.js"), false)
  assert.equal(relIsUnsafe("a/b/c.txt"), false)
  assert.equal(relIsUnsafe("file..name.js"), false) // ".." inside a name, not a segment
})

// --- parseStatusZ: the changed-set a pull reads (ADR 0012) ----------------------
// Decides which local files a pull touches, so it gets the same scrutiny as the
// path guards above.
import { parseStatusZ } from "../src/download.js"

const NUL = "\0"

test("parseStatusZ: modified, added, untracked are 'changed'; any D is 'deleted'", () => {
  const out = [" M src/a.js", "A  src/new.js", "?? notes.md", " D gone.txt", "D  staged-gone.txt", "MD both.txt"].join(NUL) + NUL
  assert.deepEqual(parseStatusZ(out), {
    changed: ["src/a.js", "src/new.js", "notes.md"],
    deleted: ["gone.txt", "staged-gone.txt", "both.txt"],
  })
})

test("parseStatusZ: empty status means nothing changed", () => {
  assert.deepEqual(parseStatusZ(""), { changed: [], deleted: [] })
  assert.deepEqual(parseStatusZ(NUL), { changed: [], deleted: [] })
  assert.deepEqual(parseStatusZ(undefined), { changed: [], deleted: [] })
})

test("parseStatusZ: paths keep spaces and leading dashes; directory entries are dropped", () => {
  const out = ["?? with space.md", "?? -dash.txt", "?? dir/"].join(NUL) + NUL
  assert.deepEqual(parseStatusZ(out), { changed: ["with space.md", "-dash.txt"], deleted: [] })
})

test("parseStatusZ: garbage entries are skipped, not thrown", () => {
  assert.deepEqual(parseStatusZ("x" + NUL + "??" + NUL + "?? ok.js" + NUL), { changed: ["ok.js"], deleted: [] })
})
