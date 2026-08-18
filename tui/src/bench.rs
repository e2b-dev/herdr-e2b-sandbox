// Bench records: what a graded run of a fleet produced.
//
// The layout mirrors `boxes/` for the same reasons (see docs/adr/0005): one file
// per member, written atomically, so a run needs no locking, cannot interleave
// two half-written results, and a member that never finished simply has no file.
//
//   $STATE_DIR/bench/<run-id>/run.json        the task, the grade command, the base
//   $STATE_DIR/bench/<run-id>/<box-key>.json  one member's verdict
//
// The run id is the fleet's task slug — ADR-0001's "the branch prefix is the
// migration key", used as intended: a bench run is a view over a fleet, never a
// second registry of its members. The member list is re-derived from branches on
// every read and is deliberately absent from run.json.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::state::{state_dir, Box};

/// What happened to one member. `Error` is NOT a failing test — it means the box
/// could not be reached, so the agent was never actually measured. Keeping them
/// apart is the whole reason `e2b-box exec` reports them differently; collapsing
/// them here would score a crashed sandbox as a losing agent.
#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Verdict {
    Pass,
    Fail,
    Error,
    #[default]
    Pending,
}

impl Verdict {
    /// How `e2b-box exec`'s JSON maps onto a verdict. `ok:false` is the box being
    /// unreachable; anything else is the command's own exit code.
    pub(crate) fn from_exec(ok: bool, exit_code: Option<i32>) -> Verdict {
        match (ok, exit_code) {
            (false, _) => Verdict::Error,
            (true, Some(0)) => Verdict::Pass,
            (true, Some(_)) => Verdict::Fail,
            // Reached the box, ran the command, and it reported no code at all.
            // Not a pass: something is wrong with the measurement, and a silent
            // upgrade to Pass is the one mistake a grader must never make.
            (true, None) => Verdict::Error,
        }
    }

    pub(crate) fn glyph(self) -> &'static str {
        match self {
            Verdict::Pass => "✓ pass",
            Verdict::Fail => "✗ fail",
            Verdict::Error => "! error",
            Verdict::Pending => "⋯",
        }
    }
}

/// `run.json` — the inputs, so a result can be read months later and still say
/// what it measured. Everything here is a fact about the run, never about which
/// members it had.
#[derive(Deserialize, Serialize, Clone, Default)]
pub(crate) struct Run {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) grade: String,
    #[serde(default)]
    pub(crate) task: String,
    #[serde(default)]
    pub(crate) base: String,
    #[serde(default, rename = "startedAt")]
    pub(crate) started_at: String,
}

/// One member's result. Output is kept as tails rather than in full: a test suite
/// can print megabytes, this file is read on every board refresh, and the last few
/// lines are what a human actually reads. The full output was on stdout when the
/// grade ran.
#[derive(Deserialize, Serialize, Clone, Default)]
pub(crate) struct Result_ {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) template: String,
    #[serde(default)]
    pub(crate) branch: String,
    #[serde(default)]
    pub(crate) verdict: Verdict,
    #[serde(default, rename = "exitCode")]
    pub(crate) exit_code: Option<i32>,
    #[serde(default)]
    pub(crate) ms: u64,
    #[serde(default)]
    pub(crate) stdout: String,
    #[serde(default)]
    pub(crate) stderr: String,
    #[serde(default)]
    pub(crate) error: String,
    #[serde(default, rename = "gradedAt")]
    pub(crate) graded_at: String,
}

pub(crate) fn bench_dir() -> PathBuf {
    state_dir().join("bench")
}

pub(crate) fn run_dir(id: &str) -> PathBuf {
    bench_dir().join(id)
}

/// Keep only the last `n` lines. Tail, not head: a failing suite says what failed
/// at the end, and truncating from the front would keep the part nobody reads.
pub(crate) fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Atomic like the box records: write beside the target, then rename, so a board
/// polling every couple of seconds can never read half a result.
pub(crate) fn write_result(id: &str, r: &Result_) -> std::io::Result<()> {
    let dir = run_dir(id);
    fs::create_dir_all(&dir)?;
    let final_path = dir.join(format!("{}.json", r.key));
    let tmp = dir.join(format!(".{}.json.tmp", r.key));
    fs::write(&tmp, serde_json::to_vec_pretty(r).unwrap_or_default())?;
    fs::rename(&tmp, &final_path)
}

pub(crate) fn write_run(r: &Run) -> std::io::Result<()> {
    let dir = run_dir(&r.id);
    fs::create_dir_all(&dir)?;
    let tmp = dir.join(".run.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(r).unwrap_or_default())?;
    fs::rename(&tmp, dir.join("run.json"))
}

pub(crate) fn load_run(id: &str) -> Option<Run> {
    let text = fs::read_to_string(run_dir(id).join("run.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Every member result in a run, sorted by label so the board's row order is
/// stable across refreshes however the finishing order fell.
pub(crate) fn load_results(id: &str) -> Vec<Result_> {
    let mut out: Vec<Result_> = Vec::new();
    let Ok(entries) = fs::read_dir(run_dir(id)) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if p.file_name().and_then(|s| s.to_str()) == Some("run.json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&p) {
            if let Ok(r) = serde_json::from_str::<Result_>(&text) {
                out.push(r);
            }
        }
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

/// Every run on disk, newest directory first — for `e2b-bench` with no run named.
pub(crate) fn list_runs() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Ok(entries) = fs::read_dir(bench_dir()) else {
        return out;
    };
    for e in entries.flatten() {
        if e.path().is_dir() {
            if let Some(name) = e.file_name().to_str() {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    out
}

/// The members of a fleet, from the box records — never from a stored list
/// (ADR-0005). A member's branch is `<prefix>/<slug>-<template>-<rand4>`, so the
/// fleet is every box whose branch carries that slug segment.
///
/// Matching on `/<slug>-` rather than the whole prefix keeps this working when
/// `[fleet] prefix` is something other than the default: the slug is the part the
/// user typed and the part that identifies the run.
pub(crate) fn members_of<'a>(boxes: &'a [Box], slug: &str) -> Vec<&'a Box> {
    let needle = format!("/{slug}-");
    boxes
        .iter()
        .filter(|b| b.branch.contains(&needle))
        .collect()
}

/// The template a member booted from, read out of its branch name
/// (`…/<slug>-<template>-<rand4>`). The box record has a `template` field too,
/// but the branch is what names the member, and a board that disagreed with the
/// branch would be confusing to read next to `git branch`.
pub(crate) fn template_of(branch: &str, slug: &str) -> String {
    let Some(rest) = branch.split(&format!("/{slug}-")).nth(1) else {
        return String::new();
    };
    match rest.rsplit_once('-') {
        Some((template, _rand)) => template.to_string(),
        None => rest.to_string(),
    }
}

/// `<slug>-<template>` — the same label `e2b-fleet` gives the member's workspace
/// and agent, so the board, the sidebar and `git branch` all say one thing.
pub(crate) fn label_of(branch: &str, slug: &str) -> String {
    let template = template_of(branch, slug);
    if template.is_empty() {
        branch.to_string()
    } else {
        format!("{slug}-{template}")
    }
}

/// A tally for the summary line. Errors are counted apart from failures because
/// "2 of 4 passed" reads very differently when the other two never ran.
#[derive(Default, PartialEq, Eq, Debug)]
pub(crate) struct Tally {
    pub(crate) pass: usize,
    pub(crate) fail: usize,
    pub(crate) error: usize,
    pub(crate) pending: usize,
}

pub(crate) fn tally(results: &[Result_]) -> Tally {
    let mut t = Tally::default();
    for r in results {
        match r.verdict {
            Verdict::Pass => t.pass += 1,
            Verdict::Fail => t.fail += 1,
            Verdict::Error => t.error += 1,
            Verdict::Pending => t.pending += 1,
        }
    }
    t
}

/// Where a run's results live, for printing. Kept here so nothing else has to
/// know the layout.
pub(crate) fn run_dir_display(id: &str) -> String {
    run_dir(id).to_string_lossy().to_string()
}

/// True when `p` is inside the bench tree — a guard for anything that deletes.
#[allow(dead_code)]
pub(crate) fn is_bench_path(p: &Path) -> bool {
    p.starts_with(bench_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreachable_box_is_an_error_not_a_failure() {
        // The distinction the whole grader rests on: a sandbox that died must
        // never be scored as an agent that failed the test.
        assert_eq!(Verdict::from_exec(false, None), Verdict::Error);
        assert_eq!(Verdict::from_exec(false, Some(0)), Verdict::Error);
        assert_eq!(Verdict::from_exec(true, Some(0)), Verdict::Pass);
        assert_eq!(Verdict::from_exec(true, Some(1)), Verdict::Fail);
    }

    #[test]
    fn a_missing_exit_code_is_never_silently_a_pass() {
        assert_eq!(Verdict::from_exec(true, None), Verdict::Error);
    }

    #[test]
    fn members_come_from_branches_not_from_a_stored_list() {
        let mk = |branch: &str| Box {
            branch: branch.into(),
            ..Default::default()
        };
        let boxes = vec![
            mk("e2b/login-fix-claude-ab12"),
            mk("e2b/login-fix-codex-ab12"),
            mk("e2b/other-task-claude-cd34"),
            mk("main"),
        ];
        let members = members_of(&boxes, "login-fix");
        assert_eq!(members.len(), 2);
        // A different [fleet] prefix must not stop the slug from matching.
        let boxes = vec![mk("bench/x/login-fix-grok-ab12")];
        assert_eq!(members_of(&boxes, "login-fix").len(), 1);
    }

    #[test]
    fn template_and_label_are_read_out_of_the_branch() {
        assert_eq!(
            template_of("e2b/login-fix-claude-ab12", "login-fix"),
            "claude"
        );
        assert_eq!(
            label_of("e2b/login-fix-claude-ab12", "login-fix"),
            "login-fix-claude"
        );
        // A slug containing a dash must not confuse the split — the template is
        // what sits between the slug and the random suffix.
        assert_eq!(
            template_of("e2b/log-in-fix-codex-99zz", "log-in-fix"),
            "codex"
        );
        // Nothing recognisable: fall back to the branch rather than invent a name.
        assert_eq!(label_of("main", "login-fix"), "main");
    }

    #[test]
    fn tails_keep_the_end_where_the_failure_is() {
        let text = (1..=10)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(tail_lines(&text, 3), "8\n9\n10");
        // Fewer lines than asked for is not an error.
        assert_eq!(tail_lines("only", 5), "only");
        assert_eq!(tail_lines("", 5), "");
    }

    #[test]
    fn errors_are_tallied_apart_from_failures() {
        let r = |v: Verdict| Result_ {
            verdict: v,
            ..Default::default()
        };
        let t = tally(&[
            r(Verdict::Pass),
            r(Verdict::Fail),
            r(Verdict::Error),
            r(Verdict::Pending),
        ]);
        assert_eq!(
            t,
            Tally {
                pass: 1,
                fail: 1,
                error: 1,
                pending: 1
            }
        );
    }
}
