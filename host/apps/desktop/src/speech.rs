use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SpeechCommand {
    Prepare,
    Speak {
        id: String,
        chunks: Vec<String>,
        language: String,
    },
    Cue {
        cue: String,
    },
    Cancel,
}

impl SpeechCommand {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Speak {
                id,
                chunks,
                language,
            } if id.is_empty()
                || id.len() > 256
                || !matches!(language.as_str(), "en" | "es")
                || chunks.is_empty()
                || chunks.len() > 256
                || chunks
                    .iter()
                    .any(|text| text.is_empty() || text.chars().count() > 700)
                || chunks.iter().map(String::len).sum::<usize>() > 128 * 1024 =>
            {
                Err("The spoken message is too large or invalid.".into())
            }
            Self::Cue { cue }
                if !matches!(
                    cue.as_str(),
                    "listening" | "sent" | "cancelled" | "attention"
                ) =>
            {
                Err("Unknown voice sound.".into())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechStatus {
    pub phase: String,
    pub id: Option<String>,
    pub error: Option<String>,
}

impl Default for SpeechStatus {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            id: None,
            error: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpeechEvent {
    Status {
        status: SpeechStatus,
    },
    Shortcut {
        action: &'static str,
        sent_at_ms: u64,
    },
    Shortcuts {
        description: String,
        error: Option<String>,
    },
}

struct Request {
    command: Option<SpeechCommand>,
    reply: oneshot::Sender<Result<(), String>>,
}

#[derive(Default)]
struct Delivery {
    status: SpeechStatus,
    updates: Option<Channel<SpeechEvent>>,
}

#[derive(Clone)]
pub struct SpeechRuntime {
    sender: mpsc::Sender<Request>,
    delivery: Arc<Mutex<Delivery>>,
}

impl SpeechRuntime {
    pub fn start() -> Self {
        let (sender, requests) = mpsc::channel(16);
        let delivery = Arc::new(Mutex::new(Delivery::default()));
        tauri::async_runtime::spawn(run(requests, delivery.clone()));
        Self { sender, delivery }
    }

    pub fn attach(&self, updates: Channel<SpeechEvent>) -> SpeechStatus {
        let mut delivery = self.delivery.lock().unwrap();
        delivery.updates = Some(updates);
        delivery.status.clone()
    }

    pub fn event(&self, event: SpeechEvent) {
        if let Some(updates) = &self.delivery.lock().unwrap().updates {
            let _ = updates.send(event);
        }
    }

    pub fn shortcut(&self, action: &'static str) {
        self.event(SpeechEvent::Shortcut {
            action,
            sent_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        });
    }

    pub async fn command(&self, command: SpeechCommand) -> Result<(), String> {
        command.validate()?;
        self.request(Some(command)).await
    }

    async fn request(&self, command: Option<SpeechCommand>) -> Result<(), String> {
        let (reply, received) = oneshot::channel();
        self.sender
            .send(Request { command, reply })
            .await
            .map_err(|_| "Speech is closed.")?;
        received.await.map_err(|_| "Speech is closed.")?
    }

    pub async fn shutdown(&self) {
        let _ = self.request(None).await;
    }
}

struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

impl Helper {
    fn start() -> Result<Self, String> {
        let executable = if let Some(path) = std::env::var_os("GSV_SPEAK_HELPER") {
            PathBuf::from(path)
        } else {
            std::env::current_exe()
                .map_err(|error| format!("Locate speech helper: {error}"))?
                .with_file_name(if cfg!(windows) {
                    "gsv-speak.exe"
                } else {
                    "gsv-speak"
                })
        };
        if !executable.is_absolute() {
            return Err("The speech helper path must be absolute.".into());
        }
        let mut child = Command::new(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Could not start local speech: {error}"))?;
        Ok(Self {
            stdin: child.stdin.take().unwrap(),
            stdout: BufReader::new(child.stdout.take().unwrap()).lines(),
            child,
        })
    }

    async fn write(&mut self, command: &SpeechCommand) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(command)
            .map_err(|error| format!("Encode speech command: {error}"))?;
        bytes.push(b'\n');
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.stdin.write_all(&bytes),
        )
        .await
        .map_err(|_| "The local speech helper stopped responding.".to_string())?
        .map_err(|error| format!("Write to local speech helper: {error}"))
    }
}

fn publish(delivery: &Mutex<Delivery>, status: SpeechStatus) {
    let mut delivery = delivery.lock().unwrap();
    delivery.status = status.clone();
    if let Some(updates) = &delivery.updates {
        let _ = updates.send(SpeechEvent::Status { status });
    }
}

async fn read_status(helper: &mut Option<Helper>) -> Result<SpeechStatus, String> {
    let Some(helper) = helper else {
        return std::future::pending().await;
    };
    let line = helper
        .stdout
        .next_line()
        .await
        .map_err(|error| format!("Read speech status: {error}"))?
        .ok_or("The local speech helper exited. Try voice again.")?;
    if line.len() > 8192 {
        return Err("The speech helper sent an oversized status.".into());
    }
    let status: SpeechStatus =
        serde_json::from_str(&line).map_err(|_| "The speech helper sent an invalid status.")?;
    if !matches!(
        status.phase.as_str(),
        "idle" | "loading" | "ready" | "speaking" | "finished" | "error"
    ) || status.error.as_ref().is_some_and(|error| error.len() > 128)
        || status.id.as_ref().is_some_and(|id| id.len() > 256)
    {
        return Err("The speech helper sent an invalid status.".into());
    }
    Ok(status)
}

async fn run(mut requests: mpsc::Receiver<Request>, delivery: Arc<Mutex<Delivery>>) {
    let mut helper = None;
    loop {
        tokio::select! {
            request = requests.recv() => {
                let Some(request) = request else { break; };
                let Some(command) = request.command else {
                    if let Some(mut helper) = helper.take() { let _ = helper.child.kill().await; }
                    let _ = request.reply.send(Ok(()));
                    break;
                };
                let result = async {
                    if helper.is_none() {
                        if matches!(command, SpeechCommand::Cancel) { return Ok(()); }
                        helper = Some(Helper::start()?);
                    }
                    helper.as_mut().unwrap().write(&command).await
                }.await;
                if let Err(error) = &result {
                    if let Some(mut helper) = helper.take() { let _ = helper.child.kill().await; }
                    publish(&delivery, SpeechStatus { phase: "error".into(), id: None, error: Some(error.clone()) });
                }
                let _ = request.reply.send(result);
            },
            status = read_status(&mut helper) => match status {
                Ok(status) => publish(&delivery, status),
                Err(error) => {
                    if let Some(mut helper) = helper.take() { let _ = helper.child.kill().await; }
                    publish(&delivery, SpeechStatus { phase: "error".into(), id: None, error: Some(error) });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_admission_bounds_private_input_and_selects_supported_voices() {
        let command = |language: &str, chunks: Vec<String>| SpeechCommand::Speak {
            id: "message:one".into(),
            chunks,
            language: language.into(),
        };
        assert!(command("en", vec!["Hello.".into()]).validate().is_ok());
        assert!(command("es", vec!["Hola.".into()]).validate().is_ok());
        assert!(command("unknown", vec!["Hello.".into()])
            .validate()
            .is_err());
        assert!(command("en", vec!["a".repeat(701)]).validate().is_err());
        assert!(command("en", vec![]).validate().is_err());
    }
}
