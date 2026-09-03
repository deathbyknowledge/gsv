mod markdown;
mod theme;

use std::cmp::Ordering;

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
const MAX_ACTION_RUNS: usize = 64;
const MAX_ACTIONS_PER_RUN: usize = 64;
const MAX_VISIBLE_LIVE_ACTIONS: usize = 6;

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
            Self::Human => palette.foreground,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileReference {
    pub target: String,
    pub path: String,
    pub revision: String,
    pub content_type: String,
    pub size: u64,
    pub filename: String,
}

impl FileReference {
    fn artifact(&self) -> Artifact {
        Artifact {
            kind: media_kind_from_content_type(&self.content_type),
            mime_type: self.content_type.clone(),
            filename: Some(self.filename.clone()),
            size: Some(self.size),
            duration_ms: None,
            transcription: None,
            source: Some(format!("{}:{}", self.target, self.path)),
            revision: Some(self.revision.clone()),
        }
    }
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MomentTimeline {
    pub sequence: Option<u64>,
    pub timestamp: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Moment {
    pub id: String,
    pub role: Role,
    pub execution: ExecutionMode,
    pub text: String,
    pub run_id: Option<String>,
    /// Durable conversation ordering when this moment came from canonical history.
    pub sequence: Option<u64>,
    /// The best persisted timeline position for merging messages with run activity.
    pub timestamp: Option<u64>,
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
            sequence: None,
            timestamp: None,
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

    pub fn with_timeline(mut self, sequence: Option<u64>, timestamp: Option<u64>) -> Self {
        self.sequence = sequence;
        self.timestamp = timestamp;
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
    OpenFiles,
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
    ToggleActions,
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
        references: Vec<FileReference>,
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
    BrowseFiles {
        request_id: u64,
        target: String,
        directory: String,
    },
    ResolveFile {
        request_id: u64,
        target: String,
        path: String,
        filename: String,
    },
    LoadOlderHistory {
        before_sequence: u64,
    },
    Abort,
    DecideApproval {
        request_id: String,
        decision: ApprovalDecision,
        remember: bool,
    },
    Quit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentActionSnapshot {
    pub run_id: String,
    pub execution_id: String,
    pub name: String,
    pub syscall: String,
    pub target: Option<String>,
    pub status: String,
    pub live: bool,
    pub started_at: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageDeliverySnapshot {
    pub run_id: String,
    pub message_id: String,
    pub started_at: u64,
}

#[derive(Clone, Debug)]
struct PendingSubmission {
    id: u64,
    text: String,
    execution: ExecutionMode,
    references: Vec<DraftReference>,
}

#[derive(Clone, Debug)]
struct CommandHistoryEntry {
    text: String,
    execution: ExecutionMode,
    references: Vec<DraftReference>,
}

#[derive(Clone, Debug)]
struct DraftSnapshot {
    text: String,
    cursor: usize,
    execution: ExecutionMode,
    references: Vec<DraftReference>,
}

#[derive(Clone, Debug)]
struct DraftReference {
    start: usize,
    end: usize,
    reference: FileReference,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentActionState {
    Running,
    Completed,
    Failed,
    Cancelled,
    Denied,
}

#[derive(Clone, Debug)]
struct AgentAction {
    execution_id: String,
    label: String,
    target: Option<String>,
    state: AgentActionState,
    started_at: Option<u64>,
    after_moment_id: Option<String>,
}

#[derive(Debug)]
struct RunActions {
    run_id: String,
    actions: Vec<AgentAction>,
    omitted: usize,
    expanded: bool,
    live: bool,
}

#[derive(Debug)]
struct FilePicker {
    request_id: u64,
    target: String,
    insertion: usize,
    directory: String,
    query: String,
    choice: usize,
    entries: Vec<FileEntry>,
    loading: bool,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug)]
enum ScrollAnchor {
    Moment(usize),
    Media,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScrollDirection {
    Older,
    Newer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ImageRange {
    top: u16,
    bottom: u16,
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

struct ActionSegmentRequest<'a> {
    run_id: &'a str,
    width: u16,
    activity_phase: bool,
    cutoff: Option<u64>,
    after_moment_id: Option<&'a str>,
    flush: bool,
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
    last_image_ranges: Vec<ImageRange>,
    follow_latest: bool,
    scroll_anchor: Option<ScrollAnchor>,
    pending_scroll_direction: Option<ScrollDirection>,
    draft: String,
    draft_cursor: usize,
    draft_references: Vec<DraftReference>,
    draft_visible: bool,
    command_history: Vec<CommandHistoryEntry>,
    action_runs: Vec<RunActions>,
    history_position: Option<usize>,
    history_draft: Option<DraftSnapshot>,
    history_has_more: bool,
    history_loading: bool,
    help_visible: bool,
    connection: ConnectionState,
    activity: Option<String>,
    pending_submission: Option<PendingSubmission>,
    uncertain_submission: Option<DraftSnapshot>,
    active_run: Option<String>,
    active_shell: Option<u64>,
    next_submission_id: u64,
    approval: Option<Approval>,
    approval_run_id: Option<String>,
    principal: String,
    environments: Vec<CapabilityEnvironment>,
    active_environment: usize,
    environment_picker: bool,
    environment_query: String,
    environment_choice: usize,
    file_picker: Option<FilePicker>,
    next_file_request_id: u64,
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
            last_image_ranges: Vec::new(),
            follow_latest: true,
            scroll_anchor: None,
            pending_scroll_direction: None,
            draft: String::new(),
            draft_cursor: 0,
            draft_references: Vec::new(),
            draft_visible: true,
            command_history: Vec::new(),
            action_runs: Vec::new(),
            history_position: None,
            history_draft: None,
            history_has_more: false,
            history_loading: false,
            help_visible: false,
            connection,
            activity: None,
            pending_submission: None,
            uncertain_submission: None,
            active_run: None,
            active_shell: None,
            next_submission_id: 1,
            approval: None,
            approval_run_id: None,
            principal: "you".to_string(),
            environments: vec![CapabilityEnvironment::gsv()],
            active_environment: 0,
            environment_picker: false,
            environment_query: String::new(),
            environment_choice: 0,
            file_picker: None,
            next_file_request_id: 1,
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
        if self.environment_picker || self.file_picker.is_some() {
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

    pub fn completion_picker_visible(&self) -> bool {
        self.environment_picker || self.file_picker.is_some()
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

    pub fn animation_active(&self) -> bool {
        matches!(
            self.connection,
            ConnectionState::Connecting | ConnectionState::Offline
        ) || self.pending_submission.is_some()
            || self.active_run.is_some()
            || self.active_shell.is_some()
            || self.history_loading
            || self
                .moments
                .iter()
                .any(|moment| moment.state == MomentState::Streaming)
            || self
                .file_picker
                .as_ref()
                .is_some_and(|picker| picker.loading)
            || self.action_runs.iter().any(|run| {
                run.live
                    && run
                        .actions
                        .iter()
                        .any(|action| action.state == AgentActionState::Running)
            })
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

    pub fn connection_lost(&mut self) {
        if self.connection == ConnectionState::Demo {
            return;
        }
        if let Some(pending) = self.pending_submission.take() {
            if self.draft.is_empty() {
                self.draft.clone_from(&pending.text);
                self.draft_references.clone_from(&pending.references);
                self.draft_cursor = self.draft.len();
                self.draft_visible = true;
                self.uncertain_submission = Some(DraftSnapshot {
                    text: pending.text.clone(),
                    cursor: pending.text.len(),
                    execution: pending.execution,
                    references: pending.references.clone(),
                });
            }
            let response_id = match pending.execution {
                ExecutionMode::Ship => format!("local:gsv:{}", pending.id),
                ExecutionMode::Shell => format!("local:shell:{}", pending.id),
            };
            if let Some(moment) = self
                .moments
                .iter_mut()
                .find(|moment| moment.id == response_id)
            {
                if !moment.text.is_empty() && !moment.text.ends_with('\n') {
                    moment.text.push('\n');
                }
                moment
                    .text
                    .push_str("Connection changed before GSV confirmed this request.");
                moment.state = MomentState::Error;
            }
        }
        self.active_shell = None;
        self.approval = None;
        self.approval_run_id = None;
        self.history_loading = false;
        if let Some(picker) = self.file_picker.as_mut().filter(|picker| picker.loading) {
            picker.loading = false;
            picker.error = Some("connection changed; press ctrl+o to retry".to_string());
        }
        self.connection = ConnectionState::Offline;
        self.activity = Some("RECONNECTING".to_string());
    }

    pub fn connection_restored(&mut self, active_run_id: Option<&str>) {
        if let Some(run_id) = active_run_id {
            self.start_run(run_id);
        } else {
            if let Some(stale_run_id) = self.active_run.clone() {
                self.finish_run(Some(&stale_run_id), None);
            }
            self.active_run = None;
            self.connection = ConnectionState::Ready;
            self.activity = None;
        }
    }

    pub fn set_activity(&mut self, activity: Option<String>) {
        self.activity = activity.map(|activity| sanitize_status(&activity));
    }

    pub fn start_agent_action(
        &mut self,
        run_id: &str,
        execution_id: &str,
        name: &str,
        syscall: &str,
        target: Option<&str>,
    ) {
        self.start_agent_action_at(run_id, execution_id, name, syscall, target, None);
    }

    pub fn start_agent_action_at(
        &mut self,
        run_id: &str,
        execution_id: &str,
        name: &str,
        syscall: &str,
        target: Option<&str>,
        started_at: Option<u64>,
    ) {
        if run_id.is_empty()
            || execution_id.is_empty()
            || self
                .active_run
                .as_deref()
                .is_some_and(|active_run| active_run != run_id)
        {
            return;
        }
        self.start_run_at(run_id, started_at);

        let after_moment_id = started_at
            .is_none()
            .then(|| {
                self.moments
                    .iter()
                    .rfind(|moment| {
                        moment.run_id.as_deref() == Some(run_id)
                            && moment.state != MomentState::Streaming
                    })
                    .map(|moment| moment.id.clone())
            })
            .flatten();
        let label = agent_action_label(name, syscall);
        let target = target
            .map(|target| sanitize_label(target, "target", 64))
            .filter(|target| !target.trim().is_empty());
        let run_index = self.ensure_action_run(run_id, true);
        let run = &mut self.action_runs[run_index];
        run.live = true;
        run.expanded = true;
        if let Some(action) = run
            .actions
            .iter_mut()
            .find(|action| action.execution_id == execution_id)
        {
            action.label = label;
            action.target = target;
            if started_at.is_some() {
                action.started_at = started_at;
            }
            if action.after_moment_id.is_none() {
                action.after_moment_id = after_moment_id;
            }
            if action.state == AgentActionState::Running {
                self.set_activity_from_latest_action(run_id);
            }
            return;
        }
        if run.actions.len() >= MAX_ACTIONS_PER_RUN {
            run.actions.remove(0);
            run.omitted = run.omitted.saturating_add(1);
        }
        run.actions.push(AgentAction {
            execution_id: execution_id.to_string(),
            label,
            target,
            state: AgentActionState::Running,
            started_at,
            after_moment_id,
        });
        run.actions.sort_by(action_timeline_order);
        self.set_activity_from_latest_action(run_id);
    }

    pub fn finish_agent_action(&mut self, run_id: &str, execution_id: &str, outcome: &str) {
        let Some(run) = self.action_runs.iter_mut().find(|run| run.run_id == run_id) else {
            return;
        };
        let Some(action) = run
            .actions
            .iter_mut()
            .find(|action| action.execution_id == execution_id)
        else {
            return;
        };
        action.state = agent_action_state(outcome);
        self.set_activity_from_latest_action(run_id);
    }

    pub fn restore_agent_action(&mut self, snapshot: AgentActionSnapshot) {
        let AgentActionSnapshot {
            run_id,
            execution_id,
            name,
            syscall,
            target,
            status,
            live,
            started_at,
        } = snapshot;
        if run_id.is_empty() || execution_id.is_empty() {
            return;
        }
        let state = agent_action_state(&status);
        let live = live && state == AgentActionState::Running;
        if live {
            if self
                .active_run
                .as_deref()
                .is_some_and(|active_run| active_run != run_id.as_str())
            {
                return;
            }
            self.start_run(&run_id);
        }

        let label = agent_action_label(&name, &syscall);
        let target = target
            .map(|target| sanitize_label(&target, "target", 64))
            .filter(|target| !target.trim().is_empty());
        let run_index = self.ensure_action_run(&run_id, live);
        let run = &mut self.action_runs[run_index];
        run.live |= live;
        run.expanded |= live;
        if let Some(action) = run
            .actions
            .iter_mut()
            .find(|action| action.execution_id == execution_id)
        {
            action.label = label;
            action.target = target;
            if started_at.is_some() {
                action.started_at = started_at;
            }
            if action.state == AgentActionState::Running || state != AgentActionState::Running {
                action.state = state;
            }
        } else {
            if run.actions.len() >= MAX_ACTIONS_PER_RUN {
                run.actions.remove(0);
                run.omitted = run.omitted.saturating_add(1);
            }
            run.actions.push(AgentAction {
                execution_id,
                label,
                target,
                state,
                started_at,
                after_moment_id: None,
            });
        }
        run.actions.sort_by(action_timeline_order);
        if live {
            self.set_activity_from_latest_action(&run_id);
        }
    }

    pub fn restore_message_delivery(&mut self, delivery: MessageDeliverySnapshot) {
        if let Some(moment) = self.moments.iter_mut().find(|moment| {
            moment.id == delivery.message_id
                && moment.run_id.as_deref() == Some(delivery.run_id.as_str())
        }) {
            moment.timestamp = Some(delivery.started_at);
        }
    }

    pub fn replace_history(&mut self, moments: Vec<Moment>) {
        if moments.is_empty() {
            return;
        }
        self.moments = moments;
        self.rebuild_command_history();
        self.selected = self.moments.len().saturating_sub(1);
        self.document_scroll = 0;
        self.follow_latest = true;
        self.scroll_anchor = None;
        self.media_expanded = false;
        self.media_focus = 0;
    }

    pub fn set_history_has_more(&mut self, has_more: bool) {
        self.history_has_more = has_more;
        self.history_loading = false;
    }

    pub fn reconcile_history(&mut self, moments: Vec<Moment>, has_more: bool) {
        for moment in moments {
            if self.moments.iter().any(|existing| existing.id == moment.id) {
                continue;
            }
            self.commit_moment(moment);
        }
        self.history_has_more = has_more;
        self.history_loading = false;
        self.rebuild_command_history();
    }

    pub fn prepend_history(&mut self, moments: Vec<Moment>, has_more: bool) {
        let anchor_id = self.moments.first().map(|moment| moment.id.clone());
        let mut older = moments
            .into_iter()
            .filter(|moment| !self.moments.iter().any(|existing| existing.id == moment.id))
            .collect::<Vec<_>>();
        if !older.is_empty() {
            older.append(&mut self.moments);
            self.moments = older;
            if let Some(anchor_id) = anchor_id {
                if let Some(index) = self
                    .moments
                    .iter()
                    .position(|moment| moment.id == anchor_id)
                {
                    self.selected = self.selected.saturating_add(index);
                    self.scroll_anchor = Some(ScrollAnchor::Moment(index));
                }
            }
            self.follow_latest = false;
            self.rebuild_command_history();
        }
        self.history_has_more = has_more;
        self.history_loading = false;
    }

    pub fn history_page_failed(&mut self) {
        self.history_loading = false;
    }

    fn rebuild_command_history(&mut self) {
        self.command_history = self
            .moments
            .iter()
            .filter(|moment| moment.role == Role::Human && !moment.text.trim().is_empty())
            .map(|moment| CommandHistoryEntry {
                text: moment.text.clone(),
                execution: moment.execution,
                references: draft_references_from_artifacts(&moment.text, &moment.artifacts),
            })
            .collect();
        if self.command_history.len() > MAX_COMMAND_HISTORY {
            self.command_history
                .drain(..self.command_history.len() - MAX_COMMAND_HISTORY);
        }
        self.reset_history_navigation();
    }

    pub fn enter_approval(&mut self, approval: Approval) {
        let run_id = self.active_run.clone();
        self.enter_approval_for(run_id.as_deref(), approval);
    }

    pub fn enter_approval_for(&mut self, run_id: Option<&str>, mut approval: Approval) {
        approval.syscall = sanitize_label(&approval.syscall, "unknown action", 96);
        approval.target = sanitize_label(&approval.target, "unknown target", 96);
        approval.preview = sanitize_multiline(&approval.preview, 4_000);
        self.approval = Some(approval);
        self.approval_run_id = run_id.map(str::to_string);
        self.environment_picker = false;
        self.file_picker = None;
        self.media_expanded = false;
    }

    pub fn leave_approval(&mut self, request_id: &str) {
        if self
            .approval
            .as_ref()
            .is_some_and(|approval| approval.request_id == request_id)
        {
            self.approval = None;
            self.approval_run_id = None;
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

        if self.file_picker.is_some() {
            return self.dispatch_file_picker(action);
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
                if value == "@"
                    && self.execution_mode == ExecutionMode::Ship
                    && self.draft.is_empty()
                {
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
                if value == "@"
                    && self.execution_mode == ExecutionMode::Ship
                    && self.file_reference_can_begin_here()
                {
                    return self.open_file_picker();
                }
                self.media_expanded = false;
                self.draft_visible = true;
                self.follow_latest = true;
                self.insert_draft_text(&value);
                Vec::new()
            }
            Action::Backspace => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                self.backspace_draft();
                Vec::new()
            }
            Action::Delete => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                self.delete_draft();
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
                let word_start = self
                    .draft_references
                    .iter()
                    .filter(|reference| {
                        reference.start < self.draft_cursor && reference.end > word_start
                    })
                    .map(|reference| reference.start)
                    .min()
                    .unwrap_or(word_start);
                self.delete_draft_range(word_start, self.draft_cursor);
                self.draft_cursor = word_start;
                Vec::new()
            }
            Action::MoveCursorLeft => {
                self.draft_cursor = self
                    .draft_references
                    .iter()
                    .find(|reference| {
                        reference.start < self.draft_cursor && reference.end >= self.draft_cursor
                    })
                    .map(|reference| reference.start)
                    .or_else(|| previous_grapheme_boundary(&self.draft, self.draft_cursor))
                    .unwrap_or(self.draft_cursor);
                Vec::new()
            }
            Action::MoveCursorRight => {
                self.draft_cursor = self
                    .draft_references
                    .iter()
                    .find(|reference| {
                        reference.start <= self.draft_cursor && reference.end > self.draft_cursor
                    })
                    .map(|reference| reference.end)
                    .or_else(|| next_grapheme_boundary(&self.draft, self.draft_cursor))
                    .unwrap_or(self.draft_cursor);
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
                self.insert_draft_text("\n");
                Vec::new()
            }
            Action::OpenFiles => self.open_file_picker(),
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
                self.scroll_older(3, true);
                self.load_older_history_if_needed()
            }
            Action::ScrollDown => {
                self.scroll_newer(3, true);
                Vec::new()
            }
            Action::ScrollPageUp => {
                self.scroll_older(self.last_viewport_height.saturating_sub(2).max(1), false);
                self.load_older_history_if_needed()
            }
            Action::ScrollPageDown => {
                self.scroll_newer(self.last_viewport_height.saturating_sub(2).max(1), false);
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
                if !self.draft_references.is_empty() {
                    return Vec::new();
                }
                self.execution_mode = match self.execution_mode {
                    ExecutionMode::Ship => ExecutionMode::Shell,
                    ExecutionMode::Shell => ExecutionMode::Ship,
                };
                self.draft_visible = true;
                self.follow_latest = true;
                self.media_expanded = false;
                Vec::new()
            }
            Action::ToggleActions => {
                self.toggle_selected_actions();
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

    fn dispatch_file_picker(&mut self, action: Action) -> Vec<Effect> {
        match action {
            Action::Insert(value) => {
                let value = sanitize_draft_input(&value);
                if let Some(picker) = self.file_picker.as_mut() {
                    if !value.is_empty() {
                        picker.query.push_str(&value);
                        picker.choice = 0;
                    }
                }
                Vec::new()
            }
            Action::Backspace | Action::Delete => {
                let Some(picker) = self.file_picker.as_mut() else {
                    return Vec::new();
                };
                if let Some(previous) =
                    previous_grapheme_boundary(&picker.query, picker.query.len())
                {
                    picker.query.truncate(previous);
                    picker.choice = 0;
                } else {
                    self.file_picker = None;
                }
                Vec::new()
            }
            Action::PreviousChoice | Action::PreviousTurn | Action::ScrollUp => {
                let count = self.matching_file_entries().len();
                if let Some(picker) = self.file_picker.as_mut() {
                    if count > 0 {
                        picker.choice = picker
                            .choice
                            .checked_sub(1)
                            .unwrap_or(count.saturating_sub(1));
                    }
                }
                Vec::new()
            }
            Action::NextChoice | Action::NextTurn | Action::ScrollDown => {
                let count = self.matching_file_entries().len();
                if let Some(picker) = self.file_picker.as_mut() {
                    if count > 0 {
                        picker.choice = (picker.choice + 1) % count;
                    }
                }
                Vec::new()
            }
            Action::Submit => self.select_file_choice(),
            Action::OpenFiles => {
                self.file_picker = None;
                self.open_file_picker()
            }
            Action::Escape => {
                self.file_picker = None;
                Vec::new()
            }
            Action::Quit => vec![Effect::Quit],
            _ => Vec::new(),
        }
    }

    fn file_reference_can_begin_here(&self) -> bool {
        !self.draft.is_empty()
            && (self.draft_cursor == 0
                || self.draft[..self.draft_cursor]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace))
    }

    fn open_file_picker(&mut self) -> Vec<Effect> {
        if self.execution_mode != ExecutionMode::Ship {
            return Vec::new();
        }
        self.close_environment_picker();
        let request_id = self.next_file_request_id;
        self.next_file_request_id = self.next_file_request_id.saturating_add(1);
        let environment = self.active_environment().clone();
        let directory = environment
            .cwd
            .clone()
            .filter(|cwd| !cwd.trim().is_empty())
            .unwrap_or_else(|| "~".to_string());
        self.file_picker = Some(FilePicker {
            request_id,
            target: environment.target.clone(),
            insertion: self.draft_cursor,
            directory: directory.clone(),
            query: String::new(),
            choice: 0,
            entries: Vec::new(),
            loading: true,
            error: None,
        });
        self.draft_visible = true;
        self.follow_latest = true;
        self.media_expanded = false;
        vec![Effect::BrowseFiles {
            request_id,
            target: environment.target,
            directory,
        }]
    }

    fn select_file_choice(&mut self) -> Vec<Effect> {
        let matches = self.matching_file_entries();
        let Some(picker) = self.file_picker.as_ref() else {
            return Vec::new();
        };
        let loading = picker.loading;
        let choice = picker.choice;
        let request_id = picker.request_id;
        let target = picker.target.clone();
        if loading {
            return Vec::new();
        }
        let Some(entry) = matches
            .get(choice.min(matches.len().saturating_sub(1)))
            .cloned()
        else {
            return Vec::new();
        };
        if entry.is_directory {
            let request_id = self.next_file_request_id;
            self.next_file_request_id = self.next_file_request_id.saturating_add(1);
            if let Some(picker) = self.file_picker.as_mut() {
                picker.request_id = request_id;
                picker.directory.clone_from(&entry.path);
                picker.query.clear();
                picker.choice = 0;
                picker.entries.clear();
                picker.loading = true;
                picker.error = None;
            }
            return vec![Effect::BrowseFiles {
                request_id,
                target,
                directory: entry.path,
            }];
        }
        if let Some(picker) = self.file_picker.as_mut() {
            picker.loading = true;
            picker.error = None;
        }
        vec![Effect::ResolveFile {
            request_id,
            target,
            path: entry.path,
            filename: entry.name,
        }]
    }

    pub fn file_listing_loaded(
        &mut self,
        request_id: u64,
        directory: String,
        mut entries: Vec<FileEntry>,
    ) {
        let Some(picker) = self.file_picker.as_mut() else {
            return;
        };
        if picker.request_id != request_id {
            return;
        }
        entries.sort_by(|left, right| {
            right
                .is_directory
                .cmp(&left.is_directory)
                .then_with(|| {
                    left.name
                        .to_ascii_lowercase()
                        .cmp(&right.name.to_ascii_lowercase())
                })
                .then_with(|| left.name.cmp(&right.name))
        });
        picker.directory = directory;
        picker.entries = entries;
        picker.choice = 0;
        picker.loading = false;
        picker.error = None;
    }

    pub fn file_picker_failed(&mut self, request_id: u64, error: impl Into<String>) {
        let Some(picker) = self.file_picker.as_mut() else {
            return;
        };
        if picker.request_id != request_id {
            return;
        }
        picker.loading = false;
        picker.error = Some(sanitize_label(
            &error.into(),
            "could not read this directory",
            160,
        ));
    }

    pub fn file_reference_resolved(&mut self, request_id: u64, reference: FileReference) {
        let Some(picker) = self.file_picker.as_ref() else {
            return;
        };
        if picker.request_id != request_id {
            return;
        }
        let insertion = picker.insertion.min(self.draft.len());
        self.file_picker = None;
        self.insert_file_reference(insertion, reference);
    }

    fn matching_file_entries(&self) -> Vec<FileEntry> {
        let Some(picker) = self.file_picker.as_ref() else {
            return Vec::new();
        };
        let query = picker.query.trim().to_ascii_lowercase();
        let parent = (query.is_empty())
            .then(|| unix_parent(&picker.directory))
            .flatten()
            .map(|path| FileEntry {
                name: "..".to_string(),
                path,
                is_directory: true,
            });
        parent
            .into_iter()
            .chain(
                picker
                    .entries
                    .iter()
                    .filter(|entry| {
                        query.is_empty()
                            || entry.name.to_ascii_lowercase().contains(&query)
                            || entry.path.to_ascii_lowercase().contains(&query)
                    })
                    .cloned(),
            )
            .collect()
    }

    fn insert_file_reference(&mut self, insertion: usize, reference: FileReference) {
        let token = reference_token(&reference);
        let needs_leading_space = insertion > 0
            && self.draft[..insertion]
                .chars()
                .next_back()
                .is_some_and(|character| !character.is_whitespace());
        let needs_trailing_space = insertion < self.draft.len()
            && self.draft[insertion..]
                .chars()
                .next()
                .is_some_and(|character| !character.is_whitespace());
        let leading = if needs_leading_space { " " } else { "" };
        let trailing = if needs_trailing_space { " " } else { "" };
        let inserted = format!("{leading}{token}{trailing}");
        self.draft_cursor = insertion;
        self.insert_draft_text(&inserted);
        let start = insertion + leading.len();
        self.draft_references.push(DraftReference {
            start,
            end: start + token.len(),
            reference,
        });
        self.draft_references
            .sort_by_key(|reference| reference.start);
    }

    fn insert_draft_text(&mut self, value: &str) {
        if value.is_empty() {
            return;
        }
        let cursor = self.draft_cursor;
        self.draft_references.retain_mut(|reference| {
            if cursor > reference.start && cursor < reference.end {
                return false;
            }
            if reference.start >= cursor {
                reference.start = reference.start.saturating_add(value.len());
                reference.end = reference.end.saturating_add(value.len());
            }
            true
        });
        self.draft.insert_str(cursor, value);
        self.draft_cursor = cursor.saturating_add(value.len());
    }

    fn backspace_draft(&mut self) {
        if let Some(reference) = self
            .draft_references
            .iter()
            .find(|reference| {
                reference.start < self.draft_cursor && reference.end >= self.draft_cursor
            })
            .cloned()
        {
            self.delete_draft_range(reference.start, reference.end);
            self.draft_cursor = reference.start;
            return;
        }
        if let Some(previous) = previous_grapheme_boundary(&self.draft, self.draft_cursor) {
            self.delete_draft_range(previous, self.draft_cursor);
            self.draft_cursor = previous;
        }
    }

    fn delete_draft(&mut self) {
        if let Some(reference) = self
            .draft_references
            .iter()
            .find(|reference| {
                reference.start <= self.draft_cursor && reference.end > self.draft_cursor
            })
            .cloned()
        {
            self.delete_draft_range(reference.start, reference.end);
            self.draft_cursor = reference.start;
            return;
        }
        if let Some(next) = next_grapheme_boundary(&self.draft, self.draft_cursor) {
            self.delete_draft_range(self.draft_cursor, next);
        }
    }

    fn delete_draft_range(&mut self, start: usize, end: usize) {
        if start >= end || end > self.draft.len() {
            return;
        }
        let removed = end - start;
        self.draft_references.retain_mut(|reference| {
            if reference.end <= start {
                return true;
            }
            if reference.start >= end {
                reference.start -= removed;
                reference.end -= removed;
                return true;
            }
            false
        });
        self.draft.drain(start..end);
    }

    fn begin_submission(&mut self) -> Option<Effect> {
        if self.pending_submission.is_some() || self.draft.trim().is_empty() {
            return None;
        }

        let id = self.next_submission_id;
        self.next_submission_id = self.next_submission_id.saturating_add(1);
        let execution = self.execution_mode;
        let text = std::mem::take(&mut self.draft);
        let references = std::mem::take(&mut self.draft_references);
        let resource_references = references
            .iter()
            .map(|reference| reference.reference.clone())
            .collect::<Vec<_>>();
        self.draft_cursor = 0;
        self.draft_visible = true;
        self.record_command(text.clone(), execution, references.clone());
        self.reset_history_navigation();
        self.pending_submission = Some(PendingSubmission {
            id,
            text: text.clone(),
            execution,
            references: references.clone(),
        });
        self.uncertain_submission = None;
        self.moments.push(
            Moment::complete(format!("local:user:{id}"), Role::Human, text.clone())
                .with_environment(self.active_environment().clone())
                .with_execution(execution)
                .with_artifacts(
                    resource_references
                        .iter()
                        .map(FileReference::artifact)
                        .collect(),
                ),
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
            sequence: None,
            timestamp: None,
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
                references: resource_references,
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
        let local_user_id = format!("local:user:{id}");
        for local_id in [local_user_id.clone(), format!("local:gsv:{id}")] {
            if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
                moment.run_id = Some(run_id.clone());
            }
        }
        if let Some(run) = self
            .action_runs
            .iter_mut()
            .find(|actions| actions.run_id == run_id)
        {
            for action in &mut run.actions {
                if action.started_at.is_none() && action.after_moment_id.is_none() {
                    action.after_moment_id = Some(local_user_id.clone());
                }
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
            self.draft_references = pending.references;
            self.draft_cursor = self.draft.len();
            self.draft_visible = true;
        }
        let local_id = format!("local:gsv:{id}");
        if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
            moment.text = error.into();
            moment.state = MomentState::Error;
        }
        if !matches!(
            self.connection,
            ConnectionState::Offline | ConnectionState::Connecting
        ) {
            self.connection = if self.active_run.is_some() || self.active_shell.is_some() {
                ConnectionState::Working
            } else {
                ConnectionState::Ready
            };
        }
        self.activity = None;
    }

    pub fn start_run(&mut self, run_id: &str) {
        self.start_run_at(run_id, None);
    }

    pub fn start_run_at(&mut self, run_id: &str, timestamp: Option<u64>) {
        if run_id.is_empty() {
            return;
        }
        if let Some(index) = self.streaming_moment_for(Some(run_id)) {
            self.moments[index].run_id = Some(run_id.to_string());
            if timestamp.is_some() && self.moments[index].timestamp.is_none() {
                self.moments[index].timestamp = timestamp;
            }
        } else {
            self.moments.push(Moment {
                id: format!("activity:{run_id}"),
                role: Role::Intelligence,
                execution: ExecutionMode::Ship,
                text: String::new(),
                run_id: Some(run_id.to_string()),
                sequence: None,
                timestamp,
                state: MomentState::Streaming,
                artifacts: Vec::new(),
                environment: None,
            });
            if self.follow_latest {
                self.selected = self.moments.len().saturating_sub(1);
            }
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
        self.start_message_stream_at(run_id, message_id, None);
    }

    pub fn start_message_stream_at(
        &mut self,
        run_id: &str,
        message_id: &str,
        timestamp: Option<u64>,
    ) {
        self.start_run_at(run_id, timestamp);
        if self.moments.iter().any(|moment| moment.id == message_id) {
            return;
        }
        if let Some(index) = self.streaming_moment_for(Some(run_id)) {
            if self.moments[index].text.is_empty() && self.moments[index].artifacts.is_empty() {
                self.moments[index].id = message_id.to_string();
                self.moments[index].run_id = Some(run_id.to_string());
                self.moments[index].timestamp = timestamp;
                return;
            }
        }
        self.moments.push(Moment {
            id: message_id.to_string(),
            role: Role::Intelligence,
            execution: ExecutionMode::Ship,
            text: String::new(),
            run_id: Some(run_id.to_string()),
            sequence: None,
            timestamp,
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
                    sequence: None,
                    timestamp: None,
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
        let has_actions = effective_run
            .as_deref()
            .is_some_and(|run_id| self.action_runs.iter().any(|run| run.run_id == run_id));
        if !is_active && index.is_none() && !has_actions {
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
                    sequence: None,
                    timestamp: None,
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

        if let Some(run_id) = effective_run.as_deref() {
            self.finish_action_run(run_id, error.is_some());
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
            self.approval_run_id = None;
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
        self.commit_moment(Moment {
            id: id.into(),
            role,
            execution: ExecutionMode::Ship,
            text: text.into(),
            run_id,
            sequence: None,
            timestamp: None,
            state: MomentState::Complete,
            artifacts,
            environment,
        });
    }

    pub fn commit_moment(&mut self, moment: Moment) {
        let Moment {
            id,
            role,
            execution: _,
            text,
            run_id,
            sequence,
            timestamp,
            state: _,
            artifacts,
            environment,
        } = moment;
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
            if let Some(index) = exact_run.or(unbound) {
                let old_id = self.moments[index].id.clone();
                {
                    let moment = &mut self.moments[index];
                    moment.id = id.clone();
                    moment.run_id = run_id.clone();
                    moment.artifacts = artifacts;
                    moment.sequence = sequence;
                    moment.timestamp = timestamp;
                    if environment.is_some() {
                        moment.environment = environment;
                    }
                }
                for action in self.action_runs.iter_mut().flat_map(|run| &mut run.actions) {
                    if action.after_moment_id.as_deref() == Some(old_id.as_str()) {
                        action.after_moment_id = Some(id.clone());
                    }
                }
                if let Some(submission_id) = old_id.strip_prefix("local:user:") {
                    let response_id = format!("local:gsv:{submission_id}");
                    if let Some(response_index) = self.moments.iter().position(|moment| {
                        moment.id == response_id && moment.state == MomentState::Error
                    }) {
                        self.moments.remove(response_index);
                        self.selected = self.selected.min(self.moments.len().saturating_sub(1));
                    }
                }
                if self
                    .uncertain_submission
                    .as_ref()
                    .is_some_and(|submission| {
                        submission.execution == ExecutionMode::Ship
                            && submission.text == text
                            && self.draft == submission.text
                    })
                {
                    self.draft.clear();
                    self.draft_references.clear();
                    self.draft_cursor = 0;
                }
                self.uncertain_submission = None;
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
                    {
                        let moment = &mut self.moments[index];
                        moment.id = id;
                        moment.text = text;
                        moment.state = MomentState::Complete;
                        moment.artifacts = artifacts;
                        moment.sequence = sequence;
                        moment.timestamp = timestamp;
                    }
                    if let Some(run_id) = run_id
                        .as_deref()
                        .filter(|run_id| self.active_run.as_deref() == Some(*run_id))
                    {
                        self.start_run(run_id);
                    }
                    return;
                }
            }
        }
        if role == Role::Human {
            let references = draft_references_from_artifacts(&text, &artifacts);
            self.record_command(text.clone(), ExecutionMode::Ship, references);
        }
        let continuing_run = (role == Role::Intelligence)
            .then(|| run_id.clone())
            .flatten()
            .filter(|run_id| self.active_run.as_deref() == Some(run_id));
        self.moments.push(Moment {
            id,
            role,
            execution: ExecutionMode::Ship,
            text,
            run_id,
            sequence,
            timestamp,
            state: MomentState::Complete,
            artifacts,
            environment,
        });
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
        }
        if let Some(run_id) = continuing_run {
            self.start_run(&run_id);
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
            sequence: None,
            timestamp: None,
            state: MomentState::Error,
            artifacts: Vec::new(),
            environment: None,
        });
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
        }
    }

    fn record_command(
        &mut self,
        text: String,
        execution: ExecutionMode,
        references: Vec<DraftReference>,
    ) {
        if text.trim().is_empty() {
            return;
        }
        self.command_history.push(CommandHistoryEntry {
            text,
            execution,
            references,
        });
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
                    references: self.draft_references.clone(),
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
            references: Vec::new(),
        });
        self.history_position = None;
        self.draft = snapshot.text;
        self.draft_references = snapshot.references;
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
        self.draft_references.clone_from(&entry.references);
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

    fn scroll_older(&mut self, rows: u16, atomic_media: bool) {
        let current = if self.follow_latest {
            self.last_max_scroll
        } else {
            self.document_scroll
        };
        let desired = current.saturating_sub(rows);
        self.document_scroll = if atomic_media {
            atomic_media_scroll(
                current,
                desired,
                ScrollDirection::Older,
                self.last_viewport_height,
                self.last_max_scroll,
                &self.last_image_ranges,
            )
        } else {
            snap_partial_media_scroll(
                desired,
                ScrollDirection::Older,
                self.last_viewport_height,
                self.last_max_scroll,
                &self.last_image_ranges,
            )
        };
        self.follow_latest = false;
        self.scroll_anchor = None;
        self.pending_scroll_direction = Some(ScrollDirection::Older);
        self.media_expanded = false;
        self.draft_visible = false;
    }

    fn scroll_newer(&mut self, rows: u16, atomic_media: bool) {
        let current = self.document_scroll.min(self.last_max_scroll);
        let desired = current.saturating_add(rows).min(self.last_max_scroll);
        self.document_scroll = if atomic_media {
            atomic_media_scroll(
                current,
                desired,
                ScrollDirection::Newer,
                self.last_viewport_height,
                self.last_max_scroll,
                &self.last_image_ranges,
            )
        } else {
            snap_partial_media_scroll(
                desired,
                ScrollDirection::Newer,
                self.last_viewport_height,
                self.last_max_scroll,
                &self.last_image_ranges,
            )
        };
        self.follow_latest = self.document_scroll >= self.last_max_scroll;
        self.scroll_anchor = None;
        self.pending_scroll_direction = Some(ScrollDirection::Newer);
        self.media_expanded = false;
    }

    fn load_older_history_if_needed(&mut self) -> Vec<Effect> {
        if self.document_scroll != 0 || !self.history_has_more || self.history_loading {
            return Vec::new();
        }
        let Some(before_sequence) = self
            .moments
            .iter()
            .filter_map(|moment| moment.sequence)
            .min()
        else {
            return Vec::new();
        };
        self.history_loading = true;
        vec![Effect::LoadOlderHistory { before_sequence }]
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

    fn ensure_action_run(&mut self, run_id: &str, live: bool) -> usize {
        if let Some(index) = self.action_runs.iter().position(|run| run.run_id == run_id) {
            return index;
        }
        if self.action_runs.len() >= MAX_ACTION_RUNS {
            let remove = self
                .action_runs
                .iter()
                .position(|run| !run.live)
                .unwrap_or(0);
            self.action_runs.remove(remove);
        }
        self.action_runs.push(RunActions {
            run_id: run_id.to_string(),
            actions: Vec::new(),
            omitted: 0,
            expanded: live,
            live,
        });
        self.action_runs.len() - 1
    }

    fn set_activity_from_latest_action(&mut self, run_id: &str) {
        if self.active_run.as_deref() != Some(run_id) {
            return;
        }
        self.activity = self
            .action_runs
            .iter()
            .find(|run| run.run_id == run_id)
            .and_then(|run| {
                run.actions
                    .iter()
                    .rev()
                    .find(|action| action.state == AgentActionState::Running)
            })
            .map(agent_action_status)
            .or_else(|| Some("THINKING".to_string()));
    }

    fn finish_action_run(&mut self, run_id: &str, failed: bool) {
        let Some(run) = self.action_runs.iter_mut().find(|run| run.run_id == run_id) else {
            return;
        };
        run.live = false;
        run.expanded = false;
        for action in &mut run.actions {
            if action.state == AgentActionState::Running {
                action.state = if failed {
                    AgentActionState::Failed
                } else {
                    AgentActionState::Completed
                };
            }
        }
    }

    fn toggle_selected_actions(&mut self) {
        if self.moments.is_empty() {
            return;
        }
        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        let run_id = self.moments[start..=end]
            .iter()
            .find_map(|moment| moment.run_id.as_deref());
        let Some(run_id) = run_id else {
            return;
        };
        let Some(run) = self.action_runs.iter_mut().find(|run| run.run_id == run_id) else {
            return;
        };
        run.expanded = !run.expanded;
        if !self.follow_latest {
            self.scroll_anchor = Some(ScrollAnchor::Moment(start));
        }
    }

    fn run_has_active_action(&self, run_id: &str) -> bool {
        self.action_runs
            .iter()
            .find(|run| run.run_id == run_id)
            .is_some_and(|run| {
                run.actions
                    .iter()
                    .any(|action| action.state == AgentActionState::Running)
            })
    }

    fn push_action_run_segment(
        &self,
        rendered: &mut Vec<(String, usize)>,
        blocks: &mut Vec<TranscriptBlock>,
        document_height: &mut u16,
        request: ActionSegmentRequest<'_>,
    ) {
        let ActionSegmentRequest {
            run_id,
            width,
            activity_phase,
            cutoff,
            after_moment_id,
            flush,
        } = request;
        let Some(run) = self
            .action_runs
            .iter()
            .find(|run| run.run_id == run_id && !run.actions.is_empty())
        else {
            return;
        };
        let cursor_index = rendered
            .iter()
            .position(|(rendered_run_id, _)| rendered_run_id == run_id)
            .unwrap_or_else(|| {
                rendered.push((run_id.to_string(), 0));
                rendered.len() - 1
            });
        let cursor = rendered[cursor_index].1;
        if cursor >= run.actions.len() {
            return;
        }
        if !run.expanded {
            push_transcript_text(
                blocks,
                document_height,
                render_agent_action_summary(run, self.theme.palette(), activity_phase),
                width,
            );
            rendered[cursor_index].1 = run.actions.len();
            return;
        }

        let end = if flush {
            run.actions.len()
        } else if let Some(after_moment_id) = after_moment_id {
            run.actions[cursor..]
                .iter()
                .position(|action| action.after_moment_id.as_deref() != Some(after_moment_id))
                .map_or(run.actions.len(), |offset| cursor + offset)
        } else if let Some(cutoff) = cutoff {
            run.actions[cursor..]
                .iter()
                .position(|action| {
                    action
                        .started_at
                        .is_none_or(|started_at| started_at > cutoff)
                })
                .map_or(run.actions.len(), |offset| cursor + offset)
        } else {
            cursor
        };
        if end <= cursor {
            return;
        }
        let visible_start = if run.live {
            run.actions.len().saturating_sub(MAX_VISIBLE_LIVE_ACTIONS)
        } else {
            0
        };
        let start = cursor.max(visible_start);
        if end > start {
            let hidden = if cursor < visible_start {
                run.omitted.saturating_add(visible_start)
            } else {
                0
            };
            push_transcript_text(
                blocks,
                document_height,
                render_agent_action_segment(
                    &run.actions[start..end],
                    hidden,
                    self.theme.palette(),
                    activity_phase,
                ),
                width,
            );
        }
        rendered[cursor_index].1 = end;
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
        self.render_with_phases(frame, true, true);
    }

    pub fn render_with_cursor(&mut self, frame: &mut Frame<'_>, cursor_phase: bool) {
        self.render_with_phases(frame, cursor_phase, cursor_phase);
    }

    pub fn render_with_animation(&mut self, frame: &mut Frame<'_>, activity_phase: bool) {
        self.render_with_phases(frame, true, activity_phase);
    }

    fn render_with_phases(
        &mut self,
        frame: &mut Frame<'_>,
        cursor_phase: bool,
        activity_phase: bool,
    ) {
        let palette = self.theme.palette();
        let area = frame.area();
        self.media_slots.clear();
        self.last_image_ranges.clear();
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

        let vertical_margin = if area.height > 18 { 2 } else { 1 };
        let canvas = area.inner(Margin::new(0, vertical_margin));
        self.render_transcript(frame, canvas, cursor_phase, activity_phase);
        if self.help_visible {
            self.media_slots.clear();
            self.render_help(frame, area);
        }
    }

    fn render_transcript(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        cursor_phase: bool,
        activity_phase: bool,
    ) {
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

        let show_prompt =
            self.draft_visible || self.follow_latest || self.completion_picker_visible();
        let mut prompt = show_prompt.then(|| {
            let (draft, cursor, style_ranges) = self.visible_draft(palette);
            let mut prompt = prompted_text_lines(
                self.input_prompt(self.active_environment(), self.execution_mode),
                &draft,
                area.width,
                Style::new().fg(palette.foreground),
                &style_ranges,
                Some(cursor),
            );
            if draft.is_empty() {
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
        let mut image_ranges = Vec::new();
        let mut rendered_action_counts = Vec::new();
        let mut rendered_approval = false;

        if self.history_loading {
            push_transcript_text(
                &mut blocks,
                &mut document_height,
                vec![activity_line(
                    Some("loading earlier history"),
                    palette,
                    activity_phase,
                )],
                area.width,
            );
        }

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
            if moment.role != Role::Human {
                if let Some(run_id) = moment.run_id.as_deref() {
                    self.push_action_run_segment(
                        &mut rendered_action_counts,
                        &mut blocks,
                        &mut document_height,
                        ActionSegmentRequest {
                            run_id,
                            width: area.width,
                            activity_phase,
                            cutoff: moment.timestamp,
                            after_moment_id: None,
                            flush: false,
                        },
                    );
                }
            }
            let body = moment.text.as_str();
            let empty_streaming = body.is_empty() && moment.state == MomentState::Streaming;
            let action_is_active = moment
                .run_id
                .as_deref()
                .is_some_and(|run_id| self.run_has_active_action(run_id));
            let body_color = if moment.state == MomentState::Error {
                palette.error
            } else {
                moment.role.color(palette)
            };
            let in_selected_turn = (turn_start..=turn_end).contains(&index);
            let artifact_focus = moment
                .artifacts
                .iter()
                .map(|_| {
                    if in_selected_turn {
                        let focused = selected_artifact_index == self.media_focus;
                        selected_artifact_index = selected_artifact_index.saturating_add(1);
                        focused
                    } else {
                        false
                    }
                })
                .collect::<Vec<_>>();
            let inline_artifacts = if moment.role == Role::Human {
                inline_artifact_occurrences(body, &moment.artifacts)
            } else {
                vec![None; moment.artifacts.len()]
            };
            let inline_styles = inline_artifacts
                .iter()
                .zip(&artifact_focus)
                .filter_map(|(occurrence, focused)| {
                    occurrence.map(|(start, end)| TextStyleRange {
                        start,
                        end,
                        style: Style::new()
                            .fg(palette.path)
                            .add_modifier(Modifier::UNDERLINED)
                            .add_modifier(if *focused {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    })
                })
                .collect::<Vec<_>>();
            let mut has_content = !body.is_empty() || (empty_streaming && !action_is_active);
            let body_top = document_height;
            if has_content {
                let mut body_lines = if empty_streaming {
                    vec![activity_line(
                        self.activity.as_deref(),
                        palette,
                        activity_phase,
                    )]
                } else {
                    match moment.role {
                        Role::Human => {
                            let environment = moment
                                .environment
                                .as_ref()
                                .unwrap_or_else(|| self.default_environment());
                            prompted_text_lines(
                                self.input_prompt(environment, moment.execution),
                                body,
                                area.width,
                                Style::new().fg(body_color),
                                &inline_styles,
                                None,
                            )
                            .lines
                        }
                        Role::Intelligence
                            if moment.execution == ExecutionMode::Ship && !self.raw_markdown =>
                        {
                            render_markdown(body, palette)
                        }
                        Role::Intelligence if moment.execution == ExecutionMode::Shell => {
                            render_plain(
                                body.strip_suffix('\n').unwrap_or(body),
                                Style::new().fg(body_color),
                            )
                        }
                        Role::Intelligence | Role::System => {
                            render_plain(body, Style::new().fg(body_color))
                        }
                    }
                };
                if !empty_streaming && moment.state == MomentState::Streaming {
                    append_activity_cursor(&mut body_lines, palette, activity_phase);
                }
                push_transcript_text(&mut blocks, &mut document_height, body_lines, area.width);
            }
            if inline_artifacts
                .iter()
                .zip(&artifact_focus)
                .any(|(occurrence, focused)| occurrence.is_some() && *focused)
            {
                focused_media_range = Some((body_top, document_height));
            }

            for ((artifact, inline), focused) in moment
                .artifacts
                .iter()
                .zip(inline_artifacts)
                .zip(artifact_focus)
            {
                if inline.is_some() && artifact.kind == MediaKind::Document {
                    continue;
                }
                if has_content {
                    push_transcript_text(
                        &mut blocks,
                        &mut document_height,
                        vec![Line::default()],
                        area.width,
                    );
                }
                let top = document_height;
                if artifact.kind == MediaKind::Image && image_height > 0 {
                    blocks.push(TranscriptBlock::Image {
                        top,
                        height: image_height,
                        artifact: artifact.clone(),
                        focused,
                    });
                    document_height = document_height.saturating_add(image_height);
                    image_ranges.push(ImageRange {
                        top,
                        bottom: document_height,
                    });
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
            if let Some(run_id) = moment.run_id.as_deref() {
                self.push_action_run_segment(
                    &mut rendered_action_counts,
                    &mut blocks,
                    &mut document_height,
                    ActionSegmentRequest {
                        run_id,
                        width: area.width,
                        activity_phase,
                        cutoff: None,
                        after_moment_id: Some(&moment.id),
                        flush: false,
                    },
                );
            }
            if let Some(run_id) = moment.run_id.as_deref() {
                let run_continues = self.moments.get(index + 1).is_some_and(|next| {
                    next.role != Role::Human && next.run_id.as_deref() == Some(run_id)
                });
                if !run_continues {
                    self.push_action_run_segment(
                        &mut rendered_action_counts,
                        &mut blocks,
                        &mut document_height,
                        ActionSegmentRequest {
                            run_id,
                            width: area.width,
                            activity_phase,
                            cutoff: None,
                            after_moment_id: None,
                            flush: true,
                        },
                    );
                    if !rendered_approval && self.approval_run_id.as_deref() == Some(run_id) {
                        if let Some(approval) = &self.approval {
                            push_transcript_text(
                                &mut blocks,
                                &mut document_height,
                                render_approval_lines(approval, palette),
                                area.width,
                            );
                            rendered_approval = true;
                        }
                    }
                }
            }
        }
        if !rendered_approval {
            if let Some(approval) = &self.approval {
                push_transcript_text(
                    &mut blocks,
                    &mut document_height,
                    render_approval_lines(approval, palette),
                    area.width,
                );
            }
        }
        self.last_image_ranges = image_ranges;

        self.last_viewport_height = viewport_height.max(1);
        self.last_max_scroll = document_height.saturating_sub(viewport_height);
        let anchor = self.scroll_anchor.take();
        let scroll_direction = self.pending_scroll_direction.take();
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
                None => {
                    if let Some(direction) = scroll_direction {
                        self.document_scroll = snap_partial_media_scroll(
                            self.document_scroll,
                            direction,
                            self.last_viewport_height,
                            self.last_max_scroll,
                            &self.last_image_ranges,
                        );
                    }
                }
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
            self.render_completion_picker(frame, area, prompt_area, activity_phase);
        }
    }

    fn visible_draft(&self, palette: Palette) -> (String, usize, Vec<TextStyleRange>) {
        if self.environment_picker {
            let value = format!("@{}", self.environment_query);
            let end = value.len();
            return (
                value,
                end,
                vec![TextStyleRange {
                    start: 0,
                    end,
                    style: Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
                }],
            );
        }

        let mut value = self.draft.clone();
        let mut ranges = self
            .draft_references
            .iter()
            .map(|reference| TextStyleRange {
                start: reference.start,
                end: reference.end,
                style: Style::new()
                    .fg(palette.path)
                    .add_modifier(Modifier::UNDERLINED),
            })
            .collect::<Vec<_>>();
        let mut cursor = self.draft_cursor;
        if let Some(picker) = &self.file_picker {
            let insertion = picker.insertion.min(value.len());
            let completion = format!("@{}", picker.query);
            let completion_len = completion.len();
            for range in &mut ranges {
                if range.start >= insertion {
                    range.start = range.start.saturating_add(completion_len);
                    range.end = range.end.saturating_add(completion_len);
                }
            }
            value.insert_str(insertion, &completion);
            ranges.push(TextStyleRange {
                start: insertion,
                end: insertion.saturating_add(completion_len),
                style: Style::new()
                    .fg(palette.path)
                    .add_modifier(Modifier::UNDERLINED),
            });
            cursor = insertion.saturating_add(completion_len);
        }
        ranges.sort_by_key(|range| range.start);
        (value, cursor, ranges)
    }

    fn render_completion_picker(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        prompt_area: Rect,
        activity_phase: bool,
    ) {
        const MAX_ROWS: usize = 7;

        if !self.completion_picker_visible() || prompt_area.y <= area.y {
            return;
        }
        let palette = self.theme.palette();
        let mut lines = Vec::new();
        if self.environment_picker {
            let matches = self.matching_environment_indices();
            let selected = self.environment_choice.min(matches.len().saturating_sub(1));
            let start = selected.saturating_sub(MAX_ROWS.saturating_sub(1));
            for (choice, index) in matches
                .iter()
                .copied()
                .enumerate()
                .skip(start)
                .take(MAX_ROWS)
            {
                let environment = &self.environments[index];
                let is_selected = choice == selected;
                let marker = if is_selected { "› " } else { "  " };
                let target = prompt_token(&environment.target, "target");
                let label = sanitize_label(&environment.label, &target, 80);
                let mut spans = vec![Span::styled(
                    format!("{marker}{target}"),
                    Style::new()
                        .fg(if is_selected {
                            palette.accent
                        } else {
                            palette.foreground
                        })
                        .add_modifier(if is_selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                )];
                if label != target {
                    spans.push(Span::styled(
                        format!("  {label}"),
                        Style::new().fg(palette.quiet),
                    ));
                }
                lines.push(Line::from(spans));
            }
            if lines.is_empty() {
                lines.push(Line::from(Span::styled(
                    "  no matching target",
                    Style::new().fg(palette.quiet),
                )));
            }
        } else if let Some(picker) = &self.file_picker {
            if picker.loading {
                lines.push(activity_line(Some("loading"), palette, activity_phase));
            } else if let Some(error) = &picker.error {
                lines.push(Line::from(Span::styled(
                    format!("  {error}"),
                    Style::new().fg(palette.error),
                )));
            } else {
                let matches = self.matching_file_entries();
                let selected = picker.choice.min(matches.len().saturating_sub(1));
                let start = selected.saturating_sub(MAX_ROWS.saturating_sub(1));
                for (choice, entry) in matches.iter().enumerate().skip(start).take(MAX_ROWS) {
                    let is_selected = choice == selected;
                    let marker = if is_selected { "› " } else { "  " };
                    let name = sanitize_label(&entry.name, "file", 120);
                    let suffix = if entry.is_directory { "/" } else { "" };
                    lines.push(Line::from(Span::styled(
                        format!("{marker}{name}{suffix}"),
                        Style::new()
                            .fg(if is_selected || entry.is_directory {
                                palette.path
                            } else {
                                palette.foreground
                            })
                            .add_modifier(if is_selected {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    )));
                }
                if lines.is_empty() {
                    lines.push(Line::from(Span::styled(
                        "  no matching file",
                        Style::new().fg(palette.quiet),
                    )));
                }
            }
        }

        let available_height = prompt_area.y.saturating_sub(area.y);
        let height = u16::try_from(lines.len())
            .unwrap_or(u16::MAX)
            .min(available_height)
            .max(1);
        let width = area.width.clamp(1, 72);
        let picker_area = Rect::new(
            prompt_area.x,
            prompt_area.y.saturating_sub(height),
            width,
            height,
        );
        frame.render_widget(Clear, picker_area);
        frame.render_widget(
            Paragraph::new(lines).style(Style::new().fg(palette.foreground).bg(palette.background)),
            picker_area,
        );
        self.media_slots
            .retain(|slot| !rectangles_intersect(slot.area, picker_area));
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
                        .borders(Borders::LEFT)
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
            help_line("@  ·  ctrl+o", "target/file completion  ·  files", palette),
            help_line("escape", "browse without losing the draft", palette),
            help_line("up/down  ·  ctrl+p/n", "command history", palette),
            help_line("page up / page down", "scroll the transcript", palette),
            help_line("left/right  ·  enter", "choose  ·  open media", palette),
            help_line("alt+a/m/v", "actions  ·  Markdown  ·  Vim", palette),
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

    fn shell_prompt(&self, environment: &CapabilityEnvironment) -> Vec<Span<'static>> {
        let palette = self.theme.palette();
        let target = prompt_token(&environment.target, "gsv");
        let mut prompt = vec![
            Span::styled(self.principal.clone(), Style::new().fg(palette.principal)),
            Span::styled("@", Style::new().fg(palette.accent)),
            Span::styled(
                target,
                Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
            ),
        ];
        if let Some(cwd) = environment
            .cwd
            .as_deref()
            .filter(|cwd| !cwd.trim().is_empty())
        {
            prompt.extend([
                Span::raw(" "),
                Span::styled(sanitize_label(cwd, "~", 80), Style::new().fg(palette.path)),
            ]);
        }
        prompt.extend([
            Span::raw(" "),
            Span::styled(
                "$",
                Style::new()
                    .fg(palette.foreground)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" "),
        ]);
        prompt
    }

    fn input_prompt(
        &self,
        environment: &CapabilityEnvironment,
        execution: ExecutionMode,
    ) -> Vec<Span<'static>> {
        let mut prompt = self.shell_prompt(environment);
        if execution == ExecutionMode::Shell {
            let palette = self.theme.palette();
            prompt.extend([
                Span::styled(
                    "!",
                    Style::new()
                        .fg(palette.foreground)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" "),
            ]);
        }
        prompt
    }
}

fn media_kind_from_content_type(content_type: &str) -> MediaKind {
    if content_type.starts_with("image/") {
        MediaKind::Image
    } else if content_type.starts_with("audio/") {
        MediaKind::Audio
    } else if content_type.starts_with("video/") {
        MediaKind::Video
    } else {
        MediaKind::Document
    }
}

fn reference_token(reference: &FileReference) -> String {
    format!("@{}", sanitize_label(&reference.filename, "file", 200))
}

fn file_reference_from_artifact(artifact: &Artifact) -> Option<FileReference> {
    let (target, path) = artifact.source.as_deref()?.split_once(':')?;
    let revision = artifact.revision.as_deref()?;
    let size = artifact.size?;
    if target.is_empty() || path.is_empty() || revision.is_empty() {
        return None;
    }
    Some(FileReference {
        target: target.to_string(),
        path: path.to_string(),
        revision: revision.to_string(),
        content_type: artifact.mime_type.clone(),
        size,
        filename: artifact.display_name().to_string(),
    })
}

fn draft_references_from_artifacts(text: &str, artifacts: &[Artifact]) -> Vec<DraftReference> {
    let mut references = Vec::new();
    for artifact in artifacts {
        let Some(reference) = file_reference_from_artifact(artifact) else {
            continue;
        };
        let token = reference_token(&reference);
        let occurrence = text.match_indices(&token).find(|(start, _)| {
            let end = start.saturating_add(token.len());
            references
                .iter()
                .all(|existing: &DraftReference| existing.end <= *start || existing.start >= end)
        });
        if let Some((start, _)) = occurrence {
            references.push(DraftReference {
                start,
                end: start.saturating_add(token.len()),
                reference,
            });
        }
    }
    references.sort_by_key(|reference| reference.start);
    references
}

fn inline_artifact_occurrences(text: &str, artifacts: &[Artifact]) -> Vec<Option<(usize, usize)>> {
    let mut occupied = Vec::<(usize, usize)>::new();
    artifacts
        .iter()
        .map(|artifact| {
            let reference = file_reference_from_artifact(artifact)?;
            let token = reference_token(&reference);
            let (start, _) = text.match_indices(&token).find(|(start, _)| {
                let end = start.saturating_add(token.len());
                occupied
                    .iter()
                    .all(|(left, right)| *right <= *start || *left >= end)
            })?;
            let occurrence = (start, start.saturating_add(token.len()));
            occupied.push(occurrence);
            Some(occurrence)
        })
        .collect()
}

fn unix_parent(path: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    if path.is_empty() || path == "~" {
        return None;
    }
    if path == "/" {
        return None;
    }
    let separator = path.rfind('/')?;
    if separator == 0 {
        Some("/".to_string())
    } else if separator == 1 && path.starts_with('~') {
        Some("~".to_string())
    } else {
        Some(path[..separator].to_string())
    }
}

fn rectangles_intersect(left: Rect, right: Rect) -> bool {
    left.x < right.right()
        && left.right() > right.x
        && left.y < right.bottom()
        && left.bottom() > right.y
}

fn atomic_media_scroll(
    current: u16,
    desired: u16,
    direction: ScrollDirection,
    viewport_height: u16,
    max_scroll: u16,
    image_ranges: &[ImageRange],
) -> u16 {
    let viewport_height = viewport_height.max(1);
    let current = current.min(max_scroll);
    let desired = desired.min(max_scroll);
    let visible = match direction {
        ScrollDirection::Older => image_ranges
            .iter()
            .rev()
            .find(|range| image_intersects(**range, current, viewport_height)),
        ScrollDirection::Newer => image_ranges
            .iter()
            .find(|range| image_intersects(**range, current, viewport_height)),
    }
    .copied();

    let target = if let Some(range) = visible {
        let partial = image_is_partial(range, current, viewport_height);
        match direction {
            ScrollDirection::Older if partial && range.top < current => range.top,
            ScrollDirection::Older => range.top.saturating_sub(viewport_height),
            ScrollDirection::Newer
                if partial && range.bottom > current.saturating_add(viewport_height) =>
            {
                range.bottom.saturating_sub(viewport_height)
            }
            ScrollDirection::Newer => range.bottom,
        }
    } else {
        let crossed = match direction {
            ScrollDirection::Older => image_ranges
                .iter()
                .rev()
                .find(|range| range.bottom <= current && range.bottom > desired),
            ScrollDirection::Newer => {
                let current_bottom = current.saturating_add(viewport_height);
                let desired_bottom = desired.saturating_add(viewport_height);
                image_ranges
                    .iter()
                    .find(|range| range.top >= current_bottom && range.top < desired_bottom)
            }
        }
        .copied();
        match (direction, crossed) {
            (ScrollDirection::Older, Some(range)) => range.top,
            (ScrollDirection::Newer, Some(range)) => range.bottom.saturating_sub(viewport_height),
            (_, None) => desired,
        }
    };

    snap_partial_media_scroll(
        target.min(max_scroll),
        direction,
        viewport_height,
        max_scroll,
        image_ranges,
    )
}

fn snap_partial_media_scroll(
    desired: u16,
    direction: ScrollDirection,
    viewport_height: u16,
    max_scroll: u16,
    image_ranges: &[ImageRange],
) -> u16 {
    let viewport_height = viewport_height.max(1);
    let mut snapped = desired.min(max_scroll);
    for _ in 0..image_ranges.len().saturating_mul(2).saturating_add(1) {
        let partial = match direction {
            ScrollDirection::Older => image_ranges
                .iter()
                .rev()
                .find(|range| image_is_partial(**range, snapped, viewport_height)),
            ScrollDirection::Newer => image_ranges
                .iter()
                .find(|range| image_is_partial(**range, snapped, viewport_height)),
        }
        .copied();
        let Some(range) = partial else {
            break;
        };
        let next = match direction {
            ScrollDirection::Older if snapped > range.top => range.top,
            ScrollDirection::Older => range.top.saturating_sub(viewport_height),
            ScrollDirection::Newer if snapped < range.top => {
                range.bottom.saturating_sub(viewport_height)
            }
            ScrollDirection::Newer => range.bottom,
        }
        .min(max_scroll);
        if next == snapped {
            break;
        }
        snapped = next;
    }
    snapped
}

fn image_intersects(range: ImageRange, scroll: u16, viewport_height: u16) -> bool {
    range.top < scroll.saturating_add(viewport_height) && range.bottom > scroll
}

fn image_is_partial(range: ImageRange, scroll: u16, viewport_height: u16) -> bool {
    image_intersects(range, scroll, viewport_height)
        && !(range.top >= scroll && range.bottom <= scroll.saturating_add(viewport_height))
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

#[derive(Clone, Copy)]
struct TextStyleRange {
    start: usize,
    end: usize,
    style: Style,
}

fn prompted_text_lines(
    prompt: Vec<Span<'static>>,
    value: &str,
    width: u16,
    text_style: Style,
    style_ranges: &[TextStyleRange],
    cursor: Option<usize>,
) -> PromptedText {
    let width = width.max(1);
    let prompt = fit_prompt(prompt, width);
    let prompt_width = prompt
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum::<usize>();
    let prompt_width = u16::try_from(prompt_width)
        .unwrap_or(width)
        .min(width.saturating_sub(1));
    // Only the first physical line owns the shell prompt. Subsequent explicit or soft-wrapped
    // lines continue at the terminal's left edge, exactly as one long terminal input stream.
    let continuation_width = 0;
    let mut text_lines = vec![Vec::<Span<'static>>::new()];
    let mut row = 0_u16;
    let mut col = prompt_width;
    let mut cursor_position = None;

    for (index, grapheme) in value.grapheme_indices(true) {
        let grapheme_width = u16::try_from(UnicodeWidthStr::width(grapheme))
            .unwrap_or(1)
            .max(1);
        if grapheme != "\n" && col.saturating_add(grapheme_width) > width {
            text_lines.push(Vec::new());
            row = row.saturating_add(1);
            col = continuation_width;
        }
        if cursor == Some(index) {
            cursor_position = Some((row, col));
        }
        if grapheme == "\n" {
            text_lines.push(Vec::new());
            row = row.saturating_add(1);
            col = continuation_width;
            continue;
        }
        if let Some(line) = text_lines.last_mut() {
            let style = style_ranges
                .iter()
                .find(|range| index >= range.start && index < range.end)
                .map_or(text_style, |range| range.style);
            if let Some(last) = line.last_mut().filter(|span| span.style == style) {
                last.content.to_mut().push_str(grapheme);
            } else {
                line.push(Span::styled(grapheme.to_string(), style));
            }
        }
        col = col.saturating_add(grapheme_width);
        if col >= width {
            text_lines.push(Vec::new());
            row = row.saturating_add(1);
            col = continuation_width;
        }
    }
    if cursor == Some(value.len()) || cursor.is_none() {
        cursor_position.get_or_insert((row, col));
    }
    if text_lines.len() > 1
        && text_lines.last().is_some_and(Vec::is_empty)
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
            let mut spans = Vec::with_capacity(prompt.len().saturating_add(text.len()));
            if index == 0 {
                spans.extend(prompt.clone());
            }
            spans.extend(text);
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

fn fit_prompt(prompt: Vec<Span<'static>>, width: u16) -> Vec<Span<'static>> {
    let max_width = width.saturating_sub(1);
    let prompt_width = prompt
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum::<usize>();
    if prompt_width <= usize::from(max_width) {
        return prompt;
    }
    if max_width == 0 {
        return Vec::new();
    }

    let suffix = if max_width > 1 { "… " } else { "…" };
    let suffix_width = u16::try_from(UnicodeWidthStr::width(suffix)).unwrap_or(max_width);
    let mut remaining = usize::from(max_width.saturating_sub(suffix_width));
    let mut compact = Vec::new();
    let mut suffix_style = prompt.first().map(|span| span.style).unwrap_or_default();
    let mut fitted = false;
    for span in prompt {
        let mut content = String::new();
        for grapheme in span.content.graphemes(true) {
            let grapheme_width = UnicodeWidthStr::width(grapheme);
            if grapheme_width > remaining {
                suffix_style = span.style;
                fitted = true;
                break;
            }
            content.push_str(grapheme);
            remaining = remaining.saturating_sub(grapheme_width);
            suffix_style = span.style;
            if remaining == 0 {
                fitted = true;
                break;
            }
        }
        if !content.is_empty() {
            compact.push(Span::styled(content, span.style));
        }
        if fitted {
            break;
        }
    }
    compact.push(Span::styled(suffix, suffix_style));
    compact
}

fn render_approval_lines(approval: &Approval, palette: Palette) -> Vec<Line<'static>> {
    let mut lines = vec![
        Line::default(),
        Line::from(Span::styled(
            "approval required",
            Style::new()
                .fg(palette.warning)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(vec![
            Span::styled(
                approval.syscall.clone(),
                Style::new().fg(palette.foreground),
            ),
            Span::styled("  on  ", Style::new().fg(palette.quiet)),
            Span::styled(approval.target.clone(), Style::new().fg(palette.accent)),
        ]),
        Line::default(),
    ];
    lines.extend(approval.preview.split('\n').map(|line| {
        Line::from(Span::styled(
            line.to_string(),
            Style::new().fg(palette.muted),
        ))
    }));
    lines.extend([
        Line::default(),
        Line::from(Span::styled(
            "o allow once   a always allow   d deny",
            Style::new().fg(palette.muted),
        )),
    ]);
    lines
}

fn help_line(key: &'static str, meaning: &'static str, palette: Palette) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{key:<22}"), Style::new().fg(palette.accent)),
        Span::styled(meaning, Style::new().fg(palette.muted)),
    ])
}

fn agent_action_label(name: &str, syscall: &str) -> String {
    let label = if name.trim().is_empty() {
        syscall
    } else {
        name
    };
    sanitize_label(label, "action", 64).to_lowercase()
}

fn agent_action_state(value: &str) -> AgentActionState {
    match value {
        "completed" | "ok" => AgentActionState::Completed,
        "cancelled" | "aborted" => AgentActionState::Cancelled,
        "denied" => AgentActionState::Denied,
        "running" => AgentActionState::Running,
        "failed" | "error" => AgentActionState::Failed,
        _ => AgentActionState::Failed,
    }
}

fn agent_action_status(action: &AgentAction) -> String {
    action.target.as_ref().map_or_else(
        || action.label.clone(),
        |target| format!("{} · {target}", action.label),
    )
}

fn action_timeline_order(left: &AgentAction, right: &AgentAction) -> Ordering {
    match (left.started_at, right.started_at) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn activity_cursor(palette: Palette, phase: bool) -> Span<'static> {
    Span::styled(
        if phase { "▌" } else { " " },
        Style::new().fg(palette.accent),
    )
}

fn activity_line(activity: Option<&str>, palette: Palette, phase: bool) -> Line<'static> {
    let label = sanitize_status(activity.unwrap_or("working")).to_lowercase();
    Line::from(vec![
        Span::raw("  "),
        activity_cursor(palette, phase),
        Span::styled(format!(" {label}"), Style::new().fg(palette.quiet)),
    ])
}

fn append_activity_cursor(lines: &mut Vec<Line<'static>>, palette: Palette, phase: bool) {
    if lines.is_empty() {
        lines.push(Line::default());
    }
    if let Some(line) = lines.last_mut() {
        line.spans.push(activity_cursor(palette, phase));
    }
}

fn render_agent_action_summary(
    run: &RunActions,
    palette: Palette,
    activity_phase: bool,
) -> Vec<Line<'static>> {
    let running = run
        .actions
        .iter()
        .any(|action| action.state == AgentActionState::Running);
    let failed = run.actions.iter().any(|action| {
        matches!(
            action.state,
            AgentActionState::Failed | AgentActionState::Denied
        )
    });
    let glyph = if running {
        if activity_phase {
            "▌"
        } else {
            " "
        }
    } else if failed {
        "×"
    } else {
        "↳"
    };
    let glyph_color = if failed {
        palette.error
    } else if running {
        palette.accent
    } else {
        palette.quiet
    };
    let count = run.omitted.saturating_add(run.actions.len());
    let suffix = if count == 1 { "" } else { "s" };
    vec![Line::from(vec![
        Span::raw("  "),
        Span::styled(glyph, Style::new().fg(glyph_color)),
        Span::styled(
            format!(" {count} action{suffix}"),
            Style::new().fg(palette.quiet),
        ),
    ])]
}

fn render_agent_action_segment(
    actions: &[AgentAction],
    hidden: usize,
    palette: Palette,
    activity_phase: bool,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if hidden > 0 {
        lines.push(Line::from(Span::styled(
            format!("    … {hidden} earlier"),
            Style::new().fg(palette.quiet),
        )));
    }
    for action in actions {
        let (glyph, color) = match action.state {
            AgentActionState::Running => (if activity_phase { "▌" } else { " " }, palette.accent),
            AgentActionState::Completed => ("✓", palette.principal),
            AgentActionState::Failed => ("×", palette.error),
            AgentActionState::Cancelled => ("–", palette.quiet),
            AgentActionState::Denied => ("!", palette.warning),
        };
        let mut spans = vec![
            Span::raw("  "),
            Span::styled(glyph, Style::new().fg(color)),
            Span::styled(
                format!(" {}", action.label),
                Style::new().fg(palette.foreground),
            ),
        ];
        if let Some(target) = &action.target {
            spans.extend([
                Span::styled(" · ", Style::new().fg(palette.quiet)),
                Span::styled(target.clone(), Style::new().fg(palette.accent)),
            ]);
        }
        lines.push(Line::from(spans));
    }
    lines
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
    use ratatui::style::Modifier;
    use ratatui::Terminal;

    use super::{
        atomic_media_scroll, image_is_partial, sanitize_status, text_metrics, Action,
        AgentActionSnapshot, App, Approval, Artifact, CapabilityEnvironment, ConnectionState,
        Effect, ExecutionMode, FileEntry, FileReference, ImageRange, MediaKind,
        MessageDeliverySnapshot, Moment, MomentState, Role, ScrollDirection, Theme,
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

    fn file_reference(filename: &str) -> FileReference {
        FileReference {
            target: "macbook".to_string(),
            path: format!("/Users/sam/Downloads/{filename}"),
            revision: format!("mtime:{filename}"),
            content_type: "text/markdown".to_string(),
            size: 512,
            filename: filename.to_string(),
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
                references: Vec::new(),
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
    fn run_activity_uses_a_blinking_block_instead_of_an_ellipsis(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("do it".to_string()));
        app.dispatch(Action::Submit);
        let backend = TestBackend::new(80, 16);
        let mut terminal = Terminal::new(backend)?;

        terminal.draw(|frame| app.render_with_animation(frame, true))?;
        let lit = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(lit.contains("▌ sending"));
        assert!(!lit.contains('⋯'));

        terminal.draw(|frame| app.render_with_animation(frame, false))?;
        let dim = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(!dim.contains('▌'));
        assert!(dim.contains("sending"));
        Ok(())
    }

    #[test]
    fn streamed_text_keeps_the_block_cursor_until_the_run_finishes(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.start_message_stream("run:one", "draft:one");
        app.append_message_delta(Some("run:one"), "draft:one", "working live");
        let backend = TestBackend::new(80, 16);
        let mut terminal = Terminal::new(backend)?;

        terminal.draw(|frame| app.render_with_animation(frame, true))?;
        let streaming = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(streaming.contains("working live▌"));

        app.finish_run(Some("run:one"), None);
        terminal.draw(|frame| app.render_with_animation(frame, true))?;
        let complete = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(complete.contains("working live"));
        assert!(!complete.contains("working live▌"));
        Ok(())
    }

    #[test]
    fn live_actions_expand_then_collapse_into_their_run() -> Result<(), Box<dyn std::error::Error>>
    {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("inspect it".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(1, "run:one".to_string(), false);
        app.start_agent_action(
            "run:one",
            "execution:one",
            "Read",
            "fs.read",
            Some("macbook"),
        );
        app.start_agent_action(
            "run:one",
            "execution:one",
            "Read",
            "fs.read",
            Some("macbook"),
        );
        let backend = TestBackend::new(80, 18);
        let mut terminal = Terminal::new(backend)?;

        terminal.draw(|frame| app.render_with_animation(frame, true))?;
        let live = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(live.contains("▌ read · macbook"));
        assert!(!live.contains("thinking"));

        app.finish_agent_action("run:one", "execution:one", "completed");
        app.finish_run(Some("run:one"), None);
        terminal.draw(|frame| app.render(frame))?;
        let collapsed = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(collapsed.contains("↳ 1 action"));
        assert!(!collapsed.contains("read · macbook"));

        app.dispatch(Action::ToggleActions);
        terminal.draw(|frame| app.render(frame))?;
        let expanded = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(expanded.contains("✓ read · macbook"));
        Ok(())
    }

    #[test]
    fn expanded_actions_follow_message_delivery_order_after_recovery(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut command =
            Moment::complete("command", Role::Human, "do it").with_timeline(Some(1), Some(100));
        command.run_id = Some("run:one".to_string());
        let mut first = Moment::complete("message:one", Role::Intelligence, "first reply")
            .with_timeline(Some(2), Some(300));
        first.run_id = Some("run:one".to_string());
        let mut second = Moment::complete("message:two", Role::Intelligence, "second reply")
            .with_timeline(Some(3), Some(500));
        second.run_id = Some("run:one".to_string());
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![command, first, second]);
        for (execution_id, name, started_at) in [("read", "Read", 200), ("write", "Write", 400)] {
            app.restore_agent_action(AgentActionSnapshot {
                run_id: "run:one".to_string(),
                execution_id: execution_id.to_string(),
                name: name.to_string(),
                syscall: format!("fs.{}", name.to_ascii_lowercase()),
                target: Some("macbook".to_string()),
                status: "ok".to_string(),
                live: false,
                started_at: Some(started_at),
            });
        }
        app.restore_message_delivery(MessageDeliverySnapshot {
            run_id: "run:one".to_string(),
            message_id: "message:one".to_string(),
            started_at: 300,
        });
        app.dispatch(Action::ToggleActions);

        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .chunks(80)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let row = |needle: &str| {
            rendered
                .iter()
                .position(|line| line.contains(needle))
                .expect("timeline item")
        };
        assert!(row("read · macbook") < row("first reply"));
        assert!(row("first reply") < row("write · macbook"));
        assert!(row("write · macbook") < row("second reply"));
        Ok(())
    }

    #[test]
    fn approval_stays_inline_with_the_transcript() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![Moment::complete(
            "answer",
            Role::Intelligence,
            "still visible",
        )]);
        app.start_run("run:one");
        app.enter_approval_for(
            Some("run:one"),
            Approval {
                request_id: "approval:one".to_string(),
                syscall: "shell.exec".to_string(),
                target: "macbook".to_string(),
                preview: "rm draft.txt".to_string(),
            },
        );

        let backend = TestBackend::new(80, 20);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("still visible"));
        assert!(rendered.contains("approval required"));
        assert!(rendered.contains("rm draft.txt"));
        assert!(rendered.contains("type a request"));
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
            vec![ratatui::text::Span::raw("you@gsv $ ")],
            "abcdefghijkl",
            16,
            ratatui::style::Style::new(),
            &[],
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
    fn prompt_hierarchy_survives_terminal_and_curated_palettes(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for theme in [Theme::Terminal, Theme::Gsv] {
            let palette = theme.palette();
            let mut app = App::new(ConnectionState::Ready);
            app.set_theme(theme);
            app.set_principal("john");
            app.set_environments(vec![CapabilityEnvironment::gsv().with_cwd("~/src")]);
            app.dispatch(Action::Insert("hello".to_string()));
            let backend = TestBackend::new(40, 12);
            let mut terminal = Terminal::new(backend)?;
            terminal.draw(|frame| app.render(frame))?;
            let buffer = terminal.backend().buffer();
            let prompt_y = (0..12)
                .find(|y| {
                    (0..40)
                        .filter_map(|x| buffer.cell((x, *y)))
                        .map(|cell| cell.symbol())
                        .collect::<String>()
                        .contains("john@gsv ~/src $ hello")
                })
                .expect("prompt row");

            let principal = buffer.cell((0, prompt_y)).expect("principal cell");
            let at = buffer.cell((4, prompt_y)).expect("at cell");
            let target = buffer.cell((5, prompt_y)).expect("target cell");
            let path = buffer.cell((9, prompt_y)).expect("path cell");
            let shell = buffer.cell((15, prompt_y)).expect("shell marker cell");
            let command = buffer.cell((17, prompt_y)).expect("command cell");
            assert_eq!(principal.fg, palette.principal);
            assert_ne!(principal.fg, palette.muted);
            assert!(!principal.modifier.contains(Modifier::BOLD));
            assert_eq!(at.fg, palette.accent);
            assert!(!at.modifier.contains(Modifier::BOLD));
            assert_eq!(target.fg, palette.accent);
            assert!(target.modifier.contains(Modifier::BOLD));
            assert_eq!(path.fg, palette.path);
            assert_ne!(path.fg, palette.muted);
            assert_eq!(shell.fg, palette.foreground);
            assert!(shell.modifier.contains(Modifier::BOLD));
            assert_eq!(command.fg, palette.foreground);
            assert!(!command.modifier.contains(Modifier::BOLD));
            assert_eq!(command.bg, palette.background);
        }
        Ok(())
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
        assert!(!inline.last_image_ranges.iter().any(|range| {
            image_is_partial(*range, inline.document_scroll, inline.last_viewport_height)
        }));
        Ok(())
    }

    #[test]
    fn one_scroll_step_reveals_then_passes_an_image_as_a_whole() {
        let image = [ImageRange {
            top: 20,
            bottom: 28,
        }];

        assert_eq!(
            atomic_media_scroll(23, 20, ScrollDirection::Older, 12, 80, &image),
            20
        );
        assert_eq!(
            atomic_media_scroll(28, 25, ScrollDirection::Older, 12, 80, &image),
            20
        );
        assert_eq!(
            atomic_media_scroll(20, 17, ScrollDirection::Older, 12, 80, &image),
            8
        );
        assert_eq!(
            atomic_media_scroll(8, 11, ScrollDirection::Newer, 12, 80, &image),
            16
        );
        assert_eq!(
            atomic_media_scroll(14, 17, ScrollDirection::Newer, 12, 80, &image),
            16
        );
        assert_eq!(
            atomic_media_scroll(16, 19, ScrollDirection::Newer, 12, 80, &image),
            28
        );
    }

    #[test]
    fn transcript_uses_the_live_terminal_width() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_inline_images(true);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "A responsive image.",
        )
        .with_artifacts(vec![image_artifact(0)])]);

        let backend = TestBackend::new(140, 30);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let first_width = app.media_slots()[0].area.width;
        assert_eq!(first_width, 138);

        let backend = TestBackend::new(180, 30);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        assert_eq!(app.media_slots()[0].area.width, 178);
        assert!(app.media_slots()[0].area.width > first_width);
        Ok(())
    }

    #[test]
    fn focused_image_uses_one_accent_rail_without_a_card() -> Result<(), Box<dyn std::error::Error>>
    {
        let mut app = App::new(ConnectionState::Ready);
        app.set_theme(Theme::Terminal);
        app.set_inline_images(true);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "One image.",
        )
        .with_artifacts(vec![image_artifact(0)])]);
        let backend = TestBackend::new(60, 18);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;

        let content = app.media_slots()[0].area;
        let rail = terminal
            .backend()
            .buffer()
            .cell((content.x.saturating_sub(1), content.y))
            .expect("focus rail cell");
        assert_eq!(rail.symbol(), "│");
        assert_eq!(rail.fg, Theme::Terminal.palette().accent);
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(['╭', '╮', '╰', '╯']
            .into_iter()
            .all(|symbol| !rendered.contains(symbol)));
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
    fn target_completion_stays_on_the_live_prompt_and_preserves_the_transcript(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_principal("john");
        app.set_environments(vec![
            CapabilityEnvironment::gsv(),
            CapabilityEnvironment::new("macbook", "MacBook"),
        ]);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Intelligence,
            "top marker\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
        )]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let prompt_before = terminal
            .backend()
            .buffer()
            .content()
            .chunks(80)
            .position(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .contains("john@gsv $ type a request")
            })
            .expect("prompt row before completion");

        app.dispatch(Action::Insert("@".to_string()));
        terminal.draw(|frame| app.render(frame))?;
        let rows = terminal
            .backend()
            .buffer()
            .content()
            .chunks(80)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>();
        let prompt_after = rows
            .iter()
            .position(|row| row.contains("john@gsv $ @"))
            .expect("live completion prompt");

        assert_eq!(prompt_after, prompt_before);
        assert!(prompt_after > 12);
        assert!(rows.iter().any(|row| row.contains("top marker")));
        assert!(rows.iter().any(|row| row.contains("macbook")));
        Ok(())
    }

    #[test]
    fn file_completion_resolves_and_submits_revision_bound_references() {
        let mut app = App::new(ConnectionState::Ready);
        app.set_environments(vec![
            CapabilityEnvironment::gsv(),
            CapabilityEnvironment::new("macbook", "MacBook").with_cwd("/Users/sam/Downloads"),
        ]);
        app.dispatch(Action::Insert("@".to_string()));
        app.dispatch(Action::Insert("mac".to_string()));
        app.dispatch(Action::Submit);
        app.dispatch(Action::Insert("review ".to_string()));

        assert_eq!(
            app.dispatch(Action::Insert("@".to_string())),
            vec![Effect::BrowseFiles {
                request_id: 1,
                target: "macbook".to_string(),
                directory: "/Users/sam/Downloads".to_string(),
            }]
        );
        assert_eq!(app.draft(), "review ");
        app.file_listing_loaded(
            1,
            "/Users/sam/Downloads".to_string(),
            vec![
                FileEntry {
                    name: "projects".to_string(),
                    path: "/Users/sam/Downloads/projects".to_string(),
                    is_directory: true,
                },
                FileEntry {
                    name: "notes.md".to_string(),
                    path: "/Users/sam/Downloads/notes.md".to_string(),
                    is_directory: false,
                },
            ],
        );
        app.dispatch(Action::Insert("notes".to_string()));
        assert_eq!(
            app.dispatch(Action::Submit),
            vec![Effect::ResolveFile {
                request_id: 1,
                target: "macbook".to_string(),
                path: "/Users/sam/Downloads/notes.md".to_string(),
                filename: "notes.md".to_string(),
            }]
        );
        let reference = file_reference("notes.md");
        app.file_reference_resolved(1, reference.clone());
        assert_eq!(app.draft(), "review @notes.md");
        assert!(!app.completion_picker_visible());

        assert_eq!(
            app.dispatch(Action::Submit),
            vec![Effect::Submit {
                id: 1,
                text: "review @notes.md".to_string(),
                target: "macbook".to_string(),
                cwd: Some("/Users/sam/Downloads".to_string()),
                references: vec![reference.clone()],
            }]
        );
        assert_eq!(app.moments()[0].artifacts.len(), 1);
        app.submission_failed(1, "offline");
        assert_eq!(app.draft(), "review @notes.md");
        assert_eq!(app.draft_references.len(), 1);
        assert_eq!(app.draft_references[0].reference, reference);
    }

    #[test]
    fn file_references_are_independently_atomic_in_the_editor() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("compare ".to_string()));
        app.insert_file_reference(app.draft_cursor, file_reference("one.md"));
        app.dispatch(Action::Insert(" and ".to_string()));
        app.insert_file_reference(app.draft_cursor, file_reference("two.md"));
        assert_eq!(app.draft(), "compare @one.md and @two.md");
        assert_eq!(app.draft_references.len(), 2);

        app.dispatch(Action::MoveCursorLeft);
        assert_eq!(app.draft_cursor, "compare @one.md and ".len());
        app.dispatch(Action::MoveCursorRight);
        assert_eq!(app.draft_cursor, app.draft().len());
        app.dispatch(Action::Backspace);
        assert_eq!(app.draft(), "compare @one.md and ");
        assert_eq!(app.draft_references.len(), 1);
        assert_eq!(app.draft_references[0].reference.filename, "one.md");
    }

    #[test]
    fn at_sign_is_literal_in_shell_mode() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::ToggleShell);
        assert!(app.dispatch(Action::Insert("@".to_string())).is_empty());
        assert_eq!(app.draft(), "@");
        assert!(!app.completion_picker_visible());
    }

    #[test]
    fn human_file_references_render_inline_without_a_duplicate_artifact_row(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_theme(Theme::Terminal);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Human,
            "review @notes.md",
        )
        .with_artifacts(vec![file_reference("notes.md").artifact()])]);
        let backend = TestBackend::new(80, 20);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rows = terminal
            .backend()
            .buffer()
            .content()
            .chunks(80)
            .collect::<Vec<_>>();
        let rendered = rows
            .iter()
            .flat_map(|row| row.iter())
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert_eq!(rendered.matches("notes.md").count(), 1);
        let (row, column) = rows
            .iter()
            .enumerate()
            .find_map(|(row, cells)| {
                let text = cells.iter().map(|cell| cell.symbol()).collect::<String>();
                text.find("@notes.md").map(|column| (row, column))
            })
            .expect("inline reference");
        let cell = &rows[row][column];
        assert_eq!(cell.fg, Theme::Terminal.palette().path);
        assert!(cell.modifier.contains(Modifier::UNDERLINED));
        Ok(())
    }

    #[test]
    fn human_image_references_keep_the_token_and_render_the_image(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_inline_images(true);
        app.replace_history(vec![Moment::complete(
            "one",
            Role::Human,
            "what is @image-0.png?",
        )
        .with_artifacts(vec![image_artifact(0)])]);
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

        assert!(rendered.contains("@image-0.png"));
        assert_eq!(app.media_slots().len(), 1);
        assert_eq!(app.media_slots()[0].artifact, image_artifact(0));
        Ok(())
    }

    #[test]
    fn completion_overlay_withdraws_intersecting_native_image_layers(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.set_inline_images(true);
        app.set_environments(
            std::iter::once(CapabilityEnvironment::gsv())
                .chain(
                    (0..8).map(|index| {
                        CapabilityEnvironment::new(format!("machine-{index}"), "machine")
                    }),
                )
                .collect(),
        );
        app.replace_history(vec![Moment::complete("one", Role::Intelligence, "image")
            .with_artifacts(vec![image_artifact(0)])]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        assert_eq!(app.media_slots().len(), 1);

        app.dispatch(Action::Insert("@".to_string()));
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
                references: Vec::new(),
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

    #[test]
    fn reaching_the_top_requests_each_history_page_once() {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![
            Moment::complete("three", Role::Human, "three").with_timeline(Some(3), Some(30)),
            Moment::complete("four", Role::Intelligence, "four").with_timeline(Some(4), Some(40)),
        ]);
        app.set_history_has_more(true);
        app.follow_latest = false;
        app.document_scroll = 0;

        assert_eq!(
            app.dispatch(Action::ScrollUp),
            vec![Effect::LoadOlderHistory { before_sequence: 3 }]
        );
        assert!(app.dispatch(Action::ScrollUp).is_empty());
    }

    #[test]
    fn prepending_history_deduplicates_and_preserves_the_draft() {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![
            Moment::complete("three", Role::Human, "three").with_timeline(Some(3), Some(30)),
            Moment::complete("four", Role::Intelligence, "four").with_timeline(Some(4), Some(40)),
        ]);
        app.dispatch(Action::Insert("unfinished thought".to_string()));
        app.prepend_history(
            vec![
                Moment::complete("one", Role::Human, "one").with_timeline(Some(1), Some(10)),
                Moment::complete("two", Role::Intelligence, "two").with_timeline(Some(2), Some(20)),
                Moment::complete("three", Role::Human, "three").with_timeline(Some(3), Some(30)),
            ],
            false,
        );

        assert_eq!(
            app.moments()
                .iter()
                .map(|moment| moment.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three", "four"]
        );
        assert_eq!(app.draft(), "unfinished thought");
    }

    #[test]
    fn reconnect_restores_an_unconfirmed_request_until_history_confirms_it() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("do the thing".to_string()));
        app.dispatch(Action::Submit);

        app.connection_lost();
        assert_eq!(app.draft(), "do the thing");
        assert!(app
            .moments()
            .iter()
            .any(|moment| { moment.id == "local:gsv:1" && moment.state == MomentState::Error }));

        app.reconcile_history(
            vec![
                Moment::complete("canonical-user", Role::Human, "do the thing")
                    .with_timeline(Some(12), Some(120)),
            ],
            false,
        );

        assert!(app.draft().is_empty());
        assert_eq!(
            app.moments()
                .iter()
                .filter(|moment| moment.role == Role::Human)
                .count(),
            1
        );
        assert!(!app
            .moments()
            .iter()
            .any(|moment| moment.id == "local:gsv:1"));
    }
}
