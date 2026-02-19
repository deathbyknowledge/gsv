use ratatui::{
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::tui::state::AppState;
use crate::tui::theme;

/// Single-line status bar (weechat style, colored background).
pub fn render(app: &AppState, width: u16) -> Paragraph<'static> {
    let left = format!(" {}", app.status_line());
    let right = format!(
        " tools:{} │ /help /quit  PgUp/Dn ",
        app.tool_verbosity.label()
    );
    let gap = (width as usize).saturating_sub(left.len() + right.len());

    Paragraph::new(Line::from(vec![
        Span::styled(left, theme::style_bar()),
        Span::styled(" ".repeat(gap), theme::style_bar()),
        Span::styled(right.to_string(), theme::style_bar()),
    ]))
}
