#!/usr/bin/env bash
# Rebuild the README diagrams. The two light HTML files are the SOURCE; the dark
# variants and all four PNGs are generated — edit `delegate.html` / `fleet.html`
# and re-run this, never the outputs.
#
#   assets/diagrams/delegate.html  ──▶  assets/delegate.png  +  assets/delegate-dark.png
#   assets/diagrams/fleet.html     ──▶  assets/fleet.png     +  assets/fleet-dark.png
#
# The dark variant is a token swap, not a second drawing: the light/dark pairs
# below are diagram-design's own skin tokens, so a colour that isn't in this
# table is a colour the light file should not have used either.
#
# Needs Google Chrome (headless). Run from anywhere.
set -euo pipefail

DIR="$(CDPATH= cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(dirname "$DIR")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "no Chrome at $CHROME — set CHROME=..." >&2; exit 1; }

# slug:viewport-height — the height is the HTML's own svg height, so a diagram
# that grows needs its number changed here too.
DIAGRAMS=(delegate:296 fleet:624 lifecycle:912)

for d in "${DIAGRAMS[@]}"; do
  slug="${d%%:*}"; height="${d##*:}"

  python3 - "$DIR/$slug.html" "$DIR/$slug-dark.html" "$slug" <<'PY'
import sys
src, dst, slug = sys.argv[1], sys.argv[2], sys.argv[3]
PAIRS = [
    ("#f5f5f5", "#0c1117"),                            # paper — GitHub's dark canvas
    ("#2d3142", "#f5f5f5"),                            # ink
    ("#ffffff", "#151b23"),                            # paper-2 — one step up from canvas
    ("#4f5d75", "#bfc0c0"),                            # muted
    ("#7a8399", "#8e98ac"),                            # soft
    ("#eb6c36", "#f08a59"),                            # accent
    ("rgba(235,108,54,0.08)",  "rgba(240,138,89,0.10)"),
    ("rgba(235,108,54,0.40)",  "rgba(240,138,89,0.50)"),
    ("rgba(45,49,66,0.02)",    "rgba(245,245,245,0.03)"),
    ("rgba(45,49,66,0.05)",    "rgba(245,245,245,0.05)"),
    ("rgba(45,49,66,0.10)",    "rgba(245,245,245,0.10)"),
    ("rgba(45,49,66,0.40)",    "rgba(245,245,245,0.40)"),
    ("rgba(45,49,66,0.80)",    "rgba(245,245,245,0.80)"),
    ("rgba(79,93,117,0.10)",   "rgba(191,192,192,0.10)"),
    ("rgba(122,131,153,0.40)", "rgba(142,152,172,0.40)"),
]
s = open(src).read()
# Two passes through placeholders: ink→paper and paper→ink would otherwise
# chase each other and land every colour on the same value.
for i, (light, _) in enumerate(PAIRS):
    s = s.replace(light, f"@@{i}@@")
for i, (_, dark) in enumerate(PAIRS):
    s = s.replace(f"@@{i}@@", dark)
# Per-variant accessible IDs: two SVGs inlined in one page must never share them.
s = s.replace(f"{slug}-title", f"{slug}-dark-title").replace(f"{slug}-desc", f"{slug}-dark-desc")
open(dst, "w").write(s)
PY

  for variant in "$slug" "$slug-dark"; do
    "$CHROME" --headless --disable-gpu --hide-scrollbars \
      --force-device-scale-factor=2 --window-size="1000,$height" \
      --screenshot="$OUT/$variant.png" "file://$DIR/$variant.html" 2>/dev/null
    echo "  wrote assets/$variant.png"
  done
done
