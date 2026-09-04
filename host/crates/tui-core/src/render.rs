//! Rendering helpers shared by the App draw code.

#[allow(unused_imports)]
use crate::prelude::*;

pub(crate) fn rectangles_intersect(left: Rect, right: Rect) -> bool {
    left.x < right.right()
        && left.right() > right.x
        && left.y < right.bottom()
        && left.bottom() > right.y
}

pub(crate) fn snap_partial_media_scroll(
    desired: u16,
    direction: ScrollDirection,
    viewport_height: u16,
    max_scroll: u16,
    browse_ranges: &[BrowseRange],
) -> u16 {
    let viewport_height = viewport_height.max(1);
    let mut snapped = desired.min(max_scroll);
    for _ in 0..browse_ranges.len().saturating_mul(2).saturating_add(1) {
        let partial = match direction {
            ScrollDirection::Older => browse_ranges.iter().rev().find(|range| {
                range.is_media() && media_is_partial(**range, snapped, viewport_height)
            }),
            ScrollDirection::Newer => browse_ranges.iter().find(|range| {
                range.is_media() && media_is_partial(**range, snapped, viewport_height)
            }),
        }
        .copied();
        let Some(range) = partial else {
            break;
        };
        let next = match direction {
            ScrollDirection::Older if snapped > range.top => range.top,
            ScrollDirection::Older => range.top.saturating_sub(viewport_height),
            ScrollDirection::Newer if snapped < range.top => {
                range.bottom.saturating_sub(viewport_height)
            }
            ScrollDirection::Newer => range.bottom,
        }
        .min(max_scroll);
        if next == snapped {
            break;
        }
        snapped = next;
    }
    snapped
}

pub(crate) fn media_intersects(range: BrowseRange, scroll: u16, viewport_height: u16) -> bool {
    range.top < scroll.saturating_add(viewport_height) && range.bottom > scroll
}

pub(crate) fn media_is_partial(range: BrowseRange, scroll: u16, viewport_height: u16) -> bool {
    media_intersects(range, scroll, viewport_height)
        && !(range.top >= scroll && range.bottom <= scroll.saturating_add(viewport_height))
}

pub(crate) fn push_transcript_text(
    blocks: &mut Vec<TranscriptBlock>,
    document_height: &mut u16,
    lines: Vec<Line<'static>>,
    width: u16,
) {
    let height = wrapped_line_count(&lines, width);
    if height == 0 {
        return;
    }
    blocks.push(TranscriptBlock::Text {
        top: *document_height,
        height,
        lines,
    });
    *document_height = document_height.saturating_add(height);
}

pub(crate) fn wrapped_line_count(lines: &[Line<'static>], width: u16) -> u16 {
    if lines.is_empty() {
        return 0;
    }
    let paragraph = Paragraph::new(Text::from(lines.to_vec())).wrap(Wrap { trim: false });
    u16::try_from(paragraph.line_count(width.max(1))).unwrap_or(u16::MAX)
}

pub(crate) struct PromptedText {
    pub(crate) lines: Vec<Line<'static>>,
    pub(crate) cursor_row: u16,
    pub(crate) cursor_col: u16,
}

#[derive(Clone, Copy)]
pub(crate) struct TextStyleRange {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) style: Style,
}

pub(crate) fn prompted_text_lines(
    prompt: Vec<Span<'static>>,
    value: &str,
    width: u16,
    text_style: Style,
    style_ranges: &[TextStyleRange],
    cursor: Option<usize>,
) -> PromptedText {
    let width = width.max(1);
    let prompt = fit_prompt(prompt, width);
    let prompt_width = prompt
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum::<usize>();
    let prompt_width = u16::try_from(prompt_width)
        .unwrap_or(width)
        .min(width.saturating_sub(1));
    // Only the first physical line owns the shell prompt. Subsequent explicit or soft-wrapped
    // lines continue at the terminal's left edge, exactly as one long terminal input stream.
    let continuation_width = 0;
    let mut text_lines = vec![Vec::<Span<'static>>::new()];
    let mut row = 0_u16;
    let mut col = prompt_width;
    let mut cursor_position = None;

    for (index, grapheme) in value.grapheme_indices(true) {
        let grapheme_width = u16::try_from(UnicodeWidthStr::width(grapheme))
            .unwrap_or(1)
            .max(1);
        if grapheme != "\n" && col.saturating_add(grapheme_width) > width {
            text_lines.push(Vec::new());
            row = row.saturating_add(1);
            col = continuation_width;
        }
        if cursor == Some(index) {
            cursor_position = Some((row, col));
        }
        if grapheme == "\n" {
            text_lines.push(Vec::new());
            row = row.saturating_add(1);
            col = continuation_width;
            continue;
        }
        if let Some(line) = text_lines.last_mut() {
            let style = style_ranges
                .iter()
                .find(|range| index >= range.start && index < range.end)
                .map_or(text_style, |range| range.style);
            if let Some(last) = line.last_mut().filter(|span| span.style == style) {
                last.content.to_mut().push_str(grapheme);
            } else {
                line.push(Span::styled(grapheme.to_string(), style));
            }
        }
        col = col.saturating_add(grapheme_width);
        if col >= width {
            text_lines.push(Vec::new());
            row = row.saturating_add(1);
            col = continuation_width;
        }
    }
    if cursor == Some(value.len()) || cursor.is_none() {
        cursor_position.get_or_insert((row, col));
    }
    if text_lines.len() > 1
        && text_lines.last().is_some_and(Vec::is_empty)
        && col == continuation_width
    {
        text_lines.pop();
        row = row.saturating_sub(1);
        col = width;
        if cursor == Some(value.len()) {
            cursor_position = Some((row, col.saturating_sub(1)));
        }
    }

    let lines = text_lines
        .into_iter()
        .enumerate()
        .map(|(index, text)| {
            let mut spans = Vec::with_capacity(prompt.len().saturating_add(text.len()));
            if index == 0 {
                spans.extend(prompt.clone());
            }
            spans.extend(text);
            Line::from(spans)
        })
        .collect();
    let (cursor_row, cursor_col) = cursor_position.unwrap_or((row, col));
    PromptedText {
        lines,
        cursor_row,
        cursor_col,
    }
}

pub(crate) fn fit_prompt(prompt: Vec<Span<'static>>, width: u16) -> Vec<Span<'static>> {
    let max_width = width.saturating_sub(1);
    let prompt_width = prompt
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum::<usize>();
    if prompt_width <= usize::from(max_width) {
        return prompt;
    }
    if max_width == 0 {
        return Vec::new();
    }

    let suffix = if max_width > 1 { "… " } else { "…" };
    let suffix_width = u16::try_from(UnicodeWidthStr::width(suffix)).unwrap_or(max_width);
    let mut remaining = usize::from(max_width.saturating_sub(suffix_width));
    let mut compact = Vec::new();
    let mut suffix_style = prompt.first().map(|span| span.style).unwrap_or_default();
    let mut fitted = false;
    for span in prompt {
        let mut content = String::new();
        for grapheme in span.content.graphemes(true) {
            let grapheme_width = UnicodeWidthStr::width(grapheme);
            if grapheme_width > remaining {
                suffix_style = span.style;
                fitted = true;
                break;
            }
            content.push_str(grapheme);
            remaining = remaining.saturating_sub(grapheme_width);
            suffix_style = span.style;
            if remaining == 0 {
                fitted = true;
                break;
            }
        }
        if !content.is_empty() {
            compact.push(Span::styled(content, span.style));
        }
        if fitted {
            break;
        }
    }
    compact.push(Span::styled(suffix, suffix_style));
    compact
}

pub(crate) fn render_approval_lines(approval: &Approval, palette: Palette) -> Vec<Line<'static>> {
    let mut lines = vec![
        Line::default(),
        Line::from(Span::styled(
            "approval required",
            Style::new()
                .fg(palette.warning)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(vec![
            Span::styled(
                approval.syscall.clone(),
                Style::new().fg(palette.foreground),
            ),
            Span::styled("  on  ", Style::new().fg(palette.quiet)),
            Span::styled(approval.target.clone(), Style::new().fg(palette.accent)),
        ]),
        Line::default(),
    ];
    lines.extend(approval.preview.split('\n').map(|line| {
        Line::from(Span::styled(
            line.to_string(),
            Style::new().fg(palette.muted),
        ))
    }));
    lines.extend([
        Line::default(),
        Line::from(Span::styled(
            "o allow once   a always allow   d deny",
            Style::new().fg(palette.muted),
        )),
    ]);
    lines
}

pub(crate) fn help_line(
    key: &'static str,
    meaning: &'static str,
    palette: Palette,
) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{key:<22}"), Style::new().fg(palette.accent)),
        Span::styled(meaning, Style::new().fg(palette.muted)),
    ])
}

pub(crate) fn agent_action_label(name: &str, syscall: &str) -> String {
    let label = if name.trim().is_empty() {
        syscall
    } else {
        name
    };
    sanitize_label(label, "action", 64).to_lowercase()
}

pub(crate) fn agent_action_state(value: &str) -> AgentActionState {
    match value {
        "completed" | "ok" => AgentActionState::Completed,
        "cancelled" | "aborted" => AgentActionState::Cancelled,
        "denied" => AgentActionState::Denied,
        "running" => AgentActionState::Running,
        "failed" | "error" => AgentActionState::Failed,
        _ => AgentActionState::Failed,
    }
}

pub(crate) fn agent_action_status(action: &AgentAction) -> String {
    action.target.as_ref().map_or_else(
        || action.label.clone(),
        |target| format!("{} · {target}", action.label),
    )
}

pub(crate) fn action_timeline_order(left: &AgentAction, right: &AgentAction) -> Ordering {
    match (left.started_at, right.started_at) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

pub(crate) fn activity_cursor(palette: Palette, phase: bool) -> Span<'static> {
    Span::styled(
        if phase { "▌" } else { " " },
        Style::new().fg(palette.accent),
    )
}

pub(crate) fn activity_line(
    activity: Option<&str>,
    palette: Palette,
    phase: bool,
) -> Line<'static> {
    let label = sanitize_status(activity.unwrap_or("working")).to_lowercase();
    Line::from(vec![
        Span::raw("  "),
        activity_cursor(palette, phase),
        Span::styled(format!(" {label}"), Style::new().fg(palette.quiet)),
    ])
}

pub(crate) fn append_activity_cursor(
    lines: &mut Vec<Line<'static>>,
    palette: Palette,
    phase: bool,
) {
    if lines.is_empty() {
        lines.push(Line::default());
    }
    if let Some(line) = lines.last_mut() {
        line.spans.push(activity_cursor(palette, phase));
    }
}

pub(crate) fn render_agent_action_summary(
    run: &RunActions,
    palette: Palette,
    activity_phase: bool,
) -> Vec<Line<'static>> {
    let running = run
        .actions
        .iter()
        .any(|action| action.state == AgentActionState::Running);
    let failed = run.actions.iter().any(|action| {
        matches!(
            action.state,
            AgentActionState::Failed | AgentActionState::Denied
        )
    });
    let glyph = if running {
        if activity_phase {
            "▌"
        } else {
            " "
        }
    } else if failed {
        "×"
    } else {
        "↳"
    };
    let glyph_color = if failed {
        palette.error
    } else if running {
        palette.accent
    } else {
        palette.quiet
    };
    let count = run.omitted.saturating_add(run.actions.len());
    let suffix = if count == 1 { "" } else { "s" };
    vec![Line::from(vec![
        Span::raw("  "),
        Span::styled(glyph, Style::new().fg(glyph_color)),
        Span::styled(
            format!(" {count} action{suffix}"),
            Style::new().fg(palette.quiet),
        ),
    ])]
}

pub(crate) fn render_agent_action_segment(
    actions: &[AgentAction],
    hidden: usize,
    palette: Palette,
    activity_phase: bool,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if hidden > 0 {
        lines.push(Line::from(Span::styled(
            format!("    … {hidden} earlier"),
            Style::new().fg(palette.quiet),
        )));
    }
    for action in actions {
        let (glyph, color) = match action.state {
            AgentActionState::Running => (if activity_phase { "▌" } else { " " }, palette.accent),
            AgentActionState::Completed => ("✓", palette.principal),
            AgentActionState::Failed => ("×", palette.error),
            AgentActionState::Cancelled => ("–", palette.quiet),
            AgentActionState::Denied => ("!", palette.warning),
        };
        let mut spans = vec![
            Span::raw("  "),
            Span::styled(glyph, Style::new().fg(color)),
            Span::styled(
                format!(" {}", action.label),
                Style::new().fg(palette.foreground),
            ),
        ];
        if let Some(target) = &action.target {
            spans.extend([
                Span::styled(" · ", Style::new().fg(palette.quiet)),
                Span::styled(target.clone(), Style::new().fg(palette.accent)),
            ]);
        }
        lines.push(Line::from(spans));
    }
    lines
}

pub(crate) fn centered_rect(area: Rect, width: u16, height: u16) -> Rect {
    let [vertical] = Layout::new(Direction::Vertical, [Constraint::Length(height)])
        .flex(ratatui::layout::Flex::Center)
        .areas(area);
    let [centered] = Layout::new(Direction::Horizontal, [Constraint::Length(width)])
        .flex(ratatui::layout::Flex::Center)
        .areas(vertical);
    centered
}
