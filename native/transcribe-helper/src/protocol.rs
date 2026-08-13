use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

use crate::audio::InputDeviceInfo;

pub const VOICE_PROTOCOL_VERSION: u16 = 2;

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

pub fn read_commands() -> crossbeam_channel::Receiver<Command> {
    let (tx, rx) = crossbeam_channel::bounded(16);
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
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
            let shutdown = command == Command::Shutdown;
            if tx.send(command).is_err() || shutdown {
                break;
            }
        }
    });
    rx
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
    fn startup_handshake_has_an_explicit_version_and_no_private_fields() {
        let event = serde_json::to_value(Event::Hello {
            protocol_version: VOICE_PROTOCOL_VERSION,
        })
        .expect("serializable event");

        assert_eq!(event["type"], "hello");
        assert_eq!(event["protocol_version"], VOICE_PROTOCOL_VERSION);
        assert_eq!(event.as_object().map(|value| value.len()), Some(2));
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
