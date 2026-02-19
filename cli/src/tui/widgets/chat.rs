use ratatui::{
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::tui::markdown;
use crate::tui::state::{MessageLine, MessageRole};
use crate::tui::theme;

/// Build styled lines for the chat pane, pre-wrapped to `max_width`.
///
/// Each returned `Line` maps to exactly one visual terminal row.
/// This means `lines.len()` is the true visual height, so scroll
/// arithmetic is always correct -- no mismatch with ratatui's Wrap.
pub fn build_lines(messages: &[MessageLine], max_width: usize) -> Vec<Line<'static>> {
    if messages.is_empty() {
        return vec![Line::from(Span::styled(
            " No messages yet. Type /help to get started.",
            theme::style_dim(),
        ))];
    }

    // If terminal is too narrow for the gutter, fall back to compact mode.
    if max_width < theme::GUTTER_WIDTH + theme::GUTTER_MIN_TEXT {
        return build_lines_narrow(messages, max_width);
    }

    let text_width = max_width - theme::GUTTER_WIDTH;
    let mut lines = Vec::with_capacity(messages.len() * 3);
    let sep_style = theme::style_separator();

    for message in messages {
        let nick = format!(
            "{:>width$}",
            message.role.label(),
            width = theme::NICK_WIDTH
        );
        let nick_style = message.role.style();

        // Assistant messages get markdown rendering; everything else is plain.
        let styled_lines: Vec<Vec<Span<'static>>> = if message.role == MessageRole::Assistant {
            markdown::render_markdown(&message.text, text_width)
        } else {
            let text_style = text_style_for(message.role);
            wrap_text(&message.text, text_width)
                .into_iter()
                .map(|s| vec![Span::styled(s, text_style)])
                .collect()
        };

        for (i, text_spans) in styled_lines.iter().enumerate() {
            let mut line_spans = if i == 0 {
                vec![
                    Span::styled(nick.clone(), nick_style),
                    Span::styled(" │ ", sep_style),
                ]
            } else {
                vec![
                    Span::raw(" ".repeat(theme::NICK_WIDTH)),
                    Span::styled(" │ ", sep_style),
                ]
            };
            line_spans.extend(text_spans.iter().cloned());
            lines.push(Line::from(line_spans));
        }
    }

    lines
}

/// Text color: nicks are colored, message body uses a readable default.
fn text_style_for(role: MessageRole) -> Style {
    match role {
        MessageRole::Error => theme::style_error(),
        MessageRole::System => theme::style_system(),
        MessageRole::Tool => theme::style_dim(),
        // User and assistant body text: default terminal foreground.
        MessageRole::User | MessageRole::Assistant => Style::default(),
    }
}

/// Narrow-terminal fallback (no gutter, just role prefix).
fn build_lines_narrow(messages: &[MessageLine], max_width: usize) -> Vec<Line<'static>> {
    let prefix_len = 8; // "[agent] " is the widest
    let text_width = max_width.saturating_sub(prefix_len).max(4);
    let mut lines = Vec::new();

    for message in messages {
        let label = format!("[{}] ", message.role.label());
        let style = message.role.style();
        let wrapped = wrap_text(&message.text, text_width);

        for (i, text) in wrapped.iter().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled(label.clone(), style),
                    Span::styled(text.clone(), style),
                ]));
            } else {
                lines.push(Line::from(Span::styled(
                    format!("{:width$}{}", "", text, width = label.len()),
                    style,
                )));
            }
        }
    }

    lines
}

// ── Word-wrap ───────────────────────────────────────────────────────────────

/// Word-wrap `text` to fit within `max_width` columns.
///
/// - Newlines in the source produce new wrapped segments.
/// - Words longer than `max_width` are force-broken.
/// - Returns at least one entry (possibly empty) per call.
fn wrap_text(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return vec![text.to_string()];
    }

    let mut result = Vec::new();

    for paragraph in text.split('\n') {
        if paragraph.is_empty() {
            result.push(String::new());
            continue;
        }

        let words: Vec<&str> = paragraph.split_whitespace().collect();
        if words.is_empty() {
            result.push(String::new());
            continue;
        }

        let mut cur = String::new();
        let mut cur_w: usize = 0;

        for word in &words {
            let wlen = word.len();

            if cur.is_empty() {
                if wlen > max_width {
                    force_break(word, max_width, &mut result);
                    // Remaining fragment becomes the new current line.
                    if let Some(last) = result.pop() {
                        cur = last;
                        cur_w = cur.len();
                    }
                } else {
                    cur = (*word).to_string();
                    cur_w = wlen;
                }
            } else if cur_w + 1 + wlen <= max_width {
                cur.push(' ');
                cur.push_str(word);
                cur_w += 1 + wlen;
            } else {
                result.push(cur);
                if wlen > max_width {
                    cur = String::new();
                    cur_w = 0;
                    force_break(word, max_width, &mut result);
                    if let Some(last) = result.pop() {
                        cur = last;
                        cur_w = cur.len();
                    }
                } else {
                    cur = (*word).to_string();
                    cur_w = wlen;
                }
            }
        }

        if !cur.is_empty() {
            result.push(cur);
        }
    }

    if result.is_empty() {
        result.push(String::new());
    }

    result
}

/// Break a single word that is wider than `max_width` into chunks.
fn force_break(word: &str, max_width: usize, out: &mut Vec<String>) {
    let mut remaining = word;
    while remaining.len() > max_width {
        out.push(remaining[..max_width].to_string());
        remaining = &remaining[max_width..];
    }
    if !remaining.is_empty() {
        out.push(remaining.to_string());
    }
}

// ── Render ──────────────────────────────────────────────────────────────────

/// Render pre-wrapped lines into a Paragraph. No `Wrap` -- each Line is
/// already one visual row, so scroll offset maps 1:1 to terminal rows.
pub fn render(lines: Vec<Line<'static>>, scroll: u16) -> Paragraph<'static> {
    Paragraph::new(lines).scroll((scroll, 0))
}
