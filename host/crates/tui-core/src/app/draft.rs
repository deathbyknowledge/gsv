//! Draft editing, submission, and command recall.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub(crate) fn rebuild_command_history(&mut self) {
        self.command_history = self
            .moments
            .iter()
            .filter(|moment| moment.role == Role::Human && !moment.text.trim().is_empty())
            .map(|moment| CommandHistoryEntry {
                text: moment.text.clone(),
                execution: moment.execution,
                references: draft_references_from_artifacts(&moment.text, &moment.artifacts),
            })
            .collect();
        if self.command_history.len() > MAX_COMMAND_HISTORY {
            self.command_history
                .drain(..self.command_history.len() - MAX_COMMAND_HISTORY);
        }
        self.reset_history_navigation();
    }

    pub(crate) fn insert_draft_text(&mut self, value: &str) {
        if value.is_empty() {
            return;
        }
        let cursor = self.draft_cursor;
        self.draft_references.retain_mut(|reference| {
            if cursor > reference.start && cursor < reference.end {
                return false;
            }
            if reference.start >= cursor {
                reference.start = reference.start.saturating_add(value.len());
                reference.end = reference.end.saturating_add(value.len());
            }
            true
        });
        self.draft.insert_str(cursor, value);
        self.draft_cursor = cursor.saturating_add(value.len());
    }

    pub(crate) fn backspace_draft(&mut self) {
        if let Some(reference) = self
            .draft_references
            .iter()
            .find(|reference| {
                reference.start < self.draft_cursor && reference.end >= self.draft_cursor
            })
            .cloned()
        {
            self.delete_draft_range(reference.start, reference.end);
            self.draft_cursor = reference.start;
            return;
        }
        if let Some(previous) = previous_grapheme_boundary(&self.draft, self.draft_cursor) {
            self.delete_draft_range(previous, self.draft_cursor);
            self.draft_cursor = previous;
        }
    }

    pub(crate) fn delete_draft(&mut self) {
        if let Some(reference) = self
            .draft_references
            .iter()
            .find(|reference| {
                reference.start <= self.draft_cursor && reference.end > self.draft_cursor
            })
            .cloned()
        {
            self.delete_draft_range(reference.start, reference.end);
            self.draft_cursor = reference.start;
            return;
        }
        if let Some(next) = next_grapheme_boundary(&self.draft, self.draft_cursor) {
            self.delete_draft_range(self.draft_cursor, next);
        }
    }

    pub(crate) fn delete_draft_range(&mut self, start: usize, end: usize) {
        if start >= end || end > self.draft.len() {
            return;
        }
        let removed = end - start;
        self.draft_references.retain_mut(|reference| {
            if reference.end <= start {
                return true;
            }
            if reference.start >= end {
                reference.start -= removed;
                reference.end -= removed;
                return true;
            }
            false
        });
        self.draft.drain(start..end);
    }

    pub(crate) fn begin_submission(&mut self) -> Option<Effect> {
        if self.pending_submission.is_some() || self.draft.trim().is_empty() {
            return None;
        }

        let id = self.next_submission_id;
        self.next_submission_id = self.next_submission_id.saturating_add(1);
        let execution = self.execution_mode;
        let text = std::mem::take(&mut self.draft);
        let references = std::mem::take(&mut self.draft_references);
        let resource_references = references
            .iter()
            .map(|reference| reference.reference.clone())
            .collect::<Vec<_>>();
        self.draft_cursor = 0;
        self.draft_visible = true;
        self.record_command(text.clone(), execution, references.clone());
        self.reset_history_navigation();
        self.pending_submission = Some(PendingSubmission {
            id,
            text: text.clone(),
            execution,
            references: references.clone(),
        });
        self.uncertain_submission = None;
        self.moments.push(
            Moment::complete(format!("local:user:{id}"), Role::Human, text.clone())
                .with_environment(self.active_environment().clone())
                .with_execution(execution)
                .with_artifacts(
                    resource_references
                        .iter()
                        .map(FileReference::artifact)
                        .collect(),
                ),
        );
        self.moments.push(Moment {
            id: match execution {
                ExecutionMode::Ship => format!("local:gsv:{id}"),
                ExecutionMode::Shell => format!("local:shell:{id}"),
            },
            role: Role::Intelligence,
            execution,
            text: String::new(),
            run_id: None,
            sequence: None,
            timestamp: None,
            state: MomentState::Streaming,
            artifacts: Vec::new(),
            environment: None,
        });
        self.selected = self.moments.len().saturating_sub(1);
        self.document_scroll = 0;
        self.follow_latest = true;
        self.scroll_anchor = None;
        self.media_expanded = false;
        self.media_focus = None;
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Working
        };
        self.activity = Some(
            match execution {
                ExecutionMode::Ship => "SENDING",
                ExecutionMode::Shell => "RUNNING",
            }
            .to_string(),
        );
        let environment = self.active_environment().clone();
        match execution {
            ExecutionMode::Ship => Some(Effect::Submit {
                id,
                text,
                target: environment.target,
                cwd: environment.cwd,
                references: resource_references,
            }),
            ExecutionMode::Shell => {
                self.active_shell = Some(id);
                Some(Effect::Shell {
                    id,
                    input: text,
                    target: environment.target,
                    cwd: environment.cwd,
                })
            }
        }
    }

    pub fn submission_accepted(&mut self, id: u64, run_id: String, queued: bool) {
        if self
            .pending_submission
            .as_ref()
            .is_none_or(|pending| pending.id != id || pending.execution != ExecutionMode::Ship)
        {
            return;
        }
        self.pending_submission = None;
        let local_user_id = format!("local:user:{id}");
        for local_id in [local_user_id.clone(), format!("local:gsv:{id}")] {
            if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
                moment.run_id = Some(run_id.clone());
            }
        }
        if let Some(run) = self
            .action_runs
            .iter_mut()
            .find(|actions| actions.run_id == run_id)
        {
            for action in &mut run.actions {
                if action.started_at.is_none() && action.after_moment_id.is_none() {
                    action.after_moment_id = Some(local_user_id.clone());
                }
            }
        }
        if self.moments.iter().any(|moment| {
            moment.run_id.as_deref() == Some(&run_id)
                && moment.execution == ExecutionMode::Ship
                && moment.state == MomentState::Streaming
        }) {
            self.active_run = Some(run_id);
        }
        self.activity = Some(if queued { "QUEUED" } else { "THINKING" }.to_string());
    }

    pub fn submission_failed(&mut self, id: u64, error: impl Into<String>) {
        let Some(pending) = self.pending_submission.take() else {
            return;
        };
        if pending.id != id {
            self.pending_submission = Some(pending);
            return;
        }
        if self.draft.is_empty() {
            self.draft = pending.text;
            self.draft_references = pending.references;
            self.draft_cursor = self.draft.len();
            self.draft_visible = true;
        }
        let local_id = format!("local:gsv:{id}");
        if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
            moment.text = error.into();
            moment.state = MomentState::Error;
        }
        if !matches!(
            self.connection,
            ConnectionState::Offline | ConnectionState::Connecting
        ) {
            self.connection = if self.active_run.is_some() || self.active_shell.is_some() {
                ConnectionState::Working
            } else {
                ConnectionState::Ready
            };
        }
        self.activity = None;
    }

    pub(crate) fn record_command(
        &mut self,
        text: String,
        execution: ExecutionMode,
        references: Vec<DraftReference>,
    ) {
        if text.trim().is_empty() {
            return;
        }
        self.command_history.push(CommandHistoryEntry {
            text,
            execution,
            references,
        });
        if self.command_history.len() > MAX_COMMAND_HISTORY {
            self.command_history.remove(0);
        }
    }

    pub(crate) fn reset_history_navigation(&mut self) {
        self.history_position = None;
        self.history_draft = None;
    }

    pub(crate) fn recall_previous_command(&mut self) {
        if self.command_history.is_empty() {
            return;
        }
        let position = match self.history_position {
            Some(position) => position.saturating_sub(1),
            None => {
                self.history_draft = Some(DraftSnapshot {
                    text: self.draft.clone(),
                    cursor: self.draft_cursor,
                    execution: self.execution_mode,
                    references: self.draft_references.clone(),
                });
                self.command_history.len() - 1
            }
        };
        self.history_position = Some(position);
        self.load_history_position(position);
    }

    pub(crate) fn recall_next_command(&mut self) {
        let Some(position) = self.history_position else {
            return;
        };
        if position + 1 < self.command_history.len() {
            let position = position + 1;
            self.history_position = Some(position);
            self.load_history_position(position);
            return;
        }
        let snapshot = self.history_draft.take().unwrap_or(DraftSnapshot {
            text: String::new(),
            cursor: 0,
            execution: self.execution_mode,
            references: Vec::new(),
        });
        self.history_position = None;
        self.draft = snapshot.text;
        self.draft_references = snapshot.references;
        self.draft_cursor = snapshot.cursor.min(self.draft.len());
        self.execution_mode = snapshot.execution;
        self.draft_visible = true;
        self.follow_latest = true;
        self.media_expanded = false;
    }

    pub(crate) fn load_history_position(&mut self, position: usize) {
        let Some(entry) = self.command_history.get(position) else {
            return;
        };
        self.draft.clone_from(&entry.text);
        self.draft_references.clone_from(&entry.references);
        self.draft_cursor = self.draft.len();
        self.execution_mode = entry.execution;
        self.draft_visible = true;
        self.follow_latest = true;
        self.media_expanded = false;
    }
}
