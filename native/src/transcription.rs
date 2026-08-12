use std::io::{BufRead as _, BufReader, Write as _};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SendError, Sender};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const EVENT_CAPACITY: usize = 16;
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceCommand {
    Start {
        request_id: u64,
        locale: String,
        device: Option<String>,
    },
    Stop {
        request_id: u64,
    },
    Cancel {
        request_id: u64,
    },
    Shutdown,
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
        revision: i32,
        committed: String,
        tentative: String,
    },
    Final {
        request_id: u64,
        text: String,
    },
    Cancelled {
        request_id: u64,
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
}

pub(crate) fn coalesce_for_ui(events: impl IntoIterator<Item = VoiceEvent>) -> Vec<VoiceEvent> {
    let mut coalesced = Vec::new();
    for event in events {
        let replace_last = matches!(event, VoiceEvent::Partial { .. })
            && coalesced.last().is_some_and(|previous| {
                matches!(previous, VoiceEvent::Partial { .. })
                    && event_request_id(previous) == event_request_id(&event)
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

#[derive(Default)]
struct VoiceSupervisorState {
    active_request: Option<u64>,
    terminal_deadline: Option<(u64, Instant)>,
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
                }
            }
            VoiceCommand::Stop { request_id } | VoiceCommand::Cancel { request_id }
                if self.active_request == Some(*request_id) =>
            {
                self.terminal_deadline = Some((*request_id, now + STOP_TIMEOUT));
            }
            VoiceCommand::Stop { .. } | VoiceCommand::Cancel { .. } | VoiceCommand::Shutdown => {}
        }
    }

    fn terminal_observed(&mut self, request_id: Option<u64>) {
        if request_id.is_some_and(|request_id| {
            self.terminal_deadline
                .is_some_and(|(terminal_id, _)| terminal_id == request_id)
        }) {
            self.terminal_deadline = None;
        }
        if request_id.is_none_or(|request_id| self.active_request == Some(request_id)) {
            self.active_request = None;
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
    let mut pending_update = None;

    loop {
        flush_pending_update(&events, &mut pending_update);
        if let Some(helper) = process.as_mut() {
            while let Ok(event) = helper.events.try_recv() {
                let terminal = matches!(
                    event,
                    VoiceEvent::Final { .. }
                        | VoiceEvent::Cancelled { .. }
                        | VoiceEvent::Error { .. }
                );
                if terminal {
                    state.terminal_observed(event_request_id(&event));
                }
                publish(&events, &mut pending_update, event);
            }
            if helper.child.try_wait().ok().flatten().is_some() {
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
                process = None;
                state.terminal_deadline = None;
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
            if let Some(mut helper) = process.take() {
                let _ = helper.child.kill();
                let _ = helper.child.wait();
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
            state.terminal_deadline = None;
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
                    if helper.child.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                terminate_child(&mut helper.child);
            }
            return;
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
                VoiceCommand::Stop { request_id } => {
                    publish(
                        &events,
                        &mut pending_update,
                        VoiceEvent::Error {
                            request_id: Some(request_id),
                            code: VoiceErrorCode::NotActive,
                        },
                    );
                }
                VoiceCommand::Start { .. } | VoiceCommand::Shutdown => unreachable!(),
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
            state.terminal_deadline = None;
            continue;
        }
        state.command_sent(&command, Instant::now());
    }
}

fn publish(
    events: &tokio::sync::mpsc::Sender<VoiceEvent>,
    pending_update: &mut Option<VoiceEvent>,
    event: VoiceEvent,
) {
    if matches!(event, VoiceEvent::State { .. } | VoiceEvent::Partial { .. }) {
        match events.try_send(event) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(event)) => {
                // State and partial events are complete snapshots. Keep only the newest while
                // the UI is busy, so progress can never block the supervisor from forwarding a
                // terminal command to the helper.
                *pending_update = Some(event);
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {}
        }
    } else {
        // Terminal delivery owns session cleanup but must not make the command supervisor wait on
        // a stalled GPUI receiver. The bounded queue normally has room because snapshots coalesce;
        // on saturation, replace the pending update with this terminal and retry next loop.
        match events.try_send(event) {
            Ok(()) => {
                *pending_update = None;
            }
            Err(tokio::sync::mpsc::error::TrySendError::Full(event)) => {
                *pending_update = Some(event);
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {}
        }
    }
}

fn flush_pending_update(
    events: &tokio::sync::mpsc::Sender<VoiceEvent>,
    pending_update: &mut Option<VoiceEvent>,
) {
    let Some(update) = pending_update.take() else {
        return;
    };
    if let Err(tokio::sync::mpsc::error::TrySendError::Full(update)) = events.try_send(update) {
        *pending_update = Some(update);
    }
}

struct HelperProcess {
    child: Child,
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
            terminate_child(&mut child);
            return Err(VoiceErrorCode::HelperUnavailable);
        };
        let Some(stdout) = child.stdout.take() else {
            terminate_child(&mut child);
            return Err(VoiceErrorCode::HelperUnavailable);
        };
        let (event_tx, events) = mpsc::sync_channel(32);
        if std::thread::Builder::new()
            .name("gsv-voice-events".to_string())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else {
                        break;
                    };
                    if let Some(event) = parse_event(&line) {
                        if event_tx.send(event).is_err() {
                            break;
                        }
                    }
                }
            })
            .is_err()
        {
            terminate_child(&mut child);
            return Err(VoiceErrorCode::HelperUnavailable);
        }
        Ok(Self {
            child,
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

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        terminate_child(&mut self.child);
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
    let development_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("transcribe-helper")
        .join("target");
    let profiles = if cfg!(debug_assertions) {
        ["debug", "release"]
    } else {
        ["release", "debug"]
    };
    profiles
        .into_iter()
        .map(|profile| {
            development_root
                .join(profile)
                .join(format!("gsv-transcribe{}", std::env::consts::EXE_SUFFIX))
        })
        .find(|candidate| candidate.is_file())
        .ok_or(VoiceErrorCode::NotInstalled)
}

fn command_request_id(command: &VoiceCommand) -> Option<u64> {
    match command {
        VoiceCommand::Start { request_id, .. }
        | VoiceCommand::Stop { request_id }
        | VoiceCommand::Cancel { request_id } => Some(*request_id),
        VoiceCommand::Shutdown => None,
    }
}

fn command_starts_helper(command: &VoiceCommand) -> bool {
    matches!(command, VoiceCommand::Start { .. })
}

fn event_request_id(event: &VoiceEvent) -> Option<u64> {
    match event {
        VoiceEvent::State { request_id, .. }
        | VoiceEvent::Partial { request_id, .. }
        | VoiceEvent::Final { request_id, .. }
        | VoiceEvent::Cancelled { request_id } => Some(*request_id),
        VoiceEvent::Error { request_id, .. } => *request_id,
    }
}

fn command_json(command: &VoiceCommand) -> Value {
    match command {
        VoiceCommand::Start {
            request_id,
            locale,
            device,
        } => {
            let mut value = json!({ "type": "start", "request_id": request_id, "locale": locale });
            if let Some(device) = device {
                value["device"] = Value::String(device.clone());
            }
            value
        }
        VoiceCommand::Stop { request_id } => {
            json!({ "type": "stop", "request_id": request_id })
        }
        VoiceCommand::Cancel { request_id } => {
            json!({ "type": "cancel", "request_id": request_id })
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
            revision: value.get("revision")?.as_i64()?.try_into().ok()?,
            committed: value.get("committed")?.as_str()?.to_string(),
            tentative: value.get("tentative")?.as_str()?.to_string(),
        }),
        "final" => Some(VoiceEvent::Final {
            request_id: request_id()?,
            text: value.get("text")?.as_str()?.to_string(),
        }),
        "cancelled" => Some(VoiceEvent::Cancelled {
            request_id: request_id()?,
        }),
        "error" => Some(VoiceEvent::Error {
            request_id: request_id(),
            code: parse_error_code(value.get("code")?.as_str()?)?,
        }),
        _ => None,
    }
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
            r#"{"type":"partial","request_id":9,"revision":3,"committed":"hello ","tentative":"world"}"#,
        );
        assert_eq!(
            event,
            Some(VoiceEvent::Partial {
                request_id: 9,
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
        });
        assert!(value.get("model").is_none());
        assert!(value.get("backend").is_none());
        assert_eq!(
            value.get("device").and_then(Value::as_str),
            Some("Studio microphone")
        );
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
        assert!(command_starts_helper(&VoiceCommand::Start {
            request_id: 8,
            locale: "auto".to_string(),
            device: None,
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
        let mut pending = None;
        publish(
            &events,
            &mut pending,
            VoiceEvent::Partial {
                request_id: 1,
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
                revision: 2,
                committed: "two".to_string(),
                tentative: String::new(),
            },
        );
        assert!(matches!(
            pending,
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
        assert!(pending.is_none());
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
        let mut pending = None;
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
            pending,
            Some(VoiceEvent::State {
                phase: VoicePhase::Verifying,
                ..
            })
        ));

        let _ = received.try_recv().expect("queued state");
        flush_pending_update(&events, &mut pending);
        assert!(pending.is_none());
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
    fn ui_batches_coalesce_only_consecutive_snapshots_for_the_same_request() {
        let partial = |request_id, revision, text: &str| VoiceEvent::Partial {
            request_id,
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
    fn replacement_request_owns_lifecycle_while_the_cancelled_request_finishes() {
        let now = Instant::now();
        let mut state = VoiceSupervisorState::default();
        state.command_sent(
            &VoiceCommand::Start {
                request_id: 1,
                locale: "auto".to_string(),
                device: None,
            },
            now,
        );
        state.command_sent(&VoiceCommand::Cancel { request_id: 1 }, now);
        state.command_sent(
            &VoiceCommand::Start {
                request_id: 2,
                locale: "auto".to_string(),
                device: None,
            },
            now,
        );
        state.terminal_observed(Some(1));

        assert_eq!(state.active_request, Some(2));
        assert!(state.terminal_deadline.is_none());
    }
}
