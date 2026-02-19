use crate::tui::state::RunPhase;

// ── UI chat events (WS -> main loop) ───────────────────────────────────────

#[derive(Clone)]
pub enum UiChatEvent {
    AssistantChunk {
        run_id: String,
        text: String,
    },
    AssistantFinal {
        run_id: String,
        text: String,
        tool_calls: Vec<ToolCallInfo>,
    },
    Error {
        run_id: Option<String>,
        text: String,
    },
    RunState {
        run_id: String,
        state: RunPhase,
    },
    /// System event from gateway (node/channel state changes).
    SystemEvent {
        payload: serde_json::Value,
    },
}

// ── Parsed event state from gateway ─────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedChatEventState {
    Queued,
    Started,
    Streaming,
    Final,
    Error,
    Unknown,
}

impl ParsedChatEventState {
    pub fn from_raw(raw: Option<&str>) -> Self {
        let state = raw.unwrap_or("").trim().to_lowercase();

        match state.as_str() {
            "queued" | "pending" => Self::Queued,
            "started" | "running" | "in_progress" => Self::Started,
            "delta" | "partial" | "streaming" => Self::Streaming,
            "final" | "done" | "complete" | "completed" | "finished" | "finalized"
            | "complete_success" => Self::Final,
            "error" | "failed" | "aborted" | "cancelled" | "timeout" => Self::Error,
            "" => Self::Unknown,
            _ => Self::Unknown,
        }
    }

    pub fn as_run_phase(self) -> Option<RunPhase> {
        match self {
            Self::Queued => Some(RunPhase::Queued),
            Self::Started => Some(RunPhase::Running),
            Self::Streaming => Some(RunPhase::Streaming),
            Self::Final => Some(RunPhase::Finalizing),
            Self::Error => Some(RunPhase::Failed),
            Self::Unknown => None,
        }
    }
}

// ── Send result parsing ─────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SendResult {
    pub directive: bool,
    pub run_id: Option<String>,
    pub run_status: Option<RunPhase>,
    pub response: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy)]
enum ParsedSendStatus {
    Started,
    Queued,
    Command,
    Error,
    Unknown,
}

impl ParsedSendStatus {
    fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("").trim().to_lowercase().as_str() {
            "started" | "running" => Self::Started,
            "queued" => Self::Queued,
            "command" | "directive" | "directive-only" => Self::Command,
            "error" => Self::Error,
            _ => Self::Unknown,
        }
    }
}

pub fn parse_send_result(payload: &serde_json::Value) -> SendResult {
    let mut result = SendResult {
        directive: false,
        run_id: None,
        run_status: None,
        response: None,
        error: None,
    };

    match ParsedSendStatus::parse(payload.get("status").and_then(|status| status.as_str())) {
        ParsedSendStatus::Started => {
            result.run_id = parse_run_id(payload);
            result.run_status = Some(RunPhase::Running);
        }
        ParsedSendStatus::Queued => {
            result.run_id = parse_run_id(payload);
            result.run_status = Some(RunPhase::Queued);
        }
        ParsedSendStatus::Command => {
            if let Some(response) = payload
                .get("response")
                .and_then(|response| response.as_str())
            {
                result.response = Some(response.to_string());
            }
            result.directive = true;
        }
        ParsedSendStatus::Error => {
            if let Some(error) = payload.get("error").and_then(|error| error.as_str()) {
                result.error = Some(error.to_string());
            }
        }
        ParsedSendStatus::Unknown => {}
    }

    if let Some(error) = payload.get("error").and_then(|error| error.as_str()) {
        result.error = Some(error.to_string());
    }

    result
}

pub fn parse_run_id(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("runId")
        .and_then(|id| id.as_str())
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())
        .map(str::to_string)
}

// ── Content extraction helpers ──────────────────────────────────────────────

/// A parsed tool call from a content block.
#[derive(Clone, Debug)]
pub struct ToolCallInfo {
    pub name: String,
    pub arguments: Option<String>,
}

/// Structured content extracted from a message payload.
#[derive(Clone, Debug, Default)]
pub struct ExtractedContent {
    /// Pure text portions of the message.
    pub text: Option<String>,
    /// Tool calls found in the content array.
    pub tool_calls: Vec<ToolCallInfo>,
}

pub fn extract_content_from_payload(payload: &serde_json::Value) -> ExtractedContent {
    if let Some(message) = payload.get("message") {
        if let Some(content) = message.get("content") {
            return extract_content_blocks(content);
        }

        if let Some(text) = message.get("text").and_then(|text| text.as_str()) {
            return ExtractedContent {
                text: Some(text.to_string()),
                tool_calls: Vec::new(),
            };
        }
    }

    if let Some(text) = payload.get("text").and_then(|text| text.as_str()) {
        return ExtractedContent {
            text: Some(text.to_string()),
            tool_calls: Vec::new(),
        };
    }

    ExtractedContent::default()
}

/// Legacy helper: extract just the text (used by streaming path and classic client).
pub fn extract_text_from_payload(payload: &serde_json::Value) -> Option<String> {
    let content = extract_content_from_payload(payload);
    content.text
}

/// Parse a `content` value into structured text + tool calls.
fn extract_content_blocks(content: &serde_json::Value) -> ExtractedContent {
    if let Some(text) = content.as_str() {
        return ExtractedContent {
            text: Some(text.to_string()),
            tool_calls: Vec::new(),
        };
    }

    if let Some(arr) = content.as_array() {
        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<ToolCallInfo> = Vec::new();

        for block in arr {
            if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
                match block_type {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                text_parts.push(text.to_string());
                            }
                        }
                    }
                    "toolCall" => {
                        if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                            let arguments = block.get("arguments").map(format_tool_args);
                            tool_calls.push(ToolCallInfo {
                                name: name.to_string(),
                                arguments,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        let text = if text_parts.is_empty() {
            None
        } else {
            Some(text_parts.join("\n"))
        };

        return ExtractedContent { text, tool_calls };
    }

    let raw = content.to_string();
    ExtractedContent {
        text: if raw.is_empty() { None } else { Some(raw) },
        tool_calls: Vec::new(),
    }
}

/// Flatten a tool's JSON arguments into a compact key=value summary.
fn format_tool_args(args: &serde_json::Value) -> String {
    if let Some(obj) = args.as_object() {
        obj.iter()
            .map(|(key, val)| {
                let short = match val {
                    serde_json::Value::String(s) => {
                        if s.len() > 60 {
                            format!("\"{}...\"", &s[..57])
                        } else {
                            format!("\"{}\"", s)
                        }
                    }
                    serde_json::Value::Bool(b) => b.to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Null => "null".to_string(),
                    _ => {
                        let raw = val.to_string();
                        if raw.len() > 60 {
                            format!("{}...", &raw[..57])
                        } else {
                            raw
                        }
                    }
                };
                format!("{}={}", key, short)
            })
            .collect::<Vec<_>>()
            .join("  ")
    } else if let Some(s) = args.as_str() {
        s.to_string()
    } else {
        args.to_string()
    }
}

/// Legacy flatten helper used by the classic (non-TUI) client.
pub fn format_content(content: &serde_json::Value) -> String {
    let extracted = extract_content_blocks(content);
    let mut parts: Vec<String> = Vec::new();

    if let Some(text) = extracted.text {
        parts.push(text);
    }
    for tc in &extracted.tool_calls {
        parts.push(format!("[Tool: {}]", tc.name));
    }

    parts.join("\n")
}

/// A single line item extracted from a history message.
pub struct HistoryItem {
    pub role: super::state::MessageRole,
    pub text: String,
}

/// Parse a history message into one or more display items.
///
/// An assistant message with tool calls produces the text item plus
/// separate `Tool` items for each call. A `toolResult` message produces
/// a single `Tool` item with the result body.
pub fn history_message_to_items(message: &serde_json::Value) -> Vec<HistoryItem> {
    use super::state::MessageRole;

    let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
    let is_error = message
        .get("isError")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let tool_name = message
        .get("toolName")
        .and_then(|name| name.as_str())
        .unwrap_or("tool");

    match role {
        "toolResult" => {
            let body = message
                .get("content")
                .and_then(|c| {
                    if c.is_string() {
                        c.as_str().map(|text| text.to_string())
                    } else {
                        Some(format_content(c))
                    }
                })
                .unwrap_or_default();

            let prefix = if is_error {
                format!("\u{25b8} {} error", tool_name)
            } else {
                format!("\u{25b8} {} result", tool_name)
            };

            let text = if body.is_empty() {
                prefix
            } else {
                format!("{}\n{}", prefix, body)
            };

            vec![HistoryItem {
                role: if is_error {
                    MessageRole::Error
                } else {
                    MessageRole::Tool
                },
                text,
            }]
        }

        "assistant" => {
            let content = message.get("content");
            let extracted = content.map(extract_content_blocks).unwrap_or_default();

            let mut items = Vec::new();

            // Text portion
            if let Some(text) = extracted.text {
                let trimmed = text.trim().to_string();
                if !trimmed.is_empty() {
                    items.push(HistoryItem {
                        role: MessageRole::Assistant,
                        text: trimmed,
                    });
                }
            }

            // Tool call items
            for tc in &extracted.tool_calls {
                let text = if let Some(args) = &tc.arguments {
                    format!("\u{25b8} {}  {}", tc.name, args)
                } else {
                    format!("\u{25b8} {}", tc.name)
                };
                items.push(HistoryItem {
                    role: MessageRole::Tool,
                    text,
                });
            }

            items
        }

        _ => {
            let mut text = message
                .get("content")
                .map(format_content)
                .or_else(|| {
                    message
                        .get("text")
                        .and_then(|text| text.as_str())
                        .map(|text| text.to_string())
                })
                .unwrap_or_default();

            if text.is_empty() {
                return Vec::new();
            }

            if role == "system" {
                text = text.trim().to_string();
            }

            let msg_role = match role {
                "user" => MessageRole::User,
                "error" => MessageRole::Error,
                _ => MessageRole::System,
            };

            vec![HistoryItem {
                role: msg_role,
                text,
            }]
        }
    }
}
