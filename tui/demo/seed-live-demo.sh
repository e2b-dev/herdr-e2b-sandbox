#!/usr/bin/env bash
# Set up a LIVE demo state for the dashboard GIF: 5 placeholder sandbox records
# plus one REAL sandbox ("web") provisioned via e2b-box — so the recording can
# actually open it and return to the board. Needs an E2B API key configured.
#   usage: seed-live-demo.sh <state_dir>
set -euo pipefail
STATE="${1:?usage: seed-live-demo.sh <state_dir>}"
BOXES="$STATE/boxes"
rm -rf "$STATE"; mkdir -p "$BOXES"

w() { printf '%s\n' "$2" > "$BOXES/$1.json"; }
w admin-1f2e3d4c  '{"key":"admin-1f2e3d4c","label":"admin","status":"ready","step":"ready","sandboxId":"i3k9adminbox0011aa","url":"https://3000-i3k9adminbox0011aa.e2b.app","files":88,"branch":"feature/rbac","worktreePath":"/Users/you/projects/admin"}'
w api-9a8b7c6     '{"key":"api-9a8b7c6","label":"api","status":"provisioning","step":"uploading 210/540 files","branch":"main","worktreePath":"/Users/you/projects/api"}'
w cli-9f8e7d6c    '{"key":"cli-9f8e7d6c","label":"cli","status":"failed","step":"provision failed · see logs","branch":"main","worktreePath":"/Users/you/projects/cli"}'
w docs-a1b2c3d4   '{"key":"docs-a1b2c3d4","label":"docs","status":"paused","step":"ready","sandboxId":"a1b2c3paused0000zz","url":"https://3000-a1b2c3paused0000zz.e2b.app","files":240,"branch":"feature/search","worktreePath":"/Users/you/projects/docs"}'
w worker-55aa66bb '{"key":"worker-55aa66bb","label":"worker","status":"ready","step":"ready","sandboxId":"iworker66box0002cc","url":"https://3000-iworker66box0002cc.e2b.app","files":31,"branch":"main","worktreePath":"/Users/you/projects/worker"}'

# the real one: a tiny "web" project, provisioned into a live E2B sandbox
PROJ=/tmp/e2b-demo/web
rm -rf /tmp/e2b-demo; mkdir -p "$PROJ"
( cd "$PROJ"
  git init -q
  printf '# web\n\nhello from the web sandbox\n' > README.md
  printf 'node_modules/\n' > .gitignore
  git add -A && git -c user.email=demo@demo.dev -c user.name=demo commit -qm init )

echo "provisioning the real 'web' sandbox…"
( cd "$PROJ" && HERDR_E2B_STATE_DIR="$STATE" e2b-box up )
for _ in $(seq 1 90); do
  f=$(ls "$BOXES"/web-*.json 2>/dev/null | head -1)
  [ -n "$f" ] && [ "$(jq -r '.status // empty' "$f" 2>/dev/null)" = ready ] && { echo "web ready: $(jq -r .sandboxId "$f")"; exit 0; }
  sleep 1
done
echo "web did not become ready in time" >&2; exit 1
