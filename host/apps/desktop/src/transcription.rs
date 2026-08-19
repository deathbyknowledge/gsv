use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SendError, Sender};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const EVENT_CAPACITY: usize = 16;
const RELIABLE_EVENT_CAPACITY: usize = 16;
const HELPER_EVENT_MAX_BYTES: usize = 128 * 1024;
pub const MAX_DEVICE_COUNT: usize = 32;
pub const MAX_DEVICE_NAME_BYTES: usize = 256;
pub const MAX_DEVICE_ID_BYTES: usize = 512;
const VOICE_PROTOCOL_VERSION: u64 = 2;
const VOICE_PROTOCOL_CONTRACT: &str = "gsv-voice-v2-continuous-segments";
const HELPER_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const DEVICE_LIST_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const SEGMENT_COMMIT_TIMEOUT: Duration = Duration::from_secs(30);
const MUTE_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceCommand {
    Start {
        request_id: u64,
        locale: String,
        device: Option<String>,
        device_id: Option<String>,
        exact_device: bool,
    },
    Stop {
        request_id: u64,
    },
    CommitSegment {
        request_id: u64,
        segment_id: u64,
    },
    Cancel {
        request_id: u64,
    },
    SetMuted {
        request_id: u64,
        muted: bool,
    },
    ListDevices {
        request_id: u64,
    },
    Shutdown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoicePhase {
    Downloading,
    Verifying,
    Loading,
    Listening,
    Finishing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceErrorCode {
    NotInstalled,
    HelperUnavailable,
    MicrophoneUnavailable,
    MicrophoneSilent,
    AudioOverflow,
    DownloadFailed,
    ModelInvalid,
    EngineFailed,
    Busy,
    NotActive,
    Interrupted,
    InvalidCommand,
}

#[derive(Clone, Debug, PartialEq)]
pub enum VoiceEvent {
    State {
        request_id: u64,
        phase: VoicePhase,
        progress: Option<f32>,
    },
    Partial {
        request_id: u64,
        segment_id: u64,
        revision: i32,
        committed: String,
        tentative: String,
    },
    MuteState {
        request_id: u64,
        revision: u64,
        muted: bool,
    },
    Final {
        request_id: u64,
        text: String,
    },
    SegmentFinal {
        request_id: u64,
        segment_id: u64,
        text: String,
    },
    Cancelled {
        request_id: u64,
    },
    Devices {
        request_id: u64,
        devices: Vec<VoiceDevice>,
    },
    Error {
        request_id: Option<u64>,
        code: VoiceErrorCode,
    },
}

pub struct VoiceHandle {
    pub commands: VoiceCommandSender,
    pub events: tokio::sync::mpsc::Receiver<VoiceEvent>,
}

#[derive(Clone)]
pub struct VoiceCommandSender(Sender<VoiceCommand>);

impl VoiceCommandSender {
    pub fn send(&self, command: VoiceCommand) -> Result<(), SendError<VoiceCommand>> {
        self.0.send(command)
    }

    #[cfg(test)]
    pub(crate) fn closed_for_test() -> Self {
        let (sender, receiver) = mpsc::channel();
        drop(receiver);
        Self(sender)
    }

    #[cfg(test)]
    pub(crate) fn channel_for_test() -> (Self, Receiver<VoiceCommand>) {
        let (sender, receiver) = mpsc::channel();
        (Self(sender), receiver)
    }
}

pub(crate) fn coalesce_for_ui(events: impl IntoIterator<Item = VoiceEvent>) -> Vec<VoiceEvent> {
    let mut coalesced = Vec::new();
    for event in events {
        let replace_last = matches!(event, VoiceEvent::Partial { .. })
            && coalesced.last().is_some_and(|previous| {
                matches!(previous, VoiceEvent::Partial { .. })
                    && partial_scope(previous) == partial_scope(&event)
            });
        if replace_last {
            if let Some(previous) = coalesced.last_mut() {
                *previous = event;
            }
        } else {
            coalesced.push(event);
        }
    }
    coalesced
}

fn partial_scope(event: &VoiceEvent) -> Option<(u64, u64)> {
    match event {
        VoiceEvent::Partial {
            request_id,
            segment_id,
            ..
        } => Some((*request_id, *segment_id)),
        _ => None,
    }
}

#[derive(Default)]
struct VoiceSupervisorState {
    active_request: Option<u64>,
    device_request: Option<u64>,
    device_deadline: Option<(u64, Instant)>,
    terminal_deadline: Option<(u64, Instant)>,
    segment_commit: Option<PendingSegmentCommit>,
    mute_ack: Option<PendingMuteAck>,
    mute_revision: Option<(u64, u64)>,
}

#[derive(Clone, Copy)]
struct PendingSegmentCommit {
    request_id: u64,
    segment_id: u64,
    deadline: Instant,
}

#[derive(Clone, Copy)]
struct PendingMuteAck {
    request_id: u64,
    muted: bool,
    after_revision: u64,
    deadline: Instant,
}

impl VoiceSupervisorState {
    fn command_sent(&mut self, command: &VoiceCommand, now: Instant) {
        match command {
            VoiceCommand::Start { request_id, .. } => {
                if self.active_request.is_none()
                    || self
                        .terminal_deadline
                        .is_some_and(|(terminal_id, _)| self.active_request == Some(terminal_id))
                {
                    self.active_request = Some(*request_id);
                    self.segment_commit = None;
                    self.mute_ack = None;
                    self.mute_revision = None;
                }
            }
            VoiceCommand::Stop { request_id } | VoiceCommand::Cancel { request_id }
                if self.active_request == Some(*request_id) =>
            {
                self.terminal_deadline = Some((*request_id, now + STOP_TIMEOUT));
                self.segment_commit = None;
                self.mute_ack = None;
            }
            VoiceCommand::CommitSegment {
                request_id,
                segment_id,
            } if self.active_request == Some(*request_id) => {
                self.segment_commit = Some(PendingSegmentCommit {
                    request_id: *request_id,
                    segment_id: *segment_id,
                    deadline: now + SEGMENT_COMMIT_TIMEOUT,
                });
            }
            VoiceCommand::SetMuted { request_id, muted }
                if self.active_request == Some(*request_id) =>
            {
                self.mute_ack = Some(PendingMuteAck {
                    request_id: *request_id,
                    muted: *muted,
                    after_revision: self
                        .mute_revision
                        .filter(|(revision_request, _)| revision_request == request_id)
                        .map_or(0, |(_, revision)| revision),
                    deadline: now + MUTE_ACK_TIMEOUT,
                });
            }
            VoiceCommand::ListDevices { request_id } => {
                self.device_request = Some(*request_id);
                self.device_deadline = Some((*request_id, now + DEVICE_LIST_TIMEOUT));
            }
            VoiceCommand::Stop { .. }
            | VoiceCommand::CommitSegment { .. }
            | VoiceCommand::Cancel { .. }
            | VoiceCommand::SetMuted { .. }
            | VoiceCommand::Shutdown => {}
        }
    }

    fn terminal_observed(&mut self, request_id: Option<u64>, devices: bool) {
        if devices {
            if request_id == self.device_request {
                self.device_request = None;
                self.device_deadline = None;
            }
            return;
        }
        if request_id.is_some_and(|request_id| {
            self.terminal_deadline
                .is_some_and(|(terminal_id, _)| terminal_id == request_id)
        }) {
            self.terminal_deadline = None;
        }
        if request_id.is_none_or(|request_id| self.active_request == Some(request_id)) {
            self.active_request = None;
            self.segment_commit = None;
            self.mute_ack = None;
            self.mute_revision = None;
        }
        if request_id.is_none_or(|request_id| self.device_request == Some(request_id)) {
            self.device_request = None;
            self.device_deadline = None;
        }
    }

    fn segment_final_observed(&mut self, request_id: u64, segment_id: u64) {
        if self.segment_commit.is_some_and(|pending| {
            pending.request_id == request_id && pending.segment_id == segment_id
        }) {
            self.segment_commit = None;
        }
    }

    fn mute_state_observed(&mut self, request_id: u64, revision: u64, muted: bool) {
        if self.mute_ack.is_some_and(|pending| {
            pending.request_id == request_id
                && revision > pending.after_revision
                && pending.muted == muted
        }) {
            self.mute_ack = None;
        }
        let replace_revision = self
            .mute_revision
            .is_none_or(|(seen_request, seen_revision)| {
                seen_request != request_id || revision > seen_revision
            });
        if replace_revision {
            self.mute_revision = Some((request_id, revision));
        }
    }

    fn expired_control_request(&self, now: Instant) -> Option<u64> {
        self.segment_commit
            .filter(|pending| now >= pending.deadline)
            .map(|pending| pending.request_id)
            .or_else(|| {
                self.mute_ack
                    .filter(|pending| now >= pending.deadline)
                    .map(|pending| pending.request_id)
            })
    }

    fn conflicts(&self, command: &VoiceCommand) -> bool {
        match command {
            VoiceCommand::ListDevices { .. } => {
                self.active_request.is_some() || self.device_request.is_some()
            }
            VoiceCommand::Start { .. } => self.device_request.is_some(),
            VoiceCommand::CommitSegment { .. } => self.segment_commit.is_some(),
            VoiceCommand::SetMuted { .. } => self.mute_ack.is_some(),
            VoiceCommand::Stop { .. } | VoiceCommand::Cancel { .. } | VoiceCommand::Shutdown => {
                false
            }
        }
    }
}

pub fn start() -> VoiceHandle {
    let (commands, command_rx) = mpsc::channel();
    let (events, event_rx) = tokio::sync::mpsc::channel(EVENT_CAPACITY);
    // Voice input is optional. If the supervisor cannot be created, dropping
    // its captured channel endpoints leaves the returned command sender
    // disconnected so the app can report the failure when dictation is used.
    let _ = std::thread::Builder::new()
        .name("gsv-voice-supervisor".to_string())
        .spawn(move || supervise(command_rx, events));
    VoiceHandle {
        commands: VoiceCommandSender(commands),
        events: event_rx,
    }
}

fn supervise(commands: Receiver<VoiceCommand>, events: tokio::sync::mpsc::Sender<VoiceEvent>) {
    let mut process: Option<HelperProcess> = None;
    let mut state = VoiceSupervisorState::default();
    let mut pending_update = PendingVoiceEvents::default();

    loop {
        recover_delivery_overflow(&mut process, &mut state, &mut pending_update);
        flush_pending_update(&events, &mut pending_update);
        if let Some(helper) = process.as_mut() {
            while let Ok(mut event) = helper.events.try_recv() {
                if let VoiceEvent::Error {
                    request_id: request_id @ None,
                    ..
                } = &mut event
                {
                    *request_id = match (state.active_request, state.device_request) {
                        (None, Some(request_id)) | (Some(request_id), None) => Some(request_id),
                        _ => None,
                    };
                }
                let request_id = event_request_id(&event);
                match &event {
                    VoiceEvent::SegmentFinal {
                        request_id,
                        segment_id,
                        ..
                    } => state.segment_final_observed(*request_id, *segment_id),
                    VoiceEvent::MuteState {
                        request_id,
                        revision,
                        muted,
                    } => state.mute_state_observed(*request_id, *revision, *muted),
                    _ => {}
                }
                let device_terminal = matches!(event, VoiceEvent::Devices { .. })
                    || matches!(event, VoiceEvent::Error { .. })
                        && request_id == state.device_request;
                let terminal = device_terminal
                    || matches!(
                        event,
                        VoiceEvent::Final { .. }
                            | VoiceEvent::Cancelled { .. }
                            | VoiceEvent::Error { .. }
                    );
                if terminal {
                    state.terminal_observed(request_id, device_terminal);
                }
                publish(&events, &mut pending_update, event);
            }
            if helper
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
                .is_some()
            {
                if state.active_request.is_some() {
                    publish(
                        &events,
                        &mut pending_update,
                        VoiceEvent::Error {
                            request_id: state.active_request.take(),
                            code: VoiceErrorCode::Interrupted,
                        },
                    );
                }
                if let Some(request_id) = state.device_request.take() {
                    publish(
                        &events,
                        &mut pending_update,
                        VoiceEvent::Error {
                            request_id: Some(request_id),
                            code: VoiceErrorCode::Interrupted,
                        },
                    );
                }
                state.device_deadline = None;
                process = None;
                state.terminal_deadline = None;
                state.segment_commit = None;
                state.mute_ack = None;
                state.mute_revision = None;
            }
        }

        if state
            .terminal_deadline
            .is_some_and(|(_, deadline)| Instant::now() >= deadline)
        {
            let request_id = state.terminal_deadline.map(|(request_id, _)| request_id);
            let interrupted_active = state
                .active_request
                .filter(|active| Some(*active) != request_id);
            if let Some(helper) = process.take() {
                terminate_helper_and_reap(helper);
            }
            publish(
                &events,
                &mut pending_update,
                VoiceEvent::Error {
                    request_id,
                    code: VoiceErrorCode::Interrupted,
                },
            );
            if state.active_request == request_id {
                state.active_request = None;
            }
            if let Some(active_request_id) = interrupted_active {
                publish(
                    &events,
                    &mut pending_update,
                    VoiceEvent::Error {
                        request_id: Some(active_request_id),
                        code: VoiceErrorCode::Interrupted,
                    },
                );
                state.active_request = None;
            }
            if let Some(device_request_id) = state.device_request.take() {
                publish(
                    &events,
                    &mut pending_update,
                    VoiceEvent::Error {
                        request_id: Some(device_request_id),
                        code: VoiceErrorCode::Interrupted,
                    },
                );
            }
            state.terminal_deadline = None;
        }

        if let Some(request_id) = state.expired_control_request(Instant::now()) {
            if let Some(helper) = process.take() {
                terminate_helper_and_reap(helper);
            }
            state = VoiceSupervisorState::default();
            publish(
                &events,
                &mut pending_update,
                VoiceEvent::Error {
                    request_id: Some(request_id),
                    code: VoiceErrorCode::Interrupted,
                },
            );
        }

        if state
            .device_deadline
            .is_some_and(|(_, deadline)| Instant::now() >= deadline)
        {
            let request_id = state.device_request.take();
            if let Some(helper) = process.take() {
                terminate_helper_and_reap(helper);
            }
            publish(
                &events,
                &mut pending_update,
                VoiceEvent::Error {
                    request_id,
                    code: VoiceErrorCode::Interrupted,
                },
            );
            state.device_deadline = None;
        }

        let command = match commands.recv_timeout(Duration::from_millis(20)) {
            Ok(command) => command,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => VoiceCommand::Shutdown,
        };
        if command == VoiceCommand::Shutdown {
            if let Some(mut helper) = process.take() {
                let _ = helper.send(&command);
                let deadline = Instant::now() + SHUTDOWN_GRACE;
                while Instant::now() < deadline {
                    if helper
                        .child
                        .as_mut()
                        .and_then(|child| child.try_wait().ok().flatten())
                        .is_some()
                    {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                terminate_helper_and_reap(helper);
            }
            return;
        }

        if let VoiceCommand::Cancel { request_id } = command {
            if state.device_request == Some(request_id) {
                if let Some(helper) = process.take() {
                    terminate_helper_and_reap(helper);
                }
                state.device_request = None;
                state.device_deadline = None;
                publish(
                    &events,
                    &mut pending_update,
                    VoiceEvent::Cancelled { request_id },
                );
                continue;
            }
        }

        if state.conflicts(&command) {
            publish(
                &events,
                &mut pending_update,
                VoiceEvent::Error {
                    request_id: command_request_id(&command),
                    code: VoiceErrorCode::Busy,
                },
            );
            continue;
        }

        if process.is_none() && !command_starts_helper(&command) {
            match command {
                VoiceCommand::Cancel { request_id } => {
                    publish(
                        &events,
                        &mut pending_update,
                        VoiceEvent::Cancelled { request_id },
                    );
                }
                VoiceCommand::Stop { request_id }
                | VoiceCommand::CommitSegment { request_id, .. }
                | VoiceCommand::SetMuted { request_id, .. } => {
                    publish(
                        &events,
                        &mut pending_update,
                        VoiceEvent::Error {
                            request_id: Some(request_id),
                            code: VoiceErrorCode::NotActive,
                        },
                    );
                }
                VoiceCommand::Start { .. }
                | VoiceCommand::ListDevices { .. }
                | VoiceCommand::Shutdown => unreachable!(),
            }
            continue;
        }

        if process.is_none() {
            match HelperProcess::spawn() {
                Ok(helper) => process = Some(helper),
                Err(code) => {
                    publish(
                        &events,
                        &mut pending_update,
                        VoiceEvent::Error {
                            request_id: command_request_id(&command),
                            code,
                        },
                    );
                    continue;
                }
            }
        }
        let Some(helper) = process.as_mut() else {
            continue;
        };
        if let Err(code) = helper.send(&command) {
            publish(
                &events,
                &mut pending_update,
                VoiceEvent::Error {
                    request_id: command_request_id(&command),
                    code,
                },
            );
            process = None;
            state.active_request = None;
            state.device_request = None;
            state.device_deadline = None;
            state.terminal_deadline = None;
            state.segment_commit = None;
            state.mute_ack = None;
            state.mute_revision = None;
            continue;
        }
        state.command_sent(&command, Instant::now());
    }
}

fn publish(
    events: &tokio::sync::mpsc::Sender<VoiceEvent>,
    pending: &mut PendingVoiceEvents,
    event: VoiceEvent,
) {
    if pending.overflowed {
        return;
    }
    if matches!(event, VoiceEvent::State { .. } | VoiceEvent::Partial { .. }) {
        if pending.snapshot.is_some() || !pending.reliable.is_empty() {
            pending.snapshot = Some(event);
            return;
        }
        match events.try_send(event) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(event)) => {
                // State and partial events are complete snapshots. Keep only the newest while
                // the UI is busy, so progress can never block the supervisor from forwarding a
                // terminal command to the helper.
                pending.snapshot = Some(event);
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                pending.snapshot = None;
            }
        }
    } else {
        // Mute acknowledgements, segment boundaries, and terminal events are
        // authoritative and may never replace one another. Queue them in helper
        // order without blocking the supervisor; coalescible snapshots use
        // their own latest-value lane.
        if matches!(
            event,
            VoiceEvent::SegmentFinal { .. }
                | VoiceEvent::Final { .. }
                | VoiceEvent::Cancelled { .. }
                | VoiceEvent::Devices { .. }
                | VoiceEvent::Error { .. }
        ) {
            pending.snapshot = None;
        }
        if !pending.reliable.is_empty() {
            pending.push_reliable(event);
            return;
        }
        match events.try_send(event) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(event)) => {
                pending.push_reliable(event);
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                pending.reliable.clear();
                pending.snapshot = None;
            }
        }
    }
}

#[derive(Default)]
struct PendingVoiceEvents {
    reliable: VecDeque<VoiceEvent>,
    snapshot: Option<VoiceEvent>,
    overflowed: bool,
    overflow_request: Option<u64>,
}

impl PendingVoiceEvents {
    fn push_reliable(&mut self, event: VoiceEvent) {
        if self.reliable.len() >= RELIABLE_EVENT_CAPACITY {
            self.overflow_request = event_request_id(&event)
                .or_else(|| self.reliable.back().and_then(event_request_id));
            self.reliable.clear();
            self.snapshot = None;
            self.overflowed = true;
        } else {
            self.reliable.push_back(event);
        }
    }

    fn take_overflowed(&mut self) -> bool {
        std::mem::take(&mut self.overflowed)
    }
}

fn recover_delivery_overflow(
    process: &mut Option<HelperProcess>,
    state: &mut VoiceSupervisorState,
    pending: &mut PendingVoiceEvents,
) {
    if !pending.take_overflowed() {
        return;
    }
    if let Some(helper) = process.take() {
        terminate_helper_and_reap(helper);
    }
    let request_id = pending
        .overflow_request
        .take()
        .or(state.active_request)
        .or(state.device_request);
    *state = VoiceSupervisorState::default();
    // Overflow discarded the ambiguous backlog. Replace it with exactly one
    // bounded failure so the UI can fail the affected request closed.
    pending.reliable.push_back(VoiceEvent::Error {
        request_id,
        code: VoiceErrorCode::Interrupted,
    });
}

fn flush_pending_update(
    events: &tokio::sync::mpsc::Sender<VoiceEvent>,
    pending: &mut PendingVoiceEvents,
) {
    while let Some(event) = pending.reliable.pop_front() {
        match events.try_send(event) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(event)) => {
                pending.reliable.push_front(event);
                return;
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                pending.reliable.clear();
                pending.snapshot = None;
                return;
            }
        }
    }
    let Some(snapshot) = pending.snapshot.take() else {
        return;
    };
    if let Err(tokio::sync::mpsc::error::TrySendError::Full(snapshot)) = events.try_send(snapshot) {
        pending.snapshot = Some(snapshot);
    }
}

struct HelperProcess {
    child: Option<Child>,
    stdin: ChildStdin,
    events: Receiver<VoiceEvent>,
}

impl HelperProcess {
    fn spawn() -> Result<Self, VoiceErrorCode> {
        let executable = helper_executable()?;
        let mut child = Command::new(&executable)
            .env("OPENBLAS_NUM_THREADS", "1")
            .env("OMP_NUM_THREADS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| VoiceErrorCode::HelperUnavailable)?;
        let Some(stdin) = child.stdin.take() else {
            terminate_and_reap(child);
            return Err(VoiceErrorCode::HelperUnavailable);
        };
        let Some(stdout) = child.stdout.take() else {
            terminate_and_reap(child);
            return Err(VoiceErrorCode::HelperUnavailable);
        };
        let (handshake_tx, handshake_rx) = mpsc::sync_channel(1);
        let (event_tx, events) = mpsc::sync_channel(32);
        if std::thread::Builder::new()
            .name("gsv-voice-events".to_string())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = Vec::new();
                let handshake = matches!(
                    read_bounded_line(&mut reader, &mut line, HELPER_EVENT_MAX_BYTES),
                    Ok(BoundedLine::Line)
                ) && std::str::from_utf8(&line)
                    .ok()
                    .is_some_and(valid_protocol_hello);
                let _ = handshake_tx.send(handshake);
                if !handshake {
                    return;
                }
                loop {
                    match read_bounded_line(&mut reader, &mut line, HELPER_EVENT_MAX_BYTES) {
                        Ok(BoundedLine::Line) => {
                            let Ok(line) = std::str::from_utf8(&line) else {
                                continue;
                            };
                            if parse_event(line).is_some_and(|event| event_tx.send(event).is_err())
                            {
                                break;
                            }
                        }
                        Ok(BoundedLine::Oversized) => continue,
                        Ok(BoundedLine::Eof) | Err(_) => break,
                    }
                }
            })
            .is_err()
        {
            terminate_and_reap(child);
            return Err(VoiceErrorCode::HelperUnavailable);
        }
        if !matches!(
            handshake_rx.recv_timeout(HELPER_HANDSHAKE_TIMEOUT),
            Ok(true)
        ) {
            terminate_and_reap(child);
            return Err(VoiceErrorCode::HelperUnavailable);
        }
        Ok(Self {
            child: Some(child),
            stdin,
            events,
        })
    }

    fn send(&mut self, command: &VoiceCommand) -> Result<(), VoiceErrorCode> {
        serde_json::to_writer(&mut self.stdin, &command_json(command))
            .map_err(|_| VoiceErrorCode::HelperUnavailable)?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| VoiceErrorCode::HelperUnavailable)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BoundedLine {
    Line,
    Oversized,
    Eof,
}

fn read_bounded_line(
    reader: &mut impl BufRead,
    line: &mut Vec<u8>,
    maximum: usize,
) -> std::io::Result<BoundedLine> {
    line.clear();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if line.is_empty() && !oversized {
                BoundedLine::Eof
            } else if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Line
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content = newline.map_or(available, |index| &available[..index]);
        if !oversized {
            let remaining = maximum.saturating_sub(line.len());
            if content.len() <= remaining {
                line.extend_from_slice(content);
            } else {
                oversized = true;
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Line
            });
        }
    }
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
}

fn terminate_and_reap(mut child: Child) {
    terminate_child(&mut child);
    // Reaping is deliberately detached: platform audio discovery can remain
    // stuck in an uninterruptible syscall even after kill. The supervisor must
    // publish cancellation/timeouts and accept later voice commands promptly.
    let _ = std::thread::Builder::new()
        .name("gsv-voice-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        });
}

fn terminate_helper_and_reap(mut helper: HelperProcess) {
    if let Some(child) = helper.child.take() {
        terminate_and_reap(child);
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            terminate_and_reap(child);
        }
    }
}

fn helper_executable() -> Result<PathBuf, VoiceErrorCode> {
    if let Some(path) = std::env::var_os("GSV_TRANSCRIBE_HELPER") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(current) = std::env::current_exe() {
        let sibling =
            current.with_file_name(format!("gsv-transcribe{}", std::env::consts::EXE_SUFFIX));
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    development_helper_candidates(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from),
        cfg!(debug_assertions),
    )
    .into_iter()
    .find(|candidate| candidate.is_file())
    .ok_or(VoiceErrorCode::NotInstalled)
}

fn development_helper_candidates(
    manifest_dir: &Path,
    target_override: Option<PathBuf>,
    debug: bool,
) -> Vec<PathBuf> {
    let workspace_root = manifest_dir.ancestors().nth(3).unwrap_or(manifest_dir);
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
                    .join(format!("gsv-transcribe{}", std::env::consts::EXE_SUFFIX))
            })
        })
        .collect()
}

fn command_request_id(command: &VoiceCommand) -> Option<u64> {
    match command {
        VoiceCommand::Start { request_id, .. }
        | VoiceCommand::Stop { request_id }
        | VoiceCommand::CommitSegment { request_id, .. }
        | VoiceCommand::Cancel { request_id }
        | VoiceCommand::SetMuted { request_id, .. }
        | VoiceCommand::ListDevices { request_id } => Some(*request_id),
        VoiceCommand::Shutdown => None,
    }
}

fn command_starts_helper(command: &VoiceCommand) -> bool {
    matches!(
        command,
        VoiceCommand::Start { .. } | VoiceCommand::ListDevices { .. }
    )
}

fn event_request_id(event: &VoiceEvent) -> Option<u64> {
    match event {
        VoiceEvent::State { request_id, .. }
        | VoiceEvent::Partial { request_id, .. }
        | VoiceEvent::MuteState { request_id, .. }
        | VoiceEvent::SegmentFinal { request_id, .. }
        | VoiceEvent::Final { request_id, .. }
        | VoiceEvent::Cancelled { request_id }
        | VoiceEvent::Devices { request_id, .. } => Some(*request_id),
        VoiceEvent::Error { request_id, .. } => *request_id,
    }
}

fn command_json(command: &VoiceCommand) -> Value {
    match command {
        VoiceCommand::Start {
            request_id,
            locale,
            device,
            device_id,
            exact_device,
        } => {
            let mut value = json!({ "type": "start", "request_id": request_id, "locale": locale });
            if let Some(device) = device {
                value["device"] = Value::String(device.clone());
            }
            if let Some(device_id) = device_id {
                value["device_id"] = Value::String(device_id.clone());
            }
            value["exact_device"] = Value::Bool(*exact_device);
            value
        }
        VoiceCommand::Stop { request_id } => {
            json!({ "type": "stop", "request_id": request_id })
        }
        VoiceCommand::CommitSegment {
            request_id,
            segment_id,
        } => {
            json!({
                "type": "commit_segment",
                "request_id": request_id,
                "segment_id": segment_id,
            })
        }
        VoiceCommand::Cancel { request_id } => {
            json!({ "type": "cancel", "request_id": request_id })
        }
        VoiceCommand::SetMuted { request_id, muted } => {
            json!({ "type": "set_muted", "request_id": request_id, "muted": muted })
        }
        VoiceCommand::ListDevices { request_id } => {
            json!({ "type": "list_devices", "request_id": request_id })
        }
        VoiceCommand::Shutdown => json!({ "type": "shutdown" }),
    }
}

fn parse_event(line: &str) -> Option<VoiceEvent> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let request_id = || value.get("request_id").and_then(Value::as_u64);
    match value.get("type").and_then(Value::as_str)? {
        "state" => Some(VoiceEvent::State {
            request_id: request_id()?,
            phase: parse_phase(value.get("phase")?.as_str()?)?,
            progress: value
                .get("progress")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
                .map(|value| value as f32),
        }),
        "partial" => Some(VoiceEvent::Partial {
            request_id: request_id()?,
            segment_id: value.get("segment_id")?.as_u64()?,
            revision: value.get("revision")?.as_i64()?.try_into().ok()?,
            committed: value.get("committed")?.as_str()?.to_string(),
            tentative: value.get("tentative")?.as_str()?.to_string(),
        }),
        "mute_state" => Some(VoiceEvent::MuteState {
            request_id: request_id()?,
            revision: value.get("revision")?.as_u64()?,
            muted: value.get("muted")?.as_bool()?,
        }),
        "final" => Some(VoiceEvent::Final {
            request_id: request_id()?,
            text: value.get("text")?.as_str()?.to_string(),
        }),
        "segment_final" => Some(VoiceEvent::SegmentFinal {
            request_id: request_id()?,
            segment_id: value.get("segment_id")?.as_u64()?,
            text: value.get("text")?.as_str()?.to_string(),
        }),
        "cancelled" => Some(VoiceEvent::Cancelled {
            request_id: request_id()?,
        }),
        "devices" => Some(VoiceEvent::Devices {
            request_id: request_id()?,
            devices: parse_devices(value.get("devices")?)?,
        }),
        "error" => Some(VoiceEvent::Error {
            request_id: request_id(),
            code: parse_error_code(value.get("code")?.as_str()?)?,
        }),
        _ => None,
    }
}

fn valid_protocol_hello(line: &str) -> bool {
    let Ok(Value::Object(value)) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    value.len() == 3
        && value.get("type").and_then(Value::as_str) == Some("hello")
        && value.get("protocol_version").and_then(Value::as_u64) == Some(VOICE_PROTOCOL_VERSION)
        && value.get("contract").and_then(Value::as_str) == Some(VOICE_PROTOCOL_CONTRACT)
}

fn parse_devices(value: &Value) -> Option<Vec<VoiceDevice>> {
    let values = value.as_array()?;
    if values.len() > MAX_DEVICE_COUNT {
        return None;
    }
    let mut ids = HashSet::with_capacity(values.len());
    values
        .iter()
        .map(|value| {
            let id = value.get("id")?.as_str()?;
            let name = value.get("name")?.as_str()?;
            if !valid_device_id(id) || !valid_device_name(name) || !ids.insert(id) {
                return None;
            }
            Some(VoiceDevice {
                id: id.to_string(),
                name: name.to_string(),
                is_default: value.get("is_default")?.as_bool()?,
            })
        })
        .collect()
}

pub fn normalized_device_name(value: &str) -> Option<String> {
    let value = value.trim();
    valid_device_name(value).then(|| value.to_string())
}

pub fn normalized_device_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (trimmed == value && valid_device_id(trimmed)).then(|| trimmed.to_string())
}

fn valid_device_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_DEVICE_NAME_BYTES
        && !value.chars().any(char::is_control)
}

fn valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_DEVICE_ID_BYTES
        && !value.chars().any(char::is_control)
        && value.trim() == value
}

fn parse_phase(value: &str) -> Option<VoicePhase> {
    match value {
        "downloading" => Some(VoicePhase::Downloading),
        "verifying" => Some(VoicePhase::Verifying),
        "loading" => Some(VoicePhase::Loading),
        "listening" => Some(VoicePhase::Listening),
        "finishing" => Some(VoicePhase::Finishing),
        _ => None,
    }
}

fn parse_error_code(value: &str) -> Option<VoiceErrorCode> {
    match value {
        "not_installed" => Some(VoiceErrorCode::NotInstalled),
        "helper_unavailable" => Some(VoiceErrorCode::HelperUnavailable),
        "microphone_unavailable" => Some(VoiceErrorCode::MicrophoneUnavailable),
        "microphone_silent" => Some(VoiceErrorCode::MicrophoneSilent),
        "audio_overflow" => Some(VoiceErrorCode::AudioOverflow),
        "download_failed" => Some(VoiceErrorCode::DownloadFailed),
        "model_invalid" => Some(VoiceErrorCode::ModelInvalid),
        "engine_failed" => Some(VoiceErrorCode::EngineFailed),
        "busy" => Some(VoiceErrorCode::Busy),
        "not_active" => Some(VoiceErrorCode::NotActive),
        "interrupted" => Some(VoiceErrorCode::Interrupted),
        "invalid_command" => Some(VoiceErrorCode::InvalidCommand),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_parser_preserves_committed_and_tentative_text() {
        let event = parse_event(
            r#"{"type":"partial","request_id":9,"segment_id":2,"revision":3,"committed":"hello ","tentative":"world"}"#,
        );
        assert_eq!(
            event,
            Some(VoiceEvent::Partial {
                request_id: 9,
                segment_id: 2,
                revision: 3,
                committed: "hello ".to_string(),
                tentative: "world".to_string(),
            })
        );
    }

    #[test]
    fn helper_commands_do_not_expose_models_or_backends() {
        let value = command_json(&VoiceCommand::Start {
            request_id: 2,
            locale: "auto".to_string(),
            device: Some("Studio microphone".to_string()),
            device_id: None,
            exact_device: true,
        });
        assert!(value.get("model").is_none());
        assert!(value.get("backend").is_none());
        assert_eq!(
            value.get("device").and_then(Value::as_str),
            Some("Studio microphone")
        );
        assert_eq!(
            value.get("exact_device").and_then(Value::as_bool),
            Some(true)
        );
        assert!(value.get("device_id").is_none());
        let selected_by_id = command_json(&VoiceCommand::Start {
            request_id: 4,
            locale: "auto".to_string(),
            device: None,
            device_id: Some("opaque-device-id".to_string()),
            exact_device: true,
        });
        assert_eq!(
            selected_by_id.get("device_id").and_then(Value::as_str),
            Some("opaque-device-id")
        );
        assert!(selected_by_id.get("device").is_none());
        assert_eq!(
            command_json(&VoiceCommand::Start {
                request_id: 3,
                locale: "auto".to_string(),
                device: Some("studio".to_string()),
                device_id: None,
                exact_device: false,
            })
            .get("exact_device")
            .and_then(Value::as_bool),
            Some(false)
        );

        let mute = command_json(&VoiceCommand::SetMuted {
            request_id: 2,
            muted: true,
        });
        assert_eq!(mute["type"], "set_muted");
        assert_eq!(mute["request_id"], 2);
        assert_eq!(mute["muted"], true);
        assert_eq!(mute.as_object().map(|value| value.len()), Some(3));

        let commit = command_json(&VoiceCommand::CommitSegment {
            request_id: 2,
            segment_id: 7,
        });
        assert_eq!(commit["type"], "commit_segment");
        assert_eq!(commit["request_id"], 2);
        assert_eq!(commit["segment_id"], 7);
        assert_eq!(commit.as_object().map(|value| value.len()), Some(3));
    }

    #[test]
    fn stale_terminal_events_carry_correlation_without_starting_work() {
        assert_eq!(
            event_request_id(&VoiceEvent::Cancelled { request_id: 7 }),
            Some(7)
        );
        assert!(!command_starts_helper(&VoiceCommand::Cancel {
            request_id: 7
        }));
        assert!(!command_starts_helper(&VoiceCommand::Stop {
            request_id: 7
        }));
        assert!(!command_starts_helper(&VoiceCommand::CommitSegment {
            request_id: 7,
            segment_id: 0,
        }));
        assert!(!command_starts_helper(&VoiceCommand::SetMuted {
            request_id: 7,
            muted: true,
        }));
        assert!(command_starts_helper(&VoiceCommand::Start {
            request_id: 8,
            locale: "auto".to_string(),
            device: None,
            device_id: None,
            exact_device: false,
        }));
        assert!(command_starts_helper(&VoiceCommand::ListDevices {
            request_id: 9
        }));
    }

    #[test]
    fn partial_backpressure_keeps_the_latest_complete_snapshot() {
        let (events, mut received) = tokio::sync::mpsc::channel(1);
        events
            .try_send(VoiceEvent::State {
                request_id: 1,
                phase: VoicePhase::Listening,
                progress: None,
            })
            .expect("the test channel should accept its first event");
        let mut pending = PendingVoiceEvents::default();
        publish(
            &events,
            &mut pending,
            VoiceEvent::Partial {
                request_id: 1,
                segment_id: 0,
                revision: 1,
                committed: "one".to_string(),
                tentative: String::new(),
            },
        );
        publish(
            &events,
            &mut pending,
            VoiceEvent::Partial {
                request_id: 1,
                segment_id: 0,
                revision: 2,
                committed: "two".to_string(),
                tentative: String::new(),
            },
        );
        assert!(matches!(
            pending.snapshot.as_ref(),
            Some(VoiceEvent::Partial { revision: 2, .. })
        ));

        assert!(matches!(
            received.try_recv(),
            Ok(VoiceEvent::State {
                request_id: 1,
                phase: VoicePhase::Listening,
                ..
            })
        ));
        flush_pending_update(&events, &mut pending);
        assert!(pending.snapshot.is_none());
        assert!(matches!(
            received.try_recv(),
            Ok(VoiceEvent::Partial { revision: 2, .. })
        ));
    }

    #[test]
    fn state_backpressure_never_blocks_and_keeps_the_latest_phase() {
        let (events, mut received) = tokio::sync::mpsc::channel(1);
        events
            .try_send(VoiceEvent::State {
                request_id: 4,
                phase: VoicePhase::Downloading,
                progress: Some(0.1),
            })
            .expect("the test channel should accept its first event");
        let mut pending = PendingVoiceEvents::default();
        publish(
            &events,
            &mut pending,
            VoiceEvent::State {
                request_id: 4,
                phase: VoicePhase::Downloading,
                progress: Some(0.6),
            },
        );
        publish(
            &events,
            &mut pending,
            VoiceEvent::State {
                request_id: 4,
                phase: VoicePhase::Verifying,
                progress: None,
            },
        );
        assert!(matches!(
            pending.snapshot.as_ref(),
            Some(VoiceEvent::State {
                phase: VoicePhase::Verifying,
                ..
            })
        ));

        let _ = received.try_recv().expect("queued state");
        flush_pending_update(&events, &mut pending);
        assert!(pending.snapshot.is_none());
        assert!(matches!(
            received.try_recv(),
            Ok(VoiceEvent::State {
                request_id: 4,
                phase: VoicePhase::Verifying,
                ..
            })
        ));
    }

    #[test]
    fn reliable_backpressure_is_ordered_bounded_and_fails_closed_on_overflow() {
        let (events, _received) = tokio::sync::mpsc::channel(1);
        events
            .try_send(VoiceEvent::State {
                request_id: 7,
                phase: VoicePhase::Listening,
                progress: None,
            })
            .expect("fill UI channel");
        let mut pending = PendingVoiceEvents::default();
        for revision in 0..2 {
            publish(
                &events,
                &mut pending,
                VoiceEvent::Partial {
                    request_id: 7,
                    segment_id: 0,
                    revision,
                    committed: revision.to_string(),
                    tentative: String::new(),
                },
            );
        }
        for revision in 0..RELIABLE_EVENT_CAPACITY as u64 {
            publish(
                &events,
                &mut pending,
                VoiceEvent::MuteState {
                    request_id: 7,
                    revision,
                    muted: revision % 2 == 0,
                },
            );
        }
        assert!(matches!(
            pending.snapshot.as_ref(),
            Some(VoiceEvent::Partial { revision: 1, .. })
        ));
        assert_eq!(pending.reliable.len(), RELIABLE_EVENT_CAPACITY);
        assert!(pending
            .reliable
            .iter()
            .enumerate()
            .all(|(index, event)| matches!(
                event,
                VoiceEvent::MuteState { revision, .. } if *revision == index as u64
            )));

        publish(
            &events,
            &mut pending,
            VoiceEvent::Final {
                request_id: 7,
                text: "terminal".to_string(),
            },
        );
        assert!(pending.overflowed);
        assert!(pending.reliable.is_empty());
        assert!(pending.snapshot.is_none());

        let mut process = None;
        // A terminal event may already have cleared supervisor state before its
        // delivery overflows, so the bounded lane retains only its public ID.
        let mut state = VoiceSupervisorState::default();
        recover_delivery_overflow(&mut process, &mut state, &mut pending);
        assert_eq!(state.active_request, None);
        assert!(!pending.overflowed);
        assert_eq!(
            pending.reliable.pop_front(),
            Some(VoiceEvent::Error {
                request_id: Some(7),
                code: VoiceErrorCode::Interrupted,
            })
        );
        assert!(pending.reliable.is_empty());
    }

    #[test]
    fn mute_ack_and_terminal_keep_order_and_supersede_a_stale_snapshot() {
        let (events, mut received) = tokio::sync::mpsc::channel(1);
        events
            .try_send(VoiceEvent::State {
                request_id: 3,
                phase: VoicePhase::Listening,
                progress: None,
            })
            .expect("fill UI channel");
        let mut pending = PendingVoiceEvents::default();
        publish(
            &events,
            &mut pending,
            VoiceEvent::Partial {
                request_id: 3,
                segment_id: 0,
                revision: 1,
                committed: "stale".to_string(),
                tentative: String::new(),
            },
        );
        publish(
            &events,
            &mut pending,
            VoiceEvent::MuteState {
                request_id: 3,
                revision: 1,
                muted: true,
            },
        );
        publish(
            &events,
            &mut pending,
            VoiceEvent::Final {
                request_id: 3,
                text: "final".to_string(),
            },
        );
        assert!(pending.snapshot.is_none());
        assert_eq!(pending.reliable.len(), 2);

        let _ = received.try_recv().expect("initial state");
        flush_pending_update(&events, &mut pending);
        assert!(matches!(
            received.try_recv(),
            Ok(VoiceEvent::MuteState {
                request_id: 3,
                revision: 1,
                muted: true,
            })
        ));
        flush_pending_update(&events, &mut pending);
        assert!(matches!(
            received.try_recv(),
            Ok(VoiceEvent::Final { request_id: 3, text }) if text == "final"
        ));
        assert!(pending.reliable.is_empty());
    }

    #[test]
    fn segment_final_is_a_reliable_nonterminal_snapshot_barrier() {
        let (events, mut received) = tokio::sync::mpsc::channel(1);
        events
            .try_send(VoiceEvent::State {
                request_id: 3,
                phase: VoicePhase::Listening,
                progress: None,
            })
            .expect("fill UI channel");
        let mut pending = PendingVoiceEvents::default();
        publish(
            &events,
            &mut pending,
            VoiceEvent::Partial {
                request_id: 3,
                segment_id: 0,
                revision: 4,
                committed: "stale tail".to_string(),
                tentative: String::new(),
            },
        );
        publish(
            &events,
            &mut pending,
            VoiceEvent::SegmentFinal {
                request_id: 3,
                segment_id: 0,
                text: "authoritative".to_string(),
            },
        );
        publish(
            &events,
            &mut pending,
            VoiceEvent::Partial {
                request_id: 3,
                segment_id: 1,
                revision: 1,
                committed: "next".to_string(),
                tentative: String::new(),
            },
        );

        assert_eq!(pending.reliable.len(), 1);
        assert!(matches!(
            pending.snapshot.as_ref(),
            Some(VoiceEvent::Partial { segment_id: 1, .. })
        ));
        let _ = received.try_recv().expect("initial state");
        flush_pending_update(&events, &mut pending);
        assert!(matches!(
            received.try_recv(),
            Ok(VoiceEvent::SegmentFinal {
                request_id: 3,
                segment_id: 0,
                text,
            }) if text == "authoritative"
        ));
        flush_pending_update(&events, &mut pending);
        assert!(matches!(
            received.try_recv(),
            Ok(VoiceEvent::Partial {
                request_id: 3,
                segment_id: 1,
                ..
            })
        ));
    }

    #[test]
    fn ui_batches_coalesce_only_consecutive_snapshots_for_the_same_request() {
        let partial = |request_id, revision, text: &str| VoiceEvent::Partial {
            request_id,
            segment_id: 0,
            revision,
            committed: text.to_string(),
            tentative: String::new(),
        };
        let events = coalesce_for_ui([
            VoiceEvent::State {
                request_id: 1,
                phase: VoicePhase::Listening,
                progress: None,
            },
            partial(1, 1, "old"),
            partial(1, 2, "latest"),
            VoiceEvent::Final {
                request_id: 1,
                text: "latest".to_string(),
            },
            partial(2, 1, "next request"),
        ]);
        assert_eq!(events.len(), 4);
        assert!(matches!(
            &events[1],
            VoiceEvent::Partial {
                request_id: 1,
                revision: 2,
                committed,
                ..
            } if committed == "latest"
        ));
        assert!(matches!(
            &events[3],
            VoiceEvent::Partial { request_id: 2, .. }
        ));
    }

    #[test]
    fn ui_batches_never_coalesce_across_segment_boundaries() {
        let partial = |segment_id, text: &str| VoiceEvent::Partial {
            request_id: 1,
            segment_id,
            revision: 1,
            committed: text.to_string(),
            tentative: String::new(),
        };
        let events = coalesce_for_ui([partial(0, "old"), partial(1, "new")]);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0],
            VoiceEvent::Partial { segment_id: 0, .. }
        ));
        assert!(matches!(
            events[1],
            VoiceEvent::Partial { segment_id: 1, .. }
        ));
    }

    #[test]
    fn structured_states_and_errors_are_parsed_without_diagnostics() {
        assert_eq!(
            parse_event(r#"{"type":"state","request_id":4,"phase":"downloading","progress":0.42}"#),
            Some(VoiceEvent::State {
                request_id: 4,
                phase: VoicePhase::Downloading,
                progress: Some(0.42),
            })
        );
        assert_eq!(
            parse_event(r#"{"type":"error","request_id":4,"code":"model_invalid"}"#),
            Some(VoiceEvent::Error {
                request_id: Some(4),
                code: VoiceErrorCode::ModelInvalid,
            })
        );
        assert!(parse_event(
            r#"{"type":"error","request_id":4,"code":"model_invalid","message":"/private/model"}"#
        )
        .is_some());
        assert_eq!(
            parse_event(r#"{"type":"mute_state","request_id":4,"revision":8,"muted":true}"#),
            Some(VoiceEvent::MuteState {
                request_id: 4,
                revision: 8,
                muted: true,
            })
        );
        assert!(
            parse_event(r#"{"type":"mute_state","request_id":4,"revision":-1,"muted":true}"#)
                .is_none()
        );
        assert_eq!(
            parse_event(r#"{"type":"segment_final","request_id":4,"segment_id":3,"text":"hello"}"#),
            Some(VoiceEvent::SegmentFinal {
                request_id: 4,
                segment_id: 3,
                text: "hello".to_string(),
            })
        );
    }

    #[test]
    fn helper_handshake_requires_exact_protocol_v2_hello() {
        assert!(valid_protocol_hello(
            r#"{"type":"hello","protocol_version":2,"contract":"gsv-voice-v2-continuous-segments"}"#
        ));
        assert!(!valid_protocol_hello(
            r#"{"type":"hello","protocol_version":2}"#
        ));
        assert!(!valid_protocol_hello(
            r#"{"type":"hello","protocol_version":1,"contract":"gsv-voice-v2-continuous-segments"}"#
        ));
        assert!(!valid_protocol_hello(
            r#"{"type":"hello","protocol_version":2,"contract":"stale"}"#
        ));
        assert!(!valid_protocol_hello(
            r#"{"type":"state","request_id":1,"phase":"loading"}"#
        ));
        assert!(!valid_protocol_hello(""));
        assert!(!valid_protocol_hello(
            r#"{"type":"hello","protocol_version":2,"contract":"gsv-voice-v2-continuous-segments","unexpected":true}"#
        ));
    }

    #[test]
    fn invalid_progress_and_unknown_codes_do_not_cross_the_boundary() {
        assert_eq!(
            parse_event(r#"{"type":"state","request_id":4,"phase":"downloading","progress":9.0}"#),
            Some(VoiceEvent::State {
                request_id: 4,
                phase: VoicePhase::Downloading,
                progress: None,
            })
        );
        assert!(parse_event(r#"{"type":"error","code":"private_native_error"}"#).is_none());
        assert_eq!(
            parse_event(r#"{"type":"error","request_id":4,"code":"microphone_silent"}"#),
            Some(VoiceEvent::Error {
                request_id: Some(4),
                code: VoiceErrorCode::MicrophoneSilent,
            })
        );
    }

    #[test]
    fn device_events_are_typed_and_strictly_bounded() {
        assert_eq!(
            parse_event(
                r#"{"type":"devices","request_id":5,"devices":[{"id":"builtin-id","name":"Built-in Microphone","is_default":true},{"id":"usb-id","name":"USB Mic","is_default":false}]}"#
            ),
            Some(VoiceEvent::Devices {
                request_id: 5,
                devices: vec![
                    VoiceDevice {
                        id: "builtin-id".to_string(),
                        name: "Built-in Microphone".to_string(),
                        is_default: true,
                    },
                    VoiceDevice {
                        id: "usb-id".to_string(),
                        name: "USB Mic".to_string(),
                        is_default: false,
                    },
                ],
            })
        );
        let long_name = "a".repeat(MAX_DEVICE_NAME_BYTES + 1);
        assert!(parse_event(&format!(
            r#"{{"type":"devices","request_id":5,"devices":[{{"id":"long-name","name":"{long_name}","is_default":false}}]}}"#
        ))
        .is_none());
        let too_many = (0..=MAX_DEVICE_COUNT)
            .map(|index| {
                format!(r#"{{"id":"id-{index}","name":"mic-{index}","is_default":false}}"#)
            })
            .collect::<Vec<_>>()
            .join(",");
        assert!(parse_event(&format!(
            r#"{{"type":"devices","request_id":5,"devices":[{too_many}]}}"#
        ))
        .is_none());
        assert!(parse_event(
            r#"{"type":"devices","request_id":5,"devices":[{"id":"one","name":"Same","is_default":true},{"id":"two","name":"Same","is_default":false}]}"#
        )
        .is_some());
        assert!(parse_event(
            r#"{"type":"devices","request_id":5,"devices":[{"id":"same","name":"One","is_default":true},{"id":"same","name":"Two","is_default":false}]}"#
        )
        .is_none());
    }

    #[test]
    fn helper_lines_are_bounded_and_recover_after_oversized_input() {
        let input = format!(
            "{}\n{{\"type\":\"cancelled\",\"request_id\":7}}\n",
            "x".repeat(9)
        );
        let mut reader = std::io::Cursor::new(input.into_bytes());
        let mut line = Vec::new();
        assert_eq!(
            read_bounded_line(&mut reader, &mut line, 8).expect("oversized line"),
            BoundedLine::Oversized
        );
        assert_eq!(
            read_bounded_line(&mut reader, &mut line, HELPER_EVENT_MAX_BYTES).expect("valid line"),
            BoundedLine::Line
        );
        assert_eq!(
            parse_event(std::str::from_utf8(&line).expect("UTF-8")),
            Some(VoiceEvent::Cancelled { request_id: 7 })
        );
    }

    #[test]
    fn workspace_helper_candidates_prefer_the_root_target() {
        let manifest = Path::new("/work/gsv/host/apps/desktop");
        let candidates = development_helper_candidates(manifest, None, true);
        assert_eq!(
            candidates[0],
            Path::new("/work/gsv/target/debug")
                .join(format!("gsv-transcribe{}", std::env::consts::EXE_SUFFIX))
        );
        assert_eq!(
            candidates[1],
            Path::new("/work/gsv/target/release")
                .join(format!("gsv-transcribe{}", std::env::consts::EXE_SUFFIX))
        );
        assert!(candidates
            .iter()
            .all(|candidate| !candidate.starts_with("/work/gsv/host/helpers/transcriber/target")));
    }

    #[test]
    fn replacement_request_owns_lifecycle_while_the_cancelled_request_finishes() {
        let now = Instant::now();
        let mut state = VoiceSupervisorState::default();
        state.command_sent(
            &VoiceCommand::Start {
                request_id: 1,
                locale: "auto".to_string(),
                device: None,
                device_id: None,
                exact_device: false,
            },
            now,
        );
        state.command_sent(&VoiceCommand::Cancel { request_id: 1 }, now);
        state.command_sent(
            &VoiceCommand::Start {
                request_id: 2,
                locale: "auto".to_string(),
                device: None,
                device_id: None,
                exact_device: false,
            },
            now,
        );
        state.terminal_observed(Some(1), false);

        assert_eq!(state.active_request, Some(2));
        assert!(state.terminal_deadline.is_none());
    }

    #[test]
    fn enumeration_does_not_take_or_clear_the_active_voice_request() {
        let now = Instant::now();
        let mut state = VoiceSupervisorState::default();
        state.command_sent(
            &VoiceCommand::Start {
                request_id: 1,
                locale: "auto".to_string(),
                device: None,
                device_id: None,
                exact_device: false,
            },
            now,
        );
        assert!(state.conflicts(&VoiceCommand::ListDevices { request_id: 2 }));

        state.active_request = None;
        state.command_sent(&VoiceCommand::ListDevices { request_id: 2 }, now);
        assert!(state.conflicts(&VoiceCommand::Start {
            request_id: 3,
            locale: "auto".to_string(),
            device: None,
            device_id: None,
            exact_device: false,
        }));
        state.terminal_observed(Some(2), true);
        assert_eq!(state.active_request, None);
        assert_eq!(state.device_request, None);
    }

    #[test]
    fn segment_and_mute_acknowledgements_are_nonterminal_and_correlated() {
        let now = Instant::now();
        let mut state = VoiceSupervisorState::default();
        state.command_sent(
            &VoiceCommand::Start {
                request_id: 7,
                locale: "auto".to_string(),
                device: None,
                device_id: None,
                exact_device: false,
            },
            now,
        );
        state.mute_state_observed(7, 0, false);
        state.command_sent(
            &VoiceCommand::CommitSegment {
                request_id: 7,
                segment_id: 0,
            },
            now,
        );
        assert!(state.conflicts(&VoiceCommand::CommitSegment {
            request_id: 7,
            segment_id: 1,
        }));
        state.segment_final_observed(7, 1);
        assert!(state.segment_commit.is_some());
        state.segment_final_observed(7, 0);
        assert!(state.segment_commit.is_none());
        assert_eq!(state.active_request, Some(7));

        state.command_sent(
            &VoiceCommand::SetMuted {
                request_id: 7,
                muted: true,
            },
            now,
        );
        assert!(state.conflicts(&VoiceCommand::SetMuted {
            request_id: 7,
            muted: false,
        }));
        state.mute_state_observed(7, 0, true);
        assert!(state.mute_ack.is_some());
        state.mute_state_observed(7, 1, false);
        assert!(state.mute_ack.is_some());
        state.mute_state_observed(7, 2, true);
        assert!(state.mute_ack.is_none());
        assert_eq!(state.active_request, Some(7));
    }

    #[test]
    fn control_ack_deadlines_are_bounded_and_terminal_commands_supersede_them() {
        let now = Instant::now();
        let mut state = VoiceSupervisorState::default();
        state.command_sent(
            &VoiceCommand::Start {
                request_id: 7,
                locale: "auto".to_string(),
                device: None,
                device_id: None,
                exact_device: false,
            },
            now,
        );
        state.command_sent(
            &VoiceCommand::CommitSegment {
                request_id: 7,
                segment_id: 0,
            },
            now,
        );
        state.command_sent(
            &VoiceCommand::SetMuted {
                request_id: 7,
                muted: true,
            },
            now,
        );
        assert_eq!(state.expired_control_request(now), None);
        assert_eq!(
            state.expired_control_request(now + MUTE_ACK_TIMEOUT),
            Some(7)
        );

        state.command_sent(&VoiceCommand::Stop { request_id: 7 }, now);
        assert!(state.segment_commit.is_none());
        assert!(state.mute_ack.is_none());
        assert_eq!(
            state.expired_control_request(now + SEGMENT_COMMIT_TIMEOUT),
            None
        );
    }
}
