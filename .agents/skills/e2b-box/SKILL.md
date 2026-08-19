---
name: e2b-box
description: Drive the herdr-e2b plugin — e2b-box, e2b-fleet, e2b-bench, e2b-dash — from the CLI, the way an agent orchestrator (or a human without the keybindings) uses it. Two workflows it maps: (1) you already have a worktree and want its work mirrored into an E2B cloud sandbox (e2b-box open/sync/pull, one box per worktree), and (2) you want ONE task fanned out from the current checkout to several coding agents at once — claude, codex, opencode, amp, grok, droid, prime — each in its own auto-created worktree + sandbox (e2b-fleet), then monitored, graded with a held-out check (e2b-bench), and the best result pulled back (best-of-n). Use whenever the user mentions e2b-box, e2b-fleet, e2b-bench, fleets, "run the same task on claude and codex", "fan this out to N agents", "send this worktree to a sandbox", "move my work to the cloud box", "grade the fleet", "best of n agents", "pull the winner", or presses/asks about prefix+shift+E / prefix+shift+F / prefix+shift+D in herdr. Also use when orchestrating these commands yourself as the agent instead of the human.
---

# e2b-box — the herdr-e2b plugin, driven from the CLI

herdr-e2b mirrors git worktrees into E2B cloud sandboxes. Humans reach it through
herdr keybindings; agents and scripts reach the SAME verbs as CLI one-liners. Every
keybinding has a CLI spelling — prefer the CLI when you are the one driving.

| herdr keybinding | what it does | CLI one-liner |
|---|---|---|
| `prefix+shift+E` | boot/attach this worktree's sandbox | `e2b-box open` |
| `prefix+shift+F` | fleet pickers (slug, roster) → board | `e2b-box fleet <slug> --agents a,b --task "…"` |
| `prefix+shift+D` | dashboard TUI toggle | `e2b-box dash` (`dash toggle` for the bindable one) |

One CLI: `e2b-box` fronts everything (`e2b-box fleet …`, `e2b-box dash`). The
standalone names `e2b-fleet`, `e2b-bench`, `e2b-dash` also work and are the same
scripts.

## Picking the workflow — the decision that matters

**You (or the user) already have a worktree with work in it, and want that exact
tree running in a cloud sandbox** → `e2b-box`. One worktree = one box = (optionally)
one agent inside it. This is the original per-worktree pattern: the box mirrors the
live tree, uncommitted changes and all. Spin one box per existing worktree; there
is no fan-out here.

```sh
cd ~/_wt/repo/my-branch
e2b-box open                 # boot (or reconnect) + attach a shell in the box
e2b-box up -t claude         # or: provision in the background, stay local
e2b-box sync                 # later: re-upload local changes   local → box
e2b-box pull                 # bring the box's results back     box → local
```

**You want the SAME task attempted by several agents at once, starting clean from
the current checkout's HEAD (main or a feature branch)** → `e2b-fleet`. It creates
the worktrees FOR you — one per agent, in herdr's default worktree directory, each
on branch `e2b/<slug>-<template>-<rand4>` (`<template>` is the last path segment,
so `ondrejs-project/herdr-agents` gives `herdr-agents`), each in its own herdr workspace, each
with its own sandbox booted from that agent's template, each agent started already
holding the task. Do NOT pre-create worktrees for a fleet; that is the whole point
of the verb.

```sh
cd ~/dev/e2b/some-repo       # the checkout to branch members off (its HEAD is the base)
e2b-box fleet t-42 --agents claude,codex --task "fix the login redirect loop"
e2b-box fleet t-42 --all --task "…"        # every agent the config knows
e2b-box fleet t-42 -a claude,codex -t base --task "…"   # -t base = control arm, plain shell
```

Rules that bite:
- Run it from inside the git checkout — members branch off ITS head.
- Members start clean: uncommitted files are NOT carried in (it warns, never blocks).
  If the dirty work is the point, use the `e2b-box` workflow instead, or commit first.
- The task is ONE argv element — quote it once, newlines and backticks survive.
- A TERMINAL decides presentation, never the verb: at a tty you get the live board;
  without one (an agent, a script, CI) the same line runs in the foreground and
  returns a summary + exit code. `create` in front is optional. Add `--dry-run` to
  print every command it would run and create nothing — use this to verify a plan.

## Monitoring a fleet (as an agent)

The human watches the board. An agent reads state instead:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/e2b-dev.herdr-e2b/fleets/<slug>.log"  # per-member report
e2b-box list                                        # every tracked box: status, template, id, url
e2b-box exec 'git -C ~/project log --oneline -5'    # peek inside ONE box (run from its worktree)
```

Members are herdr panes named `<slug>-<template>` — `herdr` CLI / the herdr skill can
read their screens for liveness. There is no fleet object to poll (branches ARE the
fleet's identity); "done" is judged by grading, not by a status field.

## Grading + best-of-n

`e2b-bench` runs one held-out check inside every member's box and prints a verdict
per member. Exit 0 only when every member passed — pipeable, CI-safe, no tty needed.

```sh
e2b-bench t-42 --grade 'npm test'                    # run the check, show the board
e2b-bench t-42 --grade 'pytest -q' --timeout-ms 600000
e2b-bench t-42                                       # re-show a graded run
e2b-bench                                            # list graded runs on disk
```

Best-of-n loop end-to-end:
1. `e2b-box fleet <slug> --all --task "…"` — fan out.
2. Wait/monitor (above). Agents finish on their own inside their boxes.
3. `e2b-bench <slug> --grade '<held-out check>'` — verdict per member.
4. Winner's work home: `cd` into the winning member's worktree, `e2b-box pull`
   (add `--force` only when the tree is deliberately dirty), commit on its
   `e2b/<slug>-<template>-<rand4>` branch.
5. `e2b-box fleet kill <slug>` — kills boxes, removes worktrees, KEEPS all branches
   (they are the run's only product). `--prune-branches` deletes them too but still
   refuses any branch with commits that exist nowhere else; `--force` overrides.

For the full scripted shootout (fleet + watch + grade + comparison table in one),
the `harness-bench` skill wraps this — reach for it when the user says "benchmark
the agents" rather than "run a fleet".

## Everything else

Full verb/flag reference — every permutation of `e2b-box`, `e2b-fleet`, `e2b-bench`,
`e2b-dash`, plus exit codes, state paths, config keys and env overrides — lives in
[references/commands.md](references/commands.md). Read it before composing a command
you have not seen above, or when a command refuses and you need the exact semantics
(`pull` on a dirty tree, `kill` vs `pause`, template resolution order).

Safety notes an orchestrator must respect:
- Boxes are billable. `sync` provisions a fresh box if none exists (it says so).
  Never leave a fleet running unattended past its usefulness — `fleet kill <slug>`.
- `pull` overwrites local files from the box; it aborts on a dirty/non-git tree
  unless `--force` — that abort is protecting real work, don't reflex-force it.
- `fleet kill --prune-branches --force` destroys branches with unique commits.
  Only on explicit user request.
- `e2b-dash` is a full-screen TUI and refuses without a tty — agents never run it;
  use `e2b-box list` / `status` instead.
