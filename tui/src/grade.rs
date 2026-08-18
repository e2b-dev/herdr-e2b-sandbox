// Running the held-out check in every member's box, concurrently.
//
// Rust drives; it never touches E2B. Each member is graded by shelling out to
// `e2b-box exec`, which is the only thing that may call the SDK (JavaScript-only
// — ARCHITECTURE.md, "Three layers"). Same shape as actions.rs: build a Command,
// address the box by KEY, read what comes back.
use std::{
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::bench::{label_of, tail_lines, template_of, Result_, Verdict};
use crate::state::Box;

/// How much of each stream a result keeps. Enough to see the assertion that
/// failed, not so much that a board refresh reads a megabyte per member.
const TAIL: usize = 40;

/// `e2b-box exec`'s stdout contract, and the only part of it Rust parses.
#[derive(serde::Deserialize, Default)]
struct ExecOut {
    #[serde(default)]
    ok: bool,
    #[serde(default, rename = "exitCode")]
    exit_code: Option<i32>,
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    error: String,
}

/// Seconds since the epoch as a string. Not a formatted date: the board renders
/// durations, and pulling in a date crate to print something nothing parses
/// would be a dependency bought for one line of output.
fn now_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

pub(crate) fn grade_command(key: &str, cmd: &str, timeout_ms: u64) -> Command {
    let mut c = Command::new("e2b-box");
    c.arg("exec")
        .arg("--timeout-ms")
        .arg(timeout_ms.to_string())
        .arg(cmd)
        .env("KEY", key)
        // The board may be running inside a herdr pane, whose context would
        // otherwise make e2b-box resolve a DIFFERENT box than the KEY we set.
        .env_remove("HERDR_PLUGIN_CONTEXT_JSON")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

/// Grade one member. Never returns an error: every outcome — including "the
/// helper did not run at all" — is a Result_ the run can record, because a member
/// with no file is indistinguishable from one that was never started.
pub(crate) fn grade_one(b: &Box, slug: &str, cmd: &str, timeout_ms: u64) -> Result_ {
    let mut r = Result_ {
        key: b.key.clone(),
        label: label_of(&b.branch, slug),
        template: template_of(&b.branch, slug),
        branch: b.branch.clone(),
        graded_at: now_stamp(),
        ..Default::default()
    };

    let started = SystemTime::now();
    let out = match grade_command(&b.key, cmd, timeout_ms).output() {
        Ok(o) => o,
        Err(e) => {
            r.verdict = Verdict::Error;
            r.error = format!("could not run e2b-box exec: {e}");
            return r;
        }
    };
    r.ms = started.elapsed().map(|d| d.as_millis() as u64).unwrap_or(0);

    let text = String::from_utf8_lossy(&out.stdout);
    let parsed: ExecOut = match serde_json::from_str(text.trim()) {
        Ok(p) => p,
        Err(_) => {
            // exec.js promises one JSON object on stdout. Anything else means it
            // never got far enough to print one — a missing node, an unresolvable
            // e2b-box. Keep what it did say; guessing a verdict would be worse.
            r.verdict = Verdict::Error;
            r.error = format!(
                "unparseable output from e2b-box exec: {}",
                tail_lines(String::from_utf8_lossy(&out.stderr).trim(), 3)
            );
            return r;
        }
    };

    r.verdict = Verdict::from_exec(parsed.ok, parsed.exit_code);
    r.exit_code = parsed.exit_code;
    r.stdout = tail_lines(&parsed.stdout, TAIL);
    r.stderr = tail_lines(&parsed.stderr, TAIL);
    r.error = parsed.error;
    r
}

/// Grade every member at once. A suite takes minutes and the members are
/// independent, so N members cost roughly what one does — the same reason
/// `e2b-fleet` provisions concurrently.
///
/// `on_done` is called from the grading thread as each member finishes, so the
/// caller can persist a result the moment it exists rather than at the end. A
/// run interrupted halfway then still has the results it earned.
pub(crate) fn grade_all<F>(
    members: &[&Box],
    slug: &str,
    cmd: &str,
    timeout_ms: u64,
    on_done: F,
) -> Vec<Result_>
where
    F: Fn(&Result_) + Sync,
{
    std::thread::scope(|scope| {
        let handles: Vec<_> = members
            .iter()
            .map(|b| {
                let on_done = &on_done;
                scope.spawn(move || {
                    let r = grade_one(b, slug, cmd, timeout_ms);
                    on_done(&r);
                    r
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grade_command_addresses_the_box_by_key_and_bounds_itself() {
        let c = grade_command("mybox", "npm test", 1234);
        let argv: Vec<String> = c
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(c.get_program().to_string_lossy(), "e2b-box");
        assert_eq!(argv, vec!["exec", "--timeout-ms", "1234", "npm test"]);
        // The command is ONE argv element — quoting it here and letting the box's
        // shell split it keeps `cd x && npm test` working.
        assert_eq!(argv.len(), 4);
        let env: Vec<_> = c.get_envs().collect();
        assert!(env
            .iter()
            .any(|(k, v)| *k == "KEY" && v.map(|v| v == "mybox").unwrap_or(false)));
        // A stale pane context would silently redirect the grade to another box.
        assert!(env
            .iter()
            .any(|(k, v)| *k == "HERDR_PLUGIN_CONTEXT_JSON" && v.is_none()));
    }
}
