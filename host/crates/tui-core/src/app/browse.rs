//! Browse mode: turn navigation, scrolling, and media focus.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub(crate) fn activate_media(&mut self) -> Vec<Effect> {
        self.clamp_media_focus();
        let Some(artifact) = self.selected_artifact().cloned() else {
            return Vec::new();
        };
        if self.inline_images && artifact.kind == MediaKind::Image {
            self.media_expanded = !self.media_expanded;
            Vec::new()
        } else {
            vec![Effect::OpenArtifact { artifact }]
        }
    }

    pub(crate) fn previous_turn(&mut self) {
        if self.draft_visible || self.moments.is_empty() {
            return;
        }
        let start = self.turn_start(self.selected);
        if start > 0 {
            self.selected = start - 1;
            self.scroll_anchor = Some(ScrollAnchor::Moment(self.turn_start(self.selected)));
            self.follow_latest = false;
            self.media_expanded = false;
            self.media_focus = None;
        }
    }

    pub(crate) fn next_turn(&mut self) {
        if self.draft_visible || self.moments.is_empty() {
            return;
        }
        let end = self.turn_end(self.turn_start(self.selected));
        if end + 1 < self.moments.len() {
            self.selected = self.turn_end(end + 1);
            self.scroll_anchor = Some(ScrollAnchor::Moment(end + 1));
            self.follow_latest = self.selected + 1 >= self.moments.len();
            self.media_expanded = false;
            self.media_focus = None;
        }
    }

    pub(crate) fn scroll_older(&mut self, rows: u16, atomic_media: bool) {
        let current = if self.follow_latest {
            self.last_max_scroll
        } else {
            self.document_scroll
        };
        self.document_scroll = current;
        if atomic_media && self.step_browse(ScrollDirection::Older, rows) {
            self.follow_latest = false;
            self.scroll_anchor = None;
            self.pending_scroll_direction = None;
            self.media_expanded = false;
            self.draft_visible = false;
            return;
        }
        let desired = current.saturating_sub(rows);
        self.document_scroll = snap_partial_media_scroll(
            desired,
            ScrollDirection::Older,
            self.last_viewport_height,
            self.last_max_scroll,
            &self.last_browse_ranges,
        );
        self.follow_latest = false;
        self.scroll_anchor = None;
        self.pending_scroll_direction = Some(ScrollDirection::Older);
        self.media_expanded = false;
        self.draft_visible = false;
        self.sync_browse_focus(ScrollDirection::Older);
    }

    pub(crate) fn scroll_newer(&mut self, rows: u16, atomic_media: bool) {
        let current = self.document_scroll.min(self.last_max_scroll);
        self.document_scroll = current;
        if atomic_media && self.step_browse(ScrollDirection::Newer, rows) {
            self.follow_latest = self.document_scroll >= self.last_max_scroll
                && self.current_browse_range_index()
                    == self.last_browse_ranges.len().checked_sub(1);
            self.scroll_anchor = None;
            self.pending_scroll_direction = None;
            self.media_expanded = false;
            self.draft_visible = false;
            return;
        }
        let desired = current.saturating_add(rows).min(self.last_max_scroll);
        self.document_scroll = snap_partial_media_scroll(
            desired,
            ScrollDirection::Newer,
            self.last_viewport_height,
            self.last_max_scroll,
            &self.last_browse_ranges,
        );
        self.follow_latest = self.document_scroll >= self.last_max_scroll;
        self.scroll_anchor = None;
        self.pending_scroll_direction = Some(ScrollDirection::Newer);
        self.media_expanded = false;
        self.draft_visible = false;
        self.sync_browse_focus(ScrollDirection::Newer);
    }

    pub(crate) fn step_browse(&mut self, direction: ScrollDirection, rows: u16) -> bool {
        if self.last_browse_ranges.is_empty() {
            return false;
        }
        let mut current_index = self.current_browse_range_index();
        if current_index.is_none() {
            self.sync_browse_focus(direction);
            current_index = self.current_browse_range_index();
        }
        let Some(current_index) = current_index else {
            return false;
        };
        let current = self.last_browse_ranges[current_index];
        let viewport_height = self.last_viewport_height.max(1);
        let viewport_top = self.document_scroll.min(self.last_max_scroll);
        let viewport_bottom = viewport_top.saturating_add(viewport_height);
        match direction {
            ScrollDirection::Older if current.top < viewport_top => {
                self.document_scroll = viewport_top.saturating_sub(rows).max(current.top);
                return true;
            }
            ScrollDirection::Newer if current.bottom > viewport_bottom => {
                let furthest = current
                    .bottom
                    .saturating_sub(viewport_height)
                    .min(self.last_max_scroll);
                self.document_scroll = viewport_top.saturating_add(rows).min(furthest);
                return true;
            }
            _ => {}
        }
        let next_index = match direction {
            ScrollDirection::Older => current_index.checked_sub(1),
            ScrollDirection::Newer => {
                (current_index + 1 < self.last_browse_ranges.len()).then_some(current_index + 1)
            }
        };
        let Some(next_index) = next_index else {
            return false;
        };
        let next = self.last_browse_ranges[next_index];
        self.focus_browse_target(next.target);
        let fully_visible = next.top >= viewport_top && next.bottom <= viewport_bottom;
        let desired = match (direction, fully_visible) {
            (ScrollDirection::Older, true) => viewport_top
                .saturating_sub(rows)
                .max(next.bottom.saturating_sub(viewport_height)),
            (ScrollDirection::Older, false) => next.bottom.saturating_sub(viewport_height),
            (ScrollDirection::Newer, true) => viewport_top.saturating_add(rows).min(next.top),
            (ScrollDirection::Newer, false) => next.top,
        }
        .min(self.last_max_scroll);
        self.document_scroll = snap_partial_media_scroll(
            desired,
            direction,
            viewport_height,
            self.last_max_scroll,
            &self.last_browse_ranges,
        );
        true
    }

    pub(crate) fn current_browse_range_index(&self) -> Option<usize> {
        let selected_turn = self.turn_start(self.selected);
        self.last_browse_ranges
            .iter()
            .position(|range| match range.target {
                BrowseTarget::Moment(moment_index) => {
                    self.media_focus.is_none() && moment_index == self.selected
                }
                BrowseTarget::Media {
                    moment_index,
                    media_focus,
                } => {
                    self.media_focus == Some(media_focus)
                        && self.turn_start(moment_index) == selected_turn
                }
            })
    }

    pub(crate) fn sync_browse_focus(&mut self, direction: ScrollDirection) {
        let document_height = self
            .last_browse_ranges
            .iter()
            .map(|range| range.bottom)
            .max()
            .unwrap_or_default();
        if document_height == 0 {
            return;
        }
        let focus_row = match direction {
            ScrollDirection::Older => self.document_scroll,
            ScrollDirection::Newer => self
                .document_scroll
                .saturating_add(self.last_viewport_height.saturating_sub(1))
                .min(document_height.saturating_sub(1)),
        };
        let containing = self
            .last_browse_ranges
            .iter()
            .find(|range| range.top <= focus_row && focus_row < range.bottom);
        let nearest = match direction {
            ScrollDirection::Older => self
                .last_browse_ranges
                .iter()
                .rev()
                .find(|range| range.bottom <= focus_row)
                .or_else(|| self.last_browse_ranges.first()),
            ScrollDirection::Newer => self
                .last_browse_ranges
                .iter()
                .find(|range| range.top > focus_row)
                .or_else(|| self.last_browse_ranges.last()),
        };
        if let Some(range) = containing.or(nearest) {
            self.focus_browse_target(range.target);
        }
    }

    pub(crate) fn focus_browse_target(&mut self, target: BrowseTarget) {
        match target {
            BrowseTarget::Moment(moment_index) => {
                self.selected = moment_index.min(self.moments.len().saturating_sub(1));
                self.media_focus = None;
            }
            BrowseTarget::Media {
                moment_index,
                media_focus,
            } => {
                self.selected = moment_index.min(self.moments.len().saturating_sub(1));
                self.media_focus = Some(media_focus);
            }
        }
    }

    pub(crate) fn turn_artifact_count(&self) -> usize {
        if self.moments.is_empty() {
            return 0;
        }
        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        self.moments[start..=end]
            .iter()
            .flat_map(|moment| &moment.artifacts)
            .count()
    }

    pub(crate) fn selected_artifact(&self) -> Option<&Artifact> {
        if self.moments.is_empty() {
            return None;
        }
        let media_focus = self.media_focus?;
        let start = self.turn_start(self.selected);
        let end = self.turn_end(start);
        self.moments[start..=end]
            .iter()
            .flat_map(|moment| &moment.artifacts)
            .nth(media_focus)
    }

    pub(crate) fn clamp_media_focus(&mut self) {
        let count = self.turn_artifact_count();
        self.media_focus = self
            .media_focus
            .map(|focus| focus.min(count.saturating_sub(1)))
            .filter(|_| count > 0);
    }

    pub(crate) fn move_media_focus(&mut self, forward: bool) {
        let count = self.turn_artifact_count();
        if count == 0 {
            self.media_focus = None;
            self.media_expanded = false;
            return;
        }
        self.media_focus = Some(match (self.media_focus, forward) {
            (Some(focus), true) => (focus + 1) % count,
            (Some(focus), false) => focus.checked_sub(1).unwrap_or(count - 1),
            (None, true) => 0,
            (None, false) => count - 1,
        });
        if self
            .selected_artifact()
            .is_none_or(|artifact| artifact.kind != MediaKind::Image)
        {
            self.media_expanded = false;
        }
        self.scroll_anchor = Some(ScrollAnchor::Media);
        self.follow_latest = false;
    }
}
