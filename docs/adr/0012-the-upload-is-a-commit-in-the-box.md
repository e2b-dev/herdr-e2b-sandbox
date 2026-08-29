# The upload is a commit in the box

**Status:** accepted, 2026-08-29

The plugin mirrors a worktree into a box by uploading files, never `.git`
(`src/upload.js`). Until now the box side then ran `git init -b <branch> && git add
-A` and stopped. That left a repository with a staged index and no commit: `git
status` read as every file being new (`main +197` in a prompt), `git diff HEAD` had
nothing to diff against, `git blame` and `git log` were dead, and an agent working
in the box had no way to tell what it had changed from what it had been handed.

`pull` (`src/download.js`) paid for the same gap in time. With no baseline to ask
the box's git about, it listed every file, read every file over the SDK and
byte-compared each one locally, so a pull after a four-file change cost the same as
a pull after a rewrite, and a pull with nothing to fetch cost the same again.

## Decision

**The box gets a baseline commit whose tree is the laptop's `HEAD`, and the
laptop's uncommitted changes sit on top of it, uncommitted.** `git status` in the
box then reads as `git status` does locally.

- A fresh box, worktree with a HEAD (**mirror**): `git archive HEAD` locally, one
  tarball written and extracted in the box, `git init -b <branch> && git add -A &&
  git commit`. Then only the files that differ from HEAD locally (modified, added,
  untracked; `git status --porcelain`) are written on top, and files deleted
  locally are removed, so they read `D` in the box too. The message is
  `herdr-e2b: snapshot of <label> @ <branch> <local sha>`; the sha is now the
  literal content of the baseline, not a hint.
- A fresh box, no HEAD (**snapshot**: a non-repo folder, or a repo with no
  commits): every file git would see is written, then all of it is committed. The
  box reads clean; there was no local history to mirror.
- A sync (`e2b-box sync`): the same, over a box that already has a baseline and
  possibly agent work. The tarball is extracted over the tree (a re-upload always
  overwrote tracked files) and the commit stages **only the tracked paths**
  (`--pathspec-from-file`). `git add -A` here would fold the agent's uncommitted
  work into the baseline and make it invisible to the changed-set pull below.
- Staging is not mirrored: a locally staged change arrives unstaged. The box
  answers "what differs from HEAD", not "what is in the index".
- A tracked path on the plugin's ignore list (`.env`) is removed before the
  commit, so it is in neither the baseline nor the tree.
- `pull` asks the box `git status --porcelain -z` and reads only what it names.
  Deletions are **reported, not applied**: pull writes files in place, and a delete
  is the one write a local `git diff` cannot show afterwards.
- A box with no `HEAD` (provisioned before this ADR, or a non-repo project dir)
  falls back to the full listing and byte-compare, exactly as before.

The identity is pinned (`-c user.name=herdr-e2b -c user.email=herdr-e2b@localhost`),
not read from the box: a template ships any `.gitconfig` or none, and a commit that
fails for want of a name is a baseline that silently never existed. `--allow-empty`
keeps `HEAD` born even for an upload of zero files; `--no-verify` because a hook is
one more way for the baseline not to happen. The whole command ends in `|| true`:
a box whose baseline could not be made still opens and still works, it is just the
slow pull.

## Consequences

- In the box, `git status` starts as the laptop's own status and grows with the
  agent's work; `git diff` shows both against a real HEAD. A clean local `main`
  opens as a clean `main`, a dirty one opens dirty in the same way.
- Upload cost drops from one write per file to one tarball plus the dirty set.
  For this repo: 2.2 MB and 11 files instead of 199 writes.
- `pull` costs O(changed files) instead of O(all files), and can name what the
  agent deleted.
- The baseline is a real commit on the box's `main`. A user who pulls and then
  looks at the box's `git log` sees one synthetic commit per upload with a
  `herdr-e2b:` prefix. This is the trade: history in the box is the upload
  history, not the repo's.
- `pull_risk` and the clobber prompts in `bin/e2b-box` are unchanged; they guard
  the local side, which this ADR does not touch.

## Rejected

- **Upload `.git` and clone properly.** Gives the box real history, and pull gains
  nothing from it: the changed set is the same question either way. The cost is
  the entire object store per box; for this repo that includes every prebuilt TUI
  binary ever committed. `git archive HEAD` is the one tree that matters, at 2.2 MB.
- **Commit the working tree as the baseline** (the first cut of this ADR). Cheap
  and it made pull fast, but it flattened the laptop's own uncommitted work into
  the baseline: a dirty local `main` opened as a clean one, and the agent could
  not see what the user had in flight.
- **`git bundle` of HEAD.** Shallow bundles are not a thing git supports cleanly,
  and a full bundle is the object store again.
- **Diff by mtime.** `files.write` sets the mtime to upload time on every file,
  so there is nothing to compare against.
