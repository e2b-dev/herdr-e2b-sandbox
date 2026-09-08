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
  writeFileSync(herdr, `#!/bin/sh
printf "%s\\n" "$@" > "$POPUP_CALLS"
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
    run: (binary, args = [], env = {}) => spawnSync(path.join(root, "bin", binary), args, {
      encoding: "utf8",
      env: { ...process.env, HERDR_PLUGIN_CONTEXT_JSON: "", HERDR_PANE_ID: "", HERDR_BIN_PATH: herdr, HERDR_PLUGIN_STATE_DIR: dir, POPUP_CALLS: calls, ...env },
    }),
  }
}

test("settings actions launch pane and popup views without needing their own terminal", (t) => {
  const f = fixture(t)
  const manifest = TOML.parse(readFileSync(path.join(root, "herdr-plugin.toml"), "utf8"))
  assert.equal(manifest.panes.find((pane) => pane.id === "popup").title, " herdr-e2b-sandbox")
  for (const id of ["dashboard", "popup", "open", "fleet"]) {
    const action = manifest.actions.find((action) => action.id === id)
    const result = spawnSync(action.command[0], action.command.slice(1), {
      encoding: "utf8",
      env: { ...process.env, HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_CONTEXT_JSON: "", HERDR_PANE_ID: "", HERDR_BIN_PATH: f.herdr, HERDR_PLUGIN_STATE_DIR: f.dir, POPUP_CALLS: f.calls },
    })
    assert.equal(result.status, 0, result.stderr)
    const called = readFileSync(f.calls, "utf8").trim().split("\n")
    if (id === "dashboard") {
      assert.deepEqual(called, ["pane", "run", "w1:p1", "e2b-dash"])
    } else if (id === "open" || id === "fleet") {
      assert.deepEqual(called, ["plugin", "pane", "open", "--plugin", manifest.id, "--entrypoint", id === "open" ? "box" : "fleet", "--placement", "split", "--target-pane", "w1:p1", "--direction", "down", "--focus"])
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

test("box and fleet splits follow the invoking pane and focus below it", (t) => {
  const f = fixture(t)
  for (const [binary, entrypoint] of [["e2b-box-open", "box"], ["e2b-fleet-open", "fleet"]]) {
    for (const context of [JSON.stringify({ focused_pane_id: "w2:p3" }), ""]) {
      const result = f.run(binary, [], { HERDR_PLUGIN_CONTEXT_JSON: context, HERDR_PANE_ID: "w3:p4" })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n"), [
        "plugin", "pane", "open", "--plugin", "e2b-dev.herdr-e2b", "--entrypoint", entrypoint,
        "--placement", "split", "--target-pane", context ? "w2:p3" : "w3:p4", "--direction", "down", "--focus",
      ])
    }
    assert.equal(f.run(binary, [], { POPUP_EXIT: "1", HERDR_PANE_ID: "w3:p4" }).status, 1)
  }
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
  assert.equal(f.run("e2b-box-open", ["--placement", "left"]).status, 2)
  assert.equal(f.run("e2b-box-open", ["--box"]).status, 2)
  assert.equal(f.run("e2b-box-open", ["--nope"]).status, 2)
})

test("[dashboard].popup_open reaches the dashboard's settings, anything else means below", (t) => {
  const f = fixture(t)
  for (const [value, expected] of [['"tab"', "tab"], ['"right"', "right"], ['"left"', "below"], [null, "below"]]) {
    writeFileSync(path.join(f.dir, "config.toml"), value === null ? "" : `[dashboard]\npopup_open = ${value}\n`)
    const result = spawnSync(process.execPath, [path.join(root, "src/resolve-dashboard.js")], {
      encoding: "utf8",
      env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: f.dir, HERDR_PLUGIN_STATE_DIR: f.dir },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).popup_open, expected, `popup_open = ${value}`)
  }
})
