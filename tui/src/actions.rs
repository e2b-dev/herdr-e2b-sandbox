// Per-sandbox actions: the confirm-gated verbs, and Enter's "go to the worktree".
use std::process::Command;

use crate::state::sh;

#[derive(Clone, Copy)]
pub(crate) enum Verb {
    Sync,
    Pull,
    Kill,
}

impl Verb {
    pub(crate) fn cmd(self) -> &'static str {
        match self {
            Verb::Sync => "sync",
            Verb::Pull => "pull",
            Verb::Kill => "kill",
        }
    }
    pub(crate) fn confirm(self, label: &str, wt: &str) -> String {
        match self {
            Verb::Sync => {
                format!("SYNC  local → sandbox   uploads {wt} into the sandbox (additive)   [y/N]")
            }
            Verb::Pull => {
                format!("PULL  sandbox → local   overwrites {wt} from the sandbox   [y/N]")
            }
            Verb::Kill => format!("KILL  '{label}'   destroys the sandbox   [y/N]"),
        }
    }
}

/// Verbs that address the box by KEY alone. Everything else operates ON the
/// worktree, so it must run there (and the caller must check it still exists).
pub(crate) fn key_only(verb: &str) -> bool {
    matches!(verb, "kill" | "status" | "pause" | "resume")
}

pub(crate) fn action_command(verb: &str, key: &str, wt: &str) -> Command {
    let mut command = Command::new("e2b-box");
    command
        .arg(verb)
        .env("KEY", key)
        .env_remove("HERDR_PLUGIN_CONTEXT_JSON");
    if !key_only(verb) {
        command.current_dir(wt);
    }
    command
}

/// Enter: go to a sandbox's local worktree. Focus an already-open herdr workspace
/// for that path (or a subdir), else open it fresh. Only meaningful inside herdr.
/// Returns a status message for the footer.
pub(crate) fn goto_worktree(label: &str, wt: &str) -> String {
    if wt.is_empty() {
        return format!("{label}: no worktree path");
    }
    if std::env::var("HERDR_SOCKET_PATH").map_or(true, |s| s.is_empty()) {
        return "↵ needs herdr (press o to open the sandbox instead)".into();
    }
    let herdr = std::env::var("HERDR_BIN_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "herdr".into());
    // Match an open pane by cwd (or a subdir), then:
    //  - different workspace → workspace focus (+ tab focus)
    //  - same workspace, other tab → tab focus
    //  - same workspace + tab → unzoom the dashboard's own pane (you're already
    //    in this worktree; the board is zoomed over it)
    //  - not open anywhere → open it fresh (--focus)
    let sel = "'.result.panes[] | select(.cwd==$wt or (.cwd|startswith($wt+\"/\")) or .foreground_cwd==$wt or (.foreground_cwd|startswith($wt+\"/\"))) | \"\\(.workspace_id) \\(.tab_id)\"'";
    let script = format!(
        "wt={wt}; sel=$({h} pane list 2>/dev/null | jq -r --arg wt \"$wt\" {sel} | head -1); \
ws=$(echo \"$sel\" | cut -d' ' -f1); tab=$(echo \"$sel\" | cut -d' ' -f2); \
if [ -z \"$ws\" ]; then \
  if [ -d \"$wt\" ]; then {h} workspace create --cwd \"$wt\" --focus >/dev/null 2>&1 && echo opened || echo missing; else echo missing; fi; \
elif [ \"$ws\" != \"$HERDR_WORKSPACE_ID\" ]; then \
  {h} workspace focus \"$ws\" >/dev/null 2>&1; {h} tab focus \"$tab\" >/dev/null 2>&1; echo switched; \
elif [ \"$tab\" != \"$HERDR_TAB_ID\" ]; then \
  {h} tab focus \"$tab\" >/dev/null 2>&1; echo switched; \
else \
  {h} pane zoom --pane \"$HERDR_PANE_ID\" --off >/dev/null 2>&1 || {h} pane zoom --current --off >/dev/null 2>&1; echo unzoomed; \
fi",
        wt = sh(wt),
        h = sh(&herdr),
        sel = sel,
    );
    let word = Command::new("bash")
        .arg("-lc")
        .arg(&script)
        .env_remove("HERDR_PLUGIN_CONTEXT_JSON")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    match word.as_str() {
        "switched" => format!("→ switched to {label}'s worktree"),
        "opened" => format!("→ opened {label}'s worktree"),
        "unzoomed" => format!("→ {label} is here — unzoomed the board"),
        "missing" => format!("{label}: worktree not open & not found locally"),
        _ => format!("{label}: couldn't switch"),
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::{action_command, key_only};
    use crate::state::{
        branch_cell, branch_column_width, git_dir_link, head_branch, parse_head, region_label,
        resolve_branch, status_detail, template_cell, template_downgraded, TEMPLATE_W,
    };

    /// A throwaway directory under the system temp dir. `head_branch` reads real
    /// files, so the only honest test of it is one that puts real files on disk —
    /// the parsers below are already covered in isolation, and a wrong path join
    /// between them would pass every one of those.
    struct TempTree(std::path::PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("e2b-dash-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }
        fn write(&self, rel: &str, body: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).expect("parent");
            std::fs::write(path, body).expect("write");
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn head_branch_reads_a_plain_checkout() {
        let tree = TempTree::new("plain");
        tree.write(".git/HEAD", "ref: refs/heads/main\n");
        assert_eq!(head_branch(tree.path()), Some("main".to_string()));
    }

    #[test]
    fn head_branch_follows_a_linked_worktrees_git_file() {
        // The shape `git worktree add` produces: `.git` is a file pointing at a
        // directory inside the parent repo. A relative pointer resolves against
        // the worktree root, which is the join most likely to be written wrong.
        let tree = TempTree::new("linked");
        tree.write(".git", "gitdir: ./real-git-dir\n");
        tree.write(
            "real-git-dir/HEAD",
            "ref: refs/heads/e2b/login-claude-a1b2\n",
        );
        assert_eq!(
            head_branch(tree.path()),
            Some("e2b/login-claude-a1b2".to_string())
        );
    }

    #[test]
    fn head_branch_gives_up_on_a_missing_worktree() {
        let tree = TempTree::new("gone");
        let path = tree.path().to_string();
        drop(tree);
        assert_eq!(head_branch(&path), None);
        assert_eq!(head_branch(""), None);
    }

    #[test]
    fn kill_executes_inherited_path_binary_directly() {
        let command = action_command("kill", "box-1", "");
        let key = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new("KEY"))
            .and_then(|(_, value)| value);

        assert_eq!(command.get_program(), OsStr::new("e2b-box"));
        assert_eq!(command.get_args().collect::<Vec<_>>(), [OsStr::new("kill")]);
        assert_eq!(key, Some(OsStr::new("box-1")));
    }

    // pause/resume address the box by KEY, so they must run even for a box whose
    // worktree is gone — a paused box still bills nothing but must be resumable.
    #[test]
    fn pause_and_resume_need_no_worktree() {
        assert!(key_only("pause") && key_only("resume"));
        assert_eq!(action_command("pause", "box-1", "").get_current_dir(), None);
    }

    #[test]
    fn sync_uses_worktree_as_process_directory() {
        let command = action_command("sync", "box'1", "/tmp/work tree");

        assert_eq!(command.get_program(), OsStr::new("e2b-box"));
        assert_eq!(command.get_args().collect::<Vec<_>>(), [OsStr::new("sync")]);
        assert_eq!(
            command.get_current_dir(),
            Some(std::path::Path::new("/tmp/work tree"))
        );
    }

    // --- the BRANCH column ------------------------------------------------
    // The dashboard shows a branch because a branch is a useful fact about a
    // worktree; it reads HEAD and nothing else, and never interprets the name.

    #[test]
    fn head_yields_the_branch_without_its_refs_prefix() {
        assert_eq!(
            parse_head("ref: refs/heads/main\n").as_deref(),
            Some("main")
        );
        // Slashes are ordinary in a ref, so only the refs/heads/ prefix goes.
        assert_eq!(
            parse_head("ref: refs/heads/feat/deep/name\n").as_deref(),
            Some("feat/deep/name")
        );
    }

    #[test]
    fn a_detached_head_shows_the_short_commit_instead_of_breaking() {
        assert_eq!(
            parse_head("9d72f9012ab34cd56ef7890123456789abcdef01\n").as_deref(),
            Some("@9d72f90")
        );
        // Neither a ref nor a sha: unknown, and the caller falls back.
        assert_eq!(parse_head("garbage\n"), None);
        assert_eq!(parse_head(""), None);
    }

    #[test]
    fn a_linked_worktrees_git_file_points_at_its_git_dir() {
        assert_eq!(
            git_dir_link("gitdir: /repo/.git/worktrees/member\n").as_deref(),
            Some("/repo/.git/worktrees/member")
        );
        assert_eq!(git_dir_link("not a gitdir pointer"), None);
    }

    // A box outlives its worktree (removed checkout, still-billable sandbox):
    // the record's branch is then the last true thing known about it.
    #[test]
    fn a_missing_worktree_falls_back_to_the_record() {
        assert_eq!(resolve_branch(None, "feat/gone"), "feat/gone");
        assert_eq!(resolve_branch(None, "  "), "");
        // The live read wins whenever there is one — a record written at
        // provisioning time goes stale the moment you check something else out.
        assert_eq!(
            resolve_branch(Some("feat/now".into()), "feat/then"),
            "feat/now"
        );
    }

    #[test]
    fn a_long_branch_is_cut_to_the_column_and_marked() {
        assert_eq!(branch_cell("feat/short", 20), "feat/short");
        assert_eq!(branch_cell("feat/short", 10), "feat/short"); // exact fit, no cut
        assert_eq!(
            branch_cell("feat/a-very-long-branch-name", 12),
            "feat/a-very…"
        );
        assert_eq!(branch_cell("feat/x", 1), "…");
        // Unknown branch reads like the FILES column's "nothing to show".
        assert_eq!(branch_cell("", 12), "—");
        // Column dropped: the row still renders, it just has no branch cell.
        assert_eq!(branch_cell("feat/x", 0), "");
    }

    #[test]
    fn the_column_gives_way_before_the_other_columns_do() {
        assert_eq!(branch_column_width(60), 0); // too narrow to afford one
        assert_eq!(branch_column_width(0), 0);
        assert_eq!(branch_column_width(95), 8); // the narrowest it's worth
        assert_eq!(branch_column_width(200), 28); // capped, STATUS keeps the rest
        assert!(branch_column_width(101) > branch_column_width(96));
    }

    // --- the TEMPLATE column ----------------------------------------------
    // Which image a box runs decides which agent is installed in it, so the
    // board names it — and says out loud when it is NOT the one asked for.

    // --- STATUS carries what STEP used to -----------------------------------

    #[test]
    fn the_status_cell_only_adds_a_step_that_says_something_new() {
        assert_eq!(
            status_detail("provisioning", "uploading 210/540 files").as_deref(),
            Some("uploading 210/540 files")
        );
        assert_eq!(
            status_detail("failed", "provision failed · see logs").as_deref(),
            Some("provision failed · see logs")
        );
        // The pair the dropped STEP column printed twice.
        assert_eq!(status_detail("ready", "ready"), None);
        // `ready` is the step's "nothing in flight" value — stale beside a
        // paused box, not news.
        assert_eq!(status_detail("paused", "ready"), None);
        assert_eq!(status_detail("ready", ""), None);
    }

    // --- the header's region ----------------------------------------------

    #[test]
    fn a_domain_reads_as_the_region_a_person_would_have_picked() {
        assert_eq!(region_label("e2b-juliett.dev"), "eu");
        // US is served at two hosts, and both are the same environment.
        assert_eq!(region_label("e2b.app"), "us");
        assert_eq!(region_label("e2b.dev"), "us");
        // Nothing pinned IS US: US production resolves to no domain at all.
        assert_eq!(region_label(""), "us");
        assert_eq!(region_label("  "), "us");
        // An unknown host has no region name, so it prints as itself rather
        // than being given an invented one.
        assert_eq!(region_label("e2b-staging.internal"), "e2b-staging.internal");
    }

    #[test]
    fn the_template_column_shows_the_image_the_box_actually_runs() {
        assert_eq!(template_cell("claude", "", TEMPLATE_W), "claude");
        // Nothing recorded (older record, or a box with no sandbox yet) reads
        // like the FILES column's "nothing to show".
        assert_eq!(template_cell("", "", TEMPLATE_W), "—");
        // Column dropped: no text at all.
        assert_eq!(template_cell("claude", "", 0), "");
    }

    #[test]
    fn a_downgraded_template_is_marked_and_keeps_its_mark_when_cut() {
        // Requested one wasn't built on this cluster; `base` booted instead.
        assert_eq!(template_cell("base", "claude", TEMPLATE_W), "base ⚠");
        // The mark holds its two cells, so the NAME is what gives way.
        assert_eq!(template_cell("base-with-extras", "claude", 8), "base-… ⚠");
        assert!(template_downgraded("base", "claude"));
        // The node side clears requestedTemplate on a match, so neither an empty
        // nor an equal value is a downgrade.
        assert!(!template_downgraded("claude", ""));
        assert!(!template_downgraded("claude", "claude"));
    }
}
