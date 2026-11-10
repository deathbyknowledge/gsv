//! `gsv clock`: the Ship's hourly check-in.
//!
//! The clock is an ordinary Ship routine named Clock. Each tick wakes the Ship
//! with the built-in check-in skill, which asks what the owner would want done
//! now. Most ticks end silently; anything the Ship does is ordinary work.

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::ClockAction;
use crate::commands::routines;
use crate::remote::{self, call, number, text, DynError, Output};
use crate::render;

const ROUTINE_NAME: &str = "Clock";
const ROUTINE_MESSAGE: &str = "Clock tick. Use the check-in skill.";

async fn clock_routines(client: &KernelClient) -> Result<Vec<Value>, DynError> {
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

/// `7-23` as the hours a tick runs, on the hour.
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

/// The hours of a `0 FROM-TO * * *` cron line, as `07:00–23:00`.
fn hours_label(schedule: &Value) -> Option<String> {
    let expression = schedule.get("expression")?;
    let hours = text(expression, "expr").split_whitespace().nth(1)?;
    let (from, to) = parse_hours(hours).ok()?;
    Some(format!("{from:02}:00–{to:02}:00"))
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<ClockAction>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let style = out.style;
    match action {
        Some(ClockAction::On { hours }) => {
            let (from, to) = parse_hours(&hours)?;
            if let Some(existing) = clock_routines(&client).await?.first() {
                let paused = if remote::flag(existing, "enabled") {
                    ""
                } else {
                    " It is paused; resume it with: gsv routines edit ID --resume"
                };
                println!("Your Ship's clock is already on.{paused}");
                return Ok(());
            }
            let result = call(
                &client,
                "sched.add",
                json!({
                    "name": ROUTINE_NAME,
                    "description": "Hourly check-ins: your Ship looks at what happened and decides whether you'd want anything done",
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
                "Your Ship's clock is on. It checks in every hour from {from:02}:00 to {to:02}:00."
            );
            Ok(())
        }
        Some(ClockAction::Now) => {
            let schedule = clock_routines(&client)
                .await?
                .into_iter()
                .next()
                .ok_or("Your Ship's clock is off. Turn it on with: gsv clock on")?;
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
                    Ok(())
                }
            }
        }
        Some(ClockAction::Off) => {
            let found = clock_routines(&client).await?;
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
                    "Your Ship's clock was already off."
                } else {
                    "Your Ship's clock is off. It still wakes for messages, mail and events."
                }
            );
            Ok(())
        }
        None => {
            let found = clock_routines(&client).await?;
            if out.json {
                return render::print_json(&json!({ "routines": found }));
            }
            let Some(schedule) = found.first() else {
                println!("Your Ship's clock is off.");
                print!("{}", render::hint(&style, "Turn it on with: gsv clock on"));
                return Ok(());
            };
            let now = render::now_ms();
            let state = schedule.get("state").cloned().unwrap_or(Value::Null);
            let hours = hours_label(schedule).unwrap_or_else(|| "on its schedule".to_string());
            if !remote::flag(schedule, "enabled") {
                println!("Your Ship's clock is paused ({hours}).");
                return Ok(());
            }
            println!("Your Ship's clock is on: every hour, {hours}.");
            if let Some(next) = number(&state, "nextRunAtMs") {
                println!("Next check-in {}.", render::relative_time(next, now));
            }
            match (text(&state, "lastStatus"), number(&state, "lastRunAtMs")) {
                ("error", Some(at)) => println!(
                    "The last tick failed {}: {}",
                    render::relative_time(at, now),
                    text(&state, "lastError")
                ),
                (_, Some(at)) => println!("Last tick {}.", render::relative_time(at, now)),
                _ => {}
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hours_parse_the_way_people_type_them() {
        assert_eq!(parse_hours("7-23").expect("hours"), (7, 23));
        assert_eq!(parse_hours(" 0 - 23 ").expect("hours"), (0, 23));
        parse_hours("23-7").expect_err("backwards");
        parse_hours("7-24").expect_err("out of range");
        parse_hours("7").expect_err("no range");
    }

    #[test]
    fn the_hours_read_back_from_the_cron_line() {
        let schedule = json!({ "expression": { "kind": "cron", "expr": "0 8-22 * * *" } });
        assert_eq!(hours_label(&schedule).as_deref(), Some("08:00–22:00"));
    }
}
