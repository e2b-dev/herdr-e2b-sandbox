// Worker: ensure an E2B sandbox exists for a worktree (reconnect to the tracked
// one, or create a fresh one), and optionally upload the local tree into it.
// Launched by bin/e2b-box. Writes live progress into the sandbox record so the pane
// can render a spinner.
//
// Usage: node provision.js '<json>'
//   json: { key, branch, worktreePath, workspaceId, op?, template? }
//   template: explicit choice for a NEW sandbox (picker / --template); overrides
//             the per-branch rules. Ignored when reconnecting to an existing box.
//   op:  "ensure" (default) — reconnect-or-create; upload only a FRESH sandbox, so
//                             reconnecting never clobbers in-sandbox edits.
//        "sync"             — ensure, then always re-upload the local tree.
import { appendFile } from "node:fs/promises"
import { Sandbox, NotFoundError } from "e2b"

import {
  loadConfig,
  resolveTemplate,
  resolveLifecycle,
  resolveEnv,
  unresolvedForwards,
  describeRegion,
  regionForDomain,
  CONFIG_PATH,
} from "./config.js"
import { seedCommand } from "./fleet-seed.js"
import {
  requireApiKey,
  sdkConn,
  warnCredentials,
  notify,
  isMissingTemplateError,
  probeTemplate,
} from "./shared.js"
import { writeRecord, readRecord, logPath } from "./store.js"
import { uploadSnapshot } from "./upload.js"

const input = JSON.parse(process.argv[2] || "{}")
const { key, branch, worktreePath, workspaceId } = input
const op = input.op === "sync" ? "sync" : "ensure"
// Human-facing name (prompt/record). Defaults to the key if the caller didn't
// pass one; the key itself may carry a disambiguating hash suffix.
const displayLabel = (input.label || key).replace(/'/g, "")
if (!key || !worktreePath) {
  console.error("provision: missing key/worktreePath")
  process.exit(2)
}

const cfg = loadConfig()
// Where the worktree lands inside the sandbox. Defaults to /home/user/project
// (config [sandbox].project_path); falls back to /home/user/<key> only if that
// is explicitly blanked.
const projectPath = cfg.projectPath || `/home/user/${key}`
// Metadata is stored on E2B's servers — keep it to non-sensitive identifiers.
// No absolute local path here (it would leak your username / machine layout);
// the full path stays only in the local record on your machine.
const metadata = {
  app: "herdr-e2b",
  herdrWorktreeKey: key,
  herdrBranch: branch || "",
}

async function log(msg) {
  try {
    await appendFile(logPath(key), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // best effort
  }
}

async function step(label, extra = {}) {
  await writeRecord(key, {
    status: "provisioning",
    step: label,
    branch,
    worktreePath,
    workspaceId,
    ...extra,
  })
  await log(label)
  // Foreground callers (e.g. `e2b-box sync`) get live progress; backgrounded
  // workers (open/up) have stderr going to the log file (not a TTY), so this
  // stays quiet there and the spinner reads `step` from the record instead.
  if (process.stderr.isTTY) process.stderr.write(`  ${label}\n`)
}

async function main() {
  requireApiKey(cfg)
  warnCredentials(cfg)
  if (cfg.credWarning) await log(cfg.credWarning)

  let sandbox = null
  let created = false
  const prev = await readRecord(key)
  // Which template the box ACTUALLY runs — the requested one, or `base` when the
  // requested one was not built on this cluster. Held out here because the seeding
  // below needs it and both branches (fresh create, reconnect) can set it.
  let boxTemplate = prev?.template ?? ""
  // A box lives on exactly one cluster, and an API key belongs to exactly one
  // cluster. Touching a domain-pinned box therefore needs credentials KNOWN to
  // be on that cluster — cfg.domain is that knowledge (key + domain resolve as
  // a pair). Two ways it can be missing:
  //   - it resolved to a different cluster: a region flip since the box was
  //     created. Reconnecting is impossible, and creating "the" box would
  //     silently make a SECOND one on the other cluster — alive and billable.
  //   - it resolved to nothing (null): the key matches no `e2b auth login` and
  //     nothing pinned E2B_DOMAIN, so the key's cluster is a guess. Connecting
  //     the box's cluster with it would surface as a bare 401 "Invalid API
  //     key" — this error is that 401, caught early and named.
  // Either way: stop, say why, say how to fix it.
  if (prev?.sandboxId && prev.domain && prev.domain !== cfg.domain) {
    // Same remedies either way — each names a mechanism that ships with the
    // plugin or the `e2b` CLI, so they work on any machine: log in on the box's
    // cluster, pin it for this shell, pin it for good, or give the box up.
    const box = regionForDomain(prev.domain)
    const remedy =
      `Run \`e2b auth login\` against ${prev.domain}, or \`export E2B_DOMAIN=${prev.domain}\` ` +
      `alongside a key from there` +
      (box ? `, or pin \`[sandbox] region = "${box}"\` in ${CONFIG_PATH}` : "") +
      ` — or \`e2b-box kill\` the box first.`
    throw new Error(
      cfg.domain
        ? `box '${key}' was created on ${prev.domain} but this shell resolves to ${cfg.domain}. ` +
          remedy
        : `box '${key}' was created on ${prev.domain}, but the current API key's cluster is ` +
          `unknown (it matches no \`e2b auth login\` and no E2B_DOMAIN is set), so connecting ` +
          `would be rejected as an invalid key. ${remedy}`,
    )
  }
  // Prefer the box's own cluster; only a brand-new box takes the resolved one.
  const domain = prev?.domain || cfg.domain || null
  const conn = sdkConn(cfg, domain)
  if (prev?.sandboxId) {
    notify("E2B", `${op === "sync" ? "Syncing" : "Reconnecting"} sandbox for ${branch || key}…`)
    await step("reconnecting to sandbox")
    try {
      // connect() auto-resumes a paused sandbox (from auto_pause) on its own.
      sandbox = await Sandbox.connect(prev.sandboxId, {
        ...conn,
        timeoutMs: cfg.sandboxTimeoutMs,
      })
    } catch (e) {
      if (e instanceof NotFoundError) {
        // The sandbox is genuinely gone (idle-timed-out / killed) — make a fresh one.
        await log(`sandbox ${prev.sandboxId} not found (${(e && e.message) || e}); creating a fresh one`)
        sandbox = null
      } else {
        // Transient (network / rate-limit / auth). Do NOT create a second sandbox
        // behind the old one (it may still be alive and billable) — surface the
        // error and leave the record intact so the next open retries the reconnect.
        throw e
      }
    }
  }

  if (!sandbox) {
    notify("E2B", `Booting sandbox for ${branch || key}…`)
    // An explicit choice (`e2b-box open --template …`, the picker, E2B_TEMPLATE)
    // beats the per-branch rules; without one, the rules and default decide.
    const template = input.template || resolveTemplate(branch, cfg)
    let usedTemplate = template
    await step(`creating sandbox (${template})`)
    // Resolved once and recorded below: the lifecycle is fixed at create time,
    // so the record — not the config file as it reads later — is what e2b-box's
    // closing messages must describe.
    const lifecycle = resolveLifecycle(cfg)
    const opts = {
      ...conn,
      timeoutMs: cfg.sandboxTimeoutMs,
      metadata,
      lifecycle,
    }
    // Why the template can't be booted, once known — set either by the probe
    // below or by a create that failed. One reason, one fallback, so both routes
    // report identically.
    let unavailable = null

    // Ask before booting. A create has to FAIL before it can tell us a template
    // is missing; asking costs ~50ms. `probeTemplate` answers `false` only when
    // it is sure, and `null` when it can't tell (a foreign-namespace 400, a
    // network blip) — so this can save a doomed create but never cost a box that
    // would have booted. `base` is not probed: it is the fallback itself.
    if (template !== "base" && (await probeTemplate(template, conn)) === false) {
      unavailable = "checked before creating"
    }

    if (!unavailable) {
      try {
        // envs is per-sandbox and per-template: it never enters the image, so a
        // credential here is not baked into anything shareable, and it is resolved
        // fresh on every create rather than read back from the record.
        //
        // process.env is handed IN rather than read by the resolver: a credential
        // `e2b-box auth` recorded by name (never by value) lives in this process's
        // environment and is looked up here, at the one moment it is needed.
        // A name auth.toml recorded that this process cannot resolve is the one
        // failure that arrives disguised as success: the box boots, its agent opens a
        // sign-in screen, and the report that promised the credential still says
        // `key found`. herdr launches plugin commands as `bash -lc`, so a key exported
        // only from ~/.zshrc is present at discovery and absent right here. Named in
        // the log at the exact moment it goes missing — the box is still created,
        // because an unauthenticated box is what was asked for and is still useful.
        for (const missing of unresolvedForwards(cfg, template, process.env)) {
          await log(
            `warning: $${missing} was recorded by 'e2b-box auth' but is not set here, so this box will not get it — export it from ~/.profile (herdr uses a login shell), or set the box's own variable in ${CONFIG_PATH}`,
          )
        }
        sandbox = await Sandbox.create(template, { ...opts, envs: resolveEnv(cfg, template, process.env) })
      } catch (e) {
        // If a custom template isn't built yet, don't hard-fail — fall back to base.
        const msg = (e && e.message) || String(e)
        if (template !== "base" && isMissingTemplateError(msg)) unavailable = msg
        else throw e
      }
    }

    if (unavailable) {
      // Name the REGION, not just the template. "template 'x' not found" is the
      // signature symptom of asking the wrong region, and reads as a missing
      // template unless it says where we looked.
      const where = describeRegion(conn.domain)
      await log(`template '${template}' not found in ${where} (${unavailable}); falling back to 'base'`)
      notify("E2B", `Template '${template}' not found in ${where} — using base`)
      await step("creating sandbox (base — fallback)")
      // `base`'s env, not the requested template's: the box you actually get
      // is a base box, and handing it a credential for an agent it doesn't
      // ship is a secret sent somewhere with no reason to hold it.
      sandbox = await Sandbox.create("base", { ...opts, envs: resolveEnv(cfg, "base", process.env) })
      usedTemplate = "base"
    }
    created = true
    boxTemplate = usedTemplate
    // Persist the cluster with the box, so every later verb (shell, sync, pull,
    // kill, dashboard) acts on the cluster that actually holds it instead of
    // re-resolving from an environment that may have moved on.
    await writeRecord(key, {
      sandboxId: sandbox.sandboxId,
      template: usedTemplate,
      // What this box does at its idle timeout ("pause" or "kill"), and for a
      // pause which snapshot kind — set at create time and immutable, so
      // e2b-box's leave/pull messages read it from here rather than guessing
      // from the current config.
      onTimeout: typeof lifecycle.onTimeout === "string" ? lifecycle.onTimeout : lifecycle.onTimeout.action,
      ...(typeof lifecycle.onTimeout === "object" ? { keepMemory: lifecycle.onTimeout.keepMemory !== false } : {}),
      // Remember a downgrade. Templates are PER-CLUSTER, so asking for one that
      // only exists on another cluster is an easy mistake with a quiet result:
      // a `base` box that looks fine until the agent you wanted isn't installed.
      // e2b-box says this out loud before handing you the shell.
      ...(usedTemplate === template ? { requestedTemplate: "" } : { requestedTemplate: template }),
      ...(conn.domain ? { domain: conn.domain } : {}),
    })
  }

  await step("preparing project dir", { sandboxId: sandbox.sandboxId })
  await sandbox.commands.run(`mkdir -p '${projectPath}'`)

  // Upload the local tree only for a FRESH sandbox (it's empty) or an explicit sync.
  // Reconnecting to an existing sandbox must NOT overwrite in-sandbox edits — pull them
  // down first (`e2b-box pull`) if you want them locally.
  let files = prev?.files ?? 0
  if (created || op === "sync") {
    const { count, viaGit } = await uploadSnapshot({
      sandbox,
      localRoot: worktreePath,
      remoteRoot: projectPath,
      ignore: cfg.ignore,
      batchSize: cfg.batchSize,
      onProgress: (done, total) => step(`uploading ${done}/${total} files`),
    })
    files = count
    await log(`uploaded ${count} files (${viaGit ? "git-tracked, .gitignore honored" : "filesystem walk"})`)

    await step("initializing git")
    const safeBranch = (branch || "main").replace(/'/g, "") // git needs a real ref
    await sandbox.commands.run(
      `cd '${projectPath}' && ` +
        `(git rev-parse --git-dir >/dev/null 2>&1 || git init -b '${safeBranch}') && ` +
        `git add -A >/dev/null 2>&1 || true`,
    )
  }

  // No multiplexer goes into the box (ADR-0008). A pause with a memory snapshot
  // already freezes every process — the plugin's own terminal client
  // (src/attach.js) is what attaches a shell, and nothing in the box needs to
  // hold a session for it. The box stays as thin as its template.
  //
  // Shell personalization — a cyan [e2b:label] prompt, HERDR_E2B markers, and
  // landing in the project dir. Rewritten on EVERY connect (one cheap file
  // write) so a box created before a change picks it up; only the one-time
  // `.bashrc` hook is skipped for a sandbox that already has it. This is also
  // what strips the tmux hand-off out of a box provisioned before ADR-0008 —
  // a leftover `exec tmux` in this file would swallow the new client's shell.
  await step("personalizing shell")
  const rc =
    "# herdr-e2b\n" +
    "export HERDR_E2B=1\n" +
    `export HERDR_E2B_BRANCH='${displayLabel}'\n` +
    `PS1='\\[\\033[1;36m\\][e2b:${displayLabel}]\\[\\033[0m\\] \\w \\$ '\n` +
    `cd '${projectPath}' 2>/dev/null || true\n`
  await sandbox.files.write("/home/user/.herdr-e2b.sh", rc)
  if (created) {
    await sandbox.commands
      .run(
        'for f in .bashrc .bash_profile .profile; do ' +
          'grep -q herdr-e2b "$HOME/$f" 2>/dev/null || ' +
          "echo '[ -f ~/.herdr-e2b.sh ] && . ~/.herdr-e2b.sh' >> \"$HOME/$f\"; done",
      )
      .catch(() => {})
  }

  // The agent's first-run state — the theme picker, the sign-in menu, the trust and
  // bypass disclaimers — written before anything opens the agent.
  //
  // It happens HERE, over the SDK, and not by typing into the pane, because typing
  // has a hard ceiling: `herdr pane run` truncates at 1024 bytes, and the claude
  // command is 1424. It was cut mid-`node -e`, the next typed line was appended to
  // the stump, and the box ran `node -echo …` (observed live, test-9 and test-10).
  // Codex's command is 840 bytes, which is the entire reason it always worked and
  // claude never did.
  //
  // Writing the file also makes the credential rule absolute rather than careful: the
  // command still only ever NAMES `$ANTHROPIC_API_KEY` and lets the box's shell expand
  // it, but now no part of it reaches the pane, the scrollback, or herdr's session
  // files at all. Run from the project dir because the command asks the box for its
  // own `cwd` when recording a per-directory trust decision.
  //
  // Best-effort, every time, for every box: a sandbox whose agent could not be seeded
  // still opens and still works — it just asks its questions.
  const seed = seedCommand(boxTemplate, cfg.fleetSeeds)
  if (seed) {
    await sandbox.files.write("/home/user/.herdr-e2b-seed.sh", `${seed}\n`)
    await sandbox.commands
      .run('bash "$HOME/.herdr-e2b-seed.sh"', { cwd: projectPath })
      .catch(() => {})
  }

  const url = `https://${sandbox.getHost(cfg.serverPort)}`
  await writeRecord(key, {
    status: "ready",
    step: "ready",
    label: displayLabel,
    sandboxId: sandbox.sandboxId,
    url,
    projectPath: projectPath,
    files,
    // Backfills the cluster on records written before domains were tracked
    // (the mismatch guard above already ran, so this can't relabel a box).
    ...(conn.domain ? { domain: conn.domain } : {}),
  })
  await log(`ready · ${sandbox.sandboxId} · ${files} files · ${url}`)
  notify("E2B", `Sandbox ready for ${branch || key}`)
  console.log(JSON.stringify({ ok: true, sandboxId: sandbox.sandboxId, url, files }))
}

main().catch(async (err) => {
  const msg = (err && err.message) || String(err)
  await writeRecord(key, { status: "failed", step: msg })
  await log(`FAILED: ${(err && err.stack) || msg}`)
  notify("E2B", `Sandbox failed for ${branch || key}: ${msg}`)
  process.exit(1)
})
