#!/usr/bin/env bash
# Seed sample box records so the POC dashboards have something to render.
# Point a dashboard at poc/sample-boxes to demo without live boxes.
# Names are generic placeholders — not real projects.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sample-boxes"
mkdir -p "$DIR"
rm -f "$DIR"/*.json

write() { printf '%s\n' "$2" > "$DIR/$1.json"; }

write admin-1f2e3d4c  '{"key":"admin-1f2e3d4c","label":"admin","status":"ready","step":"ready","sandboxId":"i3k9adminbox0011aa","url":"https://3000-i3k9adminbox0011aa.e2b.app","projectPath":"/home/user/project","files":88,"branch":"feature/rbac","worktreePath":"/Users/you/projects/admin","updatedAt":"2026-07-14T16:40:00Z"}'
write api-9a8b7c6     '{"key":"api-9a8b7c6","label":"api","status":"provisioning","step":"uploading 210/540 files","branch":"main","worktreePath":"/Users/you/projects/api","updatedAt":"2026-07-14T16:52:10Z"}'
write cli-9f8e7d6c    '{"key":"cli-9f8e7d6c","label":"cli","status":"failed","step":"provision failed · see logs","branch":"main","worktreePath":"/Users/you/projects/cli","updatedAt":"2026-07-14T13:40:00Z"}'
write docs-a1b2c3d4   '{"key":"docs-a1b2c3d4","label":"docs","status":"paused","step":"ready","sandboxId":"a1b2c3paused0000zz","url":"https://3000-a1b2c3paused0000zz.e2b.app","projectPath":"/home/user/project","files":240,"branch":"feature/search","worktreePath":"/Users/you/projects/docs","updatedAt":"2026-07-14T14:02:00Z"}'
write web-3737f02d    '{"key":"web-3737f02d","label":"web","status":"ready","step":"ready","sandboxId":"inpxiwzqafspsbqhlgy","url":"https://3000-inpxiwzqafspsbqhlgy.e2b.app","projectPath":"/home/user/project","files":142,"branch":"feature/checkout","worktreePath":"/Users/you/projects/web","updatedAt":"2026-07-14T16:10:00Z"}'
write worker-55aa66bb '{"key":"worker-55aa66bb","label":"worker","status":"ready","step":"ready","sandboxId":"iworker66box0002cc","url":"https://3000-iworker66box0002cc.e2b.app","projectPath":"/home/user/project","files":31,"branch":"main","worktreePath":"/Users/you/projects/worker","updatedAt":"2026-07-14T16:31:00Z"}'

echo "seeded $(ls "$DIR"/*.json | wc -l | tr -d ' ') sample records in $DIR"
