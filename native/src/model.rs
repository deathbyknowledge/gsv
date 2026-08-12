use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;

use crate::content::{MediaAttachment, MediaKind};
use crate::history::{
    HistoryActivity as PreparedHistoryActivity, HistoryActivityCategory, HistoryActivityUnit,
    HistoryApprovalPreview, HistoryMomentRole, HistoryPendingApproval, HistoryPreparationCandidate,
    HistorySnapshot, HistoryToolCallState,
};
use crate::prepared::{content_revision, ContentRevision};

const RETIRED_RUN_LIMIT: usize = 128;
static NEXT_MOMENT_REVISION: AtomicU64 = AtomicU64::new(1);

fn next_moment_revision() -> u64 {
    NEXT_MOMENT_REVISION.fetch_add(1, Ordering::Relaxed).max(1)
}

// This is an index hint, not an identity check. Keep its work bounded so installing history never
// scans every user message body merely to reconcile the rare uncertain delivery. Hash matches are
// always verified against the exact text before they affect delivery state.
fn text_fingerprint(text: &str) -> u64 {
    const SAMPLE_BYTES: usize = 32;
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x100_0000_01b3;

    let bytes = text.as_bytes();
    let mut fingerprint = FNV_OFFSET ^ bytes.len() as u64;
    let mut mix = |byte: u8| {
        fingerprint ^= u64::from(byte);
        fingerprint = fingerprint.wrapping_mul(FNV_PRIME);
    };
    for byte in bytes.iter().take(SAMPLE_BYTES) {
        mix(*byte);
    }
    for byte in bytes.iter().skip(bytes.len().saturating_sub(SAMPLE_BYTES)) {
        mix(*byte);
    }
    fingerprint
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ActivityCategory {
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

    fn summary_index(self) -> Option<usize> {
        match self {
            Self::SearchingFiles => Some(0),
            Self::ReadingFiles => Some(1),
            Self::WritingFiles => Some(2),
            Self::EditingFiles => Some(3),
            Self::DeletingFiles => Some(4),
            Self::RunningCommands => Some(5),
            Self::RunningCode => Some(6),
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
    call_id: String,
    execution_id: Option<String>,
    terminal_baseline: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveActivityFinished {
    run_id: String,
    call_id: String,
    execution_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LiveActivityEntry {
    pub category: ActivityCategory,
    pub count: usize,
}

impl LiveActivity {
    fn identity(&self) -> String {
        self.execution_id
            .as_deref()
            .map(exact_execution_key)
            .unwrap_or_else(|| format!("legacy-call:{}", self.call_id))
    }
}

fn exact_execution_key(execution_id: &str) -> String {
    format!("execution:{execution_id}")
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
    /// The immutable presentation snapshot is also the canonical body. GPUI can wrap this in a
    /// `SharedString` without copying it, so a live update never retains a second full body solely
    /// for rendering.
    pub text: Arc<str>,
    pub content_revision: u64,
    pub media: Arc<Vec<MediaAttachment>>,
    pub run_id: Option<String>,
    pub state: MomentState,
    text_fingerprint: u64,
    preparation_revision: Option<ContentRevision>,
    preparation_text: Option<Arc<str>>,
    media_revision: ContentRevision,
}

/// An exact identity handoff from a locally streamed assistant moment to the authoritative
/// history message that persists it. Callers may migrate presentation state using this mapping
/// before replacing the conversation, while content caches use the revisions to reject stale
/// work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MomentIdentityAdoption {
    pub(crate) transient_id: String,
    pub(crate) durable_id: String,
    pub(crate) run_id: String,
    pub(crate) revision: ContentRevision,
    pub(crate) media_revision: ContentRevision,
}

impl Moment {
    pub fn new(id: impl Into<String>, role: MomentRole, text: impl Into<String>) -> Self {
        let text = text.into();
        let media = Arc::new(Vec::new());
        let preparation_revision =
            (role == MomentRole::Intelligence).then(|| content_revision(&text, media.as_slice()));
        let text: Arc<str> = Arc::from(text);
        let preparation_text = (role == MomentRole::Intelligence).then(|| text.clone());
        Self {
            id: id.into(),
            role,
            text_fingerprint: text_fingerprint(text.as_ref()),
            text,
            content_revision: next_moment_revision(),
            media_revision: content_revision("", media.as_slice()),
            media,
            run_id: None,
            state: MomentState::Complete,
            preparation_revision,
            preparation_text,
        }
    }

    fn streaming(id: impl Into<String>, text: String, run_id: Option<String>) -> Self {
        let text_fingerprint = text_fingerprint(&text);
        Self {
            id: id.into(),
            role: MomentRole::Intelligence,
            text: Arc::from(text),
            content_revision: next_moment_revision(),
            media: Arc::new(Vec::new()),
            run_id,
            state: MomentState::Streaming,
            text_fingerprint,
            preparation_revision: None,
            preparation_text: None,
            media_revision: content_revision("", &[]),
        }
    }

    fn from_shared_history(
        id: String,
        role: MomentRole,
        render_text: Arc<str>,
        media: Arc<Vec<MediaAttachment>>,
        run_id: Option<String>,
        preparation: Option<&HistoryPreparationCandidate>,
    ) -> Self {
        Self {
            id,
            role,
            text_fingerprint: text_fingerprint(render_text.as_ref()),
            text: render_text,
            content_revision: next_moment_revision(),
            media_revision: preparation.map_or_else(
                || content_revision("", media.as_slice()),
                |candidate| candidate.media_revision,
            ),
            media,
            run_id,
            state: MomentState::Complete,
            preparation_revision: preparation.map(|candidate| candidate.revision),
            preparation_text: preparation.map(|candidate| candidate.text.clone()),
        }
    }

    fn replace_text(&mut self, text: String) {
        if self.text.as_ref() == text {
            return;
        }
        self.text_fingerprint = text_fingerprint(&text);
        self.text = Arc::from(text);
        self.content_revision = next_moment_revision();
        self.preparation_revision = None;
        self.preparation_text = None;
    }

    fn append_text(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        let mut text = String::with_capacity(self.text.len() + delta.len());
        text.push_str(self.text.as_ref());
        text.push_str(delta);
        self.text_fingerprint = text_fingerprint(&text);
        self.text = Arc::from(text);
        self.content_revision = next_moment_revision();
        self.preparation_revision = None;
        self.preparation_text = None;
    }

    fn replace_media(&mut self, media: Arc<Vec<MediaAttachment>>) {
        if self.media == media {
            return;
        }
        self.media = media;
        self.content_revision = next_moment_revision();
        self.media_revision = content_revision("", self.media.as_slice());
        self.preparation_revision = None;
        self.preparation_text = None;
    }

    fn complete(&mut self) {
        self.state = MomentState::Complete;
        self.preparation_revision = (self.role == MomentRole::Intelligence)
            .then(|| content_revision(self.text.as_ref(), self.media.as_slice()));
        self.preparation_text = (self.role == MomentRole::Intelligence).then(|| self.text.clone());
    }

    pub(crate) fn preparation_candidate(&self) -> Option<HistoryPreparationCandidate> {
        (self.role == MomentRole::Intelligence && self.state == MomentState::Complete)
            .then_some(self.preparation_revision)
            .flatten()
            .zip(self.preparation_text.as_ref())
            .map(|(revision, text)| HistoryPreparationCandidate {
                id: Arc::from(self.id.as_str()),
                revision,
                media_revision: self.media_revision,
                text: text.clone(),
                render_text: self.text.clone(),
                media: self.media.clone(),
            })
    }
}

fn is_adoptable_transient(moment: &Moment) -> bool {
    moment.id.starts_with("assistant:transient:")
        && moment.role == MomentRole::Intelligence
        && moment.state == MomentState::Complete
        && moment
            .run_id
            .as_deref()
            .is_some_and(|run_id| !run_id.is_empty())
}

fn exact_moment_identity_matches(
    transient: &Moment,
    transient_revision: ContentRevision,
    run_id: &str,
    durable: &Moment,
) -> bool {
    let transient_text = transient
        .preparation_text
        .as_deref()
        .unwrap_or(transient.text.as_ref());
    let durable_text = durable
        .preparation_text
        .as_deref()
        .unwrap_or(durable.text.as_ref());
    durable.id != transient.id
        && durable.role == MomentRole::Intelligence
        && durable.state == MomentState::Complete
        && durable.run_id.as_deref() == Some(run_id)
        && durable.preparation_revision == Some(transient_revision)
        && durable.media_revision == transient.media_revision
        && durable_text == transient_text
        && durable.text == transient.text
        && durable.media == transient.media
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingApproval {
    pub request_id: String,
    pub run_id: String,
    pub syscall: String,
    pub target: String,
    pub preview: ApprovalPreview,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApprovalPreview {
    Shell {
        command: Option<String>,
    },
    Delete {
        path: Option<String>,
    },
    Fetch {
        method: Option<String>,
        url: Option<String>,
    },
    Mcp {
        tool: Option<String>,
    },
    Unknown,
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
    pub mode: SurfaceMode,
    next_transient_id: u64,
    user_occurrence_baselines: HashMap<String, usize>,
    retired_run_ids: VecDeque<String>,
    response_activity: HashMap<String, Vec<ActivitySummaryEntry>>,
    history_call_states: HashMap<(String, String), HistoryCallState>,
    live_activities: HashMap<String, LiveActivity>,
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
            mode: SurfaceMode::Conversation,
            next_transient_id: 1,
            user_occurrence_baselines: HashMap::new(),
            retired_run_ids: VecDeque::new(),
            response_activity: HashMap::new(),
            history_call_states: HashMap::new(),
            live_activities: HashMap::new(),
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
            mode: SurfaceMode::Conversation,
            next_transient_id: 1,
            user_occurrence_baselines: HashMap::new(),
            retired_run_ids: VecDeque::new(),
            response_activity: HashMap::new(),
            history_call_states: HashMap::new(),
            live_activities: HashMap::new(),
            stopping_run_id: None,
            follow_latest: true,
        }
    }

    pub fn current(&self) -> Option<&Moment> {
        self.moments.get(self.selected)
    }

    /// Find authoritative history messages that are exact persisted identities of local streamed
    /// responses. A run can contain several assistant messages, so the run id is only the first
    /// discriminator: text, media, and both semantic revisions must also match exactly, and the
    /// match must be one-to-one.
    pub(crate) fn history_identity_adoptions(
        &self,
        history_moments: &[Moment],
    ) -> Vec<MomentIdentityAdoption> {
        self.moments
            .iter()
            .filter(|moment| is_adoptable_transient(moment))
            .filter_map(|transient| {
                let run_id = transient.run_id.as_deref()?;
                let revision = transient.preparation_revision.unwrap_or_else(|| {
                    content_revision(transient.text.as_ref(), transient.media.as_slice())
                });
                let mut durable_matches = history_moments.iter().filter(|durable| {
                    exact_moment_identity_matches(transient, revision, run_id, durable)
                });
                let durable = durable_matches.next()?;
                if durable_matches.next().is_some()
                    || self
                        .moments
                        .iter()
                        .filter(|candidate| is_adoptable_transient(candidate))
                        .filter(|candidate| {
                            let candidate_revision =
                                candidate.preparation_revision.unwrap_or_else(|| {
                                    content_revision(
                                        candidate.text.as_ref(),
                                        candidate.media.as_slice(),
                                    )
                                });
                            exact_moment_identity_matches(
                                candidate,
                                candidate_revision,
                                run_id,
                                durable,
                            )
                        })
                        .take(2)
                        .count()
                        != 1
                {
                    return None;
                }
                Some(MomentIdentityAdoption {
                    transient_id: transient.id.clone(),
                    durable_id: durable.id.clone(),
                    run_id: run_id.to_string(),
                    revision,
                    media_revision: transient.media_revision,
                })
            })
            .collect()
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

    pub fn live_activity_entries(&self) -> Vec<LiveActivityEntry> {
        let mut counts = [0_usize; SUMMARY_ACTIVITY_CATEGORIES.len()];
        for activity in self.live_activities.values() {
            if let Some(index) = activity.category.summary_index() {
                counts[index] += 1;
            }
        }
        SUMMARY_ACTIVITY_CATEGORIES
            .iter()
            .copied()
            .zip(counts)
            .filter_map(|(category, count)| {
                (count > 0).then_some(LiveActivityEntry { category, count })
            })
            .collect()
    }

    pub fn set_live_activity(&mut self, mut activity: LiveActivity) -> bool {
        if self.active_run_id.as_deref() != Some(activity.run_id.as_str())
            || !self.accepts_run(Some(&activity.run_id))
        {
            return false;
        }
        let history_key = (activity.run_id.clone(), activity.call_id.clone());
        activity.terminal_baseline = self
            .history_call_states
            .get(&history_key)
            .and_then(|state| match state {
                HistoryCallState::Pending => None,
                HistoryCallState::Terminal { message_id } => Some(message_id.clone()),
            });
        let key = activity.identity();
        if self.pending_approval.is_none() {
            self.activity = None;
        }
        if self.live_activities.contains_key(&key) {
            return false;
        }
        self.live_activities.insert(key, activity);
        true
    }

    pub fn finish_live_activity(&mut self, finished: &LiveActivityFinished) -> bool {
        if self.active_run_id.as_deref() != Some(finished.run_id.as_str())
            || !self.accepts_run(Some(&finished.run_id))
        {
            return false;
        }
        let key = exact_execution_key(&finished.execution_id);
        if self
            .live_activities
            .get(&key)
            .is_none_or(|activity| activity.call_id != finished.call_id)
        {
            return false;
        }
        self.live_activities.remove(&key);
        self.show_thinking_if_idle(&finished.run_id);
        true
    }

    pub fn resume_thinking(&mut self, run_id: Option<&str>) -> bool {
        let Some(run_id) = run_id else {
            return false;
        };
        if self.active_run_id.as_deref() != Some(run_id) || !self.accepts_run(Some(run_id)) {
            return false;
        }
        self.clear_live_activity(Some(run_id));
        self.activity = Some("THINKING".to_string());
        true
    }

    pub fn clear_live_activity(&mut self, run_id: Option<&str>) {
        if run_id.is_none() {
            self.reset_activity_correlation();
        }
        if let Some(run_id) = run_id {
            self.live_activities
                .retain(|_, activity| activity.run_id != run_id);
        } else {
            self.live_activities.clear();
        }
    }

    pub fn clear_legacy_live_activity(&mut self, run_id: Option<&str>) {
        self.live_activities.retain(|_, activity| {
            activity.execution_id.is_some()
                || run_id.is_some_and(|run_id| activity.run_id != run_id)
        });
    }

    pub fn reconcile_history_activity(&mut self, history: HistoryActivity) {
        let HistoryActivity {
            summaries,
            latest_call_states,
            authoritative,
        } = history;
        let active_run_id = self.active_run_id.clone();
        self.live_activities.retain(|_, activity| {
            let Some(HistoryCallState::Terminal { message_id }) =
                latest_call_states.get(&(activity.run_id.clone(), activity.call_id.clone()))
            else {
                return true;
            };
            activity.terminal_baseline.as_deref() == Some(message_id.as_str())
        });
        if let Some(run_id) = active_run_id
            .filter(|_| self.live_activities.is_empty() && self.pending_approval.is_none())
        {
            self.show_thinking_if_idle(&run_id);
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
        let mut history_user_occurrences = HashMap::<u64, Vec<Arc<str>>>::new();
        for moment in &moments {
            if moment.role == MomentRole::User {
                history_user_occurrences
                    .entry(moment.text_fingerprint)
                    .or_default()
                    .push(moment.text.clone());
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
                            .get(&local.text_fingerprint)
                            .map(|candidates| {
                                candidates
                                    .iter()
                                    .filter(|candidate| candidate.as_ref() == local.text.as_ref())
                                    .count()
                            })
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
        let fingerprint = text_fingerprint(&text);
        let occurrence_baseline = self
            .moments
            .iter()
            .filter(|moment| {
                moment.role == MomentRole::User
                    && moment.state != MomentState::Error
                    && moment.text_fingerprint == fingerprint
                    && moment.text.as_ref() == text
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
                if moment.text.trim().is_empty()
                    && moment.media.is_empty()
                    && self.live_activities.is_empty()
                {
                    self.activity = Some("THINKING".to_string());
                }
                return;
            }
        } else if let Some(previous_run_id) = self.active_run_id.take() {
            self.complete_streaming_moment(&previous_run_id, true);
            self.retire_run(previous_run_id);
            self.stopping_run_id = None;
        }

        if !same_run {
            self.reset_activity_correlation();
            self.live_activities.clear();
            self.active_run_id = Some(run_id.clone());
        }
        if self.live_activities.is_empty() {
            self.activity = Some("THINKING".to_string());
        }

        if self.moments.iter().any(|moment| {
            moment.state == MomentState::Streaming
                && moment.run_id.as_deref() == Some(run_id.as_str())
        }) {
            return;
        }

        let id = self.transient_id("assistant");
        let was_following = self.follow_latest || self.moments.is_empty();
        let moment = Moment::streaming(id, String::new(), Some(run_id));
        self.moments.push(moment);
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
            moment.append_text(delta);
        } else {
            let id = self.transient_id("assistant");
            let moment = Moment::streaming(id, delta.to_string(), effective_run_id.clone());
            self.moments.push(moment);
        }
        self.activity = None;
        self.clear_live_activity(effective_run_id.as_deref());
        self.follow_after_append(was_following);
    }

    /// Installs an already materialized provider snapshot without first cloning it at the model
    /// boundary. This is the normal path for streaming providers that include the accumulated
    /// partial response in each event.
    pub fn replace_run_text_owned(&mut self, run_id: Option<&str>, text: String) {
        self.replace_run_text_inner(run_id, text, true);
    }

    fn restore_run_text(&mut self, run_id: &str, text: &str) {
        self.replace_run_text_inner(Some(run_id), text.to_string(), false);
    }

    fn replace_run_text_inner(
        &mut self,
        run_id: Option<&str>,
        text: String,
        clear_live_activity: bool,
    ) {
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
            moment.replace_text(text);
        } else if !text.is_empty() {
            let id = self.transient_id("assistant");
            let moment = Moment::streaming(id, text, effective_run_id.clone());
            self.moments.push(moment);
        }
        if clear_live_activity {
            self.activity = None;
            self.clear_live_activity(effective_run_id.as_deref());
        }
        self.follow_after_append(was_following);
    }

    pub fn replace_run_media(
        &mut self,
        run_id: Option<&str>,
        media: impl Into<Arc<Vec<MediaAttachment>>>,
    ) {
        let media = media.into();
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
            moment.replace_media(media);
        } else if !media.is_empty() {
            let id = self.transient_id("assistant");
            let mut moment = Moment::streaming(id, String::new(), effective_run_id.clone());
            moment.replace_media(media);
            self.moments.push(moment);
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
            self.live_activities.clear();
            self.reset_activity_correlation();
        }
        if let Some(run_id) = run_id {
            self.retired_run_ids.retain(|retired| retired != run_id);
            self.stopping_run_id = None;
            self.start_run(run_id);
            if let Some(live_text) = live_text.filter(|text| !text.is_empty()) {
                self.restore_run_text(run_id, live_text);
            }
            if preserve_stopping {
                self.stopping_run_id = Some(run_id.to_string());
                self.activity = Some("STOPPING".to_string());
            }
        } else {
            self.active_run_id = None;
            self.stopping_run_id = None;
            self.activity = None;
            self.live_activities.clear();
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
                moment.replace_text(
                    error
                        .unwrap_or("The run ended without a response.")
                        .to_string(),
                );
            }
            if error.is_none() {
                moment.complete();
            }
        } else if let Some(error) = error {
            let id = self.transient_id("error");
            let mut moment = Moment::new(id, MomentRole::System, error);
            moment.run_id = Some(active_run_id.clone());
            moment.state = MomentState::Error;
            self.moments.push(moment);
        }

        self.retire_run(active_run_id);
        self.active_run_id = None;
        self.stopping_run_id = None;
        self.activity = None;
        self.live_activities.clear();
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
        self.live_activities.clear();
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
        self.live_activities.clear();
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
        let mut moment = Moment::new(id, MomentRole::System, message);
        moment.state = MomentState::Error;
        self.moments.push(moment);
        self.activity = None;
        self.select_latest();
    }

    pub fn set_approval(&mut self, approval: PendingApproval) -> bool {
        let preserved_feedback = self
            .pending_approval
            .as_ref()
            .filter(|pending| pending.request_id == approval.request_id)
            .and(self.activity.as_deref())
            .filter(|activity| {
                matches!(
                    *activity,
                    "APPLYING"
                        | "NOT APPLIED · TRY AGAIN"
                        | "TYPE ALLOW ONCE, ALWAYS ALLOW, OR DENY"
                )
            })
            .map(str::to_string);
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
            existing.replace_text(text);
        } else {
            let mut moment = Moment::new(id, MomentRole::System, text);
            moment.run_id = Some(approval.run_id.clone());
            moment.state = MomentState::Approval;
            self.moments.push(moment);
        }
        self.pending_approval = Some(approval);
        self.activity = Some(preserved_feedback.unwrap_or_else(|| "APPROVAL REQUIRED".to_string()));
        self.clear_legacy_live_activity(None);
        self.select_latest();
        true
    }

    pub fn clear_approval(&mut self) {
        let preserve_live_activity = self.pending_approval.as_ref().is_some_and(|approval| {
            !approval.run_id.is_empty()
                && self.active_run_id.as_deref() == Some(approval.run_id.as_str())
                && self
                    .live_activities
                    .values()
                    .any(|activity| activity.run_id == approval.run_id)
        });
        self.pending_approval = None;
        self.moments
            .retain(|moment| moment.state != MomentState::Approval);
        self.activity = self.active_run_id.as_ref().map(|_| "THINKING".to_string());
        if !preserve_live_activity {
            self.live_activities.clear();
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
            self.moments[index].complete();
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

    fn show_thinking_if_idle(&mut self, run_id: &str) {
        if self.active_run_id.as_deref() == Some(run_id)
            && self.live_activities.is_empty()
            && self.pending_approval.is_none()
            && self.stopping_run_id.is_none()
        {
            self.activity = Some("THINKING".to_string());
        }
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
    let execution_id = match value.get("executionId") {
        Some(value) => {
            let execution_id = value.as_str()?.trim();
            if execution_id.is_empty() {
                return None;
            }
            Some(execution_id)
        }
        None => None,
    };
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
        call_id: call_id.to_string(),
        execution_id: execution_id.map(str::to_string),
        terminal_baseline: None,
    })
}

pub fn parse_tool_finished_activity(value: &Value) -> Option<LiveActivityFinished> {
    let run_id = value.get("runId")?.as_str()?.trim();
    let call_id = value.get("callId")?.as_str()?.trim();
    let execution_id = value.get("executionId")?.as_str()?.trim();
    let outcome = value.get("outcome")?.as_str()?;
    if run_id.is_empty()
        || call_id.is_empty()
        || execution_id.is_empty()
        || !matches!(outcome, "completed" | "failed" | "cancelled" | "denied")
    {
        return None;
    }
    Some(LiveActivityFinished {
        run_id: run_id.to_string(),
        call_id: call_id.to_string(),
        execution_id: execution_id.to_string(),
    })
}

#[cfg(test)]
pub fn parse_history_with_activity(payload: &Value) -> (Vec<Moment>, HistoryActivity) {
    let snapshot = crate::history::normalize_history(payload);
    (
        moments_from_history(&snapshot),
        activity_from_history(&snapshot.activity),
    )
}

#[cfg(test)]
fn derive_history_activity(payload: &Value) -> HistoryActivity {
    let snapshot = crate::history::normalize_history(payload);
    activity_from_history(&snapshot.activity)
}

#[cfg(test)]
fn history_is_authoritative(payload: &Value, _visible_message_count: usize) -> bool {
    let snapshot = crate::history::normalize_history(payload);
    snapshot.activity.authoritative
}

/// Install-ready conversation data produced by the client runtime. Large message and media bodies
/// remain shared, so applying a fetched history page on the GPUI thread performs no content copy or
/// Markdown parsing.
pub fn moments_from_history(snapshot: &HistorySnapshot) -> Vec<Moment> {
    let preparations = snapshot
        .preparation_candidates
        .iter()
        .map(|candidate| (candidate.id.as_ref(), candidate))
        .collect::<HashMap<_, _>>();
    snapshot
        .moments
        .iter()
        .map(|moment| {
            let role = match moment.role {
                HistoryMomentRole::User => MomentRole::User,
                HistoryMomentRole::Intelligence => MomentRole::Intelligence,
                HistoryMomentRole::System => MomentRole::System,
            };
            Moment::from_shared_history(
                moment.id.to_string(),
                role,
                moment.render_text.clone(),
                moment.media.clone(),
                moment.run_id.as_deref().map(str::to_string),
                preparations.get(moment.id.as_ref()).copied(),
            )
        })
        .collect()
}

pub fn activity_from_history(history: &PreparedHistoryActivity) -> HistoryActivity {
    HistoryActivity {
        summaries: history
            .summaries
            .iter()
            .map(|summary| HistoryActivitySummary {
                moment_id: summary.moment_id.to_string(),
                entries: summary
                    .entries
                    .iter()
                    .map(|entry| ActivitySummaryEntry {
                        category: match entry.category {
                            HistoryActivityCategory::SearchingFiles => {
                                ActivityCategory::SearchingFiles
                            }
                            HistoryActivityCategory::ReadingFiles => ActivityCategory::ReadingFiles,
                            HistoryActivityCategory::WritingFiles => ActivityCategory::WritingFiles,
                            HistoryActivityCategory::EditingFiles => ActivityCategory::EditingFiles,
                            HistoryActivityCategory::DeletingFiles => {
                                ActivityCategory::DeletingFiles
                            }
                            HistoryActivityCategory::RunningCommands => {
                                ActivityCategory::RunningCommands
                            }
                            HistoryActivityCategory::RunningCode => ActivityCategory::RunningCode,
                        },
                        count: entry.count,
                        unit: match entry.unit {
                            HistoryActivityUnit::Operations => ActivityUnit::Operations,
                            HistoryActivityUnit::Reads => ActivityUnit::Reads,
                            HistoryActivityUnit::Commands => ActivityUnit::Commands,
                            HistoryActivityUnit::Runs => ActivityUnit::Runs,
                        },
                    })
                    .collect(),
            })
            .collect(),
        latest_call_states: history
            .latest_call_states
            .iter()
            .map(|entry| {
                (
                    (entry.run_id.to_string(), entry.call_id.to_string()),
                    match &entry.state {
                        HistoryToolCallState::Pending => HistoryCallState::Pending,
                        HistoryToolCallState::Terminal { message_id } => {
                            HistoryCallState::Terminal {
                                message_id: message_id.to_string(),
                            }
                        }
                    },
                )
            })
            .collect(),
        authoritative: history.authoritative,
    }
}

pub fn pending_approval_from_history(approval: &HistoryPendingApproval) -> PendingApproval {
    PendingApproval {
        request_id: approval.request_id.to_string(),
        run_id: approval.run_id.to_string(),
        syscall: approval.syscall.to_string(),
        target: approval.target.to_string(),
        preview: match &approval.preview {
            HistoryApprovalPreview::Shell { command } => ApprovalPreview::Shell {
                command: command.as_deref().map(str::to_string),
            },
            HistoryApprovalPreview::Delete { path } => ApprovalPreview::Delete {
                path: path.as_deref().map(str::to_string),
            },
            HistoryApprovalPreview::Fetch { method, url } => ApprovalPreview::Fetch {
                method: method.as_deref().map(str::to_string),
                url: url.as_deref().map(str::to_string),
            },
            HistoryApprovalPreview::Mcp { tool } => ApprovalPreview::Mcp {
                tool: tool.as_deref().map(str::to_string),
            },
            HistoryApprovalPreview::Unknown => ApprovalPreview::Unknown,
        },
    }
}

pub fn approval_prompt(approval: &PendingApproval) -> String {
    let target = approval_target_label(&approval.target);
    let request = match &approval.preview {
        ApprovalPreview::Shell {
            command: Some(command),
        } if !command.is_empty() => format!("I want to run this on {target}:\n\n{command}"),
        ApprovalPreview::Shell { command: Some(_) } => {
            format!("I want to continue a shell session on {target}.")
        }
        ApprovalPreview::Shell { command: None } => {
            format!("I want to run a shell command on {target}.")
        }
        ApprovalPreview::Delete { path: Some(path) } if !path.is_empty() => format!(
            "I want to delete this from {target}:\n\n{}",
            visible_approval_text(path)
        ),
        ApprovalPreview::Delete { path: _ } => {
            format!("I want to delete a file from {target}.")
        }
        ApprovalPreview::Fetch { method, url } => {
            let method = method.as_deref().filter(|value| !value.is_empty());
            let url = url.as_deref().filter(|value| !value.is_empty());
            match (method, url) {
                (Some(method), Some(url)) => format!(
                    "I want to send this web request from {target}:\n\n{} {}",
                    visible_approval_text(method),
                    visible_approval_text(url)
                ),
                (None, Some(url)) => format!(
                    "I want to fetch this from {target}:\n\n{}",
                    visible_approval_text(url)
                ),
                _ => format!("I want to make a web request from {target}."),
            }
        }
        ApprovalPreview::Mcp { tool: Some(tool) } if !tool.is_empty() => format!(
            "I want to use the connected tool “{}” on {target}.",
            visible_approval_text(tool)
        ),
        ApprovalPreview::Mcp { tool: _ } => {
            format!("I want to use a connected tool on {target}.")
        }
        ApprovalPreview::Unknown => {
            format!("I want to perform a protected action on {target}.")
        }
    };
    request
}

pub fn approval_scope_description(approval: &PendingApproval) -> String {
    let action = match &approval.preview {
        ApprovalPreview::Shell { .. } => "shell commands",
        ApprovalPreview::Delete { .. } => "file deletions",
        ApprovalPreview::Fetch { .. } => "web requests",
        ApprovalPreview::Mcp { .. } => "connected tool calls",
        ApprovalPreview::Unknown => "requests for this operation",
    };
    let target = match approval.target.as_str() {
        "gsv" => "on this GSV",
        "targets/*" => "on connected devices",
        _ => "on this target only",
    };
    format!("“Always allow” covers future {action} {target} in this conversation.")
}

#[cfg(test)]
pub fn parse_history(payload: &Value) -> Vec<Moment> {
    parse_history_with_activity(payload).0
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
    let request_id = value.get("requestId")?.as_str()?.to_string();
    let run_id = value
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let syscall = value
        .get("syscall")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let target = value.get("target")?.as_str()?.trim();
    if target.is_empty() {
        return None;
    }
    Some(PendingApproval {
        request_id,
        run_id,
        target: target.to_string(),
        preview: approval_preview(&syscall, value.get("args")),
        syscall,
    })
}

fn approval_preview(syscall: &str, args: Option<&Value>) -> ApprovalPreview {
    let record = args.and_then(Value::as_object);
    match syscall {
        "shell.exec" => ApprovalPreview::Shell {
            command: record
                .and_then(|args| args.get("input"))
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "fs.delete" => ApprovalPreview::Delete {
            path: record
                .and_then(|args| args.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "net.fetch" => ApprovalPreview::Fetch {
            method: record
                .and_then(|args| args.get("method"))
                .and_then(Value::as_str)
                .map(str::to_string),
            url: record
                .and_then(|args| args.get("url"))
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "sys.mcp.call" => ApprovalPreview::Mcp {
            tool: record
                .and_then(|args| args.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        _ => ApprovalPreview::Unknown,
    }
}

fn approval_target_label(target: &str) -> String {
    match target {
        "gsv" => "GSV".to_string(),
        "targets/*" => "connected devices".to_string(),
        target if !target.is_empty() => {
            format!("“{}”", visible_approval_text(target))
        }
        _ => unreachable!("approval targets are validated at the protocol boundary"),
    }
}

fn visible_approval_text(value: &str) -> String {
    let mut visible = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\n' => visible.push_str("\\n"),
            '\r' => visible.push_str("\\r"),
            '\t' => visible.push_str("\\t"),
            character if character.is_control() => {
                visible.extend(character.escape_unicode());
            }
            character => visible.push(character),
        }
    }
    visible
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
        assert_eq!(moments[1].text.as_ref(), "Done.");
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
        assert_eq!(moments[0].text.as_ref(), "\n  keep this spacing  \n");
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
        let empty_revision = conversation.moments[0].content_revision;
        conversation.stream_text(Some("run-1"), "Hello");
        let hello_revision = conversation.moments[0].content_revision;
        conversation.stream_text(Some("run-1"), " there");
        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].text.as_ref(), "Hello there");
        assert_ne!(hello_revision, empty_revision);
        assert_ne!(conversation.moments[0].content_revision, hello_revision);
        conversation.finish_run(Some("run-1"), None);
        assert_eq!(conversation.moments[0].state, MomentState::Complete);
        let candidate = conversation.moments[0]
            .preparation_candidate()
            .expect("completed intelligence is prepared by revision");
        assert_eq!(candidate.render_text.as_ref(), "Hello there");
        assert_eq!(candidate.text.as_ref(), "Hello there");
    }

    #[test]
    fn completed_stream_identity_maps_exactly_to_a_different_durable_id() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-adopt");
        conversation.stream_text(Some("run-adopt"), "A **stable** answer");
        assert!(conversation.finish_run(Some("run-adopt"), None));
        let transient_id = conversation.moments[0].id.clone();
        let snapshot = crate::history::normalize_history(&json!({
            "messages": [
                {
                    "id": 91,
                    "runId": "run-adopt",
                    "role": "assistant",
                    "content": "A **stable** answer"
                }
            ]
        }));
        let history = moments_from_history(&snapshot);

        let adoptions = conversation.history_identity_adoptions(&history);

        assert_eq!(
            adoptions,
            vec![MomentIdentityAdoption {
                transient_id,
                durable_id: "91".to_string(),
                run_id: "run-adopt".to_string(),
                revision: content_revision("A **stable** answer", &[]),
                media_revision: content_revision("", &[]),
            }]
        );
    }

    #[test]
    fn stream_identity_rejects_stale_content_and_run_mismatches() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-current");
        conversation.stream_text(Some("run-current"), "Current answer");
        assert!(conversation.finish_run(Some("run-current"), None));

        for (run_id, text) in [
            ("run-stale", "Current answer"),
            ("run-current", "Current answer plus a stale tail"),
        ] {
            let snapshot = crate::history::normalize_history(&json!({
                "messages": [
                    {
                        "id": 92,
                        "runId": run_id,
                        "role": "assistant",
                        "content": text
                    }
                ]
            }));
            assert!(conversation
                .history_identity_adoptions(&moments_from_history(&snapshot))
                .is_empty());
        }

        let media_mismatch = crate::history::normalize_history(&json!({
            "messages": [
                {
                    "id": 92,
                    "runId": "run-current",
                    "role": "assistant",
                    "content": "Current answer",
                    "media": [
                        {
                            "type": "image",
                            "mimeType": "image/png",
                            "key": "home/alice/.gsv/media/different"
                        }
                    ]
                }
            ]
        }));
        assert!(conversation
            .history_identity_adoptions(&moments_from_history(&media_mismatch))
            .is_empty());
    }

    #[test]
    fn streaming_partial_never_adopts_an_earlier_identical_occurrence() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-repeat-live");
        conversation.stream_text(Some("run-repeat-live"), "Done.");
        let snapshot = crate::history::normalize_history(&json!({
            "messages": [{
                "id": 90,
                "runId": "run-repeat-live",
                "role": "assistant",
                "content": "Done."
            }]
        }));

        assert!(conversation
            .history_identity_adoptions(&moments_from_history(&snapshot))
            .is_empty());
    }

    #[test]
    fn stream_identity_requires_an_unambiguous_durable_message() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-repeat");
        conversation.stream_text(Some("run-repeat"), "Repeated answer");
        assert!(conversation.finish_run(Some("run-repeat"), None));
        let snapshot = crate::history::normalize_history(&json!({
            "messages": [
                {
                    "id": 93,
                    "runId": "run-repeat",
                    "role": "assistant",
                    "content": "Repeated answer"
                },
                {
                    "id": 94,
                    "runId": "run-repeat",
                    "role": "assistant",
                    "content": "Repeated answer"
                }
            ]
        }));

        assert!(conversation
            .history_identity_adoptions(&moments_from_history(&snapshot))
            .is_empty());
    }

    #[test]
    fn owned_stream_snapshot_becomes_the_canonical_gpui_allocation() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-owned");
        let snapshot = "provider-owned snapshot".repeat(40);
        conversation.replace_run_text_owned(Some("run-owned"), snapshot.clone());

        let moment = &conversation.moments[0];
        assert_eq!(moment.text.as_ref(), snapshot);
        let render = gpui::SharedString::new(moment.text.clone());
        let render_arc: Arc<str> = render.into();
        assert!(Arc::ptr_eq(&moment.text, &render_arc));
    }

    #[test]
    fn history_moments_share_the_background_render_snapshot() {
        let snapshot = crate::history::normalize_history(&json!({
            "messages": [
                { "id": 1, "role": "user", "content": "A large immutable thought" },
                { "id": 2, "role": "assistant", "content": "A prepared answer" }
            ]
        }));
        let moments = moments_from_history(&snapshot);

        assert_eq!(moments.len(), 2);
        assert!(Arc::ptr_eq(
            &moments[0].text,
            &snapshot.moments[0].render_text
        ));
        assert!(Arc::ptr_eq(
            &moments[1].text,
            &snapshot.moments[1].render_text
        ));
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

        let empty_revision = conversation.moments[0].content_revision;
        conversation.replace_run_media(Some("run-1"), media.clone());
        let media_revision = conversation.moments[0].content_revision;
        conversation.replace_run_media(Some("run-1"), media);
        conversation.finish_run(Some("run-1"), None);

        assert_ne!(media_revision, empty_revision);
        assert_eq!(conversation.moments[0].content_revision, media_revision);
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
        conversation.replace_run_text_owned(Some("run-1"), "Hello there".to_string());

        assert_eq!(conversation.moments.len(), 1);
        assert_eq!(conversation.moments[0].text.as_ref(), "Hello there");
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
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::ReadingFiles,
                count: 1,
            }]
        );

        assert!(conversation.resume_thinking(Some("run-1")));
        assert!(conversation.set_live_activity(activity));
        assert_eq!(
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::ReadingFiles,
                count: 1,
            }]
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
        assert!(conversation.live_activity_entries().is_empty());
        assert_eq!(conversation.activity.as_deref(), Some("THINKING"));
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
    fn exact_executions_group_concurrently_and_finish_individually() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        for payload in [
            json!({
                "runId": "run-1",
                "callId": "read-a",
                "executionId": "execution-read-a",
                "syscall": "fs.read",
                "args": { "path": "/private/a" }
            }),
            json!({
                "runId": "run-1",
                "callId": "shell",
                "executionId": "execution-shell",
                "syscall": "shell.exec",
                "args": { "input": "private command" }
            }),
            json!({
                "runId": "run-1",
                "callId": "read-b",
                "executionId": "execution-read-b",
                "syscall": "fs.read",
                "args": { "path": "/private/b" }
            }),
        ] {
            let activity = parse_tool_started_activity(&payload).expect("valid exact start");
            assert!(!format!("{activity:?}").contains("private"));
            assert!(conversation.set_live_activity(activity));
        }
        assert_eq!(
            conversation.live_activity_entries(),
            vec![
                LiveActivityEntry {
                    category: ActivityCategory::ReadingFiles,
                    count: 2,
                },
                LiveActivityEntry {
                    category: ActivityCategory::RunningCommands,
                    count: 1,
                },
            ]
        );
        assert!(!conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-1",
                "callId": "must-not-replace-read-a",
                "executionId": "execution-read-a",
                "syscall": "fs.delete"
            }))
            .expect("well-formed duplicate execution")
        ));
        assert_eq!(
            conversation.live_activity_entries(),
            vec![
                LiveActivityEntry {
                    category: ActivityCategory::ReadingFiles,
                    count: 2,
                },
                LiveActivityEntry {
                    category: ActivityCategory::RunningCommands,
                    count: 1,
                },
            ]
        );

        let finish = parse_tool_finished_activity(&json!({
            "runId": "run-1",
            "callId": "shell",
            "executionId": "execution-shell",
            "outcome": "failed",
            "timestamp": 10,
            "output": "must not be retained"
        }))
        .expect("valid exact finish");
        assert!(!format!("{finish:?}").contains("retained"));
        assert!(conversation.finish_live_activity(&finish));
        assert!(!conversation.finish_live_activity(&finish));
        assert_eq!(
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::ReadingFiles,
                count: 2,
            }]
        );

        let mismatched_call = parse_tool_finished_activity(&json!({
            "runId": "run-1",
            "callId": "not-read-a",
            "executionId": "execution-read-a",
            "outcome": "completed"
        }))
        .expect("well-formed but mismatched finish");
        assert!(!conversation.finish_live_activity(&mismatched_call));

        for (call_id, execution_id, outcome) in [
            ("read-b", "execution-read-b", "denied"),
            ("read-a", "execution-read-a", "cancelled"),
        ] {
            let finish = parse_tool_finished_activity(&json!({
                "runId": "run-1",
                "callId": call_id,
                "executionId": execution_id,
                "outcome": outcome
            }))
            .expect("valid exact finish");
            assert!(conversation.finish_live_activity(&finish));
        }
        assert!(conversation.live_activity_entries().is_empty());
        assert_eq!(conversation.activity.as_deref(), Some("THINKING"));
        assert!(parse_tool_finished_activity(&json!({
            "runId": "run-1",
            "callId": "read-a",
            "executionId": "execution-read-a",
            "outcome": "unknown"
        }))
        .is_none());
    }

    #[test]
    fn history_recovery_and_live_text_replay_preserve_exact_execution_state() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "Partial answer");
        conversation.reconcile_history_activity(derive_history_activity(&json!({
            "truncated": false,
            "messages": [
                { "id": 1, "runId": "run-1", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "call-reused", "name": "Read" }] } },
                { "id": 2, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "call-reused", "outcome": "completed", "output": "private old result" } }
            ]
        })));
        assert!(conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-1",
                "callId": "call-reused",
                "executionId": "execution-new",
                "syscall": "fs.read"
            }))
            .expect("valid exact start")
        ));

        conversation.reconcile_history_activity(derive_history_activity(&json!({
            "truncated": false,
            "messages": [
                { "id": 1, "runId": "run-1", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "call-reused", "name": "Read" }] } },
                { "id": 2, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "call-reused", "outcome": "completed", "output": "private old result" } }
            ]
        })));
        conversation.reconcile_active_run(Some("run-1"), Some("Partial answer"));
        assert_eq!(
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::ReadingFiles,
                count: 1,
            }]
        );

        conversation.reconcile_history_activity(derive_history_activity(&json!({
            "truncated": false,
            "messages": [
                { "id": 1, "runId": "run-1", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "call-reused", "name": "Read" }] } },
                { "id": 2, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "call-reused", "outcome": "completed", "output": "private old result" } },
                { "id": 3, "runId": "run-1", "role": "assistant", "content": { "text": "", "toolCalls": [{ "id": "call-reused", "name": "Read" }] } },
                { "id": 4, "runId": "run-1", "role": "toolResult", "content": { "toolName": "Read", "toolCallId": "call-reused", "outcome": "failed", "output": "private new result" } }
            ]
        })));
        conversation.reconcile_active_run(Some("run-1"), Some("Partial answer"));
        assert!(conversation.live_activity_entries().is_empty());
        assert_eq!(conversation.activity.as_deref(), Some("THINKING"));
    }

    #[test]
    fn visible_response_output_clears_live_activity() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        let activity = parse_tool_started_activity(&json!({
            "runId": "run-1",
            "callId": "call-1",
            "executionId": "execution-1",
            "name": "Search",
            "syscall": "fs.search"
        }))
        .expect("valid activity");
        assert!(conversation.set_live_activity(activity));

        conversation.stream_text(Some("run-1"), "The answer");
        assert!(conversation.live_activity_entries().is_empty());

        assert!(conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-1",
                "callId": "call-2",
                "executionId": "execution-2",
                "name": "CodeMode",
                "syscall": "codemode.exec"
            }))
            .expect("valid second activity")
        ));
        conversation.replace_run_media(Some("run-1"), Vec::new());
        assert!(conversation.live_activity_entries().is_empty());
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
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::RunningCommands,
                count: 1,
            }]
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
        assert!(conversation.live_activity_entries().is_empty());
        assert_eq!(conversation.activity.as_deref(), Some("THINKING"));
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
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::RunningCommands,
                count: 1,
            }]
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
        assert!(conversation.live_activity_entries().is_empty());
        assert_eq!(conversation.activity.as_deref(), Some("THINKING"));
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
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::RunningCode,
                count: 1,
            }]
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
        let mut history_moment = Moment::new("message:9", MomentRole::User, "hello");
        history_moment.run_id = Some("run-1".to_string());
        conversation.replace_history(vec![history_moment]);

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
    fn uncertain_delivery_fingerprint_collisions_still_require_exact_text() {
        let prefix = "p".repeat(32);
        let suffix = "s".repeat(32);
        let submitted = format!("{prefix}{}{}", "a".repeat(64), suffix);
        let collision = format!("{prefix}{}{}", "b".repeat(64), suffix);
        assert_eq!(submitted.len(), collision.len());
        assert_eq!(text_fingerprint(&submitted), text_fingerprint(&collision));

        let mut conversation = Conversation::connecting();
        let local_id = conversation.append_user(submitted.clone());
        conversation.mark_user_uncertain(&local_id);
        conversation.replace_history(vec![Moment::new(
            "message:collision",
            MomentRole::User,
            collision,
        )]);
        assert!(conversation
            .moments
            .iter()
            .any(|moment| moment.id == local_id));

        conversation.replace_history(vec![Moment::new(
            "message:exact",
            MomentRole::User,
            submitted,
        )]);
        assert!(conversation
            .moments
            .iter()
            .all(|moment| !moment.id.starts_with("user:transient:")));
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

        let mut history_moment = Moment::new("message:1", MomentRole::User, "same thought");
        history_moment.run_id = Some("run-1".to_string());
        conversation.replace_history(vec![history_moment]);

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
        assert_eq!(conversation.moments[0].text.as_ref(), "enough");
    }

    #[test]
    fn idle_history_retires_the_previously_active_run() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        conversation.stream_text(Some("run-1"), "done");
        conversation.replace_history(Vec::new());
        conversation.reconcile_active_run(None, None);
        conversation.replace_run_text_owned(Some("run-1"), "stale".to_string());

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
        assert_eq!(conversation.moments[0].text.as_ref(), "Complete answer");
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
        assert_eq!(conversation.moments[0].text.as_ref(), "Keep this much");
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
        assert_eq!(conversation.moments[0].text.as_ref(), "First");
        assert_eq!(conversation.moments[0].state, MomentState::Complete);
        assert_eq!(conversation.moments[1].text.as_ref(), "Second");
        assert_eq!(conversation.active_run_id.as_deref(), Some("run-2"));
    }

    #[test]
    fn shell_approval_preserves_the_exact_command_and_correlation() {
        let command = format!(
            "  printf 'a  b'\n\t&& echo \"$PATH\"\n{}  ",
            "x".repeat(220)
        );
        let approval = parse_pending_approval(&json!({
            "requestId": "request:exact",
            "runId": "run:exact",
            "toolName": "Shell",
            "syscall": "shell.exec",
            "target": "macbook",
            "args": {
                "input": command,
                "cwd": "/private/workspace",
                "timeout": 120000
            }
        }))
        .expect("valid approval");

        assert_eq!(approval.request_id, "request:exact");
        assert_eq!(approval.run_id, "run:exact");
        assert_eq!(approval.target, "macbook");
        assert_eq!(
            approval.preview,
            ApprovalPreview::Shell {
                command: Some(command.clone())
            }
        );
        assert_eq!(
            approval_prompt(&approval),
            format!("I want to run this on “macbook”:\n\n{command}")
        );
        assert_eq!(
            approval_scope_description(&approval),
            "“Always allow” covers future shell commands on this target only in this conversation."
        );
    }

    #[test]
    fn guarded_approval_previews_keep_only_action_specific_safe_fields() {
        let delete = parse_pending_approval(&json!({
            "requestId": "request-delete",
            "runId": "run-delete",
            "syscall": "fs.delete",
            "target": "gsv",
            "args": {
                "path": "/tmp/old file.txt",
                "content": "unrelated private contents"
            }
        }))
        .expect("valid delete approval");
        assert_eq!(
            delete.preview,
            ApprovalPreview::Delete {
                path: Some("/tmp/old file.txt".to_string())
            }
        );
        assert_eq!(
            approval_prompt(&delete),
            "I want to delete this from GSV:\n\n/tmp/old file.txt"
        );
        assert!(!approval_prompt(&delete).contains("private contents"));

        let fetch = parse_pending_approval(&json!({
            "requestId": "request-fetch",
            "runId": "run-fetch",
            "syscall": "net.fetch",
            "target": "gsv",
            "args": {
                "method": "POST",
                "url": "https://example.com/jobs",
                "headers": { "authorization": "Bearer private-token" }
            }
        }))
        .expect("valid fetch approval");
        assert_eq!(
            fetch.preview,
            ApprovalPreview::Fetch {
                method: Some("POST".to_string()),
                url: Some("https://example.com/jobs".to_string())
            }
        );
        assert_eq!(
            approval_prompt(&fetch),
            "I want to send this web request from GSV:\n\nPOST https://example.com/jobs"
        );
        assert!(!approval_prompt(&fetch).contains("private-token"));

        let mcp = parse_pending_approval(&json!({
            "requestId": "request-mcp",
            "runId": "run-mcp",
            "syscall": "sys.mcp.call",
            "target": "gsv",
            "args": {
                "serverId": "server-internal-id",
                "name": "create_issue",
                "arguments": { "private": "customer data" }
            }
        }))
        .expect("valid MCP approval");
        assert_eq!(
            mcp.preview,
            ApprovalPreview::Mcp {
                tool: Some("create_issue".to_string())
            }
        );
        assert_eq!(
            approval_prompt(&mcp),
            "I want to use the connected tool “create_issue” on GSV."
        );
        assert!(!approval_prompt(&mcp).contains("server-internal-id"));
        assert!(!approval_prompt(&mcp).contains("customer data"));
        assert_eq!(
            approval_scope_description(&mcp),
            "“Always allow” covers future connected tool calls on this GSV in this conversation."
        );
    }

    #[test]
    fn matching_approval_refresh_preserves_feedback_but_a_new_request_resets_it() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-approval");
        let request = |request_id: &str| PendingApproval {
            request_id: request_id.to_string(),
            run_id: "run-approval".to_string(),
            syscall: "shell.exec".to_string(),
            target: "gsv".to_string(),
            preview: ApprovalPreview::Shell {
                command: Some("pwd".to_string()),
            },
        };

        assert!(conversation.set_approval(request("request-1")));
        conversation.activity = Some("APPLYING".to_string());
        assert!(conversation.set_approval(request("request-1")));
        assert_eq!(conversation.activity.as_deref(), Some("APPLYING"));

        conversation.activity = Some("NOT APPLIED · TRY AGAIN".to_string());
        assert!(conversation.set_approval(request("request-1")));
        assert_eq!(
            conversation.activity.as_deref(),
            Some("NOT APPLIED · TRY AGAIN")
        );

        assert!(conversation.set_approval(request("request-2")));
        assert_eq!(conversation.activity.as_deref(), Some("APPROVAL REQUIRED"));
    }

    #[test]
    fn unknown_approval_input_falls_back_without_exposing_raw_arguments() {
        let missing_target = json!({
            "requestId": "request-unknown",
            "runId": "run-unknown",
            "toolName": "FutureDangerousTool",
            "syscall": "future.danger",
            "args": {
                "input": "do not expose this",
                "token": "private-token",
                "nested": { "secret": true }
            }
        });
        assert!(parse_pending_approval(&missing_target).is_none());
        let mut request = missing_target;
        request["target"] = json!("gsv");
        let approval = parse_pending_approval(&request).expect("valid guarded approval");

        assert_eq!(approval.target, "gsv");
        assert_eq!(approval.preview, ApprovalPreview::Unknown);
        assert_eq!(
            approval_prompt(&approval),
            "I want to perform a protected action on GSV."
        );
        assert_eq!(
            approval_scope_description(&approval),
            "“Always allow” covers future requests for this operation on this GSV in this conversation."
        );
        assert!(!approval_prompt(&approval).contains("do not expose this"));
        assert!(!approval_prompt(&approval).contains("private-token"));
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
            "target": "gsv",
            "args": { "input": "private" }
        }))
        .expect("valid approval");

        assert!(conversation.set_approval(approval));
        assert!(conversation.live_activity_entries().is_empty());
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
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::RunningCommands,
                count: 1,
            }]
        );
    }

    #[test]
    fn approval_hides_but_preserves_an_earlier_exact_execution() {
        let mut conversation = Conversation::connecting();
        conversation.start_run("run-1");
        assert!(conversation.set_live_activity(
            parse_tool_started_activity(&json!({
                "runId": "run-1",
                "callId": "background-read",
                "executionId": "execution-background",
                "syscall": "fs.read"
            }))
            .expect("valid exact start")
        ));
        let approval = parse_pending_approval(&json!({
            "requestId": "request-1",
            "runId": "run-1",
            "toolName": "Shell",
            "syscall": "shell.exec",
            "target": "gsv",
            "args": { "input": "private" }
        }))
        .expect("valid approval");

        assert!(conversation.set_approval(approval));
        assert_eq!(
            conversation.live_activity_entries(),
            vec![LiveActivityEntry {
                category: ActivityCategory::ReadingFiles,
                count: 1,
            }]
        );
        assert_eq!(conversation.activity.as_deref(), Some("APPROVAL REQUIRED"));

        let finish = parse_tool_finished_activity(&json!({
            "runId": "run-1",
            "callId": "background-read",
            "executionId": "execution-background",
            "outcome": "completed"
        }))
        .expect("valid exact finish");
        assert!(conversation.finish_live_activity(&finish));
        assert!(conversation.live_activity_entries().is_empty());
        assert_eq!(conversation.activity.as_deref(), Some("APPROVAL REQUIRED"));

        conversation.clear_approval();
        assert_eq!(conversation.activity.as_deref(), Some("THINKING"));
    }
}
