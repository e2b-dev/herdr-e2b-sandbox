// Does every configured agent key actually work?
//
//   node scripts/verify-keys.mjs [template ...]
//
// One throwaway sandbox per template, booted with exactly the env a fleet member
// would get, running that agent's HEADLESS one-shot with a trivial prompt. The
// agent has to come back with a specific word, so this proves the whole path —
// key accepted, provider reachable, model answering — rather than just that a
// binary exists.
//
// Why this is worth its own script: a bad key does not fail at spawn. The member
// boots, the box is green, and the agent sits on a sign-in screen its pane never
// shows you until you look. Two minutes here beats a fleet of members that each
// quietly did nothing.
//
// THE RULE: a key is never printed, never logged, and never passed on a command
// line. It goes into `Sandbox.create`'s `envs` and is referred to only by the
// NAME of its variable and its length. Output is safe to paste anywhere.
import { Sandbox } from "e2b"
import { loadConfig, resolveEnv } from "../src/config.js"
import { seedCommand } from "../src/fleet-seed.js"

// The word each agent must say back. Short, unmistakable, and nothing an error
// message would produce on its own.
const WORD = "HERDRE2BOK"
const PROMPT = `reply with exactly this word and nothing else: ${WORD}`

// Headless invocations, taken from commands already verified against real boxes
// (harness-bench's agents.ts for claude/codex/grok/amp; a live probe for prime).
// `keyvar` is what the check reports on — the variable whose presence decides
// whether this template is worth booting at all.
const CHECKS = {
  claude: { keyvar: "ANTHROPIC_API_KEY", cmd: (p) => `claude --dangerously-skip-permissions -p ${p}` },
  codex: {
    keyvar: "OPENAI_API_KEY",
    cmd: (p) => `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${p}`,
  },
  grok: { keyvar: "XAI_API_KEY", cmd: (p) => `grok --always-approve -p ${p}` },
  amp: { keyvar: "AMP_API_KEY", cmd: (p) => `amp --dangerously-allow-all -x ${p}` },
  prime: { keyvar: "PRIME_API_KEY", cmd: (p) => `prime-agent -p ${p}` },
  // Droid installs to ~/.local/bin, which a non-interactive shell does not have
  // on PATH (its own .bashrc export sits below the interactivity guard).
  droid: { keyvar: "FACTORY_API_KEY", cmd: (p) => `export PATH=$HOME/.local/bin:$PATH; droid exec ${p}` },
  // opencode speaks several providers, so there is no single variable to demand —
  // whichever one is configured is the one it will use. Reported rather than
  // required: with none of them it falls through to its bundled Zen provider and
  // never answers, which is what the word check catches.
  opencode: { keyvar: "", anyOf: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"], cmd: (p) => `opencode run ${p}` },
}

// Single-quoted for the box's shell. The prompt is ours and contains no quotes,
// but building it by hand is how a future edit introduces one.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

const cfg = loadConfig()
const only = process.argv.slice(2)
const templates = (only.length ? only : Object.keys(CHECKS)).filter((t) => {
  if (CHECKS[t]) return true
  console.log(`skip ${t} — no headless check defined for it`)
  return false
})

const conn = { apiKey: cfg.apiKey, ...(cfg.domain ? { domain: cfg.domain } : {}) }

async function verify(template) {
  const check = CHECKS[template]
  const envs = resolveEnv(cfg, template) || {}
  const key = check.keyvar ? envs[check.keyvar] : undefined

  // Reported, never guessed at: an unset key and a placeholder somebody pasted
  // around are different problems with the same symptom.
  if (check.keyvar && !key) return { template, ok: false, note: `${check.keyvar} not configured` }
  if (key && /PASTE|…/.test(key)) return { template, ok: false, note: `${check.keyvar} is still a placeholder` }

  let sbx
  try {
    sbx = await Sandbox.create(template, { ...conn, envs, timeoutMs: 300000 })

    // Seed first, exactly as src/provision.js does. Not optional dressing: Codex
    // reads its credential from ~/.codex/auth.json, NOT from the environment, so
    // without this it reaches api.openai.com with no bearer at all and 401s while
    // a perfectly good key sits in the box. Verifying the un-seeded path would
    // report a broken key that the real fleet uses fine.
    const seed = seedCommand(template, cfg.fleetSeeds)
    if (seed) {
      await sbx.files.write("/home/user/.herdr-e2b-seed.sh", `${seed}\n`)
      await sbx.commands.run('bash "$HOME/.herdr-e2b-seed.sh"', { cwd: "/home/user" }).catch(() => {})
    }

    const r = await sbx.commands.run(check.cmd(shq(PROMPT)), { timeoutMs: 180000, cwd: "/home/user" })
    const out = `${r.stdout || ""}${r.stderr || ""}`
    if (out.includes(WORD)) {
      if (check.keyvar) return { template, ok: true, note: `${check.keyvar} accepted (${key.length} chars)` }
      // No single required variable — say which one it actually had.
      const via = (check.anyOf || []).find((v) => envs[v])
      return {
        template,
        ok: true,
        note: via ? `${via} accepted (${envs[via].length} chars)` : "answered with no key configured",
      }
    }
    // The tail, not the head: a sign-in screen and a rate-limit both say what
    // they are at the end. Trimmed hard so a TUI dump can't bury the verdict.
    return { template, ok: false, note: `no "${WORD}" in output — ${out.trim().split("\n").slice(-3).join(" / ").slice(0, 240)}` }
  } catch (e) {
    // A non-zero exit throws, and the agent's own explanation is in the THROWN
    // object, not its message — `exit status 1` on its own tells you nothing
    // about whether the key was rejected or the CLI wanted a different flag.
    const body = `${e?.result?.stdout || e?.stdout || ""}${e?.result?.stderr || e?.stderr || ""}`.trim()
    const tail = body ? body.split("\n").filter(Boolean).slice(-4).join(" / ") : String(e?.message || e)
    return { template, ok: false, note: tail.slice(0, 300) }
  } finally {
    // Always. A verification run that leaves boxes behind bills for the privilege.
    await sbx?.kill().catch(() => {})
  }
}

console.log(`verifying ${templates.length} template(s) — one sandbox each, killed on the way out\n`)
const results = await Promise.all(templates.map(verify))

let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? "✓" : "✗"} ${r.template.padEnd(9)} ${r.note}`)
}
console.log(`\n${results.length - failed}/${results.length} usable`)
process.exit(failed ? 1 : 0)
