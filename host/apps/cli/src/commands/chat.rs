use std::io::{self, BufRead, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gsv::kernel_client::{cli_peer_identity, BinaryBodyLimits, GatewayAuth, KernelClient};
use serde_json::{json, Value};
use tokio::sync::mpsc;

const CHAT_WAIT_TIMEOUT_SECS: u64 = 120;

#[derive(Clone, Debug)]
struct PendingChatSignal {
    signal: String,
    payload: Value,
}

type StdinLine = Result<String, String>;

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
        eprintln!("[gateway-client-debug] {}", message.as_ref());
    }
}

fn signal_run_id(payload: &Value) -> Option<String> {
    payload
        .get("runId")
        .or_else(|| {
            payload
                .get("message")
                .and_then(|message| message.get("runId"))
        })
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

fn implicit_personal_owner_uid(owner_uid: u64) -> Result<u64, &'static str> {
    if owner_uid == 0 {
        return Err("root has no implicit personal intelligence; pass --pid");
    }
    Ok(owner_uid)
}

fn personal_process_id(payload: &Value, owner_uid: u64) -> Option<String> {
    payload
        .get("processes")?
        .as_array()?
        .iter()
        .find(|process| {
            process.get("personal").and_then(Value::as_bool) == Some(true)
                && process.get("uid").and_then(Value::as_u64) == Some(owner_uid)
        })?
        .get("pid")?
        .as_str()
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
    hil_requests: &mpsc::UnboundedSender<Value>,
) {
    let run_id = signal_run_id(payload).unwrap_or_else(|| "<none>".to_string());
    debug_log(
        debug_enabled,
        format!("process signal={} runId={}", signal, run_id),
    );

    match signal {
        "message.committed" => {
            let is_directed_process_message = payload.get("directed").and_then(Value::as_bool)
                == Some(true)
                && payload
                    .get("message")
                    .and_then(|message| message.get("author"))
                    .and_then(|author| author.get("kind"))
                    .and_then(Value::as_str)
                    == Some("process");
            if is_directed_process_message && !emitted_text.load(Ordering::SeqCst) {
                if let Some(text) = payload
                    .get("message")
                    .and_then(|message| message.get("text"))
                    .and_then(Value::as_str)
                {
                    print!("{}", text);
                    let _ = io::stdout().flush();
                    emitted_text.store(true, Ordering::SeqCst);
                }
            }
        }
        "message.delta" => {
            if let Some(text) = payload.get("delta").and_then(Value::as_str) {
                print!("{}", text);
                let _ = io::stdout().flush();
                emitted_text.store(true, Ordering::SeqCst);
            }
        }
        "message.aborted" => {
            if emitted_text.swap(false, Ordering::SeqCst) {
                println!();
            }
        }
        "proc.run.tool.started" => {
            if let Some(name) = payload.get("name").and_then(|value| value.as_str()) {
                println!("\n[tool] {}", name);
            }
        }
        "proc.run.hil.requested" => {
            if payload.get("requestId").and_then(Value::as_str).is_some()
                && payload.get("pid").and_then(Value::as_str).is_some()
            {
                let _ = hil_requests.send(payload.clone());
            }
        }
        "proc.run.finished" => {
            if let Some(error) = payload.get("error").and_then(|value| value.as_str()) {
                eprintln!("\nError: {}", error);
            } else if emitted_text.load(Ordering::SeqCst) {
                println!();
            }

            if let Ok(mut run_id) = expected_run_id.lock() {
                *run_id = None;
            }
            awaiting_response.store(false, Ordering::SeqCst);
            emitted_text.store(false, Ordering::SeqCst);
            completed.store(true, Ordering::SeqCst);
            debug_log(
                debug_enabled,
                "proc.run.finished -> completed=true awaiting=false",
            );
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
    hil_requests: &mpsc::UnboundedSender<Value>,
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
            hil_requests,
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

fn spawn_stdin_reader() -> mpsc::UnboundedReceiver<StdinLine> {
    let (sender, receiver) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let result = line.map_err(|error| error.to_string());
            if sender.send(result).is_err() {
                return;
            }
        }
    });
    receiver
}

async fn handle_hil_request(
    client: &KernelClient,
    payload: Value,
    stdin_lines: &mut mpsc::UnboundedReceiver<StdinLine>,
    interactive_stdin: bool,
) {
    let Some(pid) = payload.get("pid").and_then(Value::as_str) else {
        eprintln!("\nInvalid approval request: missing pid");
        return;
    };
    let Some(request_id) = payload.get("requestId").and_then(Value::as_str) else {
        eprintln!("\nInvalid approval request: missing requestId");
        return;
    };
    let syscall = payload
        .get("syscall")
        .and_then(Value::as_str)
        .unwrap_or("unknown syscall");
    let target = payload
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("unknown target");
    let args = payload.get("args").cloned().unwrap_or_else(|| json!({}));

    println!("\n[approval required] {syscall} on {target}");
    match serde_json::to_string_pretty(&args) {
        Ok(rendered) => println!("{rendered}"),
        Err(_) => println!("{args}"),
    }
    if !interactive_stdin {
        eprintln!(
            "Approval {request_id} is still pending; rerun `gsv chat` in an interactive terminal to decide it."
        );
        return;
    }

    let (decision, remember) = loop {
        print!("Approve [o]nce, [a]lways, or [d]eny? ");
        let _ = io::stdout().flush();
        let Some(line) = stdin_lines.recv().await else {
            eprintln!("\nInput closed; approval remains pending.");
            return;
        };
        let line = match line {
            Ok(line) => line.trim().to_ascii_lowercase(),
            Err(error) => {
                eprintln!("\nCould not read approval decision: {error}");
                return;
            }
        };
        match line.as_str() {
            "o" | "once" | "approve" | "y" | "yes" => break ("approve", false),
            "a" | "always" | "approve always" => break ("approve", true),
            "d" | "deny" | "n" | "no" => break ("deny", false),
            _ => println!("Enter o, a, or d."),
        }
    };

    match client
        .request_ok(
            "proc.hil",
            Some(json!({
                "pid": pid,
                "requestId": request_id,
                "decision": decision,
                "remember": remember,
            })),
        )
        .await
    {
        Ok(result) if result.get("ok").and_then(Value::as_bool) == Some(true) => {
            println!(
                "[approval] {}{}",
                if decision == "approve" {
                    "approved"
                } else {
                    "denied"
                },
                if remember { " and remembered" } else { "" },
            );
        }
        Ok(result) => {
            let error = result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("approval was not accepted");
            eprintln!("[approval] {error}");
        }
        Err(error) => eprintln!("[approval] request failed: {error}"),
    }
}

async fn wait_for_chat_complete(
    completed: &AtomicBool,
    debug_enabled: bool,
    is_disconnected: impl Fn() -> bool,
    client: &KernelClient,
    hil_requests: &mut mpsc::UnboundedReceiver<Value>,
    stdin_lines: &mut mpsc::UnboundedReceiver<StdinLine>,
    interactive_stdin: bool,
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
        tokio::select! {
            request = hil_requests.recv() => {
                if let Some(request) = request {
                    handle_hil_request(client, request, stdin_lines, interactive_stdin).await;
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {}
        }
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
    let (hil_sender, mut hil_requests) = mpsc::unbounded_channel::<Value>();
    let hil_sender_for_handler = hil_sender.clone();
    let debug_enabled_for_handler = debug_enabled;

    let client = match KernelClient::connect_with_peer(
        url,
        cli_peer_identity(),
        Vec::new(),
        auth,
        BinaryBodyLimits::default(),
        move |frame| {
            if let gsv::protocol::Frame::Sig(sig) = frame {
                let payload = sig.payload.unwrap_or_else(|| json!({}));
                let incoming_run_id =
                    signal_run_id(&payload).unwrap_or_else(|| "<none>".to_string());
                debug_log(
                    debug_enabled_for_handler,
                    format!("signal recv raw={} runId={}", sig.signal, incoming_run_id),
                );
                if !sig.signal.starts_with("proc.run.") && !sig.signal.starts_with("message.") {
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
                                format!(
                                    "signal queued (expected runId pending) queue_len={}",
                                    pending.len()
                                ),
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
                    &hil_sender_for_handler,
                );
            }
        },
    )
    .await
    {
        Ok(client) => client,
        Err(error) => return Err(error),
    };
    if let Some(hint) = client
        .connection()
        .connect_result
        .as_ref()
        .and_then(|result| release_hint(gsv::build_info::PACKAGE_VERSION, &result.server))
    {
        eprintln!("{hint}");
    }
    let interactive_stdin = io::stdin().is_terminal();
    let mut stdin_lines = spawn_stdin_reader();

    let pid = match pid {
        Some(pid) => pid,
        None => {
            let owner_uid = client
                .connection()
                .connect_result
                .as_ref()
                .ok_or("sys.connect returned no current user")
                .and_then(|result| {
                    implicit_personal_owner_uid(result.peer.principal.account.uid)
                })?;
            let processes = client
                .request_ok("proc.list", Some(json!({ "uid": owner_uid })))
                .await?;
            personal_process_id(&processes, owner_uid)
                .ok_or("proc.list returned no personal intelligence process")?
        }
    };
    debug_log(debug_enabled, format!("chat process pid={pid}"));
    let conversation_id = client.conversation_for_process(&pid).await?;

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
                "conversation.send start pid={} chars={}",
                pid,
                message.chars().count()
            ),
        );

        let result = client
            .conversation_send(
                &conversation_id,
                &message,
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        debug_log(
            debug_enabled,
            format!(
                "conversation.send response runId={} queued={}",
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
                &hil_sender,
            );
        }

        wait_for_chat_complete(
            completed.as_ref(),
            debug_enabled,
            || client.connection().is_disconnected(),
            &client,
            &mut hil_requests,
            &mut stdin_lines,
            interactive_stdin,
        )
        .await;
        return Ok(());
    }

    println!("Connected! Type your message and press Enter. Type 'quit' to exit.\n");

    print!("> ");
    let _ = io::stdout().flush();

    loop {
        tokio::select! {
            request = hil_requests.recv() => {
                if let Some(request) = request {
                    handle_hil_request(
                        &client,
                        request,
                        &mut stdin_lines,
                        interactive_stdin,
                    ).await;
                    print!("\n> ");
                    let _ = io::stdout().flush();
                }
            }
            line = stdin_lines.recv() => {
                let Some(line) = line else { break };
                let line = line.map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
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
                        "conversation.send start pid={} chars={}",
                        pid,
                        line.chars().count()
                    ),
                );

                let result = client
                    .conversation_send(
                        &conversation_id,
                        line,
                        &uuid::Uuid::new_v4().to_string(),
                    )
                    .await?;
                debug_log(
                    debug_enabled,
                    format!(
                        "conversation.send response runId={} queued={}",
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
                        &hil_sender,
                    );
                }

                print!("\n> ");
                let _ = io::stdout().flush();
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use super::{implicit_personal_owner_uid, personal_process_id, process_chat_signal};
    use serde_json::json;

    #[test]
    fn selects_the_personal_process_instead_of_recent_work() {
        let payload = json!({
            "processes": [
                { "pid": "proc:work", "uid": 1000, "personal": false },
                { "pid": "proc:personal", "uid": 1000, "personal": true }
            ]
        });

        assert_eq!(
            personal_process_id(&payload, 1000).as_deref(),
            Some("proc:personal")
        );
    }

    #[test]
    fn selects_only_the_current_users_personal_process() {
        let payload = json!({
            "processes": [
                { "pid": "proc:other", "uid": 1001, "personal": true },
                { "pid": "proc:self", "uid": 1000, "personal": true }
            ]
        });

        assert_eq!(
            personal_process_id(&payload, 1000).as_deref(),
            Some("proc:self")
        );
    }

    #[test]
    fn resolves_the_current_user_from_the_authenticated_principal() {
        assert_eq!(implicit_personal_owner_uid(1000), Ok(1000));
    }

    #[test]
    fn requires_root_to_choose_an_explicit_process() {
        assert_eq!(
            implicit_personal_owner_uid(0),
            Err("root has no implicit personal intelligence; pass --pid")
        );
    }

    #[test]
    fn rejects_a_list_without_a_personal_process() {
        let payload = json!({
            "processes": [{ "pid": "proc:work", "uid": 1000, "personal": false }]
        });

        assert_eq!(personal_process_id(&payload, 1000), None);
    }

    #[test]
    fn an_aborted_message_stream_allows_the_committed_replacement_to_print() {
        let expected_run_id = Arc::new(Mutex::new(Some("run-one".to_string())));
        let awaiting_response = AtomicBool::new(true);
        let emitted_text = AtomicBool::new(true);
        let completed = AtomicBool::new(false);
        let (hil_sender, _hil_requests) = tokio::sync::mpsc::unbounded_channel();

        process_chat_signal(
            false,
            "message.aborted",
            &json!({ "runId": "run-one", "reason": "projection changed" }),
            &expected_run_id,
            &awaiting_response,
            &emitted_text,
            &completed,
            &hil_sender,
        );

        assert!(!emitted_text.load(Ordering::SeqCst));
        assert!(awaiting_response.load(Ordering::SeqCst));
        assert!(!completed.load(Ordering::SeqCst));
    }

    #[test]
    fn a_committed_user_input_is_not_printed_as_the_answer() {
        let expected_run_id = Arc::new(Mutex::new(Some("run-one".to_string())));
        let awaiting_response = AtomicBool::new(true);
        let emitted_text = AtomicBool::new(false);
        let completed = AtomicBool::new(false);
        let (hil_sender, _hil_requests) = tokio::sync::mpsc::unbounded_channel();

        process_chat_signal(
            false,
            "message.committed",
            &json!({
                "directed": false,
                "message": {
                    "runId": "run-one",
                    "author": { "kind": "user", "uid": 1000 },
                    "text": "hello"
                }
            }),
            &expected_run_id,
            &awaiting_response,
            &emitted_text,
            &completed,
            &hil_sender,
        );

        assert!(!emitted_text.load(Ordering::SeqCst));
        assert!(!completed.load(Ordering::SeqCst));
    }

    #[test]
    fn queues_structured_hil_requests_without_parsing_prompt_text() {
        let expected_run_id = Arc::new(Mutex::new(Some("run-one".to_string())));
        let awaiting_response = AtomicBool::new(true);
        let emitted_text = AtomicBool::new(false);
        let completed = AtomicBool::new(false);
        let (hil_sender, mut hil_requests) = tokio::sync::mpsc::unbounded_channel();
        let payload = json!({
            "pid": "proc-one",
            "runId": "run-one",
            "requestId": "request-one",
            "syscall": "shell.exec",
            "target": "gsv",
            "args": { "input": "date" }
        });

        process_chat_signal(
            false,
            "proc.run.hil.requested",
            &payload,
            &expected_run_id,
            &awaiting_response,
            &emitted_text,
            &completed,
            &hil_sender,
        );

        assert_eq!(hil_requests.try_recv().ok(), Some(payload));
        assert!(awaiting_response.load(Ordering::SeqCst));
    }
}

/// One line when the gateway runs a newer stable release than this CLI. The
/// CLI is never replaced under a person; the installer does that on request.
fn release_hint(current: &str, server: &gateway_client::protocol::ServerInfo) -> Option<String> {
    use host_config::release::{parse_version, stable_tag, DEV_RELEASE_TAG};
    if server.release.as_deref() == Some(DEV_RELEASE_TAG) {
        return None;
    }
    let current = parse_version(current)?;
    let available = parse_version(&server.version)?;
    if available <= current {
        return None;
    }
    let command = if cfg!(windows) {
        "irm https://install.gsv.space/install.ps1 | iex"
    } else {
        "curl -fsSL https://install.gsv.space | bash"
    };
    Some(format!(
        "GSV {} is available; this CLI is {current}. Update with: {command}",
        stable_tag(available)
    ))
}

#[cfg(test)]
mod release_hint_tests {
    use super::release_hint;
    use gateway_client::protocol::ServerInfo;

    fn server(version: &str, release: Option<&str>) -> ServerInfo {
        ServerInfo {
            version: version.to_string(),
            release: release.map(str::to_string),
            connection_id: "conn".to_string(),
        }
    }

    #[test]
    fn hints_only_for_a_newer_stable_gateway() {
        let hint = release_hint("0.4.1", &server("0.4.2", Some("v0.4.2"))).expect("newer hints");
        assert!(hint.starts_with("GSV v0.4.2 is available; this CLI is 0.4.1."));
        assert_eq!(
            release_hint("0.4.1", &server("0.4.1", Some("v0.4.1"))),
            None
        );
        assert_eq!(release_hint("0.4.1", &server("0.9.0", Some("dev"))), None);
        assert_eq!(release_hint("0.4.1", &server("nope", None)), None);
    }
}
