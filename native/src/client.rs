use std::collections::HashMap;
use std::env;
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gsv::config::CliConfig;
use gsv::connection::GatewayRpcError;
use gsv::kernel_client::{GatewayAuth, KernelClient, ProcSendResult};
use gsv::protocol::Frame;
use serde_json::{json, Value};
use tokio::sync::mpsc as tokio_mpsc;
use tokio::task::JoinSet;

use crate::startup::{
    resolve_startup, ConnectionSettings, Credential, LoginDefaults, LoginStep, StartupResolution,
    StartupSources,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const RPC_TIMEOUT: Duration = Duration::from_secs(45);
const RPC_ENVELOPE_TIMEOUT: Duration = Duration::from_secs(46);
const CONNECTION_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const HISTORY_POLL_INTERVAL: Duration = Duration::from_secs(5);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(250);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(8);
const DEMO_SESSION_ID: u64 = 0;

static NEXT_LIVE_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub enum ApprovalDecision {
    Approve { remember: bool },
    Deny,
}

#[derive(Clone)]
pub enum ClientCommand {
    Connect(ConnectionSettings),
    CancelConnect {
        attempt_id: u64,
    },
    Send {
        submission_id: u64,
        message: String,
    },
    Abort {
        run_id: String,
    },
    Decide {
        request_id: String,
        decision: ApprovalDecision,
    },
    RefreshHistory,
    Shell(String),
    Shutdown,
}

#[derive(Clone, Debug)]
pub enum ClientEvent {
    Connecting,
    LoginFailed {
        attempt_id: u64,
        defaults: LoginDefaults,
        step: LoginStep,
        message: String,
    },
    SetupRequired {
        attempt_id: u64,
        defaults: LoginDefaults,
        message: String,
    },
    Reconnecting {
        attempt: u32,
        message: String,
    },
    Connected {
        attempt_id: u64,
        session_id: u64,
        pid: String,
    },
    History {
        session_id: u64,
        history: Value,
    },
    /// The snapshot is intentionally withheld because a newer signal owns the state.
    HistorySuperseded {
        session_id: u64,
        request_signal_id: u64,
        response_signal_id: u64,
    },
    Signal {
        session_id: u64,
        name: String,
        payload: Value,
    },
    SendAccepted {
        submission_id: u64,
        run_id: String,
        queued: bool,
    },
    SendFailed {
        submission_id: u64,
        message: String,
    },
    SendUncertain {
        submission_id: u64,
        submitted_text: String,
        message: String,
    },
    AbortResolved {
        run_id: String,
    },
    AbortFailed {
        run_id: String,
        message: String,
    },
    ApprovalResolved {
        request_id: String,
    },
    ApprovalFailed {
        request_id: String,
        message: String,
    },
    ShellResult {
        command: String,
        output: String,
        exit_code: Option<i64>,
    },
    Error(String),
}

pub struct ClientHandle {
    pub commands: tokio_mpsc::UnboundedSender<ClientCommand>,
    pub events: tokio_mpsc::UnboundedReceiver<ClientEvent>,
    pub login: Option<LoginDefaults>,
}

pub fn start(demo: bool) -> ClientHandle {
    let (command_tx, command_rx) = tokio_mpsc::unbounded_channel();
    let (event_tx, event_rx) = tokio_mpsc::unbounded_channel();
    let (initial_connection, login) = if demo {
        (None, None)
    } else {
        match startup_resolution() {
            StartupResolution::Connect(settings) => (Some(settings), None),
            StartupResolution::Login(defaults) => (None, Some(defaults)),
        }
    };
    let thread_name = if demo {
        "gsv-native-demo"
    } else {
        "gsv-native-client"
    };

    let thread_events = event_tx.clone();
    let spawn_result = thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = thread_events.send(ClientEvent::Error(format!(
                        "The native client runtime could not start: {error}"
                    )));
                    return;
                }
            };
            if demo {
                runtime.block_on(run_demo(command_rx, thread_events));
            } else {
                runtime.block_on(run_live(command_rx, thread_events, initial_connection));
            }
        });
    if let Err(error) = spawn_result {
        let _ = event_tx.send(ClientEvent::Error(format!(
            "The native client thread could not start: {error}"
        )));
    }

    ClientHandle {
        commands: command_tx,
        events: event_rx,
        login,
    }
}

async fn run_live(
    mut commands: tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: tokio_mpsc::UnboundedSender<ClientEvent>,
    mut connection: Option<ConnectionSettings>,
) {
    let mut preferred_pid = None;
    let mut reconnect_attempt = 0_u32;
    let mut has_connected = false;

    'connection: loop {
        let settings = match connection.take() {
            Some(settings) => settings,
            None => {
                has_connected = false;
                preferred_pid = None;
                reconnect_attempt = 0;
                let Some(settings) = wait_for_connection(&mut commands, &events).await else {
                    return;
                };
                settings
            }
        };
        let _ = events.send(ClientEvent::Connecting);
        let reconnect_pid = preferred_pid.clone();
        let url = settings.url.clone();
        let establishing = establish_live_session(
            &url,
            gateway_auth(&settings),
            reconnect_pid.as_deref(),
            events.clone(),
        );
        tokio::pin!(establishing);

        let session = loop {
            tokio::select! {
                biased;
                command = commands.recv() => {
                    let Some(command) = command else {
                        return;
                    };
                    match command {
                        ClientCommand::Connect(next) => {
                            has_connected = false;
                            preferred_pid = None;
                            reconnect_attempt = 0;
                            connection = Some(next);
                            continue 'connection;
                        }
                        ClientCommand::CancelConnect { attempt_id }
                            if attempt_id == settings.attempt_id =>
                        {
                            has_connected = false;
                            preferred_pid = None;
                            continue 'connection;
                        }
                        command => {
                            if handle_unavailable_command(command, &events) {
                                return;
                            }
                        }
                    }
                }
                result = &mut establishing => break result,
            }
        };

        let session = match session {
            Ok(session) => session,
            Err(error) => {
                match error.kind {
                    EstablishFailureKind::Authentication(step) => {
                        let _ = events.send(ClientEvent::LoginFailed {
                            attempt_id: settings.attempt_id,
                            defaults: login_defaults(&settings),
                            step,
                            message: error.message,
                        });
                        preferred_pid = None;
                        continue;
                    }
                    EstablishFailureKind::SetupRequired => {
                        let _ = events.send(ClientEvent::SetupRequired {
                            attempt_id: settings.attempt_id,
                            defaults: login_defaults(&settings),
                            message: error.message,
                        });
                        preferred_pid = None;
                        continue;
                    }
                    EstablishFailureKind::Transport if !has_connected => {
                        let _ = events.send(ClientEvent::LoginFailed {
                            attempt_id: settings.attempt_id,
                            defaults: login_defaults(&settings),
                            step: LoginStep::Url,
                            message: error.message,
                        });
                        preferred_pid = None;
                        continue;
                    }
                    EstablishFailureKind::Session if !has_connected => {
                        let _ = events.send(ClientEvent::LoginFailed {
                            attempt_id: settings.attempt_id,
                            defaults: login_defaults(&settings),
                            step: LoginStep::Password,
                            message: error.message,
                        });
                        preferred_pid = None;
                        continue;
                    }
                    EstablishFailureKind::Transport | EstablishFailureKind::Session => {}
                }
                reconnect_attempt = reconnect_attempt.saturating_add(1);
                let _ = events.send(ClientEvent::Reconnecting {
                    attempt: reconnect_attempt,
                    message: error.message,
                });
                match wait_to_reconnect(
                    reconnect_attempt,
                    settings.attempt_id,
                    &mut commands,
                    &events,
                )
                .await
                {
                    ReconnectWaitOutcome::Retry => connection = Some(settings),
                    ReconnectWaitOutcome::Replace(next) => {
                        has_connected = false;
                        preferred_pid = None;
                        connection = Some(next);
                    }
                    ReconnectWaitOutcome::Cancelled => {
                        has_connected = false;
                        preferred_pid = None;
                    }
                    ReconnectWaitOutcome::Shutdown => return,
                }
                continue;
            }
        };

        loop {
            match commands.try_recv() {
                Ok(ClientCommand::Connect(next)) => {
                    has_connected = false;
                    preferred_pid = None;
                    reconnect_attempt = 0;
                    connection = Some(next);
                    continue 'connection;
                }
                Ok(ClientCommand::CancelConnect { attempt_id })
                    if attempt_id == settings.attempt_id =>
                {
                    has_connected = false;
                    preferred_pid = None;
                    continue 'connection;
                }
                Ok(command) => {
                    if handle_unavailable_command(command, &events) {
                        return;
                    }
                }
                Err(tokio_mpsc::error::TryRecvError::Empty) => break,
                Err(tokio_mpsc::error::TryRecvError::Disconnected) => return,
            }
        }

        let LiveSession {
            client,
            pid,
            history,
            history_request_signal_id,
            process_exit,
            signal_lease,
            session_id,
        } = session;
        has_connected = true;
        reconnect_attempt = 0;
        preferred_pid = Some(pid.clone());
        if settings.remember_identity {
            remember_connection_identity(&settings);
        }
        let _ = events.send(ClientEvent::Connected {
            attempt_id: settings.attempt_id,
            session_id,
            pid: pid.clone(),
        });
        let initial_history_superseded =
            signal_lease.handoff_history(history_request_signal_id, history, &events);

        match run_connected_session(
            ActiveClientSession {
                client,
                pid,
                process_exit,
                signal_lease,
                attempt_id: settings.attempt_id,
            },
            &mut commands,
            &events,
            initial_history_superseded,
        )
        .await
        {
            ConnectedSessionOutcome::Shutdown => return,
            ConnectedSessionOutcome::Reconnect(message) => {
                reconnect_attempt = 1;
                let _ = events.send(ClientEvent::Reconnecting {
                    attempt: reconnect_attempt,
                    message,
                });
                match wait_to_reconnect(
                    reconnect_attempt,
                    settings.attempt_id,
                    &mut commands,
                    &events,
                )
                .await
                {
                    ReconnectWaitOutcome::Retry => connection = Some(settings),
                    ReconnectWaitOutcome::Replace(next) => {
                        has_connected = false;
                        preferred_pid = None;
                        connection = Some(next);
                    }
                    ReconnectWaitOutcome::Cancelled => {
                        has_connected = false;
                        preferred_pid = None;
                    }
                    ReconnectWaitOutcome::Shutdown => return,
                }
            }
            ConnectedSessionOutcome::Replace(next) => {
                has_connected = false;
                preferred_pid = None;
                connection = Some(next);
            }
            ConnectedSessionOutcome::Cancelled => {
                has_connected = false;
                preferred_pid = None;
            }
        }
    }
}

struct LiveSession {
    client: Arc<KernelClient>,
    pid: String,
    history: Value,
    history_request_signal_id: u64,
    process_exit: Arc<tokio::sync::Notify>,
    signal_lease: SessionSignalLease,
    session_id: u64,
}

struct ActiveClientSession {
    client: Arc<KernelClient>,
    pid: String,
    process_exit: Arc<tokio::sync::Notify>,
    signal_lease: SessionSignalLease,
    attempt_id: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EstablishFailureKind {
    Authentication(LoginStep),
    SetupRequired,
    Transport,
    Session,
}

#[derive(Debug)]
struct EstablishFailure {
    kind: EstablishFailureKind,
    message: String,
}

impl EstablishFailure {
    fn session(message: impl Into<String>) -> Self {
        Self {
            kind: EstablishFailureKind::Session,
            message: message.into(),
        }
    }
}

#[derive(Debug)]
struct BufferedSignal {
    name: String,
    payload: Value,
}

#[derive(Debug)]
struct SignalState {
    active: bool,
    released: bool,
    last_signal_id: u64,
    selected_pid: Option<String>,
    buffered: Vec<BufferedSignal>,
}

struct SessionSignalLease {
    session_id: u64,
    state: Arc<Mutex<SignalState>>,
}

impl SessionSignalLease {
    fn new(session_id: u64) -> Self {
        Self {
            session_id,
            state: Arc::new(Mutex::new(SignalState {
                active: true,
                released: false,
                last_signal_id: 0,
                selected_pid: None,
                buffered: Vec::new(),
            })),
        }
    }

    fn select_pid(&self, pid: String) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        state.selected_pid = Some(pid.clone());
        state
            .buffered
            .retain(|signal| signal.payload.get("pid").and_then(Value::as_str) == Some(&pid));
        state
            .buffered
            .iter()
            .any(|signal| signal.name == "process.exit")
    }

    fn signal_watermark(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.last_signal_id)
            .unwrap_or_default()
    }

    fn handoff_history(
        &self,
        request_signal_id: u64,
        history: Value,
        events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            let _ = events.send(ClientEvent::History {
                session_id: self.session_id,
                history,
            });
            return false;
        };
        if !state.active || state.released {
            return false;
        }

        // Event enqueueing stays under the same lock as signal observation so
        // the handoff is buffered signals -> snapshot boundary -> live signals.
        for signal in std::mem::take(&mut state.buffered) {
            let _ = events.send(ClientEvent::Signal {
                session_id: self.session_id,
                name: signal.name,
                payload: signal.payload,
            });
        }
        let response_signal_id = state.last_signal_id;
        let superseded = response_signal_id != request_signal_id;
        if superseded {
            let _ = events.send(ClientEvent::HistorySuperseded {
                session_id: self.session_id,
                request_signal_id,
                response_signal_id,
            });
        } else {
            let _ = events.send(ClientEvent::History {
                session_id: self.session_id,
                history,
            });
        }
        state.released = true;
        superseded
    }

    fn emit_history_if_current(
        &self,
        request_signal_id: u64,
        history: Value,
        events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    ) -> bool {
        let Ok(state) = self.state.lock() else {
            let _ = events.send(ClientEvent::History {
                session_id: self.session_id,
                history,
            });
            return false;
        };
        if !state.active {
            return false;
        }

        // A callback cannot advance the watermark or enqueue its signal between
        // this comparison and the history event while this guard is held.
        let response_signal_id = state.last_signal_id;
        if response_signal_id != request_signal_id {
            let _ = events.send(ClientEvent::HistorySuperseded {
                session_id: self.session_id,
                request_signal_id,
                response_signal_id,
            });
            true
        } else {
            let _ = events.send(ClientEvent::History {
                session_id: self.session_id,
                history,
            });
            false
        }
    }

    fn deactivate(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active = false;
            state.buffered.clear();
        }
    }
}

impl Drop for SessionSignalLease {
    fn drop(&mut self) {
        self.deactivate();
    }
}

enum ConnectedSessionOutcome {
    Reconnect(String),
    Replace(ConnectionSettings),
    Cancelled,
    Shutdown,
}

enum ReconnectWaitOutcome {
    Retry,
    Replace(ConnectionSettings),
    Cancelled,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestFailureKind {
    Rejected,
    Transport,
}

#[derive(Debug)]
struct RequestFailure {
    kind: RequestFailureKind,
    message: String,
}

impl RequestFailure {
    fn rejected(message: impl Into<String>) -> Self {
        Self {
            kind: RequestFailureKind::Rejected,
            message: message.into(),
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self {
            kind: RequestFailureKind::Transport,
            message: message.into(),
        }
    }
}

impl Display for RequestFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug)]
enum SendAttemptFailure {
    Rejected(String),
    Uncertain(String),
}

#[derive(Debug)]
struct ShellResponse {
    output: String,
    exit_code: Option<i64>,
}

enum ConnectedTaskOutcome {
    Send(Result<ProcSendResult, SendAttemptFailure>),
    Abort(Result<Value, RequestFailure>),
    Approval(Result<Value, RequestFailure>),
    History(Result<Value, RequestFailure>),
    Shell(Result<ShellResponse, RequestFailure>),
}

struct ConnectedTaskCompletion {
    operation_id: u64,
    outcome: ConnectedTaskOutcome,
}

enum PendingOperation {
    Send {
        submission_id: u64,
        submitted_text: String,
    },
    Abort {
        run_id: String,
    },
    Approval {
        request_id: String,
    },
    History {
        request_signal_id: u64,
    },
    Shell {
        command: String,
    },
}

#[derive(Default)]
struct HistoryRefresh {
    in_flight: bool,
    pending: bool,
}

impl HistoryRefresh {
    fn request(&mut self) -> bool {
        if self.in_flight {
            self.pending = true;
            false
        } else {
            self.in_flight = true;
            true
        }
    }

    fn complete(&mut self) -> bool {
        if self.pending {
            self.pending = false;
            true
        } else {
            self.in_flight = false;
            false
        }
    }
}

fn next_live_session_id() -> u64 {
    loop {
        let session_id = NEXT_LIVE_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        if session_id != DEMO_SESSION_ID {
            return session_id;
        }
    }
}

fn queue_session_signal(
    state: &Arc<Mutex<SignalState>>,
    session_id: u64,
    name: String,
    payload: Value,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
) -> bool {
    let Ok(mut state) = state.lock() else {
        return false;
    };
    if !state.active {
        return false;
    }
    if let Some(expected_pid) = state.selected_pid.as_deref() {
        if payload.get("pid").and_then(Value::as_str) != Some(expected_pid) {
            return false;
        }
    }
    state.last_signal_id = state.last_signal_id.saturating_add(1);
    if state.selected_pid.is_none() {
        state.buffered.push(BufferedSignal { name, payload });
        return false;
    }

    if state.released {
        let _ = events.send(ClientEvent::Signal {
            session_id,
            name,
            payload,
        });
    } else {
        state.buffered.push(BufferedSignal { name, payload });
    }
    true
}

fn reserve_operation(
    next_operation_id: &mut u64,
    pending: &mut HashMap<u64, PendingOperation>,
    operation: PendingOperation,
) -> u64 {
    let operation_id = *next_operation_id;
    *next_operation_id = next_operation_id.wrapping_add(1);
    if *next_operation_id == 0 {
        *next_operation_id = 1;
    }
    pending.insert(operation_id, operation);
    operation_id
}

fn spawn_connected_command(
    tasks: &mut JoinSet<ConnectedTaskCompletion>,
    pending: &mut HashMap<u64, PendingOperation>,
    next_operation_id: &mut u64,
    client: Arc<KernelClient>,
    pid: String,
    command: ClientCommand,
) {
    match command {
        ClientCommand::Send {
            submission_id,
            message,
        } => {
            let operation_id = reserve_operation(
                next_operation_id,
                pending,
                PendingOperation::Send {
                    submission_id,
                    submitted_text: message.clone(),
                },
            );
            tasks.spawn(async move {
                ConnectedTaskCompletion {
                    operation_id,
                    outcome: ConnectedTaskOutcome::Send(
                        send_message(&client, &pid, &message).await,
                    ),
                }
            });
        }
        ClientCommand::Abort { run_id } => {
            let operation_id = reserve_operation(
                next_operation_id,
                pending,
                PendingOperation::Abort {
                    run_id: run_id.clone(),
                },
            );
            tasks.spawn(async move {
                let result = request_ok(
                    &client,
                    "proc.abort",
                    Some(json!({ "pid": pid, "runId": run_id })),
                )
                .await;
                ConnectedTaskCompletion {
                    operation_id,
                    outcome: ConnectedTaskOutcome::Abort(result),
                }
            });
        }
        ClientCommand::Decide {
            request_id,
            decision,
        } => {
            let operation_id = reserve_operation(
                next_operation_id,
                pending,
                PendingOperation::Approval {
                    request_id: request_id.clone(),
                },
            );
            tasks.spawn(async move {
                let (decision, remember) = match decision {
                    ApprovalDecision::Approve { remember } => ("approve", remember),
                    ApprovalDecision::Deny => ("deny", false),
                };
                let result = request_ok(
                    &client,
                    "proc.hil",
                    Some(json!({
                        "pid": pid,
                        "requestId": request_id,
                        "decision": decision,
                        "remember": remember,
                    })),
                )
                .await;
                ConnectedTaskCompletion {
                    operation_id,
                    outcome: ConnectedTaskOutcome::Approval(result),
                }
            });
        }
        ClientCommand::Shell(command) => {
            let operation_id = reserve_operation(
                next_operation_id,
                pending,
                PendingOperation::Shell {
                    command: command.clone(),
                },
            );
            tasks.spawn(async move {
                ConnectedTaskCompletion {
                    operation_id,
                    outcome: ConnectedTaskOutcome::Shell(execute_shell(&client, command).await),
                }
            });
        }
        ClientCommand::Connect(_)
        | ClientCommand::CancelConnect { .. }
        | ClientCommand::RefreshHistory
        | ClientCommand::Shutdown => {}
    }
}

fn spawn_history_task(
    tasks: &mut JoinSet<ConnectedTaskCompletion>,
    pending: &mut HashMap<u64, PendingOperation>,
    next_operation_id: &mut u64,
    client: Arc<KernelClient>,
    pid: String,
    request_signal_id: u64,
) {
    let operation_id = reserve_operation(
        next_operation_id,
        pending,
        PendingOperation::History { request_signal_id },
    );
    tasks.spawn(async move {
        ConnectedTaskCompletion {
            operation_id,
            outcome: ConnectedTaskOutcome::History(fetch_history(&client, &pid).await),
        }
    });
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CompletionDisposition {
    completed_history: bool,
    superseded_history: bool,
}

fn emit_connected_completion(
    completion: ConnectedTaskCompletion,
    pending: &mut HashMap<u64, PendingOperation>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    signal_lease: &SessionSignalLease,
    suppress_history: bool,
) -> CompletionDisposition {
    let Some(operation) = pending.remove(&completion.operation_id) else {
        return CompletionDisposition::default();
    };
    let completed_history = matches!(operation, PendingOperation::History { .. });
    if suppress_history && completed_history {
        return CompletionDisposition {
            completed_history: true,
            superseded_history: false,
        };
    }

    let mut superseded_history = false;

    match (operation, completion.outcome) {
        (
            PendingOperation::Send {
                submission_id,
                submitted_text,
            },
            ConnectedTaskOutcome::Send(result),
        ) => match result {
            Ok(result) => {
                let _ = events.send(ClientEvent::SendAccepted {
                    submission_id,
                    run_id: result.run_id,
                    queued: result.queued,
                });
            }
            Err(SendAttemptFailure::Rejected(error)) => {
                let _ = events.send(ClientEvent::SendFailed {
                    submission_id,
                    message: format!("GSV couldn’t accept that thought: {error}"),
                });
            }
            Err(SendAttemptFailure::Uncertain(error)) => {
                let _ = events.send(ClientEvent::SendUncertain {
                    submission_id,
                    submitted_text,
                    message: format!(
                        "GSV may have accepted that thought, but the response was lost: {error}"
                    ),
                });
            }
        },
        (PendingOperation::Abort { run_id }, ConnectedTaskOutcome::Abort(result)) => match result {
            Ok(response) if abort_response_applied(&response, &run_id) => {
                let _ = events.send(ClientEvent::AbortResolved { run_id });
            }
            Ok(_) => {
                let _ = events.send(ClientEvent::AbortFailed {
                    run_id,
                    message: "That run was no longer active when GSV received the stop request."
                        .to_string(),
                });
            }
            Err(error) => {
                let _ = events.send(ClientEvent::AbortFailed {
                    run_id,
                    message: format!("The active run could not be stopped: {error}"),
                });
            }
        },
        (PendingOperation::Approval { request_id }, ConnectedTaskOutcome::Approval(result)) => {
            match result {
                Ok(response) if approval_response_matches(&response, &request_id) => {
                    let _ = events.send(ClientEvent::ApprovalResolved { request_id });
                }
                Ok(_) => {
                    let _ = events.send(ClientEvent::ApprovalFailed {
                        request_id,
                        message:
                            "GSV returned a different approval request than the one submitted."
                                .to_string(),
                    });
                }
                Err(error) => {
                    let _ = events.send(ClientEvent::ApprovalFailed {
                        request_id,
                        message: format!("That approval decision could not be applied: {error}"),
                    });
                }
            }
        }
        (
            PendingOperation::History { request_signal_id },
            ConnectedTaskOutcome::History(result),
        ) => match result {
            Ok(history) => {
                superseded_history =
                    signal_lease.emit_history_if_current(request_signal_id, history, events);
            }
            Err(error) => {
                let _ = events.send(ClientEvent::Error(format!(
                    "This process’s history could not be read: {error}"
                )));
            }
        },
        (PendingOperation::Shell { command }, ConnectedTaskOutcome::Shell(result)) => {
            match result {
                Ok(result) => {
                    let _ = events.send(ClientEvent::ShellResult {
                        command,
                        output: result.output,
                        exit_code: result.exit_code,
                    });
                }
                Err(error) => {
                    let _ = events.send(ClientEvent::ShellResult {
                        command,
                        output: error.to_string(),
                        exit_code: None,
                    });
                }
            }
        }
        _ => {
            let _ = events.send(ClientEvent::Error(
                "The native client mismatched an operation result.".to_string(),
            ));
        }
    }
    CompletionDisposition {
        completed_history,
        superseded_history,
    }
}

async fn reconcile_interrupted_tasks(
    tasks: &mut JoinSet<ConnectedTaskCompletion>,
    pending: &mut HashMap<u64, PendingOperation>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    signal_lease: &SessionSignalLease,
    reason: &str,
) {
    while let Some(result) = tasks.try_join_next() {
        if let Ok(completion) = result {
            emit_connected_completion(completion, pending, events, signal_lease, true);
        }
    }

    tasks.abort_all();
    while tasks.join_next().await.is_some() {}

    for (_, operation) in pending.drain() {
        match operation {
            PendingOperation::Send {
                submission_id,
                submitted_text,
            } => {
                let _ = events.send(ClientEvent::SendUncertain {
                    submission_id,
                    submitted_text,
                    message: reason.to_string(),
                });
            }
            PendingOperation::Abort { run_id } => {
                let _ = events.send(ClientEvent::AbortFailed {
                    run_id,
                    message: reason.to_string(),
                });
            }
            PendingOperation::Approval { request_id } => {
                let _ = events.send(ClientEvent::ApprovalFailed {
                    request_id,
                    message: reason.to_string(),
                });
            }
            PendingOperation::Shell { command } => {
                let _ = events.send(ClientEvent::ShellResult {
                    command,
                    output: reason.to_string(),
                    exit_code: None,
                });
            }
            PendingOperation::History { .. } => {}
        }
    }
}

async fn discard_tasks(tasks: &mut JoinSet<ConnectedTaskCompletion>) {
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

fn abort_response_applied(response: &Value, requested_run_id: &str) -> bool {
    response.get("aborted").and_then(Value::as_bool) == Some(true)
        && response
            .get("runId")
            .and_then(Value::as_str)
            .is_none_or(|run_id| run_id == requested_run_id)
}

fn approval_response_matches(response: &Value, request_id: &str) -> bool {
    response.get("requestId").and_then(Value::as_str) == Some(request_id)
}

async fn establish_live_session(
    url: &str,
    auth: GatewayAuth,
    preferred_pid: Option<&str>,
    events: tokio_mpsc::UnboundedSender<ClientEvent>,
) -> Result<LiveSession, EstablishFailure> {
    let session_id = next_live_session_id();
    let process_exit = Arc::new(tokio::sync::Notify::new());
    let signal_lease = SessionSignalLease::new(session_id);
    let signal_state = signal_lease.state.clone();
    let signal_process_exit = process_exit.clone();
    let signal_events = events.clone();
    let connect = KernelClient::connect_user(url, auth, move |frame| {
        let Frame::Sig(signal) = frame else {
            return;
        };
        let payload = signal.payload.unwrap_or_else(|| json!({}));
        let is_process_exit = signal.signal == "process.exit";
        if queue_session_signal(
            &signal_state,
            session_id,
            signal.signal,
            payload,
            &signal_events,
        ) && is_process_exit
        {
            signal_process_exit.notify_one();
        }
    });
    let connected = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| EstablishFailure {
            kind: EstablishFailureKind::Transport,
            message: format!("Connecting to {url} timed out after {CONNECT_TIMEOUT:?}."),
        })?;
    let client = Arc::new(connected.map_err(|error| classify_connect_failure(url, error))?);

    let pid = choose_process(&client, preferred_pid)
        .await
        .map_err(EstablishFailure::session)?;
    if signal_lease.select_pid(pid.clone()) {
        process_exit.notify_one();
    }
    let history_request_signal_id = signal_lease.signal_watermark();
    let history = fetch_history(&client, &pid).await.map_err(|error| {
        EstablishFailure::session(format!("This process’s history could not be read: {error}"))
    })?;

    Ok(LiveSession {
        client,
        pid,
        history,
        history_request_signal_id,
        process_exit,
        signal_lease,
        session_id,
    })
}

fn classify_connect_failure(url: &str, error: Box<dyn std::error::Error>) -> EstablishFailure {
    if let Some(error) = error.downcast_ref::<GatewayRpcError>() {
        if error.is_setup_required() {
            return EstablishFailure {
                kind: EstablishFailureKind::SetupRequired,
                message: "This GSV still needs first-time setup. Finish setup in the web app or with `gsv auth setup`, then try again."
                    .to_string(),
            };
        }
        if error.code == 401 {
            let unknown_user = error.message.to_ascii_lowercase().contains("unknown user");
            return EstablishFailure {
                kind: EstablishFailureKind::Authentication(if unknown_user {
                    LoginStep::Username
                } else {
                    LoginStep::Password
                }),
                message: if unknown_user {
                    "I couldn’t find that user on this GSV.".to_string()
                } else {
                    "That username or credential wasn’t accepted.".to_string()
                },
            };
        }
    }

    EstablishFailure {
        kind: EstablishFailureKind::Transport,
        message: format!("I couldn’t reach your GSV at {url}. {error}"),
    }
}

async fn run_connected_session(
    session: ActiveClientSession,
    commands: &mut tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    initial_history_superseded: bool,
) -> ConnectedSessionOutcome {
    let ActiveClientSession {
        client,
        pid,
        process_exit,
        signal_lease,
        attempt_id: session_attempt_id,
    } = session;
    let mut connection_check = tokio::time::interval(CONNECTION_CHECK_INTERVAL);
    connection_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut history_poll = tokio::time::interval(HISTORY_POLL_INTERVAL);
    history_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    history_poll.tick().await;
    let mut tasks = JoinSet::new();
    let mut pending = HashMap::new();
    let mut next_operation_id = 1_u64;
    let mut history_refresh = HistoryRefresh::default();
    if initial_history_superseded && history_refresh.request() {
        spawn_history_task(
            &mut tasks,
            &mut pending,
            &mut next_operation_id,
            client.clone(),
            pid.clone(),
            signal_lease.signal_watermark(),
        );
    }

    loop {
        if client.connection().is_disconnected() {
            signal_lease.deactivate();
            reconcile_interrupted_tasks(
                &mut tasks,
                &mut pending,
                events,
                &signal_lease,
                "The connection changed before GSV confirmed the operation.",
            )
            .await;
            return ConnectedSessionOutcome::Reconnect(
                "The connection to your GSV closed.".to_string(),
            );
        }

        tokio::select! {
            biased;
            _ = process_exit.notified() => {
                signal_lease.deactivate();
                reconcile_interrupted_tasks(
                    &mut tasks,
                    &mut pending,
                    events,
                    &signal_lease,
                    "That GSV process ended before it confirmed the operation.",
                ).await;
                return ConnectedSessionOutcome::Reconnect(
                    "That GSV process ended. I’m opening another conversation.".to_string(),
                );
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    signal_lease.deactivate();
                    discard_tasks(&mut tasks).await;
                    return ConnectedSessionOutcome::Shutdown;
                };
                match command {
                    ClientCommand::Connect(next) => {
                        signal_lease.deactivate();
                        reconcile_interrupted_tasks(
                            &mut tasks,
                            &mut pending,
                            events,
                            &signal_lease,
                            "The connection changed before GSV confirmed the operation.",
                        ).await;
                        return ConnectedSessionOutcome::Replace(next);
                    }
                    ClientCommand::CancelConnect { attempt_id }
                        if attempt_id == session_attempt_id =>
                    {
                        signal_lease.deactivate();
                        reconcile_interrupted_tasks(
                            &mut tasks,
                            &mut pending,
                            events,
                            &signal_lease,
                            "The connection was cancelled before GSV confirmed the operation.",
                        ).await;
                        return ConnectedSessionOutcome::Cancelled;
                    }
                    ClientCommand::CancelConnect { .. } => {}
                    ClientCommand::Shutdown => {
                        signal_lease.deactivate();
                        discard_tasks(&mut tasks).await;
                        return ConnectedSessionOutcome::Shutdown;
                    }
                    ClientCommand::RefreshHistory => {
                        if history_refresh.request() {
                            spawn_history_task(
                                &mut tasks,
                                &mut pending,
                                &mut next_operation_id,
                                client.clone(),
                                pid.clone(),
                                signal_lease.signal_watermark(),
                            );
                        }
                    }
                    command => spawn_connected_command(
                        &mut tasks,
                        &mut pending,
                        &mut next_operation_id,
                        client.clone(),
                        pid.clone(),
                        command,
                    ),
                }
            }
            result = tasks.join_next(), if !tasks.is_empty() => {
                match result {
                    Some(Ok(completion)) => {
                        let rejected_history = matches!(
                            &completion.outcome,
                            ConnectedTaskOutcome::History(Err(error))
                                if error.kind == RequestFailureKind::Rejected
                        );
                        let disposition = emit_connected_completion(
                            completion,
                            &mut pending,
                            events,
                            &signal_lease,
                            false,
                        );
                        if rejected_history {
                            signal_lease.deactivate();
                            reconcile_interrupted_tasks(
                                &mut tasks,
                                &mut pending,
                                events,
                                &signal_lease,
                                "The selected GSV process disappeared before it confirmed the operation.",
                            ).await;
                            return ConnectedSessionOutcome::Reconnect(
                                "That GSV process is no longer available. I’m opening another conversation."
                                    .to_string(),
                            );
                        }
                        if disposition.completed_history {
                            if disposition.superseded_history {
                                history_refresh.request();
                            }
                            if history_refresh.complete() {
                                spawn_history_task(
                                    &mut tasks,
                                    &mut pending,
                                    &mut next_operation_id,
                                    client.clone(),
                                    pid.clone(),
                                    signal_lease.signal_watermark(),
                                );
                            }
                        }
                    }
                    Some(Err(error)) => {
                        let _ = events.send(ClientEvent::Error(format!(
                            "A native client operation stopped unexpectedly: {error}"
                        )));
                    }
                    None => {}
                }
            }
            _ = connection_check.tick() => {
                if client.connection().is_disconnected() {
                    continue;
                }
            }
            _ = history_poll.tick() => {
                if history_refresh.request() {
                    spawn_history_task(
                        &mut tasks,
                        &mut pending,
                        &mut next_operation_id,
                        client.clone(),
                        pid.clone(),
                        signal_lease.signal_watermark(),
                    );
                }
            }
        }
    }
}

fn handle_unavailable_command(
    command: ClientCommand,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
) -> bool {
    match command {
        ClientCommand::Connect(_) | ClientCommand::CancelConnect { .. } => {}
        ClientCommand::Send { submission_id, .. } => {
            let _ = events.send(ClientEvent::SendFailed {
                submission_id,
                message: "That thought wasn’t sent because GSV is reconnecting.".to_string(),
            });
        }
        ClientCommand::Abort { run_id } => {
            let _ = events.send(ClientEvent::AbortFailed {
                run_id,
                message: "The stop request wasn’t sent because GSV is reconnecting.".to_string(),
            });
        }
        ClientCommand::Decide { request_id, .. } => {
            let _ = events.send(ClientEvent::ApprovalFailed {
                request_id,
                message: "That approval wasn’t sent because GSV is reconnecting. I’ll recover the current request from history."
                    .to_string(),
            });
        }
        ClientCommand::RefreshHistory => {}
        ClientCommand::Shell(command) => {
            let _ = events.send(ClientEvent::ShellResult {
                command,
                output: "GSV is reconnecting; the command was not run.".to_string(),
                exit_code: None,
            });
        }
        ClientCommand::Shutdown => return true,
    }
    false
}

async fn wait_for_connection(
    commands: &mut tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
) -> Option<ConnectionSettings> {
    loop {
        let command = commands.recv().await?;
        match command {
            ClientCommand::Connect(settings) => return Some(settings),
            ClientCommand::Shutdown => return None,
            command => {
                handle_unavailable_command(command, events);
            }
        }
    }
}

async fn wait_to_reconnect(
    attempt: u32,
    active_attempt_id: u64,
    commands: &mut tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
) -> ReconnectWaitOutcome {
    let delay = tokio::time::sleep(reconnect_delay(attempt));
    tokio::pin!(delay);
    loop {
        tokio::select! {
            biased;
            command = commands.recv() => {
                let Some(command) = command else {
                    return ReconnectWaitOutcome::Shutdown;
                };
                match command {
                    ClientCommand::Connect(next) => {
                        return ReconnectWaitOutcome::Replace(next);
                    }
                    ClientCommand::CancelConnect { attempt_id }
                        if attempt_id == active_attempt_id =>
                    {
                        return ReconnectWaitOutcome::Cancelled;
                    }
                    command => {
                        if handle_unavailable_command(command, events) {
                            return ReconnectWaitOutcome::Shutdown;
                        }
                    }
                }
            }
            _ = &mut delay => return ReconnectWaitOutcome::Retry,
        }
    }
}

fn reconnect_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(16);
    let multiplier = 1_u32 << exponent;
    INITIAL_RECONNECT_DELAY
        .saturating_mul(multiplier)
        .min(MAX_RECONNECT_DELAY)
}

fn startup_resolution() -> StartupResolution {
    let config = CliConfig::load();
    resolve_startup(StartupSources {
        url: nonempty_env("GSV_URL").or_else(|| normalize_field(config.gateway.url.clone())),
        username: nonempty_env("GSV_USER").or_else(|| config.gateway_username()),
        explicit_token: nonempty_secret_env("GSV_TOKEN"),
        explicit_password: nonempty_secret_env("GSV_PASSWORD"),
        cached_token: config.gateway_session_token(),
        configured_token: config.gateway_token(),
    })
}

fn gateway_auth(settings: &ConnectionSettings) -> GatewayAuth {
    let (password, token) = match &settings.credential {
        Credential::Password(password) => (Some(password.clone()), None),
        Credential::Token(token) => (None, Some(token.clone())),
    };
    GatewayAuth {
        username: Some(settings.username.clone()),
        password,
        token,
    }
}

fn login_defaults(settings: &ConnectionSettings) -> LoginDefaults {
    LoginDefaults {
        url: Some(settings.url.clone()),
        username: Some(settings.username.clone()),
    }
}

fn remember_connection_identity(settings: &ConnectionSettings) {
    let mut config = CliConfig::load();
    config.gateway.url = Some(settings.url.clone());
    config.gateway.username = Some(settings.username.clone());
    let _ = config.save();
}

fn nonempty_env(key: &str) -> Option<String> {
    normalize_field(env::var(key).ok())
}

fn normalize_field(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn nonempty_secret_env(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
}

async fn choose_process(
    client: &KernelClient,
    preferred_pid: Option<&str>,
) -> Result<String, String> {
    let response = request_ok(client, "proc.list", Some(json!({})))
        .await
        .map_err(|error| format!("GSV processes could not be listed: {error}"))?;
    let configured_pid = nonempty_env("GSV_NATIVE_PID");
    let preferred_pid = configured_pid.as_deref().or(preferred_pid);
    if let Some(pid) = select_existing_process(&response, preferred_pid) {
        return Ok(pid);
    }

    let spawned = request_ok(
        client,
        "proc.spawn",
        Some(json!({ "interactive": true, "label": "Native" })),
    )
    .await
    .map_err(|error| format!("A native GSV process could not be started: {error}"))?;
    let pid = spawned
        .get("pid")
        .and_then(Value::as_str)
        .ok_or_else(|| "GSV started a process without returning its pid.".to_string())?;
    Ok(pid.to_string())
}

fn select_existing_process(response: &Value, preferred_pid: Option<&str>) -> Option<String> {
    let processes = response
        .get("processes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|process| process.get("interactive").and_then(Value::as_bool) == Some(true))
        .collect::<Vec<_>>();

    if let Some(preferred_pid) = preferred_pid {
        if processes
            .iter()
            .any(|process| process.get("pid").and_then(Value::as_str) == Some(preferred_pid))
        {
            return Some(preferred_pid.to_string());
        }
    }

    processes
        .into_iter()
        .filter_map(|process| {
            let pid = process.get("pid")?.as_str()?.to_string();
            let activity = process
                .get("lastActiveAt")
                .and_then(Value::as_i64)
                .or_else(|| process.get("createdAt").and_then(Value::as_i64))
                .unwrap_or_default();
            Some((activity, pid))
        })
        .max_by_key(|(activity, _)| *activity)
        .map(|(_, pid)| pid)
}

async fn fetch_history(client: &KernelClient, pid: &str) -> Result<Value, RequestFailure> {
    request_ok(
        client,
        "proc.history",
        Some(json!({ "pid": pid, "tail": true, "limit": 200 })),
    )
    .await
}

async fn request_ok(
    client: &KernelClient,
    call: &str,
    args: Option<Value>,
) -> Result<Value, RequestFailure> {
    let request = client
        .connection()
        .request_with_timeout(call, args, RPC_TIMEOUT);
    let response = tokio::time::timeout(RPC_ENVELOPE_TIMEOUT, request)
        .await
        .map_err(|_| {
            RequestFailure::transport(format!("{call} timed out after {RPC_ENVELOPE_TIMEOUT:?}"))
        })?
        .map_err(|error| RequestFailure::transport(error.to_string()))?;
    if !response.ok {
        let Some(error) = response.error else {
            return Err(RequestFailure::transport(format!(
                "{call} failed without error details"
            )));
        };
        let kind = classify_response_failure(error.code, error.retryable);
        return Err(RequestFailure {
            kind,
            message: format!("{} failed (code {}): {}", call, error.code, error.message),
        });
    }
    let data = response.data.unwrap_or_else(|| json!({}));
    if data.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(RequestFailure::rejected(
            data.get("error")
                .and_then(Value::as_str)
                .unwrap_or("The gateway rejected the request"),
        ));
    }
    Ok(data)
}

fn classify_response_failure(code: i32, retryable: Option<bool>) -> RequestFailureKind {
    if retryable == Some(true) || code >= 500 {
        RequestFailureKind::Transport
    } else {
        RequestFailureKind::Rejected
    }
}

async fn send_message(
    client: &KernelClient,
    pid: &str,
    message: &str,
) -> Result<ProcSendResult, SendAttemptFailure> {
    let payload = match request_ok(
        client,
        "proc.send",
        Some(json!({ "pid": pid, "message": message })),
    )
    .await
    {
        Ok(payload) => payload,
        Err(error) if error.kind == RequestFailureKind::Rejected => {
            return Err(SendAttemptFailure::Rejected(error.to_string()));
        }
        Err(error) => return Err(SendAttemptFailure::Uncertain(error.to_string())),
    };
    let result: ProcSendResult = serde_json::from_value(payload).map_err(|error| {
        SendAttemptFailure::Uncertain(format!("Invalid proc.send response: {error}"))
    })?;
    if !result.ok {
        return Err(SendAttemptFailure::Rejected(
            result
                .error
                .clone()
                .unwrap_or_else(|| "The gateway rejected the thought".to_string()),
        ));
    }
    Ok(result)
}

async fn execute_shell(
    client: &KernelClient,
    command: String,
) -> Result<ShellResponse, RequestFailure> {
    let result = request_ok(client, "shell.exec", Some(json!({ "input": command }))).await?;
    Ok(ShellResponse {
        output: result
            .get("output")
            .and_then(Value::as_str)
            .or_else(|| result.get("stdout").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string(),
        exit_code: result.get("exitCode").and_then(Value::as_i64),
    })
}

async fn run_demo(
    mut commands: tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: tokio_mpsc::UnboundedSender<ClientEvent>,
) {
    let _ = events.send(ClientEvent::Connected {
        attempt_id: 0,
        session_id: DEMO_SESSION_ID,
        pid: "demo:native".to_string(),
    });
    let generation = Arc::new(AtomicU64::new(0));

    while let Some(command) = commands.recv().await {
        match command {
            ClientCommand::Connect(_) | ClientCommand::CancelConnect { .. } => {}
            ClientCommand::Send {
                submission_id,
                message,
            } => {
                let run = generation.fetch_add(1, Ordering::SeqCst) + 1;
                let run_id = format!("demo-run-{run}");
                let _ = events.send(ClientEvent::SendAccepted {
                    submission_id,
                    run_id: run_id.clone(),
                    queued: false,
                });
                let stream_events = events.clone();
                let stream_generation = generation.clone();
                tokio::spawn(async move {
                    let response = demo_response(&message);
                    for fragment in word_fragments(&response) {
                        tokio::time::sleep(Duration::from_millis(42)).await;
                        if stream_generation.load(Ordering::SeqCst) != run {
                            return;
                        }
                        let _ = stream_events.send(ClientEvent::Signal {
                            session_id: DEMO_SESSION_ID,
                            name: "proc.run.stream".to_string(),
                            payload: json!({
                                "pid": "demo:native",
                                "runId": run_id,
                                "event": { "type": "text_delta", "delta": fragment },
                            }),
                        });
                    }
                    let _ = stream_events.send(ClientEvent::Signal {
                        session_id: DEMO_SESSION_ID,
                        name: "proc.run.finished".to_string(),
                        payload: json!({ "pid": "demo:native", "runId": run_id }),
                    });
                });
            }
            ClientCommand::Abort { run_id } => {
                generation.fetch_add(1, Ordering::SeqCst);
                let _ = events.send(ClientEvent::AbortResolved { run_id });
            }
            ClientCommand::Shell(command) => {
                let output = if command.trim() == "status" {
                    "native interface: awake\ngateway: demo\ndevices: 3 available".to_string()
                } else {
                    format!("Demo console received: {command}")
                };
                let _ = events.send(ClientEvent::ShellResult {
                    command,
                    output,
                    exit_code: Some(0),
                });
            }
            ClientCommand::Decide { request_id, .. } => {
                let _ = events.send(ClientEvent::ApprovalResolved { request_id });
            }
            ClientCommand::RefreshHistory => {}
            ClientCommand::Shutdown => break,
        }
    }
}

fn demo_response(message: &str) -> String {
    if message.to_ascii_lowercase().contains("device") {
        "Your laptop, studio machine, and phone are all reachable. The studio machine is doing the heaviest work, so I would leave it undisturbed for another nine minutes.".to_string()
    } else {
        "I understand. The interesting part is that this can remain a thought, not become a configuration screen. I’ll keep the machinery behind the sentence and bring it forward only when your control is required.".to_string()
    }
}

fn word_fragments(text: &str) -> Vec<String> {
    let mut fragments = Vec::new();
    for (index, word) in text.split_whitespace().enumerate() {
        let prefix = if index == 0 { "" } else { " " };
        fragments.push(format!("{prefix}{word}"));
    }
    fragments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_stream_preserves_word_spacing() {
        assert_eq!(word_fragments("one two three").concat(), "one two three");
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_capped() {
        assert_eq!(reconnect_delay(1), Duration::from_millis(250));
        assert_eq!(reconnect_delay(2), Duration::from_millis(500));
        assert_eq!(reconnect_delay(6), Duration::from_secs(8));
        assert_eq!(reconnect_delay(u32::MAX), Duration::from_secs(8));
    }

    #[test]
    fn reconnect_wait_preserves_cancel_and_replacement_controls() -> Result<(), String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|error| error.to_string())?;
        let (events, _event_rx) = tokio_mpsc::unbounded_channel();

        let (cancel_tx, mut cancel_rx) = tokio_mpsc::unbounded_channel();
        cancel_tx
            .send(ClientCommand::CancelConnect { attempt_id: 7 })
            .map_err(|_| "cancel channel closed".to_string())?;
        assert!(matches!(
            runtime.block_on(wait_to_reconnect(1, 7, &mut cancel_rx, &events)),
            ReconnectWaitOutcome::Cancelled
        ));

        let replacement = ConnectionSettings {
            attempt_id: 8,
            url: "wss://gsv.example/ws".to_string(),
            username: "hank".to_string(),
            credential: Credential::Password("replacement".to_string()),
            remember_identity: true,
        };
        let (replace_tx, mut replace_rx) = tokio_mpsc::unbounded_channel();
        replace_tx
            .send(ClientCommand::Connect(replacement))
            .map_err(|_| "replacement channel closed".to_string())?;
        assert!(matches!(
            runtime.block_on(wait_to_reconnect(1, 7, &mut replace_rx, &events)),
            ReconnectWaitOutcome::Replace(ConnectionSettings { attempt_id: 8, .. })
        ));
        Ok(())
    }

    #[test]
    fn startup_handshake_failures_return_to_the_owned_surface() {
        let unknown_user = classify_connect_failure(
            "wss://gsv.example/ws",
            Box::new(GatewayRpcError::new(
                "sys.connect",
                401,
                "Unknown user",
                None,
            )),
        );
        assert_eq!(
            unknown_user.kind,
            EstablishFailureKind::Authentication(LoginStep::Username)
        );

        let rejected_password = classify_connect_failure(
            "wss://gsv.example/ws",
            Box::new(GatewayRpcError::new(
                "sys.connect",
                401,
                "Invalid credentials",
                None,
            )),
        );
        assert_eq!(
            rejected_password.kind,
            EstablishFailureKind::Authentication(LoginStep::Password)
        );

        let setup = classify_connect_failure(
            "ws://localhost:8787/ws",
            Box::new(GatewayRpcError::new(
                "sys.connect",
                425,
                "Setup required",
                Some(json!({ "setupMode": true })),
            )),
        );
        assert_eq!(setup.kind, EstablishFailureKind::SetupRequired);
    }

    #[test]
    fn reconnect_reuses_a_visible_interactive_process() {
        let processes = json!({
            "processes": [
                {
                    "pid": "older",
                    "interactive": true,
                    "lastActiveAt": 10
                },
                {
                    "pid": "preferred",
                    "interactive": true,
                    "lastActiveAt": 1
                }
            ]
        });

        assert_eq!(
            select_existing_process(&processes, Some("preferred")).as_deref(),
            Some("preferred")
        );
    }

    #[test]
    fn reconnect_reselects_when_the_previous_process_is_gone() {
        let processes = json!({
            "processes": [
                {
                    "pid": "older",
                    "interactive": true,
                    "lastActiveAt": 10
                },
                {
                    "pid": "latest",
                    "interactive": true,
                    "lastActiveAt": 20
                },
                {
                    "pid": "background",
                    "interactive": false,
                    "lastActiveAt": 30
                }
            ]
        });

        assert_eq!(
            select_existing_process(&processes, Some("missing")).as_deref(),
            Some("latest")
        );
    }

    #[test]
    fn redundant_history_refreshes_coalesce_to_one_follow_up() {
        let mut refresh = HistoryRefresh::default();

        assert!(refresh.request());
        assert!(!refresh.request());
        assert!(!refresh.request());
        assert!(refresh.complete());
        assert!(!refresh.complete());
        assert!(refresh.request());
    }

    #[test]
    fn abort_resolution_requires_an_applied_matching_response() {
        assert!(abort_response_applied(&json!({ "aborted": true }), "run-1"));
        assert!(abort_response_applied(
            &json!({ "aborted": true, "runId": "run-1" }),
            "run-1"
        ));
        assert!(!abort_response_applied(
            &json!({ "aborted": false, "runId": "run-1" }),
            "run-1"
        ));
        assert!(!abort_response_applied(
            &json!({ "aborted": true, "runId": "run-2" }),
            "run-1"
        ));
    }

    #[test]
    fn approval_resolution_requires_the_submitted_request() {
        assert!(approval_response_matches(
            &json!({ "requestId": "approval-1" }),
            "approval-1"
        ));
        assert!(!approval_response_matches(
            &json!({ "requestId": "approval-2" }),
            "approval-1"
        ));
        assert!(!approval_response_matches(&json!({}), "approval-1"));
    }

    #[test]
    fn retryable_and_server_failures_make_send_delivery_uncertain() {
        assert_eq!(
            classify_response_failure(503, Some(false)),
            RequestFailureKind::Transport
        );
        assert_eq!(
            classify_response_failure(429, Some(true)),
            RequestFailureKind::Transport
        );
        assert_eq!(
            classify_response_failure(403, Some(false)),
            RequestFailureKind::Rejected
        );
    }

    #[test]
    fn uncertain_send_reports_the_exact_submission_and_text() {
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        let signal_lease = SessionSignalLease::new(1);
        let mut pending = HashMap::from([(
            9,
            PendingOperation::Send {
                submission_id: 42,
                submitted_text: "keep this thought".to_string(),
            },
        )]);

        emit_connected_completion(
            ConnectedTaskCompletion {
                operation_id: 9,
                outcome: ConnectedTaskOutcome::Send(Err(SendAttemptFailure::Uncertain(
                    "timed out".to_string(),
                ))),
            },
            &mut pending,
            &events,
            &signal_lease,
            false,
        );

        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::SendUncertain {
                submission_id: 42,
                ref submitted_text,
                ..
            }) if submitted_text == "keep this thought"
        ));
        assert!(pending.is_empty());
    }

    #[test]
    fn session_handoff_puts_authoritative_history_between_buffered_and_live_signals() {
        let lease = SessionSignalLease::new(77);
        let (events, mut received) = tokio_mpsc::unbounded_channel();

        assert!(!queue_session_signal(
            &lease.state,
            77,
            "proc.run.started".to_string(),
            json!({ "pid": "selected", "runId": "run-1" }),
            &events,
        ));
        assert!(!queue_session_signal(
            &lease.state,
            77,
            "proc.run.stream".to_string(),
            json!({ "pid": "other", "runId": "run-2" }),
            &events,
        ));
        assert!(!lease.select_pid("selected".to_string()));
        assert!(received.try_recv().is_err());

        let request_signal_id = lease.signal_watermark();
        assert!(!lease.handoff_history(request_signal_id, json!({ "activeRunId": null }), &events,));
        assert!(queue_session_signal(
            &lease.state,
            77,
            "proc.run.stream".to_string(),
            json!({ "pid": "selected", "runId": "run-2" }),
            &events,
        ));

        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::Signal {
                session_id: 77,
                ref name,
                ..
            }) if name == "proc.run.started"
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::History { session_id: 77, .. })
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::Signal {
                session_id: 77,
                ref name,
                ..
            }) if name == "proc.run.stream"
        ));
        assert!(received.try_recv().is_err());

        lease.deactivate();
        assert!(!queue_session_signal(
            &lease.state,
            77,
            "proc.run.finished".to_string(),
            json!({ "pid": "selected", "runId": "run-1" }),
            &events,
        ));
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn signal_during_initial_history_fetch_supersedes_the_snapshot() {
        let lease = SessionSignalLease::new(88);
        let (events, mut received) = tokio_mpsc::unbounded_channel();

        assert!(!queue_session_signal(
            &lease.state,
            88,
            "proc.run.started".to_string(),
            json!({ "pid": "selected", "runId": "run-1" }),
            &events,
        ));
        assert!(!lease.select_pid("selected".to_string()));
        let request_signal_id = lease.signal_watermark();
        assert!(queue_session_signal(
            &lease.state,
            88,
            "proc.run.hil.requested".to_string(),
            json!({ "pid": "selected", "runId": "run-1", "requestId": "hil-1" }),
            &events,
        ));

        assert!(lease.handoff_history(
            request_signal_id,
            json!({ "activeRunId": null, "pendingHil": null }),
            &events,
        ));

        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::Signal { ref name, .. }) if name == "proc.run.started"
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::Signal { ref name, .. }) if name == "proc.run.hil.requested"
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::HistorySuperseded {
                session_id: 88,
                request_signal_id: request,
                response_signal_id: response,
            }) if request == request_signal_id && response > request
        ));
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn signal_during_connected_history_fetch_suppresses_only_that_snapshot() {
        let lease = SessionSignalLease::new(89);
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        lease.select_pid("selected".to_string());
        assert!(!lease.handoff_history(0, json!({}), &events));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::History { session_id: 89, .. })
        ));

        let stale_request_signal_id = lease.signal_watermark();
        assert!(queue_session_signal(
            &lease.state,
            89,
            "proc.run.hil.requested".to_string(),
            json!({ "pid": "selected", "runId": "run-1", "requestId": "hil-1" }),
            &events,
        ));
        assert!(lease.emit_history_if_current(
            stale_request_signal_id,
            json!({ "pendingHil": null }),
            &events,
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::Signal { ref name, .. }) if name == "proc.run.hil.requested"
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::HistorySuperseded {
                session_id: 89,
                request_signal_id: request,
                response_signal_id: response,
            }) if request == stale_request_signal_id && response > request
        ));

        let fresh_request_signal_id = lease.signal_watermark();
        assert!(!lease.emit_history_if_current(
            fresh_request_signal_id,
            json!({ "pendingHil": { "requestId": "hil-1" } }),
            &events,
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::History { session_id: 89, .. })
        ));
    }

    #[test]
    fn buffered_selected_process_exit_is_reported_when_the_pid_is_known() {
        let lease = SessionSignalLease::new(91);
        let (events, mut received) = tokio_mpsc::unbounded_channel();

        assert!(!queue_session_signal(
            &lease.state,
            91,
            "process.exit".to_string(),
            json!({ "pid": "selected" }),
            &events,
        ));
        assert!(lease.select_pid("selected".to_string()));
        let request_signal_id = lease.signal_watermark();
        assert!(!lease.handoff_history(request_signal_id, json!({ "activeRunId": null }), &events,));

        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::Signal {
                session_id: 91,
                ref name,
                ..
            }) if name == "process.exit"
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::History { session_id: 91, .. })
        ));
    }

    #[test]
    fn unavailable_send_fails_the_exact_submission_and_shutdown_stops() {
        let (events, mut received) = tokio_mpsc::unbounded_channel();

        assert!(!handle_unavailable_command(
            ClientCommand::Send {
                submission_id: 41,
                message: "hello".to_string(),
            },
            &events,
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::SendFailed {
                submission_id: 41,
                ..
            })
        ));
        assert!(handle_unavailable_command(ClientCommand::Shutdown, &events));
    }
}
