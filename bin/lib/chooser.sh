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
# Self-contained on purpose: bash builtins only, no lib/paths.sh, no node, no
# state dir. Source it from anywhere, in any order. That is also why neither
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
ask_template_tty() {
  local lbl="$1" resolved="$2" choices="$3" n="$4" marks="${5:-}" sel=0 i key rest hit typed
  if { : >/dev/tty; } 2>/dev/null; then
    exec 3>/dev/tty 4</dev/tty
  elif [ -t 0 ] && { exec 3>&0; } 2>/dev/null; then
    exec 4<&0
  else
    return 1
  fi
  local items=()
  while IFS= read -r t; do [ -n "$t" ] && items+=("$t"); done <<EOF
$choices
EOF
  # Marks are indexed positionally, not compacted like <choices>: an interior blank
  # line means "this row has nothing to say", and dropping it would slide every
  # annotation below it onto the wrong template. TRAILING blanks are a different
  # story — the caller's own $(…) already stripped them, so this array is routinely
  # SHORTER than <choices> and the `:-` below is load-bearing rather than defensive.
  # `wide` is the longest mark, so the column fits whatever it is handed and 0 means
  # there is no column to draw at all.
  local notes=() wide=0
  i=0
  while IFS= read -r t; do
    notes[$i]="$t"
    [ "${#t}" -gt "$wide" ] && wide=${#t}
    i=$((i + 1))
  done <<EOF
$marks
EOF
  # Open on the default row wherever it sits in the list — the menu keeps its
  # configured order (base last), so row 1 is not the one Enter should take.
  i=0
  while [ "$i" -lt "$n" ]; do
    [ "${items[$i]}" = "$resolved" ] && { sel=$i; break; }
    i=$((i + 1))
  done
  # Draw on the alternate screen so the pane's scrollback survives — the sandbox
  # shell takes this pane over the moment we're done.
  printf '\033[?1049h\033[?25l' >&3
  while :; do
    printf '\033[2J\033[H' >&3
    printf '\n  \033[1mE2B template\033[0m \033[2mfor\033[0m \033[1m%s\033[0m\n\n' "$lbl" >&3
    i=0
    while [ "$i" -lt "$n" ]; do
      if [ "$i" -eq "$sel" ]; then
        printf '  \033[7m ▸ [%s] %-24s \033[0m' "$((i + 1))" "${items[$i]}" >&3
      else
        printf '     [%s] %-24s ' "$((i + 1))" "${items[$i]}" >&3
      fi
      # Reserve the column only when something is annotated, so a machine that has
      # never run `e2b-box auth` sees exactly the menu it always saw.
      [ "$wide" -gt 0 ] && printf ' \033[2m%-*s\033[0m' "$wide" "${notes[$i]:-}" >&3
      [ "${items[$i]}" = "$resolved" ] && printf ' \033[2mdefault\033[0m' >&3
      printf '\n' >&3
      i=$((i + 1))
    done
    printf '\n  \033[2m↑/↓ · j/k move   enter confirm   number jumps   t type a name   q/esc abort\033[0m\n' >&3
    # Bounded: a pane nobody is watching must not wedge provisioning forever. A
    # timeout is not a choice either — nobody is there to make one.
    IFS= read -rsn1 -t 120 key <&4 || { chooser_close_tty; return 2; }
    hit=""
    case "$key" in
      [1-9]) [ "$key" -le "$n" ] && hit="${items[$((key - 1))]}" ;;
      j|J)   sel=$(((sel + 1) % n)) ;;
      k|K)   sel=$(((sel - 1 + n) % n)) ;;
      t|T)   printf '\033[?25h\n  template name: ' >&3
             IFS= read -r -t 120 typed <&4 || typed=""
             [ -n "$typed" ] && hit="$typed" || printf '\033[?25l' >&3 ;;
      ''|$'\n'|$'\r') hit="${items[$sel]}" ;;
      # q and bare Esc ABORT — they used to take the default, which meant leaving
      # the menu booted a sandbox you never picked (a `base` box, billing, from a
      # keypress that means "get me out of here"). Both other pickers already read
      # these as an abort; this one was the outlier. Enter is how you take a row.
      q|Q)   chooser_close_tty; return 2 ;;
      $'\e')
        IFS= read -rsn2 -t 1 rest <&4
        case "$rest" in
          '[A'|'OA') sel=$(((sel - 1 + n) % n)) ;;
          '[B'|'OB') sel=$(((sel + 1) % n)) ;;
          '')        chooser_close_tty; return 2 ;;
        esac ;;
    esac
    [ -n "$hit" ] && break
  done
  chooser_close_tty
  printf '%s' "$hit"
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
  local note="$1" validate="${2:-}" want_task="${3:-}" buf="" task="" field=0 key rest err=""
  chooser_open_tty || return 1
  printf '\033[?1049h' >&3
  while :; do
    printf '\033[2J\033[H' >&3
    printf '\n  \033[1mNew E2B fleet\033[0m\n\n' >&3
    printf '  \033[2mA short name for what this fleet is for. Every member'\''s branch\n' >&3
    printf '  carries it, so it is sanitized into a legal git ref.\033[0m\n\n' >&3
    [ -n "$note" ] && printf '  \033[33m%s\033[0m\n\n' "$note" >&3
    # The block cursor marks the field being typed into; with no task field
    # there is only ever one, so this draws exactly what it always drew.
    if [ "$field" -eq 0 ]; then
      printf '  task slug: %s\033[7m \033[0m\n' "$buf" >&3
    else
      printf '  task slug: %s\n' "$buf" >&3
    fi
    if [ -n "$want_task" ]; then
      printf '\n  \033[2mOptional. The fleet task: one instruction, handed to every member'\''s\n' >&3
      printf '  agent as it comes up. Leave it empty to just get the boxes.\033[0m\n\n' >&3
      if [ "$field" -eq 1 ]; then
        printf '  fleet task: %s\033[7m \033[0m\n' "$task" >&3
      else
        printf '  fleet task: %s\n' "$task" >&3
      fi
    fi
    [ -n "$err" ] && printf '\n  \033[31m%s\033[0m\n' "$err" >&3
    if [ -n "$want_task" ]; then
      printf '\n  \033[2mtab · ↑/↓ switch field   backspace deletes   enter launches   esc aborts\033[0m\n' >&3
    else
      printf '\n  \033[2mtype to edit   backspace deletes   enter continues   esc aborts\033[0m\n' >&3
    fi
    # Bounded like the template chooser: a pane nobody is watching must not sit
    # here forever holding a keybinding hostage.
    IFS= read -rsn1 -t 300 key <&4 || { chooser_close_tty; return 2; }
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
        # discrimination as the template chooser, and the same 1s window.
        IFS= read -rsn2 -t 1 rest <&4
        case "$rest" in
          '[A'|'OA'|'[B'|'OB') [ -n "$want_task" ] && field=$((1 - field)) ;;
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
ask_roster_tty() {
  local lbl="$1" choices="$2" n="$3" pre="$4" sel=-1 i key rest err="" picked=0 mark
  chooser_open_tty || return 1
  local items=() on=()
  while IFS= read -r t; do [ -n "$t" ] && items+=("$t"); done <<EOF
$choices
EOF
  i=0
  while [ "$i" -lt "$n" ]; do
    case $'\n'"$pre"$'\n' in
      *$'\n'"${items[$i]}"$'\n'*) on[$i]=1; [ "$sel" -lt 0 ] && sel=$i ;;
      *) on[$i]=0 ;;
    esac
    i=$((i + 1))
  done
  # Open on the first pre-ticked row, so the common case ("my usual roster") is
  # enter and nothing else; no default roster means start at the top.
  [ "$sel" -lt 0 ] && sel=0
  printf '\033[?1049h\033[?25l' >&3
  while :; do
    picked=0
    i=0; while [ "$i" -lt "$n" ]; do [ "${on[$i]}" -eq 1 ] && picked=$((picked + 1)); i=$((i + 1)); done
    printf '\033[2J\033[H' >&3
    printf '\n  \033[1mRoster\033[0m \033[2mfor fleet\033[0m \033[1m%s\033[0m \033[2m— one member per template\033[0m\n\n' "$lbl" >&3
    i=0
    while [ "$i" -lt "$n" ]; do
      mark="[ ]"; [ "${on[$i]}" -eq 1 ] && mark="[✓]"
      if [ "$i" -eq "$sel" ]; then
        printf '  \033[7m ▸ %s [%s] %-24s \033[0m\n' "$mark" "$((i + 1))" "${items[$i]}" >&3
      else
        printf '     %s [%s] %-24s \n' "$mark" "$((i + 1))" "${items[$i]}" >&3
      fi
      i=$((i + 1))
    done
    printf '\n  \033[2m%s selected\033[0m\n' "$picked" >&3
    [ -n "$err" ] && printf '\n  \033[31m%s\033[0m\n' "$err" >&3
    printf '\n  \033[2mspace toggles   ↑/↓ · j/k move   number toggles   enter launches   q aborts\033[0m\n' >&3
    IFS= read -rsn1 -t 300 key <&4 || { chooser_close_tty; return 2; }
    err=""
    case "$key" in
      ' ')   on[$sel]=$((1 - on[sel])) ;;
      [1-9]) [ "$key" -le "$n" ] && { sel=$((key - 1)); on[$sel]=$((1 - on[sel])); } ;;
      j|J)   sel=$(((sel + 1) % n)) ;;
      k|K)   sel=$(((sel - 1 + n) % n)) ;;
      ''|$'\n'|$'\r')
        # An empty roster is not a fleet — say so and stay put rather than
        # launching nothing and calling it a success.
        if [ "$picked" -gt 0 ]; then break; fi
        err="pick at least one template — a fleet with no members is nothing" ;;
      q|Q)   chooser_close_tty; return 2 ;;
      $'\e')
        IFS= read -rsn2 -t 1 rest <&4
        case "$rest" in
          '[A'|'OA') sel=$(((sel - 1 + n) % n)) ;;
          '[B'|'OB') sel=$(((sel + 1) % n)) ;;
          '')        chooser_close_tty; return 2 ;;   # bare Esc = abort, like q
        esac ;;
    esac
  done
  chooser_close_tty
  i=0
  while [ "$i" -lt "$n" ]; do
    [ "${on[$i]}" -eq 1 ] && printf '%s\n' "${items[$i]}"
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
    printf '\033[2J\033[H' >&3
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
      printf '\n' >&3
      i=$((i + 1))
    done
    printf '\n  \033[2m↑/↓ move   enter confirm   letter picks   number jumps   q/esc %s\033[0m\n' "$resolved" >&3
    IFS= read -rsn1 -t 120 key <&4 || { chooser_close_tty; return 2; }
    case "$key" in
      ''|$'\n'|$'\r') hit="${ids[$sel]}" ;;
      [1-9]) [ "$key" -le "$n" ] && hit="${ids[$((key - 1))]}" ;;
      q|Q)   chooser_close_tty; return 2 ;;
      $'\e')
        IFS= read -rsn2 -t 1 rest <&4
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
