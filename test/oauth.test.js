import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  AMP, CODEX, MUSE, ampConnect, codexAuthorizeUrl, codexConnect, codexRefresh, deviceFlow,
  jwtExpiryIso, museConnect, pkcePair, validAmpAccessToken,
} from "../src/oauth.js"

// Every flow runs against a scripted `fetch`: a list of handlers matched by URL,
// each returning { status, body }. Nothing here touches the network or a browser.
function scripted(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init })
    const route = routes.find((r) => (typeof r.url === "string" ? r.url === url : r.url.test(url)))
    if (!route) throw new Error(`unexpected request to ${url}`)
    const step = typeof route.reply === "function" ? route.reply(init, calls) : route.reply
    return { ok: step.status < 400, status: step.status, text: async () => JSON.stringify(step.body) }
  }
  return { fetch, calls }
}
const sleep = async () => {}
const jwt = (exp) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`

test("pkce pair: verifier is base64url of the bytes, challenge is its S256", () => {
  const bytes = Buffer.alloc(32, 7)
  const { verifier, challenge } = pkcePair(bytes)
  assert.equal(verifier, bytes.toString("base64url"))
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"))
  assert.doesNotMatch(verifier + challenge, /[+/=]/)
})

test("jwtExpiryIso reads exp, and refuses anything that is not a JWT", () => {
  assert.equal(jwtExpiryIso(jwt(1_800_000_000)), new Date(1_800_000_000 * 1000).toISOString())
  assert.equal(jwtExpiryIso("sgamp_notajwt"), null)
  assert.equal(jwtExpiryIso(undefined), null)
})

test("device flow: hands the human the complete URL and code, polls through pending and slow_down, returns tokens", async () => {
  let polls = 0
  const { fetch, calls } = scripted([
    { url: "https://x/auth", reply: { status: 200, body: { device_code: "dc", user_code: "AB-CD", verification_uri: "https://x/d", verification_uri_complete: "https://x/d?user_code=AB-CD", expires_in: 300, interval: 1 } } },
    { url: "https://x/token", reply: () => (++polls === 1 ? { status: 400, body: { error: "authorization_pending" } } : polls === 2 ? { status: 400, body: { error: "slow_down" } } : { status: 200, body: { access_token: "tok" } }) },
  ])
  const seen = []
  const tokens = await deviceFlow({ authorizeUrl: "https://x/auth", tokenUrl: "https://x/token", clientId: "cid", onCode: (c) => seen.push(c), fetch, sleep })
  assert.equal(tokens.access_token, "tok")
  assert.deepEqual(seen, [{ url: "https://x/d?user_code=AB-CD", userCode: "AB-CD", expiresIn: 300 }])
  assert.equal(calls[0].init.body, "client_id=cid")
  assert.match(calls[1].init.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc&client_id=cid/)
  assert.equal(polls, 3)
})

test("device flow: a denial and an expiry are named, not retried forever", async () => {
  const denied = scripted([
    { url: "https://x/auth", reply: { status: 200, body: { device_code: "dc", user_code: "A", verification_uri: "https://x/d", expires_in: 300, interval: 1 } } },
    { url: "https://x/token", reply: { status: 400, body: { error: "access_denied" } } },
  ])
  await assert.rejects(deviceFlow({ authorizeUrl: "https://x/auth", tokenUrl: "https://x/token", clientId: "c", fetch: denied.fetch, sleep }), /denied in the browser/)
  let t = 0
  const expired = scripted([
    { url: "https://x/auth", reply: { status: 200, body: { device_code: "dc", user_code: "A", verification_uri: "https://x/d", expires_in: 10, interval: 5 } } },
    { url: "https://x/token", reply: { status: 400, body: { error: "authorization_pending" } } },
  ])
  await assert.rejects(deviceFlow({ authorizeUrl: "https://x/auth", tokenUrl: "https://x/token", clientId: "c", fetch: expired.fetch, sleep, now: () => (t += 6000) }), /expired before it was approved/)
})

test("muse: Meta device flow, then Meta mints the API key; only the key is kept", async () => {
  const { fetch, calls } = scripted([
    { url: MUSE.authorizeUrl, reply: { status: 200, body: { device_code: "dc", user_code: "XCCF-DXML", verification_uri: "https://auth.meta.com/oauth/device", expires_in: 600, interval: 5 } } },
    { url: MUSE.tokenUrl, reply: { status: 200, body: { access_token: "meta-id-token" } } },
    { url: MUSE.keyUrl, reply: (init) => (init.headers.Authorization === "Bearer meta-id-token" && init.headers["x-api-version"] === "1.0.0" ? { status: 200, body: { api_key: "muse-key-1" } } : { status: 401, body: {} }) },
  ])
  const r = await museConnect({ fetch, sleep, onCode: () => {} })
  assert.deepEqual(r, { secret: { kind: "api-key", META_API_KEY: "muse-key-1" }, expiresAt: null })
  assert.equal(calls[0].init.body, `client_id=${MUSE.clientId}`)
})

test("muse: an account that has not finished setup is told where, and nothing is stored", async () => {
  const { fetch } = scripted([
    { url: MUSE.authorizeUrl, reply: { status: 200, body: { device_code: "dc", user_code: "A", verification_uri: "https://m/d", expires_in: 600, interval: 5 } } },
    { url: MUSE.tokenUrl, reply: { status: 200, body: { access_token: "t" } } },
    { url: MUSE.keyUrl, reply: { status: 200, body: { action_url: "https://dev.meta.ai/setup" } } },
  ])
  await assert.rejects(museConnect({ fetch, sleep }), /Finish setup at https:\/\/dev\.meta\.ai\/setup/)
})

test("amp: opens the Security page and keeps exactly the pasted access token", async () => {
  const seen = []
  const r = await ampConnect({ onCode: (c) => seen.push(c), prompt: async () => "  sgamp_user_abcdefghijklmnop \n" })
  assert.deepEqual(seen, [{ url: AMP.settingsUrl, userCode: null, expiresIn: 600 }])
  assert.deepEqual(r, { secret: { kind: "api-key", AMP_API_KEY: "sgamp_user_abcdefghijklmnop" }, expiresAt: null })
  // A session JWT pasted by mistake is refused: it is the five-minute bearer of ADR 0014.
  await assert.rejects(ampConnect({ prompt: async () => jwt(1_900_000_000) }), /Expected an amp access token/)
  await assert.rejects(ampConnect({ prompt: async () => "" }), /nothing was saved/)
  assert.equal(validAmpAccessToken("sgamp_user_0123456789abcdefXYZ"), true)
  assert.equal(validAmpAccessToken(jwt(1)), false)
})

test("codex: authorize URL carries codex's own client id, PKCE and originator", () => {
  const u = new URL(codexAuthorizeUrl({ challenge: "ch", state: "st" }))
  assert.equal(u.origin + u.pathname, CODEX.authorizeUrl)
  assert.equal(u.searchParams.get("client_id"), CODEX.clientId)
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback")
  assert.equal(u.searchParams.get("code_challenge"), "ch")
  assert.equal(u.searchParams.get("code_challenge_method"), "S256")
  assert.equal(u.searchParams.get("originator"), "codex_cli_rs")
  assert.equal(u.searchParams.get("scope"), CODEX.scope)
})

test("codex: PKCE callback, state check, exchange, auth.json shape with the bearer's expiry", async () => {
  const exp = 1_900_000_000
  const { fetch, calls } = scripted([
    { url: CODEX.tokenUrl, reply: (init) => (/grant_type=authorization_code&code=the-code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_verifier=/.test(init.body) ? { status: 200, body: { id_token: "id", access_token: jwt(exp), refresh_token: "rt-1" } } : { status: 400, body: { error: "bad" } }) },
  ])
  const listen = () => Promise.resolve({ code: "the-code", state: "st" })
  const r = await codexConnect({ fetch, onCode: () => {}, listen, state: "st", now: () => 1_700_000_000_000 })
  assert.equal(r.secret.auth_mode, "chatgpt")
  assert.equal(r.secret.tokens.refresh_token, "rt-1")
  assert.equal(r.secret.last_refresh, new Date(1_700_000_000_000).toISOString())
  assert.equal(r.expiresAt, new Date(exp * 1000).toISOString())
  assert.equal(calls.length, 1)
  await assert.rejects(codexConnect({ fetch, listen: () => Promise.resolve({ code: "c", state: "other" }), state: "st" }), /different state/)
  await assert.rejects(codexConnect({ fetch, listen: () => Promise.resolve({ error: "access_denied", error_description: "no" }), state: "st" }), /access_denied - no/)
})

test("codex refresh: the request codex sends, and the rotated auth.json that comes back", async () => {
  const { fetch, calls } = scripted([
    { url: CODEX.tokenUrl, reply: { status: 200, body: { id_token: "id2", access_token: jwt(2_000_000_000), refresh_token: "rt-2" } } },
  ])
  const before = { auth_mode: "chatgpt", tokens: { id_token: "id1", access_token: "old", refresh_token: "rt-1", account_id: "acct" } }
  const after = await codexRefresh(before, { fetch, now: () => 1_700_000_000_000 })
  assert.deepEqual(JSON.parse(calls[0].init.body), { client_id: CODEX.clientId, grant_type: "refresh_token", refresh_token: "rt-1", scope: "openid profile email" })
  assert.equal(after.tokens.refresh_token, "rt-2")
  assert.equal(after.tokens.account_id, "acct")
  assert.equal(after.tokens.id_token, "id2")
  const dead = scripted([{ url: CODEX.tokenUrl, reply: { status: 400, body: { error: "invalid_grant" } } }])
  await assert.rejects(codexRefresh(before, { fetch: dead.fetch }), /codex refresh failed \(400: invalid_grant\)/)
})
