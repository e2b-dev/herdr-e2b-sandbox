# Connections select one credential before a box is created

An explicit connection is a user's choice of account and authentication method.
It is separate from a discovered value or discovered session. `e2b-box auth` and
`auth discover` retain their discovery behavior; `auth connect` creates a named
personal connection that applies to new boxes.

The first adapters are Claude's official `setup-token` command and Codex's
existing borrowed-session transform. Claude tokens are supplied deliberately,
not scraped from the Keychain. Interactive capture runs the first-party CLI in
a PTY, redacts the token from displayed output, and returns it on a private pipe.
Python 3 is required for that bridge; `--token-stdin --yes` accepts an existing
setup-token without putting it in command arguments. Codex connects a pointer to
the local login and still replaces its real refresh token before delivery.

## Ownership and detected subscription

All connections in this iteration have personal access. `claude auth status`
provides local subscription metadata: Pro/Max classify as personal plans;
Team/Enterprise classify as organization plans; missing or new values are
unknown. An organization ID alone does not classify a plan.

Default Claude names reflect that detected account: an organization slug for
Team/Enterprise (falling back to the plan name), `personal` for Pro/Max, and
`local` for unknown plans. `--name` overrides the suggestion. Names are labels,
never access grants. Reconnect preserves existing IDs and their bindings. The
UI shows `Local account` separately from `Access: Only you`.

This metadata describes the local login observed before connection, not proof of
the account selected in a subsequent browser flow. The UI labels that distinction.
A Team seat does not imply consent or permission to distribute its credential.
`--org` is rejected with an explanation until a shared service provides actual
membership and authorization. It is not implemented as a local label that suggests
team access exists.

## Selection and compatibility

Selection order is `--connection`, then `[templates.<name>] connection`, then the
only personal connection for the harness. More than one unselected candidate is
an error. With no managed connection, the existing config/discovery ladder stays
in effect.

An explicit connection can bind a custom template to its harness without guessing
from the template's name. Known mismatches (a Claude connection for `codex`) and
`base` are rejected. The binding supplies the default onboarding seed, while a
template-specific `[fleet.seed]` override still wins, including an empty override.

This **amends ADR 0010**: a selected connection outranks a discovered session and
`prefer = "env"`. Its adapter removes conflicting auth variables/provider selectors
before inserting the selected material. An unavailable or expired selected
credential causes an error; it never silently falls back to a different account.
Fleet preflight uses the same resolver. Ordinary missing discovery credentials
still warn and launch; invalid selected connections stop the fleet before worktree
creation. A selected connection also prevents template fallback to a base box.

## Storage and lifetime

`$CONFIG_DIR/connections/` is private (0700). Each connection has a metadata JSON
file and, for Claude, a separate revisioned token file (0600). A write commits
metadata last. Old token revisions are retained until disconnect so a concurrent
provisioner that already read old metadata can finish reading that revision.
List/explain read metadata only. Existing `auth.toml` remains secret-free and
`config.toml` remains user-owned.

These files are protected by local file permissions; they are not an encrypted
vault. Connection mutation uses a short per-name directory lock. An interrupted
writer can leave that lock behind; after confirming no writer is running, remove
the named `.lock` directory to recover.

Fresh setup-token captures use the documented one-year lifetime, conservatively
measured from before starting login. Pasted tokens have unknown expiry. Codex's
expiry is read fresh from its source when checked or provisioned; it cannot refresh
inside the box. `check` validates local availability and known expiry, not provider
acceptance, and makes no model request. A configured connection is never displayed
as provider-verified.

Connections are applied at **creation**. Box records retain the selected connection
ID and revision, never its secret. Reconnect/disconnect change local configuration
only. The record also preserves the selected harness for custom-template seeding.
Existing boxes retain their credentials; `--connection` is rejected for an
already tracked sandbox instead of pretending its running process was updated.
If a tracked sandbox has disappeared, its connection ID remains pinned during
recreation. A future runtime refresh/update feature needs a separate delivery
protocol; it cannot be implemented by merely editing a host token file.
