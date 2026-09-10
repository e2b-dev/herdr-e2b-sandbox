#!/usr/bin/env bash
# Cache only chooser arguments, never answers or credentials. NUL fields are data,
# not shell source, so a worktree or model name cannot become executable code.
picker_preset_names() {
  local file name
  for file in "$CONFIG_DIR"/presets/*.json; do
    [ -f "$file" ] || continue
    name="${file##*/}"; name="${name%.json}"
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] && printf '%s\n' "$name"
  done
  return 0
}

picker_preset_rows() {
  local node
  node=$(pane_node) || return 1
  "$node" "$PLUGIN_DIR/src/fleet-spec.js" --rows "$1"
}

picker_cache_read() {
  local value
  PICKER_CACHE=()
  [ -r "$1" ] || return 1
  while IFS= read -r -d '' value; do PICKER_CACHE+=("$value"); done < "$1"
  [ "${#PICKER_CACHE[@]}" -eq 14 ] && [ "${PICKER_CACHE[0]}" = 1 ] && [ "${PICKER_CACHE[1]}" = "$PWD" ] || return 1
  [[ "${PICKER_CACHE[6]}" =~ ^[0-9]*$ && "${PICKER_CACHE[11]}" =~ ^[0-9]*$ ]]
}

picker_cache_write() {
  local mode="$1" file tmp i offset=3; shift
  file=$(picker_cache_path)
  picker_cache_read "$file" || PICKER_CACHE=(1 "$PWD" "${PICKER_BOX_KEY:-$(box_key "$PWD")}" '' '' '' '' '' '' '' '' '' '' '')
  [ "$mode" = fleet ] && offset=9
  for i in "$@"; do PICKER_CACHE[$offset]="$i"; offset=$((offset + 1)); done
  if mkdir -p "${file%/*}" && tmp=$(mktemp "$file.XXXXXX"); then
    printf '%s\0' "${PICKER_CACHE[@]}" > "$tmp" && mv -f "$tmp" "$file"
  fi
  # Each popup receives its own result, so another popup cannot settle its read.
  [ -z "${E2B_PICKER_INPUT:-}" ] || printf '%s\0' "${PICKER_CACHE[@]}" > "$E2B_PICKER_INPUT"
  return 0
}

# Called by the chooser only AFTER its frame is flushed. Every reopen resolves
# again, including config/catalog edits, branch rules, auth and live box records.
# This deliberately has no dependency fingerprint that could miss an input.
picker_refresh() {
  local rc old new
  [ "${picker_fresh_screen:-}" != "$picker_screen" ] || return 0
  if [ -z "${picker_job:-}" ]; then
    (
      HERDR_PLUGIN_CONTEXT_JSON= E2B_PICKER_INPUT="$picker_work/input" "$DIR/e2b-box" "$picker_command" > "$picker_work/out" 2> "$picker_work/error"
      printf '%s\n' "$?" > "$picker_work/done"
    ) &
    picker_job=$!
  fi
  [ -f "$picker_work/done" ] || return 1
  IFS= read -r rc < "$picker_work/done"
  if [ "$rc" != 0 ]; then cat "$picker_work/error" >&2; return 5; fi
  old=$(printf '%s\034' "${CHOOSER_INPUT[@]}")
  picker_cache_read "$picker_work/input" || return 5
  [ "$picker_screen" != box ] || [ -n "${PICKER_CACHE[5]}" ] || return 4
  case "$picker_screen" in
    box) CHOOSER_INPUT=("${PICKER_CACHE[@]:3:6}") ;;
    slug) CHOOSER_INPUT=("${PICKER_CACHE[9]}" picker_slug_valid task) ;;
    roster) CHOOSER_INPUT=("$picker_slug" "${PICKER_CACHE[@]:10:4}") ;;
  esac
  new=$(printf '%s\034' "${CHOOSER_INPUT[@]}")
  picker_fresh_screen="$picker_screen"
  [ "$old" = "$new" ] || return 3
  return 0
}

picker_slug_valid() {
  local node
  node=$(pane_node) || return 1
  "$node" "$PLUGIN_DIR/src/fleet-name.js" "$1" base >/dev/null 2>&1
}

picker_popup_prepare() {
  picker_work=$(mktemp -d "$STATE_DIR/pickers/refresh.XXXXXX") || return 1
  picker_job=""; picker_fresh_screen=""
  trap '[ -z "$picker_job" ] || kill "$picker_job" 2>/dev/null; rm -rf "$picker_work"' EXIT
}

picker_popup_box() {
  local rc
  picker_popup_prepare || return 1
  picker_command=pick; picker_screen=box
  CHOOSER_INPUT=("${PICKER_CACHE[@]:3:6}")
  ask_template_tty "${CHOOSER_INPUT[@]}" picker_refresh > "$picker_work/answer"; rc=$?
  if [ "$rc" -eq 4 ]; then cat "$picker_work/out"; return 0; fi
  [ "$rc" -eq 0 ] || return "$rc"
  printf '%s\n' "${PICKER_CACHE[2]}"
  cat "$picker_work/answer"
}

picker_popup_fleet() {
  local rc task t e m args=()
  picker_popup_prepare || return 1
  picker_command=fleet; picker_screen=slug
  CHOOSER_INPUT=("${PICKER_CACHE[9]}" picker_slug_valid task)
  ask_slug_tty "${CHOOSER_INPUT[@]}" picker_refresh > "$picker_work/answer"; rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  { IFS= read -r picker_slug; IFS= read -r task || true; } < "$picker_work/answer"
  picker_screen=roster
  CHOOSER_INPUT=("$picker_slug" "${PICKER_CACHE[@]:10:4}")
  ask_roster_tty "${CHOOSER_INPUT[@]}" picker_refresh "$(picker_preset_names)" picker_preset_rows > "$picker_work/answer"; rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  while IFS=$'\t' read -r t e m; do
    if [ "$t" = @preset ]; then args+=(--preset "$e"); continue; fi
    [ "$e" != - ] || e=""
    [ -z "$t" ] || args+=(-t "$t${m:+:$m}${e:+@$e}")
  done < "$picker_work/answer"
  rm -rf "$picker_work"; trap - EXIT
  HERDR_PLUGIN_CONTEXT_JSON= E2B_PICKER_DIRTY_NOTE="${PICKER_CACHE[9]}" exec "$DIR/e2b-box" fleet --slug "$picker_slug" ${task:+--task "$task"} "${args[@]}"
}
