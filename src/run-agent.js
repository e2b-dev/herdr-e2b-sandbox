// The command `e2b-box run` hands a box to make its agent work ONE task to completion
// and exit, the headless sibling of `[fleet.agents]`.
//
// `[fleet.agents]` starts an agent for a human to sit in front of: an interactive
// TUI in a herdr pane, task typed in afterwards. A cron or a delivery lane has no
// pane and nobody to type, so `run` needs each vendor's non-interactive entry point
// instead, the mode that reads a prompt, works until the turn ends, prints, and
// exits with a code. The two tables are kept apart on purpose: the interactive
// command for a template is not a flag away from its headless one (`claude` vs
// `claude -p`, `codex` vs `codex exec`, `amp` vs `amp -x`), and one table with
// two meanings per row is how the wrong mode gets typed into the wrong place.
//
// THE CONTRACT EVERY COMMAND HERE KEEPS: the task is a FILE in the box, at
// `TASK_FILE`, written over the SDK before the command runs (bin/e2b-box `run`,
// same path bin/e2b-fleet writes its brief to). The command reads it from there,
// `"$(cat …)"` as a positional, or `< …` on stdin, whichever the vendor documents,
// so the task text itself never crosses argv or a shell quoting boundary, and a
// GOAL.md the length of a design doc is the same one line as "fix the bug".
//
// Every default carries that vendor's own skip-approvals flag, for the reason
// `[fleet.agents]` gives: the box is a disposable cloud sandbox with nobody attached
// to approve an edit, and an agent that stops on its first permission prompt has
// produced nothing. The same caveat applies, the box has network egress and holds
// the credential `[templates.<name>.env]` gave it; the protection is a short-lived
// box and a scoped key, not a constrained agent.
//
// Flags verified against each vendor's own docs (claude: code.claude.com/docs/en/headless;
// codex: codex-rs/exec/src/cli.rs; opencode: opencode.ai/docs/cli; amp:
// ampcode.com/docs/cli/execute-mode). A template nobody has verified a headless mode
// for (grok, droid, prime, muse) has NO default: `run` refuses it by name and says
// what to configure, because an invented flag fails to launch and looks exactly like
// an agent that did nothing.
import path from "node:path"
import { pathToFileURL } from "node:url"

import { loadConfig } from "./config.js"

/** Where the task lands inside the box. Single-quoted on purpose: the box's own
 * shell expands `$HOME`, which is how the same string works in a command typed
 * into a pane and in one run over the SDK. */
export const TASK_FILE = '$HOME/.herdr-e2b-task.md'

/** template → the one-line command that works TASK_FILE to completion and exits. */
export const DEFAULT_RUN_AGENTS = {
  // `-p` (--print) is Claude Code's non-interactive mode: exit 0 on success,
  // non-zero on failure, execution errors on stdout. The prompt is the positional.
  claude: `claude --dangerously-skip-permissions -p "$(cat ${TASK_FILE})"`,
  // `codex exec` is the non-interactive subcommand; `-` reads the prompt from
  // stdin. The bypass flag turns off both approvals AND Codex's own OS sandbox,
  // which inside an E2B box only blocks network and out-of-tree writes for nothing.
  codex: `codex exec --dangerously-bypass-approvals-and-sandbox - < ${TASK_FILE}`,
  // `opencode run [message..]` is the scripted mode; `--auto` is its approve-all.
  opencode: `opencode run --auto "$(cat ${TASK_FILE})"`,
  // `-x` (--execute) sends one message, waits for the turn to end, prints the final
  // message and exits; a piped stdin is the message.
  amp: `amp -x --dangerously-allow-all < ${TASK_FILE}`,
}

/**
 * The headless command for `template`, or "" when there is none to run.
 *
 * Looked up by KEY PRESENCE, exactly like `[fleet.agents]` and `[fleet.seed]`: a
 * template mapped to "" in `[run.agents]` is a deliberate "this template has no
 * headless agent" and must not fall back to a shipped default. Pure, takes the
 * overrides, so `node --test` can pin the whole precedence without a config file.
 */
export function runCommand(template, agents = {}) {
  const t = String(template ?? "")
  if (agents && Object.prototype.hasOwnProperty.call(agents, t)) return String(agents[t] ?? "").trim()
  return DEFAULT_RUN_AGENTS[t] ?? ""
}

/** Every template `run` can drive out of the box, for the refusal message. */
export function shippedRunTemplates() {
  return Object.keys(DEFAULT_RUN_AGENTS)
}

// --- CLI ---------------------------------------------------------------------
// bin/e2b-box asks for the command rather than carrying it, so the shell that runs
// inside a box lives in one place and `node --test` can execute it.
//
//   node run-agent.js <template>    prints the command; empty output = no agent
//   node run-agent.js --task-path   prints TASK_FILE, so bash writes the task to
//                                   the same path the commands read
//   node run-agent.js --shipped     one template per line
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = process.argv[2] ?? ""
  if (arg === "--task-path") {
    process.stdout.write(TASK_FILE)
  } else if (arg === "--shipped") {
    process.stdout.write(`${shippedRunTemplates().join("\n")}\n`)
  } else {
    let agents = {}
    try {
      agents = loadConfig().runAgents || {}
    } catch {
      // Unreadable config → the shipped defaults, never a refusal.
    }
    process.stdout.write(runCommand(arg, agents))
  }
}
