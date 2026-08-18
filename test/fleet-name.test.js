// Unit tests for fleet member naming — pure, no herdr, no E2B, no filesystem.
// A member's branch is the ONLY thing a fleet persists (ADR-0001: the branch
// prefix IS the fleet id), so these rules are load-bearing: an illegal ref
// component fails the worktree creation, and a colliding one silently joins two
// fleets.
import { test } from "node:test"
import assert from "node:assert/strict"
import { sanitizeSlug, memberBranch, memberLabel, randomSuffix, SLUG_MAX } from "../src/fleet-name.js"

test("sanitizeSlug: lowercases and turns spaces into a single separator", () => {
  assert.equal(sanitizeSlug("Login Fix"), "login-fix")
  assert.equal(sanitizeSlug("LOGIN   FIX"), "login-fix")
})

test("sanitizeSlug: illegal git-ref characters become separators", () => {
  // The whole reason this isn't bash: a slash would make "e2b/a/b-claude-1234",
  // and ~^:?*[\ and .. are all rejected by git check-ref-format.
  assert.equal(sanitizeSlug("feat/login"), "feat-login")
  assert.equal(sanitizeSlug("a~b^c:d?e*f[g\\h"), "a-b-c-d-e-f-g-h")
  assert.equal(sanitizeSlug("v1..v2"), "v1-v2")
  assert.equal(sanitizeSlug("fix@{now}"), "fix-now")
  // A ref component may not end in ".lock"; dots are separators, so it can't.
  assert.equal(sanitizeSlug("index.lock"), "index-lock")
})

test("sanitizeSlug: separators collapse and never lead or trail", () => {
  assert.equal(sanitizeSlug("--login__fix--"), "login-fix")
  assert.equal(sanitizeSlug("  spaced  out  "), "spaced-out")
  assert.equal(sanitizeSlug("a - - b"), "a-b")
})

test("sanitizeSlug: length is capped, with no trailing separator left behind", () => {
  const long = "a".repeat(SLUG_MAX + 20)
  assert.equal(sanitizeSlug(long).length, SLUG_MAX)
  // Cutting mid-separator would leave "…-" and produce "e2b/…--claude-ab12".
  const cutOnDash = "b".repeat(SLUG_MAX - 1) + " tail"
  assert.equal(sanitizeSlug(cutOnDash), "b".repeat(SLUG_MAX - 1))
})

test("sanitizeSlug: nothing usable in, empty string out", () => {
  for (const raw of ["", "   ", "!!!", "///", "-.-", null, undefined]) {
    assert.equal(sanitizeSlug(raw), "", `expected "" for ${JSON.stringify(raw)}`)
  }
})

test("memberBranch: <prefix>/<slug>-<template>-<rand4>", () => {
  assert.equal(memberBranch("login fix", "claude", { rand: "ab12" }), "e2b/login-fix-claude-ab12")
  // The template is sanitized on the same rules — it lands in a ref too.
  assert.equal(memberBranch("x", "My Template", { rand: "ab12" }), "e2b/x-my-template-ab12")
})

test("memberBranch: the prefix is configurable and may be namespaced", () => {
  assert.equal(memberBranch("x", "claude", { prefix: "bench", rand: "ab12" }), "bench/x-claude-ab12")
  assert.equal(memberBranch("x", "claude", { prefix: "team/fleet", rand: "ab12" }), "team/fleet/x-claude-ab12")
  // An unusable prefix falls back to the documented default rather than "/x-…".
  assert.equal(memberBranch("x", "claude", { prefix: "  ", rand: "ab12" }), "e2b/x-claude-ab12")
})

test("memberBranch: a slug that sanitizes to nothing is rejected", () => {
  assert.throws(() => memberBranch("!!!", "claude", { rand: "ab12" }), /slug/i)
  assert.throws(() => memberBranch("", "claude", { rand: "ab12" }), /slug/i)
  assert.throws(() => memberBranch("ok", "!!!", { rand: "ab12" }), /template/i)
})

test("memberBranch: the same fleet run twice produces different branches", () => {
  // No override → a real random suffix, so running the same fleet twice in one
  // day can't collide on a branch that already exists.
  const seen = new Set()
  for (let i = 0; i < 50; i++) seen.add(memberBranch("login-fix", "claude", { env: {} }))
  assert.ok(seen.size > 40, `expected distinct branches, got ${seen.size}/50`)
  for (const b of seen) assert.match(b, /^e2b\/login-fix-claude-[a-z0-9]{4}$/)
})

test("randomSuffix: the environment can pin it so tests can assert exact names", () => {
  assert.equal(randomSuffix({ HERDR_E2B_FLEET_RAND: "ab12" }), "ab12")
  assert.equal(memberBranch("x", "claude", { env: { HERDR_E2B_FLEET_RAND: "ab12" } }), "e2b/x-claude-ab12")
  // Junk in the override is filtered, and an override left empty is ignored.
  assert.equal(randomSuffix({ HERDR_E2B_FLEET_RAND: "A B/12" }), "ab12")
  assert.match(randomSuffix({ HERDR_E2B_FLEET_RAND: "" }), /^[a-z0-9]{4}$/)
  assert.match(randomSuffix({}), /^[a-z0-9]{4}$/)
})

test("memberLabel: <slug>-<template>, the name the workspace wears", () => {
  assert.equal(memberLabel("Login Fix", "claude"), "login-fix-claude")
  assert.throws(() => memberLabel("!!!", "claude"), /slug/i)
})
