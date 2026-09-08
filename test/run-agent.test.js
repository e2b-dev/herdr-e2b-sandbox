import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

import { DEFAULT_RUN_AGENTS, TASK_FILE, runCommand, shippedRunTemplates } from "../src/run-agent.js"

const script = fileURLToPath(new URL("../src/run-agent.js", import.meta.url))

// --- which command a template is run with ------------------------------------
// Same key-presence rule as `[fleet.agents]` and `[fleet.seed]`: "no headless
// agent" is a choice a user can make for a template, and a choice must not fall
// back to a default the moment it is spelled as the empty string.

test("runCommand: a template with a verified headless mode gets it", () => {
  assert.equal(runCommand("claude"), DEFAULT_RUN_AGENTS.claude)
  assert.equal(runCommand("codex"), DEFAULT_RUN_AGENTS.codex)
  assert.equal(runCommand("opencode"), DEFAULT_RUN_AGENTS.opencode)
  assert.equal(runCommand("amp"), DEFAULT_RUN_AGENTS.amp)
})

test("runCommand: a template nobody has verified a headless mode for runs nothing", () => {
  // An invented flag fails to launch and reads exactly like an agent that did
  // nothing, so these wait for `[run.agents]` to say what to run, including the
  // ones `[fleet.agents]` DOES start interactively.
  for (const t of ["base", "grok", "droid", "prime", "muse", "", undefined, null]) {
    assert.equal(runCommand(t), "", `${t}: expected no default`)
  }
})

test("runCommand: [run.agents] overrides a default, and \"\" switches it off", () => {
  const agents = { claude: "", muse: `muse --yolo "$(cat ${TASK_FILE})"` }
  assert.equal(runCommand("claude", agents), "")
  assert.equal(runCommand("muse", agents), `muse --yolo "$(cat ${TASK_FILE})"`)
  // A template the override says nothing about still gets its default.
  assert.equal(runCommand("codex", agents), DEFAULT_RUN_AGENTS.codex)
  // Whitespace is not a command.
  assert.equal(runCommand("claude", { claude: "   " }), "")
})

test("shippedRunTemplates: exactly the templates with a default, for the refusal message", () => {
  assert.deepEqual(shippedRunTemplates().sort(), Object.keys(DEFAULT_RUN_AGENTS).sort())
})

// --- what a shipped command may contain --------------------------------------

test("every shipped command reads the task from TASK_FILE and is one line", () => {
  for (const [template, cmd] of Object.entries(DEFAULT_RUN_AGENTS)) {
    // The task is a file in the box, written over the SDK; a command that does
    // not read it would run the agent with no task at all.
    assert.ok(cmd.includes(TASK_FILE), `${template}: does not read ${TASK_FILE}`)
    // It is handed to `sandbox.commands.run` as one string.
    assert.ok(!cmd.includes("\n"), `${template}: contains a newline`)
  }
})

test("TASK_FILE is the path bin/e2b-fleet writes its brief to, single-quoted for the box's shell", () => {
  // bin/e2b-fleet: TASK_FILE='$HOME/.herdr-e2b-task.md'. Pinned so the two verbs
  // keep handing the box the same file.
  assert.equal(TASK_FILE, "$HOME/.herdr-e2b-task.md")
})

// --- the CLI bin/e2b-box calls ------------------------------------------------

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(E2B_|HERDR_|XDG_)/.test(k)))
    execFile(process.execPath, [script, ...args], { env: { ...base, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

test("CLI: --task-path prints the path, --shipped the templates, <template> the command", async () => {
  assert.deepEqual(await cli(["--task-path"]), { code: 0, stdout: TASK_FILE, stderr: "" })
  const shipped = await cli(["--shipped"])
  assert.equal(shipped.code, 0)
  assert.deepEqual(shipped.stdout.trim().split("\n").sort(), shippedRunTemplates().sort())
  assert.deepEqual(await cli(["codex"]), { code: 0, stdout: DEFAULT_RUN_AGENTS.codex, stderr: "" })
  // Empty output, exit 0: the caller decides what "no agent" means.
  assert.deepEqual(await cli(["base"]), { code: 0, stdout: "", stderr: "" })
})
