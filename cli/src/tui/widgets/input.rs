use ratatui::{
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::tui::state::AppState;
use crate::tui::theme;

/// Input prefix shown before the cursor.
const PROMPT: &str = " > ";

/// Single-line input bar.
pub fn render(app: &AppState) -> Paragraph<'static> {
    Paragraph::new(Line::from(vec![
        Span::styled(PROMPT, Style::default().fg(theme::COLOR_USER)),
        Span::raw(app.input.clone()),
    ]))
}

/// Cursor X offset inside the input area (accounts for prompt width).
pub fn cursor_x(app: &AppState, area_width: u16) -> u16 {
    let pos = PROMPT.len() + app.input.len();
    pos.min(area_width.saturating_sub(1) as usize) as u16
}
