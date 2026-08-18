#!/usr/bin/env bash
# Print the CHANGELOG.md section body for a version, e.g. `changelog-notes.sh 0.1.0`
# emits everything under `## [0.1.0] ...` up to (not including) the next `## [` header.
# Used by the release workflow to build the GitHub Release notes.
set -euo pipefail
ver="${1:?usage: changelog-notes.sh <version>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
awk -v ver="$ver" '
  index($0, "## [" ver "]") == 1 { grab = 1; next }
  # Stop at the next version header, or the footer link-reference definitions
  # (e.g. "[0.1.0]: https://…") — neither belongs in this section body.
  grab && (/^## \[/ || /^\[[^][]*\]: /) { exit }
  grab { print }
' "$root/CHANGELOG.md"
