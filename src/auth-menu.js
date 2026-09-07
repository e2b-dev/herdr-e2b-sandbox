import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { emitKeypressEvents } from "node:readline"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import { AUTH_PATH, CONFIG_PATH, CONNECTIONS_DIR, HERDR_CONFIG_ROOT } from "./config-paths.js"

const AUTH_CLI = fileURLToPath(new URL("auth-cli.js", import.meta.url))
const clean = (value) => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f]/g, " ")

// A picker owns raw mode only while it is visible. Auth and editor subprocesses
// inherit an ordinary terminal, including Ctrl+C and line editing.
export function chooseAuthItem({ count, selected = 0, render, shortcuts = {} }) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    const output = process.stdout
    const wasRaw = input.isRaw
    if (!input.isTTY || !output.isTTY || count < 1) return reject(new Error("The auth picker needs a terminal and at least one item."))
    let index = Math.min(selected, Math.max(0, count - 1))
    let finished = false
    const draw = () => {
      try { output.write(`\x1b[2J\x1b[H${render(index)}`) } catch (error) { done("quit", error) }
    }
    const done = (action, error) => {
      if (finished) return
      finished = true
      input.off("keypress", keypress)
      output.off("resize", draw)
      process.off("SIGTERM", terminate)
      process.off("SIGINT", interrupt)
      input.setRawMode(!!wasRaw)
      input.pause()
      output.write("\x1b[?25h\x1b[?1049l")
      if (error) reject(error)
      else resolve({ action, selected: index })
    }
    const terminate = () => { done("quit"); process.exitCode = 143 }
    const interrupt = () => { done("quit"); process.exitCode = 130 }
    const keypress = (text, key = {}) => {
      if (key.ctrl && key.name === "c") return done("quit")
      if (key.name === "escape" || text === "q") return done("quit")
      if (key.name === "down" || text === "j") index = (index + 1) % count
      else if (key.name === "up" || text === "k") index = (index + count - 1) % count
      else if (/^[1-9]$/.test(text || "") && Number(text) <= count) index = Number(text) - 1
      else if (key.name === "return") return done("select")
      else if (shortcuts[text]) return done(shortcuts[text])
      draw()
    }
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.on("keypress", keypress)
    input.resume()
    output.on("resize", draw)
    process.once("SIGTERM", terminate)
    process.once("SIGINT", interrupt)
    output.write("\x1b[?1049h\x1b[?25l")
    draw()
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options })
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })
}

async function question(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question(prompt)).trim() } finally { rl.close() }
}

export function authMenuActions(agent, connections) {
  const actions = connections.filter((c) => c.harness === agent).map((c) => ({
    id: "reconnect", label: `Reconnect ${c.id}`, connection: c.id,
  }))
  if (["claude", "codex"].includes(agent)) actions.push({ id: "connect", label: agent === "claude" ? "Connect new claude account" : "Connect local codex session" })
  actions.push({ id: "explain", label: "Inspect authentication" },
    { id: "config", label: "Open config.toml (templates / API keys)" },
    { id: "discovery", label: "Open auth.toml (generated sources)" },
    { id: "connections", label: "Open saved connections folder" })
  return actions
}

export async function openAuthConfig(file, configuredOpener) {
  if (file === CONFIG_PATH && !existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try { writeFileSync(file, "# e2b-box configuration\n# Add API keys under [templates.<agent>.env].\n", { flag: "wx", mode: 0o600 }) }
    catch (error) { if (error.code !== "EEXIST") throw error }
  }
  if (!existsSync(file)) throw new Error(`${path.basename(file)} does not exist yet.${file === AUTH_PATH ? " Press s to save discovery first." : ""}`)
  const opener = configuredOpener?.trim() || (process.platform === "darwin" ? 'open "$2"' : 'xdg-open "$2"')
  return run(process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
    ["-ic", opener, "e2b-box-auth", HERDR_CONFIG_ROOT, file], { cwd: HERDR_CONFIG_ROOT })
}

export async function runAuthMenu({ initial, refresh, render, save }) {
  let state = initial
  let selected = 0
  let message = ""
  while (!process.exitCode) {
    const result = await chooseAuthItem({ count: state.summary.length, selected,
      shortcuts: { r: "refresh", s: "save", f: "config", a: "discovery" },
      render: (index) => `${render(state.summary, index)}\n\n  ↑/↓ · j/k move   number jumps   enter actions\n  s save discovery   f config   a auth.toml   r refresh   q/esc quit\n${message ? `\n  ${clean(message)}\n` : ""}`,
    })
    selected = result.selected
    if (result.action === "quit") return
    try {
      let action = { id: result.action }
      const agent = state.summary[selected].id
      if (action.id === "select") {
        const actions = authMenuActions(agent, state.cfg.connections)
        const picked = await chooseAuthItem({ count: actions.length, render: (index) => {
          const rows = actions.map((a, i) => `${i === index ? "  >" : "   "} [${i + 1}] ${clean(a.label)}`)
          return `\n  ${agent} authentication\n\n${rows.join("\n")}\n\n  ↑/↓ · j/k move   number jumps   enter confirm   q/esc back\n`
        } })
        if (picked.action === "quit") continue
        action = actions[picked.selected]
      }
      if (action.id === "refresh") {
        state = await refresh()
        message = "Refreshed"
      } else if (action.id === "save") {
        if (/^y(es)?$/i.test(await question(`\n  Save ${state.plan.entries.length} discovered sources to auth.toml? [y/N] `))) {
          save(state.plan)
          message = "Saved discovery to auth.toml"
        } else message = "Nothing was written"
      } else if (["config", "discovery", "connections"].includes(action.id)) {
        const file = { config: CONFIG_PATH, discovery: AUTH_PATH, connections: CONNECTIONS_DIR }[action.id]
        const code = await openAuthConfig(file, state.cfg.dashboardConfigOpener)
        message = code === 0 ? `Opened ${path.basename(file)} · r refresh after editing` : `Could not open ${path.basename(file)} (exit ${code})`
      } else {
        let args
        if (action.id === "reconnect") args = ["reconnect", action.connection]
        else if (action.id === "connect") {
          args = ["connect", agent]
          if (state.cfg.connections.some((c) => c.harness === agent)) {
            const name = await question("\n  New connection name (blank cancels): ")
            if (!name) continue
            args.push("--name", name)
          }
        } else args = ["explain", "--template", agent]
        const code = await run(process.execPath, [AUTH_CLI, ...args])
        await question("\n  Press Enter to return to coding agents.")
        state = await refresh()
        message = code === 0 ? "" : `Command exited with status ${code}`
      }
    } catch (error) {
      message = clean(error.message)
    }
  }
}
