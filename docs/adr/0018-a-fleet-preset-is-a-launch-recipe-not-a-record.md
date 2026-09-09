# A fleet preset is a launch recipe, not a record

A JSON fleet specification supplies a slug, task and members with template,
model, reasoning and count. Only the members are required. A named preset is that
same file under the plugin config directory's `presets/`, selected by filename.
There is one format for an agent-generated file, a saved preset and the picker.

The specification becomes existing member specs before the fleet launch path.
Explicit CLI fields override saved fields. It cannot configure teardown, execute
host commands or record a running fleet. ADR 0001 still applies: branches and box
records describe what was actually created; a preset describes a future launch.

JSON was chosen for agent generation and portability. A second TOML preset format
would add conversion and precedence rules without adding a capability. Keeping
files beside config allows reuse across worktrees without mixing recipes into
runtime state or credentials into a shareable recipe.

The parser rejects unknown fields and invalid counts, models and reasoning before
creation. It uses the same catalog as box creation. Popup selection reads the
current file and fills editable cells; a failed selection leaves the current
roster intact. Listing filenames uses only Bash, preserving cached first paint.
The chooser receives names and a caller-owned loader, and owns no config paths.
