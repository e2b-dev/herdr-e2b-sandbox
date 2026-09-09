# The catalog is read off the box, never typed

Which effort words a harness accepts and which models it lists are facts about the
binary shipped in that harness's E2B template. The plugin does not write them down; it
asks that binary and commits the answer. `scripts/harness-catalog.mjs` boots one
throwaway sandbox per shipped template, runs each harness's own catalog probes inside it
(src/catalog.js), and writes what came back into `src/harness-catalog.generated.js`, the
`<catalog>` block in `config/config.example.toml`, and `test/fixtures/catalog/`.
`src/effort.js` derives every scale from the generated module and keeps only the plugin's
overlay by hand: how a pin travels, and which words the picker declines to offer.

The tables this replaces were typed. `EFFORT_SCALES` in `src/effort.js` and the template
table in `config/config.example.toml` were both "verified against the CLI in each
template" on the same day and disagreed with each other on codex (`minimal` in one,
`max` in the other) and on droid (seven words against nine), with a third copy pinned in
the test and a fourth in a comment. They had been verified against a laptop. Every
template but one ships a different CLI version than the machine that typed the row, and
the difference changes answers in both directions: the box's `muse` had no `max` the
laptop's had, and the box's `amp` had no per-model efforts key the laptop's did
(docs/research/0003-model-and-effort-catalogs.md). The CLI in the box is the one that will
accept or reject a pin, so it is the only oracle that counts.

No registry answers this question. models.dev knows every model id and, for a few
providers, each model's effort values; OpenRouter, LiteLLM and the AI Gateway know
subsets. All of them are keyed by inference provider, and this table is keyed by
coding-agent CLI: `ultra`, `dynamic`, `off` and `none` are words the CLIs invented and
appear in no registry at all. So model ids come from the CLI where it enumerates them and
from models.dev where it does not (claude), and effort words always come from the CLI.
Five of eight CLIs print their whole vocabulary when fed a sentinel value, which is ADR
0009's spawn-the-binary probe applied to a different question, and the same shape as
`interpretProbe`: a shipped table beside a pure function that reads results and never
spawns, so every parse rule runs in CI from captured output.

## Consequences

The generated module is regenerated, never edited. A row changes when the script is
rerun and the world moved: a template rebuilt with a newer CLI, a model added or retired,
a word gained or lost. `--check` exits 2 on such drift and writes nothing; `--write`
accepts it. The release skill runs the check before tagging, so a release ships the
catalog of the templates it will boot, and a user can run the same command whenever
their templates were rebuilt.

A failed probe never blanks a row. An unauthenticated or offline run keeps the committed
row and marks it `stale: { since, reason }`, which the report and the rendered table
say out loud; otherwise one bad run would empty every scale and invalidate every user's
pin at once. And a credential is never printed and never on a command line: every probe
runs unauthenticated, or reads a variable the box already holds by name, so the
script's output is safe to paste into a PR.

The catalog is per model, not per harness, because the CLIs are: `grok-4.6` takes
`xhigh` and `grok-4.5` does not, droid's `minimax-m3` takes `high` alone, and droid
accepts any of its words at the flag and then silently runs the model's default at exit
0. Each model row carries its own efforts and default where the CLI says so, and
`effortsForModel` is the check the plugin can make that the CLI will not.

The catalog is account-scoped, and says so. droid filters its bundled models by feature
flags, codex by plan, grok by team, and the boxes the script boots are the ones THIS
config resolves (`ondrejs-project/claude` behind the alias `claude`, not E2B's public
image). Each row records the template build it was read from, so a reader can tell
which image answered and whether it has since been rebuilt.

What stays hand-written: `kind` and `via` (plugin facts about the pin route, not
harness facts), the words the picker omits (droid's `none` and `dynamic` mean "let the
model decide"), amp's scale being its `--mode` list rather than its `--reasoning-effort`
vocabulary (two vocabularies that share three words with different meanings, recorded
apart and never unioned), and opencode's generic scale (its reasoning is a per-model
variant in its own UI, and its model universe is all of models.dev, so its `models`
command, which lists only configured providers, is not consulted).
