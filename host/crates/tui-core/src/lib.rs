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

const MAX_COMMAND_HISTORY: usize = 500;

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
    pub execution: ExecutionMode,
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
            execution: ExecutionMode::Ship,
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

    pub fn with_execution(mut self, execution: ExecutionMode) -> Self {
        self.execution = execution;
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ExecutionMode {
    #[default]
    Ship,
    Shell,
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
    PreviousCommand,
    NextCommand,
    PreviousTurn,
    NextTurn,
    FirstTurn,
    LastTurn,
    ScrollUp,
    ScrollDown,
    ScrollPageUp,
    ScrollPageDown,
    PreviousChoice,
    NextChoice,
    PreviousMedia,
    NextMedia,
    ToggleHelp,
    ToggleMarkdown,
    ToggleVim,
    ToggleShell,
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
    Shell {
        id: u64,
        input: String,
        target: String,
        cwd: Option<String>,
    },
    OpenArtifact {
        artifact: Artifact,
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
    execution: ExecutionMode,
}

#[derive(Clone, Debug)]
struct CommandHistoryEntry {
    text: String,
    execution: ExecutionMode,
}

#[derive(Clone, Debug)]
struct DraftSnapshot {
    text: String,
    cursor: usize,
    execution: ExecutionMode,
}

#[derive(Clone, Copy, Debug)]
enum ScrollAnchor {
    Moment(usize),
    Media,
}

enum TranscriptBlock {
    Text {
        top: u16,
        height: u16,
        lines: Vec<Line<'static>>,
    },
    Image {
        top: u16,
        height: u16,
        artifact: Artifact,
        focused: bool,
    },
}

impl TranscriptBlock {
    fn top(&self) -> u16 {
        match self {
            Self::Text { top, .. } | Self::Image { top, .. } => *top,
        }
    }

    fn height(&self) -> u16 {
        match self {
            Self::Text { height, .. } | Self::Image { height, .. } => *height,
        }
    }
}

#[derive(Debug)]
pub struct App {
    moments: Vec<Moment>,
    selected: usize,
    document_scroll: u16,
    last_max_scroll: u16,
    last_viewport_height: u16,
    follow_latest: bool,
    scroll_anchor: Option<ScrollAnchor>,
    draft: String,
    draft_cursor: usize,
    draft_visible: bool,
    command_history: Vec<CommandHistoryEntry>,
    history_position: Option<usize>,
    history_draft: Option<DraftSnapshot>,
    help_visible: bool,
    connection: ConnectionState,
    activity: Option<String>,
    pending_submission: Option<PendingSubmission>,
    active_run: Option<String>,
    active_shell: Option<u64>,
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
    execution_mode: ExecutionMode,
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
            document_scroll: 0,
            last_max_scroll: 0,
            last_viewport_height: 1,
            follow_latest: true,
            scroll_anchor: None,
            draft: String::new(),
            draft_cursor: 0,
            draft_visible: true,
            command_history: Vec::new(),
            history_position: None,
            history_draft: None,
            help_visible: false,
            connection,
            activity: None,
            pending_submission: None,
            active_run: None,
            active_shell: None,
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
            execution_mode: ExecutionMode::Ship,
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

    pub fn cursor_visible(&self) -> bool {
        if self.approval.is_some() || self.help_visible || self.media_expanded {
            return false;
        }
        if self.environment_picker {
            return true;
        }
        self.draft_visible
    }

    pub fn approval(&self) -> Option<&Approval> {
        self.approval.as_ref()
    }

    pub fn vim_enabled(&self) -> bool {
        self.vim_enabled
    }

    pub fn execution_mode(&self) -> ExecutionMode {
        self.execution_mode
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
        if self.vim_enabled == enabled {
            return;
        }
        self.vim_enabled = enabled;
        self.draft_visible = !enabled;
        self.follow_latest = true;
    }

    pub fn set_inline_images(&mut self, enabled: bool) {
        self.inline_images = enabled;
        if !enabled {
            self.media_expanded = false;
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
        self.command_history = moments
            .iter()
            .filter(|moment| moment.role == Role::Human && !moment.text.trim().is_empty())
            .map(|moment| CommandHistoryEntry {
                text: moment.text.clone(),
                execution: moment.execution,
            })
            .collect();
        if self.command_history.len() > MAX_COMMAND_HISTORY {
            self.command_history
                .drain(..self.command_history.len() - MAX_COMMAND_HISTORY);
        }
        self.reset_history_navigation();
        self.moments = moments;
        self.selected = self.moments.len().saturating_sub(1);
        self.document_scroll = 0;
        self.follow_latest = true;
        self.scroll_anchor = None;
        self.media_expanded = false;
        self.media_focus = 0;
    }

    pub fn enter_approval(&mut self, mut approval: Approval) {
        approval.syscall = sanitize_label(&approval.syscall, "unknown action", 96);
        approval.target = sanitize_label(&approval.target, "unknown target", 96);
        approval.preview = sanitize_multiline(&approval.preview, 4_000);
        self.approval = Some(approval);
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
                self.reset_history_navigation();
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
                self.follow_latest = true;
                self.draft.insert_str(self.draft_cursor, &value);
                self.draft_cursor += value.len();
                Vec::new()
            }
            Action::Backspace => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                if let Some(previous) = previous_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft.drain(previous..self.draft_cursor);
                    self.draft_cursor = previous;
                }
                Vec::new()
            }
            Action::Delete => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                if let Some(next) = next_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft.drain(self.draft_cursor..next);
                }
                Vec::new()
            }
            Action::DeleteWord => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
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
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                self.draft.insert(self.draft_cursor, '\n');
                self.draft_cursor += 1;
                Vec::new()
            }
            Action::Submit => {
                if self.draft.is_empty() {
                    self.begin_submission()
                        .map_or_else(|| self.activate_media(), |effect| vec![effect])
                } else {
                    self.begin_submission().into_iter().collect()
                }
            }
            Action::BeginCompose => {
                self.media_expanded = false;
                self.draft_visible = true;
                self.follow_latest = true;
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
            Action::PreviousCommand => {
                self.recall_previous_command();
                Vec::new()
            }
            Action::NextCommand => {
                self.recall_next_command();
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
                    self.scroll_anchor = Some(ScrollAnchor::Moment(0));
                    self.follow_latest = false;
                    self.media_expanded = false;
                    self.media_focus = 0;
                }
                Vec::new()
            }
            Action::LastTurn => {
                if !self.draft_visible && !self.moments.is_empty() {
                    self.selected = self.moments.len().saturating_sub(1);
                    self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
                    self.follow_latest = true;
                    self.media_expanded = false;
                    self.media_focus = 0;
                }
                Vec::new()
            }
            Action::ScrollUp => {
                self.scroll_older(3);
                Vec::new()
            }
            Action::ScrollDown => {
                self.scroll_newer(3);
                Vec::new()
            }
            Action::ScrollPageUp => {
                self.scroll_older(self.last_viewport_height.saturating_sub(2).max(1));
                Vec::new()
            }
            Action::ScrollPageDown => {
                self.scroll_newer(self.last_viewport_height.saturating_sub(2).max(1));
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
                self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
                Vec::new()
            }
            Action::ToggleVim => {
                self.vim_enabled = !self.vim_enabled;
                self.draft_visible = !self.vim_enabled;
                self.follow_latest = true;
                Vec::new()
            }
            Action::ToggleShell => {
                self.reset_history_navigation();
                self.execution_mode = match self.execution_mode {
                    ExecutionMode::Ship => ExecutionMode::Shell,
                    ExecutionMode::Shell => ExecutionMode::Ship,
                };
                self.draft_visible = true;
                self.follow_latest = true;
                self.media_expanded = false;
                Vec::new()
            }
            Action::ToggleMedia => self.activate_media(),
            Action::Abort => self
                .active_run
                .as_ref()
                .map_or_else(Vec::new, |_| vec![Effect::Abort]),
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
        let execution = self.execution_mode;
        let text = std::mem::take(&mut self.draft);
        self.draft_cursor = 0;
        self.draft_visible = true;
        self.record_command(text.clone(), execution);
        self.reset_history_navigation();
        self.pending_submission = Some(PendingSubmission {
            id,
            text: text.clone(),
            execution,
        });
        self.moments.push(
            Moment::complete(format!("local:user:{id}"), Role::Human, text.clone())
                .with_environment(self.active_environment().clone())
                .with_execution(execution),
        );
        self.moments.push(Moment {
            id: match execution {
                ExecutionMode::Ship => format!("local:gsv:{id}"),
                ExecutionMode::Shell => format!("local:shell:{id}"),
            },
            role: Role::Intelligence,
            execution,
            text: String::new(),
            run_id: None,
            state: MomentState::Streaming,
            artifacts: Vec::new(),
            environment: None,
        });
        self.selected = self.moments.len().saturating_sub(1);
        self.document_scroll = 0;
        self.follow_latest = true;
        self.scroll_anchor = None;
        self.media_expanded = false;
        self.media_focus = 0;
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Working
        };
        self.activity = Some(
            match execution {
                ExecutionMode::Ship => "SENDING",
                ExecutionMode::Shell => "RUNNING",
            }
            .to_string(),
        );
        let environment = self.active_environment().clone();
        match execution {
            ExecutionMode::Ship => Some(Effect::Submit {
                id,
                text,
                target: environment.target,
                cwd: environment.cwd,
            }),
            ExecutionMode::Shell => {
                self.active_shell = Some(id);
                Some(Effect::Shell {
                    id,
                    input: text,
                    target: environment.target,
                    cwd: environment.cwd,
                })
            }
        }
    }

    fn activate_media(&mut self) -> Vec<Effect> {
        self.clamp_media_focus();
        let Some(artifact) = self.selected_artifact().cloned() else {
            return Vec::new();
        };
        if self.inline_images && artifact.kind == MediaKind::Image {
            self.media_expanded = !self.media_expanded;
            Vec::new()
        } else {
            vec![Effect::OpenArtifact { artifact }]
        }
    }

    pub fn submission_accepted(&mut self, id: u64, run_id: String, queued: bool) {
        if self
            .pending_submission
            .as_ref()
            .is_none_or(|pending| pending.id != id || pending.execution != ExecutionMode::Ship)
        {
            return;
        }
        self.pending_submission = None;
        for local_id in [format!("local:user:{id}"), format!("local:gsv:{id}")] {
            if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
                moment.run_id = Some(run_id.clone());
            }
        }
        if self.moments.iter().any(|moment| {
            moment.run_id.as_deref() == Some(&run_id)
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
        }) {
            self.active_run = Some(run_id);
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
        self.active_run = Some(run_id.to_string());
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Working
        };
        self.activity = Some("THINKING".to_string());
    }

    pub fn start_message_stream(&mut self, run_id: &str, message_id: &str) {
        self.start_run(run_id);
        if self.moments.iter().any(|moment| moment.id == message_id) {
            return;
        }
        if let Some(index) = self.streaming_moment_for(Some(run_id)) {
            if self.moments[index].text.is_empty() && self.moments[index].artifacts.is_empty() {
                self.moments[index].id = message_id.to_string();
                self.moments[index].run_id = Some(run_id.to_string());
                return;
            }
        }
        self.moments.push(Moment {
            id: message_id.to_string(),
            role: Role::Intelligence,
            execution: ExecutionMode::Ship,
            text: String::new(),
            run_id: Some(run_id.to_string()),
            state: MomentState::Streaming,
            artifacts: Vec::new(),
            environment: None,
        });
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
        }
    }

    pub fn append_message_delta(&mut self, run_id: Option<&str>, message_id: &str, delta: &str) {
        let followed_latest = self.follow_latest;
        let mut index = self.moments.iter().rposition(|moment| {
            moment.id == message_id
                && moment.role == Role::Intelligence
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
        });
        if index.is_none() {
            if let Some(run_id) = run_id {
                self.start_message_stream(run_id, message_id);
            } else if !self.moments.iter().any(|moment| moment.id == message_id) {
                self.moments.push(Moment {
                    id: message_id.to_string(),
                    role: Role::Intelligence,
                    execution: ExecutionMode::Ship,
                    text: String::new(),
                    run_id: None,
                    state: MomentState::Streaming,
                    artifacts: Vec::new(),
                    environment: None,
                });
            }
            index = self.moments.iter().rposition(|moment| {
                moment.id == message_id
                    && moment.role == Role::Intelligence
                    && moment.execution == ExecutionMode::Ship
                    && moment.state == MomentState::Streaming
            });
        }
        let Some(index) = index else {
            return;
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

    pub fn abort_message_stream(&mut self, message_id: &str) {
        let Some(index) = self.moments.iter().position(|moment| {
            moment.id == message_id
                && moment.role == Role::Intelligence
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
        }) else {
            return;
        };
        self.moments.remove(index);
        self.selected = self.selected.min(self.moments.len().saturating_sub(1));
    }

    pub fn finish_run(&mut self, run_id: Option<&str>, error: Option<&str>) {
        let effective_run = run_id
            .map(str::to_string)
            .or_else(|| self.active_run.clone());
        let is_active = effective_run
            .as_deref()
            .is_some_and(|run_id| self.active_run.as_deref() == Some(run_id));
        let index = self.moments.iter().rposition(|moment| {
            moment.role == Role::Intelligence
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
                && effective_run
                    .as_deref()
                    .is_none_or(|run_id| moment.run_id.as_deref() == Some(run_id))
        });
        if !is_active && index.is_none() {
            return;
        }

        if let Some(error) = error.filter(|error| !error.is_empty()) {
            if let Some(index) = index {
                let moment = &mut self.moments[index];
                if !moment.text.is_empty() {
                    moment.text.push_str("\n\n");
                }
                moment.text.push_str(error);
                moment.state = MomentState::Error;
            } else {
                self.moments.push(Moment {
                    id: effective_run
                        .as_deref()
                        .map(|run_id| format!("error:{run_id}"))
                        .unwrap_or_else(|| format!("error:{}", self.moments.len())),
                    role: Role::Intelligence,
                    execution: ExecutionMode::Ship,
                    text: error.to_string(),
                    run_id: effective_run.clone(),
                    state: MomentState::Error,
                    artifacts: Vec::new(),
                    environment: None,
                });
            }
        } else if let Some(index) = index {
            if self.moments[index].text.is_empty() && self.moments[index].artifacts.is_empty() {
                self.moments.remove(index);
            } else {
                self.moments[index].state = MomentState::Complete;
            }
        }

        if is_active {
            self.active_run = None;
            self.connection = if self.connection == ConnectionState::Demo {
                ConnectionState::Demo
            } else if self.active_shell.is_some() {
                ConnectionState::Working
            } else {
                ConnectionState::Ready
            };
            self.activity = None;
            self.approval = None;
            if self.follow_latest {
                self.selected = self.moments.len().saturating_sub(1);
            }
        }
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
                        && moment.execution == ExecutionMode::Ship
                        && moment.id.starts_with("local:user:")
                        && moment.run_id.as_deref() == Some(run_id)
                })
            });
            let unbound = self.moments.iter().rposition(|moment| {
                moment.role == Role::Human
                    && moment.execution == ExecutionMode::Ship
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
                if environment.is_some() {
                    moment.environment = environment;
                }
                return;
            }
        }
        if role == Role::Intelligence {
            if let Some(index) = run_id.as_deref().and_then(|run_id| {
                self.moments.iter().rposition(|moment| {
                    moment.role == Role::Intelligence
                        && moment.execution == ExecutionMode::Ship
                        && (moment.state == MomentState::Streaming
                            || moment.id.starts_with("draft:"))
                        && moment.run_id.as_deref() == Some(run_id)
                })
            }) {
                let streamed = &self.moments[index].text;
                let reconciles_stream = streamed.is_empty()
                    || streamed == &text
                    || text.starts_with(streamed.as_str())
                    || streamed.starts_with(text.as_str());
                if reconciles_stream {
                    let moment = &mut self.moments[index];
                    moment.id = id;
                    moment.text = text;
                    moment.state = MomentState::Complete;
                    moment.artifacts = artifacts;
                    return;
                }
            }
        }
        if role == Role::Human {
            self.record_command(text.clone(), ExecutionMode::Ship);
        }
        self.moments.push(Moment {
            id,
            role,
            execution: ExecutionMode::Ship,
            text,
            run_id,
            state: MomentState::Complete,
            artifacts,
            environment,
        });
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
        }
    }

    pub fn complete_demo_submission(&mut self, id: u64, request: &str) {
        let run_id = format!("demo:{id}");
        let message_id = format!("demo:message:{id}");
        self.submission_accepted(id, run_id.clone(), false);
        self.start_message_stream(&run_id, &message_id);
        self.append_message_delta(Some(&run_id), &message_id, &demo_reply(request));
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

    pub fn append_shell_output(&mut self, id: u64, output: &str) {
        if self.active_shell != Some(id) || output.is_empty() {
            return;
        }
        let Some(moment) = self.moments.iter_mut().find(|moment| {
            moment.id == format!("local:shell:{id}")
                && moment.execution == ExecutionMode::Shell
                && moment.state == MomentState::Streaming
        }) else {
            return;
        };
        moment.text.push_str(output);
        self.activity = Some("RUNNING".to_string());
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
        }
    }

    pub fn finish_shell(&mut self, id: u64, error: Option<&str>) {
        if self.active_shell != Some(id) {
            return;
        }
        let index = self
            .moments
            .iter()
            .position(|moment| moment.id == format!("local:shell:{id}"));
        if let Some(index) = index {
            if let Some(error) = error.filter(|error| !error.trim().is_empty()) {
                let moment = &mut self.moments[index];
                if !moment.text.is_empty() && !moment.text.ends_with('\n') {
                    moment.text.push('\n');
                }
                moment.text.push_str(error);
                moment.state = MomentState::Error;
            } else if self.moments[index].text.is_empty() {
                self.moments.remove(index);
            } else {
                self.moments[index].state = MomentState::Complete;
            }
        }
        if self
            .pending_submission
            .as_ref()
            .is_some_and(|pending| pending.id == id && pending.execution == ExecutionMode::Shell)
        {
            self.pending_submission = None;
        }
        self.active_shell = None;
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else if self.active_run.is_some() {
            ConnectionState::Working
        } else {
            ConnectionState::Ready
        };
        self.activity = self.active_run.as_ref().map(|_| "THINKING".to_string());
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
        }
    }

    pub fn complete_demo_shell(&mut self, id: u64, input: &str) {
        let output = match input.trim() {
            "pwd" => {
                self.active_environment()
                    .cwd
                    .as_deref()
                    .unwrap_or("~")
                    .to_string()
                    + "\n"
            }
            "ls" | "ls -la" | "ls -lah" => {
                "Desktop  Documents  Downloads  Pictures  Projects\n".to_string()
            }
            _ => "Shell execution is unavailable in the disconnected preview.\n".to_string(),
        };
        self.append_shell_output(id, &output);
        self.finish_shell(id, None);
    }

    pub fn append_local_output(&mut self, text: impl AsRef<str>) {
        let text = sanitize_multiline(text.as_ref(), 4_000);
        if text.is_empty() {
            return;
        }
        self.moments.push(Moment {
            id: format!("local:output:{}", self.moments.len()),
            role: Role::System,
            execution: self.execution_mode,
            text,
            run_id: None,
            state: MomentState::Error,
            artifacts: Vec::new(),
            environment: None,
        });
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
        }
    }

    fn record_command(&mut self, text: String, execution: ExecutionMode) {
        if text.trim().is_empty() {
            return;
        }
        self.command_history
            .push(CommandHistoryEntry { text, execution });
        if self.command_history.len() > MAX_COMMAND_HISTORY {
            self.command_history.remove(0);
        }
    }

    fn reset_history_navigation(&mut self) {
        self.history_position = None;
        self.history_draft = None;
    }

    fn recall_previous_command(&mut self) {
        if self.command_history.is_empty() {
            return;
        }
        let position = match self.history_position {
            Some(position) => position.saturating_sub(1),
            None => {
                self.history_draft = Some(DraftSnapshot {
                    text: self.draft.clone(),
                    cursor: self.draft_cursor,
                    execution: self.execution_mode,
                });
                self.command_history.len() - 1
            }
        };
        self.history_position = Some(position);
        self.load_history_position(position);
    }

    fn recall_next_command(&mut self) {
        let Some(position) = self.history_position else {
            return;
        };
        if position + 1 < self.command_history.len() {
            let position = position + 1;
            self.history_position = Some(position);
            self.load_history_position(position);
            return;
        }
        let snapshot = self.history_draft.take().unwrap_or(DraftSnapshot {
            text: String::new(),
            cursor: 0,
            execution: self.execution_mode,
        });
        self.history_position = None;
        self.draft = snapshot.text;
        self.draft_cursor = snapshot.cursor.min(self.draft.len());
        self.execution_mode = snapshot.execution;
        self.draft_visible = true;
        self.follow_latest = true;
        self.media_expanded = false;
    }

    fn load_history_position(&mut self, position: usize) {
        let Some(entry) = self.command_history.get(position) else {
            return;
        };
        self.draft.clone_from(&entry.text);
        self.draft_cursor = self.draft.len();
        self.execution_mode = entry.execution;
        self.draft_visible = true;
        self.follow_latest = true;
        self.media_expanded = false;
    }

    fn previous_turn(&mut self) {
        if self.draft_visible || self.moments.is_empty() {
            return;
        }
        let start = self.turn_start(self.selected);
        if start > 0 {
            self.selected = start - 1;
            self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
            self.follow_latest = false;
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
            self.scroll_anchor = Some(ScrollAnchor::Moment(end + 1));
            self.follow_latest = self.selected + 1 >= self.moments.len();
            self.media_expanded = false;
            self.media_focus = 0;
        }
    }

    fn scroll_older(&mut self, rows: u16) {
        let current = if self.follow_latest {
            self.last_max_scroll
        } else {
            self.document_scroll
        };
        self.document_scroll = current.saturating_sub(rows);
        self.follow_latest = false;
        self.scroll_anchor = None;
        self.media_expanded = false;
        self.draft_visible = false;
    }

    fn scroll_newer(&mut self, rows: u16) {
        self.document_scroll = self
            .document_scroll
            .saturating_add(rows)
            .min(self.last_max_scroll);
        self.follow_latest = self.document_scroll >= self.last_max_scroll;
        self.scroll_anchor = None;
        self.media_expanded = false;
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

    fn turn_artifact_count(&self) -> usize {
        if self.moments.is_empty() {
            return 0;
        }
        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        self.moments[start..=end]
            .iter()
            .flat_map(|moment| &moment.artifacts)
            .count()
    }

    fn selected_artifact(&self) -> Option<&Artifact> {
        if self.moments.is_empty() {
            return None;
        }
        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        self.moments[start..=end]
            .iter()
            .flat_map(|moment| &moment.artifacts)
            .nth(self.media_focus)
    }

    fn clamp_media_focus(&mut self) {
        self.media_focus = self
            .media_focus
            .min(self.turn_artifact_count().saturating_sub(1));
    }

    fn move_media_focus(&mut self, forward: bool) {
        let count = self.turn_artifact_count();
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
        if self
            .selected_artifact()
            .is_none_or(|artifact| artifact.kind != MediaKind::Image)
        {
            self.media_expanded = false;
        }
        self.scroll_anchor = Some(ScrollAnchor::Media);
        self.follow_latest = false;
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
            if let Some(index) = self.moments.iter().rposition(|moment| {
                moment.role == Role::Intelligence
                    && moment.execution == ExecutionMode::Ship
                    && moment.state == MomentState::Streaming
                    && moment.run_id.as_deref() == Some(run_id)
            }) {
                return Some(index);
            }
            return self.moments.iter().rposition(|moment| {
                moment.role == Role::Intelligence
                    && moment.execution == ExecutionMode::Ship
                    && moment.state == MomentState::Streaming
                    && moment.run_id.is_none()
            });
        }
        self.moments.iter().rposition(|moment| {
            moment.role == Role::Intelligence
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
        })
    }

    pub fn render(&mut self, frame: &mut Frame<'_>) {
        self.render_with_cursor(frame, true);
    }

    pub fn render_with_cursor(&mut self, frame: &mut Frame<'_>, cursor_phase: bool) {
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
            self.render_environment_picker(frame, canvas, cursor_phase);
        } else {
            self.render_transcript(frame, canvas, cursor_phase);
        }
        if self.help_visible {
            self.media_slots.clear();
            self.render_help(frame, area);
        }
    }

    fn render_transcript(&mut self, frame: &mut Frame<'_>, area: Rect, cursor_phase: bool) {
        let palette = self.theme.palette();
        let (turn_start, turn_end) = if self.moments.is_empty() {
            (0, 0)
        } else {
            let start = self.turn_start(self.selected);
            (start, self.turn_end(start))
        };
        let turn_artifacts = self
            .moments
            .get(turn_start..=turn_end)
            .into_iter()
            .flatten()
            .flat_map(|moment| moment.artifacts.iter())
            .cloned()
            .collect::<Vec<_>>();
        let image_artifacts = turn_artifacts
            .iter()
            .enumerate()
            .filter(|(_, artifact)| artifact.kind == MediaKind::Image)
            .map(|(artifact_index, artifact)| (artifact_index, artifact.clone()))
            .collect::<Vec<_>>();
        let focused_image = image_artifacts
            .iter()
            .position(|(artifact_index, _)| *artifact_index == self.media_focus);
        let has_inline_images = self.inline_images && !image_artifacts.is_empty();

        if self.media_expanded && has_inline_images && focused_image.is_some() {
            self.last_max_scroll = 0;
            let focus = focused_image.unwrap_or_default();
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
                std::slice::from_ref(&image_artifacts[focus].1),
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

        let show_prompt = self.draft_visible || self.follow_latest;
        let mut prompt = show_prompt.then(|| {
            let mut prompt = prompted_text_lines(
                &self.input_prompt(self.active_environment(), self.execution_mode),
                &self.draft,
                area.width,
                Style::new().fg(palette.human).add_modifier(Modifier::BOLD),
                Style::new().fg(palette.foreground),
                Some(self.draft_cursor),
            );
            if self.draft.is_empty() {
                if let Some(line) = prompt.lines.first_mut() {
                    line.spans.push(Span::styled(
                        match self.execution_mode {
                            ExecutionMode::Ship => "type a request",
                            ExecutionMode::Shell => "literal shell command",
                        },
                        Style::new().fg(palette.quiet),
                    ));
                }
            }
            prompt
        });
        let prompt_height = prompt
            .as_ref()
            .map(|prompt| {
                u16::try_from(prompt.lines.len())
                    .unwrap_or(u16::MAX)
                    .min(area.height)
                    .max(1)
            })
            .unwrap_or(0);
        let viewport_height = area.height.saturating_sub(prompt_height);
        let image_height = if self.inline_images && viewport_height > 0 {
            (area.height.saturating_mul(2) / 5)
                .clamp(5, 12)
                .min(viewport_height)
        } else {
            0
        };
        let mut blocks = Vec::new();
        let mut document_height = 0_u16;
        let mut moment_starts = vec![0_u16; self.moments.len()];
        let mut selected_artifact_index = 0_usize;
        let mut focused_media_range = None;

        for (index, moment) in self.moments.iter().enumerate() {
            if moment.role == Role::Human && document_height > 0 {
                push_transcript_text(
                    &mut blocks,
                    &mut document_height,
                    vec![Line::default()],
                    area.width,
                );
            }
            moment_starts[index] = document_height;
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
            let mut has_content = !body.is_empty();
            if has_content {
                let body_lines = match moment.role {
                    Role::Human => {
                        let environment = moment
                            .environment
                            .as_ref()
                            .unwrap_or_else(|| self.default_environment());
                        prompted_text_lines(
                            &self.input_prompt(environment, moment.execution),
                            body,
                            area.width,
                            Style::new().fg(palette.human).add_modifier(Modifier::BOLD),
                            Style::new().fg(body_color),
                            None,
                        )
                        .lines
                    }
                    Role::Intelligence
                        if moment.execution == ExecutionMode::Ship && !self.raw_markdown =>
                    {
                        render_markdown(body, palette)
                    }
                    Role::Intelligence if moment.execution == ExecutionMode::Shell => render_plain(
                        body.strip_suffix('\n').unwrap_or(body),
                        Style::new().fg(body_color),
                    ),
                    Role::Intelligence | Role::System => {
                        render_plain(body, Style::new().fg(body_color))
                    }
                };
                push_transcript_text(&mut blocks, &mut document_height, body_lines, area.width);
            }

            let in_selected_turn = (turn_start..=turn_end).contains(&index);
            for artifact in &moment.artifacts {
                if has_content {
                    push_transcript_text(
                        &mut blocks,
                        &mut document_height,
                        vec![Line::default()],
                        area.width,
                    );
                }
                let focused = if in_selected_turn {
                    let focused = selected_artifact_index == self.media_focus;
                    selected_artifact_index = selected_artifact_index.saturating_add(1);
                    focused
                } else {
                    false
                };
                let top = document_height;
                if artifact.kind == MediaKind::Image && image_height > 0 {
                    blocks.push(TranscriptBlock::Image {
                        top,
                        height: image_height,
                        artifact: artifact.clone(),
                        focused,
                    });
                    document_height = document_height.saturating_add(image_height);
                } else {
                    push_transcript_text(
                        &mut blocks,
                        &mut document_height,
                        render_artifacts(&[(artifact, focused)], palette),
                        area.width,
                    );
                }
                if focused {
                    focused_media_range = Some((top, document_height));
                }
                has_content = true;
            }
        }

        self.last_viewport_height = viewport_height.max(1);
        self.last_max_scroll = document_height.saturating_sub(viewport_height);
        let anchor = self.scroll_anchor.take();
        if self.follow_latest {
            self.document_scroll = self.last_max_scroll;
        } else {
            self.document_scroll = self.document_scroll.min(self.last_max_scroll);
            match anchor {
                Some(ScrollAnchor::Moment(index)) => {
                    self.document_scroll = moment_starts
                        .get(index)
                        .copied()
                        .unwrap_or_default()
                        .min(self.last_max_scroll);
                }
                Some(ScrollAnchor::Media) => {
                    if let Some((top, bottom)) = focused_media_range {
                        let viewport_bottom = self.document_scroll.saturating_add(viewport_height);
                        if top < self.document_scroll {
                            self.document_scroll = top;
                        } else if bottom > viewport_bottom {
                            self.document_scroll = bottom
                                .saturating_sub(viewport_height)
                                .min(self.last_max_scroll);
                        }
                    }
                }
                None => {}
            }
        }

        if viewport_height > 0 && document_height > 0 {
            let viewport_top = self.document_scroll;
            let viewport_bottom = viewport_top.saturating_add(viewport_height);
            let bottom_alignment = viewport_height.saturating_sub(document_height);
            for block in blocks {
                let block_top = block.top();
                let block_bottom = block_top.saturating_add(block.height());
                let visible_top = block_top.max(viewport_top);
                let visible_bottom = block_bottom.min(viewport_bottom);
                if visible_top >= visible_bottom {
                    continue;
                }
                let block_area = Rect::new(
                    area.x,
                    area.y + bottom_alignment + visible_top.saturating_sub(viewport_top),
                    area.width,
                    visible_bottom.saturating_sub(visible_top),
                );
                match block {
                    TranscriptBlock::Text { lines, .. } => {
                        frame.render_widget(
                            Paragraph::new(Text::from(lines))
                                .wrap(Wrap { trim: false })
                                .scroll((visible_top.saturating_sub(block_top), 0)),
                            block_area,
                        );
                    }
                    TranscriptBlock::Image {
                        artifact, focused, ..
                    } if visible_top == block_top && visible_bottom == block_bottom => {
                        self.push_media_slots(
                            frame,
                            block_area,
                            std::slice::from_ref(&artifact),
                            focused.then_some(0),
                        );
                    }
                    TranscriptBlock::Image {
                        artifact, focused, ..
                    } => {
                        let style = Style::new()
                            .fg(if focused {
                                palette.accent
                            } else {
                                palette.quiet
                            })
                            .add_modifier(if focused {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            });
                        frame.render_widget(
                            Paragraph::new(format!(
                                "▧  {}",
                                sanitize_label(artifact.display_name(), "image", 96)
                            ))
                            .style(style)
                            .alignment(Alignment::Center),
                            block_area,
                        );
                    }
                }
            }
        }
        if let Some(prompt) = prompt.take() {
            let cursor_row = prompt.cursor_row;
            let cursor_col = prompt.cursor_col;
            let prompt_area = Rect::new(
                area.x,
                area.bottom().saturating_sub(prompt_height),
                area.width,
                prompt_height,
            );
            let scroll = cursor_row.saturating_sub(prompt_height.saturating_sub(1));
            frame.render_widget(
                Paragraph::new(prompt.lines).scroll((scroll, 0)),
                prompt_area,
            );
            if self.cursor_visible() && cursor_phase {
                let cursor_y = prompt_area.y + cursor_row.saturating_sub(scroll);
                let cursor_x = prompt_area.x + cursor_col.min(prompt_area.width.saturating_sub(1));
                if cursor_y < prompt_area.bottom() {
                    frame.set_cursor_position(Position::new(cursor_x, cursor_y));
                }
            }
        }
    }

    fn render_environment_picker(&self, frame: &mut Frame<'_>, area: Rect, cursor_phase: bool) {
        let palette = self.theme.palette();
        let query = format!("@{}", self.environment_query);
        let mut prompt = prompted_text_lines(
            &self.input_prompt(self.active_environment(), self.execution_mode),
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
        if cursor_phase && cursor_y < picker_area.bottom() {
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
            let content_area = if width > 2 && area.height > 2 {
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
        let height = area.height.saturating_sub(2).min(24);
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
            help_line("type  ·  enter", "write  ·  send", palette),
            help_line("shift+enter", "new line", palette),
            help_line("tab", "Ship / literal shell", palette),
            help_line("@", "choose a target", palette),
            help_line("escape", "browse without losing the draft", palette),
            help_line("up/down  ·  ctrl+p/n", "command history", palette),
            help_line("page up / page down", "scroll the transcript", palette),
            help_line("left/right  ·  enter", "choose  ·  open media", palette),
            help_line("alt+m  ·  alt+v", "Markdown  ·  Vim", palette),
            help_line("ctrl+.  ·  ctrl+q", "stop Ship  ·  leave", palette),
        ];
        if self.vim_enabled {
            lines.extend([
                Line::default(),
                help_line("Vim: i/a  ·  escape", "compose  ·  browse", palette),
                help_line("Vim: h/l  ·  j/k", "media  ·  commands", palette),
                help_line("Vim: g/G  ·  enter", "ends  ·  open media", palette),
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
                        .padding(Padding::new(3, 3, 1, 1)),
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

    fn input_prompt(
        &self,
        environment: &CapabilityEnvironment,
        execution: ExecutionMode,
    ) -> String {
        let mut prompt = self.shell_prompt(environment);
        if execution == ExecutionMode::Shell {
            prompt.push_str("! ");
        }
        prompt
    }
}

fn push_transcript_text(
    blocks: &mut Vec<TranscriptBlock>,
    document_height: &mut u16,
    lines: Vec<Line<'static>>,
    width: u16,
) {
    let height = wrapped_line_count(&lines, width);
    if height == 0 {
        return;
    }
    blocks.push(TranscriptBlock::Text {
        top: *document_height,
        height,
        lines,
    });
    *document_height = document_height.saturating_add(height);
}

fn wrapped_line_count(lines: &[Line<'static>], width: u16) -> u16 {
    if lines.is_empty() {
        return 0;
    }
    let paragraph = Paragraph::new(Text::from(lines.to_vec())).wrap(Wrap { trim: false });
    u16::try_from(paragraph.line_count(width.max(1))).unwrap_or(u16::MAX)
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
    // Only the first physical line owns the shell prompt. Subsequent explicit or soft-wrapped
    // lines continue at the terminal's left edge, exactly as one long terminal input stream.
    let continuation_width = 0;
    let continuation = String::new();
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
        ConnectionState, Effect, ExecutionMode, MediaKind, Moment, MomentState, Role,
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

    fn audio_artifact(index: usize) -> Artifact {
        Artifact {
            kind: MediaKind::Audio,
            mime_type: "audio/ogg".to_string(),
            filename: Some(format!("voice-{index}.ogg")),
            size: Some(2048),
            duration_ms: Some(1_000),
            transcription: None,
            source: Some(format!("gsv:/home/ship/voice-{index}.ogg")),
            revision: Some(format!("sha256:voice-{index}")),
        }
    }

    #[test]
    fn typing_replaces_the_moment_and_escape_preserves_the_draft() {
        let mut app = App::demo();
        assert!(app.cursor_visible());
        app.dispatch(Action::Insert("open downloads".to_string()));
        assert!(app.draft_visible());
        app.dispatch(Action::Escape);
        assert!(!app.draft_visible());
        assert!(!app.cursor_visible());
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
        app.dispatch(Action::Escape);
        app.dispatch(Action::PreviousTurn);
        assert_eq!(app.selected(), 1);
        app.dispatch(Action::NextTurn);
        assert_eq!(app.selected(), 3);
    }

    #[test]
    fn render_keeps_commands_in_one_continuous_document() -> Result<(), Box<dyn std::error::Error>>
    {
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
        assert!(rendered.contains("older secret"));
        assert!(rendered.contains("you@gsv $ older command"));
        Ok(())
    }

    #[test]
    fn one_run_can_commit_multiple_visible_messages_while_the_prompt_stays_active(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("work on it".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(1, "run:one".to_string(), false);
        app.commit_message(
            "message:one",
            Role::Intelligence,
            "First update.",
            Some("run:one".to_string()),
            Vec::new(),
            None,
        );
        app.commit_message(
            "message:two",
            Role::Intelligence,
            "Second update.",
            Some("run:one".to_string()),
            Vec::new(),
            None,
        );

        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let running = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(running.contains("First update."));
        assert!(running.contains("Second update."));
        assert!(running.contains("type a request"));
        assert!(app.draft_visible());
        assert!(app.cursor_visible());

        app.finish_run(Some("run:one"), None);
        terminal.draw(|frame| app.render(frame))?;
        let finished = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(finished.contains("type a request"));
        assert!(!finished.contains("Done."));
        Ok(())
    }

    #[test]
    fn escape_leaves_the_prompt_visible_in_browse_mode() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("unfinished".to_string()));
        app.dispatch(Action::Escape);
        assert!(!app.draft_visible());
        assert!(!app.cursor_visible());

        let backend = TestBackend::new(60, 12);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("you@gsv $ unfinished"));
        Ok(())
    }

    #[test]
    fn command_history_recalls_ship_and_shell_input_and_restores_the_draft() {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![
            Moment::complete("one", Role::Human, "first"),
            Moment::complete("two", Role::Human, "pwd").with_execution(ExecutionMode::Shell),
        ]);
        app.dispatch(Action::Insert("scratch".to_string()));

        app.dispatch(Action::PreviousCommand);
        assert_eq!(app.draft(), "pwd");
        assert_eq!(app.execution_mode(), ExecutionMode::Shell);
        app.dispatch(Action::PreviousCommand);
        assert_eq!(app.draft(), "first");
        assert_eq!(app.execution_mode(), ExecutionMode::Ship);
        app.dispatch(Action::NextCommand);
        assert_eq!(app.draft(), "pwd");
        app.dispatch(Action::NextCommand);
        assert_eq!(app.draft(), "scratch");
        assert_eq!(app.execution_mode(), ExecutionMode::Ship);
    }

    #[test]
    fn prompt_input_wraps_from_the_terminal_left_edge() {
        let prompted = super::prompted_text_lines(
            "you@gsv $ ",
            "abcdefghijkl",
            16,
            ratatui::style::Style::new(),
            ratatui::style::Style::new(),
            Some(12),
        );
        let rows = prompted
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        assert_eq!(rows, vec!["you@gsv $ abcdef", "ghijkl"]);
        assert_eq!((prompted.cursor_row, prompted.cursor_col), (1, 6));
    }

    #[test]
    fn a_silent_run_returns_to_the_prompt_without_fabricating_output() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("quietly update it".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(1, "run:quiet".to_string(), false);
        app.finish_run(Some("run:quiet"), None);

        assert_eq!(app.moments().len(), 1);
        assert_eq!(app.moments()[0].role, Role::Human);
        assert!(app.moments().iter().all(|moment| moment.text != "Done."));
    }

    #[test]
    fn tab_mode_executes_the_literal_command_on_the_selected_target(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_principal("john");
        app.set_environments(vec![
            CapabilityEnvironment::gsv(),
            CapabilityEnvironment::new("macbook", "MacBook").with_cwd("~/Downloads"),
        ]);
        app.dispatch(Action::Insert("@".to_string()));
        app.dispatch(Action::Insert("mac".to_string()));
        app.dispatch(Action::Submit);
        app.dispatch(Action::ToggleShell);
        assert_eq!(app.execution_mode(), ExecutionMode::Shell);
        app.dispatch(Action::Insert("pwd".to_string()));
        assert_eq!(
            app.dispatch(Action::Submit),
            vec![Effect::Shell {
                id: 1,
                input: "pwd".to_string(),
                target: "macbook".to_string(),
                cwd: Some("~/Downloads".to_string()),
            }]
        );
        app.append_shell_output(1, "/Users/john/Downloads\n");
        app.finish_shell(1, None);

        assert_eq!(app.moments()[0].execution, ExecutionMode::Shell);
        assert_eq!(app.moments()[1].execution, ExecutionMode::Shell);
        assert_eq!(app.moments()[1].state, MomentState::Complete);
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
        assert!(rendered.contains("john@macbook ~/Downloads $ ! pwd"));
        assert!(rendered.contains("/Users/john/Downloads"));
        assert!(rendered.contains("literal shell command"));
        let rows = terminal
            .backend()
            .buffer()
            .content()
            .chunks(80)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let output_row = rows
            .iter()
            .position(|row| row.contains("/Users/john/Downloads"))
            .expect("shell output row");
        let prompt_row = rows
            .iter()
            .position(|row| row.contains("literal shell command"))
            .expect("next prompt row");
        assert_eq!(prompt_row, output_row + 1);
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
        app.start_message_stream("run:current", "draft:current");
        app.append_message_delta(Some("run:current"), "draft:current", "still working");
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
    fn media_focus_opens_the_exact_audio_artifact() {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "Two clips.",
        )
        .with_artifacts(vec![audio_artifact(0), audio_artifact(1)])]);

        app.dispatch(Action::NextMedia);
        assert_eq!(
            app.dispatch(Action::ToggleMedia),
            vec![Effect::OpenArtifact {
                artifact: audio_artifact(1)
            }]
        );
        assert_eq!(
            app.dispatch(Action::Submit),
            vec![Effect::OpenArtifact {
                artifact: audio_artifact(1)
            }]
        );
    }

    #[test]
    fn mixed_media_keeps_source_order_in_the_document() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_inline_images(true);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "Four attachments.",
        )
        .with_artifacts(vec![
            image_artifact(0),
            audio_artifact(0),
            image_artifact(1),
            audio_artifact(1),
        ])]);
        let backend = TestBackend::new(80, 48);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;

        assert_eq!(app.media_slots().len(), 2);
        let rows = terminal
            .backend()
            .buffer()
            .content()
            .chunks(80)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let first_audio = rows
            .iter()
            .position(|row| row.contains("voice-0.ogg"))
            .expect("first audio row");
        let second_audio = rows
            .iter()
            .position(|row| row.contains("voice-1.ogg"))
            .expect("second audio row");
        let first_image = usize::from(app.media_slots()[0].area.y);
        let second_image = usize::from(app.media_slots()[1].area.y);
        assert!(first_image < first_audio);
        assert!(first_audio < second_image);
        assert!(second_image < second_audio);
        Ok(())
    }

    #[test]
    fn media_focus_scrolls_to_the_corresponding_document_block(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_inline_images(true);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "Four attachments.",
        )
        .with_artifacts(vec![
            image_artifact(0),
            audio_artifact(0),
            image_artifact(1),
            audio_artifact(1),
        ])]);
        app.dispatch(Action::Escape);
        app.dispatch(Action::NextMedia);
        app.dispatch(Action::NextMedia);
        let backend = TestBackend::new(60, 18);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;

        assert!(app
            .media_slots()
            .iter()
            .any(|slot| { slot.artifact.source.as_deref() == Some("gsv:/home/ship/image-1.png") }));
        Ok(())
    }

    #[test]
    fn image_blocks_participate_in_scrolling_instead_of_staying_pinned(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let body = (0..20)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let moment = Moment::complete("one", Role::Intelligence, body)
            .with_artifacts(vec![image_artifact(0)]);
        let backend = TestBackend::new(60, 18);
        let mut terminal = Terminal::new(backend)?;

        let mut fallback = App::new(ConnectionState::Ready);
        fallback.replace_history(vec![moment.clone()]);
        terminal.draw(|frame| fallback.render(frame))?;
        let fallback_max_scroll = fallback.last_max_scroll;

        let mut inline = App::new(ConnectionState::Ready);
        inline.set_inline_images(true);
        inline.replace_history(vec![moment]);
        terminal.draw(|frame| inline.render(frame))?;
        assert!(inline.last_max_scroll > fallback_max_scroll);
        assert_eq!(inline.media_slots().len(), 1);

        inline.dispatch(Action::ScrollUp);
        terminal.draw(|frame| inline.render(frame))?;
        assert!(inline.media_slots().is_empty());
        Ok(())
    }

    #[test]
    fn help_modal_withdraws_native_media_layers() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_inline_images(true);
        app.set_vim_enabled(true);
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
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("Vim: g/G"));
        assert!(rendered.contains("Press ? or escape to return"));
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
