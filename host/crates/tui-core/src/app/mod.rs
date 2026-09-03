//! The interaction state machine shared by the native and browser TUIs.

#[allow(unused_imports)]
use crate::prelude::*;

mod actions;
mod browse;
mod dispatch;
mod draft;
mod environments;
mod files;
mod history;
mod render;
mod runs;
mod search;
#[cfg(test)]
mod tests;

#[derive(Debug)]
pub struct App {
    moments: Vec<Moment>,
    selected: usize,
    document_scroll: u16,
    last_max_scroll: u16,
    last_viewport_height: u16,
    last_browse_ranges: Vec<BrowseRange>,
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
    command_search: Option<CommandSearch>,
    transcript_search: Option<TranscriptSearch>,
    reference_picker: Option<ReferencePicker>,
    last_transcript_query: String,
    next_file_request_id: u64,
    theme: Theme,
    raw_markdown: bool,
    vim_enabled: bool,
    execution_mode: ExecutionMode,
    inline_images: bool,
    media_expanded: bool,
    media_focus: Option<usize>,
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
            last_browse_ranges: Vec::new(),
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
            command_search: None,
            transcript_search: None,
            reference_picker: None,
            last_transcript_query: String::new(),
            next_file_request_id: 1,
            theme: Theme::Gsv,
            raw_markdown: false,
            vim_enabled: false,
            execution_mode: ExecutionMode::Ship,
            inline_images: false,
            media_expanded: false,
            media_focus: None,
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
        self.input_cursor_visible() || self.browse_cursor_visible()
    }

    fn input_cursor_visible(&self) -> bool {
        if self.approval.is_some() || self.help_visible || self.media_expanded {
            return false;
        }
        if self.environment_picker
            || self.file_picker.is_some()
            || self.command_search.is_some()
            || self.transcript_search.is_some()
            || self.reference_picker.is_some()
        {
            return true;
        }
        self.draft_visible
    }

    fn browse_cursor_visible(&self) -> bool {
        !self.input_cursor_visible()
            && self.approval.is_none()
            && !self.help_visible
            && !self.media_expanded
            && !self.moments.is_empty()
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
        self.environment_picker
            || self.file_picker.is_some()
            || self.command_search.is_some()
            || self.transcript_search.is_some()
            || self.reference_picker.is_some()
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
        if enabled {
            self.document_scroll = self.last_max_scroll;
            self.sync_browse_focus(ScrollDirection::Newer);
        }
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
}
