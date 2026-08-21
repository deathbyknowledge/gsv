use gpui::{Context, Window};
use serde_json::Value;

use crate::client::{ClientCommand, ClientEvent, PreparedHistory};
use crate::interaction::{ApprovalSubmissionFailure, CanvasLayer};
use crate::model::{
    activity_from_history, extract_text, moments_from_history, parse_media, parse_pending_approval,
    parse_tool_finished_activity, parse_tool_started_activity, pending_approval_from_history,
    ConnectionState, MomentState, PendingApproval,
};

use super::media::release_assets;
use super::GsvApp;

impl GsvApp {
    pub(super) fn handle_client_event(
        &mut self,
        event: ClientEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ClientEvent::DesktopControl(request) => {
                self.handle_desktop_control(request, window, cx);
            }
            ClientEvent::DesktopControlSettled => {
                self.desktop_switch_pending = false;
                self.desktop_switch_source_pid = None;
            }
            ClientEvent::Connecting => {
                self.conversation.connection = ConnectionState::Connecting;
                self.conversation.activity = Some("CONNECTING".to_string());
                self.conversation.clear_live_activity(None);
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
                if self.voice_draft.is_some() {
                    self.cancel_dictation(true, window, cx);
                }
                let released = self.media_cache.clear(&self.commands);
                self.cancel_stale_media_preparations();
                release_assets(released, cx);
                self.client_session_id = None;
                self.pid = None;
                self.last_history = None;
                self.last_history_generation = 0;
                self.history_preparations.clear();
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
                self.conversation.clear_live_activity(None);
            }
            ClientEvent::Connected {
                attempt_id,
                session_id,
                pid,
                machine_configured,
                suggested_machine_name,
            } => {
                if let Some(login) = &mut self.login {
                    if !login.accept_connection(attempt_id) {
                        return;
                    }
                }
                self.finish_login(window, cx);
                let switching_process = self.desktop_switch_pending
                    && self
                        .desktop_switch_source_pid
                        .as_deref()
                        .is_some_and(|active| active != pid);
                if switching_process || self.pid.as_deref().is_some_and(|active| active != pid) {
                    self.reset_process_workspace(window, cx);
                }
                let released = self.media_cache.clear(&self.commands);
                self.cancel_stale_media_preparations();
                release_assets(released, cx);
                self.client_session_id = Some(session_id);
                self.pid = Some(pid);
                self.last_history = None;
                self.last_history_generation = 0;
                self.history_preparations.clear();
                self.conversation.connection = ConnectionState::Connected;
                self.conversation.activity = None;
                self.conversation.clear_live_activity(None);
                self.machine_configured = machine_configured;
                self.begin_machine_management(
                    machine_configured,
                    suggested_machine_name,
                    window,
                    cx,
                );
            }
            ClientEvent::MachineSetupFinished {
                request_id,
                activation,
                ..
            } => {
                self.handle_machine_setup_success(request_id, activation, window, cx);
            }
            ClientEvent::MachineSetupFailed {
                request_id,
                automatic,
                message,
            } => {
                self.handle_machine_setup_failure(request_id, automatic, message, window, cx);
            }
            ClientEvent::MachineStatusChanged { status } => {
                self.machine_runtime_status = status;
            }
            ClientEvent::MachineControlFailed { message } => {
                self.conversation.show_error(message);
            }
            ClientEvent::MachineDiagnostics { diagnostics } => {
                self.conversation
                    .show_error(format_machine_diagnostics(&diagnostics));
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
                media,
            } => {
                let Some(submission) = self.interaction.submission_accepted(submission_id) else {
                    return;
                };
                if !media.is_empty() {
                    self.conversation
                        .replace_moment_media(&submission.moment_id, media);
                }
                self.cleanup_pending_attachment_snapshots(submission_id);
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
                media,
                message,
            } => {
                let Some(submission) = self.interaction.submission_accepted(submission_id) else {
                    return;
                };
                if submission.text != submitted_text {
                    return;
                }
                if !media.is_empty() {
                    self.conversation
                        .replace_moment_media(&submission.moment_id, media);
                }
                self.cleanup_pending_attachment_snapshots(submission_id);
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
            ClientEvent::MediaFileLoaded {
                bytes,
                mime_type,
                filename,
                action,
                _lease,
            } => self.materialize_media_file(bytes, mime_type, filename, action, _lease, cx),
            ClientEvent::MediaFileFailed { message } => {
                self.conversation.show_error(message);
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

    fn reconcile_history(
        &mut self,
        history: PreparedHistory,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if history.generation <= self.last_history_generation {
            return;
        }
        self.last_history_generation = history.generation;
        let snapshot = history.snapshot;
        if self.last_history == Some(snapshot.revision) {
            return;
        }
        self.last_history = Some(snapshot.revision);
        let live_moment = self
            .conversation
            .moments
            .iter()
            .rev()
            .find(|moment| moment.state == MomentState::Streaming)
            .cloned();
        let active_run_id = snapshot.active_run_id.as_deref().map(str::to_string);
        let live_text = active_run_id.as_deref().and_then(|run_id| {
            live_moment
                .as_ref()
                .filter(|moment| moment.run_id.as_deref() == Some(run_id))
                .map(|moment| moment.text.as_ref())
        });
        let live_media = active_run_id.as_deref().and_then(|run_id| {
            live_moment
                .as_ref()
                .filter(|moment| moment.run_id.as_deref() == Some(run_id))
                .map(|moment| moment.media.clone())
        });
        let moments = moments_from_history(&snapshot);
        let history_activity = activity_from_history(&snapshot.activity);
        let adoptions = self.conversation.history_identity_adoptions(&moments);

        self.prepared_content.adopt_identities(&adoptions);
        self.adopt_moment_presentations(&adoptions);
        self.conversation.replace_history(moments);
        self.conversation
            .reconcile_history_activity(history_activity);
        self.conversation
            .reconcile_active_run(active_run_id.as_deref(), live_text);
        if let Some(live_media) = live_media.filter(|media| !media.is_empty()) {
            self.conversation
                .replace_run_media(active_run_id.as_deref(), live_media);
        }
        let selected_id = self.conversation.current().map(|moment| moment.id.as_str());
        self.prepared_content
            .preload_history(&snapshot.preparation_candidates, selected_id);
        self.history_preparations = snapshot
            .preparation_candidates
            .iter()
            .map(|candidate| (candidate.id.to_string(), candidate.clone()))
            .collect();

        if let Some(approval) = snapshot
            .pending_approval
            .as_ref()
            .map(pending_approval_from_history)
        {
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
            "proc.run.tool.started" => {
                if let Some(activity) = parse_tool_started_activity(payload) {
                    self.conversation.set_live_activity(activity);
                }
            }
            "proc.run.tool.finished" => {
                if let Some(activity) = parse_tool_finished_activity(payload) {
                    self.conversation.finish_live_activity(&activity);
                }
            }
            "proc.run.stream" => {
                if !self.accept_stream_sequence(run_id, payload) {
                    return;
                }
                let event = payload.get("event").unwrap_or(payload);
                if event.get("type").and_then(Value::as_str) == Some("text_delta") {
                    let before = self.visible_moment_key();
                    if let Some(partial) = stream_partial_text(event) {
                        self.conversation.replace_run_text_owned(run_id, partial);
                    } else if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                        self.conversation.stream_text(run_id, delta);
                    }
                    self.reveal_visible_change(before);
                } else {
                    self.conversation.resume_thinking(run_id);
                }
            }
            "proc.run.retrying" => {
                if self.conversation.accepts_run(run_id) {
                    self.conversation.clear_live_activity(run_id);
                    self.conversation.activity = Some(if payload.get("fallback").is_some() {
                        "TRYING ANOTHER PATH".to_string()
                    } else {
                        "TRYING AGAIN".to_string()
                    });
                }
            }
            "proc.run.output" => {
                if self.conversation.accepts_run(run_id) {
                    self.conversation.clear_live_activity(run_id);
                }
                let before = self.visible_moment_key();
                let text = payload
                    .get("text")
                    .or_else(|| payload.get("output"))
                    .map(extract_text)
                    .unwrap_or_default();
                if !text.is_empty() {
                    self.conversation.replace_run_text_owned(run_id, text);
                }
                if let Some(media) = payload.get("media") {
                    self.conversation
                        .replace_run_media(run_id, parse_media(media));
                }
                self.reveal_visible_change(before);
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
                self.conversation.clear_live_activity(None);
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
            if self.voice_draft.is_some() {
                self.cancel_dictation(true, window, cx);
            }
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

fn format_machine_diagnostics(diagnostics: &daemon_protocol::Diagnostics) -> String {
    let phase = match diagnostics.status.phase {
        daemon_protocol::DaemonPhase::Starting => "starting",
        daemon_protocol::DaemonPhase::Connecting => "connecting",
        daemon_protocol::DaemonPhase::Connected => "connected",
        daemon_protocol::DaemonPhase::Reconnecting => "reconnecting",
        daemon_protocol::DaemonPhase::Reloading => "reloading",
        daemon_protocol::DaemonPhase::ShuttingDown => "shutting down",
    };
    if diagnostics.notices.is_empty() {
        return format!("Machine diagnostics found no problems. gsvd is {phase}.");
    }
    let mut notices = diagnostics
        .notices
        .iter()
        .take(3)
        .map(|notice| {
            let level = match notice.level {
                daemon_protocol::DiagnosticLevel::Info => "info",
                daemon_protocol::DiagnosticLevel::Warning => "warning",
                daemon_protocol::DiagnosticLevel::Error => "error",
            };
            format!("{level} {}: {}", notice.code, notice.message)
        })
        .collect::<Vec<_>>();
    if diagnostics.notices.len() > notices.len() {
        notices.push(format!(
            "{} more diagnostic notices",
            diagnostics.notices.len() - notices.len()
        ));
    }
    format!(
        "Machine diagnostics · gsvd is {phase} · {}",
        notices.join(" · ")
    )
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
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{AppContext as _, TestAppContext, WindowOptions};
    use gpui_component::Root;
    use serde_json::json;

    use crate::app::bind_keys;
    use crate::model::ActivityCategory;

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

    #[test]
    fn machine_diagnostics_are_bounded_for_the_desktop_surface() {
        let diagnostics = daemon_protocol::Diagnostics::new(
            daemon_protocol::DaemonStatus {
                version: "test".to_string(),
                process_id: 1,
                machine_id: "studio".to_string(),
                phase: daemon_protocol::DaemonPhase::Connected,
                connected: true,
                uptime_seconds: 5,
                reconnect_attempt: 0,
            },
            (0..5)
                .map(|index| daemon_protocol::DiagnosticNotice {
                    level: daemon_protocol::DiagnosticLevel::Warning,
                    code: format!("notice-{index}"),
                    message: "check it".to_string(),
                })
                .collect(),
        )
        .expect("bounded diagnostics");
        let message = format_machine_diagnostics(&diagnostics);
        assert!(message.contains("gsvd is connected"));
        assert!(message.contains("warning notice-0: check it"));
        assert!(message.contains("2 more diagnostic notices"));
        assert!(!message.contains("notice-3"));
    }

    #[gpui::test]
    fn accepted_non_text_stream_resumes_thinking_while_stale_stream_is_ignored(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let _window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        let send_signal = |name: &str, payload| {
            event_tx
                .send(ClientEvent::Signal {
                    session_id: 7,
                    name: name.to_string(),
                    payload,
                })
                .expect("the app should still receive client events");
        };
        event_tx
            .send(ClientEvent::Connected {
                attempt_id: 0,
                session_id: 7,
                pid: "pid-1".to_string(),
                machine_configured: true,
                suggested_machine_name: "Test computer".to_string(),
            })
            .expect("the app should connect");
        send_signal(
            "proc.run.started",
            json!({ "pid": "pid-1", "runId": "run-1" }),
        );
        send_signal(
            "proc.run.tool.started",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "callId": "call-1",
                "name": "Shell",
                "syscall": "shell.exec"
            }),
        );
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).conversation.live_activity_entries(),
                vec![crate::model::LiveActivityEntry {
                    category: ActivityCategory::RunningCommands,
                    count: 1,
                }]
            );
        });

        send_signal(
            "proc.run.stream",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "seq": 4,
                "event": { "type": "thinking_delta", "delta": "private thought" }
            }),
        );
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.conversation.live_activity_entries().is_empty());
            assert_eq!(app.conversation.activity.as_deref(), Some("THINKING"));
        });

        send_signal(
            "proc.run.tool.started",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "callId": "call-2",
                "name": "Read",
                "syscall": "fs.read"
            }),
        );
        send_signal(
            "proc.run.stream",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "seq": 3,
                "event": { "type": "thinking_delta", "delta": "stale private thought" }
            }),
        );
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.conversation.live_activity_entries(),
                vec![crate::model::LiveActivityEntry {
                    category: ActivityCategory::ReadingFiles,
                    count: 1,
                }]
            );
            assert_eq!(app.stream_sequences.get("run-1"), Some(&4));
        });

        send_signal(
            "proc.run.stream",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "seq": 5,
                "event": { "type": "thinking_delta", "delta": "new thought" }
            }),
        );
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.conversation.live_activity_entries().is_empty());
            assert_eq!(app.conversation.activity.as_deref(), Some("THINKING"));
        });

        for (call_id, execution_id) in
            [("parallel-a", "execution-a"), ("parallel-b", "execution-b")]
        {
            send_signal(
                "proc.run.tool.started",
                json!({
                    "pid": "pid-1",
                    "runId": "run-1",
                    "callId": call_id,
                    "executionId": execution_id,
                    "syscall": "fs.read"
                }),
            );
        }
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).conversation.live_activity_entries(),
                vec![crate::model::LiveActivityEntry {
                    category: ActivityCategory::ReadingFiles,
                    count: 2,
                }]
            );
        });

        send_signal(
            "proc.run.tool.finished",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "callId": "parallel-b",
                "executionId": "execution-b",
                "outcome": "completed",
                "timestamp": 12
            }),
        );
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).conversation.live_activity_entries(),
                vec![crate::model::LiveActivityEntry {
                    category: ActivityCategory::ReadingFiles,
                    count: 1,
                }]
            );
        });

        send_signal(
            "proc.run.tool.finished",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "callId": "parallel-a",
                "executionId": "execution-a",
                "outcome": "cancelled",
                "timestamp": 13
            }),
        );
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.conversation.live_activity_entries().is_empty());
            assert_eq!(app.conversation.activity.as_deref(), Some("THINKING"));
        });

        send_signal(
            "proc.run.tool.started",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "callId": "retry-tool",
                "executionId": "execution-retry",
                "syscall": "fs.write"
            }),
        );
        send_signal(
            "proc.run.retrying",
            json!({ "pid": "pid-1", "runId": "run-1" }),
        );
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.conversation.live_activity_entries().is_empty());
            assert_eq!(app.conversation.activity.as_deref(), Some("TRYING AGAIN"));
        });

        send_signal(
            "proc.run.tool.started",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "callId": "output-tool",
                "executionId": "execution-output",
                "syscall": "codemode.exec"
            }),
        );
        send_signal(
            "proc.run.output",
            json!({
                "pid": "pid-1",
                "runId": "run-1",
                "text": "Visible response"
            }),
        );
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.conversation.live_activity_entries().is_empty());
            assert!(app.conversation.activity.is_none());
        });
    }
}
