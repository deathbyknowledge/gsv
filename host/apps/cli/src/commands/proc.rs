use gateway_client::history::{HistoryDirection, HistoryOutcome, HistoryRecordData, ProcHistory};
use gsv::kernel_client::{cli_peer_identity, BinaryBodyLimits, GatewayAuth, KernelClient};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::cli::ProcAction;

use super::format_unix_ms;

pub(crate) async fn run_proc(
    url: &str,
    auth: GatewayAuth,
    action: ProcAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_with_peer(
        url,
        cli_peer_identity(),
        Vec::new(),
        auth,
        BinaryBodyLimits::default(),
        |_| {},
    )
    .await?;

    match action {
        ProcAction::List { uid } => {
            let mut args = json!({});
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }
            let payload = client.request_ok("proc.list", Some(args)).await?;
            match serde_json::from_value::<ProcListPayload>(payload.clone()) {
                Ok(result) => print_proc_list(&result.processes),
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        ProcAction::Spawn {
            run_as,
            model,
            effort,
            label,
            prompt,
            parent_pid,
        } => {
            let mut args = json!({});
            if let Some(run_as) = run_as {
                args["runAs"] = json!(run_as);
            }
            if let Some(label) = label {
                args["label"] = json!(label);
            }
            if let Some(prompt) = prompt {
                args["prompt"] = json!(prompt);
            }
            if let Some(parent_pid) = parent_pid {
                args["parentPid"] = json!(parent_pid);
            }
            if model.is_some() || effort.is_some() {
                let mut ai = json!({});
                if let Some(model) = model {
                    ai["modelId"] = json!(model);
                }
                if let Some(effort) = effort {
                    ai["reasoning"] = json!(effort);
                }
                args["ai"] = ai;
            }
            let payload = client.request_ok("proc.spawn", Some(args)).await?;
            match serde_json::from_value::<ProcSpawnPayload>(payload.clone()) {
                Ok(result) => {
                    if !result.ok {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "proc.spawn failed".to_string())
                            .into());
                    }
                    let pid = result.pid.unwrap_or_else(|| "<unknown>".to_string());
                    if let Some(label) = result.label {
                        println!("Spawned process {} ({})", pid, label);
                    } else {
                        println!("Spawned process {}", pid);
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        ProcAction::Send { message, pid } => {
            let result = client.proc_send(&pid, &message).await?;
            println!(
                "Message accepted: run_id={} status={} queued={}",
                result.run_id, result.status, result.queued
            );
        }
        ProcAction::History {
            pid,
            tail,
            limit,
            offset,
        } => {
            let mut args = json!({ "pid": pid, "format": 2 });
            if tail {
                args["tail"] = json!(true);
            }
            if let Some(limit) = limit {
                args["limit"] = json!(limit);
            }
            if let Some(offset) = offset {
                args["offset"] = json!(offset);
            }
            let payload = client.request_ok("proc.history", Some(args)).await?;
            let result = ProcHistory::decode(payload)?;
            println!(
                "History for {} ({} message groups, generation {}, revision {}):",
                result.pid,
                result.message_count,
                result.history_generation,
                result.history_revision
            );
            for record in result.records {
                println!(
                    "[{}] {}:{} {}",
                    format_unix_ms(record.created_at as i64),
                    record.message_id,
                    record.index,
                    render_history_record(&record.data)
                );
            }
            if result.truncated {
                println!("(truncated)");
            }
        }
        ProcAction::Reset { pid } => {
            let payload = client
                .request_ok("proc.reset", Some(json!({ "pid": pid })))
                .await?;
            match serde_json::from_value::<ProcResetPayload>(payload.clone()) {
                Ok(result) => {
                    if !result.ok {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "proc.reset failed".to_string())
                            .into());
                    }
                    let pid = result.pid.unwrap_or_else(|| "<unknown>".to_string());
                    let archived_messages = result.archived_messages.unwrap_or(0);
                    if let Some(path) = result.archived_to {
                        println!(
                            "Reset {} (archived {} messages to {})",
                            pid, archived_messages, path
                        );
                    } else {
                        println!("Reset {} (archived {} messages)", pid, archived_messages);
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        ProcAction::Kill { pid, no_archive } => {
            let payload = client
                .request_ok(
                    "proc.kill",
                    Some(json!({
                        "pid": pid,
                        "archive": !no_archive,
                    })),
                )
                .await?;
            match serde_json::from_value::<ProcKillPayload>(payload.clone()) {
                Ok(result) => {
                    if !result.ok {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "proc.kill failed".to_string())
                            .into());
                    }
                    let pid = result.pid.unwrap_or_else(|| "<unknown>".to_string());
                    if let Some(path) = result.archived_to {
                        println!("Killed {} (archived to {})", pid, path);
                    } else {
                        println!("Killed {}", pid);
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
    }

    Ok(())
}
#[derive(Debug, Deserialize)]
struct ProcListPayload {
    processes: Vec<ProcListEntryPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcListEntryPayload {
    pid: String,
    uid: u32,
    personal: bool,
    parent_pid: Option<String>,
    state: String,
    active_run_id: Option<String>,
    queued_count: Option<u32>,
    last_active_at: Option<i64>,
    label: Option<String>,
    created_at: i64,
}

#[derive(Debug, Deserialize)]
struct ProcSpawnPayload {
    ok: bool,
    pid: Option<String>,
    label: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcResetPayload {
    ok: bool,
    pid: Option<String>,
    archived_messages: Option<u32>,
    archived_to: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcKillPayload {
    ok: bool,
    pid: Option<String>,
    archived_to: Option<String>,
    error: Option<String>,
}
fn print_proc_list(processes: &[ProcListEntryPayload]) {
    if processes.is_empty() {
        println!("(no processes)");
        return;
    }

    for process in processes {
        println!(
            "{} kind={} state={} uid={} queue={} active={} parent={} label={} created={} last_active={}",
            process.pid,
            if process.personal { "personal" } else { "work" },
            process.state,
            process.uid,
            process.queued_count.unwrap_or(0),
            process.active_run_id.as_deref().unwrap_or("-"),
            process.parent_pid.as_deref().unwrap_or("-"),
            process.label.as_deref().unwrap_or("-"),
            format_unix_ms(process.created_at),
            process
                .last_active_at
                .map(format_unix_ms)
                .unwrap_or_else(|| "-".to_string())
        );
    }
}

fn render_history_record(record: &HistoryRecordData) -> String {
    match record {
        HistoryRecordData::Message(message) => format!(
            "message/{}: {}{}",
            match message.direction {
                HistoryDirection::In => "in",
                HistoryDirection::Out => "out",
            },
            message.text,
            render_media(&message.media)
        ),
        HistoryRecordData::Note(note) => {
            let thinking = note
                .thinking
                .iter()
                .filter(|thinking| !thinking.redacted.unwrap_or(false))
                .map(|thinking| thinking.thinking.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "note: {}{}{}",
                note.text,
                if thinking.is_empty() {
                    String::new()
                } else {
                    format!("\nthinking: {thinking}")
                },
                render_media(&note.media)
            )
        }
        HistoryRecordData::Call(call) => format!(
            "call {} {} syscall={} target={}: {}",
            call.call_id,
            call.tool,
            call.syscall.as_deref().unwrap_or("-"),
            call.target.as_deref().unwrap_or("-"),
            serde_json::to_string(&call.args).unwrap_or_default()
        ),
        HistoryRecordData::Result(result) => format!(
            "result {} {} {}: {}{}{}{}",
            result.call_id,
            result.tool,
            match result.outcome {
                HistoryOutcome::Completed => "completed",
                HistoryOutcome::Failed => "failed",
                HistoryOutcome::Denied => "denied",
                HistoryOutcome::Cancelled => "cancelled",
            },
            match &result.output {
                Value::String(text) => text.clone(),
                output => output.to_string(),
            },
            result
                .error
                .as_ref()
                .map(|error| format!("\nerror: {}", error.message))
                .unwrap_or_default(),
            render_media(&result.media),
            render_media(&result.resources)
        ),
        HistoryRecordData::Event(event) => format!(
            "event {} [{:?}/{:?}]: {}",
            event.kind,
            event.severity,
            event.audience,
            serde_json::to_string(&event.payload).unwrap_or_default()
        ),
    }
}

fn render_media(media: &[Value]) -> String {
    if media.is_empty() {
        String::new()
    } else {
        format!(
            "\nresources: {}",
            serde_json::to_string(media).unwrap_or_default()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_renders_explicit_calls_outcomes_and_events() {
        let rows = [
            (
                json!({"kind":"call","payload":{"callId":"c","tool":"Send","syscall":null,
                "target":null,"runId":"r","args":{"text":"hello","finish":false}}}),
                "call c Send syscall=- target=-:",
            ),
            (
                json!({"kind":"result","payload":{"callId":"c","tool":"Send","outcome":"denied",
                "output":{"finish":false},"media":[],"resources":[],"error":{"message":"denied"}}}),
                "result c Send denied:",
            ),
            (
                json!({"kind":"event","payload":{"kind":"correction.exhausted","payload":{"attempts":3,"limit":3},
                "severity":"warn","audience":"person"}}),
                "event correction.exhausted [Warn/Person]:",
            ),
        ];
        for (value, expected) in rows {
            let record = serde_json::from_value(value).expect("typed record");
            assert!(render_history_record(&record).starts_with(expected));
        }
    }

    #[test]
    fn notes_preserve_text_and_hide_redacted_thinking() {
        let record = serde_json::from_value(
            json!({"kind":"note","payload":{"text":"  literal spacing\n",
            "thinking":[{"type":"thinking","thinking":"visible"},{"type":"thinking","thinking":"redacted","redacted":true}]}}),
        )
        .expect("note");
        assert_eq!(
            render_history_record(&record),
            "note:   literal spacing\n\nthinking: visible"
        );
    }
}
