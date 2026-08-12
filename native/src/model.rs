use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use crate::content::{MediaAttachment, MediaKind};

const RETIRED_RUN_LIMIT: usize = 128;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ActivityCategory {
    Thinking,
    SearchingFiles,
    ReadingFiles,
    WritingFiles,
    EditingFiles,
    DeletingFiles,
    RunningCommands,
    RunningCode,
}

impl ActivityCategory {
    fn from_syscall(value: &str) -> Option<Self> {
        match value {
            "fs.search" => Some(Self::SearchingFiles),
            "fs.read" => Some(Self::ReadingFiles),
            "fs.write" => Some(Self::WritingFiles),
            "fs.edit" => Some(Self::EditingFiles),
            "fs.delete" => Some(Self::DeletingFiles),
            "shell.exec" => Some(Self::RunningCommands),
            "codemode.exec" => Some(Self::RunningCode),
            _ => None,
        }
    }

    fn from_tool_name(value: &str) -> Option<Self> {
        match value {
            "Search" => Some(Self::SearchingFiles),
            "Read" => Some(Self::ReadingFiles),
            "Write" => Some(Self::WritingFiles),
            "Edit" => Some(Self::EditingFiles),
            "Delete" => Some(Self::DeletingFiles),
            "Shell" => Some(Self::RunningCommands),
            "CodeMode" => Some(Self::RunningCode),
            _ => None,
        }
    }

    fn summary_index(self) -> Option<usize> {
        match self {
            Self::Thinking => None,
            Self::SearchingFiles => Some(0),
            Self::ReadingFiles => Some(1),
            Self::WritingFiles => Some(2),
            Self::EditingFiles => Some(3),
            Self::DeletingFiles => Some(4),
            Self::RunningCommands => Some(5),
            Self::RunningCode => Some(6),
        }
    }

    fn expected_unit(self) -> Option<ActivityUnit> {
        match self {
            Self::Thinking => None,
            Self::ReadingFiles => Some(ActivityUnit::Reads),
            Self::RunningCommands => Some(ActivityUnit::Commands),
            Self::RunningCode => Some(ActivityUnit::Runs),
            Self::SearchingFiles
            | Self::WritingFiles
            | Self::EditingFiles
            | Self::DeletingFiles => Some(ActivityUnit::Operations),
        }
    }
}

const SUMMARY_ACTIVITY_CATEGORIES: [ActivityCategory; 7] = [
    ActivityCategory::SearchingFiles,
    ActivityCategory::ReadingFiles,
    ActivityCategory::WritingFiles,
    ActivityCategory::EditingFiles,
    ActivityCategory::DeletingFiles,
    ActivityCategory::RunningCommands,
    ActivityCategory::RunningCode,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivityUnit {
    Operations,
    Reads,
    Commands,
    Runs,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivitySummaryEntry {
    pub category: ActivityCategory,
    pub count: u64,
    pub unit: ActivityUnit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveActivity {
    pub category: ActivityCategory,
    run_id: String,
    call_id: Option<String>,
    terminal_baseline: Option<String>,
}

#[derive(Debug)]
pub struct HistoryActivitySummary {
    moment_id: String,
    entries: Vec<ActivitySummaryEntry>,
}

#[derive(Debug)]
pub struct HistoryActivity {
    summaries: Vec<HistoryActivitySummary>,
    latest_call_states: HashMap<(String, String), HistoryCallState>,
    authoritative: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum HistoryCallState {
    Pending,
    Terminal { message_id: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MomentRole {
    User,
    Intelligence,
    System,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MomentState {
    Complete,
    Sending,
    Uncertain,
    Streaming,
    Error,
    Approval,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Moment {
    pub id: String,
    pub role: MomentRole,
    pub text: String,
    pub media: Vec<MediaAttachment>,
    pub run_id: Option<String>,
    pub state: MomentState,
}

impl Moment {
    pub fn new(id: impl Into<String>, role: MomentRole, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            role,
            text: text.into(),
            media: Vec::new(),
            run_id: None,
            state: MomentState::Complete,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingApproval {
    pub request_id: String,
    pub run_id: String,
    pub tool_name: String,
    pub syscall: String,
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionState {
    Connecting,
    Connected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SurfaceMode {
    Conversation,
    Terminal,
}

#[derive(Debug)]
pub struct Conversation {
    pub moments: Vec<Moment>,
    pub selected: usize,
    pub active_run_id: Option<String>,
    pub pending_approval: Option<PendingApproval>,
    pub connection: ConnectionState,
    pub activity: Option<String>,
    pub live_activity: Option<LiveActivity>,
    pub mode: SurfaceMode,
    next_transient_id: u64,
    user_occurrence_baselines: HashMap<String, usize>,
    retired_run_ids: VecDeque<String>,
    response_activity: HashMap<String, Vec<ActivitySummaryEntry>>,
    history_call_states: HashMap<(String, String), HistoryCallState>,
    stopping_run_id: Option<String>,
    follow_latest: bool,
}

impl Conversation {
    pub fn connecting() -> Self {
        Self {
            moments: Vec::new(),
            selected: 0,
            active_run_id: None,
            pending_approval: None,
            connection: ConnectionState::Connecting,
            activity: Some("CONNECTING".to_string()),
            live_activity: None,
            mode: SurfaceMode::Conversation,
            next_transient_id: 1,
            user_occurrence_baselines: HashMap::new(),
            retired_run_ids: VecDeque::new(),
            response_activity: HashMap::new(),
            history_call_states: HashMap::new(),
            stopping_run_id: None,
            follow_latest: true,
        }
    }

    pub fn demo() -> Self {
        let moments = vec![
            Moment::new(
                "demo-1",
                MomentRole::Intelligence,
                "Good evening. I finished organizing the research from your laptop and the studio machine. What would you like to think through next?",
            ),
            Moment::new(
                "demo-2",
                MomentRole::User,
                "Show me what changed in the launch plan.",
            ),
            Moment::new(
                "demo-3",
                MomentRole::Intelligence,
                "The plan is simpler now: invite twelve people, watch where the interface disappears, and delay every dashboard until someone actually asks for one.",
            ),
        ];
        Self {
            selected: moments.len().saturating_sub(1),
            moments,
            active_run_id: None,
            pending_approval: None,
            connection: ConnectionState::Connected,
            activity: None,
            live_activity: None,
            mode: SurfaceMode::Conversation,
            next_transient_id: 1,
            user_occurrence_baselines: HashMap::new(),
            retired_run_ids: VecDeque::new(),
            response_activity: HashMap::new(),
            history_call_states: HashMap::new(),
            stopping_run_id: None,
            follow_latest: true,
        }
    }

    pub fn current(&self) -> Option<&Moment> {
        self.moments.get(self.selected)
    }

    pub fn activity_summary_for(&self, moment: &Moment) -> &[ActivitySummaryEntry] {
        if moment.role != MomentRole::Intelligence {
            return &[];
        }
        self.response_activity
            .get(&moment.id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn set_live_activity(&mut self, mut activity: LiveActivity) -> bool {
        if self.active_run_id.as_deref() != Some(activity.run_id.as_str())
            || !self.accepts_run(Some(&activity.run_id))
        {
            return false;
        }
        let Some(call_id) = activity.call_id.as_ref() else {
            return false;
        };
        let key = (activity.run_id.clone(), call_id.clone());
        activity.terminal_baseline =
            self.history_call_states
                .get(&key)
                .and_then(|state| match state {
                    HistoryCallState::Pending => None,
                    HistoryCallState::Terminal { message_id } => Some(message_id.clone()),
                });
        self.live_activity = Some(activity);
        true
    }

    pub fn resume_thinking(&mut self, run_id: Option<&str>) -> bool {
        let Some(run_id) = run_id else {
            return false;
        };
        if self.active_run_id.as_deref() != Some(run_id) || !self.accepts_run(Some(run_id)) {
            return false;
        }
        self.live_activity = Some(LiveActivity {
            category: ActivityCategory::Thinking,
            run_id: run_id.to_string(),
            call_id: None,
            terminal_baseline: None,
        });
        self.activity = Some("THINKING".to_string());
        true
    }

    pub fn clear_live_activity(&mut self, run_id: Option<&str>) {
        if run_id.is_none() {
            self.reset_activity_correlation();
        }
        if run_id.is_none_or(|run_id| {
            self.live_activity
                .as_ref()
                .is_some_and(|activity| activity.run_id == run_id)
        }) {
            self.live_activity = None;
        }
    }

    pub fn reconcile_history_activity(&mut self, history: HistoryActivity) {
        let HistoryActivity {
            summaries,
            latest_call_states,
            authoritative,
        } = history;
        let completed_live_call = self.live_activity.as_ref().and_then(|activity| {
            let call_id = activity.call_id.as_ref()?;
            let HistoryCallState::Terminal { message_id } =
                latest_call_states.get(&(activity.run_id.clone(), call_id.clone()))?
            else {
                return None;
            };
            (activity.terminal_baseline.as_deref() != Some(message_id.as_str()))
                .then(|| activity.run_id.clone())
        });
        if let Some(run_id) = completed_live_call {
            if self.pending_approval.is_none() {
                self.resume_thinking(Some(&run_id));
            } else {
                self.clear_live_activity(Some(&run_id));
            }
        }

        let moment_ids = self
            .moments
            .iter()
            .filter(|moment| moment.role == MomentRole::Intelligence)
            .map(|moment| moment.id.as_str())
            .collect::<HashSet<_>>();
        if authoritative {
            self.history_call_states.clear();
            self.response_activity
                .retain(|moment_id, _| !moment_ids.contains(moment_id.as_str()));
        }
        self.history_call_states.extend(latest_call_states);
        for summary in summaries {
            if !moment_ids.contains(summary.moment_id.as_str()) {
                continue;
            }
            if summary.entries.is_empty() {
                self.response_activity.remove(&summary.moment_id);
            } else {
                self.response_activity
                    .insert(summary.moment_id, summary.entries);
            }
        }
        self.prune_response_activity();
    }

    pub fn select(&mut self, index: usize) {
        if !self.moments.is_empty() {
            self.selected = index.min(self.moments.len() - 1);
            self.follow_latest = self.selected + 1 == self.moments.len();
        }
    }

    pub fn select_previous(&mut self) {
        self.selected = self.selected.saturating_sub(1);
        self.follow_latest = self.selected + 1 == self.moments.len();
    }

    pub fn select_next(&mut self) {
        if !self.moments.is_empty() {
            self.selected = (self.selected + 1).min(self.moments.len() - 1);
            self.follow_latest = self.selected + 1 == self.moments.len();
        }
    }

    pub fn select_latest(&mut self) {
        self.selected = self.moments.len().saturating_sub(1);
        self.follow_latest = true;
    }

    pub fn replace_history(&mut self, moments: Vec<Moment>) {
        let prior_response_activity = self
            .moments
            .iter()
            .filter_map(|moment| {
                self.response_activity
                    .get(&moment.id)
                    .cloned()
                    .map(|summary| (moment.id.clone(), moment.run_id.clone(), summary))
            })
            .collect::<Vec<_>>();
        let selected_id = (!self.follow_latest)
            .then(|| self.current().map(|moment| moment.id.clone()))
            .flatten();
        let local_user_moments = self
            .moments
            .iter()
            .filter(|moment| {
                moment.role == MomentRole::User && moment.id.starts_with("user:transient:")
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut history_user_occurrences = HashMap::new();
        for moment in &moments {
            if moment.role == MomentRole::User {
                *history_user_occurrences
                    .entry(moment.text.clone())
                    .or_insert(0) += 1;
            }
        }
        self.moments = moments;
        for local in local_user_moments {
            let represented_by_run = local.run_id.as_deref().is_some_and(|run_id| {
                self.moments.iter().any(|moment| {
                    moment.role == MomentRole::User && moment.run_id.as_deref() == Some(run_id)
                })
            });
            let represented_by_occurrence = local.state == MomentState::Uncertain
                && self
                    .user_occurrence_baselines
                    .get(&local.id)
                    .is_some_and(|baseline| {
                        history_user_occurrences
                            .get(&local.text)
                            .copied()
                            .unwrap_or_default()
                            > *baseline
                    });
            if represented_by_run || represented_by_occurrence {
                self.user_occurrence_baselines.remove(&local.id);
            } else {
                self.moments.push(local);
            }
        }
        let selected_index = selected_id.and_then(|selected_id| {
            self.moments
                .iter()
                .position(|moment| moment.id == selected_id)
        });
        if let Some(index) = selected_index {
            self.selected = index;
            self.follow_latest = false;
        } else {
            self.select_latest();
        }
        self.response_activity.clear();
        for (moment_id, run_id, summary) in prior_response_activity {
            let owner_id = self
                .moments
                .iter()
                .find(|moment| moment.role == MomentRole::Intelligence && moment.id == moment_id)
                .or_else(|| {
                    run_id.as_deref().and_then(|run_id| {
                        self.moments.iter().rev().find(|moment| {
                            moment.role == MomentRole::Intelligence
                                && moment.run_id.as_deref() == Some(run_id)
                        })
                    })
                })
                .map(|moment| moment.id.clone());
            if let Some(owner_id) = owner_id {
                self.response_activity.insert(owner_id, summary);
            }
        }
        self.prune_response_activity();
    }

    pub fn append_user(&mut self, text: impl Into<String>) -> String {
        let text = text.into();
        let occurrence_baseline = self
            .moments
            .iter()
            .filter(|moment| {
                moment.role == MomentRole::User
                    && moment.state != MomentState::Error
                    && moment.text == text
            })
            .count();
        let id = self.transient_id("user");
        let mut moment = Moment::new(id.clone(), MomentRole::User, text);
        moment.state = MomentState::Sending;
        self.moments.push(moment);
        self.user_occurrence_baselines
            .insert(id.clone(), occurrence_baseline);
        self.select_latest();
        id
    }

    pub fn accept_user(&mut self, moment_id: &str, run_id: &str) {
        if let Some(moment) = self
            .moments
            .iter_mut()
            .find(|moment| moment.id == moment_id && moment.state == MomentState::Sending)
        {
            moment.state = MomentState::Complete;
            moment.run_id = Some(run_id.to_string());
            self.user_occurrence_baselines.remove(moment_id);
        }
    }

    pub fn mark_user_uncertain(&mut self, moment_id: &str) {
        if let Some(moment) = self
            .moments
            .iter_mut()
            .find(|moment| moment.id == moment_id && moment.state == MomentState::Sending)
        {
            moment.state = MomentState::Uncertain;
        }
    }

    pub fn remove_moment(&mut self, moment_id: &str) {
        let selected_id = self.current().map(|moment| moment.id.clone());
        self.moments.retain(|moment| moment.id != moment_id);
        self.user_occurrence_baselines.remove(moment_id);
        if self.moments.is_empty() {
            self.selected = 0;
            self.follow_latest = true;
            self.response_activity.clear();
            return;
        }
        let selected_index = selected_id.and_then(|selected_id| {
            self.moments
                .iter()
                .position(|moment| moment.id == selected_id)
        });
        if let Some(index) = selected_index {
            self.selected = index;
        } else {
            self.selected = self.selected.min(self.moments.len() - 1);
        }
        self.prune_response_activity();
    }

    pub fn fail_user(&mut self, moment_id: &str) {
        if let Some(moment) = self
            .moments
            .iter_mut()
            .find(|moment| moment.id == moment_id)
        {
            moment.state = MomentState::Error;
            self.user_occurrence_baselines.remove(moment_id);
        }
    }

    pub fn start_run(&mut self, run_id: impl Into<String>) {
        let run_id = run_id.into();
        if self.is_retired(&run_id) {
            return;
        }
        if self.stopping_run_id.as_deref() == Some(run_id.as_str()) {
            return;
        }

        let same_run = self.active_run_id.as_deref() == Some(run_id.as_str());
        if same_run {
            if let Some(moment) = self.moments.iter().find(|moment| {
                moment.state == MomentState::Streaming
                    && moment.run_id.as_deref() == Some(run_id.as_str())
            }) {
                if moment.text.trim().is_empty() && moment.media.is_empty() {
                    self.activity = Some("THINKING".to_string());
                    if self.live_activity.is_none() {
                        self.live_activity = Some(LiveActivity {
                            category: ActivityCategory::Thinking,
                            run_id: run_id.clone(),
                            call_id: None,
                            terminal_baseline: None,
                        });
                    }
                }
                return;
            }
        } else if let Some(previous_run_id) = self.active_run_id.take() {
            self.complete_streaming_moment(&previous_run_id, true);
            self.retire_run(previous_run_id);
            self.stopping_run_id = None;
        }

        if same_run {
            if self.live_activity.is_none() {
                self.live_activity = Some(LiveActivity {
                    category: ActivityCategory::Thinking,
                    run_id: run_id.clone(),
                    call_id: None,
                    terminal_baseline: None,
                });
            }
        } else {
            self.reset_activity_correlation();
            self.live_activity = Some(LiveActivity {
                category: ActivityCategory::Thinking,
                run_id: run_id.clone(),
                call_id: None,
                terminal_baseline: None,
            });
            self.active_run_id = Some(run_id.clone());
        }
        self.activity = Some("THINKING".to_string());

        if self.moments.iter().any(|moment| {
            moment.state == MomentState::Streaming
                && moment.run_id.as_deref() == Some(run_id.as_str())
        }) {
            return;
        }

        let id = self.transient_id("assistant");
        let was_following = self.follow_latest || self.moments.is_empty();
        self.moments.push(Moment {
            id,
            role: MomentRole::Intelligence,
            text: String::new(),
            media: Vec::new(),
            run_id: Some(run_id),
            state: MomentState::Streaming,
        });
        if was_following {
            self.selected = self.moments.len().saturating_sub(2);
            self.follow_latest = true;
        }
    }

    pub fn stream_text(&mut self, run_id: Option<&str>, delta: &str) {
        if delta.is_empty() || !self.accepts_run(run_id) {
            return;
        }

        if self.active_run_id.is_none() {
            if let Some(run_id) = run_id {
                self.start_run(run_id);
            }
        }
        let effective_run_id = run_id
            .map(str::to_string)
            .or_else(|| self.active_run_id.clone());

        let was_following = self.follow_latest || self.moments.is_empty();
        let matching = self.moments.iter_mut().rev().find(|moment| {
            moment.state == MomentState::Streaming
                && effective_run_id
                    .as_deref()
                    .is_none_or(|run_id| moment.run_id.as_deref() == Some(run_id))
        });

        if let Some(moment) = matching {
            moment.text.push_str(delta);
        } else {
            let id = self.transient_id("assistant");
            self.moments.push(Moment {
                id,
                role: MomentRole::Intelligence,
                text: delta.to_string(),
                media: Vec::new(),
                run_id: effective_run_id.clone(),
                state: MomentState::Streaming,
            });
        }
        self.activity = None;
        self.clear_live_activity(effective_run_id.as_deref());
        self.follow_after_append(was_following);
    }

    pub fn replace_run_text(&mut self, run_id: Option<&str>, text: &str) {
        if !self.accepts_run(run_id) {
            return;
        }
        if self.active_run_id.is_none() {
            if let Some(run_id) = run_id {
                self.start_run(run_id);
            }
        }
        let effective_run_id = run_id
            .map(str::to_string)
            .or_else(|| self.active_run_id.clone());
        let was_following = self.follow_latest || self.moments.is_empty();
        let matching = self.moments.iter_mut().rev().find(|moment| {
            moment.state == MomentState::Streaming
                && effective_run_id
                    .as_deref()
                    .is_none_or(|run_id| moment.run_id.as_deref() == Some(run_id))
        });
        if let Some(moment) = matching {
            moment.text = text.to_string();
        } else if !text.is_empty() {
            let id = self.transient_id("assistant");
            self.moments.push(Moment {
                id,
                role: MomentRole::Intelligence,
                text: text.to_string(),
                media: Vec::new(),
                run_id: effective_run_id.clone(),
                state: MomentState::Streaming,
            });
        }
        self.activity = None;
        self.clear_live_activity(effective_run_id.as_deref());
        self.follow_after_append(was_following);
    }

    pub fn replace_run_media(&mut self, run_id: Option<&str>, media: Vec<MediaAttachment>) {
        if !self.accepts_run(run_id) {
            return;
        }
        if self.active_run_id.is_none() {
            if let Some(run_id) = run_id {
                self.start_run(run_id);
            }
        }
        let effective_run_id = run_id
            .map(str::to_string)
            .or_else(|| self.active_run_id.clone());
        let was_following = self.follow_latest || self.moments.is_empty();
        let matching = self.moments.iter_mut().rev().find(|moment| {
            moment.state == MomentState::Streaming
                && effective_run_id
                    .as_deref()
                    .is_none_or(|run_id| moment.run_id.as_deref() == Some(run_id))
        });
        if let Some(moment) = matching {
            moment.media = media;
        } else if !media.is_empty() {
            let id = self.transient_id("assistant");
            self.moments.push(Moment {
                id,
                role: MomentRole::Intelligence,
                text: String::new(),
                media,
                run_id: effective_run_id.clone(),
                state: MomentState::Streaming,
            });
        }
        self.activity = None;
        self.clear_live_activity(effective_run_id.as_deref());
        self.follow_after_append(was_following);
    }

    pub fn reconcile_active_run(&mut self, run_id: Option<&str>, live_text: Option<&str>) {
        let previous_run_id = self.active_run_id.clone();
        let preserve_stopping = run_id.is_some_and(|run_id| {
            previous_run_id.as_deref() == Some(run_id)
                && self.stopping_run_id.as_deref() == Some(run_id)
        });
        if previous_run_id.as_deref() != run_id {
            if let Some(previous_run_id) = previous_run_id {
                self.complete_streaming_moment(&previous_run_id, true);
                self.retire_run(previous_run_id);
            }
            self.active_run_id = None;
            self.stopping_run_id = None;
            self.live_activity = None;
            self.reset_activity_correlation();
        }
        if let Some(run_id) = run_id {
            self.retired_run_ids.retain(|retired| retired != run_id);
            self.stopping_run_id = None;
            self.start_run(run_id);
            if let Some(live_text) = live_text.filter(|text| !text.is_empty()) {
                self.replace_run_text(Some(run_id), live_text);
            }
            if preserve_stopping {
                self.stopping_run_id = Some(run_id.to_string());
                self.activity = Some("STOPPING".to_string());
            }
        } else {
            self.active_run_id = None;
            self.stopping_run_id = None;
            self.activity = None;
            self.live_activity = None;
            self.reset_activity_correlation();
        }
    }

    pub fn finish_run(&mut self, run_id: Option<&str>, error: Option<&str>) -> bool {
        let Some(active_run_id) = self.active_run_id.clone() else {
            return false;
        };
        if run_id.is_some_and(|run_id| run_id != active_run_id) {
            return false;
        }

        let matching_moment = self.moments.iter().rposition(|moment| {
            moment.state == MomentState::Streaming
                && moment.run_id.as_deref() == Some(active_run_id.as_str())
        });
        if let Some(index) = matching_moment {
            let moment = &mut self.moments[index];
            moment.state = if error.is_some() {
                MomentState::Error
            } else {
                MomentState::Complete
            };
            if moment.text.trim().is_empty() && moment.media.is_empty() {
                moment.text = error
                    .unwrap_or("The run ended without a response.")
                    .to_string();
            }
        } else if let Some(error) = error {
            let id = self.transient_id("error");
            self.moments.push(Moment {
                id,
                role: MomentRole::System,
                text: error.to_string(),
                media: Vec::new(),
                run_id: Some(active_run_id.clone()),
                state: MomentState::Error,
            });
        }

        self.retire_run(active_run_id);
        self.active_run_id = None;
        self.stopping_run_id = None;
        self.activity = None;
        self.live_activity = None;
        self.reset_activity_correlation();
        self.follow_if_requested();
        true
    }

    pub fn abort_run(&mut self, run_id: &str) -> bool {
        if self.active_run_id.as_deref() != Some(run_id) {
            return false;
        }
        self.active_run_id = None;
        self.complete_streaming_moment(run_id, true);
        self.retire_run(run_id.to_string());
        self.stopping_run_id = None;
        self.clear_approval();
        self.activity = None;
        self.live_activity = None;
        self.reset_activity_correlation();
        self.follow_if_requested();
        true
    }

    pub fn accepts_run(&self, run_id: Option<&str>) -> bool {
        let Some(run_id) = run_id.or(self.active_run_id.as_deref()) else {
            return false;
        };
        !self.is_retired(run_id)
            && self.stopping_run_id.as_deref() != Some(run_id)
            && self
                .active_run_id
                .as_deref()
                .is_none_or(|active_run_id| active_run_id == run_id)
    }

    pub fn request_abort(&mut self) -> Option<String> {
        let run_id = self.active_run_id.clone()?;
        self.stopping_run_id = Some(run_id.clone());
        self.activity = Some("STOPPING".to_string());
        self.live_activity = None;
        Some(run_id)
    }

    pub fn abort_failed(&mut self, run_id: &str) -> bool {
        if self.stopping_run_id.as_deref() != Some(run_id) {
            return false;
        }
        self.stopping_run_id = None;
        if self.active_run_id.is_some() {
            self.activity = Some("THINKING".to_string());
        }
        true
    }

    pub fn show_error(&mut self, message: impl Into<String>) {
        let id = self.transient_id("error");
        self.moments.push(Moment {
            id,
            role: MomentRole::System,
            text: message.into(),
            media: Vec::new(),
            run_id: None,
            state: MomentState::Error,
        });
        self.activity = None;
        self.select_latest();
    }

    pub fn set_approval(&mut self, approval: PendingApproval) -> bool {
        if !approval.run_id.is_empty() {
            if self.active_run_id.is_none() {
                self.start_run(approval.run_id.clone());
            }
            if !self.accepts_run(Some(&approval.run_id)) {
                return false;
            }
        }
        let text = approval_prompt(&approval);
        let id = format!("approval:{}", approval.request_id);
        if let Some(existing) = self.moments.iter_mut().find(|moment| moment.id == id) {
            existing.text = text;
        } else {
            self.moments.push(Moment {
                id,
                role: MomentRole::System,
                text,
                media: Vec::new(),
                run_id: Some(approval.run_id.clone()),
                state: MomentState::Approval,
            });
        }
        self.pending_approval = Some(approval);
        self.activity = Some("APPROVAL REQUIRED".to_string());
        self.live_activity = None;
        self.select_latest();
        true
    }

    pub fn clear_approval(&mut self) {
        let preserve_live_activity = self
            .pending_approval
            .as_ref()
            .zip(self.live_activity.as_ref())
            .is_some_and(|(approval, activity)| {
                activity.call_id.is_some()
                    && !approval.run_id.is_empty()
                    && approval.run_id == activity.run_id
                    && self.active_run_id.as_deref() == Some(activity.run_id.as_str())
            });
        self.pending_approval = None;
        self.moments
            .retain(|moment| moment.state != MomentState::Approval);
        self.activity = self.active_run_id.as_ref().map(|_| "THINKING".to_string());
        if !preserve_live_activity {
            self.live_activity = None;
        }
        self.select_latest();
    }

    fn transient_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}:transient:{}", self.next_transient_id);
        self.next_transient_id += 1;
        id
    }

    fn complete_streaming_moment(&mut self, run_id: &str, remove_empty: bool) {
        let Some(index) = self.moments.iter().rposition(|moment| {
            moment.state == MomentState::Streaming && moment.run_id.as_deref() == Some(run_id)
        }) else {
            return;
        };
        if remove_empty
            && self.moments[index].text.trim().is_empty()
            && self.moments[index].media.is_empty()
        {
            self.moments.remove(index);
            self.prune_response_activity();
        } else {
            self.moments[index].state = MomentState::Complete;
        }
    }

    fn is_retired(&self, run_id: &str) -> bool {
        self.retired_run_ids.iter().any(|retired| retired == run_id)
    }

    fn retire_run(&mut self, run_id: String) {
        if self.is_retired(&run_id) {
            return;
        }
        self.retired_run_ids.push_back(run_id);
        if self.retired_run_ids.len() > RETIRED_RUN_LIMIT {
            self.retired_run_ids.pop_front();
        }
    }

    fn prune_response_activity(&mut self) {
        let owners = self
            .moments
            .iter()
            .filter(|moment| moment.role == MomentRole::Intelligence)
            .map(|moment| moment.id.as_str())
            .collect::<HashSet<_>>();
        self.response_activity
            .retain(|owner, _| owners.contains(owner.as_str()));
    }

    fn reset_activity_correlation(&mut self) {
        self.history_call_states.clear();
    }

    fn follow_after_append(&mut self, was_following: bool) {
        if was_following {
            self.selected = self.moments.len().saturating_sub(1);
            self.follow_latest = true;
        }
    }

    fn follow_if_requested(&mut self) {
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
        } else if !self.moments.is_empty() {
            self.selected = self.selected.min(self.moments.len() - 1);
        } else {
            self.selected = 0;
            self.follow_latest = true;
        }
    }
}

pub fn parse_tool_started_activity(value: &Value) -> Option<LiveActivity> {
    let run_id = value.get("runId")?.as_str()?.trim();
    let call_id = value.get("callId")?.as_str()?.trim();
    let category = value
        .get("syscall")
        .and_then(Value::as_str)
        .and_then(ActivityCategory::from_syscall)?;
    if run_id.is_empty() || call_id.is_empty() {
        return None;
    }
    Some(LiveActivity {
        category,
        run_id: run_id.to_string(),
        call_id: Some(call_id.to_string()),
        terminal_baseline: None,
    })
}

fn derive_history_activity(payload: &Value) -> HistoryActivity {
    let Some(messages) = payload.get("messages").and_then(Value::as_array) else {
        return HistoryActivity {
            summaries: Vec::new(),
            latest_call_states: HashMap::new(),
            authoritative: false,
        };
    };
    let has_compaction_marker = messages.iter().any(history_is_compaction_marker);
    let authoritative = history_is_authoritative(payload, messages.len()) && !has_compaction_marker;
    let mut calls = HashMap::<(String, String), VecDeque<Option<ActivityCategory>>>::new();
    let mut latest_call_states = HashMap::<(String, String), HistoryCallState>::new();
    let mut run_boundaries = HashSet::<String>::new();
    let mut runs_with_call_context = HashSet::<String>::new();
    let mut incomplete_runs = HashSet::<String>::new();
    let mut pending_counts = HashMap::<String, [u64; SUMMARY_ACTIVITY_CATEGORIES.len()]>::new();
    let mut summaries = Vec::new();

    for (index, message) in messages.iter().enumerate() {
        let Some(run_id) = history_run_id(message) else {
            continue;
        };
        match message.get("role").and_then(Value::as_str) {
            Some("user") => {
                run_boundaries.insert(run_id.to_string());
            }
            Some("assistant") => {
                let tool_calls = history_tool_calls(message);
                if !tool_calls.is_empty() {
                    runs_with_call_context.insert(run_id.to_string());
                    for call in tool_calls {
                        let Some(call_id) = call
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|call_id| !call_id.is_empty())
                        else {
                            continue;
                        };
                        let category = call
                            .get("syscall")
                            .and_then(Value::as_str)
                            .and_then(ActivityCategory::from_syscall)
                            .or_else(|| {
                                call.get("name")
                                    .and_then(Value::as_str)
                                    .and_then(ActivityCategory::from_tool_name)
                            });
                        let key = (run_id.to_string(), call_id.to_string());
                        calls.entry(key.clone()).or_default().push_back(category);
                        latest_call_states.insert(key, HistoryCallState::Pending);
                    }
                    continue;
                }

                if incomplete_runs.contains(run_id) {
                    pending_counts.remove(run_id);
                    continue;
                }
                let entries = pending_counts
                    .remove(run_id)
                    .map(summary_entries)
                    .unwrap_or_default();
                if authoritative || !entries.is_empty() {
                    summaries.push(HistoryActivitySummary {
                        moment_id: history_moment_id(message, index),
                        entries,
                    });
                }
            }
            Some("toolResult") => {
                let Some(content) = message.get("content") else {
                    continue;
                };
                let call_id = content
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|call_id| !call_id.is_empty());
                let key = call_id.map(|call_id| (run_id.to_string(), call_id.to_string()));
                let correlated = key.as_ref().and_then(|key| {
                    calls
                        .get_mut(key)
                        .and_then(VecDeque::pop_front)
                        .map(|category| (key.clone(), category))
                });
                if let Some((key, _)) = &correlated {
                    if calls.get(key).is_none_or(VecDeque::is_empty) {
                        latest_call_states.insert(
                            key.clone(),
                            HistoryCallState::Terminal {
                                message_id: history_moment_id(message, index),
                            },
                        );
                    }
                }
                if !authoritative && !run_boundaries.contains(run_id) {
                    incomplete_runs.insert(run_id.to_string());
                    pending_counts.remove(run_id);
                    continue;
                }
                if content.get("outcome").and_then(Value::as_str) != Some("completed") {
                    continue;
                }
                let category = correlated.and_then(|(_, category)| category).or_else(|| {
                    (!runs_with_call_context.contains(run_id))
                        .then(|| {
                            content
                                .get("toolName")
                                .and_then(Value::as_str)
                                .and_then(ActivityCategory::from_tool_name)
                        })
                        .flatten()
                });
                let Some(index) = category.and_then(ActivityCategory::summary_index) else {
                    continue;
                };
                let counts = pending_counts.entry(run_id.to_string()).or_default();
                counts[index] = counts[index].saturating_add(1);
            }
            _ => {}
        }
    }

    HistoryActivity {
        summaries,
        latest_call_states,
        authoritative,
    }
}

fn history_is_authoritative(payload: &Value, visible_message_count: usize) -> bool {
    if payload.get("truncated").and_then(Value::as_bool) == Some(true) {
        return false;
    }

    let has_more_before = payload.get("hasMoreBefore").and_then(Value::as_bool);
    let has_more_after = payload.get("hasMoreAfter").and_then(Value::as_bool);
    if has_more_before == Some(true) || has_more_after == Some(true) {
        return false;
    }
    if has_more_before.is_some() || has_more_after.is_some() {
        return has_more_before == Some(false) && has_more_after == Some(false);
    }

    if payload.get("truncated").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    payload
        .get("messageCount")
        .and_then(Value::as_u64)
        .is_some_and(|count| count == visible_message_count as u64)
}

fn history_is_compaction_marker(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("system")
        && message
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|content| content.starts_with("Process history compacted."))
}

fn history_run_id(message: &Value) -> Option<&str> {
    message
        .get("runId")?
        .as_str()
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())
}

fn history_tool_calls(message: &Value) -> Vec<&Value> {
    let content = message.get("content").unwrap_or(&Value::Null);
    if let Some(tool_calls) = content.get("toolCalls").and_then(Value::as_array) {
        return tool_calls.iter().collect();
    }
    if let Some(tool_calls) = message.get("toolCalls").and_then(Value::as_array) {
        return tool_calls.iter().collect();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("toolCall"))
        .collect()
}

fn summary_entries(counts: [u64; SUMMARY_ACTIVITY_CATEGORIES.len()]) -> Vec<ActivitySummaryEntry> {
    SUMMARY_ACTIVITY_CATEGORIES
        .into_iter()
        .enumerate()
        .filter_map(|(index, category)| {
            let count = counts[index];
            let unit = category.expected_unit()?;
            (count > 0).then_some(ActivitySummaryEntry {
                category,
                count,
                unit,
            })
        })
        .collect()
}

pub fn parse_history_with_activity(payload: &Value) -> (Vec<Moment>, HistoryActivity) {
    let activity = derive_history_activity(payload);
    let summary_owners = activity
        .summaries
        .iter()
        .filter(|summary| !summary.entries.is_empty())
        .map(|summary| summary.moment_id.as_str())
        .collect::<HashSet<_>>();
    let moments = parse_history_moments(payload, &summary_owners);
    drop(summary_owners);
    (moments, activity)
}

pub fn approval_prompt(approval: &PendingApproval) -> String {
    let operation = if approval.tool_name.trim().is_empty() {
        approval.syscall.as_str()
    } else {
        approval.tool_name.as_str()
    };
    let detail = approval
        .detail
        .as_deref()
        .map(|detail| format!("\n\n{detail}"))
        .unwrap_or_default();
    format!(
        "GSV wants to use {operation}.{detail}\n\nType “allow once”, “always allow”, or “deny”."
    )
}

#[cfg(test)]
pub fn parse_history(payload: &Value) -> Vec<Moment> {
    parse_history_with_activity(payload).0
}

fn parse_history_moments(payload: &Value, summary_owners: &HashSet<&str>) -> Vec<Moment> {
    payload
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, message)| {
            let role = match message.get("role").and_then(Value::as_str)? {
                "user" => MomentRole::User,
                "assistant" => MomentRole::Intelligence,
                "system" => MomentRole::System,
                "toolResult" => return None,
                _ => return None,
            };
            let content = message.get("content").unwrap_or(&Value::Null);
            let text = extract_text(content);
            let media = message
                .get("media")
                .or_else(|| content.get("media"))
                .map(parse_media)
                .unwrap_or_default();
            let id = history_moment_id(message, index);
            let has_activity_summary =
                role == MomentRole::Intelligence && summary_owners.contains(id.as_str());
            if text.trim().is_empty() && media.is_empty() && !has_activity_summary {
                return None;
            }
            Some(Moment {
                id,
                role,
                text,
                media,
                run_id: message
                    .get("runId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                state: MomentState::Complete,
            })
        })
        .collect()
}

pub fn parse_media(value: &Value) -> Vec<MediaAttachment> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let item = item.as_object()?;
            let kind = match item.get("type").and_then(Value::as_str)? {
                "image" => MediaKind::Image,
                "audio" => MediaKind::Audio,
                "video" => MediaKind::Video,
                "document" => MediaKind::Document,
                _ => return None,
            };
            let mime_type = item.get("mimeType")?.as_str()?.trim();
            if mime_type.is_empty() {
                return None;
            }

            Some(MediaAttachment {
                kind,
                mime_type: mime_type.to_string(),
                key: optional_string(item.get("key")),
                path: optional_string(item.get("path")),
                url: optional_string(item.get("url")),
                filename: optional_string(item.get("filename")),
                size: item.get("size").and_then(Value::as_u64),
                duration: item.get("duration").and_then(Value::as_f64),
                transcription: optional_string(item.get("transcription")),
                description: optional_string(item.get("description")),
            })
        })
        .collect()
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn parse_pending_approval(value: &Value) -> Option<PendingApproval> {
    Some(PendingApproval {
        request_id: value.get("requestId")?.as_str()?.to_string(),
        run_id: value
            .get("runId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        tool_name: value
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        syscall: value
            .get("syscall")
            .and_then(Value::as_str)
            .unwrap_or("an operation")
            .to_string(),
        detail: value.get("args").and_then(approval_detail),
    })
}

fn approval_detail(args: &Value) -> Option<String> {
    let record = args.as_object()?;
    for (key, prefix) in [
        ("input", "Command"),
        ("command", "Command"),
        ("path", "Path"),
        ("url", "Address"),
        ("target", "Target"),
        ("cwd", "Directory"),
    ] {
        let Some(value) = record.get(key).and_then(Value::as_str) else {
            continue;
        };
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if value.is_empty() {
            continue;
        }
        return Some(format!("{prefix}: {}", truncate_chars(&value, 180)));
    }
    None
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut truncated = value
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

pub fn extract_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(extract_text)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(record) => {
            for key in ["text", "content", "message", "output"] {
                if let Some(value) = record.get(key) {
                    let text = extract_text(value);
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
            }
            String::new()
        }
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
    }
}

fn value_key(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn history_moment_id(message: &Value, index: usize) -> String {
    message
        .get("id")
        .map(value_key)
        .unwrap_or_else(|| format!("history:{index}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_keeps_human_moments_and_hides_tool_plumbing() {
        let history = json!({
            "truncated": false,
            "messages": [
                { "id": 1, "role": "user", "content": "Plan my day" },
                { "id": 2, "role": "toolResult", "content": { "output": "private details" } },
                { "id": 3, "role": "assistant", "content": [{ "type": "text", "text": "Done." }] }
            ]
        });
        let moments = parse_history(&history);
        assert_eq!(moments.len(), 2);
        assert_eq!(moments[1].text, "Done.");
    }

    #[test]
    fn history_filters_blank_content_without_normalizing_visible_whitespace() {
        let history = json!({
            "truncated": false,
            "messages": [
                { "id": 1, "role": "user", "content": " \n\t " },
                { "id": 2, "role": "assistant", "content": "\n  keep this spacing  \n" }
            ]
        });

        let moments = parse_history(&history);

        assert_eq!(moments.len(), 1);
        assert_eq!(moments[0].text, "\n  keep this spacing  \n");
    }

    #[test]
    fn history_retains_process_media_and_media_only_moments() {
        let history = json!({
            "truncated": false,
            "messages": [
                {
                    "id": 7,
                    "role": "assistant",
                    "runId": "run-media",
                    "content": {
                        "text": "",
                        "media": [
                            {
                                "type": "image",
                                "mimeType": "image/png",
                                "key": "home/alice/.gsv/media/archived-media:abc",
                                "path": "/home/alice/.gsv/media/archived-media:abc",
                                "filename": "result.png",
                                "size": 4096,
                                "description": "A finished diagram"
                            },
                            {
                                "type": "audio",
                                "mimeType": "audio/ogg",
                                "url": "https://example.com/answer.ogg",
                                "duration": 2.5,
                                "transcription": "Done"
                            }
                        ]
                    }
                }
            ]
        });

        let moments = parse_history(&history);

        assert_eq!(moments.len(), 1);
        assert_eq!(moments[0].run_id.as_deref(), Some("run-media"));
        assert_eq!(moments[0].media.len(), 2);
        assert_eq!(moments[0].media[0].kind, MediaKind::Image);
        assert_eq!(moments[0].media[0].filename.as_deref(), Some("result.png"));
        assert_eq!(moments[0].media[1].duration, Some(2.5));
    }

    #[test]
    fn streaming_is_one_mutable_moment() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "Hello");
        conversation.stream_text(Some("run-1"), " there");
        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].text, "Hello there");
        conversation.finish_run(Some("run-1"), None);
        assert_eq!(conversation.moments[0].state, MomentState::Complete);
    }

    #[test]
    fn live_media_is_idempotent_and_keeps_a_media_only_reply() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        let media = parse_media(&json!([{
            "type": "image",
            "mimeType": "image/jpeg",
            "key": "home/alice/.gsv/media/archived-media:def"
        }]));

        conversation.replace_run_media(Some("run-1"), media.clone());
        conversation.replace_run_media(Some("run-1"), media);
        conversation.finish_run(Some("run-1"), None);

        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].media.len(), 1);
        assert!(conversation.moments[0].text.is_empty());
        assert_eq!(conversation.moments[0].state, MomentState::Complete);
    }

    #[test]
    fn thinking_keeps_the_committed_thought_until_text_arrives() {
        let mut conversation = Conversation::connecting();
        let user_id = conversation.append_user("hello");
        conversation.accept_user(&user_id, "run-1");
        conversation.start_run("run-1");

        assert_eq!(
            conversation.current().map(|moment| moment.role),
            Some(MomentRole::User)
        );
        conversation.stream_text(Some("run-1"), "Hello back");
        assert_eq!(
            conversation.current().map(|moment| moment.role),
            Some(MomentRole::Intelligence)
        );
    }

    #[test]
    fn final_output_replaces_streamed_deltas_instead_of_duplicating_them() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "Hello");
        conversation.stream_text(Some("run-1"), " there");
        conversation.replace_run_text(Some("run-1"), "Hello there");

        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].text, "Hello there");
    }

    #[test]
    fn tool_started_activity_is_typed_scoped_and_sanitized() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        let activity = parse_tool_started_activity(&json!({
            "pid": "alice/main",
            "runId": "run-1",
            "callId": "call-read",
            "name": "Read",
            "syscall": "fs.read",
            "args": { "path": "/private/notes.txt", "content": "do-not-retain" }
        }))
        .expect("valid tool start");
        assert!(!format!("{activity:?}").contains("private"));
        assert!(!format!("{activity:?}").contains("do-not-retain"));
        assert!(conversation.set_live_activity(activity.clone()));
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::ReadingFiles)
        );

        assert!(conversation.resume_thinking(Some("run-1")));
        assert!(conversation.set_live_activity(activity));
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::ReadingFiles)
        );
        assert!(!conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-2",
                "callId": "call-shell",
                "name": "Shell",
                "syscall": "shell.exec"
            }))
            .expect("valid foreign activity")
        ));

        conversation.start_run("run-2");
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::Thinking)
        );
        assert!(parse_tool_started_activity(&json!({
            "runId": "run-1",
            "callId": "name-only",
            "name": "Read"
        }))
        .is_none());
    }

    #[test]
    fn a_repeated_call_id_is_a_new_live_occurrence() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        let activity = parse_tool_started_activity(&json!({
            "runId": "run-1",
            "callId": "call-replayed",
            "syscall": "fs.read"
        }))
        .expect("valid activity");

        assert!(conversation.set_live_activity(activity.clone()));
        conversation.clear_live_activity(Some("run-1"));
        assert!(conversation.set_live_activity(activity));
    }

    #[test]
    fn visible_response_output_clears_live_activity() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        let activity = parse_tool_started_activity(&json!({
            "runId": "run-1",
            "callId": "call-1",
            "name": "Search",
            "syscall": "fs.search"
        }))
        .expect("valid activity");
        assert!(conversation.set_live_activity(activity));

        conversation.stream_text(Some("run-1"), "The answer");
        assert!(conversation.live_activity.is_none());

        assert!(conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-1",
                "callId": "call-2",
                "name": "CodeMode",
                "syscall": "codemode.exec"
            }))
            .expect("valid second activity")
        ));
        conversation.replace_run_media(Some("run-1"), Vec::new());
        assert!(conversation.live_activity.is_none());
    }

    #[test]
    fn history_counts_only_completed_correlated_results_in_fixed_order() {
        let history = json!({
            "truncated": false,
            "messages": [
                {
                    "id": 1,
                    "runId": "run-1",
                    "role": "assistant",
                    "content": {
                        "text": "",
                        "toolCalls": [
                            { "id": "read-ok", "name": "Read", "arguments": { "path": "/private/read" } },
                            { "id": "write-failed", "name": "Write", "arguments": { "content": "secret" } },
                            { "id": "delete-denied", "name": "Delete", "arguments": { "path": "/private/delete" } },
                            { "id": "shell-cancelled", "name": "Shell", "arguments": { "input": "private" } },
                            { "id": "code-ok", "name": "CodeMode", "arguments": { "code": "private" } }
                        ]
                    }
                },
                { "id": 2, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "read-ok", "outcome": "completed", "output": "private contents" } },
                { "id": 3, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Write", "toolCallId": "write-failed", "outcome": "failed", "output": "private error" } },
                { "id": 4, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Delete", "toolCallId": "delete-denied", "outcome": "denied", "output": "private denial" } },
                { "id": 5, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Shell", "toolCallId": "shell-cancelled", "outcome": "cancelled", "output": "private cancellation" } },
                { "id": 6, "runId": "run-1", "role": "toolResult", "content": { "toolName": "CodeMode", "toolCallId": "code-ok", "outcome": "completed", "output": "private result" } },
                { "id": 7, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Search", "toolCallId": "unknown", "outcome": "completed", "output": "must not count" } },
                { "id": 8, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "read-ok", "outcome": "completed", "output": "duplicate" } },
                {
                    "id": 9,
                    "runId": "run-1",
                    "role": "assistant",
                    "content": "Done.",
                    "metadata": { "activitySummary": [{ "category": "deleting_files", "count": 99, "unit": "operations" }] }
                }
            ]
        });
        let activity = derive_history_activity(&history);
        let summaries = &activity.summaries;
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].moment_id, "9");
        assert_eq!(
            summaries[0].entries,
            vec![
                ActivitySummaryEntry {
                    category: ActivityCategory::ReadingFiles,
                    count: 1,
                    unit: ActivityUnit::Reads,
                },
                ActivitySummaryEntry {
                    category: ActivityCategory::RunningCode,
                    count: 1,
                    unit: ActivityUnit::Runs,
                },
            ]
        );
        assert!(!format!("{summaries:?}").contains("private"));
    }

    #[test]
    fn history_correlates_repeated_call_ids_in_sequential_tool_rounds() {
        let history = json!({
            "truncated": false,
            "messages": [
                { "id": 1, "runId": "run-repeat", "role": "user", "content": "Do both" },
                { "id": 2, "runId": "run-repeat", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "reused", "name": "Read" }] } },
                { "id": 3, "runId": "run-repeat", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "reused", "outcome": "completed", "output": "private" } },
                { "id": 4, "runId": "run-repeat", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "reused", "name": "Shell" }] } },
                { "id": 5, "runId": "run-repeat", "role": "toolResult", "content": { "toolName": "Shell", "toolCallId": "reused", "outcome": "completed", "output": "private" } },
                { "id": 6, "runId": "run-repeat", "role": "assistant", "content": "Done" }
            ]
        });
        let activity = derive_history_activity(&history);

        assert_eq!(
            activity
                .latest_call_states
                .get(&("run-repeat".to_string(), "reused".to_string())),
            Some(&HistoryCallState::Terminal {
                message_id: "5".to_string()
            })
        );
        assert_eq!(activity.summaries.len(), 1);
        assert_eq!(
            activity.summaries[0].entries,
            vec![
                ActivitySummaryEntry {
                    category: ActivityCategory::ReadingFiles,
                    count: 1,
                    unit: ActivityUnit::Reads,
                },
                ActivitySummaryEntry {
                    category: ActivityCategory::RunningCommands,
                    count: 1,
                    unit: ActivityUnit::Commands,
                },
            ]
        );
    }

    #[test]
    fn failed_repeated_call_occurrence_does_not_shift_later_success_category() {
        let history = json!({
            "truncated": false,
            "messages": [
                { "id": 1, "runId": "run-repeat", "role": "user", "content": "Try it" },
                { "id": 2, "runId": "run-repeat", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "reused", "name": "Read" }] } },
                { "id": 3, "runId": "run-repeat", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "reused", "outcome": "failed", "output": "private" } },
                { "id": 4, "runId": "run-repeat", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "reused", "name": "Shell" }] } },
                { "id": 5, "runId": "run-repeat", "role": "toolResult", "content": { "toolName": "Shell", "toolCallId": "reused", "outcome": "completed", "output": "private" } },
                { "id": 6, "runId": "run-repeat", "role": "assistant", "content": "Done" }
            ]
        });
        let activity = derive_history_activity(&history);

        assert_eq!(
            activity.summaries[0].entries,
            vec![ActivitySummaryEntry {
                category: ActivityCategory::RunningCommands,
                count: 1,
                unit: ActivityUnit::Commands,
            }]
        );
    }

    #[test]
    fn complete_legacy_history_uses_fixed_tool_name_without_call_context() {
        let history = json!({
            "truncated": false,
            "messages": [
                { "id": 20, "runId": "run-tail", "role": "toolResult", "content": { "toolName": "Search", "toolCallId": "call-before-window", "outcome": "completed", "output": "private" } },
                { "id": 21, "runId": "run-tail", "role": "assistant", "content": "Found it." }
            ]
        });
        let activity = derive_history_activity(&history);
        let summaries = &activity.summaries;

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].entries,
            vec![ActivitySummaryEntry {
                category: ActivityCategory::SearchingFiles,
                count: 1,
                unit: ActivityUnit::Operations,
            }]
        );
    }

    #[test]
    fn truncated_mid_sequence_history_never_creates_a_partial_summary() {
        let history = json!({
            "hasMoreBefore": true,
            "messages": [
                { "id": 20, "runId": "run-tail", "role": "toolResult", "content": { "toolName": "Search", "toolCallId": "call-before-window", "outcome": "completed", "output": "private" } },
                { "id": 21, "runId": "run-tail", "role": "assistant", "content": "Found it." }
            ]
        });
        let activity = derive_history_activity(&history);

        assert!(activity.summaries.is_empty());
        assert!(activity.latest_call_states.is_empty());
        assert!(!activity.authoritative);
    }

    #[test]
    fn truncated_history_starting_at_a_later_tool_round_is_incomplete() {
        let history = json!({
            "hasMoreBefore": true,
            "messages": [
                {
                    "id": 30,
                    "runId": "run-multi-round",
                    "role": "assistant",
                    "content": {
                        "text": "",
                        "toolCalls": [{ "id": "later-read", "name": "Read", "arguments": { "path": "/private" } }]
                    }
                },
                { "id": 31, "runId": "run-multi-round", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "later-read", "outcome": "completed", "output": "private" } },
                { "id": 32, "runId": "run-multi-round", "role": "assistant", "content": "Done" }
            ]
        });
        let activity = derive_history_activity(&history);

        assert!(activity.summaries.is_empty());
        assert_eq!(
            activity
                .latest_call_states
                .get(&("run-multi-round".to_string(), "later-read".to_string())),
            Some(&HistoryCallState::Terminal {
                message_id: "31".to_string()
            })
        );
    }

    #[test]
    fn truncated_history_still_derives_a_later_run_with_an_in_page_boundary() {
        let history = json!({
            "hasMoreBefore": true,
            "messages": [
                { "id": 20, "runId": "run-partial", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "before-window", "outcome": "completed", "output": "private" } },
                { "id": 21, "runId": "run-partial", "role": "assistant", "content": "Earlier answer" },
                { "id": 22, "runId": "run-complete", "role": "user", "content": "New request" },
                { "id": 23, "runId": "run-complete", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "write-1", "name": "Write", "arguments": { "path": "/private" } }] } },
                { "id": 24, "runId": "run-complete", "role": "toolResult", "content": { "toolName": "Write", "toolCallId": "write-1", "outcome": "completed", "output": "private" } },
                { "id": 25, "runId": "run-complete", "role": "assistant", "content": "New answer" }
            ]
        });
        let activity = derive_history_activity(&history);

        assert_eq!(activity.summaries.len(), 1);
        assert_eq!(activity.summaries[0].moment_id, "25");
        assert_eq!(
            activity.summaries[0].entries,
            vec![ActivitySummaryEntry {
                category: ActivityCategory::WritingFiles,
                count: 1,
                unit: ActivityUnit::Operations,
            }]
        );
    }

    #[test]
    fn history_completeness_accepts_only_proven_full_legacy_payloads() {
        assert!(!history_is_authoritative(
            &json!({ "messages": [], "truncated": true, "messageCount": 0 }),
            0
        ));
        assert!(history_is_authoritative(
            &json!({ "messages": [], "truncated": false }),
            0
        ));
        assert!(history_is_authoritative(
            &json!({ "messages": [{ "id": 1 }], "messageCount": 1 }),
            1
        ));
        assert!(!history_is_authoritative(
            &json!({ "messages": [{ "id": 1 }], "messageCount": 2 }),
            1
        ));
        assert!(history_is_authoritative(
            &json!({ "messages": [], "hasMoreBefore": false, "hasMoreAfter": false }),
            0
        ));
        assert!(!history_is_authoritative(
            &json!({ "messages": [], "hasMoreBefore": false }),
            0
        ));
        assert!(!history_is_authoritative(&json!({ "messages": [] }), 0));
    }

    #[test]
    fn compacted_history_never_derives_a_partial_suffix_summary() {
        let history = json!({
            "hasMoreBefore": false,
            "hasMoreAfter": false,
            "truncated": false,
            "messages": [
                { "id": 1, "role": "system", "content": "Process history compacted.\n\nSummary:\nprivate earlier work" },
                { "id": 2, "runId": "run-compacted", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "later", "name": "Read" }] } },
                { "id": 3, "runId": "run-compacted", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "later", "outcome": "completed", "output": "private" } },
                { "id": 4, "runId": "run-compacted", "role": "assistant", "content": "Done" }
            ]
        });
        let activity = derive_history_activity(&history);

        assert!(!activity.authoritative);
        assert!(activity.summaries.is_empty());
        assert!(!format!("{activity:?}").contains("private"));
    }

    #[test]
    fn only_the_matching_observed_result_ends_live_tool_activity() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-live");
        assert!(conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-live",
                "callId": "call-active",
                "name": "Shell",
                "syscall": "shell.exec",
                "args": { "input": "private" }
            }))
            .expect("valid tool start")
        ));

        conversation.reconcile_history_activity(derive_history_activity(&json!({
            "messages": [{
                "id": 1,
                "runId": "run-live",
                "role": "toolResult",
                "content": {
                    "toolName": "Read",
                    "toolCallId": "call-other",
                    "outcome": "completed",
                    "output": "private"
                }
            }]
        })));
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::RunningCommands)
        );

        conversation.reconcile_history_activity(derive_history_activity(&json!({
            "messages": [
                {
                    "id": 2,
                    "runId": "run-live",
                    "role": "assistant",
                    "content": { "text": "", "toolCalls": [{ "id": "call-active", "name": "Shell" }] }
                },
                {
                    "id": 3,
                    "runId": "run-live",
                    "role": "toolResult",
                    "content": {
                        "toolName": "Shell",
                        "toolCallId": "call-active",
                        "outcome": "failed",
                        "output": "private"
                    }
                }
            ]
        })));
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::Thinking)
        );
    }

    #[test]
    fn joining_mid_run_keeps_a_new_reused_call_pending_past_its_old_result() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-live");
        assert!(conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-live",
                "callId": "reused",
                "syscall": "shell.exec"
            }))
            .expect("valid tool start")
        ));
        conversation.reconcile_history_activity(derive_history_activity(&json!({
            "truncated": false,
            "messages": [
                { "id": 10, "runId": "run-live", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "reused", "name": "Read" }] } },
                { "id": 11, "runId": "run-live", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "reused", "outcome": "completed", "output": "private" } },
                { "id": 12, "runId": "run-live", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "reused", "name": "Shell" }] } }
            ]
        })));
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::RunningCommands)
        );

        conversation.reconcile_history_activity(derive_history_activity(&json!({
            "truncated": false,
            "messages": [
                { "id": 10, "runId": "run-live", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "reused", "name": "Read" }] } },
                { "id": 11, "runId": "run-live", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "reused", "outcome": "completed", "output": "private" } },
                { "id": 12, "runId": "run-live", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "reused", "name": "Shell" }] } },
                { "id": 13, "runId": "run-live", "role": "toolResult", "content": { "toolName": "Shell", "toolCallId": "reused", "outcome": "failed", "output": "private" } }
            ]
        })));
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::Thinking)
        );
    }

    #[test]
    fn stale_finish_cannot_clear_current_activity() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "First response");
        conversation.start_run("run-2");
        assert!(conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-2",
                "callId": "call-code",
                "name": "CodeMode",
                "syscall": "codemode.exec"
            }))
            .expect("valid activity")
        ));

        assert!(!conversation.finish_run(Some("run-1"), None));
        assert_eq!(conversation.active_run_id.as_deref(), Some("run-2"));
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::RunningCode)
        );
    }

    #[test]
    fn derived_summary_reconstructs_on_reconnect_and_survives_a_truncated_refresh() {
        let history = json!({
            "truncated": false,
            "messages": [
                { "id": 40, "runId": "run-1", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "read-1", "name": "Read", "arguments": { "path": "/private/a" } }, { "id": "read-2", "name": "Read", "arguments": { "path": "/private/b" } }] } },
                { "id": 41, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "read-1", "outcome": "completed", "output": "private a" } },
                { "id": 42, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "read-2", "outcome": "completed", "output": "private b" } },
                { "id": 43, "runId": "run-1", "role": "assistant", "content": "Finished" }
            ]
        });
        let expected = [ActivitySummaryEntry {
            category: ActivityCategory::ReadingFiles,
            count: 2,
            unit: ActivityUnit::Reads,
        }];

        let mut conversation = Conversation::connecting();
        let (moments, activity) = parse_history_with_activity(&history);
        conversation.replace_history(moments);
        conversation.reconcile_history_activity(activity);
        assert_eq!(
            conversation.activity_summary_for(&conversation.moments[0]),
            &expected
        );

        let mut reconnected = Conversation::connecting();
        let (moments, activity) = parse_history_with_activity(&history);
        reconnected.replace_history(moments);
        reconnected.reconcile_history_activity(activity);
        assert_eq!(
            reconnected.activity_summary_for(&reconnected.moments[0]),
            &expected
        );

        let truncated = json!({
            "hasMoreBefore": true,
            "messages": [
                { "id": 43, "runId": "run-1", "role": "assistant", "content": "Finished" }
            ]
        });
        let (moments, activity) = parse_history_with_activity(&truncated);
        conversation.replace_history(moments);
        conversation.reconcile_history_activity(activity);
        assert_eq!(
            conversation.activity_summary_for(&conversation.moments[0]),
            &expected
        );

        let authoritative_without_tools = json!({
            "hasMoreBefore": false,
            "hasMoreAfter": false,
            "messages": [
                { "id": 43, "runId": "run-1", "role": "assistant", "content": "Finished" }
            ]
        });
        let (moments, activity) = parse_history_with_activity(&authoritative_without_tools);
        conversation.replace_history(moments);
        conversation.reconcile_history_activity(activity);
        assert!(conversation
            .activity_summary_for(&conversation.moments[0])
            .is_empty());
    }

    #[test]
    fn a_blank_final_response_is_kept_when_completed_work_belongs_to_it() {
        let history = json!({
            "truncated": false,
            "messages": [
                { "id": 50, "runId": "run-blank", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "edit-1", "name": "Edit", "arguments": { "path": "/private" } }] } },
                { "id": 51, "runId": "run-blank", "role": "toolResult", "content": { "toolName": "Edit", "toolCallId": "edit-1", "outcome": "completed", "output": "private" } },
                { "id": 52, "runId": "run-blank", "role": "assistant", "content": "" }
            ]
        });
        let (moments, activity) = parse_history_with_activity(&history);

        assert_eq!(moments.len(), 1);
        assert_eq!(moments[0].id, "52");
        assert_eq!(activity.summaries.len(), 1);
        assert_eq!(activity.summaries[0].moment_id, "52");
    }

    #[test]
    fn streaming_does_not_steal_a_deliberate_history_selection() {
        let mut conversation = Conversation::demo();
        conversation.select(0);
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "A new answer");

        assert_eq!(conversation.selected, 0);
        assert_eq!(
            conversation.current().map(|moment| moment.id.as_str()),
            Some("demo-1")
        );
    }

    #[test]
    fn a_stale_history_snapshot_cannot_erase_a_local_submission() {
        let mut conversation = Conversation::connecting();
        let moment_id = conversation.append_user("keep this exact thought");
        conversation.replace_history(Vec::new());

        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].id, moment_id);
        assert_eq!(conversation.moments[0].state, MomentState::Sending);
    }

    #[test]
    fn authoritative_history_replaces_an_accepted_transient_by_run_id() {
        let mut conversation = Conversation::connecting();
        let moment_id = conversation.append_user("hello");
        conversation.accept_user(&moment_id, "run-1");
        conversation.replace_history(vec![Moment {
            id: "message:9".to_string(),
            role: MomentRole::User,
            text: "hello".to_string(),
            media: Vec::new(),
            run_id: Some("run-1".to_string()),
            state: MomentState::Complete,
        }]);

        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].id, "message:9");
    }

    #[test]
    fn uncertain_delivery_stays_visible_until_history_contains_the_thought() {
        let mut conversation = Conversation::connecting();
        let moment_id = conversation.append_user("possibly delivered");
        conversation.mark_user_uncertain(&moment_id);
        conversation.replace_history(Vec::new());
        assert_eq!(conversation.moments[0].state, MomentState::Uncertain);

        conversation.replace_history(vec![Moment::new(
            "message:10",
            MomentRole::User,
            "possibly delivered",
        )]);
        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].id, "message:10");
    }

    #[test]
    fn an_older_identical_history_message_cannot_confirm_an_uncertain_submission() {
        let mut conversation = Conversation::connecting();
        conversation.replace_history(vec![Moment::new(
            "message:old",
            MomentRole::User,
            "repeat this",
        )]);
        let moment_id = conversation.append_user("repeat this");
        conversation.mark_user_uncertain(&moment_id);

        conversation.replace_history(vec![Moment::new(
            "message:old",
            MomentRole::User,
            "repeat this",
        )]);

        assert!(conversation
            .moments
            .iter()
            .any(|moment| moment.id == moment_id && moment.state == MomentState::Uncertain));

        conversation.replace_history(vec![
            Moment::new("message:old", MomentRole::User, "repeat this"),
            Moment::new("message:new", MomentRole::User, "repeat this"),
        ]);

        assert_eq!(conversation.moments.len(), 2);
        assert!(conversation
            .moments
            .iter()
            .all(|moment| !moment.id.starts_with("user:transient:")));
    }

    #[test]
    fn repeated_uncertain_submissions_reconcile_in_occurrence_order() {
        let mut conversation = Conversation::connecting();
        let first_id = conversation.append_user("same thought");
        conversation.mark_user_uncertain(&first_id);
        let second_id = conversation.append_user("same thought");
        conversation.mark_user_uncertain(&second_id);

        conversation.replace_history(vec![Moment::new(
            "message:1",
            MomentRole::User,
            "same thought",
        )]);

        assert!(!conversation
            .moments
            .iter()
            .any(|moment| moment.id == first_id));
        assert!(conversation
            .moments
            .iter()
            .any(|moment| moment.id == second_id));

        conversation.replace_history(vec![
            Moment::new("message:1", MomentRole::User, "same thought"),
            Moment::new("message:2", MomentRole::User, "same thought"),
        ]);

        assert!(conversation
            .moments
            .iter()
            .all(|moment| !moment.id.starts_with("user:transient:")));
    }

    #[test]
    fn an_accepted_local_repeat_cannot_confirm_a_later_uncertain_repeat() {
        let mut conversation = Conversation::connecting();
        let accepted_id = conversation.append_user("same thought");
        conversation.accept_user(&accepted_id, "run-1");
        let uncertain_id = conversation.append_user("same thought");
        conversation.mark_user_uncertain(&uncertain_id);

        conversation.replace_history(vec![Moment {
            id: "message:1".to_string(),
            role: MomentRole::User,
            text: "same thought".to_string(),
            media: Vec::new(),
            run_id: Some("run-1".to_string()),
            state: MomentState::Complete,
        }]);

        assert!(conversation
            .moments
            .iter()
            .any(|moment| moment.id == uncertain_id && moment.state == MomentState::Uncertain));
    }

    #[test]
    fn history_reconciliation_keeps_a_pending_stop_frozen() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "enough");
        assert_eq!(conversation.request_abort().as_deref(), Some("run-1"));

        conversation.replace_history(Vec::new());
        conversation.reconcile_active_run(Some("run-1"), Some("enough"));
        conversation.stream_text(Some("run-1"), " too late");

        assert_eq!(conversation.activity.as_deref(), Some("STOPPING"));
        assert_eq!(conversation.moments[0].text, "enough");
    }

    #[test]
    fn idle_history_retires_the_previously_active_run() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "done");
        conversation.replace_history(Vec::new());
        conversation.reconcile_active_run(None, None);
        conversation.replace_run_text(Some("run-1"), "stale");

        assert!(conversation.moments.is_empty());
        assert!(conversation.active_run_id.is_none());
    }

    #[test]
    fn late_output_cannot_revive_a_finished_run() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "Complete answer");
        conversation.finish_run(Some("run-1"), None);
        conversation.stream_text(Some("run-1"), " stale tail");
        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].text, "Complete answer");
        assert!(conversation.active_run_id.is_none());
    }

    #[test]
    fn abort_freezes_then_retires_the_exact_run() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "Keep this much");
        assert_eq!(conversation.request_abort().as_deref(), Some("run-1"));
        conversation.stream_text(Some("run-1"), " but not this");
        conversation.abort_run("run-1");
        conversation.stream_text(Some("run-1"), " or this");
        assert_eq!(conversation.moments[0].text, "Keep this much");
        assert_eq!(conversation.moments[0].state, MomentState::Complete);
    }

    #[test]
    fn a_stale_abort_failure_cannot_unfreeze_the_stopping_run() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        assert_eq!(conversation.request_abort().as_deref(), Some("run-1"));

        assert!(!conversation.abort_failed("run-2"));
        assert_eq!(conversation.activity.as_deref(), Some("STOPPING"));
        assert!(!conversation.accepts_run(Some("run-1")));
    }

    #[test]
    fn a_matching_abort_failure_resumes_the_active_run() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        assert_eq!(conversation.request_abort().as_deref(), Some("run-1"));

        assert!(conversation.abort_failed("run-1"));
        assert_eq!(conversation.activity.as_deref(), Some("THINKING"));
        assert!(conversation.accepts_run(Some("run-1")));
        assert!(!conversation.abort_failed("run-1"));
    }

    #[test]
    fn a_new_started_run_supersedes_the_previous_stream() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "First");
        conversation.start_run("run-2");
        conversation.stream_text(Some("run-1"), " stale");
        conversation.stream_text(Some("run-2"), "Second");
        assert_eq!(conversation.moments[0].text, "First");
        assert_eq!(conversation.moments[0].state, MomentState::Complete);
        assert_eq!(conversation.moments[1].text, "Second");
        assert_eq!(conversation.active_run_id.as_deref(), Some("run-2"));
    }

    #[test]
    fn approval_keeps_the_sensitive_operation_inspectable() {
        let approval = parse_pending_approval(&json!({
            "requestId": "request-1",
            "runId": "run-1",
            "toolName": "Shell",
            "syscall": "shell.exec",
            "args": { "input": "deploy --production" }
        }))
        .expect("valid approval");
        assert_eq!(
            approval.detail.as_deref(),
            Some("Command: deploy --production")
        );
        assert!(approval_prompt(&approval).contains("deploy --production"));
    }

    #[test]
    fn approved_tool_start_survives_approval_dismissal() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        let approval = parse_pending_approval(&json!({
            "requestId": "request-1",
            "runId": "run-1",
            "toolName": "Shell",
            "syscall": "shell.exec",
            "args": { "input": "private" }
        }))
        .expect("valid approval");

        assert!(conversation.set_approval(approval));
        assert!(conversation.live_activity.is_none());
        assert!(conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-1",
                "callId": "approved-call",
                "syscall": "shell.exec",
                "args": { "input": "private" }
            }))
            .expect("valid tool start")
        ));

        conversation.clear_approval();

        assert!(conversation.pending_approval.is_none());
        assert_eq!(
            conversation
                .live_activity
                .as_ref()
                .map(|activity| activity.category),
            Some(ActivityCategory::RunningCommands)
        );
    }
}
