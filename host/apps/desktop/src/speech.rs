use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

mod diagnostics;
use diagnostics::StderrCapture;

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
        managed: bool,
        can_configure: bool,
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
    shortcuts: Option<SpeechEvent>,
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
        if let Some(event) = &delivery.shortcuts {
            let _ = updates.send(event.clone());
        }
        delivery.updates = Some(updates);
        delivery.status.clone()
    }

    pub fn event(&self, event: SpeechEvent) {
        let mut delivery = self.delivery.lock().unwrap();
        if matches!(event, SpeechEvent::Shortcuts { .. }) {
            delivery.shortcuts = Some(event.clone());
        }
        if let Some(updates) = &delivery.updates {
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
    stderr: StderrCapture,
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
        Self::spawn(Command::new(executable))
    }

    fn spawn(mut command: Command) -> Result<Self, String> {
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Could not start local speech: {error}"))?;
        Ok(Self {
            stdin: child.stdin.take().unwrap(),
            stdout: BufReader::new(child.stdout.take().unwrap()).lines(),
            stderr: StderrCapture::start(child.stderr.take().unwrap()),
            child,
        })
    }

    async fn write(&mut self, command: &impl Serialize) -> Result<(), String> {
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

    async fn stop(mut self) {
        drop(self.stdin);
        if tokio::time::timeout(std::time::Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
        let _ = self.stderr.finish().await;
    }

    async fn failure(mut self, error: &str) -> String {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill().await;
        }
        let exit = self
            .child
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.to_string())
            .unwrap_or_else(|| "exit status unavailable".into());
        let diagnostic = self.stderr.finish().await;
        let message = format!("{error} ({diagnostic}; {exit})");
        eprintln!("local speech failure: {message}");
        message
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

async fn dispatch(
    helper: &mut Option<Helper>,
    command: &SpeechCommand,
    delivery: &Mutex<Delivery>,
) -> Result<(), String> {
    if helper.is_none() {
        if matches!(command, SpeechCommand::Cancel) {
            return Ok(());
        }
        *helper = Some(Helper::start()?);
    }
    if !matches!(command, SpeechCommand::Cancel) {
        return helper.as_mut().unwrap().write(command).await;
    }
    let id = uuid::Uuid::new_v4().to_string();
    helper
        .as_mut()
        .unwrap()
        .write(&serde_json::json!({ "kind": "cancel", "id": id }))
        .await?;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let status = read_status(helper).await?;
            let result = if status.id.as_deref() == Some(id.as_str()) {
                match status.phase.as_str() {
                    "idle" => Some(Ok(())),
                    "error" => Some(Err(status
                        .error
                        .clone()
                        .unwrap_or_else(|| "Could not stop local speech playback.".into()))),
                    _ => None,
                }
            } else {
                None
            };
            publish(delivery, status);
            if let Some(result) = result {
                return result;
            }
        }
    })
    .await
    .map_err(|_| "Local speech did not confirm that playback stopped.".to_string())?
}

async fn run(mut requests: mpsc::Receiver<Request>, delivery: Arc<Mutex<Delivery>>) {
    let mut helper = None;
    loop {
        tokio::select! {
            request = requests.recv() => {
                let Some(request) = request else { break; };
                let Some(command) = request.command else {
                    if let Some(helper) = helper.take() { helper.stop().await; }
                    let _ = request.reply.send(Ok(()));
                    break;
                };
                let mut result = dispatch(&mut helper, &command, &delivery).await;
                if let Err(error) = &result {
                    let error = if let Some(helper) = helper.take() { helper.failure(error).await } else { error.clone() };
                    publish(&delivery, SpeechStatus { phase: "error".into(), id: None, error: Some(error.clone()) });
                    result = Err(error);
                }
                let _ = request.reply.send(result);
            },
            status = read_status(&mut helper) => match status {
                Ok(status) => publish(&delivery, status),
                Err(error) => {
                    let error = if let Some(helper) = helper.take() { helper.failure(&error).await } else { error };
                    publish(&delivery, SpeechStatus { phase: "error".into(), id: None, error: Some(error) });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_waits_for_its_own_acknowledgement_and_reports_failure() {
        for phase in ["idle", "error"] {
            let error = if phase == "idle" {
                "null"
            } else {
                "\"audio_error\""
            };
            let mut command = Command::new("sh");
            command.args(["-c", &format!(r#"
                IFS= read -r command
                printf '%s\n' '{{"phase":"idle","id":null,"error":null}}'
                sleep 0.1
                printf '%s\n' "$command" | sed 's/"kind":"cancel"/"phase":"{phase}","error":{error}/'
            "#)]);
            let mut helper = Some(Helper::spawn(command).unwrap());
            let delivery = Mutex::new(Delivery::default());
            {
                let pending = dispatch(&mut helper, &SpeechCommand::Cancel, &delivery);
                tokio::pin!(pending);
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(20), &mut pending)
                        .await
                        .is_err()
                );
                let result = pending.await;
                if phase == "idle" {
                    result.unwrap();
                } else {
                    assert_eq!(result.unwrap_err(), "audio_error");
                }
            }
            assert!(delivery.lock().unwrap().status.id.is_some());
            helper.take().unwrap().stop().await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_times_out_when_the_helper_never_acknowledges_it() {
        let mut command = Command::new("sh");
        command.args(["-c", r#"IFS= read -r command; printf '%s\n' '{"phase":"idle","id":"earlier-cancel","error":null}'; IFS= read -r unused"#]);
        let mut helper = Some(Helper::spawn(command).unwrap());
        let delivery = Mutex::new(Delivery::default());
        let error = dispatch(&mut helper, &SpeechCommand::Cancel, &delivery)
            .await
            .unwrap_err();
        assert!(error.contains("did not confirm"));
        helper.take().unwrap().failure(&error).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_exit_retains_redacted_stderr_in_the_reported_failure() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf '%s\\n' \"ModuleNotFoundError: No module named 'onnxruntime'\" 'private spoken content' >&2; exit 7"]);
        let mut helper = Some(Helper::spawn(command).unwrap());
        let error = read_status(&mut helper).await.err().unwrap();
        let message = helper.take().unwrap().failure(&error).await;
        assert!(message.contains("ModuleNotFoundError; onnxruntime"));
        assert!(!message.contains("private spoken content"));
    }

    #[test]
    fn maximum_speech_fits_the_helper_line_budget_after_json_escaping() {
        for character in ['"', '\\', '\0'] {
            let command = SpeechCommand::Speak {
                id: character.to_string().repeat(256),
                chunks: vec![character.to_string().repeat(512); 256],
                language: "en".into(),
            };
            command.validate().unwrap();
            let line_size = serde_json::to_vec(&command).unwrap().len() + 1;
            assert!(line_size > 256 * 1024);
            assert!(line_size <= 1024 * 1024);
        }
    }

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
        assert!(command("en", vec!["Ready.".into(); 256]).validate().is_ok());
        assert!(command("en", vec!["Ready.".into(); 257])
            .validate()
            .is_err());
        assert!(command("es", vec!["á".repeat(600); 110])
            .validate()
            .is_err());
    }
}
