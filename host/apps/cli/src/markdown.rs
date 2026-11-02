//! Markdown for Ship replies on a terminal.
//!
//! Replies stream as deltas, so the renderer holds text until each newline
//! and renders whole lines, keeping fence state from one line to the next.
//! It covers what replies use: headings, lists, quotes, fenced code, and
//! inline bold, italic, code and links. Tables pass through unchanged. When
//! stdout is not a terminal the text passes through raw, so piped replies
//! stay Markdown.

const BOLD: (&str, &str) = ("\u{1b}[1m", "\u{1b}[22m");
const ITALIC: (&str, &str) = ("\u{1b}[3m", "\u{1b}[23m");
const DIM: (&str, &str) = ("\u{1b}[2m", "\u{1b}[22m");
const CODE: (&str, &str) = ("\u{1b}[36m", "\u{1b}[39m");

#[derive(Default)]
pub(crate) struct Markdown {
    /// Render at all; otherwise text passes through as it arrived.
    enabled: bool,
    /// Use terminal styles; without them only the layout changes.
    color: bool,
    /// Write links as OSC 8 hyperlinks instead of "text (url)".
    hyperlinks: bool,
    /// The line received so far, waiting for its newline.
    pending: String,
    in_fence: bool,
}

impl Markdown {
    pub(crate) fn new(enabled: bool, color: bool, hyperlinks: bool) -> Self {
        Self {
            enabled,
            color,
            hyperlinks: color && hyperlinks,
            ..Self::default()
        }
    }

    /// Takes one delta and returns what can be written now: every line it
    /// completed, rendered.
    pub(crate) fn push(&mut self, delta: &str) -> String {
        if !self.enabled {
            return delta.to_string();
        }
        self.pending.push_str(delta);
        let mut out = String::new();
        while let Some(end) = self.pending.find('\n') {
            let rest = self.pending.split_off(end + 1);
            let line = std::mem::replace(&mut self.pending, rest);
            let line = line.trim_end_matches(['\n', '\r']);
            if let Some(rendered) = self.line(line) {
                out.push_str(&rendered);
                out.push('\n');
            }
        }
        out
    }

    /// Renders the unfinished last line, without a newline, and ends the
    /// reply: the next one starts outside any code block.
    pub(crate) fn finish(&mut self) -> String {
        let line = std::mem::take(&mut self.pending);
        let out = if line.is_empty() {
            String::new()
        } else {
            self.line(&line).unwrap_or_default()
        };
        self.in_fence = false;
        out
    }

    /// One complete line, or `None` for a fence line, which prints nothing.
    fn line(&mut self, line: &str) -> Option<String> {
        let trimmed = line.trim_start();
        let indent = line.len().saturating_sub(trimmed.len());
        let indent = " ".repeat(indent);
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            self.in_fence = !self.in_fence;
            return None;
        }
        if self.in_fence {
            return Some(format!("  {}", self.wrap(DIM, line)));
        }
        if let Some(title) = heading(trimmed) {
            return Some(self.wrap(BOLD, &inline(title, false, false)));
        }
        if trimmed.starts_with('|') {
            return Some(line.to_string());
        }
        if is_rule(trimmed) {
            return Some(self.wrap(DIM, "────────"));
        }
        if let Some(quote) = trimmed.strip_prefix('>') {
            let quote = quote.strip_prefix(' ').unwrap_or(quote);
            return Some(format!(
                "{indent}{}{}",
                self.wrap(DIM, "│ "),
                self.inline(quote)
            ));
        }
        if let Some(item) = ["- ", "* ", "+ "]
            .iter()
            .find_map(|bullet| trimmed.strip_prefix(bullet))
        {
            return Some(format!("{indent}• {}", self.inline(item)));
        }
        Some(self.inline(line))
    }

    fn inline(&self, text: &str) -> String {
        inline(text, self.color, self.hyperlinks)
    }

    fn wrap(&self, (open, close): (&str, &str), text: &str) -> String {
        if self.color && !text.is_empty() {
            format!("{open}{text}{close}")
        } else {
            text.to_string()
        }
    }
}

/// Whether the terminal is likely to show OSC 8 hyperlinks. Terminals that
/// don't understand them may print the escape, so only known ones get them.
pub(crate) fn hyperlinks_supported() -> bool {
    let var = |name: &str| std::env::var(name).unwrap_or_default();
    let program = var("TERM_PROGRAM");
    let term = var("TERM");
    ["iTerm.app", "WezTerm", "vscode", "ghostty"].contains(&program.as_str())
        || ["KITTY_WINDOW_ID", "WT_SESSION", "WEZTERM_EXECUTABLE"]
            .iter()
            .any(|name| std::env::var_os(name).is_some())
        || var("VTE_VERSION")
            .parse::<u32>()
            .is_ok_and(|version| version >= 5000)
        || ["kitty", "ghostty", "foot", "alacritty"]
            .iter()
            .any(|name| term.contains(name))
}

fn heading(line: &str) -> Option<&str> {
    let title = line.trim_start_matches('#');
    let level = line.len() - title.len();
    ((1..=6).contains(&level) && (title.is_empty() || title.starts_with(' '))).then(|| title.trim())
}

fn is_rule(line: &str) -> bool {
    let line: String = line.chars().filter(|char| !char.is_whitespace()).collect();
    line.len() >= 3
        && ['-', '*', '_']
            .iter()
            .any(|mark| line.chars().all(|char| char == *mark))
}

/// Renders inline spans in one line. A marker without its closing partner
/// stays as written.
fn inline(text: &str, color: bool, hyperlinks: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let wrap = |(open, close): (&str, &str), inner: &str| {
        if color {
            format!("{open}{inner}{close}")
        } else {
            inner.to_string()
        }
    };
    let mut out = String::new();
    let mut index = 0;
    while let Some(&char) = chars.get(index) {
        let next = chars.get(index + 1).copied();
        let previous = index.checked_sub(1).and_then(|at| chars.get(at)).copied();
        match char {
            '\\' if next.is_some_and(|next| next.is_ascii_punctuation()) => {
                out.extend(next);
                index += 2;
                continue;
            }
            '`' => {
                if let Some(end) = find(&chars, index + 1, "`") {
                    out.push_str(&wrap(CODE, &collect(&chars, index + 1, end)));
                    index = end + 1;
                    continue;
                }
            }
            '*' | '_' if next == Some(char) => {
                let marker: String = [char, char].iter().collect();
                if let Some(end) = find(&chars, index + 2, &marker).filter(|end| *end > index + 2) {
                    let inner = inline(&collect(&chars, index + 2, end), color, hyperlinks);
                    out.push_str(&wrap(BOLD, &inner));
                    index = end + 2;
                    continue;
                }
            }
            '*' | '_'
                if next.is_some_and(|next| !next.is_whitespace())
                    && (char == '*' || !previous.is_some_and(char::is_alphanumeric)) =>
            {
                let closing = (index + 1..chars.len()).find(|at| {
                    chars.get(*at) == Some(&char)
                        && chars
                            .get(at - 1)
                            .is_some_and(|before| !before.is_whitespace())
                        && (char == '*'
                            || !chars
                                .get(at + 1)
                                .is_some_and(|after| after.is_alphanumeric()))
                });
                if let Some(end) = closing {
                    let inner = inline(&collect(&chars, index + 1, end), color, hyperlinks);
                    out.push_str(&wrap(ITALIC, &inner));
                    index = end + 1;
                    continue;
                }
            }
            '[' => {
                if let Some((label, url, end)) = link(&chars, index) {
                    let label = inline(&label, color, hyperlinks);
                    if hyperlinks {
                        out.push_str(&format!("\u{1b}]8;;{url}\u{1b}\\{label}\u{1b}]8;;\u{1b}\\"));
                    } else if label == url {
                        out.push_str(&url);
                    } else {
                        out.push_str(&format!("{label} ({url})"));
                    }
                    index = end + 1;
                    continue;
                }
            }
            _ => {}
        }
        out.push(char);
        index += 1;
    }
    out
}

/// The index where `marker` next starts at or after `from`.
fn find(chars: &[char], from: usize, marker: &str) -> Option<usize> {
    let marker: Vec<char> = marker.chars().collect();
    (from..chars.len()).find(|at| chars.get(*at..at + marker.len()) == Some(marker.as_slice()))
}

fn collect(chars: &[char], from: usize, to: usize) -> String {
    chars.get(from..to).unwrap_or_default().iter().collect()
}

/// A `[label](url)` starting at `start`: its label, url and closing index.
fn link(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    let close = find(chars, start + 1, "](")?;
    let end = find(chars, close + 2, ")")?;
    let url = collect(chars, close + 2, end);
    if url.is_empty() || url.contains(char::is_whitespace) {
        return None;
    }
    Some((collect(chars, start + 1, close), url, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(markdown: &mut Markdown, deltas: &[&str]) -> String {
        let mut out: String = deltas.iter().map(|delta| markdown.push(delta)).collect();
        out.push_str(&markdown.finish());
        out
    }

    fn plain(deltas: &[&str]) -> String {
        render(&mut Markdown::new(true, false, false), deltas)
    }

    #[test]
    fn headings_turn_bold_without_their_hashes() {
        let mut markdown = Markdown::new(true, true, false);
        assert_eq!(
            render(&mut markdown, &["## Tomorrow\n", "#hashtag\n"]),
            "\u{1b}[1mTomorrow\u{1b}[22m\n#hashtag\n"
        );
    }

    #[test]
    fn lists_get_bullets_and_keep_their_indentation_and_numbers() {
        assert_eq!(
            plain(&["- one\n", "  * nested\n", "1. first\n", "---\n"]),
            "• one\n  • nested\n1. first\n────────\n"
        );
    }

    #[test]
    fn code_fences_drop_their_markers_across_deltas() {
        assert_eq!(
            plain(&[
                "Run:\n``",
                "`sh\nls -",
                "la\n**not bold**\n`",
                "``\nDone **now**"
            ]),
            "Run:\n  ls -la\n  **not bold**\nDone now"
        );
    }

    #[test]
    fn inline_spans_split_across_deltas_render_once_the_line_ends() {
        let mut markdown = Markdown::new(true, true, false);
        assert_eq!(markdown.push("A **bo"), "");
        assert_eq!(markdown.push("ld** and *it"), "");
        assert_eq!(
            markdown.push("alic* with `co"),
            "",
            "nothing prints before the newline"
        );
        assert_eq!(
            markdown.push("de`\n"),
            "A \u{1b}[1mbold\u{1b}[22m and \u{1b}[3mitalic\u{1b}[23m with \u{1b}[36mcode\u{1b}[39m\n"
        );
    }

    #[test]
    fn links_quotes_and_tables() {
        assert_eq!(
            plain(&["See [the docs](https://gsv.space/docs).\n> quoted\n| a | **b** |\n"]),
            "See the docs (https://gsv.space/docs).\n│ quoted\n| a | **b** |\n"
        );
        let mut linked = Markdown::new(true, true, true);
        assert_eq!(
            render(&mut linked, &["[docs](https://x.y)"]),
            "\u{1b}]8;;https://x.y\u{1b}\\docs\u{1b}]8;;\u{1b}\\"
        );
    }

    #[test]
    fn unmatched_markers_and_snake_case_stay_as_written() {
        assert_eq!(
            plain(&["2 * 3 and snake_case_name and **open\n"]),
            "2 * 3 and snake_case_name and **open\n"
        );
    }

    #[test]
    fn text_passes_through_raw_when_not_rendering() {
        let mut raw = Markdown::new(false, true, true);
        assert_eq!(raw.push("**Two** meet"), "**Two** meet");
        assert_eq!(raw.push("ings.\n- 9:00"), "ings.\n- 9:00");
        assert_eq!(raw.finish(), "");
    }
}
