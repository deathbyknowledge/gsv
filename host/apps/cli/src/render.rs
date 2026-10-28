//! Terminal rendering shared by every human-facing command.
//!
//! Commands build tables, detail blocks and empty states from plain text and
//! a tone; this module owns alignment, truncation to the terminal width and
//! colour. Colour appears only on a terminal and never when `NO_COLOR` is set.
//! `--json` output bypasses this module and prints the structured result.

use std::io::IsTerminal;

use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::Value;

const DEFAULT_WIDTH: usize = 100;
const MIN_FLEX_WIDTH: usize = 12;
const COLUMN_GAP: &str = "  ";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Normal,
    Strong,
    Dim,
    Accent,
    Good,
    Warn,
    Bad,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Style {
    color: bool,
    width: usize,
}

impl Style {
    /// The style for standard output: colour on a terminal unless `NO_COLOR`
    /// or `TERM=dumb`, and the terminal's width.
    pub(crate) fn stdout() -> Self {
        let terminal = std::io::stdout().is_terminal();
        Self {
            color: terminal && color_allowed(),
            // Piped output keeps the same shape as a default terminal.
            width: if terminal {
                terminal_width()
            } else {
                env_width().unwrap_or(DEFAULT_WIDTH)
            },
        }
    }

    /// The style for standard error, used for progress and prompts.
    pub(crate) fn stderr() -> Self {
        let terminal = std::io::stderr().is_terminal();
        Self {
            color: terminal && color_allowed(),
            width: terminal_width(),
        }
    }

    #[cfg(test)]
    pub(crate) fn plain(width: usize) -> Self {
        Self {
            color: false,
            width,
        }
    }

    pub(crate) fn width(&self) -> usize {
        self.width
    }

    pub(crate) fn paint(&self, tone: Tone, text: &str) -> String {
        if !self.color || text.is_empty() {
            return text.to_string();
        }
        let code = match tone {
            Tone::Normal => return text.to_string(),
            Tone::Strong => "1",
            Tone::Dim => "2",
            Tone::Accent => "36",
            Tone::Good => "32",
            Tone::Warn => "33",
            Tone::Bad => "31",
        };
        format!("\u{1b}[{code}m{text}\u{1b}[0m")
    }

    pub(crate) fn strong(&self, text: &str) -> String {
        self.paint(Tone::Strong, text)
    }

    pub(crate) fn dim(&self, text: &str) -> String {
        self.paint(Tone::Dim, text)
    }
}

fn color_allowed() -> bool {
    let no_color = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
    let dumb = std::env::var("TERM").is_ok_and(|term| term == "dumb");
    !no_color && !dumb
}

fn env_width() -> Option<usize> {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|width| *width >= 20)
}

fn terminal_width() -> usize {
    env_width()
        .or_else(platform_terminal_width)
        .unwrap_or(DEFAULT_WIDTH)
}

#[cfg(unix)]
fn platform_terminal_width() -> Option<usize> {
    let mut size = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCGWINSZ writes one `winsize` into the pointer, which refers
    // to a live, correctly typed local; failure leaves it untouched.
    let result = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) };
    (result == 0 && size.ws_col >= 20).then_some(usize::from(size.ws_col))
}

#[cfg(not(unix))]
fn platform_terminal_width() -> Option<usize> {
    None
}

/// Display width, counted in characters. Wide glyphs are rare in these
/// tables, and an approximation keeps the module dependency-free.
pub(crate) fn width_of(text: &str) -> usize {
    text.chars().count()
}

/// Shortens text to `max` characters, ending in an ellipsis when cut.
pub(crate) fn truncate(text: &str, max: usize) -> String {
    if width_of(text) <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut cut: String = text.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// Collapses line breaks and runs of whitespace so a preview fits one row.
pub(crate) fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn pad(text: &str, width: usize) -> String {
    let fill = width.saturating_sub(width_of(text));
    format!("{text}{}", " ".repeat(fill))
}

/// A short, copyable form of an opaque id: the part after its `kind:` prefix,
/// cut to eight characters. Commands accept it back through [`match_id`].
pub(crate) fn short_id(id: &str) -> String {
    let body = id.rsplit([':', '_']).next().unwrap_or(id);
    let body = if body.is_empty() { id } else { body };
    body.chars().take(8).collect()
}

/// Whether `input` names `id`: the whole id, or a prefix of its short form.
pub(crate) fn id_matches(id: &str, input: &str) -> bool {
    let input = input.trim();
    if input.is_empty() {
        return false;
    }
    if id == input {
        return true;
    }
    let body = id.rsplit([':', '_']).next().unwrap_or(id);
    body.starts_with(input)
}

/// Finds the one item whose id `input` names, or explains why none or
/// several match. `noun` names the kind of thing in the error.
pub(crate) fn match_id<'a, T>(
    items: &'a [T],
    input: &str,
    id: impl Fn(&T) -> &str,
    noun: &str,
) -> Result<&'a T, String> {
    let matches: Vec<&T> = items
        .iter()
        .filter(|item| id_matches(id(item), input))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] => Err(format!("No {noun} matches `{input}`.")),
        several => Err(format!(
            "`{input}` matches {} {noun}s: {}. Use more characters.",
            several.len(),
            several
                .iter()
                .map(|item| short_id(id(item)))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub(crate) fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", then a
/// date. Future times read "in 5 min", "in 2 h", "tomorrow", "in 3 days".
pub(crate) fn relative_time(at_ms: i64, now_ms: i64) -> String {
    let delta = now_ms.saturating_sub(at_ms);
    let future = delta < 0;
    let seconds = delta.unsigned_abs() / 1000;
    // Round to the nearest unit, so a session ending in 5 h 59 min reads as 6 h.
    let minutes = (seconds + 30) / 60;
    let hours = (minutes + 30) / 60;
    let days = hours / 24;
    let phrase = |amount: u64, unit: &str| {
        if future {
            format!("in {amount} {unit}")
        } else {
            format!("{amount} {unit} ago")
        }
    };
    if seconds < 45 {
        return if future { "in a moment" } else { "just now" }.to_string();
    }
    if minutes < 60 {
        return phrase(minutes.max(1), "min");
    }
    if hours < 24 {
        return phrase(hours, "h");
    }
    if days == 1 {
        return if future { "tomorrow" } else { "yesterday" }.to_string();
    }
    if days < 7 {
        return phrase(days, "days");
    }
    calendar_date(at_ms, now_ms)
}

fn local_time(at_ms: i64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(at_ms).single()
}

fn calendar_date(at_ms: i64, now_ms: i64) -> String {
    let (Some(at), Some(now)) = (local_time(at_ms), local_time(now_ms)) else {
        return at_ms.to_string();
    };
    if at.format("%Y").to_string() == now.format("%Y").to_string() {
        at.format("%-d %b").to_string()
    } else {
        at.format("%-d %b %Y").to_string()
    }
}

/// An absolute local time for detail views, such as "Tue 28 Oct, 14:05".
pub(crate) fn local_timestamp(at_ms: i64) -> String {
    local_time(at_ms)
        .map(|at| at.format("%a %-d %b %Y, %H:%M").to_string())
        .unwrap_or_else(|| at_ms.to_string())
}

/// Decimal sizes, as people see them in file managers: "820 B", "1.4 MB".
pub(crate) fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["KB", "MB", "GB", "TB", "PB"];
    if bytes < 1000 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1000.0;
    let mut unit = UNITS[0];
    for next in UNITS.iter().skip(1) {
        if value < 999.95 {
            break;
        }
        value /= 1000.0;
        unit = next;
    }
    if value < 10.0 {
        format!("{value:.1} {unit}")
    } else {
        format!("{value:.0} {unit}")
    }
}

/// "1 message", "3 messages".
pub(crate) fn count(amount: usize, singular: &str, plural: &str) -> String {
    if amount == 1 {
        format!("1 {singular}")
    } else {
        format!("{amount} {plural}")
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Cell {
    text: String,
    tone: Tone,
}

impl Cell {
    pub(crate) fn new(text: impl Into<String>, tone: Tone) -> Self {
        Self {
            text: one_line(&text.into()),
            tone,
        }
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }
}

impl From<String> for Cell {
    fn from(text: String) -> Self {
        Self::new(text, Tone::Normal)
    }
}

impl From<&str> for Cell {
    fn from(text: &str) -> Self {
        Self::new(text, Tone::Normal)
    }
}

/// Aligned columns. One column is marked flexible; it absorbs the cut when
/// the row would be wider than the terminal. Headers are optional: a list of
/// people or files reads better without them.
pub(crate) struct Table {
    headers: Option<Vec<String>>,
    rows: Vec<Vec<Cell>>,
    flex: usize,
    limits: Vec<(usize, usize)>,
}

impl Table {
    pub(crate) fn new(headers: &[&str]) -> Self {
        Self {
            headers: Some(headers.iter().map(|header| header.to_string()).collect()),
            rows: Vec::new(),
            flex: headers.len().saturating_sub(1),
            limits: Vec::new(),
        }
    }

    pub(crate) fn bare() -> Self {
        Self {
            headers: None,
            rows: Vec::new(),
            flex: usize::MAX,
            limits: Vec::new(),
        }
    }

    /// Marks the column that shrinks to fit the terminal width.
    pub(crate) fn flex(mut self, column: usize) -> Self {
        self.flex = column;
        self
    }

    /// Caps a column, such as a sender's name, so one long value can't push
    /// the flexible column off the screen.
    pub(crate) fn limit(mut self, column: usize, width: usize) -> Self {
        self.limits.push((column, width));
        self
    }

    pub(crate) fn row(&mut self, cells: Vec<Cell>) {
        self.rows.push(cells);
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub(crate) fn render(&self, style: &Style) -> String {
        let columns = self
            .rows
            .iter()
            .map(Vec::len)
            .chain(self.headers.iter().map(Vec::len))
            .max()
            .unwrap_or(0);
        if columns == 0 {
            return String::new();
        }
        let flex = if self.flex < columns {
            self.flex
        } else {
            columns - 1
        };
        let mut widths = vec![0usize; columns];
        for (index, width) in widths.iter_mut().enumerate() {
            let header = self
                .headers
                .as_ref()
                .and_then(|headers| headers.get(index))
                .map(|header| width_of(header))
                .unwrap_or(0);
            let cells = self
                .rows
                .iter()
                .filter_map(|row| row.get(index))
                .map(|cell| width_of(&cell.text))
                .max()
                .unwrap_or(0);
            *width = header.max(cells);
        }
        for (column, limit) in &self.limits {
            if let Some(width) = widths.get_mut(*column) {
                *width = (*width).min(*limit);
            }
        }
        let gaps = width_of(COLUMN_GAP) * columns.saturating_sub(1);
        let fixed: usize = widths
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != flex)
            .map(|(_, width)| *width)
            .sum();
        let room = style.width().saturating_sub(fixed + gaps);
        if let Some(width) = widths.get_mut(flex) {
            *width = (*width).min(room.max(MIN_FLEX_WIDTH));
        }

        let mut out = String::new();
        if let Some(headers) = &self.headers {
            let cells: Vec<Cell> = headers
                .iter()
                .map(|header| Cell::new(header.clone(), Tone::Dim))
                .collect();
            out.push_str(&render_row(&cells, &widths, style));
            out.push('\n');
        }
        for row in &self.rows {
            out.push_str(&render_row(row, &widths, style));
            out.push('\n');
        }
        out
    }
}

fn render_row(cells: &[Cell], widths: &[usize], style: &Style) -> String {
    let last = cells.len().saturating_sub(1);
    let mut line = String::new();
    for (index, cell) in cells.iter().enumerate() {
        let width = widths.get(index).copied().unwrap_or(0);
        let text = truncate(&cell.text, width);
        let text = if index == last {
            text
        } else {
            pad(&text, width)
        };
        if index > 0 {
            line.push_str(COLUMN_GAP);
        }
        line.push_str(&style.paint(cell.tone, &text));
    }
    line.trim_end().to_string()
}

/// A title line with an optional dim note, such as "Work  3 running".
pub(crate) fn heading(style: &Style, title: &str, note: Option<&str>) -> String {
    match note {
        Some(note) if !note.is_empty() => {
            format!("{}  {}\n", style.strong(title), style.dim(note))
        }
        _ => format!("{}\n", style.strong(title)),
    }
}

/// Label and value pairs with the labels aligned, for one record.
pub(crate) fn detail(style: &Style, rows: &[(&str, Cell)]) -> String {
    let label_width = rows
        .iter()
        .map(|(label, _)| width_of(label))
        .max()
        .unwrap_or(0);
    let value_width = style
        .width()
        .saturating_sub(label_width + width_of(COLUMN_GAP))
        .max(MIN_FLEX_WIDTH);
    let mut out = String::new();
    for (label, value) in rows {
        out.push_str(&format!(
            "{}{COLUMN_GAP}{}\n",
            style.dim(&pad(label, label_width)),
            style.paint(value.tone, &truncate(&value.text, value_width)),
        ));
    }
    out
}

/// What an empty list says: what is missing, and what to do next.
pub(crate) fn empty(style: &Style, message: &str, next: Option<&str>) -> String {
    match next {
        Some(next) => format!("{message}\n{}\n", style.dim(next)),
        None => format!("{message}\n"),
    }
}

/// A dim footer line, such as the command that shows the next page.
pub(crate) fn hint(style: &Style, text: &str) -> String {
    format!("{}\n", style.dim(text))
}

pub(crate) fn print_json(value: &Value) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60_000;
    const HOUR: i64 = 60 * MINUTE;
    const DAY: i64 = 24 * HOUR;

    #[test]
    fn relative_times_read_like_speech() {
        let now = 1_800_000_000_000;
        assert_eq!(relative_time(now - 10_000, now), "just now");
        assert_eq!(relative_time(now - 5 * MINUTE, now), "5 min ago");
        assert_eq!(relative_time(now - 2 * HOUR, now), "2 h ago");
        assert_eq!(relative_time(now - DAY - HOUR, now), "yesterday");
        assert_eq!(relative_time(now - 3 * DAY, now), "3 days ago");
        assert_eq!(relative_time(now + 3 * HOUR, now), "in 3 h");
        assert_eq!(relative_time(now + 6 * HOUR - 1_000, now), "in 6 h");
        assert_eq!(relative_time(now + DAY + HOUR, now), "tomorrow");
        assert!(!relative_time(now - 40 * DAY, now).contains("ago"));
    }

    #[test]
    fn sizes_use_decimal_units() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(999), "999 B");
        assert_eq!(human_size(1_400), "1.4 KB");
        assert_eq!(human_size(52_000), "52 KB");
        assert_eq!(human_size(3_200_000), "3.2 MB");
        assert_eq!(human_size(999_999), "1.0 MB");
        assert_eq!(human_size(7_000_000_000), "7.0 GB");
    }

    #[test]
    fn short_ids_drop_the_kind_and_resolve_back() {
        assert_eq!(short_id("proc:8f3a2c41-1111-2222"), "8f3a2c41");
        assert_eq!(short_id("mail:abcdef0123456789"), "abcdef01");
        assert_eq!(short_id("plain"), "plain");
        let ids = vec!["proc:8f3a2c41".to_string(), "proc:8f9b0000".to_string()];
        assert_eq!(
            match_id(&ids, "8f3", |id| id.as_str(), "process"),
            Ok(&ids[0])
        );
        let error = match_id(&ids, "8f", |id| id.as_str(), "process").expect_err("ambiguous");
        assert!(error.contains("8f3a2c41") && error.contains("8f9b0000"));
        match_id(&ids, "zz", |id| id.as_str(), "process").expect_err("rejected");
        assert_eq!(
            match_id(&ids, "proc:8f9b0000", |id| id.as_str(), "process"),
            Ok(&ids[1])
        );
    }

    #[test]
    fn limited_columns_stop_one_long_value_pushing_the_table_wide() {
        let mut table = Table::new(&["From", "Subject", "When"])
            .flex(1)
            .limit(0, 10);
        table.row(vec![
            "A sender with a very long name".into(),
            "s".repeat(200).into(),
            "2 h ago".into(),
        ]);
        let rendered = table.render(&Style::plain(60));
        let row = rendered.lines().nth(1).expect("row");
        assert!(row.starts_with("A sender …  sss"), "{row}");
        assert!(row.ends_with("…  2 h ago"), "{row}");
        assert_eq!(width_of(row), 60);
    }

    #[test]
    fn tables_align_and_cut_the_flexible_column() {
        let mut table = Table::new(&["Name", "When", "About"]).flex(2);
        table.row(vec!["Ana".into(), "2 h ago".into(), "x".repeat(80).into()]);
        table.row(vec![
            "Bartholomew".into(),
            "yesterday".into(),
            "short".into(),
        ]);
        let rendered = table.render(&Style::plain(40));
        let lines: Vec<&str> = rendered.lines().collect();
        assert_eq!(lines[0], "Name         When       About");
        assert!(lines[1].starts_with("Ana          2 h ago    xxx"));
        assert!(lines[1].ends_with('…'));
        assert!(lines.iter().all(|line| width_of(line) <= 40));
        assert_eq!(lines[2], "Bartholomew  yesterday  short");
    }

    #[test]
    fn plain_style_never_emits_escape_codes() {
        let style = Style::plain(80);
        assert_eq!(style.paint(Tone::Bad, "failed"), "failed");
        let block = detail(
            &style,
            &[
                ("Signed in", Cell::new("yes", Tone::Good)),
                ("Space", "me.ship.space".into()),
            ],
        );
        assert_eq!(block, "Signed in  yes\nSpace      me.ship.space\n");
        assert!(!block.contains('\u{1b}'));
    }

    #[test]
    fn empty_states_say_what_to_do_next() {
        let style = Style::plain(80);
        assert_eq!(
            empty(
                &style,
                "No routines yet.",
                Some("Add one: gsv routines add")
            ),
            "No routines yet.\nAdd one: gsv routines add\n"
        );
    }
}
