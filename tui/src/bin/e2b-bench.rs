// e2b-bench — grade a fleet and show the board.
//
//   e2b-bench <slug> --grade '<command>'   run the check in every member, print the board
//   e2b-bench <slug>                       print the board for a run already graded
//   e2b-bench                              list the runs on disk
//
// Rust owns the interface; it never calls the E2B SDK. Members come from the box
// records the node side writes, grading shells out to `e2b-box exec`, and the
// verdicts land in $STATE_DIR/bench/<slug>/ (ADR-0005).
//
// Deliberately not a TUI. A grade is a batch that finishes and leaves an
// artifact, so the natural surface is a table on stdout you can pipe, diff, and
// paste — `e2b-dash` is the live board for boxes, this is the report for a run.
// state.rs is shared with the dashboard, which uses more of it than this binary
// does — the unused half is the board's rendering helpers, not dead code.
#[path = "../bench.rs"]
mod bench;
#[path = "../grade.rs"]
mod grade;
#[allow(dead_code)]
#[path = "../state.rs"]
mod state;

use std::time::{SystemTime, UNIX_EPOCH};

use bench::{
    label_of, list_runs, load_results, load_run, members_of, run_dir_display, tally, Result_, Run,
    Verdict,
};
use state::{load_boxes, state_dir};

const DEFAULT_TIMEOUT_MS: u64 = 15 * 60 * 1000;

const USAGE: &str = "\
e2b-bench — grade every member of a fleet with one held-out command

usage
  e2b-bench                       list graded runs
  e2b-bench <slug>                show the board for a run
  e2b-bench <slug> --grade CMD    run CMD in every member, then show the board

options
  -g, --grade CMD                 the command to run in each member's box
  --timeout-ms N                  per-member bound (default 15 min)
  --json                          the board as JSON, same exit code
  -h, --help · -V, --version      print this · print the plugin version

exit code
  0   every member was measured and passed
  1   a member failed, or could not be measured";

/// Asking what a command does is not an error, so help goes to stdout and exits
/// 0 — it is the one output of this program a caller might legitimately pipe
/// into a pager. Misuse still goes to stderr and exits 2, via `usage_err`.
fn usage_ok() -> ! {
    println!("{USAGE}");
    std::process::exit(0)
}

fn usage_err() -> ! {
    eprintln!("{USAGE}");
    std::process::exit(2)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let mut slug = String::new();
    let mut cmd = String::new();
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => usage_ok(),
            "-V" | "--version" => {
                println!("herdr-e2b {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0)
            }
            "--json" => json = true,
            "--grade" | "-g" => {
                i += 1;
                match args.get(i) {
                    Some(v) if !v.is_empty() => cmd = v.clone(),
                    // A grade with no command would silently become "show the
                    // board", which looks like the run passed with zero members.
                    _ => {
                        eprintln!("e2b-bench: --grade needs a command");
                        std::process::exit(2)
                    }
                }
            }
            "--timeout-ms" => {
                i += 1;
                match args.get(i).and_then(|v| v.parse::<u64>().ok()) {
                    Some(v) if v > 0 => timeout_ms = v,
                    _ => {
                        eprintln!(
                            "e2b-bench: --timeout-ms needs a positive number of milliseconds"
                        );
                        std::process::exit(2)
                    }
                }
            }
            a if a.starts_with('-') => {
                eprintln!("e2b-bench: unknown flag {a}");
                usage_err()
            }
            a if slug.is_empty() => slug = a.to_string(),
            a => {
                eprintln!("e2b-bench: unexpected argument {a}");
                usage_err()
            }
        }
        i += 1;
    }

    if slug.is_empty() {
        print_runs();
        return;
    }

    if !cmd.is_empty() {
        run_grade(&slug, &cmd, timeout_ms);
    }
    print_board(&slug, json);
}

fn print_runs() {
    let runs = list_runs();
    if runs.is_empty() {
        println!("no graded runs yet.");
        println!("  grade one:  e2b-bench <task-slug> --grade 'npm test'");
        return;
    }
    println!(
        "graded runs in {}:",
        state_dir().join("bench").to_string_lossy()
    );
    for id in runs {
        let results = load_results(&id);
        let t = tally(&results);
        println!(
            "  {:<24} {} member(s)   {} pass · {} fail · {} error",
            id,
            results.len(),
            t.pass,
            t.fail,
            t.error
        );
    }
}

fn run_grade(slug: &str, cmd: &str, timeout_ms: u64) {
    let boxes = load_boxes(&state_dir().join("boxes"));
    let members = members_of(&boxes, slug);
    if members.is_empty() {
        // Not an empty pass. A slug that matches nothing is almost always a typo
        // or a fleet that was torn down, and reporting "0/0" would look like a
        // clean run.
        eprintln!("e2b-bench: no boxes belong to a fleet with the slug '{slug}'.");
        eprintln!(
            "  members are found by branch — `git branch --list '*{slug}-*'` should list them."
        );
        eprintln!("  boot one:  e2b-fleet {slug} --agents claude,codex");
        std::process::exit(1);
    }

    // Refuse to grade a member whose box is not up: `exec` would report the box
    // as unreachable and record an Error, which is TRUE but useless — the user
    // wanted a measurement, and the fix is to boot the box, not to read a table
    // of errors. Say so before spending a single command.
    let not_ready: Vec<&&state::Box> = members.iter().filter(|b| b.status != "ready").collect();
    if !not_ready.is_empty() {
        eprintln!(
            "e2b-bench: {} member(s) are not ready — grade would only record errors:",
            not_ready.len()
        );
        for b in &not_ready {
            eprintln!(
                "  {:<28} {}",
                label_of(&b.branch, slug),
                if b.status.is_empty() {
                    "no box"
                } else {
                    &b.status
                }
            );
        }
        eprintln!("  bring them up first (e2b-box open in the member's worktree), then re-run.");
        std::process::exit(1);
    }

    let run = Run {
        id: slug.to_string(),
        grade: cmd.to_string(),
        base: String::new(),
        task: String::new(),
        started_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default(),
    };
    if let Err(e) = bench::write_run(&run) {
        eprintln!("e2b-bench: could not write the run record: {e}");
        std::process::exit(1);
    }

    eprintln!(
        "grading {} member(s) of '{}' — {}",
        members.len(),
        slug,
        cmd
    );
    // Persist each result the moment it exists rather than at the end: a run
    // interrupted halfway keeps the verdicts it earned.
    grade::grade_all(&members, slug, cmd, timeout_ms, |r| {
        if let Err(e) = bench::write_result(slug, r) {
            eprintln!("  ! could not record {}: {e}", r.label);
        }
        eprintln!("  {:<28} {}", r.label, r.verdict.glyph());
    });
    eprintln!();
}

fn print_board(slug: &str, json: bool) {
    let results = load_results(slug);
    if results.is_empty() {
        eprintln!("e2b-bench: nothing recorded for '{slug}'.");
        eprintln!("  grade it:  e2b-bench {slug} --grade 'npm test'");
        std::process::exit(1);
    }
    let run = load_run(slug).unwrap_or_default();

    // The same board, for something that isn't a person. An orchestrator
    // comparing two fleet runs should diff structured verdicts, not regex an
    // aligned table — and the exit code below is identical either way, so
    // `--json` changes the rendering and nothing about the meaning.
    if json {
        let t = tally(&results);
        let doc = serde_json::json!({
            "run": run,
            "results": results,
            "tally": { "pass": t.pass, "fail": t.fail, "error": t.error, "total": results.len() },
        });
        println!("{}", serde_json::to_string_pretty(&doc).unwrap_or_default());
        if t.pass != results.len() {
            std::process::exit(1);
        }
        return;
    }

    println!("bench '{}'", slug);
    if !run.grade.is_empty() {
        println!("  check: {}", run.grade);
    }
    println!();
    println!(
        "  {:<26} {:<10} {:<9} {:>8}  DETAIL",
        "MEMBER", "TEMPLATE", "VERDICT", "TIME"
    );
    for r in &results {
        println!(
            "  {:<26} {:<10} {:<9} {:>8}  {}",
            r.label,
            if r.template.is_empty() {
                "—"
            } else {
                &r.template
            },
            r.verdict.glyph(),
            human_ms(r.ms),
            detail(r)
        );
    }
    println!();

    let t = tally(&results);
    // Errors are called out separately, never folded into failures: "2/4 passed"
    // means something very different when the other two never ran.
    let mut summary = format!("{}/{} passed", t.pass, results.len());
    if t.error > 0 {
        summary.push_str(&format!(
            "  ·  {} never measured (box unreachable)",
            t.error
        ));
    }
    println!("  {summary}");
    println!("  {}", run_dir_display(slug));

    // Exit code carries the headline so this composes in a script: 0 only when
    // every member was measured and every one passed.
    if t.pass != results.len() {
        std::process::exit(1);
    }
}

fn detail(r: &Result_) -> String {
    match r.verdict {
        Verdict::Pass => String::new(),
        Verdict::Error => {
            let e = if r.error.is_empty() {
                "box unreachable"
            } else {
                &r.error
            };
            first_line(e)
        }
        Verdict::Fail => {
            let code = r.exit_code.map(|c| format!("exit {c}")).unwrap_or_default();
            let last = first_line(
                &last_line(&r.stderr).unwrap_or_else(|| last_line(&r.stdout).unwrap_or_default()),
            );
            if last.is_empty() {
                code
            } else {
                format!("{code}  {last}")
            }
        }
        Verdict::Pending => String::new(),
    }
}

fn last_line(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
}

/// One line, bounded — the table has one column for this and a wrapped cell
/// destroys the alignment that makes the board readable.
fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() > 48 {
        let cut: String = line.chars().take(47).collect();
        format!("{cut}…")
    } else {
        line.to_string()
    }
}

fn human_ms(ms: u64) -> String {
    if ms == 0 {
        return "—".into();
    }
    let s = ms / 1000;
    if s < 60 {
        format!("{s}s")
    } else {
        format!("{}m{:02}s", s / 60, s % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_as_time_not_milliseconds() {
        assert_eq!(human_ms(0), "—");
        assert_eq!(human_ms(4_200), "4s");
        assert_eq!(human_ms(252_000), "4m12s");
        // The seconds part is padded so a column of times stays aligned.
        assert_eq!(human_ms(65_000), "1m05s");
    }

    #[test]
    fn detail_never_wraps_the_table() {
        let r = Result_ {
            verdict: Verdict::Fail,
            exit_code: Some(1),
            stderr: format!("{}\n", "x".repeat(300)),
            ..Default::default()
        };
        let d = detail(&r);
        assert!(
            d.chars().count() <= 56,
            "detail too wide: {}",
            d.chars().count()
        );
        assert!(!d.contains('\n'));
    }

    #[test]
    fn a_pass_says_nothing_and_an_error_says_why() {
        assert_eq!(
            detail(&Result_ {
                verdict: Verdict::Pass,
                ..Default::default()
            }),
            ""
        );
        let e = Result_ {
            verdict: Verdict::Error,
            error: "exec in sbx failed: not found".into(),
            ..Default::default()
        };
        assert!(detail(&e).contains("not found"));
        // An error with no message still explains itself rather than being blank.
        let bare = Result_ {
            verdict: Verdict::Error,
            ..Default::default()
        };
        assert_eq!(detail(&bare), "box unreachable");
    }

    #[test]
    fn a_failure_leads_with_the_exit_code_and_the_last_real_line() {
        let r = Result_ {
            verdict: Verdict::Fail,
            exit_code: Some(2),
            stderr: "warming up\n\n  3 tests failed\n\n".into(),
            ..Default::default()
        };
        let d = detail(&r);
        assert!(d.starts_with("exit 2"), "{d}");
        assert!(d.contains("3 tests failed"), "{d}");
    }
}
