use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gsv::config::CliConfig;
use gsv::connection::{Connection, GatewayRpcError};
use gsv::device_service;
use gsv::kernel_client::{GatewayAuth, KernelClient};
use gsv::logger::{self, NodeLogger};
use gsv::protocol::{
    ErrorShape, Frame, NodeExecEventParams, RequestFrame, ResponseFrame, SignalFrame,
};
use gsv::tools::{all_tools_with_workspace_for_device, subscribe_exec_events, Tool};
use serde_json::json;

use crate::cli::DeviceServiceAction;

mod transfer;

const MAX_NODE_EXEC_EVENT_OUTBOX: usize = 2048;

#[cfg(unix)]
async fn wait_for_shutdown_signal() -> &'static str {
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Failed to subscribe to SIGTERM");

    tokio::select! {
        _ = tokio::signal::ctrl_c() => "SIGINT",
        _ = sigterm.recv() => "SIGTERM",
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown_signal() -> &'static str {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to subscribe to Ctrl+C");
    "SIGINT"
}

pub(crate) fn resolve_node_id(cli_node_id: Option<String>, cfg: &CliConfig) -> String {
    cli_node_id
        .or_else(|| cfg.default_node_id())
        .unwrap_or_else(|| {
            let hostname = hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string());
            format!("node-{}", hostname)
        })
}

pub(crate) fn resolve_node_workspace(cli_workspace: Option<PathBuf>, cfg: &CliConfig) -> PathBuf {
    cli_workspace
        .or_else(|| cfg.default_node_workspace())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn persist_node_defaults(
    cfg: &CliConfig,
    node_id: Option<String>,
    workspace: Option<PathBuf>,
) -> Result<(String, PathBuf, bool), Box<dyn std::error::Error>> {
    let node_id = resolve_node_id(node_id, cfg);
    let workspace = resolve_node_workspace(workspace, cfg);
    let workspace = workspace.canonicalize().unwrap_or(workspace);

    let mut local_cfg = CliConfig::load();
    let mut changed = false;

    if local_cfg.node.id.as_deref() != Some(node_id.as_str()) {
        local_cfg.node.id = Some(node_id.clone());
        changed = true;
    }

    if local_cfg.node.workspace.as_ref() != Some(&workspace) {
        local_cfg.node.workspace = Some(workspace.clone());
        changed = true;
    }

    if changed {
        local_cfg.save()?;
    }

    Ok((node_id, workspace, changed))
}

fn persist_gateway_overrides(
    gateway_url_override: Option<&str>,
    gateway_username_override: Option<&str>,
    gateway_token_override: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    if gateway_url_override.is_none()
        && gateway_username_override.is_none()
        && gateway_token_override.is_none()
    {
        return Ok(false);
    }

    let mut local_cfg = CliConfig::load();
    let mut changed = false;

    if let Some(url) = gateway_url_override {
        if local_cfg.gateway.url.as_deref() != Some(url) {
            local_cfg.gateway.url = Some(url.to_string());
            changed = true;
        }
    }

    if let Some(username) = gateway_username_override {
        if local_cfg.gateway.username.as_deref() != Some(username) {
            local_cfg.gateway.username = Some(username.to_string());
            changed = true;
        }
    }

    if let Some(token) = gateway_token_override {
        if local_cfg.gateway.token.as_deref() != Some(token) {
            local_cfg.gateway.token = Some(token.to_string());
            changed = true;
        }
    }

    if changed {
        local_cfg.save()?;
    }

    Ok(changed)
}

pub(crate) fn run_device_service(
    action: DeviceServiceAction,
    cfg: &CliConfig,
    gateway_url_override: Option<&str>,
    gateway_username_override: Option<&str>,
    gateway_token_override: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        DeviceServiceAction::Install { id, workspace } => {
            let gateway_overrides_changed = persist_gateway_overrides(
                gateway_url_override,
                gateway_username_override,
                gateway_token_override,
            )?;
            let (node_id, workspace, node_defaults_changed) =
                persist_node_defaults(cfg, id, workspace)?;

            device_service::install_device_service()?;

            if gateway_overrides_changed || node_defaults_changed {
                device_service::restart_device_service()?;
            }

            println!("Device daemon installed and started.");
            if gateway_overrides_changed {
                println!("Saved gateway connection overrides to local config.");
            }
            println!(
                "Saved defaults: node.id={}, node.workspace={}",
                node_id,
                workspace.display()
            );
            println!("\nCheck status:");
            println!("  gsv device status");
            println!("View logs:");
            println!("  gsv device logs --follow");
        }
        DeviceServiceAction::Uninstall => {
            device_service::uninstall_device_service()?;

            println!("Device daemon uninstalled.");
        }
        DeviceServiceAction::Start => {
            let gateway_overrides_changed = persist_gateway_overrides(
                gateway_url_override,
                gateway_username_override,
                gateway_token_override,
            )?;

            if gateway_overrides_changed {
                device_service::restart_device_service()?;
                println!("Saved gateway connection overrides to local config.");
                println!("Device daemon restarted.");
                return Ok(());
            }

            device_service::start_device_service()?;

            println!("Device daemon started.");
        }
        DeviceServiceAction::Stop => {
            device_service::stop_device_service()?;

            println!("Device daemon stopped.");
        }
        DeviceServiceAction::Status => {
            device_service::status_device_service()?;
        }
        DeviceServiceAction::Logs { lines, follow } => {
            device_service::show_device_service_logs(lines, follow)?;
        }
    }

    Ok(())
}

fn exec_event_outbox_len(outbox: &Arc<Mutex<VecDeque<NodeExecEventParams>>>) -> usize {
    outbox.lock().map(|queue| queue.len()).unwrap_or(0)
}

enum ExecEventSendOutcome {
    Sent,
    Retry(String),
    Drop(String),
}

fn queue_exec_event_for_retry(
    outbox: &Arc<Mutex<VecDeque<NodeExecEventParams>>>,
    event: NodeExecEventParams,
    logger: &NodeLogger,
) {
    let mut queue = match outbox.lock() {
        Ok(queue) => queue,
        Err(error) => {
            logger.error(
                "node.exec.event.outbox_lock_failed",
                json!({
                    "error": error.to_string(),
                }),
            );
            return;
        }
    };

    if queue.len() >= MAX_NODE_EXEC_EVENT_OUTBOX {
        if let Some(dropped) = queue.pop_front() {
            logger.warn(
                "node.exec.event.outbox_drop_oldest",
                json!({
                    "eventId": dropped.event_id,
                    "sessionId": dropped.session_id,
                    "event": dropped.event,
                    "maxOutbox": MAX_NODE_EXEC_EVENT_OUTBOX,
                }),
            );
        }
    }

    queue.push_back(event);
}

async fn flush_exec_event_outbox_with_sender<F, Fut>(
    outbox: &Arc<Mutex<VecDeque<NodeExecEventParams>>>,
    logger: &NodeLogger,
    mut send_event: F,
) -> usize
where
    F: FnMut(NodeExecEventParams) -> Fut,
    Fut: Future<Output = ExecEventSendOutcome>,
{
    let mut sent = 0usize;

    loop {
        let next_event = match outbox.lock() {
            Ok(queue) => queue.front().cloned(),
            Err(error) => {
                logger.error(
                    "node.exec.event.outbox_lock_failed",
                    json!({
                        "error": error.to_string(),
                    }),
                );
                return sent;
            }
        };

        let Some(event) = next_event else {
            return sent;
        };

        match send_event(event.clone()).await {
            ExecEventSendOutcome::Sent => {
                if let Ok(mut queue) = outbox.lock() {
                    let _ = queue.pop_front();
                }
                sent += 1;
            }
            ExecEventSendOutcome::Drop(error) => {
                logger.error(
                    "node.exec.event.serialize_failed",
                    json!({
                        "eventId": event.event_id,
                        "sessionId": event.session_id,
                        "event": event.event,
                        "error": error,
                    }),
                );
                if let Ok(mut queue) = outbox.lock() {
                    let _ = queue.pop_front();
                }
                continue;
            }
            ExecEventSendOutcome::Retry(error) => {
                logger.warn(
                    "node.exec.event.send_failed",
                    json!({
                        "eventId": event.event_id,
                        "sessionId": event.session_id,
                        "event": event.event,
                        "error": error,
                        "outboxDepth": exec_event_outbox_len(outbox),
                    }),
                );
                return sent;
            }
        }
    }
}

async fn flush_exec_event_outbox(
    conn: &Arc<Connection>,
    outbox: &Arc<Mutex<VecDeque<NodeExecEventParams>>>,
    logger: &NodeLogger,
) -> usize {
    flush_exec_event_outbox_with_sender(outbox, logger, |event| {
        let conn = Arc::clone(conn);
        async move {
            let payload = match serde_json::to_value(&event) {
                Ok(value) => value,
                Err(error) => return ExecEventSendOutcome::Drop(error.to_string()),
            };

            let frame = Frame::Sig(SignalFrame {
                signal: "exec.status".to_string(),
                payload: Some(payload),
                seq: None,
            });

            match serde_json::to_string(&frame) {
                Ok(text) => match conn.send_raw(text).await {
                    Ok(_) => ExecEventSendOutcome::Sent,
                    Err(error) => ExecEventSendOutcome::Retry(error.to_string()),
                },
                Err(error) => ExecEventSendOutcome::Drop(error.to_string()),
            }
        }
    })
    .await
}

fn syscall_to_tool_name(call: &str) -> Option<&'static str> {
    match call {
        "fs.read" => Some("Read"),
        "fs.write" => Some("Write"),
        "fs.edit" => Some("Edit"),
        "fs.copy" => Some("Copy"),
        "fs.search" => Some("Search"),
        "fs.delete" => Some("Delete"),
        "shell.exec" => Some("Shell"),
        _ => None,
    }
}

async fn handle_driver_request(
    conn: &Arc<Connection>,
    tools: &[Box<dyn Tool>],
    workspace: &Path,
    req: &RequestFrame,
    logger: &NodeLogger,
    binary_inbox: &transfer::BinaryFrameInbox,
) {
    let args = req.args.clone().unwrap_or(serde_json::Value::Null);

    let call = req.call.as_str();
    let result = if let Some(transfer_result) =
        transfer::handle_transfer_syscall(call, args.clone(), workspace, conn, binary_inbox).await
    {
        transfer_result
    } else if let Some(tool_name) = syscall_to_tool_name(call) {
        execute_tool_by_name(tools, tool_name, args).await
    } else {
        Err(format!("unknown syscall: {}", call))
    };

    let response = match result {
        Ok(data) => Frame::Res(ResponseFrame {
            id: req.id.clone(),
            ok: true,
            data: Some(data),
            error: None,
        }),
        Err(message) => {
            if req.call.starts_with("fs.") {
                Frame::Res(ResponseFrame {
                    id: req.id.clone(),
                    ok: true,
                    data: Some(json!({
                        "ok": false,
                        "error": message,
                    })),
                    error: None,
                })
            } else {
                Frame::Res(ResponseFrame {
                    id: req.id.clone(),
                    ok: false,
                    data: None,
                    error: Some(ErrorShape {
                        code: -1,
                        message: message.clone(),
                        details: None,
                        retryable: None,
                    }),
                })
            }
        }
    };

    match serde_json::to_string(&response) {
        Ok(text) => {
            if let Err(e) = conn.send_raw(text).await {
                logger.error(
                    "driver.response.send_failed",
                    json!({
                        "requestId": req.id,
                        "call": req.call,
                        "error": e.to_string(),
                    }),
                );
            }
        }
        Err(e) => {
            logger.error(
                "driver.response.serialize_failed",
                json!({
                    "requestId": req.id,
                    "call": req.call,
                    "error": e.to_string(),
                }),
            );
        }
    }
}

async fn execute_tool_by_name(
    tools: &[Box<dyn Tool>],
    name: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    for tool in tools {
        if tool.definition().name == name {
            return tool.execute(args).await;
        }
    }
    Err(format!("tool not found: {}", name))
}

pub(crate) async fn run_shell(
    url: &str,
    auth: GatewayAuth,
) -> Result<(), Box<dyn std::error::Error>> {
    let username = auth.username.clone();
    let client = KernelClient::connect_user(url, auth, |frame| {
        if let Frame::Sig(sig) = frame {
            eprintln!("[signal] {}: {:?}", sig.signal, sig.payload);
        }
    })
    .await?;

    let username = username.unwrap_or_else(|| "setup".to_string());
    println!("Connected to GSV OS as {}", username);
    println!("Type commands to execute, or :quit to exit");
    println!();

    let stdin = io::stdin();

    loop {
        eprint!("gsv$ ");
        {
            use std::io::Write;
            let _ = std::io::stderr().flush();
        }

        let mut line = String::new();
        if stdin.read_line(&mut line)? == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == ":quit" || trimmed == ":exit" || trimmed == ":q" {
            break;
        }

        let res = client
            .connection()
            .request("shell.exec", Some(json!({ "input": trimmed })))
            .await?;

        if res.ok {
            if let Some(data) = &res.data {
                if let Some(stdout) = data.get("stdout").and_then(|v| v.as_str()) {
                    if !stdout.is_empty() {
                        print!("{}", stdout);
                    }
                }
                if let Some(stderr) = data.get("stderr").and_then(|v| v.as_str()) {
                    if !stderr.is_empty() {
                        eprint!("{}", stderr);
                    }
                }
                if let Some(exit_code) = data.get("exitCode").and_then(|v| v.as_i64()) {
                    if exit_code != 0 {
                        eprintln!("[exit {}]", exit_code);
                    }
                }
            }
        } else if let Some(err) = &res.error {
            eprintln!("error [{}]: {}", err.code, err.message);
        }
    }

    println!("bye");
    Ok(())
}

pub(crate) async fn run_node(
    url: &str,
    auth: GatewayAuth,
    node_id: String,
    workspace: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let logger = NodeLogger::new(&node_id, &workspace)?;
    let log_path = logger::node_log_path()?;
    logger.info(
        "node.start",
        json!({
            "url": url,
            "logPath": log_path.display().to_string(),
            "logMaxBytes": logger::node_log_max_bytes(),
            "logMaxFiles": logger::node_log_max_files(),
        }),
    );

    let shutdown = wait_for_shutdown_signal();
    tokio::pin!(shutdown);

    let exec_event_outbox: Arc<Mutex<VecDeque<NodeExecEventParams>>> =
        Arc::new(Mutex::new(VecDeque::new()));
    let outbox_for_exec_events = exec_event_outbox.clone();
    let logger_for_exec_events = logger.clone();
    let mut exec_events = subscribe_exec_events();
    let exec_event_collector = tokio::spawn(async move {
        loop {
            match exec_events.recv().await {
                Ok(event) => {
                    queue_exec_event_for_retry(
                        &outbox_for_exec_events,
                        event,
                        &logger_for_exec_events,
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    logger_for_exec_events.warn(
                        "node.exec.event.lagged",
                        json!({
                            "skipped": skipped,
                        }),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    const CONNECT_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(30);
    const INITIAL_RETRY_DELAY: tokio::time::Duration = tokio::time::Duration::from_secs(3);
    const MAX_RETRY_DELAY: tokio::time::Duration = tokio::time::Duration::from_secs(300);
    let mut retry_delay = INITIAL_RETRY_DELAY;

    loop {
        logger.info("connect.attempt", json!({ "url": url }));

        let tools_for_handler: Arc<Vec<Box<dyn Tool>>> = Arc::new(
            all_tools_with_workspace_for_device(workspace.clone(), node_id.clone()),
        );

        let conn = match tokio::time::timeout(
            CONNECT_TIMEOUT,
            KernelClient::connect_driver(
                url,
                node_id.clone(),
                vec!["fs.*".to_string(), "shell.exec".to_string()],
                auth.clone(),
                |_frame| {},
            ),
        )
        .await
        {
            Ok(Ok(c)) => {
                retry_delay = INITIAL_RETRY_DELAY;
                c.into_connection()
            }
            Ok(Err(e)) => {
                if let Some(rpc_error) = e.downcast_ref::<GatewayRpcError>() {
                    if rpc_error.is_setup_required() {
                        logger.error(
                            "connect.setup_required",
                            json!({
                                "error": rpc_error.to_string(),
                            }),
                        );
                        return Err(e);
                    }
                }
                logger.error(
                    "connect.failed",
                    json!({
                        "error": e.to_string(),
                        "retrySeconds": retry_delay.as_secs(),
                    }),
                );
                tokio::time::sleep(retry_delay).await;
                retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                continue;
            }
            Err(_) => {
                logger.error(
                    "connect.timeout",
                    json!({
                        "timeoutSeconds": CONNECT_TIMEOUT.as_secs(),
                        "retrySeconds": retry_delay.as_secs(),
                    }),
                );
                tokio::time::sleep(retry_delay).await;
                retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                continue;
            }
        };

        logger.info(
            "connect.ok",
            json!({
                "implements": ["fs.*", "shell.*"],
            }),
        );

        let conn = Arc::new(conn);
        let binary_inbox = transfer::BinaryFrameInbox::new();
        let binary_inbox_for_handler = binary_inbox.clone();
        conn.set_binary_handler(move |data| {
            binary_inbox_for_handler.push(data);
        })
        .await;

        let conn_clone = conn.clone();
        let tools_clone = tools_for_handler.clone();
        let workspace_clone = workspace.clone();
        let logger_clone = logger.clone();
        let binary_inbox_clone = binary_inbox.clone();

        // In the new OS architecture, the kernel sends req frames directly to
        // the driver. We dispatch based on `call` and respond with a res frame.
        conn.set_frame_handler(move |frame| {
            let conn = conn_clone.clone();
            let tools = tools_clone.clone();
            let workspace = workspace_clone.clone();
            let logger = logger_clone.clone();
            let binary_inbox = binary_inbox_clone.clone();

            tokio::spawn(async move {
                if let Frame::Req(req) = frame {
                    handle_driver_request(&conn, &tools, &workspace, &req, &logger, &binary_inbox)
                        .await;
                }
            });
        })
        .await;

        let flushed = flush_exec_event_outbox(&conn, &exec_event_outbox, &logger).await;
        if flushed > 0 {
            logger.info(
                "node.exec.event.flushed",
                json!({
                    "sent": flushed,
                    "remaining": exec_event_outbox_len(&exec_event_outbox),
                }),
            );
        }

        let keepalive_interval = tokio::time::Duration::from_secs(240);
        let keepalive_timeout = tokio::time::Duration::from_secs(10);
        logger.info(
            "connect.ok",
            json!({
                "keepaliveSeconds": keepalive_interval.as_secs(),
            }),
        );
        let mut next_keepalive_at = tokio::time::Instant::now() + keepalive_interval;

        // Monitor for disconnection or Ctrl+C
        loop {
            tokio::select! {
                signal = &mut shutdown => {
                    exec_event_collector.abort();
                    logger.info("shutdown", json!({ "signal": signal }));
                    return Ok(());
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
                    if conn.is_disconnected() {
                        logger.warn(
                            "connect.lost",
                            json!({
                                "retrySeconds": 3,
                            }),
                        );
                        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                        break; // Break inner loop to reconnect
                    }

                    let flushed = flush_exec_event_outbox(&conn, &exec_event_outbox, &logger).await;
                    if flushed > 0 {
                        logger.info(
                            "node.exec.event.flushed",
                            json!({
                                "sent": flushed,
                                "remaining": exec_event_outbox_len(&exec_event_outbox),
                            }),
                        );
                    }

                    if tokio::time::Instant::now() >= next_keepalive_at {
                        let payload = b"gsv-keepalive".to_vec();
                        let keepalive = tokio::time::timeout(keepalive_timeout, conn.send_ping(payload)).await;

                        match keepalive {
                            Ok(Ok(())) => {
                                next_keepalive_at = tokio::time::Instant::now() + keepalive_interval;
                            }
                            Ok(Err(e)) => {
                                logger.warn(
                                    "keepalive.request_error",
                                    json!({
                                        "error": e.to_string(),
                                        "retrySeconds": 3,
                                    }),
                                );
                                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                                break;
                            }
                            Err(_) => {
                                logger.warn(
                                    "keepalive.timeout",
                                    json!({
                                        "timeoutSeconds": 10,
                                        "retrySeconds": 3,
                                    }),
                                );
                                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn test_logger() -> NodeLogger {
        let log_path =
            std::env::temp_dir().join(format!("gsv-node-test-{}.log", uuid::Uuid::new_v4()));
        NodeLogger::with_path("test-node", "/tmp", &log_path, 1024 * 1024, 1)
            .expect("create test logger")
    }

    fn test_exec_event(index: usize) -> NodeExecEventParams {
        NodeExecEventParams {
            event_id: format!("event-{index}"),
            session_id: format!("session-{index}"),
            event: "finished".to_string(),
            call_id: Some(format!("call-{index}")),
            exit_code: Some(0),
            signal: None,
            output_tail: Some("ok".to_string()),
            started_at: Some(1),
            ended_at: Some(2),
        }
    }

    #[test]
    fn test_queue_exec_event_for_retry_drops_oldest_when_full() {
        let logger = test_logger();
        let outbox: Arc<Mutex<VecDeque<NodeExecEventParams>>> =
            Arc::new(Mutex::new(VecDeque::new()));

        for i in 0..=MAX_NODE_EXEC_EVENT_OUTBOX {
            queue_exec_event_for_retry(&outbox, test_exec_event(i), &logger);
        }

        let queue = outbox.lock().expect("outbox lock");
        assert_eq!(queue.len(), MAX_NODE_EXEC_EVENT_OUTBOX);
        assert_eq!(
            queue.front().map(|event| event.event_id.as_str()),
            Some("event-1")
        );
        let expected_last = format!("event-{MAX_NODE_EXEC_EVENT_OUTBOX}");
        assert_eq!(
            queue.back().map(|event| event.event_id.as_str()),
            Some(expected_last.as_str())
        );
    }

    #[tokio::test]
    async fn test_flush_exec_event_outbox_retry_keeps_event_queued() {
        let logger = test_logger();
        let outbox: Arc<Mutex<VecDeque<NodeExecEventParams>>> =
            Arc::new(Mutex::new(VecDeque::new()));
        queue_exec_event_for_retry(&outbox, test_exec_event(1), &logger);

        let sent = flush_exec_event_outbox_with_sender(&outbox, &logger, |_event| async {
            ExecEventSendOutcome::Retry("simulated send failure".to_string())
        })
        .await;

        assert_eq!(sent, 0);
        let queue = outbox.lock().expect("outbox lock");
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue.front().map(|event| event.event_id.as_str()),
            Some("event-1")
        );
    }
}
