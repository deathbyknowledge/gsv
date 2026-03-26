use std::io::{self, BufRead, Write};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{TimeZone, Utc};
use gsv::kernel_client::{GatewayAuth, KernelClient};
use qrcode::{render::unicode, QrCode};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    AdapterAction, AuthAction, AuthTokenAction, CommandAction, CommandProcessArg,
    CommandSubjectArg, ConfigAction, ProcAction,
};

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
            debug_log(
                debug_enabled,
                "chat.complete -> completed=true awaiting=false",
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

    let client = match KernelClient::connect_user(url, auth, move |frame| {
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
            );
        }
    })
    .await
    {
        Ok(client) => client,
        Err(error) => return Err(error),
    };

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
            match serde_json::from_value::<SysConfigGetPayload>(payload.clone()) {
                Ok(result) => {
                    if result.entries.is_empty() {
                        if key.is_some() {
                            println!("(not set)");
                        } else {
                            println!("(no entries)");
                        }
                    } else if let Some(requested_key) = key.as_deref() {
                        if result.entries.len() == 1 && result.entries[0].key == requested_key {
                            let entry = &result.entries[0];
                            println!("{}", display_config_value(&entry.key, &entry.value));
                        } else {
                            for entry in result.entries {
                                println!(
                                    "{} = {}",
                                    entry.key,
                                    display_config_value(&entry.key, &entry.value)
                                );
                            }
                        }
                    } else {
                        for entry in result.entries {
                            println!(
                                "{} = {}",
                                entry.key,
                                display_config_value(&entry.key, &entry.value)
                            );
                        }
                    }
                }
                Err(_) => {
                    // Schema drift fallback for debugging and compatibility.
                    println!("{}", serde_json::to_string_pretty(&payload)?);
                }
            }
        }
        ConfigAction::Set { key, value } => {
            client.sys_config_set(&key, &value).await?;
            println!("Set {}.", key);
        }
    }

    Ok(())
}

pub(crate) async fn run_auth(
    url: &str,
    auth: GatewayAuth,
    action: AuthAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    match action {
        AuthAction::Login { .. } => {
            return Err("auth login is handled directly by the CLI entrypoint".into());
        }
        AuthAction::Logout => {
            return Err("auth logout is handled directly by the CLI entrypoint".into());
        }
        AuthAction::Setup { .. } => {
            return Err("auth setup does not use an authenticated kernel session".into());
        }
        AuthAction::Link {
            code,
            adapter,
            account_id,
            actor_id,
            uid,
        } => {
            let has_manual =
                adapter.is_some() || account_id.is_some() || actor_id.is_some() || uid.is_some();
            if code.is_some() && has_manual {
                return Err(
                    "auth link: either provide one-time code OR --adapter/--account-id/--actor-id"
                        .into(),
                );
            }

            if let Some(code) = code {
                let payload = client
                    .request_ok("sys.link.consume", Some(json!({ "code": code })))
                    .await?;
                match serde_json::from_value::<SysLinkConsumePayload>(payload.clone()) {
                    Ok(result) => {
                        if result.linked {
                            if let Some(link) = result.link {
                                println!(
                                    "Linked {}:{}:{} -> uid {}",
                                    link.adapter, link.account_id, link.actor_id, link.uid
                                );
                            } else {
                                println!("linked");
                            }
                        } else {
                            println!("not linked");
                        }
                    }
                    Err(_) => {
                        println!("{}", serde_json::to_string_pretty(&payload)?);
                    }
                }
                return Ok(());
            }

            let adapter = adapter.ok_or("auth link requires --adapter")?;
            let account_id = account_id.ok_or("auth link requires --account-id")?;
            let actor_id = actor_id.ok_or("auth link requires --actor-id")?;

            let mut args = json!({
                "adapter": adapter,
                "accountId": account_id,
                "actorId": actor_id,
            });
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }

            let payload = client.request_ok("sys.link", Some(args)).await?;
            match serde_json::from_value::<SysLinkConsumePayload>(payload.clone()) {
                Ok(result) => {
                    if result.linked {
                        if let Some(link) = result.link {
                            println!(
                                "Linked {}:{}:{} -> uid {}",
                                link.adapter, link.account_id, link.actor_id, link.uid
                            );
                        } else {
                            println!("linked");
                        }
                    } else {
                        println!("not linked");
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AuthAction::LinkList { uid } => {
            let mut args = json!({});
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }
            let payload = client.request_ok("sys.link.list", Some(args)).await?;
            match serde_json::from_value::<SysLinkListPayload>(payload.clone()) {
                Ok(result) => {
                    if result.links.is_empty() {
                        println!("(no links)");
                    } else {
                        print_link_list(&result.links);
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AuthAction::Unlink {
            adapter,
            account_id,
            actor_id,
        } => {
            let payload = client
                .request_ok(
                    "sys.unlink",
                    Some(json!({
                        "adapter": adapter,
                        "accountId": account_id,
                        "actorId": actor_id,
                    })),
                )
                .await?;
            match serde_json::from_value::<SysUnlinkPayload>(payload.clone()) {
                Ok(result) => {
                    if result.removed {
                        println!("unlinked");
                    } else {
                        println!("not found");
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AuthAction::Token { action } => match action {
            AuthTokenAction::Create {
                kind,
                uid,
                label,
                role,
                device,
                expires_at,
            } => {
                let mut args = json!({
                    "kind": kind.as_str(),
                });
                if let Some(uid) = uid {
                    args["uid"] = json!(uid);
                }
                if let Some(label) = label {
                    args["label"] = json!(label);
                }
                if let Some(role) = role {
                    args["allowedRole"] = json!(role.as_str());
                }
                if let Some(device) = device {
                    args["allowedDeviceId"] = json!(device);
                }
                if let Some(expires_at) = expires_at {
                    args["expiresAt"] = json!(expires_at);
                }
                let payload = client.request_ok("sys.token.create", Some(args)).await?;
                match serde_json::from_value::<SysTokenCreatePayload>(payload.clone()) {
                    Ok(result) => {
                        print_token_create(&result.token);
                    }
                    Err(_) => {
                        println!("{}", serde_json::to_string_pretty(&payload)?);
                    }
                }
            }
            AuthTokenAction::List { uid } => {
                let mut args = json!({});
                if let Some(uid) = uid {
                    args["uid"] = json!(uid);
                }
                let payload = client.request_ok("sys.token.list", Some(args)).await?;
                match serde_json::from_value::<SysTokenListPayload>(payload.clone()) {
                    Ok(result) => {
                        print_token_list(&result.tokens);
                    }
                    Err(_) => {
                        println!("{}", serde_json::to_string_pretty(&payload)?);
                    }
                }
            }
            AuthTokenAction::Revoke {
                token_id,
                reason,
                uid,
            } => {
                let mut args = json!({
                    "tokenId": token_id,
                });
                if let Some(reason) = reason {
                    args["reason"] = json!(reason);
                }
                if let Some(uid) = uid {
                    args["uid"] = json!(uid);
                }
                let payload = client.request_ok("sys.token.revoke", Some(args)).await?;
                match serde_json::from_value::<SysTokenRevokePayload>(payload.clone()) {
                    Ok(result) => {
                        if result.revoked {
                            println!("revoked");
                        } else {
                            println!("not found");
                        }
                    }
                    Err(_) => {
                        println!("{}", serde_json::to_string_pretty(&payload)?);
                    }
                }
            }
        },
    }

    Ok(())
}

pub(crate) async fn run_adapter(
    url: &str,
    auth: GatewayAuth,
    action: AdapterAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    match action {
        AdapterAction::Connect {
            adapter,
            account_id,
            config_json,
        } => {
            let config = match config_json {
                Some(raw) => {
                    let parsed: Value = serde_json::from_str(&raw)
                        .map_err(|_| "--config-json must be valid JSON")?;
                    if !parsed.is_object() {
                        return Err("--config-json must be a JSON object".into());
                    }
                    parsed
                }
                None => json!({}),
            };

            let payload = client
                .request_ok(
                    "adapter.connect",
                    Some(json!({
                        "adapter": adapter,
                        "accountId": account_id,
                        "config": config,
                    })),
                )
                .await?;

            match serde_json::from_value::<AdapterConnectPayload>(payload.clone()) {
                Ok(result) => {
                    if !result.ok {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "adapter.connect failed".to_string())
                            .into());
                    }
                    print_adapter_connect(&result);
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AdapterAction::Disconnect {
            adapter,
            account_id,
        } => {
            let payload = client
                .request_ok(
                    "adapter.disconnect",
                    Some(json!({
                        "adapter": adapter,
                        "accountId": account_id,
                    })),
                )
                .await?;

            match serde_json::from_value::<AdapterDisconnectPayload>(payload.clone()) {
                Ok(result) => {
                    if !result.ok {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "adapter.disconnect failed".to_string())
                            .into());
                    }
                    print_adapter_disconnect(&result);
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AdapterAction::Status {
            adapter,
            account_id,
        } => {
            let mut args = json!({ "adapter": adapter });
            if let Some(account_id) = account_id {
                args["accountId"] = json!(account_id);
            }
            let payload = client.request_ok("adapter.status", Some(args)).await?;
            match serde_json::from_value::<AdapterStatusPayload>(payload.clone()) {
                Ok(result) => {
                    print_adapter_status(&result);
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
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

pub(crate) async fn run_command(
    url: &str,
    auth: GatewayAuth,
    action: CommandAction,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        CommandAction::Issue {
            manifest,
            title,
            description,
            subject,
            uid,
            max_claims,
            single_use,
            not_before_at,
            expires_at,
            required_capability,
            requested_capability,
            required_device,
            preferred_device,
            process,
            pid,
            label,
            parent_pid,
            message,
        } => {
            let client = KernelClient::connect_user(url, auth, |_| {}).await?;
            let manifest_value = if let Some(path) = manifest {
                ensure_no_inline_command_builder_fields(
                    title.as_ref(),
                    description.as_ref(),
                    uid,
                    max_claims,
                    single_use,
                    not_before_at,
                    expires_at,
                    &required_capability,
                    &requested_capability,
                    &required_device,
                    &preferred_device,
                    pid.as_ref(),
                    label.as_ref(),
                    parent_pid.as_ref(),
                    message.as_ref(),
                )?;
                let raw = fs::read_to_string(&path)
                    .map_err(|error| format!("Failed to read manifest {}: {}", path.display(), error))?;
                serde_json::from_str::<Value>(&raw)
                    .map_err(|error| format!("Manifest must be valid JSON: {}", error))?
            } else {
                build_inline_command_manifest(
                    title.as_deref(),
                    description.as_deref(),
                    subject,
                    uid,
                    max_claims,
                    single_use,
                    not_before_at,
                    expires_at,
                    &required_capability,
                    &requested_capability,
                    &required_device,
                    &preferred_device,
                    process,
                    pid.as_deref(),
                    label.as_deref(),
                    parent_pid.as_deref(),
                    message.as_deref(),
                )?
            };

            let payload = client
                .request_ok(
                    "sys.command.issue",
                    Some(json!({ "manifest": manifest_value })),
                )
                .await?;
            match serde_json::from_value::<SysCommandIssuePayload>(payload.clone()) {
                Ok(result) => print_command_issue(&result),
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        CommandAction::Get { command_id } => {
            let client = KernelClient::connect_user(url, auth, |_| {}).await?;
            let payload = client
                .request_ok(
                    "sys.command.get",
                    Some(json!({ "commandId": command_id })),
                )
                .await?;
            match serde_json::from_value::<SysCommandGetPayload>(payload.clone()) {
                Ok(result) => {
                    if let Some(command) = result.command.as_ref() {
                        print_command_detail(command)?;
                    } else {
                        println!("(not found)");
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        CommandAction::List {
            issuer_uid,
            include_revoked,
        } => {
            let client = KernelClient::connect_user(url, auth, |_| {}).await?;
            let mut args = json!({});
            if let Some(issuer_uid) = issuer_uid {
                args["issuerUid"] = json!(issuer_uid);
            }
            if include_revoked {
                args["includeRevoked"] = json!(true);
            }
            let payload = client.request_ok("sys.command.list", Some(args)).await?;
            match serde_json::from_value::<SysCommandListPayload>(payload.clone()) {
                Ok(result) => print_command_list(&result.commands),
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        CommandAction::Revoke { command_id, reason } => {
            let client = KernelClient::connect_user(url, auth, |_| {}).await?;
            let mut args = json!({ "commandId": command_id });
            if let Some(reason) = reason {
                args["reason"] = json!(reason);
            }
            let payload = client.request_ok("sys.command.revoke", Some(args)).await?;
            match serde_json::from_value::<SysCommandRevokePayload>(payload.clone()) {
                Ok(result) => {
                    if result.revoked {
                        println!("revoked");
                    } else {
                        println!("not found");
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        CommandAction::Run { command_id } => {
            let debug_enabled = client_debug_enabled();
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
                    let signal_name = sig.signal.clone();
                    let payload = sig.payload.unwrap_or_else(|| json!({}));
                    let incoming_run_id = signal_run_id(&payload).unwrap_or_else(|| "<none>".to_string());
                    debug_log(
                        debug_enabled_for_handler,
                        format!("signal recv raw={} runId={}", signal_name, incoming_run_id),
                    );
                    if !signal_name.starts_with("chat.") {
                        return;
                    }

                    let expected = expected_run_id_for_handler
                        .lock()
                        .ok()
                        .and_then(|run_id| run_id.clone());
                    if !awaiting_response_for_handler.load(Ordering::SeqCst) {
                        if let Ok(mut pending) = pending_signals_for_handler.lock() {
                            pending.push(PendingChatSignal {
                                signal: signal_name.clone(),
                                payload,
                            });
                        }
                        debug_log(debug_enabled_for_handler, "signal queued (not awaiting)");
                        return;
                    }

                    if expected.as_deref() != Some(incoming_run_id.as_str()) {
                        if let Ok(mut pending) = pending_signals_for_handler.lock() {
                            pending.push(PendingChatSignal {
                                signal: signal_name.clone(),
                                payload,
                            });
                        }
                        debug_log(
                            debug_enabled_for_handler,
                            format!(
                                "signal queued (run mismatch) signal={} incoming={} expected={:?}",
                                signal_name, incoming_run_id, expected
                            ),
                        );
                        return;
                    }

                    process_chat_signal(
                        debug_enabled_for_handler,
                        &signal_name,
                        &payload,
                        &expected_run_id_for_handler,
                        awaiting_response_for_handler.as_ref(),
                        emitted_text_for_handler.as_ref(),
                        completed_for_handler.as_ref(),
                    );
                }
            })
            .await?;

            begin_wait_for_chat_response(
                completed.as_ref(),
                emitted_text.as_ref(),
                awaiting_response.as_ref(),
                &expected_run_id,
                &pending_signals,
            );

            let payload = client
                .request_ok(
                    "sys.command.execute",
                    Some(json!({ "commandId": command_id })),
                )
                .await?;
            let result: SysCommandExecutePayload = serde_json::from_value(payload.clone())
                .or_else(|_| {
                    println!("{}", serde_json::to_string_pretty(&payload)?);
                    Err(serde_json::Error::io(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "sys.command.execute schema mismatch",
                    )))
                })?;

            if !result.ok {
                return Err(result
                    .error
                    .unwrap_or_else(|| "sys.command.execute failed".to_string())
                    .into());
            }

            let run_id = result
                .run_id
                .clone()
                .ok_or("sys.command.execute did not return runId")?;

            if let Some(command_id) = result.command_id.as_deref() {
                debug_log(
                    debug_enabled,
                    format!("command.execute commandId={}", command_id),
                );
            }
            if let Some(pid) = result.pid.as_deref() {
                debug_log(
                    debug_enabled,
                    format!("command.execute pid={} runId={}", pid, run_id),
                );
            }
            if let Some(claimed_by_uid) = result.claimed_by_uid {
                println!("claimed_by_uid={}", claimed_by_uid);
            }

            if let Ok(mut expected) = expected_run_id.lock() {
                *expected = Some(run_id.clone());
            }
            drain_pending_chat_signals(
                debug_enabled,
                &run_id,
                &pending_signals,
                &expected_run_id,
                awaiting_response.as_ref(),
                emitted_text.as_ref(),
                completed.as_ref(),
            );

            wait_for_chat_complete(completed.as_ref(), debug_enabled, || {
                client.connection().is_disconnected()
            })
            .await;
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
struct SysConfigGetPayload {
    entries: Vec<SysConfigEntryPayload>,
}

#[derive(Debug, Deserialize)]
struct SysConfigEntryPayload {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct SysTokenCreatePayload {
    token: SysTokenIssuedPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysTokenIssuedPayload {
    token_id: String,
    token: String,
    token_prefix: String,
    uid: u32,
    kind: String,
    label: Option<String>,
    allowed_role: Option<String>,
    allowed_device_id: Option<String>,
    created_at: i64,
    expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SysTokenListPayload {
    tokens: Vec<SysTokenRecordPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysTokenRecordPayload {
    token_id: String,
    uid: u32,
    kind: String,
    label: Option<String>,
    token_prefix: String,
    allowed_role: Option<String>,
    allowed_device_id: Option<String>,
    created_at: i64,
    last_used_at: Option<i64>,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
    revoked_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SysTokenRevokePayload {
    revoked: bool,
}

#[derive(Debug, Deserialize)]
struct SysLinkConsumePayload {
    linked: bool,
    link: Option<SysLinkPayload>,
}

#[derive(Debug, Deserialize)]
struct SysLinkListPayload {
    links: Vec<SysLinkPayload>,
}

#[derive(Debug, Deserialize)]
struct SysUnlinkPayload {
    removed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterConnectPayload {
    ok: bool,
    adapter: Option<String>,
    account_id: Option<String>,
    connected: Option<bool>,
    authenticated: Option<bool>,
    message: Option<String>,
    challenge: Option<AdapterChallengePayload>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterDisconnectPayload {
    ok: bool,
    adapter: Option<String>,
    account_id: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterStatusPayload {
    adapter: String,
    accounts: Vec<AdapterAccountStatusPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterAccountStatusPayload {
    account_id: String,
    connected: bool,
    authenticated: bool,
    mode: Option<String>,
    last_activity: Option<i64>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterChallengePayload {
    #[serde(rename = "type")]
    challenge_type: String,
    message: Option<String>,
    data: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysLinkPayload {
    adapter: String,
    account_id: String,
    actor_id: String,
    uid: u32,
    created_at: Option<i64>,
    linked_by_uid: Option<u32>,
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

#[derive(Debug, Deserialize)]
struct SysCommandIssuePayload {
    command: IssuedCommandPayload,
    url: String,
    cli: String,
}

#[derive(Debug, Deserialize)]
struct SysCommandGetPayload {
    command: Option<IssuedCommandPayload>,
}

#[derive(Debug, Deserialize)]
struct SysCommandListPayload {
    commands: Vec<IssuedCommandPayload>,
}

#[derive(Debug, Deserialize)]
struct SysCommandRevokePayload {
    revoked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysCommandExecutePayload {
    ok: bool,
    command_id: Option<String>,
    pid: Option<String>,
    run_id: Option<String>,
    claimed_by_uid: Option<u32>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssuedCommandPayload {
    command_id: String,
    issuer_uid: u32,
    created_at: i64,
    manifest: Value,
    revoked_at: Option<i64>,
    revoked_reason: Option<String>,
    claimed_by_uid: Option<u32>,
    claim_count: u32,
    last_executed_at: Option<i64>,
}

fn display_config_value(key: &str, value: &str) -> String {
    if is_sensitive_config_key(key) {
        mask_secret(value)
    } else {
        value.to_string()
    }
}

fn is_sensitive_config_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("api_key")
        || lower.contains("access_key")
}

fn mask_secret(value: &str) -> String {
    if value.len() > 8 {
        format!("{}...{}", &value[..4], &value[value.len() - 4..])
    } else {
        "****".to_string()
    }
}

fn format_unix_ms(timestamp_ms: i64) -> String {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| timestamp_ms.to_string())
}

fn print_token_create(token: &SysTokenIssuedPayload) {
    println!("Token created.");
    println!("id: {}", token.token_id);
    println!("prefix: {}", token.token_prefix);
    println!("uid: {}", token.uid);
    println!("kind: {}", token.kind);
    println!(
        "role: {}",
        token.allowed_role.as_deref().unwrap_or("<none>")
    );
    println!(
        "device: {}",
        token.allowed_device_id.as_deref().unwrap_or("<none>")
    );
    println!("label: {}", token.label.as_deref().unwrap_or("<none>"));
    println!("created: {}", format_unix_ms(token.created_at));
    println!(
        "expires: {}",
        token
            .expires_at
            .map(format_unix_ms)
            .unwrap_or_else(|| "never".to_string())
    );
    println!("token: {}", token.token);
    println!("Store this token now; it will not be shown again.");
}

fn print_token_list(tokens: &[SysTokenRecordPayload]) {
    if tokens.is_empty() {
        println!("(no tokens)");
        return;
    }

    let now_ms = Utc::now().timestamp_millis();
    for token in tokens {
        let status = if token.revoked_at.is_some() {
            "revoked"
        } else if token
            .expires_at
            .is_some_and(|expires_at| expires_at <= now_ms)
        {
            "expired"
        } else {
            "active"
        };

        println!(
            "{} {} uid={} kind={} role={} device={} status={}",
            token.token_id,
            token.token_prefix,
            token.uid,
            token.kind,
            token.allowed_role.as_deref().unwrap_or("-"),
            token.allowed_device_id.as_deref().unwrap_or("-"),
            status
        );
        println!(
            "  label={} created={} expires={} last_used={}",
            token.label.as_deref().unwrap_or("-"),
            format_unix_ms(token.created_at),
            token
                .expires_at
                .map(format_unix_ms)
                .unwrap_or_else(|| "never".to_string()),
            token
                .last_used_at
                .map(format_unix_ms)
                .unwrap_or_else(|| "never".to_string())
        );
        if let Some(reason) = token.revoked_reason.as_deref() {
            println!("  revoked_reason={}", reason);
        }
    }
}

fn print_adapter_connect(result: &AdapterConnectPayload) {
    let adapter = result.adapter.as_deref().unwrap_or("<unknown>");
    let account_id = result.account_id.as_deref().unwrap_or("<unknown>");
    println!(
        "Connected adapter {}:{} (connected={} authenticated={})",
        adapter,
        account_id,
        result.connected.unwrap_or(false),
        result.authenticated.unwrap_or(false),
    );
    if let Some(message) = result.message.as_deref() {
        if !message.trim().is_empty() {
            println!("message: {}", message);
        }
    }

    if let Some(challenge) = result.challenge.as_ref() {
        println!("challenge.type: {}", challenge.challenge_type);
        if let Some(message) = challenge.message.as_deref() {
            println!("challenge.message: {}", message);
        }
        if let Some(expires_at) = challenge.expires_at {
            println!("challenge.expires: {}", format_unix_ms(expires_at));
        }
        if let Some(data) = challenge.data.as_deref() {
            if challenge.challenge_type == "qr" {
                if let Some(rendered) = render_terminal_qr(data) {
                    println!("\n{}", rendered);
                } else {
                    println!("challenge.data: {}", data);
                }
            } else {
                println!("challenge.data: {}", data);
            }
        }
    }
}

fn render_terminal_qr(data: &str) -> Option<String> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Binary image/data-url challenges are adapter-specific and cannot be
    // reconstructed into QR payload text safely in the CLI.
    if trimmed.starts_with("data:") {
        return None;
    }

    let qr = QrCode::new(trimmed.as_bytes()).ok()?;
    Some(
        qr.render::<unicode::Dense1x2>()
            .quiet_zone(true)
            .dark_color(unicode::Dense1x2::Dark)
            .light_color(unicode::Dense1x2::Light)
            .build(),
    )
}

fn print_adapter_disconnect(result: &AdapterDisconnectPayload) {
    let adapter = result.adapter.as_deref().unwrap_or("<unknown>");
    let account_id = result.account_id.as_deref().unwrap_or("<unknown>");
    println!("Disconnected adapter {}:{}", adapter, account_id);
    if let Some(message) = result.message.as_deref() {
        if !message.trim().is_empty() {
            println!("message: {}", message);
        }
    }
}

fn print_adapter_status(result: &AdapterStatusPayload) {
    if result.accounts.is_empty() {
        println!("adapter={} (no accounts)", result.adapter);
        return;
    }

    for account in &result.accounts {
        println!(
            "{}:{} connected={} authenticated={} mode={} last_activity={} error={}",
            result.adapter,
            account.account_id,
            account.connected,
            account.authenticated,
            account.mode.as_deref().unwrap_or("-"),
            account
                .last_activity
                .map(format_unix_ms)
                .unwrap_or_else(|| "-".to_string()),
            account.error.as_deref().unwrap_or("-"),
        );
    }
}

fn print_link_list(links: &[SysLinkPayload]) {
    for link in links {
        println!(
            "{}:{}:{} -> uid={} created={} linked_by={}",
            link.adapter,
            link.account_id,
            link.actor_id,
            link.uid,
            link.created_at
                .map(format_unix_ms)
                .unwrap_or_else(|| "-".to_string()),
            link.linked_by_uid
                .map(|uid| uid.to_string())
                .unwrap_or_else(|| "-".to_string()),
        );
    }
}

fn print_proc_list(processes: &[ProcListEntryPayload]) {
    if processes.is_empty() {
        println!("(no processes)");
        return;
    }

    for process in processes {
        println!(
            "{} state={} uid={} parent={} label={} created={}",
            process.pid,
            process.state,
            process.uid,
            process.parent_pid.as_deref().unwrap_or("-"),
            process.label.as_deref().unwrap_or("-"),
            format_unix_ms(process.created_at)
        );
    }
}

fn render_message_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    serde_json::to_string(content).unwrap_or_else(|_| "<unrenderable>".to_string())
}

fn ensure_no_inline_command_builder_fields(
    title: Option<&String>,
    description: Option<&String>,
    uid: Option<u32>,
    max_claims: Option<u32>,
    single_use: bool,
    not_before_at: Option<i64>,
    expires_at: Option<i64>,
    required_capability: &[String],
    requested_capability: &[String],
    required_device: &[String],
    preferred_device: &[String],
    pid: Option<&String>,
    label: Option<&String>,
    parent_pid: Option<&String>,
    message: Option<&String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let has_inline_fields = title.is_some()
        || description.is_some()
        || uid.is_some()
        || max_claims.is_some()
        || single_use
        || not_before_at.is_some()
        || expires_at.is_some()
        || !required_capability.is_empty()
        || !requested_capability.is_empty()
        || !required_device.is_empty()
        || !preferred_device.is_empty()
        || pid.is_some()
        || label.is_some()
        || parent_pid.is_some()
        || message.is_some();

    if has_inline_fields {
        return Err(
            "When --manifest is used, omit inline builder fields like message/title/policy/process flags"
                .into(),
        );
    }

    Ok(())
}

fn build_inline_command_manifest(
    title: Option<&str>,
    description: Option<&str>,
    subject: CommandSubjectArg,
    uid: Option<u32>,
    max_claims: Option<u32>,
    single_use: bool,
    not_before_at: Option<i64>,
    expires_at: Option<i64>,
    required_capability: &[String],
    requested_capability: &[String],
    required_device: &[String],
    preferred_device: &[String],
    process: CommandProcessArg,
    pid: Option<&str>,
    label: Option<&str>,
    parent_pid: Option<&str>,
    message: Option<&str>,
) -> Result<Value, Box<dyn std::error::Error>> {
    let message = message
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Inline command issue requires a message")?;

    if subject.as_str() != "uid" && uid.is_some() {
        return Err("--uid may only be used with --subject uid".into());
    }
    if subject.as_str() != "claim" && max_claims.is_some() {
        return Err("--max-claims may only be used with --subject claim".into());
    }

    let subject_value = match subject {
        CommandSubjectArg::Issuer => json!({ "kind": "issuer" }),
        CommandSubjectArg::Uid => json!({
            "kind": "uid",
            "uid": uid.ok_or("--uid is required when --subject uid is used")?,
        }),
        CommandSubjectArg::Claim => {
            let mut value = json!({ "kind": "claim" });
            if let Some(max_claims) = max_claims {
                value["maxClaims"] = json!(max_claims);
            }
            value
        }
    };

    let process_value = match process {
        CommandProcessArg::Init => {
            if pid.is_some() {
                return Err("--pid may only be used with --process pid".into());
            }
            if label.is_some() || parent_pid.is_some() {
                return Err("--label/--parent may only be used with --process spawn".into());
            }
            json!({ "kind": "init" })
        }
        CommandProcessArg::Pid => {
            if label.is_some() || parent_pid.is_some() {
                return Err("--label/--parent may only be used with --process spawn".into());
            }
            json!({
                "kind": "pid",
                "pid": pid
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("--pid is required when --process pid is used")?,
            })
        }
        CommandProcessArg::Spawn => {
            if pid.is_some() {
                return Err("--pid may only be used with --process pid".into());
            }
            let mut value = json!({ "kind": "spawn" });
            if let Some(label) = label.map(str::trim).filter(|value| !value.is_empty()) {
                value["label"] = json!(label);
            }
            if let Some(parent_pid) = parent_pid.map(str::trim).filter(|value| !value.is_empty()) {
                value["parentPid"] = json!(parent_pid);
            }
            value
        }
    };

    let mut manifest = serde_json::Map::new();
    manifest.insert("version".to_string(), json!(1));
    manifest.insert("kind".to_string(), json!("gsv.command"));
    manifest.insert("subject".to_string(), subject_value);
    manifest.insert(
        "execution".to_string(),
        json!({
            "process": process_value,
            "input": {
                "kind": "message",
                "message": message,
            }
        }),
    );

    if let Some(title) = title.map(str::trim).filter(|value| !value.is_empty()) {
        manifest.insert("title".to_string(), json!(title));
    }
    if let Some(description) = description.map(str::trim).filter(|value| !value.is_empty()) {
        manifest.insert("description".to_string(), json!(description));
    }

    let mut validity = serde_json::Map::new();
    if let Some(not_before_at) = not_before_at {
        validity.insert("notBeforeAt".to_string(), json!(not_before_at));
    }
    if let Some(expires_at) = expires_at {
        validity.insert("expiresAt".to_string(), json!(expires_at));
    }
    if single_use {
        validity.insert("singleUse".to_string(), json!(true));
    }
    if !validity.is_empty() {
        manifest.insert("validity".to_string(), Value::Object(validity));
    }

    let mut policy = serde_json::Map::new();
    if !required_capability.is_empty() {
        policy.insert(
            "requiredCapabilities".to_string(),
            json!(required_capability),
        );
    }
    if !requested_capability.is_empty() {
        policy.insert(
            "requestedCapabilities".to_string(),
            json!(requested_capability),
        );
    }
    if !required_device.is_empty() {
        policy.insert("requiredDevices".to_string(), json!(required_device));
    }
    if !preferred_device.is_empty() {
        policy.insert("preferredDevices".to_string(), json!(preferred_device));
    }
    if !policy.is_empty() {
        manifest.insert("policy".to_string(), Value::Object(policy));
    }

    Ok(Value::Object(manifest))
}

fn print_command_issue(result: &SysCommandIssuePayload) {
    println!("Command issued.");
    print_command_summary(&result.command);
    println!("url: {}", result.url);
    println!("cli: {}", result.cli);
}

fn print_command_detail(command: &IssuedCommandPayload) -> Result<(), Box<dyn std::error::Error>> {
    print_command_summary(command);
    println!(
        "manifest:\n{}",
        serde_json::to_string_pretty(&command.manifest)?
    );
    Ok(())
}

fn print_command_list(commands: &[IssuedCommandPayload]) {
    if commands.is_empty() {
        println!("(no commands)");
        return;
    }

    for command in commands {
        print_command_summary(command);
    }
}

fn print_command_summary(command: &IssuedCommandPayload) {
    println!(
        "{} title={} subject={} status={} issuer={} claims={} created={}",
        command.command_id,
        command_title(&command.manifest),
        command_subject_summary(&command.manifest),
        command_status_summary(command),
        command.issuer_uid,
        command.claim_count,
        format_unix_ms(command.created_at),
    );

    if let Some(claimed_by_uid) = command.claimed_by_uid {
        println!("  claimed_by={}", claimed_by_uid);
    }
    if let Some(last_executed_at) = command.last_executed_at {
        println!("  last_executed={}", format_unix_ms(last_executed_at));
    }
    if let Some(revoked_reason) = command.revoked_reason.as_deref() {
        println!("  revoked_reason={}", revoked_reason);
    }
}

fn command_title(manifest: &Value) -> String {
    manifest
        .get("title")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "-".to_string())
}

fn command_subject_summary(manifest: &Value) -> String {
    let subject = match manifest.get("subject") {
        Some(subject) => subject,
        None => return "-".to_string(),
    };
    let kind = subject
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");

    match kind {
        "uid" => format!(
            "uid:{}",
            subject
                .get("uid")
                .and_then(|value| value.as_u64())
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".to_string())
        ),
        "claim" => {
            if let Some(max_claims) = subject.get("maxClaims").and_then(|value| value.as_u64()) {
                format!("claim:{}", max_claims)
            } else {
                "claim".to_string()
            }
        }
        "issuer" => "issuer".to_string(),
        other => other.to_string(),
    }
}

fn command_status_summary(command: &IssuedCommandPayload) -> String {
    let now_ms = Utc::now().timestamp_millis();
    if command.revoked_at.is_some() {
        return "revoked".to_string();
    }

    if let Some(expires_at) = command
        .manifest
        .get("validity")
        .and_then(|value| value.get("expiresAt"))
        .and_then(|value| value.as_i64())
    {
        if expires_at <= now_ms {
            return "expired".to_string();
        }
    }

    if command.claimed_by_uid.is_some() {
        return "claimed".to_string();
    }

    "active".to_string()
}
