use ratatui::{
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::tui::state::MessageLine;
use crate::tui::theme;

/// Build styled lines for the logs buffer.
///
/// Log output uses full terminal width (no nick gutter) for maximum
/// density.  Each `MessageLine` in the buffer represents one log line
/// from the node.
pub fn build_lines(messages: &[MessageLine], max_width: usize) -> Vec<Line<'static>> {
    if messages.is_empty() {
        return vec![Line::from(Span::styled(
            " No logs loaded. Use /logs [nodeId] [lines] to fetch.",
            theme::style_dim(),
        ))];
    }

    let mut lines = Vec::with_capacity(messages.len());
    let dim = theme::style_dim();

    for msg in messages {
        let style = match msg.role {
            crate::tui::state::MessageRole::Error => theme::style_error(),
            crate::tui::state::MessageRole::System => dim,
            _ => Style::default(),
        };

        // Word-wrap to terminal width.
        for wrapped in wrap_plain(&msg.text, max_width) {
            lines.push(Line::from(Span::styled(wrapped, style)));
        }
    }

    lines
}

/// Simple word-wrap for plain text (no gutter overhead).
fn wrap_plain(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return vec![text.to_string()];
    }

    let mut result = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            result.push(String::new());
            continue;
        }
        // For log lines, preserve leading whitespace and just hard-break
        // at max_width so structured output (tables, indentation) stays intact.
        let mut remaining = line;
        while remaining.len() > max_width {
            result.push(remaining[..max_width].to_string());
            remaining = &remaining[max_width..];
        }
        result.push(remaining.to_string());
    }
    if result.is_empty() {
        result.push(String::new());
    }
    result
}

/// Render log lines into a Paragraph.
pub fn render(lines: Vec<Line<'static>>, scroll: u16) -> Paragraph<'static> {
    Paragraph::new(lines).scroll((scroll, 0))
}
