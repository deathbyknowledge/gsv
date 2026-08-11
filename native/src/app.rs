use std::sync::mpsc::TryRecvError;
use std::time::Duration;

use gpui::{
    actions, App, AppContext, Context, Focusable, KeyBinding, Subscription, Task, Timer, Window,
};
use gpui_component::input::{InputEvent, InputState};

use crate::audio::{KeySound, TypingAudio};
use crate::client::{ApprovalDecision, ClientCommand, ClientEvent, ClientHandle};
use crate::model::{
    extract_text, parse_history, parse_pending_approval, ConnectionState, Conversation,
    MomentState, SurfaceMode,
};

mod view;

actions!(
    gsv_native,
    [
        HideDraft,
        AbortRun,
        ToggleTerminal,
        PreviousMoment,
        NextMoment
    ]
);

#[derive(Clone, Debug)]
struct TerminalExchange {
    command: String,
    output: String,
    exit_code: Option<i64>,
    pending: bool,
}

pub struct GsvApp {
    conversation: Conversation,
    input: gpui::Entity<InputState>,
    commands: tokio::sync::mpsc::UnboundedSender<ClientCommand>,
    events: std::sync::mpsc::Receiver<ClientEvent>,
    audio: TypingAudio,
    draft_visible: bool,
    conversation_draft: String,
    terminal_draft: String,
    previous_input: String,
    pid: Option<String>,
    terminal: Vec<TerminalExchange>,
    _input_subscription: Subscription,
    _poll_task: Task<()>,
}

impl GsvApp {
    pub fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        client: ClientHandle,
        demo: bool,
        sound_enabled: bool,
    ) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).auto_grow(1, 12).soft_wrap(true));
        input.focus_handle(cx).focus(window);

        let input_subscription = cx.subscribe_in(&input, window, |this, _, event, window, cx| {
            this.on_input(event, window, cx)
        });
        let poll_task = cx.spawn(async move |this, cx| loop {
            Timer::after(Duration::from_millis(16)).await;
            let Some(this) = this.upgrade() else {
                break;
            };
            if this
                .update(cx, |this, cx| {
                    this.drain_client_events(cx);
                })
                .is_err()
            {
                break;
            }
        });

        Self {
            conversation: if demo {
                Conversation::demo()
            } else {
                Conversation::connecting()
            },
            input,
            commands: client.commands,
            events: client.events,
            audio: TypingAudio::new(sound_enabled),
            draft_visible: false,
            conversation_draft: String::new(),
            terminal_draft: String::new(),
            previous_input: String::new(),
            pid: None,
            terminal: Vec::new(),
            _input_subscription: input_subscription,
            _poll_task: poll_task,
        }
    }

    fn on_input(&mut self, event: &InputEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            InputEvent::Change => {
                let value = self.input.read(cx).value().to_string();
                if value != self.previous_input {
                    let sound = classify_change(&self.previous_input, &value);
                    self.audio.play(sound);
                }

                match self.conversation.mode {
                    SurfaceMode::Conversation => self.conversation_draft = value.clone(),
                    SurfaceMode::Terminal => self.terminal_draft = value.clone(),
                }
                if self.conversation.mode == SurfaceMode::Conversation && !value.is_empty() {
                    self.draft_visible = true;
                    self.conversation.select_latest();
                }
                self.previous_input = value;
                cx.notify();
            }
            InputEvent::PressEnter { secondary } => match self.conversation.mode {
                SurfaceMode::Conversation if *secondary => self.submit(window, cx),
                SurfaceMode::Terminal if !*secondary => self.submit(window, cx),
                _ => {}
            },
            InputEvent::Focus | InputEvent::Blur => {}
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let raw = self.input.read(cx).value().to_string();
        let message = raw.trim().to_string();
        if message.is_empty() {
            self.clear_input(window, cx);
            return;
        }

        match self.conversation.mode {
            SurfaceMode::Terminal => {
                self.terminal.push(TerminalExchange {
                    command: message.clone(),
                    output: String::new(),
                    exit_code: None,
                    pending: true,
                });
                let _ = self.commands.send(ClientCommand::Shell(message));
                self.clear_input(window, cx);
            }
            SurfaceMode::Conversation => {
                if let Some(approval) = self.conversation.pending_approval.clone() {
                    let Some(decision) = approval_decision(&message) else {
                        self.conversation.activity =
                            Some("TYPE ALLOW ONCE, ALWAYS ALLOW, OR DENY".to_string());
                        cx.notify();
                        return;
                    };
                    let _ = self.commands.send(ClientCommand::Decide {
                        request_id: approval.request_id,
                        decision,
                    });
                    self.clear_input(window, cx);
                    return;
                }

                self.conversation.append_user(message.clone());
                self.conversation.activity = Some("SENDING".to_string());
                let _ = self.commands.send(ClientCommand::Send(message));
                self.clear_input(window, cx);
            }
        }
        cx.notify();
    }

    fn clear_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.previous_input.clear();
        self.input.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        match self.conversation.mode {
            SurfaceMode::Conversation => self.conversation_draft.clear(),
            SurfaceMode::Terminal => self.terminal_draft.clear(),
        }
        self.draft_visible = false;
    }

    fn hide_draft(&mut self, _: &HideDraft, _: &mut Window, cx: &mut Context<Self>) {
        if self.conversation.mode == SurfaceMode::Conversation
            && !self.conversation_draft.is_empty()
        {
            self.draft_visible = false;
            cx.notify();
        }
    }

    fn abort_run(&mut self, _: &AbortRun, _: &mut Window, _: &mut Context<Self>) {
        if let Some(run_id) = self.conversation.request_abort() {
            let _ = self.commands.send(ClientCommand::Abort { run_id });
        }
    }

    fn toggle_terminal_action(
        &mut self,
        _: &ToggleTerminal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_terminal(window, cx);
    }

    fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let current = self.input.read(cx).value().to_string();
        let next = match self.conversation.mode {
            SurfaceMode::Conversation => {
                self.conversation_draft = current;
                self.conversation.mode = SurfaceMode::Terminal;
                self.terminal_draft.clone()
            }
            SurfaceMode::Terminal => {
                self.terminal_draft = current;
                self.conversation.mode = SurfaceMode::Conversation;
                self.conversation_draft.clone()
            }
        };
        self.previous_input = next.clone();
        self.input.update(cx, |input, cx| {
            input.set_value(next.clone(), window, cx);
        });
        self.draft_visible = !next.is_empty();
        self.input.focus_handle(cx).focus(window);
        cx.notify();
    }

    fn previous_moment(&mut self, _: &PreviousMoment, _: &mut Window, cx: &mut Context<Self>) {
        if self.conversation.mode == SurfaceMode::Conversation {
            self.draft_visible = false;
            self.conversation.select_previous();
            cx.notify();
        }
    }

    fn next_moment(&mut self, _: &NextMoment, _: &mut Window, cx: &mut Context<Self>) {
        if self.conversation.mode == SurfaceMode::Conversation {
            self.draft_visible = false;
            self.conversation.select_next();
            cx.notify();
        }
    }

    fn drain_client_events(&mut self, cx: &mut Context<Self>) {
        let mut changed = false;
        loop {
            match self.events.try_recv() {
                Ok(event) => {
                    self.handle_client_event(event);
                    changed = true;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        if changed {
            cx.notify();
        }
    }

    fn handle_client_event(&mut self, event: ClientEvent) {
        match event {
            ClientEvent::Connecting => {
                self.conversation.connection = ConnectionState::Connecting;
                self.conversation.activity = Some("CONNECTING".to_string());
            }
            ClientEvent::Connected { pid } => {
                self.pid = Some(pid);
                self.conversation.connection = ConnectionState::Connected;
                self.conversation.activity = None;
            }
            ClientEvent::History(history) => {
                let live_moment = self
                    .conversation
                    .moments
                    .iter()
                    .rev()
                    .find(|moment| moment.state == MomentState::Streaming)
                    .cloned();
                let moments = parse_history(&history);
                self.conversation.replace_history(moments);
                let active_run_id = history
                    .get("activeRunId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                if let Some(run_id) = active_run_id {
                    if let Some(live_moment) = live_moment
                        .filter(|moment| {
                            moment.run_id.as_deref() == Some(run_id.as_str())
                                && !moment.text.is_empty()
                        })
                        .filter(|_| self.conversation.accepts_run(Some(&run_id)))
                    {
                        self.conversation.active_run_id = Some(run_id);
                        self.conversation.moments.push(live_moment);
                        self.conversation.select_latest();
                    } else {
                        self.conversation.start_run(run_id);
                    }
                }
                if let Some(approval) = history.get("pendingHil").and_then(parse_pending_approval) {
                    self.conversation.set_approval(approval);
                }
            }
            ClientEvent::Signal { name, payload } => self.handle_signal(&name, &payload),
            ClientEvent::SendAccepted { run_id, queued } => {
                if queued {
                    self.conversation.activity = Some("QUEUED".to_string());
                } else {
                    self.conversation.start_run(run_id);
                }
            }
            ClientEvent::AbortResolved { run_id } => {
                self.conversation.abort_run(&run_id);
            }
            ClientEvent::AbortFailed { run_id, message } => {
                self.conversation.abort_failed(&run_id);
                self.conversation.show_error(message);
            }
            ClientEvent::ApprovalResolved => {
                self.conversation.clear_approval();
                let _ = self.commands.send(ClientCommand::RefreshHistory);
            }
            ClientEvent::ShellResult {
                command,
                output,
                exit_code,
            } => {
                if let Some(exchange) = self
                    .terminal
                    .iter_mut()
                    .find(|exchange| exchange.pending && exchange.command == command)
                {
                    exchange.output = output;
                    exchange.exit_code = exit_code;
                    exchange.pending = false;
                } else {
                    self.terminal.push(TerminalExchange {
                        command,
                        output,
                        exit_code,
                        pending: false,
                    });
                }
            }
            ClientEvent::Error(message) => self.conversation.show_error(message),
            ClientEvent::Disconnected(message) => {
                self.conversation.connection = ConnectionState::Disconnected;
                self.conversation.show_error(message);
            }
        }
    }

    fn handle_signal(&mut self, name: &str, payload: &serde_json::Value) {
        if let (Some(expected), Some(actual)) = (
            self.pid.as_deref(),
            payload.get("pid").and_then(serde_json::Value::as_str),
        ) {
            if expected != actual {
                return;
            }
        }

        let run_id = payload.get("runId").and_then(serde_json::Value::as_str);
        match name {
            "proc.run.started" => {
                if let Some(run_id) = run_id {
                    self.conversation.start_run(run_id);
                }
            }
            "proc.run.stream" => {
                let event = payload.get("event").unwrap_or(payload);
                if event.get("type").and_then(serde_json::Value::as_str) == Some("text_delta") {
                    if let Some(delta) = event.get("delta").and_then(serde_json::Value::as_str) {
                        self.conversation.stream_text(run_id, delta);
                    }
                }
            }
            "proc.run.output" => {
                let text = payload
                    .get("text")
                    .or_else(|| payload.get("output"))
                    .map(extract_text)
                    .unwrap_or_default();
                if !text.is_empty() {
                    self.conversation.stream_text(run_id, &text);
                }
            }
            "proc.run.tool.started" => {
                if !self.conversation.accepts_run(run_id) {
                    return;
                }
                let syscall = payload
                    .get("syscall")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                self.conversation.activity = Some(human_activity(syscall).to_string());
            }
            "proc.run.hil.requested" => {
                if let Some(approval) = parse_pending_approval(payload) {
                    self.conversation.set_approval(approval);
                }
            }
            "proc.run.finished" => {
                let error = payload.get("error").map(extract_text);
                self.conversation
                    .finish_run(run_id, error.as_deref().filter(|text| !text.is_empty()));
                let _ = self.commands.send(ClientCommand::RefreshHistory);
            }
            "proc.changed" => {
                let changes = payload.get("changes").unwrap_or(payload);
                if changes.get("activeRunId").is_some() || changes.get("queuedCount").is_some() {
                    let _ = self.commands.send(ClientCommand::RefreshHistory);
                }
            }
            _ => {}
        }
    }
}

impl Drop for GsvApp {
    fn drop(&mut self) {
        let _ = self.commands.send(ClientCommand::Shutdown);
    }
}

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("escape", HideDraft, None),
        KeyBinding::new("secondary-.", AbortRun, None),
        KeyBinding::new("secondary-`", ToggleTerminal, None),
        KeyBinding::new("alt-up", PreviousMoment, None),
        KeyBinding::new("alt-down", NextMoment, None),
    ]);
}

fn classify_change(previous: &str, next: &str) -> KeySound {
    if next.len() < previous.len() {
        KeySound::Delete
    } else {
        match next.chars().last() {
            Some(' ' | '\t') => KeySound::Space,
            Some('\n' | '\r') => KeySound::Commit,
            _ => KeySound::Character,
        }
    }
}

fn approval_decision(input: &str) -> Option<ApprovalDecision> {
    let normalized = input.trim().to_ascii_lowercase().replace(['.', ','], "");
    match normalized.as_str() {
        "allow" | "allow once" | "approve" | "approve once" | "yes" => {
            Some(ApprovalDecision::Approve { remember: false })
        }
        "always" | "always allow" | "approve always" => {
            Some(ApprovalDecision::Approve { remember: true })
        }
        "deny" | "no" | "reject" => Some(ApprovalDecision::Deny),
        _ => None,
    }
}

fn human_activity(syscall: &str) -> &'static str {
    if syscall.starts_with("fs.") {
        "READING"
    } else if syscall.starts_with("net.") || syscall.starts_with("browser.") {
        "LOOKING"
    } else if syscall.starts_with("shell.") {
        "WORKING"
    } else {
        "THINKING"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approvals_are_deliberately_narrow_language() {
        assert!(matches!(
            approval_decision("allow once"),
            Some(ApprovalDecision::Approve { remember: false })
        ));
        assert!(matches!(
            approval_decision("always allow"),
            Some(ApprovalDecision::Approve { remember: true })
        ));
        assert!(matches!(
            approval_decision("deny"),
            Some(ApprovalDecision::Deny)
        ));
        assert!(approval_decision("do whatever seems right").is_none());
    }
}
