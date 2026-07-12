use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::cli::ProcAction;

use super::format_unix_ms;

pub(crate) async fn run_proc(
    url: &str,
    auth: GatewayAuth,
    action: ProcAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

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
            label,
            prompt,
            parent_pid,
        } => {
            let mut args = json!({ "fresh": true });
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
            let result = client.proc_send(pid.as_deref(), &message).await?;
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
            let mut args = json!({});
            if let Some(pid) = pid {
                args["pid"] = json!(pid);
            }
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
            match serde_json::from_value::<ProcHistoryPayload>(payload.clone()) {
                Ok(result) => {
                    if !result.ok {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "proc.history failed".to_string())
                            .into());
                    }
                    let pid = result.pid.unwrap_or_else(|| "<unknown>".to_string());
                    let count = result.message_count.unwrap_or(result.messages.len());
                    println!("History for {} ({} messages):", pid, count);
                    for message in result.messages {
                        let ts = message
                            .timestamp
                            .map(format_unix_ms)
                            .map(|value| format!("[{}] ", value))
                            .unwrap_or_default();
                        println!(
                            "{}{}: {}",
                            ts,
                            message.role,
                            render_message_content(&message.content)
                        );
                    }
                    if result.truncated.unwrap_or(false) {
                        println!("(truncated)");
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        ProcAction::Reset { pid } => {
            let mut args = json!({});
            if let Some(pid) = pid {
                args["pid"] = json!(pid);
            }
            let payload = client.request_ok("proc.reset", Some(args)).await?;
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
    parent_pid: Option<String>,
    state: String,
    active_run_id: Option<String>,
    active_conversation_id: Option<String>,
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
struct ProcHistoryPayload {
    ok: bool,
    pid: Option<String>,
    messages: Vec<ProcHistoryMessagePayload>,
    message_count: Option<usize>,
    truncated: Option<bool>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProcHistoryMessagePayload {
    role: String,
    content: Value,
    timestamp: Option<i64>,
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
            "{} state={} uid={} queue={} active={} convo={} parent={} label={} created={} last_active={}",
            process.pid,
            process.state,
            process.uid,
            process.queued_count.unwrap_or(0),
            process.active_run_id.as_deref().unwrap_or("-"),
            process.active_conversation_id.as_deref().unwrap_or("-"),
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

fn render_message_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    serde_json::to_string(content).unwrap_or_else(|_| "<unrenderable>".to_string())
}
