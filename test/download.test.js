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
