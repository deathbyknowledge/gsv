//! Public process-history transport contracts. Presentation belongs to each client.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{error::Error, fmt};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcHistory {
    pub format: u8,
    pub pid: String,
    pub records: Vec<HistoryRecord>,
    pub message_count: u64,
    #[serde(default)]
    pub truncated: bool,
    pub has_more_before: Option<bool>,
    pub has_more_after: Option<bool>,
    pub active_run_id: Option<String>,
    pub pending_hil: Option<Value>,
    #[serde(default)]
    pub context: Value,
    pub context_revision: Option<u64>,
    pub history_revision: u64,
    pub history_generation: u64,
    pub history_reset_revision: u64,
    pub reset: bool,
    pub has_more: bool,
    pub cursor: Option<String>,
}

impl ProcHistory {
    pub fn decode(value: Value) -> Result<Self, HistoryDecodeError> {
        if value.get("ok").and_then(Value::as_bool) == Some(false) {
            return Err(HistoryDecodeError(
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("proc.history failed")
                    .to_owned(),
            ));
        }
        if value.get("format").and_then(Value::as_u64) != Some(2) {
            return Err(HistoryDecodeError("Unsupported process history format: this client requires format 2. Upgrade the gateway.".to_owned()));
        }
        serde_json::from_value(value).map_err(|error| {
            HistoryDecodeError(format!("Invalid format-2 process history: {error}"))
        })
    }
}

#[derive(Debug)]
pub struct HistoryDecodeError(String);

impl fmt::Display for HistoryDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl Error for HistoryDecodeError {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: u64,
    pub message_id: u64,
    pub index: u64,
    pub generation: u64,
    pub run_id: Option<String>,
    pub created_at: f64,
    pub source: HistorySource,
    pub metadata: Option<Value>,
    #[serde(flatten)]
    pub data: HistoryRecordData,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistorySource {
    Typed,
    Legacy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "lowercase")]
pub enum HistoryRecordData {
    Message(HistoryMessage),
    Note(HistoryNote),
    Call(HistoryCall),
    Result(HistoryResult),
    Event(HistoryEvent),
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistoryDirection {
    In,
    Out,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub direction: HistoryDirection,
    pub text: String,
    pub media: Vec<Value>,
    pub origin: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_target: Option<String>,
    pub conversation_id: Option<String>,
    pub conversation_message_id: Option<String>,
    pub delivery_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HistoryNote {
    pub text: String,
    pub thinking: Vec<HistoryThinking>,
    #[serde(default)]
    pub media: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryThinking {
    #[serde(rename = "type")]
    pub kind: HistoryThinkingKind,
    pub thinking: String,
    pub thinking_signature: Option<String>,
    pub redacted: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistoryThinkingKind {
    Thinking,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCall {
    pub call_id: String,
    pub tool: String,
    pub syscall: Option<String>,
    pub args: Map<String, Value>,
    pub target: Option<String>,
    pub run_id: Option<String>,
    pub thought_signature: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistoryOutcome {
    Completed,
    Failed,
    Denied,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResult {
    pub call_id: String,
    pub tool: String,
    pub outcome: HistoryOutcome,
    pub output: Value,
    pub media: Vec<Value>,
    pub resources: Vec<Value>,
    pub error: Option<HistoryResultError>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HistoryResultError {
    pub message: String,
    pub code: Option<Value>,
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HistoryEvent {
    pub kind: String,
    pub payload: Map<String, Value>,
    pub severity: HistorySeverity,
    pub audience: HistoryAudience,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistorySeverity {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistoryAudience {
    Model,
    Person,
    Both,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn old_gateway_is_rejected_without_interpreting_legacy_messages() {
        let error =
            ProcHistory::decode(json!({"ok":true,"messages":[]})).expect_err("format required");
        assert!(error.to_string().contains("requires format 2"));
    }

    #[test]
    fn typed_records_and_sync_identity_are_primary() {
        let value = json!({"ok":true,"format":2,"pid":"p","messageCount":1,
            "historyRevision":8,"historyGeneration":2,"historyResetRevision":5,
            "reset":true,"hasMore":false,"cursor":"opaque",
            "messages":[{"role":"assistant","content":"must not parse"}],
            "records":[{"id":2,"messageId":1,"index":1,"generation":2,"runId":"r",
                "createdAt":-100.5,"source":"typed","kind":"result","payload":{
                    "callId":"c","tool":"Shell","outcome":"cancelled","output":{"finish":false},
                    "media":[],"resources":[],"error":{"message":"stopped","code":400}}}]});
        let history = ProcHistory::decode(value).expect("typed history");
        assert_eq!(history.cursor.as_deref(), Some("opaque"));
        assert_eq!(history.history_revision, 8);
        assert_eq!(history.history_reset_revision, 5);
        assert_eq!(history.records[0].created_at, -100.5);
        assert!(
            matches!(&history.records[0].data, HistoryRecordData::Result(result)
            if result.outcome == HistoryOutcome::Cancelled && result.output["finish"] == false)
        );
    }

    #[test]
    fn message_selection_survives_transport_without_inventing_older_selections() {
        for selected in [Some("my-macbook"), None] {
            let mut payload =
                json!({"direction":"in","text":"  inspect this\n","media":[],"origin":{}});
            if let Some(target) = selected {
                payload["selectedTarget"] = json!(target);
            }
            let message: HistoryMessage = serde_json::from_value(payload).expect("message");
            let encoded = serde_json::to_value(&message).expect("encode message");
            assert_eq!(message.selected_target.as_deref(), selected);
            assert_eq!(
                encoded.get("selectedTarget").and_then(Value::as_str),
                selected
            );
            assert_eq!(message.text, "  inspect this\n");
        }
    }
}
