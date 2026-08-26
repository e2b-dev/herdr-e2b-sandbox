// First-run state for the agent inside a member's box.
//
// A member's credential arrives as an environment variable (`[templates.<name>.env]`
// → `Sandbox.create`'s `envs`), but a fresh sandbox has no first-run *state*, so the
// agent runs its welcome wizard anyway: Claude Code asks which theme you like because
// `~/.claude.json` does not exist, and Codex offers its sign-in menu because it reads
// its credential from `~/.codex/auth.json`, not from the environment. Three members
// means three wizards to click through, which is the opposite of what a fleet is for.
//
// So each member's box is handed ONE shell command, just before its agent command is
// typed, that writes that state itself.
//
// THE RULE THAT SHAPES EVERY COMMAND HERE: the secret must never appear in the pane,
// the scrollback, or herdr's session files. The key is ALREADY inside the box as an
// environment variable, so a command may only ever carry the variable's NAME and let
// the box's own shell expand it. Anything interpolated on the host side and sent
// through `pane run` would be readable in the pane forever.
//
// Three more properties every command must keep:
//   · ONE LINE — it is typed into a shell (`pane run` is send-text plus Enter), so a
//     newline would submit half a command.
//   · POSIX sh, no backslashes, no backticks — it crosses argv, a JS string, bash and
//     a pty, and each of those is one more place an escape can be eaten.
//   · Never clobber. If the file is already there the box is a resumed member and the
//     state is the user's, so it is left exactly as it is.
//
// A missing key is not a failure: the file is still written where that helps (Claude's
// onboarding is state, not a credential), and the box says so once, itself, in the
// pane the user is already looking at. It is the box's own environment that decides,
// which is the only thing that can actually know.
//
// Also runnable as bin/e2b-fleet's lookup helper (see the CLI at the bottom):
//   node src/fleet-seed.js <template>
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "./config.js"

// Schemas below were read off a real machine, not guessed:
//
//   ~/.claude.json        hasCompletedOnboarding (bool), theme (string), autoUpdates
//                         (bool), customApiKeyResponses = {approved:[], rejected:[]}
//                         where an approved entry is the LAST 20 CHARACTERS of the key
//                         it approves — which is why the tail is computed in the box,
//                         from the variable, and is the only part of a key that is
//                         ever written down. Only ANTHROPIC_API_KEY has a tail to
//                         approve: the prompt this answers is "use this API key?",
//                         and a CLAUDE_CODE_OAUTH_TOKEN never raises it. That is also
//                         why the box only says it is unauthenticated when BOTH are
//                         absent — a subscription machine has no key and needs none. `projects.<dir>.hasTrustDialogAccepted`
//                         is the per-directory trust prompt; `$PWD` is the member's
//                         project dir, so the box fills that in for itself too.
//                         `bypassPermissionsModeAccepted` is the Bypass Permissions
//                         disclaimer — a SECOND wizard, behind the first: the agent
//                         command this plugin ships is `claude
//                         --dangerously-skip-permissions`, and without this key the
//                         flag stops at a 1/2 menu ("Permission mode downgraded to
//                         default — bypass requires accepting the disclaimer
//                         interactively first"). Pre-accepting it is a decision, not
//                         an oversight: the disclaimer asks for a disposable VM with
//                         no state worth losing, which is the literal definition of
//                         the sandbox it is being written into. The three keys above
//                         plus this one are the exact set Claude Code's own eval
//                         harness writes when it provisions a headless home.
//   ~/.codex/auth.json    {auth_mode, OPENAI_API_KEY, tokens, last_refresh}. For
//                         key-based auth the mode is "apikey"; `tokens` and
//                         `last_refresh` belong to the OAuth flow and are omitted
//                         rather than faked.
//
//   ~/.claude/settings.json
//                         `skipDangerousModePermissionPrompt` (bool) — the flag whose
//                         only job is suppressing the Bypass Permissions disclaimer,
//                         read from four scopes (user / local / flag / policy) and
//                         checked BEFORE `bypassPermissionsModeAccepted`. Both are
//                         written because they are not interchangeable: the accepted
//                         flag is a record of a click, and its key name is only as old
//                         as the version that introduced it, while a box's image may
//                         ship an older Claude Code (a member on v2.1.201 still showed
//                         the disclaimer with the accepted flag set — observed live).
//                         This one is the documented switch, so it is the one that has
//                         to be there.
//
// EXISTENCE IS NOT THE TEST. The claude image ships its own ~/.claude.json without
// `hasCompletedOnboarding`, so 'skip if the file is there' left the wizard on screen
// (observed live). Seed on STATE instead, and MERGE: keep whatever the box already
// had, add only what the wizard is waiting for, and bail out when it is already done.
//
// Written as template literals ONLY because they contain both quote kinds and no `${`
// or backtick — check that still holds before editing one.
export const DEFAULT_SEEDS = {
  claude: `k=$(printf %s "$ANTHROPIC_API_KEY" | tail -c 20); [ -n "$k" ] || [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || echo "herdr-e2b: no ANTHROPIC_API_KEY and no CLAUDE_CODE_OAUTH_TOKEN in this box - claude starts unauthenticated"; node -e 'const f=process.env.HOME+"/.claude.json",fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}if(c.hasCompletedOnboarding===true&&c.bypassPermissionsModeAccepted===true){console.log("herdr-e2b: claude onboarding already done - leaving it alone");process.exit(0)}c.hasCompletedOnboarding=true;c.bypassPermissionsModeAccepted=true;if(!c.theme)c.theme="dark";if(c.autoUpdates===undefined)c.autoUpdates=false;const k=process.argv[1];if(k){c.customApiKeyResponses=c.customApiKeyResponses||{};const a=c.customApiKeyResponses.approved||[];if(!a.includes(k))a.push(k);c.customApiKeyResponses.approved=a;c.customApiKeyResponses.rejected=c.customApiKeyResponses.rejected||[]}c.projects=c.projects||{};c.projects[process.cwd()]=Object.assign({},c.projects[process.cwd()],{hasTrustDialogAccepted:true});fs.writeFileSync(f,JSON.stringify(c))' "$k"; node -e 'const fs=require("fs"),d=process.env.HOME+"/.claude",f=d+"/settings.json";let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}if(s.skipDangerousModePermissionPrompt===true){console.log("herdr-e2b: claude already skips the bypass disclaimer - leaving it alone");process.exit(0)}s.skipDangerousModePermissionPrompt=true;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(f,JSON.stringify(s))'`,
  // Session FIRST, key as the fallback (ADR 0010). $CODEX_AUTH_JSON carries a whole
  // auth.json — the user's own signed-in session, with its single-use refresh token
  // already replaced by a placeholder host-side — so the box writes the file
  // verbatim. Only the variable's NAME is here; the box's shell expands it, and
  // nothing secret reaches the pane. Falling back to the api-key shape keeps every
  // box that has no session behaving exactly as it did before.
  //
  // The clobber guard moved from "does this file mention OPENAI_API_KEY" to "is
  // there a file at all": a resumed box signed in with a session has no such string
  // in it, and the old test would have overwritten the user's live login with a
  // freshly seeded one on every reconnect.
  //
  // Two pieces of state, not one. The key answers the sign-in menu; the trust
  // entry answers the SECOND prompt — "Do you trust the contents of this
  // directory?" — which Codex asks per working directory before it will load
  // project-scoped config, and which no credential and no launch flag removes.
  // Its schema is `projects."<abs path>".trust_level = "trusted"` in
  // ~/.codex/config.toml (Codex config reference). Appended, never rewritten: the
  // file may already carry a model or an MCP server the image put there.
  codex: `mkdir -p "$HOME/.codex"; if [ -s "$HOME/.codex/auth.json" ]; then echo "herdr-e2b: codex is already authenticated - leaving it alone"; elif [ -n "$CODEX_AUTH_JSON" ]; then printf %s "$CODEX_AUTH_JSON" > "$HOME/.codex/auth.json" && chmod 600 "$HOME/.codex/auth.json" && echo "herdr-e2b: codex signed in with your borrowed session"; elif [ -n "$OPENAI_API_KEY" ]; then printf '{"auth_mode":"apikey","OPENAI_API_KEY":"%s"}' "$OPENAI_API_KEY" > "$HOME/.codex/auth.json" && chmod 600 "$HOME/.codex/auth.json"; else echo "herdr-e2b: no codex credential in this box - codex starts unauthenticated"; fi; mkdir -p "$HOME/.codex"; node -e 'const fs=require("fs"),p=process.cwd(),f=process.env.HOME+"/.codex/config.toml",NL=String.fromCharCode(10),h="[projects."+JSON.stringify(p)+"]";let t="";try{t=fs.readFileSync(f,"utf8")}catch{}if(t.includes(h)){console.log("herdr-e2b: codex already trusts "+p+" - leaving it alone");process.exit(0)}fs.appendFileSync(f,NL+h+NL+"trust_level = "+JSON.stringify("trusted")+NL)'`,
  // Session FIRST, exactly codex's shape one entry up: $GROK_AUTH_JSON carries the
  // user's whole ~/.grok/auth.json — refresh token INCLUDED, which is safe for grok
  // alone (measured multi-use, ADR 0011) and is what lets the box re-mint its own
  // six-hour bearers instead of dying on the first one. Schema read off a real
  // laptop file (2026-08-26). XAI_API_KEY needs no file at all — grok reads it from
  // the environment — so the key branch only says what the box is running on.
  grok: `mkdir -p "$HOME/.grok"; if [ -s "$HOME/.grok/auth.json" ]; then echo "herdr-e2b: grok is already authenticated - leaving it alone"; elif [ -n "$GROK_AUTH_JSON" ]; then printf %s "$GROK_AUTH_JSON" > "$HOME/.grok/auth.json" && chmod 600 "$HOME/.grok/auth.json" && echo "herdr-e2b: grok signed in with your borrowed session"; elif [ -n "$XAI_API_KEY" ]; then echo "herdr-e2b: grok authenticates from XAI_API_KEY - no file to seed"; else echo "herdr-e2b: no grok credential in this box - grok starts unauthenticated"; fi`,
  // Not a wizard — an UPDATER. opencode updates itself in the background and then
  // puts a modal over the pane ("Successfully updated to vX. Please restart the
  // application.", observed live on test-12). That is worse than a first-run prompt,
  // because it does not appear at startup: it lands whenever the release does, so it
  // can cover the prompt a fleet task is being typed into, minutes in.
  //
  // Pinning the image instead only moves the date. The switch is in the binary:
  //     if (cfg.autoupdate === false || env.OPENCODE_DISABLE_AUTOUPDATE) return
  // The config half is used because `=== false` is unambiguous, while the env half
  // parses whatever it is handed. Schema read off a real ~/.config/opencode/
  // opencode.json (`$schema: https://opencode.ai/config.json`), and merged, because
  // that file is also where a model, providers and MCP servers live.
  // Droid authenticates from FACTORY_API_KEY in the environment (verified live),
  // so the credential needs no seeding at all — but a trusted folder does. Droid
  // asks "Trust this folder?" for the project dir before it will read, edit or run
  // anything, and that is a keypress a fleet member has nobody to make.
  //
  // Schema read out of BOTH shipped binaries (0.172.0 and 0.196.0 — identical trust
  // logic) and off a file droid wrote itself, after a first attempt copied the wrong
  // shape and left every fleet droid sitting on the prompt (observed live, t-21).
  // On disk ~/.factory/settings.json IS the "general" section, flat — droid's
  // persist path unwraps the in-memory `{general: …}` hierarchy before writing.
  // The decision is a TOP-LEVEL `trustedFolders`: a record of absolute path →
  // {trustedAt: ISO string}, zod-validated —
  //     PG8 = G.object({trustedAt: G.string()}), KG8 = G.record(PG8)
  // — and matched with `Object.keys(H).some(...)` as exact-or-ancestor prefix, so
  // an array of strings never matches (its keys are "0","1"). The key droid checks
  // is `canonicalize(findGitRootForPath(cwd) ?? cwd)` — realpath'd, walked up to
  // the nearest .git — so the seed computes exactly that for itself, in the box.
  // Merged, not written flat: the same file carries model settings and fallbacks.
  droid: `node -e 'const fs=require("fs"),q=require("path"),d=process.env.HOME+"/.factory",f=d+"/settings.json",rp=function(x){try{return fs.realpathSync(x)}catch{return x}};let g=rp(process.cwd()),x=g;for(;;){if(fs.existsSync(q.join(x,".git"))){g=x;break}const n=q.dirname(x);if(n===x)break;x=n}let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}let t=s.trustedFolders;if(!t||typeof t!=="object"||Array.isArray(t))t={};if(t[g]){console.log("herdr-e2b: droid already trusts "+g+" - leaving it alone");process.exit(0)}t[g]={trustedAt:new Date().toISOString()};s.trustedFolders=t;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(f,JSON.stringify(s))'`,
  opencode: `node -e 'const fs=require("fs"),d=process.env.HOME+"/.config/opencode",f=d+"/opencode.json";let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}if(c.autoupdate===false){console.log("herdr-e2b: opencode autoupdate already off - leaving it alone");process.exit(0)}c.autoupdate=false;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(f,JSON.stringify(c))'`,
}

/**
 * The command that seeds `template`'s first-run state, or "" for nothing to seed.
 *
 * Looked up by KEY PRESENCE, exactly like `[fleet.agents]`: a template mapped to the
 * empty string is a deliberate "seed nothing" and must not fall back to the default.
 * A template nobody has verified a schema for (`amp`, `prime`, …) has no
 * default — inventing one would write junk into somebody's home directory — so it
 * seeds nothing until `[fleet.seed]` says what to run.
 */
export function seedCommand(template, seeds = {}) {
  const t = String(template ?? "")
  if (seeds && Object.prototype.hasOwnProperty.call(seeds, t)) return seeds[t]
  return DEFAULT_SEEDS[t] ?? ""
}

// --- CLI ---------------------------------------------------------------------
// bin/e2b-fleet asks for the command rather than carrying it, so the shell that
// runs inside a box lives in one place and `node --test` can execute it.
// Prints the command (empty output = seed nothing) and always exits 0: a member
// whose first-run state could not be resolved still boots and still gets its agent.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let seeds = {}
  try {
    seeds = loadConfig().fleetSeeds || {}
  } catch {
    // Unreadable config → the shipped defaults, never a refusal.
  }
  process.stdout.write(seedCommand(process.argv[2], seeds))
}
