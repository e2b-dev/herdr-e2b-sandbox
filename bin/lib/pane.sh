#!/usr/bin/env bash
# Shared pane plumbing for the keybinding entrypoints. Source after lib/paths.sh.
# The dashboard can reuse an idle pane; box and fleet actions always split below.

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

# Anchor a new pane to the invocation, even if focus has since moved elsewhere.
#
#   pane_open_from <entrypoint> <where> [target-pane] [herdr pane-open args...]
#
# `where` is below, right, above or left (a split on that side of the target) or
# tab (a new tab). herdr itself splits right or down only, so above and left are
# a split plus `pane swap`: the new pane trades places with the target, which
# puts it on the far side. An empty target means "the invoking pane" (plugin context, then focus). The popup
# dashboard passes one explicitly: inside a popup, context and focus both name
# the popup itself, so only the launcher knew which pane it floated over.
# Anything after the target is handed to herdr as-is (`--cwd`, `--env`).
pane_open_from() {
  local entrypoint="$1" where="$2" target="${3:-}" herdr node direction= swap=
  shift 2; [ "$#" -gt 0 ] && shift
  case "$where" in
    below) direction=down ;;
    right) direction=right ;;
    above) direction=down; swap=1 ;;
    left) direction=right; swap=1 ;;
    tab) ;;
    *) echo "e2b: unknown placement '$where' (below, right, above, left or tab)" >&2; return 2 ;;
  esac
  herdr=$(pane_herdr) || { echo "e2b: can't find the herdr binary" >&2; return 1; }
  node=$(pane_node) || { echo "e2b: can't find node — set HERDR_E2B_NODE=/path/to/node" >&2; return 1; }
  if [ -z "$target" ]; then
    target=$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | "$node" "$PLUGIN_DIR/src/pane-parse.js" origin)
  fi
  if [ "${target:--}" = "-" ]; then
    read -r target _ _ <<EOF
$(pane_query "$herdr" "$node" "")
EOF
  fi
  [ "${target:--}" != "-" ] || { echo "e2b: no invoking pane" >&2; return 1; }
  if [ -n "$direction" ]; then
    "$herdr" plugin pane open --plugin e2b-dev.herdr-e2b --entrypoint "$entrypoint" \
      --placement split --target-pane "$target" --direction "$direction" --focus ${1+"$@"} >/dev/null || return
    # The split landed right of / under the target; trading places moves it to
    # the left / above. The pane is open either way, so a failed swap only warns.
    [ -z "$swap" ] || "$herdr" pane swap --pane "$target" --direction "$direction" >/dev/null \
      || echo "e2b: opened the pane, but couldn't move it $where the target" >&2
  else
    "$herdr" plugin pane open --plugin e2b-dev.herdr-e2b --entrypoint "$entrypoint" \
      --placement tab --target-pane "$target" --focus ${1+"$@"} >/dev/null
  fi
}

# The `open` and `fleet` actions: a split under the invoking pane.
pane_open_below() {
  local entrypoint="$1"
  shift
  pane_open_from "$entrypoint" below ${1+"$@"}
}
