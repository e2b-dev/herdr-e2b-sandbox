import { readFile, readdir, lstat, realpath } from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import { posix } from "node:path"

import { isIgnored, parseStatusZ } from "./shared.js"

/**
 * Upload the local worktree into the sandbox project directory, and leave the
 * box's git reading the way the laptop's does (ADR 0012).
 *
 * Two modes, chosen by whether the worktree has a commit to stand on:
 *
 *   mirror   — the worktree is a git repo with a HEAD. The box gets HEAD's tree as
 *              ONE tarball (`git archive`), extracted and committed as the baseline,
 *              and then only the files that differ from HEAD locally — modified and
 *              untracked — are written on top, and files deleted locally are removed.
 *              `git status` in the box is then the same list as `git status` here.
 *              It is also the cheap path: one write plus the dirty set, instead of
 *              one write per file. A file the ignore list names (`.env`, even when
 *              tracked) is removed before the commit, so it is in neither the
 *              baseline nor the tree.
 *   snapshot — not a repo, or a repo with no commits yet. Every file git would see
 *              (`ls-files --cached --others --exclude-standard`, or a filesystem walk
 *              for a non-repo) is written, then everything is committed as the
 *              baseline. The box reads clean; there was no local history to mirror.
 *
 * Inside a repo we always trust git, even when its selection is empty, so a repo
 * whose files are all git-ignored uploads nothing rather than leaking ignored files.
 *
 * SYNC (`baseline.created` false): the same two modes, applied over a box that already
 * has a baseline and possibly agent work. In mirror mode HEAD's tree is extracted over
 * the box (overwriting tracked files, as a re-upload always did) and the baseline
 * commit stages ONLY the tracked paths (`--pathspec-from-file`), so a file the agent
 * created stays uncommitted and `pull` still sees it. Then the local dirty set goes
 * on top as before.
 *
 * MODE BITS: `files.write` carries content, not permissions, so an overlaid file
 * lands as 0644; the tarball keeps its modes. One `chmod +x` pass over the overlaid
 * files that were executable locally puts back the one bit git tracks. Never fails
 * the upload: a box with the wrong modes is recoverable, a failed upload is not.
 *
 * `baseline` is `{ branch, label, head, created }`; without it no commit is made and
 * the old additive copy is what you get.
 */
export async function uploadSnapshot({
  sandbox,
  localRoot,
  remoteRoot,
  ignore,
  batchSize = 40,
  onProgress,
  baseline = null,
}) {
  const gitList = await gitFiles(localRoot) // null ⇒ not a git repo
  const viaGit = gitList !== null
  const archive = viaGit ? await gitArchive(localRoot) : null // null ⇒ no HEAD
  const mode = archive ? "mirror" : "snapshot"

  let files // what gets written file-by-file
  let deleted = [] // mirror only: tracked locally at HEAD, gone from the worktree
  let count
  const listPath = "/home/user/.herdr-e2b-uploaded"

  if (mode === "mirror") {
    const plan = planMirror({
      tracked: await gitTracked(localRoot),
      statusZ: await gitStatusZ(localRoot),
      ignore,
    })
    files = plan.changed
    deleted = plan.deleted
    count = plan.count
    if (onProgress) await onProgress(0, files.length + 1)

    // HEAD's tree, in one write. `tar` keeps modes, so the bulk of the tree never
    // needs the chmod pass below.
    const tgz = "/tmp/.herdr-e2b-head.tgz"
    await sandbox.files.write(tgz, archive)
    await sandbox.commands.run(
      `mkdir -p ${shQuote(remoteRoot)} && tar -xzf ${shQuote(tgz)} -C ${shQuote(remoteRoot)} && rm -f ${shQuote(tgz)}`,
    )
    await removeInBox(sandbox, remoteRoot, plan.drop)
    if (baseline) {
      // A sync stages only the paths this tarball carried; a fresh box has nothing else.
      if (!baseline.created) await sandbox.files.write(listPath, plan.keep.join("\0"))
      await sandbox.commands
        .run(baselineCommand({ projectPath: remoteRoot, ...baseline, listPath: baseline.created ? null : listPath }))
        .catch(() => {})
    }
    // A locally deleted file was put back by the tarball and committed into the
    // baseline; removing it now is what makes it read `D` in the box, as it does here.
    await removeInBox(sandbox, remoteRoot, deleted)
  } else if (viaGit) {
    // Drop directory/submodule boundary entries git emits for nested untracked
    // repos (e.g. "sub/") — they're not files and carry no content here.
    files = gitList.filter((p) => !p.endsWith("/")).filter((rel) => !isIgnored(rel, ignore))
    count = files.length
  } else {
    // Not a git repo → walk the folder directly (ignore list is the only filter).
    const rootReal = await realpath(localRoot)
    files = (await collect(localRoot, localRoot, ignore, { rootReal, seen: new Set() })).filter(
      (rel) => !isIgnored(rel, ignore),
    )
    count = files.length
  }

  let done = 0
  const execs = []
  for (const batch of chunk(files, batchSize)) {
    const entries = []
    for (const rel of batch) {
      const abs = path.join(localRoot, rel)
      let st
      try {
        st = await lstat(abs)
      } catch {
        continue // listed but gone (e.g. race) — skip
      }
      if (!st.isFile()) continue // skip dirs, symlinks, submodule gitlinks
      // 0o111: any of user/group/other execute. Git records only "was it executable",
      // so this is the same question git asks when it writes 100755 vs 100644.
      if (st.mode & 0o111) execs.push(rel)
      entries.push({ path: posix.join(remoteRoot, rel), data: await readFileAsArrayBuffer(abs) })
    }
    if (entries.length) await sandbox.files.write(entries)
    done += entries.length
    if (onProgress) await onProgress(done + (mode === "mirror" ? 1 : 0), files.length + (mode === "mirror" ? 1 : 0))
  }
  await restoreExecBits(sandbox, remoteRoot, execs)

  // Snapshot mode commits AFTER the writes: there is no separate baseline tree, the
  // uploaded files are it.
  if (baseline && mode === "snapshot") {
    if (!baseline.created) await sandbox.files.write(listPath, files.join("\0"))
    await sandbox.commands
      .run(baselineCommand({ projectPath: remoteRoot, ...baseline, listPath: baseline.created ? null : listPath }))
      .catch(() => {})
  }

  return { count, viaGit, mode, execs: execs.length, files, dirty: files.length, deleted: deleted.length }
}

/**
 * What a mirror upload does with each path, decided from the two things the local
 * git says: what HEAD tracks, and what differs from it. Pure, and tested — this is
 * the list of files that are written, removed, and committed in the box.
 *
 *   keep    — tracked at HEAD and not on the ignore list: in the tarball, in the baseline
 *   drop    — tracked at HEAD but on the ignore list (`.env`): removed BEFORE the commit
 *   changed — differs from HEAD locally (modified, added, untracked): written on top
 *   deleted — tracked at HEAD, gone locally: removed AFTER the commit, so it reads `D`
 *   count   — files the box ends up with: keep, minus deleted, plus the untracked
 *
 * Deleted-and-ignored is not a case: an ignored path is dropped before the commit,
 * so there is nothing for its deletion to show against.
 */
export function planMirror({ tracked = [], statusZ = "", ignore = [] }) {
  const trackedSet = new Set(tracked)
  const keep = []
  const drop = []
  for (const rel of tracked) (isIgnored(rel, ignore) ? drop : keep).push(rel)
  const status = parseStatusZ(statusZ)
  const changed = status.changed.filter((rel) => !isIgnored(rel, ignore))
  const deleted = status.deleted.filter((rel) => trackedSet.has(rel) && !isIgnored(rel, ignore))
  const untracked = changed.filter((rel) => !trackedSet.has(rel)).length
  return { keep, drop, changed, deleted, count: keep.length - deleted.length + untracked }
}

/**
 * The shell that turns an uploaded tree into a git BASELINE inside the box — the
 * commit everything the agent does is a diff against (ADR 0012). Pure: builds the
 * command, runs nothing, so it can be tested without a sandbox.
 *
 * Two shapes, because the two uploads mean different things:
 *
 *   fresh box  — `git init -b <branch>`, stage EVERYTHING, commit. In mirror mode
 *                "everything" is HEAD's extracted tree; in snapshot mode it is the
 *                uploaded files. Nothing else exists in the box yet.
 *   sync       — the box already has a baseline AND possibly agent work on top. Only
 *                the paths at `listPath` (NUL-delimited: the tarball's paths, or the
 *                uploaded files) are staged via `--pathspec-from-file`, so an agent's
 *                file the sync did not touch stays uncommitted and `pull` still sees
 *                it. `git add -A` here would fold the agent's work into the baseline.
 *
 * The identity is pinned with `-c` rather than read from the box: a template may
 * ship any `.gitconfig` or none, and a commit that fails for want of a name is a
 * baseline that silently never existed. `--allow-empty` keeps an empty upload (a
 * repo whose files are all ignored) from leaving HEAD unborn — a HEAD that does not
 * exist is exactly the state this exists to remove. `--no-verify`: the box has no
 * hooks worth running and a hook is one more way for the baseline not to happen.
 *
 * The message carries the local sha because the box otherwise has no idea which
 * commit it was cut from — the plugin uploads files, never `.git`.
 */
export function baselineCommand({ projectPath, branch, label, head, created, listPath }) {
  const ref = String(branch || "main").replace(/'/g, "")
  const who = "-c user.name=herdr-e2b -c user.email=herdr-e2b@localhost"
  const subject = `herdr-e2b: snapshot of ${String(label || "").replace(/'/g, "")} @ ${ref}${head ? ` ${head}` : ""}`
  const commit = `git ${who} commit -q --no-verify --allow-empty -m ${shQuote(subject)}`
  const stage = created || !listPath ? "git add -A" : `git add --pathspec-from-file=${shQuote(listPath)} --pathspec-file-nul`
  return (
    `cd ${shQuote(projectPath)} && ` +
    `(git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b ${shQuote(ref)}) && ` +
    `${stage} >/dev/null 2>&1; ${commit} >/dev/null 2>&1 || true`
  )
}

/** `rm -f` a list of paths under `remoteRoot`, chunked, best effort, `--` guarded. */
async function removeInBox(sandbox, remoteRoot, rels) {
  if (!rels.length || !sandbox?.commands?.run) return
  for (const batch of chunk(rels, 200)) {
    const args = batch.map((rel) => shQuote(posix.join(remoteRoot, rel))).join(" ")
    try {
      await sandbox.commands.run(`rm -f -- ${args}`)
    } catch {
      // A path that would not go is a nuisance; a thrown upload is a lost box.
    }
  }
}

/**
 * Put back the one permission bit git tracks. Chunked because argv has a length limit
 * and a repo can carry hundreds of scripts; `--` so a path beginning with `-` is a
 * path. Best effort by design — see the MODE note above.
 */
async function restoreExecBits(sandbox, remoteRoot, rels) {
  if (!rels.length || !sandbox?.commands?.run) return
  for (const batch of chunk(rels, 200)) {
    const args = batch.map((rel) => shQuote(posix.join(remoteRoot, rel))).join(" ")
    try {
      await sandbox.commands.run(`chmod +x -- ${args}`)
    } catch {
      // A wrong mode is a nuisance; a thrown upload is a lost box. Keep going.
    }
  }
}

/** Single-quote for a POSIX shell: wrap, and close/escape/reopen around each quote. */
function shQuote(s) {
  return `'${s.split("'").join(`'\''`)}'`
}

/**
 * git-tracked + untracked-but-not-ignored files under `root` (relative, posix),
 * or null if not a repo. The trailing `-- .` scopes the listing to `root` — so
 * when `root` is a subfolder of a larger repo (e.g. a loose folder inside a
 * mono-checkout), we upload only that folder, not the entire enclosing repo.
 */
function gitFiles(root) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        resolve(
          stdout
            .split("\0")
            .filter(Boolean)
            .map((p) => p.split(path.sep).join("/")),
        )
      },
    )
  })
}

/** `git archive --format=tar.gz HEAD` as a Buffer, or null when there is no HEAD. */
function gitArchive(root) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "archive", "--format=tar.gz", "HEAD"],
      { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    )
  })
}

/**
 * Paths in HEAD's tree (relative, posix). Empty on error. `ls-tree HEAD`, not
 * `ls-files`: the index also holds staged-new files, which the tarball (cut from
 * HEAD) does not carry, and a sync's `git add --pathspec-from-file` aborts whole on
 * one pathspec that matches nothing.
 */
function gitTracked(root) {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "ls-tree", "-r", "-z", "--name-only", "HEAD"], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? [] : stdout.split("\0").filter(Boolean).map((p) => p.split(path.sep).join("/"))),
    )
  })
}

/** The local `git status`, in the same shape pull reads from the box. Empty on error. */
function gitStatusZ(root) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : stdout),
    )
  })
}

async function collect(dir, root, ignore, state) {
  const dirReal = await realpath(dir)
  if (state.seen.has(dirReal)) return [] // symlink cycle guard
  state.seen.add(dirReal)

  const out = []
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    const rel = path.relative(root, abs).split(path.sep).join("/")
    if (isIgnored(rel, ignore)) continue

    const st = await lstat(abs)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      out.push(...(await collect(abs, root, ignore, state)))
      continue
    }
    if (st.isFile()) out.push(rel)
  }
  return out
}

function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function readFileAsArrayBuffer(abs) {
  const b = await readFile(abs)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
