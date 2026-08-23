use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gateway_client::client::GatewayAuth;
use gateway_client::connection::{Connection, ConnectionOptions, GatewayRpcError, PeerIdentity};
use gateway_client::protocol::{
    DeviceExecEventParams, ErrorShape, Frame, RequestFrame, ResponseFrame, SignalFrame,
    REQUEST_CANCEL_SIGNAL,
};
use gateway_client::{BinaryBody, BinaryBodyLimits, IncomingBody, OutgoingBody};
use serde::Deserialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, info_span, warn, Instrument};

use crate::control::DaemonRuntime;
use crate::logger;
use crate::tools::{all_tools_with_workspace_for_device, subscribe_exec_events, Tool, ToolOutput};

mod transfer;

const MAX_DEVICE_EXEC_EVENT_OUTBOX: usize = 2048;
const DEVICE_DRIVER_IMPLEMENTS: &[&str] = &["fs.*", "shell.exec", "net.fetch"];

#[derive(Default)]
struct ActiveRequestState {
    accepting: bool,
    requests: HashMap<String, ActiveRequest>,
}

#[derive(Clone)]
struct ActiveRequests(Arc<Mutex<ActiveRequestState>>);

impl Default for ActiveRequests {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(ActiveRequestState {
            accepting: true,
            requests: HashMap::new(),
        })))
    }
}

struct ActiveRequest {
    cancellation: Arc<CancellationToken>,
}

#[derive(Deserialize)]
struct RequestCancel {
    id: String,
    reason: Option<String>,
}

struct PreparedResponseBody {
    outgoing: OutgoingBody,
    deadline: Option<tokio::time::Instant>,
    source: String,
}

impl PreparedResponseBody {
    async fn send(self) -> Result<(), String> {
        let source = self.source;
        match self.deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, self.outgoing.send())
                .await
                .map_err(|_| format!("Timed out sending '{source}'"))?
                .map_err(|error| error.to_string()),
            None => self
                .outgoing
                .send()
                .await
                .map_err(|error| error.to_string()),
        }
    }
}

impl ActiveRequests {
    fn register(&self, request: &RequestFrame) -> Arc<CancellationToken> {
        let cancellation = Arc::new(CancellationToken::new());
        let previous = {
            let mut state = self.0.lock().expect("active request mutex poisoned");
            if !state.accepting {
                cancellation.cancel();
                return cancellation;
            }
            state.requests.insert(
                request.id.clone(),
                ActiveRequest {
                    cancellation: cancellation.clone(),
                },
            )
        };
        if let Some(previous) = previous {
            Self::stop(previous);
        }
        cancellation
    }

    fn cancel(&self, cancellation: RequestCancel) -> bool {
        let Some(request) = self
            .0
            .lock()
            .expect("active request mutex poisoned")
            .requests
            .remove(&cancellation.id)
        else {
            return false;
        };
        let _reason = cancellation
            .reason
            .as_deref()
            .unwrap_or("Request cancelled");
        Self::stop(request);
        true
    }

    fn cancel_all(&self, _reason: &str) {
        let requests = {
            let mut state = self.0.lock().expect("active request mutex poisoned");
            state.accepting = false;
            state
                .requests
                .drain()
                .map(|(_, request)| request)
                .collect::<Vec<_>>()
        };
        for request in requests {
            Self::stop(request);
        }
    }

    fn stop(request: ActiveRequest) {
        request.cancellation.cancel();
    }

    fn finish(&self, id: &str, cancellation: &Arc<CancellationToken>) {
        let mut state = self.0.lock().expect("active request mutex poisoned");
        if state
            .requests
            .get(id)
            .is_some_and(|request| Arc::ptr_eq(&request.cancellation, cancellation))
        {
            state.requests.remove(id);
        }
    }
}

fn prepare_response_body(
    conn: &Connection,
    body: crate::tools::ToolBody,
) -> Result<PreparedResponseBody, String> {
    let mut binary = BinaryBody::from_reader(body.reader, body.length);
    if let Some(max_length) = body.max_length {
        binary = binary.with_max_bytes(max_length);
    }
    let outgoing = conn
        .body_channel()
        .prepare(binary)
        .map_err(|error| format!("Could not prepare '{}': {error}", body.source))?;
    Ok(PreparedResponseBody {
        outgoing,
        deadline: body.deadline,
        source: body.source,
    })
}

fn driver_error_frame(request: &RequestFrame, message: String) -> Frame {
    if request.call.starts_with("fs.") {
        Frame::Res(ResponseFrame {
            id: request.id.clone(),
            ok: true,
            data: Some(json!({
                "ok": false,
                "error": message,
            })),
            error: None,
            body: None,
        })
    } else {
        Frame::Res(ResponseFrame {
            id: request.id.clone(),
            ok: false,
            data: None,
            error: Some(ErrorShape {
                code: -1,
                message,
                details: None,
                retryable: None,
            }),
            body: None,
        })
    }
}

async fn send_driver_error(conn: &Connection, request: &RequestFrame, message: String) {
    let response = driver_error_frame(request, message);
    match serde_json::to_string(&response) {
        Ok(text) => {
            if let Err(error) = conn.send_raw(text).await {
                error!(
                    event = "driver.response.send_failed",
                    request_id = %request.id,
                    call = %request.call,
                    error = %error,
                );
            }
        }
        Err(error) => {
            error!(
                event = "driver.response.serialize_failed",
                request_id = %request.id,
                call = %request.call,
                error = %error,
            );
        }
    }
}

fn exec_event_outbox_len(outbox: &Arc<Mutex<VecDeque<DeviceExecEventParams>>>) -> usize {
    outbox.lock().map(|queue| queue.len()).unwrap_or(0)
}

enum ExecEventSendOutcome {
    Sent,
    Retry(String),
    Drop(String),
}

fn queue_exec_event_for_retry(
    outbox: &Arc<Mutex<VecDeque<DeviceExecEventParams>>>,
    event: DeviceExecEventParams,
) {
    let mut queue = match outbox.lock() {
        Ok(queue) => queue,
        Err(error) => {
            error!(event = "device.exec.event.outbox_lock_failed", error = %error);
            return;
        }
    };

    if queue.len() >= MAX_DEVICE_EXEC_EVENT_OUTBOX {
        if let Some(dropped) = queue.pop_front() {
            warn!(
                event = "device.exec.event.outbox_drop_oldest",
                event_id = %dropped.event_id,
                session_id = %dropped.session_id,
                exec_event = %dropped.event,
                max_outbox = MAX_DEVICE_EXEC_EVENT_OUTBOX,
            );
        }
    }

    queue.push_back(event);
}

async fn flush_exec_event_outbox_with_sender<F, Fut>(
    outbox: &Arc<Mutex<VecDeque<DeviceExecEventParams>>>,
    mut send_event: F,
) -> usize
where
    F: FnMut(DeviceExecEventParams) -> Fut,
    Fut: Future<Output = ExecEventSendOutcome>,
{
    let mut sent = 0usize;

    loop {
        let next_event = match outbox.lock() {
            Ok(queue) => queue.front().cloned(),
            Err(error) => {
                error!(event = "device.exec.event.outbox_lock_failed", error = %error);
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
                error!(
                    event = "device.exec.event.serialize_failed",
                    event_id = %event.event_id,
                    session_id = %event.session_id,
                    exec_event = %event.event,
                    error = %error,
                );
                if let Ok(mut queue) = outbox.lock() {
                    let _ = queue.pop_front();
                }
                continue;
            }
            ExecEventSendOutcome::Retry(error) => {
                warn!(
                    event = "device.exec.event.send_failed",
                    event_id = %event.event_id,
                    session_id = %event.session_id,
                    exec_event = %event.event,
                    error = %error,
                    outbox_depth = exec_event_outbox_len(outbox),
                );
                return sent;
            }
        }
    }
}

async fn flush_exec_event_outbox(
    conn: &Arc<Connection>,
    outbox: &Arc<Mutex<VecDeque<DeviceExecEventParams>>>,
) -> usize {
    flush_exec_event_outbox_with_sender(outbox, |event| {
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
        "net.fetch" => Some("Fetch"),
        _ => None,
    }
}

async fn handle_driver_request(
    conn: &Arc<Connection>,
    tools: &[Box<dyn Tool>],
    workspace: &Path,
    req: &RequestFrame,
    request_body: Result<Option<IncomingBody>, String>,
    cancellation: &CancellationToken,
) {
    let args = req.args.clone().unwrap_or(serde_json::Value::Null);

    let call = req.call.as_str();
    if call == "net.fetch" {
        let method = args
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("GET");
        let url = args
            .get("url")
            .and_then(|value| value.as_str())
            .map(redact_url_for_log)
            .unwrap_or_else(|| "<missing>".to_string());
        info!(
            event = "net.fetch.start",
            request_id = %req.id,
            method = %method,
            url = %url,
        );
    }

    let request_body = match request_body {
        Ok(body) => body,
        Err(error) => {
            send_driver_error(conn, req, error).await;
            return;
        }
    };
    let result = match transfer::handle_transfer_syscall(
        call,
        args.clone(),
        request_body,
        workspace,
    )
    .await
    {
        transfer::TransferDispatch::Handled(result) => result,
        transfer::TransferDispatch::NotHandled(remaining_body) => {
            if let Some(tool_name) = syscall_to_tool_name(call) {
                execute_tool_by_name(tools, call, tool_name, args, remaining_body, cancellation)
                    .await
            } else {
                drop(remaining_body);
                Err(format!("unknown syscall: {call}"))
            }
        }
    };

    let mut outgoing_body = None;
    let response = match result {
        Ok(output) => {
            let data = output.data;
            let body = match output.body {
                Some(body) => match prepare_response_body(conn, body) {
                    Ok(body) => Some(body),
                    Err(error) => {
                        send_driver_error(conn, req, error).await;
                        return;
                    }
                },
                None => None,
            };
            let body_descriptor = body.as_ref().map(|body| body.outgoing.descriptor());
            if call == "net.fetch" {
                info!(
                    event = "net.fetch.ok",
                    request_id = %req.id,
                    status = ?data.get("status").and_then(|value| value.as_u64()),
                    ok = ?data.get("ok").and_then(|value| value.as_bool()),
                    body_bytes = ?body_descriptor.and_then(|body| body.length),
                );
            }
            outgoing_body = body;
            Frame::Res(ResponseFrame {
                id: req.id.clone(),
                ok: true,
                data: Some(data),
                error: None,
                body: body_descriptor,
            })
        }
        Err(message) => {
            if call == "net.fetch" {
                warn!(
                    event = "net.fetch.failed",
                    request_id = %req.id,
                    error = %message,
                );
            }
            driver_error_frame(req, message)
        }
    };

    match serde_json::to_string(&response) {
        Ok(text) => {
            if let Err(e) = conn.send_raw(text).await {
                error!(
                    event = "driver.response.send_failed",
                    request_id = %req.id,
                    call = %req.call,
                    error = %e,
                );
                return;
            }
            if let Some(body) = outgoing_body {
                if let Err(e) = body.send().await {
                    error!(
                        event = "driver.response.body_send_failed",
                        request_id = %req.id,
                        call = %req.call,
                        error = %e,
                    );
                }
            }
        }
        Err(e) => {
            error!(
                event = "driver.response.serialize_failed",
                request_id = %req.id,
                call = %req.call,
                error = %e,
            );
        }
    }
}

fn daemon_body_limits() -> BinaryBodyLimits {
    BinaryBodyLimits {
        // Filesystem transfers are streams and historically had no whole-file
        // cap. Individual tools still enforce their own request/response limits.
        max_body_bytes: u64::MAX,
        ..BinaryBodyLimits::default()
    }
}

fn redact_url_for_log(raw_url: &str) -> String {
    match reqwest::Url::parse(raw_url) {
        Ok(mut url) => {
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => "<invalid>".to_string(),
    }
}

async fn execute_tool_by_name(
    tools: &[Box<dyn Tool>],
    call: &str,
    name: &str,
    args: serde_json::Value,
    body: Option<IncomingBody>,
    cancellation: &CancellationToken,
) -> Result<ToolOutput, String> {
    let Some(tool) = tools.iter().find(|tool| tool.definition().name == name) else {
        drop(body);
        return Err(format!("tool not found: {}", name));
    };

    let timeout = tool.timeout(&args);
    let deadline = timeout.map(|duration| tokio::time::Instant::now() + duration);
    let execution = async {
        let body = match body {
            Some(mut body) => {
                let limit = match tool.request_body_limit(&args) {
                    Ok(limit) => limit,
                    Err(error) => {
                        body.cancel(&error);
                        return Err(error);
                    }
                };
                Some(
                    body.read_all(limit)
                        .await
                        .map_err(|error| error.to_string())?,
                )
            }
            None => None,
        };
        tool.execute_with_body_cancellable(args, body, cancellation)
            .await
    };
    let mut output = match (timeout, deadline) {
        (Some(timeout), Some(deadline)) => tokio::time::timeout_at(deadline, execution)
            .await
            .map_err(|_elapsed| format!("{} timed out after {}ms", call, timeout.as_millis()))?,
        _ => execution.await,
    }?;
    if let Some(body) = output.body.as_mut() {
        body.deadline = deadline;
    }
    Ok(output)
}

pub async fn run(
    url: &str,
    auth: GatewayAuth,
    device_id: String,
    workspace: PathBuf,
    shutdown: CancellationToken,
    runtime: DaemonRuntime,
) -> Result<(), Box<dyn std::error::Error>> {
    let workspace_label = workspace.display().to_string();
    let gateway_label = redact_url_for_log(url);
    let device_span = info_span!("device", device_id = %device_id, workspace = %workspace_label);

    let run = async move {
        let log_pattern = logger::device_log_pattern()?;
        info!(
            event = "device.start",
            url = %gateway_label,
            log_path = %log_pattern,
            log_rotation = "daily",
        );

        let exec_event_outbox: Arc<Mutex<VecDeque<DeviceExecEventParams>>> =
            Arc::new(Mutex::new(VecDeque::new()));
        let outbox_for_exec_events = exec_event_outbox.clone();
        let mut exec_events = subscribe_exec_events();
        let exec_event_span = tracing::Span::current();
        let exec_event_collector = tokio::spawn(
            async move {
                loop {
                    match exec_events.recv().await {
                        Ok(event) => {
                            queue_exec_event_for_retry(&outbox_for_exec_events, event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            warn!(event = "device.exec.event.lagged", skipped);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
            }
            .instrument(exec_event_span),
        );

        macro_rules! shutdown_device {
            ($signal:expr) => {{
                exec_event_collector.abort();
                runtime.set_phase(daemon_protocol::DaemonPhase::ShuttingDown);
                info!(event = "shutdown", signal = %$signal);
                return Ok(());
            }};
        }

        const CONNECT_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(30);
        const INITIAL_RETRY_DELAY: tokio::time::Duration = tokio::time::Duration::from_secs(3);
        const MAX_RETRY_DELAY: tokio::time::Duration = tokio::time::Duration::from_secs(300);
        let mut retry_delay = INITIAL_RETRY_DELAY;
        let mut reconnect_attempt = 0_u32;

        loop {
            runtime.set_phase(daemon_protocol::DaemonPhase::Connecting);
            info!(event = "connect.attempt", url = %gateway_label);

            let tools_for_handler: Arc<Vec<Box<dyn Tool>>> = Arc::new(
                all_tools_with_workspace_for_device(workspace.clone(), device_id.clone()),
            );

            let conn_attempt = tokio::time::timeout(
                CONNECT_TIMEOUT,
                Connection::connect_with_options(
                    ConnectionOptions {
                        url: url.to_string(),
                        peer: PeerIdentity::new(device_id.clone(), env!("CARGO_PKG_VERSION")),
                        implements: DEVICE_DRIVER_IMPLEMENTS
                            .iter()
                            .map(|item| item.to_string())
                            .collect(),
                        auth_username: auth.username.clone(),
                        auth_password: auth.password.clone(),
                        auth_token: auth.token.clone(),
                        limits: daemon_body_limits(),
                    },
                    |_frame| {},
                ),
            );
            let conn_attempt = tokio::select! {
                () = shutdown.cancelled() => shutdown_device!("control"),
                result = conn_attempt => result,
            };

            let conn = match conn_attempt {
                Ok(Ok(c)) => {
                    retry_delay = INITIAL_RETRY_DELAY;
                    reconnect_attempt = 0;
                    c
                }
                Ok(Err(e)) => {
                    if let Some(rpc_error) = e.downcast_ref::<GatewayRpcError>() {
                        if rpc_error.is_setup_required() {
                            error!(
                                event = "connect.setup_required",
                                error = %rpc_error,
                            );
                            return Err(e);
                        }
                    }
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                    runtime.reconnecting(reconnect_attempt, e.to_string());
                    error!(
                        event = "connect.failed",
                        error = %e,
                        retry_seconds = retry_delay.as_secs(),
                    );
                    tokio::select! {
                        () = shutdown.cancelled() => shutdown_device!("control"),
                        _ = tokio::time::sleep(retry_delay) => {}
                    }
                    retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                    continue;
                }
                Err(_) => {
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                    runtime.reconnecting(
                        reconnect_attempt,
                        format!(
                            "Gateway connection timed out after {} seconds",
                            CONNECT_TIMEOUT.as_secs()
                        ),
                    );
                    error!(
                        event = "connect.timeout",
                        timeout_seconds = CONNECT_TIMEOUT.as_secs(),
                        retry_seconds = retry_delay.as_secs(),
                    );
                    tokio::select! {
                        () = shutdown.cancelled() => shutdown_device!("control"),
                        _ = tokio::time::sleep(retry_delay) => {}
                    }
                    retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                    continue;
                }
            };

            runtime.set_phase(daemon_protocol::DaemonPhase::Connected);
            info!(event = "connect.ok", implements = ?DEVICE_DRIVER_IMPLEMENTS);

            let conn = Arc::new(conn);
            // The Connection owns its frame handler. Keep only a weak reference
            // back to the Connection here so reconnect teardown cannot form a
            // Connection -> handler -> Connection ownership cycle.
            let conn_for_handler = Arc::downgrade(&conn);
            let tools_clone = tools_for_handler.clone();
            let workspace_clone = workspace.clone();
            let body_channel = conn.body_channel().clone();
            let active_requests = ActiveRequests::default();
            let active_requests_for_handler = active_requests.clone();
            let request_span = tracing::Span::current();

            // In the new OS architecture, the kernel sends req frames directly to
            // the driver. We dispatch based on `call` and respond with a res frame.
            conn.set_frame_handler(move |frame| match frame {
                Frame::Req(req) => {
                    let Some(conn) = conn_for_handler.upgrade() else {
                        return;
                    };
                    let cancellation = active_requests_for_handler.register(&req);
                    let request_body = req
                        .body
                        .map(|descriptor| body_channel.receive(descriptor))
                        .transpose()
                        .map_err(|error: gateway_client::BodyError| error.to_string());
                    let requests = active_requests_for_handler.clone();
                    let tools = tools_clone.clone();
                    let workspace = workspace_clone.clone();
                    let request_span = request_span.clone();
                    let id = req.id.clone();

                    tokio::spawn(
                        async move {
                            tokio::select! {
                                biased;
                                _ = cancellation.cancelled() => {}
                                _ = handle_driver_request(
                                    &conn,
                                    &tools,
                                    &workspace,
                                    &req,
                                    request_body,
                                    &cancellation,
                                ) => {}
                            }
                            requests.finish(&id, &cancellation);
                        }
                        .instrument(request_span),
                    );
                }
                Frame::Sig(signal) if signal.signal == REQUEST_CANCEL_SIGNAL => {
                    let cancellation = signal
                        .payload
                        .and_then(|payload| serde_json::from_value(payload).ok());
                    if let Some(cancellation) = cancellation {
                        active_requests_for_handler.cancel(cancellation);
                    }
                }
                _ => {}
            })
            .await;

            let flushed = flush_exec_event_outbox(&conn, &exec_event_outbox).await;
            if flushed > 0 {
                info!(
                    event = "device.exec.event.flushed",
                    sent = flushed,
                    remaining = exec_event_outbox_len(&exec_event_outbox),
                );
            }

            let keepalive_interval = tokio::time::Duration::from_secs(240);
            let keepalive_timeout = tokio::time::Duration::from_secs(10);
            info!(
                event = "connect.keepalive_configured",
                keepalive_seconds = keepalive_interval.as_secs(),
            );
            let mut next_keepalive_at = tokio::time::Instant::now() + keepalive_interval;

            // Monitor for disconnection or Ctrl+C
            loop {
                tokio::select! {
                    () = shutdown.cancelled() => {
                        active_requests.cancel_all("Device shutting down");
                        conn.close();
                        shutdown_device!("control");
                    }
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
                        if conn.is_disconnected() {
                            active_requests.cancel_all("Device disconnected");
                            conn.close();
                            warn!(
                                event = "connect.lost",
                                retry_seconds = 3,
                            );
                            runtime.reconnecting(1, "The gateway connection closed.");
                            tokio::select! {
                                () = shutdown.cancelled() => shutdown_device!("control"),
                                _ = tokio::time::sleep(tokio::time::Duration::from_secs(3)) => {}
                            }
                            break; // Break inner loop to reconnect
                        }

                        let flushed = flush_exec_event_outbox(&conn, &exec_event_outbox).await;
                        if flushed > 0 {
                            info!(
                                event = "device.exec.event.flushed",
                                sent = flushed,
                                remaining = exec_event_outbox_len(&exec_event_outbox),
                            );
                        }

                        if tokio::time::Instant::now() >= next_keepalive_at {
                            let payload = b"gsv-keepalive".to_vec();
                            let keepalive = tokio::select! {
                                () = shutdown.cancelled() => {
                                    active_requests.cancel_all("Device shutting down");
                                    conn.close();
                                    shutdown_device!("control")
                                },
                                result = tokio::time::timeout(keepalive_timeout, conn.send_ping(payload)) => result,
                            };

                            match keepalive {
                                Ok(Ok(())) => {
                                    next_keepalive_at = tokio::time::Instant::now() + keepalive_interval;
                                }
                                Ok(Err(e)) => {
                                    active_requests.cancel_all("Device disconnected");
                                    conn.close();
                                    warn!(
                                        event = "keepalive.request_error",
                                        error = %e,
                                        retry_seconds = 3,
                                    );
                                    runtime.reconnecting(1, e.to_string());
                                    tokio::select! {
                                        () = shutdown.cancelled() => shutdown_device!("control"),
                                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(3)) => {}
                                    }
                                    break;
                                }
                                Err(_) => {
                                    active_requests.cancel_all("Device keepalive timed out");
                                    conn.close();
                                    warn!(
                                        event = "keepalive.timeout",
                                        timeout_seconds = 10,
                                        retry_seconds = 3,
                                    );
                                    runtime.reconnecting(1, "The gateway keepalive timed out.");
                                    tokio::select! {
                                        () = shutdown.cancelled() => shutdown_device!("control"),
                                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(3)) => {}
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            conn.close();
            active_requests.cancel_all("Device disconnected");
        }
    };

    run.instrument(device_span).await
}
#[cfg(test)]
mod tests {
    use super::*;

    fn test_exec_event(index: usize) -> DeviceExecEventParams {
        DeviceExecEventParams {
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
    fn daemon_body_limits_preserve_large_streaming_transfers() {
        assert_eq!(daemon_body_limits().max_body_bytes, u64::MAX);
    }

    async fn pending_body_error(call: &str, args: serde_json::Value) -> String {
        let channel =
            gateway_client::BinaryBodyChannel::new(BinaryBodyLimits::default(), |_frame| async {
                Ok(())
            })
            .unwrap();
        let body = channel
            .receive(gateway_client::FrameBodyDescriptor {
                stream_id: 41,
                length: Some(1),
            })
            .unwrap();
        let tools =
            all_tools_with_workspace_for_device(std::env::temp_dir(), "test-device".to_string());
        let tool_name = syscall_to_tool_name(call).unwrap();

        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            execute_tool_by_name(
                &tools,
                call,
                tool_name,
                args,
                Some(body),
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("request did not finish promptly")
        .unwrap_err()
    }

    #[test]
    fn request_cancel_cancels_the_registered_operation() {
        let request = RequestFrame {
            id: "request-1".to_string(),
            call: "net.fetch".to_string(),
            args: None,
            body: None,
        };
        let requests = ActiveRequests::default();
        let cancellation = requests.register(&request);

        assert!(requests.cancel(
            serde_json::from_value(json!({
                "id": request.id.clone(),
                "reason": "superseded",
            }))
            .unwrap(),
        ));
        assert!(!requests.cancel(RequestCancel {
            id: request.id,
            reason: None,
        },));
        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn duplicate_request_id_cancels_replaced_request() {
        let requests = ActiveRequests::default();
        let request = RequestFrame::new("fs.search", None);
        let first = requests.register(&request);
        let second = requests.register(&request);

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        requests.finish(&request.id, &first);
        assert_eq!(requests.0.lock().unwrap().requests.len(), 1);
        assert!(requests.cancel(RequestCancel {
            id: request.id,
            reason: None,
        },));
        assert!(second.is_cancelled());
    }

    #[test]
    fn connection_teardown_cancels_all_requests() {
        let requests = ActiveRequests::default();
        let first = requests.register(&RequestFrame::new("fs.search", None));
        let second = requests.register(&RequestFrame::new("net.fetch", None));

        requests.cancel_all("Connection closed");

        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert!(requests.0.lock().unwrap().requests.is_empty());
        let late = requests.register(&RequestFrame::new("fs.read", None));
        assert!(late.is_cancelled());
    }

    #[test]
    fn test_queue_exec_event_for_retry_drops_oldest_when_full() {
        let outbox: Arc<Mutex<VecDeque<DeviceExecEventParams>>> =
            Arc::new(Mutex::new(VecDeque::new()));

        for i in 0..=MAX_DEVICE_EXEC_EVENT_OUTBOX {
            queue_exec_event_for_retry(&outbox, test_exec_event(i));
        }

        let queue = outbox.lock().expect("outbox lock");
        assert_eq!(queue.len(), MAX_DEVICE_EXEC_EVENT_OUTBOX);
        assert_eq!(
            queue.front().map(|event| event.event_id.as_str()),
            Some("event-1")
        );
        let expected_last = format!("event-{MAX_DEVICE_EXEC_EVENT_OUTBOX}");
        assert_eq!(
            queue.back().map(|event| event.event_id.as_str()),
            Some(expected_last.as_str())
        );
    }

    #[tokio::test]
    async fn test_flush_exec_event_outbox_retry_keeps_event_queued() {
        let outbox: Arc<Mutex<VecDeque<DeviceExecEventParams>>> =
            Arc::new(Mutex::new(VecDeque::new()));
        queue_exec_event_for_retry(&outbox, test_exec_event(1));

        let sent = flush_exec_event_outbox_with_sender(&outbox, |_event| async {
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

    #[tokio::test]
    async fn rejects_invalid_request_bodies_before_waiting_for_frames() {
        assert_eq!(
            pending_body_error("fs.read", json!({ "path": "missing.txt" })).await,
            "Read does not accept a request body"
        );
        assert!(pending_body_error(
            "net.fetch",
            json!({ "url": "https://example.test/", "body": "text" }),
        )
        .await
        .contains("unknown field `body`"));
        assert_eq!(
            pending_body_error(
                "net.fetch",
                json!({ "url": "https://example.test/", "method": "GET" }),
            )
            .await,
            "GET requests cannot include a body"
        );
    }

    #[tokio::test]
    async fn net_fetch_timeout_includes_request_body_receipt() {
        let result = pending_body_error(
            "net.fetch",
            json!({
                "url": "https://example.test/",
                "method": "POST",
                "timeoutMs": 5,
            }),
        )
        .await;

        assert_eq!(result, "net.fetch timed out after 5ms");
    }
}
