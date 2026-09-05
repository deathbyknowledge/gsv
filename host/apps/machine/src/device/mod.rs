use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gateway_client::client::GatewayAuth;
use gateway_client::connection::{Connection, ConnectionOptions, GatewayRpcError, PeerIdentity};
use gateway_client::protocol::{
    ConnectResult, DeviceExecEventParams, ErrorShape, Frame, RequestFrame, ResponseFrame,
    SignalFrame, REQUEST_CANCEL_SIGNAL,
};
use gateway_client::{BinaryBody, BinaryBodyLimits, IncomingBody, OutgoingBody};
use serde::Deserialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, info_span, warn, Instrument};

use crate::control::DaemonRuntime;
use crate::logger;
use crate::tools::{all_tools_with_workspace_for_device, subscribe_exec_events, Tool, ToolOutput};
use crate::update::{
    installing_window_elapsed, transient_unit_state, AttemptState, AutoUpdater, InstallerHandle,
    UnitState, UpdateError, UpdateTarget, INSTALLING_WINDOW, MIN_ATTEMPT_INTERVAL,
};

mod transfer;

const MAX_DEVICE_EXEC_EVENT_OUTBOX: usize = 2048;
/// How often a connected daemon re-checks whether machine work has finished
/// so a waiting update can start.
const UPDATE_RECHECK_INTERVAL: tokio::time::Duration = tokio::time::Duration::from_secs(300);
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

    /// Requests still being served, bodies included: work a service stop
    /// would cut off.
    fn in_flight(&self) -> usize {
        self.0
            .lock()
            .expect("active request mutex poisoned")
            .requests
            .len()
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
        let mut updater = AutoUpdater::from_config(&host_config::CliConfig::load());
        // One lifecycle per driver run: idle, draining for a launch, or
        // installing. New work is refused from the moment a drain begins, so
        // the installer's service stop finds nothing to kill.
        let lifecycle = UpdateLifecycle::new();

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
                        if rpc_error.is_protocol_unsupported() {
                            lifecycle.handshake();
                            updater.refresh_from(&host_config::CliConfig::load());
                            let outcome = match updater.plan_for_protocol_error(rpc_error) {
                                Some(target) => match lifecycle.begin_drain_for(target, None) {
                                    // Already draining or installing from an
                                    // earlier decision: keep waiting for it.
                                    None => UpdateOutcome::Waiting,
                                    Some((guard, _)) => {
                                        // A refused connection has no requests
                                        // in flight, but a shell session from
                                        // the last one may still be running.
                                        let shell_sessions =
                                            crate::tools::running_process_count().await;
                                        match work_reason(0, shell_sessions) {
                                            Some(reason) => {
                                                note_update_waiting(
                                                    &runtime,
                                                    guard.target(),
                                                    reason,
                                                );
                                                guard.abandon();
                                                UpdateOutcome::Waiting
                                            }
                                            None => {
                                                let launch = start_update(
                                                    updater.clone(),
                                                    runtime.clone(),
                                                    lifecycle.clone(),
                                                    guard,
                                                    shutdown.clone(),
                                                );
                                                match run_until_cancelled(&shutdown, launch).await {
                                                    Some(outcome) => outcome,
                                                    None => shutdown_device!("control"),
                                                }
                                            }
                                        }
                                    }
                                },
                                None => UpdateOutcome::NotLaunched,
                            };
                            if outcome.keeps_waiting() {
                                // The installer stops this service itself once
                                // the release is verified. Staying alive until
                                // then keeps its service snapshot accurate.
                                reconnect_attempt = reconnect_attempt.saturating_add(1);
                                runtime.reconnecting(
                                    reconnect_attempt,
                                    "Installing the release the gateway requires.",
                                );
                                tokio::select! {
                                    () = shutdown.cancelled() => shutdown_device!("control"),
                                    _ = tokio::time::sleep(MAX_RETRY_DELAY) => {}
                                }
                                continue;
                            }
                            error!(
                                event = "connect.protocol_unsupported",
                                error = %rpc_error,
                                hint = "This gsvd build cannot talk to the gateway; install the matching release from https://install.gsv.space and restart the service.",
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
            let lifecycle_for_handler = lifecycle.clone();

            // In the new OS architecture, the kernel sends req frames directly to
            // the driver. We dispatch based on `call` and respond with a res frame.
            conn.set_frame_handler(move |frame| match frame {
                Frame::Req(req) => {
                    let Some(conn) = conn_for_handler.upgrade() else {
                        return;
                    };
                    let cancellation =
                        match lifecycle_for_handler.admit(&active_requests_for_handler, &req) {
                            Admission::Admitted(cancellation) => cancellation,
                            Admission::Refused(refusal) => {
                                cancel_refused_body(&body_channel, req.body);
                                tokio::spawn(async move {
                                    match serde_json::to_string(&refusal) {
                                        Ok(text) => {
                                            if let Err(error) = conn.send_raw(text).await {
                                                warn!(event = "update.refusal_send_failed", error = %error);
                                            }
                                        }
                                        Err(error) => {
                                            warn!(event = "update.refusal_encode_failed", error = %error);
                                        }
                                    }
                                });
                                return;
                            }
                        };
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

            // The handler is serving requests now; the update decision runs
            // beside it so a slow installer download never delays a route.
            // Dropping the guard at the end of this connection aborts it, so a
            // reconnect or a reload never leaves a launch running against
            // settings this driver no longer holds.
            lifecycle.handshake();
            // The switch and the channel are read again at every handshake,
            // so an opt-out on disk applies at the next connect.
            updater.refresh_from(&host_config::CliConfig::load());
            match update_after_connect(&updater, conn.connect_result.as_ref()) {
                Some(target) => lifecycle.queue(target),
                None => {
                    // Nothing to move to any more: an earlier "available"
                    // notice would now be wrong, while a running installer's
                    // notice still describes what is happening.
                    lifecycle.clear_pending();
                    runtime.clear_stale_update_notice();
                }
            }
            let mut update_task: Option<AbortOnDrop> = None;
            let mut next_update_check_at = tokio::time::Instant::now() + UPDATE_RECHECK_INTERVAL;
            launch_update_when_idle(
                &updater,
                &runtime,
                &lifecycle,
                &active_requests,
                &shutdown,
                &mut update_task,
            )
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

                        if lifecycle.has_pending()
                            && tokio::time::Instant::now() >= next_update_check_at
                        {
                            next_update_check_at =
                                tokio::time::Instant::now() + UPDATE_RECHECK_INTERVAL;
                            launch_update_when_idle(
                                &updater,
                                &runtime,
                                &lifecycle,
                                &active_requests,
                                &shutdown,
                                &mut update_task,
                            )
                            .await;
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

/// A spawned task that must not outlive the driver that started it.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Drive `work` until it completes or `shutdown` is cancelled, whichever
/// comes first. Cancellation wins ties so a stalled installer endpoint cannot
/// hold reload, reconnect, or Ctrl+C open.
async fn run_until_cancelled<T>(
    shutdown: &CancellationToken,
    work: impl Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        () = shutdown.cancelled() => None,
        result = work => Some(result),
    }
}

/// The release to move to after a successful handshake, if the gateway is
/// ahead. Decided after the frame handler is installed and launched in the
/// background, so the connection serves requests while the installer loads.
fn update_after_connect(
    updater: &AutoUpdater,
    result: Option<&ConnectResult>,
) -> Option<UpdateTarget> {
    updater.plan_for_server(&result?.server)
}

/// Why the machine counts as busy, given its in-flight requests and live
/// shell sessions.
fn work_reason(in_flight: usize, shell_sessions: usize) -> Option<&'static str> {
    if in_flight > 0 {
        Some("requests in flight")
    } else if shell_sessions > 0 {
        Some("shell sessions running")
    } else {
        None
    }
}

/// Requests that create work an installer's service stop would kill are
/// refused while an update is being installed; reads still pass.
fn admits_during_update(call: &str) -> bool {
    matches!(call, "fs.read" | "fs.search")
}

/// The retryable refusal for `request` while an update installs, in the
/// shape the caller expects for its call family, or `None` if it may pass.
fn update_refusal_frame(request: &RequestFrame) -> Option<Frame> {
    if admits_during_update(&request.call) {
        return None;
    }
    let message = "This machine is installing an update; retry shortly.".to_string();
    if request.call.starts_with("fs.") {
        return Some(driver_error_frame(request, message));
    }
    Some(Frame::Res(ResponseFrame {
        id: request.id.clone(),
        ok: false,
        data: None,
        error: Some(ErrorShape {
            code: 503,
            message,
            details: None,
            retryable: Some(true),
        }),
        body: None,
    }))
}

/// A refused request may already be sending a body; owning and dropping it
/// tells the sender to stop, so no orphan frames pile up.
fn cancel_refused_body(
    channel: &gateway_client::BinaryBodyChannel,
    descriptor: Option<gateway_client::protocol::FrameBodyDescriptor>,
) {
    if let Some(descriptor) = descriptor {
        if let Ok(body) = channel.receive(descriptor) {
            drop(body);
        }
    }
}

/// Where an update stands for this driver run.
#[derive(Clone, Debug, Eq, PartialEq)]
enum UpdatePhase {
    Idle,
    /// A launch is being decided or started; new work is refused.
    Draining {
        target: UpdateTarget,
    },
    /// An installer is running; new work stays refused until it restarts the
    /// service or the watcher learns it ended.
    Installing {
        target: UpdateTarget,
        since: std::time::SystemTime,
    },
}

#[derive(Debug)]
struct LifecycleState {
    phase: UpdatePhase,
    pending: Option<UpdateTarget>,
    /// Bumped on every handshake result, so a watcher from before a
    /// reconnect can tell whether its decision has been superseded.
    epoch: u64,
}

/// The update lifecycle the driver owns: one state behind one mutex.
/// Admitting a request and beginning a drain both happen under that lock,
/// so a request is either admitted before the drain and counted, or refused
/// after it; nothing slips between the flip and the in-flight sample.
#[derive(Debug)]
struct UpdateLifecycle {
    state: Mutex<LifecycleState>,
}

/// How the frame handler may treat a request right now.
enum Admission {
    Admitted(Arc<CancellationToken>),
    Refused(Frame),
}

/// What became of a failed installer's target when the watcher lowered the
/// gate.
#[derive(Debug, Eq, PartialEq)]
enum InstallerExit {
    /// The same handshake still stands and nothing else is queued: retry it.
    Requeued(UpdateTarget),
    /// A later handshake decided otherwise; the gate lowers, nothing else.
    Superseded(UpdateTarget),
    NotInstalling,
}

impl UpdateLifecycle {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(LifecycleState {
                phase: UpdatePhase::Idle,
                pending: None,
                epoch: 0,
            }),
        })
    }

    /// Whether work-creating requests are being refused.
    #[cfg(test)]
    fn refusing(&self) -> bool {
        self.lock().phase != UpdatePhase::Idle
    }

    #[cfg(test)]
    fn phase(&self) -> UpdatePhase {
        self.lock().phase.clone()
    }

    /// A handshake produced a result; decisions made before it are stale.
    fn handshake(&self) -> u64 {
        let mut state = self.lock();
        state.epoch += 1;
        state.epoch
    }

    fn epoch(&self) -> u64 {
        self.lock().epoch
    }

    fn queue(&self, target: UpdateTarget) {
        self.lock().pending = Some(target);
    }

    fn clear_pending(&self) {
        self.lock().pending = None;
    }

    fn has_pending(&self) -> bool {
        self.lock().pending.is_some()
    }

    fn pending(&self) -> Option<UpdateTarget> {
        self.lock().pending.clone()
    }

    /// Admit `request`, registering it for cancellation, or refuse it: one
    /// critical section with the drain, so the in-flight count a drain reads
    /// includes every request admitted before it and none admitted after.
    fn admit(&self, requests: &ActiveRequests, request: &RequestFrame) -> Admission {
        let state = self.lock();
        if state.phase != UpdatePhase::Idle {
            if let Some(refusal) = update_refusal_frame(request) {
                return Admission::Refused(refusal);
            }
        }
        let cancellation = requests.register(request);
        drop(state);
        Admission::Admitted(cancellation)
    }

    /// Start draining for the pending target and read the in-flight count in
    /// the same critical section. From this instant new work is refused, so
    /// the count is exact and no shell session can appear behind it. `None`
    /// when nothing is pending or a launch is already draining or installing.
    fn begin_drain(self: &Arc<Self>, requests: &ActiveRequests) -> Option<(DrainGuard, usize)> {
        let mut state = self.lock();
        if state.phase != UpdatePhase::Idle {
            return None;
        }
        let target = state.pending.take()?;
        state.phase = UpdatePhase::Draining {
            target: target.clone(),
        };
        let in_flight = requests.in_flight();
        drop(state);
        Some((
            DrainGuard {
                lifecycle: self.clone(),
                target: Some(target),
                confirmed: false,
            },
            in_flight,
        ))
    }

    /// Start draining for a target that did not come from the queue (the
    /// 102 path, which has no request registry yet). `None` when a launch is
    /// already draining or installing.
    fn begin_drain_for(
        self: &Arc<Self>,
        target: UpdateTarget,
        requests: Option<&ActiveRequests>,
    ) -> Option<(DrainGuard, usize)> {
        let mut state = self.lock();
        if state.phase != UpdatePhase::Idle {
            return None;
        }
        state.pending = None;
        state.phase = UpdatePhase::Draining {
            target: target.clone(),
        };
        let in_flight = requests.map_or(0, ActiveRequests::in_flight);
        drop(state);
        Some((
            DrainGuard {
                lifecycle: self.clone(),
                target: Some(target),
                confirmed: false,
            },
            in_flight,
        ))
    }

    /// The installer ended while this daemon is still alive: lower the gate,
    /// and queue the target again only if the handshake that chose it is
    /// still the latest and nothing newer is waiting.
    fn installer_exited(&self, epoch: u64) -> InstallerExit {
        let mut state = self.lock();
        let UpdatePhase::Installing { target, .. } = state.phase.clone() else {
            return InstallerExit::NotInstalling;
        };
        state.phase = UpdatePhase::Idle;
        if state.epoch == epoch && state.pending.is_none() {
            state.pending = Some(target.clone());
            InstallerExit::Requeued(target)
        } else {
            InstallerExit::Superseded(target)
        }
    }

    fn reset(&self, requeue: Option<UpdateTarget>) {
        let mut state = self.lock();
        state.phase = UpdatePhase::Idle;
        if let Some(target) = requeue {
            state.pending = Some(target);
        }
    }

    fn confirm(&self, target: UpdateTarget, since: std::time::SystemTime) {
        self.lock().phase = UpdatePhase::Installing { target, since };
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LifecycleState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Holds the `Draining` phase for one launch. Dropping it before the launch
/// is confirmed, whether by failure or by cancellation, returns the
/// lifecycle to `Idle` and re-queues the target, so there is exactly one
/// reset path and it is the one cancellation takes.
struct DrainGuard {
    lifecycle: Arc<UpdateLifecycle>,
    target: Option<UpdateTarget>,
    confirmed: bool,
}

impl DrainGuard {
    fn target(&self) -> &UpdateTarget {
        self.target.as_ref().unwrap_or_else(|| placeholder_target())
    }

    /// Give the target back for a later check.
    fn abandon(self) {
        drop(self);
    }

    /// Drop the target for good: the machine cannot update itself this way.
    fn discard(mut self) {
        self.target = None;
        drop(self);
    }

    /// The installer exists: keep refusing work until it restarts the
    /// service or the watcher learns it ended.
    fn confirm(mut self, since: std::time::SystemTime) {
        self.confirmed = true;
        if let Some(target) = self.target.take() {
            self.lifecycle.confirm(target, since);
        }
    }
}

impl Drop for DrainGuard {
    fn drop(&mut self) {
        if !self.confirmed {
            self.lifecycle.reset(self.target.take());
        }
    }
}

/// A `DrainGuard` carries its target until confirmation moves it into the
/// lifecycle; this placeholder only keeps `target()` total after that.
fn placeholder_target() -> &'static UpdateTarget {
    static EMPTY: std::sync::OnceLock<UpdateTarget> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| UpdateTarget {
        release: String::new(),
        reason: crate::update::UpdateReason::NewerRelease,
        installer_url: String::new(),
    })
}

/// Whether a failed launch is worth retrying on a later check: transient
/// trouble is, a machine that cannot update itself at all is not.
fn retry_later(error: &UpdateError) -> bool {
    match error {
        UpdateError::Download(_)
        | UpdateError::State(_)
        | UpdateError::Spawn(_)
        | UpdateError::Deferred { .. } => true,
        UpdateError::Disabled
        | UpdateError::NotServiceManaged { .. }
        | UpdateError::NoDetachment { .. }
        | UpdateError::AppBundle { .. }
        | UpdateError::Unwritable { .. } => false,
    }
}

fn note_update_waiting(runtime: &DaemonRuntime, target: &UpdateTarget, reason: &'static str) {
    use daemon_protocol::{DiagnosticLevel, DiagnosticNotice};
    info!(
        event = "update.deferred",
        release = %target.release,
        reason = "machine work in progress",
        detail = reason,
    );
    runtime.set_update_notice(Some(DiagnosticNotice {
        level: DiagnosticLevel::Info,
        code: "autoUpdateWaiting".to_string(),
        message: format!(
            "GSV {} is available because {}; waiting for machine work to finish before installing.",
            target.release,
            target.reason.describe()
        ),
    }));
}

/// Launch the pending update on the newer-release path once the machine is
/// idle. Draining begins before the idle check, so nothing new is admitted
/// between the check and the launch; a busy machine or a cooling attempt
/// hands the target back for the next check.
async fn launch_update_when_idle(
    updater: &AutoUpdater,
    runtime: &DaemonRuntime,
    lifecycle: &Arc<UpdateLifecycle>,
    active_requests: &ActiveRequests,
    shutdown: &CancellationToken,
    task: &mut Option<AbortOnDrop>,
) {
    let cooling = lifecycle.pending().is_some_and(|target| {
        matches!(
            updater.attempt_state(&target.release, std::time::SystemTime::now()),
            AttemptState::Cooling { .. }
        )
    });
    if cooling {
        return;
    }
    let Some((guard, in_flight)) = lifecycle.begin_drain(active_requests) else {
        return;
    };
    let shell_sessions = crate::tools::running_process_count().await;
    if let Some(reason) = work_reason(in_flight, shell_sessions) {
        note_update_waiting(runtime, guard.target(), reason);
        guard.abandon();
        return;
    }
    let launch = start_update(
        updater.clone(),
        runtime.clone(),
        lifecycle.clone(),
        guard,
        shutdown.clone(),
    );
    let shutdown = shutdown.clone();
    *task = Some(AbortOnDrop(tokio::spawn(
        async move {
            run_until_cancelled(&shutdown, launch).await;
        }
        .instrument(tracing::Span::current()),
    )));
}

/// What a handshake's update decision left behind, for the 102 path to know
/// whether to keep waiting for an installer or to give up.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UpdateOutcome {
    /// An installer was started just now.
    Launched,
    /// An installer started earlier for this release is presumably running.
    InProgress,
    /// Machine work is running; the update waits for it.
    Waiting,
    /// The launch failed in a way worth retrying, or a recent failed attempt
    /// is still cooling; the next handshake retries once the cooldown ends.
    Cooling,
    NotLaunched,
}

impl UpdateOutcome {
    /// Whether the 102 path should stay alive and retry rather than exit.
    /// Only an outcome that no retry can change is worth the fatal exit,
    /// since the service manager would otherwise restart the daemon every
    /// few seconds for the length of the cooldown.
    fn keeps_waiting(&self) -> bool {
        matches!(
            self,
            Self::Launched | Self::InProgress | Self::Waiting | Self::Cooling
        )
    }
}

/// The outcome of a launch that returned `error`, before any launch happened.
fn outcome_for_error(error: &UpdateError) -> UpdateOutcome {
    if retry_later(error) {
        UpdateOutcome::Cooling
    } else {
        UpdateOutcome::NotLaunched
    }
}

/// Whether a deferred launch means an installer for `release` is already on
/// its way, so the daemon should wait for it rather than give up.
fn installer_in_progress(updater: &AutoUpdater, release: &str) -> Option<std::time::Duration> {
    match updater.attempt_state(release, std::time::SystemTime::now()) {
        AttemptState::InProgress { since } => Some(since),
        AttemptState::Cooling { .. } | AttemptState::None => None,
    }
}

/// Start the installer for the drained target and record the decision where
/// `gsv daemon diagnostics` shows it. A confirmed launch moves the lifecycle
/// to `Installing` and starts the watcher; any other outcome drops the guard,
/// which resets the lifecycle and re-queues the target when that is useful.
async fn start_update(
    updater: AutoUpdater,
    runtime: DaemonRuntime,
    lifecycle: Arc<UpdateLifecycle>,
    guard: DrainGuard,
    shutdown: CancellationToken,
) -> UpdateOutcome {
    use daemon_protocol::{DiagnosticLevel, DiagnosticNotice};
    const STARTED: &str = "autoUpdateStarted";
    let target = guard.target().clone();
    let reason = target.reason.describe();
    let error = match updater.launch(&target).await {
        Ok(launch) => {
            info!(
                event = "update.started",
                release = %launch.release,
                reason,
                detach = %launch.detach,
                log_path = %launch.log_path.display(),
            );
            runtime.set_update_notice(Some(DiagnosticNotice {
                level: DiagnosticLevel::Info,
                code: STARTED.to_string(),
                message: format!(
                    "Installing GSV {} because {reason}; the service restarts when the installer finishes.",
                    launch.release
                ),
            }));
            let since = std::time::SystemTime::now();
            guard.confirm(since);
            let epoch = lifecycle.epoch();
            spawn_installer_watch(InstallerWatch {
                updater,
                runtime,
                lifecycle,
                installer: Some(launch.installer),
                release: launch.release,
                log_path: launch.log_path,
                since,
                epoch,
                shutdown,
            });
            return UpdateOutcome::Launched;
        }
        Err(error) => error,
    };
    match &error {
        UpdateError::Disabled => {
            info!(event = "update.available", release = %target.release, reason);
            runtime.set_update_notice(Some(DiagnosticNotice {
                level: DiagnosticLevel::Warning,
                code: "autoUpdateOff".to_string(),
                message: format!(
                    "GSV {} is available because {reason}, but automatic updates are off. Run the installer, or set device.auto_update = true.",
                    target.release
                ),
            }));
        }
        UpdateError::NotServiceManaged { .. } => {
            info!(event = "update.available", release = %target.release, reason, detail = %error);
            runtime.set_update_notice(Some(DiagnosticNotice {
                level: DiagnosticLevel::Info,
                code: "autoUpdateSkipped".to_string(),
                message: format!("GSV {} is available, but {error}.", target.release),
            }));
        }
        UpdateError::Deferred { .. } => {
            if let Some(since) = installer_in_progress(&updater, &target.release) {
                let minutes = since.as_secs() / 60;
                info!(event = "update.in_progress", release = %target.release, reason, minutes);
                runtime.set_update_notice(Some(DiagnosticNotice {
                    level: DiagnosticLevel::Info,
                    code: STARTED.to_string(),
                    message: format!(
                        "Installing GSV {} because {reason}; the installer started {minutes} minutes ago.",
                        target.release
                    ),
                }));
                // No handle to that installer: the bounded window watches it.
                let started_at = std::time::SystemTime::now()
                    .checked_sub(since)
                    .unwrap_or_else(std::time::SystemTime::now);
                let log_path = updater.log_path().to_path_buf();
                guard.confirm(started_at);
                let epoch = lifecycle.epoch();
                spawn_installer_watch(InstallerWatch {
                    updater,
                    runtime,
                    lifecycle,
                    installer: None,
                    release: target.release.clone(),
                    log_path,
                    since: started_at,
                    epoch,
                    shutdown,
                });
                return UpdateOutcome::InProgress;
            }
            info!(event = "update.deferred", release = %target.release, reason, detail = %error);
            // An installer from this process lifetime is presumably still
            // running; its notice stays until the outcome replaces it.
            let started = runtime
                .update_notice()
                .is_some_and(|notice| notice.code == STARTED);
            if !started {
                let notice =
                    match updater.attempt_state(&target.release, std::time::SystemTime::now()) {
                        AttemptState::Cooling { since } => DiagnosticNotice {
                            level: DiagnosticLevel::Warning,
                            code: "autoUpdateSkipped".to_string(),
                            message: cooling_message(&target.release, since),
                        },
                        AttemptState::InProgress { .. } | AttemptState::None => {
                            skipped_notice(&target.release, &error)
                        }
                    };
                runtime.set_update_notice(Some(notice));
            }
        }
        skip if skip.is_skip() => {
            info!(event = "update.skipped", release = %target.release, reason, detail = %error);
            runtime.set_update_notice(Some(skipped_notice(&target.release, &error)));
        }
        _ => {
            warn!(event = "update.failed", release = %target.release, reason, error = %error);
            runtime.set_update_notice(Some(skipped_notice(&target.release, &error)));
        }
    }
    let outcome = outcome_for_error(&error);
    if retry_later(&error) {
        guard.abandon();
    } else {
        guard.discard();
    }
    outcome
}

/// The notice for a release whose last attempt failed `since` ago.
fn cooling_message(release: &str, since: std::time::Duration) -> String {
    let failed_minutes = since.as_secs() / 60;
    let due_minutes = MIN_ATTEMPT_INTERVAL.saturating_sub(since).as_secs() / 60;
    format!(
        "GSV {release} was not installed: the last attempt failed {failed_minutes} minutes ago. The next attempt is due in {due_minutes} minutes."
    )
}

/// Everything the installer watcher needs for the rest of this driver run.
struct InstallerWatch {
    updater: AutoUpdater,
    runtime: DaemonRuntime,
    lifecycle: Arc<UpdateLifecycle>,
    installer: Option<InstallerHandle>,
    release: String,
    log_path: PathBuf,
    since: std::time::SystemTime,
    /// The handshake epoch the launch was decided in.
    epoch: u64,
    shutdown: CancellationToken,
}

/// Watch the installer. If it ends while this daemon is still alive, the
/// service was not restarted: lower the gate, demote the attempt to cooling,
/// queue the target again unless a later handshake superseded it, and say so.
fn spawn_installer_watch(watch: InstallerWatch) {
    let InstallerWatch {
        updater,
        runtime,
        lifecycle,
        installer,
        release,
        log_path,
        since,
        epoch,
        shutdown,
    } = watch;
    tokio::spawn(
        async move {
            let Some(detail) =
                run_until_cancelled(&shutdown, installer_ended(installer, since)).await
            else {
                return;
            };
            if let Err(error) = updater.clear_launched(&release) {
                warn!(event = "update.record_failed", release = %release, error = %error);
            }
            let message = match lifecycle.installer_exited(epoch) {
                InstallerExit::Requeued(_) | InstallerExit::NotInstalling => {
                    warn!(event = "update.installer_exited", release = %release, detail = %detail);
                    format!(
                        "GSV {release} was not installed: the installer ended without restarting the service ({detail}). See {}.",
                        log_path.display()
                    )
                }
                InstallerExit::Superseded(_) => {
                    info!(event = "update.superseded", release = %release, detail = %detail);
                    format!(
                        "GSV {release} was not installed ({detail}); a newer handshake has since decided what to do. See {}.",
                        log_path.display()
                    )
                }
            };
            runtime.set_update_notice(Some(daemon_protocol::DiagnosticNotice {
                level: daemon_protocol::DiagnosticLevel::Warning,
                code: "autoUpdateSkipped".to_string(),
                message,
            }));
        }
        .instrument(tracing::Span::current()),
    );
}

/// Resolve once the installer is known to have ended without restarting this
/// daemon: the child's exit, the transient unit going inactive, or, with no
/// cheaper signal, the bounded installing window running out.
async fn installer_ended(
    installer: Option<InstallerHandle>,
    since: std::time::SystemTime,
) -> String {
    match installer {
        Some(InstallerHandle::Process(mut child)) => match child.wait().await {
            Ok(status) => format!("exit status {status}"),
            Err(error) => format!("could not wait for the installer: {error}"),
        },
        Some(InstallerHandle::TransientUnit {
            unit,
            systemctl: Some(systemctl),
        }) => loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
            match transient_unit_state(&systemctl, &unit).await {
                UnitState::Inactive => break format!("transient unit {unit} is no longer active"),
                UnitState::Active => {}
                // A probe that proved nothing keeps the gate closed, but not
                // forever: the installing window bounds the wait.
                UnitState::Unknown
                    if installing_window_elapsed(since, std::time::SystemTime::now()) =>
                {
                    break format!(
                        "the state of transient unit {unit} could not be confirmed within the installing window"
                    );
                }
                UnitState::Unknown => {}
            }
        },
        Some(InstallerHandle::TransientUnit {
            unit,
            systemctl: None,
        }) => {
            wait_for_window(since).await;
            format!("transient unit {unit} could not be watched; the installing window ran out")
        }
        None => {
            wait_for_window(since).await;
            "the installing window ran out".to_string()
        }
    }
}

async fn wait_for_window(since: std::time::SystemTime) {
    while !installing_window_elapsed(since, std::time::SystemTime::now()) {
        let elapsed = std::time::SystemTime::now()
            .duration_since(since)
            .unwrap_or_default();
        let remaining = INSTALLING_WINDOW
            .checked_sub(elapsed)
            .unwrap_or_default()
            .max(std::time::Duration::from_secs(1));
        tokio::time::sleep(remaining).await;
    }
}

fn skipped_notice(release: &str, error: &UpdateError) -> daemon_protocol::DiagnosticNotice {
    daemon_protocol::DiagnosticNotice {
        level: daemon_protocol::DiagnosticLevel::Warning,
        code: "autoUpdateSkipped".to_string(),
        message: format!("GSV {release} is available, but {error}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::ReleaseChannel;
    use gateway_client::protocol::{
        ConnectedPeer, PeerGrant, PeerPrincipal, PeerPrincipalKind, ProcessIdentity, ServerInfo,
    };
    use std::sync::atomic::Ordering;

    fn connect_result(version: &str, release: &str) -> ConnectResult {
        ConnectResult {
            protocol: gateway_client::protocol::PROTOCOL_VERSION,
            server: ServerInfo {
                version: version.to_string(),
                release: Some(release.to_string()),
                connection_id: "conn-1".to_string(),
            },
            peer: ConnectedPeer {
                id: "machine-1".to_string(),
                session_id: "session-1".to_string(),
                principal: PeerPrincipal {
                    kind: PeerPrincipalKind::Machine,
                    account: ProcessIdentity {
                        uid: 1000,
                        gid: 1000,
                        gids: vec![1000],
                        username: "u".to_string(),
                        home: "/home/u".to_string(),
                        cwd: "/home/u".to_string(),
                    },
                },
                grant: PeerGrant {
                    calls: Vec::new(),
                    signals: Vec::new(),
                    implements: Vec::new(),
                },
            },
        }
    }

    #[tokio::test]
    async fn a_cancelled_driver_stops_a_pending_launch() {
        let shutdown = CancellationToken::new();
        shutdown.cancel();
        assert_eq!(
            run_until_cancelled(&shutdown, std::future::pending::<bool>()).await,
            None
        );

        let live = CancellationToken::new();
        assert_eq!(
            run_until_cancelled(&live, std::future::ready(true)).await,
            Some(true)
        );

        let later = CancellationToken::new();
        let stopper = later.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            stopper.cancel();
        });
        assert_eq!(
            run_until_cancelled(&later, std::future::pending::<bool>()).await,
            None
        );
    }

    #[tokio::test]
    async fn dropping_the_guard_aborts_the_task() {
        let guard = AbortOnDrop(tokio::spawn(std::future::pending::<()>()));
        let handle_is_finished = {
            let task = &guard.0;
            !task.is_finished()
        };
        assert!(handle_is_finished);
        drop(guard);
        tokio::task::yield_now().await;
    }

    #[test]
    fn a_recent_attempt_for_the_named_release_means_an_installer_is_running() {
        let dir = std::env::temp_dir().join(format!("gsvd-progress-{}", uuid::Uuid::new_v4()));
        let updater = AutoUpdater::new(
            true,
            ReleaseChannel::Stable,
            "0.4.1",
            dir.join("auto-update"),
            dir.join("auto-update.log"),
        );
        assert_eq!(installer_in_progress(&updater, "v0.5.0"), None);
        // An attempt that failed before the installer started is only a
        // cooling record: the 102 path sees no installer and takes its exit.
        updater
            .record_attempt_for_test("v0.5.0", std::time::SystemTime::now(), false)
            .expect("record attempt");
        assert_eq!(installer_in_progress(&updater, "v0.5.0"), None);
        updater
            .record_attempt_for_test("v0.5.0", std::time::SystemTime::now(), true)
            .expect("record launched attempt");
        assert!(installer_in_progress(&updater, "v0.5.0").is_some());
        assert_eq!(installer_in_progress(&updater, "v0.6.0"), None);
    }

    fn target(release: &str) -> UpdateTarget {
        UpdateTarget {
            release: release.to_string(),
            reason: crate::update::UpdateReason::NewerRelease,
            installer_url: crate::update::DEFAULT_INSTALLER_URL.to_string(),
        }
    }

    #[test]
    fn work_is_named_by_what_is_running() {
        assert_eq!(work_reason(0, 0), None);
        assert_eq!(work_reason(2, 0), Some("requests in flight"));
        assert_eq!(work_reason(0, 1), Some("shell sessions running"));
        assert_eq!(work_reason(1, 1), Some("requests in flight"));
        // The 102 path has no requests in flight; only shell sessions count.
        assert_eq!(work_reason(0, 1), Some("shell sessions running"));
        assert_eq!(work_reason(0, 0), None);
    }

    /// The response inside a refusal; a missing refusal yields a response
    /// with an empty id so the assertions on it fail plainly.
    fn response_of(frame: Option<Frame>) -> ResponseFrame {
        match frame {
            Some(Frame::Res(response)) => response,
            _ => ResponseFrame {
                id: String::new(),
                ok: true,
                data: None,
                error: None,
                body: None,
            },
        }
    }

    #[test]
    fn work_creating_requests_are_refused_while_an_update_installs() {
        let shell = RequestFrame {
            id: "req-shell".to_string(),
            call: "shell.exec".to_string(),
            args: None,
            body: None,
        };
        let refusal = response_of(update_refusal_frame(&shell));
        assert!(!refusal.ok);
        assert_eq!(refusal.id, "req-shell");
        let error = refusal.error.expect("refusal carries an error");
        assert_eq!(error.code, 503);
        assert_eq!(error.retryable, Some(true));
        assert!(error.message.contains("installing an update"));
        assert!(error.message.contains("retry"));

        let write = RequestFrame {
            id: "req-write".to_string(),
            call: "fs.write".to_string(),
            ..shell.clone()
        };
        let refusal = response_of(update_refusal_frame(&write));
        assert!(refusal.ok);
        assert_eq!(refusal.id, "req-write");
        assert_eq!(
            refusal.data.and_then(|data| data.get("ok").cloned()),
            Some(json!(false))
        );

        for call in ["fs.read", "fs.search"] {
            let read = RequestFrame {
                call: call.to_string(),
                ..shell.clone()
            };
            assert!(update_refusal_frame(&read).is_none(), "{call} passes");
        }
        assert!(!admits_during_update("net.fetch"));
    }

    #[test]
    fn only_outcomes_no_retry_can_change_take_the_fatal_exit() {
        let dir = PathBuf::from("/opt/gsv/bin");
        for outcome in [
            UpdateOutcome::Launched,
            UpdateOutcome::InProgress,
            UpdateOutcome::Waiting,
            UpdateOutcome::Cooling,
        ] {
            assert!(outcome.keeps_waiting(), "{outcome:?}");
        }
        assert!(!UpdateOutcome::NotLaunched.keeps_waiting());

        for error in [
            UpdateError::Download("timed out".to_string()),
            UpdateError::State("disk full".to_string()),
            UpdateError::Spawn("no such file".to_string()),
            UpdateError::Deferred {
                since: std::time::Duration::from_secs(60),
            },
        ] {
            assert_eq!(outcome_for_error(&error), UpdateOutcome::Cooling, "{error}");
        }
        for error in [
            UpdateError::Disabled,
            UpdateError::NotServiceManaged { dir: dir.clone() },
            UpdateError::NoDetachment { dir: dir.clone() },
            UpdateError::AppBundle { dir: dir.clone() },
            UpdateError::Unwritable { dir },
        ] {
            assert_eq!(
                outcome_for_error(&error),
                UpdateOutcome::NotLaunched,
                "{error}"
            );
        }

        let message = cooling_message("v0.5.0", std::time::Duration::from_secs(25 * 60));
        assert!(message.contains("failed 25 minutes ago"));
        assert!(message.contains("due in 35 minutes"));
    }

    #[test]
    fn transient_failures_keep_the_target_for_a_later_check() {
        let dir = PathBuf::from("/opt/gsv/bin");
        assert!(retry_later(&UpdateError::Download("timed out".to_string())));
        assert!(retry_later(&UpdateError::Spawn("no such file".to_string())));
        assert!(retry_later(&UpdateError::State("disk full".to_string())));
        assert!(retry_later(&UpdateError::Deferred {
            since: std::time::Duration::from_secs(60)
        }));
        assert!(!retry_later(&UpdateError::Disabled));
        assert!(!retry_later(&UpdateError::NotServiceManaged {
            dir: dir.clone()
        }));
        assert!(!retry_later(&UpdateError::NoDetachment {
            dir: dir.clone()
        }));
        assert!(!retry_later(&UpdateError::AppBundle { dir: dir.clone() }));
        assert!(!retry_later(&UpdateError::Unwritable { dir }));
    }

    fn test_updater(enabled: bool) -> AutoUpdater {
        let dir = std::env::temp_dir().join(format!("gsvd-lifecycle-{}", uuid::Uuid::new_v4()));
        AutoUpdater::new(
            enabled,
            ReleaseChannel::Stable,
            "0.4.1",
            dir.join("auto-update"),
            dir.join("auto-update.log"),
        )
    }

    #[test]
    fn a_busy_machine_at_drain_returns_to_idle_with_the_target_queued() {
        let lifecycle = UpdateLifecycle::new();
        let requests = ActiveRequests::default();
        assert!(
            lifecycle.begin_drain(&requests).is_none(),
            "nothing pending"
        );
        lifecycle.queue(target("v0.5.0"));
        let (guard, in_flight) = lifecycle.begin_drain(&requests).expect("drain begins");
        assert_eq!(in_flight, 0);
        assert!(
            lifecycle.refusing(),
            "new work is refused from the drain on"
        );
        assert_eq!(
            lifecycle.phase(),
            UpdatePhase::Draining {
                target: target("v0.5.0")
            }
        );
        assert!(!lifecycle.has_pending());
        assert!(
            lifecycle.begin_drain(&requests).is_none(),
            "one drain at a time"
        );
        guard.abandon();
        assert_eq!(lifecycle.phase(), UpdatePhase::Idle);
        assert!(!lifecycle.refusing());
        assert_eq!(lifecycle.pending(), Some(target("v0.5.0")));
    }

    #[tokio::test]
    async fn an_aborted_launch_task_resets_the_lifecycle_by_dropping_its_guard() {
        let lifecycle = UpdateLifecycle::new();
        let (guard, _) = lifecycle
            .begin_drain_for(target("v0.5.0"), None)
            .expect("drain begins");
        let task = AbortOnDrop(tokio::spawn(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        }));
        tokio::task::yield_now().await;
        assert!(lifecycle.refusing());
        drop(task);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(lifecycle.phase(), UpdatePhase::Idle);
        assert!(!lifecycle.refusing());
        assert_eq!(lifecycle.pending(), Some(target("v0.5.0")));
    }

    #[test]
    fn a_confirmed_launch_installs_until_the_installer_is_seen_to_end() {
        let lifecycle = UpdateLifecycle::new();
        let (guard, _) = lifecycle
            .begin_drain_for(target("v0.5.0"), None)
            .expect("drain begins");
        let since = std::time::SystemTime::now();
        guard.confirm(since);
        let epoch = lifecycle.epoch();
        assert_eq!(
            lifecycle.phase(),
            UpdatePhase::Installing {
                target: target("v0.5.0"),
                since,
            }
        );
        assert!(lifecycle.refusing());
        assert!(!lifecycle.has_pending());
        assert!(lifecycle.begin_drain_for(target("v0.6.0"), None).is_none());

        let updater = test_updater(true);
        updater
            .record_attempt_for_test("v0.5.0", since, true)
            .expect("record launched attempt");
        assert!(installer_in_progress(&updater, "v0.5.0").is_some());

        // The installer ended and this daemon is still here, with the same
        // handshake standing: the target is queued again.
        assert_eq!(
            lifecycle.installer_exited(epoch),
            InstallerExit::Requeued(target("v0.5.0"))
        );
        updater.clear_launched("v0.5.0").expect("clear launched");
        assert_eq!(lifecycle.phase(), UpdatePhase::Idle);
        assert!(!lifecycle.refusing());
        assert_eq!(lifecycle.pending(), Some(target("v0.5.0")));
        assert_eq!(installer_in_progress(&updater, "v0.5.0"), None);
        assert_eq!(
            lifecycle.installer_exited(epoch),
            InstallerExit::NotInstalling
        );
    }

    #[test]
    fn a_newer_handshake_supersedes_a_failed_installers_target() {
        // A later handshake chose a different release.
        let lifecycle = UpdateLifecycle::new();
        let (guard, _) = lifecycle
            .begin_drain_for(target("v0.5.0"), None)
            .expect("drain begins");
        guard.confirm(std::time::SystemTime::now());
        let epoch = lifecycle.epoch();
        lifecycle.handshake();
        lifecycle.queue(target("v0.6.0"));
        assert_eq!(
            lifecycle.installer_exited(epoch),
            InstallerExit::Superseded(target("v0.5.0"))
        );
        assert_eq!(lifecycle.phase(), UpdatePhase::Idle);
        assert!(!lifecycle.refusing());
        assert_eq!(lifecycle.pending(), Some(target("v0.6.0")));

        // A later handshake decided there is nothing to install (a rollback).
        let lifecycle = UpdateLifecycle::new();
        let (guard, _) = lifecycle
            .begin_drain_for(target("v0.5.0"), None)
            .expect("drain begins");
        guard.confirm(std::time::SystemTime::now());
        let epoch = lifecycle.epoch();
        lifecycle.handshake();
        lifecycle.clear_pending();
        assert_eq!(
            lifecycle.installer_exited(epoch),
            InstallerExit::Superseded(target("v0.5.0"))
        );
        assert!(!lifecycle.has_pending());

        // Same handshake, but something else is already queued: keep it.
        let lifecycle = UpdateLifecycle::new();
        let (guard, _) = lifecycle
            .begin_drain_for(target("v0.5.0"), None)
            .expect("drain begins");
        guard.confirm(std::time::SystemTime::now());
        let epoch = lifecycle.epoch();
        lifecycle.queue(target("v0.7.0"));
        assert_eq!(
            lifecycle.installer_exited(epoch),
            InstallerExit::Superseded(target("v0.5.0"))
        );
        assert_eq!(lifecycle.pending(), Some(target("v0.7.0")));
    }

    #[tokio::test]
    async fn a_launch_that_fails_before_the_installer_exists_resets_the_lifecycle() {
        let (runtime, _receiver) = DaemonRuntime::new("machine-a".to_string());
        let shutdown = CancellationToken::new();
        // Disabled is not worth retrying, so the target is discarded; the
        // guard's drop is the only reset path, whatever the error.
        let lifecycle = UpdateLifecycle::new();
        let (guard, _) = lifecycle
            .begin_drain_for(target("v0.5.0"), None)
            .expect("drain begins");
        assert!(lifecycle.refusing());
        let outcome = start_update(
            test_updater(false),
            runtime,
            lifecycle.clone(),
            guard,
            shutdown,
        )
        .await;
        assert_eq!(outcome, UpdateOutcome::NotLaunched);
        assert_eq!(lifecycle.phase(), UpdatePhase::Idle);
        assert!(!lifecycle.refusing());
        assert!(!lifecycle.has_pending());
    }

    #[tokio::test]
    async fn a_refused_request_with_a_body_cancels_the_body() {
        use gateway_client::protocol::{
            parse_binary_frame, FrameBodyDescriptor, BINARY_FRAME_CANCEL,
        };
        let (frames_tx, mut frames_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let channel = gateway_client::BinaryBodyChannel::new(BinaryBodyLimits::default(), {
            move |frame| {
                let frames_tx = frames_tx.clone();
                async move {
                    let _ = frames_tx.send(frame);
                    Ok(())
                }
            }
        })
        .expect("body channel");
        let descriptor = FrameBodyDescriptor {
            stream_id: 7,
            length: Some(64),
        };
        let request = RequestFrame {
            id: "req-shell".to_string(),
            call: "shell.exec".to_string(),
            args: None,
            body: Some(descriptor),
        };
        assert!(update_refusal_frame(&request).is_some());
        cancel_refused_body(&channel, request.body);
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), frames_rx.recv())
            .await
            .expect("a control frame is sent")
            .expect("frame");
        let (stream_id, flags, _) = parse_binary_frame(&frame).expect("binary frame");
        assert_eq!(stream_id, 7);
        assert_ne!(flags & BINARY_FRAME_CANCEL, 0, "the sender is told to stop");

        // Without a body there is nothing to cancel and nothing is sent.
        cancel_refused_body(&channel, None);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), frames_rx.recv())
                .await
                .is_err()
        );
    }

    fn shell_request(id: &str) -> RequestFrame {
        RequestFrame {
            id: id.to_string(),
            call: "shell.exec".to_string(),
            args: None,
            body: None,
        }
    }

    #[test]
    fn admission_and_the_drain_share_one_critical_section() {
        let lifecycle = UpdateLifecycle::new();
        let requests = ActiveRequests::default();

        // Admitted before the drain: counted in flight, so the machine is busy.
        let before = match lifecycle.admit(&requests, &shell_request("req-before")) {
            Admission::Admitted(cancellation) => Some(cancellation),
            Admission::Refused(_) => None,
        }
        .expect("an idle lifecycle admits work");
        lifecycle.queue(target("v0.5.0"));
        let (guard, in_flight) = lifecycle.begin_drain(&requests).expect("drain begins");
        assert_eq!(in_flight, 1);
        assert_eq!(work_reason(in_flight, 0), Some("requests in flight"));

        // Arriving after the flip: refused, never registered. Reads pass.
        assert!(matches!(
            lifecycle.admit(&requests, &shell_request("req-after")),
            Admission::Refused(_)
        ));
        assert_eq!(requests.in_flight(), 1);
        let read = RequestFrame {
            call: "fs.read".to_string(),
            ..shell_request("req-read")
        };
        assert!(matches!(
            lifecycle.admit(&requests, &read),
            Admission::Admitted(_)
        ));

        requests.finish("req-before", &before);
        guard.abandon();
        assert!(matches!(
            lifecycle.admit(&requests, &shell_request("req-idle-again")),
            Admission::Admitted(_)
        ));
    }

    #[test]
    fn no_interleaving_admits_a_request_the_drain_does_not_count() {
        for round in 0..20 {
            let lifecycle = UpdateLifecycle::new();
            let requests = ActiveRequests::default();
            lifecycle.queue(target("v0.5.0"));
            let admitted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let start = Arc::new(std::sync::Barrier::new(9));
            let mut workers = Vec::new();
            for worker in 0..8 {
                let lifecycle = lifecycle.clone();
                let requests = requests.clone();
                let admitted = admitted.clone();
                let start = start.clone();
                workers.push(std::thread::spawn(move || {
                    start.wait();
                    let request = shell_request(&format!("req-{round}-{worker}"));
                    if let Admission::Admitted(_) = lifecycle.admit(&requests, &request) {
                        admitted.fetch_add(1, Ordering::SeqCst);
                    }
                }));
            }
            start.wait();
            let (guard, in_flight) = lifecycle.begin_drain(&requests).expect("drain begins");
            for worker in workers {
                worker.join().expect("worker finishes");
            }
            // Every admitted request was counted by the drain, and every
            // request the drain did not count was refused.
            assert_eq!(in_flight, admitted.load(Ordering::SeqCst), "round {round}");
            assert_eq!(requests.in_flight(), in_flight, "round {round}");
            guard.abandon();
        }
    }

    #[test]
    fn a_newer_gateway_is_followed_only_after_the_handshake_result_exists() {
        let dir = std::env::temp_dir().join(format!("gsvd-connect-{}", uuid::Uuid::new_v4()));
        let updater = AutoUpdater::new(
            true,
            ReleaseChannel::Stable,
            "0.4.1",
            dir.join("auto-update"),
            dir.join("auto-update.log"),
        );
        assert_eq!(update_after_connect(&updater, None), None);
        assert_eq!(
            update_after_connect(&updater, Some(&connect_result("0.4.1", "v0.4.1"))),
            None
        );
        assert_eq!(
            update_after_connect(&updater, Some(&connect_result("0.5.0", "v0.5.0")))
                .map(|target| target.release),
            Some("v0.5.0".to_string())
        );
    }

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
