# The plugin owns the terminal; a box gets no multiplexer

Every box installed tmux and made each interactive shell join one session, so that
reconnecting after a pause landed back on the screen you left. The reasoning was sound and
is written up at `src/provision.js:216-223`: a pause freezes the VM, so the agent keeps
running, but the connection you were attached to dies with the pause and `e2b sandbox
connect` opens a **new** terminal — leaving a live agent with nobody on its tty.

The premise underneath that fix turns out to be only half true, and the half that is false
is the half tmux was hired for.

## What we measured

Seven boxes, three agent templates, across a real `pause({ keepMemory: true })` and resume.
Harness on branch [`prototype/pty-reattach-repaint`](https://github.com/e2b-dev/herdr-e2b-sandbox/tree/prototype/pty-reattach-repaint);
raw PTY dumps under `.scratch/sbx-memory/`.

| claim | result |
| --- | --- |
| The agent process survives a memory-snapshot pause | Yes — same pid on 6/6 runs, resume 230-740 ms |
| `pty.connect(pid)` reattaches to it | Yes, first-class in the SDK since 1.0.0 |
| Reattaching gives you the screen back | **No — 0 bytes on 6/6 runs.** envd buffers nothing |
| A `pty.resize()` SIGWINCH makes the TUI repaint | Yes, on `claude`, `codex` and `grok` |
| One one-way resize is enough (a real reconnect) | Yes — one signal, one complete frame |
| Pausing with a live subscriber corrupts anything | No — pause 1.3 s, resume 231 ms, frame identical |
| A raw PTY mangles modified-Enter the way tmux did | No — `^[[13;2u` and friends pass byte-for-byte |

So process survival was never the problem, and tmux was never solving it. What tmux
actually provided was **the screen**: envd reads the PTY master continuously but drops the
bytes whenever nobody is subscribed, and `MultiplexedChannel.Fork()` hands a reconnecting
client a fresh channel with no replay. There is no ring buffer anywhere in the path.

## The decision

Delete the in-box tmux. The plugin owns a PTY client in `src/`, which reattaches to the
box's **terminal** by pid and forces a repaint with a resize.

The E2B SDK is JavaScript-only, so this could only ever live in `src/*.js` — the same
constraint that put every other sandbox call there. `bin/e2b-box` keeps its shape: the
client goes exactly where `e2b sandbox connect` was (`bin/e2b-box:364`) and its exit code
drives the same branches.

## What this costs, plainly

**Scrollback, across a reconnect.** You get the current frame, not the history above it. In
a 200-line run the repaint returned the ~22 lines that fit the viewport; the rest is
unrecoverable, because nothing ever held it. tmux did hold it. That is a real regression and
the only one.

We accept it rather than paper over it. A plugin-side buffer was considered and rejected:
it could only replay bytes the client itself received, so it would have holes exactly where
the interesting thing happened — the box working while you were away. A partial history
that lies is worse than an honest blank frame.

## Considered and rejected

**Keep tmux, gate the client behind a config key.** Not orthogonal: a box provisioned with
tmux has a `.bashrc` that `exec`s it, so a PTY client attaching to such a box lands *inside*
tmux anyway. Two reconnect paths that interact is two products, and the fallback nobody
exercises is the fallback that does not work.

**Wait for `--pid` in `@e2b/cli`.** `sandbox connect` unconditionally calls `pty.create`, so
the CLI cannot reattach at all. Worth fixing upstream — and we will, along with asking E2B
infra for a per-PTY ring buffer in envd, which would erase the scrollback caveat entirely —
but neither is a reason to keep shipping tmux in the meantime.

**SSH into the box.** Needs a custom template with `openssh-server` and `websocat`, which is
heavier rather than thinner, and an SSH session is itself a connection that dies on pause.
It lands back on the same fresh-shell problem.

## Consequences

- **`auto_pause` becomes the default.** Reattach-by-pid is meaningless if the idle timeout
  kills the box instead of pausing it. The docs already promised auto-pause in places where
  the default said otherwise.
- **A filesystem-only pause is incompatible with reattaching.** `keepMemory: false` cold-boots
  from disk; there is no pid to come back to, and the terminal starts fresh. That is a
  legitimate mode, not a bug — it just is not this one.
- **The record gains the terminal.** A box's terminal is identified by a pid stamped with
  `HERDR_E2B_TERMINAL=<box key>` at creation and verified against `commands.list()` before
  every reattach. Trusting a bare pid would eventually attach someone to a recycled one.
- **The plugin grows its first long-lived TTY-owning process.** Every `node src/*.js` call
  until now was print-JSON-and-exit, with `provision.js` detached onto a log file. A client
  that holds the pane for hours is a new shape here, and the reason `bin/e2b-box`'s TTY
  guards stay exactly where they are.
- **The 2-second "never attached" heuristic goes away.** Owning the process means it can say
  what happened instead of us inferring it from a stopwatch (`bin/e2b-box:367`).
- **The client corrects the record on the way out.** Only the explicit pause verb wrote
  `paused`, so a box auto-pausing underneath a session left a record claiming `ready`. The
  client is the only thing present at that moment: one `getInfo` on the observed loss — an
  act, not a poll — writes the truth, and the readiness spinner treats `paused` as settled
  instead of a state worth waiting on.
- **Removing tmux removes the modified-Enter bug, not just the workaround.** `extended-keys on`
  existed because tmux itself re-encodes those sequences; the live failure it was patching
  (fleet t-16) cannot recur with no multiplexer in the path.
