//! File completion and @file references in the draft.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub(crate) fn dispatch_file_picker(&mut self, action: Action) -> Vec<Effect> {
        match action {
            Action::Insert(value) => {
                let value = sanitize_draft_input(&value);
                if let Some(picker) = self.file_picker.as_mut() {
                    if !value.is_empty() {
                        picker.query.push_str(&value);
                        picker.choice = 0;
                    }
                }
                Vec::new()
            }
            Action::Backspace | Action::Delete => {
                let Some(picker) = self.file_picker.as_mut() else {
                    return Vec::new();
                };
                if let Some(previous) =
                    previous_grapheme_boundary(&picker.query, picker.query.len())
                {
                    picker.query.truncate(previous);
                    picker.choice = 0;
                } else {
                    self.file_picker = None;
                }
                Vec::new()
            }
            Action::PreviousChoice | Action::PreviousTurn | Action::ScrollUp => {
                let count = self.matching_file_entries().len();
                if let Some(picker) = self.file_picker.as_mut() {
                    if count > 0 {
                        picker.choice = picker
                            .choice
                            .checked_sub(1)
                            .unwrap_or(count.saturating_sub(1));
                    }
                }
                Vec::new()
            }
            Action::NextChoice | Action::NextTurn | Action::ScrollDown => {
                let count = self.matching_file_entries().len();
                if let Some(picker) = self.file_picker.as_mut() {
                    if count > 0 {
                        picker.choice = (picker.choice + 1) % count;
                    }
                }
                Vec::new()
            }
            Action::Submit => self.select_file_choice(),
            Action::OpenFiles => {
                self.file_picker = None;
                self.open_file_picker()
            }
            Action::Escape => {
                self.file_picker = None;
                Vec::new()
            }
            Action::Quit => vec![Effect::Quit],
            _ => Vec::new(),
        }
    }

    pub(crate) fn file_reference_can_begin_here(&self) -> bool {
        !self.draft.is_empty()
            && (self.draft_cursor == 0
                || self.draft[..self.draft_cursor]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace))
    }

    pub(crate) fn open_file_picker(&mut self) -> Vec<Effect> {
        if self.execution_mode != ExecutionMode::Ship {
            return Vec::new();
        }
        self.close_environment_picker();
        self.command_search = None;
        self.transcript_search = None;
        self.reference_picker = None;
        let request_id = self.next_file_request_id;
        self.next_file_request_id = self.next_file_request_id.saturating_add(1);
        let environment = self.active_environment().clone();
        let directory = environment
            .cwd
            .clone()
            .filter(|cwd| !cwd.trim().is_empty())
            .unwrap_or_else(|| "~".to_string());
        self.file_picker = Some(FilePicker {
            request_id,
            target: environment.target.clone(),
            insertion: self.draft_cursor,
            directory: directory.clone(),
            query: String::new(),
            choice: 0,
            entries: Vec::new(),
            loading: true,
            error: None,
        });
        self.draft_visible = true;
        self.follow_latest = true;
        self.media_expanded = false;
        vec![Effect::BrowseFiles {
            request_id,
            target: environment.target,
            directory,
        }]
    }

    pub(crate) fn select_file_choice(&mut self) -> Vec<Effect> {
        let matches = self.matching_file_entries();
        let Some(picker) = self.file_picker.as_ref() else {
            return Vec::new();
        };
        let loading = picker.loading;
        let choice = picker.choice;
        let request_id = picker.request_id;
        let target = picker.target.clone();
        if loading {
            return Vec::new();
        }
        let Some(entry) = matches
            .get(choice.min(matches.len().saturating_sub(1)))
            .cloned()
        else {
            return Vec::new();
        };
        if entry.is_directory {
            let request_id = self.next_file_request_id;
            self.next_file_request_id = self.next_file_request_id.saturating_add(1);
            if let Some(picker) = self.file_picker.as_mut() {
                picker.request_id = request_id;
                picker.directory.clone_from(&entry.path);
                picker.query.clear();
                picker.choice = 0;
                picker.entries.clear();
                picker.loading = true;
                picker.error = None;
            }
            return vec![Effect::BrowseFiles {
                request_id,
                target,
                directory: entry.path,
            }];
        }
        if let Some(picker) = self.file_picker.as_mut() {
            picker.loading = true;
            picker.error = None;
        }
        vec![Effect::ResolveFile {
            request_id,
            target,
            path: entry.path,
            filename: entry.name,
        }]
    }

    pub fn file_listing_loaded(
        &mut self,
        request_id: u64,
        directory: String,
        mut entries: Vec<FileEntry>,
    ) {
        let Some(picker) = self.file_picker.as_mut() else {
            return;
        };
        if picker.request_id != request_id {
            return;
        }
        entries.sort_by(|left, right| {
            right
                .is_directory
                .cmp(&left.is_directory)
                .then_with(|| {
                    left.name
                        .to_ascii_lowercase()
                        .cmp(&right.name.to_ascii_lowercase())
                })
                .then_with(|| left.name.cmp(&right.name))
        });
        picker.directory = directory;
        picker.entries = entries;
        picker.choice = 0;
        picker.loading = false;
        picker.error = None;
    }

    pub fn file_picker_failed(&mut self, request_id: u64, error: impl Into<String>) {
        let Some(picker) = self.file_picker.as_mut() else {
            return;
        };
        if picker.request_id != request_id {
            return;
        }
        picker.loading = false;
        picker.error = Some(sanitize_label(
            &error.into(),
            "could not read this directory",
            160,
        ));
    }

    pub fn file_reference_resolved(&mut self, request_id: u64, reference: FileReference) {
        let Some(picker) = self.file_picker.as_ref() else {
            return;
        };
        if picker.request_id != request_id {
            return;
        }
        let insertion = picker.insertion.min(self.draft.len());
        self.file_picker = None;
        self.insert_file_reference(insertion, reference);
    }

    pub(crate) fn matching_file_entries(&self) -> Vec<FileEntry> {
        let Some(picker) = self.file_picker.as_ref() else {
            return Vec::new();
        };
        let query = picker.query.trim();
        if query.is_empty() {
            return unix_parent(&picker.directory)
                .map(|path| FileEntry {
                    name: "..".to_string(),
                    path,
                    is_directory: true,
                })
                .into_iter()
                .chain(picker.entries.iter().cloned())
                .collect();
        }
        let mut matches = picker
            .entries
            .iter()
            .filter_map(|entry| {
                let name_score = fuzzy_score(query, &entry.name);
                let path_score = fuzzy_score(query, &entry.path).map(|score| score - 12);
                name_score
                    .into_iter()
                    .chain(path_score)
                    .max()
                    .map(|score| (entry.clone(), score + i64::from(entry.is_directory) * 4))
            })
            .collect::<Vec<_>>();
        matches.sort_by(|(left, left_score), (right, right_score)| {
            right_score
                .cmp(left_score)
                .then_with(|| right.is_directory.cmp(&left.is_directory))
                .then_with(|| {
                    left.name
                        .to_ascii_lowercase()
                        .cmp(&right.name.to_ascii_lowercase())
                })
                .then_with(|| left.name.cmp(&right.name))
        });
        matches.into_iter().map(|(entry, _)| entry).collect()
    }

    pub(crate) fn insert_file_reference(&mut self, insertion: usize, reference: FileReference) {
        let token = reference_token(&reference);
        let needs_leading_space = insertion > 0
            && self.draft[..insertion]
                .chars()
                .next_back()
                .is_some_and(|character| !character.is_whitespace());
        let needs_trailing_space = insertion < self.draft.len()
            && self.draft[insertion..]
                .chars()
                .next()
                .is_some_and(|character| !character.is_whitespace());
        let leading = if needs_leading_space { " " } else { "" };
        let trailing = if needs_trailing_space { " " } else { "" };
        let inserted = format!("{leading}{token}{trailing}");
        self.draft_cursor = insertion;
        self.insert_draft_text(&inserted);
        let start = insertion + leading.len();
        self.draft_references.push(DraftReference {
            start,
            end: start + token.len(),
            reference,
        });
        self.draft_references
            .sort_by_key(|reference| reference.start);
    }
}
