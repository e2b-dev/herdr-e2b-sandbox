#!/usr/bin/env bash
# Build step for `herdr plugin install` (and manual local dev):
# install node deps and link the e2b-box CLI onto PATH.
set -euo pipefail
DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "herdr-e2b: installing node deps…"
if command -v npm >/dev/null 2>&1; then
  # Reproducible install from the committed lockfile when possible.
  if [ -f package-lock.json ]; then
    npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install
  else
    npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install
  fi
else
  echo "  ! npm not found — install Node.js (>=22), then re-run ./install.sh" >&2
fi

chmod +x bin/e2b-box bin/e2b-box-open bin/e2b-dash bin/e2b-dash-toggle \
         bin/e2b-fleet bin/e2b-fleet-open bin/e2b-bench bin/teardown-worktree 2>/dev/null || true

BIN="${HOME}/.local/bin"
mkdir -p "$BIN"
ln -sf "$DIR/bin/e2b-box" "$BIN/e2b-box"
echo "herdr-e2b: linked e2b-box -> $BIN/e2b-box"

# Fleets are `e2b-box fleet`, so bin/e2b-fleet is an implementation detail and is
# deliberately NOT linked onto PATH — one CLI is the whole point. Everything that
# reaches it goes through e2b-box (which resolves it by absolute path) or through
# the plugin entrypoints (which use $HERDR_PLUGIN_ROOT).
#
# An older install put it on PATH; leaving that symlink behind would keep a second
# CLI alive that no longer gets documented, so it is removed — but only when it is
# OUR symlink, never a file somebody else put there.
if [ -L "$BIN/e2b-fleet" ] && [ "$(readlink "$BIN/e2b-fleet")" = "$DIR/bin/e2b-fleet" ]; then
  rm -f "$BIN/e2b-fleet"
  echo "herdr-e2b: removed the old e2b-fleet link — it is 'e2b-box fleet' now"
fi
ln -sf "$DIR/bin/e2b-fleet-open" "$BIN/e2b-fleet-open"

# The grader, linked unconditionally even though its Rust binary may not exist
# yet (only the cargo path below builds it — the release assets and the committed
# prebuilts carry the dashboard alone). Linking anyway means a user who types
# `e2b-bench` gets the launcher's "not built, here is how" instead of a bare
# `command not found`, which says nothing about what to do next.
ln -sf "$DIR/bin/e2b-bench" "$BIN/e2b-bench"
echo "herdr-e2b: linked e2b-bench -> $BIN/e2b-bench"

# Make sure that bin dir is actually on PATH — otherwise the first thing a new
# user types ('e2b-box') is a 'command not found'. Warn with the exact fix.
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  ! $BIN is not on your PATH — add it, e.g.:"
     echo "      echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc   # (or ~/.bashrc), then restart your shell" ;;
esac

command -v e2b >/dev/null 2>&1 || echo "  ! e2b CLI not found — 'npm i -g @e2b/cli' (needed for the sandbox shell)"

# Optional dashboard TUI (Rust/Ratatui). Source first when a toolchain exists,
# else the binary this checkout's version published to its GitHub Release, else
# the committed prebuilt. The core plugin works without it; every branch below
# degrades to a friendly note rather than failing the install. The launcher
# always resolves tui/target/release/e2b-dash.
#
# `e2b-bench` comes out of the same crate but is NOT covered by the download
# paths: a release asset and a committed prebuilt are one file each, and that
# file is the dashboard. So the grader exists only where cargo ran. That is
# stated rather than papered over — its launcher says how to build it.
CANONICAL_REPO="tomasvarga/herdr-e2b"   # where releases are published
ln -sf "$DIR/bin/e2b-dash" "$BIN/e2b-dash"
ln -sf "$DIR/bin/e2b-dash-toggle" "$BIN/e2b-dash-toggle"
# Which GitHub repo publishes this plugin's releases. A fork can carry none, so
# the canonical repo is tried after whatever `origin` says; $HERDR_E2B_RELEASE_REPO
# overrides both (useful for testing, or an internal mirror).
release_repos() {
  local origin slug
  if [ -n "${HERDR_E2B_RELEASE_REPO:-}" ]; then printf '%s\n' "$HERDR_E2B_RELEASE_REPO"; return 0; fi
  origin=$(git -C "$DIR" remote get-url origin 2>/dev/null || true)
  case "$origin" in
    *github.com[:/]*)
      slug=${origin#*github.com}          # ":owner/repo.git" or "/owner/repo.git"
      slug=${slug#[:/]}; slug=${slug%.git}
      [ -n "$slug" ] && printf '%s\n' "$slug" ;;
  esac
  printf '%s\n' "$CANONICAL_REPO"
}

# The version this checkout claims — the release we must match, so the dashboard
# can never be newer or older than the plugin around it.
plugin_version() {
  grep -E '^version' "$DIR/herdr-plugin.toml" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)".*/\1/'
}

# Fetch $1 (asset name) for this version into $2. Quiet, bounded, and best
# effort: no network, no release for this version, or a fork without assets all
# just return non-zero so the caller falls through to the next option.
fetch_asset() {
  local asset="$1" dest="$2" ver repo url tmp
  ver=$(plugin_version); [ -n "$ver" ] || return 1
  tmp="$dest.download.$$"
  while read -r repo; do
    [ -n "$repo" ] || continue
    url="https://github.com/$repo/releases/download/v$ver/$asset"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 2 --max-time 120 -o "$tmp" "$url" 2>/dev/null || { rm -f "$tmp"; continue; }
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$tmp" "$url" 2>/dev/null || { rm -f "$tmp"; continue; }
    else
      return 1   # no downloader at all
    fi
    # A 200 that isn't a binary (an HTML error page, an LFS pointer) would install
    # something unrunnable, so check the magic bytes before committing to it.
    case "$(head -c 4 "$tmp" | od -An -tx1 | tr -d ' \n')" in
      cffaedfe|cefaedfe|cafebabe|feedface|7f454c46) ;;   # Mach-O (incl. fat) / ELF
      *) rm -f "$tmp"; continue ;;
    esac
    chmod +x "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$dest" || { rm -f "$tmp"; continue; }
    printf '%s' "$repo"
    return 0
  done <<EOF
$(release_repos)
EOF
  return 1
}

prebuilt=""
case "$(uname -s)" in
  Darwin) prebuilt="e2b-dash-darwin-universal" ;;
  Linux)
    # The Linux prebuilts are glibc-dynamic — on musl (Alpine) they won't run, so
    # skip them there and let the cargo path build from source instead.
    if ! ldd --version 2>&1 | grep -qi musl; then
      case "$(uname -m)" in
        aarch64|arm64) prebuilt="e2b-dash-linux-arm64" ;;
        x86_64)        prebuilt="e2b-dash-linux-x64" ;;
      esac
    fi ;;
esac
mkdir -p "$DIR/tui/target/release"
# Clear any stale/wrong-platform binary so we never run a leftover from another
# machine; each branch below re-creates it (or leaves it absent → launcher errors).
rm -f "$DIR/tui/target/release/e2b-dash"
# SOURCE FIRST when a toolchain exists. The prebuilts in tui/prebuilt/ are
# hand-committed artifacts — release CI publishes them, nothing rebuilds them —
# so on any checkout whose tui/src has moved ahead of them, preferring the
# prebuilt silently installs an OLDER dashboard than the code you are holding,
# with no error to say so. Building takes seconds; a silent downgrade costs an
# afternoon. The prebuilt remains the fallback that keeps this dependency-free
# for anyone without Rust.
# Falls back to the committed prebuilt: used when a build fails and when there is
# no release asset to fetch.
use_committed_prebuilt() {
  [ -n "$prebuilt" ] && [ -f "$DIR/tui/prebuilt/$prebuilt" ] || return 1
  chmod +x "$DIR/tui/prebuilt/$prebuilt" 2>/dev/null || true
  ln -sf "../../prebuilt/$prebuilt" "$DIR/tui/target/release/e2b-dash"
}

if command -v cargo >/dev/null 2>&1; then
  echo "herdr-e2b: building the dashboard from source (cargo)…"
  if (cd "$DIR/tui" && cargo build --release >/dev/null 2>&1); then
    # One crate, two binaries: the board and the grader are built together, so
    # this is the only branch that produces e2b-bench at all.
    echo "  built — run 'e2b-dash' or open the 'dashboard' pane. 'e2b-bench' is ready too."
  else
    echo "  ! build failed — trying the published binary for v$(plugin_version)…" >&2
    if from_repo=$(fetch_asset "$prebuilt" "$DIR/tui/target/release/e2b-dash") && [ -n "$prebuilt" ]; then
      echo "  downloaded from $from_repo — run 'e2b-dash' or open the 'dashboard' pane."
    elif use_committed_prebuilt; then
      echo "  ! using the committed prebuilt instead (may be older than this checkout)." >&2
    fi
  fi
# No toolchain: take the binary published for THIS version, so the dashboard
# matches the plugin around it. Only then the committed copy.
elif [ -n "$prebuilt" ] && from_repo=$(fetch_asset "$prebuilt" "$DIR/tui/target/release/e2b-dash"); then
  echo "herdr-e2b: dashboard ready (downloaded $prebuilt v$(plugin_version) from $from_repo)."
  echo "  run 'e2b-dash' or open the 'dashboard' pane."
elif use_committed_prebuilt; then
  echo "herdr-e2b: dashboard ready (committed prebuilt: $prebuilt) — run 'e2b-dash' or open the 'dashboard' pane."
  echo "  note: no release asset for v$(plugin_version) was reachable, so this is the checked-in binary."
else
  # Nothing worked — say so and move on. The dashboard is optional; a missing one
  # must never fail the install (offline machine, musl, unsupported arch).
  echo "herdr-e2b: no dashboard binary for $(uname -sm) — skipping (optional)."
  echo "  to enable it: install rustup (https://rustup.rs), then (cd tui && cargo build --release),"
  echo "  or re-run ./install.sh with a network connection to fetch the published binary."
fi

# API key: if we don't already have one (env or config), prompt to save it into
# the plugin config. Interactive only — the `herdr plugin install` build step
# has no TTY, so it skips silently (set the key later). Never clobbers a config.
# Keep IN SYNC with src/config.js and bin/lib/paths.sh. HERDR_PLUGIN_CONFIG_DIR
# is set when herdr runs this as the plugin's build step; the XDG path is the
# fallback for a hand-run ./install.sh.
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/e2b-dev.herdr-e2b}"
CFG="$CONFIG_DIR/config.toml"
have_key=0
[ -n "${E2B_API_KEY:-}" ] && have_key=1
[ -f "$CFG" ] && grep -q 'e2b_api_key' "$CFG" && have_key=1
if [ "$have_key" -eq 1 ]; then
  echo "herdr-e2b: E2B API key already configured."
elif [ -t 0 ]; then
  printf 'herdr-e2b: paste your E2B API key to save it (blank = skip · https://e2b.dev/dashboard): '
  read -rs E2B_KEY_INPUT; echo
  if [ -n "$E2B_KEY_INPUT" ]; then
    mkdir -p "$CONFIG_DIR"
    if [ -f "$CFG" ]; then
      echo "  $CFG exists — add under a [secrets] section:  e2b_api_key = \"…\""
    else
      printf '[secrets]\ne2b_api_key = "%s"\n' "$E2B_KEY_INPUT" > "$CFG"
      chmod 600 "$CFG"
      echo "  saved key to $CFG"
    fi
  else
    echo "  skipped — set [secrets].e2b_api_key in $CFG later, or export E2B_API_KEY"
  fi
else
  echo "  ! No E2B API key — set [secrets].e2b_api_key in $CFG, or export E2B_API_KEY"
fi

# The e2b SDK needs Node >= 22. herdr may launch under an older node; the plugin
# auto-resolves a newer one (nvm/Homebrew) at runtime, but warn if PATH is old.
if command -v node >/dev/null 2>&1 && ! node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)' 2>/dev/null; then
  echo "  ! Node $(node -v) on PATH is < 22 (e2b SDK needs >=22). The plugin will use a newer node if one is installed; else set HERDR_E2B_NODE=/path/to/node."
fi

# Template recommendation — "base" (the default) is minimal & tight on disk.
echo "herdr-e2b: tip — sandboxes default to the 'base' template (minimal). For real"
echo "  work, build a bigger CUSTOM template (more disk/CPU + your toolchain) and"
echo "  set [sandbox].template in $CFG. Build with 'e2b template build'"
echo "  (https://e2b.dev/docs/sandbox-template) — or ask your coding agent to set"
echo "  one up. Public agent templates (claude, codex, opencode, amp, grok) also work."

echo "herdr-e2b: done. Bind prefix+shift+e (open sandbox), prefix+shift+f (fleet) and"
echo "  prefix+shift+d (dashboard) in your herdr config."
