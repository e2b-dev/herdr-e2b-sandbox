# herdr-e2b

The language of this plugin: a git worktree on your machine, mirrored into an E2B
cloud sandbox, driven from herdr.

## Language

### The box

**Box**:
One E2B sandbox that mirrors exactly one worktree. Every box belongs to a worktree
and every worktree has at most one box.
_Avoid_: Sandbox (that is E2B's word for the remote machine itself), instance, VM

**Box key**:
A box's stable identity, derived from the absolute path of the worktree it mirrors.
Two worktrees can never share a key; the same worktree always resolves to the same one.
_Avoid_: Box id, sandbox id (the sandbox id is E2B's, and changes when the box is recreated)

**Record**:
The on-disk facts about a box — status, sandbox id, preview URL. The only thing the
CLI, the worker, and the dashboard agree on.
_Avoid_: State file, cache

**Template**:
The E2B image a box boots from, and therefore which toolchain and coding agent it
already has installed (`claude`, `codex`, `grok`, `base`, …). A template is a choice
made once, when the box is created.
_Avoid_: Image, agent, harness — a template may ship an agent, but the two are not the
same thing and herdr's own "agent" means a *local* pane process

### Worktrees and fleets

**Worktree**:
A local git checkout that a box mirrors. The unit of ownership: it decides the box
key, what gets uploaded, and where a pull lands. Any checkout counts — the main one
included, even a plain non-git folder — since the key is the folder's path; only a
herdr-managed worktree additionally gets the automatic teardown when it is removed.
In user-facing prose prefer *branch* for the pitch, *checkout* for mechanics, and
*worktree* only where the herdr lifecycle (teardown, fleet members) is the point.

**Workspace**:
herdr's sidebar entry for a worktree. Created by herdr, not by this plugin.

**Fleet**:
Several worktrees created in one go from one base ref, one per chosen template, so the
same starting point can be worked by several agents at once. A fleet is a *batch*, not
a tracked object — it exists only as the branch-name prefix its members share.
_Avoid_: Squad, swarm, council, matrix

**Member**:
One worktree of a fleet, with its own branch, its own workspace, and its own box. A
member is an ordinary worktree in every respect; nothing about it is fleet-aware.

**Task slug**:
The short human-written name that identifies a fleet — the part of a member's branch
name that says what the fleet is *for*, shared by every member.

**Roster**:
The templates chosen for one fleet, one member each. Picked per fleet; a template
appears in a roster at most once.

**Fleet task**:
The instruction handed to every member's agent at launch, identical for all of them.
Optional — a fleet with no task is just several ready boxes.
_Avoid_: Prompt, brief, job
