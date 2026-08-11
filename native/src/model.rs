use std::collections::VecDeque;

use serde_json::Value;

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
    Streaming,
    Error,
    Approval,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Moment {
    pub id: String,
    pub role: MomentRole,
    pub text: String,
    pub run_id: Option<String>,
    pub state: MomentState,
}

impl Moment {
    pub fn new(id: impl Into<String>, role: MomentRole, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            role,
            text: text.into(),
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
    Disconnected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SurfaceMode {
    Conversation,
    Terminal,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TypeLayout {
    pub size: f32,
    pub line_height: f32,
    pub width: f32,
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
    retired_run_ids: VecDeque<String>,
    stopping_run_id: Option<String>,
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
            retired_run_ids: VecDeque::new(),
            stopping_run_id: None,
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
            retired_run_ids: VecDeque::new(),
            stopping_run_id: None,
        }
    }

    pub fn current(&self) -> Option<&Moment> {
        self.moments.get(self.selected)
    }

    pub fn select(&mut self, index: usize) {
        if !self.moments.is_empty() {
            self.selected = index.min(self.moments.len() - 1);
        }
    }

    pub fn select_previous(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub fn select_next(&mut self) {
        if !self.moments.is_empty() {
            self.selected = (self.selected + 1).min(self.moments.len() - 1);
        }
    }

    pub fn select_latest(&mut self) {
        self.selected = self.moments.len().saturating_sub(1);
    }

    pub fn replace_history(&mut self, moments: Vec<Moment>) {
        self.moments = moments;
        self.select_latest();
    }

    pub fn append_user(&mut self, text: impl Into<String>) {
        let id = self.transient_id("user");
        self.moments
            .push(Moment::new(id, MomentRole::User, text.into()));
        self.select_latest();
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
        self.moments.push(Moment {
            id,
            role: MomentRole::Intelligence,
            text: String::new(),
            run_id: Some(run_id),
            state: MomentState::Streaming,
        });
        self.select_latest();
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
                run_id: effective_run_id,
                state: MomentState::Streaming,
            });
        }
        self.activity = None;
        self.select_latest();
    }

    pub fn finish_run(&mut self, run_id: Option<&str>, error: Option<&str>) {
        let Some(active_run_id) = self.active_run_id.clone() else {
            return;
        };
        if run_id.is_some_and(|run_id| run_id != active_run_id) {
            return;
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
            if moment.text.trim().is_empty() {
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
                run_id: Some(active_run_id.clone()),
                state: MomentState::Error,
            });
        }

        self.retire_run(active_run_id);
        self.active_run_id = None;
        self.stopping_run_id = None;
        self.activity = None;
        self.select_latest();
    }

    pub fn abort_run(&mut self, run_id: &str) {
        if self.active_run_id.as_deref() != Some(run_id) {
            return;
        }
        self.active_run_id = None;
        self.complete_streaming_moment(run_id, true);
        self.retire_run(run_id.to_string());
        self.stopping_run_id = None;
        self.clear_approval();
        self.activity = None;
        self.select_latest();
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

    pub fn abort_failed(&mut self, run_id: &str) {
        if self.stopping_run_id.as_deref() != Some(run_id) {
            return;
        }
        self.stopping_run_id = None;
        if self.active_run_id.is_some() {
            self.activity = Some("THINKING".to_string());
        }
    }

    pub fn show_error(&mut self, message: impl Into<String>) {
        let id = self.transient_id("error");
        self.moments.push(Moment {
            id,
            role: MomentRole::System,
            text: message.into(),
            run_id: None,
            state: MomentState::Error,
        });
        self.activity = None;
        self.select_latest();
    }

    pub fn set_approval(&mut self, approval: PendingApproval) {
        if !approval.run_id.is_empty() {
            if self.active_run_id.is_none() {
                self.start_run(approval.run_id.clone());
            }
            if !self.accepts_run(Some(&approval.run_id)) {
                return;
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
                run_id: Some(approval.run_id.clone()),
                state: MomentState::Approval,
            });
        }
        self.pending_approval = Some(approval);
        self.activity = Some("APPROVAL REQUIRED".to_string());
        self.select_latest();
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
        if remove_empty && self.moments[index].text.trim().is_empty() {
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

pub fn adaptive_type_layout(text: &str, streaming: bool) -> TypeLayout {
    let characters = text.chars().count();
    let lines = text.lines().count().max(1);
    let effective = characters + lines.saturating_sub(1) * 42;
    let size = if streaming {
        42.0
    } else {
        match effective {
            0..=56 => 72.0,
            57..=150 => 58.0,
            151..=330 => 46.0,
            331..=720 => 36.0,
            _ => 28.0,
        }
    };
    let line_height = match size as u32 {
        0..=32 => 1.34,
        33..=44 => 1.26,
        45..=60 => 1.18,
        _ => 1.11,
    };
    let width = match size as u32 {
        0..=32 => 900.0,
        33..=44 => 860.0,
        45..=60 => 780.0,
        _ => 700.0,
    };
    TypeLayout {
        size,
        line_height,
        width,
    }
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
            let text = extract_text(message.get("content")?).trim().to_string();
            if text.is_empty() {
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
                run_id: message
                    .get("runId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                state: MomentState::Complete,
            })
        })
        .collect()
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
    fn type_size_steps_down_without_becoming_dashboard_copy() {
        assert_eq!(adaptive_type_layout("Short thought", false).size, 72.0);
        assert_eq!(adaptive_type_layout(&"a".repeat(200), false).size, 46.0);
        assert_eq!(adaptive_type_layout(&"a".repeat(900), false).size, 28.0);
        assert_eq!(adaptive_type_layout("streaming", true).size, 42.0);
    }

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
