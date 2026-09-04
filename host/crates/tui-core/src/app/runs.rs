//! Runs, streamed replies, shell output, and committed moments.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub fn start_run(&mut self, run_id: &str) {
        self.start_run_at(run_id, None);
    }

    pub fn start_run_at(&mut self, run_id: &str, timestamp: Option<u64>) {
        if run_id.is_empty() {
            return;
        }
        if let Some(index) = self.streaming_moment_for(Some(run_id)) {
            self.moments[index].run_id = Some(run_id.to_string());
            if timestamp.is_some() && self.moments[index].timestamp.is_none() {
                self.moments[index].timestamp = timestamp;
            }
        } else {
            self.moments.push(Moment {
                id: format!("activity:{run_id}"),
                role: Role::Intelligence,
                execution: ExecutionMode::Ship,
                text: String::new(),
                run_id: Some(run_id.to_string()),
                sequence: None,
                timestamp,
                state: MomentState::Streaming,
                artifacts: Vec::new(),
                environment: None,
            });
            if self.follow_latest {
                self.selected = self.moments.len().saturating_sub(1);
                self.media_focus = None;
            }
        }
        self.active_run = Some(run_id.to_string());
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Working
        };
        self.activity = Some("THINKING".to_string());
    }

    pub fn start_message_stream(&mut self, run_id: &str, message_id: &str) {
        self.start_message_stream_at(run_id, message_id, None);
    }

    pub fn start_message_stream_at(
        &mut self,
        run_id: &str,
        message_id: &str,
        timestamp: Option<u64>,
    ) {
        self.start_run_at(run_id, timestamp);
        if self.moments.iter().any(|moment| moment.id == message_id) {
            return;
        }
        if let Some(index) = self.streaming_moment_for(Some(run_id)) {
            if self.moments[index].text.is_empty() && self.moments[index].artifacts.is_empty() {
                self.moments[index].id = message_id.to_string();
                self.moments[index].run_id = Some(run_id.to_string());
                self.moments[index].timestamp = timestamp;
                return;
            }
        }
        self.moments.push(Moment {
            id: message_id.to_string(),
            role: Role::Intelligence,
            execution: ExecutionMode::Ship,
            text: String::new(),
            run_id: Some(run_id.to_string()),
            sequence: None,
            timestamp,
            state: MomentState::Streaming,
            artifacts: Vec::new(),
            environment: None,
        });
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
            self.media_focus = None;
        }
    }

    pub fn append_message_delta(&mut self, run_id: Option<&str>, message_id: &str, delta: &str) {
        let followed_latest = self.follow_latest;
        let mut index = self.moments.iter().rposition(|moment| {
            moment.id == message_id
                && moment.role == Role::Intelligence
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
        });
        if index.is_none() {
            if let Some(run_id) = run_id {
                self.start_message_stream(run_id, message_id);
            } else if !self.moments.iter().any(|moment| moment.id == message_id) {
                self.moments.push(Moment {
                    id: message_id.to_string(),
                    role: Role::Intelligence,
                    execution: ExecutionMode::Ship,
                    text: String::new(),
                    run_id: None,
                    sequence: None,
                    timestamp: None,
                    state: MomentState::Streaming,
                    artifacts: Vec::new(),
                    environment: None,
                });
            }
            index = self.moments.iter().rposition(|moment| {
                moment.id == message_id
                    && moment.role == Role::Intelligence
                    && moment.execution == ExecutionMode::Ship
                    && moment.state == MomentState::Streaming
            });
        }
        let Some(index) = index else {
            return;
        };
        if self.moments[index].run_id.is_none() {
            self.moments[index].run_id = run_id.map(str::to_string);
        }
        self.moments[index].text.push_str(delta);
        self.activity = Some("RESPONDING".to_string());
        if followed_latest {
            self.selected = index;
            self.media_focus = None;
        }
    }

    pub fn abort_message_stream(&mut self, message_id: &str) {
        let Some(index) = self.moments.iter().position(|moment| {
            moment.id == message_id
                && moment.role == Role::Intelligence
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
        }) else {
            return;
        };
        self.moments.remove(index);
        self.selected = self.selected.min(self.moments.len().saturating_sub(1));
        self.media_focus = None;
    }

    pub fn finish_run(&mut self, run_id: Option<&str>, error: Option<&str>) {
        let effective_run = run_id
            .map(str::to_string)
            .or_else(|| self.active_run.clone());
        let is_active = effective_run
            .as_deref()
            .is_some_and(|run_id| self.active_run.as_deref() == Some(run_id));
        let index = self.moments.iter().rposition(|moment| {
            moment.role == Role::Intelligence
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
                && effective_run
                    .as_deref()
                    .is_none_or(|run_id| moment.run_id.as_deref() == Some(run_id))
        });
        let has_actions = effective_run
            .as_deref()
            .is_some_and(|run_id| self.action_runs.iter().any(|run| run.run_id == run_id));
        if !is_active && index.is_none() && !has_actions {
            return;
        }

        if let Some(error) = error.filter(|error| !error.is_empty()) {
            if let Some(index) = index {
                let moment = &mut self.moments[index];
                if !moment.text.is_empty() {
                    moment.text.push_str("\n\n");
                }
                moment.text.push_str(error);
                moment.state = MomentState::Error;
            } else {
                self.moments.push(Moment {
                    id: effective_run
                        .as_deref()
                        .map(|run_id| format!("error:{run_id}"))
                        .unwrap_or_else(|| format!("error:{}", self.moments.len())),
                    role: Role::Intelligence,
                    execution: ExecutionMode::Ship,
                    text: error.to_string(),
                    run_id: effective_run.clone(),
                    sequence: None,
                    timestamp: None,
                    state: MomentState::Error,
                    artifacts: Vec::new(),
                    environment: None,
                });
            }
        } else if let Some(index) = index {
            if self.moments[index].text.is_empty() && self.moments[index].artifacts.is_empty() {
                self.moments.remove(index);
            } else {
                self.moments[index].state = MomentState::Complete;
            }
        }

        if let Some(run_id) = effective_run.as_deref() {
            self.finish_action_run(run_id, error.is_some());
        }

        if is_active {
            self.active_run = None;
            self.connection = if self.connection == ConnectionState::Demo {
                ConnectionState::Demo
            } else if self.active_shell.is_some() {
                ConnectionState::Working
            } else {
                ConnectionState::Ready
            };
            self.activity = None;
            self.approval = None;
            self.approval_run_id = None;
            if self.follow_latest {
                self.selected = self.moments.len().saturating_sub(1);
                self.media_focus = None;
            }
        }
    }

    pub fn commit_message(
        &mut self,
        id: impl Into<String>,
        role: Role,
        text: impl Into<String>,
        run_id: Option<String>,
        artifacts: Vec<Artifact>,
        environment: Option<CapabilityEnvironment>,
    ) {
        self.commit_moment(Moment {
            id: id.into(),
            role,
            execution: ExecutionMode::Ship,
            text: text.into(),
            run_id,
            sequence: None,
            timestamp: None,
            state: MomentState::Complete,
            artifacts,
            environment,
        });
    }

    pub fn commit_moment(&mut self, moment: Moment) {
        let Moment {
            id,
            role,
            execution: _,
            text,
            run_id,
            sequence,
            timestamp,
            state: _,
            artifacts,
            environment,
        } = moment;
        if self.moments.iter().any(|moment| moment.id == id) {
            return;
        }
        if role == Role::Human {
            let exact_run = run_id.as_deref().and_then(|run_id| {
                self.moments.iter().rposition(|moment| {
                    moment.role == Role::Human
                        && moment.execution == ExecutionMode::Ship
                        && moment.id.starts_with("local:user:")
                        && moment.run_id.as_deref() == Some(run_id)
                })
            });
            let unbound = self.moments.iter().rposition(|moment| {
                moment.role == Role::Human
                    && moment.execution == ExecutionMode::Ship
                    && moment.id.starts_with("local:user:")
                    && moment.run_id.is_none()
                    && moment.text == text
            });
            if let Some(index) = exact_run.or(unbound) {
                let old_id = self.moments[index].id.clone();
                {
                    let moment = &mut self.moments[index];
                    moment.id = id.clone();
                    moment.run_id = run_id.clone();
                    moment.artifacts = artifacts;
                    moment.sequence = sequence;
                    moment.timestamp = timestamp;
                    if environment.is_some() {
                        moment.environment = environment;
                    }
                }
                for action in self.action_runs.iter_mut().flat_map(|run| &mut run.actions) {
                    if action.after_moment_id.as_deref() == Some(old_id.as_str()) {
                        action.after_moment_id = Some(id.clone());
                    }
                }
                if let Some(submission_id) = old_id.strip_prefix("local:user:") {
                    let response_id = format!("local:gsv:{submission_id}");
                    if let Some(response_index) = self.moments.iter().position(|moment| {
                        moment.id == response_id && moment.state == MomentState::Error
                    }) {
                        self.moments.remove(response_index);
                        self.selected = self.selected.min(self.moments.len().saturating_sub(1));
                        self.media_focus = None;
                    }
                }
                if self
                    .uncertain_submission
                    .as_ref()
                    .is_some_and(|submission| {
                        submission.execution == ExecutionMode::Ship
                            && submission.text == text
                            && self.draft == submission.text
                    })
                {
                    self.draft.clear();
                    self.draft_references.clear();
                    self.draft_cursor = 0;
                }
                self.uncertain_submission = None;
                return;
            }
        }
        if role == Role::Intelligence {
            if let Some(index) = run_id.as_deref().and_then(|run_id| {
                self.moments.iter().rposition(|moment| {
                    moment.role == Role::Intelligence
                        && moment.execution == ExecutionMode::Ship
                        && (moment.state == MomentState::Streaming
                            || moment.id.starts_with("draft:"))
                        && moment.run_id.as_deref() == Some(run_id)
                })
            }) {
                let streamed = &self.moments[index].text;
                let reconciles_stream = streamed.is_empty()
                    || streamed == &text
                    || text.starts_with(streamed.as_str())
                    || streamed.starts_with(text.as_str());
                if reconciles_stream {
                    {
                        let moment = &mut self.moments[index];
                        moment.id = id;
                        moment.text = text;
                        moment.state = MomentState::Complete;
                        moment.artifacts = artifacts;
                        moment.sequence = sequence;
                        moment.timestamp = timestamp;
                    }
                    if let Some(run_id) = run_id
                        .as_deref()
                        .filter(|run_id| self.active_run.as_deref() == Some(*run_id))
                    {
                        self.start_run(run_id);
                    }
                    return;
                }
            }
        }
        if role == Role::Human {
            let references = draft_references_from_artifacts(&text, &artifacts);
            self.record_command(text.clone(), ExecutionMode::Ship, references);
        }
        let continuing_run = (role == Role::Intelligence)
            .then(|| run_id.clone())
            .flatten()
            .filter(|run_id| self.active_run.as_deref() == Some(run_id));
        self.moments.push(Moment {
            id,
            role,
            execution: ExecutionMode::Ship,
            text,
            run_id,
            sequence,
            timestamp,
            state: MomentState::Complete,
            artifacts,
            environment,
        });
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
            self.media_focus = None;
        }
        if let Some(run_id) = continuing_run {
            self.start_run(&run_id);
        }
    }

    pub fn complete_demo_submission(&mut self, id: u64, request: &str) {
        let run_id = format!("demo:{id}");
        let message_id = format!("demo:message:{id}");
        self.submission_accepted(id, run_id.clone(), false);
        self.start_message_stream(&run_id, &message_id);
        self.append_message_delta(Some(&run_id), &message_id, &demo_reply(request));
        if request.to_ascii_lowercase().contains("media") {
            if let Some(moment) = self
                .moments
                .iter_mut()
                .rfind(|moment| moment.run_id.as_deref() == Some(&run_id))
            {
                moment.artifacts.push(Artifact {
                    kind: MediaKind::Image,
                    mime_type: "image/png".to_string(),
                    filename: Some("gsv-preview.png".to_string()),
                    size: Some(218 * 1024),
                    duration_ms: None,
                    transcription: Some(
                        "A clean, full-screen GSV interface rendered as a terminal document."
                            .to_string(),
                    ),
                    source: Some("gsv:~/artifacts/gsv-preview.png".to_string()),
                    revision: Some("demo:1".to_string()),
                });
            }
        }
        self.finish_run(Some(&run_id), None);
    }

    pub fn append_shell_output(&mut self, id: u64, output: &str) {
        if self.active_shell != Some(id) || output.is_empty() {
            return;
        }
        let Some(moment) = self.moments.iter_mut().find(|moment| {
            moment.id == format!("local:shell:{id}")
                && moment.execution == ExecutionMode::Shell
                && moment.state == MomentState::Streaming
        }) else {
            return;
        };
        moment.text.push_str(output);
        self.activity = Some("RUNNING".to_string());
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
            self.media_focus = None;
        }
    }

    pub fn finish_shell(&mut self, id: u64, error: Option<&str>) {
        if self.active_shell != Some(id) {
            return;
        }
        let index = self
            .moments
            .iter()
            .position(|moment| moment.id == format!("local:shell:{id}"));
        if let Some(index) = index {
            if let Some(error) = error.filter(|error| !error.trim().is_empty()) {
                let moment = &mut self.moments[index];
                if !moment.text.is_empty() && !moment.text.ends_with('\n') {
                    moment.text.push('\n');
                }
                moment.text.push_str(error);
                moment.state = MomentState::Error;
            } else if self.moments[index].text.is_empty() {
                self.moments.remove(index);
            } else {
                self.moments[index].state = MomentState::Complete;
            }
        }
        if self
            .pending_submission
            .as_ref()
            .is_some_and(|pending| pending.id == id && pending.execution == ExecutionMode::Shell)
        {
            self.pending_submission = None;
        }
        self.active_shell = None;
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else if self.active_run.is_some() {
            ConnectionState::Working
        } else {
            ConnectionState::Ready
        };
        self.activity = self.active_run.as_ref().map(|_| "THINKING".to_string());
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
            self.media_focus = None;
        }
    }

    pub fn complete_demo_shell(&mut self, id: u64, input: &str) {
        let output = match input.trim() {
            "pwd" => {
                self.active_environment()
                    .cwd
                    .as_deref()
                    .unwrap_or("~")
                    .to_string()
                    + "\n"
            }
            "ls" | "ls -la" | "ls -lah" => {
                "Desktop  Documents  Downloads  Pictures  Projects\n".to_string()
            }
            _ => "Shell execution is unavailable in the disconnected preview.\n".to_string(),
        };
        self.append_shell_output(id, &output);
        self.finish_shell(id, None);
    }

    pub fn append_local_output(&mut self, text: impl AsRef<str>) {
        let text = sanitize_multiline(text.as_ref(), 4_000);
        if text.is_empty() {
            return;
        }
        self.moments.push(Moment {
            id: format!("local:output:{}", self.moments.len()),
            role: Role::System,
            execution: self.execution_mode,
            text,
            run_id: None,
            sequence: None,
            timestamp: None,
            state: MomentState::Error,
            artifacts: Vec::new(),
            environment: None,
        });
        if self.follow_latest {
            self.selected = self.moments.len().saturating_sub(1);
            self.media_focus = None;
        }
    }

    pub(crate) fn turn_start(&self, index: usize) -> usize {
        let index = index.min(self.moments.len().saturating_sub(1));
        if self
            .moments
            .get(index)
            .is_some_and(|moment| moment.role == Role::Human)
        {
            return index;
        }
        self.moments[..=index]
            .iter()
            .rposition(|moment| moment.role == Role::Human)
            .unwrap_or(index)
    }

    pub(crate) fn turn_end(&self, start: usize) -> usize {
        self.moments
            .iter()
            .enumerate()
            .skip(start.saturating_add(1))
            .find_map(|(index, moment)| (moment.role == Role::Human).then_some(index - 1))
            .unwrap_or_else(|| self.moments.len().saturating_sub(1))
    }

    pub(crate) fn streaming_moment_for(&self, run_id: Option<&str>) -> Option<usize> {
        if let Some(run_id) = run_id {
            if let Some(index) = self.moments.iter().rposition(|moment| {
                moment.role == Role::Intelligence
                    && moment.execution == ExecutionMode::Ship
                    && moment.state == MomentState::Streaming
                    && moment.run_id.as_deref() == Some(run_id)
            }) {
                return Some(index);
            }
            return self.moments.iter().rposition(|moment| {
                moment.role == Role::Intelligence
                    && moment.execution == ExecutionMode::Ship
                    && moment.state == MomentState::Streaming
                    && moment.run_id.is_none()
            });
        }
        self.moments.iter().rposition(|moment| {
            moment.role == Role::Intelligence
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
        })
    }
}
