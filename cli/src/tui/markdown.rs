//! Lightweight markdown → ratatui `Span` renderer.
//!
//! Parses a subset of CommonMark sufficient for LLM output:
//!   Block level:  fenced code blocks, ATX headers, lists, blockquotes, hrules
//!   Inline level: **bold**, *italic*, `code`, [text](url)
//!
//! Produces pre-wrapped `Vec<Span>` lines so the chat widget can append
//! its gutter and pass them straight to ratatui without `Wrap`.

use ratatui::style::{Modifier, Style};
use ratatui::text::Span;

use crate::tui::theme;

// ── Internal span model ─────────────────────────────────────────────────────

#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct SpanStyle {
    bold: bool,
    italic: bool,
    code: bool,
    dim: bool,
}

#[derive(Clone)]
struct MdSpan {
    text: String,
    style: SpanStyle,
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Parse markdown text and produce word-wrapped, styled lines.
///
/// Each inner `Vec<Span>` is one visual terminal row.  The caller adds
/// the gutter (nick + separator) before passing to ratatui.
pub fn render_markdown(text: &str, max_width: usize) -> Vec<Vec<Span<'static>>> {
    let source_lines: Vec<&str> = text.split('\n').collect();
    let mut result: Vec<Vec<Span<'static>>> = Vec::new();
    let mut in_code_block = false;

    for line in &source_lines {
        let trimmed = line.trim();

        // ── Code-block fences ───────────────────────────────────────
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_block = !in_code_block;
            continue; // skip the fence line itself
        }

        if in_code_block {
            // Preserve whitespace, no wrap, code style.
            result.push(vec![Span::styled(
                (*line).to_string(),
                theme::style_md_code(),
            )]);
            continue;
        }

        // ── Blank line ──────────────────────────────────────────────
        if trimmed.is_empty() {
            result.push(Vec::new());
            continue;
        }

        // ── Horizontal rule ─────────────────────────────────────────
        if is_hrule(trimmed) {
            let width = max_width.min(40);
            result.push(vec![Span::styled("─".repeat(width), theme::style_dim())]);
            continue;
        }

        // ── ATX header ──────────────────────────────────────────────
        if let Some((level, header_text)) = parse_header(trimmed) {
            let spans = parse_inline(header_text);
            let base = theme::style_md_heading(level);
            for wline in wrap_spans(&spans, max_width) {
                result.push(to_ratatui(&wline, base));
            }
            continue;
        }

        // ── Blockquote ──────────────────────────────────────────────
        if let Some(quote_body) =
            trimmed
                .strip_prefix("> ")
                .or_else(|| if trimmed == ">" { Some("") } else { None })
        {
            let spans = parse_inline(quote_body);
            let inner_w = max_width.saturating_sub(2);
            let base = theme::style_md_blockquote();
            for wline in wrap_spans(&spans, inner_w) {
                let mut out = vec![Span::styled("│ ", theme::style_dim())];
                out.extend(to_ratatui(&wline, base));
                result.push(out);
            }
            continue;
        }

        // ── List item ───────────────────────────────────────────────
        if let Some((prefix, body)) = parse_list_item(line) {
            let indent = prefix.len();
            let spans = parse_inline(body);
            let inner_w = max_width.saturating_sub(indent);
            let wrapped = wrap_spans(&spans, inner_w);
            for (i, wline) in wrapped.iter().enumerate() {
                let mut out = if i == 0 {
                    vec![Span::styled(prefix.clone(), theme::style_dim())]
                } else {
                    vec![Span::raw(" ".repeat(indent))]
                };
                out.extend(to_ratatui(wline, Style::default()));
                result.push(out);
            }
            continue;
        }

        // ── Regular paragraph line ──────────────────────────────────
        let spans = parse_inline(line);
        for wline in wrap_spans(&spans, max_width) {
            result.push(to_ratatui(&wline, Style::default()));
        }
    }

    if result.is_empty() {
        result.push(Vec::new());
    }
    result
}

// ── Block-level helpers ─────────────────────────────────────────────────────

fn is_hrule(line: &str) -> bool {
    let stripped: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
    stripped.len() >= 3
        && (stripped.iter().all(|&c| c == '-')
            || stripped.iter().all(|&c| c == '*')
            || stripped.iter().all(|&c| c == '_'))
}

fn parse_header(line: &str) -> Option<(u8, &str)> {
    let level = line.bytes().take_while(|&b| b == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &line[level..];
    if rest.starts_with(' ') {
        Some((level as u8, rest[1..].trim_end()))
    } else {
        None
    }
}

fn parse_list_item<'a>(line: &'a str) -> Option<(String, &'a str)> {
    let leading = line.len() - line.trim_start().len();
    let pad = &line[..leading];
    let trimmed = &line[leading..];

    // Unordered: "- " or "* "
    if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
    {
        return Some((format!("{}• ", pad), rest));
    }

    // Ordered: "N. "
    let num_end = trimmed.bytes().take_while(|b| b.is_ascii_digit()).count();
    if num_end > 0 {
        if let Some(rest) = trimmed[num_end..].strip_prefix(". ") {
            let num = &trimmed[..num_end];
            return Some((format!("{}{}. ", pad, num), rest));
        }
    }

    None
}

// ── Inline markdown parser ──────────────────────────────────────────────────
//
// Walks the line character by character.  Precedence: ``` > *** > ** > * > [

fn parse_inline(text: &str) -> Vec<MdSpan> {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut spans: Vec<MdSpan> = Vec::new();
    let mut buf = String::new();
    let mut style = SpanStyle::default();
    let mut i = 0;

    while i < len {
        let ch = chars[i];

        // ── Backtick: inline code ───────────────────────────────────
        if ch == '`' {
            flush(&mut spans, &mut buf, style);
            let close = find_char(&chars, '`', i + 1);
            if let Some(end) = close {
                let code_text: String = chars[i + 1..end].iter().collect();
                spans.push(MdSpan {
                    text: code_text,
                    style: SpanStyle {
                        code: true,
                        ..Default::default()
                    },
                });
                i = end + 1;
            } else {
                buf.push('`');
                i += 1;
            }
            continue;
        }

        // ── Asterisks: bold / italic ────────────────────────────────
        if ch == '*' {
            let run = count_run(&chars, '*', i);

            if run >= 3 {
                // *** toggles both bold and italic
                flush(&mut spans, &mut buf, style);
                style.bold = !style.bold;
                style.italic = !style.italic;
                i += 3;
                continue;
            }
            if run == 2 {
                flush(&mut spans, &mut buf, style);
                style.bold = !style.bold;
                i += 2;
                continue;
            }
            // Single *
            flush(&mut spans, &mut buf, style);
            style.italic = !style.italic;
            i += 1;
            continue;
        }

        // ── Link: [text](url) ───────────────────────────────────────
        if ch == '[' {
            if let Some((link_text, link_url, end)) = try_parse_link(&chars, i) {
                flush(&mut spans, &mut buf, style);
                spans.push(MdSpan {
                    text: link_text,
                    style,
                });
                spans.push(MdSpan {
                    text: format!(" ({})", link_url),
                    style: SpanStyle {
                        dim: true,
                        ..Default::default()
                    },
                });
                i = end;
                continue;
            }
        }

        buf.push(ch);
        i += 1;
    }

    flush(&mut spans, &mut buf, style);

    if spans.is_empty() {
        spans.push(MdSpan {
            text: String::new(),
            style: SpanStyle::default(),
        });
    }
    spans
}

/// Flush accumulated text into a span (if non-empty).
fn flush(spans: &mut Vec<MdSpan>, buf: &mut String, style: SpanStyle) {
    if !buf.is_empty() {
        spans.push(MdSpan {
            text: buf.clone(),
            style,
        });
        buf.clear();
    }
}

fn find_char(chars: &[char], target: char, from: usize) -> Option<usize> {
    for j in from..chars.len() {
        if chars[j] == target {
            return Some(j);
        }
    }
    None
}

fn count_run(chars: &[char], target: char, from: usize) -> usize {
    chars[from..].iter().take_while(|&&c| c == target).count()
}

fn try_parse_link(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    // start points at '['
    let text_start = start + 1;
    let text_end = find_char(chars, ']', text_start)?;

    // Must be followed immediately by '('
    if text_end + 1 >= chars.len() || chars[text_end + 1] != '(' {
        return None;
    }

    let url_start = text_end + 2;
    let mut depth: usize = 1;
    let mut url_end = url_start;
    while url_end < chars.len() && depth > 0 {
        match chars[url_end] {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth > 0 {
            url_end += 1;
        }
    }

    if depth != 0 {
        return None;
    }

    let link_text: String = chars[text_start..text_end].iter().collect();
    let link_url: String = chars[url_start..url_end].iter().collect();
    Some((link_text, link_url, url_end + 1))
}

// ── Span-aware word wrapper ─────────────────────────────────────────────────

struct StyledWord {
    text: String,
    style: SpanStyle,
}

fn spans_to_words(spans: &[MdSpan]) -> Vec<StyledWord> {
    let mut words = Vec::new();
    for span in spans {
        for word in span.text.split_whitespace() {
            words.push(StyledWord {
                text: word.to_string(),
                style: span.style,
            });
        }
    }
    words
}

fn wrap_spans(spans: &[MdSpan], max_width: usize) -> Vec<Vec<MdSpan>> {
    if max_width == 0 {
        return vec![spans.to_vec()];
    }

    let words = spans_to_words(spans);
    if words.is_empty() {
        return vec![vec![MdSpan {
            text: String::new(),
            style: SpanStyle::default(),
        }]];
    }

    let mut lines: Vec<Vec<MdSpan>> = Vec::new();
    let mut cur: Vec<MdSpan> = Vec::new();
    let mut cur_w: usize = 0;

    for word in &words {
        let wlen = word.text.len();

        // Does it fit on the current line?
        if cur_w > 0 && cur_w + 1 + wlen > max_width {
            lines.push(cur);
            cur = Vec::new();
            cur_w = 0;
        }

        // Force-break a word wider than max_width.
        if wlen > max_width {
            let mut remaining = word.text.as_str();
            while !remaining.is_empty() {
                let avail = if cur_w > 0 {
                    max_width.saturating_sub(cur_w + 1)
                } else {
                    max_width
                };
                if avail == 0 {
                    lines.push(cur);
                    cur = Vec::new();
                    cur_w = 0;
                    continue;
                }
                let take = avail.min(remaining.len());
                if cur_w > 0 {
                    let prev = cur.last().map(|s| s.style).unwrap_or_default();
                    let sp = if prev == word.style {
                        word.style
                    } else {
                        SpanStyle::default()
                    };
                    push_span(&mut cur, " ", sp);
                    cur_w += 1;
                }
                push_span(&mut cur, &remaining[..take], word.style);
                cur_w += take;
                remaining = &remaining[take..];
                if !remaining.is_empty() {
                    lines.push(cur);
                    cur = Vec::new();
                    cur_w = 0;
                }
            }
            continue;
        }

        // Normal word — add space separator.
        // If the previous and next word share a style, keep it (allows merging).
        // Otherwise use Normal so styled regions stay cleanly bounded.
        if cur_w > 0 {
            let prev = cur.last().map(|s| s.style).unwrap_or_default();
            let sp_style = if prev == word.style {
                word.style
            } else {
                SpanStyle::default()
            };
            push_span(&mut cur, " ", sp_style);
            cur_w += 1;
        }
        push_span(&mut cur, &word.text, word.style);
        cur_w += wlen;
    }

    if !cur.is_empty() {
        lines.push(cur);
    }
    if lines.is_empty() {
        lines.push(Vec::new());
    }
    lines
}

/// Append `text` to the last span if its style matches, else push a new span.
fn push_span(spans: &mut Vec<MdSpan>, text: &str, style: SpanStyle) {
    if let Some(last) = spans.last_mut() {
        if last.style == style {
            last.text.push_str(text);
            return;
        }
    }
    spans.push(MdSpan {
        text: text.to_string(),
        style,
    });
}

// ── Conversion to ratatui Spans ─────────────────────────────────────────────

fn to_ratatui(md_spans: &[MdSpan], base: Style) -> Vec<Span<'static>> {
    md_spans.iter().map(|s| to_ratatui_span(s, base)).collect()
}

fn to_ratatui_span(md: &MdSpan, base: Style) -> Span<'static> {
    let style = if md.style.code {
        theme::style_md_code()
    } else if md.style.dim {
        theme::style_dim()
    } else {
        let mut s = base;
        if md.style.bold {
            s = s.add_modifier(Modifier::BOLD);
        }
        if md.style.italic {
            s = s.add_modifier(Modifier::ITALIC);
        }
        s
    };
    Span::styled(md.text.clone(), style)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: render and collect just the text from each visual line.
    fn render_texts(md: &str, width: usize) -> Vec<String> {
        render_markdown(md, width)
            .into_iter()
            .map(|spans| spans.into_iter().map(|s| s.content.to_string()).collect())
            .collect()
    }

    #[test]
    fn plain_text_unchanged() {
        let lines = render_texts("Hello world", 80);
        assert_eq!(lines, vec!["Hello world"]);
    }

    #[test]
    fn bold_inline() {
        let lines = render_markdown("Say **hello** world", 80);
        assert_eq!(lines.len(), 1);
        // Should have 3 spans: "Say " (normal), "hello" (bold), " world" (normal)
        assert_eq!(lines[0].len(), 3);
        assert_eq!(lines[0][0].content.as_ref(), "Say ");
        assert_eq!(lines[0][1].content.as_ref(), "hello");
        assert_eq!(lines[0][2].content.as_ref(), " world");
    }

    #[test]
    fn italic_inline() {
        let lines = render_markdown("Say *hello* world", 80);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 3);
        assert_eq!(lines[0][1].content.as_ref(), "hello");
    }

    #[test]
    fn inline_code() {
        let lines = render_markdown("Use `foo()` here", 80);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 3);
        assert_eq!(lines[0][1].content.as_ref(), "foo()");
    }

    #[test]
    fn code_block_preserved() {
        let md = "before\n```\nlet x = 1;\n  indented;\n```\nafter";
        let lines = render_texts(md, 80);
        assert_eq!(lines[0], "before");
        assert_eq!(lines[1], "let x = 1;");
        assert_eq!(lines[2], "  indented;");
        assert_eq!(lines[3], "after");
    }

    #[test]
    fn header_parsed() {
        let lines = render_markdown("## Hello", 80);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0][0].content.as_ref(), "Hello");
    }

    #[test]
    fn list_items() {
        let lines = render_texts("- one\n- two\n1. three", 80);
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("one"));
        assert!(lines[1].contains("two"));
        assert!(lines[2].contains("three"));
    }

    #[test]
    fn blockquote() {
        let lines = render_texts("> quoted text", 80);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("quoted"));
    }

    #[test]
    fn horizontal_rule() {
        let lines = render_texts("---", 80);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with('─'));
    }

    #[test]
    fn word_wrap_respects_width() {
        let lines = render_texts("one two three four five", 10);
        assert!(lines.len() > 1);
        for line in &lines {
            assert!(line.len() <= 10, "line too wide: {:?}", line);
        }
    }

    #[test]
    fn link_parsed() {
        let lines = render_markdown("See [docs](https://example.com) here", 80);
        assert_eq!(lines.len(), 1);
        // "See " + "docs" + " (https://example.com)" + " here"
        assert!(lines[0].len() >= 3);
        let text: String = lines[0].iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("docs"));
        assert!(text.contains("example.com"));
    }

    #[test]
    fn empty_input() {
        let lines = render_texts("", 80);
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn unclosed_code_block_treated_as_code() {
        let md = "before\n```\ncode line\nmore code";
        let lines = render_texts(md, 80);
        assert_eq!(lines[0], "before");
        assert_eq!(lines[1], "code line");
        assert_eq!(lines[2], "more code");
    }

    #[test]
    fn bold_italic_combined() {
        let lines = render_markdown("This is ***bold italic*** text", 80);
        assert_eq!(lines.len(), 1);
        // "This is " + "bold italic" + " text"
        assert_eq!(lines[0].len(), 3);
    }
}
