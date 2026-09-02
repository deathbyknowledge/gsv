use markdown::{mdast::Node, ParseOptions};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::Palette;
use crate::Artifact;

pub(crate) fn render_plain(source: &str, style: Style) -> Vec<Line<'static>> {
    source
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            Line::from(Span::styled(sanitize(line), style))
        })
        .collect()
}

pub(crate) fn render_markdown(source: &str, palette: Palette) -> Vec<Line<'static>> {
    let Ok(root) = markdown::to_mdast(source, &ParseOptions::gfm()) else {
        return render_plain(source, Style::new().fg(palette.foreground));
    };
    let mut lines = Vec::new();
    render_block(&root, palette, &mut lines);
    trim_trailing_blank_lines(&mut lines);
    if lines.is_empty() {
        lines.push(Line::default());
    }
    lines
}

pub(crate) fn render_artifacts(
    artifacts: &[(&Artifact, bool)],
    palette: Palette,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for (artifact, focused) in artifacts {
        if !lines.is_empty() {
            lines.push(Line::default());
        }
        lines.push(Line::from(vec![
            Span::styled(
                if *focused { "› " } else { "  " },
                Style::new().fg(if *focused {
                    palette.accent
                } else {
                    palette.muted
                }),
            ),
            Span::styled(
                format!("{}  ", artifact.kind.symbol()),
                Style::new().fg(if *focused {
                    palette.accent
                } else {
                    palette.muted
                }),
            ),
            Span::styled(
                sanitize(artifact.display_name()),
                Style::new()
                    .fg(palette.foreground)
                    .add_modifier(if *focused {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            ),
        ]));
        if let Some(transcription) = artifact.transcription.as_deref() {
            lines.push(Line::from(Span::styled(
                sanitize(&shorten(transcription, 240)),
                Style::new().fg(palette.muted),
            )));
        }
    }
    lines
}

fn render_block(node: &Node, palette: Palette, output: &mut Vec<Line<'static>>) {
    match node {
        Node::Root(root) => {
            for child in &root.children {
                render_block(child, palette, output);
            }
        }
        Node::Paragraph(paragraph) => {
            output.extend(render_inlines(
                &paragraph.children,
                palette,
                Style::new().fg(palette.foreground),
            ));
            push_blank_line(output);
        }
        Node::Heading(heading) => {
            let color = if heading.depth == 1 {
                palette.accent
            } else {
                palette.foreground
            };
            let lines = render_inlines(
                &heading.children,
                palette,
                Style::new().fg(color).add_modifier(Modifier::BOLD),
            );
            output.extend(lines);
            push_blank_line(output);
        }
        Node::Code(code) => {
            let mut code_style = Style::new().fg(palette.foreground);
            if let Some(background) = palette.code_background {
                code_style = code_style.bg(background);
            }
            for line in code.value.split('\n') {
                output.push(Line::from(vec![
                    Span::styled("│ ", Style::new().fg(palette.quiet)),
                    Span::styled(sanitize(line), code_style),
                ]));
            }
            push_blank_line(output);
        }
        Node::List(list) => {
            for (index, child) in list.children.iter().enumerate() {
                let Node::ListItem(item) = child else {
                    continue;
                };
                let mut item_lines = Vec::new();
                for child in &item.children {
                    render_block(child, palette, &mut item_lines);
                }
                trim_trailing_blank_lines(&mut item_lines);
                let marker = if let Some(checked) = item.checked {
                    if checked {
                        "✓ ".to_string()
                    } else {
                        "□ ".to_string()
                    }
                } else if list.ordered {
                    format!("{}. ", list.start.unwrap_or(1) as usize + index)
                } else {
                    "• ".to_string()
                };
                if item_lines.is_empty() {
                    item_lines.push(Line::default());
                }
                for (line_index, line) in item_lines.into_iter().enumerate() {
                    let prefix = if line_index == 0 {
                        marker.clone()
                    } else {
                        " ".repeat(marker.chars().count())
                    };
                    output.push(prefixed_line(line, prefix, palette.accent));
                }
            }
            push_blank_line(output);
        }
        Node::Table(table) => {
            for (row_index, child) in table.children.iter().enumerate() {
                let Node::TableRow(row) = child else {
                    continue;
                };
                let cells = row
                    .children
                    .iter()
                    .map(node_text)
                    .map(|cell| sanitize(cell.trim()))
                    .collect::<Vec<_>>();
                let style = if row_index == 0 {
                    Style::new()
                        .fg(palette.foreground)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::new().fg(palette.foreground)
                };
                output.push(Line::from(Span::styled(cells.join("  │  "), style)));
                if row_index == 0 {
                    output.push(Line::from(Span::styled(
                        "─".repeat(cells.join("  │  ").chars().count().min(96)),
                        Style::new().fg(palette.quiet),
                    )));
                }
            }
            push_blank_line(output);
        }
        Node::Blockquote(blockquote) => {
            let mut quoted = Vec::new();
            for child in &blockquote.children {
                render_block(child, palette, &mut quoted);
            }
            trim_trailing_blank_lines(&mut quoted);
            for line in quoted {
                output.push(prefixed_line(line, "│ ".to_string(), palette.muted));
            }
            push_blank_line(output);
        }
        Node::ThematicBreak(_) => {
            output.push(Line::from(Span::styled(
                "─".repeat(36),
                Style::new().fg(palette.quiet),
            )));
            push_blank_line(output);
        }
        Node::Image(image) => {
            render_markdown_image(&image.alt, &image.url, palette, output);
        }
        Node::ImageReference(image) => {
            output.push(Line::from(vec![
                Span::styled("▧  ", Style::new().fg(palette.muted)),
                Span::styled(sanitize(&image.alt), Style::new().fg(palette.foreground)),
            ]));
            push_blank_line(output);
        }
        Node::Html(html) => {
            output.extend(render_plain(&html.value, Style::new().fg(palette.muted)));
            push_blank_line(output);
        }
        Node::Definition(_) => {}
        other => {
            if let Some(children) = other.children() {
                for child in children {
                    render_block(child, palette, output);
                }
            } else {
                let value = other.to_string();
                if !value.is_empty() {
                    output.extend(render_plain(&value, Style::new().fg(palette.foreground)));
                    push_blank_line(output);
                }
            }
        }
    }
}

fn render_inlines(children: &[Node], palette: Palette, base: Style) -> Vec<Line<'static>> {
    let mut lines = vec![Vec::new()];
    for child in children {
        render_inline(child, palette, base, &mut lines);
    }
    lines.into_iter().map(Line::from).collect()
}

fn render_inline(node: &Node, palette: Palette, style: Style, lines: &mut Vec<Vec<Span<'static>>>) {
    match node {
        Node::Text(text) => push_text(lines, &text.value, style),
        Node::Emphasis(emphasis) => {
            let style = style.add_modifier(Modifier::ITALIC);
            for child in &emphasis.children {
                render_inline(child, palette, style, lines);
            }
        }
        Node::Strong(strong) => {
            let style = style.add_modifier(Modifier::BOLD);
            for child in &strong.children {
                render_inline(child, palette, style, lines);
            }
        }
        Node::Delete(deleted) => {
            let style = style.add_modifier(Modifier::CROSSED_OUT);
            for child in &deleted.children {
                render_inline(child, palette, style, lines);
            }
        }
        Node::InlineCode(code) => {
            let mut code_style = style.fg(palette.accent);
            if let Some(background) = palette.code_background {
                code_style = code_style.bg(background);
            }
            push_span(lines, Span::styled(sanitize(&code.value), code_style));
        }
        Node::InlineMath(math) => {
            let mut code_style = style.fg(palette.accent);
            if let Some(background) = palette.code_background {
                code_style = code_style.bg(background);
            }
            push_span(lines, Span::styled(sanitize(&math.value), code_style));
        }
        Node::Break(_) => lines.push(Vec::new()),
        Node::Link(link) => {
            let label = link.children.iter().map(node_text).collect::<String>();
            let link_style = style.fg(palette.accent).add_modifier(Modifier::UNDERLINED);
            for child in &link.children {
                render_inline(child, palette, link_style, lines);
            }
            if label.trim() != link.url.trim() {
                push_span(
                    lines,
                    Span::styled(
                        format!("  ‹{}›", sanitize(&shorten(&link.url, 120))),
                        Style::new().fg(palette.muted),
                    ),
                );
            }
        }
        Node::LinkReference(link) => {
            let link_style = style.fg(palette.accent).add_modifier(Modifier::UNDERLINED);
            for child in &link.children {
                render_inline(child, palette, link_style, lines);
            }
        }
        Node::Image(image) => {
            push_span(
                lines,
                Span::styled(
                    format!(
                        "▧  {}  ‹{}›",
                        sanitize(&image.alt),
                        sanitize(&shorten(&image.url, 120))
                    ),
                    Style::new().fg(palette.muted),
                ),
            );
        }
        Node::ImageReference(image) => {
            push_span(
                lines,
                Span::styled(
                    format!("▧  {}", sanitize(&image.alt)),
                    Style::new().fg(palette.muted),
                ),
            );
        }
        Node::Html(html) => push_text(lines, &html.value, style.fg(palette.muted)),
        other => {
            if let Some(children) = other.children() {
                for child in children {
                    render_inline(child, palette, style, lines);
                }
            } else {
                push_text(lines, &other.to_string(), style);
            }
        }
    }
}

fn render_markdown_image(alt: &str, url: &str, palette: Palette, output: &mut Vec<Line<'static>>) {
    output.push(Line::from(vec![
        Span::styled("▧  ", Style::new().fg(palette.muted)),
        Span::styled(sanitize(alt), Style::new().fg(palette.foreground)),
    ]));
    output.push(Line::from(Span::styled(
        format!("       {}", sanitize(&shorten(url, 140))),
        Style::new().fg(palette.muted),
    )));
    push_blank_line(output);
}

fn node_text(node: &Node) -> String {
    match node {
        Node::Text(text) => text.value.clone(),
        Node::InlineCode(code) => code.value.clone(),
        Node::Image(image) => image.alt.clone(),
        other => other
            .children()
            .map(|children| children.iter().map(node_text).collect::<Vec<_>>().join(""))
            .unwrap_or_default(),
    }
}

fn prefixed_line(
    mut line: Line<'static>,
    prefix: String,
    color: ratatui::style::Color,
) -> Line<'static> {
    line.spans
        .insert(0, Span::styled(prefix, Style::new().fg(color)));
    line
}

fn push_text(lines: &mut Vec<Vec<Span<'static>>>, value: &str, style: Style) {
    for (index, part) in value.split('\n').enumerate() {
        if index > 0 {
            push_span(lines, Span::styled(" ", style));
        }
        if !part.is_empty() {
            push_span(lines, Span::styled(sanitize(part), style));
        }
    }
}

fn push_span(lines: &mut Vec<Vec<Span<'static>>>, span: Span<'static>) {
    if let Some(line) = lines.last_mut() {
        line.push(span);
    } else {
        lines.push(vec![span]);
    }
}

fn push_blank_line(lines: &mut Vec<Line<'static>>) {
    if lines.last().is_some_and(|line| line.width() > 0) {
        lines.push(Line::default());
    }
}

fn trim_trailing_blank_lines(lines: &mut Vec<Line<'static>>) {
    while lines.last().is_some_and(|line| line.width() == 0) {
        lines.pop();
    }
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '\t' => "    ".chars().collect::<Vec<_>>(),
            character if character.is_control() => "�".chars().collect(),
            character => vec![character],
        })
        .collect()
}

fn shorten(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Theme;

    fn rendered_text(lines: &[Line<'_>]) -> String {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn markdown_preserves_terminal_document_structure() {
        let lines = render_markdown(
            "# Result\n\nThis is **clear** and [`typed`](https://example.com).\n\n```rust\nlet answer = 42;\n```\n\n- one\n- two",
            Theme::Gsv.palette(),
        );
        let rendered = rendered_text(&lines);
        assert!(rendered.contains("Result"));
        assert!(rendered.contains("‹https://example.com›"));
        assert!(rendered.contains("│ let answer = 42;"));
        assert!(!rendered.contains("CODE"));
        assert!(rendered.contains("• one"));
    }

    #[test]
    fn markdown_control_characters_cannot_escape_the_cell_renderer() {
        let rendered = rendered_text(&render_markdown("hello\u{1b}[31m", Theme::Gsv.palette()));
        assert_eq!(rendered, "hello�[31m");
    }

    #[test]
    fn plain_output_normalizes_windows_line_endings() {
        let rendered = rendered_text(&render_plain("one\r\ntwo\r\n", Style::new()));
        assert_eq!(rendered, "one\ntwo\n");
    }
}
