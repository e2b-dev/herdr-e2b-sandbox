#!/usr/bin/env bash
# The full-screen pickers, shared by every verb that has to ask a human
# something before it creates a box. They live here rather than in the box CLI
# so a second script can source them without also sourcing a 600-line CLI (and
# its side effects: the `jq` check, the context-json cd, the argument grammar).
#
# Four entry points, one look and one feel:
#   ask_template_tty  one template for one box       (`e2b-box open`)
#   ask_slug_tty      a line of text, plus an
#                     optional second one            (`e2b-fleet`, screen one)
#   ask_roster_tty    several templates at once      (`e2b-fleet`, screen two)
#   ask_action_tty    one verb from a short list     (the on-close prompt)
#
# Self-contained on purpose: bash and standard terminal utilities, no lib/paths.sh,
# no node or state dir. Source it from anywhere, in any order. That is also why neither
# picker validates anything itself — `ask_slug_tty` takes the name of a
# validator function so the rule can live where it belongs (src/fleet-name.js
# owns ref sanitizing) without dragging node in here.

# Full-screen chooser for the template: arrows or j/k to move, a number to jump
# straight to a row, enter to confirm, q or Esc to abort. The interaction
# model deliberately mirrors herdr-pickr's reviewer chooser
# (github.com/tomasvarga/herdr-pickr, MIT) so the two plugins feel like one tool. Prints the chosen template on stdout (callers capture it) and returns
# non-zero when there's no terminal to draw on.
#
#   ask_template_tty <label> <default-template> <choices> <count> [marks]
#
# where <label> names what's being booted (it's the title), <default-template>
# is the row that opens SELECTED (nothing takes it but Enter — q, Esc and the
# read timeout all return 2, and the caller must create nothing), <choices> is
# the menu one template per line, and <count> is how many lines that is.
#
# <marks> is optional and parallel to <choices>: one line per row, drawn dimmed
# beside the name, empty for a row with nothing to say. It ANNOTATES and never
# filters — a template whose box would come up on a sign-in screen stays in the
# menu, because hiding it would remove one the user may intend to configure later
# (or a base image that needs no credential at all). Callers pass what
# `e2b-box auth` discovered; this file neither knows nor asks where a mark came from.
#
# Finding "where the human is" takes two tries. A plain shell has a controlling
# terminal, so /dev/tty is the pane. A herdr pane program may run on a pty WITHOUT
# it being our controlling terminal — /dev/tty fails there while fd 0 is the very
# pane you're looking at — so fall back to duplicating stdin.

# ── drawing without flicker ─────────────────────────────────────────────────────
#
# A frame is built in one string and written with ONE printf: home the cursor,
# every line ends with erase-to-end-of-line, the frame ends with erase-to-end-of-
# screen. Nothing is cleared before it is redrawn, so moving the cursor repaints
# the two rows that changed and the rest of the screen never blinks.
#
# CHOOSER_CENTER=1 (set by bin/e2b-popup for the pickers it hosts) draws the frame
# in the MIDDLE of the terminal instead of its top-left: the popup is a floating
# 90%×85% overlay and a menu hugging its corner reads as a mistake. The frame is
# measured (visible width, line count) and padded on the left and the top; nothing
# about its content changes, so the same keys give the same answers either way.
#
# The padding is STICKY within one picker: the widest frame and the tallest frame
# seen so far decide it, so opening a row's list (more lines) or moving onto a
# wider row never shifts the table sideways or up and back. `center_reset` at each
# picker's start lets the next one measure afresh.
F="" CENTER_W=0 CENTER_N=0
center_reset() { CENTER_W=0; CENTER_N=0; }
f_line() { F="$F$1"$'\033[K\n'; }
f_flush() {
  [ "${CHOOSER_CENTER:-0}" = 1 ] && F=$(center_frame "$F")$'\n'
  printf '\033[H%s\033[J' "$F" >&3; F=""
}
center_frame() {
  local f="${1%$'\n'}" size rows cols l v maxw=0 n=0 top left pad="" out=""
  size=$(stty size <&4 2>/dev/null) || size=""
  rows="${size%% *}"; cols="${size##* }"
  [[ "$rows" =~ ^[0-9]+$ && "$cols" =~ ^[0-9]+$ ]] || { printf '%s' "$f"; return; }
  while IFS= read -r l; do
    # Forking once per line made centering alone consume the cached-frame budget.
    v="$l"
    while [[ "$v" =~ $'\033''\[[0-9;?]*[A-Za-z]' ]]; do v="${v/"${BASH_REMATCH[0]}"/}"; done
    [ "${#v}" -gt "$maxw" ] && maxw=${#v}; n=$((n + 1))
  done <<EOF
$f
EOF
  [ "$maxw" -gt "$CENTER_W" ] && CENTER_W=$maxw; maxw=$CENTER_W
  [ "$n" -gt "$CENTER_N" ] && CENTER_N=$n; n=$CENTER_N
  left=$(( (cols - maxw) / 2 )); [ "$left" -gt 0 ] || left=0
  top=$(( (rows - n) / 2 )); [ "$top" -gt 0 ] || top=0
  pad=$(printf '%*s' "$left" "")
  while [ "$top" -gt 0 ]; do out="$out"$'\033[K\n'; top=$((top - 1)); done
  while IFS= read -r l; do out="$out$pad$l"$'\n'; done <<EOF
$f
EOF
  printf '%s' "${out%$'\n'}"
}

# ── effort cells, shared by both pickers ─────────────────────────────────────────
#
# `effort_rows` is what `node src/effort-cli.js` prints: one `<template>|<kind>|
# <v1,v2,…>|<configured>|<via>` per template (src/effort.js owns the words each
# harness accepts). The pickers only ever choose from that list; they never invent
# a level. An empty effort ("") means "leave the pin / the harness default alone",
# and it is one entry in the list, drawn as `default`, so a human can get back to
# it. Missing rows (old callers, tests) mean no effort column at all.
#
# COLUMNS. Both pickers are tables with a focused CELL, not just a focused row:
# →/tab and ←/shift-tab move the focus across columns, ↑/↓ move across rows in
# whichever column you are in. The template column is where enter means "go";
# the effort column is where enter opens that row's list (↑/↓ choose, enter takes,
# esc leaves it as it was). The model column sits between them and works the same
# way: its list is the harness's catalog (src/harness-catalog.generated.js), read
# off the same rows as fields six and seven. Column INDICES are fixed (0 template,
# 1 model, 2 effort, 3 count) and a column no row has is skipped when the focus
# moves (`col_step`), so a table with efforts and no models feels exactly as it did
# before models existed. Widths are fixed so the columns line up:
#   template 24 · model 24 · effort 11 · count 5
EFF_KIND=() EFF_VALS=() EFF_VIA=() EFF_INIT=() MOD_VALS=() MOD_INIT=()
effort_load() { # $1 = template list (newline), $2 = effort rows (newline) → fills EFF_* and MOD_* by index
  local i=0 t k v c via mv mc row
  EFF_KIND=(); EFF_VALS=(); EFF_VIA=(); EFF_INIT=(); MOD_VALS=(); MOD_INIT=()
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    EFF_KIND[$i]="none"; EFF_VALS[$i]=""; EFF_VIA[$i]=""; EFF_INIT[$i]=""; MOD_VALS[$i]=""; MOD_INIT[$i]=""
    while IFS='|' read -r row k v c via mv mc; do
      [ "$row" = "$t" ] || continue
      EFF_KIND[$i]="$k"; EFF_VALS[$i]="$v"; EFF_VIA[$i]="$via"; EFF_INIT[$i]="$c"; MOD_VALS[$i]="$mv"; MOD_INIT[$i]="$mc"
    done <<EOF
$2
EOF
    i=$((i + 1))
  done <<EOF
$1
EOF
}
# The next column the focus can land on: $1 = current, $2 = +1 or -1, $3 = the last
# index this table has, $4/$5 = whether any row has a model / an effort cell.
# Stays put at either edge. Columns 0 and 3 always exist when the table has them.
col_step() {
  local c="$1"
  while :; do
    c=$((c + $2))
    if [ "$c" -lt 0 ] || [ "$c" -gt "$3" ]; then printf '%s' "$1"; return; fi
    case "$c" in 0|3) break ;; 1) [ "${4:-0}" -eq 1 ] && break ;; 2) [ "${5:-0}" -eq 1 ] && break ;; esac
  done
  printf '%s' "$c"
}
# The last column a row has: $1 = the table's last index, $2/$3 = has model / effort.
# Where ←/shift-tab land when they step back off a row's first column onto the row
# above, the mirror of →/tab walking off a row's last cell onto the next row.
col_last() { col_step "$(($1 + 1))" -1 "$1" "$2" "$3"; }
# One model cell: the id, `default` for none chosen, a long id cut with `…`; blank
# when the row lists no models. $3 = 1 draws it as the focused cell. Reverse video
# is the only thing that marks a cell: no brackets, no chevrons, so an unfocused
# table reads as plain columns of text under the header.
# CELL avoids a subshell for each cell in the first frame.
CELL=""
model_cell() { # $1 = models csv, $2 = value, $3 = focused
  local shown body
  [ -n "$1" ] || { printf -v CELL '%-24s' ""; return; }
  shown="${2:-default}"
  [ "${#shown}" -gt 23 ] && shown="${shown:0:22}…"
  printf -v body '%-24s' "$shown"
  if [ "${3:-0}" -eq 1 ]; then printf -v CELL '\033[7m%s\033[0m' "$body"; else printf -v CELL '%s' "$body"; fi
}
# One effort cell: the value, `default` for none chosen; blank when the row has no
# scale. $3 = 1 draws it as the focused cell.
effort_cell() { # $1 = kind, $2 = value, $3 = focused
  local body
  case "$1" in
    none) printf -v CELL '%-11s' ""; return ;;
    *)    printf -v body '%-11s' "${2:-default}" ;;
  esac
  if [ "${3:-0}" -eq 1 ]; then printf -v CELL '\033[7m%s\033[0m' "$body"; else printf -v CELL '%s' "$body"; fi
}
# The list a focused effort cell opens: the values of one row, `default` first.
# Draws below the table; ↑/↓ move, enter takes, esc/q leave it unchanged.
# Sets POP_PICK to the chosen value ("" for default) and returns 0, or returns 1
# when it was left. The caller redraws the frame each keystroke around it, so this
# only draws the list itself (via f_line) and reads keys.
POP_PICK=""
# The list a cell opens is a DROPDOWN: drawn right under the row it belongs to,
# starting at that cell's column, pushing the rows below it down, the way a select
# unfolds where it was clicked. No title (the position says which cell), and its
# key hint takes the footer's place while it is open (`list_hint`). A catalog can
# run to a hundred ids (prime lists 104), so $4 > 0 draws a WINDOW of that many
# rows around the cursor with a count of what lies above and below; 0 draws all.
list_lines() { # $1 = values csv, $2 = current, $3 = cursor index (-1 = default), $4 = window rows, $5 = indent, $6 = width
  local IFS=, list=() i cnt first=-1 last win="${4:-0}" pad w="${6:-9}"
  read -ra list <<<"$1"
  cnt=${#list[@]}; last=$((cnt - 1))
  if [ "$win" -gt 0 ] && [ $((cnt + 1)) -gt "$win" ]; then
    first=$(($3 - win / 2)); [ "$first" -lt -1 ] && first=-1
    last=$((first + win - 1))
    [ "$last" -gt $((cnt - 1)) ] && { last=$((cnt - 1)); first=$((last - win + 1)); }
  fi
  pad=$(printf '%*s' "${5:-2}" "")
  [ "$first" -gt -1 ] && f_line "$pad$(printf '\033[2m  … %s more above\033[0m' "$((first + 1))")"
  i=$first
  while [ "$i" -le "$last" ]; do
    local v; [ "$i" -lt 0 ] && v="" || v="${list[$i]}"
    local shown="${v:-default}" mark="  "
    [ "$v" = "$2" ] && mark="• "
    if [ "$i" -eq "$3" ]; then f_line "$pad$(printf '\033[7m▸ %s%-*s\033[0m' "$mark" "$w" "$shown")"
    else f_line "$pad  $mark$shown"; fi
    i=$((i + 1))
  done
  [ "$last" -lt $((cnt - 1)) ] && f_line "$pad$(printf '\033[2m  … %s more below\033[0m' "$((cnt - 1 - last))")"
}
list_hint() { f_line "  $(printf '\033[2m↑/↓ choose   enter take   esc keep %s\033[0m' "${1:-default}")"; }
# Where the two cells start on a row, as columns: the row prefix, the 24-wide
# template name, its trailing space, and the space before the cell. $1 = prefix
# width (single picker 9, roster 13), $2 = has_mod; effort sits one 24-wide cell
# and a space further right when a model cell is drawn.
model_col() { printf '%s' "$(($1 + 26))"; }
effort_col() { printf '%s' "$(($1 + 26 + (${2:-0} == 1 ? 25 : 0)))"; }
MODEL_WINDOW=14
effort_index() { # $1 = values csv, $2 = value → index or -1
  local IFS=, list=() i=0
  read -ra list <<<"$1"
  while [ "$i" -lt "${#list[@]}" ]; do [ "${list[$i]}" = "$2" ] && { printf '%s' "$i"; return; }; i=$((i + 1)); done
  printf '%s' -1
}
effort_at() { # $1 = values csv, $2 = index → value ("" for -1)
  local IFS=, list=(); read -ra list <<<"$1"
  [ "$2" -lt 0 ] && printf '' || printf '%s' "${list[$2]}"
}
effort_count() { local IFS=, list=(); read -ra list <<<"$1"; printf '%s' "${#list[@]}"; }

# A picker for one box: template rows, each with a model cell and an effort cell.
# →/tab focuses the next cell, enter there opens the row's list; enter on the
# template column answers `<template>`, `<template>\t<effort>` or
# `<template>\t<effort>\t<model>` (the effort field `-` when only a model was
# chosen): tabs only as far as something was chosen, so old callers see exactly
# what they always did.
# An optional caller-owned refresh callback returns 1 while pending, 3 with new
# arguments in CHOOSER_INPUT, 4 when settled, or 5 on failure. It first runs after
# paint. Keys wait for fresh rows; replacing a menu requires a fresh confirmation.
chooser_read_key() {
  local timeout="$1" refresh="$2" deadline=$((SECONDS + $1)) rc interval="$1"
  if [ -n "$refresh" ]; then
    # macOS system bash accepts only whole seconds for read's timeout.
    interval=1; [ "${BASH_VERSINFO[0]}" -lt 4 ] || interval=0.05
  fi
  while :; do
    if [ -n "$refresh" ]; then
      "$refresh"; rc=$?
      case "$rc" in 3|4|5) return "$rc" ;; esac
      [ "$rc" -ne 0 ] || interval="$timeout"
    else rc=0; fi
    if [ "$rc" -eq 0 ] && [ "${CHOOSER_KEY+x}" ]; then
      key="$CHOOSER_KEY"; unset CHOOSER_KEY; return 0
    fi
    if IFS= read -rsn1 -t "$interval" key <&4; then
      # Aborting must work even if the caller's resolver has stalled. Escape
      # sequences are still decoded by the existing key handlers.
      if [ "$key" = $'\e' ] || { [ "${3:-}" = q ] && [[ "$key" = [qQ] ]]; }; then return 0; fi
      # Defer confirmation while resolving, but keep reading so Escape can
      # cancel it. A blocking wait here made a quick Enter trap the popup.
      if [ "$rc" -eq 1 ] && { [ -z "$key" ] || { [ "${3:-}" = q ] && [[ "$key" = [1-9tT] ]]; }; }; then
        CHOOSER_KEY="$key"
        continue
      fi
      unset CHOOSER_KEY
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || return 2
    [ -n "$refresh" ] || return 2
  done
}

# Escape shares its leading byte with arrows and Shift-Tab. A short window is
# enough for a local popup's key sequence; a full second made "back" feel stuck.
chooser_escape_tail() {
  rest=""
  if [ "${CHOOSER_ESCAPE_WAIT:-}" = 0 ]; then
    # The popup caller keeps input unbuffered, so complete arrow sequences are
    # visible here without a timer. Bash 3.2's read -t 0 always times out, so
    # use a bounded, nonblocking terminal read there instead.
    if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
      stty min 0 time 0 <&4
      rest=$(dd bs=1 count=2 <&4 2>/dev/null)
      stty min 1 time 0 <&4
    else
      local byte
      while [ "${#rest}" -lt 2 ] && read -t 0 <&4; do
        IFS= read -rsn1 byte <&4 || break
        rest="$rest$byte"
      done
    fi
  else
    local delay="${CHOOSER_ESCAPE_WAIT:-0.02}"
    [ "${BASH_VERSINFO[0]}" -ge 4 ] || delay=1
    IFS= read -rsn2 -t "$delay" rest <&4 || true
  fi
}

ask_template_tty() {
  local lbl="$1" resolved="$2" choices="$3" n="$4" marks="${5:-}" efforts="${6:-}" sel=0 i key rest hit typed col=0 pop=0 pidx=-1 pk="" nc
  local refresh="${7:-}" refresh_rc
  # `pk` names the open list: "eff" or "mod".
  if { : >/dev/tty; } 2>/dev/null; then
    exec 3>/dev/tty 4</dev/tty
  elif [ -t 0 ] && { exec 3>&0; } 2>/dev/null; then
    exec 4<&0
  else
    return 1
  fi
  center_reset
  local items=()
  while IFS= read -r t; do [ -n "$t" ] && items+=("$t"); done <<EOF
$choices
EOF
  local notes=() wide=0
  i=0
  while IFS= read -r t; do
    notes[$i]="$t"
    [ "${#t}" -gt "$wide" ] && wide=${#t}
    i=$((i + 1))
  done <<EOF
$marks
EOF
  effort_load "$choices" "$efforts"
  local eff=() mod=() has_eff=0 has_mod=0
  i=0
  while [ "$i" -lt "$n" ]; do
    eff[$i]="${EFF_INIT[$i]:-}"; mod[$i]="${MOD_INIT[$i]:-}"
    [ "${EFF_KIND[$i]:-none}" != none ] && has_eff=1
    [ -n "${MOD_VALS[$i]:-}" ] && has_mod=1
    [ "${items[$i]}" = "$resolved" ] && sel=$i
    i=$((i + 1))
  done
  local has_cells=0; { [ "$has_eff" -eq 1 ] || [ "$has_mod" -eq 1 ]; } && has_cells=1
  # ←/h/shift-tab: the previous cell of this row, or from its first column the LAST
  # cell of the row above (wrapping to the bottom), the mirror of →/tab. Reads and
  # sets the loop's sel/col/rm/re.
  pick_back() {
    local nc prm=0 pre=0
    nc=$(col_step "$col" -1 2 "$rm" "$re")
    if [ "$nc" != "$col" ]; then col=$nc; return; fi
    sel=$(((sel - 1 + n) % n))
    [ -n "${MOD_VALS[$sel]:-}" ] && prm=1; [ "${EFF_KIND[$sel]:-none}" != none ] && pre=1
    col=$(col_last 2 "$prm" "$pre")
  }
  [ "${CHOOSER_REPAINT:-0}" = 1 ] || printf '\033[?1049h\033[?25l\033[2J' >&3
  while :; do
    f_line ""
    f_line "  $(printf '\033[1mE2B template\033[0m \033[2mfor\033[0m \033[1m%s\033[0m' "$lbl")"
    f_line ""
    i=0
    while [ "$i" -lt "$n" ]; do
      local line
      if [ "$i" -eq "$sel" ] && [ "$col" -eq 0 ]; then
        printf -v line '  \033[7m ▸ [%s] %-24s \033[0m' "$((i + 1))" "${items[$i]}"
      elif [ "$i" -eq "$sel" ]; then
        printf -v line '   ▸ [%s] %-24s ' "$((i + 1))" "${items[$i]}"
      else
        printf -v line '     [%s] %-24s ' "$((i + 1))" "${items[$i]}"
      fi
      if [ "$has_mod" -eq 1 ]; then
        local fm=0; [ "$i" -eq "$sel" ] && [ "$col" -eq 1 ] && fm=1
        model_cell "${MOD_VALS[$i]:-}" "${mod[$i]}" "$fm"; line="$line $CELL"
      fi
      if [ "$has_eff" -eq 1 ]; then
        local foc=0; [ "$i" -eq "$sel" ] && [ "$col" -eq 2 ] && foc=1
        effort_cell "${EFF_KIND[$i]:-none}" "${eff[$i]}" "$foc"; line="$line $CELL"
        [ "${EFF_KIND[$i]:-none}" = generic ] && line="$line $(printf '\033[2m(%s)\033[0m' "${EFF_VIA[$i]}")"
      fi
      [ "$wide" -gt 0 ] && line="$line $(printf '\033[2m%-*s\033[0m' "$wide" "${notes[$i]:-}")"
      [ "${items[$i]}" = "$resolved" ] && line="$line $(printf '\033[2mdefault\033[0m')"
      f_line "$line"
      # The open list unfolds right under its row, at its cell's column.
      if [ "$pop" -eq 1 ] && [ "$i" -eq "$sel" ]; then
        if [ "$pk" = mod ]; then list_lines "${MOD_VALS[$sel]}" "${mod[$sel]}" "$pidx" "$MODEL_WINDOW" "$(model_col 9)" 22
        else list_lines "${EFF_VALS[$sel]}" "${eff[$sel]}" "$pidx" 0 "$(effort_col 9 "$has_mod")" 9; fi
      fi
      i=$((i + 1))
    done
    f_line ""
    if [ "$pop" -eq 1 ]; then
      [ "$pk" = mod ] && list_hint "${mod[$sel]}" || list_hint "${eff[$sel]}"
    else
      if [ "$has_cells" -eq 1 ]; then
        local cells="effort"; [ "$has_mod" -eq 1 ] && { [ "$has_eff" -eq 1 ] && cells="model/effort" || cells="model"; }
        f_line "  $(printf '\033[2m↑/↓ move   →/tab %s column   enter confirm (on a cell: its list)   number jumps   t type a name   q/esc abort\033[0m' "$cells")"
      else
        f_line "  $(printf '\033[2m↑/↓ · j/k move   enter confirm   number jumps   t type a name   q/esc abort\033[0m')"
      fi
    fi
    f_flush
    chooser_read_key 120 "$refresh" q; refresh_rc=$?
    case "$refresh_rc" in
      3) unset CHOOSER_KEY; CHOOSER_REPAINT=1 ask_template_tty "${CHOOSER_INPUT[@]}" "$refresh"; return $? ;;
      0) ;;
      *) chooser_close_tty; return "$refresh_rc" ;;
    esac
    hit=""
    # which cells THIS row has, for the column walk
    local rm=0 re=0; [ -n "${MOD_VALS[$sel]:-}" ] && rm=1; [ "${EFF_KIND[$sel]:-none}" != none ] && re=1
    if [ "$pop" -eq 1 ]; then
      # inside a list: ↑/↓ (j/k) move, enter takes, esc/q keep, number picks
      local vals cnt take=0
      [ "$pk" = mod ] && vals="${MOD_VALS[$sel]}" || vals="${EFF_VALS[$sel]}"
      cnt=$(effort_count "$vals")
      case "$key" in
        j|J) pidx=$(( (pidx + 2) % (cnt + 1) - 1 )) ;;
        k|K) pidx=$(( (pidx + cnt + 1) % (cnt + 1) - 1 )) ;;
        [0-9]) [ "$key" -le "$cnt" ] && { pidx=$((key - 1)); take=1; } ;;
        ''|$'\n'|$'\r') take=1 ;;
        q|Q) pop=0 ;;
        $'\e')
          chooser_escape_tail
          case "$rest" in
            '[A'|'OA') pidx=$(( (pidx + cnt + 1) % (cnt + 1) - 1 )) ;;
            '[B'|'OB') pidx=$(( (pidx + 2) % (cnt + 1) - 1 )) ;;
            '') pop=0 ;;
          esac ;;
      esac
      # Taking a value (or leaving the list) keeps the focus on the cell it belongs
      # to, so what just changed is what is highlighted; ←/shift-tab back to the
      # template column and enter confirms the box.
      if [ "$take" -eq 1 ]; then
        if [ "$pk" = mod ]; then mod[$sel]=$(effort_at "$vals" "$pidx"); else eff[$sel]=$(effort_at "$vals" "$pidx"); fi
        pop=0
      fi
      continue
    fi
    case "$key" in
      [1-9]) [ "$key" -le "$n" ] && hit="${items[$((key - 1))]}" ;;
      j|J)   sel=$(((sel + 1) % n)) ;;
      k|K)   sel=$(((sel - 1 + n) % n)) ;;
      # → and tab walk THIS row's cells (a row with no model or no effort has no
      # such column to land on) and then on to the next row's first column, so one
      # key visits everything; ← and shift-tab walk the same path backwards.
      l|L|$'\t') nc=$(col_step "$col" 1 2 "$rm" "$re"); if [ "$nc" = "$col" ]; then sel=$(((sel + 1) % n)); col=0; else col=$nc; fi ;;
      h|H)   pick_back ;;
      t|T)   printf '\033[?25h\n  template name: ' >&3
             IFS= read -r -t 120 typed <&4 || typed=""
             if [ -n "$typed" ]; then chooser_close_tty; printf '%s' "$typed"; return 0; fi
             printf '\033[?25l' >&3 ;;
      ''|$'\n'|$'\r')
        if [ "$col" -eq 1 ] && [ -n "${MOD_VALS[$sel]:-}" ]; then
          pop=1; pk=mod; pidx=$(effort_index "${MOD_VALS[$sel]}" "${mod[$sel]}")
        elif [ "$col" -eq 2 ] && [ "${EFF_KIND[$sel]:-none}" != none ]; then
          pop=1; pk=eff; pidx=$(effort_index "${EFF_VALS[$sel]}" "${eff[$sel]}")
        else
          hit="${items[$sel]}"
        fi ;;
      q|Q)   chooser_close_tty; return 2 ;;
      $'\e')
        chooser_escape_tail
        case "$rest" in
          '[A'|'OA') sel=$(((sel - 1 + n) % n)) ;;
          '[B'|'OB') sel=$(((sel + 1) % n)) ;;
          '[C'|'OC') nc=$(col_step "$col" 1 2 "$rm" "$re"); if [ "$nc" = "$col" ]; then sel=$(((sel + 1) % n)); col=0; else col=$nc; fi ;;
          '[D'|'OD') pick_back ;;
          '[Z')      pick_back ;;   # shift-tab
          '')        chooser_close_tty; return 2 ;;
        esac ;;
    esac
    [ -n "$hit" ] && break
  done
  chooser_close_tty
  # A number key answers with that row's own cells, not the highlighted row's.
  i=0; while [ "$i" -lt "$n" ]; do [ "${items[$i]}" = "$hit" ] && break; i=$((i + 1)); done
  member_line "$hit" "${eff[$i]:-}" "${mod[$i]:-}"
}
# One answer line: `<template>[\t<effort>[\t<model>]]`, tabs only as far as
# something was chosen. An effort left at default in front of a chosen model is
# written `-`, never empty: bash's `read` with a tab IFS folds an empty middle field
# into its neighbour, and the model would come back AS the effort. $4 = 1 ends the
# line with a newline (the roster's per-member rows).
member_line() { # $1 = template, $2 = effort, $3 = model, $4 = newline
  if [ -n "$3" ]; then printf '%s\t%s\t%s' "$1" "${2:--}" "$3"
  elif [ -n "$2" ]; then printf '%s\t%s' "$1" "$2"
  else printf '%s' "$1"; fi
  # Explicit, because this is the picker's last statement and its exit code: a
  # false `[ … ] &&` here made every single-picker answer return 1.
  [ "${4:-0}" -eq 1 ] && printf '\n'
  return 0
}


# --- shared plumbing for the pickers added after the extraction ---------------
# The same two-step "find the human" dance ask_template_tty does inline. The
# single-select body above is deliberately NOT refactored onto this: it is the
# one TTY-sensitive path that shipped before any of it had automated coverage,
# so it stays byte-for-byte what it was and the new entry points share this
# instead. Opens fd 3 (draw) and fd 4 (read); returns 1 when there is no
# terminal at all.
chooser_open_tty() {
  if { : >/dev/tty; } 2>/dev/null; then
    exec 3>/dev/tty 4</dev/tty
  elif [ -t 0 ] && { exec 3>&0; } 2>/dev/null; then
    exec 4<&0
  else
    return 1
  fi
}

# Leave the alternate screen, restore the cursor, drop the descriptors. Every
# exit from a picker goes through here, including the aborts — a picker that
# returned with the alternate screen still up would leave the pane unusable.
chooser_close_tty() {
  printf '\033[?25h\033[?1049l' >&3
  exec 3>&- 4<&-
}

# One line of text, asked full-screen — plus, optionally, a second one.
#
#   ask_slug_tty <note> [validator-fn] [want-task]
#
# <note> is a warning to show above the field (empty for none) and
# <validator-fn> is the name of a shell function that returns 0 when the typed
# text is acceptable; it is called with the raw text and must print nothing.
# Prints the RAW text on stdout — sanitizing belongs to the caller's validator,
# not here, so the user always sees back exactly what they typed.
#
# <want-task> (any non-empty value) adds the OPTIONAL fleet-task field below the
# slug: the instruction every member's agent is handed at launch. Then stdout is
# two lines — the slug, then the task — and an empty task is an empty second
# line, which is what "send nothing" looks like. Callers that don't ask for the
# field get exactly one line, as they always did; only the validator applies to
# the slug, because a fleet task is free text with no rules to break.
#
# Returns 1 when there is no terminal, 2 when the user aborted (bare Esc, or the
# read timing out — an unwatched pane must not launch a fleet by itself).
ask_slug_tty() {
  local refresh="${4:-}" refresh_rc
  local note="$1" validate="${2:-}" want_task="${3:-}" buf="" task="" field=0 key rest err=""
  chooser_open_tty || return 1
  center_reset
  printf '\033[?1049h' >&3
  # Built as a frame like the other pickers (f_line / f_flush), so the popup can
  # center it the same way.
  while :; do
    f_line ""
    f_line "  $(printf '\033[1mNew E2B fleet\033[0m')"
    f_line ""
    f_line "  $(printf '\033[2mA short name for what this fleet is for. Every member'\''s branch')"
    f_line "  $(printf 'carries it, so it is sanitized into a legal git ref.\033[0m')"
    f_line ""
    [ -n "$note" ] && { f_line "  $(printf '\033[33m%s\033[0m' "$note")"; f_line ""; }
    # The block cursor marks the field being typed into; with no task field
    # there is only ever one, so this draws exactly what it always drew.
    if [ "$field" -eq 0 ]; then
      f_line "  $(printf 'task slug: %s\033[7m \033[0m' "$buf")"
    else
      f_line "  task slug: $buf"
    fi
    if [ -n "$want_task" ]; then
      f_line ""
      f_line "  $(printf '\033[2mOptional. The fleet task: one instruction, handed to every member'\''s')"
      f_line "  $(printf 'agent as it comes up. Leave it empty to just get the boxes.\033[0m')"
      f_line ""
      if [ "$field" -eq 1 ]; then
        f_line "  $(printf 'fleet task: %s\033[7m \033[0m' "$task")"
      else
        f_line "  fleet task: $task"
      fi
    fi
    [ -n "$err" ] && { f_line ""; f_line "  $(printf '\033[31m%s\033[0m' "$err")"; }
    f_line ""
    if [ -n "$want_task" ]; then
      f_line "  $(printf '\033[2mtab · ↑/↓ switch field   backspace deletes   enter launches   esc aborts\033[0m')"
    else
      f_line "  $(printf '\033[2mtype to edit   backspace deletes   enter continues   esc aborts\033[0m')"
    fi
    f_flush
    # Bounded like the template chooser: a pane nobody is watching must not sit
    # here forever holding a keybinding hostage.
    chooser_read_key 300 "$refresh"; refresh_rc=$?
    case "$refresh_rc" in
      3) note="${CHOOSER_INPUT[0]}"; continue ;;
      0) ;;
      *) chooser_close_tty; return "$refresh_rc" ;;
    esac
    case "$key" in
      ''|$'\n'|$'\r')
        # Enter always means "go", from either field — so the slug-only flow is
        # still one keypress and the task field can never trap you in it.
        err=""
        if [ -z "$buf" ]; then
          err="a fleet is named by what it is for — type something"
          field=0
        elif [ -n "$validate" ] && ! "$validate" "$buf"; then
          err="that can't become a git branch — give it letters or digits"
          field=0
        else
          break
        fi ;;
      $'\177'|$'\b')
        if [ "$field" -eq 0 ]; then buf="${buf%?}"; else task="${task%?}"; fi ;;
      $'\t') [ -n "$want_task" ] && field=$((1 - field)) ;;
      $'\e')
        # An arrow key is Esc + 2 more bytes; a bare Esc is the abort. Same
        # short discrimination window as the template chooser.
        chooser_escape_tail
        case "$rest" in
          '[A'|'OA'|'[B'|'OB'|'[Z') [ -n "$want_task" ] && field=$((1 - field)) ;;
          '') chooser_close_tty; return 2 ;;
        esac ;;
      [[:print:]])
        if [ "$field" -eq 0 ]; then buf="$buf$key"; else task="$task$key"; fi ;;
      *) ;;   # any other control byte: ignore rather than paste it into a ref
    esac
  done
  chooser_close_tty
  if [ -n "$want_task" ]; then printf '%s\n%s' "$buf" "$task"; else printf '%s' "$buf"; fi
}

# Several templates at once — the fleet roster.
#
#   ask_roster_tty <label> <choices> <count> <preticked>
#
# <choices> is the menu, one template per line (the same list `open` offers) and
# <count> is how many lines that is; <preticked> is the configured default
# roster, also one per line. A pre-ticked name that is not in <choices> is
# ignored: the roster MARKS rows, it never invents them.
#
# Prints the chosen templates on stdout, one per line, in menu order. Returns 1
# when there is no terminal and 2 when the user aborted — and an abort here has
# to mean "created nothing", so it is checked before anything is spawned.
# The roster TABLE: one row per template with three cells — in the fleet or not,
# how hard it thinks, how many of it — plus, when a template's instances are NOT
# all to think alike (`s`), one nested row per instance with its own effort cell.
#
#   ask_roster_tty <label> <choices> <n> <pre-ticked> [effort-rows]
#
# Focus is a CELL: ↑/↓ move rows, →/tab and ←/shift-tab move columns. Enter on the
# template or count column launches; enter on an effort cell opens that row's list.
# Prints one line per MEMBER (a template with count 3 is three lines):
# `<template>` or `<template>\t<effort>` — the tab only when an effort was chosen,
# so a caller that knows nothing about efforts still reads what it always did.
# Returns 1 with no terminal, 2 on q/Esc/timeout.
# Optional arguments after the refresh callback are preset names (one per line)
# and a loader callback. The loader returns a one-line task preview, then
# template|model|effort rows, one per member. Applying one adds an @preset<TAB>name
# line before the answer so the caller can resolve its optional task at handoff.
ask_roster_tty() {
  local refresh="${6:-}" refresh_rc
  local presets="${7:-}" load_preset="${8:-}" preset_names=() preset_index=-1 preset="" preset_task="" name
  while IFS= read -r name; do [ -z "$name" ] || preset_names+=("$name"); done <<< "$presets"
  local lbl="$1" choices="$2" n="$3" pre="$4" efforts="${5:-}" sel=-1 i j key rest err="" picked=0 mark col=0 pop=0 pidx=-1 pk="" nc maxc
  chooser_open_tty || return 1
  center_reset
  local items=() on=() cnt=() same=() eff=() inst=() mod=() instm=()
  while IFS= read -r t; do [ -n "$t" ] && items+=("$t"); done <<EOF
$choices
EOF
  effort_load "$choices" "$efforts"
  local has_eff=0 has_mod=0
  i=0
  while [ "$i" -lt "$n" ]; do
    case $'\n'"$pre"$'\n' in
      *$'\n'"${items[$i]}"$'\n'*) on[$i]=1; [ "$sel" -lt 0 ] && sel=$i ;;
      *) on[$i]=0 ;;
    esac
    cnt[$i]=1; same[$i]=1; eff[$i]="${EFF_INIT[$i]:-}"; inst[$i]=""; mod[$i]="${MOD_INIT[$i]:-}"; instm[$i]=""
    [ "${EFF_KIND[$i]:-none}" != none ] && has_eff=1
    [ -n "${MOD_VALS[$i]:-}" ] && has_mod=1
    i=$((i + 1))
  done
  [ "$sel" -lt 0 ] && sel=0
  # The count column exists as soon as the table has any cell at all.
  local maxcol=0 has_cells=0
  { [ "$has_eff" -eq 1 ] || [ "$has_mod" -eq 1 ]; } && { maxcol=3; has_cells=1; }
  # Does this row have a cell to open? $1 = row, $2 = "mod" or "eff".
  row_has() { if [ "$2" = mod ]; then [ -n "${MOD_VALS[$1]:-}" ]; else [ "${EFF_KIND[$1]:-none}" != none ]; fi; }
  # The cursor walks VISIBLE rows: `T<i>` for a template, `I<i>:<j>` for instance j
  # of template i (drawn while that template is in, has several instances, and is
  # not thinking alike). Rebuilt every frame from the state above.
  local rows=() cur="T$sel" r
  # instance efforts live in inst[i] as a space list, "-" standing for "" (a space
  # list cannot hold an empty word); get/set by 1-based j
  inst_get() { local IFS=' ' a=(${inst[$1]}); printf '%s' "${a[$(($2 - 1))]:-}"; }
  inst_set() { local IFS=' ' a=(${inst[$1]}) k=0 out=""; a[$(($2 - 1))]="$3"; while [ "$k" -lt "${cnt[$1]}" ]; do out="$out${a[$k]:--} "; k=$((k + 1)); done; inst[$1]="$out"; }
  inst_val() { local v; v=$(inst_get "$1" "$2"); [ "$v" = "-" ] && v=""; printf '%s' "$v"; }
  # the same three for instance MODELS, in instm[i]
  instm_get() { local IFS=' ' a=(${instm[$1]}); printf '%s' "${a[$(($2 - 1))]:-}"; }
  instm_set() { local IFS=' ' a=(${instm[$1]}) k=0 out=""; a[$(($2 - 1))]="$3"; while [ "$k" -lt "${cnt[$1]}" ]; do out="$out${a[$k]:--} "; k=$((k + 1)); done; instm[$1]="$out"; }
  instm_val() { local v; v=$(instm_get "$1" "$2"); [ "$v" = "-" ] && v=""; printf '%s' "$v"; }
  # `s` on a row: make its instances differ (their model, their effort), which only
  # means anything for a ticked template with at least two members, so it ticks and
  # grows the row as needed and unfolds it, with the cursor on instance #1's first
  # cell. `s` again folds.
  unfold() {
    local t="$1"
    if [ "${same[$t]}" -eq 1 ]; then
      on[$t]=1
      [ "${cnt[$t]}" -lt 2 ] && cnt[$t]=2
      same[$t]=0
      j=1; while [ "$j" -le "${cnt[$t]}" ]; do inst_set "$t" "$j" "${eff[$t]:--}"; instm_set "$t" "$j" "${mod[$t]:--}"; j=$((j + 1)); done
      cur="I$t:1"; col=$(col_step 0 1 2 "$has_mod" "$has_eff")
    else
      same[$t]=1; cur="T$t"; col=0
    fi
  }
  # ←/h/shift-tab: the previous cell of this row, or from its first column the LAST
  # cell of the row above (a template row's count, an instance row's effort or
  # model), wrapping to the bottom: the mirror of →/tab. Reads and sets the loop's
  # cur/col/at/rm/re.
  roster_back() {
    local nc pti pmax="$maxcol" prm=0 pre=0
    nc=$(col_step "$col" -1 "$maxcol" "$rm" "$re")
    if [ "$nc" != "$col" ]; then col=$nc; return; fi
    cur="${rows[$(((at - 1 + ${#rows[@]}) % ${#rows[@]}))]}"
    pti="${cur#[TI]}"; pti="${pti%%:*}"
    case "$cur" in I*) pmax=2 ;; esac
    row_has "$pti" mod && prm=1; row_has "$pti" eff && pre=1
    col=$(col_last "$pmax" "$prm" "$pre")
  }
  # Presets fill the existing editable cells. The caller owns file access and
  # validation; a bad recipe must leave the current roster intact.
  roster_preset() {
    local data task_preview t m e idx k first=-1 counts=()
    [ -n "$load_preset" ] && [ ${#preset_names[@]} -gt 0 ] || return 0
    if [ "$preset_index" -lt 0 ] && [ "$1" -lt 0 ]; then preset_index=0; fi
    preset_index=$(((preset_index + $1 + ${#preset_names[@]}) % ${#preset_names[@]}))
    name="${preset_names[$preset_index]}"
    data=$("$load_preset" "$name" 2>&1) || { err="$data"; return; }
    task_preview="${data%%$'\n'*}"; data="${data#*$'\n'}"
    while IFS='|' read -r t m e; do
      idx=-1
      for k in "${!items[@]}"; do [ "${items[$k]}" != "$t" ] || idx=$k; done
      [ "$idx" -ge 0 ] || { err="preset '$name': '$t' is not in this roster menu"; return; }
      counts[$idx]=$((${counts[$idx]:-0} + 1))
      [ "${counts[$idx]}" -le 20 ] || { err="preset '$name': a template can have at most 20 members in the picker"; return; }
    done <<< "$data"
    for k in "${!items[@]}"; do on[$k]=0; cnt[$k]=0; same[$k]=1; inst[$k]=""; instm[$k]=""; done
    while IFS='|' read -r t m e; do
      for k in "${!items[@]}"; do [ "${items[$k]}" != "$t" ] || idx=$k; done
      [ "$first" -ge 0 ] || first=$idx
      on[$idx]=1; cnt[$idx]=$((cnt[idx] + 1))
      m="${m:-${MOD_INIT[$idx]:-}}"; e="${e:-${EFF_INIT[$idx]:-}}"
      if [ "${cnt[$idx]}" -eq 1 ]; then mod[$idx]="$m"; eff[$idx]="$e"
      elif [ "${mod[$idx]}" != "$m" ] || [ "${eff[$idx]}" != "$e" ]; then same[$idx]=0; fi
      inst_set "$idx" "${cnt[$idx]}" "${e:--}"
      instm_set "$idx" "${cnt[$idx]}" "${m:--}"
    done <<< "$data"
    for k in "${!items[@]}"; do [ "${cnt[$k]}" -gt 0 ] || cnt[$k]=1; done
    preset="$name"; preset_task="$task_preview"; cur="T$first"; col=0; pop=0
  }
  [ "${CHOOSER_REPAINT:-0}" = 1 ] || printf '\033[?1049h\033[?25l\033[2J' >&3
  while :; do
    rows=(); picked=0
    i=0
    while [ "$i" -lt "$n" ]; do
      rows+=("T$i")
      if [ "${on[$i]}" -eq 1 ]; then
        picked=$((picked + cnt[i]))
        if [ "${same[$i]}" -eq 0 ] && [ "${cnt[$i]}" -gt 1 ]; then
          j=1; while [ "$j" -le "${cnt[$i]}" ]; do rows+=("I$i:$j"); j=$((j + 1)); done
        fi
      fi
      i=$((i + 1))
    done
    local found=0; for r in "${rows[@]}"; do [ "$r" = "$cur" ] && found=1; done
    if [ "$found" -eq 0 ]; then cur="${cur#[TI]}"; cur="T${cur%%:*}"; fi
    f_line ""
    f_line "  $(printf '\033[1mRoster\033[0m \033[2mfor fleet\033[0m \033[1m%s\033[0m' "$lbl")"
    [ ${#preset_names[@]} -eq 0 ] || f_line "  preset: ${preset:-custom}   p next preset · P previous (then edit any cell)"
    [ -z "$preset_task" ] || f_line "  preset task (if you left task empty): $preset_task"
    f_line ""
    if [ "$has_cells" -eq 1 ]; then
      # Same widths as a template row below: `     [✓] [1] ` is 13 columns, then
      # the 24-wide name and a space, then one space before each 24 / 11 cell,
      # then two before the 5-wide count (as wide as its title).
      local head; head=$(printf '             %-24s ' "template")
      [ "$has_mod" -eq 1 ] && head="$head $(printf '%-24s' "model")"
      [ "$has_eff" -eq 1 ] && head="$head $(printf '%-11s' "effort")"
      f_line "$(printf '\033[2m%s  %s\033[0m' "$head" "count")"
    fi
    for r in "${rows[@]}"; do
      local line
      case "$r" in
        T*) i="${r#T}"
            mark="[ ]"; [ "${on[$i]}" -eq 1 ] && mark="[✓]"
            if [ "$r" = "$cur" ] && [ "$col" -eq 0 ]; then printf -v line '  \033[7m ▸ %s [%s] %-24s \033[0m' "$mark" "$((i + 1))" "${items[$i]}"
            elif [ "$r" = "$cur" ]; then printf -v line '   ▸ %s [%s] %-24s ' "$mark" "$((i + 1))" "${items[$i]}"
            else printf -v line '     %s [%s] %-24s ' "$mark" "$((i + 1))" "${items[$i]}"; fi
            if [ "$has_cells" -eq 1 ]; then
              local fm=0 fe=0 fc=0 folded=1
              [ "$r" = "$cur" ] && [ "$col" -eq 1 ] && fm=1
              [ "$r" = "$cur" ] && [ "$col" -eq 2 ] && fe=1
              [ "$r" = "$cur" ] && [ "$col" -eq 3 ] && fc=1
              { [ "${same[$i]}" -eq 0 ] && [ "${cnt[$i]}" -gt 1 ]; } && folded=0
              if [ "$has_mod" -eq 1 ]; then
                if [ "$folded" -eq 1 ] || [ -z "${MOD_VALS[$i]:-}" ]; then model_cell "${MOD_VALS[$i]:-}" "${mod[$i]}" "$fm"; line="$line $CELL"
                elif [ "$fm" -eq 1 ]; then line="$line $(printf '\033[7m%-24s\033[0m' "each own")"
                else line="$line $(printf '%-24s' "each own")"; fi
              fi
              if [ "$has_eff" -eq 1 ]; then
                if [ "$folded" -eq 1 ] || [ "${EFF_KIND[$i]:-none}" = none ]; then effort_cell "${EFF_KIND[$i]:-none}" "${eff[$i]}" "$fe"; line="$line $CELL"
                elif [ "$fe" -eq 1 ]; then line="$line $(printf '\033[7m%-11s\033[0m' "each own")"
                else line="$line $(printf '%-11s' "each own")"; fi
              fi
              if [ "$fc" -eq 1 ]; then line="$line  $(printf '\033[7m%-5s\033[0m' "${cnt[$i]}")"; else line="$line  $(printf '%-5s' "${cnt[$i]}")"; fi
              if [ "${cnt[$i]}" -gt 1 ]; then
                [ "${same[$i]}" -eq 1 ] && line="$line $(printf '\033[2msame [✓]\033[0m')" || line="$line $(printf '\033[2msame [ ]\033[0m')"
              fi
              [ "${EFF_KIND[$i]:-none}" = generic ] && line="$line $(printf '\033[2m(%s)\033[0m' "${EFF_VIA[$i]}")"
            fi
            f_line "$line" ;;
        I*) i="${r#I}"; j="${i#*:}"; i="${i%%:*}"
            local glyph; [ "$j" -eq "${cnt[$i]}" ] && glyph="└ #$j" || glyph="├ #$j"
            local fm=0 fe=0 rowfoc=0
            [ "$r" = "$cur" ] && [ "$col" -eq 1 ] && fm=1
            [ "$r" = "$cur" ] && [ "$col" -ge 2 ] && fe=1
            [ "$r" = "$cur" ] && [ "$col" -eq 0 ] && rowfoc=1
            if [ "$rowfoc" -eq 1 ]; then printf -v line '  \033[7m ▸          %-24s \033[0m' "$glyph"
            elif [ "$fm" -eq 1 ] || [ "$fe" -eq 1 ]; then printf -v line '   ▸          %-24s ' "$glyph"
            else printf -v line '              %-24s ' "$glyph"; fi
            [ "$has_mod" -eq 1 ] && { model_cell "${MOD_VALS[$i]:-}" "$(instm_val "$i" "$j")" "$fm"; line="$line $CELL"; }
            [ "$has_eff" -eq 1 ] && { effort_cell "${EFF_KIND[$i]:-none}" "$(inst_val "$i" "$j")" "$fe"; line="$line $CELL"; }
            f_line "$line" ;;
      esac
      # The open list unfolds right under its row, at its cell's column.
      if [ "$pop" -eq 1 ] && [ "$r" = "$cur" ]; then
        local pti="${cur#[TI]}"; pti="${pti%%:*}"; local pij=""; case "$cur" in I*) pij="${cur#*:}" ;; esac
        if [ "$pk" = mod ]; then
          local curm="${mod[$pti]}"; [ -n "$pij" ] && curm=$(instm_val "$pti" "$pij")
          list_lines "${MOD_VALS[$pti]}" "$curm" "$pidx" "$MODEL_WINDOW" "$(model_col 13)" 22
        else
          local cure="${eff[$pti]}"; [ -n "$pij" ] && cure=$(inst_val "$pti" "$pij")
          list_lines "${EFF_VALS[$pti]}" "$cure" "$pidx" 0 "$(effort_col 13 "$has_mod")" 9
        fi
      fi
    done
    f_line ""
    f_line "  $(printf '\033[2m%s member%s\033[0m' "$picked" "$([ "$picked" -eq 1 ] || printf s)")"
    [ -n "$err" ] && { f_line ""; f_line "  $(printf '\033[31m%s\033[0m' "$err")"; }
    local ti="${cur#[TI]}"; ti="${ti%%:*}"; local ij=""; case "$cur" in I*) ij="${cur#*:}" ;; esac
    f_line ""
    if [ "$pop" -eq 1 ]; then
      local curv; if [ "$pk" = mod ]; then curv="${mod[$ti]}"; [ -n "$ij" ] && curv=$(instm_val "$ti" "$ij"); else curv="${eff[$ti]}"; [ -n "$ij" ] && curv=$(inst_val "$ti" "$ij"); fi
      list_hint "$curv"
    else
      if [ "$has_cells" -eq 1 ]; then
        f_line "  $(printf '\033[2mspace tick   ↑/↓ move   →/tab column   +/- count   s per-instance cells   enter launch (on a cell: its list)   q abort\033[0m')"
      else
        f_line "  $(printf '\033[2mspace toggles   ↑/↓ · j/k move   number toggles   enter launches   q aborts\033[0m')"
      fi
    fi
    f_flush
    chooser_read_key 300 "$refresh" q; refresh_rc=$?
    case "$refresh_rc" in
      3) unset CHOOSER_KEY; CHOOSER_REPAINT=1 ask_roster_tty "${CHOOSER_INPUT[@]}" "$refresh" "$presets" "$load_preset"; return $? ;;
      0) ;;
      *) chooser_close_tty; return "$refresh_rc" ;;
    esac
    err=""
    local at=0; for r in "${!rows[@]}"; do [ "${rows[$r]}" = "$cur" ] && at=$r; done
    # which cells the row under the cursor has, for the column walk
    local rm=0 re=0; row_has "$ti" mod && rm=1; row_has "$ti" eff && re=1
    if [ "$pop" -eq 1 ]; then
      local vals cnt_v take=0
      [ "$pk" = mod ] && vals="${MOD_VALS[$ti]}" || vals="${EFF_VALS[$ti]}"
      cnt_v=$(effort_count "$vals")
      case "$key" in
        j|J) pidx=$(( (pidx + 2) % (cnt_v + 1) - 1 )) ;;
        k|K) pidx=$(( (pidx + cnt_v + 1) % (cnt_v + 1) - 1 )) ;;
        [0-9]) [ "$key" -le "$cnt_v" ] && { pidx=$((key - 1)); take=1; } ;;
        ''|$'\n'|$'\r') take=1 ;;
        q|Q) pop=0 ;;
        $'\e')
          chooser_escape_tail
          case "$rest" in
            '[A'|'OA') pidx=$(( (pidx + cnt_v + 1) % (cnt_v + 1) - 1 )) ;;
            '[B'|'OB') pidx=$(( (pidx + 2) % (cnt_v + 1) - 1 )) ;;
            '') pop=0 ;;
          esac ;;
      esac
      if [ "$take" -eq 1 ]; then
        local v; v=$(effort_at "$vals" "$pidx")
        if [ "$pk" = mod ]; then
          if [ -n "$ij" ]; then instm_set "$ti" "$ij" "${v:--}"; else mod[$ti]="$v"; fi
        elif [ -n "$ij" ]; then inst_set "$ti" "$ij" "${v:--}"; else eff[$ti]="$v"; fi
        # The list closes and the focus stays on the cell just set; ←/shift-tab to
        # the template column (or → to the count) and enter launches.
        pop=0
      fi
      continue
    fi
    case "$key" in
      ' ')   on[$ti]=$((1 - on[ti])) ;;
      [1-9]) [ "$key" -le "$n" ] && { cur="T$((key - 1))"; on[$((key - 1))]=$((1 - on[key - 1])); } ;;
      j|J)   cur="${rows[$(((at + 1) % ${#rows[@]}))]}" ;;
      k|K)   cur="${rows[$(((at - 1 + ${#rows[@]}) % ${#rows[@]}))]}" ;;
      # → and tab walk the row's cells and then on to the NEXT row's first column;
      # ← and shift-tab walk the same path backwards.
      l|L|$'\t') maxc="$maxcol"; [ -n "$ij" ] && maxc=2; nc=$(col_step "$col" 1 "$maxc" "$rm" "$re")
             if [ "$nc" = "$col" ]; then cur="${rows[$(((at + 1) % ${#rows[@]}))]}"; col=0; else col=$nc; fi ;;
      h|H)   roster_back ;;
      p)     roster_preset 1 ;;
      P)     roster_preset -1 ;;
      '+'|'=') [ "${cnt[$ti]}" -lt 20 ] && { cnt[$ti]=$((cnt[ti] + 1)); inst_set "$ti" "${cnt[$ti]}" "${eff[$ti]:--}"; instm_set "$ti" "${cnt[$ti]}" "${mod[$ti]:--}"; } ;;
      '-'|'_') [ "${cnt[$ti]}" -gt 1 ] && cnt[$ti]=$((cnt[ti] - 1)) ;;
      s|S)   { row_has "$ti" eff || row_has "$ti" mod; } && unfold "$ti" ;;
      ''|$'\n'|$'\r')
        # On a template row: the model cell (1) or the effort cell (2) opens its
        # list, the count cell (3) launches. On an instance row: col 1 is its model
        # cell, anything to the right its effort cell.
        if [ "$col" -eq 1 ] && row_has "$ti" mod; then
          local curv="${mod[$ti]}"; [ -n "$ij" ] && curv=$(instm_val "$ti" "$ij")
          pop=1; pk=mod; pidx=$(effort_index "${MOD_VALS[$ti]}" "$curv")
        elif row_has "$ti" eff && { { [ -n "$ij" ] && [ "$col" -ge 1 ]; } || [ "$col" -eq 2 ]; }; then
          local curv="${eff[$ti]}"; [ -n "$ij" ] && curv=$(inst_val "$ti" "$ij")
          pop=1; pk=eff; pidx=$(effort_index "${EFF_VALS[$ti]}" "$curv")
        elif [ "$picked" -gt 0 ]; then break
        else err="pick at least one template — a fleet with no members is nothing"; fi ;;
      q|Q)   chooser_close_tty; return 2 ;;
      $'\e')
        chooser_escape_tail
        case "$rest" in
          '[A'|'OA') cur="${rows[$(((at - 1 + ${#rows[@]}) % ${#rows[@]}))]}" ;;
          '[B'|'OB') cur="${rows[$(((at + 1) % ${#rows[@]}))]}" ;;
          '[C'|'OC') maxc="$maxcol"; [ -n "$ij" ] && maxc=2; nc=$(col_step "$col" 1 "$maxc" "$rm" "$re")
                     if [ "$nc" = "$col" ]; then cur="${rows[$(((at + 1) % ${#rows[@]}))]}"; col=0; else col=$nc; fi ;;
          '[D'|'OD') roster_back ;;
          '[Z')      roster_back ;;   # shift-tab
          '')        chooser_close_tty; return 2 ;;   # bare Esc = abort, like q
        esac ;;
    esac
  done
  chooser_close_tty
  [ -z "$preset" ] || printf '@preset\t%s\n' "$preset"
  i=0
  while [ "$i" -lt "$n" ]; do
    if [ "${on[$i]}" -eq 1 ]; then
      j=1
      while [ "$j" -le "${cnt[$i]}" ]; do
        local e="${eff[$i]}" m="${mod[$i]}"
        [ "${same[$i]}" -eq 0 ] && [ "${cnt[$i]}" -gt 1 ] && { e=$(inst_val "$i" "$j"); m=$(instm_val "$i" "$j"); }
        member_line "${items[$i]}" "$e" "$m" 1
        j=$((j + 1))
      done
    fi
    i=$((i + 1))
  done
}


# One verb from a short list, drawn like the template chooser so leaving a box
# feels like booting one. Rows are `id|hotkey|label|note`, one per line:
#
#   ask_action_tty <title> <default-id> <rows>
#
# Prints the chosen id on stdout. Returns 1 with no terminal, 2 on q/Esc/timeout —
# and the CALLER decides what an abort means (for the close prompt it is the
# default, since "get me out of here" and "leave it" are the same wish there).
#
# Two deliberate differences from the template chooser. A row's hotkey takes it
# outright, so `p` pulls and `L` leaves with one press, as the old line prompt
# did; and because `k` is a hotkey here, j/k do NOT navigate — arrows and numbers
# do. Anything destructive is the caller's to confirm: one keypress is enough to
# choose, not enough to lose a box.
ask_action_tty() {
  local title="$1" resolved="$2" rows="$3" sel=0 i n=0 key rest hit=""
  local ids=() keys=() labels=() notes=() wide=0 t
  while IFS='|' read -r id hk lb nt; do
    [ -n "$id" ] || continue
    ids+=("$id"); keys+=("$hk"); labels+=("$lb"); notes+=("${nt:-}")
    [ "${#nt}" -gt "$wide" ] && wide=${#nt}
    [ "$id" = "$resolved" ] && sel=$n
    n=$((n + 1))
  done <<EOF
$rows
EOF
  [ "$n" -gt 0 ] || return 1
  chooser_open_tty || return 1
  printf '\033[?1049h\033[?25l' >&3
  while :; do
    printf '\033[H' >&3
    printf '\n  \033[1m%s\033[0m\n\n' "$title" >&3
    i=0
    while [ "$i" -lt "$n" ]; do
      if [ "$i" -eq "$sel" ]; then
        printf '  \033[7m ▸ [%s] %-24s \033[0m' "${keys[$i]}" "${labels[$i]}" >&3
      else
        printf '     [%s] %-24s ' "${keys[$i]}" "${labels[$i]}" >&3
      fi
      [ "$wide" -gt 0 ] && printf ' \033[2m%-*s\033[0m' "$wide" "${notes[$i]}" >&3
      [ "${ids[$i]}" = "$resolved" ] && printf ' \033[2mdefault\033[0m' >&3
      printf '\033[K\n' >&3
      i=$((i + 1))
    done
    printf '\n  \033[2m↑/↓ move   enter confirm   letter picks   number jumps   q/esc %s\033[0m\n' "$resolved" >&3
    printf '\033[J' >&3
    IFS= read -rsn1 -t 120 key <&4 || { chooser_close_tty; return 2; }
    case "$key" in
      ''|$'\n'|$'\r') hit="${ids[$sel]}" ;;
      [1-9]) [ "$key" -le "$n" ] && hit="${ids[$((key - 1))]}" ;;
      q|Q)   chooser_close_tty; return 2 ;;
      $'\e')
        chooser_escape_tail
        case "$rest" in
          '[A'|'OA') sel=$(((sel - 1 + n) % n)) ;;
          '[B'|'OB') sel=$(((sel + 1) % n)) ;;
          '')        chooser_close_tty; return 2 ;;
        esac ;;
      *)
        # A hotkey, either case: the menu shows one case, the finger may use the other.
        i=0
        while [ "$i" -lt "$n" ]; do
          t="${keys[$i]}"
          if [ "$key" = "$t" ] || [ "$key" = "$(printf '%s' "$t" | tr '[:upper:]' '[:lower:]')" ] || [ "$key" = "$(printf '%s' "$t" | tr '[:lower:]' '[:upper:]')" ]; then
            hit="${ids[$i]}"; break
          fi
          i=$((i + 1))
        done ;;
    esac
    [ -n "$hit" ] && break
  done
  chooser_close_tty
  printf '%s' "$hit"
}
