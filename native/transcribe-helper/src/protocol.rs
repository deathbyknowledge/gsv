use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Start {
        request_id: u64,
        #[serde(default = "default_locale")]
        locale: String,
    },
    Stop {
        request_id: u64,
    },
    Cancel {
        request_id: u64,
    },
    Shutdown,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event<'a> {
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
    Error {
        request_id: Option<u64>,
        message: &'a str,
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
                Err(error) => {
                    emit(&Event::Error {
                        request_id: None,
                        message: &format!("invalid transcription command: {error}"),
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
    fn protocol_does_not_expose_model_or_backend_choices() {
        let command: Command =
            serde_json::from_str(r#"{"type":"start","request_id":7,"locale":"nl-NL"}"#)
                .expect("valid command");
        assert_eq!(
            command,
            Command::Start {
                request_id: 7,
                locale: "nl-NL".to_string(),
            }
        );

        let event = serde_json::to_value(Event::Partial {
            request_id: 7,
            revision: 2,
            committed: "hello ",
            tentative: "world",
        })
        .expect("serializable event");
        assert!(event.get("model").is_none());
        assert!(event.get("backend").is_none());
    }
}
