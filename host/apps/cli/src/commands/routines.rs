//! `gsv routines`: things your Ship does on a schedule.
//!
//! Routines made here match the ones the web app makes: a responsibility
//! message on a daily, weekly, interval or cron schedule, or once at a time.

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::{Cadence, RoutinesAction};
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Table, Tone};

const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_NAMES: [&str; 7] = [
    "Sundays",
    "Mondays",
    "Tuesdays",
    "Wednesdays",
    "Thursdays",
    "Fridays",
    "Saturdays",
];

fn parse_time(value: &str) -> Result<(u32, u32), DynError> {
    let (hour, minute) = value
        .trim()
        .split_once(':')
        .ok_or_else(|| format!("`{value}` isn't a time; use HH:MM, such as 09:00"))?;
    let hour: u32 = hour
        .parse()
        .map_err(|_error| format!("`{value}` isn't a time"))?;
    let minute: u32 = minute
        .parse()
        .map_err(|_error| format!("`{value}` isn't a time"))?;
    if hour > 23 || minute > 59 {
        return Err(format!("`{value}` isn't a time of day").into());
    }
    Ok((hour, minute))
}

fn parse_interval(value: &str) -> Result<u64, DynError> {
    let value = value.trim().to_ascii_lowercase();
    let split = value
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(value.len());
    let (amount, unit) = value.split_at(split);
    let amount: u64 = amount
        .parse()
        .map_err(|_error| format!("`{value}` isn't an interval; use 30m, 2h or 1d"))?;
    let unit_ms = match unit.trim() {
        "s" | "sec" | "secs" | "seconds" => 1000,
        "m" | "min" | "mins" | "minutes" => 60_000,
        "h" | "hr" | "hrs" | "hours" => 3_600_000,
        "d" | "day" | "days" => 86_400_000,
        _ => return Err(format!("`{value}` isn't an interval; use 30m, 2h or 1d").into()),
    };
    let every = amount.saturating_mul(unit_ms);
    if every < 1000 {
        return Err("Routines run at most once a second".into());
    }
    Ok(every)
}

fn time_zone(timezone: &str) -> Result<jiff::tz::TimeZone, DynError> {
    jiff::tz::TimeZone::get(timezone)
        .map_err(|error| format!("`{timezone}` isn't a time zone ({error})").into())
}

/// The moment `--at` names, in unix milliseconds: "tomorrow 09:00",
/// "today 18:30", a bare "18:30" (today) or "2026-10-29 18:00", read in
/// `timezone`. A time that has passed is refused.
fn parse_at(value: &str, timezone: &str, now_ms: i64) -> Result<i64, DynError> {
    let zone = time_zone(timezone)?;
    let now = jiff::Timestamp::from_millisecond(now_ms)?.to_zoned(zone.clone());
    let value = value.trim();
    let (day, time) = match value.rsplit_once(' ') {
        Some((day, time)) => (day.trim(), time),
        None => ("today", value),
    };
    let date = match day.to_ascii_lowercase().as_str() {
        "today" => now.date(),
        "tomorrow" => now.date().tomorrow()?,
        _ => day.parse::<jiff::civil::Date>().map_err(|_error| {
            format!("`{day}` isn't a day; use today, tomorrow or a date such as 2026-10-29")
        })?,
    };
    let (hour, minute) = parse_time(time)?;
    let hour = i8::try_from(hour)?;
    let minute = i8::try_from(minute)?;
    let at = date.at(hour, minute, 0, 0).to_zoned(zone)?;
    let at_ms = at.timestamp().as_millisecond();
    if at_ms <= now_ms {
        return Err(format!(
            "{} has already passed in {timezone}",
            at.strftime("%a %-d %b %H:%M")
        )
        .into());
    }
    Ok(at_ms)
}

/// The schedule expression for the cadence flags, or `None` when none was
/// given.
fn expression(cadence: &Cadence, timezone: &str, now_ms: i64) -> Result<Option<Value>, DynError> {
    if let Some(at) = &cadence.at {
        return Ok(Some(
            json!({ "kind": "at", "atMs": parse_at(at, timezone, now_ms)? }),
        ));
    }
    if let Some(time) = &cadence.daily {
        let (hour, minute) = parse_time(time)?;
        return Ok(Some(
            json!({ "kind": "cron", "expr": format!("{minute} {hour} * * *"), "timezone": timezone }),
        ));
    }
    if let Some(weekly) = &cadence.weekly {
        let (day, time) = weekly
            .trim()
            .split_once(' ')
            .ok_or("Give a day and a time, such as \"mon 09:00\"")?;
        let day = day.to_ascii_lowercase();
        let index = WEEKDAYS
            .iter()
            .position(|name| day.starts_with(name))
            .ok_or_else(|| format!("`{day}` isn't a day of the week"))?;
        let (hour, minute) = parse_time(time)?;
        return Ok(Some(
            json!({ "kind": "cron", "expr": format!("{minute} {hour} * * {index}"), "timezone": timezone }),
        ));
    }
    if let Some(every) = &cadence.every {
        return Ok(Some(
            json!({ "kind": "every", "everyMs": parse_interval(every)? }),
        ));
    }
    if let Some(cron) = &cadence.cron {
        let expr = cron.split_whitespace().collect::<Vec<_>>().join(" ");
        if expr.split(' ').count() != 5 {
            return Err("A cron expression has five fields, such as \"0 9 * * 1-5\"".into());
        }
        return Ok(Some(
            json!({ "kind": "cron", "expr": expr, "timezone": timezone }),
        ));
    }
    Ok(None)
}

/// "Daily at 09:00", "Mondays at 08:30", "Every 2 hours", or
/// "once · Thu 29 Oct 18:00" in `timezone`.
fn cadence_label(expression: &Value, timezone: &str) -> String {
    match text(expression, "kind") {
        "at" => {
            let at = number(expression, "atMs")
                .and_then(|at| jiff::Timestamp::from_millisecond(at).ok())
                .zip(time_zone(timezone).ok())
                .map(|(at, zone)| at.to_zoned(zone).strftime("%a %-d %b %H:%M").to_string());
            match at {
                Some(at) => format!("once · {at}"),
                None => "once".to_string(),
            }
        }
        "after" => "After a delay".to_string(),
        "every" => {
            let every = remote::amount(expression, "everyMs");
            let (size, one, many) = [
                (86_400_000, "day", "days"),
                (3_600_000, "hour", "hours"),
                (60_000, "minute", "minutes"),
                (1000, "second", "seconds"),
            ]
            .into_iter()
            .find(|(size, _, _)| every.is_multiple_of(*size))
            .unwrap_or((1000, "second", "seconds"));
            match every / size {
                1 => format!("Every {one}"),
                count => format!("Every {count} {many}"),
            }
        }
        _ => {
            let expr = text(expression, "expr");
            let fields: Vec<&str> = expr.split(' ').collect();
            let simple = match fields.as_slice() {
                [minute, hour, "*", "*", day] => {
                    match (minute.parse::<u32>(), hour.parse::<u32>()) {
                        (Ok(minute), Ok(hour)) if minute < 60 && hour < 24 => {
                            let time = format!("{hour:02}:{minute:02}");
                            if *day == "*" {
                                Some(format!("Daily at {time}"))
                            } else {
                                day.parse::<usize>()
                                    .ok()
                                    .and_then(|day| WEEKDAY_NAMES.get(day))
                                    .map(|day| format!("{day} at {time}"))
                            }
                        }
                        _ => None,
                    }
                }
                _ => None,
            };
            simple.unwrap_or_else(|| format!("{expr} · {}", text(expression, "timezone")))
        }
    }
}

/// The Ship's time zone, as the web app's routine editor reads it.
async fn ship_timezone(client: &KernelClient) -> String {
    let uid = remote::me(client).map(|me| me.uid).unwrap_or_default();
    for key in [
        format!("users/{uid}/locale/timezone"),
        "config/server/timezone".to_string(),
    ] {
        if let Ok(result) = client.sys_config_get(Some(&key)).await {
            if let Some(value) = items(&result, "entries")
                .iter()
                .find(|entry| text(entry, "key") == key)
                .and_then(|entry| opt_text(entry, "value"))
            {
                return value.to_string();
            }
        }
    }
    "UTC".to_string()
}

async fn schedules(client: &KernelClient) -> Result<Vec<Value>, DynError> {
    let result = call(
        client,
        "sched.list",
        json!({ "includeDisabled": true, "limit": 200 }),
    )
    .await?;
    Ok(items(&result, "schedules").to_vec())
}

async fn find(client: &KernelClient, id: &str) -> Result<Value, DynError> {
    let all = schedules(client).await?;
    let found = render::match_id(&all, id, |schedule| text(schedule, "id"), "routine")?;
    Ok(found.clone())
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<RoutinesAction>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let style = out.style;
    match action {
        None => {
            let all = schedules(&client).await?;
            if out.json {
                return render::print_json(&json!({ "schedules": all }));
            }
            if all.is_empty() {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        "No routines yet.",
                        Some("Add one: gsv routines add \"Morning briefing\" \"Plan my day\" --daily 08:00")
                    )
                );
                return Ok(());
            }
            let now = render::now_ms();
            let once = all.iter().any(|schedule| {
                schedule
                    .get("expression")
                    .is_some_and(|expression| text(expression, "kind") == "at")
            });
            let timezone = if once {
                ship_timezone(&client).await
            } else {
                "UTC".to_string()
            };
            let mut table = Table::new(&["Id", "Routine", "When", "Next", "Last run"]).flex(1);
            for schedule in &all {
                let state = schedule.get("state").cloned().unwrap_or(Value::Null);
                let enabled = remote::flag(schedule, "enabled");
                let next = if !enabled {
                    Cell::new("paused", Tone::Warn)
                } else {
                    Cell::new(
                        number(&state, "nextRunAtMs")
                            .map(|at| render::relative_time(at, now))
                            .unwrap_or_else(|| "—".to_string()),
                        Tone::Normal,
                    )
                };
                let last = match (text(&state, "lastStatus"), number(&state, "lastRunAtMs")) {
                    ("ok", Some(at)) => {
                        Cell::new(format!("✓ {}", render::relative_time(at, now)), Tone::Good)
                    }
                    ("error", Some(at)) => {
                        Cell::new(format!("✗ {}", render::relative_time(at, now)), Tone::Bad)
                    }
                    ("skipped", Some(at)) => Cell::new(
                        format!("skipped {}", render::relative_time(at, now)),
                        Tone::Dim,
                    ),
                    _ => Cell::new("never", Tone::Dim),
                };
                table.row(vec![
                    Cell::new(render::short_id(text(schedule, "id")), Tone::Accent),
                    Cell::new(
                        text(schedule, "name"),
                        if enabled { Tone::Strong } else { Tone::Dim },
                    ),
                    cadence_label(
                        schedule.get("expression").unwrap_or(&Value::Null),
                        &timezone,
                    )
                    .into(),
                    next,
                    last,
                ]);
            }
            print!(
                "{}",
                render::heading(&style, "Routines", Some(&all.len().to_string()))
            );
            print!("{}", table.render(&style));
            Ok(())
        }
        Some(RoutinesAction::Add {
            name,
            message,
            cadence,
            timezone,
        }) => {
            let timezone = match timezone {
                Some(timezone) => timezone,
                None => ship_timezone(&client).await,
            };
            let expression = expression(&cadence, &timezone, render::now_ms())?
                .ok_or("Say when it runs: --daily 08:00, --weekly \"mon 09:00\", --every 2h, --cron \"0 9 * * 1-5\" or --at \"tomorrow 09:00\"")?;
            let result = call(
                &client,
                "sched.add",
                json!({
                    "name": name.trim(),
                    "enabled": true,
                    "expression": expression,
                    "target": { "kind": "responsibility", "message": message.trim() },
                }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            let schedule = result.get("schedule").cloned().unwrap_or(Value::Null);
            println!(
                "Added {}. {}.",
                style.strong(text(&schedule, "name")),
                cadence_label(
                    schedule.get("expression").unwrap_or(&Value::Null),
                    &timezone
                )
            );
            if let Some(next) = schedule
                .get("state")
                .and_then(|state| number(state, "nextRunAtMs"))
            {
                print!(
                    "{}",
                    render::hint(
                        &style,
                        &format!(
                            "First run {}.",
                            render::relative_time(next, render::now_ms())
                        )
                    )
                );
            }
            Ok(())
        }
        Some(RoutinesAction::Edit {
            id,
            name,
            message,
            cadence,
            timezone,
            pause,
            resume,
        }) => {
            let schedule = find(&client, &id).await?;
            let existing_timezone = schedule
                .get("expression")
                .and_then(|expression| opt_text(expression, "timezone"))
                .map(str::to_string);
            let timezone = match timezone.or(existing_timezone) {
                Some(timezone) => timezone,
                None => ship_timezone(&client).await,
            };
            let mut patch = json!({});
            if let Some(name) = name {
                patch["name"] = json!(name.trim());
            }
            if let Some(expression) = expression(&cadence, &timezone, render::now_ms())? {
                patch["expression"] = expression;
            }
            if let Some(message) = message {
                let target = schedule.get("target").cloned().unwrap_or(Value::Null);
                if text(&target, "kind") != "responsibility" {
                    return Err(
                        "This routine was set up elsewhere; change what it does in the web app."
                            .into(),
                    );
                }
                let mut target = target;
                target["message"] = json!(message.trim());
                patch["target"] = target;
            }
            if pause {
                patch["enabled"] = json!(false);
            } else if resume {
                patch["enabled"] = json!(true);
            }
            if patch.as_object().is_some_and(serde_json::Map::is_empty) {
                return Err(
                    "Say what to change, such as --daily 07:30, --message \"…\" or --pause".into(),
                );
            }
            let result = call(
                &client,
                "sched.update",
                json!({ "id": text(&schedule, "id"), "patch": patch }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            let updated = result.get("schedule").cloned().unwrap_or(Value::Null);
            let state = if remote::flag(&updated, "enabled") {
                ""
            } else {
                " (paused)"
            };
            println!(
                "Updated {}. {}{state}.",
                style.strong(text(&updated, "name")),
                cadence_label(updated.get("expression").unwrap_or(&Value::Null), &timezone)
            );
            Ok(())
        }
        Some(RoutinesAction::Remove { id }) => {
            let schedule = find(&client, &id).await?;
            let result = call(
                &client,
                "sched.remove",
                json!({ "id": text(&schedule, "id") }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            println!("Removed {}.", style.strong(text(&schedule, "name")));
            Ok(())
        }
        Some(RoutinesAction::Run { id }) => {
            let schedule = find(&client, &id).await?;
            let result = call(
                &client,
                "sched.run",
                json!({ "id": text(&schedule, "id"), "mode": "force" }),
            )
            .await?;
            if out.json {
                render::print_json(&result)?;
            }
            let name = text(&schedule, "name");
            match items(&result, "results").first() {
                Some(run) if text(run, "status") == "error" => {
                    return Err(format!("{name} failed: {}", text(run, "error")).into())
                }
                _ if out.json => {}
                Some(run) if text(run, "status") == "skipped" => {
                    println!("{name} is already running, so this run was skipped.")
                }
                _ => println!("Started {name}. See what it does with: gsv work"),
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cadence(
        daily: Option<&str>,
        weekly: Option<&str>,
        every: Option<&str>,
        cron: Option<&str>,
    ) -> Cadence {
        Cadence {
            daily: daily.map(str::to_string),
            weekly: weekly.map(str::to_string),
            every: every.map(str::to_string),
            cron: cron.map(str::to_string),
            at: None,
        }
    }

    #[test]
    fn cadences_become_the_same_expressions_the_web_app_makes() {
        let tz = "Europe/Madrid";
        assert_eq!(
            expression(&cadence(Some("8:05"), None, None, None), tz, 0).expect("daily"),
            Some(json!({ "kind": "cron", "expr": "5 8 * * *", "timezone": tz }))
        );
        assert_eq!(
            expression(&cadence(None, Some("Monday 09:30"), None, None), tz, 0).expect("weekly"),
            Some(json!({ "kind": "cron", "expr": "30 9 * * 1", "timezone": tz }))
        );
        assert_eq!(
            expression(&cadence(None, None, Some("2h"), None), tz, 0).expect("every"),
            Some(json!({ "kind": "every", "everyMs": 7_200_000 }))
        );
        expression(&cadence(None, None, None, Some("0 9 * *")), tz, 0).expect_err("rejected");
        expression(&cadence(Some("25:00"), None, None, None), tz, 0).expect_err("rejected");
        expression(&cadence(None, Some("someday 09:00"), None, None), tz, 0).expect_err("rejected");
        assert_eq!(expression(&Cadence::default(), tz, 0).expect("none"), None);
    }

    #[test]
    fn cadences_read_back_as_words() {
        assert_eq!(
            cadence_label(
                &json!({ "kind": "cron", "expr": "0 8 * * *", "timezone": "UTC" }),
                "UTC"
            ),
            "Daily at 08:00"
        );
        assert_eq!(
            cadence_label(
                &json!({ "kind": "cron", "expr": "30 9 * * 1", "timezone": "UTC" }),
                "UTC"
            ),
            "Mondays at 09:30"
        );
        assert_eq!(
            cadence_label(
                &json!({ "kind": "cron", "expr": "0 9 * * 1-5", "timezone": "UTC" }),
                "UTC"
            ),
            "0 9 * * 1-5 · UTC"
        );
        assert_eq!(
            cadence_label(&json!({ "kind": "every", "everyMs": 3_600_000 }), "UTC"),
            "Every hour"
        );
        assert_eq!(
            cadence_label(&json!({ "kind": "every", "everyMs": 5_400_000 }), "UTC"),
            "Every 90 minutes"
        );
    }

    #[test]
    fn one_off_times_read_in_the_ships_time_zone_and_refuse_the_past() {
        // Wed 28 Oct 2026, 12:00 in Madrid (11:00 UTC).
        let now = 1_793_185_200_000;
        let tz = "Europe/Madrid";
        let tomorrow = parse_at("tomorrow 09:00", tz, now).expect("tomorrow");
        assert_eq!(tomorrow, 1_793_260_800_000);
        assert_eq!(
            parse_at("2026-10-29 18:00", tz, now).expect("date"),
            1_793_293_200_000
        );
        assert_eq!(
            cadence_label(&json!({ "kind": "at", "atMs": 1_793_293_200_000_i64 }), tz),
            "once · Thu 29 Oct 18:00"
        );
        let error = parse_at("today 09:00", tz, now)
            .expect_err("past")
            .to_string();
        assert!(error.contains("already passed"), "{error}");
        parse_at("someday 09:00", tz, now).expect_err("not a day");
        parse_at("tomorrow 9", tz, now).expect_err("not a time");
        parse_at("tomorrow 09:00", "Mars/Olympus", now).expect_err("not a zone");
    }
}
