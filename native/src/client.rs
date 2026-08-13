use std::collections::{HashMap, HashSet};
use std::env;
use std::fmt::{self, Display, Formatter};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gsv_client::client::{GatewayAuth, KernelClient, ProcSendResult};
use gsv_client::connection::{ClientIdentity, GatewayRpcError};
use gsv_client::protocol::Frame;
use gsv_client::{BinaryBody, BinaryBodyLimits};
use gsv_config::{CliConfig, ConfigError, ConfigFile};
use gsv_desktop_control::{
    ClientOptions as DesktopClientOptions, DesktopControlClient, DesktopControlEndpoint,
    DesktopControlServer, Error as DesktopControlError, OperationError, ProcessId, RequestContext,
    ServerOptions,
};
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio::sync::{mpsc as tokio_mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use tokio::task::{AbortHandle, JoinSet};

use crate::content::{MediaAttachment, MediaKind};
use crate::desktop_control::{DesktopControlRequest, NativeDesktopControlHandler};
use crate::history::{normalize_history, HistorySnapshot, MAX_FETCHED_HISTORY_MESSAGES};
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
const MEDIA_FETCH_TIMEOUT: Duration = Duration::from_secs(45);
const MEDIA_CLEANUP_RPC_TIMEOUT: Duration = Duration::from_secs(5);
const MEDIA_CLEANUP_ENVELOPE_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_MEDIA_BYTES: usize = 48 * 1024 * 1024;
const MAX_CONCURRENT_MEDIA_TRANSFERS: usize = 2;
const MAX_MEDIA_CLEANUP_ENTRIES: usize = 256;
const MEDIA_CLEANUP_JOURNAL_VERSION: u64 = 1;
const DEMO_SESSION_ID: u64 = 0;

static NEXT_LIVE_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub enum ApprovalDecision {
    Approve { remember: bool },
    Deny,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MediaSource {
    Process { key: String },
    Remote { url: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaFileAction {
    Open,
    Save,
}

#[derive(Clone, Debug)]
pub struct OutgoingAttachment {
    pub media_id: String,
    pub snapshot: PathBuf,
    pub kind: MediaKind,
    pub mime_type: String,
    pub filename: String,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct MediaTransferLease {
    _permit: Arc<OwnedSemaphorePermit>,
}

pub enum ClientCommand {
    Connect(ConnectionSettings),
    CancelConnect {
        attempt_id: u64,
    },
    Send {
        submission_id: u64,
        message: String,
        attachments: Vec<OutgoingAttachment>,
    },
    Abort {
        run_id: String,
    },
    Decide {
        request_id: String,
        decision: ApprovalDecision,
    },
    RefreshHistory,
    LoadMedia {
        request_id: u64,
        source: MediaSource,
    },
    CancelMedia {
        request_id: u64,
    },
    MaterializeMedia {
        source: MediaSource,
        filename: Option<String>,
        mime_type: Option<String>,
        action: MediaFileAction,
    },
    DesktopNew {
        context: RequestContext,
        response: oneshot::Sender<Result<ProcessId, OperationError>>,
    },
    DesktopUse {
        context: RequestContext,
        process_id: ProcessId,
        response: oneshot::Sender<Result<ProcessId, OperationError>>,
    },
    Shell(String),
    Shutdown,
}

/// A background-normalized history response. Generations are monotonic within one live session.
#[derive(Clone, Debug)]
pub struct PreparedHistory {
    pub generation: u64,
    pub snapshot: Arc<HistorySnapshot>,
}

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
        history: PreparedHistory,
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
        media: Vec<MediaAttachment>,
    },
    SendFailed {
        submission_id: u64,
        message: String,
    },
    SendUncertain {
        submission_id: u64,
        submitted_text: String,
        media: Vec<MediaAttachment>,
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
    MediaLoaded {
        request_id: u64,
        bytes: Arc<[u8]>,
        mime_type: Option<String>,
        _lease: MediaTransferLease,
    },
    MediaFailed {
        request_id: u64,
        message: String,
    },
    MediaFileLoaded {
        bytes: Arc<[u8]>,
        mime_type: Option<String>,
        filename: Option<String>,
        action: MediaFileAction,
        _lease: MediaTransferLease,
    },
    MediaFileFailed {
        message: String,
    },
    DesktopControl(DesktopControlRequest),
    DesktopControlSettled,
    Error(String),
}

pub struct ClientHandle {
    pub commands: tokio_mpsc::UnboundedSender<ClientCommand>,
    pub events: tokio_mpsc::UnboundedReceiver<ClientEvent>,
    pub login: Option<LoginDefaults>,
}

pub enum DesktopStartup {
    Started(ClientHandle),
    ActivatedExisting,
    Failed(String),
}

pub fn start_desktop(demo: bool) -> DesktopStartup {
    if demo {
        return DesktopStartup::Started(start(demo));
    }
    let endpoint = match DesktopControlEndpoint::current_user() {
        Ok(endpoint) => endpoint,
        Err(error) => return DesktopStartup::Failed(error.to_string()),
    };
    let (command_tx, command_rx) = tokio_mpsc::unbounded_channel();
    let (event_tx, event_rx) = tokio_mpsc::unbounded_channel();
    let (initial_connection, login) = match startup_resolution() {
        StartupResolution::Connect(settings) => (Some(settings), None),
        StartupResolution::Login(defaults) => (None, Some(defaults)),
    };
    let (binding_tx, binding_rx) = std_mpsc::sync_channel(1);
    let server_endpoint = endpoint.clone();
    if let Err(error) = spawn_client_thread(
        "gsv-native-client",
        command_rx,
        event_tx.clone(),
        move |runtime, commands, events| {
            let server = {
                let _runtime_guard = runtime.enter();
                DesktopControlServer::bind(
                    &server_endpoint,
                    NativeDesktopControlHandler::new(events.clone()),
                    ServerOptions::default(),
                )
            };
            let server = match server {
                Ok(server) => {
                    let _ = binding_tx.send(DesktopServerBinding::Bound);
                    server
                }
                Err(DesktopControlError::AlreadyRunning) => {
                    let _ = binding_tx.send(DesktopServerBinding::AlreadyRunning);
                    return;
                }
                Err(error) => {
                    let _ = binding_tx.send(DesktopServerBinding::Failed(error.to_string()));
                    return;
                }
            };
            runtime.block_on(async move {
                let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
                let server_task = tokio::spawn(server.run_until(async move {
                    let _ = shutdown_rx.await;
                }));
                run_live(commands, events, initial_connection).await;
                let _ = shutdown_tx.send(());
                let _ = server_task.await;
            });
        },
    ) {
        return DesktopStartup::Failed(error);
    }
    match binding_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(DesktopServerBinding::Bound) => DesktopStartup::Started(ClientHandle {
            commands: command_tx,
            events: event_rx,
            login,
        }),
        Ok(DesktopServerBinding::AlreadyRunning) => match activate_existing_desktop(endpoint) {
            Ok(()) => DesktopStartup::ActivatedExisting,
            Err(error) => DesktopStartup::Failed(error),
        },
        Ok(DesktopServerBinding::Failed(error)) => DesktopStartup::Failed(error),
        Err(error) => {
            DesktopStartup::Failed(format!("Desktop control did not finish starting: {error}"))
        }
    }
}

enum DesktopServerBinding {
    Bound,
    AlreadyRunning,
    Failed(String),
}

fn activate_existing_desktop(endpoint: DesktopControlEndpoint) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime
        .block_on(DesktopControlClient::new(endpoint, DesktopClientOptions::default()).activate())
        .map_err(|error| error.to_string())
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

    let _ = spawn_client_thread(
        thread_name,
        command_rx,
        event_tx.clone(),
        move |runtime, command_rx, thread_events| {
            if demo {
                runtime.block_on(run_demo(command_rx, thread_events));
            } else {
                runtime.block_on(run_live(command_rx, thread_events, initial_connection));
            }
        },
    );

    ClientHandle {
        commands: command_tx,
        events: event_rx,
        login,
    }
}

fn spawn_client_thread<F>(
    thread_name: &str,
    command_rx: tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: tokio_mpsc::UnboundedSender<ClientEvent>,
    run: F,
) -> Result<(), String>
where
    F: FnOnce(
            tokio::runtime::Runtime,
            tokio_mpsc::UnboundedReceiver<ClientCommand>,
            tokio_mpsc::UnboundedSender<ClientEvent>,
        ) + Send
        + 'static,
{
    let thread_events = events.clone();
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
            run(runtime, command_rx, thread_events);
        });
    if let Err(error) = spawn_result {
        let _ = events.send(ClientEvent::Error(format!(
            "The native client thread could not start: {error}"
        )));
        return Err(error.to_string());
    }
    Ok(())
}

async fn run_live(
    mut commands: tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: tokio_mpsc::UnboundedSender<ClientEvent>,
    mut connection: Option<ConnectionSettings>,
) {
    let mut preferred_pid = None;
    let mut reconnect_attempt = 0_u32;
    let mut has_connected = false;
    let mut pending_switch: Option<PendingDesktopSwitch> = None;

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
        let require_preferred_pid = pending_switch.is_some();
        let url = settings.url.clone();
        let establishing = establish_live_session(
            &url,
            gateway_auth(&settings),
            reconnect_pid.as_deref(),
            require_preferred_pid,
            events.clone(),
        );
        tokio::pin!(establishing);
        let switch_context = pending_switch
            .as_ref()
            .map(|pending| pending.context.clone());
        let switch_cancelled = async move {
            match switch_context {
                Some(context) => context.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(switch_cancelled);

        let session = loop {
            tokio::select! {
                biased;
                _ = &mut switch_cancelled => {
                    if let Some(pending) = pending_switch.take() {
                        let _ = pending.response.send(Err(OperationError::Conflict));
                        let _ = events.send(ClientEvent::DesktopControlSettled);
                        preferred_pid = pending.previous_pid;
                        connection = Some(settings);
                        continue 'connection;
                    }
                }
                command = commands.recv() => {
                    let Some(command) = command else {
                        settle_pending_switch(
                            &mut pending_switch,
                            &events,
                            OperationError::Unavailable,
                        );
                        return;
                    };
                    match command {
                        ClientCommand::Connect(next) => {
                            settle_pending_switch(
                                &mut pending_switch,
                                &events,
                                OperationError::Conflict,
                            );
                            has_connected = false;
                            preferred_pid = None;
                            reconnect_attempt = 0;
                            connection = Some(next);
                            continue 'connection;
                        }
                        ClientCommand::CancelConnect { attempt_id }
                            if attempt_id == settings.attempt_id =>
                        {
                            settle_pending_switch(
                                &mut pending_switch,
                                &events,
                                OperationError::Conflict,
                            );
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
                if let Some(pending) = pending_switch.take() {
                    let _ = pending
                        .response
                        .send(Err(map_establish_operation_error(&error)));
                    let _ = events.send(ClientEvent::DesktopControlSettled);
                    preferred_pid = pending.previous_pid;
                    connection = Some(settings);
                    continue;
                }
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
                    settle_pending_switch(&mut pending_switch, &events, OperationError::Conflict);
                    has_connected = false;
                    preferred_pid = None;
                    reconnect_attempt = 0;
                    connection = Some(next);
                    continue 'connection;
                }
                Ok(ClientCommand::CancelConnect { attempt_id })
                    if attempt_id == settings.attempt_id =>
                {
                    settle_pending_switch(&mut pending_switch, &events, OperationError::Conflict);
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
                Err(tokio_mpsc::error::TryRecvError::Disconnected) => {
                    settle_pending_switch(
                        &mut pending_switch,
                        &events,
                        OperationError::Unavailable,
                    );
                    return;
                }
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
        if pending_switch
            .as_ref()
            .is_some_and(|pending| pending.context.is_cancelled() || pending.response.is_closed())
        {
            if let Some(pending) = pending_switch.take() {
                let _ = pending.response.send(Err(OperationError::Conflict));
                let _ = events.send(ClientEvent::DesktopControlSettled);
                preferred_pid = pending.previous_pid;
                connection = Some(settings);
                continue;
            }
        }
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
        let initial_history_superseded = matches!(
            signal_lease.handoff_history(history_request_signal_id, history, &events),
            HistoryPublication::Superseded | HistoryPublication::Stale
        );
        if let Some(pending) = pending_switch.take() {
            match ProcessId::new(pid.clone()) {
                Ok(process_id) => {
                    let _ = pending.response.send(Ok(process_id));
                    let _ = events.send(ClientEvent::DesktopControlSettled);
                }
                Err(_) => {
                    let _ = pending.response.send(Err(OperationError::Internal));
                    let _ = events.send(ClientEvent::DesktopControlSettled);
                    preferred_pid = pending.previous_pid;
                    connection = Some(settings);
                    continue;
                }
            }
        }

        match run_connected_session(
            ActiveClientSession {
                client,
                pid,
                process_exit,
                signal_lease,
                attempt_id: settings.attempt_id,
                cleanup_scope: MediaCleanupScope::from_settings(&settings),
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
            ConnectedSessionOutcome::Switch {
                pid: next_pid,
                context,
                response,
            } => {
                pending_switch = Some(PendingDesktopSwitch {
                    context,
                    response,
                    previous_pid: preferred_pid.clone(),
                });
                preferred_pid = Some(next_pid);
                connection = Some(settings);
            }
            ConnectedSessionOutcome::Cancelled => {
                has_connected = false;
                preferred_pid = None;
            }
        }
    }
}

struct PendingDesktopSwitch {
    context: RequestContext,
    response: oneshot::Sender<Result<ProcessId, OperationError>>,
    previous_pid: Option<String>,
}

fn settle_pending_switch(
    pending_switch: &mut Option<PendingDesktopSwitch>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    error: OperationError,
) -> Option<String> {
    let pending = pending_switch.take()?;
    settle_desktop_switch(pending.response, pending.previous_pid, events, error)
}

fn settle_desktop_switch(
    response: oneshot::Sender<Result<ProcessId, OperationError>>,
    previous_pid: Option<String>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    error: OperationError,
) -> Option<String> {
    let _ = response.send(Err(error));
    let _ = events.send(ClientEvent::DesktopControlSettled);
    previous_pid
}

struct LiveSession {
    client: Arc<KernelClient>,
    pid: String,
    history: PreparedHistory,
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
    cleanup_scope: MediaCleanupScope,
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
    latest_history_generation: u64,
    selected_pid: Option<String>,
    buffered: Vec<BufferedSignal>,
}

struct SessionSignalLease {
    session_id: u64,
    state: Arc<Mutex<SignalState>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HistoryPublication {
    Published,
    Superseded,
    Stale,
    Inactive,
}

impl SessionSignalLease {
    fn new(session_id: u64) -> Self {
        Self {
            session_id,
            state: Arc::new(Mutex::new(SignalState {
                active: true,
                released: false,
                last_signal_id: 0,
                latest_history_generation: 0,
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
        history: PreparedHistory,
        events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    ) -> HistoryPublication {
        let Ok(mut state) = self.state.lock() else {
            return HistoryPublication::Inactive;
        };
        if !state.active || state.released {
            return HistoryPublication::Inactive;
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
        } else if history.generation <= state.latest_history_generation {
            state.released = true;
            return HistoryPublication::Stale;
        } else {
            state.latest_history_generation = history.generation;
            let _ = events.send(ClientEvent::History {
                session_id: self.session_id,
                history,
            });
        }
        state.released = true;
        if superseded {
            HistoryPublication::Superseded
        } else {
            HistoryPublication::Published
        }
    }

    fn emit_history_if_current(
        &self,
        request_signal_id: u64,
        history: PreparedHistory,
        events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    ) -> HistoryPublication {
        let Ok(mut state) = self.state.lock() else {
            return HistoryPublication::Inactive;
        };
        if !state.active {
            return HistoryPublication::Inactive;
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
            HistoryPublication::Superseded
        } else if history.generation <= state.latest_history_generation {
            HistoryPublication::Stale
        } else {
            state.latest_history_generation = history.generation;
            let _ = events.send(ClientEvent::History {
                session_id: self.session_id,
                history,
            });
            HistoryPublication::Published
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
    Switch {
        pid: String,
        context: RequestContext,
        response: oneshot::Sender<Result<ProcessId, OperationError>>,
    },
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
    Uncertain {
        message: String,
        media: Vec<MediaAttachment>,
    },
}

#[derive(Debug)]
struct ShellResponse {
    output: String,
    exit_code: Option<i64>,
}

#[derive(Debug)]
struct MediaResponse {
    bytes: Arc<[u8]>,
    mime_type: Option<String>,
}

enum ConnectedTaskOutcome {
    Send(Result<(ProcSendResult, Vec<MediaAttachment>), SendAttemptFailure>),
    Abort(Result<Value, RequestFailure>),
    Approval(Result<Value, RequestFailure>),
    History(Result<PreparedHistory, RequestFailure>),
    Shell(Result<ShellResponse, RequestFailure>),
    Media(Result<(MediaResponse, MediaTransferLease), RequestFailure>),
    MediaFile(Result<(MediaResponse, MediaTransferLease), RequestFailure>),
}

struct ConnectedTaskCompletion {
    operation_id: u64,
    outcome: ConnectedTaskOutcome,
}

enum PendingOperation {
    Send {
        submission_id: u64,
        submitted_text: String,
        progress: Arc<SendProgress>,
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
    Media {
        request_id: u64,
    },
    MediaFile {
        filename: Option<String>,
        mime_type: Option<String>,
        action: MediaFileAction,
    },
}

struct SendProgress {
    send_started: AtomicBool,
    media: Mutex<Vec<MediaAttachment>>,
}

impl Default for SendProgress {
    fn default() -> Self {
        Self::new()
    }
}

impl SendProgress {
    fn new() -> Self {
        Self {
            send_started: AtomicBool::new(false),
            media: Mutex::new(Vec::new()),
        }
    }

    fn stage_media(
        &self,
        journal: &MediaCleanupJournal,
        scope: &MediaCleanupScope,
        pid: &str,
        media: MediaAttachment,
    ) -> Result<(), String> {
        let entry = media_cleanup_entry(scope, pid, &media)
            .ok_or_else(|| "GSV returned an attachment without cleanup ownership".to_string())?;
        self.media
            .lock()
            .map_err(|_| "The attachment cleanup state became unavailable".to_string())?
            .push(media);
        journal.record(std::slice::from_ref(&entry))
    }

    fn begin_send(
        &self,
        journal: &MediaCleanupJournal,
        scope: &MediaCleanupScope,
        pid: &str,
    ) -> Result<(), String> {
        let entries = media_cleanup_entries(scope, pid, &self.media());
        journal.retain_for_send(&entries)?;
        // There is deliberately no await between transitioning the write-ahead entries to
        // durable retention and setting this fence. A process crash in this window retains the
        // exact descriptors; cancellation can observe only cleanup ownership or send ownership.
        self.send_started.store(true, Ordering::Release);
        Ok(())
    }

    fn media(&self) -> Vec<MediaAttachment> {
        self.media
            .lock()
            .map(|media| media.clone())
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MediaCleanupScope {
    gateway_url: String,
    username: String,
}

impl MediaCleanupScope {
    fn from_settings(settings: &ConnectionSettings) -> Self {
        Self {
            gateway_url: settings.url.clone(),
            username: settings.username.clone(),
        }
    }

    fn owns(&self, entry: &MediaCleanupEntry) -> bool {
        self.gateway_url == entry.gateway_url && self.username == entry.username
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MediaCleanupEntry {
    gateway_url: String,
    username: String,
    pid: String,
    key: String,
    cleanup: bool,
}

impl MediaCleanupEntry {
    fn to_value(&self) -> Value {
        json!({
            "gatewayUrl": self.gateway_url,
            "username": self.username,
            "pid": self.pid,
            "key": self.key,
            "cleanup": self.cleanup,
        })
    }

    fn from_value(value: &Value) -> Result<Self, ConfigError> {
        let field = |name| {
            value
                .get(name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or_else(|| invalid_cleanup_journal(format!("missing {name}")))
        };
        Ok(Self {
            gateway_url: field("gatewayUrl")?,
            username: field("username")?,
            pid: field("pid")?,
            key: field("key")?,
            cleanup: value
                .get("cleanup")
                .and_then(Value::as_bool)
                .ok_or_else(|| invalid_cleanup_journal("missing cleanup disposition"))?,
        })
    }

    fn same_object(&self, other: &Self) -> bool {
        self.gateway_url == other.gateway_url
            && self.username == other.username
            && self.pid == other.pid
            && self.key == other.key
    }
}

#[derive(Clone)]
struct MediaCleanupJournal {
    store: ConfigFile<Value>,
}

impl MediaCleanupJournal {
    fn live() -> Self {
        let path = CliConfig::config_path()
            .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
            .unwrap_or_else(gsv_config::gsv_home)
            .join("native-media-cleanup.toml");
        Self::new(path)
    }

    fn new(path: PathBuf) -> Self {
        Self {
            store: ConfigFile::new(path),
        }
    }

    fn record(&self, additions: &[MediaCleanupEntry]) -> Result<(), String> {
        if additions.is_empty() {
            return Ok(());
        }
        self.store
            .update(|document| {
                let mut entries = decode_cleanup_journal(document)?;
                for addition in additions {
                    if !entries.iter().any(|entry| entry.same_object(addition)) {
                        if entries.len() >= MAX_MEDIA_CLEANUP_ENTRIES {
                            return Err(invalid_cleanup_journal(
                                "the cleanup journal reached its safe entry limit",
                            ));
                        }
                        entries.push(addition.clone());
                    }
                }
                *document = encode_cleanup_journal(&entries);
                Ok(())
            })
            .map_err(|error| error.to_string())
    }

    fn remove(&self, removals: &[MediaCleanupEntry]) -> Result<(), String> {
        if removals.is_empty() {
            return Ok(());
        }
        self.store
            .update(|document| {
                let mut entries = decode_cleanup_journal(document)?;
                entries.retain(|entry| !removals.iter().any(|removal| entry.same_object(removal)));
                *document = encode_cleanup_journal(&entries);
                Ok(())
            })
            .map_err(|error| error.to_string())
    }

    fn entries_for(&self, scope: &MediaCleanupScope) -> Result<Vec<MediaCleanupEntry>, String> {
        self.store
            .load()
            .and_then(|document| decode_cleanup_journal(&document))
            .map(|entries| {
                entries
                    .into_iter()
                    .filter(|entry| scope.owns(entry) && entry.cleanup)
                    .collect()
            })
            .map_err(|error| error.to_string())
    }

    fn retain_for_send(&self, retained: &[MediaCleanupEntry]) -> Result<(), String> {
        self.set_cleanup_disposition(retained, false)
    }

    fn arm_for_cleanup(&self, cleanup: &[MediaCleanupEntry]) -> Result<(), String> {
        self.set_cleanup_disposition(cleanup, true)
    }

    fn set_cleanup_disposition(
        &self,
        targets: &[MediaCleanupEntry],
        cleanup: bool,
    ) -> Result<(), String> {
        if targets.is_empty() {
            return Ok(());
        }
        self.store
            .update(|document| {
                let mut entries = decode_cleanup_journal(document)?;
                for target in targets {
                    let entry = entries
                        .iter_mut()
                        .find(|entry| entry.same_object(target))
                        .ok_or_else(|| {
                            invalid_cleanup_journal(
                                "a staged attachment was missing from the cleanup journal",
                            )
                        })?;
                    entry.cleanup = cleanup;
                }
                *document = encode_cleanup_journal(&entries);
                Ok(())
            })
            .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    fn retained_for(&self, scope: &MediaCleanupScope) -> Result<Vec<MediaCleanupEntry>, String> {
        self.store
            .load()
            .and_then(|document| decode_cleanup_journal(&document))
            .map(|entries| {
                entries
                    .into_iter()
                    .filter(|entry| scope.owns(entry) && !entry.cleanup)
                    .collect()
            })
            .map_err(|error| error.to_string())
    }
}

fn invalid_cleanup_journal(message: impl Into<String>) -> ConfigError {
    ConfigError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        message.into(),
    ))
}

fn decode_cleanup_journal(document: &Value) -> Result<Vec<MediaCleanupEntry>, ConfigError> {
    if document.is_null() {
        return Ok(Vec::new());
    }
    if document.get("version").and_then(Value::as_u64) != Some(MEDIA_CLEANUP_JOURNAL_VERSION) {
        return Err(invalid_cleanup_journal(
            "unsupported native media cleanup journal version",
        ));
    }
    let entries = document
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_cleanup_journal("missing cleanup journal entries"))?;
    if entries.len() > MAX_MEDIA_CLEANUP_ENTRIES {
        return Err(invalid_cleanup_journal(
            "the cleanup journal exceeds its safe entry limit",
        ));
    }
    entries.iter().map(MediaCleanupEntry::from_value).collect()
}

fn encode_cleanup_journal(entries: &[MediaCleanupEntry]) -> Value {
    json!({
        "version": MEDIA_CLEANUP_JOURNAL_VERSION,
        "entries": entries.iter().map(MediaCleanupEntry::to_value).collect::<Vec<_>>(),
    })
}

fn media_cleanup_entry(
    scope: &MediaCleanupScope,
    pid: &str,
    media: &MediaAttachment,
) -> Option<MediaCleanupEntry> {
    Some(MediaCleanupEntry {
        gateway_url: scope.gateway_url.clone(),
        username: scope.username.clone(),
        pid: pid.to_string(),
        key: media.key.as_deref()?.to_string(),
        cleanup: true,
    })
}

fn media_cleanup_entries(
    scope: &MediaCleanupScope,
    pid: &str,
    media: &[MediaAttachment],
) -> Vec<MediaCleanupEntry> {
    media
        .iter()
        .filter_map(|media| media_cleanup_entry(scope, pid, media))
        .collect()
}

struct MediaTaskControl {
    operation_id: u64,
    abort_handle: AbortHandle,
}

struct ConnectedCommandContext<'a> {
    tasks: &'a mut JoinSet<ConnectedTaskCompletion>,
    pending: &'a mut HashMap<u64, PendingOperation>,
    media_tasks: &'a mut HashMap<u64, MediaTaskControl>,
    cancelled_task_ids: &'a mut HashSet<tokio::task::Id>,
    next_operation_id: &'a mut u64,
    client: Arc<KernelClient>,
    http_client: reqwest::Client,
    media_slots: Arc<Semaphore>,
    cleanup_journal: Arc<MediaCleanupJournal>,
    cleanup_scope: MediaCleanupScope,
    pid: String,
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

fn reserve_history_generation(next_generation: &mut u64) -> u64 {
    let generation = (*next_generation).max(1);
    *next_generation = generation.wrapping_add(1).max(1);
    generation
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

fn spawn_connected_command(context: ConnectedCommandContext<'_>, command: ClientCommand) {
    let ConnectedCommandContext {
        tasks,
        pending,
        media_tasks,
        cancelled_task_ids,
        next_operation_id,
        client,
        http_client,
        media_slots,
        cleanup_journal,
        cleanup_scope,
        pid,
    } = context;
    match command {
        ClientCommand::Send {
            submission_id,
            message,
            attachments,
        } => {
            let progress = Arc::new(SendProgress::default());
            let operation_id = reserve_operation(
                next_operation_id,
                pending,
                PendingOperation::Send {
                    submission_id,
                    submitted_text: message.clone(),
                    progress: progress.clone(),
                },
            );
            tasks.spawn(async move {
                ConnectedTaskCompletion {
                    operation_id,
                    outcome: ConnectedTaskOutcome::Send(
                        upload_and_send_message(
                            &client,
                            &cleanup_journal,
                            &cleanup_scope,
                            &pid,
                            &message,
                            attachments,
                            progress,
                        )
                        .await,
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
        ClientCommand::LoadMedia { request_id, source } => {
            cancel_media_task(request_id, media_tasks, pending, cancelled_task_ids);
            let operation_id = reserve_operation(
                next_operation_id,
                pending,
                PendingOperation::Media { request_id },
            );
            let abort_handle = tasks.spawn(async move {
                let result = async {
                    let permit = media_slots.acquire_owned().await.map_err(|_| {
                        RequestFailure::transport("The media transfer queue is unavailable.")
                    })?;
                    let media = load_media(&client, &http_client, &pid, source).await?;
                    Ok((
                        media,
                        MediaTransferLease {
                            _permit: Arc::new(permit),
                        },
                    ))
                }
                .await;
                ConnectedTaskCompletion {
                    operation_id,
                    outcome: ConnectedTaskOutcome::Media(result),
                }
            });
            media_tasks.insert(
                request_id,
                MediaTaskControl {
                    operation_id,
                    abort_handle,
                },
            );
        }
        ClientCommand::MaterializeMedia {
            source,
            filename,
            mime_type,
            action,
        } => {
            let operation_id = reserve_operation(
                next_operation_id,
                pending,
                PendingOperation::MediaFile {
                    filename,
                    mime_type,
                    action,
                },
            );
            tasks.spawn(async move {
                let result = async {
                    let permit = media_slots.acquire_owned().await.map_err(|_| {
                        RequestFailure::transport("The media transfer queue is unavailable.")
                    })?;
                    let media = load_media(&client, &http_client, &pid, source).await?;
                    Ok((
                        media,
                        MediaTransferLease {
                            _permit: Arc::new(permit),
                        },
                    ))
                }
                .await;
                ConnectedTaskCompletion {
                    operation_id,
                    outcome: ConnectedTaskOutcome::MediaFile(result),
                }
            });
        }
        ClientCommand::Connect(_)
        | ClientCommand::CancelConnect { .. }
        | ClientCommand::DesktopNew { .. }
        | ClientCommand::DesktopUse { .. }
        | ClientCommand::RefreshHistory
        | ClientCommand::CancelMedia { .. }
        | ClientCommand::Shutdown => {}
    }
}

fn cancel_media_task(
    request_id: u64,
    media_tasks: &mut HashMap<u64, MediaTaskControl>,
    pending: &mut HashMap<u64, PendingOperation>,
    cancelled_task_ids: &mut HashSet<tokio::task::Id>,
) -> bool {
    let Some(control) = media_tasks.remove(&request_id) else {
        return false;
    };
    pending.remove(&control.operation_id);
    cancelled_task_ids.insert(control.abort_handle.id());
    control.abort_handle.abort();
    true
}

fn remove_media_task_by_id(
    task_id: tokio::task::Id,
    media_tasks: &mut HashMap<u64, MediaTaskControl>,
) {
    let request_id = media_tasks.iter().find_map(|(request_id, control)| {
        (control.abort_handle.id() == task_id).then_some(*request_id)
    });
    if let Some(request_id) = request_id {
        media_tasks.remove(&request_id);
    }
}

fn spawn_history_task(
    tasks: &mut JoinSet<ConnectedTaskCompletion>,
    pending: &mut HashMap<u64, PendingOperation>,
    next_operation_id: &mut u64,
    client: Arc<KernelClient>,
    pid: String,
    request_signal_id: u64,
    generation: u64,
) {
    let operation_id = reserve_operation(
        next_operation_id,
        pending,
        PendingOperation::History { request_signal_id },
    );
    tasks.spawn(async move {
        ConnectedTaskCompletion {
            operation_id,
            outcome: ConnectedTaskOutcome::History(fetch_history(&client, &pid, generation).await),
        }
    });
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct CompletionDisposition {
    completed_history: bool,
    refresh_history: bool,
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
            refresh_history: false,
        };
    }

    let mut refresh_history = false;

    match (operation, completion.outcome) {
        (
            PendingOperation::Send {
                submission_id,
                submitted_text,
                ..
            },
            ConnectedTaskOutcome::Send(result),
        ) => match result {
            Ok((result, media)) => {
                let _ = events.send(ClientEvent::SendAccepted {
                    submission_id,
                    run_id: result.run_id,
                    queued: result.queued,
                    media,
                });
            }
            Err(SendAttemptFailure::Rejected(error)) => {
                let _ = events.send(ClientEvent::SendFailed {
                    submission_id,
                    message: format!("GSV couldn’t accept that thought: {error}"),
                });
            }
            Err(SendAttemptFailure::Uncertain {
                message: error,
                media,
            }) => {
                let _ = events.send(ClientEvent::SendUncertain {
                    submission_id,
                    submitted_text,
                    media,
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
                refresh_history = matches!(
                    signal_lease.emit_history_if_current(request_signal_id, history, events),
                    HistoryPublication::Superseded | HistoryPublication::Stale
                );
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
        (PendingOperation::Media { request_id }, ConnectedTaskOutcome::Media(result)) => {
            match result {
                Ok((media, lease)) => {
                    let _ = events.send(ClientEvent::MediaLoaded {
                        request_id,
                        bytes: media.bytes,
                        mime_type: media.mime_type,
                        _lease: lease,
                    });
                }
                Err(error) => {
                    let _ = events.send(ClientEvent::MediaFailed {
                        request_id,
                        message: format!("That media could not be opened: {error}"),
                    });
                }
            }
        }
        (
            PendingOperation::MediaFile {
                filename,
                mime_type,
                action,
            },
            ConnectedTaskOutcome::MediaFile(result),
        ) => match result {
            Ok((media, lease)) => {
                let _ = events.send(ClientEvent::MediaFileLoaded {
                    bytes: media.bytes,
                    mime_type: media.mime_type.or(mime_type),
                    filename,
                    action,
                    _lease: lease,
                });
            }
            Err(error) => {
                let _ = events.send(ClientEvent::MediaFileFailed {
                    message: format!("That media could not be opened: {error}"),
                });
            }
        },
        _ => {
            let _ = events.send(ClientEvent::Error(
                "The native client mismatched an operation result.".to_string(),
            ));
        }
    }
    CompletionDisposition {
        completed_history,
        refresh_history,
    }
}

async fn reconcile_interrupted_tasks(
    tasks: &mut JoinSet<ConnectedTaskCompletion>,
    pending: &mut HashMap<u64, PendingOperation>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
    signal_lease: &SessionSignalLease,
    cleanup: MediaCleanupRuntime<'_>,
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
                progress,
            } => {
                if progress.send_started.load(Ordering::Acquire) {
                    let _ = events.send(ClientEvent::SendUncertain {
                        submission_id,
                        submitted_text,
                        media: progress.media(),
                        message: reason.to_string(),
                    });
                } else {
                    let _ = events.send(ClientEvent::SendFailed {
                        submission_id,
                        message: reason.to_string(),
                    });
                }
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
            PendingOperation::Media { request_id } => {
                let _ = events.send(ClientEvent::MediaFailed {
                    request_id,
                    message: reason.to_string(),
                });
            }
            PendingOperation::MediaFile { .. } => {
                let _ = events.send(ClientEvent::MediaFileFailed {
                    message: reason.to_string(),
                });
            }
            PendingOperation::History { .. } => {}
        }
    }
    if let Err(error) =
        retry_journaled_media_cleanup(cleanup.client, cleanup.journal, cleanup.scope).await
    {
        let _ = events.send(ClientEvent::Error(format!(
            "Attachment cleanup remains queued for retry: {error}"
        )));
    }
}

struct MediaCleanupRuntime<'a> {
    client: &'a KernelClient,
    journal: &'a MediaCleanupJournal,
    scope: &'a MediaCleanupScope,
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
    require_preferred_pid: bool,
    events: tokio_mpsc::UnboundedSender<ClientEvent>,
) -> Result<LiveSession, EstablishFailure> {
    let session_id = next_live_session_id();
    let process_exit = Arc::new(tokio::sync::Notify::new());
    let signal_lease = SessionSignalLease::new(session_id);
    let signal_state = signal_lease.state.clone();
    let signal_process_exit = process_exit.clone();
    let signal_events = events.clone();
    let identity = ClientIdentity::new(
        format!("gsv-desktop-{}", uuid::Uuid::new_v4()),
        env!("CARGO_PKG_VERSION"),
    )
    .with_channel("desktop");
    let connect = KernelClient::connect_user_with_identity(
        url,
        identity,
        auth,
        BinaryBodyLimits::default(),
        move |frame| {
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
        },
    );
    let connected = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| EstablishFailure {
            kind: EstablishFailureKind::Transport,
            message: format!("Connecting to {url} timed out after {CONNECT_TIMEOUT:?}."),
        })?;
    let client = Arc::new(connected.map_err(|error| classify_connect_failure(url, error))?);

    let pid = choose_process(&client, preferred_pid, require_preferred_pid)
        .await
        .map_err(EstablishFailure::session)?;
    if signal_lease.select_pid(pid.clone()) {
        process_exit.notify_one();
    }
    let history_request_signal_id = signal_lease.signal_watermark();
    let history = fetch_history(&client, &pid, 1).await.map_err(|error| {
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

fn map_establish_operation_error(error: &EstablishFailure) -> OperationError {
    match error.kind {
        EstablishFailureKind::Authentication(_) => OperationError::PermissionDenied,
        EstablishFailureKind::SetupRequired | EstablishFailureKind::Transport => {
            OperationError::Unavailable
        }
        EstablishFailureKind::Session => {
            let lower = error.message.to_ascii_lowercase();
            if lower.contains("no longer available") || lower.contains("not found") {
                OperationError::ProcessNotFound
            } else {
                OperationError::Internal
            }
        }
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
        cleanup_scope,
    } = session;
    let mut connection_check = tokio::time::interval(CONNECTION_CHECK_INTERVAL);
    connection_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut history_poll = tokio::time::interval(HISTORY_POLL_INTERVAL);
    history_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    history_poll.tick().await;
    let mut tasks = JoinSet::new();
    let mut pending = HashMap::new();
    let mut media_tasks = HashMap::new();
    let mut cancelled_task_ids = HashSet::new();
    let mut next_operation_id = 1_u64;
    let mut next_history_generation = 2_u64;
    let mut history_refresh = HistoryRefresh::default();
    let http_client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(MEDIA_FETCH_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let media_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_MEDIA_TRANSFERS));
    let cleanup_journal = Arc::new(MediaCleanupJournal::live());
    if let Err(error) =
        retry_journaled_media_cleanup(&client, &cleanup_journal, &cleanup_scope).await
    {
        let _ = events.send(ClientEvent::Error(format!(
            "Attachment cleanup is queued but could not be checked yet: {error}"
        )));
    }
    if initial_history_superseded && history_refresh.request() {
        spawn_history_task(
            &mut tasks,
            &mut pending,
            &mut next_operation_id,
            client.clone(),
            pid.clone(),
            signal_lease.signal_watermark(),
            reserve_history_generation(&mut next_history_generation),
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
                MediaCleanupRuntime {
                    client: &client,
                    journal: &cleanup_journal,
                    scope: &cleanup_scope,
                },
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
                    MediaCleanupRuntime {
                        client: &client,
                        journal: &cleanup_journal,
                        scope: &cleanup_scope,
                    },
                    "That GSV process ended before it confirmed the operation.",
                ).await;
                return ConnectedSessionOutcome::Reconnect(
                    "That GSV process ended. I’m opening another conversation.".to_string(),
                );
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    signal_lease.deactivate();
                    reconcile_interrupted_tasks(
                        &mut tasks,
                        &mut pending,
                        events,
                        &signal_lease,
                        MediaCleanupRuntime {
                            client: &client,
                            journal: &cleanup_journal,
                            scope: &cleanup_scope,
                        },
                        "GSV Desktop closed before it confirmed the operation.",
                    ).await;
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
                            MediaCleanupRuntime {
                                client: &client,
                                journal: &cleanup_journal,
                                scope: &cleanup_scope,
                            },
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
                            MediaCleanupRuntime {
                                client: &client,
                                journal: &cleanup_journal,
                                scope: &cleanup_scope,
                            },
                            "The connection was cancelled before GSV confirmed the operation.",
                        ).await;
                        return ConnectedSessionOutcome::Cancelled;
                    }
                    ClientCommand::CancelConnect { .. } => {}
                    ClientCommand::Shutdown => {
                        signal_lease.deactivate();
                        reconcile_interrupted_tasks(
                            &mut tasks,
                            &mut pending,
                            events,
                            &signal_lease,
                            MediaCleanupRuntime {
                                client: &client,
                                journal: &cleanup_journal,
                                scope: &cleanup_scope,
                            },
                            "GSV Desktop closed before it confirmed the operation.",
                        ).await;
                        return ConnectedSessionOutcome::Shutdown;
                    }
                    ClientCommand::DesktopNew { context, response } => {
                        if context.is_cancelled() {
                            let _ = response.send(Err(OperationError::Conflict));
                            let _ = events.send(ClientEvent::DesktopControlSettled);
                            continue;
                        }
                        if !pending.is_empty() || !media_tasks.is_empty() {
                            let _ = response.send(Err(OperationError::Busy));
                            let _ = events.send(ClientEvent::DesktopControlSettled);
                            continue;
                        }
                        match spawn_desktop_process(&client, &context).await {
                            Ok(next_pid) => {
                                signal_lease.deactivate();
                                discard_tasks(&mut tasks).await;
                                return ConnectedSessionOutcome::Switch {
                                    pid: next_pid,
                                    context,
                                    response,
                                };
                            }
                            Err(error) => {
                                let _ = response.send(Err(error));
                                let _ = events.send(ClientEvent::DesktopControlSettled);
                            }
                        }
                    }
                    ClientCommand::DesktopUse { context, process_id, response } => {
                        if context.is_cancelled() {
                            let _ = response.send(Err(OperationError::Conflict));
                            let _ = events.send(ClientEvent::DesktopControlSettled);
                            continue;
                        }
                        if !pending.is_empty() || !media_tasks.is_empty() {
                            let _ = response.send(Err(OperationError::Busy));
                            let _ = events.send(ClientEvent::DesktopControlSettled);
                            continue;
                        }
                        match validate_desktop_process(&client, &context, &process_id).await {
                            Ok(()) if process_id.as_str() == pid => {
                                let _ = response.send(Ok(process_id));
                                let _ = events.send(ClientEvent::DesktopControlSettled);
                            }
                            Ok(()) => {
                                signal_lease.deactivate();
                                discard_tasks(&mut tasks).await;
                                return ConnectedSessionOutcome::Switch {
                                    pid: process_id.into_inner(),
                                    context,
                                    response,
                                };
                            }
                            Err(error) => {
                                let _ = response.send(Err(error));
                                let _ = events.send(ClientEvent::DesktopControlSettled);
                            }
                        }
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
                                reserve_history_generation(&mut next_history_generation),
                            );
                        }
                    }
                    ClientCommand::CancelMedia { request_id } => {
                        cancel_media_task(
                            request_id,
                            &mut media_tasks,
                            &mut pending,
                            &mut cancelled_task_ids,
                        );
                    }
                    command => spawn_connected_command(
                        ConnectedCommandContext {
                            tasks: &mut tasks,
                            pending: &mut pending,
                            media_tasks: &mut media_tasks,
                            cancelled_task_ids: &mut cancelled_task_ids,
                            next_operation_id: &mut next_operation_id,
                            client: client.clone(),
                            http_client: http_client.clone(),
                            media_slots: media_slots.clone(),
                            cleanup_journal: cleanup_journal.clone(),
                            cleanup_scope: cleanup_scope.clone(),
                            pid: pid.clone(),
                        },
                        command,
                    ),
                }
            }
            result = tasks.join_next_with_id(), if !tasks.is_empty() => {
                match result {
                    Some(Ok((task_id, completion))) => {
                        cancelled_task_ids.remove(&task_id);
                        remove_media_task_by_id(task_id, &mut media_tasks);
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
                                MediaCleanupRuntime {
                                    client: &client,
                                    journal: &cleanup_journal,
                                    scope: &cleanup_scope,
                                },
                                "The selected GSV process disappeared before it confirmed the operation.",
                            ).await;
                            return ConnectedSessionOutcome::Reconnect(
                                "That GSV process is no longer available. I’m opening another conversation."
                                    .to_string(),
                            );
                        }
                        if disposition.completed_history {
                            if disposition.refresh_history {
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
                                    reserve_history_generation(&mut next_history_generation),
                                );
                            }
                        }
                    }
                    Some(Err(error)) => {
                        let task_id = error.id();
                        remove_media_task_by_id(task_id, &mut media_tasks);
                        if !cancelled_task_ids.remove(&task_id) {
                            let _ = events.send(ClientEvent::Error(format!(
                                "A native client operation stopped unexpectedly: {error}"
                            )));
                        }
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
                        reserve_history_generation(&mut next_history_generation),
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
        ClientCommand::DesktopNew { response, .. } | ClientCommand::DesktopUse { response, .. } => {
            let _ = response.send(Err(OperationError::Unavailable));
            let _ = events.send(ClientEvent::DesktopControlSettled);
        }
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
        ClientCommand::LoadMedia { request_id, .. } => {
            let _ = events.send(ClientEvent::MediaFailed {
                request_id,
                message: "That media isn’t available while GSV is reconnecting.".to_string(),
            });
        }
        ClientCommand::MaterializeMedia { .. } => {
            let _ = events.send(ClientEvent::MediaFileFailed {
                message: "That media isn’t available while GSV is reconnecting.".to_string(),
            });
        }
        ClientCommand::CancelMedia { .. } => {}
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
    let _ = CliConfig::update(|config| {
        config.gateway.url = Some(settings.url.clone());
        config.gateway.username = Some(settings.username.clone());
    });
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
    require_preferred_pid: bool,
) -> Result<String, String> {
    let response = request_ok(client, "proc.list", Some(json!({})))
        .await
        .map_err(|error| format!("GSV processes could not be listed: {error}"))?;
    let configured_pid = nonempty_env("GSV_NATIVE_PID");
    let preferred_pid = configured_pid.as_deref().or(preferred_pid);
    if let Some(pid) = select_existing_process(&response, preferred_pid) {
        return Ok(pid);
    }
    if require_preferred_pid {
        return Err("The selected interactive GSV process is no longer available.".to_string());
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

async fn spawn_desktop_process(
    client: &KernelClient,
    context: &RequestContext,
) -> Result<String, OperationError> {
    // The server can time out or its peer can disappear while this request is
    // queued. Check cancellation immediately before the gateway mutation.
    if context.is_cancelled() {
        return Err(OperationError::Conflict);
    }
    let request = request_ok(
        client,
        "proc.spawn",
        Some(json!({ "interactive": true, "label": "Desktop" })),
    );
    let spawned = tokio::select! {
        result = request => result.map_err(map_desktop_request_failure)?,
        () = context.cancelled() => return Err(OperationError::Conflict),
    };
    let pid = spawned
        .get("pid")
        .and_then(Value::as_str)
        .ok_or(OperationError::Internal)?;
    if context.is_cancelled() {
        // proc.spawn may already have committed, but cancellation forbids the
        // later Desktop selection mutation. The durable Process remains owned
        // and inspectable by the user rather than being silently killed.
        return Err(OperationError::Conflict);
    }
    ProcessId::new(pid.to_string()).map_err(|_| OperationError::Internal)?;
    Ok(pid.to_string())
}

async fn validate_desktop_process(
    client: &KernelClient,
    context: &RequestContext,
    process_id: &ProcessId,
) -> Result<(), OperationError> {
    if context.is_cancelled() {
        return Err(OperationError::Conflict);
    }
    let request = request_ok(client, "proc.list", Some(json!({})));
    let listed = tokio::select! {
        result = request => result.map_err(map_desktop_request_failure)?,
        () = context.cancelled() => return Err(OperationError::Conflict),
    };
    if context.is_cancelled() {
        return Err(OperationError::Conflict);
    }
    let found = desktop_process_is_selectable(&listed, process_id.as_str());
    found.then_some(()).ok_or(OperationError::ProcessNotFound)
}

fn desktop_process_is_selectable(response: &Value, process_id: &str) -> bool {
    response
        .get("processes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|process| {
            process.get("pid").and_then(Value::as_str) == Some(process_id)
                && process.get("interactive").and_then(Value::as_bool) == Some(true)
        })
}

fn map_desktop_request_failure(error: RequestFailure) -> OperationError {
    match error.kind {
        RequestFailureKind::Transport => OperationError::Unavailable,
        RequestFailureKind::Rejected => {
            let lower = error.message.to_ascii_lowercase();
            if lower.contains("not found") || lower.contains("does not exist") {
                OperationError::ProcessNotFound
            } else if lower.contains("permission") || lower.contains("forbidden") {
                OperationError::PermissionDenied
            } else {
                OperationError::Internal
            }
        }
    }
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

async fn fetch_history(
    client: &KernelClient,
    pid: &str,
    generation: u64,
) -> Result<PreparedHistory, RequestFailure> {
    let payload = request_ok(
        client,
        "proc.history",
        Some(json!({
            "pid": pid,
            "tail": true,
            "limit": MAX_FETCHED_HISTORY_MESSAGES,
        })),
    )
    .await?;
    let snapshot = tokio::task::spawn_blocking(move || Arc::new(normalize_history(&payload)))
        .await
        .map_err(|error| {
            RequestFailure::transport(format!(
                "The history preparation worker stopped unexpectedly: {error}"
            ))
        })?;
    Ok(PreparedHistory {
        generation,
        snapshot,
    })
}

async fn load_media(
    client: &KernelClient,
    http_client: &reqwest::Client,
    pid: &str,
    source: MediaSource,
) -> Result<MediaResponse, RequestFailure> {
    match source {
        MediaSource::Process { key } => fetch_process_media(client, pid, &key).await,
        MediaSource::Remote { url } => {
            tokio::time::timeout(MEDIA_FETCH_TIMEOUT, fetch_remote_media(http_client, &url))
                .await
                .map_err(|_| RequestFailure::transport("The remote media fetch timed out."))?
        }
    }
}

async fn fetch_process_media(
    client: &KernelClient,
    pid: &str,
    key: &str,
) -> Result<MediaResponse, RequestFailure> {
    if key.trim().is_empty() {
        return Err(RequestFailure::rejected(
            "The process media reference is empty.",
        ));
    }

    let request = client.connection().request_response(
        "proc.media.read",
        Some(json!({ "pid": pid, "key": key })),
        RPC_TIMEOUT,
    );
    let response = tokio::time::timeout(RPC_ENVELOPE_TIMEOUT, request)
        .await
        .map_err(|_| {
            RequestFailure::transport(format!(
                "proc.media.read timed out after {RPC_ENVELOPE_TIMEOUT:?}"
            ))
        })?
        .map_err(|error| RequestFailure::transport(error.to_string()))?;

    let data = response.data;
    if data.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(RequestFailure::rejected(
            data.get("error")
                .and_then(Value::as_str)
                .unwrap_or("The gateway rejected the media read"),
        ));
    }

    let Some(mut body) = response.body else {
        return Err(RequestFailure::transport(
            "GSV returned media metadata without its body.",
        ));
    };
    let Some(declared_size) = data.get("size").and_then(Value::as_u64) else {
        body.cancel("Media size metadata was invalid");
        return Err(RequestFailure::transport(
            "GSV returned media without a valid size.",
        ));
    };
    if declared_size > MAX_MEDIA_BYTES as u64 {
        body.cancel("Media transfer limit exceeded");
        return Err(RequestFailure::rejected(format!(
            "Media exceeds the {MAX_MEDIA_BYTES}-byte transfer limit."
        )));
    }
    if body.length().is_some_and(|length| length != declared_size) {
        body.cancel("Media size metadata did not match");
        return Err(RequestFailure::transport(
            "GSV returned inconsistent media size metadata.",
        ));
    }

    let bytes: Arc<[u8]> = Arc::from(
        body.read_all(MAX_MEDIA_BYTES)
            .await
            .map_err(|error| RequestFailure::transport(error.to_string()))?,
    );
    if bytes.len() as u64 != declared_size {
        return Err(RequestFailure::transport(
            "The media bytes did not match the declared size.",
        ));
    }
    let mime_type = data
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|mime_type| !mime_type.is_empty())
        .map(str::to_string);
    Ok(MediaResponse { bytes, mime_type })
}

async fn fetch_remote_media(
    http_client: &reqwest::Client,
    url: &str,
) -> Result<MediaResponse, RequestFailure> {
    let url = url::Url::parse(url)
        .map_err(|_| RequestFailure::rejected("The remote media URL is invalid."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RequestFailure::rejected(
            "Remote media must use an HTTP or HTTPS URL.",
        ));
    }

    let mut response =
        http_client.get(url).send().await.map_err(|_| {
            RequestFailure::transport("The remote media server could not be reached.")
        })?;
    if !response.status().is_success() {
        return Err(RequestFailure::rejected(format!(
            "The remote media server returned HTTP {}.",
            response.status().as_u16()
        )));
    }

    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_MEDIA_BYTES as u64)
    {
        return Err(RequestFailure::rejected(format!(
            "Media exceeds the {MAX_MEDIA_BYTES}-byte transfer limit."
        )));
    }
    let mime_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RequestFailure::transport("The remote media transfer was interrupted."))?
    {
        let Some(next_length) = bytes.len().checked_add(chunk.len()) else {
            return Err(RequestFailure::rejected(
                "The remote media is too large to open.",
            ));
        };
        if next_length > MAX_MEDIA_BYTES {
            return Err(RequestFailure::rejected(format!(
                "Media exceeds the {MAX_MEDIA_BYTES}-byte transfer limit."
            )));
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(MediaResponse {
        bytes: Arc::from(bytes),
        mime_type,
    })
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
    media: &[MediaAttachment],
) -> Result<ProcSendResult, SendAttemptFailure> {
    let media = media.iter().map(media_to_json).collect::<Vec<_>>();
    let payload = match request_ok(
        client,
        "proc.send",
        Some(json!({ "pid": pid, "message": message, "media": media })),
    )
    .await
    {
        Ok(payload) => payload,
        Err(error) if error.kind == RequestFailureKind::Rejected => {
            return Err(SendAttemptFailure::Rejected(error.to_string()));
        }
        Err(error) => {
            return Err(SendAttemptFailure::Uncertain {
                message: error.to_string(),
                media: Vec::new(),
            });
        }
    };
    let result: ProcSendResult =
        serde_json::from_value(payload).map_err(|error| SendAttemptFailure::Uncertain {
            message: format!("Invalid proc.send response: {error}"),
            media: Vec::new(),
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

async fn upload_and_send_message(
    client: &KernelClient,
    cleanup_journal: &MediaCleanupJournal,
    cleanup_scope: &MediaCleanupScope,
    pid: &str,
    message: &str,
    attachments: Vec<OutgoingAttachment>,
    progress: Arc<SendProgress>,
) -> Result<(ProcSendResult, Vec<MediaAttachment>), SendAttemptFailure> {
    let mut staged = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let media = match upload_attachment(client, pid, &attachment).await {
            Ok(media) => media,
            Err(error) => {
                let _ = retry_journaled_media_cleanup(client, cleanup_journal, cleanup_scope).await;
                return Err(SendAttemptFailure::Rejected(error));
            }
        };
        if let Err(error) = progress.stage_media(cleanup_journal, cleanup_scope, pid, media.clone())
        {
            // The returned media exists but could not be recorded durably. Try the exact
            // descriptor synchronously before returning a definite pre-send failure.
            let cleanup_entry = media_cleanup_entry(cleanup_scope, pid, &media);
            if let Some(entry) = cleanup_entry {
                let _ = delete_staged_media(client, &entry).await;
            }
            let _ = retry_journaled_media_cleanup(client, cleanup_journal, cleanup_scope).await;
            return Err(SendAttemptFailure::Rejected(format!(
                "The attachment could not be staged safely: {error}"
            )));
        }
        staged.push(media);
    }

    if let Err(error) = progress.begin_send(cleanup_journal, cleanup_scope, pid) {
        let _ = retry_journaled_media_cleanup(client, cleanup_journal, cleanup_scope).await;
        return Err(SendAttemptFailure::Rejected(format!(
            "The attachment cleanup state could not be committed: {error}"
        )));
    }
    match send_message(client, pid, message, &staged).await {
        Ok(result) => {
            let entries = media_cleanup_entries(cleanup_scope, pid, &staged);
            let _ = cleanup_journal.remove(&entries);
            Ok((result, staged))
        }
        Err(SendAttemptFailure::Rejected(error)) => {
            // proc.send definitely rejected the request. Re-arm the same descriptors before
            // deletion so a transient cleanup failure remains recoverable across restart.
            let entries = media_cleanup_entries(cleanup_scope, pid, &staged);
            if cleanup_journal.arm_for_cleanup(&entries).is_ok() {
                let _ = retry_journaled_media_cleanup(client, cleanup_journal, cleanup_scope).await;
            }
            Err(SendAttemptFailure::Rejected(error))
        }
        Err(SendAttemptFailure::Uncertain { message, .. }) => {
            Err(SendAttemptFailure::Uncertain {
                message,
                // The gateway may have accepted proc.send. Keep the process-scoped objects and
                // expose their exact descriptors for history reconciliation; deleting here would
                // race an accepted run.
                media: staged,
            })
        }
    }
}

async fn upload_attachment(
    client: &KernelClient,
    pid: &str,
    attachment: &OutgoingAttachment,
) -> Result<MediaAttachment, String> {
    if attachment.size > MAX_MEDIA_BYTES as u64 {
        return Err(format!(
            "{} is larger than the attachment limit",
            attachment.filename
        ));
    }
    let file = tokio::fs::File::open(&attachment.snapshot)
        .await
        .map_err(|_| format!("{} could not be read", attachment.filename))?;
    let body = BinaryBody::from_reader(file, Some(attachment.size));
    let request = client.connection().request_with_body(
        "proc.media.write",
        Some(json!({
            "pid": pid,
            "mediaId": attachment.media_id,
            "type": media_kind_name(attachment.kind),
            "mimeType": attachment.mime_type,
            "filename": attachment.filename,
        })),
        body,
        RPC_ENVELOPE_TIMEOUT,
    );
    let response = request
        .await
        .map_err(|error| format!("{} could not be uploaded: {error}", attachment.filename))?;
    if response.body.is_some() {
        return Err("GSV returned an unexpected body for the media upload".to_string());
    }
    if response.data.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(response
            .data
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("GSV rejected the attachment")
            .to_string());
    }
    let media = response
        .data
        .get("media")
        .ok_or_else(|| "GSV returned no attachment descriptor".to_string())?;
    media_from_json(media)
        .ok_or_else(|| "GSV returned an invalid attachment descriptor".to_string())
}

async fn retry_journaled_media_cleanup(
    client: &KernelClient,
    journal: &MediaCleanupJournal,
    scope: &MediaCleanupScope,
) -> Result<(), String> {
    let entries = journal.entries_for(scope)?;
    let mut removed = Vec::new();
    let mut first_error = None;
    for entry in entries {
        match delete_staged_media(client, &entry).await {
            Ok(()) => removed.push(entry),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    journal.remove(&removed)?;
    first_error.map_or(Ok(()), Err)
}

async fn delete_staged_media(
    client: &KernelClient,
    entry: &MediaCleanupEntry,
) -> Result<(), String> {
    let request = client.connection().request_with_timeout(
        "proc.media.delete",
        Some(json!({ "pid": entry.pid, "key": entry.key })),
        MEDIA_CLEANUP_RPC_TIMEOUT,
    );
    let response = tokio::time::timeout(MEDIA_CLEANUP_ENVELOPE_TIMEOUT, request)
        .await
        .map_err(|_| "proc.media.delete timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if !response.ok {
        return Err(response
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "proc.media.delete failed without error details".to_string()));
    }
    let data = response.data.unwrap_or_else(|| json!({}));
    if data.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(data
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The gateway rejected the media cleanup")
            .to_string());
    }
    Ok(())
}

fn media_kind_name(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "image",
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
        MediaKind::Document => "document",
    }
}

fn media_to_json(media: &MediaAttachment) -> Value {
    json!({
        "type": media_kind_name(media.kind),
        "mimeType": media.mime_type,
        "key": media.key,
        "path": media.path,
        "url": media.url,
        "filename": media.filename,
        "size": media.size,
        "duration": media.duration,
        "transcription": media.transcription,
    })
}

fn media_from_json(value: &Value) -> Option<MediaAttachment> {
    let kind = match value.get("type")?.as_str()? {
        "image" => MediaKind::Image,
        "audio" => MediaKind::Audio,
        "video" => MediaKind::Video,
        "document" => MediaKind::Document,
        _ => return None,
    };
    let mime_type = value.get("mimeType")?.as_str()?.trim();
    let key = value.get("key")?.as_str()?.trim();
    if mime_type.is_empty() || key.is_empty() {
        return None;
    }
    Some(MediaAttachment {
        kind,
        mime_type: mime_type.to_string(),
        key: Some(key.to_string()),
        path: value
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string),
        url: None,
        filename: value
            .get("filename")
            .and_then(Value::as_str)
            .map(str::to_string),
        size: value.get("size").and_then(Value::as_u64),
        duration: value.get("duration").and_then(Value::as_f64),
        transcription: value
            .get("transcription")
            .and_then(Value::as_str)
            .map(str::to_string),
        description: None,
    })
}

#[cfg(test)]
mod outgoing_media_tests {
    use super::*;

    fn cleanup_scope(url: &str, username: &str) -> MediaCleanupScope {
        MediaCleanupScope {
            gateway_url: url.to_string(),
            username: username.to_string(),
        }
    }

    fn cleanup_media(key: &str) -> MediaAttachment {
        MediaAttachment {
            kind: MediaKind::Document,
            mime_type: "application/pdf".to_string(),
            key: Some(key.to_string()),
            path: None,
            url: None,
            filename: Some("report.pdf".to_string()),
            size: Some(42),
            duration: None,
            transcription: None,
            description: None,
        }
    }

    fn cleanup_journal() -> (tempfile::TempDir, MediaCleanupJournal) {
        let directory = tempfile::tempdir().expect("temporary cleanup directory");
        let journal = MediaCleanupJournal::new(directory.path().join("cleanup.toml"));
        (directory, journal)
    }

    #[test]
    fn uploaded_media_descriptors_round_trip_without_private_fields() {
        let value = json!({
            "type": "document",
            "mimeType": "application/pdf",
            "key": "var/media/7/pid/report",
            "path": "/var/media/report",
            "filename": "report.pdf",
            "size": 42
        });
        let media = media_from_json(&value).expect("valid media");
        assert_eq!(media.kind, MediaKind::Document);
        assert_eq!(media.key.as_deref(), Some("var/media/7/pid/report"));
        assert_eq!(media.filename.as_deref(), Some("report.pdf"));
        let wire = media_to_json(&media);
        assert_eq!(wire["type"], "document");
        assert_eq!(wire["key"], "var/media/7/pid/report");
        assert!(wire.get("data").is_none());
    }

    #[test]
    fn malformed_uploaded_media_is_rejected() {
        assert!(media_from_json(&json!({
            "type": "document",
            "mimeType": "application/pdf"
        }))
        .is_none());
        assert!(media_from_json(&json!({
            "type": "unknown",
            "mimeType": "application/pdf",
            "key": "owned"
        }))
        .is_none());
    }

    #[test]
    fn staged_media_remains_journaled_until_send_begins() {
        let (_directory, journal) = cleanup_journal();
        let scope = cleanup_scope("wss://gateway.example/ws", "root");
        let progress = SendProgress::new();

        progress
            .stage_media(
                &journal,
                &scope,
                "proc-7",
                cleanup_media("var/media/root/proc-7/report"),
            )
            .expect("stage media");

        assert!(!progress.send_started.load(Ordering::Acquire));
        let entries = journal.entries_for(&scope).expect("load cleanup entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, "proc-7");
        assert_eq!(entries[0].key, "var/media/root/proc-7/report");
    }

    #[test]
    fn begin_send_disarms_journal_before_setting_uncertainty_fence() {
        let (_directory, journal) = cleanup_journal();
        let scope = cleanup_scope("wss://gateway.example/ws", "root");
        let progress = SendProgress::new();
        progress
            .stage_media(
                &journal,
                &scope,
                "proc-7",
                cleanup_media("var/media/root/proc-7/report"),
            )
            .expect("stage media");

        progress
            .begin_send(&journal, &scope, "proc-7")
            .expect("begin send");

        assert!(progress.send_started.load(Ordering::Acquire));
        assert!(journal
            .entries_for(&scope)
            .expect("load cleanup entries")
            .is_empty());
        let retained = journal
            .retained_for(&scope)
            .expect("load retained descriptors");
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].key, "var/media/root/proc-7/report");
    }

    #[test]
    fn cleanup_journal_isolates_gateway_and_user_scopes() {
        let (_directory, journal) = cleanup_journal();
        let first = cleanup_scope("wss://one.example/ws", "root");
        let second = cleanup_scope("wss://two.example/ws", "root");
        let third = cleanup_scope("wss://one.example/ws", "alice");
        let entries = [
            MediaCleanupEntry {
                gateway_url: first.gateway_url.clone(),
                username: first.username.clone(),
                pid: "proc-1".to_string(),
                key: "var/media/root/proc-1/one".to_string(),
                cleanup: true,
            },
            MediaCleanupEntry {
                gateway_url: second.gateway_url.clone(),
                username: second.username.clone(),
                pid: "proc-2".to_string(),
                key: "var/media/root/proc-2/two".to_string(),
                cleanup: true,
            },
            MediaCleanupEntry {
                gateway_url: third.gateway_url.clone(),
                username: third.username.clone(),
                pid: "proc-3".to_string(),
                key: "var/media/alice/proc-3/three".to_string(),
                cleanup: true,
            },
        ];
        journal.record(&entries).expect("record entries");

        assert_eq!(
            journal.entries_for(&first).expect("first scope"),
            vec![entries[0].clone()]
        );
        assert_eq!(
            journal.entries_for(&second).expect("second scope"),
            vec![entries[1].clone()]
        );
        assert_eq!(
            journal.entries_for(&third).expect("third scope"),
            vec![entries[2].clone()]
        );
    }

    #[test]
    fn cleanup_entry_is_retained_until_a_delete_is_confirmed() {
        let (_directory, journal) = cleanup_journal();
        let scope = cleanup_scope("wss://gateway.example/ws", "root");
        let entry = MediaCleanupEntry {
            gateway_url: scope.gateway_url.clone(),
            username: scope.username.clone(),
            pid: "proc-7".to_string(),
            key: "var/media/root/proc-7/report".to_string(),
            cleanup: true,
        };
        journal
            .record(std::slice::from_ref(&entry))
            .expect("record cleanup");

        // A failed delete performs no journal mutation. The later successful attempt removes the
        // exact entry, which is the retry contract used by retry_journaled_media_cleanup.
        assert_eq!(
            journal.entries_for(&scope).expect("pending cleanup"),
            vec![entry.clone()]
        );
        journal
            .remove(std::slice::from_ref(&entry))
            .expect("confirm cleanup");
        assert!(journal.entries_for(&scope).expect("cleaned up").is_empty());
    }

    #[test]
    fn replacing_connection_settles_pending_desktop_switch_once() {
        let (response_tx, mut response_rx) = oneshot::channel();
        let (events, mut received_events) = tokio_mpsc::unbounded_channel();
        assert_eq!(
            settle_desktop_switch(
                response_tx,
                Some("previous".to_string()),
                &events,
                OperationError::Conflict,
            )
            .as_deref(),
            Some("previous")
        );
        assert_eq!(
            response_rx.try_recv().expect("desktop response"),
            Err(OperationError::Conflict)
        );
        assert!(matches!(
            received_events.try_recv(),
            Ok(ClientEvent::DesktopControlSettled)
        ));
        assert!(received_events.try_recv().is_err());
    }
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
    let http_client = reqwest::Client::new();
    let media_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_MEDIA_TRANSFERS));
    let mut media_tasks = JoinSet::new();
    let mut media_controls: HashMap<u64, AbortHandle> = HashMap::new();
    let mut cancelled_task_ids = HashSet::new();

    loop {
        tokio::select! {
            biased;
            command = commands.recv() => {
                let Some(command) = command else {
                    media_tasks.abort_all();
                    return;
                };
                match command {
            ClientCommand::Connect(_) | ClientCommand::CancelConnect { .. } => {}
            ClientCommand::Send {
                submission_id,
                message,
                ..
            } => {
                let run = generation.fetch_add(1, Ordering::SeqCst) + 1;
                let run_id = format!("demo-run-{run}");
                let _ = events.send(ClientEvent::SendAccepted {
                    submission_id,
                    run_id: run_id.clone(),
                    queued: false,
                    media: Vec::new(),
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
            ClientCommand::LoadMedia { request_id, source } => {
                if let Some(control) = media_controls.remove(&request_id) {
                    cancelled_task_ids.insert(control.id());
                    control.abort();
                }
                let media_http_client = http_client.clone();
                let media_slots = media_slots.clone();
                let control = media_tasks.spawn(async move {
                    let result = load_demo_media(&media_http_client, media_slots, source).await;
                    (request_id, result)
                });
                media_controls.insert(request_id, control);
            }
            ClientCommand::CancelMedia { request_id } => {
                if let Some(control) = media_controls.remove(&request_id) {
                    cancelled_task_ids.insert(control.id());
                    control.abort();
                }
            }
            ClientCommand::MaterializeMedia { .. } => {
                let _ = events.send(ClientEvent::MediaFileFailed {
                    message: "Demo media cannot be opened outside the app.".to_string(),
                });
            }
            ClientCommand::DesktopNew { response, .. }
            | ClientCommand::DesktopUse { response, .. } => {
                let _ = response.send(Err(OperationError::Unavailable));
                let _ = events.send(ClientEvent::DesktopControlSettled);
            }
            ClientCommand::Shutdown => {
                media_tasks.abort_all();
                return;
            }
                }
            }
            result = media_tasks.join_next_with_id(), if !media_tasks.is_empty() => {
                match result {
                    Some(Ok((task_id, (request_id, result)))) => {
                        cancelled_task_ids.remove(&task_id);
                        if media_controls
                            .get(&request_id)
                            .is_some_and(|control| control.id() == task_id)
                        {
                            media_controls.remove(&request_id);
                            emit_media_result(request_id, result, &events);
                        }
                    }
                    Some(Err(error)) => {
                        let task_id = error.id();
                        let request_id = media_controls.iter().find_map(|(request_id, control)| {
                            (control.id() == task_id).then_some(*request_id)
                        });
                        if let Some(request_id) = request_id {
                            media_controls.remove(&request_id);
                        }
                        if !cancelled_task_ids.remove(&task_id) {
                            let _ = events.send(ClientEvent::Error(format!(
                                "A demo media operation stopped unexpectedly: {error}"
                            )));
                        }
                    }
                    None => {}
                }
            }
        }
    }
}

async fn load_demo_media(
    http_client: &reqwest::Client,
    media_slots: Arc<Semaphore>,
    source: MediaSource,
) -> Result<(MediaResponse, MediaTransferLease), RequestFailure> {
    let permit = media_slots
        .acquire_owned()
        .await
        .map_err(|_| RequestFailure::transport("The media transfer queue is unavailable."))?;
    let media = match source {
        MediaSource::Remote { url } => {
            tokio::time::timeout(MEDIA_FETCH_TIMEOUT, fetch_remote_media(http_client, &url))
                .await
                .map_err(|_| RequestFailure::transport("The remote media fetch timed out."))??
        }
        MediaSource::Process { .. } => {
            return Err(RequestFailure::rejected(
                "Process media is not available in the demo session.",
            ));
        }
    };
    Ok((
        media,
        MediaTransferLease {
            _permit: Arc::new(permit),
        },
    ))
}

fn emit_media_result(
    request_id: u64,
    result: Result<(MediaResponse, MediaTransferLease), RequestFailure>,
    events: &tokio_mpsc::UnboundedSender<ClientEvent>,
) {
    match result {
        Ok((media, lease)) => {
            let _ = events.send(ClientEvent::MediaLoaded {
                request_id,
                bytes: media.bytes,
                mime_type: media.mime_type,
                _lease: lease,
            });
        }
        Err(error) => {
            let _ = events.send(ClientEvent::MediaFailed {
                request_id,
                message: format!("That media could not be opened: {error}"),
            });
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

    fn prepared_history(generation: u64, payload: Value) -> PreparedHistory {
        PreparedHistory {
            generation,
            snapshot: Arc::new(normalize_history(&payload)),
        }
    }

    #[test]
    fn loaded_media_holds_its_transfer_slot_until_the_event_is_consumed() -> Result<(), String> {
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots
            .clone()
            .try_acquire_owned()
            .map_err(|error| error.to_string())?;
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        emit_media_result(
            7,
            Ok((
                MediaResponse {
                    bytes: Arc::from(&b"image"[..]),
                    mime_type: Some("image/png".to_string()),
                },
                MediaTransferLease {
                    _permit: Arc::new(permit),
                },
            )),
            &events,
        );

        assert_eq!(slots.available_permits(), 0);
        let event = received
            .try_recv()
            .map_err(|error| format!("media event was not delivered: {error}"))?;
        drop(event);
        assert_eq!(slots.available_permits(), 1);
        Ok(())
    }

    #[test]
    fn remote_media_rejects_non_http_sources_before_fetching() -> Result<(), String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        let result = runtime.block_on(fetch_remote_media(
            &reqwest::Client::new(),
            "file:///tmp/private.png",
        ));
        let Err(error) = result else {
            return Err("file media should be rejected".to_string());
        };
        assert_eq!(error.kind, RequestFailureKind::Rejected);
        Ok(())
    }

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
    fn desktop_use_accepts_only_the_exact_interactive_process() {
        let processes = json!({
            "processes": [
                { "pid": "interactive", "interactive": true },
                { "pid": "background", "interactive": false }
            ]
        });

        assert!(desktop_process_is_selectable(&processes, "interactive"));
        assert!(!desktop_process_is_selectable(&processes, "background"));
        assert!(!desktop_process_is_selectable(&processes, "missing"));
    }

    #[test]
    fn desktop_switch_failure_mapping_does_not_expose_gateway_details() {
        let missing = EstablishFailure::session(
            "The selected interactive GSV process is no longer available: private detail",
        );
        assert_eq!(
            map_establish_operation_error(&missing),
            OperationError::ProcessNotFound
        );
        let transport = EstablishFailure {
            kind: EstablishFailureKind::Transport,
            message: "credential=do-not-leak".to_string(),
        };
        assert_eq!(
            map_establish_operation_error(&transport),
            OperationError::Unavailable
        );
    }

    #[test]
    fn stale_old_session_signal_cannot_cross_the_switch_fence() {
        let old = SessionSignalLease::new(100);
        let new = SessionSignalLease::new(101);
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        old.select_pid("old-pid".to_string());
        new.select_pid("new-pid".to_string());
        old.handoff_history(0, prepared_history(1, json!({})), &events);
        new.handoff_history(0, prepared_history(1, json!({})), &events);
        while received.try_recv().is_ok() {}

        old.deactivate();
        assert!(!queue_session_signal(
            &old.state,
            100,
            "proc.run.output".to_string(),
            json!({ "pid": "old-pid", "text": "stale" }),
            &events,
        ));
        assert!(!queue_session_signal(
            &new.state,
            101,
            "proc.run.output".to_string(),
            json!({ "pid": "old-pid", "text": "wrong process" }),
            &events,
        ));
        assert!(received.try_recv().is_err());
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
                progress: Arc::new(SendProgress::default()),
            },
        )]);

        emit_connected_completion(
            ConnectedTaskCompletion {
                operation_id: 9,
                outcome: ConnectedTaskOutcome::Send(Err(SendAttemptFailure::Uncertain {
                    message: "timed out".to_string(),
                    media: Vec::new(),
                })),
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
        assert_eq!(
            lease.handoff_history(
                request_signal_id,
                prepared_history(1, json!({ "activeRunId": null })),
                &events,
            ),
            HistoryPublication::Published
        );
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

        assert_eq!(
            lease.handoff_history(
                request_signal_id,
                prepared_history(1, json!({ "activeRunId": null, "pendingHil": null })),
                &events,
            ),
            HistoryPublication::Superseded
        );

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
        assert_eq!(
            lease.handoff_history(0, prepared_history(1, json!({})), &events),
            HistoryPublication::Published
        );
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
        assert_eq!(
            lease.emit_history_if_current(
                stale_request_signal_id,
                prepared_history(2, json!({ "pendingHil": null })),
                &events,
            ),
            HistoryPublication::Superseded
        );
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
        assert_eq!(
            lease.emit_history_if_current(
                fresh_request_signal_id,
                prepared_history(3, json!({ "pendingHil": { "requestId": "hil-1" } })),
                &events,
            ),
            HistoryPublication::Published
        );
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::History { session_id: 89, .. })
        ));
    }

    #[test]
    fn older_history_generation_cannot_replace_a_published_snapshot() {
        let lease = SessionSignalLease::new(90);
        let (events, mut received) = tokio_mpsc::unbounded_channel();
        lease.select_pid("selected".to_string());
        assert_eq!(
            lease.handoff_history(
                0,
                prepared_history(4, json!({ "messageCount": 4 })),
                &events
            ),
            HistoryPublication::Published
        );
        assert!(matches!(
            received.try_recv(),
            Ok(ClientEvent::History {
                session_id: 90,
                history: PreparedHistory { generation: 4, .. },
            })
        ));

        assert_eq!(
            lease.emit_history_if_current(
                0,
                prepared_history(6, json!({ "messageCount": 6 })),
                &events,
            ),
            HistoryPublication::Published
        );
        assert!(received.try_recv().is_ok());
        assert_eq!(
            lease.emit_history_if_current(
                0,
                prepared_history(5, json!({ "messageCount": 5 })),
                &events,
            ),
            HistoryPublication::Stale
        );
        assert!(received.try_recv().is_err());
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
        assert_eq!(
            lease.handoff_history(
                request_signal_id,
                prepared_history(1, json!({ "activeRunId": null })),
                &events,
            ),
            HistoryPublication::Published
        );

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
                attachments: Vec::new(),
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
