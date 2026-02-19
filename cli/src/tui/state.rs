use std::collections::HashMap;
use std::time::{Duration, Instant};

use ratatui::style::Style;

use crate::tui::buffer::{Buffer, BufferId};
use crate::tui::system::SystemState;
use crate::tui::theme;

// ── Message model ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
    Error,
    Tool,
}

impl MessageRole {
    pub fn label(&self) -> &'static str {
        match self {
            Self::User => "you",
            Self::Assistant => "agent",
            Self::System => "info",
            Self::Error => "err",
            Self::Tool => "tool",
        }
    }

    pub fn style(&self) -> Style {
        match self {
            Self::User => theme::style_user(),
            Self::Assistant => theme::style_assistant(),
            Self::System => theme::style_system(),
            Self::Error => theme::style_error(),
            Self::Tool => theme::style_tool(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolVerbosity {
    /// Hide all tool calls and results.
    Quiet,
    /// Show tool names; truncate results to a few lines.
    Normal,
    /// Show tool names + arguments + full results.
    Verbose,
}

impl ToolVerbosity {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::Normal => "normal",
            Self::Verbose => "verbose",
        }
    }
}

pub struct MessageLine {
    pub role: MessageRole,
    pub text: String,
}

// ── Run phase tracking ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunPhase {
    Queued,
    Running,
    Streaming,
    Finalizing,
    Failed,
    Unknown,
}

impl RunPhase {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Streaming => "streaming",
            Self::Finalizing => "finalizing",
            Self::Failed => "failed",
            Self::Unknown => "processing",
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Streaming)
    }
}

// ── Application state ───────────────────────────────────────────────────────

pub struct AppState {
    // Chat
    pub messages: Vec<MessageLine>,
    pub streams: HashMap<String, usize>,

    // Buffers
    pub active_buffer: BufferId,
    pub system_buffer: Buffer,

    // System state (live node/channel/session info)
    pub system: SystemState,

    // Logs
    pub logs_buffer: Buffer,
    pub logs_last_node: Option<String>,
    pub logs_last_lines: usize,

    // Input
    pub input: String,
    pub input_history: Vec<String>,
    pub input_history_index: Option<usize>,

    // Session
    pub session_key: String,
    pub status: Option<String>,

    // Scroll
    pub chat_scroll: usize,
    pub chat_auto_follow: bool,

    // Waiting / run tracking
    pub waiting: bool,
    pub waiting_started: Option<Instant>,
    pub active_run_id: Option<String>,
    pub run_phases: HashMap<String, RunPhase>,

    // Tool display
    pub tool_verbosity: ToolVerbosity,

    // Animation
    pub spinner_tick: usize,
}

impl AppState {
    pub fn new(session_key: &str) -> Self {
        Self {
            messages: Vec::new(),
            streams: HashMap::new(),
            active_buffer: BufferId::Chat,
            system_buffer: Buffer::new(BufferId::System),
            system: SystemState::new(),
            logs_buffer: Buffer::new(BufferId::Logs),
            logs_last_node: None,
            logs_last_lines: 100,
            input: String::new(),
            input_history: Vec::new(),
            input_history_index: None,
            session_key: session_key.to_string(),
            status: None,
            chat_scroll: 0,
            chat_auto_follow: true,
            waiting: false,
            waiting_started: None,
            active_run_id: None,
            run_phases: HashMap::new(),
            tool_verbosity: ToolVerbosity::Normal,
            spinner_tick: 0,
        }
    }

    // ── Buffers ─────────────────────────────────────────────────────────

    pub fn switch_buffer(&mut self, id: BufferId) {
        self.active_buffer = id;
        match id {
            BufferId::System => self.system_buffer.mark_read(),
            BufferId::Logs => self.logs_buffer.mark_read(),
            _ => {}
        }
    }

    // ── Status ──────────────────────────────────────────────────────────

    pub fn set_status(&mut self, status: impl Into<String>) {
        self.status = Some(status.into());
    }

    // ── Messages ────────────────────────────────────────────────────────

    pub fn push_message(&mut self, role: MessageRole, text: impl Into<String>) {
        self.messages.push(MessageLine {
            role,
            text: text.into(),
        });
        self.chat_auto_follow = true;
    }

    /// Add a tool-call message (respects verbosity -- quiet hides it entirely).
    pub fn push_tool_call(&mut self, tc: &super::events::ToolCallInfo) {
        if self.tool_verbosity == ToolVerbosity::Quiet {
            return;
        }
        let text = match self.tool_verbosity {
            ToolVerbosity::Verbose => {
                if let Some(args) = &tc.arguments {
                    format!("\u{25b8} {}  {}", tc.name, args)
                } else {
                    format!("\u{25b8} {}", tc.name)
                }
            }
            _ => format!("\u{25b8} {}", tc.name),
        };
        self.messages.push(MessageLine {
            role: MessageRole::Tool,
            text,
        });
        self.chat_auto_follow = true;
    }

    /// Add a tool-result message (respects verbosity and truncation).
    pub fn push_tool_result(&mut self, tool_name: &str, body: &str, is_error: bool) {
        if self.tool_verbosity == ToolVerbosity::Quiet {
            return;
        }

        let prefix = if is_error {
            format!("\u{25b8} {} error", tool_name)
        } else {
            format!("\u{25b8} {} result", tool_name)
        };

        if body.is_empty() {
            self.messages.push(MessageLine {
                role: if is_error {
                    MessageRole::Error
                } else {
                    MessageRole::Tool
                },
                text: prefix,
            });
            self.chat_auto_follow = true;
            return;
        }

        let truncated = match self.tool_verbosity {
            ToolVerbosity::Verbose => body.to_string(),
            _ => truncate_lines(body, super::theme::TOOL_RESULT_TRUNCATE_LINES),
        };

        let text = format!("{}\n{}", prefix, truncated);
        self.messages.push(MessageLine {
            role: if is_error {
                MessageRole::Error
            } else {
                MessageRole::Tool
            },
            text,
        });
        self.chat_auto_follow = true;
    }

    pub fn append_partial(&mut self, run_id: String, text: String) {
        if text.is_empty() {
            return;
        }

        if let Some(idx) = self.streams.get(&run_id).copied() {
            if let Some(msg) = self.messages.get_mut(idx) {
                msg.text.push_str(&text);
                return;
            }
        }

        let idx = self.messages.len();
        self.messages.push(MessageLine {
            role: MessageRole::Assistant,
            text,
        });

        if run_id == theme::RUN_DEFAULT_ID {
            if let Some(active_run_id) = self.active_run_id.clone() {
                self.streams.insert(active_run_id, idx);
            } else {
                self.streams.insert(run_id, idx);
            }
        } else {
            self.streams.insert(run_id, idx);
        }
    }

    pub fn finalize_run(&mut self, run_id: String, text: String) {
        let active_run_id = self.active_run_id.clone();
        self.pop_run_state(&run_id);

        let mut idx = self.streams.remove(&run_id);

        if idx.is_none() {
            if let Some(active_run_id) = active_run_id {
                idx = self.streams.remove(&active_run_id);
            }
        }

        if let Some(idx) = idx {
            if let Some(msg) = self.messages.get_mut(idx) {
                if !text.is_empty() {
                    msg.text = text;
                }
                return;
            }
        }

        if text.is_empty() {
            return;
        }

        self.messages.push(MessageLine {
            role: MessageRole::Assistant,
            text,
        });
    }

    // ── Scroll ──────────────────────────────────────────────────────────

    pub fn max_chat_scroll(&self, line_count: usize, chat_height: usize) -> usize {
        let chat_height = chat_height.max(1);
        line_count.saturating_sub(chat_height)
    }

    pub fn ensure_chat_scroll(&mut self, line_count: usize, chat_height: usize) {
        let max_scroll = self.max_chat_scroll(line_count, chat_height);

        if self.chat_auto_follow {
            self.chat_scroll = max_scroll;
            return;
        }

        if self.chat_scroll > max_scroll {
            self.chat_scroll = max_scroll;
            return;
        }

        if self.chat_scroll >= max_scroll {
            self.chat_auto_follow = true;
        }
    }

    pub fn scroll_chat_up(&mut self, lines: usize) {
        self.chat_auto_follow = false;
        self.chat_scroll = self.chat_scroll.saturating_sub(lines);
    }

    pub fn scroll_chat_down(&mut self, lines: usize) {
        self.chat_auto_follow = false;
        self.chat_scroll = self.chat_scroll.saturating_add(lines);
    }

    pub fn scroll_chat_to_top(&mut self) {
        self.chat_auto_follow = false;
        self.chat_scroll = 0;
    }

    pub fn scroll_chat_to_bottom(&mut self) {
        self.chat_auto_follow = true;
    }

    // ── Input history ───────────────────────────────────────────────────

    pub fn add_input_history(&mut self, line: &str) {
        if line.trim().is_empty() {
            return;
        }

        let trimmed = line.trim().to_string();

        if self
            .input_history
            .last()
            .is_none_or(|previous| previous != &trimmed)
        {
            self.input_history.push(trimmed);
        }

        if self.input_history.len() > theme::MAX_INPUT_HISTORY {
            let _ = self.input_history.remove(0);
        }

        self.input_history_index = None;
    }

    pub fn history_up(&mut self) {
        if self.input_history.is_empty() {
            return;
        }

        let next_index = match self.input_history_index {
            None => self.input_history.len() - 1,
            Some(0) => 0,
            Some(index) => index - 1,
        };

        self.input_history_index = Some(next_index);
        if let Some(entry) = self.input_history.get(next_index) {
            self.input = entry.clone();
        }
    }

    pub fn history_down(&mut self) {
        match self.input_history_index {
            None => return,
            Some(index) if index + 1 >= self.input_history.len() => {
                self.input_history_index = None;
                self.input.clear();
            }
            Some(index) => {
                let next_index = index + 1;
                self.input_history_index = Some(next_index);
                if let Some(entry) = self.input_history.get(next_index) {
                    self.input = entry.clone();
                }
            }
        }
    }

    // ── Run tracking ────────────────────────────────────────────────────

    pub fn set_active_run_id(&mut self, run_id: String) {
        if self.active_run_id.as_deref() == Some(&run_id) {
            return;
        }
        self.active_run_id = Some(run_id);
    }

    pub fn set_run_state(&mut self, run_id: String, state: RunPhase) {
        self.run_phases.insert(run_id.clone(), state);
        self.set_active_run_id(run_id);
        if state.is_active() {
            self.waiting = true;
            if self.waiting_started.is_none() {
                self.waiting_started = Some(Instant::now());
            }
        }
    }

    /// Reset the silence timer. Call on any incoming activity (chunks,
    /// state changes) so the timeout measures silence, not wall-clock.
    pub fn touch_activity(&mut self) {
        if self.waiting {
            self.waiting_started = Some(Instant::now());
        }
    }

    pub fn pop_run_state(&mut self, run_id: &str) -> Option<RunPhase> {
        let mut removed = self.run_phases.remove(run_id);

        if removed.is_none() {
            if let Some(active_run_id) = self.active_run_id.clone() {
                removed = self.run_phases.remove(&active_run_id);
            }
        }

        if self.active_run_id.as_deref() == Some(run_id) {
            self.active_run_id = None;
        }

        if self.active_run_id.is_none() {
            self.active_run_id = self.run_phases.keys().next().cloned();
        }

        if self.run_phases.is_empty() {
            self.waiting = false;
            self.waiting_started = None;
        }

        removed
    }

    pub fn clear_runs(&mut self) {
        self.run_phases.clear();
        self.active_run_id = None;
        self.waiting = false;
        self.waiting_started = None;
        self.streams.clear();
    }

    pub fn timeout_if_needed(&mut self, now: Instant) -> bool {
        if self.waiting {
            self.waiting_started = self.waiting_started.or(Some(now));
            if now.duration_since(self.waiting_started.unwrap_or(now))
                > Duration::from_secs(theme::CONNECTION_TIMEOUT_SECS)
            {
                self.push_message(
                    MessageRole::Error,
                    format!(
                        "Timeout after {} seconds waiting for response",
                        theme::CONNECTION_TIMEOUT_SECS
                    ),
                );
                self.clear_runs();
                self.streams.clear();
                return true;
            }
        }

        false
    }

    // ── Display helpers ─────────────────────────────────────────────────

    pub fn current_run_label(&self) -> Option<String> {
        let active_run = self
            .active_run_id
            .as_ref()
            .or_else(|| self.run_phases.keys().next())?;

        let state = self
            .run_phases
            .get(active_run)
            .copied()
            .unwrap_or(RunPhase::Unknown);
        Some(format!("{} {}", state.label(), short_run_id(active_run)))
    }

    pub fn status_line(&self) -> String {
        if self.waiting {
            let spinner = theme::SPINNER[self.spinner_tick % theme::SPINNER.len()];
            let elapsed = self
                .waiting_started
                .and_then(|start| Instant::now().checked_duration_since(start))
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let state = self
                .current_run_label()
                .unwrap_or_else(|| "processing".to_string());
            let queue = if self.run_phases.len() > 1 {
                format!(" ({} queued)", self.run_phases.len() - 1)
            } else {
                String::new()
            };

            format!("{} {} ({}s){}", spinner, state, elapsed, queue)
        } else if let Some(status) = &self.status {
            status.clone()
        } else {
            "ready".to_string()
        }
    }
}

// ── Session key helpers ─────────────────────────────────────────────────────

pub fn normalize_session_key_for_match(session_key: &str) -> String {
    let trimmed = session_key.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let normalized = trimmed.to_lowercase();
    if normalized == "main" {
        return "agent:main:main".to_string();
    }

    if !normalized.starts_with("agent:") {
        return normalized;
    }

    let parts = normalized.split(':').collect::<Vec<_>>();
    if parts.len() < 2 {
        return normalized;
    }

    let agent_id = parts[1];
    if parts.len() == 3 && parts[2] == "cli" {
        return format!("agent:{}:main", agent_id);
    }

    if parts.len() == 4 && parts[2] == "cli" && parts[3] == "dm" {
        return format!("agent:{}:dm:main", agent_id);
    }

    if parts.len() >= 5 && parts[2] == "cli" && parts[3] == "dm" {
        return if parts[4] == "main" {
            format!("agent:{}:main", agent_id)
        } else {
            format!("agent:{}:dm:{}", agent_id, parts[4..].join(":"))
        };
    }

    normalized
}

pub fn extract_agent_from_session_key(session_key: &str) -> Option<String> {
    let mut parts = session_key.split(':');
    if parts.next()? != "agent" {
        return None;
    }
    parts.next().map(ToString::to_string)
}

pub fn build_agent_session_key(agent: &str) -> String {
    format!("agent:{}:cli:dm:main", agent.trim().to_lowercase())
}

pub fn session_display_name(session_key: &str) -> String {
    let agent =
        extract_agent_from_session_key(session_key).unwrap_or_else(|| "unknown".to_string());
    let session = session_key.split(':').last().unwrap_or("main");
    format!("{} ({})", session, agent)
}

pub fn short_run_id(run_id: &str) -> String {
    if run_id == theme::RUN_DEFAULT_ID {
        return "local".to_string();
    }
    run_id.chars().take(8).collect::<String>()
}

/// Truncate text to at most `max_lines` lines, appending a count of hidden lines.
pub fn truncate_lines(text: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= max_lines {
        return text.to_string();
    }
    let shown: Vec<&str> = lines[..max_lines].to_vec();
    let hidden = lines.len() - max_lines;
    format!("{}\n  ({} more lines)", shown.join("\n"), hidden)
}
