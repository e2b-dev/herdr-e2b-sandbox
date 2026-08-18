#!/usr/bin/env bash
# Shared paths for herdr-e2b scripts. Source this from bin/* scripts.
PLUGIN_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Keep IN SYNC with src/store.js and tui/src/main.rs so the writer, e2b-box, and
# the dashboard all agree on where box records live.
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-${HERDR_E2B_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/herdr-e2b}}"
# Same rule for config: herdr's HERDR_PLUGIN_CONFIG_DIR is the documented home
# for user-editable config, so it wins over the XDG path it happens to point at.
# Keep IN SYNC with src/config.js and install.sh.
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/herdr-e2b}"
BOXES_DIR="$STATE_DIR/boxes"
mkdir -p "$BOXES_DIR" 2>/dev/null || true

# The plugin's version, read from the manifest so `--version` on any binary and
# the version herdr's marketplace shows can never drift apart. Prints "unknown"
# rather than failing: a missing manifest must not take out a running command.
plugin_version() {
  local v
  v=$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$PLUGIN_DIR/herdr-plugin.toml" 2>/dev/null | head -1)
  printf '%s' "${v:-unknown}"
}

# Sanitize a string to filesystem/metadata-safe chars.
e2b_key() {
  local raw="$1"
  printf '%s' "$raw" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//'
}

# Collision-free box key for an absolute path: "<folder>-<hash8>". The folder
# name keeps records readable; the hash of the full path disambiguates two
# folders that share a basename (which would otherwise collide on one record and
# let removing one kill the other's box). Keep in sync with e2b-box/teardown.
box_key() {
  local p base h
  p="$1"
  base=$(e2b_key "$(basename "$p")")
  h=$(printf '%s' "$p" | shasum -a 256 2>/dev/null | cut -c1-8)
  [ -n "$h" ] || h=$(printf '%s' "$p" | cksum | tr -cd '0-9' | cut -c1-8)
  printf '%s-%s' "${base:-box}" "$h"
}

# System (non-$HOME) bin dirs to probe, in order. A variable rather than a
# literal so the offline tests can aim the system half of discovery at a
# fabricated tree instead of whatever node the runner happens to have installed.
HERDR_E2B_SYS_BIN_DIRS="${HERDR_E2B_SYS_BIN_DIRS:-/opt/homebrew/bin /usr/local/bin /usr/bin}"

# Every place a node-managed binary ($1: "node" or "e2b") can live, one per line.
# Covers the version managers people actually use plus the distro/Homebrew paths;
# unmatched globs come through literally, so callers must test each with -x.
# ONE list so the runtime and the CLI are never probed in different places.
e2b_bin_candidates() {
  local bin="$1" data="${XDG_DATA_HOME:-$HOME/.local/share}" sys
  printf '%s\n' \
    "$HOME"/.nvm/versions/node/v*/bin/"$bin" \
    "$data"/mise/installs/node/*/bin/"$bin" \
    "$data"/fnm/node-versions/*/installation/bin/"$bin" \
    "$HOME/Library/Application Support"/fnm/node-versions/*/installation/bin/"$bin" \
    "$HOME"/.volta/bin/"$bin" \
    "$HOME"/.asdf/installs/nodejs/*/bin/"$bin"
  for sys in $HERDR_E2B_SYS_BIN_DIRS; do printf '%s\n' "$sys/$bin"; done
}

# Resolve a Node >= 22. The `e2b` SDK require()s an ESM-only chalk, which older
# node (e.g. herdr may launch under v20) can't load — provision.js then dies at
# import. Prefer $HERDR_E2B_NODE, then PATH node if new enough, then the NEWEST
# qualifying node found across the version managers in e2b_bin_candidates.
# Prints the node path, or exits non-zero if none is >= 22 (callers must then
# name HERDR_E2B_NODE as the remedy — it's the only escape hatch left).
e2b_node() {
  local ok='process.exit(+process.versions.node.split(".")[0]>=22?0:1)'
  # One exec per candidate does both jobs: gate on >= 22, and print a sortable
  # rank so the newest wins instead of whichever the glob happened to list last
  # (lexicographic order puts v9 after v22).
  local rank='const v=process.versions.node.split(".").map(Number);if(v[0]>=22)console.log(v[0]*1000000+v[1]*1000+v[2])'
  if [ -n "${HERDR_E2B_NODE:-}" ] && "$HERDR_E2B_NODE" -e "$ok" 2>/dev/null; then
    printf '%s' "$HERDR_E2B_NODE"; return 0
  fi
  if command -v node >/dev/null 2>&1 && node -e "$ok" 2>/dev/null; then
    command -v node; return 0
  fi
  local d r best="" best_r=0
  # Heredoc, not a pipe: a pipeline would run the loop in a subshell and $best
  # would never escape it.
  while IFS= read -r d; do
    [ -x "$d" ] || continue
    r=$("$d" -e "$rank" 2>/dev/null) || continue
    [ -n "$r" ] || continue
    if [ "$r" -gt "$best_r" ] 2>/dev/null; then best="$d"; best_r="$r"; fi
  done <<EOF
$(e2b_bin_candidates node)
EOF
  [ -n "$best" ] && { printf '%s' "$best"; return 0; }
  return 1
}

# Put a Node >= 22 (and the `e2b` CLI beside it) first on PATH, so the CLI is
# found AND runs under a node its SDK supports. herdr may launch under an older
# node whose PATH lacks both — without this, `e2b sandbox connect` isn't found
# (pane exits) or crashes at import. Safe to call repeatedly.
ensure_e2b_path() {
  local n d e
  n=$(e2b_node 2>/dev/null) && d=$(dirname "$n") || d=""
  # Best case: one bin dir has both a good node and e2b (e.g. an nvm version).
  if [ -n "$d" ] && [ -x "$d/e2b" ]; then
    case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH"; export PATH ;; esac
    return 0
  fi
  [ -n "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH"; export PATH ;; esac
  command -v e2b >/dev/null 2>&1 && return 0
  # Same locations as the runtime probe — a teammate's `e2b` is installed next to
  # their mise/fnm/volta/asdf node, not only next to an nvm or Homebrew one.
  while IFS= read -r e; do
    [ -x "$e" ] && { PATH="$(dirname "$e"):$PATH"; export PATH; return 0; }
  done <<EOF
$(e2b_bin_candidates e2b)
EOF
  return 1
}

# Kill a sandbox via the SDK (node kill.js), not the e2b CLI — so the CLI is only
# needed for the interactive shell. Best-effort; needs a Node >= 22. Returns
# non-zero only if a real kill error occurred (already-gone counts as success).
sdk_kill() {
  local sid="$1" domain="${2:-}" node_bin
  [ -n "$sid" ] || return 0           # nothing to kill → success
  # No usable Node → could NOT kill (callers keep the record). Say why here: the
  # callers' message is about the kill, so without this the node remedy is lost.
  node_bin=$(e2b_node) || {
    echo "  ! needs Node >= 22 to kill (set HERDR_E2B_NODE=/path/to/node)" >&2; return 1
  }
  # kill.js exits 0 when the sandbox is killed OR already gone, non-zero on a real
  # failure — so callers must only delete the record on success. $2 is the box's
  # cluster: kill the wrong one and it reports "already gone" while the real box
  # keeps running and billing.
  "$node_bin" "$PLUGIN_DIR/src/kill.js" "$sid" "$domain"
}

# Make sure the `e2b` CLI has BOTH halves of its credentials: the key and the
# cluster it belongs to. Env wins; anything missing is resolved by
# src/resolve-env.js (plugin config, then the `e2b` CLI login).
#
# Both matter because herdr runs plugin commands as `bash -lc` — a login shell
# that never reads ~/.zshrc — so a region set up by a zsh hook is invisible here
# and the SDK would quietly fall back to its default cluster.
#
# Optional arg: a domain from a box record, which wins over the resolved one so
# every verb acts on the cluster that actually holds that box.
ensure_e2b_env() {
  local box_domain="${1:-}" line node_bin
  if [ -z "${E2B_API_KEY:-}" ] || [ -z "${E2B_DOMAIN:-}" ]; then
    # e2b_node, not bare `node`: under `bash -lc` a version-managed node (mise,
    # nvm, volta) is often not on PATH at all, and silently resolving nothing is
    # how the credentials go missing in the first place.
    node_bin=$(e2b_node 2>/dev/null || command -v node 2>/dev/null || true)
    if [ -n "$node_bin" ]; then
      while IFS= read -r line; do
        case "$line" in
          E2B_API_KEY=*) [ -z "${E2B_API_KEY:-}" ] && export E2B_API_KEY="${line#E2B_API_KEY=}" ;;
          E2B_DOMAIN=*)  [ -z "${E2B_DOMAIN:-}" ]  && export E2B_DOMAIN="${line#E2B_DOMAIN=}" ;;
        esac
      done <<EOF
$("$node_bin" "$PLUGIN_DIR/src/resolve-env.js" 2>/dev/null || true)
EOF
    fi
  fi
  # A tracked box outranks everything: it lives where it was created.
  [ -n "$box_domain" ] && export E2B_DOMAIN="$box_domain"
  return 0
}

# Back-compat alias — older call sites only ever wanted the key.
ensure_e2b_key() { ensure_e2b_env "$@"; }

# Filter for the `e2b` CLI's stderr. A paused or expired sandbox is an ordinary
# outcome here — we detect it and reprovision — but the CLI reports it as an
# unhandled rejection: eight frames of SDK/commander internals through Homebrew
# paths, which buries the one line that says what happened and reads like a
# crash in this plugin. Keep the cause, drop the frames.
#
# awk, not sed: this filters a LIVE stream feeding an interactive shell, and it
# has to flush per line rather than block-buffer.
e2b_quiet_stderr() {
  awk '
    # Stack frames: "    at Function.connectSandbox (/opt/homebrew/...)".
    /^[[:space:]]*at [A-Za-z_$]/     { next }
    /^[[:space:]]*at async /         { next }
    # A pause pulls the terminal out from under the CLI, which reports it as a
    # crash: "TimeoutError: … The sandbox was killed or reached its end of life …",
    # or the terser "2: [unknown] terminated". Both are wrong (a paused box is
    # frozen, not killed) and alarming. Drop them; disconnect_notice in e2b-box
    # says what actually happened and how to get back.
    /\[unknown\] terminated/ { next }
    # The error line, in either shape the CLI produces:
    #   "SandboxNotFoundError: Paused sandbox i… not found"
    #   "tr [SandboxNotFoundError]: Paused sandbox i… not found"  (wrapped form)
    # Keep only the human half, in our own voice.
    match($0, /[A-Za-z]+Error\]?:[[:space:]]*/) {
      print "  ! " substr($0, RSTART + RLENGTH); fflush(); next
    }
    { print; fflush() }
  '
}
