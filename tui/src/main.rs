// herdr-e2b dashboard — a live Ratatui board of every tracked E2B sandbox.
// Reads the sandbox JSON records, renders an auto-refreshing table, and runs
// e2b-box actions against EACH SANDBOX'S OWN worktreePath (shown in the UI), with
// a confirm gate on the ones that overwrite or destroy. Single static binary.
//
// Theming: defaults to the TERMINAL's own palette (so it inherits whatever theme
// your terminal / herdr uses). Cycle live with `T`, or seed a start theme with
// E2B_DASH_THEME (or "auto" = terminal):
//   terminal (default) | solarized-light | tokyo-night | dracula | nord | gruvbox
//
//   cargo run --release -- [boxes_dir]
mod actions;
mod state;
mod theme;

use std::{
    path::PathBuf,
    process::{Command, Output},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, MouseButton, MouseEventKind,
};
use ratatui::{
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, TableState},
    Frame,
};

use actions::{action_command, goto_worktree, key_only, Verb};
use state::{
    branch_cell, branch_column_width, current_domain, load_boxes, plugin_version, probe_domain,
    region_label, sh, state_dir, status_detail, template_cell, template_downgraded, Box,
    TEMPLATE_W,
};
use theme::{initial_theme_idx, save_theme, status_glyph_color, theme_from, Theme, THEMES};

struct App {
    dir: PathBuf,
    theme: Theme,
    theme_idx: usize,
    boxes: Vec<Box>,
    state: TableState,
    msg: String,
    pending: Option<Verb>,
    run: Option<(String, String, &'static str, String)>, // (label, key, verb, worktree)
    post_open: Option<(String, String, String)>, // after a shell exits: (label, key, worktree)
    domain: String,                              // cluster shown in the header
    domain_checked: Instant,                     // last re-ask (see probe_domain)
    version: Option<String>,                     // plugin version for the header
    table_area: Rect, // where draw() last put the table (mouse hit-testing)
    branch_w: u16,    // BRANCH column width draw() last used (0 = dropped)
}

impl App {
    fn reload(&mut self) {
        self.boxes = load_boxes(&self.dir);
        if self.boxes.is_empty() {
            self.state.select(None);
        } else {
            let sel = self.state.selected().unwrap_or(0);
            self.state.select(Some(sel.min(self.boxes.len() - 1)));
        }
    }
    fn move_by(&mut self, d: isize) {
        if self.boxes.is_empty() {
            return;
        }
        let n = self.boxes.len() as isize;
        let cur = self.state.selected().unwrap_or(0) as isize;
        self.state.select(Some(((cur + d).rem_euclid(n)) as usize));
    }
    fn sel(&self) -> Option<&Box> {
        self.state.selected().and_then(|i| self.boxes.get(i))
    }
    fn arm(&mut self, v: Verb) {
        if self
            .sel()
            .is_some_and(|b| !b.worktree_path.is_empty() || matches!(v, Verb::Kill))
        {
            self.pending = Some(v);
        }
    }
    /// Which data row (index into `boxes`) a terminal cell lands on, if any.
    /// Row 0 sits below the table's top border, header row, and header margin.
    fn row_at(&self, x: u16, y: u16) -> Option<usize> {
        let a = self.table_area;
        let top = a.y + 3; // border + header + bottom_margin
        if a.width < 2 || x <= a.x || x >= a.x + a.width - 1 || y < top || y + 1 >= a.y + a.height {
            return None;
        }
        let i = self.state.offset() + (y - top) as usize;
        (i < self.boxes.len()).then_some(i)
    }
    /// The SANDBOX column's x range: border(1) + "▸ "(2) + NAME(18)+gap +
    /// BRANCH(+gap, when the pane was wide enough for one) + TEMPLATE+gap.
    /// Keep in sync with the `widths` array in draw().
    fn sandbox_col(&self, x: u16) -> bool {
        let branch = if self.branch_w > 0 {
            self.branch_w + 1
        } else {
            0
        };
        let start = self.table_area.x + 1 + 2 + 18 + 1 + branch + TEMPLATE_W + 1;
        x >= start && x < start + 22
    }
    /// `z`: pause a live box (stops its billing clock; files AND memory are
    /// snapshotted) or resume a paused one — same sandbox id either way. No
    /// confirm gate: neither direction destroys anything. A provisioning/failed
    /// box has nothing to toggle.
    fn pause_or_resume(&mut self) {
        let Some((label, key, status)) = self
            .sel()
            .map(|b| (b.label.clone(), b.key.clone(), b.status.clone()))
        else {
            return;
        };
        match status.as_str() {
            "paused" => self.run = Some((label, key, "resume", String::new())),
            "ready" => self.run = Some((label, key, "pause", String::new())),
            "" => self.msg = format!("{label}: no sandbox to pause"),
            s => self.msg = format!("{label}: can't pause a '{s}' box"),
        }
    }
    fn copy_selected_id(&mut self) {
        match self.sel() {
            Some(b) if !b.sandbox_id.is_empty() => self.msg = copy_to_clipboard(&b.sandbox_id),
            Some(_) => self.msg = "no sandbox id yet".into(),
            None => {}
        }
    }
}

/// Put `text` on the system clipboard. A native tool first (survives terminals
/// that filter escape sequences), then OSC 52 — asking the terminal itself to
/// set the clipboard — which is what works over ssh and inside multiplexers
/// that pass it through.
fn copy_to_clipboard(text: &str) -> String {
    use std::io::Write;
    let tools: &[(&str, &[&str])] = &[
        ("pbcopy", &[]),
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("clip.exe", &[]),
    ];
    for (cmd, args) in tools {
        let child = Command::new(cmd)
            .args(*args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            let wrote = child
                .stdin
                .take()
                .is_some_and(|mut s| s.write_all(text.as_bytes()).is_ok());
            if wrote && child.wait().is_ok_and(|st| st.success()) {
                return format!("copied {text}");
            }
        }
    }
    let mut out = std::io::stdout();
    let _ = write!(out, "\x1b]52;c;{}\x07", b64(text.as_bytes()));
    let _ = out.flush();
    format!("copied {text} (OSC 52)")
}

/// Minimal base64 (standard alphabet, padded) — only OSC 52 needs it, not worth a crate.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).copied().as_ref().unwrap_or(&0),
            *chunk.get(2).copied().as_ref().unwrap_or(&0),
        ];
        let n = u32::from_be_bytes([0, b[0], b[1], b[2]]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

struct ActionDone {
    label: String,
    verb: &'static str,
    output: std::io::Result<Output>,
}

fn last_output_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_owned())
}

fn draw(f: &mut Frame, app: &mut App) {
    let t = &app.theme;
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(3),
        Constraint::Length(3),
    ])
    .split(f.area());

    // Header: title + REGION on the left, the VERSION and theme right-aligned on
    // the SAME line. The region is the load-bearing half — it says where a box
    // opened from here would land — so it sits beside the title and never gives
    // way; the title gives up detail first, and the right-hand pair sheds items
    // on a pane too narrow for all of it. Widths are counted in chars (all of it
    // is ASCII plus `·`/`⚠`, one cell each in a terminal font).
    //
    // The right side drops theme before version. Both are context rather than
    // live state, but the version answers "is the thing I am looking at the thing
    // I just built?" — the question that actually gets asked of a plugin loaded
    // from a working tree — while the theme is visible in every colour on screen
    // and so is the cheapest thing to lose.
    //
    // Region, not the host: `eu` is what you asked for, `e2b-juliett.dev` is how
    // it happens to be served, and the resolver already speaks in regions.
    let domain = app.domain.clone();
    // A box created on another cluster can't be reached from this one, so flag a
    // mixed list rather than implying the header's region holds all of them.
    let mixed = app
        .boxes
        .iter()
        .any(|b| !b.domain.is_empty() && b.domain != domain);
    let region = region_label(&domain);

    let n = app.boxes.len();
    let theme_name = THEMES[app.theme_idx];
    let width = chunks[0].width as usize;
    let theme_txt = format!("theme: {theme_name}");
    // `v` prefixed so a bare number can't read as a count of something.
    let ver_txt = app
        .version
        .as_deref()
        .map(|v| format!("v{v}"))
        .unwrap_or_default();
    // Richest first; the search below takes the first that fits, so the pane keeps
    // as much of the pair as it can afford. Two trailing spaces hold it off the edge.
    let tails: Vec<String> = if ver_txt.is_empty() {
        vec![format!("{theme_txt}  "), String::new()]
    } else {
        vec![
            format!("{ver_txt} · {theme_txt}  "),
            format!("{ver_txt}  "),
            String::new(),
        ]
    };
    // What the region costs on the left, mark included — it is never dropped, so
    // every title candidate has to be measured against it.
    let region_len = "region ".chars().count() + region.chars().count() + if mixed { 2 } else { 0 };
    // Widest title that still leaves room for the region, in order of preference;
    // the last one is region-only, for a pane that can afford nothing else.
    let titles = [
        format!("  herdr-e2b-sandbox · {n} sandboxes · "),
        "  herdr-e2b-sandbox · ".to_string(),
        "  e2b · ".to_string(),
        "  ".to_string(),
    ];
    let fits = |title: &String, tail: usize| title.chars().count() + region_len + tail < width;
    // Prefer keeping the right-hand pair; give it up before shortening the title
    // further, because a pane wide enough for the full title reads better with it
    // than with a truncated title and a version.
    let (tail_idx, title) = tails
        .iter()
        .enumerate()
        .find_map(|(i, tail)| {
            titles
                .iter()
                .find(|s| fits(s, tail.chars().count()))
                .map(|s| (i, s.clone()))
        })
        .unwrap_or((tails.len() - 1, String::new()));
    // Which of the pair survived. Derived from the chosen candidate rather than
    // re-measured, so the spans below cannot disagree with what was budgeted for.
    let show_theme = tail_idx == 0;
    let show_ver = !ver_txt.is_empty() && tail_idx <= 1;

    let mut spans = vec![
        title.fg(t.accent).add_modifier(Modifier::BOLD),
        "region ".fg(t.dim),
        region.clone().fg(t.accent).add_modifier(Modifier::BOLD),
    ];
    if mixed {
        spans.push(" ⚠".fg(t.paused));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), chunks[0]);
    if show_ver || show_theme {
        let mut right_spans: Vec<Span> = Vec::new();
        if show_ver {
            right_spans.push(ver_txt.clone().fg(t.accent).add_modifier(Modifier::BOLD));
        }
        if show_ver && show_theme {
            right_spans.push(" · ".fg(t.dim));
        }
        if show_theme {
            right_spans.push("theme: ".fg(t.dim));
            right_spans.push(theme_name.fg(t.accent).add_modifier(Modifier::BOLD));
        }
        right_spans.push("  ".into());
        f.render_widget(
            Paragraph::new(Line::from(right_spans)).alignment(Alignment::Right),
            chunks[0],
        );
    }

    // BRANCH: which branch each box's worktree is on. Folder names alone stop
    // being readable once several related worktrees are tracked. On a pane too
    // narrow to afford the column it is dropped entirely (width 0) rather than
    // squeezed — see branch_column_width.
    let branch_w = branch_column_width(chunks[1].width);
    app.branch_w = branch_w;

    let mut titles = vec!["NAME"];
    if branch_w > 0 {
        titles.push("BRANCH");
    }
    // STATUS is LAST and elastic: it absorbed the old STEP column, which said
    // "ready" beside a "ready" status and only ever carried anything new while a
    // box was provisioning or had failed.
    titles.extend(["TEMPLATE", "SANDBOX", "FILES", "STATUS"]);
    let header = Row::new(titles)
        .style(Style::default().fg(t.accent).add_modifier(Modifier::BOLD))
        .bottom_margin(1);

    let rows: Vec<Row> = app
        .boxes
        .iter()
        .map(|b| {
            let (dot, col) = status_glyph_color(t, &b.status);
            // The step is the only part of the old STEP column worth its width:
            // "uploading 210/540 files" while provisioning, "provision failed ·
            // see logs" after a failure. A step that merely repeats the status is
            // dropped rather than printed twice.
            let mut status = vec![format!("{dot} ").fg(col), b.status.clone().into()];
            if let Some(detail) = status_detail(&b.status, &b.step) {
                status.push(format!(" · {detail}").fg(t.dim));
            }
            let status = Line::from(status);
            let sid = b.sandbox_id.clone();
            let files = if b.files > 0 {
                b.files.to_string()
            } else {
                "—".into()
            };
            // TEMPLATE: which image the box runs — the fact that says whether
            // the agent you wanted is even installed in there. Amber when the
            // requested template wasn't available and `base` booted instead.
            let downgraded = template_downgraded(&b.template, &b.requested_template);
            let template = Cell::from(template_cell(
                &b.template,
                &b.requested_template,
                TEMPLATE_W,
            ))
            .fg(if downgraded { t.paused } else { t.dim });
            let mut cells = vec![Cell::from(b.label.clone())];
            if branch_w > 0 {
                cells.push(Cell::from(branch_cell(&b.branch, branch_w)).fg(t.dim));
            }
            cells.extend([
                template,
                Cell::from(sid),
                Cell::from(files),
                Cell::from(status),
            ]);
            Row::new(cells)
        })
        .collect();

    let mut widths = vec![Constraint::Length(18)];
    if branch_w > 0 {
        widths.push(Constraint::Length(branch_w));
    }
    widths.extend([
        Constraint::Length(TEMPLATE_W),
        // Full E2B sandbox id (~21 chars) — truncating it made rows useless for
        // `e2b sandbox connect <id>` / dashboard lookups.
        Constraint::Length(22),
        Constraint::Length(6),
        // STATUS takes the rest: it is the one cell whose text grows (the
        // provisioning step rides along in it).
        Constraint::Min(20),
    ]);
    let table = Table::new(rows, widths)
        .header(header)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(t.border)),
        )
        .row_highlight_style(t.sel)
        .highlight_symbol("▸ ");
    app.table_area = chunks[1]; // remembered for mouse hit-testing
    f.render_stateful_widget(table, chunks[1], &mut app.state);

    let target = app
        .sel()
        .map(|b| {
            let wt = if b.worktree_path.is_empty() {
                "—".into()
            } else {
                b.worktree_path.clone()
            };
            format!("  target: {wt}")
        })
        .unwrap_or_default();
    let target_line = Line::from(target).style(Style::default().fg(t.dim));

    let mid = if let Some((label, _, _)) = &app.post_open {
        // A paused box is the common way OUT of the shell now (the sandbox went
        // away under it), so lead with the way back in rather than pull/kill.
        let line = if app.sel().is_some_and(|b| b.status == "paused") {
            format!("  '{label}' paused — [o] resume & reattach · [p]ull changes down · [k]ill it · [L]eave paused")
        } else {
            format!("  left '{label}' — [o] reattach · [p]ull changes down · [k]ill it · [L]eave running")
        };
        Line::from(line).style(t.confirm)
    } else if let Some(v) = app.pending {
        let b = app.sel();
        let label = b.map(|b| b.label.as_str()).unwrap_or("");
        let wt = b.map(|b| b.worktree_path.as_str()).unwrap_or("");
        Line::from(format!("  {}", v.confirm(label, wt))).style(t.confirm)
    } else {
        // `z` is a toggle, so name the direction it would take FOR THE SELECTED
        // ROW rather than spending footer width on "pause/resume".
        let z = if app.sel().is_some_and(|b| b.status == "paused") {
            "z resume"
        } else {
            "z pause"
        };
        Line::from(format!("  ↑/↓ move · ↵ open · w worktree · s sync · p pull · {z} · x kill · c copy id · r refresh · T theme · q quit"))
            .style(Style::default().fg(t.dim))
    };
    let msg = Line::from(format!("  {}", app.msg)).style(Style::default().fg(t.paused));
    f.render_widget(Paragraph::new(vec![target_line, mid, msg]), chunks[2]);
}

fn main() -> std::io::Result<()> {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| state_dir().join("boxes"));

    let idx = initial_theme_idx();
    let mut app = App {
        dir,
        theme: theme_from(THEMES[idx]),
        theme_idx: idx,
        boxes: vec![],
        state: TableState::default(),
        msg: String::new(),
        pending: None,
        run: None,
        post_open: None,
        domain: String::new(),
        domain_checked: Instant::now(),
        // Read once: the manifest cannot change under a running dashboard without
        // the plugin being reloaded, which restarts this process anyway.
        version: plugin_version(),
        table_area: Rect::default(),
        branch_w: 0,
    };
    app.reload();
    app.domain = probe_domain().unwrap_or_else(|| current_domain(&app.boxes));
    if !app.boxes.is_empty() {
        app.state.select(Some(0));
    }

    let (action_tx, action_rx) = mpsc::channel::<ActionDone>();
    let mut terminal = ratatui::init();
    // Mouse: click selects a row, a click on the SANDBOX cell copies the id,
    // wheel scrolls. (Terminal-native text selection needs shift+drag while
    // capture is on — the click-to-copy is the replacement for the common case.)
    let _ = crossterm::execute!(std::io::stdout(), EnableMouseCapture);
    let mut last = Instant::now();
    let res = loop {
        while let Ok(done) = action_rx.try_recv() {
            app.msg = match done.output {
                Ok(output) if output.status.success() => {
                    let detail = last_output_line(&output.stdout)
                        .map(|line| format!(" · {line}"))
                        .unwrap_or_default();
                    format!("{} done · {}{detail}", done.verb, done.label)
                }
                Ok(output) => {
                    let bytes = if output.stderr.is_empty() {
                        &output.stdout
                    } else {
                        &output.stderr
                    };
                    let detail = last_output_line(bytes)
                        .map(|line| format!(" · {line}"))
                        .unwrap_or_default();
                    format!("{} failed · {}{detail}", done.verb, done.label)
                }
                Err(error) => format!("{} failed · {} · {error}", done.verb, done.label),
            };
            app.reload();
        }
        if let Err(e) = terminal.draw(|f| draw(f, &mut app)) {
            break Err(e);
        }

        if let Some((label, key, verb, wt)) = app.run.take() {
            // kill/status/pause/resume target the box by KEY (no worktree needed).
            // Everything else operates ON the worktree, so it MUST exist — never
            // fall back to the current dir (that would provision/sync the wrong folder).
            if !key_only(verb) && (wt.is_empty() || !std::path::Path::new(&wt).is_dir()) {
                app.msg = format!("skipped {verb}: worktree not found ({wt})");
                continue; // stay in the TUI, run nothing
            }

            // `open` is the interactive one: run INLINE (hand this pane's terminal
            // to the box shell), quiet e2b-box with E2B_DASH=1, and offer
            // pull/kill/leave when the shell exits. `unset HERDR_PLUGIN_CONTEXT_JSON`
            // stops e2b-box cd-ing to the dashboard pane's context; KEY pins the
            // box; sh() single-quotes every value so odd paths can't break out.
            if verb == "open" {
                // Hand the pane to the sandbox shell — mouse capture must go
                // with it, or the shell receives mouse escape garbage.
                let _ = crossterm::execute!(std::io::stdout(), DisableMouseCapture);
                ratatui::restore();
                let script = format!(
                    "unset HERDR_PLUGIN_CONTEXT_JSON; cd {} && KEY={} E2B_DASH=1 e2b-box open",
                    sh(&wt),
                    sh(&key),
                );
                let _ = Command::new("bash")
                    .arg("-lc")
                    .arg(&script)
                    .env_remove("HERDR_PLUGIN_CONTEXT_JSON")
                    .status();
                terminal = ratatui::init();
                let _ = crossterm::execute!(std::io::stdout(), EnableMouseCapture);
                app.post_open = Some((label, key, wt));
                app.reload();
                continue;
            }

            let tx = action_tx.clone();
            let result_label = label.clone();
            thread::spawn(move || {
                let output = action_command(verb, &key, &wt).output();
                let _ = tx.send(ActionDone {
                    label: result_label,
                    verb,
                    output,
                });
            });
            app.msg = format!("{verb} running · {label}");
            continue;
        }

        if event::poll(Duration::from_millis(250))? {
            match event::read()? {
                // Mouse is navigation + copy only — never a confirm. While a
                // pending confirm or the post-open prompt is up, ignore it so a
                // stray click can't answer a destructive question.
                Event::Mouse(m) if app.pending.is_none() && app.post_open.is_none() => {
                    match m.kind {
                        MouseEventKind::ScrollDown => app.move_by(1),
                        MouseEventKind::ScrollUp => app.move_by(-1),
                        MouseEventKind::Down(MouseButton::Left) => {
                            if let Some(i) = app.row_at(m.column, m.row) {
                                app.state.select(Some(i));
                                if app.sandbox_col(m.column) {
                                    app.copy_selected_id();
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Event::Key(k) => {
                    // Post-open: after the box shell exits, offer pull / kill / leave.
                    if let Some((label, key, wt)) = app.post_open.take() {
                        match k.code {
                            KeyCode::Char('p') | KeyCode::Char('P') => {
                                app.run = Some((label, key, "pull", wt));
                            }
                            KeyCode::Char('k') | KeyCode::Char('K') => {
                                app.run = Some((label, key, "kill", wt));
                            }
                            // Go back in. `open` resumes a paused box on the way and
                            // attaches a shell through the plugin's terminal client.
                            KeyCode::Char('o') | KeyCode::Char('O') | KeyCode::Char('z') => {
                                app.run = Some((label, key, "open", wt));
                            }
                            _ => app.msg = format!("left '{label}' running"),
                        }
                        continue;
                    }
                    if let Some(v) = app.pending {
                        match k.code {
                            KeyCode::Char('y') | KeyCode::Char('Y') => {
                                if let Some(b) = app.sel() {
                                    app.run = Some((
                                        b.label.clone(),
                                        b.key.clone(),
                                        v.cmd(),
                                        b.worktree_path.clone(),
                                    ));
                                }
                                app.pending = None;
                            }
                            _ => {
                                app.pending = None;
                                app.msg = "cancelled".into();
                            }
                        }
                        continue;
                    }
                    match k.code {
                        KeyCode::Char('q') | KeyCode::Esc => break Ok(()),
                        KeyCode::Char('r') => {
                            app.reload();
                            app.msg = "refreshed".into();
                        }
                        KeyCode::Char('t') | KeyCode::Char('T') => {
                            app.theme_idx = (app.theme_idx + 1) % THEMES.len();
                            app.theme = theme_from(THEMES[app.theme_idx]);
                            save_theme(THEMES[app.theme_idx]); // remember across runs
                            app.msg = format!("theme: {} (saved)", THEMES[app.theme_idx]);
                        }
                        KeyCode::Down | KeyCode::Char('j') => app.move_by(1),
                        KeyCode::Up | KeyCode::Char('k') => app.move_by(-1),
                        KeyCode::Char('s') => app.arm(Verb::Sync),
                        KeyCode::Char('p') => app.arm(Verb::Pull),
                        KeyCode::Char('x') => app.arm(Verb::Kill),
                        KeyCode::Char('c') => app.copy_selected_id(),
                        KeyCode::Char('z') => app.pause_or_resume(),
                        // Enter is the row's PRIMARY action, and on a board of
                        // sandboxes that's "open this one". Jumping to the local
                        // worktree lives on `w`: it's the rarer move, and it reads as
                        // a no-op whenever the board is already zoomed over that very
                        // worktree's pane — which is the common case.
                        KeyCode::Char('o') | KeyCode::Enter => {
                            if let Some(b) = app.sel() {
                                app.run = Some((
                                    b.label.clone(),
                                    b.key.clone(),
                                    "open",
                                    b.worktree_path.clone(),
                                ));
                            }
                        }
                        KeyCode::Char('w') => {
                            if let Some(b) = app.sel() {
                                let (label, wt) = (b.label.clone(), b.worktree_path.clone());
                                app.msg = goto_worktree(&label, &wt);
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        if last.elapsed() >= Duration::from_secs(2) {
            app.reload();
            last = Instant::now();
        }
        if app.domain_checked.elapsed() >= Duration::from_secs(10) {
            if let Some(d) = probe_domain() {
                app.domain = d;
            }
            app.domain_checked = Instant::now();
        }
    };
    let _ = crossterm::execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::restore();
    res
}
