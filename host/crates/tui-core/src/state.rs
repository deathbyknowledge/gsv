//! Crate-private interaction state the App composes: drafts, pickers, searches, and browse ranges.

#[allow(unused_imports)]
use crate::prelude::*;

#[derive(Clone, Debug)]
pub(crate) struct PendingSubmission {
    pub(crate) id: u64,
    pub(crate) text: String,
    pub(crate) execution: ExecutionMode,
    pub(crate) references: Vec<DraftReference>,
}

#[derive(Clone, Debug)]
pub(crate) struct CommandHistoryEntry {
    pub(crate) text: String,
    pub(crate) execution: ExecutionMode,
    pub(crate) references: Vec<DraftReference>,
}

#[derive(Clone, Debug)]
pub(crate) struct DraftSnapshot {
    pub(crate) text: String,
    pub(crate) cursor: usize,
    pub(crate) execution: ExecutionMode,
    pub(crate) references: Vec<DraftReference>,
}

#[derive(Clone, Debug)]
pub(crate) struct DraftReference {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) reference: FileReference,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentActionState {
    Running,
    Completed,
    Failed,
    Cancelled,
    Denied,
}

#[derive(Clone, Debug)]
pub(crate) struct AgentAction {
    pub(crate) execution_id: String,
    pub(crate) label: String,
    pub(crate) target: Option<String>,
    pub(crate) state: AgentActionState,
    pub(crate) started_at: Option<u64>,
    pub(crate) after_moment_id: Option<String>,
}

#[derive(Debug)]
pub(crate) struct RunActions {
    pub(crate) run_id: String,
    pub(crate) actions: Vec<AgentAction>,
    pub(crate) omitted: usize,
    pub(crate) expanded: bool,
    pub(crate) live: bool,
}

#[derive(Debug)]
pub(crate) struct FilePicker {
    pub(crate) request_id: u64,
    pub(crate) target: String,
    pub(crate) insertion: usize,
    pub(crate) directory: String,
    pub(crate) query: String,
    pub(crate) choice: usize,
    pub(crate) entries: Vec<FileEntry>,
    pub(crate) loading: bool,
    pub(crate) error: Option<String>,
}

#[derive(Debug)]
pub(crate) struct CommandSearch {
    pub(crate) query: String,
    pub(crate) choice: usize,
    pub(crate) original: DraftSnapshot,
    pub(crate) original_draft_visible: bool,
    pub(crate) original_follow_latest: bool,
}

#[derive(Debug)]
pub(crate) struct TranscriptSearch {
    pub(crate) query: String,
    pub(crate) choice: usize,
    pub(crate) original_selected: usize,
    pub(crate) original_media_focus: Option<usize>,
    pub(crate) original_follow_latest: bool,
}

#[derive(Debug)]
pub(crate) struct ReferencePicker {
    pub(crate) query: String,
    pub(crate) choice: usize,
    pub(crate) references: Vec<OpenReference>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ScrollAnchor {
    Moment(usize),
    Media,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ScrollDirection {
    Older,
    Newer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BrowseTarget {
    Moment(usize),
    Media {
        moment_index: usize,
        media_focus: usize,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct BrowseRange {
    pub(crate) top: u16,
    pub(crate) bottom: u16,
    pub(crate) target: BrowseTarget,
}

impl BrowseRange {
    pub(crate) fn is_media(self) -> bool {
        matches!(self.target, BrowseTarget::Media { .. })
    }
}

pub(crate) enum TranscriptBlock {
    Text {
        top: u16,
        height: u16,
        lines: Vec<Line<'static>>,
    },
    Image {
        top: u16,
        height: u16,
        artifact: Artifact,
        focused: bool,
    },
}

pub(crate) struct ActionSegmentRequest<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) width: u16,
    pub(crate) activity_phase: bool,
    pub(crate) cutoff: Option<u64>,
    pub(crate) after_moment_id: Option<&'a str>,
    pub(crate) flush: bool,
}

impl TranscriptBlock {
    pub(crate) fn top(&self) -> u16 {
        match self {
            Self::Text { top, .. } | Self::Image { top, .. } => *top,
        }
    }

    pub(crate) fn height(&self) -> u16 {
        match self {
            Self::Text { height, .. } | Self::Image { height, .. } => *height,
        }
    }
}
