// Print the configured dashboard theme ([dashboard].theme), if any.
// Used by bin/e2b-dash to seed the TUI's default theme. Prints nothing (exit 0)
// when unset — the TUI then falls back to a saved choice or "terminal".
import { loadConfig } from "./config.js"

const theme = loadConfig().dashboardTheme
if (theme) process.stdout.write(String(theme))
