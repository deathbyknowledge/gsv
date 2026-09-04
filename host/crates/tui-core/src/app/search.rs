//! Command, transcript, and reference searches.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub(crate) fn begin_command_search(&mut self) {
        if self.command_search.is_some() {
            let count = self.matching_command_indices().len();
            if let Some(search) = self.command_search.as_mut() {
                if count > 0 {
                    search.choice = (search.choice + 1) % count;
                }
            }
            return;
        }
        self.close_environment_picker();
        self.file_picker = None;
        self.transcript_search = None;
        self.reference_picker = None;
        self.command_search = Some(CommandSearch {
            query: String::new(),
            choice: 0,
            original: DraftSnapshot {
                text: self.draft.clone(),
                cursor: self.draft_cursor,
                execution: self.execution_mode,
                references: self.draft_references.clone(),
            },
            original_draft_visible: self.draft_visible,
            original_follow_latest: self.follow_latest,
        });
        self.draft_visible = true;
        self.follow_latest = true;
        self.media_expanded = false;
    }

    pub(crate) fn dispatch_command_search(&mut self, action: Action) -> Vec<Effect> {
        match action {
            Action::Insert(value) => {
                let value = sanitize_draft_input(&value).replace('\n', "");
                if !value.is_empty() {
                    if let Some(search) = self.command_search.as_mut() {
                        search.query.push_str(&value);
                        search.choice = 0;
                    }
                }
            }
            Action::Backspace | Action::Delete => {
                if let Some(search) = self.command_search.as_mut() {
                    if let Some(previous) =
                        previous_grapheme_boundary(&search.query, search.query.len())
                    {
                        search.query.truncate(previous);
                        search.choice = 0;
                    }
                }
            }
            Action::BeginCommandSearch | Action::NextChoice | Action::NextCommand => {
                let count = self.matching_command_indices().len();
                if let Some(search) = self.command_search.as_mut() {
                    if count > 0 {
                        search.choice = (search.choice + 1) % count;
                    }
                }
            }
            Action::PreviousChoice | Action::PreviousCommand => {
                let count = self.matching_command_indices().len();
                if let Some(search) = self.command_search.as_mut() {
                    if count > 0 {
                        search.choice = search
                            .choice
                            .checked_sub(1)
                            .unwrap_or(count.saturating_sub(1));
                    }
                }
            }
            Action::Submit => self.accept_command_search(),
            Action::Escape => self.cancel_command_search(),
            Action::Quit => return vec![Effect::Quit],
            _ => {}
        }
        Vec::new()
    }

    pub(crate) fn matching_command_indices(&self) -> Vec<usize> {
        let Some(search) = self.command_search.as_ref() else {
            return Vec::new();
        };
        let query = search.query.trim();
        let mut matches = self
            .command_history
            .iter()
            .enumerate()
            .rev()
            .filter_map(|(index, entry)| {
                if query.is_empty() {
                    Some((index, 0_i64))
                } else {
                    fuzzy_score(query, &entry.text).map(|score| (index, score))
                }
            })
            .collect::<Vec<_>>();
        if !query.is_empty() {
            matches.sort_by(|(left_index, left_score), (right_index, right_score)| {
                right_score
                    .cmp(left_score)
                    .then_with(|| right_index.cmp(left_index))
            });
        }
        matches.into_iter().map(|(index, _)| index).collect()
    }

    pub(crate) fn command_search_preview(&self) -> Option<&CommandHistoryEntry> {
        let search = self.command_search.as_ref()?;
        let matches = self.matching_command_indices();
        self.command_history
            .get(*matches.get(search.choice.min(matches.len().saturating_sub(1)))?)
    }

    pub(crate) fn accept_command_search(&mut self) {
        let entry = self.command_search_preview().cloned();
        self.command_search = None;
        let Some(entry) = entry else {
            return;
        };
        self.draft = entry.text;
        self.draft_references = entry.references;
        self.draft_cursor = self.draft.len();
        self.execution_mode = entry.execution;
        self.draft_visible = true;
        self.follow_latest = true;
        self.media_expanded = false;
        self.reset_history_navigation();
    }

    pub(crate) fn cancel_command_search(&mut self) {
        let Some(search) = self.command_search.take() else {
            return;
        };
        self.draft = search.original.text;
        self.draft_references = search.original.references;
        self.draft_cursor = search.original.cursor.min(self.draft.len());
        self.execution_mode = search.original.execution;
        self.draft_visible = search.original_draft_visible;
        self.follow_latest = search.original_follow_latest;
    }

    pub(crate) fn begin_transcript_search(&mut self) {
        if self.moments.is_empty() {
            return;
        }
        self.close_environment_picker();
        self.file_picker = None;
        self.command_search = None;
        self.reference_picker = None;
        self.transcript_search = Some(TranscriptSearch {
            query: String::new(),
            choice: 0,
            original_selected: self.selected,
            original_media_focus: self.media_focus,
            original_follow_latest: self.follow_latest,
        });
        self.draft_visible = true;
        self.follow_latest = false;
        self.media_expanded = false;
        self.sync_transcript_search_selection();
    }

    pub(crate) fn dispatch_transcript_search(&mut self, action: Action) -> Vec<Effect> {
        match action {
            Action::Insert(value) => {
                let value = sanitize_draft_input(&value).replace('\n', "");
                if !value.is_empty() {
                    if let Some(search) = self.transcript_search.as_mut() {
                        search.query.push_str(&value);
                        search.choice = 0;
                    }
                    self.sync_transcript_search_selection();
                }
            }
            Action::Backspace | Action::Delete => {
                if let Some(search) = self.transcript_search.as_mut() {
                    if let Some(previous) =
                        previous_grapheme_boundary(&search.query, search.query.len())
                    {
                        search.query.truncate(previous);
                        search.choice = 0;
                    }
                }
                self.sync_transcript_search_selection();
            }
            Action::NextChoice | Action::NextTranscriptMatch | Action::NextTurn => {
                self.move_transcript_search_choice(true);
            }
            Action::PreviousChoice | Action::PreviousTranscriptMatch | Action::PreviousTurn => {
                self.move_transcript_search_choice(false);
            }
            Action::Submit => self.accept_transcript_search(),
            Action::Escape => self.cancel_transcript_search(),
            Action::Quit => return vec![Effect::Quit],
            _ => {}
        }
        Vec::new()
    }

    pub(crate) fn matching_transcript_indices(&self, query: &str) -> Vec<usize> {
        let query = query.trim().to_lowercase();
        self.moments
            .iter()
            .enumerate()
            .rev()
            .filter_map(|(index, moment)| {
                if query.is_empty()
                    || moment.text.to_lowercase().contains(&query)
                    || moment.artifacts.iter().any(|artifact| {
                        artifact.display_name().to_lowercase().contains(&query)
                            || artifact
                                .source
                                .as_deref()
                                .is_some_and(|source| source.to_lowercase().contains(&query))
                    })
                {
                    Some(index)
                } else {
                    None
                }
            })
            .collect()
    }

    pub(crate) fn sync_transcript_search_selection(&mut self) {
        let Some(search) = self.transcript_search.as_ref() else {
            return;
        };
        let matches = self.matching_transcript_indices(&search.query);
        let choice = search.choice.min(matches.len().saturating_sub(1));
        if let Some(index) = matches.get(choice).copied() {
            self.selected = index;
            self.media_focus = None;
            self.scroll_anchor = Some(ScrollAnchor::Moment(index));
        }
    }

    pub(crate) fn move_transcript_search_choice(&mut self, forward: bool) {
        let Some(search) = self.transcript_search.as_ref() else {
            return;
        };
        let count = self.matching_transcript_indices(&search.query).len();
        if count == 0 {
            return;
        }
        if let Some(search) = self.transcript_search.as_mut() {
            search.choice = if forward {
                (search.choice + 1) % count
            } else {
                search.choice.checked_sub(1).unwrap_or(count - 1)
            };
        }
        self.sync_transcript_search_selection();
    }

    pub(crate) fn accept_transcript_search(&mut self) {
        let Some(search) = self.transcript_search.take() else {
            return;
        };
        if search.query.trim().is_empty() {
            self.selected = search.original_selected;
            self.media_focus = search.original_media_focus;
            self.follow_latest = search.original_follow_latest;
        } else {
            self.last_transcript_query = search.query;
            self.follow_latest = false;
        }
        self.draft_visible = false;
        self.scroll_anchor = Some(ScrollAnchor::Moment(self.selected));
    }

    pub(crate) fn cancel_transcript_search(&mut self) {
        let Some(search) = self.transcript_search.take() else {
            return;
        };
        self.selected = search.original_selected;
        self.media_focus = search.original_media_focus;
        self.follow_latest = search.original_follow_latest;
        self.draft_visible = false;
        self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
    }

    pub(crate) fn repeat_transcript_search(&mut self, forward: bool) {
        if self.draft_visible || self.last_transcript_query.is_empty() {
            return;
        }
        let matches = self.matching_transcript_indices(&self.last_transcript_query);
        if matches.is_empty() {
            return;
        }
        let current = matches
            .iter()
            .position(|index| *index == self.selected)
            .unwrap_or(0);
        let choice = if forward {
            (current + 1) % matches.len()
        } else {
            current.checked_sub(1).unwrap_or(matches.len() - 1)
        };
        self.selected = matches[choice];
        self.media_focus = None;
        self.follow_latest = false;
        self.scroll_anchor = Some(ScrollAnchor::Moment(self.selected));
        self.media_expanded = false;
    }

    pub(crate) fn open_reference_picker(&mut self) -> Vec<Effect> {
        let references = self.selected_open_references();
        if references.is_empty() {
            return Vec::new();
        }
        self.close_environment_picker();
        self.reference_picker = None;
        self.file_picker = None;
        self.command_search = None;
        self.transcript_search = None;
        self.reference_picker = Some(ReferencePicker {
            query: String::new(),
            choice: 0,
            references,
        });
        self.draft_visible = true;
        self.follow_latest = false;
        self.media_expanded = false;
        self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
        Vec::new()
    }

    pub(crate) fn dispatch_reference_picker(&mut self, action: Action) -> Vec<Effect> {
        match action {
            Action::Insert(value) => {
                let value = sanitize_draft_input(&value).replace('\n', "");
                if !value.is_empty() {
                    if let Some(picker) = self.reference_picker.as_mut() {
                        picker.query.push_str(&value);
                        picker.choice = 0;
                    }
                }
            }
            Action::Backspace | Action::Delete => {
                if let Some(picker) = self.reference_picker.as_mut() {
                    if let Some(previous) =
                        previous_grapheme_boundary(&picker.query, picker.query.len())
                    {
                        picker.query.truncate(previous);
                        picker.choice = 0;
                    }
                }
            }
            Action::NextChoice | Action::NextTurn | Action::ScrollDown => {
                self.move_reference_choice(true);
            }
            Action::PreviousChoice | Action::PreviousTurn | Action::ScrollUp => {
                self.move_reference_choice(false);
            }
            Action::Submit => return self.accept_reference_choice(),
            Action::Escape => self.close_reference_picker(),
            Action::Quit => return vec![Effect::Quit],
            _ => {}
        }
        Vec::new()
    }

    pub(crate) fn matching_reference_indices(&self) -> Vec<usize> {
        let Some(picker) = self.reference_picker.as_ref() else {
            return Vec::new();
        };
        let query = picker.query.trim();
        let mut matches = picker
            .references
            .iter()
            .enumerate()
            .filter_map(|(index, reference)| {
                if query.is_empty() {
                    return Some((index, 0_i64));
                }
                fuzzy_score(query, reference.label())
                    .into_iter()
                    .chain(fuzzy_score(query, reference.value()))
                    .max()
                    .map(|score| (index, score))
            })
            .collect::<Vec<_>>();
        if !query.is_empty() {
            matches.sort_by(|(left_index, left_score), (right_index, right_score)| {
                right_score
                    .cmp(left_score)
                    .then_with(|| left_index.cmp(right_index))
            });
        }
        matches.into_iter().map(|(index, _)| index).collect()
    }

    pub(crate) fn move_reference_choice(&mut self, forward: bool) {
        let count = self.matching_reference_indices().len();
        if count == 0 {
            return;
        }
        if let Some(picker) = self.reference_picker.as_mut() {
            picker.choice = if forward {
                (picker.choice + 1) % count
            } else {
                picker.choice.checked_sub(1).unwrap_or(count - 1)
            };
        }
    }

    pub(crate) fn accept_reference_choice(&mut self) -> Vec<Effect> {
        let Some(picker) = self.reference_picker.as_ref() else {
            return Vec::new();
        };
        let matches = self.matching_reference_indices();
        let reference = matches
            .get(picker.choice.min(matches.len().saturating_sub(1)))
            .and_then(|index| picker.references.get(*index))
            .cloned();
        self.close_reference_picker();
        match reference {
            Some(OpenReference::Url { url, .. }) => vec![Effect::OpenUrl { url }],
            Some(OpenReference::Path {
                target,
                path,
                filename,
            }) => vec![Effect::OpenPath {
                target,
                path,
                filename,
            }],
            None => Vec::new(),
        }
    }

    pub(crate) fn close_reference_picker(&mut self) {
        self.reference_picker = None;
        self.draft_visible = false;
        self.follow_latest = false;
        self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
    }

    pub(crate) fn selected_open_references(&self) -> Vec<OpenReference> {
        if self.moments.is_empty() {
            return Vec::new();
        }
        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        let environment = self.moments[start..=end]
            .iter()
            .find_map(|moment| moment.environment.as_ref())
            .unwrap_or_else(|| self.active_environment());
        let mut references = Vec::new();
        let mut seen = HashSet::new();
        for extracted in self.moments[start..=end]
            .iter()
            .flat_map(|moment| extract_references(&moment.text))
        {
            let reference = match extracted {
                ExtractedReference::Url { label, url } => OpenReference::Url { label, url },
                ExtractedReference::Path(path) => {
                    let (target, path) = target_resource_path(&path).unwrap_or_else(|| {
                        (
                            environment.target.clone(),
                            resolve_environment_path(&path, environment.cwd.as_deref()),
                        )
                    });
                    let filename = path
                        .trim_end_matches('/')
                        .rsplit('/')
                        .find(|part| !part.is_empty())
                        .unwrap_or("file")
                        .to_string();
                    OpenReference::Path {
                        target,
                        path,
                        filename,
                    }
                }
            };
            let key = match &reference {
                OpenReference::Url { url, .. } => format!("url:{url}"),
                OpenReference::Path { target, path, .. } => format!("path:{target}:{path}"),
            };
            if seen.insert(key) {
                references.push(reference);
            }
        }
        references
    }
}
