# Model ids and reasoning efforts, automatically

Source material for automating the two hand-maintained tables this repo keeps: the
`reasoning` column of `src/effort.js` (`EFFORT_SCALES`, line 39) and the
`template -> model / reasoning` comment block in `config/config.example.toml`
(lines ~227-239). Established 2026-09-09 by 24 parallel probes against live vendor
endpoints, installed binaries on one macOS 25.5.0 machine, and one boot of all eight
shipped agent templates.

Nothing here is from a model's memory. Every enum below was read off a binary, a
shipped artifact, or an HTTP response quoted in-line. Where a claim could not be
reproduced it is marked UNVERIFIED at the bottom.

## The question, split in two

The ask reads as one problem and is two, with different answers:

| | what it is | best source |
|---|---|---|
| **model ids** | data about an inference provider's catalog | a registry. models.dev is the best one. |
| **reasoning efforts** | a property of the *harness CLI's* own vocabulary | the harness binary. No registry carries it. |

The split is not academic. `ultra` (codex, muse, amp), `dynamic` and `off` (droid) and
`none` (muse, droid) appear **zero times** across models.dev's whole 7,612-model
corpus. Those tokens exist only inside the CLIs. Conversely no CLI knows the pricing
or context window that a registry serves for free.

## Verdict on a single source: no

Seven candidate registries were surveyed and each one independently rechecked by an
adversarial verifier that re-ran the fetch itself. All seven survived on the model
column and all seven failed on the effort column, for the same structural reason:
**registries are keyed by inference provider, and this table is keyed by coding-agent
CLI.** Those are different objects.

| source | reachable | model ids | effort enum | harness coverage |
|---|---|---|---|---|
| **models.dev** `GET https://models.dev/api.json` (4.5 MB, unauth, 213 providers, 7,612 models) | yes | **best available** | real, per (provider, model), at `reasoning_options[{type:"effort"}].values` | ids 8/8. efforts 3/8 (claude, codex, grok) |
| **OpenRouter** `GET https://openrouter.ai/api/v1/models` (431 models, unauth) | yes | yes | real, at `reasoning.supported_efforts`. Three-state: array (162), `null` (143), absent (126) | 1/8 (opencode) |
| **Vercel AI Gateway** | yes | yes | real for 95 of 373 models | 2/8 (claude, codex). grok/amp/droid/prime/muse all 404 |
| **LiteLLM** `model_prices_and_context_window.json` (unauth, daily) | yes | yes | **none.** Only `supports_reasoning` booleans | ids 3/8 (claude 28, codex 229, grok 52 with an `xai/` prefix to strip) |
| **Vendor native APIs** (Anthropic `/v1/models`, `chatgpt.com/backend-api/codex/models`, `api.x.ai/v1/models`) | yes | yes, authoritative | real and per-model. Anthropic ships `capabilities.effort` as first-party documented schema | 3/8, and **all three 401 without a credential** |
| **Hugging Face router** `/v1/models` (136 models) | yes | partial | none. `effort`, `reasoning_effort`, `reasoning_options` all appear zero times | 0/8 |
| **npm metadata packages** (`tokenlens`, `llm-info`, `@continuedev/llm-info`, `ai-model-registry`) | published | stale | n/a | 0/8. Last publishes range 2025-10-04 to 2026-05-07, so none can describe a model shipped this quarter |

Two genuine near-misses found late, worth naming as prior art rather than leaving
unexamined. Both are a coding agent shipping exactly the generated catalog this repo
wants, and both refute the "no registry has these tokens" argument as originally
stated (the correct argument is the keying one above):

- `@oh-my-pi/pi-catalog@18.1.15` (published 2026-09-08): `src/models.json`, 68
  providers, per-model `"thinking": {"mode":"effort","efforts":[...]}`, plus a typed
  `src/effort.ts` enum of `minimal|low|medium|high|xhigh|max`. Counts in that file:
  4,198 `xhigh`, 2,237 `minimal`, 90 `none`, 88 `off`, and 0 `dynamic`.
- `@kortix/llm-catalog@0.13.12` (published 2026-09-08): the same idea for a gateway.

Not a source: there is no MCP model-catalog server. `models.dev/mcp` 302s to a
marketing page and `openrouter.ai/api/v1/mcp` is 404.

## The finding that changes the design: the templates lag, badly

All eight agent templates were booted and their harness versions read out of the box.
The template ships a materially older CLI than this laptop, in every case but codex:

| template | in the box | local on PATH | vendor latest |
|---|---|---|---|
| claude | **2.1.201** | 2.1.266 | 2.1.266 |
| codex | 0.153.4 | 0.153.2 (PATH) | 0.153.4 |
| grok | **1.0.5** | 1.0.24 | 1.0.24 |
| opencode | **1.17.13** | 1.18.29 | 1.18.30 |
| amp | **0.0.1783315410** (2026-07-06) | 0.0.1788883237 | 0.0.1788940851 |
| droid | **0.172.0** | 0.199.0 | 0.215.1 |
| prime | **0.7.0** | 0.9.3 | 0.9.4 |
| muse | **0.1.0-R708.1** | 1.0.3-R2198.1 | 1.0.3-R2198.1 |

This is not a fidelity nicety. It changes answers, in both directions:

- **muse.** In the template, `muse --help` prints `none|minimal|low|medium|high|xhigh|ultra`.
  `src/effort.js` is therefore *correct for the box*, and the local probe finding
  ("1.0.3 adds `max`") would have corrupted it.
- **amp.** In the template, `amp plugins show-agent-options --json` returns
  `capabilities` of `reasoning,vision,tools` with **no `efforts` key at all** (20
  models, `grep -c efforts` exits 1). The local machine's amp has it. So the obvious
  parse rule yields nothing on the box it is meant to run on.
- What survives the box check unchanged: claude 2.1.201 gives the same five values,
  droid 0.172.0 the same nine, prime 0.7.0 the same seven. `node` and `jq` exist in
  all eight templates (node v20.9.0, v22.23.1 in claude and prime).

Consequence: `config/config.example.toml`'s annotation "verified against the CLI in
each template, 2026-09-09" is **false today** for claude, grok, droid, muse and amp.
It was verified against this laptop. A local-only probe is not a fallback transport,
it is a different and wrong answer for 5 of 8 rows.

## Per-harness mechanisms

All eight yield their effort vocabulary from an artifact already on the box. Six of
eight yield model ids the same way. Ordered by how much a script gets per call.

| harness | model ids | effort enum | per-model? | auth needed |
|---|---|---|---|---|
| **codex** | `codex debug models --bundled`, `models[]` where `visibility=="list"`, `.slug` | same JSON: `supported_reasoning_levels[].effort` + `default_reasoning_level` | yes, with defaults | no (`--bundled`) |
| **droid** | JSON-RPC handshake over stdio | same handshake: `availableModels[].supportedReasoningEfforts` + `defaultReasoningEffort` | yes, with defaults | no |
| **grok** | `~/.grok/models_cache.json`, `Object.keys(models)` | same file: `models[id].info.reasoning_efforts[].value` | yes, with defaults | **yes**, file only exists after one authenticated run |
| **amp** | `amp plugins show-agent-options --json`, `.models[].id` | `.models[].capabilities.efforts` (union for the scale) | yes | no |
| **claude** | Anthropic `GET /v1/models?limit=100`, `capabilities.effort` keys | `claude -p --effort __probe__ ""`, then `/Valid values:\s*([^.]+)\./` | flat from CLI, per-model from API | efforts no, ids **yes** |
| **prime** | `prime-agent model list`, or `api.pinference.ai/api/v1/models` (unauth, 116 models) | `prime-agent --help`, `/--thinking <level>\s+Set reasoning:\s*(.+)/` | via bundled `pi-ai` catalog | no |
| **muse** | none pinnable (no verified settings key for a model) | `muse exec --help`, line after `--reasoning-effort`, split on `|` | via on-disk catalog cache | no |
| **opencode** | models.dev (**never** `opencode models`, see below) | nothing to generate: reasoning is a per-model UI *variant*, not a setting the plugin can write | n/a | n/a |

Exact commands, evidence and parse rules per harness are in the workflow transcript at
`.claude/.../workflows/wf_8d7e9da8-0c6/journal.jsonl`.

### The rejection message is an enumerating oracle

Five of eight CLIs print their own valid set when fed a sentinel. This is the ADR 0009
spawn-the-binary shape applied to efforts, and it costs no inference:

```
$ claude -p --effort __probe__ ""
Warning: Unknown --effort value '__probe__' ... Valid values: low, medium, high, xhigh, max.

$ droid exec --reasoning-effort __bogus__ "x"
Allowed values: none, dynamic, off, minimal, low, medium, high, xhigh, max

$ grok -m grok-4.6 --reasoning-effort __probe__ -p "x"
--effort/--reasoning-effort: unknown effort level '__probe__'; use one of: xhigh, high, medium, low

$ prime-agent --thinking bogus -p "say hi"
Warning: Invalid thinking level "bogus". Valid values: off, minimal, low, medium, high, xhigh, max

$ muse --reasoning-effort bogus
invalid value 'bogus' ...: expected none|minimal|low|medium|high|xhigh|max|ultra

$ amp config model-providers check-access --provider-model a/b --reasoning-effort bogus-zzz
Error: ... Allowed choices are none, minimal, low, medium, high, xhigh, max.
```

Three cautions. `claude`'s probe needs an empty prompt so it dies before starting a
session (exit 1, zero tokens). `grok`'s probe **requires auth**: unauthenticated it
exits earlier on `Not signed in`. `grok`'s empty-prompt guard runs before effort
validation, so probe with a non-empty `-p` string or every value falsely passes.

### Effort is per-model, not per-harness

This is the structural error in both current tables. Measured today:

- `grok-4.6` accepts `xhigh`; **`grok-4.5` does not.** Byte-identical to the CLI's own
  two rejection messages, and to the two `reasoning_efforts` arrays in its cache.
- codex `gpt-5.5` and `gpt-5.2` cap at `xhigh`. `gpt-5.6-luna` has `max` but no
  `ultra`. `gpt-6-astra` / `gpt-5.6-sol` / `gpt-5.6-terra` have both.
- droid `minimax-m3` accepts `[high]` only. `kimi-k2.6` is `[off, high]`.
  `gpt-5.5-pro` is `[medium, high, xhigh]`.
- claude: `xhigh` is invalid on `sonnet-4-6` and `opus-4-6`, and `haiku-4-5`,
  `sonnet-4-5` and `opus-4-5` support no effort at all.
- muse: `max` is on `muse-spark-1.3` only, not on the `-contributor` or `1.2` rows.

A flat per-template row cannot express any of this, and for droid it is actively
misleading (next section).

### Silent failure is the norm, and it is asymmetric

Nothing here fails loudly. Per-harness, what a bad pin actually does:

| harness | bad effort value | bad model value |
|---|---|---|
| claude | via `CLAUDE_CODE_EFFORT_LEVEL` (**the route this plugin uses**): silently dropped, runs the model default, no message | loud: `unrecognized_model`, turn still runs |
| droid | **silently coerced** to that model's `defaultReasoningEffort`, exit 0. Source is in the binary: `if (R.supportedReasoningEfforts.includes(H)) return H; return R.defaultReasoningEffort` | prints `Invalid model` and **exits 0** |
| grok | file route is unvalidated locally: box boots clean, first turn dies with API 400 `Invalid reasoning effort` | rejected at set time |
| codex | client never validates (its own schema types it as a plain non-empty string), API rejects at first turn | boots fine, dies first turn |
| prime | warning on stderr, **clamped** to the nearest supported level, exit 0 | n/a |
| muse | warning on stderr, runs the default, exit 0 | boots fine, dies first turn |
| opencode | unknown variant looked up, missed, **silently ignored**, exit 0 | opaque server error |
| amp | commander rejects locally, exit 1 | `--mode` typo **exits 0** after a ~20s round trip |

Two consequences. First, validating the pin plugin-side is the only signal that exists
for claude, droid, prime, muse and opencode. Second, a bad pin is almost always
create-time silent and runtime loud, which is the worst shape for a fleet: the box is
green and the pane looks fine.

## Drift already present in this repo

The case for automating does not need an argument about upstream velocity. **The repo
holds two hand-maintained copies of the same eight scales and they already disagree
with each other.**

| harness | `src/effort.js:39` | `config/config.example.toml:~228` | measured today |
|---|---|---|---|
| codex | `low medium high xhigh max ultra` | `minimal low medium high xhigh ultra` | no listed model offers `minimal`; every one offers `max` |
| droid | 7 values (drops `none`, `dynamic`) | 9 values | 9 syntactic, 8 live (`dynamic` supported by no available model) |
| muse | has `ultra`, lacks `max` | not listed | box (0.1.0) has neither `max`; laptop (1.0.3) has `max`, and `ultra` is entitlement-gated and degrades to `xhigh` |
| grok | flat `low medium high xhigh` | flat, plus `grok-build` as an example id | per-model. `grok-4.5` has no `xhigh`. `grok-build` is **not in this account's catalog** |

Same eight scales are also written down a third time in `test/effort.test.js` (as
pinned expectations) and a fourth time in a comment block in `src/model-pin.js`. Four
copies, drifting independently.

Version annotations in `src/effort.js` are stale too: it cites grok 1.0.13 (box 1.0.5,
laptop 1.0.24), droid 0.213.0 (box 0.172.0, laptop 0.199.0, vendor 0.215.1), prime
0.7.0 (laptop 0.9.3), muse 0.2.1 (box 0.1.0). Its `kimi-k3: off|low|high|max` example
does not appear in the box droid's model list at all.

One unrelated one-line bug found on the way: `src/harnesses.js:12` says "Governed by
`docs/adr/0006`", but `docs/adr/0006` is `region-is-sugar-over-domain.md`. The
spawn-the-binary and never-read-the-credential-store rule is **ADR 0009**.

## The cheap staleness key nobody was looking for

A weekly cron that boots eight boxes is the obvious refresh and it is wasteful. Two
unauthenticated-shaped signals answer "did anything actually change" first.

**1. The E2B template inventory.** `GET https://api.e2b.dev/templates` with
`X-API-KEY` (the team key already in `~/.e2b/config.json`) returns per-template
`templateID`, `buildID`, `buildCount`, `updatedAt`, `lastSpawnedAt`. Live today:

```
opencode  2026-09-09T04:31:18Z  buildCount 78
codex     2026-09-07T15:13:57Z  28
claude    2026-09-07T08:12:01Z  23
grok      2026-09-07T08:18:12Z  20
amp       2026-09-07T08:11:18Z  19
droid     2026-09-07T08:17:14Z  15
prime     2026-09-07T08:25:34Z   9
muse      2026-09-07T08:22:55Z   8
```

Store `buildID` beside each generated row and re-probe only the templates whose build
moved. One HTTP call instead of eight sandboxes.

It also answers a question the plugin cannot ask today. The same listing carries two
public agent templates with **no row in `src/harnesses.js`**: `devin` (buildCount 21)
and `cursor-agents` (buildCount 20), both rebuilt in the same 08:11-08:25Z batch as the
eight known ones. So this endpoint is also the only channel that would report "there
is a ninth agent image and the plugin has no row for it".

**2. Per-vendor version feeds**, seven of eight, all unauthenticated:

```
claude    npm packument @anthropic-ai/claude-code  dist-tags.latest -> 2.1.266
codex     npm packument @openai/codex                                 0.153.4
opencode  npm packument opencode-ai                                   1.18.30
amp       npm packument @sourcegraph/amp                              0.0.1788940851-g2b0940
prime     GitHub releases/latest PrimeIntellect-ai/prime-agent        v0.9.4
grok      GET https://x.ai/cli/stable            (bare string)        1.0.24
droid     GET https://app.factory.ai/cli         (embeds VER="...")   0.215.1
muse      GET https://api.meta.ai/muse-code/channels/muse-stable      1.0.3-R2198.1
```

Do not reach for a GitHub releases feed for grok or amp: `xai-org/grok-cli` and
`sourcegraph/amp` are both 404. And `prime-agent` is **not on npmjs.org** (`npm view`
returns E404), so GitHub is its only feed.

## Recommended shape

Per-harness probe of the shipped artifact, one pure parse layer, three transports, one
committed generated data module. Deliberately the same shape as `src/harnesses.js` and
`src/fleet-seed.js`: a shipped data table beside a pure function, because ADR 0009
already settled this argument for credential detection and the argument is identical.

1. **`src/catalog.js`** (new, pure). `CATALOG_PROBES` table plus
   `interpretCatalog(id, probe)` which takes a probe RESULT and never spawns, mirroring
   `interpretProbe`. Every parse reads `stdout` + `stderr` combined and ignores the exit
   code, because two probes exit non-zero by design. All eight parse rules then test on
   a machine with no harness installed, which is what keeps `npm test` offline.
2. **`scripts/harness-catalog.mjs`** (new, the only impure part), beside and modelled on
   the existing `scripts/verify-keys.mjs`:
   `node scripts/harness-catalog.mjs [template ...] [--check|--write] [--from=box|local|fixture]`.
   Default templates are `Object.keys(HARNESSES)` so the default set cannot drift from
   what the plugin ships. `--check` is the default and writes nothing. Exit 0 clean, 1
   usage or untrustworthy probe, **2 drift found** (a finding, not an error, so a
   refresher can tell "the world moved" from "the script is broken").
3. **`src/harness-catalog.generated.js`** (new, generated, committed). Each row carries
   `probedFrom`, the resolved binary path and the version that answered, plus the E2B
   `buildID`. `src/effort.js` then derives `EFFORT_SCALES` from it and keeps only the
   hand-written `kind` and `via` overlay, which are plugin facts (how the pin reaches
   the box), not harness facts. Four copies collapse to one.
4. **Sentinel comments in `config/config.example.toml`.** Rewrite only between the
   markers, as text. Never re-stringify: `@iarna/toml`'s `stringify` drops comments and
   that file is almost entirely comments.

`--from=box` is the **authoritative** transport, not an optional one, per the version
table above. It reuses `verify-keys.mjs`'s throwaway-sandbox pattern.

Zero new dependencies: `execFile` for spawning, Node 22 global `fetch` for the two
model-column lookups, `@iarna/toml` already a dependency, `e2b` already a dependency.
`npm test` gains `test/catalog.test.js` automatically through the existing
`test/*.test.js` glob, and never probes.

Two rules the script must keep, in its header the way `verify-keys.mjs` states its own:

- **A credential is never printed and never passed on a command line.** Its output goes
  into a PR body, so it must be safe to paste. Report the variable NAME and whether it
  was present.
- **A failed probe never blanks a row.** Keep the committed row, mark it
  `stale: {since, reason}`, say so in the report. Otherwise one unauthenticated run
  silently empties every scale and every user pin becomes invalid.

### Phasing

- **Phase 0, about 6 lines, no new files.** Fix the drifts that exist now: reconcile the
  codex row (drop `minimal`, add `max`), reconcile droid's two lists, correct the stale
  version annotations, and fix the ADR 0006 citation. Ships correctness this week and
  makes the next phase's motivation self-evident.
- **Phase 1, read-only.** `src/catalog.js` + `scripts/harness-catalog.mjs` with the
  `fixture` and `box` transports, fixtures captured from the eight real template
  binaries, `test/catalog.test.js`, two npm scripts. The manual work here is mostly the
  work of *noticing*, and this kills that outright while changing no behavior.
- **Phase 2, writes.** `--write`, the generated module, the sentinels, and
  `src/effort.js` deriving instead of holding literals. Rework `test/effort.test.js`
  from exact-value pinning to invariants.
- **Phase 3, self-running.** Trigger off `buildID` + the version feeds rather than a
  blind cron, open a PR when the tree changes. Last on purpose: a bot opening PRs from
  parsers nobody has reviewed is worse than a manual run on a Friday.
- **Phase 4, only on request.** Cross-validate model against effort in `provision.js`
  (droid's silent coercion is invisible today) and `--fix-config` for surgical repair of
  the user's own `config.toml`.

## Traps for whoever writes this

1. **`opencode models` is not the universe of valid ids.** It lists CONFIGURED
   providers. Measured: `env -i PATH=$PATH HOME=/tmp/oc-clean opencode models` prints 7
   lines; with real credentials it prints 439. A box probe would delete 432 valid ids.
   Use models.dev for opencode's model column, or skip validating that row.
2. **amp has two vocabularies. Never union them.** `ultra` is a MODE only;
   `xhigh`/`max`/`minimal`/`none` are EFFORTS only; `low|medium|high` overlap and mean
   different things. amp's `--mode` is also server-validated, so a typo exits 0.
3. **Model id shapes differ per harness.** droid ids are bare single segments
   (`claude-opus-5`). prime and opencode are `provider/model`, split at the FIRST slash
   (`openrouter/qwen/qwen3.8-max-0902` has three segments; amp has a five-segment id).
   `src/model-pin.js` already splits correctly; do not regress it.
4. **`prime` is not the harness. `prime-agent` is.** Both are installed here and they
   are different products. `src/harnesses.js:507` already gets this right.
5. **Drew's shell shadows two of these binaries.** `droid` is a zsh function that
   rewrites args (adding `--skip-permissions-unsafe`), and `codex` is a function with
   five `codex` entries on PATH. A probe must call the absolute path, not trust
   `command -v` in an interactive shell. `claude` also resolves to 2.1.266 under zsh and
   2.1.191 under bash on this machine.
6. **The grok pin can be silently skipped today.** `src/model-pin.js`'s guard leaves the
   file alone if it already contains `[models]`, and grok **writes its own `[models]`
   section on first run** (a clean `GROK_HOME` gets one immediately). That is the most
   likely reason a grok pin appears not to apply.
7. **`droid.initialize_session` is not read-only.** It scaffolds `~/.factory` and creates
   a session. Point HOME at a temp dir; it still returns the full model list.
8. **Catalogs are account-scoped.** droid filters its bundled ~81 models to 45 by
   feature flags cached in `~/.factory/cache/feature-flags.json`; codex's catalog is
   plan-gated; grok's is team-scoped (`grok-build` is absent from this account). A
   generated table should record which account produced it.
9. **`codex debug models` silently falls back to the bundled catalog when
   unauthenticated**, returning retired models. Detect it by diffing against
   `--bundled`, or check `~/.codex/models_cache.json`'s `fetched_at`.

## Unverified

- The response body of Anthropic `GET /v1/models`. Endpoint verified (401 demanding
  `x-api-key`); the `capabilities.effort` shape is taken from first-party docs. Closes
  with any working key.
- Whether `api.x.ai/v1/models` (the BYOK path) carries `reasoning_efforts`. Existence
  proven by 401; content not. The CLI entries carry `supported_in_api`, implying the two
  catalogs are deliberately different sets.
- `https://ampcode.com/api/models` shape (401 with and without a bearer). Do not build
  on it; the offline CLI JSON is better anyway.
- `https://downloads.claude.ai/model-catalog/v1/catalog.json` is baked into claude
  2.1.266 as the default catalog URL and currently returns 404 `NoSuchKey`. If it lands
  it supersedes both the API and the binary-extraction path. Worth re-probing.
- Whether muse's `max` is a distinct provider tier or a client-side alias. Accepted by
  the CLI and present in the `muse-spark-1.3` catalog row, but absent from the MSP wire
  enum (which declares itself closed).
- Whether droid's `availableModels` can differ from the bundled catalog because of a
  network response rather than only cached feature flags.
