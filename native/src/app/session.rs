use gpui::{Context, Window};
use serde_json::Value;

use crate::client::{ClientCommand, ClientEvent};
use crate::interaction::{ApprovalSubmissionFailure, CanvasLayer};
use crate::model::{
    extract_text, parse_history, parse_media, parse_pending_approval, ConnectionState, MomentState,
    PendingApproval,
};

use super::media::release_assets;
use super::{human_activity, GsvApp};

impl GsvApp {
    pub(super) fn handle_client_event(
        &mut self,
        event: ClientEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ClientEvent::Connecting => {
                self.conversation.connection = ConnectionState::Connecting;
                self.conversation.activity = Some("CONNECTING".to_string());
            }
            ClientEvent::LoginFailed {
                attempt_id,
                defaults,
                step,
                message,
            } => {
                self.show_login_failure(attempt_id, defaults, step, message, window, cx);
            }
            ClientEvent::SetupRequired {
                attempt_id,
                defaults,
                message,
            } => {
                self.show_setup_required(attempt_id, defaults, message, window, cx);
            }
            ClientEvent::Reconnecting { attempt, message } => {
                let released = self.media_cache.clear(&self.commands);
                self.cancel_stale_media_preparations();
                release_assets(released, cx);
                self.client_session_id = None;
                self.pid = None;
                self.last_history = None;
                self.conversation.connection = ConnectionState::Connecting;
                let activity = if attempt <= 1 {
                    "RECONNECTING".to_string()
                } else {
                    format!("RECONNECTING · {attempt}")
                };
                if self.conversation.moments.is_empty() {
                    self.conversation.show_error(message);
                }
                self.conversation.activity = Some(activity);
            }
            ClientEvent::Connected {
                attempt_id,
                session_id,
                pid,
            } => {
                if let Some(login) = &mut self.login {
                    if !login.accept_connection(attempt_id) {
                        return;
                    }
                }
                self.finish_login(window, cx);
                let released = self.media_cache.clear(&self.commands);
                self.cancel_stale_media_preparations();
                release_assets(released, cx);
                self.client_session_id = Some(session_id);
                self.pid = Some(pid);
                self.last_history = None;
                self.conversation.connection = ConnectionState::Connected;
                self.conversation.activity = None;
            }
            ClientEvent::History {
                session_id,
                history,
            } if self.client_session_id == Some(session_id) => {
                self.reconcile_history(history, window, cx);
            }
            ClientEvent::History { .. } => {}
            ClientEvent::HistorySuperseded {
                session_id,
                request_signal_id,
                response_signal_id,
            } if self.client_session_id == Some(session_id)
                && history_was_superseded(request_signal_id, response_signal_id) => {}
            ClientEvent::HistorySuperseded { .. } => {}
            ClientEvent::Signal {
                session_id,
                name,
                payload,
            } if self.client_session_id == Some(session_id) => {
                self.handle_signal(&name, &payload, window, cx);
            }
            ClientEvent::Signal { .. } => {}
            ClientEvent::SendAccepted {
                submission_id,
                run_id,
                queued,
            } => {
                let Some(submission) = self.interaction.submission_accepted(submission_id) else {
                    return;
                };
                self.conversation
                    .accept_user(&submission.moment_id, &run_id);
                if queued {
                    self.conversation.activity = Some("QUEUED".to_string());
                } else {
                    self.conversation.start_run(run_id);
                }
                self.timeline_scroll
                    .scroll_to_item(self.conversation.selected);
            }
            ClientEvent::SendFailed {
                submission_id,
                message,
            } => self.handle_submission_failure(submission_id, message, window, cx),
            ClientEvent::SendUncertain {
                submission_id,
                submitted_text,
                message,
            } => {
                let Some(submission) = self.interaction.submission_accepted(submission_id) else {
                    return;
                };
                if submission.text != submitted_text {
                    return;
                }
                self.conversation.mark_user_uncertain(&submission.moment_id);
                self.conversation.show_error(message);
                self.conversation.activity = Some("VERIFYING DELIVERY".to_string());
            }
            ClientEvent::AbortResolved { run_id } => {
                if self.conversation.abort_run(&run_id) && self.interaction.is_approval() {
                    self.leave_approval(window, cx);
                }
            }
            ClientEvent::AbortFailed { run_id, message } => {
                if self.conversation.abort_failed(&run_id) {
                    self.conversation.show_error(message);
                }
            }
            ClientEvent::ApprovalResolved { request_id } => {
                let matches_current = self
                    .conversation
                    .pending_approval
                    .as_ref()
                    .is_some_and(|approval| approval.request_id == request_id);
                if matches_current && self.interaction.approval_submission_accepted(&request_id) {
                    self.leave_approval(window, cx);
                    let _ = self.commands.send(ClientCommand::RefreshHistory);
                }
            }
            ClientEvent::ApprovalFailed {
                request_id,
                message,
            } => self.handle_approval_failure(&request_id, message, window, cx),
            ClientEvent::ShellResult {
                command,
                output,
                exit_code,
            } => {
                if let Some(exchange) = self
                    .terminal
                    .iter_mut()
                    .find(|exchange| exchange.pending && exchange.command == command)
                {
                    exchange.output = output;
                    exchange.exit_code = exit_code;
                    exchange.pending = false;
                } else {
                    self.terminal.push(super::TerminalExchange {
                        command,
                        output,
                        exit_code,
                        pending: false,
                    });
                }
            }
            ClientEvent::MediaLoaded {
                request_id,
                bytes,
                mime_type,
                _lease,
            } => {
                if let Some(preparation) = self
                    .media_cache
                    .preparation_for(request_id, bytes, mime_type)
                {
                    self.begin_media_preparation(request_id, preparation, _lease, cx);
                }
            }
            ClientEvent::MediaFailed {
                request_id,
                message,
            } => {
                drop(message);
                self.media_cache.failed(request_id);
            }
            ClientEvent::Error(message) => {
                if self.show_login_runtime_error(message.clone(), window, cx) {
                    return;
                }
                if let Some(approval) = self.conversation.pending_approval.clone() {
                    self.conversation.show_error(message);
                    self.conversation.set_approval(approval);
                } else {
                    self.conversation.show_error(message);
                }
            }
        }
    }

    fn reconcile_history(&mut self, history: Value, window: &mut Window, cx: &mut Context<Self>) {
        if self.last_history.as_ref() == Some(&history) {
            return;
        }
        self.last_history = Some(history.clone());
        let live_moment = self
            .conversation
            .moments
            .iter()
            .rev()
            .find(|moment| moment.state == MomentState::Streaming)
            .cloned();
        let active_run_id = history
            .get("activeRunId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let live_text = active_run_id.as_deref().and_then(|run_id| {
            live_moment
                .as_ref()
                .filter(|moment| moment.run_id.as_deref() == Some(run_id))
                .map(|moment| moment.text.as_str())
        });
        let live_media = active_run_id.as_deref().and_then(|run_id| {
            live_moment
                .as_ref()
                .filter(|moment| moment.run_id.as_deref() == Some(run_id))
                .map(|moment| moment.media.clone())
        });

        self.conversation.replace_history(parse_history(&history));
        self.conversation
            .reconcile_active_run(active_run_id.as_deref(), live_text);
        if let Some(live_media) = live_media.filter(|media| !media.is_empty()) {
            self.conversation
                .replace_run_media(active_run_id.as_deref(), live_media);
        }
        self.prepared_content
            .preload(&self.conversation.moments, self.conversation.selected);

        if let Some(approval) = history.get("pendingHil").and_then(parse_pending_approval) {
            self.enter_approval(approval, window, cx);
        } else if self.conversation.pending_approval.is_some() {
            self.leave_approval(window, cx);
        }
        self.timeline_scroll
            .scroll_to_item(self.conversation.selected);
    }

    fn handle_signal(
        &mut self,
        name: &str,
        payload: &Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let (Some(expected), Some(actual)) = (
            self.pid.as_deref(),
            payload.get("pid").and_then(Value::as_str),
        ) {
            if expected != actual {
                return;
            }
        }

        let run_id = payload.get("runId").and_then(Value::as_str);
        match name {
            "proc.run.started" => {
                if let Some(run_id) = run_id {
                    self.conversation.start_run(run_id);
                }
            }
            "proc.run.stream" => {
                let event = payload.get("event").unwrap_or(payload);
                if event.get("type").and_then(Value::as_str) == Some("text_delta") {
                    if !self.accept_stream_sequence(run_id, payload) {
                        return;
                    }
                    let before = self.visible_moment_key();
                    if let Some(partial) = stream_partial_text(event) {
                        self.conversation.replace_run_text(run_id, &partial);
                    } else if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                        self.conversation.stream_text(run_id, delta);
                    }
                    self.reveal_visible_change(before);
                }
            }
            "proc.run.retrying" => {
                if self.conversation.accepts_run(run_id) {
                    self.conversation.activity = Some(if payload.get("fallback").is_some() {
                        "TRYING ANOTHER PATH".to_string()
                    } else {
                        "TRYING AGAIN".to_string()
                    });
                }
            }
            "proc.run.output" => {
                let before = self.visible_moment_key();
                let text = payload
                    .get("text")
                    .or_else(|| payload.get("output"))
                    .map(extract_text)
                    .unwrap_or_default();
                if !text.is_empty() {
                    self.conversation.replace_run_text(run_id, &text);
                }
                if let Some(media) = payload.get("media") {
                    self.conversation
                        .replace_run_media(run_id, parse_media(media));
                }
                self.reveal_visible_change(before);
            }
            "proc.run.tool.started" => {
                if !self.conversation.accepts_run(run_id) {
                    return;
                }
                let syscall = payload
                    .get("syscall")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.conversation.activity = Some(human_activity(syscall).to_string());
            }
            "proc.run.hil.requested" => {
                if let Some(approval) = parse_pending_approval(payload) {
                    self.enter_approval(approval, window, cx);
                }
            }
            "proc.run.finished" => {
                let before = self.visible_moment_key();
                let error = payload.get("error").map(extract_text);
                if let Some(media) = payload.get("media") {
                    self.conversation
                        .replace_run_media(run_id, parse_media(media));
                }
                let finished = self
                    .conversation
                    .finish_run(run_id, error.as_deref().filter(|text| !text.is_empty()));
                if finished && self.interaction.is_approval() {
                    self.leave_approval(window, cx);
                }
                if let Some(run_id) = run_id {
                    self.stream_sequences.remove(run_id);
                }
                self.reveal_visible_change(before);
                let _ = self.commands.send(ClientCommand::RefreshHistory);
            }
            "proc.changed" if signal_requests_history(payload) => {
                let _ = self.commands.send(ClientCommand::RefreshHistory);
            }
            "process.exit" => {
                self.conversation.connection = ConnectionState::Connecting;
                self.conversation.activity = Some("OPENING A NEW CONVERSATION".to_string());
            }
            _ => {}
        }
    }

    fn enter_approval(
        &mut self,
        approval: PendingApproval,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let is_new_request = self
            .conversation
            .pending_approval
            .as_ref()
            .is_none_or(|pending| pending.request_id != approval.request_id);
        if !self.conversation.set_approval(approval) {
            return;
        }
        if is_new_request {
            self.approval_resume_mode
                .get_or_insert(self.conversation.mode);
            if self.conversation.mode == crate::model::SurfaceMode::Terminal {
                self.terminal_draft = self.input.read(cx).value().to_string();
                self.conversation.mode = crate::model::SurfaceMode::Conversation;
            }
            self.interaction.enter_approval();
            self.set_input_value(String::new(), window, cx);
            self.timeline_scroll
                .scroll_to_item(self.conversation.selected);
            self.begin_transition(1.0);
        }
    }

    fn leave_approval(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.conversation.clear_approval();
        self.interaction.leave_approval();
        self.conversation.mode = self
            .approval_resume_mode
            .take()
            .unwrap_or(crate::model::SurfaceMode::Conversation);
        let value = if self.conversation.mode == crate::model::SurfaceMode::Terminal {
            self.terminal_draft.clone()
        } else {
            self.interaction.conversation_draft().to_string()
        };
        self.set_input_value(value, window, cx);
        if self.conversation.mode == crate::model::SurfaceMode::Conversation
            && self.interaction.layer == CanvasLayer::Draft
        {
            self.timeline_scroll
                .scroll_to_item(self.conversation.moments.len());
        }
    }

    pub(super) fn handle_approval_failure(
        &mut self,
        request_id: &str,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(failure) = self.interaction.approval_submission_failed(request_id) else {
            return;
        };
        self.conversation.activity = Some("NOT APPLIED · TRY AGAIN".to_string());
        if let ApprovalSubmissionFailure::RestoreDecision { text } = failure {
            if self.conversation.mode == crate::model::SurfaceMode::Conversation {
                self.set_input_value(text, window, cx);
            }
        }
        self.conversation.show_error(message);
        if let Some(approval) = self.conversation.pending_approval.clone() {
            let _ = self.conversation.set_approval(approval);
            self.conversation.activity = Some("NOT APPLIED · TRY AGAIN".to_string());
        }
    }

    fn accept_stream_sequence(&mut self, run_id: Option<&str>, payload: &Value) -> bool {
        let (Some(run_id), Some(sequence)) = (run_id, payload.get("seq").and_then(Value::as_u64))
        else {
            return true;
        };
        if self
            .stream_sequences
            .get(run_id)
            .is_some_and(|previous| *previous >= sequence)
        {
            return false;
        }
        self.stream_sequences.insert(run_id.to_string(), sequence);
        true
    }

    fn visible_moment_key(&self) -> Option<(String, bool)> {
        if self.interaction.visible_draft().is_some() {
            return None;
        }
        self.conversation.current().map(|moment| {
            (
                moment.id.clone(),
                !moment.text.trim().is_empty() || !moment.media.is_empty(),
            )
        })
    }

    fn reveal_visible_change(&mut self, before: Option<(String, bool)>) {
        let after = self.visible_moment_key();
        if after != before && after.as_ref().is_some_and(|(_, visible)| *visible) {
            self.timeline_scroll
                .scroll_to_item(self.conversation.selected);
            self.begin_transition(1.0);
        }
    }
}

fn stream_partial_text(event: &Value) -> Option<String> {
    let content = event.get("partial")?.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

fn signal_requests_history(payload: &Value) -> bool {
    if let Some(changes) = payload.get("changes").and_then(Value::as_array) {
        return changes
            .iter()
            .filter_map(Value::as_str)
            .any(|change| matches!(change, "messages" | "queue" | "lifecycle"));
    }
    payload.get("queuedCount").is_some() || payload.get("activeRunId").is_some()
}

fn history_was_superseded(request_signal_id: u64, response_signal_id: u64) -> bool {
    response_signal_id > request_signal_id
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn message_change_arrays_refresh_history() {
        assert!(signal_requests_history(&json!({
            "changes": ["messages"],
            "queuedCount": 0
        })));
        assert!(signal_requests_history(&json!({
            "changes": ["queue"]
        })));
        assert!(!signal_requests_history(&json!({
            "changes": ["context"]
        })));
    }

    #[test]
    fn a_history_observed_before_a_new_signal_is_superseded() {
        assert!(history_was_superseded(7, 8));
        assert!(!history_was_superseded(8, 8));
        assert!(!history_was_superseded(9, 8));
    }
}
