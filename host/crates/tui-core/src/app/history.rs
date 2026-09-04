//! Transcript history paging and reconciliation with committed messages.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub fn replace_history(&mut self, moments: Vec<Moment>) {
        if moments.is_empty() {
            return;
        }
        self.moments = moments;
        self.rebuild_command_history();
        self.selected = self.moments.len().saturating_sub(1);
        self.document_scroll = 0;
        self.follow_latest = true;
        self.scroll_anchor = None;
        self.media_expanded = false;
        self.media_focus = None;
    }

    pub fn set_history_has_more(&mut self, has_more: bool) {
        self.history_has_more = has_more;
        self.history_loading = false;
    }

    pub fn reconcile_history(&mut self, moments: Vec<Moment>, has_more: bool) {
        for moment in moments {
            if self.moments.iter().any(|existing| existing.id == moment.id) {
                continue;
            }
            self.commit_moment(moment);
        }
        self.history_has_more = has_more;
        self.history_loading = false;
        self.rebuild_command_history();
    }

    pub fn prepend_history(&mut self, moments: Vec<Moment>, has_more: bool) {
        let anchor_id = self.moments.first().map(|moment| moment.id.clone());
        let mut older = moments
            .into_iter()
            .filter(|moment| !self.moments.iter().any(|existing| existing.id == moment.id))
            .collect::<Vec<_>>();
        if !older.is_empty() {
            older.append(&mut self.moments);
            self.moments = older;
            if let Some(anchor_id) = anchor_id {
                if let Some(index) = self
                    .moments
                    .iter()
                    .position(|moment| moment.id == anchor_id)
                {
                    self.selected = self.selected.saturating_add(index);
                    self.scroll_anchor = Some(ScrollAnchor::Moment(index));
                }
            }
            self.follow_latest = false;
            self.rebuild_command_history();
        }
        self.history_has_more = has_more;
        self.history_loading = false;
    }

    pub fn history_page_failed(&mut self) {
        self.history_loading = false;
    }

    pub(crate) fn load_older_history_if_needed(&mut self) -> Vec<Effect> {
        if self.document_scroll != 0 || !self.history_has_more || self.history_loading {
            return Vec::new();
        }
        let Some(before_sequence) = self
            .moments
            .iter()
            .filter_map(|moment| moment.sequence)
            .min()
        else {
            return Vec::new();
        };
        self.history_loading = true;
        vec![Effect::LoadOlderHistory { before_sequence }]
    }
}
