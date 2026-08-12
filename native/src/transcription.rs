use std::io::{BufRead as _, BufReader, Write as _};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const COMMAND_CAPACITY: usize = 8;
const EVENT_CAPACITY: usize = 16;
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceCommand {
    Start { request_id: u64, locale: String },
    Stop { request_id: u64 },
    Cancel { request_id: u64 },
    Shutdown,
}

#[derive(Clone, Debug, PartialEq)]
pub enum VoiceEvent {
    Preparing {
        request_id: u64,
        progress: Option<f32>,
    },
    Listening {
        request_id: u64,
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
        message: String,
    },
}

pub struct VoiceHandle {
    pub commands: SyncSender<VoiceCommand>,
    pub events: tokio::sync::mpsc::Receiver<VoiceEvent>,
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

pub fn start() -> VoiceHandle {
    let (commands, command_rx) = mpsc::sync_channel(COMMAND_CAPACITY);
    let (events, event_rx) = tokio::sync::mpsc::channel(EVENT_CAPACITY);
    // Voice input is optional. If the supervisor cannot be created, dropping
    // its captured channel endpoints leaves the returned command sender
    // disconnected so the app can report the failure when dictation is used.
    let _ = std::thread::Builder::new()
        .name("gsv-voice-supervisor".to_string())
        .spawn(move || supervise(command_rx, events));
    VoiceHandle {
        commands,
        events: event_rx,
    }
}

fn supervise(commands: Receiver<VoiceCommand>, events: tokio::sync::mpsc::Sender<VoiceEvent>) {
    let mut process: Option<HelperProcess> = None;
    let mut active_request = None;
    let mut terminal_deadline = None;
    let mut pending_partial = None;

    loop {
        flush_pending_partial(&events, &mut pending_partial);
        if let Some(helper) = process.as_mut() {
            while let Ok(event) = helper.events.try_recv() {
                let terminal = matches!(
                    event,
                    VoiceEvent::Final { .. }
                        | VoiceEvent::Cancelled { .. }
                        | VoiceEvent::Error { .. }
                );
                let belongs_to_active = event_request_id(&event)
                    .is_none_or(|request_id| active_request == Some(request_id));
                if terminal && belongs_to_active {
                    active_request = None;
                    terminal_deadline = None;
                }
                publish(&events, &mut pending_partial, event);
            }
            if helper.child.try_wait().ok().flatten().is_some() {
                if active_request.is_some() {
                    publish(
                        &events,
                        &mut pending_partial,
                        VoiceEvent::Error {
                            request_id: active_request.take(),
                            message: "voice input stopped unexpectedly".to_string(),
                        },
                    );
                }
                process = None;
                terminal_deadline = None;
            }
        }

        if terminal_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            if let Some(mut helper) = process.take() {
                let _ = helper.child.kill();
                let _ = helper.child.wait();
            }
            publish(
                &events,
                &mut pending_partial,
                VoiceEvent::Error {
                    request_id: active_request.take(),
                    message: "voice input did not stop and was restarted".to_string(),
                },
            );
            terminal_deadline = None;
        }

        let command = match commands.recv_timeout(Duration::from_millis(20)) {
            Ok(command) => command,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => VoiceCommand::Shutdown,
        };
        if command == VoiceCommand::Shutdown {
            if let Some(mut helper) = process.take() {
                let _ = helper.send(&command);
                let _ = helper.child.kill();
                let _ = helper.child.wait();
            }
            return;
        }

        if process.is_none() && !command_starts_helper(&command) {
            match command {
                VoiceCommand::Cancel { request_id } => {
                    publish(
                        &events,
                        &mut pending_partial,
                        VoiceEvent::Cancelled { request_id },
                    );
                }
                VoiceCommand::Stop { request_id } => {
                    publish(
                        &events,
                        &mut pending_partial,
                        VoiceEvent::Error {
                            request_id: Some(request_id),
                            message: "voice input is not active".to_string(),
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
                Err(message) => {
                    publish(
                        &events,
                        &mut pending_partial,
                        VoiceEvent::Error {
                            request_id: command_request_id(&command),
                            message,
                        },
                    );
                    continue;
                }
            }
        }
        let Some(helper) = process.as_mut() else {
            continue;
        };
        if let Err(message) = helper.send(&command) {
            publish(
                &events,
                &mut pending_partial,
                VoiceEvent::Error {
                    request_id: command_request_id(&command),
                    message,
                },
            );
            process = None;
            active_request = None;
            terminal_deadline = None;
            continue;
        }
        match command {
            VoiceCommand::Start { request_id, .. } => active_request = Some(request_id),
            VoiceCommand::Stop { request_id } | VoiceCommand::Cancel { request_id }
                if active_request == Some(request_id) =>
            {
                terminal_deadline = Some(Instant::now() + STOP_TIMEOUT);
            }
            VoiceCommand::Stop { .. } | VoiceCommand::Cancel { .. } => {}
            VoiceCommand::Shutdown => unreachable!(),
        }
    }
}

fn publish(
    events: &tokio::sync::mpsc::Sender<VoiceEvent>,
    pending_partial: &mut Option<VoiceEvent>,
    event: VoiceEvent,
) {
    if matches!(event, VoiceEvent::Partial { .. }) {
        match events.try_send(event) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(event)) => {
                // Partial events are complete snapshots. Keep only the newest
                // one while the UI is busy rather than growing work or
                // allowing the latest transcript to be lost.
                *pending_partial = Some(event);
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {}
        }
    } else {
        if let Some(partial) = pending_partial.take() {
            let _ = events.blocking_send(partial);
        }
        let _ = events.blocking_send(event);
    }
}

fn flush_pending_partial(
    events: &tokio::sync::mpsc::Sender<VoiceEvent>,
    pending_partial: &mut Option<VoiceEvent>,
) {
    let Some(partial) = pending_partial.take() else {
        return;
    };
    if let Err(tokio::sync::mpsc::error::TrySendError::Full(partial)) = events.try_send(partial) {
        *pending_partial = Some(partial);
    }
}

struct HelperProcess {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<VoiceEvent>,
}

impl HelperProcess {
    fn spawn() -> Result<Self, String> {
        let executable = helper_executable()?;
        let mut child = Command::new(&executable)
            .env("OPENBLAS_NUM_THREADS", "1")
            .env("OMP_NUM_THREADS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("voice input helper could not start: {error}"))?;
        let Some(stdin) = child.stdin.take() else {
            terminate_child(&mut child);
            return Err("voice input helper has no command channel".to_string());
        };
        let Some(stdout) = child.stdout.take() else {
            terminate_child(&mut child);
            return Err("voice input helper has no event channel".to_string());
        };
        let (event_tx, events) = mpsc::sync_channel(32);
        if let Err(error) = std::thread::Builder::new()
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
        {
            terminate_child(&mut child);
            return Err(format!("voice input event reader could not start: {error}"));
        }
        Ok(Self {
            child,
            stdin,
            events,
        })
    }

    fn send(&mut self, command: &VoiceCommand) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, &command_json(command))
            .map_err(|error| format!("voice input command could not be written: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("voice input helper disconnected: {error}"))
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

fn helper_executable() -> Result<PathBuf, String> {
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
    ["release", "debug"]
        .into_iter()
        .map(|profile| {
            development_root
                .join(profile)
                .join(format!("gsv-transcribe{}", std::env::consts::EXE_SUFFIX))
        })
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "voice input is not installed; build the gsv-transcribe helper".to_string())
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
        VoiceEvent::Preparing { request_id, .. }
        | VoiceEvent::Listening { request_id }
        | VoiceEvent::Partial { request_id, .. }
        | VoiceEvent::Final { request_id, .. }
        | VoiceEvent::Cancelled { request_id } => Some(*request_id),
        VoiceEvent::Error { request_id, .. } => *request_id,
    }
}

fn command_json(command: &VoiceCommand) -> Value {
    match command {
        VoiceCommand::Start { request_id, locale } => {
            json!({ "type": "start", "request_id": request_id, "locale": locale })
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
        "preparing" => Some(VoiceEvent::Preparing {
            request_id: request_id()?,
            progress: value
                .get("progress")
                .and_then(Value::as_f64)
                .map(|v| v as f32),
        }),
        "listening" => Some(VoiceEvent::Listening {
            request_id: request_id()?,
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
            message: value.get("message")?.as_str()?.to_string(),
        }),
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
        });
        assert!(value.get("model").is_none());
        assert!(value.get("backend").is_none());
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
        }));
    }

    #[test]
    fn partial_backpressure_keeps_the_latest_complete_snapshot() {
        let (events, mut received) = tokio::sync::mpsc::channel(1);
        events
            .try_send(VoiceEvent::Listening { request_id: 1 })
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
            Ok(VoiceEvent::Listening { request_id: 1 })
        ));
        flush_pending_partial(&events, &mut pending);
        assert!(pending.is_none());
        assert!(matches!(
            received.try_recv(),
            Ok(VoiceEvent::Partial { revision: 2, .. })
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
            VoiceEvent::Listening { request_id: 1 },
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
}
