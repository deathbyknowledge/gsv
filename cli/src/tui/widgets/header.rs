use ratatui::{
    style::Modifier,
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::tui::buffer::BufferId;
use crate::tui::state::AppState;
use crate::tui::theme;

/// Single-line title bar (weechat style, colored background).
pub fn render(app: &AppState, width: u16) -> Paragraph<'static> {
    let bar = theme::style_bar();
    let accent = theme::style_bar_accent();

    let mut spans = vec![Span::styled(" GSV", accent), Span::styled(" │ ", bar)];

    // Buffer tabs
    for &buf_id in BufferId::ALL {
        let idx = buf_id.index() + 1;
        let label = buf_id.label();
        let is_active = app.active_buffer == buf_id;
        let unread = if buf_id == BufferId::System {
            app.system_buffer.unread
        } else {
            0
        };

        if is_active {
            spans.push(Span::styled(
                format!("[{}:{}]", idx, label),
                accent.add_modifier(Modifier::BOLD),
            ));
        } else if unread > 0 {
            spans.push(Span::styled(format!("{}:{}", idx, label), accent));
        } else {
            spans.push(Span::styled(format!("{}:{}", idx, label), bar));
        }
        spans.push(Span::styled(" ", bar));
    }

    // System summary (right side)
    let summary = app.system.summary();
    spans.push(Span::styled(format!("│ {}", summary), bar));

    // Pad to full width
    let current_len: usize = spans.iter().map(|s| s.content.len()).sum();
    let pad = (width as usize).saturating_sub(current_len);
    spans.push(Span::styled(" ".repeat(pad), bar));

    Paragraph::new(Line::from(spans))
}
