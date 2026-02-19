use ratatui::style::{Color, Modifier, Style};

// ── Layout ──────────────────────────────────────────────────────────────────
//
// Weechat-style: single-line title bar, chat area, single-line status bar,
// single-line input.  Total chrome = 3 lines, everything else is chat.

pub const TITLE_HEIGHT: u16 = 1;
pub const STATUS_HEIGHT: u16 = 1;
pub const INPUT_HEIGHT: u16 = 1;
pub const MIN_CHAT_HEIGHT: u16 = 1;

// ── Chat gutter ─────────────────────────────────────────────────────────────
//
// Format:  "  you │ message text"
//          "      │ continuation"
//
// NICK_WIDTH(5) + " │ "(3) = GUTTER_WIDTH(8)

pub const NICK_WIDTH: usize = 5;
pub const GUTTER_WIDTH: usize = 8; // NICK_WIDTH + " │ "
pub const GUTTER_MIN_TEXT: usize = 10; // below this, drop the gutter

// ── Timing ──────────────────────────────────────────────────────────────────

pub const TICK_MS: u64 = 80;
pub const CONNECTION_TIMEOUT_SECS: u64 = 120;
pub const CROSSTERM_POLL_MS: u64 = 50;
pub const SYSTEM_POLL_INTERVAL_SECS: u64 = 30;

// ── Limits ──────────────────────────────────────────────────────────────────

pub const MAX_INPUT_HISTORY: usize = 200;
pub const HISTORY_LOAD_LIMIT: i64 = 200;
pub const CHAT_SCROLL_PAGE_SIZE: usize = 8;
pub const TOOL_RESULT_TRUNCATE_LINES: usize = 3;

// ── Spinner frames ──────────────────────────────────────────────────────────

pub const SPINNER: &[&str] = &["⠋", "⠙", "⠸", "⠴", "⠦", "⠇", "⠏", "⠶"];

// ── Sentinel ────────────────────────────────────────────────────────────────

pub const RUN_DEFAULT_ID: &str = "__gsv_client_default__";

// ── Colors ──────────────────────────────────────────────────────────────────

pub const COLOR_USER: Color = Color::Cyan;
pub const COLOR_ASSISTANT: Color = Color::Green;
pub const COLOR_SYSTEM: Color = Color::DarkGray;
pub const COLOR_ERROR: Color = Color::Red;
pub const COLOR_TOOL: Color = Color::Yellow;
pub const COLOR_DIM: Color = Color::DarkGray;
pub const COLOR_SEPARATOR: Color = Color::DarkGray;

// Bar colors (weechat-style colored background bars)
pub const COLOR_BAR_FG: Color = Color::White;
pub const COLOR_BAR_BG: Color = Color::Blue;
pub const COLOR_BAR_ACCENT: Color = Color::Cyan;

// ── Styles ──────────────────────────────────────────────────────────────────

pub fn style_user() -> Style {
    Style::default().fg(COLOR_USER).add_modifier(Modifier::BOLD)
}

pub fn style_assistant() -> Style {
    Style::default()
        .fg(COLOR_ASSISTANT)
        .add_modifier(Modifier::BOLD)
}

pub fn style_system() -> Style {
    Style::default().fg(COLOR_SYSTEM)
}

pub fn style_error() -> Style {
    Style::default()
        .fg(COLOR_ERROR)
        .add_modifier(Modifier::BOLD)
}

pub fn style_tool() -> Style {
    Style::default().fg(COLOR_TOOL)
}

pub fn style_dim() -> Style {
    Style::default().fg(COLOR_DIM)
}

pub fn style_separator() -> Style {
    Style::default().fg(COLOR_SEPARATOR)
}

pub fn style_bar() -> Style {
    Style::default().fg(COLOR_BAR_FG).bg(COLOR_BAR_BG)
}

pub fn style_bar_accent() -> Style {
    Style::default()
        .fg(COLOR_BAR_ACCENT)
        .bg(COLOR_BAR_BG)
        .add_modifier(Modifier::BOLD)
}
