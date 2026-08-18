#!/usr/bin/env bash
# Shared pane plumbing for the keybinding entrypoints (e2b-dash-toggle,
# e2b-box-open). Source this AFTER lib/paths.sh.
#
# The reason this exists: herdr has no pane placement meaning "cover exactly this
# pane" — `zoomed`/`overlay` take the whole tab, `split` halves it, `popup` is a
# centered box. The only thing that fills one pane exactly is running the program
# *in* that pane. So both entrypoints ask herdr what the focused pane is doing,
# and either run there or fall back to a split beside it.

# Resolve tools by path, not by PATH: a keybinding runs in herdr's environment,
# which under a GUI/launchd start can be a bare /usr/bin:/bin. herdr hands
# keybindings its own binary in $HERDR_BIN_PATH, so prefer that.
pane_herdr() {
  local h="${HERDR_BIN_PATH:-}" c
  [ -x "$h" ] || h=$(command -v herdr 2>/dev/null || true)
  for c in "$HOME/.local/bin/herdr" /opt/homebrew/bin/herdr /usr/local/bin/herdr; do
    [ -n "$h" ] && break
    [ -x "$c" ] && h="$c"
  done
  [ -n "$h" ] || return 1
  printf '%s' "$h"
}

# One interpreter, the one the plugin already hard-requires. Plain PATH node is a
# fine fallback: this is a JSON.parse, not the SDK, so it doesn't need node >= 22.
pane_node() {
  local n
  n=$(e2b_node 2>/dev/null || command -v node 2>/dev/null || true)
  [ -n "$n" ] || return 1
  printf '%s' "$n"
}

# "<focused_pane> <titled_pane> <tab_pane_ids>" for a [[panes]] title, "-" for
# anything absent. Callers `read -r a b c` it, so it always prints three fields.
pane_query() {
  local herdr="$1" node="$2" title="$3"
  "$herdr" pane list 2>/dev/null | "$node" "$PLUGIN_DIR/src/pane-parse.js" panes "$title"
}

# Foreground process names in a pane, one per line.
pane_procs() {
  local herdr="$1" node="$2" pane="$3"
  "$herdr" pane process-info --pane "$pane" 2>/dev/null | "$node" "$PLUGIN_DIR/src/pane-parse.js" procs
}

# Is this pane an idle shell — i.e. ours to type into?
#
# This has to fail SAFE: typing into a pane that is mid-something — an agent, a
# dev server, an attached sandbox shell — puts our command into whatever is
# reading that terminal. So "idle" must be positively proven: at least one
# foreground process, and every one of them a shell. No data (the call failed, or
# herdr reported none) means unknown, and unknown counts as busy.
pane_is_idle() {
  local herdr="$1" node="$2" pane="$3" name seen=0
  while read -r name; do
    [ -n "$name" ] || continue
    seen=$((seen + 1))
    case "$name" in
      zsh|-zsh|bash|-bash|sh|-sh|fish|dash|ksh|login) ;;
      *) seen=-1; break ;;   # something real is running here
    esac
  done < <(pane_procs "$herdr" "$node" "$pane")
  [ "$seen" -gt 0 ]
}
