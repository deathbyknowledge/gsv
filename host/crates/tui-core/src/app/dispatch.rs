//! Keyboard and control actions dispatched into state changes and effects.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub fn enter_approval(&mut self, approval: Approval) {
        let run_id = self.active_run.clone();
        self.enter_approval_for(run_id.as_deref(), approval);
    }

    pub fn enter_approval_for(&mut self, run_id: Option<&str>, mut approval: Approval) {
        approval.syscall = sanitize_label(&approval.syscall, "unknown action", 96);
        approval.target = sanitize_label(&approval.target, "unknown target", 96);
        approval.preview = sanitize_multiline(&approval.preview, 4_000);
        self.approval = Some(approval);
        self.approval_run_id = run_id.map(str::to_string);
        self.environment_picker = false;
        self.file_picker = None;
        self.command_search = None;
        self.transcript_search = None;
        self.reference_picker = None;
        self.media_expanded = false;
    }

    pub fn leave_approval(&mut self, request_id: &str) {
        if self
            .approval
            .as_ref()
            .is_some_and(|approval| approval.request_id == request_id)
        {
            self.approval = None;
            self.approval_run_id = None;
        }
    }

    pub fn dispatch(&mut self, action: Action) -> Vec<Effect> {
        if matches!(&action, Action::Abort) {
            return self
                .active_run
                .as_ref()
                .map_or_else(Vec::new, |_| vec![Effect::Abort]);
        }

        if self.help_visible {
            match &action {
                Action::Escape | Action::ToggleHelp => {
                    self.help_visible = false;
                    return Vec::new();
                }
                Action::ToggleActions | Action::ToggleMarkdown | Action::ToggleVim => {
                    self.help_visible = false;
                }
                Action::Quit => return vec![Effect::Quit],
                _ => return Vec::new(),
            }
        }

        if self.command_search.is_some() {
            return self.dispatch_command_search(action);
        }

        if self.transcript_search.is_some() {
            return self.dispatch_transcript_search(action);
        }

        if self.reference_picker.is_some() {
            return self.dispatch_reference_picker(action);
        }

        if self.file_picker.is_some() {
            return self.dispatch_file_picker(action);
        }

        if self.environment_picker {
            return match action {
                Action::Insert(value) => {
                    let value = sanitize_draft_input(&value);
                    if !value.is_empty() {
                        self.environment_query.push_str(&value);
                        self.environment_choice = 0;
                    }
                    Vec::new()
                }
                Action::Backspace | Action::Delete => {
                    if let Some(previous) = previous_grapheme_boundary(
                        &self.environment_query,
                        self.environment_query.len(),
                    ) {
                        self.environment_query.truncate(previous);
                        self.environment_choice = 0;
                    }
                    Vec::new()
                }
                Action::PreviousChoice | Action::PreviousTurn | Action::ScrollUp => {
                    let count = self.matching_environment_indices().len();
                    if count > 0 {
                        self.environment_choice = self
                            .environment_choice
                            .checked_sub(1)
                            .unwrap_or(count.saturating_sub(1));
                    }
                    Vec::new()
                }
                Action::NextChoice | Action::NextTurn | Action::ScrollDown => {
                    let count = self.matching_environment_indices().len();
                    if count > 0 {
                        self.environment_choice = (self.environment_choice + 1) % count;
                    }
                    Vec::new()
                }
                Action::Submit => {
                    self.select_environment_choice();
                    Vec::new()
                }
                Action::Escape => {
                    self.close_environment_picker();
                    Vec::new()
                }
                Action::Quit => vec![Effect::Quit],
                _ => Vec::new(),
            };
        }

        if let Some(approval) = &self.approval {
            return match action {
                Action::DecideApproval { decision, remember } => {
                    vec![Effect::DecideApproval {
                        request_id: approval.request_id.clone(),
                        decision,
                        remember,
                    }]
                }
                Action::ToggleHelp => {
                    self.help_visible = true;
                    Vec::new()
                }
                Action::Quit => vec![Effect::Quit],
                _ => Vec::new(),
            };
        }

        match action {
            Action::Insert(value) => {
                let value = sanitize_draft_input(&value);
                if value.is_empty() {
                    return Vec::new();
                }
                self.reset_history_navigation();
                if value == "@"
                    && self.execution_mode == ExecutionMode::Ship
                    && self.draft.is_empty()
                {
                    self.environment_picker = true;
                    self.environment_query.clear();
                    self.environment_choice = self
                        .matching_environment_indices()
                        .iter()
                        .position(|index| *index == self.active_environment)
                        .unwrap_or(0);
                    self.draft_visible = true;
                    return Vec::new();
                }
                if value == "@"
                    && self.execution_mode == ExecutionMode::Ship
                    && self.file_reference_can_begin_here()
                {
                    return self.open_file_picker();
                }
                self.media_expanded = false;
                self.draft_visible = true;
                self.follow_latest = true;
                self.insert_draft_text(&value);
                Vec::new()
            }
            Action::Backspace => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                self.backspace_draft();
                Vec::new()
            }
            Action::Delete => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                self.delete_draft();
                Vec::new()
            }
            Action::DeleteWord => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                let before = &self.draft[..self.draft_cursor];
                let trimmed = before.trim_end_matches(char::is_whitespace);
                let word_start = trimmed.rfind(char::is_whitespace).map_or(0, |index| {
                    index + trimmed[index..].chars().next().map_or(0, char::len_utf8)
                });
                let word_start = self
                    .draft_references
                    .iter()
                    .filter(|reference| {
                        reference.start < self.draft_cursor && reference.end > word_start
                    })
                    .map(|reference| reference.start)
                    .min()
                    .unwrap_or(word_start);
                self.delete_draft_range(word_start, self.draft_cursor);
                self.draft_cursor = word_start;
                Vec::new()
            }
            Action::MoveCursorLeft => {
                self.draft_cursor = self
                    .draft_references
                    .iter()
                    .find(|reference| {
                        reference.start < self.draft_cursor && reference.end >= self.draft_cursor
                    })
                    .map(|reference| reference.start)
                    .or_else(|| previous_grapheme_boundary(&self.draft, self.draft_cursor))
                    .unwrap_or(self.draft_cursor);
                Vec::new()
            }
            Action::MoveCursorRight => {
                self.draft_cursor = self
                    .draft_references
                    .iter()
                    .find(|reference| {
                        reference.start <= self.draft_cursor && reference.end > self.draft_cursor
                    })
                    .map(|reference| reference.end)
                    .or_else(|| next_grapheme_boundary(&self.draft, self.draft_cursor))
                    .unwrap_or(self.draft_cursor);
                Vec::new()
            }
            Action::MoveCursorHome => {
                self.draft_cursor = self.draft[..self.draft_cursor]
                    .rfind('\n')
                    .map_or(0, |index| index + 1);
                Vec::new()
            }
            Action::MoveCursorEnd => {
                self.draft_cursor = self.draft[self.draft_cursor..]
                    .find('\n')
                    .map_or(self.draft.len(), |index| self.draft_cursor + index);
                Vec::new()
            }
            Action::Newline => {
                self.reset_history_navigation();
                self.draft_visible = true;
                self.follow_latest = true;
                self.insert_draft_text("\n");
                Vec::new()
            }
            Action::OpenFiles => self.open_file_picker(),
            Action::OpenReferences => self.open_reference_picker(),
            Action::Submit => {
                if self.draft.is_empty() {
                    self.begin_submission()
                        .map_or_else(|| self.activate_media(), |effect| vec![effect])
                } else {
                    self.begin_submission().into_iter().collect()
                }
            }
            Action::BeginCompose => {
                self.media_expanded = false;
                self.draft_visible = true;
                self.follow_latest = true;
                Vec::new()
            }
            Action::Escape => {
                if self.media_expanded {
                    self.media_expanded = false;
                } else {
                    self.draft_visible = false;
                    self.sync_browse_focus(ScrollDirection::Newer);
                }
                Vec::new()
            }
            Action::PreviousCommand => {
                self.recall_previous_command();
                Vec::new()
            }
            Action::NextCommand => {
                self.recall_next_command();
                Vec::new()
            }
            Action::BeginCommandSearch => {
                self.begin_command_search();
                Vec::new()
            }
            Action::BeginTranscriptSearch => {
                self.begin_transcript_search();
                Vec::new()
            }
            Action::NextTranscriptMatch => {
                self.repeat_transcript_search(true);
                Vec::new()
            }
            Action::PreviousTranscriptMatch => {
                self.repeat_transcript_search(false);
                Vec::new()
            }
            Action::PreviousTurn => {
                self.previous_turn();
                Vec::new()
            }
            Action::NextTurn => {
                self.next_turn();
                Vec::new()
            }
            Action::FirstTurn => {
                if !self.draft_visible && !self.moments.is_empty() {
                    self.selected = self.turn_end(0);
                    self.scroll_anchor = Some(ScrollAnchor::Moment(0));
                    self.follow_latest = false;
                    self.media_expanded = false;
                    self.media_focus = None;
                }
                Vec::new()
            }
            Action::LastTurn => {
                if !self.draft_visible && !self.moments.is_empty() {
                    self.selected = self.moments.len().saturating_sub(1);
                    self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
                    self.follow_latest = true;
                    self.media_expanded = false;
                    self.media_focus = None;
                }
                Vec::new()
            }
            Action::ScrollUp => {
                if self.media_expanded {
                    self.move_media_focus(false);
                    return Vec::new();
                }
                self.scroll_older(3, true);
                self.load_older_history_if_needed()
            }
            Action::ScrollDown => {
                if self.media_expanded {
                    self.move_media_focus(true);
                    return Vec::new();
                }
                self.scroll_newer(3, true);
                Vec::new()
            }
            Action::ScrollPageUp => {
                self.scroll_older(self.last_viewport_height.saturating_sub(2).max(1), false);
                self.load_older_history_if_needed()
            }
            Action::ScrollPageDown => {
                self.scroll_newer(self.last_viewport_height.saturating_sub(2).max(1), false);
                Vec::new()
            }
            Action::PreviousChoice | Action::NextChoice => Vec::new(),
            Action::PreviousMedia => {
                self.move_media_focus(false);
                Vec::new()
            }
            Action::NextMedia => {
                self.move_media_focus(true);
                Vec::new()
            }
            Action::ToggleHelp => {
                self.help_visible = true;
                Vec::new()
            }
            Action::ToggleMarkdown => {
                self.raw_markdown = !self.raw_markdown;
                self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
                Vec::new()
            }
            Action::ToggleVim => {
                self.vim_enabled = !self.vim_enabled;
                Vec::new()
            }
            Action::ToggleShell => {
                self.reset_history_navigation();
                if !self.draft_references.is_empty() {
                    return Vec::new();
                }
                self.execution_mode = match self.execution_mode {
                    ExecutionMode::Ship => ExecutionMode::Shell,
                    ExecutionMode::Shell => ExecutionMode::Ship,
                };
                self.draft_visible = true;
                self.follow_latest = true;
                self.media_expanded = false;
                Vec::new()
            }
            Action::ToggleActions => {
                self.toggle_selected_actions();
                Vec::new()
            }
            Action::ToggleMedia => self.activate_media(),
            Action::Abort => unreachable!("abort actions are handled before modal dispatch"),
            Action::DecideApproval { .. } => Vec::new(),
            Action::Quit => vec![Effect::Quit],
        }
    }
}
