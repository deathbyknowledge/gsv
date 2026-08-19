use std::env;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver as StdReceiver, SyncSender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use gsv_vision_control::{
    read_frame, write_frame, ControlStatus, DesktopCommand, GestureContext, GestureIntent,
    HelperEvent, LifecycleState, ScrollState, SessionId, EVENT_CHANNEL_CONTRACT_MARKER, EVENT_FD,
    EVENT_FD_MARKER_ENV, PROTOCOL_VERSION, SESSION_HIGH_ENV, SESSION_LOW_ENV,
};
use tokio::sync::{mpsc as tokio_mpsc, watch};
use uuid::Uuid;

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;

const PARENT_STDIN_WATCHDOG: &str = "GSV_VISION_PARENT_STDIN";
const DEBUG_WINDOW_MARKER: &str = "GSV_VISION_DEBUG_WINDOW";
const ENABLED_MARKER: &str = "1";
const EVENT_CAPACITY: usize = 8;
const WIRE_EVENT_CAPACITY: usize = 16;
const HELPER_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const SUPERVISOR_POLL: Duration = Duration::from_millis(20);

const HELPER_ENVIRONMENT: &[&str] = &[
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
    "PATH",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GSV_VISION_RUNTIME",
    "GSV_MEDIAPIPE_LIBRARY",
    "GSV_VISION_MODEL",
    "GSV_VISION_CAMERA",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VisionDebugError {
    InvalidOverride,
    NotInstalled,
    #[cfg(not(unix))]
    Unsupported,
    StartFailed,
    HandshakeFailed,
}

impl fmt::Display for VisionDebugError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidOverride => "GSV_VISION_HELPER does not name a file",
            Self::NotInstalled => "gsv-vision was not found",
            #[cfg(not(unix))]
            Self::Unsupported => "gesture control is not supported on this platform",
            Self::StartFailed => "gsv-vision could not be started",
            Self::HandshakeFailed => "gsv-vision did not complete its protocol handshake",
        })
    }
}

pub(crate) type VisionContext = GestureContext;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VisionEvent {
    Lifecycle(LifecycleState),
    Status {
        sequence: u64,
        received_at: Instant,
        status: ControlStatus,
    },
    Intent {
        sequence: u64,
        received_at: Instant,
        intent: GestureIntent,
    },
    Scroll {
        sequence: u64,
        received_at: Instant,
        state: ScrollState,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct VisionStatusEvent {
    sequence: u64,
    received_at: Instant,
    status: ControlStatus,
}

impl VisionStatusEvent {
    const fn into_event(self) -> VisionEvent {
        VisionEvent::Status {
            sequence: self.sequence,
            received_at: self.received_at,
            status: self.status,
        }
    }
}

/// Merges a reliable FIFO lifecycle/intent lane with one replace-latest status
/// cell. The lanes alternate when both remain busy so continuous status updates
/// cannot starve reliable actions. A terminal lifecycle clears the status cell
/// before entering the reliable lane.
pub(crate) struct VisionEventReceiver {
    reliable: tokio_mpsc::Receiver<VisionEvent>,
    status: watch::Receiver<Option<VisionStatusEvent>>,
    reliable_closed: bool,
    status_closed: bool,
    prefer_reliable: bool,
}

impl VisionEventReceiver {
    pub(crate) async fn recv(&mut self) -> Option<VisionEvent> {
        loop {
            if self.prefer_reliable {
                tokio::select! {
                    biased;
                    event = self.reliable.recv(), if !self.reliable_closed => {
                        match event {
                            Some(event) => {
                                self.prefer_reliable = false;
                                return Some(event);
                            }
                            None => self.reliable_closed = true,
                        }
                    }
                    changed = self.status.changed(), if !self.status_closed => {
                        match changed {
                            Ok(()) => {
                                let latest = *self.status.borrow_and_update();
                                if let Some(status) = latest {
                                    return Some(status.into_event());
                                }
                            }
                            Err(_) => self.status_closed = true,
                        }
                    }
                    else => return None,
                }
            } else {
                tokio::select! {
                    biased;
                    changed = self.status.changed(), if !self.status_closed => {
                        match changed {
                            Ok(()) => {
                                let latest = *self.status.borrow_and_update();
                                if let Some(status) = latest {
                                    self.prefer_reliable = true;
                                    return Some(status.into_event());
                                }
                            }
                            Err(_) => self.status_closed = true,
                        }
                    }
                    event = self.reliable.recv(), if !self.reliable_closed => {
                        match event {
                            Some(event) => return Some(event),
                            None => self.reliable_closed = true,
                        }
                    }
                    else => return None,
                }
            }
        }
    }

    fn close(&mut self) {
        self.reliable.close();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VisionContextError {
    Closed,
}

#[derive(Clone)]
pub(crate) struct VisionContextSender {
    state: Arc<ContextState>,
}

impl VisionContextSender {
    pub(crate) fn set_context(&self, context: VisionContext) -> Result<(), VisionContextError> {
        self.state.set(context)
    }

    /// Re-emits the current absolute state as an authority acknowledgement.
    /// This is intentionally distinct from ordinary replace-if-changed
    /// synchronization: a rejected or idempotent reliable intent still needs
    /// one new context frame so the helper can leave its pending state.
    pub(crate) fn reassert_context(
        &self,
        context: VisionContext,
    ) -> Result<(), VisionContextError> {
        self.state.reassert(context)
    }

    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self {
            state: Arc::new(ContextState::new()),
        }
    }

    #[cfg(test)]
    pub(crate) fn revision_for_test(&self) -> u64 {
        self.state.lock().snapshot.revision
    }

    #[cfg(test)]
    pub(crate) fn context_for_test(&self) -> VisionContext {
        self.state.lock().snapshot.context
    }
}

pub(crate) struct VisionHandle {
    pub(crate) context: VisionContextSender,
    pub(crate) events: VisionEventReceiver,
    shutdown: Arc<AtomicBool>,
    supervisor: Option<JoinHandle<()>>,
}

impl VisionHandle {
    fn stop(&mut self) {
        self.events.close();
        self.context.state.close();
        self.shutdown.store(true, Ordering::Release);
        if let Some(supervisor) = self.supervisor.take() {
            let _ = supervisor.join();
        }
    }
}

impl Drop for VisionHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Copy)]
struct ContextSnapshot {
    revision: u64,
    context: VisionContext,
}

struct ContextInner {
    snapshot: ContextSnapshot,
    closed: bool,
}

struct ContextState {
    inner: Mutex<ContextInner>,
    changed: Condvar,
}

struct SupervisorSignals {
    shutdown_requested: Arc<AtomicBool>,
    command_failed: Arc<AtomicBool>,
}

impl SupervisorSignals {
    fn should_report_interrupted(&self, terminal_reported: bool) -> bool {
        !self.shutdown_requested.load(Ordering::Acquire) && !terminal_reported
    }
}

impl ContextState {
    fn new() -> Self {
        Self {
            inner: Mutex::new(ContextInner {
                snapshot: ContextSnapshot {
                    revision: 1,
                    context: VisionContext::Disabled,
                },
                closed: false,
            }),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ContextInner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn set(&self, context: VisionContext) -> Result<(), VisionContextError> {
        let mut inner = self.lock();
        if inner.closed {
            return Err(VisionContextError::Closed);
        }
        if inner.snapshot.context == context {
            return Ok(());
        }
        inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1).max(1);
        inner.snapshot.context = context;
        self.changed.notify_one();
        Ok(())
    }

    fn reassert(&self, context: VisionContext) -> Result<(), VisionContextError> {
        let mut inner = self.lock();
        if inner.closed {
            return Err(VisionContextError::Closed);
        }
        inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1).max(1);
        inner.snapshot.context = context;
        self.changed.notify_one();
        Ok(())
    }

    fn desired(&self) -> VisionContext {
        self.lock().snapshot.context
    }

    fn wait_after(&self, revision: u64) -> Option<ContextSnapshot> {
        let mut inner = self.lock();
        loop {
            if inner.closed {
                return None;
            }
            if inner.snapshot.revision != revision {
                return Some(inner.snapshot);
            }
            inner = match self.changed.wait(inner) {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }

    fn close(&self) {
        let mut inner = self.lock();
        inner.snapshot.revision = inner.snapshot.revision.wrapping_add(1).max(1);
        inner.snapshot.context = VisionContext::Disabled;
        inner.closed = true;
        self.changed.notify_all();
    }
}

enum WireRead {
    Event {
        event: HelperEvent,
        received_at: Instant,
    },
    Eof,
    Invalid,
}

struct SpawnedHelper {
    child: Child,
    stdin: ChildStdin,
    wire_events: StdReceiver<WireRead>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LaunchMode {
    Headless,
    Debug,
}

pub(crate) fn start_from_env() -> Result<Option<VisionHandle>, VisionDebugError> {
    let Some(mode) = launch_mode(
        env::var_os("GSV_GESTURES").as_deref(),
        env::var_os("GSV_GESTURE_DEBUG").as_deref(),
    ) else {
        return Ok(None);
    };

    #[cfg(not(unix))]
    {
        Err(VisionDebugError::Unsupported)
    }

    #[cfg(unix)]
    {
        start_supported(mode).map(Some)
    }
}

#[cfg(unix)]
fn start_supported(mode: LaunchMode) -> Result<VisionHandle, VisionDebugError> {
    let executable = resolve_helper(
        env::var_os("GSV_VISION_HELPER").map(PathBuf::from),
        env::current_exe().ok(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        env::var_os("CARGO_TARGET_DIR").map(PathBuf::from),
        cfg!(debug_assertions),
    )?;
    let session_id = new_session_id();
    let mut command = Command::new(executable);
    command
        .env_clear()
        .envs(allowed_environment(env::vars_os()));
    configure_protocol_environment(&mut command, session_id, mode);
    match mode {
        LaunchMode::Headless => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        LaunchMode::Debug => {
            command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        }
    }
    let helper = spawn_helper(&mut command, session_id)?;
    start_supervisor(helper, session_id)
}

fn configure_protocol_environment(command: &mut Command, session_id: SessionId, mode: LaunchMode) {
    command
        .env(PARENT_STDIN_WATCHDOG, ENABLED_MARKER)
        .env(EVENT_FD_MARKER_ENV, EVENT_CHANNEL_CONTRACT_MARKER)
        .env(SESSION_HIGH_ENV, session_id.high().to_string())
        .env(SESSION_LOW_ENV, session_id.low().to_string());
    if mode == LaunchMode::Debug {
        command.env(DEBUG_WINDOW_MARKER, ENABLED_MARKER);
    }
}

fn new_session_id() -> SessionId {
    let value = Uuid::new_v4().as_u128();
    SessionId::new((value >> 64) as u64, value as u64)
}

#[cfg(unix)]
fn spawn_helper(
    command: &mut Command,
    session_id: SessionId,
) -> Result<SpawnedHelper, VisionDebugError> {
    let (event_reader, event_writer) =
        anonymous_pipe().map_err(|_| VisionDebugError::StartFailed)?;
    let writer_fd = event_writer.as_raw_fd();
    // SAFETY: the callback performs only async-signal-safe fd operations. The
    // owned writer remains alive until `spawn` returns and is then closed in
    // Desktop, leaving the helper as the event pipe's sole writer.
    unsafe {
        command.pre_exec(move || map_event_fd(writer_fd));
    }
    let spawn = command.stdin(Stdio::piped()).spawn();
    drop(event_writer);
    let mut child = spawn.map_err(|_| VisionDebugError::StartFailed)?;
    let Some(stdin) = child.stdin.take() else {
        terminate_and_reap(child);
        return Err(VisionDebugError::StartFailed);
    };
    let wire_events = match start_event_reader(event_reader) {
        Ok(events) => events,
        Err(()) => {
            terminate_and_reap(child);
            return Err(VisionDebugError::StartFailed);
        }
    };
    let handshake = wire_events.recv_timeout(HELPER_HANDSHAKE_TIMEOUT);
    if !matches!(
        handshake,
        Ok(WireRead::Event {
            event: HelperEvent::Hello {
                protocol_version: PROTOCOL_VERSION,
                session_id: received,
            },
            ..
        }) if received == session_id
    ) {
        terminate_and_reap(child);
        return Err(VisionDebugError::HandshakeFailed);
    }
    Ok(SpawnedHelper {
        child,
        stdin,
        wire_events,
    })
}

#[cfg(unix)]
fn anonymous_pipe() -> std::io::Result<(File, OwnedFd)> {
    let mut descriptors = [-1; 2];
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let status = {
        // SAFETY: `descriptors` points to storage for the two fds returned by pipe2.
        unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) }
    };
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let status = {
        // SAFETY: `descriptors` points to storage for the two fds returned by pipe.
        let status = unsafe { libc::pipe(descriptors.as_mut_ptr()) };
        if status == 0 {
            for descriptor in descriptors {
                // SAFETY: both descriptors were returned by pipe and remain open.
                let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
                if flags == -1
                    // SAFETY: the descriptor remains valid and `flags` came from F_GETFD.
                    || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) }
                        == -1
                {
                    // SAFETY: both descriptors are valid and owned by this function.
                    unsafe {
                        libc::close(descriptors[0]);
                        libc::close(descriptors[1]);
                    }
                    return Err(std::io::Error::last_os_error());
                }
            }
        }
        status
    };
    if status == -1 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: successful pipe creation returned two newly owned descriptors.
    let reader = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: successful pipe creation returned two newly owned descriptors.
    let writer = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    Ok((File::from(reader), writer))
}

#[cfg(unix)]
fn map_event_fd(parent_fd: i32) -> std::io::Result<()> {
    if parent_fd == EVENT_FD {
        // SAFETY: the fd is inherited from the parent and F_GETFD has no pointer arguments.
        let flags = unsafe { libc::fcntl(EVENT_FD, libc::F_GETFD) };
        if flags == -1 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: EVENT_FD is valid and the operation only clears close-on-exec.
        if unsafe { libc::fcntl(EVENT_FD, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    } else {
        // SAFETY: parent_fd is the live pipe writer and dup2 atomically replaces EVENT_FD.
        if unsafe { libc::dup2(parent_fd, EVENT_FD) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

fn start_event_reader(reader: File) -> Result<StdReceiver<WireRead>, ()> {
    let (sender, events) = mpsc::sync_channel(WIRE_EVENT_CAPACITY);
    std::thread::Builder::new()
        .name("gsv-vision-events".to_string())
        .spawn(move || read_events(reader, sender))
        .map_err(|_| ())?;
    Ok(events)
}

fn read_events(mut reader: File, events: SyncSender<WireRead>) {
    loop {
        let message = match read_frame::<HelperEvent>(&mut reader) {
            Ok(Some(event)) => WireRead::Event {
                event,
                received_at: Instant::now(),
            },
            Ok(None) => WireRead::Eof,
            Err(_) => WireRead::Invalid,
        };
        let terminal = !matches!(message, WireRead::Event { .. });
        if events.send(message).is_err() || terminal {
            return;
        }
    }
}

fn start_supervisor(
    helper: SpawnedHelper,
    session_id: SessionId,
) -> Result<VisionHandle, VisionDebugError> {
    let SpawnedHelper {
        child,
        stdin,
        wire_events,
    } = helper;
    let context_state = Arc::new(ContextState::new());
    let shutdown = Arc::new(AtomicBool::new(false));
    let command_failed = Arc::new(AtomicBool::new(false));
    let (event_sender, reliable_events) = tokio_mpsc::channel(EVENT_CAPACITY);
    let (status_sender, status_events) = watch::channel(None);
    let supervisor_context = Arc::clone(&context_state);
    let supervisor_signals = SupervisorSignals {
        shutdown_requested: Arc::clone(&shutdown),
        command_failed: Arc::clone(&command_failed),
    };
    let supervisor = std::thread::Builder::new()
        .name("gsv-vision-supervisor".to_string())
        .spawn(move || {
            supervise(
                child,
                wire_events,
                session_id,
                supervisor_context,
                supervisor_signals,
                event_sender,
                status_sender,
            );
        })
        .map_err(|_| VisionDebugError::StartFailed)?;
    let writer_context = Arc::clone(&context_state);
    let writer_command_failed = Arc::clone(&command_failed);
    if std::thread::Builder::new()
        .name("gsv-vision-commands".to_string())
        .spawn(move || command_writer(stdin, session_id, writer_context, writer_command_failed))
        .is_err()
    {
        context_state.close();
        shutdown.store(true, Ordering::Release);
        let _ = supervisor.join();
        return Err(VisionDebugError::StartFailed);
    }
    Ok(VisionHandle {
        context: VisionContextSender {
            state: context_state,
        },
        events: VisionEventReceiver {
            reliable: reliable_events,
            status: status_events,
            reliable_closed: false,
            status_closed: false,
            prefer_reliable: false,
        },
        shutdown,
        supervisor: Some(supervisor),
    })
}

fn command_writer(
    mut stdin: impl Write,
    session_id: SessionId,
    context: Arc<ContextState>,
    command_failed: Arc<AtomicBool>,
) {
    let mut revision = 0;
    while let Some(snapshot) = context.wait_after(revision) {
        let command = DesktopCommand::set_context(session_id, snapshot.context);
        if write_frame(&mut stdin, &command).is_err() {
            command_failed.store(true, Ordering::Release);
            break;
        }
        revision = snapshot.revision;
    }
}

fn supervise(
    mut child: Child,
    wire_events: StdReceiver<WireRead>,
    session_id: SessionId,
    context: Arc<ContextState>,
    signals: SupervisorSignals,
    events: tokio_mpsc::Sender<VisionEvent>,
    statuses: watch::Sender<Option<VisionStatusEvent>>,
) {
    let mut last_sequence = 0;
    let mut terminal_reported = false;
    loop {
        if signals.shutdown_requested.load(Ordering::Acquire) {
            break;
        }
        if signals.command_failed.load(Ordering::Acquire) {
            break;
        }
        match wire_events.recv_timeout(SUPERVISOR_POLL) {
            Ok(WireRead::Event { event, received_at }) => {
                match translate_event(
                    event,
                    received_at,
                    session_id,
                    &mut last_sequence,
                    context.desired(),
                ) {
                    Ok(Some(event)) => {
                        terminal_reported = matches!(
                            event,
                            VisionEvent::Lifecycle(state) if state != LifecycleState::Ready
                        );
                        if send_vision_event(&events, &statuses, event).is_err()
                            || terminal_reported
                        {
                            break;
                        }
                    }
                    Ok(None) => {}
                    Err(()) => {
                        let _ = send_vision_event(
                            &events,
                            &statuses,
                            VisionEvent::Lifecycle(LifecycleState::ProtocolError),
                        );
                        terminal_reported = true;
                        break;
                    }
                }
            }
            Ok(WireRead::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Ok(WireRead::Invalid) => {
                let _ = send_vision_event(
                    &events,
                    &statuses,
                    VisionEvent::Lifecycle(LifecycleState::ProtocolError),
                );
                terminal_reported = true;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
            }
        }
    }

    context.close();
    if signals.should_report_interrupted(terminal_reported) {
        let _ = send_vision_event(
            &events,
            &statuses,
            VisionEvent::Lifecycle(LifecycleState::Interrupted),
        );
    }
    terminate_child(&mut child);
    let _ = reap_in_background(child);
}

fn send_vision_event(
    events: &tokio_mpsc::Sender<VisionEvent>,
    statuses: &watch::Sender<Option<VisionStatusEvent>>,
    event: VisionEvent,
) -> Result<(), ()> {
    if let VisionEvent::Status {
        sequence,
        received_at,
        status,
    } = event
    {
        statuses.send_replace(Some(VisionStatusEvent {
            sequence,
            received_at,
            status,
        }));
        return Ok(());
    }
    if matches!(
        event,
        VisionEvent::Lifecycle(state) if state != LifecycleState::Ready
    ) {
        // A terminal lifecycle is authoritative over any explanatory snapshot
        // that the stalled UI has not consumed yet.
        statuses.send_replace(None);
    }
    events.blocking_send(event).map_err(|_| ())
}

fn translate_event(
    event: HelperEvent,
    received_at: Instant,
    expected_session: SessionId,
    last_sequence: &mut u64,
    context: VisionContext,
) -> Result<Option<VisionEvent>, ()> {
    let (session_id, sequence) = match event {
        HelperEvent::Hello { .. } => return Err(()),
        HelperEvent::Lifecycle {
            session_id,
            sequence,
            ..
        }
        | HelperEvent::Status {
            session_id,
            sequence,
            ..
        }
        | HelperEvent::Intent {
            session_id,
            sequence,
            ..
        }
        | HelperEvent::Scroll {
            session_id,
            sequence,
            ..
        } => (session_id, sequence),
    };
    if session_id != expected_session || sequence == 0 || sequence <= *last_sequence {
        return Ok(None);
    }
    *last_sequence = sequence;
    match event {
        HelperEvent::Lifecycle { state, .. } => Ok(Some(VisionEvent::Lifecycle(state))),
        HelperEvent::Status {
            status: ControlStatus::Disabled,
            ..
        } if context == VisionContext::Disabled => Ok(Some(VisionEvent::Status {
            sequence,
            received_at,
            status: ControlStatus::Disabled,
        })),
        HelperEvent::Status {
            status: status @ ControlStatus::Standby { .. },
            ..
        } if context == VisionContext::Standby => Ok(Some(VisionEvent::Status {
            sequence,
            received_at,
            status,
        })),
        HelperEvent::Status {
            status:
                status @ ControlStatus::Active {
                    voice_request_id,
                    muted,
                    ..
                },
            ..
        } if matches!(
            context,
        VisionContext::Active {
            voice_request_id: expected_request_id,
            muted: expected_muted,
        } if expected_request_id == voice_request_id && expected_muted == muted
        ) =>
        {
            Ok(Some(VisionEvent::Status {
                sequence,
                received_at,
                status,
            }))
        }
        HelperEvent::Status { .. } => Ok(None),
        HelperEvent::Intent {
            intent: intent @ GestureIntent::StartTranscription,
            ..
        } if context == VisionContext::Standby => Ok(Some(VisionEvent::Intent {
            sequence,
            received_at,
            intent,
        })),
        HelperEvent::Intent {
            intent:
                intent @ GestureIntent::VoiceRequest {
                    voice_request_id, ..
                },
            ..
        } if matches!(
            context,
            VisionContext::Active {
                voice_request_id: expected_request_id,
                ..
            } if expected_request_id == voice_request_id
        ) =>
        {
            Ok(Some(VisionEvent::Intent {
                sequence,
                received_at,
                intent,
            }))
        }
        HelperEvent::Intent { .. } => Ok(None),
        HelperEvent::Scroll { state, .. } => Ok(Some(VisionEvent::Scroll {
            sequence,
            received_at,
            state,
        })),
        HelperEvent::Hello { .. } => Err(()),
    }
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
}

fn terminate_and_reap(mut child: Child) {
    terminate_child(&mut child);
    let _ = reap_in_background(child);
}

fn reap_in_background(mut child: Child) -> Option<JoinHandle<()>> {
    // Camera and native inference teardown can remain stuck below Rust even after kill.
    // Desktop owns termination, but a detached reaper owns the potentially blocking wait.
    std::thread::Builder::new()
        .name("gsv-vision-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        })
        .ok()
}

fn debug_enabled(value: Option<&OsStr>) -> bool {
    value == Some(OsStr::new("1"))
}

fn launch_mode(gestures: Option<&OsStr>, debug: Option<&OsStr>) -> Option<LaunchMode> {
    if debug_enabled(debug) {
        Some(LaunchMode::Debug)
    } else if debug_enabled(gestures) {
        Some(LaunchMode::Headless)
    } else {
        None
    }
}

fn resolve_helper(
    override_path: Option<PathBuf>,
    current_executable: Option<PathBuf>,
    manifest_dir: &Path,
    target_override: Option<PathBuf>,
    debug: bool,
) -> Result<PathBuf, VisionDebugError> {
    if let Some(path) = override_path {
        return path
            .is_file()
            .then_some(path)
            .ok_or(VisionDebugError::InvalidOverride);
    }

    if let Some(current_executable) = current_executable {
        let sibling =
            current_executable.with_file_name(format!("gsv-vision{}", env::consts::EXE_SUFFIX));
        if sibling.is_file() {
            return Ok(sibling);
        }
    }

    development_helper_candidates(manifest_dir, target_override, debug)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or(VisionDebugError::NotInstalled)
}

fn development_helper_candidates(
    manifest_dir: &Path,
    target_override: Option<PathBuf>,
    debug: bool,
) -> Vec<PathBuf> {
    let workspace_root = manifest_dir.parent().unwrap_or(manifest_dir);
    let mut target_dirs = Vec::with_capacity(2);
    if let Some(target) = target_override {
        target_dirs.push(if target.is_absolute() {
            target
        } else {
            workspace_root.join(target)
        });
    }
    target_dirs.push(workspace_root.join("target"));
    let profiles = if debug {
        ["debug", "release"]
    } else {
        ["release", "debug"]
    };
    target_dirs
        .into_iter()
        .flat_map(|target| {
            profiles.map(move |profile| {
                target
                    .join(profile)
                    .join(format!("gsv-vision{}", env::consts::EXE_SUFFIX))
            })
        })
        .collect()
}

fn allowed_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    environment
        .into_iter()
        .filter(|(key, _)| {
            key.to_str()
                .is_some_and(|key| HELPER_ENVIRONMENT.contains(&key))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    const SESSION: SessionId = SessionId::new(3, 5);

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "test command pipe closed",
            ))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn gesture_debug_requires_exact_opt_in() {
        assert!(debug_enabled(Some(OsStr::new("1"))));
        assert!(!debug_enabled(None));
        assert!(!debug_enabled(Some(OsStr::new("true"))));
        assert!(!debug_enabled(Some(OsStr::new("0"))));
    }

    #[test]
    fn launch_mode_accepts_production_or_debug_opt_in_exactly() {
        assert_eq!(
            launch_mode(Some(OsStr::new("1")), None),
            Some(LaunchMode::Headless)
        );
        assert_eq!(
            launch_mode(None, Some(OsStr::new("1"))),
            Some(LaunchMode::Debug)
        );
        assert_eq!(
            launch_mode(Some(OsStr::new("1")), Some(OsStr::new("1"))),
            Some(LaunchMode::Debug)
        );
        assert_eq!(launch_mode(Some(OsStr::new("true")), None), None);
        assert_eq!(launch_mode(None, Some(OsStr::new("0"))), None);
        assert_eq!(ENABLED_MARKER, "1");
        assert_ne!(EVENT_CHANNEL_CONTRACT_MARKER, ENABLED_MARKER);
    }

    #[test]
    fn supervisor_uses_exact_private_markers_and_debug_is_separate() {
        let mut headless = Command::new("unused");
        configure_protocol_environment(&mut headless, SESSION, LaunchMode::Headless);
        let headless_environment = headless
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.map(OsStr::to_owned)))
            .collect::<Vec<_>>();
        assert!(headless_environment.iter().any(|(key, value)| {
            key == EVENT_FD_MARKER_ENV
                && value.as_deref() == Some(OsStr::new(EVENT_CHANNEL_CONTRACT_MARKER))
        }));
        assert!(!headless_environment
            .iter()
            .any(|(key, _)| key == DEBUG_WINDOW_MARKER));

        let mut debug = Command::new("unused");
        configure_protocol_environment(&mut debug, SESSION, LaunchMode::Debug);
        assert!(debug
            .get_envs()
            .any(|(key, value)| { key == DEBUG_WINDOW_MARKER && value == Some(OsStr::new("1")) }));
    }

    #[test]
    fn resolution_prefers_override_then_sibling_then_workspace_target() {
        let directory = tempdir().expect("temporary directory");
        let workspace = directory.path();
        let manifest = workspace.join("native");
        let installed = workspace.join("installed");
        fs::create_dir_all(&manifest).expect("native directory");
        fs::create_dir_all(&installed).expect("installed directory");

        let override_path = workspace.join("explicit-vision-helper");
        let current_executable = installed.join(format!("gsv-native{}", env::consts::EXE_SUFFIX));
        let sibling = installed.join(format!("gsv-vision{}", env::consts::EXE_SUFFIX));
        let workspace_helper = workspace
            .join("target/debug")
            .join(format!("gsv-vision{}", env::consts::EXE_SUFFIX));
        fs::write(&override_path, []).expect("override helper");
        fs::write(&sibling, []).expect("sibling helper");
        fs::create_dir_all(workspace_helper.parent().expect("target directory"))
            .expect("target directory");
        fs::write(&workspace_helper, []).expect("workspace helper");

        assert_eq!(
            resolve_helper(
                Some(override_path.clone()),
                Some(current_executable.clone()),
                &manifest,
                None,
                true,
            ),
            Ok(override_path)
        );
        assert_eq!(
            resolve_helper(
                None,
                Some(current_executable.clone()),
                &manifest,
                None,
                true,
            ),
            Ok(sibling.clone())
        );
        fs::remove_file(sibling).expect("remove sibling helper");
        assert_eq!(
            resolve_helper(None, Some(current_executable), &manifest, None, true),
            Ok(workspace_helper)
        );
    }

    #[test]
    fn invalid_override_does_not_fall_back_to_discovered_helper() {
        let directory = tempdir().expect("temporary directory");
        let installed = directory.path().join("installed");
        fs::create_dir_all(&installed).expect("installed directory");
        let current_executable = installed.join(format!("gsv-native{}", env::consts::EXE_SUFFIX));
        let sibling = installed.join(format!("gsv-vision{}", env::consts::EXE_SUFFIX));
        fs::write(&sibling, []).expect("sibling helper");

        assert_eq!(
            resolve_helper(
                Some(directory.path().join("missing")),
                Some(current_executable),
                directory.path(),
                None,
                true,
            ),
            Err(VisionDebugError::InvalidOverride)
        );
    }

    #[test]
    fn helper_environment_is_an_explicit_allowlist() {
        let environment = vec![
            (OsString::from("PATH"), OsString::from("/bin")),
            (
                OsString::from("GSV_VISION_RUNTIME"),
                OsString::from("/debug/vision-runtime"),
            ),
            (
                OsString::from("GSV_MEDIAPIPE_LIBRARY"),
                OsString::from("/debug/libmediapipe.so"),
            ),
            (
                OsString::from("GSV_VISION_MODEL"),
                OsString::from("/debug/model.task"),
            ),
            (OsString::from("GSV_VISION_CAMERA"), OsString::from("2")),
            (OsString::from("GSV_TOKEN"), OsString::from("secret")),
            (OsString::from(EVENT_FD_MARKER_ENV), OsString::from("3")),
            (OsString::from(SESSION_HIGH_ENV), OsString::from("4")),
            (OsString::from(SESSION_LOW_ENV), OsString::from("5")),
            (OsString::from("HOME"), OsString::from("/private/home")),
        ];

        let allowed = allowed_environment(environment);
        assert_eq!(allowed.len(), 5);
        assert!(allowed.iter().any(|(key, _)| key == "PATH"));
        assert!(allowed.iter().any(|(key, _)| key == "GSV_VISION_RUNTIME"));
        assert!(allowed
            .iter()
            .any(|(key, _)| key == "GSV_MEDIAPIPE_LIBRARY"));
        assert!(allowed.iter().any(|(key, _)| key == "GSV_VISION_MODEL"));
        assert!(allowed.iter().any(|(key, _)| key == "GSV_VISION_CAMERA"));
        assert!(!allowed.iter().any(|(key, _)| key == "GSV_TOKEN"));
        assert!(!allowed.iter().any(|(key, _)| key == EVENT_FD_MARKER_ENV));
        assert!(!allowed.iter().any(|(key, _)| key == SESSION_HIGH_ENV));
        assert!(!allowed.iter().any(|(key, _)| key == SESSION_LOW_ENV));
        assert!(!allowed.iter().any(|(key, _)| key == "HOME"));
    }

    #[test]
    fn context_updates_are_absolute_and_reassertable() {
        let state = Arc::new(ContextState::new());
        let sender = VisionContextSender {
            state: Arc::clone(&state),
        };
        let initial = state.wait_after(0).expect("initial disabled context");
        assert_eq!(initial.context, VisionContext::Disabled);
        sender
            .set_context(VisionContext::Disabled)
            .expect("identical context remains valid");
        assert_eq!(state.lock().snapshot.revision, initial.revision);

        sender
            .set_context(VisionContext::Standby)
            .expect("standby context");
        let standby_revision = state.lock().snapshot.revision;
        sender
            .set_context(VisionContext::Standby)
            .expect("identical standby context remains valid");
        assert_eq!(state.lock().snapshot.revision, standby_revision);
        sender
            .reassert_context(VisionContext::Standby)
            .expect("identical authority can be replayed");
        let reasserted_revision = state.lock().snapshot.revision;
        assert_ne!(reasserted_revision, standby_revision);
        sender
            .set_context(VisionContext::Active {
                voice_request_id: 8,
                muted: false,
            })
            .expect("active context");
        assert_ne!(state.lock().snapshot.revision, reasserted_revision);
        sender
            .set_context(VisionContext::Active {
                voice_request_id: 8,
                muted: true,
            })
            .expect("muted context");
        sender
            .set_context(VisionContext::Disabled)
            .expect("disable context");
        assert_eq!(state.desired(), VisionContext::Disabled);
        let latest = state
            .wait_after(initial.revision)
            .expect("latest context update");
        assert_eq!(latest.context, VisionContext::Disabled);
    }

    #[test]
    fn command_write_failure_is_not_mistaken_for_requested_shutdown() {
        let context = Arc::new(ContextState::new());
        let signals = SupervisorSignals {
            shutdown_requested: Arc::new(AtomicBool::new(false)),
            command_failed: Arc::new(AtomicBool::new(false)),
        };

        command_writer(
            FailingWriter,
            SESSION,
            context,
            Arc::clone(&signals.command_failed),
        );

        assert!(signals.command_failed.load(Ordering::Acquire));
        assert!(signals.should_report_interrupted(false));
    }

    #[test]
    fn stale_session_sequence_and_voice_context_are_fenced() {
        let received_at = Instant::now();
        let intent = |session_id, sequence, intent| HelperEvent::Intent {
            session_id,
            sequence,
            intent,
        };
        let mut sequence = 0;
        assert_eq!(
            translate_event(
                intent(SessionId::new(9, 9), 1, GestureIntent::StartTranscription,),
                received_at,
                SESSION,
                &mut sequence,
                VisionContext::Standby,
            ),
            Ok(None)
        );
        assert_eq!(sequence, 0);
        assert_eq!(
            translate_event(
                intent(SESSION, 1, GestureIntent::StartTranscription),
                received_at,
                SESSION,
                &mut sequence,
                VisionContext::Disabled,
            ),
            Ok(None)
        );
        assert_eq!(sequence, 1);
        assert_eq!(
            translate_event(
                intent(SESSION, 1, GestureIntent::StartTranscription),
                received_at,
                SESSION,
                &mut sequence,
                VisionContext::Standby,
            ),
            Ok(None)
        );
        assert_eq!(
            translate_event(
                intent(SESSION, 2, GestureIntent::StartTranscription),
                received_at,
                SESSION,
                &mut sequence,
                VisionContext::Standby,
            ),
            Ok(Some(VisionEvent::Intent {
                sequence: 2,
                received_at,
                intent: GestureIntent::StartTranscription,
            }))
        );

        let send = |voice_request_id| GestureIntent::VoiceRequest {
            voice_request_id,
            action: gsv_vision_control::VoiceRequestGestureIntent::Send,
        };
        let active = VisionContext::Active {
            voice_request_id: 21,
            muted: false,
        };
        assert_eq!(
            translate_event(
                intent(SESSION, 3, send(20)),
                received_at,
                SESSION,
                &mut sequence,
                active,
            ),
            Ok(None)
        );
        assert_eq!(
            translate_event(
                intent(SESSION, 4, send(21)),
                received_at,
                SESSION,
                &mut sequence,
                active,
            ),
            Ok(Some(VisionEvent::Intent {
                sequence: 4,
                received_at,
                intent: send(21),
            }))
        );
    }

    #[test]
    fn scroll_state_is_session_fenced_but_independent_of_voice_context() {
        let received_at = Instant::now();
        let held = ScrollState::Held {
            instance_id: 4,
            direction: gsv_vision_control::ScrollDirection::Up,
        };
        let mut sequence = 0;
        assert_eq!(
            translate_event(
                HelperEvent::Scroll {
                    session_id: SessionId::new(9, 9),
                    sequence: 1,
                    state: held,
                },
                received_at,
                SESSION,
                &mut sequence,
                VisionContext::Standby,
            ),
            Ok(None)
        );
        assert_eq!(sequence, 0);
        assert_eq!(
            translate_event(
                HelperEvent::Scroll {
                    session_id: SESSION,
                    sequence: 1,
                    state: held,
                },
                received_at,
                SESSION,
                &mut sequence,
                VisionContext::Disabled,
            ),
            Ok(Some(VisionEvent::Scroll {
                sequence: 1,
                received_at,
                state: held,
            }))
        );
    }

    #[test]
    fn semantic_status_is_session_sequence_and_context_fenced() {
        let received_at = Instant::now();
        let status = |session_id, sequence, status| HelperEvent::Status {
            session_id,
            sequence,
            status,
        };
        let active_status = ControlStatus::Active {
            voice_request_id: 21,
            muted: false,
            progress: None,
        };
        let active_context = VisionContext::Active {
            voice_request_id: 21,
            muted: false,
        };
        let mut sequence = 0;

        assert_eq!(
            translate_event(
                status(SessionId::new(9, 9), 1, active_status),
                received_at,
                SESSION,
                &mut sequence,
                active_context,
            ),
            Ok(None)
        );
        assert_eq!(sequence, 0);
        assert_eq!(
            translate_event(
                status(SESSION, 1, active_status),
                received_at,
                SESSION,
                &mut sequence,
                VisionContext::Standby,
            ),
            Ok(None)
        );
        assert_eq!(sequence, 1);
        assert_eq!(
            translate_event(
                status(SESSION, 2, active_status),
                received_at,
                SESSION,
                &mut sequence,
                active_context,
            ),
            Ok(Some(VisionEvent::Status {
                sequence: 2,
                received_at,
                status: active_status,
            }))
        );
        assert_eq!(
            translate_event(
                status(
                    SESSION,
                    3,
                    ControlStatus::Active {
                        voice_request_id: 21,
                        muted: true,
                        progress: None,
                    },
                ),
                received_at,
                SESSION,
                &mut sequence,
                active_context,
            ),
            Ok(None)
        );
    }

    #[test]
    fn stalled_ui_receives_the_latest_fresh_status_and_every_reliable_event() {
        let (events, reliable) = tokio_mpsc::channel(EVENT_CAPACITY);
        let (statuses, status) = watch::channel(None);
        let mut receiver = VisionEventReceiver {
            reliable,
            status,
            reliable_closed: false,
            status_closed: false,
            prefer_reliable: false,
        };
        let stale = Instant::now()
            .checked_sub(Duration::from_secs(2))
            .expect("test instant supports subtraction");
        send_vision_event(
            &events,
            &statuses,
            VisionEvent::Lifecycle(LifecycleState::Ready),
        )
        .expect("reliable lifecycle queues");
        for (sequence, muted) in [(2, false), (3, true), (4, false)] {
            send_vision_event(
                &events,
                &statuses,
                VisionEvent::Status {
                    sequence,
                    received_at: stale,
                    status: ControlStatus::Active {
                        voice_request_id: 31,
                        muted,
                        progress: None,
                    },
                },
            )
            .expect("obsolete status coalesces");
        }
        send_vision_event(
            &events,
            &statuses,
            VisionEvent::Intent {
                sequence: 5,
                received_at: Instant::now(),
                intent: GestureIntent::VoiceRequest {
                    voice_request_id: 31,
                    action: gsv_vision_control::VoiceRequestGestureIntent::Mute,
                },
            },
        )
        .expect("reliable intent queues");
        let final_received_at = Instant::now();
        let final_status = ControlStatus::Active {
            voice_request_id: 31,
            muted: true,
            progress: None,
        };
        send_vision_event(
            &events,
            &statuses,
            VisionEvent::Status {
                sequence: 6,
                received_at: final_received_at,
                status: final_status,
            },
        )
        .expect("final status replaces obsolete status");

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            assert_eq!(
                receiver.recv().await,
                Some(VisionEvent::Status {
                    sequence: 6,
                    received_at: final_received_at,
                    status: final_status,
                })
            );
            send_vision_event(
                &events,
                &statuses,
                VisionEvent::Status {
                    sequence: 7,
                    received_at: Instant::now(),
                    status: final_status,
                },
            )
            .expect("continuous status remains nonblocking");
            assert_eq!(
                receiver.recv().await,
                Some(VisionEvent::Lifecycle(LifecycleState::Ready))
            );
            assert!(matches!(
                receiver.recv().await,
                Some(VisionEvent::Status { sequence: 7, .. })
            ));
            assert!(matches!(
                receiver.recv().await,
                Some(VisionEvent::Intent {
                    sequence: 5,
                    intent: GestureIntent::VoiceRequest {
                        voice_request_id: 31,
                        action: gsv_vision_control::VoiceRequestGestureIntent::Mute,
                    },
                    ..
                })
            ));
        });
    }

    #[test]
    fn terminal_lifecycle_discards_an_unseen_active_status() {
        let (events, reliable) = tokio_mpsc::channel(EVENT_CAPACITY);
        let (statuses, status) = watch::channel(None);
        let mut receiver = VisionEventReceiver {
            reliable,
            status,
            reliable_closed: false,
            status_closed: false,
            prefer_reliable: false,
        };
        send_vision_event(
            &events,
            &statuses,
            VisionEvent::Status {
                sequence: 2,
                received_at: Instant::now(),
                status: ControlStatus::Active {
                    voice_request_id: 31,
                    muted: false,
                    progress: None,
                },
            },
        )
        .expect("active status queues");
        send_vision_event(
            &events,
            &statuses,
            VisionEvent::Lifecycle(LifecycleState::CameraStopped),
        )
        .expect("terminal lifecycle queues");

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");
        assert_eq!(
            runtime.block_on(receiver.recv()),
            Some(VisionEvent::Lifecycle(LifecycleState::CameraStopped))
        );
    }

    #[test]
    fn a_second_hello_is_a_protocol_error() {
        let mut sequence = 0;
        assert_eq!(
            translate_event(
                HelperEvent::Hello {
                    protocol_version: PROTOCOL_VERSION,
                    session_id: SESSION,
                },
                Instant::now(),
                SESSION,
                &mut sequence,
                VisionContext::Disabled,
            ),
            Err(())
        );
    }
}
