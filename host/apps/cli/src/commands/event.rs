//! `gsv event`: record events from your own sources, without a public address.
//!
//! The same path a Ship's routines and scripts use, so a script on any computer
//! can tell its owner or hand Ship some work.

use std::io::Read;

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::EventAction;
use crate::remote::{self, call, items, number, text, DynError, Output};
use crate::render;

const EVENTS_PER_CALL: usize = 100;

/// One JSON object per line becomes one event each; a blank line is nothing.
fn parse_lines(input: &str) -> Result<Vec<Value>, DynError> {
    input
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| {
            serde_json::from_str::<Value>(line)
                .map_err(|error| format!("line {}: {error}", index + 1).into())
        })
        .collect()
}

async fn emit(
    client: &KernelClient,
    source: &str,
    events: &[Value],
) -> Result<(i64, i64), DynError> {
    let mut accepted = 0;
    let mut duplicates = 0;
    for batch in events.chunks(EVENTS_PER_CALL) {
        let result = call(
            client,
            "event.emit",
            json!({ "source": source, "events": batch }),
        )
        .await?;
        accepted += number(&result, "accepted").unwrap_or(0);
        duplicates += number(&result, "duplicates").unwrap_or(0);
    }
    Ok((accepted, duplicates))
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: EventAction,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    match action {
        EventAction::Sources => {
            let result = call(&client, "event.source.list", json!({})).await?;
            if out.json {
                return render::print_json(&result);
            }
            for source in items(&result, "sources") {
                println!(
                    "{}\t{}\t{}",
                    text(source, "name"),
                    text(source, "ship"),
                    text(source, "label")
                );
            }
        }
        EventAction::Add {
            name,
            label,
            webhook,
        } => {
            let mut args = json!({ "name": name, "webhook": webhook });
            if let Some(label) = label {
                args["label"] = json!(label);
            }
            let result = call(&client, "event.source.add", args).await?;
            if out.json {
                return render::print_json(&result);
            }
            println!("Added {name}.");
            for (key, title) in [("webhookUrl", "Address"), ("secret", "Signing secret")] {
                let value = text(&result, key);
                if !value.is_empty() {
                    println!("{title}: {value}");
                }
            }
        }
        EventAction::Emit {
            source,
            title,
            id,
            preview,
            body,
            stdin,
        } => {
            let events = if stdin {
                let mut input = String::new();
                std::io::stdin().read_to_string(&mut input)?;
                parse_lines(&input)?
            } else {
                let title =
                    title.ok_or("Give a --title, or --stdin with one JSON object per line")?;
                let mut event = json!({ "title": title });
                for (key, value) in [("id", id), ("preview", preview), ("body", body)] {
                    if let Some(value) = value {
                        event[key] = json!(value);
                    }
                }
                vec![event]
            };
            let (accepted, duplicates) = emit(&client, &source, &events).await?;
            if out.json {
                return render::print_json(
                    &json!({ "accepted": accepted, "duplicates": duplicates }),
                );
            }
            println!("{accepted} accepted, {duplicates} already seen");
        }
        EventAction::List { source, limit } => {
            let mut args = json!({ "limit": limit });
            if let Some(source) = source {
                args["source"] = json!(source);
            }
            let result = call(&client, "event.list", args).await?;
            if out.json {
                return render::print_json(&result);
            }
            for event in items(&result, "events") {
                println!(
                    "{}\t{}\t{}",
                    text(event, "emittedBy"),
                    text(event, "eventId"),
                    text(event, "title")
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_line_is_one_event_and_a_bad_line_is_named() {
        let events = parse_lines("{\"title\":\"a\"}\n\n{\"title\":\"b\",\"id\":\"2\"}\n").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["id"], "2");
        assert!(parse_lines("{\"title\":\"a\"}\nnope")
            .unwrap_err()
            .to_string()
            .starts_with("line 2:"));
    }
}
