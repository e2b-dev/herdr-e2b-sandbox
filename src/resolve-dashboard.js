// Read display settings together for the dashboard's background startup task.
import { loadConfig } from "./config.js"

const cfg = loadConfig()
process.stdout.write(JSON.stringify({
  theme: cfg.dashboardTheme,
  opener: cfg.dashboardConfigOpener,
  domain: cfg.domain || "e2b.dev",
}))
