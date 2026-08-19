// Box records + small shared helpers (state dir resolution, shell quoting).
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

/// One tracked sandbox, as written by the node side into a `<state>/boxes/*.json`.
#[derive(Deserialize, Default, Clone)]
pub(crate) struct Box {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) step: String,
    #[serde(default, rename = "sandboxId")]
    pub(crate) sandbox_id: String,
    /// The template the sandbox ACTUALLY runs, as written at create time. Empty
    /// for a record from before templates were tracked, and for a box that never
    /// got as far as a sandbox.
    #[serde(default)]
    pub(crate) template: String,
    /// The template that was ASKED for, recorded only when it differs from the
    /// one that booted — a template built on another cluster falls back to
    /// `base` (see provision.js), and the board says so rather than implying the
    /// agent you wanted is in there.
    #[serde(default, rename = "requestedTemplate")]
    pub(crate) requested_template: String,
    #[serde(default)]
    pub(crate) files: u32,
    #[serde(default, rename = "worktreePath")]
    pub(crate) worktree_path: String,
    /// The branch of the worktree this box mirrors. Deserialized from the
    /// record (what the branch was when the box was last provisioned) and then
    /// overwritten by `load_boxes` with what the worktree says *now*, so a
    /// checkout after provisioning doesn't leave the board lying. Empty when
    /// neither source knows — rendered as `—`.
    #[serde(default)]
    pub(crate) branch: String,
    /// The E2B cluster this box lives on. Empty for records written before
    /// domains were tracked — those boxes are on whatever the SDK defaulted to.
    #[serde(default)]
    pub(crate) domain: String,
}

/// Plugin state dir. Prefer herdr's own HERDR_PLUGIN_STATE_DIR (set for plugin
/// panes), then the plugin's HERDR_E2B_STATE_DIR override, then the XDG path the
/// node side writes to. Keep IN SYNC with src/store.js and bin/lib/paths.sh.
pub(crate) fn state_dir() -> PathBuf {
    if let Ok(d) = std::env::var("HERDR_PLUGIN_STATE_DIR") {
        return PathBuf::from(d);
    }
    if let Ok(d) = std::env::var("HERDR_E2B_STATE_DIR") {
        return PathBuf::from(d);
    }
    if let Ok(d) = std::env::var("XDG_STATE_HOME") {
        return PathBuf::from(d).join("herdr/plugins/e2b-dev.herdr-e2b");
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join(".local/state/herdr/plugins/e2b-dev.herdr-e2b")
}

/// All box records in `dir`, sorted by display label.
pub(crate) fn load_boxes(dir: &PathBuf) -> Vec<Box> {
    let mut out: Vec<Box> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(txt) = fs::read_to_string(&p) {
                if let Ok(mut b) = serde_json::from_str::<Box>(&txt) {
                    if b.label.is_empty() {
                        b.label = b.key.clone();
                    }
                    // Refresh point for the branch too — read once per reload,
                    // cached on the Box, never touched again during a draw.
                    b.branch = resolve_branch(head_branch(&b.worktree_path), &b.branch);
                    out.push(b);
                }
            }
        }
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

/// What the branch column shows: the worktree's live answer when we could read
/// one, otherwise the branch the record remembers from provisioning time (still
/// the last true thing we know about a worktree that has since been removed),
/// otherwise nothing.
pub(crate) fn resolve_branch(live: Option<String>, recorded: &str) -> String {
    live.unwrap_or_else(|| recorded.trim().to_string())
}

/// The branch a worktree is on right now, read straight out of git's `HEAD`.
///
/// Deliberately NOT `git rev-parse`: forking a process per box per refresh is
/// what would make the board stutter. `HEAD` is a one-line file whose format is
/// part of git's on-disk layout, so a read + a `strip_prefix` is the whole job,
/// and the result is cached on the `Box` like every other field.
///
/// `None` for a worktree that is missing, isn't a checkout, or whose `HEAD` we
/// can't make sense of — the caller falls back to the record.
pub(crate) fn head_branch(worktree: &str) -> Option<String> {
    if worktree.is_empty() {
        return None;
    }
    let root = Path::new(worktree);
    let dot_git = root.join(".git");
    let git_dir = if fs::metadata(&dot_git).ok()?.is_dir() {
        dot_git
    } else {
        // A linked worktree's `.git` is a FILE pointing at the real git dir,
        // so every worktree created by `git worktree add` lands here.
        let link = git_dir_link(&fs::read_to_string(&dot_git).ok()?)?;
        root.join(link)
    };
    parse_head(&fs::read_to_string(git_dir.join("HEAD")).ok()?)
}

/// The path out of a linked worktree's `.git` file (`gitdir: <path>`). May be
/// relative, so the caller resolves it against the worktree root.
pub(crate) fn git_dir_link(text: &str) -> Option<String> {
    let line = text.lines().next()?;
    let path = line.strip_prefix("gitdir:")?.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Read a `HEAD` file's contents as a branch name. A detached HEAD holds a raw
/// commit sha instead of a ref — show it short and `@`-prefixed, because "which
/// commit" is the only honest answer there and a blank cell would read as an
/// error.
pub(crate) fn parse_head(head: &str) -> Option<String> {
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        let name = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        return (!name.is_empty()).then(|| name.to_string());
    }
    let detached = head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit());
    detached.then(|| format!("@{}", &head[..7]))
}

/// Width of the TEMPLATE column: wide enough for the longest agent template the
/// plugin ships rules for (`opencode`) plus the downgrade mark, and fixed — which
/// template a box runs is part of what the box IS, so it doesn't give way.
pub(crate) const TEMPLATE_W: u16 = 12;

/// Fixed cost of a table row that is NOT the branch column: the block's two
/// borders, the `▸ ` highlight symbol, NAME/TEMPLATE/SANDBOX/FILES, the minimum
/// STATUS (last column, and elastic because it carries the provisioning step),
/// and the one-cell gap between each of those five columns.
/// Keep in sync with the `widths` array in main.rs's `draw`.
const TABLE_FIXED: u16 = 2 + 2 + 18 + TEMPLATE_W + 22 + 6 + 20 + 4;
const BRANCH_MIN: u16 = 8;
const BRANCH_MAX: u16 = 28; // fits a long feature branch without starving STEP

/// How wide the BRANCH column may be in a table `total` cells across. Zero
/// means the pane can't afford one at all, and the column is dropped rather
/// than shoving STEP off the right edge — the branch is the addition here, so
/// the branch is what gives way first.
pub(crate) fn branch_column_width(total: u16) -> u16 {
    let spare = total.saturating_sub(TABLE_FIXED + 1); // +1: the column's own gap
    if spare < BRANCH_MIN {
        0
    } else {
        spare.min(BRANCH_MAX)
    }
}

/// A branch rendered into `width` cells. Longer names are cut with `…` so a
/// truncated branch never passes for a real one; an unknown branch reads as the
/// same `—` the FILES column uses for "nothing to show".
pub(crate) fn branch_cell(branch: &str, width: u16) -> String {
    fit(branch, width)
}

/// Whether a box is running a DIFFERENT template than the one asked for. The
/// node side records the requested name only in that case, so a non-empty,
/// non-matching `requestedTemplate` is the whole test.
pub(crate) fn template_downgraded(template: &str, requested: &str) -> bool {
    !requested.is_empty() && requested != template
}

/// What the TEMPLATE column shows: the template the sandbox actually runs, with
/// a trailing `⚠` when that is not the one requested — the same glyph the header
/// uses for "this list isn't all one cluster". The mark keeps its two cells even
/// when the name has to be cut, because a silent downgrade is exactly the thing
/// the column exists to make visible.
pub(crate) fn template_cell(template: &str, requested: &str, width: u16) -> String {
    if width == 0 {
        return String::new();
    }
    if !template_downgraded(template, requested) {
        return fit(template, width);
    }
    format!("{} ⚠", fit(template, width.saturating_sub(2)))
}

/// A value cut to `width` cells: `…` marks a truncation, `—` stands in for nothing
/// known, and a zero-width (dropped) column renders no text at all.
fn fit(value: &str, width: u16) -> String {
    let width = width as usize;
    if width == 0 {
        return String::new();
    }
    if value.is_empty() {
        return "—".into();
    }
    if value.chars().count() <= width {
        return value.to_string();
    }
    let kept: String = value.chars().take(width.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// The extra detail the STATUS cell shows after the status word, if any — what
/// the dropped STEP column was actually for: `uploading 210/540 files` while a
/// box provisions, `provision failed · see logs` after it fails.
///
/// Nothing is shown when the step only repeats the status, and nothing when the
/// step is `ready` — that is the step's own "nothing in flight" value, so beside
/// a `paused` box it is stale rather than informative.
pub(crate) fn status_detail(status: &str, step: &str) -> Option<String> {
    let step = step.trim();
    let dull = step.is_empty() || step == status || step == "ready";
    (!dull).then(|| step.to_string())
}

/// The REGION a domain belongs to — what a person picks, as opposed to the host
/// that serves it. Keep the table IN SYNC with `REGION_BY_DOMAIN` in
/// src/config.js, which is where the plugin's own answer lives.
///
/// An empty domain is `us`, and deliberately so: US production resolves to no
/// domain at all (the SDK defaults there), so "nothing pinned" and "US" are the
/// same state — see the REGIONS table in config.js. A host with no region name
/// prints as itself rather than being given an invented one.
pub(crate) fn region_label(domain: &str) -> String {
    match domain.trim() {
        "" | "e2b.app" | "e2b.dev" => "us".into(),
        "e2b-juliett.dev" => "eu".into(),
        other => other.into(),
    }
}

/// The E2B cluster this dashboard is pointed at — i.e. where a box opened from
/// here would land. `bin/e2b-dash` exports `E2B_DOMAIN` (resolved by the same
/// bash bridge every other verb uses), so the TUI never re-implements the
/// precedence. Launched directly, with no env, fall back to what the tracked
/// boxes say, so the header still shows something true.
pub(crate) fn current_domain(boxes: &[Box]) -> String {
    if let Ok(d) = std::env::var("E2B_DOMAIN") {
        let d = d.trim();
        if !d.is_empty() {
            return d.to_string();
        }
    }
    boxes
        .iter()
        .find(|b| !b.domain.is_empty())
        .map(|b| b.domain.clone())
        .unwrap_or_default()
}

/// Re-ask the bash layer which cluster we would use *now*. `bin/e2b-dash` passes
/// the resolver's path in `E2B_DASH_DOMAIN_CMD`; without it (TUI launched
/// directly) there is nothing to poll and the launch-time value stands.
///
/// This exists because the header would otherwise be frozen at launch: switch
/// regions with the dashboard open and it would keep naming the old cluster.
/// Returns None on any failure — a header that keeps its last good value beats
/// one that blanks out because a probe hiccuped.
///
/// The TUI's own env is a launch-time snapshot (`bin/e2b-dash` exports
/// E2B_DOMAIN before exec'ing us), and the resolver gives env highest
/// precedence — inherited, it would win every probe and freeze the header at
/// the launch value. Scrub both credential halves so the resolver reads its
/// fresh sources (plugin config, `e2b` CLI login); the key must go too, since
/// the resolver only trusts the CLI login's domain when the resolved key is
/// the CLI's own.
pub(crate) fn probe_domain() -> Option<String> {
    let cmd = std::env::var("E2B_DASH_DOMAIN_CMD").ok()?;
    let out = std::process::Command::new(&cmd)
        .env_remove("E2B_DOMAIN")
        .env_remove("E2B_API_KEY")
        .output()
        .ok()?;
    let d = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!d.is_empty()).then_some(d)
}

/// POSIX shell single-quote a value so it's a single safe token (paths with
/// spaces, $, backticks, quotes can't expand or break out of `bash -lc`).
pub(crate) fn sh(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
