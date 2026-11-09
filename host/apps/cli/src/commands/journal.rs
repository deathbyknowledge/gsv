//! `gsv journal`: the Ship's hourly check-ins, drawn as a strip of time.
//!
//! The journal is the owner's file, `pages/journal/YYYY/MM/YYYY-MM-DD.md` in
//! the personal wiki. The Ship appends one `## HH:MM ●|·` entry per check-in
//! (see the built-in `journal` skill); everything else on the page is left out
//! of the strip. The check-ins come from an ordinary routine named Journal.

use std::io::IsTerminal;

use console::{Key, Term};
use gsv::kernel_client::{GatewayAuth, KernelClient};
use jiff::civil::Date;
use serde_json::{json, Value};

use crate::cli::JournalAction;
use crate::commands::{memory, routines};
use crate::remote::{self, call, opt_text, text, DynError, Output};
use crate::render::{self, Style, Tone};

const ROUTINE_NAME: &str = "Journal";
const ROUTINE_MESSAGE: &str = "Journal check-in. Use the journal skill.";
const MAX_STRIP_WIDTH: usize = 120;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Event {
    minute: u32,
    mark: char,
    text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Tick {
    minute: u32,
    acted: bool,
    summary: String,
    events: Vec<Event>,
}

/// Minutes since midnight from `HH:MM`.
fn parse_clock(value: &str) -> Option<u32> {
    let (hour, minute) = value.split_once(':')?;
    let (hour, minute) = (hour.parse::<u32>().ok()?, minute.parse::<u32>().ok()?);
    (hour < 24 && minute < 60 && value.len() == 5).then_some(hour * 60 + minute)
}

fn clock(minute: u32) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

/// The check-ins on one journal page, in the order of their times.
fn parse_day(content: &str) -> Vec<Tick> {
    let mut ticks: Vec<Tick> = Vec::new();
    let mut open = false;
    for line in content.lines() {
        let line = line.trim_end();
        if let Some(heading) = line.strip_prefix("## ") {
            let mut parts = heading.split_whitespace();
            let minute = parts.next().and_then(parse_clock);
            let mark = parts.next();
            open = match (minute, mark) {
                (Some(minute), Some(mark @ ("●" | "·"))) if parts.next().is_none() => {
                    ticks.push(Tick {
                        minute,
                        acted: mark == "●",
                        summary: String::new(),
                        events: Vec::new(),
                    });
                    true
                }
                _ => false,
            };
            continue;
        }
        if line.starts_with('#') {
            open = false;
        }
        let Some(tick) = ticks.last_mut().filter(|_| open) else {
            continue;
        };
        if let Some(item) = line.trim_start().strip_prefix("- ") {
            let (time, rest) = item.split_once(' ').unwrap_or((item, ""));
            if let Some(minute) = parse_clock(time) {
                let rest = rest.trim_start();
                let mut chars = rest.chars();
                let (mark, text) = match chars.next() {
                    Some(mark) if !mark.is_alphanumeric() => (mark, chars.as_str().trim()),
                    _ => ('◆', rest),
                };
                tick.events.push(Event {
                    minute,
                    mark,
                    text: text.to_string(),
                });
                continue;
            }
        }
        if tick.events.is_empty() && !line.trim().is_empty() {
            if !tick.summary.is_empty() {
                tick.summary.push(' ');
            }
            tick.summary.push_str(line.trim());
        }
    }
    ticks.sort_by_key(|tick| tick.minute);
    ticks
}

fn mark_tone(mark: char) -> Tone {
    match mark {
        '✉' => Tone::Accent,
        '✓' => Tone::Good,
        '⚑' => Tone::Warn,
        '✗' => Tone::Bad,
        _ => Tone::Normal,
    }
}

/// A row of single-column cells, painted in runs of one tone.
struct Row(Vec<(char, Tone)>);

impl Row {
    fn new(width: usize, fill: char, tone: Tone) -> Self {
        Self(vec![(fill, tone); width])
    }

    fn put(&mut self, column: usize, value: char, tone: Tone) {
        if let Some(cell) = self.0.get_mut(column) {
            *cell = (value, tone);
        }
    }

    fn is_blank(&self, column: usize) -> bool {
        self.0.get(column).is_some_and(|(value, _)| *value == ' ')
    }

    fn render(&self, style: &Style) -> String {
        let mut out = String::new();
        let mut run = String::new();
        let mut tone = Tone::Normal;
        for (value, cell_tone) in &self.0 {
            if *cell_tone != tone && !run.is_empty() {
                out.push_str(&style.paint(tone, &run));
                run.clear();
            }
            tone = *cell_tone;
            run.push(*value);
        }
        out.push_str(&style.paint(tone, &run));
        out.trim_end().to_string()
    }
}

/// The day as a line of check-ins with the events that landed between them:
///
/// ```text
/// ──·──────●──────·──▶
///    ╲ ✉ ✓  ╲      ╲
/// 08     09     10
/// ```
fn render_strip(ticks: &[Tick], selected: Option<usize>, style: &Style) -> String {
    let times = ticks
        .iter()
        .flat_map(|tick| std::iter::once(tick.minute).chain(tick.events.iter().map(|e| e.minute)));
    let (Some(first), Some(last)) = (times.clone().min(), times.max()) else {
        return String::new();
    };
    let start = first / 60 * 60;
    let hours = (last.div_ceil(60) * 60)
        .saturating_sub(start)
        .div_ceil(60)
        .max(1) as usize;
    let lead = 2;
    let available = style.width().min(MAX_STRIP_WIDTH).saturating_sub(lead + 4);
    let per_hour = (available / hours).max(3);
    let width = lead + hours * per_hour + 1;
    let column = |minute: u32| lead + (minute.saturating_sub(start) as usize * per_hour) / 60;

    let mut line = Row::new(width, '─', Tone::Dim);
    let mut below = Row::new(width + 1, ' ', Tone::Normal);
    for (index, tick) in ticks.iter().enumerate() {
        let at = column(tick.minute);
        let tone = if selected == Some(index) {
            Tone::Strong
        } else if tick.acted {
            Tone::Accent
        } else {
            Tone::Normal
        };
        line.put(at, if tick.acted { '●' } else { '·' }, tone);
        below.put(at + 1, '╲', Tone::Dim);
    }
    for event in ticks.iter().flat_map(|tick| &tick.events) {
        let mut at = column(event.minute);
        while !below.is_blank(at) && at < width {
            at += 1;
        }
        below.put(at, event.mark, mark_tone(event.mark));
    }

    let mut labels = Row::new(width + 1, ' ', Tone::Dim);
    let step = 3_usize.div_ceil(per_hour).max(1);
    for hour in (0..=hours).step_by(step) {
        let at = lead + hour * per_hour;
        for (offset, digit) in format!("{:02}", (start / 60) as usize + hour)
            .chars()
            .enumerate()
        {
            labels.put(at + offset, digit, Tone::Dim);
        }
    }

    let mut out = format!("{}{}\n", line.render(style), style.dim("──▶"));
    out.push_str(&format!("{}\n", below.render(style)));
    out.push_str(&format!("{}\n", labels.render(style)));
    if let Some(tick) = selected.and_then(|index| ticks.get(index)) {
        let mut caret = Row::new(width, ' ', Tone::Normal);
        caret.put(column(tick.minute), '▲', Tone::Strong);
        out.push_str(&format!("{}\n", caret.render(style)));
    }
    out
}

fn render_tick(tick: &Tick, style: &Style) -> String {
    let mark = if tick.acted {
        style.paint(Tone::Accent, "●")
    } else {
        style.dim("·")
    };
    let summary = if tick.summary.is_empty() {
        style.dim("Nothing written.")
    } else {
        tick.summary.clone()
    };
    let mut out = format!("{} {mark} {summary}\n", style.strong(&clock(tick.minute)));
    for event in &tick.events {
        out.push_str(&format!(
            "   {} {} {}\n",
            style.dim(&clock(event.minute)),
            style.paint(mark_tone(event.mark), &event.mark.to_string()),
            event.text
        ));
    }
    out
}

fn day_title(date: Date) -> String {
    date.strftime("%a %-d %b %Y").to_string()
}

fn page_path(date: Date) -> String {
    format!(
        "pages/journal/{}/{:02}/{date}.md",
        date.year(),
        date.month()
    )
}

/// Today, yesterday or YYYY-MM-DD, in the Ship's time zone.
fn parse_date(value: Option<&str>, timezone: &str) -> Result<Date, DynError> {
    let today = jiff::Timestamp::now()
        .to_zoned(jiff::tz::TimeZone::get(timezone).unwrap_or(jiff::tz::TimeZone::UTC))
        .date();
    match value.map(str::trim) {
        None | Some("today") => Ok(today),
        Some("yesterday") => Ok(today.yesterday()?),
        Some(value) => value.parse::<Date>().map_err(|_unparsed| {
            format!("Give a day as today, yesterday or YYYY-MM-DD, not `{value}`").into()
        }),
    }
}

struct Journal {
    client: KernelClient,
    repo: String,
}

impl Journal {
    async fn open(client: KernelClient) -> Result<Self, DynError> {
        let wikis = memory::wikis(&client).await?;
        let repo = memory::find_wiki(&wikis, "personal")
            .map(|wiki| wiki.repo.clone())
            .ok_or("Your Ship has no personal wiki yet.")?;
        Ok(Self { client, repo })
    }

    async fn day(&self, date: Date) -> Result<Vec<Tick>, DynError> {
        let read = call(
            &self.client,
            "repo.read",
            json!({ "repo": self.repo, "path": page_path(date) }),
        )
        .await;
        match read {
            Ok(read) => Ok(parse_day(opt_text(&read, "content").unwrap_or_default())),
            Err(error) if error.to_string().contains("Path not found") => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }
}

fn render_day(date: Date, ticks: &[Tick], selected: Option<usize>, style: &Style) -> String {
    let acted = ticks.iter().filter(|tick| tick.acted).count();
    let note = if ticks.is_empty() {
        String::new()
    } else {
        format!(
            "{} · {acted} acted",
            render::count(ticks.len(), "check-in", "check-ins")
        )
    };
    let mut out = render::heading(style, &day_title(date), Some(&note));
    if ticks.is_empty() {
        out.push_str(&render::empty(style, "No check-ins on this day.", None));
        return out;
    }
    out.push('\n');
    out.push_str(&render_strip(ticks, selected, style));
    out
}

async fn browse(journal: &Journal, mut date: Date, style: &Style) -> Result<(), DynError> {
    let term = Term::stdout();
    term.hide_cursor()?;
    let _cursor = ShownOnDrop(term.clone());
    let mut ticks = journal.day(date).await?;
    let mut selected = ticks.len().checked_sub(1);
    let mut drawn = 0;
    let outcome = loop {
        let mut screen = render_day(date, &ticks, selected, style);
        if let Some(tick) = selected.and_then(|index| ticks.get(index)) {
            screen.push('\n');
            screen.push_str(&render_tick(tick, style));
        }
        screen.push('\n');
        screen.push_str(&render::hint(style, "←/→ check-ins · ↑/↓ days · q quit"));
        term.clear_last_lines(drawn)?;
        term.write_str(&screen)?;
        drawn = screen.lines().count();

        let key = match term.read_key() {
            Ok(key) => key,
            Err(error) => break Err(error.into()),
        };
        let day = match key {
            Key::ArrowLeft | Key::Char('h') => {
                selected = selected.map(|index| index.saturating_sub(1));
                None
            }
            Key::ArrowRight | Key::Char('l') => {
                selected = selected.map(|index| (index + 1).min(ticks.len().saturating_sub(1)));
                None
            }
            Key::ArrowUp | Key::Char('k') => date.yesterday().ok(),
            Key::ArrowDown | Key::Char('j') => date.tomorrow().ok(),
            Key::Char('q') | Key::Escape | Key::Enter => break Ok(()),
            _ => None,
        };
        if let Some(day) = day {
            date = day;
            ticks = match journal.day(date).await {
                Ok(ticks) => ticks,
                Err(error) => break Err(error),
            };
            selected = ticks.len().checked_sub(1);
        }
    };
    outcome
}

/// Gives the cursor back however browsing ends.
struct ShownOnDrop(Term);

impl Drop for ShownOnDrop {
    fn drop(&mut self) {
        if let Err(error) = self.0.show_cursor() {
            eprintln!("{error}");
        }
    }
}

async fn journal_routines(client: &KernelClient) -> Result<Vec<Value>, DynError> {
    Ok(routines::schedules(client)
        .await?
        .into_iter()
        .filter(|schedule| {
            text(schedule, "name") == ROUTINE_NAME
                && schedule
                    .get("target")
                    .is_some_and(|target| text(target, "kind") == "responsibility")
        })
        .collect())
}

/// `7-23` as the hours a check-in runs, on the hour.
fn parse_hours(value: &str) -> Result<(u32, u32), DynError> {
    let (from, to) = value
        .split_once('-')
        .and_then(|(from, to)| {
            Some((
                from.trim().parse::<u32>().ok()?,
                to.trim().parse::<u32>().ok()?,
            ))
        })
        .filter(|(from, to)| from <= to && *to < 24)
        .ok_or_else(|| {
            format!("Give hours as FROM-TO between 0 and 23, such as 7-23, not `{value}`")
        })?;
    Ok((from, to))
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<JournalAction>,
    day: Option<String>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let style = out.style;
    match action {
        Some(JournalAction::On { hours }) => {
            let (from, to) = parse_hours(&hours)?;
            if let Some(existing) = journal_routines(&client).await?.first() {
                let paused = if remote::flag(existing, "enabled") {
                    ""
                } else {
                    " It is paused; resume it with: gsv routines edit ID --resume"
                };
                println!("Your journal is already on.{paused}");
                return Ok(());
            }
            let result = call(
                &client,
                "sched.add",
                json!({
                    "name": ROUTINE_NAME,
                    "description": "Hourly check-ins written to your journal",
                    "enabled": true,
                    "expression": {
                        "kind": "cron",
                        "expr": format!("0 {from}-{to} * * *"),
                        "timezone": routines::ship_timezone(&client).await,
                    },
                    "target": { "kind": "responsibility", "message": ROUTINE_MESSAGE },
                }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            println!(
                "Your journal is on. Your Ship checks in every hour from {from:02}:00 to {to:02}:00."
            );
            print!("{}", render::hint(&style, "See a day with: gsv journal"));
            Ok(())
        }
        Some(JournalAction::Now) => {
            let schedule = journal_routines(&client)
                .await?
                .into_iter()
                .next()
                .ok_or("Your journal is off. Turn it on with: gsv journal on")?;
            let result = call(
                &client,
                "sched.run",
                json!({ "id": text(&schedule, "id"), "mode": "force" }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            match remote::items(&result, "results").first() {
                Some(run) if text(run, "status") == "error" => {
                    Err(format!("The check-in failed: {}", text(run, "error")).into())
                }
                Some(run) if text(run, "status") == "skipped" => {
                    println!("A check-in is already running.");
                    Ok(())
                }
                _ => {
                    println!("Your Ship is checking in now.");
                    print!(
                        "{}",
                        render::hint(&style, "See it in a moment with: gsv journal")
                    );
                    Ok(())
                }
            }
        }
        Some(JournalAction::Off) => {
            let found = journal_routines(&client).await?;
            for schedule in &found {
                call(
                    &client,
                    "sched.remove",
                    json!({ "id": text(schedule, "id") }),
                )
                .await?;
            }
            if out.json {
                return render::print_json(&json!({ "removed": found.len() }));
            }
            println!(
                "{}",
                if found.is_empty() {
                    "Your journal was already off."
                } else {
                    "Your journal is off. What it wrote stays in your personal wiki."
                }
            );
            Ok(())
        }
        None => {
            let timezone = routines::ship_timezone(&client).await;
            let date = parse_date(day.as_deref(), &timezone)?;
            let journal = Journal::open(client).await?;
            let ticks = journal.day(date).await?;
            if out.json {
                return render::print_json(&json!({
                    "date": date.to_string(),
                    "path": format!("personal/{}", page_path(date)),
                    "checkIns": ticks.iter().map(|tick| json!({
                        "time": clock(tick.minute),
                        "acted": tick.acted,
                        "summary": tick.summary,
                        "events": tick.events.iter().map(|event| json!({
                            "time": clock(event.minute),
                            "mark": event.mark.to_string(),
                            "text": event.text,
                        })).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                }));
            }
            if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
                return browse(&journal, date, &style).await;
            }
            print!("{}", render_day(date, &ticks, None, &style));
            if ticks.is_empty() && journal_routines(&journal.client).await?.is_empty() {
                print!(
                    "{}",
                    render::hint(&style, "Turn it on with: gsv journal on")
                );
            }
            for tick in &ticks {
                println!();
                print!("{}", render_tick(tick, &style));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "# 2026-11-09

## 09:00 ·
Quiet. Mail from Ana can wait until tonight.

- 08:42 ✉ Ana asked about Saturday

## Bought a new kettle

Not a check-in, so the strip leaves it out.

## 10:00 ●
Reminded you about the dentist
at 15:00.

- 09:20 ⚑ Dentist confirmation needs a reply
- 09:55 ✓ Flight search finished
- 09:58 plain text gets a mark
";

    #[test]
    fn check_ins_are_read_from_their_headings_and_other_entries_are_ignored() {
        let ticks = parse_day(PAGE);
        assert_eq!(ticks.len(), 2);
        assert_eq!(
            (ticks[0].minute, ticks[0].acted, ticks[0].summary.as_str()),
            (540, false, "Quiet. Mail from Ana can wait until tonight.")
        );
        assert_eq!(ticks[0].events.len(), 1);
        assert_eq!(ticks[1].summary, "Reminded you about the dentist at 15:00.");
        assert_eq!(
            ticks[1]
                .events
                .iter()
                .map(|event| (clock(event.minute), event.mark))
                .collect::<Vec<_>>(),
            vec![
                ("09:20".to_string(), '⚑'),
                ("09:55".to_string(), '✓'),
                ("09:58".to_string(), '◆')
            ]
        );
        assert!(parse_day("## 9:00 ●\n## 25:00 ·\n## 10:00 done\n").is_empty());
    }

    #[test]
    fn the_strip_places_check_ins_and_events_on_the_hours() {
        let style = Style::plain(40);
        let strip = render_strip(&parse_day(PAGE), Some(1), &style);
        let lines: Vec<&str> = strip.lines().collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[0].starts_with("──"));
        assert!(lines[0].ends_with("──▶"));
        let dot = lines[0].chars().position(|c| c == '·').expect("quiet tick");
        let acted = lines[0].chars().position(|c| c == '●').expect("acted tick");
        assert!(dot < acted);
        assert_eq!(lines[1].chars().nth(dot + 1), Some('╲'));
        for mark in ['✉', '⚑', '✓', '◆'] {
            assert!(lines[1].contains(mark), "{mark} in {}", lines[1]);
        }
        assert!(lines[2].trim_start().starts_with("08"));
        assert_eq!(lines[3].chars().position(|c| c == '▲'), Some(acted));
    }

    #[test]
    fn days_and_hours_parse_the_way_people_type_them() {
        assert_eq!(
            parse_date(Some("2026-11-09"), "UTC")
                .expect("date")
                .to_string(),
            "2026-11-09"
        );
        parse_date(Some("monday"), "UTC").expect_err("rejected");
        assert_eq!(
            page_path("2026-03-04".parse().expect("date")),
            "pages/journal/2026/03/2026-03-04.md"
        );
        assert_eq!(parse_hours("7-23").expect("hours"), (7, 23));
        parse_hours("23-7").expect_err("backwards");
        parse_hours("7-24").expect_err("out of range");
    }
}
