//! Public presentation types: moments, media, environments, actions, and effects.

#[allow(unused_imports)]
use crate::prelude::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Human,
    Intelligence,
    System,
}

impl Role {
    pub(crate) fn color(self, palette: Palette) -> Color {
        match self {
            Self::Human => palette.foreground,
            Self::Intelligence => palette.foreground,
            Self::System => palette.warning,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    Document,
}

impl MediaKind {
    pub(crate) fn symbol(self) -> &'static str {
        match self {
            Self::Image => "▧",
            Self::Audio => "▶",
            Self::Video => "▶",
            Self::Document => "↗",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Artifact {
    pub kind: MediaKind,
    pub mime_type: String,
    pub filename: Option<String>,
    pub size: Option<u64>,
    pub duration_ms: Option<u64>,
    pub transcription: Option<String>,
    /// A user-visible reference such as `target:/path` or a legacy media key.
    pub source: Option<String>,
    /// The immutable revision paired with a canonical resource source.
    pub revision: Option<String>,
}

impl Artifact {
    pub fn display_name(&self) -> &str {
        self.filename.as_deref().unwrap_or("untitled")
    }

    pub(crate) fn cache_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            self.source.as_deref().unwrap_or_default(),
            self.revision.as_deref().unwrap_or_default(),
            self.mime_type
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityEnvironment {
    /// Exact routing identity. Display sanitization must never change this value.
    pub target: String,
    pub label: String,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileReference {
    pub target: String,
    pub path: String,
    pub revision: String,
    pub content_type: String,
    pub size: u64,
    pub filename: String,
}

impl FileReference {
    pub fn artifact(&self) -> Artifact {
        Artifact {
            kind: media_kind_from_content_type(&self.content_type),
            mime_type: self.content_type.clone(),
            filename: Some(self.filename.clone()),
            size: Some(self.size),
            duration_ms: None,
            transcription: None,
            source: Some(format!("{}:{}", self.target, self.path)),
            revision: Some(self.revision.clone()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OpenReference {
    Url {
        label: String,
        url: String,
    },
    Path {
        target: String,
        path: String,
        filename: String,
    },
}

impl OpenReference {
    pub(crate) fn label(&self) -> &str {
        match self {
            Self::Url { label, .. } => label,
            Self::Path { filename, .. } => filename,
        }
    }

    pub(crate) fn value(&self) -> &str {
        match self {
            Self::Url { url, .. } => url,
            Self::Path { path, .. } => path,
        }
    }
}

impl CapabilityEnvironment {
    pub fn new(target: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            label: label.into(),
            cwd: None,
        }
    }

    pub fn gsv() -> Self {
        Self::new("gsv", "gsv")
    }

    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MediaSlot {
    pub key: String,
    pub area: Rect,
    pub artifact: Artifact,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MomentState {
    Complete,
    Streaming,
    Error,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MomentTimeline {
    pub sequence: Option<u64>,
    pub timestamp: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Moment {
    pub id: String,
    pub role: Role,
    pub execution: ExecutionMode,
    pub text: String,
    pub run_id: Option<String>,
    /// Durable conversation ordering when this moment came from canonical history.
    pub sequence: Option<u64>,
    /// The best persisted timeline position for merging messages with run activity.
    pub timestamp: Option<u64>,
    pub state: MomentState,
    pub artifacts: Vec<Artifact>,
    pub environment: Option<CapabilityEnvironment>,
}

impl Moment {
    pub fn complete(id: impl Into<String>, role: Role, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            role,
            execution: ExecutionMode::Ship,
            text: text.into(),
            run_id: None,
            sequence: None,
            timestamp: None,
            state: MomentState::Complete,
            artifacts: Vec::new(),
            environment: None,
        }
    }

    pub fn with_artifacts(mut self, artifacts: Vec<Artifact>) -> Self {
        self.artifacts = artifacts;
        self
    }

    pub fn with_environment(mut self, environment: CapabilityEnvironment) -> Self {
        self.environment = Some(environment);
        self
    }

    pub fn with_execution(mut self, execution: ExecutionMode) -> Self {
        self.execution = execution;
        self
    }

    pub fn with_timeline(mut self, sequence: Option<u64>, timestamp: Option<u64>) -> Self {
        self.sequence = sequence;
        self.timestamp = timestamp;
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionState {
    Demo,
    Connecting,
    Ready,
    Working,
    Offline,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approval {
    pub request_id: String,
    pub syscall: String,
    pub target: String,
    pub preview: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ExecutionMode {
    #[default]
    Ship,
    Shell,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    Insert(String),
    Backspace,
    Delete,
    DeleteWord,
    MoveCursorLeft,
    MoveCursorRight,
    MoveCursorHome,
    MoveCursorEnd,
    Newline,
    OpenFiles,
    OpenReferences,
    Submit,
    BeginCompose,
    Escape,
    PreviousCommand,
    NextCommand,
    BeginCommandSearch,
    BeginTranscriptSearch,
    NextTranscriptMatch,
    PreviousTranscriptMatch,
    PreviousTurn,
    NextTurn,
    FirstTurn,
    LastTurn,
    ScrollUp,
    ScrollDown,
    ScrollPageUp,
    ScrollPageDown,
    PreviousChoice,
    NextChoice,
    PreviousMedia,
    NextMedia,
    ToggleHelp,
    ToggleMarkdown,
    ToggleVim,
    ToggleShell,
    ToggleActions,
    ToggleMedia,
    Abort,
    DecideApproval {
        decision: ApprovalDecision,
        remember: bool,
    },
    Quit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Effect {
    Submit {
        id: u64,
        text: String,
        target: String,
        cwd: Option<String>,
        references: Vec<FileReference>,
    },
    Shell {
        id: u64,
        input: String,
        target: String,
        cwd: Option<String>,
    },
    OpenArtifact {
        artifact: Artifact,
    },
    OpenUrl {
        url: String,
    },
    OpenPath {
        target: String,
        path: String,
        filename: String,
    },
    BrowseFiles {
        request_id: u64,
        target: String,
        directory: String,
    },
    ResolveFile {
        request_id: u64,
        target: String,
        path: String,
        filename: String,
    },
    LoadOlderHistory {
        before_sequence: u64,
    },
    Abort,
    DecideApproval {
        request_id: String,
        decision: ApprovalDecision,
        remember: bool,
    },
    Quit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentActionSnapshot {
    pub run_id: String,
    pub execution_id: String,
    pub name: String,
    pub syscall: String,
    pub target: Option<String>,
    pub status: String,
    pub live: bool,
    pub started_at: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageDeliverySnapshot {
    pub run_id: String,
    pub message_id: String,
    pub started_at: u64,
}
