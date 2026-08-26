---
name: release
description: Sweep every merge-ready pull request into main, then cut and publish a new version of this repo — the whole path from "what's ready?" to a live GitHub Release with the dashboard binaries attached. It enumerates open PRs with a merge-readiness verdict (green CI vs. running vs. needs-a-human), squash-merges the ones that are genuinely ready, moves the `[Unreleased]` changelog items under a dated version heading, bumps `package.json` and `herdr-plugin.toml` together, runs the pre-tag preflight the release workflow would otherwise fail on minutes later, tags, pushes, and watches the run to a published release. Use this whenever the user says release, cut a release, ship it, publish, tag a version, bump the version, "merge what's ready", "merge the green PRs", "clear the PR queue", "what's mergeable", "is anything ready to merge", "sweep the PRs", "0.2.0", "next version", "do a patch release", "release the plugin", or asks what state the open PRs are in — and also when they ask for only half of it, like merging without releasing or releasing without merging, because the safety rules and the version arithmetic are the same either way. Prefer this over improvising `gh pr merge` and `git tag` by hand: this repo has a review ruleset that makes healthy PRs report as BLOCKED, two version files that must agree with the tag, and a release workflow that hard-fails on an empty changelog section after spending minutes cross-compiling — all easy to get wrong once and impossible to take back.
---

# release — sweep what's ready, then cut a version

Two phases that are usually run together but are independently useful:

1. **Sweep** — merge the open PRs that are genuinely ready, so main holds everything the version will claim.
2. **Cut** — turn `[Unreleased]` into a dated version, tag it, and let the workflow publish.

Both phases do things that cannot be undone. A merged PR can be reverted but not un-merged; a
pushed tag and a published release are public the moment they land. So the shape of this skill is:
gather evidence cheaply, show the human the verdicts, act only on the unambiguous ones, and stop
and ask on anything else. That is not timidity — it is the only way to move fast here without
occasionally shipping something nobody meant to ship.

## Phase 1 — the merge sweep

### Get the verdicts

```bash
bash .agents/skills/release/scripts/pr-status.sh
```

One row per open PR, each with a verdict:

| verdict | meaning | what to do |
|---|---|---|
| `READY` | not a draft, no conflicts, every check green against current main | merge it (subject to the rules below) |
| `STALE` | green, but the checks ran against a base that has since moved | re-run CI or update the branch, then merge |
| `WAIT` | checks still in flight | do not merge; either wait or leave it for the next sweep |
| `HOLD` | draft, conflicts, red CI, **no checks at all**, or CI **held pending approval** | a human decides; report it and move on |

The script computes this rather than leaving it to inspection because three of these are
counterintuitive:

- A PR with **zero** checks is `HOLD`, not `READY`. Nothing has proven it safe, and "no news" is not
  good news.
- A fork PR from a first-time contributor has its workflows **held** at `action_required` until a
  maintainer releases them, and the check rollup does not say so — it just contains fewer entries,
  sometimes only the CLA status. That is the most dangerous shape here, because "one check, green,
  nothing running" reads as ready when nothing has been tested at all. The script probes the head
  sha's workflow runs for held ones and calls that `HOLD`. Releasing a held run means letting an
  outsider's code execute in CI, so read the diff first — then `gh api -X POST
  repos/<owner>/<repo>/actions/runs/<id>/approve`, and wait for the real checks.
- A PR can report `mergeable: MERGEABLE` while its CI is red, so the check rollup is consulted
  separately from GitHub's own mergeability field.
- `STALE` is the one nothing in the GitHub API surfaces. A PR whose checks passed a week ago against
  an older main is reported as green and mergeable, but those tests never ran against the tree that
  would actually ship. That matters more at release time than at review time: the release notes end
  up claiming a tested state that was never tested. Fix it by updating the branch (`gh pr update-branch <N>`)
  and letting CI run again — not by deciding it's probably fine.

### What never gets merged without asking

- **Someone else's PR — unless the user has already approved it.** This repo takes outside
  contributions, and a green PR from another author is normally a review request rather than a queue
  item: surface it, name the author, let the user decide. But check `reviewDecision` first. An
  `APPROVED` from the user *is* the go-ahead — holding a PR they already signed off on isn't caution,
  it's ignoring an answer they already gave. Hold when nobody has reviewed it; merge when they have.
- **A fork PR whose diff nobody has read.** Outside contributions frequently skip CodeQL (default
  setup doesn't analyse fork heads), so the one PR from beyond the org is often the one with the
  least automated scrutiny. Compare its check count against an internal PR's; if it is short, read
  the diff line by line before merging and say that you did. Green on fewer checks is less evidence,
  not equal evidence.
- **Anything `WAIT` or `HOLD`.** No "it'll probably pass". If CI is still running, the honest report
  is that it is still running.
- **A PR the user didn't ask about**, when they named specific ones. "Merge #20" is not permission
  to sweep the queue.

### `BLOCKED` is usually not a problem

`mergeStateStatus: BLOCKED` on a green PR almost always means the ruleset on `main` wants one
approving review, and on a solo-authored change there is nobody to give it. Confirm what the rule
actually is before concluding anything:

```bash
gh api repos/e2b-dev/herdr-e2b-sandbox/rulesets --jq '.[]|{id,name}'
gh api repos/e2b-dev/herdr-e2b-sandbox/rulesets/<id> \
  --jq '{rules:[.rules[]|{type,params:(.parameters//{}|{required_approving_review_count})}]}'
```

If the only thing standing in the way is that review requirement and the author is the user, an
admin merge is the intended path — but **say so in the report**, because "I used your admin bypass"
is information the user needs, not an implementation detail. If a check is genuinely failing,
`--admin` is the wrong tool and the answer is to fix the PR.

### Merging

Squash is this repo's current convention — recent history is uniformly `type: description (#N)`,
even where a branch carried several commits. Match it, and write the subject yourself so the title
is conventional rather than a branch slug:

```bash
gh pr merge <N> --squash --admin --delete-branch \
  --subject "type: short description (#N)"
```

Then sync local main before doing anything else, so every later step reads the real tree:

```bash
git checkout main && git pull
```

## Phase 2 — cutting the release

### Choose the version

Read what actually landed since the last tag, then propose a number:

```bash
git log --oneline "$(git describe --tags --abbrev=0)"..main
```

This project is pre-1.0, and its own history sets the rule: `0.1.0` shipped breaking changes
(`feat!:` entries) as a **minor**. So while the major is `0`:

- any `feat` or `feat!` → bump the **minor** (`0.1.0` → `0.2.0`)
- only `fix` / `docs` / `chore` → bump the **patch** (`0.1.0` → `0.1.1`)

After `1.0.0`, revert to ordinary semver (`feat!` → major).

State the number and the reasoning, and let the user correct it before you touch a file. A version
is the one decision here with no undo — tags are not re-pointed, and a wrong number is permanent
public history. If the user already named a version, use theirs.

### Write the changelog

The workflow builds the GitHub Release notes from this file, so the changelog *is* the release. In
`CHANGELOG.md`:

1. Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, using **today's** date. (Check it — a
   release branch prepared weeks ago carries a stale date, which is exactly the trap that shows up
   in a long-lived release PR.)
2. Leave a fresh, empty `## [Unreleased]` heading directly above the new version section. This
   looks like pointless bookkeeping and is not: with no such heading, the next contributor adding a
   bullet to "the top of the changelog" lands it inside a **published** version's notes, silently
   rewriting what a shipped release claims to contain. An empty heading costs one line and gives
   every future bullet an obvious home.
3. Update the two link definitions at the bottom:
   ```
   [Unreleased]: https://github.com/e2b-dev/herdr-e2b-sandbox/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/e2b-dev/herdr-e2b-sandbox/releases/tag/vX.Y.Z
   ```
4. Audit for coverage before moving on. Every feature merged in phase 1 should have a bullet — grep
   for a distinctive word from each merged PR title. A silent omission here means a release whose
   notes don't mention its own headline feature, and nobody notices until someone goes looking for
   it later.

### Bump both version files

`package.json` and `herdr-plugin.toml` have to agree with each other **and** with the tag. CI's
`version-check` job and the release workflow both assert it independently:

```bash
node -e 'const f="package.json",fs=require("fs");const j=JSON.parse(fs.readFileSync(f));j.version=process.argv[1];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' X.Y.Z
sed -i '' 's/^version = ".*"/version = "X.Y.Z"/' herdr-plugin.toml
```

### Preflight, then tag

```bash
bash .agents/skills/release/scripts/release-preflight.sh X.Y.Z
```

This checks the whole set at once — on main, clean tree, synced with origin, both version files
matching, a non-empty changelog section that `scripts/changelog-notes.sh` can actually extract, no
existing tag, and a green `npm test`. Three of these are things the release workflow itself fails
on, but only *after* installing a cross-compile toolchain and building three binaries. Failing here
costs seconds; failing there costs minutes and leaves a pushed tag attached to a failed run.

Only when it is all clear:

```bash
git tag vX.Y.Z && git push origin main --tags
```

**Do not rebuild `tui/prebuilt/` locally.** `CONTRIBUTING.md` still says to, but the workflow now
wipes that directory and rebuilds all three binaries from the tag's own source — which is strictly
better, since it cannot ship a stale blob. Local `zig` and `cargo-zigbuild` are not needed.

### Watch the run without blocking on it

The tag push starts the release workflow. It takes a few minutes (the cross-compile dominates), so
watch it with a monitor rather than a blocking `gh run watch` — a blocking watch leaves the user
staring at nothing and cannot be interrupted usefully:

```bash
gh run list --workflow=release.yml --limit 1 --json databaseId,status --jq '.[0]'
```

Then arm a monitor that emits each completed step and exits on the run's terminal state, so a
failure is as loud as a success. Watch for the steps that matter: `npm test`, the tag↔version
verification, the changelog notes build, the binary build, and the verification that all three
binaries exist.

### Verify what actually published

A green run is not proof the release looks right. Check the artifact:

```bash
gh release view vX.Y.Z --json tagName,isDraft,isPrerelease,url,assets \
  --jq '{tag:.tagName,draft:.isDraft,prerelease:.isPrerelease,url,assets:[.assets[]|{name,size}]}'
```

Three assets should be attached — `e2b-dash-darwin-universal`, `e2b-dash-linux-x64`,
`e2b-dash-linux-arm64` — and `draft` should be `false`. Report the URL, and copy it to the clipboard
with `pbcopy` so it is ready to paste.

## If a release branch already exists

A long-lived `chore/release-X.Y.Z` branch will have gone stale behind main. Bring main **into** it:

```bash
git merge origin/main --no-edit
```

Not a rebase. The branch is already pushed, and rebasing a pushed branch means force-pushing it —
which rewrites history other people may have fetched. A merge commit is slightly less tidy and
strictly safer, and the squash-merge into main erases the difference anyway.

Then re-audit it as if it were fresh: a release branch prepared earlier carries an old date and is
missing every bullet added since.

## Report

Close with a short table: each PR merged (number, squash SHA, and whether an admin bypass was used),
each PR deliberately left alone and why, the version chosen and the reasoning, and the release URL
with its assets. Then say what state `[Unreleased]` is in, so the next person knows where to add.

If any part was skipped or blocked, say that plainly in the same place. A release report that
implies completeness it doesn't have is worse than one that names its gap.

## The traps in this repo, specifically

- **A merged PR can file its changelog bullets into a *published* section.** This is the sharpest
  trap in the repo and it is completely silent. An open PR's changelog hunk was written against
  `## [Unreleased]`; once a release renames that heading, the hunk's context still matches and the
  bullets land inside the shipped version's notes. Git reports a clean merge, `version-check` only
  compares the two version files, and nothing fails — the release just quietly claims things it
  never contained, and the *next* release's section comes out empty and hard-fails the workflow
  after the tag is public. So: keep an empty `[Unreleased]` heading alive, and after merging any PR
  that touches `CHANGELOG.md`, look at where its bullets actually went before tagging.
- **`BLOCKED` ≠ broken.** It is the review ruleset. Check the ruleset before diagnosing anything.
- **Green is not the same as green against main.** See `STALE` above.
- **Two version files, one tag.** All three must agree or two separate jobs fail.
- **An empty changelog section fails the release** — after the slow build steps, not before.
- **`CONTRIBUTING.md` step 3 is stale** on rebuilding `tui/prebuilt/`; the workflow does it.
- **Never force-push.** Not to a release branch, not to main, not with `--force-with-lease`.
- **A PR with no checks is not a passing PR.** Absence of evidence is not evidence — and a fork
  PR's CI is held for approval without saying so, so "one green check" can mean "no CI ran".
