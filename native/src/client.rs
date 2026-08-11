use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use gsv::config::CliConfig;
use gsv::kernel_client::{GatewayAuth, KernelClient};
use gsv::protocol::Frame;
use serde_json::{json, Value};
use tokio::sync::mpsc as tokio_mpsc;

#[derive(Clone, Debug)]
pub enum ApprovalDecision {
    Approve { remember: bool },
    Deny,
}

#[derive(Clone, Debug)]
pub enum ClientCommand {
    Send(String),
    Abort {
        run_id: String,
    },
    Decide {
        request_id: String,
        decision: ApprovalDecision,
    },
    RefreshHistory,
    Shell(String),
    Shutdown,
}

#[derive(Clone, Debug)]
pub enum ClientEvent {
    Connecting,
    Connected {
        pid: String,
    },
    History(Value),
    Signal {
        name: String,
        payload: Value,
    },
    SendAccepted {
        run_id: String,
        queued: bool,
    },
    AbortResolved {
        run_id: String,
    },
    AbortFailed {
        run_id: String,
        message: String,
    },
    ApprovalResolved,
    ShellResult {
        command: String,
        output: String,
        exit_code: Option<i64>,
    },
    Error(String),
    Disconnected(String),
}

pub struct ClientHandle {
    pub commands: tokio_mpsc::UnboundedSender<ClientCommand>,
    pub events: mpsc::Receiver<ClientEvent>,
}

pub fn start(demo: bool) -> ClientHandle {
    let (command_tx, command_rx) = tokio_mpsc::unbounded_channel();
    let (event_tx, event_rx) = mpsc::channel();
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
                runtime.block_on(run_live(command_rx, thread_events));
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
    }
}

async fn run_live(
    mut commands: tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: mpsc::Sender<ClientEvent>,
) {
    let _ = events.send(ClientEvent::Connecting);
    let config = CliConfig::load();
    let (url, auth) = gateway_settings(&config);
    let signal_events = events.clone();
    let client = match KernelClient::connect_user(&url, auth, move |frame| {
        if let Frame::Sig(signal) = frame {
            let _ = signal_events.send(ClientEvent::Signal {
                name: signal.signal,
                payload: signal.payload.unwrap_or_else(|| json!({})),
            });
        }
    })
    .await
    {
        Ok(client) => client,
        Err(error) => {
            let _ = events.send(ClientEvent::Disconnected(format!(
                "I couldn’t reach your GSV at {url}. Run the gateway, sign in with the CLI, or start this prototype with --demo.\n\n{error}"
            )));
            return;
        }
    };

    let pid = match choose_process(&client).await {
        Ok(process) => process,
        Err(error) => {
            let _ = events.send(ClientEvent::Error(error));
            return;
        }
    };
    let _ = events.send(ClientEvent::Connected { pid: pid.clone() });
    send_history(&client, &pid, &events).await;

    let mut connection_check = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else {
                    break;
                };
                match command {
                    ClientCommand::Send(message) => {
                        match client.proc_send(&pid, &message).await {
                            Ok(result) => {
                                let _ = events.send(ClientEvent::SendAccepted {
                                    run_id: result.run_id,
                                    queued: result.queued,
                                });
                            }
                            Err(error) => {
                                let _ = events.send(ClientEvent::Error(format!("GSV couldn’t accept that thought: {error}")));
                            }
                        }
                    }
                    ClientCommand::Abort { run_id } => {
                        let args = json!({ "pid": pid, "runId": run_id });
                        match client.request_ok("proc.abort", Some(args)).await {
                            Ok(_) => {
                                let _ = events.send(ClientEvent::AbortResolved { run_id });
                            }
                            Err(error) => {
                                let _ = events.send(ClientEvent::AbortFailed {
                                    run_id,
                                    message: format!("The active run could not be stopped: {error}"),
                                });
                            }
                        }
                    }
                    ClientCommand::Decide { request_id, decision } => {
                        let (decision, remember) = match decision {
                            ApprovalDecision::Approve { remember } => ("approve", remember),
                            ApprovalDecision::Deny => ("deny", false),
                        };
                        match client.request_ok("proc.hil", Some(json!({
                            "pid": pid,
                            "requestId": request_id,
                            "decision": decision,
                            "remember": remember,
                        }))).await {
                            Ok(_) => {
                                let _ = events.send(ClientEvent::ApprovalResolved);
                            }
                            Err(error) => {
                                let _ = events.send(ClientEvent::Error(format!("That approval decision could not be applied: {error}")));
                            }
                        }
                    }
                    ClientCommand::RefreshHistory => send_history(&client, &pid, &events).await,
                    ClientCommand::Shell(command) => run_shell(&client, command, &events).await,
                    ClientCommand::Shutdown => break,
                }
            }
            _ = connection_check.tick() => {
                if client.connection().is_disconnected() {
                    let _ = events.send(ClientEvent::Disconnected("The connection to your GSV closed.".to_string()));
                    break;
                }
            }
        }
    }
}

fn gateway_settings(config: &CliConfig) -> (String, GatewayAuth) {
    let url = nonempty_env("GSV_URL").unwrap_or_else(|| config.gateway_url());
    let username = nonempty_env("GSV_USER").or_else(|| config.gateway_username());
    let password = nonempty_env("GSV_PASSWORD");
    let token = nonempty_env("GSV_TOKEN")
        .or_else(|| config.gateway_session_token())
        .or_else(|| config.gateway_token());
    (
        url,
        GatewayAuth {
            username,
            password,
            token,
        },
    )
}

fn nonempty_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn choose_process(client: &KernelClient) -> Result<String, String> {
    if let Some(pid) = nonempty_env("GSV_NATIVE_PID") {
        return Ok(pid);
    }

    let response = client
        .request_ok("proc.list", Some(json!({})))
        .await
        .map_err(|error| format!("GSV processes could not be listed: {error}"))?;
    let process = response
        .get("processes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|process| process.get("interactive").and_then(Value::as_bool) == Some(true))
        .filter_map(|process| {
            let pid = process.get("pid")?.as_str()?.to_string();
            let activity = process
                .get("lastActiveAt")
                .and_then(Value::as_i64)
                .or_else(|| process.get("createdAt").and_then(Value::as_i64))
                .unwrap_or_default();
            Some((activity, pid))
        })
        .max_by_key(|(activity, _)| *activity);

    if let Some((_, pid)) = process {
        return Ok(pid);
    }

    let spawned = client
        .request_ok(
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

async fn send_history(client: &KernelClient, pid: &str, events: &mpsc::Sender<ClientEvent>) {
    match client
        .request_ok(
            "proc.history",
            Some(json!({ "pid": pid, "tail": true, "limit": 200 })),
        )
        .await
    {
        Ok(history) => {
            let _ = events.send(ClientEvent::History(history));
        }
        Err(error) => {
            let _ = events.send(ClientEvent::Error(format!(
                "This process’s history could not be read: {error}"
            )));
        }
    }
}

async fn run_shell(client: &KernelClient, command: String, events: &mpsc::Sender<ClientEvent>) {
    match client
        .request_ok("shell.exec", Some(json!({ "input": command })))
        .await
    {
        Ok(result) => {
            let output = result
                .get("output")
                .and_then(Value::as_str)
                .or_else(|| result.get("stdout").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();
            let exit_code = result.get("exitCode").and_then(Value::as_i64);
            let _ = events.send(ClientEvent::ShellResult {
                command,
                output,
                exit_code,
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

async fn run_demo(
    mut commands: tokio_mpsc::UnboundedReceiver<ClientCommand>,
    events: mpsc::Sender<ClientEvent>,
) {
    let _ = events.send(ClientEvent::Connected {
        pid: "demo:native".to_string(),
    });
    let generation = Arc::new(AtomicU64::new(0));

    while let Some(command) = commands.recv().await {
        match command {
            ClientCommand::Send(message) => {
                let run = generation.fetch_add(1, Ordering::SeqCst) + 1;
                let run_id = format!("demo-run-{run}");
                let _ = events.send(ClientEvent::SendAccepted {
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
                            name: "proc.run.stream".to_string(),
                            payload: json!({
                                "pid": "demo:native",
                                "runId": run_id,
                                "event": { "type": "text_delta", "delta": fragment },
                            }),
                        });
                    }
                    let _ = stream_events.send(ClientEvent::Signal {
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
            ClientCommand::Decide { .. } => {
                let _ = events.send(ClientEvent::ApprovalResolved);
            }
            ClientCommand::RefreshHistory => {}
            ClientCommand::Shutdown => break,
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
    fn demo_stream_preserves_word_spacing() {
        assert_eq!(word_fragments("one two three").concat(), "one two three");
    }
}
