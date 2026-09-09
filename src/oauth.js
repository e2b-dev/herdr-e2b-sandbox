// The plugin's OWN sign-in to a vendor, stored as a connection (ADR 0015).
//
// Every other credential this plugin handles is one it FOUND: a variable in the
// environment, a key in a harness's config file, a session a harness left on disk
// (ADR 0009, 0010, 0011). This module is the one place the plugin signs in itself,
// using the same public OAuth client each vendor's CLI uses, so what comes back is a
// login the laptop's own CLI never touches: it rotates nothing on the laptop and the
// laptop rotates nothing under it. The result is stored under `connections/`
// (ADR 0013) and delivered like any other connection.
//
// What each vendor yields, and why it is that and not a session:
//   muse   Meta's device flow, then Meta's own "mint a Muse API key" call. A key,
//          no refresh, no expiry the plugin has to track. This is exactly what
//          `muse login` does for itself.
//   amp    no OAuth at all: amp's long-lived access token (`sgamp_…`) can only be
//          read behind the web app's recent-sign-in gate, so the plugin opens that
//          page and stores what the human pastes. The reasons are measured, below.
//   codex  Codex CLI's PKCE flow against auth.openai.com, its own client id. A
//          ten-day bearer plus a single-use refresh token, of which the plugin is the
//          sole custodian: boxes get the placeholder rule's copy (ADR 0010), the
//          plugin refreshes on `auth check` / `auth reconnect`, and never at
//          box-create time, so provisioning stays synchronous and pure.
//
// The flows are written against injectable `fetch`, `open`, `now` and `sleep` so
// test/oauth.test.js runs every one of them against a scripted server with no
// network and no browser. Nothing here prints; the CLI decides what a human sees.
//
// Every request body below is data the vendor's own CLI sends. Client ids are
// PUBLIC clients (no secret exists), copied from the shipped CLIs — the same ids
// replicas-cli 0.2.634 uses for the same purpose.

import { createHash, randomBytes } from "node:crypto"
import http from "node:http"

/** `{ code_verifier, code_challenge }` for PKCE S256, base64url per RFC 7636. */
export function pkcePair(bytes = randomBytes(32)) {
  const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const verifier = b64url(bytes)
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) }
}

/** `exp` of a JWT as ISO, or null when the token is not a decodable JWT. */
export function jwtExpiryIso(token) {
  try {
    const seg = String(token).split(".")[1]
    const pad = "=".repeat((4 - (seg.length % 4)) % 4)
    const j = JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8"))
    return Number.isFinite(j?.exp) ? new Date(j.exp * 1000).toISOString() : null
  } catch {
    return null
  }
}

const form = (o) => new URLSearchParams(o).toString()
const FORM = { "Content-Type": "application/x-www-form-urlencoded" }
const JSON_H = { "Content-Type": "application/json", Accept: "application/json" }

async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}

/**
 * RFC 8628 device flow, shared by muse (Meta) and amp (WorkOS): ask for a code, hand
 * the human a URL, poll until the vendor answers with tokens.
 *
 * `onCode({ url, userCode, expiresIn })` is the CLI's hook to print and/or open the
 * URL. `authorization_pending` and `slow_down` are the only errors that keep polling;
 * anything else is the vendor saying no, and the message names it.
 */
export async function deviceFlow({ authorizeUrl, tokenUrl, clientId, extra = {}, onCode, fetch, sleep, now = Date.now }) {
  const start = await fetch(authorizeUrl, { method: "POST", headers: FORM, body: form({ client_id: clientId, ...extra }) })
  const device = await readJson(start)
  if (!start.ok || typeof device?.device_code !== "string" || typeof device?.user_code !== "string") {
    throw new Error(`sign-in could not start (${start.status}${device?.error ? `: ${device.error}` : ""})`)
  }
  const url = typeof device.verification_uri_complete === "string" ? device.verification_uri_complete : device.verification_uri
  const expiresIn = Number.isFinite(device.expires_in) ? device.expires_in : 600
  await onCode?.({ url, userCode: device.user_code, expiresIn })
  const deadline = now() + expiresIn * 1000
  let interval = Math.max(1, Number.isFinite(device.interval) ? device.interval : 5) * 1000
  while (now() < deadline) {
    await sleep(interval)
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: FORM,
      body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: clientId }),
    })
    const body = await readJson(res)
    if (res.ok && typeof body?.access_token === "string") return body
    if (body?.error === "slow_down") {
      interval += 5000
      continue
    }
    if (body?.error === "authorization_pending") continue
    throw new Error(body?.error === "access_denied" ? "sign-in was denied in the browser" : `sign-in failed: ${body?.error_description || body?.error || res.status}`)
  }
  throw new Error("sign-in expired before it was approved in the browser")
}

// ─── muse ─────────────────────────────────────────────────────────────────────

export const MUSE = {
  clientId: "1031625952748946",
  authorizeUrl: "https://auth.meta.com/oidc/device/authorization/",
  tokenUrl: "https://auth.meta.com/oidc/device/token/",
  keyUrl: "https://api.meta.ai/muse-code/key",
}

/**
 * Sign in with a Meta account, then have Meta mint a Muse API key for it. Returns
 * `{ META_API_KEY }` — a key, which is what `[templates.muse.env]` and the muse
 * harness row already know how to deliver.
 */
export async function museConnect({ fetch, sleep, onCode, now }) {
  const tokens = await deviceFlow({ ...MUSE, extra: {}, onCode, fetch, sleep, now })
  const res = await fetch(MUSE.keyUrl, {
    method: "POST",
    headers: { ...JSON_H, Authorization: `Bearer ${tokens.access_token}`, "x-api-version": "1.0.0" },
    body: "{}",
  })
  const body = await readJson(res)
  if (!res.ok) throw new Error(`Muse did not issue an API key (${res.status}${body?.message ? `: ${body.message}` : ""})`)
  if (typeof body?.api_key !== "string" || !body.api_key) {
    throw new Error(`Muse did not issue an API key.${typeof body?.action_url === "string" ? ` Finish setup at ${body.action_url} and connect again.` : ""}`)
  }
  return { secret: { kind: "api-key", META_API_KEY: body.api_key }, expiresAt: null }
}

// ─── amp ──────────────────────────────────────────────────────────────────────
//
// amp is the harness where the plugin's own sign-in buys nothing, and it is worth
// recording why so nobody re-derives it. `amp login` is a WorkOS device flow
// (`authapi.ampcode.com/user_management/authorize/device`, client
// `client_01JNSEYM3V0J5AXK4YXNXRXTGP`) and the plugin can run it; the result is the
// five-minute bearer plus rotating refresh token ADR 0014 measured. The credential a
// box needs is the long-lived ACCESS TOKEN (`sgamp_…`) the Security settings page
// shows, and that page reads it through a SvelteKit remote function
// (`POST /_app/remote/…/getAccessToken`) which (a) accepts only the browser's cookie
// session, never a bearer ("Authentication required"), (b) refuses cross-site
// callers, and (c) demands a RECENT sign-in ("REAUTH_REQUIRED") — all measured live,
// 2026-09-09. Nothing a CLI holds satisfies that, by design: it is amp's sudo gate.
//
// So `auth connect amp` opens that page and takes the token the human pastes. One
// paste, once; the token lives until they rotate it, and N boxes can hold it.

export const AMP = {
  settingsUrl: "https://ampcode.com/settings/security#access-token",
}

/** `sgamp_…`: amp's long-lived access token, the only amp credential a connection stores. */
export function validAmpAccessToken(value) {
  return typeof value === "string" && /^sgamp_[A-Za-z0-9_-]{16,}$/.test(value)
}

/**
 * Open amp's Security page and take the pasted token. `prompt` is the CLI's
 * readline (injected, so tests pass a value); `onCode` is the same hook the device
 * flows use, here carrying the page URL and no code.
 */
export async function ampConnect({ onCode, prompt }) {
  await onCode?.({ url: AMP.settingsUrl, userCode: null, expiresIn: 600 })
  const value = String((await prompt?.("Paste the access token from that page: ")) ?? "").trim()
  if (!validAmpAccessToken(value)) throw new Error("Expected an amp access token (sgamp_…); nothing was saved.")
  return { secret: { kind: "api-key", AMP_API_KEY: value }, expiresAt: null }
}

// ─── codex ────────────────────────────────────────────────────────────────────

export const CODEX = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  callbackPort: 1455,
  callbackPath: "/auth/callback",
  scope: "openid profile email offline_access",
}

/** The browser URL for one PKCE attempt; `state` and `challenge` are the caller's. */
export function codexAuthorizeUrl({ challenge, state, port = CODEX.callbackPort }) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CODEX.clientId,
    redirect_uri: `http://localhost:${port}${CODEX.callbackPath}`,
    scope: CODEX.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex_cli_rs",
  })
  return `${CODEX.authorizeUrl}?${q}`
}

/** The `~/.codex/auth.json` shape codex reads, from a token response. */
export function codexAuthJson(tokens, now = Date.now) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: tokens.id_token, access_token: tokens.access_token, refresh_token: tokens.refresh_token, account_id: tokens.account_id },
    last_refresh: new Date(now()).toISOString(),
  }
}

/**
 * Codex's refresh grant, the request codex-rs itself sends. Returns a NEW auth.json
 * (new bearer, new single-use refresh token). Whoever calls this owns the chain:
 * the old refresh token is dead afterwards, which is why only the plugin ever does.
 */
export async function codexRefresh(authJson, { fetch, now = Date.now }) {
  const res = await fetch(CODEX.tokenUrl, {
    method: "POST",
    headers: JSON_H,
    body: JSON.stringify({ client_id: CODEX.clientId, grant_type: "refresh_token", refresh_token: authJson?.tokens?.refresh_token, scope: "openid profile email" }),
  })
  const body = await readJson(res)
  if (!res.ok || typeof body?.access_token !== "string") throw new Error(`codex refresh failed (${res.status}${body?.error ? `: ${body.error}` : ""}) - sign in again with auth reconnect`)
  return codexAuthJson({ ...authJson.tokens, ...body, account_id: authJson?.tokens?.account_id }, now)
}

/**
 * Codex CLI's own sign-in: PKCE, a localhost callback on codex's port, the token
 * exchange. Resolves to `{ secret: <auth.json object>, expiresAt }` where expiresAt
 * is the bearer's. `listen` is injectable so the test can drive the callback
 * without a socket; the default binds codex's port on 127.0.0.1.
 */
export async function codexConnect({ fetch, onCode, now = Date.now, listen = listenOnce, port = CODEX.callbackPort, pkce = pkcePair(), state = randomBytes(16).toString("hex") }) {
  const url = codexAuthorizeUrl({ challenge: pkce.challenge, state, port })
  const callback = listen({ port, path: CODEX.callbackPath })
  await onCode?.({ url, userCode: null, expiresIn: 600 })
  const q = await callback
  if (q.error) throw new Error(`sign-in failed: ${q.error}${q.error_description ? ` - ${q.error_description}` : ""}`)
  if (q.state !== state) throw new Error("sign-in returned a different state than it was given - possible CSRF, nothing was saved")
  if (!q.code) throw new Error("sign-in returned no authorization code")
  const res = await fetch(CODEX.tokenUrl, {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", code: q.code, redirect_uri: `http://localhost:${port}${CODEX.callbackPath}`, client_id: CODEX.clientId, code_verifier: pkce.verifier }),
  })
  const tokens = await readJson(res)
  if (!res.ok || typeof tokens?.access_token !== "string") throw new Error(`token exchange failed (${res.status}${tokens?.error ? `: ${tokens.error}` : ""})`)
  return { secret: codexAuthJson(tokens, now), expiresAt: jwtExpiryIso(tokens.access_token) }
}

/** One HTTP request on 127.0.0.1:<port><path>, its query as an object, then the server closes. */
export function listenOnce({ port, path: expected }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`)
      if (u.pathname !== expected) {
        res.writeHead(404).end("Not Found")
        return
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end("<!doctype html><title>herdr-e2b</title><p>Signed in. You can close this tab and return to the terminal.</p>")
      server.close()
      resolve(Object.fromEntries(u.searchParams))
    })
    server.on("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is in use - close any other codex sign-in and try again`) : e))
    server.listen(port, "127.0.0.1")
  })
}

/** Which harnesses `auth connect --oauth` knows, and the connect function for each. */
export const OAUTH_CONNECT = { muse: museConnect, amp: ampConnect, codex: codexConnect }
