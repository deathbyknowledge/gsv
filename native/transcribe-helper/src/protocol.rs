use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

use crate::audio::{CaptureControl, InputDeviceInfo, MuteRequest};

pub const VOICE_PROTOCOL_VERSION: u16 = 2;
/// Exact private helper/Desktop contract. Rotate this when an incompatible
/// unshipped command or event shape changes so a stale sibling fails closed.
pub const VOICE_PROTOCOL_CONTRACT: &str = "gsv-voice-v2-streaming-mute";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Start {
        request_id: u64,
        #[serde(default = "default_locale")]
        locale: String,
        #[serde(default)]
        device: Option<String>,
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        exact_device: bool,
    },
    Stop {
        request_id: u64,
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

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Downloading,
    Verifying,
    Loading,
    Listening,
    Finishing,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
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

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event<'a> {
    Hello {
        protocol_version: u16,
        contract: &'a str,
    },
    State {
        request_id: u64,
        phase: Phase,
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<f32>,
    },
    Partial {
        request_id: u64,
        revision: i32,
        committed: &'a str,
        tentative: &'a str,
    },
    MuteState {
        request_id: u64,
        revision: u64,
        muted: bool,
    },
    Final {
        request_id: u64,
        text: &'a str,
    },
    Cancelled {
        request_id: u64,
    },
    Devices {
        request_id: u64,
        devices: &'a [InputDeviceInfo],
    },
    Error {
        request_id: Option<u64>,
        code: ErrorCode,
    },
}

fn default_locale() -> String {
    "auto".to_string()
}

pub struct ReceivedCommand {
    pub command: Command,
    pub mute_request: Option<MuteRequest>,
    pub completion: CommandCompletion,
}

#[derive(Default)]
pub struct CommandCompletion(Option<crossbeam_channel::Sender<()>>);

impl CommandCompletion {
    fn new(completion: crossbeam_channel::Sender<()>) -> Self {
        Self(Some(completion))
    }
}

impl Drop for CommandCompletion {
    fn drop(&mut self) {
        if let Some(completion) = self.0.take() {
            let _ = completion.send(());
        }
    }
}

pub fn read_commands(control: CaptureControl) -> crossbeam_channel::Receiver<ReceivedCommand> {
    let (tx, rx) = crossbeam_channel::bounded(16);
    std::thread::spawn(move || {
        let stdin = io::stdin();
        read_command_lines(stdin.lock(), &tx, &control);
    });
    rx
}

fn read_command_lines(
    reader: impl BufRead,
    tx: &crossbeam_channel::Sender<ReceivedCommand>,
    control: &CaptureControl,
) {
    for line in reader.lines() {
        let Ok(line) = line else {
            break;
        };
        let command = match serde_json::from_str::<Command>(&line) {
            Ok(command) => command,
            Err(_) => {
                emit(&Event::Error {
                    request_id: None,
                    code: ErrorCode::InvalidCommand,
                });
                continue;
            }
        };
        let mute_request = match &command {
            Command::SetMuted { request_id, muted } => control.request_mute(*request_id, *muted),
            _ => None,
        };
        // Serialize SetMuted ingress with its applied acknowledgement. The
        // privacy gate above closes immediately for mute, while waiting here
        // prevents a later SetMuted from changing the generation before the
        // active loop has acknowledged this command's effective state.
        let (completion, applied) = if matches!(command, Command::SetMuted { .. }) {
            let (completion, applied) = crossbeam_channel::bounded(1);
            (CommandCompletion::new(completion), Some(applied))
        } else {
            (CommandCompletion::default(), None)
        };
        let shutdown = command == Command::Shutdown;
        let sent = tx
            .send(ReceivedCommand {
                command,
                mute_request,
                completion,
            })
            .is_ok();
        if !sent || shutdown {
            break;
        }
        if let Some(applied) = applied {
            let _ = applied.recv();
        }
    }
}

pub fn emit(event: &Event<'_>) {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if serde_json::to_writer(&mut output, event).is_ok() {
        let _ = output.write_all(b"\n");
        let _ = output.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_handshake_has_the_exact_v2_contract() {
        let event = serde_json::to_value(Event::Hello {
            protocol_version: VOICE_PROTOCOL_VERSION,
            contract: VOICE_PROTOCOL_CONTRACT,
        })
        .expect("serializable event");

        assert_eq!(event["type"], "hello");
        assert_eq!(event["protocol_version"], VOICE_PROTOCOL_VERSION);
        assert_eq!(event["contract"], VOICE_PROTOCOL_CONTRACT);
        assert_eq!(event.as_object().map(|value| value.len()), Some(3));
    }

    #[test]
    fn protocol_does_not_expose_model_backend_paths_or_messages() {
        let command: Command =
            serde_json::from_str(r#"{"type":"start","request_id":7,"locale":"nl-NL"}"#)
                .expect("valid command");
        assert_eq!(
            command,
            Command::Start {
                request_id: 7,
                locale: "nl-NL".to_string(),
                device: None,
                device_id: None,
                exact_device: false,
            }
        );

        let event = serde_json::to_value(Event::Error {
            request_id: Some(7),
            code: ErrorCode::ModelInvalid,
        })
        .expect("serializable event");
        assert_eq!(
            event.get("code").and_then(serde_json::Value::as_str),
            Some("model_invalid")
        );
        assert!(event.get("message").is_none());
        assert!(event.get("model").is_none());
        assert!(event.get("backend").is_none());
        assert!(event.get("path").is_none());
    }

    #[test]
    fn preparation_states_are_bounded_and_explicit() {
        let state = serde_json::to_value(Event::State {
            request_id: 3,
            phase: Phase::Downloading,
            progress: Some(0.25),
        })
        .expect("serializable event");
        assert_eq!(state["phase"], "downloading");
        assert_eq!(state["progress"], 0.25);
    }

    #[test]
    fn start_accepts_an_optional_microphone_without_exposing_it_in_events() {
        let command: Command =
            serde_json::from_str(r#"{"type":"start","request_id":8,"device":"Shure MV6"}"#)
                .expect("valid command");
        assert_eq!(
            command,
            Command::Start {
                request_id: 8,
                locale: "auto".to_string(),
                device: Some("Shure MV6".to_string()),
                device_id: None,
                exact_device: false,
            }
        );

        let event = serde_json::to_value(Event::Error {
            request_id: Some(8),
            code: ErrorCode::MicrophoneSilent,
        })
        .expect("serializable event");
        assert_eq!(event["code"], "microphone_silent");
        assert!(event.get("device").is_none());
    }

    #[test]
    fn start_accepts_explicit_exact_device_matching() {
        let command: Command = serde_json::from_str(
            r#"{"type":"start","request_id":9,"device":"Shure MV6","device_id":"alsa:shure","exact_device":true}"#,
        )
        .expect("valid command");
        assert_eq!(
            command,
            Command::Start {
                request_id: 9,
                locale: "auto".to_string(),
                device: Some("Shure MV6".to_string()),
                device_id: Some("alsa:shure".to_string()),
                exact_device: true,
            }
        );
    }

    #[test]
    fn mute_commands_and_acknowledgements_are_request_scoped_and_bounded() {
        let command: Command =
            serde_json::from_str(r#"{"type":"set_muted","request_id":9,"muted":true}"#)
                .expect("valid command");
        assert_eq!(
            command,
            Command::SetMuted {
                request_id: 9,
                muted: true,
            }
        );

        let event = serde_json::to_value(Event::MuteState {
            request_id: 9,
            revision: 4,
            muted: true,
        })
        .expect("serializable event");
        assert_eq!(event["type"], "mute_state");
        assert_eq!(event["request_id"], 9);
        assert_eq!(event["revision"], 4);
        assert_eq!(event["muted"], true);
        assert_eq!(event.as_object().map(|value| value.len()), Some(4));
        assert!(event.get("audio").is_none());
        assert!(event.get("diagnostics").is_none());
    }

    #[test]
    fn inactive_mute_completion_releases_the_reader_for_the_next_command() {
        let input = std::io::Cursor::new(
            concat!(
                "{\"type\":\"set_muted\",\"request_id\":9,\"muted\":true}\n",
                "{\"type\":\"start\",\"request_id\":10}\n",
                "{\"type\":\"shutdown\"}\n",
            )
            .as_bytes(),
        );
        let control = CaptureControl::default();
        let (sender, commands) = crossbeam_channel::bounded(4);
        let worker = std::thread::spawn(move || read_command_lines(input, &sender, &control));

        let inactive_mute = commands
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("mute command");
        assert!(matches!(
            inactive_mute.command,
            Command::SetMuted {
                request_id: 9,
                muted: true,
            }
        ));
        assert!(inactive_mute.mute_request.is_none());
        drop(inactive_mute);

        let next = commands
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("reader released for subsequent start");
        assert!(matches!(
            next.command,
            Command::Start { request_id: 10, .. }
        ));
        drop(next);
        assert!(matches!(
            commands
                .recv_timeout(std::time::Duration::from_secs(1))
                .expect("subsequent shutdown"),
            ReceivedCommand {
                command: Command::Shutdown,
                ..
            }
        ));
        worker.join().expect("reader worker");
    }

    #[test]
    fn device_list_commands_and_events_are_correlated_and_bounded_in_shape() {
        let command: Command = serde_json::from_str(r#"{"type":"list_devices","request_id":11}"#)
            .expect("valid command");
        assert_eq!(command, Command::ListDevices { request_id: 11 });

        let devices = vec![InputDeviceInfo {
            id: "alsa:shure".to_string(),
            name: "Shure MV6".to_string(),
            is_default: true,
        }];
        let event = serde_json::to_value(Event::Devices {
            request_id: 11,
            devices: &devices,
        })
        .expect("serializable event");
        assert_eq!(event["type"], "devices");
        assert_eq!(event["request_id"], 11);
        assert_eq!(event["devices"][0]["name"], "Shure MV6");
        assert_eq!(event["devices"][0]["id"], "alsa:shure");
        assert_eq!(event["devices"][0]["is_default"], true);
        assert_eq!(
            event["devices"][0].as_object().map(|value| value.len()),
            Some(3)
        );
        assert!(event.get("backend").is_none());
        assert!(event.get("diagnostics").is_none());
    }
}
