// Print the resolved E2B credentials for the bash layer, one `NAME=value` per
// line (empty values omitted). Used by bin/lib/paths.sh to feed the `e2b` CLI
// without depending on ~/.zshrc — herdr spawns plugin commands as `bash -lc`,
// a login shell that reads ~/.profile and never a zsh rc, so anything a zsh
// hook exports (an E2B region switch, say) is simply absent there.
//
// Replaces the older resolve-key.js: the key alone was never enough — a key
// without its cluster is how you provision on the wrong one.
import { loadConfig } from "./config.js"

// A broken config (an unknown [sandbox] region, say) is a user error with a
// fixable message, not a crash. The bash layer folds our stderr into the
// terminal, so print the message alone — a stack trace here buries the one line
// that says what to change.
let cfg
try {
  cfg = loadConfig()
} catch (err) {
  process.stderr.write(`${(err && err.message) || String(err)}\n`)
  process.exit(1)
}
if (cfg.apiKey) process.stdout.write(`E2B_API_KEY=${cfg.apiKey}\n`)
if (cfg.domain) process.stdout.write(`E2B_DOMAIN=${cfg.domain}\n`)
if (cfg.credWarning) process.stderr.write(`${cfg.credWarning}\n`)
