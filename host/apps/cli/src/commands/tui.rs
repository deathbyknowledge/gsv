use std::io::{self, IsTerminal};
use std::sync::Arc;

use crossterm::cursor::Show;
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
    Action, App, Approval, ApprovalDecision, ConnectionState, Effect, Moment, Role,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::chat::{implicit_personal_owner_uid, personal_process_id};

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
) -> Result<(), Box<dyn std::error::Error>> {
    let (runtime_sender, runtime_receiver) = mpsc::unbounded_channel();
    if demo {
        return run_interface(App::demo(), None, runtime_sender, runtime_receiver).await;
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
    let owner_uid = client
        .connection()
        .connect_result
        .as_ref()
        .ok_or("GSV returned no current user")
        .and_then(|result| implicit_personal_owner_uid(result.peer.principal.account.uid))?;
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
    let history = client
        .request_ok(
            "conversation.history",
            Some(json!({
                "conversationId": conversation_id,
                "limit": 200,
            })),
        )
        .await?;

    let mut app = App::new(ConnectionState::Ready);
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

    enable_raw_mode()?;
    let _restore = TerminalRestore;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;
    let mut terminal_events = EventStream::new();

    loop {
        terminal.draw(|frame| app.render(frame))?;
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
            Effect::Submit { id, text } => {
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
            app.set_activity(Some("WORKING".to_string()));
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

    match key.code {
        KeyCode::Char('q' | 'Q') if control => Some(Action::Quit),
        KeyCode::Char('.') if control => Some(Action::Abort),
        KeyCode::Char('p' | 'P') if control => Some(Action::PreviousMoment),
        KeyCode::Char('n' | 'N') if control => Some(Action::NextMoment),
        KeyCode::Char('a' | 'A') if control => Some(Action::MoveCursorHome),
        KeyCode::Char('e' | 'E') if control => Some(Action::MoveCursorEnd),
        KeyCode::Char('b' | 'B') if control => Some(Action::MoveCursorLeft),
        KeyCode::Char('f' | 'F') if control => Some(Action::MoveCursorRight),
        KeyCode::Char('w' | 'W') if control => Some(Action::DeleteWord),
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
        KeyCode::Enter => Some(Action::Submit),
        KeyCode::Esc => Some(Action::Escape),
        KeyCode::Backspace => Some(Action::Backspace),
        KeyCode::Delete => Some(Action::Delete),
        KeyCode::Left => Some(Action::MoveCursorLeft),
        KeyCode::Right => Some(Action::MoveCursorRight),
        KeyCode::Home => Some(Action::MoveCursorHome),
        KeyCode::End => Some(Action::MoveCursorEnd),
        KeyCode::Up if alt => Some(Action::PreviousMoment),
        KeyCode::Down if alt => Some(Action::NextMoment),
        KeyCode::PageUp => Some(Action::ScrollUp),
        KeyCode::PageDown => Some(Action::ScrollDown),
        KeyCode::Up if !app.draft_visible() => Some(Action::ScrollUp),
        KeyCode::Down if !app.draft_visible() => Some(Action::ScrollDown),
        KeyCode::Tab if !command_modifier => Some(Action::Insert("    ".to_string())),
        _ => None,
    }
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
            let mut moment = Moment::complete(id, role, text);
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
    app.commit_message(id, role_from_author(message.get("author")), text, run_id);
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
    use gsv_tui_core::{App, ConnectionState, Role};
    use serde_json::json;

    use super::{apply_signal, history_moments, truncate_chars};

    #[test]
    fn conversation_history_becomes_user_visible_moments() {
        let moments = history_moments(&json!({
            "messages": [
                {
                    "id": 1,
                    "author": { "kind": "user" },
                    "text": "hello"
                },
                {
                    "id": 2,
                    "author": { "kind": "process" },
                    "text": "hi",
                    "runId": "run-one"
                }
            ]
        }));
        assert_eq!(moments.len(), 2);
        assert_eq!(moments[0].role, Role::Human);
        assert_eq!(moments[1].role, Role::Intelligence);
        assert_eq!(moments[1].run_id.as_deref(), Some("run-one"));
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
}
