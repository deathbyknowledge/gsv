use ratatui::{
    style::Style,
    text::{Line, Span},
    widgets::Paragraph,
};

use crate::tui::state::AppState;
use crate::tui::theme;

/// Build styled lines for the system buffer.
pub fn build_lines(app: &AppState, max_width: usize) -> Vec<Line<'static>> {
    let text_width = if max_width > theme::GUTTER_WIDTH + theme::GUTTER_MIN_TEXT {
        max_width - theme::GUTTER_WIDTH
    } else {
        max_width
    };
    let _ = text_width; // used for future wrapping

    let sep_style = theme::style_separator();
    let dim = theme::style_dim();
    let mut lines: Vec<Line<'static>> = Vec::new();

    // ── Nodes ───────────────────────────────────────────────────────
    let active_nodes: Vec<_> = app.system.nodes.values().filter(|n| n.connected).collect();

    lines.push(section_header("Nodes", active_nodes.len(), sep_style));
    if active_nodes.is_empty() {
        lines.push(body_line("  (none connected)", dim, sep_style));
    } else {
        for node in &active_nodes {
            let tool_str = if node.tool_count == 1 {
                "1 tool".to_string()
            } else {
                format!("{} tools", node.tool_count)
            };
            lines.push(body_line(
                &format!(
                    "  {:<16} {:<8} {}  {}",
                    node.node_id, node.host_os, tool_str, node.host_role
                ),
                Style::default(),
                sep_style,
            ));
        }
    }

    // Disconnected nodes (dim)
    let disconnected: Vec<_> = app.system.nodes.values().filter(|n| !n.connected).collect();
    if !disconnected.is_empty() {
        for node in &disconnected {
            lines.push(body_line(
                &format!("  {:<16} (disconnected)", node.node_id),
                dim,
                sep_style,
            ));
        }
    }

    lines.push(Line::from(Span::raw("")));

    // ── Channels ────────────────────────────────────────────────────
    let active_channels: Vec<_> = app
        .system
        .channels
        .values()
        .filter(|c| c.connected)
        .collect();

    lines.push(section_header("Channels", active_channels.len(), sep_style));
    if active_channels.is_empty() {
        lines.push(body_line("  (none connected)", dim, sep_style));
    } else {
        for ch in &active_channels {
            let since = ch.connected_at.as_deref().unwrap_or("?");
            lines.push(body_line(
                &format!("  {}:{:<12} connected {}", ch.channel, ch.account_id, since),
                Style::default(),
                sep_style,
            ));
        }
    }

    lines.push(Line::from(Span::raw("")));

    // ── Session ─────────────────────────────────────────────────────
    lines.push(section_header_plain("Session", sep_style));
    lines.push(body_line(
        &format!(
            "  {}",
            crate::tui::state::session_display_name(&app.session_key)
        ),
        Style::default(),
        sep_style,
    ));
    if let Some(status) = &app.status {
        lines.push(body_line(&format!("  status: {}", status), dim, sep_style));
    }

    // Refresh info
    if let Some(last) = app.system.last_refresh {
        let ago = last.elapsed().as_secs();
        let label = if ago < 2 {
            "just now".to_string()
        } else if ago < 60 {
            format!("{}s ago", ago)
        } else {
            format!("{}m ago", ago / 60)
        };
        lines.push(Line::from(Span::raw("")));
        lines.push(body_line(
            &format!("  last refresh: {}", label),
            dim,
            sep_style,
        ));
    }

    lines
}

fn section_header(title: &str, count: usize, sep_style: Style) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("{:>width$}", "sys", width = theme::NICK_WIDTH),
            theme::style_system(),
        ),
        Span::styled(" │ ", sep_style),
        Span::styled(format!("{} ({}):", title, count), Style::default()),
    ])
}

fn section_header_plain(title: &str, sep_style: Style) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("{:>width$}", "sys", width = theme::NICK_WIDTH),
            theme::style_system(),
        ),
        Span::styled(" │ ", sep_style),
        Span::styled(format!("{}:", title), Style::default()),
    ])
}

fn body_line(text: &str, style: Style, sep_style: Style) -> Line<'static> {
    Line::from(vec![
        Span::raw(" ".repeat(theme::NICK_WIDTH)),
        Span::styled(" │ ", sep_style),
        Span::styled(text.to_string(), style),
    ])
}

/// Render pre-built system lines into a Paragraph.
pub fn render(lines: Vec<Line<'static>>, scroll: u16) -> Paragraph<'static> {
    Paragraph::new(lines).scroll((scroll, 0))
}
