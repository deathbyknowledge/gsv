use ratatui::layout::{Alignment, Constraint, Direction, Layout, Margin, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph, Wrap};
use ratatui::Frame;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const BACKGROUND: Color = Color::Rgb(8, 9, 11);
const FOREGROUND: Color = Color::Rgb(232, 230, 222);
const MUTED: Color = Color::Rgb(105, 108, 116);
const QUIET: Color = Color::Rgb(61, 64, 70);
const ACCENT: Color = Color::Rgb(151, 170, 255);
const HUMAN: Color = Color::Rgb(190, 201, 255);
const WARNING: Color = Color::Rgb(244, 190, 108);
const ERROR: Color = Color::Rgb(241, 126, 126);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Human,
    Intelligence,
    System,
}

impl Role {
    fn label(self) -> &'static str {
        match self {
            Self::Human => "YOU",
            Self::Intelligence => "GSV",
            Self::System => "SYSTEM",
        }
    }

    fn color(self) -> Color {
        match self {
            Self::Human => HUMAN,
            Self::Intelligence => FOREGROUND,
            Self::System => WARNING,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MomentState {
    Complete,
    Streaming,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Moment {
    pub id: String,
    pub role: Role,
    pub text: String,
    pub run_id: Option<String>,
    pub state: MomentState,
}

impl Moment {
    pub fn complete(id: impl Into<String>, role: Role, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            role,
            text: text.into(),
            run_id: None,
            state: MomentState::Complete,
        }
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

impl ConnectionState {
    fn label(self) -> &'static str {
        match self {
            Self::Demo => "DEMO",
            Self::Connecting => "CONNECTING",
            Self::Ready => "READY",
            Self::Working => "WORKING",
            Self::Offline => "OFFLINE",
        }
    }

    fn color(self) -> Color {
        match self {
            Self::Demo => WARNING,
            Self::Connecting | Self::Working => ACCENT,
            Self::Ready => Color::Rgb(130, 207, 160),
            Self::Offline => ERROR,
        }
    }
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
    Submit,
    Escape,
    PreviousMoment,
    NextMoment,
    ScrollUp,
    ScrollDown,
    ToggleHelp,
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
    },
    Abort,
    DecideApproval {
        request_id: String,
        decision: ApprovalDecision,
        remember: bool,
    },
    Quit,
}

#[derive(Clone, Debug)]
struct PendingSubmission {
    id: u64,
    text: String,
}

#[derive(Debug)]
pub struct App {
    moments: Vec<Moment>,
    selected: usize,
    moment_scroll: u16,
    last_max_scroll: u16,
    draft: String,
    draft_cursor: usize,
    draft_visible: bool,
    help_visible: bool,
    connection: ConnectionState,
    activity: Option<String>,
    pending_submission: Option<PendingSubmission>,
    next_submission_id: u64,
    approval: Option<Approval>,
}

impl App {
    pub fn new(connection: ConnectionState) -> Self {
        Self {
            moments: Vec::new(),
            selected: 0,
            moment_scroll: 0,
            last_max_scroll: 0,
            draft: String::new(),
            draft_cursor: 0,
            draft_visible: false,
            help_visible: false,
            connection,
            activity: None,
            pending_submission: None,
            next_submission_id: 1,
            approval: None,
        }
    }

    pub fn demo() -> Self {
        let mut app = Self::new(ConnectionState::Demo);
        app.moments.push(Moment::complete(
            "welcome",
            Role::Intelligence,
            "Tell me what you want done.\n\nTry “show me what is taking up space on this computer” or simply start typing.",
        ));
        app
    }

    pub fn moments(&self) -> &[Moment] {
        &self.moments
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    pub fn draft(&self) -> &str {
        &self.draft
    }

    pub fn draft_visible(&self) -> bool {
        self.draft_visible
    }

    pub fn approval(&self) -> Option<&Approval> {
        self.approval.as_ref()
    }

    pub fn set_connection(&mut self, connection: ConnectionState) {
        self.connection = connection;
    }

    pub fn set_activity(&mut self, activity: Option<String>) {
        self.activity = activity;
    }

    pub fn replace_history(&mut self, moments: Vec<Moment>) {
        if moments.is_empty() {
            return;
        }
        self.moments = moments;
        self.selected = self.moments.len().saturating_sub(1);
        self.moment_scroll = 0;
    }

    pub fn enter_approval(&mut self, approval: Approval) {
        self.approval = Some(approval);
        self.draft_visible = false;
    }

    pub fn leave_approval(&mut self, request_id: &str) {
        if self
            .approval
            .as_ref()
            .is_some_and(|approval| approval.request_id == request_id)
        {
            self.approval = None;
        }
    }

    pub fn dispatch(&mut self, action: Action) -> Vec<Effect> {
        if self.help_visible {
            return match action {
                Action::Escape | Action::ToggleHelp => {
                    self.help_visible = false;
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
                self.draft_visible = true;
                self.draft.insert_str(self.draft_cursor, &value);
                self.draft_cursor += value.len();
                Vec::new()
            }
            Action::Backspace => {
                self.draft_visible = true;
                if let Some(previous) = previous_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft.drain(previous..self.draft_cursor);
                    self.draft_cursor = previous;
                }
                Vec::new()
            }
            Action::Delete => {
                self.draft_visible = true;
                if let Some(next) = next_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft.drain(self.draft_cursor..next);
                }
                Vec::new()
            }
            Action::DeleteWord => {
                self.draft_visible = true;
                let before = &self.draft[..self.draft_cursor];
                let trimmed = before.trim_end_matches(char::is_whitespace);
                let word_start = trimmed.rfind(char::is_whitespace).map_or(0, |index| {
                    index + trimmed[index..].chars().next().map_or(0, char::len_utf8)
                });
                self.draft.drain(word_start..self.draft_cursor);
                self.draft_cursor = word_start;
                Vec::new()
            }
            Action::MoveCursorLeft => {
                if let Some(previous) = previous_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft_cursor = previous;
                }
                Vec::new()
            }
            Action::MoveCursorRight => {
                if let Some(next) = next_grapheme_boundary(&self.draft, self.draft_cursor) {
                    self.draft_cursor = next;
                }
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
                self.draft_visible = true;
                self.draft.insert(self.draft_cursor, '\n');
                self.draft_cursor += 1;
                Vec::new()
            }
            Action::Submit => self.begin_submission().into_iter().collect(),
            Action::Escape => {
                self.draft_visible = false;
                Vec::new()
            }
            Action::PreviousMoment => {
                self.previous_moment();
                Vec::new()
            }
            Action::NextMoment => {
                self.next_moment();
                Vec::new()
            }
            Action::ScrollUp => {
                if self.moment_scroll > 0 {
                    self.moment_scroll -= 1;
                } else {
                    self.previous_moment();
                }
                Vec::new()
            }
            Action::ScrollDown => {
                if self.moment_scroll < self.last_max_scroll {
                    self.moment_scroll += 1;
                } else {
                    self.next_moment();
                }
                Vec::new()
            }
            Action::ToggleHelp => {
                self.help_visible = true;
                Vec::new()
            }
            Action::Abort => vec![Effect::Abort],
            Action::DecideApproval { .. } => Vec::new(),
            Action::Quit => vec![Effect::Quit],
        }
    }

    fn begin_submission(&mut self) -> Option<Effect> {
        if self.pending_submission.is_some() || self.draft.trim().is_empty() {
            return None;
        }

        let id = self.next_submission_id;
        self.next_submission_id = self.next_submission_id.saturating_add(1);
        let text = std::mem::take(&mut self.draft);
        self.draft_cursor = 0;
        self.draft_visible = false;
        self.pending_submission = Some(PendingSubmission {
            id,
            text: text.clone(),
        });
        self.moments.push(Moment::complete(
            format!("local:user:{id}"),
            Role::Human,
            text.clone(),
        ));
        self.moments.push(Moment {
            id: format!("local:gsv:{id}"),
            role: Role::Intelligence,
            text: String::new(),
            run_id: None,
            state: MomentState::Streaming,
        });
        self.selected = self.moments.len().saturating_sub(1);
        self.moment_scroll = 0;
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Working
        };
        self.activity = Some("SENDING".to_string());
        Some(Effect::Submit { id, text })
    }

    pub fn submission_accepted(&mut self, id: u64, run_id: String, queued: bool) {
        if self
            .pending_submission
            .as_ref()
            .is_none_or(|pending| pending.id != id)
        {
            return;
        }
        self.pending_submission = None;
        for local_id in [format!("local:user:{id}"), format!("local:gsv:{id}")] {
            if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
                moment.run_id = Some(run_id.clone());
            }
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
            self.draft_cursor = self.draft.len();
            self.draft_visible = true;
        }
        let local_id = format!("local:gsv:{id}");
        if let Some(moment) = self.moments.iter_mut().find(|moment| moment.id == local_id) {
            moment.text = error.into();
            moment.state = MomentState::Error;
        }
        self.connection = ConnectionState::Offline;
        self.activity = None;
    }

    pub fn start_run(&mut self, run_id: &str) {
        if let Some(index) = self.streaming_moment_for(Some(run_id)) {
            self.moments[index].run_id = Some(run_id.to_string());
        }
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Working
        };
        self.activity = Some("THINKING".to_string());
    }

    pub fn append_delta(&mut self, run_id: Option<&str>, delta: &str) {
        let followed_latest = self.selected + 1 >= self.moments.len();
        let index = self.streaming_moment_for(run_id);
        let index = match index {
            Some(index) => index,
            None => {
                self.moments.push(Moment {
                    id: run_id
                        .map(|run_id| format!("run:{run_id}"))
                        .unwrap_or_else(|| format!("stream:{}", self.moments.len())),
                    role: Role::Intelligence,
                    text: String::new(),
                    run_id: run_id.map(str::to_string),
                    state: MomentState::Streaming,
                });
                self.moments.len() - 1
            }
        };
        if self.moments[index].run_id.is_none() {
            self.moments[index].run_id = run_id.map(str::to_string);
        }
        self.moments[index].text.push_str(delta);
        self.activity = Some("RESPONDING".to_string());
        if followed_latest {
            self.selected = index;
        }
    }

    pub fn replace_run_text(&mut self, run_id: Option<&str>, text: impl Into<String>) {
        let text = text.into();
        let index = self.streaming_moment_for(run_id);
        if let Some(index) = index {
            self.moments[index].text = text;
            if self.moments[index].run_id.is_none() {
                self.moments[index].run_id = run_id.map(str::to_string);
            }
        } else {
            self.moments.push(Moment {
                id: run_id
                    .map(|run_id| format!("run:{run_id}"))
                    .unwrap_or_else(|| format!("output:{}", self.moments.len())),
                role: Role::Intelligence,
                text,
                run_id: run_id.map(str::to_string),
                state: MomentState::Streaming,
            });
            self.selected = self.moments.len().saturating_sub(1);
        }
        self.activity = Some("RESPONDING".to_string());
    }

    pub fn finish_run(&mut self, run_id: Option<&str>, error: Option<&str>) {
        let index = match run_id {
            Some(run_id) => self
                .moments
                .iter()
                .rposition(|moment| moment.run_id.as_deref() == Some(run_id)),
            None => self.moments.iter().rposition(|moment| {
                moment.role == Role::Intelligence && moment.state == MomentState::Streaming
            }),
        };
        let Some(index) = index else {
            return;
        };
        let moment = &mut self.moments[index];
        if let Some(error) = error.filter(|error| !error.is_empty()) {
            if !moment.text.is_empty() {
                moment.text.push_str("\n\n");
            }
            moment.text.push_str(error);
            moment.state = MomentState::Error;
        } else {
            if moment.text.is_empty() {
                moment.text = "Done.".to_string();
            }
            moment.state = MomentState::Complete;
        }
        self.connection = if self.connection == ConnectionState::Demo {
            ConnectionState::Demo
        } else {
            ConnectionState::Ready
        };
        self.activity = None;
        self.approval = None;
    }

    pub fn commit_message(
        &mut self,
        id: impl Into<String>,
        role: Role,
        text: impl Into<String>,
        run_id: Option<String>,
    ) {
        let id = id.into();
        let text = text.into();
        if self.moments.iter().any(|moment| moment.id == id) {
            return;
        }
        if role == Role::Human {
            let exact_run = run_id.as_deref().and_then(|run_id| {
                self.moments.iter().rposition(|moment| {
                    moment.role == Role::Human
                        && moment.id.starts_with("local:user:")
                        && moment.run_id.as_deref() == Some(run_id)
                })
            });
            let unbound = self.moments.iter().rposition(|moment| {
                moment.role == Role::Human
                    && moment.id.starts_with("local:user:")
                    && moment.run_id.is_none()
                    && moment.text == text
            });
            if let Some(moment) = exact_run
                .or(unbound)
                .and_then(|index| self.moments.get_mut(index))
            {
                moment.id = id;
                moment.run_id = run_id;
                return;
            }
        }
        if role == Role::Intelligence {
            if let Some(index) = run_id.as_deref().and_then(|run_id| {
                self.moments
                    .iter()
                    .rposition(|moment| moment.run_id.as_deref() == Some(run_id))
            }) {
                let moment = &mut self.moments[index];
                moment.id = id;
                moment.text = text;
                moment.state = MomentState::Complete;
                return;
            }
        }
        self.moments.push(Moment {
            id,
            role,
            text,
            run_id,
            state: MomentState::Complete,
        });
        self.selected = self.moments.len().saturating_sub(1);
        self.moment_scroll = 0;
    }

    pub fn complete_demo_submission(&mut self, id: u64, request: &str) {
        let run_id = format!("demo:{id}");
        self.submission_accepted(id, run_id.clone(), false);
        self.append_delta(Some(&run_id), &demo_reply(request));
        self.finish_run(Some(&run_id), None);
    }

    fn previous_moment(&mut self) {
        if !self.draft_visible && self.selected > 0 {
            self.selected -= 1;
            self.moment_scroll = 0;
        }
    }

    fn next_moment(&mut self) {
        if !self.draft_visible && self.selected + 1 < self.moments.len() {
            self.selected += 1;
            self.moment_scroll = 0;
        }
    }

    fn streaming_moment_for(&self, run_id: Option<&str>) -> Option<usize> {
        if let Some(run_id) = run_id {
            if let Some(index) = self
                .moments
                .iter()
                .rposition(|moment| moment.run_id.as_deref() == Some(run_id))
            {
                return Some(index);
            }
            return self.moments.iter().rposition(|moment| {
                moment.role == Role::Intelligence
                    && moment.state == MomentState::Streaming
                    && moment.run_id.is_none()
            });
        }
        self.moments.iter().rposition(|moment| {
            moment.role == Role::Intelligence && moment.state == MomentState::Streaming
        })
    }

    pub fn render(&mut self, frame: &mut Frame<'_>) {
        let area = frame.area();
        frame.render_widget(Block::new().style(Style::new().bg(BACKGROUND)), area);
        if area.width < 32 || area.height < 12 {
            frame.render_widget(
                Paragraph::new("GSV needs a little more room")
                    .alignment(Alignment::Center)
                    .style(Style::new().fg(FOREGROUND).bg(BACKGROUND)),
                area,
            );
            return;
        }

        let [header, body, footer] = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(6),
            Constraint::Length(3),
        ])
        .areas(area);
        self.render_header(frame, header);
        self.render_body(frame, body);
        self.render_footer(frame, footer);
        if self.help_visible {
            self.render_help(frame, area);
        }
    }

    fn render_header(&self, frame: &mut Frame<'_>, area: Rect) {
        let [brand, status] = Layout::horizontal([Constraint::Min(12), Constraint::Length(24)])
            .areas(area.inner(Margin::new(2, 0)));
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    "GSV",
                    Style::new().fg(FOREGROUND).add_modifier(Modifier::BOLD),
                ),
                Span::styled("  /  SHIP", Style::new().fg(MUTED)),
            ])),
            brand,
        );
        let activity = self.activity.as_deref().unwrap_or(self.connection.label());
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("● ", Style::new().fg(self.connection.color())),
                Span::styled(activity, Style::new().fg(MUTED)),
            ]))
            .alignment(Alignment::Right),
            status,
        );
    }

    fn render_body(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let [rail, canvas, _breathing_room] = Layout::horizontal([
            Constraint::Length(5),
            Constraint::Min(20),
            Constraint::Length(4),
        ])
        .areas(area);
        self.render_rail(frame, rail);

        if let Some(approval) = &self.approval {
            self.last_max_scroll = 0;
            render_approval(frame, canvas, approval);
        } else if self.draft_visible {
            self.last_max_scroll = 0;
            self.render_draft(frame, canvas);
        } else {
            self.render_moment(frame, canvas);
        }
    }

    fn render_rail(&self, frame: &mut Frame<'_>, area: Rect) {
        if self.moments.is_empty() {
            return;
        }
        let visible = usize::from(area.height.saturating_sub(4)).max(1);
        let half = visible / 2;
        let start = self
            .selected
            .saturating_sub(half)
            .min(self.moments.len().saturating_sub(visible));
        let end = (start + visible).min(self.moments.len());
        let mut lines = Vec::with_capacity(end - start + 1);
        for index in start..end {
            let selected = index == self.selected;
            lines.push(Line::from(Span::styled(
                if selected { "  ●" } else { "  ·" },
                Style::new().fg(if selected { ACCENT } else { QUIET }),
            )));
        }
        let height = u16::try_from(lines.len())
            .unwrap_or(u16::MAX)
            .min(area.height);
        let y = area.y + area.height.saturating_sub(height) / 2;
        frame.render_widget(
            Paragraph::new(lines),
            Rect::new(area.x, y, area.width, height),
        );
    }

    fn render_moment(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let Some(moment) = self.moments.get(self.selected) else {
            self.last_max_scroll = 0;
            frame.render_widget(
                Paragraph::new("Start typing.")
                    .style(Style::new().fg(MUTED))
                    .alignment(Alignment::Center),
                area,
            );
            return;
        };

        let content_area = area.inner(Margin::new(2, 1));
        let text_width = content_area.width.max(1);
        let body = if moment.text.is_empty() && moment.state == MomentState::Streaming {
            "Thinking…"
        } else {
            moment.text.as_str()
        };
        let body_style = Style::new().fg(if moment.state == MomentState::Error {
            ERROR
        } else {
            moment.role.color()
        });
        let mut lines = vec![
            Line::from(Span::styled(
                moment.role.label(),
                Style::new()
                    .fg(moment.role.color())
                    .add_modifier(Modifier::BOLD),
            )),
            Line::default(),
        ];
        lines.extend(
            body.split('\n')
                .map(|line| Line::from(Span::styled(line, body_style))),
        );
        let text = Text::from(lines);
        let paragraph = Paragraph::new(text).wrap(Wrap { trim: false });
        let line_count_u16 = text_metrics(body, body.len(), text_width)
            .2
            .saturating_add(2);
        self.last_max_scroll = line_count_u16.saturating_sub(content_area.height);
        self.moment_scroll = self.moment_scroll.min(self.last_max_scroll);
        let render_height = line_count_u16.min(content_area.height).max(1);
        let y = if self.last_max_scroll == 0 {
            content_area.y + content_area.height.saturating_sub(render_height) / 2
        } else {
            content_area.y
        };
        let render_area = Rect::new(content_area.x, y, content_area.width, render_height);
        frame.render_widget(paragraph.scroll((self.moment_scroll, 0)), render_area);
    }

    fn render_draft(&self, frame: &mut Frame<'_>, area: Rect) {
        let content_area = area.inner(Margin::new(2, 1));
        let label_height = 2;
        let available_text_height = content_area.height.saturating_sub(label_height).max(1);
        let width = content_area.width.max(1);
        let (cursor_row, cursor_col, total_rows) =
            text_metrics(&self.draft, self.draft_cursor, width);
        let visible_rows = total_rows.min(available_text_height).max(1);
        let compound_height = label_height + visible_rows;
        let y = content_area.y + content_area.height.saturating_sub(compound_height) / 2;
        let label_area = Rect::new(content_area.x, y, width, 1);
        let text_area = Rect::new(content_area.x, y + label_height, width, visible_rows);
        frame.render_widget(
            Paragraph::new("YOU  /  DRAFT")
                .style(Style::new().fg(HUMAN).add_modifier(Modifier::BOLD)),
            label_area,
        );
        let scroll = cursor_row.saturating_sub(visible_rows.saturating_sub(1));
        let draft_text = if self.draft.is_empty() {
            Text::styled("What should happen?", Style::new().fg(QUIET))
        } else {
            Text::styled(self.draft.as_str(), Style::new().fg(FOREGROUND))
        };
        frame.render_widget(
            Paragraph::new(draft_text)
                .wrap(Wrap { trim: false })
                .scroll((scroll, 0)),
            text_area,
        );
        let cursor_y = text_area.y + cursor_row.saturating_sub(scroll);
        let cursor_x = text_area.x + cursor_col.min(text_area.width.saturating_sub(1));
        if cursor_y < text_area.bottom() {
            frame.set_cursor_position(Position::new(cursor_x, cursor_y));
        }
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let hint = if self.approval.is_some() {
            "O  ALLOW ONCE     A  ALWAYS ALLOW     D  DENY"
        } else if self.draft_visible {
            "ENTER  SEND     SHIFT+ENTER  NEW LINE     ESC  KEEP FOR LATER"
        } else {
            "TYPE  ASK ANYTHING     CTRL+P / CTRL+N  MOVE     ?  KEYS"
        };
        let inner = area.inner(Margin::new(2, 0));
        frame.render_widget(
            Paragraph::new(hint)
                .style(Style::new().fg(MUTED))
                .alignment(Alignment::Center),
            inner,
        );
    }

    fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        let width = area.width.saturating_sub(8).min(68);
        let height = area.height.saturating_sub(4).min(20);
        let popup = centered_rect(area, width, height);
        frame.render_widget(Clear, popup);
        let help = Text::from(vec![
            Line::from(Span::styled(
                "THE GSV GRAMMAR",
                Style::new().fg(FOREGROUND).add_modifier(Modifier::BOLD),
            )),
            Line::default(),
            help_line("type anywhere", "write a request"),
            help_line("enter", "send"),
            help_line("shift+enter", "new line"),
            help_line("escape", "hide the draft without losing it"),
            help_line("ctrl+p / ctrl+n", "previous / next moment"),
            help_line("alt+up / alt+down", "previous / next moment"),
            help_line("page up / page down", "scroll a long moment"),
            help_line("ctrl+.", "stop the active run"),
            help_line("ctrl+q", "leave GSV"),
            Line::default(),
            Line::from(Span::styled(
                "Press ? or escape to return",
                Style::new().fg(MUTED),
            )),
        ]);
        frame.render_widget(
            Paragraph::new(help)
                .block(
                    Block::new()
                        .borders(Borders::ALL)
                        .border_type(BorderType::Rounded)
                        .border_style(Style::new().fg(QUIET))
                        .style(Style::new().bg(BACKGROUND))
                        .padding(Padding::new(3, 3, 2, 2)),
                )
                .wrap(Wrap { trim: false }),
            popup,
        );
    }
}

fn render_approval(frame: &mut Frame<'_>, area: Rect, approval: &Approval) {
    let content_area = area.inner(Margin::new(2, 1));
    let mut lines = vec![
        Line::from(Span::styled(
            "APPROVAL REQUIRED",
            Style::new().fg(WARNING).add_modifier(Modifier::BOLD),
        )),
        Line::default(),
        Line::from(vec![
            Span::styled(&approval.syscall, Style::new().fg(FOREGROUND)),
            Span::styled("  ON  ", Style::new().fg(MUTED)),
            Span::styled(&approval.target, Style::new().fg(ACCENT)),
        ]),
        Line::default(),
    ];
    lines.extend(
        approval
            .preview
            .split('\n')
            .map(|line| Line::from(Span::styled(line, Style::new().fg(MUTED)))),
    );
    let text = Text::from(lines);
    let paragraph = Paragraph::new(text).wrap(Wrap { trim: false });
    let width = content_area.width.max(1);
    let action = format!("{}  ON  {}", approval.syscall, approval.target);
    let line_count = text_metrics(&action, action.len(), width)
        .2
        .saturating_add(text_metrics(&approval.preview, approval.preview.len(), width).2)
        .saturating_add(3)
        .min(content_area.height);
    let render_area = Rect::new(
        content_area.x,
        content_area.y + content_area.height.saturating_sub(line_count) / 2,
        content_area.width,
        line_count.max(1),
    );
    frame.render_widget(paragraph, render_area);
}

fn help_line(key: &'static str, meaning: &'static str) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{key:<22}"), Style::new().fg(ACCENT)),
        Span::styled(meaning, Style::new().fg(MUTED)),
    ])
}

fn centered_rect(area: Rect, width: u16, height: u16) -> Rect {
    let [vertical] = Layout::new(Direction::Vertical, [Constraint::Length(height)])
        .flex(ratatui::layout::Flex::Center)
        .areas(area);
    let [centered] = Layout::new(Direction::Horizontal, [Constraint::Length(width)])
        .flex(ratatui::layout::Flex::Center)
        .areas(vertical);
    centered
}

fn previous_grapheme_boundary(value: &str, cursor: usize) -> Option<usize> {
    value[..cursor]
        .grapheme_indices(true)
        .next_back()
        .map(|(index, _)| index)
}

fn next_grapheme_boundary(value: &str, cursor: usize) -> Option<usize> {
    value[cursor..]
        .grapheme_indices(true)
        .nth(1)
        .map(|(index, _)| cursor + index)
        .or_else(|| (cursor < value.len()).then_some(value.len()))
}

fn text_metrics(value: &str, cursor: usize, width: u16) -> (u16, u16, u16) {
    let width = width.max(1);
    let mut row = 0_u16;
    let mut col = 0_u16;
    let mut cursor_position = None;
    for (index, grapheme) in value.grapheme_indices(true) {
        if index == cursor {
            cursor_position = Some((row, col));
        }
        if grapheme == "\n" {
            row = row.saturating_add(1);
            col = 0;
            continue;
        }
        let grapheme_width = u16::try_from(UnicodeWidthStr::width(grapheme))
            .unwrap_or(1)
            .max(1);
        if col.saturating_add(grapheme_width) > width {
            row = row.saturating_add(1);
            col = 0;
        }
        col = col.saturating_add(grapheme_width);
        if col >= width {
            row = row.saturating_add(1);
            col = 0;
        }
    }
    let (cursor_row, cursor_col) = cursor_position.unwrap_or((row, col));
    (cursor_row, cursor_col, row.saturating_add(1))
}

fn demo_reply(request: &str) -> String {
    let normalized = request.to_ascii_lowercase();
    if normalized.contains("download") && normalized.contains("open") {
        "I’d open ~/Downloads on this computer.\n\nThis preview is intentionally disconnected, so no local action was taken. The connected TUI sends the same request through GSV’s capability boundary."
            .to_string()
    } else if normalized.starts_with("ls") || normalized.contains("list the files") {
        "Desktop\nDocuments\nDownloads\nPictures\nProjects\n\nIn connected mode this comes from the selected machine target; this preview uses example output."
            .to_string()
    } else {
        format!(
            "Understood. I’d turn “{}” into an inspectable GSV run, ask only for capabilities it needs, and keep you in control while it works.\n\nThis browser/native preview is exercising the shared TUI interface; connect it to run the request for real.",
            request.trim()
        )
    }
}

#[cfg(test)]
mod tests {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    use super::{
        text_metrics, Action, App, Approval, ConnectionState, Effect, Moment, MomentState, Role,
    };

    #[test]
    fn typing_replaces_the_moment_and_escape_preserves_the_draft() {
        let mut app = App::demo();
        app.dispatch(Action::Insert("open downloads".to_string()));
        assert!(app.draft_visible());
        app.dispatch(Action::Escape);
        assert!(!app.draft_visible());
        assert_eq!(app.draft(), "open downloads");
        app.dispatch(Action::Insert(" please".to_string()));
        assert_eq!(app.draft(), "open downloads please");
    }

    #[test]
    fn submission_is_optimistic_and_restores_failed_text() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("show downloads".to_string()));
        assert_eq!(
            app.dispatch(Action::Submit),
            vec![Effect::Submit {
                id: 1,
                text: "show downloads".to_string(),
            }]
        );
        assert_eq!(app.moments().len(), 2);
        app.submission_failed(1, "Could not connect");
        assert_eq!(app.draft(), "show downloads");
        assert!(app.draft_visible());
    }

    #[test]
    fn ctrl_style_navigation_keeps_one_selected_moment() {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![
            Moment::complete("one", Role::Human, "one"),
            Moment::complete("two", Role::Intelligence, "two"),
        ]);
        assert_eq!(app.selected(), 1);
        app.dispatch(Action::PreviousMoment);
        assert_eq!(app.selected(), 0);
        app.dispatch(Action::NextMoment);
        assert_eq!(app.selected(), 1);
    }

    #[test]
    fn render_contains_only_the_selected_moment_body() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![
            Moment::complete("one", Role::Human, "older secret"),
            Moment::complete("two", Role::Intelligence, "visible answer"),
        ]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let rendered = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(rendered.contains("visible answer"));
        assert!(!rendered.contains("older secret"));
        Ok(())
    }

    #[test]
    fn render_preserves_explicit_message_line_breaks() -> Result<(), Box<dyn std::error::Error>> {
        let mut app = App::new(ConnectionState::Ready);
        app.replace_history(vec![Moment::complete(
            "answer",
            Role::Intelligence,
            "first line\n\nsecond line",
        )]);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let buffer = terminal.backend().buffer();
        let first_row = buffer
            .content()
            .chunks(80)
            .position(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .contains("first line")
            })
            .expect("first line should be rendered");
        let second_row = buffer
            .content()
            .chunks(80)
            .position(|row| {
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .contains("second line")
            })
            .expect("second line should be rendered");
        assert_eq!(second_row, first_row + 2);
        Ok(())
    }

    #[test]
    fn stale_run_completion_cannot_finish_the_active_response() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("do it".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(1, "run:current".to_string(), false);
        app.append_delta(Some("run:current"), "still working");
        app.enter_approval(Approval {
            request_id: "approval:current".to_string(),
            syscall: "shell.exec".to_string(),
            target: "machine:current".to_string(),
            preview: "safe".to_string(),
        });

        app.finish_run(Some("run:old"), Some("late failure"));

        let active = app
            .moments()
            .iter()
            .find(|moment| {
                moment.run_id.as_deref() == Some("run:current") && moment.role == Role::Intelligence
            })
            .expect("active response");
        assert_eq!(active.text, "still working");
        assert_eq!(active.state, MomentState::Streaming);
        assert!(app.approval().is_some());
    }

    #[test]
    fn identical_user_messages_reconcile_by_run_identity() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Insert("repeat".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(1, "run:first".to_string(), false);
        app.dispatch(Action::Insert("repeat".to_string()));
        app.dispatch(Action::Submit);
        app.submission_accepted(2, "run:second".to_string(), true);

        app.commit_message(
            "message:first",
            Role::Human,
            "repeat",
            Some("run:first".to_string()),
        );

        assert!(app
            .moments()
            .iter()
            .any(|moment| moment.id == "message:first"
                && moment.run_id.as_deref() == Some("run:first")));
        assert!(app
            .moments()
            .iter()
            .any(|moment| moment.id == "local:user:2"
                && moment.run_id.as_deref() == Some("run:second")));
    }

    #[test]
    fn cursor_metrics_treat_a_combining_sequence_as_one_cell() {
        let value = "e\u{301}x";
        assert_eq!(text_metrics(value, "e\u{301}".len(), 20), (0, 1, 1));
    }
}
