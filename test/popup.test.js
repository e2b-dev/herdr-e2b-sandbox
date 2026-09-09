import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import TOML from "@iarna/toml"

const root = path.resolve(import.meta.dirname, "..")

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "e2b-popup-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const herdr = path.join(dir, "herdr")
  const calls = path.join(dir, "calls")
  // `open`'s action asks `e2b-box pick --needed` before choosing popup or pane; a
  // pinned menu of three keeps that answer independent of this machine's config.
  const config = path.join(dir, "config")
  mkdirSync(config)
  writeFileSync(path.join(config, "config.toml"), '[sandbox]\ntemplate = "base"\ntemplates = ["claude", "codex", "base"]\n')
  writeFileSync(herdr, `#!/bin/sh
printf "%s\\n" "$@" > "$POPUP_CALLS"
printf "%s\\n" "$*" >> "$POPUP_CALLS.all"
case "$1 $2" in
  "pane list") printf '%s\\n' '{"result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","focused":true}]}}' ;;
  "pane process-info") printf '%s\\n' '{"result":{"process_info":{"foreground_processes":[{"name":"zsh"}]}}}' ;;
esac
exit "\${POPUP_EXIT:-0}"
`, { mode: 0o755 })
  return {
    calls,
    herdr,
    dir,
    config,
    run: (binary, args = [], env = {}) => spawnSync(path.join(root, "bin", binary), args, {
      encoding: "utf8",
      env: { ...process.env, E2B_TEMPLATE: "", HERDR_PLUGIN_CONTEXT_JSON: "", HERDR_PANE_ID: "", HERDR_BIN_PATH: herdr, HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: config, POPUP_CALLS: calls, ...env },
    }),
  }
}

// The popup opened as a config surface: what bin/lib/pane.sh `pane_open_popup` asks herdr for.
const popupCall = (mode, origin, cwd) => [
  "plugin", "pane", "open", "--plugin", "e2b-dev.herdr-e2b", "--entrypoint", "popup", "--placement", "popup", "--width", "90%", "--height", "85%",
  "--env", "E2B_DASH_POPUP=1", "--env", `E2B_POPUP_MODE=${mode}`, "--env", `E2B_DASH_ORIGIN_PANE=${origin}`, "--cwd", cwd, "--env", `E2B_PICK_CWD=${cwd}`,
]

test("settings actions launch pane and popup views without needing their own terminal", (t) => {
  const f = fixture(t)
  const manifest = TOML.parse(readFileSync(path.join(root, "herdr-plugin.toml"), "utf8"))
  assert.equal(manifest.panes.find((pane) => pane.id === "popup").title, " herdr-e2b-sandbox")
  for (const id of ["dashboard", "popup", "open", "fleet"]) {
    const action = manifest.actions.find((action) => action.id === id)
    const result = spawnSync(action.command[0], action.command.slice(1), {
      encoding: "utf8",
      env: { ...process.env, E2B_TEMPLATE: "", HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_CONTEXT_JSON: "", HERDR_PANE_ID: "", HERDR_BIN_PATH: f.herdr, HERDR_PLUGIN_STATE_DIR: f.dir, HERDR_PLUGIN_CONFIG_DIR: f.config, POPUP_CALLS: f.calls },
    })
    assert.equal(result.status, 0, result.stderr)
    const called = readFileSync(f.calls, "utf8").trim().split("\n")
    if (id === "dashboard") {
      assert.deepEqual(called, ["pane", "run", "w1:p1", "e2b-dash"])
    } else if (id === "open" || id === "fleet") {
      // Both actions put their questions in the popup, over the invoking pane, about
      // the worktree the action ran in (here: the plugin root, the process cwd).
      assert.deepEqual(called, popupCall(id === "open" ? "pick-box" : "pick-fleet", "w1:p1", process.cwd()))
    } else {
      assert.deepEqual(called, ["plugin", "pane", "open", "--plugin", manifest.id, "--entrypoint", "popup", "--placement", "popup", "--width", "90%", "--height", "85%", "--env", "E2B_DASH_POPUP=1", "--env", "E2B_DASH_ORIGIN_PANE=w1:p1"])
    }
  }
})

test("popup opens the existing dashboard in a floating terminal, including through e2b-box", (t) => {
  const f = fixture(t)
  // The origin pane is the invoking pane (plugin context, then HERDR_PANE_ID,
  // then focus) — the same resolution the box/fleet splits use.
  for (const [binary, args, env, origin] of [
    [["e2b-popup"], [], {}, "w1:p1"],
    [["e2b-box"], ["popup"], {}, "w1:p1"],
    [["e2b-popup"], [], { HERDR_PANE_ID: "w3:p4" }, "w3:p4"],
    [["e2b-popup"], [], { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w2:p3" }), HERDR_PANE_ID: "w3:p4" }, "w2:p3"],
  ]) {
    const result = f.run(binary[0], args, env)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n"), [
      "plugin", "pane", "open", "--plugin", "e2b-dev.herdr-e2b", "--entrypoint", "popup",
      "--placement", "popup", "--width", "90%", "--height", "85%",
      "--env", "E2B_DASH_POPUP=1", "--env", `E2B_DASH_ORIGIN_PANE=${origin}`,
    ])
  }
})

test("popup still opens when no origin pane can be found", (t) => {
  const f = fixture(t)
  writeFileSync(f.herdr, `#!/bin/sh
printf "%s\\n" "$@" > "$POPUP_CALLS"
case "$1 $2" in
  "pane list") printf '%s\\n' '{"result":{"panes":[]}}' ;;
esac
`, { mode: 0o755 })
  const result = f.run("e2b-popup")
  assert.equal(result.status, 0, result.stderr)
  const called = readFileSync(f.calls, "utf8").trim().split("\n")
  assert.deepEqual(called.slice(-2), ["--env", "E2B_DASH_POPUP=1"])
})

test("popup help and invalid arguments never contact Herdr", (t) => {
  const f = fixture(t)
  assert.equal(f.run("e2b-box", ["popup", "--help"]).status, 0)
  assert.equal(f.run("e2b-popup", ["--unknown"]).status, 2)
  assert.throws(() => readFileSync(f.calls), { code: "ENOENT" })
})

test("popup reports Herdr failures instead of claiming it opened", (t) => {
  const f = fixture(t)
  assert.equal(f.run("e2b-popup", [], { POPUP_EXIT: "1" }).status, 1)
})

test("native popup renders directly with plugin paths and credential precedence, without contacting Herdr", (t) => {
  const f = fixture(t)
  const plugin = path.join(f.dir, "plugin with spaces")
  mkdirSync(path.join(plugin, "bin/lib"), { recursive: true })
  for (const file of ["e2b-popup", "lib/paths.sh", "lib/pane.sh"]) {
    copyFileSync(path.join(root, "bin", file), path.join(plugin, "bin", file))
  }
  writeFileSync(path.join(plugin, "bin/e2b-dash"), `#!/bin/sh
printf '%s\\n' "$HERDR_PLUGIN_ID" "$HERDR_PLUGIN_ROOT" "$HERDR_PLUGIN_CONFIG_DIR" "$HERDR_PLUGIN_STATE_DIR" "$E2B_DASH_POPUP"
`, { mode: 0o755 })
  const config = path.join(f.dir, "custom config")
  const result = spawnSync("bash", [path.join(plugin, "bin/e2b-popup"), "--render"], {
    encoding: "utf8",
    env: { ...process.env, HERDR_PLUGIN_CONTEXT_JSON: "", HERDR_PANE_ID: "", HERDR_BIN_PATH: f.herdr, POPUP_CALLS: f.calls, HERDR_PLUGIN_STATE_DIR: f.dir, HERDR_PLUGIN_CONFIG_DIR: config },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split("\n"), ["e2b-dev.herdr-e2b", realpathSync(plugin), config, f.dir, "1"])
  assert.throws(() => readFileSync(f.calls), { code: "ENOENT" })
  assert.equal(f.run("e2b-popup", ["--render", "unexpected"]).status, 2)
})

test("box and fleet actions open the popup over the invoking pane, about its worktree", (t) => {
  const f = fixture(t)
  for (const [binary, mode] of [["e2b-box-open", "pick-box"], ["e2b-fleet-open", "pick-fleet"]]) {
    for (const context of [JSON.stringify({ focused_pane_id: "w2:p3" }), ""]) {
      const result = f.run(binary, [], { HERDR_PLUGIN_CONTEXT_JSON: context, HERDR_PANE_ID: "w3:p4" })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n"), popupCall(mode, context ? "w2:p3" : "w3:p4", process.cwd()))
    }
    // The context's cwd is the worktree the popup is about, not where the action happens to run.
    const ctx = JSON.stringify({ focused_pane_id: "w2:p3", focused_pane_cwd: f.dir })
    assert.equal(f.run(binary, [], { HERDR_PLUGIN_CONTEXT_JSON: ctx }).status, 0)
    assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n"), popupCall(mode, "w2:p3", f.dir))
    // No popup to be had: the pane below, as before. Both attempts failing is a failure.
    assert.equal(f.run(binary, [], { POPUP_EXIT: "1", HERDR_PANE_ID: "w3:p4" }).status, 1)
  }
})

test("--render in pick-box mode hands the answer to a pane under the origin and exits, closing the popup", (t) => {
  const f = fixture(t)
  const repo = path.join(f.dir, "repo")
  mkdirSync(repo)
  spawnSync("git", ["-C", repo, "init", "-q"])
  spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"])
  // No terminal here, so the picker cannot draw: pick answers with the key alone and
  // the hand-off opens the box plain. With E2B_TEMPLATE set the answer is that name.
  for (const [env, extra] of [[{}, []], [{ E2B_TEMPLATE: "codex" }, ["--env", "E2B_TEMPLATE=codex"]]]) {
    const result = spawnSync("bash", [path.join(root, "bin/e2b-popup"), "--render"], {
      encoding: "utf8",
      env: {
        ...process.env, E2B_TEMPLATE: "", HERDR_PLUGIN_CONTEXT_JSON: "", HERDR_PANE_ID: "", HERDR_BIN_PATH: f.herdr, HERDR_PLUGIN_STATE_DIR: f.dir,
        HERDR_PLUGIN_CONFIG_DIR: f.config, POPUP_CALLS: f.calls, E2B_POPUP_MODE: "pick-box", E2B_PICK_CWD: repo, E2B_DASH_ORIGIN_PANE: "w2:p3", ...env,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const called = readFileSync(f.calls, "utf8").trim().split("\n")
    assert.deepEqual(called.slice(0, 13), [
      "plugin", "pane", "open", "--plugin", "e2b-dev.herdr-e2b", "--entrypoint", "box", "--placement", "split", "--target-pane", "w2:p3", "--direction", "down",
    ])
    assert.equal(called[13], "--focus")
    assert.deepEqual(called.slice(14, 16), ["--cwd", repo])
    assert.equal(called[16], "--env")
    assert.match(called[17], /^KEY=repo-[0-9a-f]{8}$/)
    assert.deepEqual(called.slice(18), extra)
  }
})

test("the popup picker's hand-off carries what was picked into the box pane's environment", (t) => {
  const f = fixture(t)
  const result = f.run("e2b-box-open", ["--target-pane", "w5:p6", "--placement", "below", "--cwd", "/tmp/w", "--box", "k1", "--template", "codex", "--reasoning", "high", "--model", "gpt-5.5"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n"), [
    "plugin", "pane", "open", "--plugin", "e2b-dev.herdr-e2b", "--entrypoint", "box", "--placement", "split", "--target-pane", "w5:p6", "--direction", "down", "--focus",
    "--cwd", "/tmp/w", "--env", "KEY=k1", "--env", "E2B_TEMPLATE=codex", "--env", "E2B_REASONING=high", "--env", "E2B_MODEL=gpt-5.5",
  ])
  // Empty picks are not passed on: an unchosen effort must not become an empty pin.
  assert.equal(f.run("e2b-box-open", ["--target-pane", "w5:p6", "--box", "k1", "--template", "codex", "--reasoning", "", "--model", ""]).status, 0)
  assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n").slice(-4), ["--env", "KEY=k1", "--env", "E2B_TEMPLATE=codex"])
})

test("the popup's Enter opens the box where [dashboard].popup_open says, pinned to that box", (t) => {
  const f = fixture(t)
  // Explicit target beats context and focus: inside a popup both name the popup.
  const env = { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w9:p9" }), HERDR_PANE_ID: "w9:p9" }
  const tail = ["--focus", "--cwd", "/tmp/work tree", "--env", "KEY=tree-abc12345"]
  for (const [placement, expected] of [
    [[], ["--placement", "split", "--target-pane", "w5:p6", "--direction", "down"]],
    [["--placement", "below"], ["--placement", "split", "--target-pane", "w5:p6", "--direction", "down"]],
    [["--placement", "right"], ["--placement", "split", "--target-pane", "w5:p6", "--direction", "right"]],
    [["--placement", "tab"], ["--placement", "tab", "--target-pane", "w5:p6"]],
  ]) {
    const result = f.run("e2b-box-open", ["--target-pane", "w5:p6", ...placement, "--cwd", "/tmp/work tree", "--box", "tree-abc12345"], env)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n"), [
      "plugin", "pane", "open", "--plugin", "e2b-dev.herdr-e2b", "--entrypoint", "box", ...expected, ...tail,
    ])
  }
  // above/left: herdr only splits down/right, so the new pane trades places
  // with the origin afterwards. A failed swap is a warning, not a failed open.
  for (const [placement, direction] of [["above", "down"], ["left", "right"]]) {
    rmSync(`${f.calls}.all`, { force: true })
    const result = f.run("e2b-box-open", ["--target-pane", "w5:p6", "--placement", placement, "--box", "tree-abc12345"], env)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(`${f.calls}.all`, "utf8").trim().split("\n"), [
      `plugin pane open --plugin e2b-dev.herdr-e2b --entrypoint box --placement split --target-pane w5:p6 --direction ${direction} --focus --env KEY=tree-abc12345`,
      `pane swap --pane w5:p6 --direction ${direction}`,
    ])
  }
  assert.equal(f.run("e2b-box-open", ["--placement", "up"]).status, 2)
  assert.equal(f.run("e2b-box-open", ["--box"]).status, 2)
  assert.equal(f.run("e2b-box-open", ["--nope"]).status, 2)
})

test("[dashboard].popup_open reaches the dashboard's settings, anything else means below", (t) => {
  const f = fixture(t)
  for (const [value, expected] of [['"tab"', "tab"], ['"right"', "right"], ['"above"', "above"], ['"left"', "left"], ['"up"', "below"], [null, "below"]]) {
    writeFileSync(path.join(f.dir, "config.toml"), value === null ? "" : `[dashboard]\npopup_open = ${value}\n`)
    const result = spawnSync(process.execPath, [path.join(root, "src/resolve-dashboard.js")], {
      encoding: "utf8",
      env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: f.dir, HERDR_PLUGIN_STATE_DIR: f.dir },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).popup_open, expected, `popup_open = ${value}`)
  }
})

test("picker refresh returns input without asking or contacting Herdr, and headless render keeps its handoff", (t) => {
  const f = fixture(t)
  const reply = path.join(f.dir, "picker-input")
  const result = f.run("e2b-box", ["pick"], { E2B_PICKER_INPUT: reply })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^herdr-e2b-sandbox-[0-9a-f]{8}\n\n$/)
  const fields = readFileSync(reply).toString().split("\0")
  assert.equal(fields[1], process.cwd())
  assert.equal(fields[4], "base")
  assert.equal(fields[5], "base\nclaude\ncodex")
  assert.match(fields[8], /codex\|/)
  assert.throws(() => readFileSync(f.calls), { code: "ENOENT" })

  const rendered = f.run("e2b-popup", ["--render"], { E2B_POPUP_MODE: "pick-box", E2B_PICK_CWD: process.cwd() })
  assert.equal(rendered.status, 0, rendered.stderr)
  assert.doesNotMatch(rendered.stdout, /E2B template/)
  assert.match(readFileSync(f.calls, "utf8"), /KEY=herdr-e2b-sandbox-/)
})

test("fleet refresh fills the same worktree cache without asking or creating members", (t) => {
  const f = fixture(t)
  const reply = path.join(f.dir, "picker-input")
  assert.equal(f.run("e2b-box", ["pick"], { E2B_PICKER_INPUT: reply }).status, 0)
  const before = readFileSync(reply).toString().split("\0")
  const result = f.run("e2b-box", ["fleet"], { E2B_PICKER_INPUT: reply })
  assert.equal(result.status, 0, result.stderr)
  const after = readFileSync(reply).toString().split("\0")
  assert.deepEqual(after.slice(0, 9), before.slice(0, 9))
  assert.equal(after[10], "claude\ncodex")
  assert.match(after[13], /codex\|/)
  assert.throws(() => readFileSync(f.calls), { code: "ENOENT" })
})

test("startup warms both picker inputs for restored pane directories without opening anything", (t) => {
  const f = fixture(t)
  const repos = [path.join(f.dir, "focused repo"), path.join(f.dir, "other repo")]
  for (const repo of repos) {
    mkdirSync(repo)
    spawnSync("git", ["-C", repo, "init", "-q"])
  }
  writeFileSync(f.herdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$POPUP_CALLS"
printf '%s\\n' '${JSON.stringify({ result: { panes: repos.map(cwd => ({ cwd, foreground_cwd: cwd })) } })}'
`, { mode: 0o755 })
  const manifest = TOML.parse(readFileSync(path.join(root, "herdr-plugin.toml"), "utf8"))
  assert.deepEqual(manifest.startup[0].command, ["bash", "bin/e2b-picker-warm", "--all"])
  assert.deepEqual(manifest.events.find(e => e.on === "workspace.created").command, ["bash", "bin/e2b-picker-warm"])
  const result = f.run("e2b-picker-warm", ["--all"], {
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: repos[0] }), KEY: "unrelated-box", E2B_TEMPLATE: "pinned-elsewhere",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(f.calls, "utf8"), "pane list\n")
  for (const repo of repos) {
    const cache = path.join(f.dir, "pickers", ...repo.split("/").filter(Boolean).map(p => `d-${p}`), "input")
    const fields = readFileSync(cache).toString().split("\0")
    assert.equal(fields[1], repo)
    assert.equal(fields[5], "base\nclaude\ncodex")
    assert.equal(fields[10], "claude\ncodex")
  }
})
