// Which create failures may silently downgrade a box to `base`, and which must
// reach the user. Every message below was captured from a live juliett (EU)
// call, not invented — see the spike notes in the custom-templates issue.
import { test } from "node:test"
import assert from "node:assert/strict"
import { isMissingTemplateError, probeTemplate } from "../src/shared.js"

const CONN = { apiKey: "e2b_x", domain: "e2b-juliett.dev" }

test("a missing template falls back to base, bare or namespaced", () => {
  // Both captured from Sandbox.create() against e2b-juliett.dev.
  assert.equal(isMissingTemplateError("404: template 'totally-not-real-xyz' not found"), true)
  assert.equal(
    isMissingTemplateError("404: template 'ondrejs-project/nope-not-real' not found"),
    true,
  )
})

test("a foreign-namespace 400 is NOT a missing template", () => {
  // Template.exists("e2b/base") on EU raises this, but Sandbox.create("e2b/base")
  // boots the template fine. Reading it as "missing" would swap a working box
  // for `base`, so the predicate has to say no even though the wording is close.
  const msg = "400: namespace 'e2b' must match your team 'ondrejs-project'"
  assert.equal(isMissingTemplateError(msg), false)
})

test("the namespace guard beats the substring that would otherwise match", () => {
  // The guard exists because the 400 is one reword away from matching: today it
  // contains no "template"/"404"/"not found", so the bare regex says no by luck.
  // Pin the intent, so a future "template namespace 'x' must match…" still fails
  // closed rather than quietly downgrading.
  assert.equal(
    isMissingTemplateError("404: template namespace 'e2b' must match your team 'ondrejs-project'"),
    false,
  )
})

test("unrelated failures never downgrade the box", () => {
  assert.equal(isMissingTemplateError("401: Invalid API key, cannot get the team"), false)
  assert.equal(isMissingTemplateError("socket hang up"), false)
  assert.equal(isMissingTemplateError(""), false)
  assert.equal(isMissingTemplateError(undefined), false)
})

// --- the pre-flight probe ----------------------------------------------------
// A create that has to fail before it can tell you a template is missing costs a
// boot attempt; asking first costs ~50ms. The probe is only ever allowed to SAVE
// time, never to cost a working box — so it answers three ways, and the third is
// the one that matters.

test("probeTemplate: a template that exists answers true", async () => {
  assert.equal(await probeTemplate("claude", CONN, async () => true), true)
})

test("probeTemplate: a template that does not exist answers false", async () => {
  assert.equal(await probeTemplate("nope", CONN, async () => false), false)
})

test("probeTemplate: a foreign-namespace 400 answers null — 'cannot tell'", async () => {
  // Measured on juliett: Template.exists("e2b/base") raises this, while
  // Sandbox.create("e2b/base") boots that very template. Answering `false` here
  // would swap a working box for `base` — the exact harm the probe exists to
  // avoid, caused by the probe itself.
  const boom = async () => {
    throw new Error("400: namespace 'e2b' must match your team 'ondrejs-project'")
  }
  assert.equal(await probeTemplate("e2b/base", CONN, boom), null)
})

test("probeTemplate: any other failure also answers null, never false", async () => {
  // A probe is an optimisation. A network blip, an expired key or an SDK change
  // must degrade to "ask create instead", never to "the template is missing".
  for (const err of ["socket hang up", "401: Invalid API key", "boom"]) {
    const boom = async () => {
      throw new Error(err)
    }
    assert.equal(await probeTemplate("x", CONN, boom), null, `for ${err}`)
  }
})

test("probeTemplate: a non-boolean answer is not trusted as false", async () => {
  // `false` is the only value that may skip a create, so anything unexpected
  // has to fall through rather than be coerced.
  assert.equal(await probeTemplate("x", CONN, async () => undefined), null)
})
