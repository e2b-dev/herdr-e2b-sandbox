# Fleet JSON and presets

A fleet specification saves the roster you would otherwise build in the picker.
An agent can generate the same JSON and pass it to the CLI without a terminal.

Save this as `compare.json`, or use the repository's
[example](../config/presets/compare.json):

```json
{
  "members": [
    { "template": "codex", "model": "gpt-6-astra", "reasoning": "high", "count": 2 },
    { "template": "claude", "model": "claude-fable-5", "reasoning": "max" }
  ]
}
```

Preview the plan, then run it:

```sh
e2b-box fleet create login-fix --file compare.json --task "Fix the login redirect loop" --dry-run
e2b-box fleet create login-fix --file compare.json --task "Fix the login redirect loop"
```

`--file -` reads JSON from stdin. A specification may also include `"slug"` and
`"task"`, allowing `e2b-box fleet create --file fleet.json` to supply the whole run.
Tasks are literal text, including embedded newlines; they are never file paths or
shell commands. Explicit CLI slug, `--task` and roster flags override their saved
counterparts, independent of argument order. `--task ""` clears a saved task.
`--file` and `--preset` are mutually exclusive.

The `members` array is required and nonempty. Every member needs `template`.
`model` and `reasoning` are optional and inherit that template's configured defaults
when omitted. `count` defaults to 1 and accepts integers from 1 to 20. Repeat a
template in separate entries to give its members different models or reasoning.
Unknown fields and invalid types are errors. Model and reasoning pins are checked
against the current catalog before any member is created; `--dry-run` performs
the same checks. Template names use the existing roster check and `--force` escape.

For named presets, put JSON files in `presets/` beside your plugin `config.toml`.
For example, `$HERDR_PLUGIN_CONFIG_DIR/presets/compare.json`; the default directory
is `${XDG_CONFIG_HOME:-~/.config}/herdr/plugins/config/e2b-dev.herdr-e2b/presets`.
Names use letters, digits, hyphens and underscores and start with a letter or digit.

```sh
e2b-box fleet presets
e2b-box fleet login-fix --preset compare --task "Fix the login redirect loop"
```

In the fleet popup's roster screen, **p** selects the next preset and **Shift+P**
the previous one. Its counts, models and reasoning fill the existing cells. Review
them, edit any cell, then press Enter from the template or count column to launch.
A saved task is shown and used if you left the task field empty. The slug entered
on screen always identifies this run. Presets containing templates absent from the
picker menu are refused there; use the CLI for a deliberately off-menu roster.
The picker supports at most 20 members of any one template.

Preset names are listed without starting Node, so they do not delay the cached
first frame. Selecting one reads and validates its current file. A malformed
preset leaves the current roster intact and displays the error.

Without a terminal the command skips the dashboard, provisions members through
the running Herdr instance, and returns the usual fleet summary and exit code.
This launches the members' agents; it does not wait for their tasks to finish.
`--no-dashboard` requests that same foreground behavior from a terminal.

For an agent generating a file: use only the fields above, choose model and
reasoning values from the plugin's current catalog, and run `--dry-run` first.
Save a reusable roster without a slug so each invocation can name its own task.
Presets describe future launches; they contain no box IDs, branches or live status.
