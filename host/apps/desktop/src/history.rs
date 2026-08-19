//! Transport-neutral history normalization.
//!
//! The client runs [`normalize_history`] on its background runtime before publishing a snapshot
//! to GPUI. The resulting graph is immutable and shares completed message bodies with both the
//! conversation model and the bounded content-preparation worker.

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{DefaultHasher, Hasher as _};
use std::io;
use std::sync::Arc;

use serde_json::Value;

use crate::content::{MediaAttachment, MediaKind};
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
}

struct IndexedHistoryMessage<'a> {
    id: Arc<str>,
    value: &'a Value,
}

/// Normalize one `proc.history` response without performing Markdown parsing or GPUI layout.
pub fn normalize_history(payload: &Value) -> HistorySnapshot {
    let revision = history_revision(payload);
    let all_messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let dropped_messages = all_messages
        .len()
        .saturating_sub(MAX_FETCHED_HISTORY_MESSAGES);
    let visible_messages = &all_messages[dropped_messages..];
    let visible_message_count = visible_messages.len();
    let has_compaction_marker = visible_messages.iter().any(history_is_compaction_marker);
    let messages = canonical_history_messages(visible_messages, dropped_messages);
    let activity = derive_history_activity(
        payload,
        &messages,
        dropped_messages,
        visible_message_count,
        has_compaction_marker,
    );
    let summary_owners = activity
        .summaries
        .iter()
        .filter(|summary| !summary.entries.is_empty())
        .map(|summary| summary.moment_id.clone())
        .collect::<HashSet<_>>();
    let mut moments = Vec::with_capacity(messages.len());
    let mut preparation_candidates = Vec::new();

    for message in &messages {
        let value = message.value;
        let Some(role_name) = value.get("role").and_then(Value::as_str) else {
            continue;
        };
        let content = value.get("content").unwrap_or(&Value::Null);
        let text: Arc<str> = Arc::from(extract_text(content));
        let media = Arc::new(
            value
                .get("media")
                .or_else(|| content.get("media"))
                .map(parse_media)
                .unwrap_or_default(),
        );
        let id = message.id.clone();
        let run_id = history_run_id(value).map(Arc::from);

        let render_text = text.clone();
        if role_name == "assistant" {
            let candidate = HistoryPreparationCandidate {
                id: id.clone(),
                revision: content_revision(text.as_ref(), media.as_slice()),
                media_revision: content_revision("", media.as_slice()),
                render_text: render_text.clone(),
                text: text.clone(),
                media: media.clone(),
            };
            preparation_candidates.push(candidate);
        }

        let role = match role_name {
            "user" => HistoryMomentRole::User,
            "assistant" => HistoryMomentRole::Intelligence,
            "system" => HistoryMomentRole::System,
            "toolResult" => continue,
            _ => continue,
        };
        let has_activity_summary =
            role == HistoryMomentRole::Intelligence && summary_owners.contains(id.as_ref());
        if text.trim().is_empty() && media.is_empty() && !has_activity_summary {
            continue;
        }
        moments.push(HistoryMoment {
            id,
            role,
            text,
            render_text,
            media,
            run_id,
        });
    }

    HistorySnapshot {
        revision,
        active_run_id: payload
            .get("activeRunId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|run_id| !run_id.is_empty())
            .map(Arc::from),
        pending_approval: payload
            .get("pendingHil")
            .filter(|value| !value.is_null())
            .and_then(parse_pending_approval),
        moments: moments.into(),
        activity,
        preparation_candidates: preparation_candidates.into(),
        message_count: payload.get("messageCount").and_then(Value::as_u64),
        truncated: dropped_messages > 0
            || payload.get("truncated").and_then(Value::as_bool) == Some(true),
        has_more_before: payload.get("hasMoreBefore").and_then(Value::as_bool),
        has_more_after: payload.get("hasMoreAfter").and_then(Value::as_bool),
    }
}

/// Message ids are process-history identities. A repeated id is an invalid transport record, but
/// retaining the latest occurrence gives reconnecting clients a deterministic, internally
/// consistent snapshot without allowing two different bodies to share one presentation key.
fn canonical_history_messages<'a>(
    messages: &'a [Value],
    index_offset: usize,
) -> Vec<IndexedHistoryMessage<'a>> {
    let indexed = messages
        .iter()
        .enumerate()
        .map(|(local_index, value)| {
            let index = index_offset + local_index;
            IndexedHistoryMessage {
                id: Arc::from(history_moment_id(value, index)),
                value,
            }
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

fn derive_history_activity(
    payload: &Value,
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

    for message in messages {
        let value = message.value;
        let Some(run_id) = history_run_id(value).map(Arc::<str>::from) else {
            continue;
        };
        match value.get("role").and_then(Value::as_str) {
            Some("user") => {
                run_boundaries.insert(run_id);
            }
            Some("assistant") => {
                let tool_calls = history_tool_calls(value);
                if !tool_calls.is_empty() {
                    runs_with_call_context.insert(run_id.clone());
                    for call in tool_calls {
                        let Some(call_id) = call
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|call_id| !call_id.is_empty())
                            .map(Arc::<str>::from)
                        else {
                            continue;
                        };
                        let category = call
                            .get("syscall")
                            .and_then(Value::as_str)
                            .and_then(HistoryActivityCategory::from_syscall)
                            .or_else(|| {
                                call.get("name")
                                    .and_then(Value::as_str)
                                    .and_then(HistoryActivityCategory::from_tool_name)
                            });
                        let key = (run_id.clone(), call_id);
                        calls.entry(key.clone()).or_default().push_back(category);
                        latest_call_states.insert(key, HistoryToolCallState::Pending);
                    }
                    continue;
                }

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
            Some("toolResult") => {
                let Some(content) = value.get("content") else {
                    continue;
                };
                let call_id = content
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|call_id| !call_id.is_empty())
                    .map(Arc::<str>::from);
                let key = call_id.map(|call_id| (run_id.clone(), call_id));
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
                            HistoryToolCallState::Terminal {
                                message_id: message.id.clone(),
                            },
                        );
                    }
                }
                if !authoritative && !run_boundaries.contains(&run_id) {
                    incomplete_runs.insert(run_id.clone());
                    pending_counts.remove(&run_id);
                    continue;
                }
                if content.get("outcome").and_then(Value::as_str) != Some("completed") {
                    continue;
                }
                let category = correlated.and_then(|(_, category)| category).or_else(|| {
                    (!runs_with_call_context.contains(&run_id))
                        .then(|| {
                            content
                                .get("toolName")
                                .and_then(Value::as_str)
                                .and_then(HistoryActivityCategory::from_tool_name)
                        })
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

fn parse_media(value: &Value) -> Vec<MediaAttachment> {
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

fn extract_text(value: &Value) -> String {
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

fn history_moment_id(message: &Value, index: usize) -> String {
    message
        .get("id")
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string())
        })
        .unwrap_or_else(|| format!("history:{index}"))
}

fn history_revision(payload: &Value) -> HistoryRevision {
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
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn normalization_is_typed_bounded_and_precomputes_each_assistant_revision_once() {
        let messages = (0..MAX_FETCHED_HISTORY_MESSAGES + 5)
            .map(|index| {
                json!({
                    "id": index,
                    "runId": format!("run-{index}"),
                    "role": "assistant",
                    "content": format!("reply {index}")
                })
            })
            .collect::<Vec<_>>();
        let payload = json!({
            "messages": messages,
            "messageCount": MAX_FETCHED_HISTORY_MESSAGES + 5,
            "truncated": false,
            "activeRunId": "run-live"
        });

        let snapshot = normalize_history(&payload);

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
            "messages": [
                { "id": 1, "runId": "run-1", "role": "user", "content": "Do both" },
                { "id": 2, "runId": "run-1", "role": "assistant", "content": { "text": "", "toolCalls": [
                    { "id": "read-a", "name": "Read", "arguments": { "path": "/private/a" } },
                    { "id": "read-b", "syscall": "fs.read", "arguments": { "path": "/private/b" } }
                ] } },
                { "id": 3, "runId": "run-1", "role": "toolResult", "content": { "toolCallId": "read-a", "toolName": "Read", "outcome": "completed", "output": "private" } },
                { "id": 4, "runId": "run-1", "role": "toolResult", "content": { "toolCallId": "read-b", "toolName": "Read", "outcome": "completed", "output": "private" } },
                { "id": 5, "runId": "run-1", "role": "assistant", "content": "Done" }
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

        let snapshot = normalize_history(&payload);

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
        let first = normalize_history(&json!({
            "messages": [{ "id": 1, "role": "assistant", "content": "one" }],
            "activeRunId": null
        }));
        let same = normalize_history(&json!({
            "messages": [{ "id": 1, "role": "assistant", "content": "one" }],
            "activeRunId": null
        }));
        let changed = normalize_history(&json!({
            "messages": [{ "id": 1, "role": "assistant", "content": "two" }],
            "activeRunId": null
        }));

        assert_eq!(first.revision, same.revision);
        assert_ne!(first.revision, changed.revision);
    }

    #[test]
    fn duplicate_message_ids_keep_only_the_latest_record_and_its_preparation() {
        let snapshot = normalize_history(&json!({
            "messages": [
                {
                    "id": "assistant",
                    "runId": "run-old",
                    "role": "assistant",
                    "content": {
                        "text": "# stale response",
                        "media": [{
                            "type": "image",
                            "mimeType": "image/png",
                            "url": "https://example.com/stale.png"
                        }]
                    }
                },
                { "id": "user", "runId": "run-live", "role": "user", "content": "between" },
                { "id": "other", "runId": "run-live", "role": "assistant", "content": "other" },
                {
                    "id": "assistant",
                    "runId": "run-live",
                    "role": "assistant",
                    "content": {
                        "text": "# latest response",
                        "media": [{
                            "type": "image",
                            "mimeType": "image/png",
                            "url": "https://example.com/latest.png"
                        }]
                    }
                }
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
            ["user", "other", "assistant"]
        );
        assert_eq!(snapshot.preparation_candidates.len(), 2);
        assert_eq!(
            snapshot
                .preparation_candidates
                .iter()
                .map(|candidate| candidate.id.as_ref())
                .collect::<Vec<_>>(),
            ["other", "assistant"]
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
        assert_eq!(latest.id.as_ref(), "assistant");
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
}
