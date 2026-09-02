use std::io::{self, IsTerminal};
use std::sync::Arc;

use crossterm::cursor::{SetCursorStyle, Show};
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event as TerminalEvent, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
    MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures_util::StreamExt;
use gsv::kernel_client::{cli_peer_identity, BinaryBodyLimits, GatewayAuth, KernelClient};
use gsv::protocol::Frame;
use gsv_tui_core::{
    Action, App, Approval, ApprovalDecision, Artifact, CapabilityEnvironment, ConnectionState,
    Effect, MediaKind, Moment, Role, Theme,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::chat::{implicit_personal_owner_uid, personal_process_id};

mod media;

use media::ImageManager;

enum RuntimeEvent {
    Signal {
        name: String,
        payload: Value,
    },
    SubmissionAccepted {
        id: u64,
        run_id: String,
        queued: bool,
    },
    SubmissionFailed {
        id: u64,
        error: String,
    },
    ShellOutput {
        id: u64,
        output: String,
    },
    ShellFinished {
        id: u64,
        error: Option<String>,
    },
    ApprovalDecided {
        request_id: String,
    },
    ApprovalFailed {
        error: String,
    },
    AbortFinished {
        error: Option<String>,
    },
}

struct ConnectedSession {
    client: Arc<KernelClient>,
    pid: String,
    conversation_id: String,
}

struct TerminalRestore;

impl Drop for TerminalRestore {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            Show,
            SetCursorStyle::DefaultUserShape,
            DisableBracketedPaste,
            DisableMouseCapture,
            LeaveAlternateScreen
        );
    }
}

pub(crate) async fn run_tui(
    url: &str,
    auth: GatewayAuth,
    preferred_pid: Option<String>,
    demo: bool,
    vim: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (runtime_sender, runtime_receiver) = mpsc::unbounded_channel();
    if demo {
        let mut app = App::demo();
        app.set_principal(whoami::username());
        app.set_environments(vec![
            CapabilityEnvironment::gsv(),
            CapabilityEnvironment::new("macbook", "MacBook"),
            CapabilityEnvironment::new("browser", "Browser"),
        ]);
        app.set_vim_enabled(vim);
        return run_interface(app, None, runtime_sender, runtime_receiver).await;
    }

    let signal_sender = runtime_sender.clone();
    let client = KernelClient::connect_with_peer(
        url,
        cli_peer_identity(),
        Vec::new(),
        auth,
        BinaryBodyLimits::default(),
        move |frame| {
            if let Frame::Sig(signal) = frame {
                let _ = signal_sender.send(RuntimeEvent::Signal {
                    name: signal.signal,
                    payload: signal.payload.unwrap_or_else(|| json!({})),
                });
            }
        },
    )
    .await?;
    let account = &client
        .connection()
        .connect_result
        .as_ref()
        .ok_or("GSV returned no current user")
        .map(|result| &result.peer.principal.account)?;
    let owner_uid = implicit_personal_owner_uid(account.uid)?;
    let principal = account.username.clone();
    let pid = match preferred_pid {
        Some(pid) => pid,
        None => {
            let processes = client
                .request_ok("proc.list", Some(json!({ "uid": owner_uid })))
                .await?;
            personal_process_id(&processes, owner_uid)
                .ok_or("GSV returned no personal intelligence process")?
        }
    };
    let conversation_id = client.conversation_for_process(&pid).await?;
    let (history, environments) = tokio::join!(
        client.request_ok(
            "conversation.history",
            Some(json!({
                "conversationId": conversation_id,
                "limit": 200,
            })),
        ),
        available_environments(&client),
    );
    let history = history?;

    let mut app = App::new(ConnectionState::Ready);
    app.set_principal(principal);
    app.set_vim_enabled(vim);
    app.set_environments(environments);
    let moments = history_moments(&history);
    if moments.is_empty() {
        app.replace_history(vec![Moment::complete(
            "local:ready",
            Role::Intelligence,
            "Ship is ready. Tell me what should happen.",
        )]);
    } else {
        app.replace_history(moments);
    }

    run_interface(
        app,
        Some(ConnectedSession {
            client: Arc::new(client),
            pid,
            conversation_id,
        }),
        runtime_sender,
        runtime_receiver,
    )
    .await
}

async fn run_interface(
    mut app: App,
    session: Option<ConnectedSession>,
    runtime_sender: mpsc::UnboundedSender<RuntimeEvent>,
    mut runtime_receiver: mpsc::UnboundedReceiver<RuntimeEvent>,
) -> Result<(), Box<dyn std::error::Error>> {
    if !io::stdout().is_terminal() {
        return Err("The GSV interface needs an interactive terminal".into());
    }
    app.set_theme(Theme::Terminal);

    enable_raw_mode()?;
    let _restore = TerminalRestore;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )?;
    let mut image_manager = ImageManager::detect();
    app.set_inline_images(true);
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;
    let mut terminal_events = EventStream::new();
    let mut insert_cursor = false;

    loop {
        let next_insert_cursor = app.cursor_visible();
        if insert_cursor != next_insert_cursor {
            let style = if next_insert_cursor {
                SetCursorStyle::SteadyBar
            } else {
                SetCursorStyle::DefaultUserShape
            };
            execute!(terminal.backend_mut(), style)?;
            insert_cursor = next_insert_cursor;
        }
        terminal.draw(|frame| {
            app.render(frame);
            image_manager.render(frame, app.media_slots());
        })?;
        image_manager.synchronize(
            app.media_slots(),
            session.as_ref().map(|session| &session.client),
        );
        tokio::select! {
            maybe_event = terminal_events.next() => {
                let Some(event) = maybe_event else {
                    break;
                };
                let event = event?;
                let action = terminal_action(&app, event);
                if let Some(action) = action {
                    let effects = app.dispatch(action);
                    if apply_effects(&mut app, effects, session.as_ref(), &runtime_sender) {
                        break;
                    }
                }
            }
            Some(event) = runtime_receiver.recv() => {
                apply_runtime_event(&mut app, event, session.as_ref());
            }
            () = image_manager.next_event() => {}
        }
    }

    Ok(())
}

fn apply_effects(
    app: &mut App,
    effects: Vec<Effect>,
    session: Option<&ConnectedSession>,
    runtime_sender: &mpsc::UnboundedSender<RuntimeEvent>,
) -> bool {
    for effect in effects {
        match effect {
            Effect::Submit { id, text, .. } => {
                let Some(session) = session else {
                    app.complete_demo_submission(id, &text);
                    continue;
                };
                let client = Arc::clone(&session.client);
                let conversation_id = session.conversation_id.clone();
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    let result = client
                        .conversation_send(
                            &conversation_id,
                            &text,
                            &uuid::Uuid::new_v4().to_string(),
                        )
                        .await;
                    let event = match result {
                        Ok(result) => RuntimeEvent::SubmissionAccepted {
                            id,
                            run_id: result.run_id,
                            queued: result.queued,
                        },
                        Err(error) => RuntimeEvent::SubmissionFailed {
                            id,
                            error: error.to_string(),
                        },
                    };
                    let _ = sender.send(event);
                });
                drop(handle);
            }
            Effect::Shell {
                id,
                input,
                target,
                cwd,
            } => {
                let Some(session) = session else {
                    app.complete_demo_shell(id, &input);
                    continue;
                };
                let client = Arc::clone(&session.client);
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    run_shell_command(client, sender, id, input, target, cwd).await;
                });
                drop(handle);
            }
            Effect::Abort => {
                let Some(session) = session else {
                    app.set_activity(None);
                    continue;
                };
                let client = Arc::clone(&session.client);
                let pid = session.pid.clone();
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    let error = client
                        .request_ok("proc.abort", Some(json!({ "pid": pid })))
                        .await
                        .err()
                        .map(|error| error.to_string());
                    let _ = sender.send(RuntimeEvent::AbortFinished { error });
                });
                drop(handle);
            }
            Effect::DecideApproval {
                request_id,
                decision,
                remember,
            } => {
                let Some(session) = session else {
                    continue;
                };
                let client = Arc::clone(&session.client);
                let pid = session.pid.clone();
                let sender = runtime_sender.clone();
                let request_id_for_result = request_id.clone();
                let handle = tokio::spawn(async move {
                    let decision = match decision {
                        ApprovalDecision::Approve => "approve",
                        ApprovalDecision::Deny => "deny",
                    };
                    let result = client
                        .request_ok(
                            "proc.hil",
                            Some(json!({
                                "pid": pid,
                                "requestId": request_id,
                                "decision": decision,
                                "remember": remember,
                            })),
                        )
                        .await;
                    let event = match result {
                        Ok(_) => RuntimeEvent::ApprovalDecided {
                            request_id: request_id_for_result,
                        },
                        Err(error) => RuntimeEvent::ApprovalFailed {
                            error: error.to_string(),
                        },
                    };
                    let _ = sender.send(event);
                });
                drop(handle);
            }
            Effect::Quit => return true,
        }
    }
    false
}

fn apply_runtime_event(app: &mut App, event: RuntimeEvent, session: Option<&ConnectedSession>) {
    match event {
        RuntimeEvent::Signal { name, payload } => {
            if let Some(session) = session {
                apply_signal(app, &session.pid, &session.conversation_id, &name, &payload);
            }
        }
        RuntimeEvent::SubmissionAccepted { id, run_id, queued } => {
            app.submission_accepted(id, run_id, queued);
        }
        RuntimeEvent::SubmissionFailed { id, error } => {
            app.submission_failed(id, format!("That request was not sent.\n\n{error}"));
        }
        RuntimeEvent::ShellOutput { id, output } => {
            app.append_shell_output(id, &output);
        }
        RuntimeEvent::ShellFinished { id, error } => {
            app.finish_shell(id, error.as_deref());
        }
        RuntimeEvent::ApprovalDecided { request_id } => {
            app.leave_approval(&request_id);
            app.set_activity(Some("APPROVED".to_string()));
        }
        RuntimeEvent::ApprovalFailed { error } => {
            app.set_activity(Some(format!("APPROVAL FAILED · {error}")));
        }
        RuntimeEvent::AbortFinished { error } => {
            app.set_activity(Some(match error {
                Some(error) => format!("STOP FAILED · {error}"),
                None => "STOPPING".to_string(),
            }));
        }
    }
}

fn apply_signal(app: &mut App, pid: &str, conversation_id: &str, name: &str, payload: &Value) {
    if signal_pid(payload).is_some_and(|actual| actual != pid)
        || signal_conversation_id(payload).is_some_and(|actual| actual != conversation_id)
    {
        return;
    }
    let run_id = signal_run_id(payload);
    match name {
        "proc.run.started" | "message.started" => {
            if let Some(run_id) = run_id {
                app.start_run(run_id);
            }
        }
        "message.delta" => {
            if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                app.append_delta(run_id, delta);
            }
        }
        "proc.run.output" => {
            let text = payload
                .get("text")
                .or_else(|| payload.get("output"))
                .and_then(Value::as_str);
            if let Some(text) = text {
                app.replace_run_text(run_id, text);
            }
        }
        "message.committed" => {
            if let Some(message) = payload.get("message") {
                commit_signal_message(app, message);
            }
        }
        "proc.run.tool.started" => {
            let syscall = payload
                .get("syscall")
                .and_then(Value::as_str)
                .unwrap_or("working");
            let target = payload
                .get("target")
                .or_else(|| payload.get("args").and_then(|args| args.get("target")))
                .and_then(Value::as_str)
                .unwrap_or("gsv");
            app.set_activity(Some(format!("ship@{target} · {syscall}")));
        }
        "proc.run.retrying" => {
            app.set_activity(Some("TRYING ANOTHER PATH".to_string()));
        }
        "proc.run.hil.requested" => {
            if let Some(approval) = approval_from_signal(payload) {
                app.enter_approval(approval);
            }
        }
        "proc.run.finished" => {
            let error = payload.get("error").and_then(Value::as_str);
            app.finish_run(run_id, error);
        }
        _ => {}
    }
}

fn terminal_action(app: &App, event: TerminalEvent) -> Option<Action> {
    match event {
        TerminalEvent::Key(key)
            if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
        {
            key_action(app, key)
        }
        TerminalEvent::Mouse(mouse) => match mouse.kind {
            MouseEventKind::ScrollUp => Some(Action::ScrollUp),
            MouseEventKind::ScrollDown => Some(Action::ScrollDown),
            _ => None,
        },
        TerminalEvent::Paste(text) => Some(Action::Insert(text)),
        TerminalEvent::Resize(_, _)
        | TerminalEvent::FocusGained
        | TerminalEvent::FocusLost
        | TerminalEvent::Key(_) => None,
    }
}

fn key_action(app: &App, key: KeyEvent) -> Option<Action> {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let command_modifier = key.modifiers.intersects(
        KeyModifiers::CONTROL
            | KeyModifiers::ALT
            | KeyModifiers::SUPER
            | KeyModifiers::HYPER
            | KeyModifiers::META,
    );

    if app.approval().is_some() && !command_modifier {
        return match key.code {
            KeyCode::Char('o' | 'O') => Some(Action::DecideApproval {
                decision: ApprovalDecision::Approve,
                remember: false,
            }),
            KeyCode::Char('a' | 'A') => Some(Action::DecideApproval {
                decision: ApprovalDecision::Approve,
                remember: true,
            }),
            KeyCode::Char('d' | 'D') => Some(Action::DecideApproval {
                decision: ApprovalDecision::Deny,
                remember: false,
            }),
            KeyCode::Char('?') => Some(Action::ToggleHelp),
            _ => None,
        };
    }

    if app.environment_picker_visible() {
        return match key.code {
            KeyCode::Char('q' | 'Q') if control => Some(Action::Quit),
            KeyCode::Esc => Some(Action::Escape),
            KeyCode::Enter => Some(Action::Submit),
            KeyCode::Backspace | KeyCode::Delete => Some(Action::Backspace),
            KeyCode::Up => Some(Action::PreviousChoice),
            KeyCode::Down => Some(Action::NextChoice),
            KeyCode::Char('p' | 'P') if control => Some(Action::PreviousChoice),
            KeyCode::Char('n' | 'N') if control => Some(Action::NextChoice),
            KeyCode::Char(character) if !command_modifier => {
                Some(Action::Insert(character.to_string()))
            }
            _ => None,
        };
    }

    if alt && matches!(key.code, KeyCode::Char('v' | 'V')) {
        return Some(Action::ToggleVim);
    }
    if !command_modifier && key.code == KeyCode::Tab {
        return Some(Action::ToggleShell);
    }
    if key.code == KeyCode::PageUp {
        return Some(Action::ScrollPageUp);
    }
    if key.code == KeyCode::PageDown {
        return Some(Action::ScrollPageDown);
    }

    if app.vim_enabled() && !app.draft_visible() && !command_modifier {
        return match key.code {
            KeyCode::Char('i' | 'a') => Some(Action::BeginCompose),
            KeyCode::Char('h') => Some(Action::PreviousMedia),
            KeyCode::Char('j') => Some(Action::NextTurn),
            KeyCode::Char('k') => Some(Action::PreviousTurn),
            KeyCode::Char('l') => Some(Action::NextMedia),
            KeyCode::Char('g') => Some(Action::FirstTurn),
            KeyCode::Char('G') => Some(Action::LastTurn),
            KeyCode::Enter => Some(Action::ToggleMedia),
            KeyCode::Char('?') => Some(Action::ToggleHelp),
            _ => None,
        };
    }

    match key.code {
        KeyCode::Char('q' | 'Q') if control => Some(Action::Quit),
        KeyCode::Char('.') if control => Some(Action::Abort),
        KeyCode::Char('p' | 'P') if control => Some(Action::PreviousTurn),
        KeyCode::Char('n' | 'N') if control => Some(Action::NextTurn),
        KeyCode::Char('u' | 'U') if control && app.vim_enabled() && !app.draft_visible() => {
            Some(Action::ScrollUp)
        }
        KeyCode::Char('d' | 'D') if control && app.vim_enabled() && !app.draft_visible() => {
            Some(Action::ScrollDown)
        }
        KeyCode::Char('a' | 'A') if control => Some(Action::MoveCursorHome),
        KeyCode::Char('e' | 'E') if control => Some(Action::MoveCursorEnd),
        KeyCode::Char('b' | 'B') if control => Some(Action::MoveCursorLeft),
        KeyCode::Char('f' | 'F') if control => Some(Action::MoveCursorRight),
        KeyCode::Char('w' | 'W') if control => Some(Action::DeleteWord),
        KeyCode::Char('m' | 'M') if alt => Some(Action::ToggleMarkdown),
        KeyCode::Char('?') if !app.draft_visible() && !command_modifier => Some(Action::ToggleHelp),
        KeyCode::Char(character) if !command_modifier => {
            Some(Action::Insert(character.to_string()))
        }
        KeyCode::Enter
            if key
                .modifiers
                .intersects(KeyModifiers::SHIFT | KeyModifiers::CONTROL) =>
        {
            Some(Action::Newline)
        }
        KeyCode::Enter if !app.draft_visible() => Some(Action::ToggleMedia),
        KeyCode::Enter => Some(Action::Submit),
        KeyCode::Esc => Some(Action::Escape),
        KeyCode::Backspace => Some(Action::Backspace),
        KeyCode::Delete => Some(Action::Delete),
        KeyCode::Left if !app.draft_visible() => Some(Action::PreviousMedia),
        KeyCode::Right if !app.draft_visible() => Some(Action::NextMedia),
        KeyCode::Left => Some(Action::MoveCursorLeft),
        KeyCode::Right => Some(Action::MoveCursorRight),
        KeyCode::Home => Some(Action::MoveCursorHome),
        KeyCode::End => Some(Action::MoveCursorEnd),
        KeyCode::Up if alt => Some(Action::PreviousTurn),
        KeyCode::Down if alt => Some(Action::NextTurn),
        KeyCode::Up if !app.draft_visible() => Some(Action::ScrollUp),
        KeyCode::Down if !app.draft_visible() => Some(Action::ScrollDown),
        _ => None,
    }
}

#[derive(Debug, Eq, PartialEq)]
enum ShellResponse {
    Running { output: String, session_id: String },
    Completed { output: String },
    Failed { output: String, error: String },
}

async fn run_shell_command(
    client: Arc<KernelClient>,
    sender: mpsc::UnboundedSender<RuntimeEvent>,
    id: u64,
    input: String,
    target: String,
    cwd: Option<String>,
) {
    let mut args = json!({
        "input": input,
        "target": target,
    });
    if let Some(cwd) = cwd {
        args["cwd"] = Value::String(cwd);
    }

    loop {
        let payload = match client.request_ok("shell.exec", Some(args)).await {
            Ok(payload) => payload,
            Err(error) => {
                let _ = sender.send(RuntimeEvent::ShellFinished {
                    id,
                    error: Some(error.to_string()),
                });
                return;
            }
        };
        let response = match parse_shell_response(&payload) {
            Ok(response) => response,
            Err(error) => {
                let _ = sender.send(RuntimeEvent::ShellFinished {
                    id,
                    error: Some(error),
                });
                return;
            }
        };
        match response {
            ShellResponse::Running { output, session_id } => {
                if !output.is_empty()
                    && sender
                        .send(RuntimeEvent::ShellOutput { id, output })
                        .is_err()
                {
                    return;
                }
                args = json!({
                    "input": "",
                    "sessionId": session_id,
                });
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            ShellResponse::Completed { output } => {
                if !output.is_empty()
                    && sender
                        .send(RuntimeEvent::ShellOutput { id, output })
                        .is_err()
                {
                    return;
                }
                let _ = sender.send(RuntimeEvent::ShellFinished { id, error: None });
                return;
            }
            ShellResponse::Failed { output, error } => {
                if !output.is_empty()
                    && sender
                        .send(RuntimeEvent::ShellOutput { id, output })
                        .is_err()
                {
                    return;
                }
                let _ = sender.send(RuntimeEvent::ShellFinished {
                    id,
                    error: Some(error),
                });
                return;
            }
        }
    }
}

fn parse_shell_response(payload: &Value) -> Result<ShellResponse, String> {
    let output = payload
        .get("output")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let stdout = payload.get("stdout").and_then(Value::as_str).unwrap_or("");
            let stderr = payload.get("stderr").and_then(Value::as_str).unwrap_or("");
            format!("{stdout}{stderr}")
        });
    match payload.get("status").and_then(Value::as_str) {
        Some("running") => {
            let session_id = payload
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|session_id| !session_id.is_empty())
                .ok_or_else(|| {
                    "shell.exec returned a running command without a session id".to_string()
                })?;
            Ok(ShellResponse::Running {
                output,
                session_id: session_id.to_string(),
            })
        }
        Some("completed") => Ok(ShellResponse::Completed { output }),
        Some("failed") => Ok(ShellResponse::Failed {
            output,
            error: payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Command failed")
                .to_string(),
        }),
        Some(status) => Err(format!("shell.exec returned unknown status: {status}")),
        None if payload.get("stdout").is_some()
            || payload.get("stderr").is_some()
            || payload.get("exitCode").is_some() =>
        {
            match payload.get("exitCode").and_then(Value::as_i64) {
                Some(exit_code) if exit_code != 0 => Ok(ShellResponse::Failed {
                    output,
                    error: format!("Command exited with code {exit_code}"),
                }),
                _ => Ok(ShellResponse::Completed { output }),
            }
        }
        None if payload.get("error").and_then(Value::as_str).is_some() => {
            Ok(ShellResponse::Failed {
                output,
                error: payload["error"]
                    .as_str()
                    .unwrap_or("Command failed")
                    .to_string(),
            })
        }
        None => Err("shell.exec returned no command status".to_string()),
    }
}

async fn available_environments(client: &KernelClient) -> Vec<CapabilityEnvironment> {
    let mut environments = vec![CapabilityEnvironment::gsv()];
    let Ok(payload) = client
        .request_ok("sys.device.list", Some(json!({ "includeOffline": false })))
        .await
    else {
        return environments;
    };
    environments.extend(device_environments(&payload));
    environments
}

fn device_environments(payload: &Value) -> Vec<CapabilityEnvironment> {
    payload
        .get("devices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|device| {
            let target = device.get("deviceId").and_then(Value::as_str)?;
            if target.trim().is_empty() {
                return None;
            }
            let label = device
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .unwrap_or(target);
            Some(CapabilityEnvironment::new(target, label))
        })
        .collect()
}

fn history_moments(payload: &Value) -> Vec<Moment> {
    payload
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| {
            let text = message.get("text").and_then(Value::as_str)?;
            let id = value_id(message.get("id"))
                .unwrap_or_else(|| format!("history:{}", message_sequence(message)));
            let role = role_from_author(message.get("author"));
            let mut moment = Moment::complete(id, role, text)
                .with_artifacts(media_artifacts(message.get("media")));
            moment.environment = message_environment(message);
            moment.run_id = message
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(moment)
        })
        .collect()
}

fn commit_signal_message(app: &mut App, message: &Value) {
    let Some(text) = message.get("text").and_then(Value::as_str) else {
        return;
    };
    let id = value_id(message.get("id"))
        .unwrap_or_else(|| format!("message:{}", message_sequence(message)));
    let run_id = message
        .get("runId")
        .and_then(Value::as_str)
        .map(str::to_string);
    app.commit_message(
        id,
        role_from_author(message.get("author")),
        text,
        run_id,
        media_artifacts(message.get("media")),
        message_environment(message),
    );
}

fn message_environment(message: &Value) -> Option<CapabilityEnvironment> {
    let environment = message.get("origin")?.get("environment")?;
    let target = environment.get("target")?.as_str()?;
    if target.trim().is_empty() {
        return None;
    }
    let mut selected = CapabilityEnvironment::new(target, target);
    selected.cwd = environment
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(selected)
}

fn media_artifacts(value: Option<&Value>) -> Vec<Artifact> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(media_artifact)
        .collect()
}

fn media_artifact(value: &Value) -> Option<Artifact> {
    let object = value.as_object()?;
    if object.get("type").and_then(Value::as_str) == Some("resource") {
        let reference = object.get("ref")?.as_object()?;
        let mime_type = reference.get("contentType")?.as_str()?.to_string();
        let path = reference.get("path")?.as_str()?;
        let target = reference.get("target")?.as_str()?;
        let revision = reference.get("revision")?.as_str()?.to_string();
        return Some(Artifact {
            kind: media_kind(object.get("mediaType").and_then(Value::as_str), &mime_type),
            mime_type,
            filename: object
                .get("filename")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    path.rsplit('/')
                        .find(|part| !part.is_empty())
                        .map(str::to_string)
                }),
            size: reference.get("size").and_then(Value::as_u64),
            duration_ms: duration_millis(object.get("duration")),
            transcription: object
                .get("transcription")
                .and_then(Value::as_str)
                .map(str::to_string),
            source: Some(format!("{target}:{path}")),
            revision: Some(revision),
        });
    }

    let legacy_type = object.get("type")?.as_str()?;
    let mime_type = object
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream")
        .to_string();
    let source = object
        .get("path")
        .or_else(|| object.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            let key = object.get("key")?.as_str()?;
            let conversation = object
                .get("conversationId")
                .and_then(Value::as_str)
                .unwrap_or("process");
            Some(format!("{conversation}:{key}"))
        });
    Some(Artifact {
        kind: media_kind(Some(legacy_type), &mime_type),
        mime_type,
        filename: object
            .get("filename")
            .and_then(Value::as_str)
            .map(str::to_string),
        size: object.get("size").and_then(Value::as_u64),
        duration_ms: duration_millis(object.get("duration")),
        transcription: object
            .get("transcription")
            .and_then(Value::as_str)
            .map(str::to_string),
        source,
        revision: None,
    })
}

fn media_kind(kind: Option<&str>, mime_type: &str) -> MediaKind {
    match kind {
        Some("image") => MediaKind::Image,
        Some("audio") => MediaKind::Audio,
        Some("video") => MediaKind::Video,
        Some("document") => MediaKind::Document,
        _ if mime_type.starts_with("image/") => MediaKind::Image,
        _ if mime_type.starts_with("audio/") => MediaKind::Audio,
        _ if mime_type.starts_with("video/") => MediaKind::Video,
        _ => MediaKind::Document,
    }
}

fn duration_millis(value: Option<&Value>) -> Option<u64> {
    let seconds = value?.as_f64()?;
    std::time::Duration::try_from_secs_f64(seconds)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn role_from_author(author: Option<&Value>) -> Role {
    match author
        .and_then(|author| author.get("kind"))
        .and_then(Value::as_str)
    {
        Some("user") => Role::Human,
        Some("system") => Role::System,
        _ => Role::Intelligence,
    }
}

fn approval_from_signal(payload: &Value) -> Option<Approval> {
    let request_id = payload.get("requestId")?.as_str()?.to_string();
    let syscall = payload
        .get("syscall")
        .and_then(Value::as_str)
        .unwrap_or("unknown action")
        .to_string();
    let target = payload
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("unknown target")
        .to_string();
    let preview = payload
        .get("args")
        .and_then(|args| serde_json::to_string_pretty(args).ok())
        .map(|preview| truncate_chars(&preview, 800))
        .unwrap_or_else(|| "No action preview was provided.".to_string());
    Some(Approval {
        request_id,
        syscall,
        target,
        preview,
    })
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(limit).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn signal_run_id(payload: &Value) -> Option<&str> {
    payload
        .get("runId")
        .or_else(|| {
            payload
                .get("message")
                .and_then(|message| message.get("runId"))
        })
        .and_then(Value::as_str)
}

fn signal_pid(payload: &Value) -> Option<&str> {
    payload
        .get("pid")
        .or_else(|| {
            payload
                .get("message")
                .and_then(|message| message.get("pid"))
        })
        .and_then(Value::as_str)
}

fn signal_conversation_id(payload: &Value) -> Option<&str> {
    payload
        .get("conversationId")
        .or_else(|| {
            payload
                .get("message")
                .and_then(|message| message.get("conversationId"))
        })
        .and_then(Value::as_str)
}

fn value_id(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn message_sequence(message: &Value) -> String {
    message
        .get("sequence")
        .map(Value::to_string)
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use gsv_tui_core::{Action, App, ConnectionState, MediaKind, Role};
    use serde_json::json;

    use super::{
        apply_signal, device_environments, history_moments, key_action, parse_shell_response,
        truncate_chars, ShellResponse,
    };

    #[test]
    fn conversation_history_becomes_user_visible_moments() {
        let moments = history_moments(&json!({
            "messages": [
                {
                    "id": 1,
                    "author": { "kind": "user" },
                    "text": "hello",
                    "origin": {
                        "kind": "client",
                        "environment": {
                            "target": "macbook",
                            "cwd": "/Users/sam/Downloads"
                        }
                    }
                },
                {
                    "id": 2,
                    "author": { "kind": "process" },
                    "text": "hi",
                    "runId": "run-one",
                    "media": [
                        {
                            "type": "resource",
                            "ref": {
                                "type": "file",
                                "target": "gsv",
                                "path": "/home/ship/chart.png",
                                "revision": "sha256:one",
                                "contentType": "image/png",
                                "size": 2048
                            },
                            "mediaType": "image",
                            "filename": "chart.png",
                            "transcription": "a chart"
                        }
                    ]
                }
            ]
        }));
        assert_eq!(moments.len(), 2);
        assert_eq!(moments[0].role, Role::Human);
        assert_eq!(
            moments[0]
                .environment
                .as_ref()
                .map(|environment| environment.target.as_str()),
            Some("macbook")
        );
        assert_eq!(
            moments[0]
                .environment
                .as_ref()
                .and_then(|environment| environment.cwd.as_deref()),
            Some("/Users/sam/Downloads")
        );
        assert_eq!(moments[1].role, Role::Intelligence);
        assert_eq!(moments[1].run_id.as_deref(), Some("run-one"));
        assert_eq!(moments[1].artifacts.len(), 1);
        assert_eq!(moments[1].artifacts[0].kind, MediaKind::Image);
        assert_eq!(
            moments[1].artifacts[0].source.as_deref(),
            Some("gsv:/home/ship/chart.png")
        );
        assert_eq!(
            moments[1].artifacts[0].revision.as_deref(),
            Some("sha256:one")
        );
    }

    #[test]
    fn signals_from_another_process_do_not_mutate_the_surface() {
        let mut app = App::new(ConnectionState::Ready);
        apply_signal(
            &mut app,
            "proc-one",
            "conversation-one",
            "message.delta",
            &json!({
                "pid": "proc-two",
                "runId": "run-two",
                "delta": "wrong"
            }),
        );
        assert!(app.moments().is_empty());
    }

    #[test]
    fn approval_previews_are_bounded_by_unicode_scalar_count() {
        let value = "é".repeat(805);
        let truncated = truncate_chars(&value, 800);
        assert_eq!(truncated.chars().count(), 801);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn vim_browse_keys_are_opt_in() {
        let mut app = App::new(ConnectionState::Ready);
        let j = KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE);
        assert_eq!(key_action(&app, j), Some(Action::Insert("j".to_string())));

        app.set_vim_enabled(true);
        assert_eq!(key_action(&app, j), Some(Action::NextTurn));

        let i = KeyEvent::new(KeyCode::Char('i'), KeyModifiers::NONE);
        assert_eq!(key_action(&app, i), Some(Action::BeginCompose));
        let h = KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE);
        let l = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE);
        assert_eq!(key_action(&app, h), Some(Action::PreviousMedia));
        assert_eq!(key_action(&app, l), Some(Action::NextMedia));
    }

    #[test]
    fn tab_toggles_literal_shell_and_page_keys_scroll_the_document() {
        let mut app = App::new(ConnectionState::Ready);
        app.set_vim_enabled(true);
        let tab = KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE);
        let page_up = KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE);
        let page_down = KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE);
        assert_eq!(key_action(&app, tab), Some(Action::ToggleShell));
        assert_eq!(key_action(&app, page_up), Some(Action::ScrollPageUp));
        assert_eq!(key_action(&app, page_down), Some(Action::ScrollPageDown));
    }

    #[test]
    fn shell_responses_preserve_stream_chunks_and_legacy_output() {
        assert_eq!(
            parse_shell_response(&json!({
                "status": "running",
                "output": "one\n",
                "sessionId": "shell-one"
            })),
            Ok(ShellResponse::Running {
                output: "one\n".to_string(),
                session_id: "shell-one".to_string(),
            })
        );
        assert_eq!(
            parse_shell_response(&json!({
                "status": "completed",
                "output": "two\n",
                "exitCode": 0
            })),
            Ok(ShellResponse::Completed {
                output: "two\n".to_string(),
            })
        );
        assert_eq!(
            parse_shell_response(&json!({
                "stdout": "old out\n",
                "stderr": "old err\n",
                "exitCode": 7
            })),
            Ok(ShellResponse::Failed {
                output: "old out\nold err\n".to_string(),
                error: "Command exited with code 7".to_string(),
            })
        );
        assert_eq!(
            parse_shell_response(&json!({ "error": "permission denied" })),
            Ok(ShellResponse::Failed {
                output: String::new(),
                error: "permission denied".to_string(),
            })
        );
    }

    #[test]
    fn arrow_keys_choose_media_while_browsing() {
        let app = App::new(ConnectionState::Ready);
        let left = KeyEvent::new(KeyCode::Left, KeyModifiers::NONE);
        let right = KeyEvent::new(KeyCode::Right, KeyModifiers::NONE);
        assert_eq!(key_action(&app, left), Some(Action::PreviousMedia));
        assert_eq!(key_action(&app, right), Some(Action::NextMedia));
    }

    #[test]
    fn target_discovery_preserves_exact_ids_and_human_labels() {
        let environments = device_environments(&json!({
            "devices": [
                { "deviceId": "macbook.local", "label": "Sam's MacBook" },
                { "deviceId": "studio", "label": "" }
            ]
        }));
        assert_eq!(environments.len(), 2);
        assert_eq!(environments[0].target, "macbook.local");
        assert_eq!(environments[0].label, "Sam's MacBook");
        assert_eq!(environments[1].target, "studio");
        assert_eq!(environments[1].label, "studio");
    }
}
