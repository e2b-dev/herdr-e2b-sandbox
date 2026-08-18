// Dashboard theming. Defaults to the terminal's own palette (blends with any
// terminal/herdr theme); presets are cycled with `T` and persisted.
use ratatui::style::{Color, Modifier, Style};
use std::fs;

use crate::state::state_dir;

pub(crate) struct Theme {
    pub(crate) accent: Color,
    pub(crate) dim: Color,
    pub(crate) border: Color,
    pub(crate) ready: Color,
    pub(crate) paused: Color,
    pub(crate) prov: Color,
    pub(crate) failed: Color,
    pub(crate) sel: Style,     // selected-row style
    pub(crate) confirm: Style, // confirm bar style
}

fn rgb(hex: u32) -> Color {
    Color::Rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

// Cycle order for the `T` key. "terminal" (== auto) is first so it's the default.
pub(crate) const THEMES: [&str; 6] = [
    "terminal",
    "solarized-light",
    "tokyo-night",
    "dracula",
    "nord",
    "gruvbox",
];

pub(crate) fn theme_from(name: &str) -> Theme {
    match name {
        // Solarized Light — tuned for a LIGHT terminal background.
        "solarized-light" => Theme {
            accent: rgb(0x268bd2),
            dim: rgb(0x586e75),
            border: rgb(0x93a1a1),
            ready: rgb(0x859900),
            paused: rgb(0xb58900),
            prov: rgb(0x268bd2),
            failed: rgb(0xdc322f),
            sel: Style::default()
                .bg(rgb(0xeee8d5))
                .fg(rgb(0x002b36))
                .add_modifier(Modifier::BOLD),
            confirm: Style::default()
                .bg(rgb(0xb58900))
                .fg(rgb(0xfdf6e3))
                .add_modifier(Modifier::BOLD),
        },
        "tokyo-night" => Theme {
            accent: rgb(0x7aa2f7),
            dim: rgb(0x565f89),
            border: rgb(0x3b4261),
            ready: rgb(0x9ece6a),
            paused: rgb(0xe0af68),
            prov: rgb(0x7dcfff),
            failed: rgb(0xf7768e),
            sel: Style::default()
                .bg(rgb(0x283457))
                .fg(rgb(0xc0caf5))
                .add_modifier(Modifier::BOLD),
            confirm: Style::default()
                .bg(rgb(0xe0af68))
                .fg(rgb(0x1a1b26))
                .add_modifier(Modifier::BOLD),
        },
        "dracula" => Theme {
            accent: rgb(0xbd93f9),
            dim: rgb(0x6272a4),
            border: rgb(0x44475a),
            ready: rgb(0x50fa7b),
            paused: rgb(0xf1fa8c),
            prov: rgb(0x8be9fd),
            failed: rgb(0xff5555),
            sel: Style::default()
                .bg(rgb(0x44475a))
                .fg(rgb(0xf8f8f2))
                .add_modifier(Modifier::BOLD),
            confirm: Style::default()
                .bg(rgb(0xf1fa8c))
                .fg(rgb(0x282a36))
                .add_modifier(Modifier::BOLD),
        },
        "nord" => Theme {
            accent: rgb(0x88c0d0),
            dim: rgb(0x4c566a),
            border: rgb(0x434c5e),
            ready: rgb(0xa3be8c),
            paused: rgb(0xebcb8b),
            prov: rgb(0x81a1c1),
            failed: rgb(0xbf616a),
            sel: Style::default()
                .bg(rgb(0x3b4252))
                .fg(rgb(0xeceff4))
                .add_modifier(Modifier::BOLD),
            confirm: Style::default()
                .bg(rgb(0xebcb8b))
                .fg(rgb(0x2e3440))
                .add_modifier(Modifier::BOLD),
        },
        "gruvbox" => Theme {
            accent: rgb(0x83a598),
            dim: rgb(0x928374),
            border: rgb(0x504945),
            ready: rgb(0xb8bb26),
            paused: rgb(0xfabd2f),
            prov: rgb(0x83a598),
            failed: rgb(0xfb4934),
            sel: Style::default()
                .bg(rgb(0x3c3836))
                .fg(rgb(0xebdbb2))
                .add_modifier(Modifier::BOLD),
            confirm: Style::default()
                .bg(rgb(0xfabd2f))
                .fg(rgb(0x282828))
                .add_modifier(Modifier::BOLD),
        },
        // "terminal" (default): the terminal's OWN 16-color palette via named ANSI
        // colors + a REVERSED selection — blends with any terminal theme.
        _ => Theme {
            accent: Color::Cyan,
            dim: Color::DarkGray,
            border: Color::Blue,
            ready: Color::Green,
            paused: Color::Yellow,
            prov: Color::Cyan,
            failed: Color::Red,
            sel: Style::default().add_modifier(Modifier::REVERSED | Modifier::BOLD),
            confirm: Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        },
    }
}

pub(crate) fn status_glyph_color(theme: &Theme, s: &str) -> (&'static str, Color) {
    match s {
        "ready" => ("●", theme.ready),
        "paused" => ("●", theme.paused),
        "provisioning" => ("◐", theme.prov),
        "failed" => ("●", theme.failed),
        _ => ("○", theme.dim),
    }
}

fn theme_file() -> std::path::PathBuf {
    state_dir().join("dashboard-theme")
}

pub(crate) fn save_theme(name: &str) {
    let p = theme_file();
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(p, name);
}

/// Starting theme: a saved `T` choice wins (so it persists), else the
/// E2B_DASH_THEME seed ("auto" -> terminal), else default (terminal).
pub(crate) fn initial_theme_idx() -> usize {
    if let Ok(s) = fs::read_to_string(theme_file()) {
        if let Some(i) = THEMES.iter().position(|&t| t == s.trim()) {
            return i;
        }
    }
    let mut want = std::env::var("E2B_DASH_THEME").unwrap_or_default();
    if want == "auto" {
        want = "terminal".into();
    }
    THEMES.iter().position(|&t| t == want).unwrap_or(0)
}
