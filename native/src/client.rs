use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gsv::config::CliConfig;
use gsv::connection::GatewayRpcError;
use gsv::kernel_client::{GatewayAuth, KernelClient, ProcSendResult};
use gsv::protocol::{
    build_binary_frame, parse_binary_frame, Frame, FrameBodyDescriptor, BINARY_FRAME_CANCEL,
    BINARY_FRAME_DATA, BINARY_FRAME_END, BINARY_FRAME_ERROR,
};
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio::sync::{mpsc as tokio_mpsc, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::{AbortHandle, JoinSet};

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
const MEDIA_BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MEDIA_BYTES: usize = 48 * 1024 * 1024;
const MAX_BUFFERED_MEDIA_BYTES: usize = 64 * 1024 * 1024;
const MAX_BUFFERED_MEDIA_FRAMES: usize = 2048;
const MAX_CANCELLED_MEDIA_STREAMS: usize = 256;
const MAX_FAILED_MEDIA_STREAMS: usize = 256;
const MAX_CONCURRENT_MEDIA_TRANSFERS: usize = 2;
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

#[derive(Clone, Debug)]
pub struct MediaTransferLease {
    _permit: Arc<OwnedSemaphorePermit>,
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
    LoadMedia {
        request_id: u64,
        source: MediaSource,
    },
    CancelMedia {
        request_id: u64,
    },
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
            media_bodies,
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
                media_bodies,
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
    media_bodies: ResponseBodyInbox,
    pid: String,
    history: Value,
    history_request_signal_id: u64,
    process_exit: Arc<tokio::sync::Notify>,
    signal_lease: SessionSignalLease,
    session_id: u64,
}

struct ActiveClientSession {
    client: Arc<KernelClient>,
    media_bodies: ResponseBodyInbox,
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

#[derive(Debug)]
struct MediaResponse {
    bytes: Arc<[u8]>,
    mime_type: Option<String>,
}

#[derive(Clone)]
struct ResponseBodyInbox {
    state: Arc<Mutex<ResponseBodyState>>,
    notify: Arc<Notify>,
    send_frame: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
}

#[derive(Default)]
struct ResponseBodyState {
    frames: HashMap<u32, VecDeque<QueuedBodyFrame>>,
    registered: HashSet<u32>,
    terminal: HashSet<u32>,
    failures: HashMap<u32, String>,
    cancelled: CancelledBodyStreams,
    buffered_bytes: usize,
    buffered_frames: usize,
}

#[derive(Default)]
struct CancelledBodyStreams {
    stream_ids: HashSet<u32>,
    insertion_order: VecDeque<u32>,
}

impl CancelledBodyStreams {
    fn insert(&mut self, stream_id: u32) {
        if stream_id == 0 || !self.stream_ids.insert(stream_id) {
            return;
        }
        while self.insertion_order.len() >= MAX_CANCELLED_MEDIA_STREAMS {
            if let Some(evicted) = self.insertion_order.pop_front() {
                self.stream_ids.remove(&evicted);
            }
        }
        self.insertion_order.push_back(stream_id);
    }

    fn accept_reused(&mut self, stream_id: u32) {
        self.stream_ids.remove(&stream_id);
        self.insertion_order.retain(|queued| *queued != stream_id);
    }

    fn should_discard(&mut self, stream_id: u32, flags: u8) -> bool {
        let should_discard = self.stream_ids.contains(&stream_id);
        if should_discard && flags & BINARY_FRAME_END != 0 {
            self.stream_ids.remove(&stream_id);
            self.insertion_order.retain(|queued| *queued != stream_id);
        }
        should_discard
    }
}

#[derive(Debug)]
struct QueuedBodyFrame {
    flags: u8,
    payload: Vec<u8>,
}

enum BodyItem {
    Frame(QueuedBodyFrame),
    Failure(String),
}

impl ResponseBodyInbox {
    fn new(send_frame: impl Fn(Vec<u8>) + Send + Sync + 'static) -> Self {
        Self {
            state: Arc::new(Mutex::new(ResponseBodyState::default())),
            notify: Arc::new(Notify::new()),
            send_frame: Arc::new(send_frame),
        }
    }

    fn push(&self, data: Vec<u8>) {
        let Some((stream_id, flags, payload)) = parse_binary_frame(&data) else {
            return;
        };

        let mut cancel = false;
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if flags & BINARY_FRAME_CANCEL != 0 {
            return;
        }
        if state.cancelled.should_discard(stream_id, flags) {
            return;
        }
        if state.terminal.contains(&stream_id) || state.failures.contains_key(&stream_id) {
            return;
        }

        let stream_bytes = state
            .frames
            .get(&stream_id)
            .map(|frames| {
                frames
                    .iter()
                    .map(|frame| frame.payload.len())
                    .sum::<usize>()
            })
            .unwrap_or_default();
        let exceeds_limit = stream_bytes.saturating_add(payload.len()) > MAX_MEDIA_BYTES
            || state.buffered_bytes.saturating_add(payload.len()) > MAX_BUFFERED_MEDIA_BYTES
            || state.buffered_frames >= MAX_BUFFERED_MEDIA_FRAMES;
        if exceeds_limit {
            remove_body_frames(&mut state, stream_id);
            record_body_failure(
                &mut state,
                stream_id,
                format!("Media exceeds the {MAX_MEDIA_BYTES}-byte transfer limit."),
            );
            cancel = true;
        } else {
            state.buffered_bytes += payload.len();
            state.buffered_frames += 1;
            state
                .frames
                .entry(stream_id)
                .or_default()
                .push_back(QueuedBodyFrame { flags, payload });
            if flags & BINARY_FRAME_END != 0 {
                state.terminal.insert(stream_id);
            }
        }
        drop(state);

        if cancel {
            self.send_cancel(stream_id, "Media transfer limit exceeded");
        }
        self.notify.notify_waiters();
    }

    fn register(&self, body: FrameBodyDescriptor) -> Result<(), RequestFailure> {
        if body.stream_id == 0 {
            return Err(RequestFailure::transport(
                "The gateway returned an invalid media body stream.",
            ));
        }
        let Ok(mut state) = self.state.lock() else {
            return Err(RequestFailure::transport(
                "The media body receiver is unavailable.",
            ));
        };
        if !state.failures.contains_key(&body.stream_id) {
            state.cancelled.accept_reused(body.stream_id);
        }
        state.registered.insert(body.stream_id);
        Ok(())
    }

    async fn read_body(&self, body: FrameBodyDescriptor) -> Result<Arc<[u8]>, RequestFailure> {
        self.register(body)?;
        let mut guard = IncomingBodyGuard::new(self.clone(), body.stream_id);
        if body
            .length
            .is_some_and(|length| length > MAX_MEDIA_BYTES as u64)
        {
            return Err(RequestFailure::rejected(format!(
                "Media exceeds the {MAX_MEDIA_BYTES}-byte transfer limit."
            )));
        }

        let expected_length = body.length;
        let capacity = expected_length
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or_default();
        let mut bytes = Vec::with_capacity(capacity);
        loop {
            let frame = match self.take(body.stream_id).await? {
                BodyItem::Frame(frame) => frame,
                BodyItem::Failure(message) => {
                    guard.complete();
                    self.finish_cancelled(body.stream_id);
                    return Err(RequestFailure::rejected(message));
                }
            };
            if frame.flags & BINARY_FRAME_ERROR != 0 {
                guard.complete();
                self.finish(body.stream_id);
                return Err(RequestFailure::transport(
                    String::from_utf8(frame.payload)
                        .unwrap_or_else(|_| "The gateway media transfer failed.".to_string()),
                ));
            }
            if frame.flags & BINARY_FRAME_DATA != 0 {
                let Some(next_length) = bytes.len().checked_add(frame.payload.len()) else {
                    return Err(RequestFailure::rejected(
                        "The media body is too large to open.".to_string(),
                    ));
                };
                if next_length > MAX_MEDIA_BYTES {
                    return Err(RequestFailure::rejected(format!(
                        "Media exceeds the {MAX_MEDIA_BYTES}-byte transfer limit."
                    )));
                }
                if expected_length.is_some_and(|length| next_length as u64 > length) {
                    return Err(RequestFailure::transport(
                        "The media body exceeded its declared length.".to_string(),
                    ));
                }
                bytes.extend_from_slice(&frame.payload);
            }
            if frame.flags & BINARY_FRAME_END != 0 {
                break;
            }
        }

        if expected_length.is_some_and(|length| bytes.len() as u64 != length) {
            guard.complete();
            self.finish(body.stream_id);
            return Err(RequestFailure::transport(
                "The media body did not match its declared length.".to_string(),
            ));
        }
        guard.complete();
        self.finish(body.stream_id);
        Ok(Arc::from(bytes))
    }

    async fn take(&self, stream_id: u32) -> Result<BodyItem, RequestFailure> {
        let deadline = tokio::time::Instant::now() + MEDIA_BODY_IDLE_TIMEOUT;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if let Some(item) = self.pop(stream_id) {
                return Ok(item);
            }

            tokio::time::timeout_at(deadline, notified.as_mut())
                .await
                .map_err(|_| {
                    RequestFailure::transport("The media body transfer timed out.".to_string())
                })?;
        }
    }

    fn pop(&self, stream_id: u32) -> Option<BodyItem> {
        let Ok(mut state) = self.state.lock() else {
            return Some(BodyItem::Failure(
                "The media body receiver is unavailable.".to_string(),
            ));
        };
        if let Some(message) = state.failures.remove(&stream_id) {
            return Some(BodyItem::Failure(message));
        }
        let queue = state.frames.get_mut(&stream_id)?;
        let frame = queue.pop_front()?;
        if queue.is_empty() {
            state.frames.remove(&stream_id);
        }
        state.buffered_bytes = state.buffered_bytes.saturating_sub(frame.payload.len());
        state.buffered_frames = state.buffered_frames.saturating_sub(1);
        Some(BodyItem::Frame(frame))
    }

    fn finish(&self, stream_id: u32) {
        if let Ok(mut state) = self.state.lock() {
            remove_body_frames(&mut state, stream_id);
            state.registered.remove(&stream_id);
            state.terminal.remove(&stream_id);
            state.failures.remove(&stream_id);
        }
    }

    fn finish_cancelled(&self, stream_id: u32) {
        if let Ok(mut state) = self.state.lock() {
            remove_body_frames(&mut state, stream_id);
            state.registered.remove(&stream_id);
            state.terminal.remove(&stream_id);
            state.failures.remove(&stream_id);
            state.cancelled.insert(stream_id);
        }
    }

    fn cancel(&self, stream_id: u32, reason: &str) {
        let accepted = if let Ok(mut state) = self.state.lock() {
            let had_frames = remove_body_frames(&mut state, stream_id);
            let registered = state.registered.remove(&stream_id);
            let terminal = state.terminal.remove(&stream_id);
            let failed = state.failures.remove(&stream_id).is_some();
            state.cancelled.insert(stream_id);
            had_frames || registered || terminal || failed
        } else {
            false
        };
        if accepted {
            self.send_cancel(stream_id, reason);
        }
    }

    fn send_cancel(&self, stream_id: u32, reason: &str) {
        if stream_id == 0 {
            return;
        }
        (self.send_frame)(build_binary_frame(
            stream_id,
            BINARY_FRAME_CANCEL | BINARY_FRAME_END,
            reason.as_bytes(),
        ));
    }
}

fn remove_body_frames(state: &mut ResponseBodyState, stream_id: u32) -> bool {
    let Some(frames) = state.frames.remove(&stream_id) else {
        return false;
    };
    state.buffered_bytes = state
        .buffered_bytes
        .saturating_sub(frames.iter().map(|frame| frame.payload.len()).sum());
    state.buffered_frames = state.buffered_frames.saturating_sub(frames.len());
    true
}

fn record_body_failure(state: &mut ResponseBodyState, stream_id: u32, message: String) {
    if !state.failures.contains_key(&stream_id) && state.failures.len() >= MAX_FAILED_MEDIA_STREAMS
    {
        if let Some(evicted) = state.failures.keys().next().copied() {
            state.failures.remove(&evicted);
            state.terminal.remove(&evicted);
        }
    }
    state.terminal.insert(stream_id);
    state.cancelled.insert(stream_id);
    state.failures.insert(stream_id, message);
}

struct IncomingBodyGuard {
    inbox: ResponseBodyInbox,
    stream_id: u32,
    complete: bool,
}

impl IncomingBodyGuard {
    fn new(inbox: ResponseBodyInbox, stream_id: u32) -> Self {
        Self {
            inbox,
            stream_id,
            complete: false,
        }
    }

    fn complete(&mut self) {
        self.complete = true;
    }
}

impl Drop for IncomingBodyGuard {
    fn drop(&mut self) {
        if !self.complete {
            self.inbox
                .cancel(self.stream_id, "Media body was no longer needed");
        }
    }
}

enum ConnectedTaskOutcome {
    Send(Result<ProcSendResult, SendAttemptFailure>),
    Abort(Result<Value, RequestFailure>),
    Approval(Result<Value, RequestFailure>),
    History(Result<Value, RequestFailure>),
    Shell(Result<ShellResponse, RequestFailure>),
    Media(Result<(MediaResponse, MediaTransferLease), RequestFailure>),
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
    Media {
        request_id: u64,
    },
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
    media_bodies: ResponseBodyInbox,
    http_client: reqwest::Client,
    media_slots: Arc<Semaphore>,
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
        media_bodies,
        http_client,
        media_slots,
        pid,
    } = context;
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
                    let media =
                        load_media(&client, &media_bodies, &http_client, &pid, source).await?;
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
        ClientCommand::Connect(_)
        | ClientCommand::CancelConnect { .. }
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
            PendingOperation::Media { request_id } => {
                let _ = events.send(ClientEvent::MediaFailed {
                    request_id,
                    message: reason.to_string(),
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

async fn install_media_body_handler(client: &Arc<KernelClient>) -> ResponseBodyInbox {
    let weak_client = Arc::downgrade(client);
    let inbox = ResponseBodyInbox::new(move |frame| {
        let Some(client) = weak_client.upgrade() else {
            return;
        };
        tokio::spawn(async move {
            let _ = client.connection().send_binary(frame).await;
        });
    });
    let handler_inbox = inbox.clone();
    client
        .connection()
        .set_binary_handler(move |frame| handler_inbox.push(frame))
        .await;
    inbox
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
    let media_bodies = install_media_body_handler(&client).await;

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
        media_bodies,
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
        media_bodies,
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
    let mut media_tasks = HashMap::new();
    let mut cancelled_task_ids = HashSet::new();
    let mut next_operation_id = 1_u64;
    let mut history_refresh = HistoryRefresh::default();
    let http_client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(MEDIA_FETCH_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let media_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_MEDIA_TRANSFERS));
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
                            media_bodies: media_bodies.clone(),
                            http_client: http_client.clone(),
                            media_slots: media_slots.clone(),
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
        ClientCommand::LoadMedia { request_id, .. } => {
            let _ = events.send(ClientEvent::MediaFailed {
                request_id,
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

async fn load_media(
    client: &KernelClient,
    media_bodies: &ResponseBodyInbox,
    http_client: &reqwest::Client,
    pid: &str,
    source: MediaSource,
) -> Result<MediaResponse, RequestFailure> {
    match source {
        MediaSource::Process { key } => fetch_process_media(client, media_bodies, pid, &key).await,
        MediaSource::Remote { url } => {
            tokio::time::timeout(MEDIA_FETCH_TIMEOUT, fetch_remote_media(http_client, &url))
                .await
                .map_err(|_| RequestFailure::transport("The remote media fetch timed out."))?
        }
    }
}

async fn fetch_process_media(
    client: &KernelClient,
    media_bodies: &ResponseBodyInbox,
    pid: &str,
    key: &str,
) -> Result<MediaResponse, RequestFailure> {
    if key.trim().is_empty() {
        return Err(RequestFailure::rejected(
            "The process media reference is empty.",
        ));
    }

    let request = client.connection().request_with_timeout(
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

    let body = response.body;
    if !response.ok {
        cancel_response_body(media_bodies, body);
        let Some(error) = response.error else {
            return Err(RequestFailure::transport(
                "proc.media.read failed without error details",
            ));
        };
        return Err(RequestFailure {
            kind: classify_response_failure(error.code, error.retryable),
            message: format!(
                "proc.media.read failed (code {}): {}",
                error.code, error.message
            ),
        });
    }

    let data = response.data.unwrap_or_else(|| json!({}));
    if data.get("ok").and_then(Value::as_bool) == Some(false) {
        cancel_response_body(media_bodies, body);
        return Err(RequestFailure::rejected(
            data.get("error")
                .and_then(Value::as_str)
                .unwrap_or("The gateway rejected the media read"),
        ));
    }

    let Some(body) = body else {
        return Err(RequestFailure::transport(
            "GSV returned media metadata without its body.",
        ));
    };
    let Some(declared_size) = data.get("size").and_then(Value::as_u64) else {
        media_bodies.register(body)?;
        media_bodies.cancel(body.stream_id, "Media size metadata was invalid");
        return Err(RequestFailure::transport(
            "GSV returned media without a valid size.",
        ));
    };
    if declared_size > MAX_MEDIA_BYTES as u64 {
        media_bodies.register(body)?;
        media_bodies.cancel(body.stream_id, "Media transfer limit exceeded");
        return Err(RequestFailure::rejected(format!(
            "Media exceeds the {MAX_MEDIA_BYTES}-byte transfer limit."
        )));
    }
    if body.length.is_some_and(|length| length != declared_size) {
        media_bodies.register(body)?;
        media_bodies.cancel(body.stream_id, "Media size metadata did not match");
        return Err(RequestFailure::transport(
            "GSV returned inconsistent media size metadata.",
        ));
    }

    let bytes = media_bodies.read_body(body).await?;
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

fn cancel_response_body(media_bodies: &ResponseBodyInbox, body: Option<FrameBodyDescriptor>) {
    let Some(body) = body else {
        return;
    };
    if media_bodies.register(body).is_ok() {
        media_bodies.cancel(body.stream_id, "Media response was not accepted");
    }
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

    #[test]
    fn media_body_consumes_frames_that_arrive_before_registration() -> Result<(), String> {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sent_frames = sent.clone();
        let inbox = ResponseBodyInbox::new(move |frame| {
            if let Ok(mut sent) = sent_frames.lock() {
                sent.push(frame);
            }
        });
        inbox.push(build_binary_frame(23, BINARY_FRAME_DATA, b"image"));
        inbox.push(build_binary_frame(23, BINARY_FRAME_END, &[]));

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|error| error.to_string())?;
        let bytes = runtime
            .block_on(inbox.read_body(FrameBodyDescriptor {
                stream_id: 23,
                length: Some(5),
            }))
            .map_err(|error| error.to_string())?;

        assert_eq!(bytes.as_ref(), b"image");
        assert!(sent.lock().map(|sent| sent.is_empty()).unwrap_or(false));
        Ok(())
    }

    #[test]
    fn oversized_declared_media_body_is_cancelled_without_waiting() -> Result<(), String> {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sent_frames = sent.clone();
        let inbox = ResponseBodyInbox::new(move |frame| {
            if let Ok(mut sent) = sent_frames.lock() {
                sent.push(frame);
            }
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|error| error.to_string())?;
        let result = runtime.block_on(inbox.read_body(FrameBodyDescriptor {
            stream_id: 24,
            length: Some(MAX_MEDIA_BYTES as u64 + 1),
        }));
        let Err(error) = result else {
            return Err("oversized media should be rejected".to_string());
        };
        assert_eq!(error.kind, RequestFailureKind::Rejected);

        let frame = sent
            .lock()
            .map_err(|_| "sent frame mutex poisoned".to_string())?
            .first()
            .cloned()
            .ok_or_else(|| "expected a cancellation frame".to_string())?;
        let (stream_id, flags, _) = parse_binary_frame(&frame)
            .ok_or_else(|| "cancellation frame should parse".to_string())?;
        assert_eq!(stream_id, 24);
        assert_eq!(flags, BINARY_FRAME_CANCEL | BINARY_FRAME_END);

        inbox.push(build_binary_frame(
            24,
            BINARY_FRAME_CANCEL | BINARY_FRAME_END,
            b"outgoing direction",
        ));
        assert!(inbox
            .state
            .lock()
            .map(|state| state.cancelled.stream_ids.contains(&24))
            .unwrap_or(false));
        inbox.push(build_binary_frame(24, BINARY_FRAME_DATA, b"late"));
        let late_was_discarded = inbox
            .state
            .lock()
            .map(|state| {
                !state.frames.contains_key(&24) && state.cancelled.stream_ids.contains(&24)
            })
            .unwrap_or(false);
        assert!(late_was_discarded);

        inbox
            .register(FrameBodyDescriptor {
                stream_id: 24,
                length: Some(2),
            })
            .map_err(|error| error.to_string())?;
        inbox.push(build_binary_frame(24, BINARY_FRAME_DATA, b"ok"));
        inbox.push(build_binary_frame(24, BINARY_FRAME_END, &[]));
        let reused = runtime
            .block_on(inbox.read_body(FrameBodyDescriptor {
                stream_id: 24,
                length: Some(2),
            }))
            .map_err(|error| error.to_string())?;
        assert_eq!(reused.as_ref(), b"ok");
        Ok(())
    }

    #[test]
    fn cancelled_media_stream_tracking_is_bounded() {
        let mut streams = CancelledBodyStreams::default();
        for stream_id in 1..=(MAX_CANCELLED_MEDIA_STREAMS as u32 + 1) {
            streams.insert(stream_id);
        }

        assert_eq!(streams.stream_ids.len(), MAX_CANCELLED_MEDIA_STREAMS);
        assert!(!streams.stream_ids.contains(&1));
        let newest = MAX_CANCELLED_MEDIA_STREAMS as u32 + 1;
        assert!(streams.should_discard(newest, BINARY_FRAME_END));
        assert!(!streams.should_discard(newest, BINARY_FRAME_DATA));
    }

    #[test]
    fn failed_pre_descriptor_media_stream_tracking_is_bounded() {
        let mut state = ResponseBodyState::default();
        for stream_id in 1..=(MAX_FAILED_MEDIA_STREAMS as u32 + 1) {
            record_body_failure(&mut state, stream_id, "too large".to_string());
        }

        assert_eq!(state.failures.len(), MAX_FAILED_MEDIA_STREAMS);
        assert_eq!(state.terminal.len(), MAX_FAILED_MEDIA_STREAMS);
        assert!(state.cancelled.stream_ids.len() <= MAX_CANCELLED_MEDIA_STREAMS);
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
