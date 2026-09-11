//! Transport-neutral history normalization.
//!
//! The client runs [`normalize_history`] on its background runtime before publishing a snapshot
//! to GPUI. The resulting graph is immutable and shares completed message bodies with both the
//! conversation model and the bounded content-preparation worker.

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{DefaultHasher, Hasher as _};
use std::io;
use std::sync::Arc;

use gateway_client::history::{
    HistoryAudience, HistoryDirection, HistoryEvent, HistoryOutcome, HistoryRecord,
    HistoryRecordData, HistorySeverity, ProcHistory,
};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;

use crate::content::{parse_media_attachments, MediaAttachment};
use crate::prepared::{content_revision, ContentRevision};

pub const MAX_FETCHED_HISTORY_MESSAGES: usize = 200;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct HistoryRevision(u64);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HistoryMomentRole {
    User,
    Intelligence,
    System,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HistoryActivityCategory {
    SearchingFiles,
    ReadingFiles,
    WritingFiles,
    EditingFiles,
    DeletingFiles,
    RunningCommands,
    RunningCode,
}

impl HistoryActivityCategory {
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

    fn summary_index(self) -> usize {
        match self {
            Self::SearchingFiles => 0,
            Self::ReadingFiles => 1,
            Self::WritingFiles => 2,
            Self::EditingFiles => 3,
            Self::DeletingFiles => 4,
            Self::RunningCommands => 5,
            Self::RunningCode => 6,
        }
    }

    fn unit(self) -> HistoryActivityUnit {
        match self {
            Self::ReadingFiles => HistoryActivityUnit::Reads,
            Self::RunningCommands => HistoryActivityUnit::Commands,
            Self::RunningCode => HistoryActivityUnit::Runs,
            Self::SearchingFiles
            | Self::WritingFiles
            | Self::EditingFiles
            | Self::DeletingFiles => HistoryActivityUnit::Operations,
        }
    }
}

const ACTIVITY_CATEGORIES: [HistoryActivityCategory; 7] = [
    HistoryActivityCategory::SearchingFiles,
    HistoryActivityCategory::ReadingFiles,
    HistoryActivityCategory::WritingFiles,
    HistoryActivityCategory::EditingFiles,
    HistoryActivityCategory::DeletingFiles,
    HistoryActivityCategory::RunningCommands,
    HistoryActivityCategory::RunningCode,
];

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HistoryActivityUnit {
    Operations,
    Reads,
    Commands,
    Runs,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryActivitySummaryEntry {
    pub category: HistoryActivityCategory,
    pub count: u64,
    pub unit: HistoryActivityUnit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryActivitySummary {
    pub moment_id: Arc<str>,
    pub entries: Arc<[HistoryActivitySummaryEntry]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HistoryToolCallState {
    Pending,
    Terminal { message_id: Arc<str> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryToolCallStateEntry {
    pub run_id: Arc<str>,
    pub call_id: Arc<str>,
    pub state: HistoryToolCallState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryActivity {
    pub summaries: Arc<[HistoryActivitySummary]>,
    pub latest_call_states: Arc<[HistoryToolCallStateEntry]>,
    pub authoritative: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryMoment {
    pub id: Arc<str>,
    pub role: HistoryMomentRole,
    pub event_severity: Option<HistorySeverity>,
    pub selected_target: Option<Arc<str>>,
    pub text: Arc<str>,
    pub render_text: Arc<str>,
    pub media: Arc<Vec<MediaAttachment>>,
    pub run_id: Option<Arc<str>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HistoryApprovalPreview {
    Shell {
        command: Option<Arc<str>>,
    },
    Delete {
        path: Option<Arc<str>>,
    },
    Fetch {
        method: Option<Arc<str>>,
        url: Option<Arc<str>>,
    },
    Mcp {
        tool: Option<Arc<str>>,
    },
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryPendingApproval {
    pub request_id: Arc<str>,
    pub run_id: Arc<str>,
    pub syscall: Arc<str>,
    pub target: Arc<str>,
    pub preview: HistoryApprovalPreview,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryPreparationCandidate {
    pub id: Arc<str>,
    pub revision: ContentRevision,
    pub media_revision: ContentRevision,
    pub text: Arc<str>,
    /// GPUI-compatible immutable text prepared off the foreground thread. This intentionally
    /// avoids copying a large history message every time its moment is painted.
    pub render_text: Arc<str>,
    pub media: Arc<Vec<MediaAttachment>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistorySnapshot {
    pub revision: HistoryRevision,
    pub active_run_id: Option<Arc<str>>,
    pub pending_approval: Option<HistoryPendingApproval>,
    pub moments: Arc<[HistoryMoment]>,
    pub activity: HistoryActivity,
    pub preparation_candidates: Arc<[HistoryPreparationCandidate]>,
    pub message_count: Option<u64>,
    pub truncated: bool,
    pub has_more_before: Option<bool>,
    pub has_more_after: Option<bool>,
    pub sync: HistorySync,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistorySync {
    pub revision: u64,
    pub generation: u64,
    pub reset_revision: u64,
    pub reset: bool,
    pub has_more: bool,
    pub cursor: Option<String>,
}

struct IndexedHistoryMessage<'a> {
    id: Arc<str>,
    value: &'a HistoryRecord,
}

/// Normalize one `proc.history` response without performing Markdown parsing or GPUI layout.
pub fn normalize_history(payload: &ProcHistory) -> HistorySnapshot {
    let mut groups = Vec::new();
    let mut seen = HashSet::new();
    for record in &payload.records {
        if seen.insert(record.message_id) {
            groups.push(record.message_id);
        }
    }
    let dropped_messages = groups.len().saturating_sub(MAX_FETCHED_HISTORY_MESSAGES);
    let visible_groups = groups[dropped_messages..]
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    let records = payload
        .records
        .iter()
        .filter(|record| visible_groups.contains(&record.message_id))
        .collect::<Vec<_>>();
    let messages = canonical_history_messages(&records);
    let has_compaction_marker = messages.iter().any(|message| {
        matches!(&message.value.data,
        HistoryRecordData::Event(event) if event.kind == "history.compacted"
                || (event.kind == "legacy" && event.payload.get("recognizedKind").and_then(Value::as_str) == Some("history.compacted")))
    });
    let activity = derive_history_activity(
        payload,
        &messages,
        dropped_messages,
        visible_groups.len(),
        has_compaction_marker,
    );
    let summary_owners = activity
        .summaries
        .iter()
        .filter(|summary| !summary.entries.is_empty())
        .map(|summary| summary.moment_id.clone())
        .collect::<HashSet<_>>();
    let mut moments = Vec::new();
    let mut preparation_candidates = Vec::new();
    for message in messages {
        let (role, text, media) = match &message.value.data {
            HistoryRecordData::Message(payload) => (
                match payload.direction {
                    HistoryDirection::In => HistoryMomentRole::User,
                    HistoryDirection::Out => HistoryMomentRole::Intelligence,
                },
                payload.text.clone(),
                &payload.media,
            ),
            HistoryRecordData::Note(payload) => (
                HistoryMomentRole::Intelligence,
                payload.text.clone(),
                &payload.media,
            ),
            HistoryRecordData::Event(event) if event.audience != HistoryAudience::Model => {
                let text: Arc<str> = Arc::from(render_history_event(event));
                moments.push(HistoryMoment {
                    id: message.id,
                    role: HistoryMomentRole::System,
                    event_severity: Some(event.severity),
                    selected_target: None,
                    text: text.clone(),
                    render_text: text,
                    media: Arc::new(Vec::new()),
                    run_id: message.value.run_id.as_deref().map(Arc::from),
                });
                continue;
            }
            _ => continue,
        };
        append_moment(
            &mut moments,
            &mut preparation_candidates,
            message.id.clone(),
            role,
            text,
            parse_media_attachments(&Value::Array(media.clone())),
            message.value.run_id.as_deref().map(Arc::from),
            &summary_owners,
        );
        if let HistoryRecordData::Message(payload) = &message.value.data {
            if let Some(moment) = moments.last_mut().filter(|moment| moment.id == message.id) {
                moment.selected_target = payload.selected_target.as_deref().map(Arc::from);
            }
        }
    }
    HistorySnapshot {
        revision: history_revision(payload),
        active_run_id: payload
            .active_run_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .map(Arc::from),
        pending_approval: payload
            .pending_hil
            .as_ref()
            .and_then(parse_pending_approval),
        moments: moments.into(),
        activity,
        preparation_candidates: preparation_candidates.into(),
        message_count: Some(payload.message_count),
        truncated: dropped_messages > 0 || payload.truncated,
        has_more_before: payload.has_more_before,
        has_more_after: payload.has_more_after,
        sync: HistorySync {
            revision: payload.history_revision,
            generation: payload.history_generation,
            reset_revision: payload.history_reset_revision,
            reset: payload.reset,
            has_more: payload.has_more,
            cursor: payload.cursor.clone(),
        },
    }
}

fn render_history_event(event: &HistoryEvent) -> String {
    if event.kind == "target.connection" {
        if let (Some(target), Some(change @ ("connected" | "disconnected"))) = (
            event.payload.get("targetId").and_then(Value::as_str),
            event.payload.get("event").and_then(Value::as_str),
        ) {
            let label = event
                .payload
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty() && *label != target);
            return match label {
                Some(label) => format!("{label} ({target}) {change}."),
                None => format!("{target} {change}."),
            };
        }
    }
    format!(
        "{}\n{}",
        event.kind,
        serde_json::to_string_pretty(&event.payload).unwrap_or_default()
    )
}

#[allow(clippy::too_many_arguments)]
fn append_moment(
    moments: &mut Vec<HistoryMoment>,
    candidates: &mut Vec<HistoryPreparationCandidate>,
    id: Arc<str>,
    role: HistoryMomentRole,
    text: String,
    media: Vec<MediaAttachment>,
    run_id: Option<Arc<str>>,
    summary_owners: &HashSet<Arc<str>>,
) {
    let text: Arc<str> = Arc::from(text);
    let media = Arc::new(media);
    if role == HistoryMomentRole::Intelligence {
        candidates.push(HistoryPreparationCandidate {
            id: id.clone(),
            revision: content_revision(&text, &media),
            media_revision: content_revision("", &media),
            text: text.clone(),
            render_text: text.clone(),
            media: media.clone(),
        });
    }
    if text.trim().is_empty() && media.is_empty() && !summary_owners.contains(&id) {
        return;
    }
    moments.push(HistoryMoment {
        id,
        role,
        event_severity: None,
        selected_target: None,
        text: text.clone(),
        render_text: text,
        media,
        run_id,
    });
}

pub fn normalize_conversation_history(
    conversation: &Value,
    process: &ProcHistory,
) -> HistorySnapshot {
    let activity = normalize_history(process);
    let mut moments = Vec::new();
    let mut preparation_candidates = Vec::new();
    let mut times = HashMap::<Arc<str>, f64>::new();
    let notices = process
        .records
        .iter()
        .filter_map(|record| match &record.data {
            HistoryRecordData::Event(event) if event.audience != HistoryAudience::Model => {
                Some((record, event))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let conversation_id = conversation
        .get("conversation")
        .and_then(|summary| summary.get("id"))
        .and_then(Value::as_str);
    let notice_messages = notices
        .iter()
        .filter_map(|(_, event)| {
            if event.kind != "correction.exhausted"
                || event
                    .payload
                    .get("conversationId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| Some(id) != conversation_id)
            {
                return None;
            }
            event
                .payload
                .get("messageId")
                .and_then(Value::as_str)
                .map(|id| (id, event.severity))
        })
        .collect::<HashMap<_, _>>();
    let all_messages = conversation
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let dropped = all_messages
        .len()
        .saturating_sub(MAX_FETCHED_HISTORY_MESSAGES);
    let mut canonical_ids = HashSet::new();
    for message in &all_messages[dropped..] {
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            continue;
        };
        canonical_ids.insert(id);
        times.insert(
            Arc::from(id),
            message
                .get("createdAt")
                .and_then(Value::as_f64)
                .unwrap_or_default(),
        );
        let role = if notice_messages.contains_key(id) {
            HistoryMomentRole::System
        } else if message
            .get("author")
            .and_then(|author| author.get("kind"))
            .and_then(Value::as_str)
            == Some("user")
        {
            HistoryMomentRole::User
        } else {
            HistoryMomentRole::Intelligence
        };
        append_moment(
            &mut moments,
            &mut preparation_candidates,
            Arc::from(id),
            role,
            message
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            message
                .get("media")
                .map(parse_media_attachments)
                .unwrap_or_default(),
            message.get("runId").and_then(Value::as_str).map(Arc::from),
            &HashSet::new(),
        );
        if let Some(moment) = moments.last_mut().filter(|moment| moment.id.as_ref() == id) {
            moment.event_severity = notice_messages.get(id).copied();
            moment.selected_target = message
                .get("selectedTarget")
                .and_then(Value::as_str)
                .map(Arc::from);
        }
    }
    let raw_run_by_moment = activity
        .moments
        .iter()
        .filter_map(|moment| Some((moment.id.as_ref(), moment.run_id.as_deref()?)))
        .collect::<HashMap<_, _>>();
    let canonical_moment_by_run = moments
        .iter()
        .filter(|moment| moment.role == HistoryMomentRole::Intelligence)
        .filter_map(|moment| Some((moment.run_id.as_deref()?, moment.id.clone())))
        .collect::<HashMap<_, _>>();
    let summaries = activity
        .activity
        .summaries
        .iter()
        .filter_map(|summary| {
            let run_id = raw_run_by_moment.get(summary.moment_id.as_ref())?;
            Some(HistoryActivitySummary {
                moment_id: canonical_moment_by_run.get(run_id)?.clone(),
                entries: summary.entries.clone(),
            })
        })
        .collect::<Vec<_>>();
    // Process notices stay explicitly system-owned, separate from committed conversation messages.
    let notices_by_id = notices
        .into_iter()
        .map(|(record, event)| (record_identity(record), (record, event)))
        .collect::<HashMap<_, _>>();
    let mut pending_notices = Vec::new();
    for moment in activity
        .moments
        .iter()
        .filter(|moment| moment.role == HistoryMomentRole::System)
    {
        let Some((record, event)) = notices_by_id.get(&moment.id) else {
            continue;
        };
        if event.kind == "correction.exhausted"
            && event
                .payload
                .get("messageId")
                .and_then(Value::as_str)
                .is_some_and(|id| canonical_ids.contains(id) && notice_messages.contains_key(id))
        {
            continue;
        }
        let mut moment = moment.clone();
        moment.id = Arc::from(format!(
            "process:{}:{}:{}",
            process.pid, record.generation, moment.id
        ));
        pending_notices.push((record.created_at, moment));
    }
    pending_notices.sort_by(|left, right| left.0.total_cmp(&right.0));
    for (created_at, moment) in pending_notices {
        let position = moments
            .iter()
            .position(|existing| times[&existing.id] > created_at)
            .unwrap_or(moments.len());
        times.insert(moment.id.clone(), created_at);
        moments.insert(position, moment);
    }
    HistorySnapshot {
        revision: history_revision(&(conversation, process)),
        active_run_id: activity.active_run_id,
        pending_approval: activity.pending_approval,
        moments: moments.into(),
        preparation_candidates: preparation_candidates.into(),
        activity: HistoryActivity {
            summaries: summaries.into(),
            latest_call_states: activity.activity.latest_call_states,
            authoritative: activity.activity.authoritative,
        },
        message_count: conversation
            .get("conversation")
            .and_then(|summary| summary.get("latestSequence"))
            .and_then(Value::as_u64),
        truncated: dropped > 0
            || conversation.get("hasMore").and_then(Value::as_bool) == Some(true),
        has_more_before: if dropped > 0 {
            Some(true)
        } else {
            conversation.get("hasMore").and_then(Value::as_bool)
        },
        has_more_after: Some(false),
        sync: activity.sync,
    }
}

/// Message ids are process-history identities. A repeated id is an invalid transport record, but
/// retaining the latest occurrence gives reconnecting clients a deterministic, internally
/// consistent snapshot without allowing two different bodies to share one presentation key.
fn canonical_history_messages<'a>(
    messages: &[&'a HistoryRecord],
) -> Vec<IndexedHistoryMessage<'a>> {
    let indexed = messages
        .iter()
        .map(|value| IndexedHistoryMessage {
            id: record_identity(value),
            value,
        })
        .collect::<Vec<_>>();
    let latest = indexed
        .iter()
        .enumerate()
        .map(|(position, message)| (message.id.clone(), position))
        .collect::<HashMap<_, _>>();
    indexed
        .into_iter()
        .enumerate()
        .filter_map(|(position, message)| {
            (latest.get(&message.id) == Some(&position)).then_some(message)
        })
        .collect()
}

fn record_identity(record: &HistoryRecord) -> Arc<str> {
    Arc::from(if record.index == 0 {
        record.message_id.to_string()
    } else {
        format!("{}:{}", record.message_id, record.index)
    })
}

fn derive_history_activity(
    payload: &ProcHistory,
    messages: &[IndexedHistoryMessage<'_>],
    index_offset: usize,
    visible_message_count: usize,
    has_compaction_marker: bool,
) -> HistoryActivity {
    let authoritative = index_offset == 0
        && history_is_authoritative(payload, visible_message_count)
        && !has_compaction_marker;
    let mut calls =
        HashMap::<(Arc<str>, Arc<str>), VecDeque<Option<HistoryActivityCategory>>>::new();
    let mut latest_call_states = HashMap::<(Arc<str>, Arc<str>), HistoryToolCallState>::new();
    let mut run_boundaries = HashSet::<Arc<str>>::new();
    let mut runs_with_call_context = HashSet::<Arc<str>>::new();
    let mut incomplete_runs = HashSet::<Arc<str>>::new();
    let mut pending_counts = HashMap::<Arc<str>, [u64; ACTIVITY_CATEGORIES.len()]>::new();
    let mut summaries = Vec::new();
    let call_groups = messages
        .iter()
        .filter_map(|message| match &message.value.data {
            HistoryRecordData::Call(call) if call.syscall.is_some() => {
                Some(message.value.message_id)
            }
            _ => None,
        })
        .collect::<HashSet<_>>();
    for message in messages {
        let Some(run_id) = message
            .value
            .run_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .map(Arc::<str>::from)
        else {
            continue;
        };
        match &message.value.data {
            HistoryRecordData::Message(payload) if payload.direction == HistoryDirection::In => {
                run_boundaries.insert(run_id);
            }
            HistoryRecordData::Call(call) => {
                runs_with_call_context.insert(run_id.clone());
                if call.syscall.is_none() {
                    continue;
                }
                let category = call
                    .syscall
                    .as_deref()
                    .and_then(HistoryActivityCategory::from_syscall);
                let key = (run_id, Arc::from(call.call_id.as_str()));
                calls.entry(key.clone()).or_default().push_back(category);
                latest_call_states.insert(key, HistoryToolCallState::Pending);
            }
            HistoryRecordData::Note(_) if !call_groups.contains(&message.value.message_id) => {
                if incomplete_runs.contains(&run_id) {
                    pending_counts.remove(&run_id);
                    continue;
                }
                let entries = pending_counts
                    .remove(&run_id)
                    .map(summary_entries)
                    .unwrap_or_default();
                if authoritative || !entries.is_empty() {
                    summaries.push(HistoryActivitySummary {
                        moment_id: message.id.clone(),
                        entries: entries.into(),
                    });
                }
            }
            HistoryRecordData::Result(result) => {
                let key = (run_id.clone(), Arc::<str>::from(result.call_id.as_str()));
                let correlated = calls.get_mut(&key).and_then(VecDeque::pop_front);
                if correlated.is_some() && calls.get(&key).is_none_or(VecDeque::is_empty) {
                    latest_call_states.insert(
                        key,
                        HistoryToolCallState::Terminal {
                            message_id: message.id.clone(),
                        },
                    );
                }
                if !authoritative && !run_boundaries.contains(&run_id) {
                    incomplete_runs.insert(run_id.clone());
                    pending_counts.remove(&run_id);
                    continue;
                }
                if result.outcome != HistoryOutcome::Completed {
                    continue;
                }
                let category = correlated.flatten().or_else(|| {
                    (!runs_with_call_context.contains(&run_id))
                        .then(|| HistoryActivityCategory::from_tool_name(&result.tool))
                        .flatten()
                });
                let Some(category) = category else {
                    continue;
                };
                let counts = pending_counts.entry(run_id).or_default();
                let index = category.summary_index();
                counts[index] = counts[index].saturating_add(1);
            }
            _ => {}
        }
    }
    let mut latest_call_states = latest_call_states
        .into_iter()
        .map(|((run_id, call_id), state)| HistoryToolCallStateEntry {
            run_id,
            call_id,
            state,
        })
        .collect::<Vec<_>>();
    latest_call_states
        .sort_by(|left, right| (&left.run_id, &left.call_id).cmp(&(&right.run_id, &right.call_id)));
    HistoryActivity {
        summaries: summaries.into(),
        latest_call_states: latest_call_states.into(),
        authoritative,
    }
}

fn history_is_authoritative(payload: &ProcHistory, visible_message_count: usize) -> bool {
    if payload.truncated
        || payload.has_more
        || payload.has_more_before == Some(true)
        || payload.has_more_after == Some(true)
    {
        return false;
    }
    if payload.has_more_before.is_some() || payload.has_more_after.is_some() {
        return payload.has_more_before == Some(false) && payload.has_more_after == Some(false);
    }
    payload.message_count == visible_message_count as u64
}

fn summary_entries(counts: [u64; ACTIVITY_CATEGORIES.len()]) -> Vec<HistoryActivitySummaryEntry> {
    ACTIVITY_CATEGORIES
        .into_iter()
        .enumerate()
        .filter_map(|(index, category)| {
            let count = counts[index];
            (count > 0).then_some(HistoryActivitySummaryEntry {
                category,
                count,
                unit: category.unit(),
            })
        })
        .collect()
}

fn parse_pending_approval(value: &Value) -> Option<HistoryPendingApproval> {
    let syscall: Arc<str> = Arc::from(
        value
            .get("syscall")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let target = value.get("target")?.as_str()?.trim();
    if target.is_empty() {
        return None;
    }
    Some(HistoryPendingApproval {
        request_id: Arc::from(value.get("requestId")?.as_str()?),
        run_id: Arc::from(
            value
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        target: Arc::from(target),
        preview: history_approval_preview(&syscall, value.get("args")),
        syscall,
    })
}

fn history_approval_preview(syscall: &str, args: Option<&Value>) -> HistoryApprovalPreview {
    let record = args.and_then(Value::as_object);
    let field = |key| {
        record
            .and_then(|args| args.get(key))
            .and_then(Value::as_str)
            .map(Arc::from)
    };
    match syscall {
        "shell.exec" => HistoryApprovalPreview::Shell {
            command: field("input"),
        },
        "fs.delete" => HistoryApprovalPreview::Delete {
            path: field("path"),
        },
        "net.fetch" => HistoryApprovalPreview::Fetch {
            method: field("method"),
            url: field("url"),
        },
        "sys.mcp.call" => HistoryApprovalPreview::Mcp {
            tool: field("name"),
        },
        _ => HistoryApprovalPreview::Unknown,
    }
}

fn history_revision(payload: &impl serde::Serialize) -> HistoryRevision {
    let mut hasher = DefaultHasher::new();
    let _ = serde_json::to_writer(HashWriter(&mut hasher), payload);
    HistoryRevision(hasher.finish())
}

struct HashWriter<'a>(&'a mut DefaultHasher);

impl io::Write for HashWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.write(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn fixture(mut payload: Value) -> ProcHistory {
    let envelope = payload.as_object_mut().expect("fixture envelope");
    let records = envelope
        .entry("records")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .expect("records");
    let mut groups = HashSet::new();
    for (ordinal, record) in records.iter_mut().enumerate() {
        let record = record.as_object_mut().expect("record");
        let id = record
            .get("id")
            .cloned()
            .unwrap_or_else(|| json!(ordinal + 1));
        groups.insert(record.get("messageId").unwrap_or(&id).to_string());
        record.entry("id").or_insert(id.clone());
        record.entry("messageId").or_insert(id);
        record.entry("index").or_insert(json!(0));
        record.entry("generation").or_insert(json!(0));
        record.entry("runId").or_insert(Value::Null);
        record.entry("createdAt").or_insert(json!(0));
        record.entry("source").or_insert(json!("typed"));
    }
    envelope
        .entry("messageCount")
        .or_insert(json!(groups.len()));
    for (key, value) in [
        ("ok", json!(true)),
        ("format", json!(2)),
        ("pid", json!("fixture-pid")),
        ("historyRevision", json!(0)),
        ("historyGeneration", json!(0)),
        ("historyResetRevision", json!(0)),
        ("reset", json!(false)),
        ("hasMore", json!(false)),
    ] {
        envelope.entry(key).or_insert(value);
    }
    ProcHistory::decode(payload).expect("valid format-2 fixture")
}

#[cfg(test)]
pub(crate) fn normalize_fixture(payload: &Value) -> HistorySnapshot {
    normalize_history(&fixture(payload.clone()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn selected_targets_reach_native_moments_from_each_history_owner() {
        let process = super::fixture(json!({"records":[
            {"kind":"message","payload":{"direction":"in","text":"  inspect this\n","media":[],"origin":{},"selectedTarget":"macbook"}},
            {"kind":"message","payload":{"direction":"in","text":"another message","media":[],"origin":{}}}
        ]}));
        let raw = super::normalize_history(&process);
        let raw_moments = crate::model::moments_from_history(&raw);
        assert_eq!(raw_moments[0].selected_target.as_deref(), Some("macbook"));
        assert_eq!(raw_moments[0].text.as_ref(), "  inspect this\n");
        assert_eq!(raw_moments[1].selected_target, None);

        let canonical = json!({"conversation":{"id":"c"},"messages":[
            {"id":"first","author":{"kind":"user"},"text":"  inspect this\n","selectedTarget":"gsv"},
            {"id":"second","author":{"kind":"user"},"text":"another message"}
        ]});
        let snapshot = super::normalize_conversation_history(&canonical, &process);
        let moments = crate::model::moments_from_history(&snapshot);
        assert_eq!(moments[0].selected_target.as_deref(), Some("gsv"));
        assert_eq!(moments[0].text.as_ref(), "  inspect this\n");
        assert_eq!(moments[1].selected_target, None);

        let mut changed = process.clone();
        if let gateway_client::history::HistoryRecordData::Message(message) =
            &mut changed.records[0].data
        {
            message.selected_target = Some("different-target".to_string());
        }
        assert_ne!(raw.revision, super::normalize_history(&changed).revision);
    }

    use super::*;

    #[test]
    fn normalization_is_typed_bounded_and_precomputes_each_assistant_revision_once() {
        let messages = (0..MAX_FETCHED_HISTORY_MESSAGES + 5)
            .map(|index| {
                json!({ "id": index, "runId": format!("run-{index}"), "index": 0, "kind": "note", "payload": { "text": format!("reply {index}"), "thinking": [], "media": [] } })
            })
            .collect::<Vec<_>>();
        let payload = json!({
            "records": messages,
            "messageCount": MAX_FETCHED_HISTORY_MESSAGES + 5,
            "truncated": false,
            "activeRunId": "run-live"
        });

        let snapshot = normalize_fixture(&payload);

        assert_eq!(snapshot.moments.len(), MAX_FETCHED_HISTORY_MESSAGES);
        assert_eq!(
            snapshot.preparation_candidates.len(),
            MAX_FETCHED_HISTORY_MESSAGES
        );
        assert_eq!(snapshot.moments[0].id.as_ref(), "5");
        assert_eq!(snapshot.active_run_id.as_deref(), Some("run-live"));
        assert!(snapshot.truncated);
        assert!(!snapshot.activity.authoritative);
        let candidate = snapshot
            .preparation_candidates
            .last()
            .expect("latest assistant candidate");
        assert_eq!(
            candidate.revision,
            content_revision(candidate.text.as_ref(), candidate.media.as_slice())
        );
        assert_eq!(
            candidate.media_revision,
            content_revision("", candidate.media.as_slice())
        );
        assert!(Arc::ptr_eq(
            &snapshot.moments.last().expect("latest moment").text,
            &candidate.text,
        ));
        assert!(Arc::ptr_eq(
            &snapshot.moments.last().expect("latest moment").media,
            &candidate.media,
        ));
    }

    #[test]
    fn normalization_keeps_activity_and_approval_content_out_of_the_ui_parser() {
        let payload = json!({
                    "records": [
                        { "id": 1, "runId": "run-1", "index": 0, "kind": "message", "payload": { "direction": "in", "text": "Do both", "media": [], "origin": {} } },
                        { "id": 2, "runId": "run-1", "index": 0, "kind": "call", "payload": { "callId": "read-a", "tool": "Read", "syscall": "fs.read", "target": null, "runId": "run-1", "args": { "path": "/private/a" } } },
        { "id": 2, "runId": "run-1", "index": 1, "kind": "call", "payload": { "callId": "read-b", "tool": "Read", "syscall": "fs.read", "target": null, "runId": "run-1", "args": { "path": "/private/b" } } },
                        { "id": 3, "runId": "run-1", "index": 0, "kind": "result", "payload": { "callId": "read-a", "tool": "Read", "outcome": "completed", "output": "private", "media": [], "resources": [] } },
                        { "id": 4, "runId": "run-1", "index": 0, "kind": "result", "payload": { "callId": "read-b", "tool": "Read", "outcome": "completed", "output": "private", "media": [], "resources": [] } },
                        { "id": 5, "runId": "run-1", "index": 0, "kind": "note", "payload": { "text": "Done", "thinking": [], "media": [] } }
                    ],
                    "truncated": false,
                    "pendingHil": {
                        "requestId": "approval-1",
                        "runId": "run-1",
                        "syscall": "shell.exec",
                        "target": "gsv",
                        "args": { "input": "  printf   private  " }
                    }
                });

        let snapshot = normalize_fixture(&payload);

        assert_eq!(snapshot.activity.summaries.len(), 1);
        assert_eq!(snapshot.activity.summaries[0].moment_id.as_ref(), "5");
        assert_eq!(
            snapshot.activity.summaries[0].entries.as_ref(),
            &[HistoryActivitySummaryEntry {
                category: HistoryActivityCategory::ReadingFiles,
                count: 2,
                unit: HistoryActivityUnit::Reads,
            }]
        );
        assert!(matches!(
            snapshot.pending_approval.as_ref(),
            Some(HistoryPendingApproval {
                target,
                preview: HistoryApprovalPreview::Shell {
                    command: Some(command),
                },
                ..
            }) if target.as_ref() == "gsv" && command.as_ref() == "  printf   private  "
        ));
        assert_eq!(
            snapshot
                .pending_approval
                .as_ref()
                .map(|approval| approval.syscall.as_ref()),
            Some("shell.exec")
        );
        assert!(!format!("{:?}", snapshot.activity).contains("private"));
    }

    #[test]
    fn revision_changes_with_transport_visible_history_state() {
        let first = normalize_fixture(&json!({
            "records": [{ "id": 1, "index": 0, "kind": "note", "payload": { "text": "one", "thinking": [], "media": [] } }],
            "activeRunId": null
        }));
        let same = normalize_fixture(&json!({
            "records": [{ "id": 1, "index": 0, "kind": "note", "payload": { "text": "one", "thinking": [], "media": [] } }],
            "activeRunId": null
        }));
        let changed = normalize_fixture(&json!({
            "records": [{ "id": 1, "index": 0, "kind": "note", "payload": { "text": "two", "thinking": [], "media": [] } }],
            "activeRunId": null
        }));

        assert_eq!(first.revision, same.revision);
        assert_ne!(first.revision, changed.revision);
    }

    #[test]
    fn duplicate_message_ids_keep_only_the_latest_record_and_its_preparation() {
        let snapshot = normalize_fixture(&json!({
            "records": [
                { "id": 103, "runId": "run-old", "index": 0, "kind": "note", "payload": { "text": "# stale response", "thinking": [], "media": [{
                            "type": "image",
                            "mimeType": "image/png",
                            "url": "https://example.com/stale.png"
                        }] } },
                { "id": 101, "runId": "run-live", "index": 0, "kind": "message", "payload": { "direction": "in", "text": "between", "media": [], "origin": {} } },
                { "id": 102, "runId": "run-live", "index": 0, "kind": "note", "payload": { "text": "other", "thinking": [], "media": [] } },
                { "id": 103, "runId": "run-live", "index": 0, "kind": "note", "payload": { "text": "# latest response", "thinking": [], "media": [{
                            "type": "image",
                            "mimeType": "image/png",
                            "url": "https://example.com/latest.png"
                        }] } }
            ],
            "messageCount": 4,
            "truncated": false,
            "hasMoreBefore": false,
            "hasMoreAfter": false,
            "activeRunId": "run-live"
        }));

        assert_eq!(
            snapshot
                .moments
                .iter()
                .map(|moment| moment.id.as_ref())
                .collect::<Vec<_>>(),
            ["101", "102", "103"]
        );
        assert_eq!(snapshot.preparation_candidates.len(), 2);
        assert_eq!(
            snapshot
                .preparation_candidates
                .iter()
                .map(|candidate| candidate.id.as_ref())
                .collect::<Vec<_>>(),
            ["102", "103"]
        );
        assert_eq!(snapshot.message_count, Some(4));
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.has_more_before, Some(false));
        assert_eq!(snapshot.has_more_after, Some(false));
        assert_eq!(snapshot.active_run_id.as_deref(), Some("run-live"));
        assert!(snapshot.activity.authoritative);

        for candidate in snapshot.preparation_candidates.iter() {
            let moment = snapshot
                .moments
                .iter()
                .find(|moment| moment.id == candidate.id)
                .expect("every preparation must own the surviving moment body");
            assert!(Arc::ptr_eq(&moment.text, &candidate.text));
            assert!(Arc::ptr_eq(&moment.render_text, &candidate.render_text));
            assert!(Arc::ptr_eq(&moment.media, &candidate.media));
            assert_eq!(
                candidate.revision,
                content_revision(moment.text.as_ref(), moment.media.as_slice())
            );
        }

        let latest = snapshot
            .preparation_candidates
            .last()
            .expect("latest assistant preparation");
        assert_eq!(latest.id.as_ref(), "103");
        assert_eq!(latest.text.as_ref(), "# latest response");
        assert_eq!(
            latest.media[0].url.as_deref(),
            Some("https://example.com/latest.png")
        );
        assert!(snapshot
            .moments
            .iter()
            .all(|moment| !moment.text.contains("stale response")));
    }

    #[test]
    fn conversation_history_attaches_process_activity_to_the_canonical_message() {
        let conversation = json!({
            "conversation": { "latestSequence": 2 },
            "messages": [
                {
                    "id": "conversation-user",
                    "runId": "run-1",
                    "author": { "kind": "user" },
                    "text": "inspect it",
                    "createdAt": 1
                },
                {
                    "id": "conversation-answer",
                    "runId": "run-1",
                    "author": { "kind": "process" },
                    "text": "done",
                    "createdAt": 2
                }
            ],
            "hasMore": false
        });
        let process = json!({
                    "records": [
                        { "id": 1, "runId": "run-1", "index": 0, "kind": "message", "payload": { "direction": "in", "text": "inspect it", "media": [], "origin": {} } },
                        { "id": 2, "runId": "run-1", "index": 0, "kind": "call", "payload": { "callId": "shell-1", "tool": "Shell", "syscall": "shell.exec", "target": null, "runId": "run-1", "args": { "input": "pwd" } } },
                        { "id": 3, "runId": "run-1", "index": 0, "kind": "result", "payload": { "callId": "shell-1", "tool": "Shell", "outcome": "completed", "output": "ok", "media": [], "resources": [] } },
                        { "id": 4, "runId": "run-1", "index": 0, "kind": "note", "payload": { "text": "done", "thinking": [], "media": [] } },
        { "id": 4, "runId": "run-1", "index": 1, "kind": "call", "payload": { "callId": "message-1", "tool": "Message", "syscall": null, "target": null, "runId": "run-1", "args": { "text": "done" } } }
                    ],
                    "messageCount": 4,
                    "truncated": false,
                    "hasMoreBefore": false,
                    "hasMoreAfter": false
                });

        let snapshot = normalize_conversation_history(&conversation, &fixture(process));

        assert_eq!(snapshot.activity.summaries.len(), 1);
        assert_eq!(
            snapshot.activity.summaries[0].moment_id.as_ref(),
            "conversation-answer"
        );
        assert_eq!(snapshot.activity.summaries[0].entries[0].count, 1);
    }
    #[test]
    fn typed_groups_keep_every_member_and_run_control_is_not_shell_activity() {
        let history = fixture(
            json!({"truncated":false,"historyRevision":9,"historyGeneration":3,
                "historyResetRevision":6,"reset":true,"cursor":"opaque", "records":[
                {"id":1,"runId":"r","kind":"message","payload":{"direction":"in","text":"hello","media":[],"origin":{}}},
                {"id":2,"messageId":2,"index":0,"runId":"r","kind":"note","payload":{"text":"draft","thinking":[]}},
                {"id":3,"messageId":2,"index":1,"runId":"r","kind":"call","payload":{"callId":"c","tool":"Shell",
                    "syscall":null,"args":{"input":"message send hello && yield"},"target":null,"runId":"r"}},
                {"id":4,"runId":"r","kind":"result","payload":{"callId":"c","tool":"Shell","outcome":"completed",
                    "output":{"action":"send","finish":true,"delivery":{"messageId":"m"}},"media":[],"resources":[]}},
                {"id":5,"runId":"r","kind":"note","payload":{"text":"after","thinking":[]}}
            ]}),
        );
        let snapshot = normalize_history(&history);
        assert_eq!(snapshot.moments.len(), 3);
        assert_eq!(snapshot.moments[1].id.as_ref(), "2");
        assert!(snapshot.activity.latest_call_states.is_empty());
        assert!(snapshot
            .activity
            .summaries
            .iter()
            .all(|summary| summary.entries.is_empty()));
        assert_eq!(snapshot.sync.revision, 9);
        assert_eq!(snapshot.sync.generation, 3);
        assert_eq!(snapshot.sync.reset_revision, 6);
        assert!(snapshot.sync.reset);
        assert_eq!(snapshot.sync.cursor.as_deref(), Some("opaque"));
    }

    #[test]
    fn canonical_messages_ignore_drafts_and_keep_person_notices_as_system_moments() {
        let process = fixture(json!({"truncated":false,"records":[
            {"id":1,"runId":"r","kind":"note","payload":{"text":"uncommitted draft","thinking":[]}},
            {"id":2,"runId":"r","kind":"message","payload":{"direction":"out","text":"compatibility copy",
                "media":[],"origin":{},"conversationMessageId":"m"}},
            {"id":3,"runId":"r","kind":"event","payload":{"kind":"correction.exhausted",
                "payload":{"attempts":3,"limit":3},"severity":"warn","audience":"person"}},
            {"id":4,"runId":"r","kind":"event","payload":{"kind":"correction.text-only",
                "payload":{"attempt":1,"limit":3},"severity":"warn","audience":"model"}}
        ]}));
        let canonical = json!({"conversation":{"latestSequence":1},"hasMore":false,"messages":[
            {"id":"m","runId":"r","author":{"kind":"process"},"text":"  committed text\n","media":[
                {"type":"resource","ref":{"type":"file","target":"gsv","path":"/home/a/picture.png",
                "revision":"immutable-revision","contentType":"image/png","size":42},"mediaType":"image"}]}]});
        let snapshot = normalize_conversation_history(&canonical, &process);
        assert_eq!(snapshot.moments.len(), 2);
        assert_eq!(snapshot.moments[0].text.as_ref(), "  committed text\n");
        assert_eq!(
            snapshot.moments[0].media[0]
                .resource
                .as_ref()
                .expect("resource")
                .revision,
            "immutable-revision"
        );
        assert_eq!(snapshot.moments[1].role, HistoryMomentRole::System);
        assert!(snapshot.moments[1].text.starts_with("correction.exhausted"));
        assert!(Arc::ptr_eq(
            &snapshot.moments[1].text,
            &snapshot.moments[1].render_text
        ));
        assert!(snapshot
            .moments
            .iter()
            .all(|moment| !moment.text.contains("uncommitted")
                && !moment.text.contains("correction.text-only")));
    }
    #[test]
    fn notices_keep_chronological_position_and_committed_notice_identity() {
        let process = fixture(json!({"truncated":false,"records":[
            {"id":1,"createdAt":5,"kind":"event","payload":{"kind":"delivery.failed",
                "payload":{"phase":"message","error":"old failure"},"severity":"error","audience":"person"}},
            {"id":2,"createdAt":10,"kind":"event","payload":{"kind":"correction.exhausted",
                "payload":{"attempts":3,"limit":3,"messageId":"notice"},"severity":"warn","audience":"person"}}
        ]}));
        let canonical = json!({"messages":[
            {"id":"notice","createdAt":10,"author":{"kind":"process"},"text":"committed notice"},
            {"id":"answer","createdAt":20,"author":{"kind":"process"},"text":"latest answer"},
            {"id":"clock-adjusted","createdAt":18,"author":{"kind":"process"},"text":"later sequence"}
        ]});
        let snapshot = normalize_conversation_history(&canonical, &process);
        assert_eq!(snapshot.moments.len(), 4);
        assert!(snapshot.moments[0].text.contains("old failure"));
        assert_eq!(snapshot.moments[1].id.as_ref(), "notice");
        assert_eq!(snapshot.moments[1].text.as_ref(), "committed notice");
        assert_eq!(snapshot.moments[1].role, HistoryMomentRole::System);
        assert_eq!(snapshot.moments[2].id.as_ref(), "answer");
        assert_eq!(snapshot.moments[3].id.as_ref(), "clock-adjusted");
    }
    #[test]
    fn machine_connection_events_are_concise_system_notices_with_severity() {
        for (label, change, expected) in [
            (
                Some("Studio"),
                "disconnected",
                "Studio (studio-pc) disconnected.",
            ),
            (Some("studio-pc"), "connected", "studio-pc connected."),
            (None, "disconnected", "studio-pc disconnected."),
        ] {
            let mut event_payload =
                json!({"targetId":"studio-pc","event":change,"platform":"linux","observedAt":1});
            if let Some(label) = label {
                event_payload["label"] = json!(label);
            }
            let snapshot = normalize_fixture(&json!({"records":[{"id":1,"kind":"event","payload":{
                "kind":"target.connection","payload":event_payload,"severity":"warn","audience":"person"}}]}));
            assert_eq!(snapshot.moments[0].role, HistoryMomentRole::System);
            assert_eq!(snapshot.moments[0].text.as_ref(), expected);
            assert_eq!(
                snapshot.moments[0].event_severity,
                Some(HistorySeverity::Warn)
            );
            let moments = crate::model::moments_from_history(&snapshot);
            assert_eq!(moments[0].event_severity, Some(HistorySeverity::Warn));
        }
    }
}
