# Cached picker input is appearance, never launch authority

A picker popup paints its previous input before starting the CLI or Node, following
the dashboard's cached-appearance startup. `pick_template` and `e2b-fleet` still
own the resolved arguments. They write one atomic NUL-delimited file per absolute
worktree cwd under the plugin state directory. It holds a version, cwd and box key,
then the box's label, resolved default, choices, count, marks and effort rows, plus
the fleet's dirty-tree note, choices, count, default roster and effort rows. It holds
neither credentials nor a previous answer. Bash reads data fields, never shell source.

The lookup mirrors cwd components with a `d-` prefix and ends in `input`. Cwd has the
same identity semantics as a box key, while direct lookup avoids running the hash
utility before painting. Prefixes prevent a child checkout named `input` from
colliding with its parent's file. Box and fleet inputs share the file; a private
refresh reply keeps concurrent popups from consuming one another's result.

`e2b-picker-warm` also resolves both inputs before the first opening. Herdr's
asynchronous startup hook (0.7.5+) visits restored pane directories, and its
workspace-created hook warms new ones. Installation launches the same warmup
detached after configuration and auth discovery, because linking or enabling a
plugin does not run startup hooks. The warmup clears inherited per-box pins and
only calls the existing input producers; it never asks, opens panes or provisions.
Older hosts retain installation/event warming and the cold picker fallback.

Every cached opening starts the existing resolver path after its first frame.
There is no reusable freshness verdict: config.toml and catalog mtime changes,
git branch rules, auth results, connection marks and live box records are all
re-read on every opening. A stale auth mark can annotate the first frame, as in
the existing annotate-never-filter invariant. A cached choice cannot launch a box.
The chooser checks for completion every 50 ms while waiting for input
(one second on Bash 3.2, whose `read -t` requires whole seconds). Early
confirmation stays pending while Escape remains readable; changed arguments
repaint without clearing the screen and require confirmation again. A settled
template hands off as before.

The chooser owns no paths or resolver logic. Its optional refresh callback follows
the existing slug-validator pattern: callers supply the behavior and arguments.
Unchanged input preserves the selection; changed menu input resets the cells to the
fresh defaults. A changed fleet note preserves the slug and task being typed.
Normal key handlers and idle timeouts remain in place. Missing or malformed cache
files take the existing cold path, whose cache write runs alongside the picker.

The popup keeps terminal input unbuffered between reads. Escape checks the
remaining bytes already queued for the encoded key, without waiting for a timeout.
Arrow sequences keep their meanings, and Shift-Tab reverses Tab through cells and
fleet text fields. Escape in a dropdown closes only that dropdown. Ordinary
terminals retain a short sequence window (20 ms on modern Bash, the original
second on Bash 3.2).

The normal handoff remains authoritative: `e2b-box-open` carries explicit picks to
`e2b-box open`, and `provision.js` checks model and per-model effort against the
current catalog before creation. Fleet answers pass through the existing spec
parser, roster spelling check and per-member open path.

Calling the two Node scripts directly from the popup would duplicate the CLI's
settled-template rules, so the CLI stays the refresh owner. Combining those scripts
would save one import but would still delay the first frame. Precomputing before
opening the popup would put that delay back in front of the overlay, the reason
`e2b-box-open` already opens the popup first.
