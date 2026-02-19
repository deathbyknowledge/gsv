use crate::tui::state::MessageLine;

// ── Buffer IDs ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BufferId {
    Chat,
    System,
}

impl BufferId {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::System => "system",
        }
    }

    pub fn index(&self) -> usize {
        match self {
            Self::Chat => 0,
            Self::System => 1,
        }
    }

    pub fn from_index(index: usize) -> Option<Self> {
        match index {
            0 => Some(Self::Chat),
            1 => Some(Self::System),
            _ => None,
        }
    }

    pub const ALL: &[BufferId] = &[BufferId::Chat, BufferId::System];
}

// ── Buffer ──────────────────────────────────────────────────────────────────

pub struct Buffer {
    pub id: BufferId,
    pub messages: Vec<MessageLine>,
    pub scroll: usize,
    pub auto_follow: bool,
    /// Unread count since the buffer was last active.
    pub unread: usize,
}

impl Buffer {
    pub fn new(id: BufferId) -> Self {
        Self {
            id,
            messages: Vec::new(),
            scroll: 0,
            auto_follow: true,
            unread: 0,
        }
    }

    pub fn push(&mut self, msg: MessageLine, is_active: bool) {
        self.messages.push(msg);
        self.auto_follow = true;
        if !is_active {
            self.unread += 1;
        }
    }

    pub fn clear(&mut self) {
        self.messages.clear();
        self.scroll = 0;
        self.auto_follow = true;
        self.unread = 0;
    }

    pub fn mark_read(&mut self) {
        self.unread = 0;
    }
}
