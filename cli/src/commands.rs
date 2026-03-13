use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::{ConfigAction, ProcAction};

const CHAT_WAIT_TIMEOUT_SECS: u64 = 120;

#[derive(Clone, Debug)]
struct PendingChatSignal {
    signal: String,
    payload: Value,
}

fn client_debug_enabled() -> bool {
    std::env::var("GSV_CLIENT_DEBUG")
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !normalized.is_empty() && normalized != "0" && normalized != "false"
        })
        .unwrap_or(false)
}

fn debug_log(enabled: bool, message: impl AsRef<str>) {
    if enabled {
        eprintln!("[gsv-client-debug] {}", message.as_ref());
    }
}

fn signal_run_id(payload: &Value) -> Option<String> {
    payload
        .get("runId")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

fn process_chat_signal(
    debug_enabled: bool,
    signal: &str,
    payload: &Value,
    expected_run_id: &Arc<Mutex<Option<String>>>,
    awaiting_response: &AtomicBool,
    emitted_text: &AtomicBool,
    completed: &AtomicBool,
) {
    let run_id = signal_run_id(payload).unwrap_or_else(|| "<none>".to_string());
    debug_log(
        debug_enabled,
        format!("process signal={} runId={}", signal, run_id),
    );

    match signal {
        "chat.text" => {
            if let Some(text) = payload.get("text").and_then(|value| value.as_str()) {
                print!("{}", text);
                let _ = io::stdout().flush();
                emitted_text.store(true, Ordering::SeqCst);
            }
        }
        "chat.tool_call" => {
            if let Some(name) = payload.get("name").and_then(|value| value.as_str()) {
                println!("\n[tool] {}", name);
            }
        }
        "chat.tool_result" => {
            let tool_name = payload
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let ok = payload
                .get("ok")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if ok {
                println!("[tool result] {}: ok", tool_name);
            } else {
                let error = payload
                    .get("error")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown error");
                eprintln!("[tool result] {}: {}", tool_name, error);
            }
        }
        "chat.complete" => {
            if let Some(error) = payload.get("error").and_then(|value| value.as_str()) {
                eprintln!("\nError: {}", error);
            } else if !emitted_text.load(Ordering::SeqCst) {
                if let Some(text) = payload.get("text").and_then(|value| value.as_str()) {
                    if !text.is_empty() {
                        println!("\nAssistant: {}", text);
                    }
                }
            } else {
                println!();
            }

            if let Ok(mut run_id) = expected_run_id.lock() {
                *run_id = None;
            }
            awaiting_response.store(false, Ordering::SeqCst);
            emitted_text.store(false, Ordering::SeqCst);
            completed.store(true, Ordering::SeqCst);
            debug_log(debug_enabled, "chat.complete -> completed=true awaiting=false");
        }
        _ => {}
    }
}

fn drain_pending_chat_signals(
    debug_enabled: bool,
    expected_run_id_value: &str,
    pending_signals: &Arc<Mutex<Vec<PendingChatSignal>>>,
    expected_run_id: &Arc<Mutex<Option<String>>>,
    awaiting_response: &AtomicBool,
    emitted_text: &AtomicBool,
    completed: &AtomicBool,
) -> (usize, usize) {
    let queued = match pending_signals.lock() {
        Ok(mut pending) => std::mem::take(&mut *pending),
        Err(_) => return (0, 0),
    };

    let total = queued.len();
    let mut processed = 0usize;

    for queued_signal in queued {
        let run_id = signal_run_id(&queued_signal.payload);
        if run_id.as_deref() != Some(expected_run_id_value) {
            continue;
        }
        processed += 1;
        process_chat_signal(
            debug_enabled,
            &queued_signal.signal,
            &queued_signal.payload,
            expected_run_id,
            awaiting_response,
            emitted_text,
            completed,
        );
        if !awaiting_response.load(Ordering::SeqCst) {
            break;
        }
    }
    debug_log(
        debug_enabled,
        format!(
            "drain pending runId={} total={} processed={}",
            expected_run_id_value, total, processed
        ),
    );
    (total, processed)
}

fn begin_wait_for_chat_response(
    completed: &AtomicBool,
    emitted_text: &AtomicBool,
    awaiting_response: &AtomicBool,
    expected_run_id: &Arc<Mutex<Option<String>>>,
    pending_signals: &Arc<Mutex<Vec<PendingChatSignal>>>,
) {
    completed.store(false, Ordering::SeqCst);
    emitted_text.store(false, Ordering::SeqCst);
    awaiting_response.store(true, Ordering::SeqCst);
    if let Ok(mut expected) = expected_run_id.lock() {
        *expected = None;
    }
    if let Ok(mut pending) = pending_signals.lock() {
        pending.clear();
    }
}

async fn wait_for_chat_complete(
    completed: &AtomicBool,
    debug_enabled: bool,
    is_disconnected: impl Fn() -> bool,
) {
    let timeout = tokio::time::Duration::from_secs(CHAT_WAIT_TIMEOUT_SECS);
    let start = tokio::time::Instant::now();

    while !completed.load(Ordering::SeqCst) {
        if is_disconnected() {
            eprintln!("Connection lost while waiting for chat response");
            debug_log(debug_enabled, "wait aborted: connection disconnected");
            break;
        }
        if start.elapsed() > timeout {
            eprintln!(
                "Timeout waiting for chat completion after {} seconds",
                CHAT_WAIT_TIMEOUT_SECS
            );
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
}

pub(crate) async fn run_client(
    url: &str,
    auth: GatewayAuth,
    message: Option<String>,
    pid: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let debug_enabled = client_debug_enabled();

    println!("Connecting to {}...", url);
    debug_log(debug_enabled, format!("connecting url={}", url));

    let completed = Arc::new(AtomicBool::new(false));
    let completed_for_handler = completed.clone();
    let expected_run_id = Arc::new(Mutex::new(None::<String>));
    let expected_run_id_for_handler = expected_run_id.clone();
    let emitted_text = Arc::new(AtomicBool::new(false));
    let emitted_text_for_handler = emitted_text.clone();
    let awaiting_response = Arc::new(AtomicBool::new(false));
    let awaiting_response_for_handler = awaiting_response.clone();
    let pending_signals = Arc::new(Mutex::new(Vec::<PendingChatSignal>::new()));
    let pending_signals_for_handler = pending_signals.clone();
    let debug_enabled_for_handler = debug_enabled;

    let client = KernelClient::connect_user(url, auth, move |frame| {
        if let gsv::protocol::Frame::Sig(sig) = frame {
            let payload = sig.payload.unwrap_or_else(|| json!({}));
            let incoming_run_id = signal_run_id(&payload).unwrap_or_else(|| "<none>".to_string());
            debug_log(
                debug_enabled_for_handler,
                format!("signal recv raw={} runId={}", sig.signal, incoming_run_id),
            );
            if !sig.signal.starts_with("chat.") {
                debug_log(debug_enabled_for_handler, "signal ignored (non-chat)");
                return;
            }
            let expected = expected_run_id_for_handler
                .lock()
                .ok()
                .and_then(|run_id| run_id.clone());
            debug_log(
                debug_enabled_for_handler,
                format!(
                    "signal recv={} runId={} expected={:?} awaiting={}",
                    sig.signal,
                    incoming_run_id,
                    expected,
                    awaiting_response_for_handler.load(Ordering::SeqCst)
                ),
            );

            if !awaiting_response_for_handler.load(Ordering::SeqCst) {
                debug_log(
                    debug_enabled_for_handler,
                    "signal ignored (awaiting_response=false)",
                );
                return;
            }

            let signal_run_id = signal_run_id(&payload);

            let Some(expected) = expected else {
                if signal_run_id.is_some() {
                    if let Ok(mut pending) = pending_signals_for_handler.lock() {
                        pending.push(PendingChatSignal {
                            signal: sig.signal.clone(),
                            payload,
                        });
                        debug_log(
                            debug_enabled_for_handler,
                            format!("signal queued (expected runId pending) queue_len={}", pending.len()),
                        );
                    }
                }
                return;
            };

            if signal_run_id.as_deref() != Some(expected.as_str()) {
                debug_log(
                    debug_enabled_for_handler,
                    format!(
                        "signal ignored (runId mismatch): signal={:?} expected={}",
                        signal_run_id, expected
                    ),
                );
                return;
            }

            process_chat_signal(
                debug_enabled_for_handler,
                &sig.signal,
                &payload,
                &expected_run_id_for_handler,
                awaiting_response_for_handler.as_ref(),
                emitted_text_for_handler.as_ref(),
                completed_for_handler.as_ref(),
            );
        }
    })
    .await?;

    if let Some(message) = message {
        begin_wait_for_chat_response(
            completed.as_ref(),
            emitted_text.as_ref(),
            awaiting_response.as_ref(),
            &expected_run_id,
            &pending_signals,
        );
        debug_log(
            debug_enabled,
            format!(
                "proc.send start pid={} chars={}",
                pid.as_deref().unwrap_or("<init>"),
                message.chars().count()
            ),
        );

        let result = client.proc_send(pid.as_deref(), &message).await?;
        debug_log(
            debug_enabled,
            format!(
                "proc.send response runId={} queued={}",
                result.run_id, result.queued
            ),
        );
        if result.queued {
            println!("[queued] process is busy; your message was queued");
        }

        if let Ok(mut expected) = expected_run_id.lock() {
            *expected = Some(result.run_id);
        }
        if let Some(expected_run_id_value) = expected_run_id
            .lock()
            .ok()
            .and_then(|run_id| run_id.clone())
        {
            drain_pending_chat_signals(
                debug_enabled,
                &expected_run_id_value,
                &pending_signals,
                &expected_run_id,
                awaiting_response.as_ref(),
                emitted_text.as_ref(),
                completed.as_ref(),
            );
        }

        wait_for_chat_complete(completed.as_ref(), debug_enabled, || {
            client.connection().is_disconnected()
        })
        .await;
        return Ok(());
    }

    println!("Connected! Type your message and press Enter. Type 'quit' to exit.\n");

    let stdin = io::stdin();
    print!("> ");
    let _ = io::stdout().flush();

    for line in stdin.lock().lines() {
        let line = line?;
        let line = line.trim();

        if line == "quit" || line == "exit" {
            break;
        }

        if line.is_empty() {
            print!("> ");
            let _ = io::stdout().flush();
            continue;
        }

        begin_wait_for_chat_response(
            completed.as_ref(),
            emitted_text.as_ref(),
            awaiting_response.as_ref(),
            &expected_run_id,
            &pending_signals,
        );
        debug_log(
            debug_enabled,
            format!(
                "proc.send start pid={} chars={}",
                pid.as_deref().unwrap_or("<init>"),
                line.chars().count()
            ),
        );

        let result = client.proc_send(pid.as_deref(), line).await?;
        debug_log(
            debug_enabled,
            format!(
                "proc.send response runId={} queued={}",
                result.run_id, result.queued
            ),
        );
        if result.queued {
            println!("[queued] process is busy; your message was queued");
        }

        if let Ok(mut expected) = expected_run_id.lock() {
            *expected = Some(result.run_id);
        }
        if let Some(expected_run_id_value) = expected_run_id
            .lock()
            .ok()
            .and_then(|run_id| run_id.clone())
        {
            drain_pending_chat_signals(
                debug_enabled,
                &expected_run_id_value,
                &pending_signals,
                &expected_run_id,
                awaiting_response.as_ref(),
                emitted_text.as_ref(),
                completed.as_ref(),
            );
        }

        wait_for_chat_complete(completed.as_ref(), debug_enabled, || {
            client.connection().is_disconnected()
        })
        .await;

        print!("\n> ");
        let _ = io::stdout().flush();
    }

    Ok(())
}

pub(crate) async fn run_config(
    url: &str,
    auth: GatewayAuth,
    action: ConfigAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    match action {
        ConfigAction::Get { key } => {
            let payload = client.sys_config_get(key.as_deref()).await?;
            println!("{}", serde_json::to_string_pretty(&payload)?);
        }
        ConfigAction::Set { key, value } => {
            client.sys_config_set(&key, &value).await?;
            println!("ok");
        }
    }

    Ok(())
}

pub(crate) async fn run_proc(
    url: &str,
    auth: GatewayAuth,
    action: ProcAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    let payload = match action {
        ProcAction::List { uid } => {
            let mut args = json!({});
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }
            client.request_ok("proc.list", Some(args)).await?
        }
        ProcAction::Spawn {
            label,
            prompt,
            parent_pid,
        } => {
            let mut args = json!({});
            if let Some(label) = label {
                args["label"] = json!(label);
            }
            if let Some(prompt) = prompt {
                args["prompt"] = json!(prompt);
            }
            if let Some(parent_pid) = parent_pid {
                args["parentPid"] = json!(parent_pid);
            }
            client.request_ok("proc.spawn", Some(args)).await?
        }
        ProcAction::Send { message, pid } => {
            let result = client.proc_send(pid.as_deref(), &message).await?;
            serde_json::to_value(result)?
        }
        ProcAction::History { pid, limit, offset } => {
            let mut args = json!({});
            if let Some(pid) = pid {
                args["pid"] = json!(pid);
            }
            if let Some(limit) = limit {
                args["limit"] = json!(limit);
            }
            if let Some(offset) = offset {
                args["offset"] = json!(offset);
            }
            client.request_ok("proc.history", Some(args)).await?
        }
        ProcAction::Reset { pid } => {
            let mut args = json!({});
            if let Some(pid) = pid {
                args["pid"] = json!(pid);
            }
            client.request_ok("proc.reset", Some(args)).await?
        }
        ProcAction::Kill { pid, no_archive } => {
            client
                .request_ok(
                    "proc.kill",
                    Some(json!({
                        "pid": pid,
                        "archive": !no_archive,
                    })),
                )
                .await?
        }
    };

    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}
