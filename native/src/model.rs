use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::content::{MediaAttachment, MediaKind};

const RETIRED_RUN_LIMIT: usize = 128;

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
    pub mode: SurfaceMode,
    next_transient_id: u64,
    user_occurrence_baselines: HashMap<String, usize>,
    retired_run_ids: VecDeque<String>,
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
            stopping_run_id: None,
            follow_latest: true,
        }
    }

    pub fn current(&self) -> Option<&Moment> {
        self.moments.get(self.selected)
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

        if self.active_run_id.as_deref() == Some(run_id.as_str()) {
            self.activity = Some("THINKING".to_string());
            if self.moments.iter().any(|moment| {
                moment.state == MomentState::Streaming
                    && moment.run_id.as_deref() == Some(run_id.as_str())
            }) {
                return;
            }
        } else if let Some(previous_run_id) = self.active_run_id.take() {
            self.complete_streaming_moment(&previous_run_id, true);
            self.retire_run(previous_run_id);
            self.stopping_run_id = None;
        }

        self.active_run_id = Some(run_id.clone());
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
                run_id: effective_run_id,
                state: MomentState::Streaming,
            });
        }
        self.activity = None;
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
                run_id: effective_run_id,
                state: MomentState::Streaming,
            });
        }
        self.activity = None;
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
                run_id: effective_run_id,
                state: MomentState::Streaming,
            });
        }
        self.activity = None;
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
        }
    }

    pub fn finish_run(&mut self, run_id: Option<&str>, error: Option<&str>) -> bool {
        let Some(active_run_id) = self.active_run_id.clone() else {
            return false;
        };
        if run_id.is_some_and(|run_id| run_id != active_run_id) {
            return false;
        }

        if let Some(moment) = self.moments.iter_mut().rev().find(|moment| {
            moment.state == MomentState::Streaming
                && moment.run_id.as_deref() == Some(active_run_id.as_str())
        }) {
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
        self.select_latest();
        true
    }

    pub fn clear_approval(&mut self) {
        self.pending_approval = None;
        self.moments
            .retain(|moment| moment.state != MomentState::Approval);
        self.activity = self.active_run_id.as_ref().map(|_| "THINKING".to_string());
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

pub fn parse_history(payload: &Value) -> Vec<Moment> {
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
            if text.trim().is_empty() && media.is_empty() {
                return None;
            }
            let id = message
                .get("id")
                .map(value_key)
                .unwrap_or_else(|| format!("history:{index}"));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_keeps_human_moments_and_hides_tool_plumbing() {
        let history = json!({
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
}
