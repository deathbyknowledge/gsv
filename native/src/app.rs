use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::time::Instant;

use gpui::{
    actions, App, AppContext, Context, Entity, FocusHandle, Focusable, KeyBinding, ScrollHandle,
    Subscription, Task, Window,
};
use gpui_component::input::{InputEvent, InputState};

use crate::audio::{KeySound, TypingAudio};
use crate::client::{ApprovalDecision, ClientCommand, ClientHandle};
use crate::interaction::{CanvasInteraction, CanvasLayer, SubmissionFailure};
use crate::model::{Conversation, SurfaceMode};
use crate::startup::{LoginDefaults, LoginFlow, LoginProgress, LoginStep};
use crate::typography::TypeLayout;

mod login;
mod media;
mod rich;
mod session;
mod view;

use media::MediaCache;
use rich::CachedRichDocument;

actions!(
    gsv_native,
    [
        SubmitThought,
        InsertNewline,
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

#[derive(Clone, Copy, Debug, PartialEq)]
struct CachedTypeLayout {
    content_hash: u64,
    maximum_size: Option<u32>,
    weight: u32,
    layout: TypeLayout,
}

impl CachedTypeLayout {
    fn matches(self, text: &str, maximum_size: Option<f32>, weight: gpui::FontWeight) -> bool {
        self.content_hash == type_content_hash(text)
            && self.maximum_size == maximum_size.map(f32::to_bits)
            && self.weight == weight.0.to_bits()
    }
}

fn type_content_hash(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

fn new_login_input(
    login: &LoginFlow,
    window: &mut Window,
    cx: &mut Context<GsvApp>,
) -> Option<Entity<InputState>> {
    let (masked, placeholder) = match login.step() {
        LoginStep::Url => (false, "ws://localhost:8787/ws"),
        LoginStep::Username => (false, "username"),
        LoginStep::Password => (true, "password"),
        LoginStep::Connecting | LoginStep::SetupRequired => return None,
    };
    let input = cx.new(|cx| {
        InputState::new(window, cx)
            .masked(masked)
            .placeholder(placeholder)
    });
    let value = login.input_value();
    input.update(cx, |input, cx| input.set_value(value, window, cx));
    Some(input)
}

pub struct GsvApp {
    conversation: Conversation,
    interaction: CanvasInteraction,
    input: gpui::Entity<InputState>,
    login: Option<LoginFlow>,
    login_input: Option<Entity<InputState>>,
    login_input_len: usize,
    login_focus: FocusHandle,
    commands: tokio::sync::mpsc::UnboundedSender<ClientCommand>,
    audio: TypingAudio,
    terminal_draft: String,
    previous_input: String,
    pid: Option<String>,
    client_session_id: Option<u64>,
    last_history: Option<serde_json::Value>,
    terminal: Vec<TerminalExchange>,
    timeline_scroll: ScrollHandle,
    message_scroll: ScrollHandle,
    message_scroll_moment: Option<String>,
    history_scroll_accumulator: f32,
    history_scroll_last_event: Option<Instant>,
    stream_type_sizes: HashMap<String, f32>,
    type_layouts: HashMap<String, CachedTypeLayout>,
    rich_documents: HashMap<String, CachedRichDocument>,
    media_cache: MediaCache,
    draft_type_size: Option<f32>,
    stream_sequences: HashMap<String, u64>,
    type_viewport: Option<(u32, u32)>,
    transition_epoch: u64,
    transition_direction: f32,
    reduced_motion: bool,
    programmatic_input: Option<String>,
    approval_resume_mode: Option<SurfaceMode>,
    _input_subscription: Subscription,
    _login_subscription: Option<Subscription>,
    _event_task: Task<()>,
}

impl GsvApp {
    pub fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        client: ClientHandle,
        demo: bool,
        sound_enabled: bool,
        reduced_motion: bool,
    ) -> Self {
        let ClientHandle {
            commands,
            mut events,
            login: login_defaults,
        } = client;
        let input = cx.new(|cx| InputState::new(window, cx).auto_grow(1, 12).soft_wrap(true));
        let login_focus = cx.focus_handle();
        let input_subscription = cx.subscribe_in(&input, window, |this, _, event, window, cx| {
            this.on_input(event, window, cx);
        });
        let login = login_defaults.map(LoginFlow::new);
        let login_input_len = login
            .as_ref()
            .map(|login| login.input_value().chars().count())
            .unwrap_or(0);
        let login_input = login
            .as_ref()
            .and_then(|login| new_login_input(login, window, cx));
        let login_subscription = login_input.as_ref().map(|login_input| {
            cx.subscribe_in(login_input, window, |this, _, event, window, cx| {
                this.on_login_input(event, window, cx);
            })
        });
        if let Some(login_input) = &login_input {
            login_input.focus_handle(cx).focus(window);
        } else if login.is_some() {
            login_focus.focus(window);
        } else {
            input.focus_handle(cx).focus(window);
        }
        let event_task = cx.spawn_in(window, async move |this, cx| {
            while let Some(event) = events.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.handle_client_event(event, window, cx);
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });

        Self {
            conversation: if demo {
                Conversation::demo()
            } else {
                Conversation::connecting()
            },
            interaction: CanvasInteraction::new(),
            input,
            login,
            login_input,
            login_input_len,
            login_focus,
            commands,
            audio: TypingAudio::new(sound_enabled),
            terminal_draft: String::new(),
            previous_input: String::new(),
            pid: None,
            client_session_id: None,
            last_history: None,
            terminal: Vec::new(),
            timeline_scroll: ScrollHandle::new(),
            message_scroll: ScrollHandle::new(),
            message_scroll_moment: None,
            history_scroll_accumulator: 0.0,
            history_scroll_last_event: None,
            stream_type_sizes: HashMap::new(),
            type_layouts: HashMap::new(),
            rich_documents: HashMap::new(),
            media_cache: MediaCache::default(),
            draft_type_size: None,
            stream_sequences: HashMap::new(),
            type_viewport: None,
            transition_epoch: 0,
            transition_direction: 0.0,
            reduced_motion,
            programmatic_input: None,
            approval_resume_mode: None,
            _input_subscription: input_subscription,
            _login_subscription: login_subscription,
            _event_task: event_task,
        }
    }

    fn on_input(&mut self, event: &InputEvent, _window: &mut Window, cx: &mut Context<Self>) {
        match event {
            InputEvent::Change => {
                let value = self.input.read(cx).value().to_string();
                if self
                    .programmatic_input
                    .take()
                    .is_some_and(|expected| expected == value)
                {
                    self.previous_input = value;
                    return;
                }
                if value != self.previous_input {
                    if value.len() < self.previous_input.len() {
                        self.draft_type_size = None;
                    }
                    self.audio
                        .play(classify_change(&self.previous_input, &value));
                }

                match self.conversation.mode {
                    SurfaceMode::Conversation => {
                        let previous_layer = self.interaction.layer;
                        self.interaction.on_input(value.clone());
                        if previous_layer != self.interaction.layer
                            && self.interaction.layer == CanvasLayer::Draft
                        {
                            self.timeline_scroll
                                .scroll_to_item(self.conversation.moments.len());
                        }
                    }
                    SurfaceMode::Terminal => self.terminal_draft = value.clone(),
                }
                self.previous_input = value;
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {}
            InputEvent::Focus | InputEvent::Blur => {}
        }
    }

    fn on_login_input(&mut self, event: &InputEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(event, InputEvent::Change) {
            return;
        }
        let Some(input) = &self.login_input else {
            return;
        };
        let input_len = input.read(cx).value().chars().count();
        if input_len != self.login_input_len {
            self.audio.play(if input_len < self.login_input_len {
                KeySound::Delete
            } else {
                KeySound::Character
            });
            self.login_input_len = input_len;
        }
        cx.notify();
    }

    fn refresh_login_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._login_subscription = None;
        self.login_input = None;
        self.login_input_len = 0;
        let Some(login) = &self.login else {
            self.input.focus_handle(cx).focus(window);
            return;
        };
        self.login_input_len = login.input_value().chars().count();
        self.login_input = new_login_input(login, window, cx);
        if let Some(input) = &self.login_input {
            self._login_subscription =
                Some(
                    cx.subscribe_in(input, window, |this, _, event, window, cx| {
                        this.on_login_input(event, window, cx);
                    }),
                );
            input.focus_handle(cx).focus(window);
        } else {
            self.login_focus.focus(window);
        }
    }

    fn submit_login(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(login) = &mut self.login else {
            return;
        };
        if login.step() == LoginStep::Connecting {
            return;
        }
        let value = self
            .login_input
            .as_ref()
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_default();
        match login.submit(value) {
            Ok(LoginProgress::Next) => {
                self.audio.play(KeySound::Commit);
                self.begin_transition(1.0);
                self.refresh_login_input(window, cx);
                cx.notify();
            }
            Ok(LoginProgress::Connect(settings)) => {
                let attempt_id = settings.attempt_id;
                self.audio.play(KeySound::Commit);
                self.begin_transition(1.0);
                self.refresh_login_input(window, cx);
                if let Err(error) = self.commands.send(ClientCommand::Connect(settings)) {
                    drop(error);
                    if let Some(login) = &mut self.login {
                        login.fail_connection(
                            attempt_id,
                            LoginStep::Password,
                            "The native client stopped before it could connect.".to_string(),
                        );
                    }
                    self.refresh_login_input(window, cx);
                }
                cx.notify();
            }
            Err(message) => {
                login.set_error(message);
                cx.notify();
            }
        }
    }

    fn back_login(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(login) = &mut self.login else {
            return false;
        };
        if let Some(attempt_id) = login.cancel_connection() {
            let _ = self
                .commands
                .send(ClientCommand::CancelConnect { attempt_id });
            self.begin_transition(-1.0);
            self.refresh_login_input(window, cx);
            cx.notify();
            return true;
        }
        if !login.back() {
            return false;
        }
        self.begin_transition(-1.0);
        self.refresh_login_input(window, cx);
        cx.notify();
        true
    }

    fn show_login_failure(
        &mut self,
        attempt_id: u64,
        defaults: LoginDefaults,
        step: LoginStep,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let accepted = if let Some(login) = &mut self.login {
            login.fail_connection(attempt_id, step, message)
        } else {
            self.login = Some(LoginFlow::from_failure(defaults, step, message));
            true
        };
        if accepted {
            self.begin_transition(-1.0);
            self.refresh_login_input(window, cx);
        }
    }

    fn show_setup_required(
        &mut self,
        attempt_id: u64,
        defaults: LoginDefaults,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let accepted = if let Some(login) = &mut self.login {
            login.require_setup(attempt_id, message)
        } else {
            self.login = Some(LoginFlow::from_failure(
                defaults,
                LoginStep::SetupRequired,
                message,
            ));
            true
        };
        if accepted {
            self.begin_transition(-1.0);
            self.refresh_login_input(window, cx);
        }
    }

    fn show_login_runtime_error(
        &mut self,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(login) = &mut self.login else {
            return false;
        };
        if login.step() == LoginStep::Connecting {
            let defaults = login.defaults();
            self.login = Some(LoginFlow::from_failure(
                defaults,
                LoginStep::Password,
                message,
            ));
            self.refresh_login_input(window, cx);
        } else {
            login.set_error(message);
        }
        true
    }

    fn finish_login(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._login_subscription = None;
        self.login_input = None;
        self.login_input_len = 0;
        self.login = None;
        self.input.focus_handle(cx).focus(window);
        self.begin_transition(1.0);
    }

    fn focus_active_input(&self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(input) = &self.login_input {
            input.focus_handle(cx).focus(window);
        } else if self.login.is_some() {
            self.login_focus.focus(window);
        } else {
            self.input.focus_handle(cx).focus(window);
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.login.is_some() {
            self.submit_login(window, cx);
            return;
        }
        let raw = self.input.read(cx).value().to_string();
        if raw.trim().is_empty() {
            if !raw.is_empty() {
                match self.conversation.mode {
                    SurfaceMode::Conversation => self.interaction.on_input(String::new()),
                    SurfaceMode::Terminal => self.terminal_draft.clear(),
                }
                self.set_input_value(String::new(), window, cx);
            }
            return;
        }

        match self.conversation.mode {
            SurfaceMode::Terminal => self.submit_terminal(raw, window, cx),
            SurfaceMode::Conversation if self.interaction.is_approval() => {
                self.submit_approval(raw, window, cx);
            }
            SurfaceMode::Conversation => self.submit_conversation(raw, window, cx),
        }
    }

    fn submit_terminal(&mut self, command: String, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .commands
            .send(ClientCommand::Shell(command.clone()))
            .is_err()
        {
            self.terminal.push(TerminalExchange {
                command,
                output: "The native client stopped before this command could run.".to_string(),
                exit_code: None,
                pending: false,
            });
            return;
        }
        self.audio.play(KeySound::Commit);
        self.terminal.push(TerminalExchange {
            command,
            output: String::new(),
            exit_code: None,
            pending: true,
        });
        self.terminal_draft.clear();
        self.set_input_value(String::new(), window, cx);
    }

    fn submit_approval(&mut self, message: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.interaction.layer == CanvasLayer::ApprovalPrompt
            && !self.interaction.approval_draft().is_empty()
        {
            self.interaction.on_input(message);
            cx.notify();
            return;
        }
        let Some(approval) = self.conversation.pending_approval.clone() else {
            return;
        };
        if self.interaction.is_approval_submitting() {
            self.conversation.activity = Some("APPLYING".to_string());
            return;
        }
        let Some(decision) = approval_decision(&message) else {
            self.conversation.activity = Some("TYPE ALLOW ONCE, ALWAYS ALLOW, OR DENY".to_string());
            cx.notify();
            return;
        };

        let request_id = approval.request_id;
        if !self
            .interaction
            .begin_approval_submission(request_id.clone(), message.clone())
        {
            return;
        }
        if self
            .commands
            .send(ClientCommand::Decide {
                request_id: request_id.clone(),
                decision,
            })
            .is_err()
        {
            self.handle_approval_failure(
                &request_id,
                "The native client stopped before that decision could be applied.".to_string(),
                window,
                cx,
            );
            return;
        }
        self.audio.play(KeySound::Commit);
        self.conversation.activity = Some("APPLYING".to_string());
        self.set_input_value(String::new(), window, cx);
    }

    fn submit_conversation(
        &mut self,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.interaction.layer == CanvasLayer::Moment {
            self.interaction.show_conversation_draft();
            cx.notify();
            return;
        }
        if self.interaction.is_submitting() {
            self.conversation.activity = Some("SENDING PREVIOUS THOUGHT".to_string());
            cx.notify();
            return;
        }

        let moment_id = self.conversation.append_user(message.clone());
        let Some(submission_id) = self
            .interaction
            .begin_submission(message.clone(), moment_id.clone())
        else {
            self.conversation.remove_moment(&moment_id);
            return;
        };

        self.conversation.activity = Some("SENDING".to_string());
        self.begin_transition(1.0);
        self.timeline_scroll
            .scroll_to_item(self.conversation.selected);
        self.set_input_value(String::new(), window, cx);
        if self
            .commands
            .send(ClientCommand::Send {
                submission_id,
                message,
            })
            .is_err()
        {
            self.handle_submission_failure(
                submission_id,
                "The native client stopped before that thought could be sent.".to_string(),
                window,
                cx,
            );
        } else {
            self.audio.play(KeySound::Commit);
        }
    }

    fn handle_submission_failure(
        &mut self,
        submission_id: u64,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(failure) = self.interaction.submission_failed(submission_id) else {
            return;
        };
        match failure {
            SubmissionFailure::RestoreDraft { moment_id, text } => {
                self.conversation.remove_moment(&moment_id);
                if !self.interaction.is_approval() {
                    self.set_input_value(text, window, cx);
                }
            }
            SubmissionFailure::PreserveFailedMoment { moment_id } => {
                self.conversation.fail_user(&moment_id);
            }
        }
        self.conversation.show_error(message);
    }

    fn set_input_value(&mut self, value: String, window: &mut Window, cx: &mut Context<Self>) {
        self.draft_type_size = None;
        self.previous_input = value.clone();
        self.programmatic_input = Some(value.clone());
        let line = value.chars().filter(|character| *character == '\n').count() as u32;
        let column = value
            .rsplit('\n')
            .next()
            .unwrap_or_default()
            .chars()
            .count() as u32;
        self.input.update(cx, |input, cx| {
            input.set_value(value, window, cx);
            input.set_cursor_position(
                gpui_component::input::Position::new(line, column),
                window,
                cx,
            );
        });
        self.input.focus_handle(cx).focus(window);
    }

    fn hide_draft(&mut self, _: &HideDraft, window: &mut Window, cx: &mut Context<Self>) {
        if self.login.is_some() {
            self.back_login(window, cx);
            return;
        }
        if self.conversation.mode == SurfaceMode::Conversation && self.interaction.hide_draft() {
            self.begin_transition(0.0);
            cx.notify();
        }
    }

    fn submit_thought_action(
        &mut self,
        _: &SubmitThought,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let modifiers = window.modifiers();
        if modifiers.shift || modifiers.secondary() {
            return;
        }
        self.submit(window, cx);
    }

    fn insert_newline_action(
        &mut self,
        _: &InsertNewline,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.login.is_some() {
            cx.stop_propagation();
            return;
        }
        self.input
            .update(cx, |input, cx| input.insert("\n", window, cx));
    }

    fn abort_run(&mut self, _: &AbortRun, _: &mut Window, _: &mut Context<Self>) {
        if self.login.is_some() {
            return;
        }
        if let Some(run_id) = self.conversation.request_abort() {
            if self
                .commands
                .send(ClientCommand::Abort {
                    run_id: run_id.clone(),
                })
                .is_err()
            {
                self.conversation.abort_failed(&run_id);
            }
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
        if self.login.is_some() {
            return;
        }
        let next = match self.conversation.mode {
            SurfaceMode::Conversation => {
                self.conversation.mode = SurfaceMode::Terminal;
                self.terminal_draft.clone()
            }
            SurfaceMode::Terminal => {
                self.terminal_draft = self.input.read(cx).value().to_string();
                self.conversation.mode = SurfaceMode::Conversation;
                if self.interaction.is_approval() {
                    self.interaction.approval_draft().to_string()
                } else {
                    self.interaction.conversation_draft().to_string()
                }
            }
        };
        self.begin_transition(0.0);
        self.set_input_value(next, window, cx);
        cx.notify();
    }

    fn previous_moment(&mut self, _: &PreviousMoment, _: &mut Window, cx: &mut Context<Self>) {
        self.move_moment(-1, cx);
    }

    fn next_moment(&mut self, _: &NextMoment, _: &mut Window, cx: &mut Context<Self>) {
        self.move_moment(1, cx);
    }

    fn move_moment(&mut self, direction: i8, cx: &mut Context<Self>) {
        if self.login.is_some()
            || self.conversation.mode != SurfaceMode::Conversation
            || self.interaction.is_approval()
        {
            return;
        }
        self.interaction.hide_draft();
        let previous = self.conversation.selected;
        if direction < 0 {
            self.conversation.select_previous();
        } else {
            self.conversation.select_next();
        }
        if previous != self.conversation.selected {
            self.timeline_scroll
                .scroll_to_item(self.conversation.selected);
            self.begin_transition(if direction < 0 { -1.0 } else { 1.0 });
            cx.notify();
        }
    }

    fn select_moment(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.login.is_some()
            || self.interaction.is_approval()
            || self.conversation.moments.is_empty()
        {
            return;
        }
        self.interaction.hide_draft();
        let previous = self.conversation.selected;
        self.conversation.select(index);
        self.timeline_scroll
            .scroll_to_item(self.conversation.selected);
        if previous != self.conversation.selected {
            self.begin_transition(if index < previous { -1.0 } else { 1.0 });
        }
        cx.notify();
    }

    fn show_held_draft(&mut self, cx: &mut Context<Self>) {
        if self.login.is_some() || self.interaction.is_approval() {
            return;
        }
        self.interaction.show_conversation_draft();
        self.timeline_scroll
            .scroll_to_item(self.conversation.moments.len());
        self.begin_transition(1.0);
        cx.notify();
    }

    fn begin_transition(&mut self, direction: f32) {
        self.history_scroll_accumulator = 0.0;
        self.history_scroll_last_event = None;
        self.transition_epoch = self.transition_epoch.wrapping_add(1);
        self.transition_direction = direction;
    }
}

impl Drop for GsvApp {
    fn drop(&mut self) {
        let _ = self.commands.send(ClientCommand::Shutdown);
    }
}

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("secondary-enter", InsertNewline, Some("Input")),
        KeyBinding::new("shift-enter", InsertNewline, Some("Input")),
        KeyBinding::new("enter", SubmitThought, Some("Input")),
        KeyBinding::new("escape", HideDraft, None),
        KeyBinding::new("secondary-.", AbortRun, None),
        KeyBinding::new("secondary-`", ToggleTerminal, None),
        KeyBinding::new("alt-up", PreviousMoment, None),
        KeyBinding::new("alt-down", NextMoment, None),
    ]);
}

fn classify_change(previous: &str, next: &str) -> KeySound {
    let prefix = previous
        .char_indices()
        .zip(next.char_indices())
        .take_while(|((_, left), (_, right))| left == right)
        .last()
        .map_or(0, |((offset, character), _)| offset + character.len_utf8());
    let previous_tail = &previous[prefix..];
    let next_tail = &next[prefix..];
    let common_suffix = previous_tail
        .chars()
        .rev()
        .zip(next_tail.chars().rev())
        .take_while(|(left, right)| left == right)
        .map(|(character, _)| character.len_utf8())
        .sum::<usize>()
        .min(previous_tail.len())
        .min(next_tail.len());
    let inserted_end = next.len().saturating_sub(common_suffix);
    let inserted = &next[prefix..inserted_end];

    if inserted.is_empty() {
        KeySound::Delete
    } else {
        match inserted.chars().last() {
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
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{TestAppContext, WindowOptions};
    use gpui_component::Root;

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

    #[test]
    fn edit_sounds_follow_the_changed_range() {
        assert_eq!(classify_change("ac", "a c"), KeySound::Space);
        assert_eq!(classify_change("a c", "ac"), KeySound::Delete);
        assert_eq!(classify_change("tail", "t中ail"), KeySound::Character);
        assert_eq!(classify_change("one", "one\ntwo"), KeySound::Character);
        assert_eq!(classify_change("one", "one\n"), KeySound::Commit);
    }

    #[gpui::test]
    fn typing_from_a_moment_enters_the_visible_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "hello");

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.interaction.layer, CanvasLayer::Draft);
            assert_eq!(app.interaction.visible_draft(), Some("hello"));
        });
    }

    #[gpui::test]
    fn password_login_is_isolated_and_dropped_when_connecting(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: Some(crate::startup::LoginDefaults {
                url: Some("ws://localhost:8788/ws".to_string()),
                username: Some("hank".to_string()),
            }),
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, false, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), " exact password ");
        cx.simulate_keystrokes(window.into(), "shift-enter");
        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Password)
            );
            assert_eq!(
                app.login_input
                    .as_ref()
                    .map(|input| input.read(cx).value().to_string())
                    .as_deref(),
                Some(" exact password ")
            );
            assert!(app.previous_input.is_empty());
            assert_eq!(app.interaction.layer, CanvasLayer::Moment);
        });
        cx.simulate_keystrokes(window.into(), "ctrl-enter");
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Password)
            );
        });

        cx.simulate_keystrokes(window.into(), "enter");
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Connecting)
            );
            assert!(app.login_input.is_none());
        });
        let received = command_rx
            .try_recv()
            .ok()
            .and_then(|command| match command {
                ClientCommand::Connect(settings) => match settings.credential {
                    crate::startup::Credential::Password(password) => {
                        Some((settings.attempt_id, password))
                    }
                    crate::startup::Credential::Token(_) => None,
                },
                _ => None,
            });
        assert_eq!(
            received.as_ref().map(|(_, password)| password.as_str()),
            Some(" exact password ")
        );
        let attempt_id = received.map(|(attempt_id, _)| attempt_id).unwrap_or(0);

        cx.simulate_keystrokes(window.into(), "escape");
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Password)
            );
            assert!(app.login_input.is_some());
        });
        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::CancelConnect { attempt_id: cancelled })
                if cancelled == attempt_id
        ));

        let _ = event_tx.send(crate::client::ClientEvent::Connected {
            attempt_id,
            session_id: 9,
            pid: "stale-login".to_string(),
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Password)
            );
            assert!(app.client_session_id.is_none());
        });

        let _ = event_tx.send(crate::client::ClientEvent::SetupRequired {
            attempt_id: 0,
            defaults: crate::startup::LoginDefaults {
                url: Some("ws://localhost:8788/ws".to_string()),
                username: Some("hank".to_string()),
            },
            message: "Setup is incomplete.".to_string(),
        });
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).login.as_ref().map(LoginFlow::step),
                Some(LoginStep::SetupRequired)
            );
        });
        cx.simulate_keystrokes(window.into(), "enter");
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Url)
            );
        });
    }

    #[gpui::test]
    fn submit_shortcut_is_non_mutating_and_requires_a_visible_held_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "exact thought");
        cx.simulate_keystrokes(window.into(), "escape enter");
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.interaction.layer, CanvasLayer::Draft);
            assert_eq!(app.input.read(cx).value().as_ref(), "exact thought");
        });
        assert!(command_rx.try_recv().is_err());

        cx.simulate_keystrokes(window.into(), "enter");
        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::Send { message, .. }) if message == "exact thought"
        ));
    }

    #[gpui::test]
    fn modified_enter_adds_newlines_and_plain_enter_submits(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "first");
        cx.simulate_keystrokes(window.into(), "ctrl-enter");
        cx.simulate_input(window.into(), "second");
        cx.simulate_keystrokes(window.into(), "shift-enter");
        cx.simulate_input(window.into(), "third");

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).input.read(cx).value().as_ref(),
                "first\nsecond\nthird"
            );
        });
        assert!(command_rx.try_recv().is_err());

        cx.simulate_keystrokes(window.into(), "enter");
        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::Send { message, .. }) if message == "first\nsecond\nthird"
        ));
    }

    #[gpui::test]
    fn mode_round_trip_keeps_a_hidden_draft_hidden(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "unfinished");
        cx.simulate_keystrokes(window.into(), "escape ctrl-` ctrl-`");
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.interaction.layer, CanvasLayer::Moment);
            assert_eq!(app.interaction.conversation_draft(), "unfinished");
            assert_eq!(app.input.read(cx).value().as_ref(), "unfinished");
        });
    }

    #[gpui::test]
    fn mode_round_trip_restores_a_trailing_newline_caret_at_the_end(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "tail");
        cx.simulate_keystrokes(window.into(), "ctrl-enter escape ctrl-` ctrl-`");
        cx.run_until_parked();
        cx.simulate_input(window.into(), "next");

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            assert_eq!(app.read(cx).input.read(cx).value().as_ref(), "tail\nnext");
        });
    }

    #[gpui::test]
    fn approval_takeover_restores_the_terminal_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_keystrokes(window.into(), "ctrl-`");
        cx.simulate_input(window.into(), "status --watch");
        let _ = event_tx.send(crate::client::ClientEvent::Connected {
            attempt_id: 0,
            session_id: 7,
            pid: "pid-1".to_string(),
        });
        let _ = event_tx.send(crate::client::ClientEvent::Signal {
            session_id: 7,
            name: "proc.run.hil.requested".to_string(),
            payload: serde_json::json!({
                "pid": "pid-1",
                "runId": "run-1",
                "requestId": "request-1",
                "toolName": "Shell",
                "syscall": "shell.exec",
                "args": { "input": "deploy" }
            }),
        });
        cx.run_until_parked();

        let app_entity = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app_entity.read(cx);
            assert_eq!(app.conversation.mode, SurfaceMode::Conversation);
            assert!(app.interaction.is_approval());
            assert_eq!(app.terminal_draft, "status --watch");
        });

        let _ = event_tx.send(crate::client::ClientEvent::History {
            session_id: 7,
            history: serde_json::json!({ "messages": [] }),
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app_entity.read(cx);
            assert_eq!(app.conversation.mode, SurfaceMode::Terminal);
            assert_eq!(app.input.read(cx).value().as_ref(), "status --watch");
        });
    }
}
