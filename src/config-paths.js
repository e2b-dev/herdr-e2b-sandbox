import os from "node:os"
import path from "node:path"

export const HERDR_CONFIG_ROOT = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "herdr",
)
export const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(HERDR_CONFIG_ROOT, "plugins/config/e2b-dev.herdr-e2b")
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.toml")
export const AUTH_PATH = path.join(CONFIG_DIR, "auth.toml")
export const CONNECTIONS_DIR = path.join(CONFIG_DIR, "connections")
