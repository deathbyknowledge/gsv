mod markdown;
mod theme;

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Margin, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph, Wrap};
use ratatui::Frame;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use markdown::{render_artifacts, render_markdown, render_plain};
use theme::Palette;

pub use theme::Theme;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Human,
    Intelligence,
    System,
}

impl Role {
    fn color(self, palette: Palette) -> Color {
        match self {
            Self::Human => palette.human,
            Self::Intelligence => palette.foreground,
            Self::System => palette.warning,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    Document,
}

impl MediaKind {
    fn symbol(self) -> &'static str {
        match self {
            Self::Image => "▧",
            Self::Audio => "▶",
            Self::Video => "▶",
            Self::Document => "↗",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Artifact {
    pub kind: MediaKind,
    pub mime_type: String,
    pub filename: Option<String>,
    pub size: Option<u64>,
    pub duration_ms: Option<u64>,
    pub transcription: Option<String>,
    /// A user-visible reference such as `target:/path` or a legacy media key.
    pub source: Option<String>,
    /// The immutable revision paired with a canonical resource source.
    pub revision: Option<String>,
}

impl Artifact {
    pub fn display_name(&self) -> &str {
        self.filename.as_deref().unwrap_or("untitled")
    }

    fn cache_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            self.source.as_deref().unwrap_or_default(),
            self.revision.as_deref().unwrap_or_default(),
            self.mime_type
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityEnvironment {
    /// Exact routing identity. Display sanitization must never change this value.
    pub target: String,
    pub label: String,
    pub cwd: Option<String>,
}

impl CapabilityEnvironment {
    pub fn new(target: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            label: label.into(),
            cwd: None,
        }
    }

    pub fn gsv() -> Self {
        Self::new("gsv", "gsv")
    }

    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MediaSlot {
    pub key: String,
    pub area: Rect,
    pub artifact: Artifact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MomentState {
    Complete,
    Streaming,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Moment {
    pub id: String,
    pub role: Role,
    pub text: String,
    pub run_id: Option<String>,
    pub state: MomentState,
    pub artifacts: Vec<Artifact>,
    pub environment: Option<CapabilityEnvironment>,
}

impl Moment {
    pub fn complete(id: impl Into<String>, role: Role, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            role,
            text: text.into(),
            run_id: None,
            state: MomentState::Complete,
            artifacts: Vec::new(),
            environment: None,
        }
    }

    pub fn with_artifacts(mut self, artifacts: Vec<Artifact>) -> Self {
        self.artifacts = artifacts;
        self
    }

    pub fn with_environment(mut self, environment: CapabilityEnvironment) -> Self {
        self.environment = Some(environment);
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionState {
    Demo,
    Connecting,
    Ready,
    Working,
    Offline,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approval {
    pub request_id: String,
    pub syscall: String,
    pub target: String,
    pub preview: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    Insert(String),
    Backspace,
    Delete,
    DeleteWord,
    MoveCursorLeft,
    MoveCursorRight,
    MoveCursorHome,
    MoveCursorEnd,
    Newline,
    Submit,
    BeginCompose,
    Escape,
    PreviousTurn,
    NextTurn,
    FirstTurn,
    LastTurn,
    ScrollUp,
    ScrollDown,
    PreviousChoice,
    NextChoice,
    PreviousMedia,
    NextMedia,
    ToggleHelp,
    ToggleMarkdown,
    ToggleVim,
    ToggleMedia,
    Abort,
    DecideApproval {
        decision: ApprovalDecision,
        remember: bool,
    },
    Quit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Effect {
    Submit {
        id: u64,
        text: String,
        target: String,
        cwd: Option<String>,
    },
    Abort,
    DecideApproval {
        request_id: String,
        decision: ApprovalDecision,
        remember: bool,
    },
    Quit,
}

#[derive(Clone, Debug)]
struct PendingSubmission {
    id: u64,
    text: String,
}

#[derive(Debug)]
pub struct App {
    moments: Vec<Moment>,
    selected: usize,
    moment_scroll: u16,
    last_max_scroll: u16,
    draft: String,
    draft_cursor: usize,
    draft_visible: bool,
    help_visible: bool,
    connection: ConnectionState,
    activity: Option<String>,
    pending_submission: Option<PendingSubmission>,
    next_submission_id: u64,
    approval: Option<Approval>,
    principal: String,
    environments: Vec<CapabilityEnvironment>,
    active_environment: usize,
    environment_picker: bool,
    environment_query: String,
    environment_choice: usize,
    theme: Theme,
    raw_markdown: bool,
    vim_enabled: bool,
    inline_images: bool,
    media_expanded: bool,
    media_focus: usize,
    media_slots: Vec<MediaSlot>,
}

impl App {
    pub fn new(connection: ConnectionState) -> Self {
        Self {
            moments: Vec::new(),
            selected: 0,
            moment_scroll: 0,
            last_max_scroll: 0,
            draft: String::new(),
            draft_cursor: 0,
            draft_visible: false,
            help_visible: false,
            connection,
            activity: None,
            pending_submission: None,
            next_submission_id: 1,
            approval: None,
            principal: "you".to_string(),
            environments: vec![CapabilityEnvironment::gsv()],
            active_environment: 0,
            environment_picker: false,
            environment_query: String::new(),
            environment_choice: 0,
            theme: Theme::Gsv,
            raw_markdown: false,
            vim_enabled: false,
            inline_images: false,
            media_expanded: false,
            media_focus: 0,
            media_slots: Vec::new(),
        }
    }

    pub fn demo() -> Self {
        let mut app = Self::new(ConnectionState::Demo);
        app.moments.push(Moment::complete(
            "welcome",
            Role::Intelligence,
            "Tell me what you want done.\n\nTry **show me Markdown and media**, or simply start typing.",
        ));
        app
    }

    pub fn moments(&self) -> &[Moment] {
        &self.moments
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    pub fn draft(&self) -> &str {
        &self.draft
    }

    pub fn draft_visible(&self) -> bool {
        self.draft_visible
    }

    pub fn approval(&self) -> Option<&Approval> {
        self.approval.as_ref()
    }

    pub fn vim_enabled(&self) -> bool {
        self.vim_enabled
    }

    pub fn environment_picker_visible(&self) -> bool {
        self.environment_picker
    }

    pub fn active_environment(&self) -> &CapabilityEnvironment {
        &self.environments[self.active_environment]
    }

    pub fn media_slots(&self) -> &[MediaSlot] {
        &self.media_slots
    }

    pub fn media_expanded(&self) -> bool {
        self.media_expanded
    }

    pub fn set_principal(&mut self, principal: impl AsRef<str>) {
        self.principal = prompt_token(principal.as_ref(), "you");
    }

    pub fn set_environments(&mut self, environments: Vec<CapabilityEnvironment>) {
        let active_target = self.active_environment().target.clone();
        let mut normalized = Vec::with_capacity(environments.len().saturating_add(1));
        normalized.push(
            environments
                .iter()
                .find(|environment| environment.target == "gsv")
                .cloned()
                .unwrap_or_else(CapabilityEnvironment::gsv),
        );
        for environment in environments {
            if environment.target == "gsv"
                || environment.target.trim().is_empty()
                || normalized
                    .iter()
                    .any(|candidate| candidate.target == environment.target)
            {
                continue;
            }
            normalized.push(environment);
        }
        self.environments = normalized;
        self.active_environment = self
            .environments
            .iter()
            .position(|environment| environment.target == active_target)
            .unwrap_or(0);
        self.environment_choice = 0;
    }

    pub fn set_vim_enabled(&mut self, enabled: bool) {
        self.vim_enabled = enabled;
    }

    pub fn set_inline_images(&mut self, enabled: bool) {
        self.inline_images = enabled;
        if !enabled {
            self.media_expanded = false;
            self.media_focus = 0;
        }
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
    }

    pub fn set_connection(&mut self, connection: ConnectionState) {
        self.connection = connection;
    }

    pub fn set_activity(&mut self, activity: Option<String>) {
        self.activity = activity.map(|activity| sanitize_status(&activity));
    }

    pub fn replace_history(&mut self, moments: Vec<Moment>) {
        if moments.is_empty() {
            return;
        }
        self.moments = moments;
        self.selected = self.moments.len().saturating_sub(1);
        self.moment_scroll = 0;
        self.media_expanded = false;
        self.media_focus = 0;
    }

    pub fn enter_approval(&mut self, mut approval: Approval) {
        approval.syscall = sanitize_label(&approval.syscall, "unknown action", 96);
        approval.target = sanitize_label(&approval.target, "unknown target", 96);
        approval.preview = sanitize_multiline(&approval.preview, 4_000);
        self.approval = Some(approval);
        self.draft_visible = false;
        self.media_expanded = false;
    }

    pub fn leave_approval(&mut self, request_id: &str) {
        if self
            .approval
            .as_ref()
            .is_some_and(|approval| approval.request_id == request_id)
        {
            self.approval = None;
        }
    }

    pub fn dispatch(&mut self, action: Action) -> Vec<Effect> {
        if self.help_visible {
            return match action {
                Action::Escape | Action::ToggleHelp => {
                    self.help_visible = false;
                    Vec::new()
                }
                Action::Quit => vec![Effect::Quit],
                _ => Vec::new(),
            };
        }

        if self.environment_picker {
            return match action {
                Action::Insert(value) => {
                    let value = sanitize_draft_input(&value);
                    if !value.is_empty() {
                        self.environment_query.push_str(&value);
                        self.environment_choice = 0;
                    }
                    Vec::new()
                }
                Action::Backspace | Action::Delete => {
                    if let Some(previous) = previous_grapheme_boundary(
                        &self.environment_query,
                        self.environment_query.len(),
                    ) {
                        self.environment_query.truncate(previous);
                        self.environment_choice = 0;
                    }
                    Vec::new()
                }
                Action::PreviousChoice | Action::PreviousTurn | Action::ScrollUp => {
                    let count = self.matching_environment_indices().len();
                    if count > 0 {
                        self.environment_choice = self
                            .environment_choice
                            .checked_sub(1)
                            .unwrap_or(count.saturating_sub(1));
                    }
                    Vec::new()
                }
                Action::NextChoice | Action::NextTurn | Action::ScrollDown => {
                    let count = self.matching_environment_indices().len();
                    if count > 0 {
                        self.environment_choice = (self.environment_choice + 1) % count;
                    }
                    Vec::new()
                }
                Action::Submit => {
                    self.select_environment_choice();
                    Vec::new()
                }
                Action::Escape => {
                    self.close_environment_picker();
                    Vec::new()
                }
                Action::Quit => vec![Effect::Quit],
                _ => Vec::new(),
            };
        }

        if let Some(approval) = &self.approval {
            return match action {
                Action::DecideApproval { decision, remember } => {
                    vec![Effect::DecideApproval {
                        request_id: approval.request_id.clone(),
                        decision,
                        remember,
                    }]
                }
                Action::ToggleHelp => {
                    self.help_visible = true;
                    Vec::new()
                }
                Action::Quit => vec![Effect::Quit],
                _ => Vec::new(),
            };
        }

        match action {
            Action::Insert(value) => {
                let value = sanitize_draft_input(&value);
                if value.is_empty() {
                    return Vec::new();
                }
                if value == "@" && self.draft.is_empty() {
                    self.environment_picker = true;
                    self.environment_query.clear();
                    self.environment_choice = self
                        .matching_environment_indices()
                        .iter()
                        .position(|index| *index == self.active_environment)
                        .unwrap_or(0);
                    self.draft_visible = true;
                    return Vec::new();
                }
                self.media_expanded = false;
                self.draft_visible = true;
                self.draft.insert_str(self.draft_cursor, &value);
                self.draft_cursor += value.len();
                Vec::new()
            }
            Action::Backspace => {
                self.draft_visible = true;
                if let Some(previous) = previous_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft.drain(previous..self.draft_cursor);
                    self.draft_cursor = previous;
                }
                Vec::new()
            }
            Action::Delete => {
                self.draft_visible = true;
                if let Some(next) = next_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft.drain(self.draft_cursor..next);
                }
                Vec::new()
            }
            Action::DeleteWord => {
                self.draft_visible = true;
                let before = &self.draft[..self.draft_cursor];
                let trimmed = before.trim_end_matches(char::is_whitespace);
                let word_start = trimmed.rfind(char::is_whitespace).map_or(0, |index| {
                    index + trimmed[index..].chars().next().map_or(0, char::len_utf8)
                });
                self.draft.drain(word_start..self.draft_cursor);
                self.draft_cursor = word_start;
                Vec::new()
            }
            Action::MoveCursorLeft => {
                if let Some(previous) = previous_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft_cursor = previous;
                }
                Vec::new()
            }
            Action::MoveCursorRight => {
                if let Some(next) = next_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft_cursor = next;
                }
                Vec::new()
            }
            Action::MoveCursorHome => {
                self.draft_cursor = self.draft[..self.draft_cursor]
                    .rfind('\n')
                    .map_or(0, |index| index + 1);
                Vec::new()
            }
            Action::MoveCursorEnd => {
                self.draft_cursor = self.draft[self.draft_cursor..]
                    .find('\n')
                    .map_or(self.draft.len(), |index| self.draft_cursor + index);
                Vec::new()
            }
            Action::Newline => {
                self.draft_visible = true;
                self.draft.insert(self.draft_cursor, '\n');
                self.draft_cursor += 1;
                Vec::new()
            }
            Action::Submit => self.begin_submission().into_iter().collect(),
            Action::BeginCompose => {
                self.media_expanded = false;
                self.draft_visible = true;
                Vec::new()
            }
            Action::Escape => {
                if self.media_expanded {
                    self.media_expanded = false;
                } else {
                    self.draft_visible = false;
                }
                Vec::new()
            }
            Action::PreviousTurn => {
                self.previous_turn();
                Vec::new()
            }
            Action::NextTurn => {
                self.next_turn();
                Vec::new()
            }
            Action::FirstTurn => {
                if !self.draft_visible && !self.moments.is_empty() {
                    self.selected = self.turn_end(0);
                    self.moment_scroll = 0;
                    self.media_expanded = false;
                    self.media_focus = 0;
                }
                Vec::new()
            }
            Action::LastTurn => {
                if !self.draft_visible && !self.moments.is_empty() {
                    self.selected = self.moments.len().saturating_sub(1);
                    self.moment_scroll = 0;
                    self.media_expanded = false;
                    self.media_focus = 0;
                }
                Vec::new()
            }
            Action::ScrollUp => {
                if self.moment_scroll > 0 {
                    self.moment_scroll -= 1;
                } else {
                    self.previous_turn();
                }
                Vec::new()
            }
            Action::ScrollDown => {
                if self.moment_scroll < self.last_max_scroll {
                    self.moment_scroll += 1;
                } else {
                    self.next_turn();
                }
                Vec::new()
            }
            Action::PreviousChoice | Action::NextChoice => Vec::new(),
            Action::PreviousMedia => {
                self.move_media_focus(false);
                Vec::new()
            }
            Action::NextMedia => {
                self.move_media_focus(true);
                Vec::new()
            }
            Action::ToggleHelp => {
                self.help_visible = true;
                Vec::new()
            }
            Action::ToggleMarkdown => {
                self.raw_markdown = !self.raw_markdown;
                self.moment_scroll = 0;
                Vec::new()
            }
            Action::ToggleVim => {
                self.vim_enabled = !self.vim_enabled;
                Vec::new()
            }
            Action::ToggleMedia => {
                if self.inline_images && self.turn_has_images() {
                    self.clamp_media_focus();
                    self.media_expanded = !self.media_expanded;
                    self.moment_scroll = 0;
                }
                Vec::new()
            }
            Action::Abort => vec![Effect::Abort],
            Action::DecideApproval { .. } => Vec::new(),
            Action::Quit => vec![Effect::Quit],
        }
    }

    fn begin_submission(&mut self) -> Option<Effect> {
        if self.pending_submission.is_some() || self.draft.trim().is_empty() {
            return None;
        }

        let id = self.next_submission_id;
        self.next_submission_id = self.next_submission_id.saturating_add(1);
        let text = std::mem::take(&mut self.draft);
        self.draft_cursor = 0;
        self.draft_visible = false;
        self.pending_submission = Some(PendingSubmission {
            id,
            text: text.clone(),
        });
        self.moments.push(
            Moment::complete(format!("local:user:{id}"), Role::Human, text.clone())
                .with_environment(self.active_environment().clone()),
        );
        self.moments.push(Moment {
            id: format!("local:gsv:{id}"),
            role: Role::Intelligence,
            text: String::new(),
            run_id: None,
            state: MomentState::Streaming,
            artifacts: Vec::new(),
            environment: None,
        });
        self.selected = self.moments.len().saturating_sub(1);
        self.moment_scroll = 0;
        self.media_expanded = false;
        self.media_focus = 0;
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Working
        };
        self.activity = Some("SENDING".to_string());
        let environment = self.active_environment();
        Some(Effect::Submit {
            id,
            text,
            target: environment.target.clone(),
            cwd: environment.cwd.clone(),
        })
    }

    pub fn submission_accepted(&mut self, id: u64, run_id: String, queued: bool) {
        if self
            .pending_submission
            .as_ref()
            .is_none_or(|pending| pending.id != id)
        {
            return;
        }
        self.pending_submission = None;
        for local_id in [format!("local:user:{id}"), format!("local:gsv:{id}")] {
            if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
                moment.run_id = Some(run_id.clone());
            }
        }
        self.activity = Some(if queued { "QUEUED" } else { "THINKING" }.to_string());
    }

    pub fn submission_failed(&mut self, id: u64, error: impl Into<String>) {
        let Some(pending) = self.pending_submission.take() else {
            return;
        };
        if pending.id != id {
            self.pending_submission = Some(pending);
            return;
        }
        if self.draft.is_empty() {
            self.draft = pending.text;
            self.draft_cursor = self.draft.len();
            self.draft_visible = true;
        }
        let local_id = format!("local:gsv:{id}");
        if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
            moment.text = error.into();
            moment.state = MomentState::Error;
        }
        self.connection = ConnectionState::Offline;
        self.activity = None;
    }

    pub fn start_run(&mut self, run_id: &str) {
        if let Some(index) = self.streaming_moment_for(Some(run_id)) {
            self.moments[index].run_id = Some(run_id.to_string());
        }
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Working
        };
        self.activity = Some("THINKING".to_string());
    }

    pub fn append_delta(&mut self, run_id: Option<&str>, delta: &str) {
        let followed_latest = self.selected + 1 >= self.moments.len();
        let index = self.streaming_moment_for(run_id);
        let index = match index {
            Some(index) => index,
            None => {
                self.moments.push(Moment {
                    id: run_id
                        .map(|run_id| format!("run:{run_id}"))
                        .unwrap_or_else(|| format!("stream:{}", self.moments.len())),
                    role: Role::Intelligence,
                    text: String::new(),
                    run_id: run_id.map(str::to_string),
                    state: MomentState::Streaming,
                    artifacts: Vec::new(),
                    environment: None,
                });
                self.moments.len() - 1
            }
        };
        if self.moments[index].run_id.is_none() {
            self.moments[index].run_id = run_id.map(str::to_string);
        }
        self.moments[index].text.push_str(delta);
        self.activity = Some("RESPONDING".to_string());
        if followed_latest {
            self.selected = index;
        }
    }

    pub fn replace_run_text(&mut self, run_id: Option<&str>, text: impl Into<String>) {
        let text = text.into();
        let index = self.streaming_moment_for(run_id);
        if let Some(index) = index {
            self.moments[index].text = text;
            if self.moments[index].run_id.is_none() {
                self.moments[index].run_id = run_id.map(str::to_string);
            }
        } else {
            self.moments.push(Moment {
                id: run_id
                    .map(|run_id| format!("run:{run_id}"))
                    .unwrap_or_else(|| format!("output:{}", self.moments.len())),
                role: Role::Intelligence,
                text,
                run_id: run_id.map(str::to_string),
                state: MomentState::Streaming,
                artifacts: Vec::new(),
                environment: None,
            });
            self.selected = self.moments.len().saturating_sub(1);
        }
        self.activity = Some("RESPONDING".to_string());
    }

    pub fn finish_run(&mut self, run_id: Option<&str>, error: Option<&str>) {
        let index = match run_id {
            Some(run_id) => self
                .moments
                .iter()
                .rposition(|moment| moment.run_id.as_deref() == Some(run_id)),
            None => self.moments.iter().rposition(|moment| {
                moment.role == Role::Intelligence && moment.state == MomentState::Streaming
            }),
        };
        let Some(index) = index else {
            return;
        };
        let moment = &mut self.moments[index];
        if let Some(error) = error.filter(|error| !error.is_empty()) {
            if !moment.text.is_empty() {
                moment.text.push_str("\n\n");
            }
            moment.text.push_str(error);
            moment.state = MomentState::Error;
        } else {
            if moment.text.is_empty() {
                moment.text = "Done.".to_string();
            }
            moment.state = MomentState::Complete;
        }
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Ready
        };
        self.activity = None;
        self.approval = None;
    }

    pub fn commit_message(
        &mut self,
        id: impl Into<String>,
        role: Role,
        text: impl Into<String>,
        run_id: Option<String>,
        artifacts: Vec<Artifact>,
        environment: Option<CapabilityEnvironment>,
    ) {
        let id = id.into();
        let text = text.into();
        if self.moments.iter().any(|moment| moment.id == id) {
            return;
        }
        if role == Role::Human {
            let exact_run = run_id.as_deref().and_then(|run_id| {
                self.moments.iter().rposition(|moment| {
                    moment.role == Role::Human
                        && moment.id.starts_with("local:user:")
                        && moment.run_id.as_deref() == Some(run_id)
                })
            });
            let unbound = self.moments.iter().rposition(|moment| {
                moment.role == Role::Human
                    && moment.id.starts_with("local:user:")
                    && moment.run_id.is_none()
                    && moment.text == text
            });
            if let Some(moment) = exact_run
                .or(unbound)
                .and_then(|index| self.moments.get_mut(index))
            {
                moment.id = id;
                moment.run_id = run_id;
                moment.artifacts = artifacts;
                moment.environment = environment;
                return;
            }
        }
        if role == Role::Intelligence {
            if let Some(index) = run_id.as_deref().and_then(|run_id| {
                self.moments
                    .iter()
                    .rposition(|moment| moment.run_id.as_deref() == Some(run_id))
            }) {
                let moment = &mut self.moments[index];
                moment.id = id;
                moment.text = text;
                moment.state = MomentState::Complete;
                moment.artifacts = artifacts;
                return;
            }
        }
        self.moments.push(Moment {
            id,
            role,
            text,
            run_id,
            state: MomentState::Complete,
            artifacts,
            environment,
        });
        self.selected = self.moments.len().saturating_sub(1);
        self.moment_scroll = 0;
    }

    pub fn complete_demo_submission(&mut self, id: u64, request: &str) {
        let run_id = format!("demo:{id}");
        self.submission_accepted(id, run_id.clone(), false);
        self.append_delta(Some(&run_id), &demo_reply(request));
        if request.to_ascii_lowercase().contains("media") {
            if let Some(moment) = self
                .moments
                .iter_mut()
                .rfind(|moment| moment.run_id.as_deref() == Some(&run_id))
            {
                moment.artifacts.push(Artifact {
                    kind: MediaKind::Image,
                    mime_type: "image/png".to_string(),
                    filename: Some("gsv-preview.png".to_string()),
                    size: Some(218 * 1024),
                    duration_ms: None,
                    transcription: Some(
                        "A clean, full-screen GSV interface rendered as a terminal document."
                            .to_string(),
                    ),
                    source: Some("gsv:~/artifacts/gsv-preview.png".to_string()),
                    revision: Some("demo:1".to_string()),
                });
            }
        }
        self.finish_run(Some(&run_id), None);
    }

    fn previous_turn(&mut self) {
        if self.draft_visible || self.moments.is_empty() {
            return;
        }
        let start = self.turn_start(self.selected);
        if start > 0 {
            self.selected = start - 1;
            self.moment_scroll = 0;
            self.media_expanded = false;
            self.media_focus = 0;
        }
    }

    fn next_turn(&mut self) {
        if self.draft_visible || self.moments.is_empty() {
            return;
        }
        let end = self.turn_end(self.turn_start(self.selected));
        if end + 1 < self.moments.len() {
            self.selected = self.turn_end(end + 1);
            self.moment_scroll = 0;
            self.media_expanded = false;
            self.media_focus = 0;
        }
    }

    fn turn_start(&self, index: usize) -> usize {
        let index = index.min(self.moments.len().saturating_sub(1));
        if self
            .moments
            .get(index)
            .is_some_and(|moment| moment.role == Role::Human)
        {
            return index;
        }
        self.moments[..=index]
            .iter()
            .rposition(|moment| moment.role == Role::Human)
            .unwrap_or(index)
    }

    fn turn_end(&self, start: usize) -> usize {
        self.moments
            .iter()
            .enumerate()
            .skip(start.saturating_add(1))
            .find_map(|(index, moment)| (moment.role == Role::Human).then_some(index - 1))
            .unwrap_or_else(|| self.moments.len().saturating_sub(1))
    }

    fn turn_has_images(&self) -> bool {
        self.turn_image_count() > 0
    }

    fn turn_image_count(&self) -> usize {
        if self.moments.is_empty() {
            return 0;
        }
        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        self.moments[start..=end]
            .iter()
            .flat_map(|moment| &moment.artifacts)
            .filter(|artifact| artifact.kind == MediaKind::Image)
            .count()
    }

    fn clamp_media_focus(&mut self) {
        self.media_focus = self
            .media_focus
            .min(self.turn_image_count().saturating_sub(1));
    }

    fn move_media_focus(&mut self, forward: bool) {
        if !self.inline_images {
            return;
        }
        let count = self.turn_image_count();
        if count == 0 {
            self.media_focus = 0;
            self.media_expanded = false;
            return;
        }
        self.media_focus = if forward {
            (self.media_focus + 1) % count
        } else {
            self.media_focus.checked_sub(1).unwrap_or(count - 1)
        };
    }

    fn matching_environment_indices(&self) -> Vec<usize> {
        let query = self.environment_query.trim().to_ascii_lowercase();
        self.environments
            .iter()
            .enumerate()
            .filter_map(|(index, environment)| {
                let matches = query.is_empty()
                    || environment.target.to_ascii_lowercase().contains(&query)
                    || environment.label.to_ascii_lowercase().contains(&query);
                matches.then_some(index)
            })
            .collect()
    }

    fn select_environment_choice(&mut self) {
        let matches = self.matching_environment_indices();
        if let Some(index) = matches.get(self.environment_choice).copied() {
            self.active_environment = index;
            self.close_environment_picker();
        }
    }

    fn close_environment_picker(&mut self) {
        self.environment_picker = false;
        self.environment_query.clear();
        self.environment_choice = 0;
    }

    fn streaming_moment_for(&self, run_id: Option<&str>) -> Option<usize> {
        if let Some(run_id) = run_id {
            if let Some(index) = self
                .moments
                .iter()
                .rposition(|moment| moment.run_id.as_deref() == Some(run_id))
            {
                return Some(index);
            }
            return self.moments.iter().rposition(|moment| {
                moment.role == Role::Intelligence
                    && moment.state == MomentState::Streaming
                    && moment.run_id.is_none()
            });
        }
        self.moments.iter().rposition(|moment| {
            moment.role == Role::Intelligence && moment.state == MomentState::Streaming
        })
    }

    pub fn render(&mut self, frame: &mut Frame<'_>) {
        let palette = self.theme.palette();
        let area = frame.area();
        self.media_slots.clear();
        frame.render_widget(
            Block::new().style(Style::new().bg(palette.background)),
            area,
        );
        if area.width < 28 || area.height < 8 {
            frame.render_widget(
                Paragraph::new("GSV needs a little more room")
                    .alignment(Alignment::Center)
                    .style(Style::new().fg(palette.foreground).bg(palette.background)),
                area,
            );
            return;
        }

        let horizontal_margin = if area.width > 104 {
            area.width.saturating_sub(96) / 2
        } else {
            2
        };
        let vertical_margin = if area.height > 18 { 2 } else { 1 };
        let canvas = area.inner(Margin::new(horizontal_margin, vertical_margin));
        if let Some(approval) = &self.approval {
            self.last_max_scroll = 0;
            render_approval(frame, canvas, approval, palette);
        } else if self.environment_picker {
            self.last_max_scroll = 0;
            self.render_environment_picker(frame, canvas);
        } else if self.draft_visible {
            self.last_max_scroll = 0;
            self.render_draft(frame, canvas);
        } else {
            self.render_turn(frame, canvas);
        }
        if self.help_visible {
            self.media_slots.clear();
            self.render_help(frame, area);
        }
    }

    fn render_turn(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let palette = self.theme.palette();
        if self.moments.is_empty() {
            self.last_max_scroll = 0;
            frame.render_widget(
                Paragraph::new(self.shell_prompt(self.active_environment()))
                    .style(Style::new().fg(palette.muted))
                    .alignment(Alignment::Center),
                area,
            );
            return;
        }

        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        let turn = self.moments[start..=end].to_vec();
        let image_artifacts = turn
            .iter()
            .flat_map(|moment| moment.artifacts.iter())
            .filter(|artifact| artifact.kind == MediaKind::Image)
            .cloned()
            .collect::<Vec<_>>();
        let inline_image_count = if self.inline_images {
            image_artifacts.len().min(3)
        } else {
            0
        };

        if self.media_expanded && inline_image_count > 0 {
            self.last_max_scroll = 0;
            let focus = self
                .media_focus
                .min(image_artifacts.len().saturating_sub(1));
            let footer_height = u16::from(image_artifacts.len() > 1);
            let media_area = Rect::new(
                area.x,
                area.y,
                area.width,
                area.height.saturating_sub(footer_height),
            );
            self.push_media_slots(
                frame,
                media_area,
                std::slice::from_ref(&image_artifacts[focus]),
                None,
            );
            if footer_height > 0 {
                frame.render_widget(
                    Paragraph::new(format!(
                        "\u{2039}  {} / {}  \u{203a}",
                        focus + 1,
                        image_artifacts.len()
                    ))
                    .style(Style::new().fg(self.theme.palette().quiet))
                    .alignment(Alignment::Center),
                    Rect::new(area.x, area.bottom().saturating_sub(1), area.width, 1),
                );
            }
            return;
        }

        let image_focus = self
            .media_focus
            .min(image_artifacts.len().saturating_sub(1));
        let image_window_start = if inline_image_count > 0 {
            image_focus
                .saturating_sub(inline_image_count / 2)
                .min(image_artifacts.len().saturating_sub(inline_image_count))
        } else {
            0
        };
        let image_window_end = image_window_start + inline_image_count;

        let mut lines = Vec::new();
        for moment in &turn {
            if !lines.is_empty() {
                lines.push(Line::default());
            }
            let body = if moment.text.is_empty() && moment.state == MomentState::Streaming {
                "⋯"
            } else {
                moment.text.as_str()
            };
            let body_color = if moment.state == MomentState::Error {
                palette.error
            } else {
                moment.role.color(palette)
            };
            match moment.role {
                Role::Human => {
                    let environment = moment
                        .environment
                        .as_ref()
                        .unwrap_or_else(|| self.default_environment());
                    lines.extend(
                        prompted_text_lines(
                            &self.shell_prompt(environment),
                            body,
                            area.width,
                            Style::new().fg(palette.human).add_modifier(Modifier::BOLD),
                            Style::new().fg(body_color),
                            None,
                        )
                        .lines,
                    );
                }
                Role::Intelligence if !self.raw_markdown => {
                    lines.extend(render_markdown(body, palette));
                }
                Role::Intelligence | Role::System => {
                    lines.extend(render_plain(body, Style::new().fg(body_color)));
                }
            }
        }

        let fallback_artifacts = turn
            .iter()
            .flat_map(|moment| moment.artifacts.iter())
            .filter(|artifact| artifact.kind != MediaKind::Image)
            .chain(
                image_artifacts
                    .iter()
                    .enumerate()
                    .filter_map(|(index, artifact)| {
                        (!(image_window_start..image_window_end).contains(&index))
                            .then_some(artifact)
                    }),
            )
            .cloned()
            .collect::<Vec<_>>();
        if !fallback_artifacts.is_empty() {
            lines.push(Line::default());
            lines.extend(render_artifacts(&fallback_artifacts, palette));
        }

        let text = Text::from(lines);
        let paragraph = Paragraph::new(text).wrap(Wrap { trim: false });
        let line_count = u16::try_from(paragraph.line_count(area.width.max(1)))
            .unwrap_or(u16::MAX)
            .max(1);
        let media_height = if inline_image_count > 0 {
            (area.height.saturating_mul(2) / 5).clamp(5, 14)
        } else {
            0
        };
        let gap = u16::from(media_height > 0);
        let text_capacity = area.height.saturating_sub(media_height + gap).max(1);
        self.last_max_scroll = line_count.saturating_sub(text_capacity);
        self.moment_scroll = self.moment_scroll.min(self.last_max_scroll);
        let text_height = line_count.min(text_capacity).max(1);
        let compound_height = text_height.saturating_add(media_height).saturating_add(gap);
        let y = if self.last_max_scroll == 0 {
            area.y + area.height.saturating_sub(compound_height) / 2
        } else {
            area.y
        };
        let text_area = Rect::new(area.x, y, area.width, text_height);
        frame.render_widget(paragraph.scroll((self.moment_scroll, 0)), text_area);
        if inline_image_count > 0 {
            let media_area = Rect::new(
                area.x,
                text_area.bottom().saturating_add(gap),
                area.width,
                media_height,
            );
            self.push_media_slots(
                frame,
                media_area,
                &image_artifacts[image_window_start..image_window_end],
                Some(image_focus - image_window_start),
            );
        }
    }

    fn render_draft(&self, frame: &mut Frame<'_>, area: Rect) {
        let palette = self.theme.palette();
        let prompt = self.shell_prompt(self.active_environment());
        let mut layout = prompted_text_lines(
            &prompt,
            &self.draft,
            area.width,
            Style::new().fg(palette.human).add_modifier(Modifier::BOLD),
            Style::new().fg(palette.foreground),
            Some(self.draft_cursor),
        );
        if self.draft.is_empty() {
            if let Some(line) = layout.lines.first_mut() {
                line.spans.push(Span::styled(
                    "type a request",
                    Style::new().fg(palette.quiet),
                ));
            }
        }
        let total_rows = u16::try_from(layout.lines.len()).unwrap_or(u16::MAX).max(1);
        let visible_rows = total_rows.min(area.height).max(1);
        let y = area.y + area.height.saturating_sub(visible_rows) / 2;
        let text_area = Rect::new(area.x, y, area.width, visible_rows);
        let scroll = layout
            .cursor_row
            .saturating_sub(visible_rows.saturating_sub(1));
        frame.render_widget(Paragraph::new(layout.lines).scroll((scroll, 0)), text_area);
        let cursor_y = text_area.y + layout.cursor_row.saturating_sub(scroll);
        let cursor_x = text_area.x + layout.cursor_col.min(text_area.width.saturating_sub(1));
        if cursor_y < text_area.bottom() {
            frame.set_cursor_position(Position::new(cursor_x, cursor_y));
        }
    }

    fn render_environment_picker(&self, frame: &mut Frame<'_>, area: Rect) {
        let palette = self.theme.palette();
        let query = format!("@{}", self.environment_query);
        let mut prompt = prompted_text_lines(
            &self.shell_prompt(self.active_environment()),
            &query,
            area.width,
            Style::new().fg(palette.human).add_modifier(Modifier::BOLD),
            Style::new().fg(palette.foreground),
            Some(query.len()),
        );
        prompt.lines.push(Line::default());
        let matches = self.matching_environment_indices();
        for (choice, index) in matches.iter().copied().enumerate() {
            let environment = &self.environments[index];
            let selected = choice == self.environment_choice.min(matches.len().saturating_sub(1));
            let marker = if selected { "› " } else { "  " };
            let target = prompt_token(&environment.target, "target");
            let label = sanitize_label(&environment.label, &target, 80);
            let mut spans = vec![Span::styled(
                format!("{marker}{target}"),
                Style::new()
                    .fg(if selected {
                        palette.accent
                    } else {
                        palette.foreground
                    })
                    .add_modifier(if selected {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            )];
            if label != target {
                spans.push(Span::styled(
                    format!("  {label}"),
                    Style::new().fg(palette.muted),
                ));
            }
            prompt.lines.push(Line::from(spans));
        }
        if matches.is_empty() {
            prompt.lines.push(Line::from(Span::styled(
                "  no matching target",
                Style::new().fg(palette.muted),
            )));
        }
        let total_height = u16::try_from(prompt.lines.len())
            .unwrap_or(u16::MAX)
            .min(area.height)
            .max(1);
        let picker_area = Rect::new(
            area.x,
            area.y + area.height.saturating_sub(total_height) / 2,
            area.width,
            total_height,
        );
        frame.render_widget(Paragraph::new(prompt.lines), picker_area);
        let cursor_y = picker_area.y + prompt.cursor_row;
        let cursor_x = picker_area.x + prompt.cursor_col.min(picker_area.width.saturating_sub(1));
        if cursor_y < picker_area.bottom() {
            frame.set_cursor_position(Position::new(cursor_x, cursor_y));
        }
    }

    fn push_media_slots(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        artifacts: &[Artifact],
        focused: Option<usize>,
    ) {
        if artifacts.is_empty() || area.width == 0 || area.height == 0 {
            return;
        }
        let palette = self.theme.palette();
        let count = u16::try_from(artifacts.len()).unwrap_or(u16::MAX).max(1);
        let gap = 2_u16;
        let total_gap = gap.saturating_mul(count.saturating_sub(1));
        let slot_width = area.width.saturating_sub(total_gap) / count;
        for (index, artifact) in artifacts.iter().enumerate() {
            let index = u16::try_from(index).unwrap_or(u16::MAX);
            let x = area.x + index.saturating_mul(slot_width.saturating_add(gap));
            let width = if index + 1 == count {
                area.right().saturating_sub(x)
            } else {
                slot_width
            };
            let slot_area = Rect::new(x, area.y, width, area.height);
            let content_area = if focused.is_some() && width > 2 && area.height > 2 {
                slot_area.inner(Margin::new(1, 1))
            } else {
                slot_area
            };
            if focused == Some(usize::from(index)) {
                frame.render_widget(
                    Block::new()
                        .borders(Borders::ALL)
                        .border_type(BorderType::Rounded)
                        .border_style(Style::new().fg(palette.accent)),
                    slot_area,
                );
            }
            frame.render_widget(
                Paragraph::new(sanitize_label(artifact.display_name(), "image", 96))
                    .style(Style::new().fg(palette.quiet))
                    .alignment(Alignment::Center),
                content_area,
            );
            self.media_slots.push(MediaSlot {
                key: artifact.cache_key(),
                area: content_area,
                artifact: artifact.clone(),
            });
        }
    }

    fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        let palette = self.theme.palette();
        let width = area.width.saturating_sub(8).min(68);
        let height = area.height.saturating_sub(4).min(24);
        let popup = centered_rect(area, width, height);
        frame.render_widget(Clear, popup);
        let mut lines = vec![
            Line::from(Span::styled(
                "keys",
                Style::new()
                    .fg(palette.foreground)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::default(),
            help_line("type anywhere", "write a request", palette),
            help_line("enter", "send", palette),
            help_line("shift+enter", "new line", palette),
            help_line("@", "choose a target", palette),
            help_line("escape", "browse without losing the draft", palette),
            help_line("ctrl+p / ctrl+n", "previous / next turn", palette),
            help_line("page up / page down", "move through a long turn", palette),
            help_line("left / right", "choose media", palette),
            help_line("enter", "open / close media", palette),
            help_line("alt+m", "rendered / source Markdown", palette),
            help_line("alt+v", "toggle Vim controls", palette),
            help_line("ctrl+.", "stop the active run", palette),
            help_line("ctrl+q", "leave GSV", palette),
        ];
        if self.vim_enabled {
            lines.extend([
                Line::default(),
                help_line("Vim: i / escape", "compose / browse", palette),
                help_line("Vim: j / k", "next / previous turn", palette),
                help_line("Vim: h / l", "previous / next media", palette),
                help_line("Vim: g / G", "first / latest turn", palette),
                help_line("Vim: enter", "open / close media", palette),
            ]);
        }
        lines.extend([
            Line::default(),
            Line::from(Span::styled(
                "Press ? or escape to return",
                Style::new().fg(palette.muted),
            )),
        ]);
        let help = Text::from(lines);
        frame.render_widget(
            Paragraph::new(help)
                .block(
                    Block::new()
                        .borders(Borders::ALL)
                        .border_type(BorderType::Rounded)
                        .border_style(Style::new().fg(palette.quiet))
                        .style(Style::new().bg(palette.background))
                        .padding(Padding::new(3, 3, 2, 2)),
                )
                .wrap(Wrap { trim: false }),
            popup,
        );
    }

    fn default_environment(&self) -> &CapabilityEnvironment {
        &self.environments[0]
    }

    fn shell_prompt(&self, environment: &CapabilityEnvironment) -> String {
        let target = prompt_token(&environment.target, "gsv");
        match environment
            .cwd
            .as_deref()
            .filter(|cwd| !cwd.trim().is_empty())
        {
            Some(cwd) => format!(
                "{}@{} {} $ ",
                self.principal,
                target,
                sanitize_label(cwd, "~", 80)
            ),
            None => format!("{}@{} $ ", self.principal, target),
        }
    }
}

struct PromptedText {
    lines: Vec<Line<'static>>,
    cursor_row: u16,
    cursor_col: u16,
}

fn prompted_text_lines(
    prompt: &str,
    value: &str,
    width: u16,
    prompt_style: Style,
    text_style: Style,
    cursor: Option<usize>,
) -> PromptedText {
    let width = width.max(1);
    let prompt = fit_prompt(prompt, width);
    let prompt_width = u16::try_from(UnicodeWidthStr::width(prompt.as_str()))
        .unwrap_or(width)
        .min(width.saturating_sub(1));
    let continuation_width = prompt_width.min(width.saturating_sub(1));
    let continuation = " ".repeat(usize::from(continuation_width));
    let mut text_lines = vec![String::new()];
    let mut row = 0_u16;
    let mut col = prompt_width;
    let mut cursor_position = None;

    for (index, grapheme) in value.grapheme_indices(true) {
        let grapheme_width = u16::try_from(UnicodeWidthStr::width(grapheme))
            .unwrap_or(1)
            .max(1);
        if grapheme != "\n" && col.saturating_add(grapheme_width) > width {
            text_lines.push(String::new());
            row = row.saturating_add(1);
            col = continuation_width;
        }
        if cursor == Some(index) {
            cursor_position = Some((row, col));
        }
        if grapheme == "\n" {
            text_lines.push(String::new());
            row = row.saturating_add(1);
            col = continuation_width;
            continue;
        }
        if let Some(line) = text_lines.last_mut() {
            line.push_str(grapheme);
        }
        col = col.saturating_add(grapheme_width);
        if col >= width {
            text_lines.push(String::new());
            row = row.saturating_add(1);
            col = continuation_width;
        }
    }
    if cursor == Some(value.len()) || cursor.is_none() {
        cursor_position.get_or_insert((row, col));
    }
    if text_lines.len() > 1
        && text_lines.last().is_some_and(String::is_empty)
        && col == continuation_width
    {
        text_lines.pop();
        row = row.saturating_sub(1);
        col = width;
        if cursor == Some(value.len()) {
            cursor_position = Some((row, col.saturating_sub(1)));
        }
    }

    let lines = text_lines
        .into_iter()
        .enumerate()
        .map(|(index, text)| {
            let mut spans = Vec::with_capacity(2);
            if index == 0 {
                spans.push(Span::styled(prompt.clone(), prompt_style));
            } else {
                spans.push(Span::raw(continuation.clone()));
            }
            if !text.is_empty() {
                spans.push(Span::styled(text, text_style));
            }
            Line::from(spans)
        })
        .collect();
    let (cursor_row, cursor_col) = cursor_position.unwrap_or((row, col));
    PromptedText {
        lines,
        cursor_row,
        cursor_col,
    }
}

fn fit_prompt(prompt: &str, width: u16) -> String {
    if UnicodeWidthStr::width(prompt) < usize::from(width) {
        return prompt.to_string();
    }
    let available = usize::from(width.saturating_sub(4)).max(1);
    let compact = prompt.chars().take(available).collect::<String>();
    format!("{compact}… ")
}

fn render_approval(frame: &mut Frame<'_>, area: Rect, approval: &Approval, palette: Palette) {
    let content_area = area.inner(Margin::new(2, 1));
    let mut lines = vec![
        Line::from(Span::styled(
            "APPROVAL REQUIRED",
            Style::new()
                .fg(palette.warning)
                .add_modifier(Modifier::BOLD),
        )),
        Line::default(),
        Line::from(vec![
            Span::styled(&approval.syscall, Style::new().fg(palette.foreground)),
            Span::styled("  ON  ", Style::new().fg(palette.muted)),
            Span::styled(&approval.target, Style::new().fg(palette.accent)),
        ]),
        Line::default(),
    ];
    lines.extend(
        approval
            .preview
            .split('\n')
            .map(|line| Line::from(Span::styled(line, Style::new().fg(palette.muted)))),
    );
    lines.extend([
        Line::default(),
        Line::from(Span::styled(
            "o allow once   a always allow   d deny",
            Style::new().fg(palette.muted),
        )),
    ]);
    let text = Text::from(lines);
    let paragraph = Paragraph::new(text).wrap(Wrap { trim: false });
    let width = content_area.width.max(1);
    let line_count = u16::try_from(paragraph.line_count(width))
        .unwrap_or(u16::MAX)
        .min(content_area.height);
    let render_area = Rect::new(
        content_area.x,
        content_area.y + content_area.height.saturating_sub(line_count) / 2,
        content_area.width,
        line_count.max(1),
    );
    frame.render_widget(paragraph, render_area);
}

fn help_line(key: &'static str, meaning: &'static str, palette: Palette) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{key:<22}"), Style::new().fg(palette.accent)),
        Span::styled(meaning, Style::new().fg(palette.muted)),
    ])
}

fn centered_rect(area: Rect, width: u16, height: u16) -> Rect {
    let [vertical] = Layout::new(Direction::Vertical, [Constraint::Length(height)])
        .flex(ratatui::layout::Flex::Center)
        .areas(area);
    let [centered] = Layout::new(Direction::Horizontal, [Constraint::Length(width)])
        .flex(ratatui::layout::Flex::Center)
        .areas(vertical);
    centered
}

fn previous_grapheme_boundary(value: &str, cursor: usize) -> Option<usize> {
    value[..cursor]
        .grapheme_indices(true)
        .next_back()
        .map(|(index, _)| index)
}

fn prompt_token(value: &str, fallback: &str) -> String {
    let token = value
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        .take(32)
        .collect::<String>();
    if token.is_empty() {
        fallback.to_string()
    } else {
        token
    }
}

fn sanitize_draft_input(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '\n' => vec!['\n'],
            '\t' => vec![' ', ' ', ' ', ' '],
            character if character.is_control() => Vec::new(),
            character => vec![character],
        })
        .collect()
}

fn sanitize_status(value: &str) -> String {
    sanitize_label(value, "WORKING", 80)
}

fn sanitize_label(value: &str, fallback: &str, max_chars: usize) -> String {
    let status = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>();
    if status.trim().is_empty() {
        fallback.to_string()
    } else {
        status
    }
}

fn sanitize_multiline(value: &str, max_chars: usize) -> String {
    sanitize_draft_input(value)
        .chars()
        .take(max_chars)
        .collect()
}

fn next_grapheme_boundary(value: &str, cursor: usize) -> Option<usize> {
    value[cursor..]
        .grapheme_indices(true)
        .nth(1)
        .map(|(index, _)| cursor + index)
        .or_else(|| (cursor < value.len()).then_some(value.len()))
}

#[cfg(test)]
fn text_metrics(value: &str, cursor: usize, width: u16) -> (u16, u16, u16) {
    let width = width.max(1);
    let mut row = 0_u16;
    let mut col = 0_u16;
    let mut cursor_position = None;
    for (index, grapheme) in value.grapheme_indices(true) {
        if index == cursor {
            cursor_position = Some((row, col));
        }
        if grapheme == "\n" {
            row = row.saturating_add(1);
            col = 0;
            continue;
        }
        let grapheme_width = u16::try_from(UnicodeWidthStr::width(grapheme))
            .unwrap_or(1)
            .max(1);
        if col.saturating_add(grapheme_width) > width {
            row = row.saturating_add(1);
            col = 0;
        }
        col = col.saturating_add(grapheme_width);
        if col >= width {
            row = row.saturating_add(1);
            col = 0;
        }
    }
    let (cursor_row, cursor_col) = cursor_position.unwrap_or((row, col));
    (cursor_row, cursor_col, row.saturating_add(1))
}

fn demo_reply(request: &str) -> String {
    let normalized = request.to_ascii_lowercase();
    if normalized.contains("markdown") || normalized.contains("media") {
        "# A terminal document\n\nThis is **structured**, restrained, and still feels native to the shell.\n\n- Markdown becomes typography\n- Links remain inspectable\n- Media remains an addressable artifact\n\n```sh\nship@macbook $ du -sh ~/Downloads/*\n```\n\n> GSV owns the grammar. Your terminal owns the atmosphere."
            .to_string()
    } else if normalized.contains("download") && normalized.contains("open") {
        "I’d open ~/Downloads on this computer.\n\nThis preview is intentionally disconnected, so no local action was taken. The connected TUI sends the same request through GSV’s capability boundary."
            .to_string()
    } else if normalized.starts_with("ls") || normalized.contains("list the files") {
        "Desktop\nDocuments\nDownloads\nPictures\nProjects\n\nIn connected mode this comes from the selected machine target; this preview uses example output."
            .to_string()
    } else {
        format!(
            "Understood. I’d turn “{}” into an inspectable GSV run, ask only for capabilities it needs, and keep you in control while it works.\n\nThis browser/native preview is exercising the shared TUI interface; connect it to run the request for real.",
            request.trim()
        )
    }
}

#[cfg(test)]
mod tests {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    use super::{
        sanitize_status, text_metrics, Action, App, Approval, Artifact, CapabilityEnvironment,
        ConnectionState, Effect, MediaKind, Moment, MomentState, Role,
    };

    fn image_artifact(index: usize) -> Artifact {
        Artifact {
            kind: MediaKind::Image,
            mime_type: "image/png".to_string(),
            filename: Some(format!("image-{index}.png")),
            size: Some(2048),
            duration_ms: None,
            transcription: None,
            source: Some(format!("gsv:/home/ship/image-{index}.png")),
            revision: Some(format!("sha256:{index}")),
        }
    }

    #[test]
    fn typing_replaces_the_moment_and_escape_preserves_the_draft() {
        let mut app = App::demo();
        app.dispatch(Action::Insert("open downloads".to_string()));
        assert!(app.draft_visible());
        app.dispatch(Action::Escape);
        assert!(!app.draft_visible());
        assert_eq!(app.draft(), "open downloads");
        app.dispatch(Action::Insert(" please".to_string()));
        assert_eq!(app.draft(), "open downloads please");
    }

    #[test]
    fn submission_is_optimistic_and_restores_failed_text() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("show downloads".to_string()));
        assert_eq!(
            app.dispatch(Action::Submit),
            vec![Effect::Submit {
                id: 1,
                text: "show downloads".to_string(),
                target: "gsv".to_string(),
                cwd: None,
            }]
        );
        assert_eq!(app.moments().len(), 2);
        app.submission_failed(1, "Could not connect");
        assert_eq!(app.draft(), "show downloads");
        assert!(app.draft_visible());
    }

    #[test]
    fn navigation_moves_between_complete_turns() {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![
            Moment::complete("one", Role::Human, "one"),
            Moment::complete("two", Role::Intelligence, "two"),
            Moment::complete("three", Role::Human, "three"),
            Moment::complete("four", Role::Intelligence, "four"),
        ]);
        assert_eq!(app.selected(), 3);
        app.dispatch(Action::PreviousTurn);
        assert_eq!(app.selected(), 1);
        app.dispatch(Action::NextTurn);
        assert_eq!(app.selected(), 3);
    }

    #[test]
    fn render_contains_only_the_selected_command_result_turn(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![
            Moment::complete("one", Role::Human, "older command"),
            Moment::complete("two", Role::Intelligence, "older secret"),
            Moment::complete("three", Role::Human, "visible command"),
            Moment::complete("four", Role::Intelligence, "visible answer"),
        ]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("visible answer"));
        assert!(rendered.contains("you@gsv $ visible command"));
        assert!(!rendered.contains("older secret"));
        Ok(())
    }

    #[test]
    fn render_preserves_explicit_message_line_breaks() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![Moment::complete(
            "answer",
            Role::Intelligence,
            "first line\n\nsecond line",
        )]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let buffer = terminal.backend().buffer();
        let first_row = buffer
            .content()
            .chunks(80)
            .position(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .contains("first line")
            })
            .expect("first line should be rendered");
        let second_row = buffer
            .content()
            .chunks(80)
            .position(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .contains("second line")
            })
            .expect("second line should be rendered");
        assert_eq!(second_row, first_row + 2);
        Ok(())
    }

    #[test]
    fn stale_run_completion_cannot_finish_the_active_response() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("do it".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(1, "run:current".to_string(), false);
        app.append_delta(Some("run:current"), "still working");
        app.enter_approval(Approval {
            request_id: "approval:current".to_string(),
            syscall: "shell.exec".to_string(),
            target: "machine:current".to_string(),
            preview: "safe".to_string(),
        });

        app.finish_run(Some("run:old"), Some("late failure"));

        let active = app
            .moments()
            .iter()
            .find(|moment| {
                moment.run_id.as_deref() == Some("run:current") && moment.role == Role::Intelligence
            })
            .expect("active response");
        assert_eq!(active.text, "still working");
        assert_eq!(active.state, MomentState::Streaming);
        assert!(app.approval().is_some());
    }

    #[test]
    fn identical_user_messages_reconcile_by_run_identity() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("repeat".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(1, "run:first".to_string(), false);
        app.dispatch(Action::Insert("repeat".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(2, "run:second".to_string(), true);

        app.commit_message(
            "message:first",
            Role::Human,
            "repeat",
            Some("run:first".to_string()),
            Vec::new(),
            None,
        );

        assert!(app
            .moments()
            .iter()
            .any(|moment| moment.id == "message:first"
                && moment.run_id.as_deref() == Some("run:first")));
        assert!(app
            .moments()
            .iter()
            .any(|moment| moment.id == "local:user:2"
                && moment.run_id.as_deref() == Some("run:second")));
    }

    #[test]
    fn cursor_metrics_treat_a_combining_sequence_as_one_cell() {
        let value = "e\u{301}x";
        assert_eq!(text_metrics(value, "e\u{301}".len(), 20), (0, 1, 1));
    }

    #[test]
    fn external_labels_cannot_inject_terminal_controls() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Working);
        app.set_principal("jo\u{1b}[31mhn");
        app.set_activity(Some("ship@mac\u{1b}[2Jbook · shell.exec".to_string()));
        app.replace_history(vec![Moment::complete("one", Role::Human, "hello")]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("jo31mhn@gsv $ hello"));
        assert!(!rendered.contains('\u{1b}'));
        assert_eq!(
            sanitize_status("ship@mac\u{1b}[2Jbook · shell.exec"),
            "ship@mac[2Jbook · shell.exec"
        );
        Ok(())
    }

    #[test]
    fn canonical_media_is_content_first_without_unsolicited_metadata(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "Here it is.",
        )
        .with_artifacts(vec![Artifact {
            kind: MediaKind::Image,
            mime_type: "image/png".to_string(),
            filename: Some("chart.png".to_string()),
            size: Some(2048),
            duration_ms: None,
            transcription: Some("a chart".to_string()),
            source: Some("gsv:/home/ship/chart.png".to_string()),
            revision: Some("sha256:one".to_string()),
        }])]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("▧  chart.png"));
        assert!(rendered.contains("a chart"));
        assert!(!rendered.contains("image/png"));
        assert!(!rendered.contains("2.0 KB"));
        assert!(!rendered.contains("gsv:/home/ship/chart.png"));
        assert!(!rendered.contains("sha256:one"));
        Ok(())
    }

    #[test]
    fn media_focus_selects_the_exact_image_that_opens() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_inline_images(true);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "Four images.",
        )
        .with_artifacts((0..4).map(image_artifact).collect())]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;

        app.dispatch(Action::NextMedia);
        app.dispatch(Action::NextMedia);
        app.dispatch(Action::ToggleMedia);
        terminal.draw(|frame| app.render(frame))?;
        assert!(app.media_expanded());
        assert_eq!(app.media_slots().len(), 1);
        assert_eq!(
            app.media_slots()[0].artifact.source.as_deref(),
            Some("gsv:/home/ship/image-2.png")
        );

        app.dispatch(Action::NextMedia);
        terminal.draw(|frame| app.render(frame))?;
        assert_eq!(
            app.media_slots()[0].artifact.source.as_deref(),
            Some("gsv:/home/ship/image-3.png")
        );

        app.dispatch(Action::Escape);
        assert!(!app.media_expanded());
        Ok(())
    }

    #[test]
    fn help_modal_withdraws_native_media_layers() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_inline_images(true);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "An image.",
        )
        .with_artifacts(vec![image_artifact(0)])]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;

        terminal.draw(|frame| app.render(frame))?;
        assert_eq!(app.media_slots().len(), 1);
        app.dispatch(Action::ToggleHelp);
        terminal.draw(|frame| app.render(frame))?;
        assert!(app.media_slots().is_empty());
        Ok(())
    }

    #[test]
    fn target_picker_changes_both_prompt_and_submission_context(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_principal("john");
        app.set_environments(vec![CapabilityEnvironment::new("macbook", "macbook")]);
        app.dispatch(Action::Insert("@".to_string()));
        assert!(app.environment_picker_visible());
        app.dispatch(Action::Insert("mac".to_string()));
        app.dispatch(Action::Submit);
        assert_eq!(app.active_environment().target, "macbook");
        app.dispatch(Action::Insert("open downloads".to_string()));
        assert_eq!(
            app.dispatch(Action::Submit),
            vec![Effect::Submit {
                id: 1,
                text: "open downloads".to_string(),
                target: "macbook".to_string(),
                cwd: None,
            }]
        );
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("john@macbook $ open downloads"));
        Ok(())
    }

    #[test]
    fn approval_display_is_sanitized_without_changing_its_correlation_id() {
        let mut app = App::new(ConnectionState::Ready);
        app.enter_approval(Approval {
            request_id: "request\u{1b}:exact".to_string(),
            syscall: "shell\u{1b}[31m.exec".to_string(),
            target: "mac\nbook".to_string(),
            preview: "one\u{1b}[2J\ntwo".to_string(),
        });
        let approval = app.approval().expect("approval");
        assert_eq!(approval.request_id, "request\u{1b}:exact");
        assert_eq!(approval.syscall, "shell[31m.exec");
        assert_eq!(approval.target, "macbook");
        assert_eq!(approval.preview, "one[2J\ntwo");
    }
}
