# Headless: `e2b-box run`

One command, no pane, no human: boot a box for this checkout, hand its agent a
task, wait for the agent to finish, bring the result home, exit with a code.
What a cron or a delivery lane dispatches. Filed as
[#47](https://github.com/e2b-dev/herdr-e2b-sandbox/issues/47) by the harness team
that already runs the interactive verbs; `open` and `fleet` need a herdr pane and
somebody in it, `exec` runs one command, and nothing ran an agent to completion.

```bash
e2b-box run -t claude --task GOAL.md --push --json
```

## What one run does

| step | what happens | on failure |
| --- | --- | --- |
| 1 resolve | task from `--task`, template from `-t` (or the tracked box's), headless command from `src/run-agent.js` | exit 2, nothing created |
| 2 boot | fresh box: create + upload the tree, uncommitted changes included. Tracked box: reconnect (resume if paused) + re-upload, so the agent works the current tree | `boot-failed` |
| 3 task | task written into the box as `$HOME/.herdr-e2b-task.md` over the SDK | `task-failed` |
| 4 agent | the template's non-interactive command runs in the project dir, bounded by `--timeout-ms` (30 min default), killed at the bound | `agent-unmeasured` (never ran to a verdict) or `agent-failed` (exited non-zero) |
| 5 pull | `e2b-box pull`, clobber guard intact | `pull-failed`, box never killed |
| 6 push | `--push` only: `git add -A && git commit && git push -u <remote> <branch>` on the **local** checkout | `push-failed` |
| 7 box | paused by default, `--kill` destroys, `--keep` leaves running | `teardown-failed` |

Exit 0 only when `status` is `done`. Anything else exits 1 (usage errors 2).
The agent's work comes home even when the agent failed: a half-finished tree is
the evidence you want to read.

## The task

`--task` takes one value, read three ways:

| value | read as |
| --- | --- |
| `--task 'fix the login redirect loop'` | the text itself |
| `--task GOAL.md` | the file's contents (any readable file) |
| `--task -` | stdin |

The task never crosses argv into the box. It lands as a file, base64 over the
SDK, and the agent command reads the file, so a task the length of a design doc
is the same one line as "fix the bug".

## Templates and the agent command

The template decides which agent works the task, and `run` needs that agent's
**non-interactive** mode, which is not a flag away from the interactive one
`[fleet.agents]` starts. Shipped, verified against each vendor's docs:

| template | command in the box |
| --- | --- |
| `claude` | `claude --dangerously-skip-permissions -p "$(cat $HOME/.herdr-e2b-task.md)"` |
| `codex` | `codex exec --dangerously-bypass-approvals-and-sandbox - < $HOME/.herdr-e2b-task.md` |
| `opencode` | `opencode run --auto "$(cat $HOME/.herdr-e2b-task.md)"` |
| `amp` | `amp -x --dangerously-allow-all < $HOME/.herdr-e2b-task.md` |
| `grok` | `grok --always-approve --prompt-file $HOME/.herdr-e2b-task.md` |
| `droid` | `droid exec --skip-permissions-unsafe -f $HOME/.herdr-e2b-task.md` |
| `muse` | `muse exec --yolo --user-input-auto-resolve --prompt-file $HOME/.herdr-e2b-task.md` |
| `prime` | `prime-agent -p --no-session "$(cat $HOME/.herdr-e2b-task.md)"` |

`base` (the default) and your own templates are refused by name before anything
boots. An invented flag fails to launch and reads exactly like an agent
that did nothing. Teach one in `[run.agents]`:

```toml
[run.agents]
droid = 'droid exec --auto high -f $HOME/.herdr-e2b-task.md'   # a leash instead of the bypass
"my-project/my-template" = 'claude --dangerously-skip-permissions -p "$(cat $HOME/.herdr-e2b-task.md)"'
claude = ""    # switch a shipped one off
```

The command must read the task file and must exit when the agent is done. It runs
in the box's project dir. `e2b-box run … --dry-run` prints exactly what would run.

Two account-side things seen live that look like launch failures and are not:
opencode with no configured model picks one by internal priority, which can land on
a model with no tool use (`opencode run --auto -m <provider/model> …` in
`[run.agents]` pins it); and amp reports `Out of Credits` on stderr with exit 0, so
`run` says `done` while `pull` finds nothing changed.

The skip-approvals flags are the point of a box: disposable, isolated from your
machine, nobody attached to approve an edit. They are not a cage. The box has
network egress and holds the credential `[templates.<name>.env]` gave it.

## Model and reasoning

`run` does not take a model flag. The model is the template's, set once in config
and applied to every box booted from it, headless or not:

```toml
[templates.opencode]
model = "openrouter/qwen/qwen3.8-max-0902"
[templates.codex]
model = "gpt-5.4"
reasoning = "high"
```

The plugin delivers it the way each harness reads it (environment for claude and
opencode, the harness's own config file for codex, grok, droid, prime and muse;
`config.example.toml` has the per-harness table). Every pinned box also carries
`HERDR_E2B_MODEL` and `HERDR_E2B_REASONING`, so a `[run.agents]` command of your
own can use `--model "$HERDR_E2B_MODEL"`.

## What becomes of the box

| flag | afterwards | when |
| --- | --- | --- |
| (default) | **paused**: frozen with its memory, nothing billing, `e2b-box open` puts you back in it, `e2b-box kill` ends it | a run you want to look at afterwards |
| `--kill` | destroyed, record removed | cron, CI, anything nobody comes back to |
| `--keep` | left running; it still auto-pauses at `[sandbox] timeout_ms` | you are about to `open` it |

A pull that did not complete never lets the box be killed, even under `--kill`:
it is paused instead, with the work still in it. The one thing this verb must
not do is destroy work that has not come home.

## `--push`

Commits on the **local** branch and pushes it. Local because the box holds a
baseline commit and no history ([ADR 0012](adr/0012-the-upload-is-a-commit-in-the-box.md)),
so the branch with the real history is the one on the machine running `run`.

- `--remote R` (default `origin`), `-m MSG` (default `herdr-e2b run (<template>): <first line of the task>`).
- Everything the pull left different is committed, `git add -A`. A tree that was
  dirty before the run is part of the snapshot the agent worked from, so it is part
  of the result; `run` says so on stderr.
- Detached HEAD is `push-failed`: put the checkout on a branch first.
- Nothing to commit is not a failure. The push still runs.

## The JSON contract

`--json` prints exactly one object on stdout; progress goes to stderr.

```json
{
  "ok": true,
  "key": "repo-6f0b506d",
  "sandboxId": "iq0kzlq3n1bii76ll19cb",
  "template": "claude",
  "status": "done",
  "agent":  { "ok": true, "exitCode": 0, "stdout": "…", "stderr": "", "error": "" },
  "pull":   { "ok": true, "output": "…" },
  "push":   { "ok": true, "remote": "origin", "branch": "main", "commit": "9ce9a43…" },
  "box": "paused",
  "elapsedMs": 16000,
  "error": ""
}
```

`status`: `done` · `boot-failed` · `task-failed` · `agent-unmeasured` ·
`agent-failed` · `pull-failed` · `push-failed` · `teardown-failed`.
`box`: `paused` · `killed` · `running`. `push` is `null` without `--push`.
`agent` is `e2b-box exec`'s object: `ok:false` means the command was never
measured (unreachable, killed at the bound), `ok:true` means `exitCode` is its own
verdict.

## From CI

Nothing in `run` needs herdr, a TTY, or the `e2b` CLI. It needs Node 22, jq, git,
the plugin checkout with its dependencies, an E2B key, and a credential the box's
agent can use. The credential reaches the box through `config.toml`, written per
job from a secret.

```yaml
name: agent run
on:
  workflow_dispatch:
    inputs:
      goal: { description: "path to the goal file", default: GOAL.md }

jobs:
  run:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: plugin
        uses: actions/checkout@v4
        with: { repository: e2b-dev/herdr-e2b-sandbox, ref: main, path: .herdr-e2b }
      - run: npm ci --omit=dev
        working-directory: .herdr-e2b

      - name: credential for the box
        run: |
          mkdir -p "$RUNNER_TEMP/cfg"
          printf '[templates.claude.env]\nANTHROPIC_API_KEY = "%s"\n' "$ANTHROPIC_API_KEY" > "$RUNNER_TEMP/cfg/config.toml"
          chmod 600 "$RUNNER_TEMP/cfg/config.toml"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: run the goal
        run: |
          git config user.name  "agent-bot"
          git config user.email "agent-bot@users.noreply.github.com"
          git checkout -b "agent/${GITHUB_RUN_ID}"
          .herdr-e2b/bin/e2b-box run -t claude \
            --task "${{ inputs.goal }}" \
            --push --kill --timeout-ms 1500000 --json | tee result.json
        env:
          E2B_API_KEY: ${{ secrets.E2B_API_KEY }}
          # E2B_DOMAIN: e2b-juliett.dev          # EU tenant only
          HERDR_PLUGIN_CONFIG_DIR: ${{ runner.temp }}/cfg
          HERDR_PLUGIN_STATE_DIR:  ${{ runner.temp }}/state

      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: run-result, path: result.json }
```

What to know about this shape:

- **`--kill`.** Box records are files on the runner, and the runner is gone when
  the job ends. A box the job paused is still on your tenant but invisible to any
  laptop's `e2b-box list` or `e2b-dash`. Kill it in the job, or plan on finding it
  in the E2B web dashboard (every box carries `app=herdr-e2b` metadata).
- **`git checkout -b`.** `actions/checkout` on a PR event leaves a detached HEAD,
  and `--push` pushes the branch you are on.
- **The checkout token pushes.** The box never holds GitHub credentials; the push
  is local to the runner.
- **A fresh checkout is clean**, so the clobber guard never trips in CI.
- **`--timeout-ms` under `[sandbox] timeout_ms`** (default one hour), or the box
  pauses under the agent first.
- **Exit code is the gate.** The step fails on any `status` other than `done`;
  `result.json` says which step.

## Live check

`test/e2e-run.sh` boots three throwaway boxes against a bare remote and walks the
whole table above: refusal creates nothing, dirty snapshot in, agent out, pull +
commit + push, pause then `kill`, `--timeout-ms` → `agent-unmeasured`, the clobber
guard downgrading `--kill` to a pause, `--force` bringing the edit home. Not in
`npm test`; run it before a release that touches `run`.

## Not here yet

- `e2b-fleet run --task … --json`, one result per member, the best-of-N shape.
- Adopting boxes a CI runner left on the tenant into a laptop's records.
- Streaming the agent's output while the run is in flight; it arrives buffered in
  the JSON.
