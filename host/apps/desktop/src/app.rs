use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Instant;

use gpui::{
    actions, App, AppContext, ClipboardItem, Context, Entity, FocusHandle, Focusable, KeyBinding,
    PathPromptOptions, ScrollHandle, Subscription, Task, Window,
};
use gpui_component::input::{Copy, InputEvent, InputState};

use crate::attachments::{AttachmentError, AttachmentStore, DraftAttachment};
use crate::audio::{KeySound, TypingAudio};
use crate::client::{
    ApprovalDecision, ClientCommand, ClientHandle, MediaFileAction, MediaTransferLease,
    OutgoingAttachment,
};
use crate::content::MediaAttachment;
use crate::desktop_control::DesktopControlRequest;
use crate::history::{HistoryPreparationCandidate, HistoryRevision};
use crate::interaction::{CanvasInteraction, CanvasLayer, SubmissionFailure};
use crate::media_files::{MaterializedMedia, MediaFileStore};
use crate::model::{Conversation, MomentIdentityAdoption, SurfaceMode};
use crate::prepared::PreparedContent;
use crate::startup::{LoginDefaults, LoginFlow, LoginProgress, LoginStep};
use crate::transcription::{coalesce_for_ui, VoiceCommand};
use crate::typography::TypeLayout;
use desktop_protocol::{DesktopStatus, GatewayState, OperationError, ProcessId, WindowState};
use gesture_protocol::{GestureContext, GestureProgress, LifecycleState};
use host_config::MicrophonePreference;

mod gesture;
mod gesture_guide;
mod login;
mod media;
mod microphone;
mod preparation;
mod presence;
mod rich;
mod selection;
mod session;
mod view;

use media::{release_assets, MediaCache, MediaPreparation, PreparedMedia};
use microphone::{
    configured_microphone_preference, MicrophoneChooser, PendingMicrophoneRequest, VoiceDraft,
};
use preparation::{run_preparation_worker, PreparedContentCache};
use presence::PresenceLane;
use selection::TextSelection;

actions!(
    desktop,
    [
        SubmitThought,
        InsertNewline,
        HideDraft,
        AbortRun,
        ToggleTerminal,
        PreviousMoment,
        NextMoment,
        ToggleDictation,
        ToggleGestureGuide,
        ChooseMicrophone,
        PreviousMicrophone,
        NextMicrophone,
        SelectMicrophone,
        AddAttachment
    ]
);

#[derive(Clone, Debug)]
struct TerminalExchange {
    command: String,
    output: String,
    exit_code: Option<i64>,
    pending: bool,
}

struct MediaPreparationResult {
    request_id: u64,
    prepared: PreparedMedia,
    _lease: MediaTransferLease,
}

struct AttachmentPreparationResult {
    batch_id: u64,
    result: Result<Vec<DraftAttachment>, AttachmentError>,
}

struct MediaFilePreparationResult {
    request_id: u64,
    action: MediaFileAction,
    result: std::io::Result<MaterializedMedia>,
    _lease: MediaTransferLease,
}

#[derive(Debug, PartialEq, Eq)]
struct VoiceComposition {
    value: String,
    cursor: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct HistoryEdgeIntent {
    direction: i8,
    progress: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum MessageScrollAnchor {
    Top,
    Bottom,
    Ratio(f32),
    Absolute(f32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum RichPresentationPhase {
    Steady,
    FadingPlain,
    AwaitingRichLayout { anchor: MessageScrollAnchor },
    FadingRich,
    UpdatingRichLayout { anchor: MessageScrollAnchor },
}

#[derive(Clone, Debug)]
struct RichPresentation {
    moment_id: String,
    revision: u64,
    epoch: u64,
    phase: RichPresentationPhase,
    outgoing_content: Option<PreparedContent>,
}

#[derive(Clone, Debug)]
struct PendingRichFallback {
    moment_id: String,
    content: PreparedContent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct VoiceGestureStatus {
    sequence: u64,
    received_at: Instant,
    context: GestureContext,
    progress: Option<GestureProgress>,
}

pub(crate) enum VisionStartup {
    Disabled,
    Unavailable,
    Started(crate::vision_debug::VisionHandle),
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct CachedTypeLayout {
    content_hash: u64,
    maximum_size: Option<u32>,
    weight: u32,
    last_used: u64,
    layout: TypeLayout,
}

impl CachedTypeLayout {
    fn matches(
        self,
        content_hash: u64,
        maximum_size: Option<f32>,
        weight: gpui::FontWeight,
    ) -> bool {
        self.content_hash == content_hash
            && self.maximum_size == maximum_size.map(f32::to_bits)
            && self.weight == weight.0.to_bits()
    }
}

fn type_content_hash(value: &impl Hash) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn new_login_input(
    login: &LoginFlow,
    window: &mut Window,
    cx: &mut Context<GsvApp>,
) -> Option<Entity<InputState>> {
    let (masked, placeholder) = match login.step() {
        LoginStep::Url => (false, "ws://localhost:8787/ws"),
        LoginStep::Username => (false, "username"),
        LoginStep::Password => (true, "password"),
        LoginStep::Connecting | LoginStep::SetupRequired => return None,
    };
    let input = cx.new(|cx| {
        InputState::new(window, cx)
            .masked(masked)
            .placeholder(placeholder)
    });
    let value = login.input_value();
    input.update(cx, |input, cx| input.set_value(value, window, cx));
    Some(input)
}

pub struct GsvApp {
    conversation: Conversation,
    interaction: CanvasInteraction,
    input: gpui::Entity<InputState>,
    login: Option<LoginFlow>,
    login_input: Option<Entity<InputState>>,
    login_input_len: usize,
    login_focus: FocusHandle,
    commands: tokio::sync::mpsc::UnboundedSender<ClientCommand>,
    audio: TypingAudio,
    terminal_draft: String,
    previous_input: String,
    pid: Option<String>,
    client_session_id: Option<u64>,
    last_history: Option<HistoryRevision>,
    last_history_generation: u64,
    history_preparations: HashMap<String, HistoryPreparationCandidate>,
    terminal: Vec<TerminalExchange>,
    timeline_scroll: ScrollHandle,
    message_scroll: ScrollHandle,
    message_scroll_moment: Option<String>,
    history_scroll_accumulator: f32,
    history_scroll_last_event: Option<Instant>,
    history_edge_intent: Option<HistoryEdgeIntent>,
    history_edge_feedback_epoch: u64,
    presence_lane: Entity<PresenceLane>,
    rich_presentation: Option<RichPresentation>,
    pending_rich_fallback: Option<PendingRichFallback>,
    next_rich_presentation_epoch: u64,
    rich_layout_wait_scheduled: Option<u64>,
    rich_steady_wait_scheduled: Option<u64>,
    timeline_scroll_accumulator: f32,
    timeline_scroll_last_event: Option<Instant>,
    stream_type_sizes: HashMap<String, f32>,
    type_layouts: HashMap<String, CachedTypeLayout>,
    type_layout_clock: u64,
    prepared_content: PreparedContentCache,
    media_cache: MediaCache,
    media_preparation_results: tokio::sync::mpsc::Sender<MediaPreparationResult>,
    media_preparations: HashMap<u64, Task<()>>,
    attachment_store: Option<AttachmentStore>,
    draft_attachments: Vec<DraftAttachment>,
    pending_attachments: HashMap<u64, Vec<DraftAttachment>>,
    next_attachment_batch_id: u64,
    attachment_preparation_results: tokio::sync::mpsc::Sender<AttachmentPreparationResult>,
    attachment_preparations: HashMap<u64, Task<()>>,
    attachment_picker: Option<Task<()>>,
    media_file_store: Option<MediaFileStore>,
    next_media_file_request_id: u64,
    media_file_results: tokio::sync::mpsc::Sender<MediaFilePreparationResult>,
    media_file_preparations: HashMap<u64, Task<()>>,
    media_file_saves: HashMap<u64, Task<()>>,
    draft_type_size: Option<f32>,
    stream_sequences: HashMap<String, u64>,
    type_viewport: Option<(u32, u32)>,
    transition_epoch: u64,
    transition_direction: f32,
    message_transition_cost: Option<(u64, bool)>,
    text_selection: TextSelection,
    reduced_motion: bool,
    programmatic_input: Option<String>,
    approval_resume_mode: Option<SurfaceMode>,
    desktop_switch_pending: bool,
    desktop_switch_source_pid: Option<String>,
    voice_commands: crate::transcription::VoiceCommandSender,
    voice_draft: Option<VoiceDraft>,
    voice_notice: Option<String>,
    microphone_preference: MicrophonePreference,
    microphone_chooser: Option<MicrophoneChooser>,
    microphone_focus: FocusHandle,
    pending_microphone_request: Option<PendingMicrophoneRequest>,
    microphone_request_cancellation: Option<Task<()>>,
    microphone_save_pending: bool,
    microphone_save_generation: u64,
    microphone_save_cancellation: Option<Arc<AtomicBool>>,
    microphone_save_task: Option<Task<()>>,
    next_voice_request_id: u64,
    vision_context: Option<crate::vision_debug::VisionContextSender>,
    vision_voice_request_id: Option<u64>,
    vision_lifecycle: Option<gesture_protocol::LifecycleState>,
    vision_gesture_status: Option<VoiceGestureStatus>,
    vision_gesture_expiry_task: Option<Task<()>>,
    vision_status_sequence: u64,
    gesture_guide_open: bool,
    _input_subscription: Subscription,
    _login_subscription: Option<Subscription>,
    _event_task: Task<()>,
    _preparation_worker: Task<()>,
    _preparation_task: Task<()>,
    _media_preparation_task: Task<()>,
    _attachment_preparation_task: Task<()>,
    _media_file_task: Task<()>,
    _voice_task: Task<()>,
    _vision_task: Option<Task<()>>,
}

impl GsvApp {
    fn handle_desktop_control(
        &mut self,
        request: DesktopControlRequest,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match request {
            DesktopControlRequest::Activate { context, response } => {
                if context.is_cancelled() || response.is_closed() {
                    return;
                }
                window.activate_window();
                self.input.focus_handle(cx).focus(window);
                let _ = response.send(Ok(()));
            }
            DesktopControlRequest::Status { context, response } => {
                if context.is_cancelled() || response.is_closed() {
                    return;
                }
                let gateway = if self.login.is_some() {
                    GatewayState::Disconnected
                } else if self.client_session_id.is_some()
                    && self.conversation.connection == crate::model::ConnectionState::Connected
                {
                    GatewayState::Connected
                } else {
                    GatewayState::Connecting
                };
                let selected_process = self
                    .pid
                    .as_ref()
                    .and_then(|pid| ProcessId::new(pid.clone()).ok());
                let status = DesktopStatus {
                    gateway,
                    window: if window.is_window_active() {
                        WindowState::Focused
                    } else {
                        WindowState::Visible
                    },
                    selected_process,
                };
                let _ = response.send(Ok(status));
            }
            DesktopControlRequest::New { context, response } => {
                if !self.desktop_process_change_allowed(&context, response.is_closed()) {
                    let error = if self.login.is_some() || self.client_session_id.is_none() {
                        OperationError::Unavailable
                    } else {
                        OperationError::Busy
                    };
                    let _ = response.send(Err(error));
                    return;
                }
                window.activate_window();
                self.desktop_switch_pending = true;
                self.desktop_switch_source_pid.clone_from(&self.pid);
                if self
                    .commands
                    .send(ClientCommand::DesktopNew { context, response })
                    .is_err()
                {
                    self.desktop_switch_pending = false;
                    self.desktop_switch_source_pid = None;
                    // The response sender was moved into the failed command and
                    // is dropped here, so the handler reports unavailable.
                }
            }
            DesktopControlRequest::Use {
                context,
                process_id,
                response,
            } => {
                if !self.desktop_process_change_allowed(&context, response.is_closed()) {
                    let error = if self.login.is_some() || self.client_session_id.is_none() {
                        OperationError::Unavailable
                    } else {
                        OperationError::Busy
                    };
                    let _ = response.send(Err(error));
                    return;
                }
                window.activate_window();
                self.desktop_switch_pending = true;
                self.desktop_switch_source_pid.clone_from(&self.pid);
                if self
                    .commands
                    .send(ClientCommand::DesktopUse {
                        context,
                        process_id,
                        response,
                    })
                    .is_err()
                {
                    self.desktop_switch_pending = false;
                    self.desktop_switch_source_pid = None;
                    // See DesktopNew: dropping the response maps to unavailable.
                }
            }
            DesktopControlRequest::MicrophoneList { context, response } => {
                self.handle_microphone_control(context, response, None, window, cx);
            }
            DesktopControlRequest::MicrophoneUse {
                context,
                name,
                response,
            } => {
                self.handle_microphone_control(
                    context,
                    response,
                    Some(MicrophonePreference::Device {
                        id: None,
                        name: name.into_inner(),
                    }),
                    window,
                    cx,
                );
            }
            DesktopControlRequest::MicrophoneDefault { context, response } => {
                self.handle_microphone_control(
                    context,
                    response,
                    Some(MicrophonePreference::SystemDefault),
                    window,
                    cx,
                );
            }
        }
    }

    fn desktop_process_change_allowed(
        &self,
        context: &desktop_protocol::RequestContext,
        response_closed: bool,
    ) -> bool {
        !context.is_cancelled()
            && !response_closed
            && self.login.is_none()
            && self.client_session_id.is_some()
            && !self.desktop_switch_pending
            && self.conversation.mode == SurfaceMode::Conversation
            && !self.interaction.is_submitting()
            && !self.interaction.is_approval()
            && !self.interaction.is_approval_submitting()
            && self.interaction.conversation_draft().is_empty()
            && self.draft_attachments.is_empty()
            && self.pending_attachments.is_empty()
            && self.attachment_preparations.is_empty()
            && self.attachment_picker.is_none()
            && self.media_preparations.is_empty()
            && self.media_file_preparations.is_empty()
            && self.media_file_saves.is_empty()
            && self.voice_draft.is_none()
            && self.microphone_chooser.is_none()
            && self.pending_microphone_request.is_none()
            && !self.microphone_save_pending
            && self.terminal_draft.is_empty()
            && !self.terminal.iter().any(|exchange| exchange.pending)
    }

    fn reset_process_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.desktop_switch_pending = false;
        self.desktop_switch_source_pid = None;
        let released = self.media_cache.clear(&self.commands);
        self.cancel_stale_media_preparations();
        release_assets(released, cx);
        for attachment in self.draft_attachments.drain(..) {
            let _ = std::fs::remove_file(attachment.snapshot);
        }
        for attachments in self
            .pending_attachments
            .drain()
            .map(|(_, attachments)| attachments)
        {
            for attachment in attachments {
                let _ = std::fs::remove_file(attachment.snapshot);
            }
        }
        self.interaction.set_conversation_has_attachments(false);
        self.conversation = Conversation::connecting();
        self.interaction = CanvasInteraction::new();
        self.terminal.clear();
        self.terminal_draft.clear();
        self.previous_input.clear();
        self.last_history = None;
        self.last_history_generation = 0;
        self.history_preparations.clear();
        self.stream_sequences.clear();
        self.stream_type_sizes.clear();
        self.type_layouts.clear();
        self.draft_type_size = None;
        self.prepared_content.clear();
        self.rich_presentation = None;
        self.pending_rich_fallback = None;
        self.message_scroll_moment = None;
        self.timeline_scroll = ScrollHandle::new();
        self.message_scroll = ScrollHandle::new();
        self.history_scroll_accumulator = 0.0;
        self.history_scroll_last_event = None;
        self.history_edge_intent = None;
        self.timeline_scroll_accumulator = 0.0;
        self.timeline_scroll_last_event = None;
        self.text_selection.clear();
        self.approval_resume_mode = None;
        self.programmatic_input = None;
        self.set_input_value(String::new(), window, cx);
    }

    fn adopt_moment_presentations(&mut self, adoptions: &[MomentIdentityAdoption]) {
        for adoption in adoptions {
            let transient_key = format!("moment:{}", adoption.transient_id);
            let durable_key = format!("moment:{}", adoption.durable_id);
            if let Some(size) = self.stream_type_sizes.remove(&transient_key) {
                self.stream_type_sizes.insert(durable_key.clone(), size);
                self.stream_type_sizes
                    .entry(format!("run:{}", adoption.run_id))
                    .or_insert(size);
            }
            if let Some(layout) = self.type_layouts.remove(&transient_key) {
                self.type_layouts.entry(durable_key).or_insert(layout);
            }
            if self.message_scroll_moment.as_deref() == Some(adoption.transient_id.as_str()) {
                self.message_scroll_moment = Some(adoption.durable_id.clone());
            }
            self.text_selection
                .adopt_moment_id(&adoption.transient_id, &adoption.durable_id);
            if let Some(presentation) = self
                .rich_presentation
                .as_mut()
                .filter(|presentation| presentation.moment_id == adoption.transient_id)
            {
                presentation.moment_id.clone_from(&adoption.durable_id);
            }
            if let Some(fallback) = self
                .pending_rich_fallback
                .as_mut()
                .filter(|fallback| fallback.moment_id == adoption.transient_id)
            {
                fallback.moment_id.clone_from(&adoption.durable_id);
            }
        }
    }

    #[cfg(test)]
    pub fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        client: ClientHandle,
        demo: bool,
        sound_enabled: bool,
        reduced_motion: bool,
    ) -> Self {
        Self::new_with_vision(
            window,
            cx,
            client,
            demo,
            sound_enabled,
            reduced_motion,
            VisionStartup::Disabled,
        )
    }

    pub(crate) fn new_with_vision(
        window: &mut Window,
        cx: &mut Context<Self>,
        client: ClientHandle,
        demo: bool,
        sound_enabled: bool,
        reduced_motion: bool,
        vision_startup: VisionStartup,
    ) -> Self {
        let (vision, initial_vision_lifecycle) = match vision_startup {
            VisionStartup::Disabled => (None, None),
            VisionStartup::Unavailable => (None, Some(LifecycleState::Interrupted)),
            VisionStartup::Started(vision) => (Some(vision), None),
        };
        let ClientHandle {
            commands,
            mut events,
            login: login_defaults,
        } = client;
        let crate::transcription::VoiceHandle {
            commands: voice_commands,
            events: mut voice_events,
        } = crate::transcription::start();
        let input = cx.new(|cx| InputState::new(window, cx).auto_grow(1, 12).soft_wrap(true));
        let login_focus = cx.focus_handle();
        let microphone_focus = cx.focus_handle();
        let presence_lane = cx.new(|_| PresenceLane::new(Vec::new(), false, reduced_motion));
        let input_subscription = cx.subscribe_in(&input, window, |this, _, event, window, cx| {
            this.on_input(event, window, cx);
        });
        let login = login_defaults.map(LoginFlow::new);
        let login_input_len = login
            .as_ref()
            .map(|login| login.input_value().chars().count())
            .unwrap_or(0);
        let login_input = login
            .as_ref()
            .and_then(|login| new_login_input(login, window, cx));
        let login_subscription = login_input.as_ref().map(|login_input| {
            cx.subscribe_in(login_input, window, |this, _, event, window, cx| {
                this.on_login_input(event, window, cx);
            })
        });
        if let Some(login_input) = &login_input {
            login_input.focus_handle(cx).focus(window);
        } else if login.is_some() {
            login_focus.focus(window);
        } else {
            input.focus_handle(cx).focus(window);
        }
        let event_task = cx.spawn_in(window, async move |this, cx| {
            while let Some(first) = events.recv().await {
                let mut batch = Vec::with_capacity(16);
                batch.push(first);
                while batch.len() < 64 {
                    let Ok(event) = events.try_recv() else {
                        break;
                    };
                    batch.push(event);
                }
                if this
                    .update_in(cx, |this, window, cx| {
                        for event in batch {
                            this.handle_client_event(event, window, cx);
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let (
            prepared_content,
            preparation_requests,
            preparation_results,
            mut prepared_content_events,
        ) = PreparedContentCache::new();
        let preparation_worker = cx.background_spawn(run_preparation_worker(
            preparation_requests,
            preparation_results,
            cx.background_executor().clone(),
        ));
        let preparation_task = cx.spawn(async move |this, cx| {
            while let Some(result) = prepared_content_events.recv().await {
                if this
                    .update(cx, |this, cx| {
                        let acceptance = this.prepared_content.accept(result);
                        let visible = acceptance.as_deref().is_some_and(|accepted_id| {
                            this.interaction.visible_draft().is_none()
                                && this
                                    .conversation
                                    .current()
                                    .is_some_and(|moment| moment.id == accepted_id)
                        });
                        if visible {
                            // The cache keeps the last prepared Markdown snapshot visible while a
                            // newer provider snapshot is pending. A rich-to-rich acceptance is an
                            // in-place document update, not a new plain-to-rich presentation.
                            this.pending_rich_fallback = None;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let (media_preparation_results, mut media_preparation_events) =
            tokio::sync::mpsc::channel::<MediaPreparationResult>(2);
        let media_preparation_task = cx.spawn(async move |this, cx| {
            while let Some(result) = media_preparation_events.recv().await {
                if this
                    .update(cx, |this, cx| {
                        this.media_preparations.remove(&result.request_id);
                        release_assets(this.media_cache.apply_prepared(result.prepared), cx);
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let (attachment_preparation_results, mut attachment_preparation_events) =
            tokio::sync::mpsc::channel::<AttachmentPreparationResult>(2);
        let attachment_preparation_task = cx.spawn_in(window, async move |this, cx| {
            while let Some(result) = attachment_preparation_events.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.attachment_preparations.remove(&result.batch_id);
                        this.apply_prepared_attachments(result.result, window, cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let (media_file_results, mut media_file_events) =
            tokio::sync::mpsc::channel::<MediaFilePreparationResult>(2);
        let media_file_task = cx.spawn_in(window, async move |this, cx| {
            while let Some(result) = media_file_events.recv().await {
                if this
                    .update_in(cx, |this, window, cx| {
                        this.media_file_preparations.remove(&result.request_id);
                        this.apply_materialized_media(result, window, cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let voice_task = cx.spawn_in(window, async move |this, cx| {
            while let Some(first) = voice_events.recv().await {
                let mut batch = Vec::with_capacity(8);
                batch.push(first);
                while batch.len() < 32 {
                    let Ok(event) = voice_events.try_recv() else {
                        break;
                    };
                    batch.push(event);
                }
                let batch = coalesce_for_ui(batch);
                if this
                    .update_in(cx, |this, window, cx| {
                        for event in batch {
                            this.handle_voice_event(event, window, cx);
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let vision_context = vision.as_ref().map(|handle| handle.context.clone());
        let vision_task = vision.map(|mut handle| {
            cx.spawn_in(window, async move |this, cx| {
                while let Some(event) = handle.events.recv().await {
                    if this
                        .update_in(cx, |this, window, cx| {
                            this.handle_vision_event(event, window, cx);
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
        });

        let mut app = Self {
            conversation: if demo {
                Conversation::demo()
            } else {
                Conversation::connecting()
            },
            interaction: CanvasInteraction::new(),
            input,
            login,
            login_input,
            login_input_len,
            login_focus,
            commands,
            audio: TypingAudio::new(sound_enabled),
            terminal_draft: String::new(),
            previous_input: String::new(),
            pid: None,
            client_session_id: None,
            last_history: None,
            last_history_generation: 0,
            history_preparations: HashMap::new(),
            terminal: Vec::new(),
            timeline_scroll: ScrollHandle::new(),
            message_scroll: ScrollHandle::new(),
            message_scroll_moment: None,
            history_scroll_accumulator: 0.0,
            history_scroll_last_event: None,
            history_edge_intent: None,
            history_edge_feedback_epoch: 0,
            presence_lane,
            rich_presentation: None,
            pending_rich_fallback: None,
            next_rich_presentation_epoch: 1,
            rich_layout_wait_scheduled: None,
            rich_steady_wait_scheduled: None,
            timeline_scroll_accumulator: 0.0,
            timeline_scroll_last_event: None,
            stream_type_sizes: HashMap::new(),
            type_layouts: HashMap::new(),
            type_layout_clock: 0,
            prepared_content,
            media_cache: MediaCache::default(),
            media_preparation_results,
            media_preparations: HashMap::new(),
            attachment_store: AttachmentStore::new().ok(),
            draft_attachments: Vec::new(),
            pending_attachments: HashMap::new(),
            next_attachment_batch_id: 1,
            attachment_preparation_results,
            attachment_preparations: HashMap::new(),
            attachment_picker: None,
            media_file_store: MediaFileStore::new().ok(),
            next_media_file_request_id: 1,
            media_file_results,
            media_file_preparations: HashMap::new(),
            media_file_saves: HashMap::new(),
            draft_type_size: None,
            stream_sequences: HashMap::new(),
            type_viewport: None,
            transition_epoch: 0,
            transition_direction: 0.0,
            message_transition_cost: None,
            text_selection: TextSelection::default(),
            reduced_motion,
            programmatic_input: None,
            approval_resume_mode: None,
            desktop_switch_pending: false,
            desktop_switch_source_pid: None,
            voice_commands,
            voice_draft: None,
            voice_notice: None,
            microphone_preference: configured_microphone_preference(),
            microphone_chooser: None,
            microphone_focus,
            pending_microphone_request: None,
            microphone_request_cancellation: None,
            microphone_save_pending: false,
            microphone_save_generation: 0,
            microphone_save_cancellation: None,
            microphone_save_task: None,
            next_voice_request_id: 1,
            vision_context,
            vision_voice_request_id: None,
            vision_lifecycle: initial_vision_lifecycle,
            vision_gesture_status: None,
            vision_gesture_expiry_task: None,
            vision_status_sequence: 0,
            gesture_guide_open: false,
            _input_subscription: input_subscription,
            _login_subscription: login_subscription,
            _event_task: event_task,
            _preparation_worker: preparation_worker,
            _preparation_task: preparation_task,
            _media_preparation_task: media_preparation_task,
            _attachment_preparation_task: attachment_preparation_task,
            _media_file_task: media_file_task,
            _voice_task: voice_task,
            _vision_task: vision_task,
        };
        app.initialize_vision_context();
        app
    }

    fn begin_media_preparation(
        &mut self,
        request_id: u64,
        preparation: MediaPreparation,
        lease: MediaTransferLease,
        cx: &mut Context<Self>,
    ) {
        let results = self.media_preparation_results.clone();
        let task = cx.background_spawn(async move {
            let prepared = preparation.prepare();
            let _ = results
                .send(MediaPreparationResult {
                    request_id,
                    prepared,
                    _lease: lease,
                })
                .await;
        });
        drop(self.media_preparations.insert(request_id, task));
    }

    fn cancel_stale_media_preparations(&mut self) {
        for request_id in self.media_cache.take_cancelled_preparations() {
            self.media_preparations.remove(&request_id);
        }
    }

    fn choose_attachments(
        &mut self,
        _: &AddAttachment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.login.is_some()
            || self.desktop_switch_pending
            || self.microphone_chooser.is_some()
            || self.conversation.mode != SurfaceMode::Conversation
            || self.interaction.is_approval()
            || self.attachment_picker.is_some()
        {
            return;
        }
        let picker = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        self.attachment_picker = Some(cx.spawn_in(window, async move |this, cx| {
            let paths = match picker.await {
                Ok(Ok(Some(paths))) => paths,
                Ok(Ok(None)) => Vec::new(),
                Ok(Err(error)) => {
                    if let Ok(()) = this.update_in(cx, |this, _, cx| {
                        this.attachment_picker = None;
                        this.conversation
                            .show_error(format!("Files could not be selected: {error}"));
                        cx.notify();
                    }) {}
                    return;
                }
                Err(_) => Vec::new(),
            };
            let _ = this.update_in(cx, |this, window, cx| {
                this.attachment_picker = None;
                if !paths.is_empty() {
                    this.prepare_attachment_paths(paths, window, cx);
                }
            });
        }));
    }

    fn prepare_attachment_paths(
        &mut self,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let prospective_count = self.draft_attachments.len().saturating_add(paths.len());
        if prospective_count > crate::attachments::MAX_ATTACHMENTS {
            self.conversation.show_error(
                AttachmentError::TooMany {
                    count: prospective_count,
                    maximum: crate::attachments::MAX_ATTACHMENTS,
                }
                .user_message(),
            );
            cx.notify();
            return;
        }
        let Some(store) = self.attachment_store.as_mut() else {
            self.conversation
                .show_error(AttachmentError::SnapshotUnavailable.user_message());
            cx.notify();
            return;
        };
        let batch = match store.reserve_batch(paths) {
            Ok(batch) => batch,
            Err(error) => {
                self.conversation.show_error(error.user_message());
                cx.notify();
                return;
            }
        };
        let batch_id = self.next_attachment_batch_id;
        self.next_attachment_batch_id = self.next_attachment_batch_id.saturating_add(1).max(1);
        let results = self.attachment_preparation_results.clone();
        let task = cx.background_spawn(async move {
            let result = batch.prepare();
            let _ = results
                .send(AttachmentPreparationResult { batch_id, result })
                .await;
        });
        self.attachment_preparations.insert(batch_id, task);
        self.conversation.activity = Some("PREPARING ATTACHMENTS".to_string());
        self.input.focus_handle(cx).focus(window);
        cx.notify();
    }

    fn apply_prepared_attachments(
        &mut self,
        result: Result<Vec<DraftAttachment>, AttachmentError>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match result {
            Ok(mut attachments) => {
                let current_bytes = self
                    .draft_attachments
                    .iter()
                    .map(|attachment| attachment.size)
                    .sum::<u64>();
                let incoming_bytes = attachments
                    .iter()
                    .map(|attachment| attachment.size)
                    .sum::<u64>();
                if self
                    .draft_attachments
                    .len()
                    .saturating_add(attachments.len())
                    > crate::attachments::MAX_ATTACHMENTS
                    || current_bytes
                        .checked_add(incoming_bytes)
                        .is_none_or(|total| total > crate::attachments::MAX_ATTACHMENT_TOTAL_BYTES)
                {
                    for attachment in attachments {
                        let _ = std::fs::remove_file(attachment.snapshot);
                    }
                    self.conversation
                        .show_error(AttachmentError::TotalTooLarge.user_message());
                    cx.notify();
                    return;
                }
                self.draft_attachments.append(&mut attachments);
                self.interaction.set_conversation_has_attachments(true);
                self.conversation.activity = None;
                self.timeline_scroll
                    .scroll_to_item(self.conversation.moments.len());
                self.input.focus_handle(cx).focus(window);
                self.begin_transition(1.0);
                cx.notify();
            }
            Err(error) => {
                self.conversation.show_error(error.user_message());
                cx.notify();
            }
        }
    }

    fn remove_draft_attachment(
        &mut self,
        attachment_id: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self
            .draft_attachments
            .iter()
            .position(|attachment| attachment.id == attachment_id)
        else {
            return;
        };
        let attachment = self.draft_attachments.remove(index);
        let _ = std::fs::remove_file(attachment.snapshot);
        self.interaction
            .set_conversation_has_attachments(!self.draft_attachments.is_empty());
        self.input.focus_handle(cx).focus(window);
        cx.notify();
    }

    fn materialize_media_file(
        &mut self,
        bytes: Arc<[u8]>,
        mime_type: Option<String>,
        filename: Option<String>,
        action: MediaFileAction,
        lease: MediaTransferLease,
        cx: &mut Context<Self>,
    ) {
        let Some(store) = self.media_file_store.as_mut() else {
            self.conversation
                .show_error("The private media workspace is unavailable.".to_string());
            cx.notify();
            return;
        };
        let materialization = match store.reserve(bytes, filename, mime_type) {
            Ok(materialization) => materialization,
            Err(_) => {
                self.conversation
                    .show_error("That media could not be prepared.".to_string());
                cx.notify();
                return;
            }
        };
        let request_id = self.next_media_file_request_id;
        self.next_media_file_request_id = self.next_media_file_request_id.saturating_add(1).max(1);
        let results = self.media_file_results.clone();
        let task = cx.background_spawn(async move {
            let result = materialization.write();
            let _ = results
                .send(MediaFilePreparationResult {
                    request_id,
                    action,
                    result,
                    _lease: lease,
                })
                .await;
        });
        self.media_file_preparations.insert(request_id, task);
        self.conversation.activity = Some(match action {
            MediaFileAction::Open => "OPENING MEDIA".to_string(),
            MediaFileAction::Save => "PREPARING DOWNLOAD".to_string(),
        });
        cx.notify();
    }

    fn apply_materialized_media(
        &mut self,
        result: MediaFilePreparationResult,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let materialized = match result.result {
            Ok(materialized) => materialized,
            Err(_) => {
                self.conversation
                    .show_error("That media could not be prepared.".to_string());
                cx.notify();
                return;
            }
        };
        self.conversation.activity = None;
        match result.action {
            MediaFileAction::Open => {
                cx.open_with_system(&materialized.path);
                cx.notify();
            }
            MediaFileAction::Save => {
                let directory = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
                let picker = cx.prompt_for_new_path(&directory, Some(&materialized.display_name));
                let save_id = result.request_id;
                self.media_file_saves.insert(
                    save_id,
                    cx.spawn_in(window, async move |this, cx| {
                        let destination = match picker.await {
                            Ok(Ok(Some(destination))) => destination,
                            _ => {
                                let _ = this.update_in(cx, |this, _, _| {
                                    this.media_file_saves.remove(&save_id);
                                });
                                return;
                            }
                        };
                        let source = materialized.path;
                        let copy_destination = destination.clone();
                        let copy = cx.background_spawn(async move {
                            copy_materialized_media(&source, &copy_destination)
                        });
                        let result = copy.await;
                        let _ = this.update_in(cx, |this, _, cx| {
                            this.media_file_saves.remove(&save_id);
                            match result {
                                Ok(()) => cx.reveal_path(&destination),
                                Err(_) => this
                                    .conversation
                                    .show_error("That media could not be saved.".to_string()),
                            }
                            cx.notify();
                        });
                    }),
                );
            }
        }
    }

    fn on_input(&mut self, event: &InputEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            InputEvent::Change => {
                let value = self.input.read(cx).value().to_string();
                if self
                    .programmatic_input
                    .take()
                    .is_some_and(|expected| expected == value)
                {
                    self.previous_input = value;
                    return;
                }
                if self.desktop_switch_pending {
                    self.set_input_value(self.previous_input.clone(), window, cx);
                    return;
                }
                if self
                    .voice_draft
                    .as_ref()
                    .is_some_and(|voice| voice.rendered != value)
                {
                    self.cancel_dictation(false, window, cx);
                }
                self.voice_notice = None;
                if value != self.previous_input {
                    self.text_selection.clear();
                    if value.len() < self.previous_input.len() {
                        self.draft_type_size = None;
                    }
                    self.audio
                        .play(classify_change(&self.previous_input, &value));
                }

                match self.conversation.mode {
                    SurfaceMode::Conversation => {
                        let previous_layer = self.interaction.layer;
                        self.interaction.on_input(value.clone());
                        if previous_layer != self.interaction.layer
                            && self.interaction.layer == CanvasLayer::Draft
                        {
                            self.timeline_scroll
                                .scroll_to_item(self.conversation.moments.len());
                        }
                    }
                    SurfaceMode::Terminal => self.terminal_draft = value.clone(),
                }
                self.previous_input = value;
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {}
            InputEvent::Focus | InputEvent::Blur => {}
        }
    }

    fn on_login_input(&mut self, event: &InputEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(event, InputEvent::Change) {
            return;
        }
        let Some(input) = &self.login_input else {
            return;
        };
        let input_len = input.read(cx).value().chars().count();
        if input_len != self.login_input_len {
            self.audio.play(if input_len < self.login_input_len {
                KeySound::Delete
            } else {
                KeySound::Character
            });
            self.login_input_len = input_len;
        }
        cx.notify();
    }

    fn refresh_login_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._login_subscription = None;
        self.login_input = None;
        self.login_input_len = 0;
        let Some(login) = &self.login else {
            self.input.focus_handle(cx).focus(window);
            return;
        };
        self.login_input_len = login.input_value().chars().count();
        self.login_input = new_login_input(login, window, cx);
        if let Some(input) = &self.login_input {
            self._login_subscription =
                Some(
                    cx.subscribe_in(input, window, |this, _, event, window, cx| {
                        this.on_login_input(event, window, cx);
                    }),
                );
            input.focus_handle(cx).focus(window);
        } else {
            self.login_focus.focus(window);
        }
    }

    fn submit_login(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(login) = &mut self.login else {
            return;
        };
        if login.step() == LoginStep::Connecting {
            return;
        }
        let value = self
            .login_input
            .as_ref()
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_default();
        match login.submit(value) {
            Ok(LoginProgress::Next) => {
                self.audio.play(KeySound::Commit);
                self.begin_transition(1.0);
                self.refresh_login_input(window, cx);
                cx.notify();
            }
            Ok(LoginProgress::Connect(settings)) => {
                let attempt_id = settings.attempt_id;
                self.audio.play(KeySound::Commit);
                self.begin_transition(1.0);
                self.refresh_login_input(window, cx);
                if let Err(error) = self.commands.send(ClientCommand::Connect(settings)) {
                    drop(error);
                    if let Some(login) = &mut self.login {
                        login.fail_connection(
                            attempt_id,
                            LoginStep::Password,
                            "The native client stopped before it could connect.".to_string(),
                        );
                    }
                    self.refresh_login_input(window, cx);
                }
                cx.notify();
            }
            Err(message) => {
                login.set_error(message);
                cx.notify();
            }
        }
    }

    fn back_login(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(login) = &mut self.login else {
            return false;
        };
        if let Some(attempt_id) = login.cancel_connection() {
            let _ = self
                .commands
                .send(ClientCommand::CancelConnect { attempt_id });
            self.begin_transition(-1.0);
            self.refresh_login_input(window, cx);
            cx.notify();
            return true;
        }
        if !login.back() {
            return false;
        }
        self.begin_transition(-1.0);
        self.refresh_login_input(window, cx);
        cx.notify();
        true
    }

    fn show_login_failure(
        &mut self,
        attempt_id: u64,
        defaults: LoginDefaults,
        step: LoginStep,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let accepted = if let Some(login) = &mut self.login {
            login.fail_connection(attempt_id, step, message)
        } else {
            self.login = Some(LoginFlow::from_failure(defaults, step, message));
            true
        };
        if accepted {
            self.begin_transition(-1.0);
            self.refresh_login_input(window, cx);
        }
    }

    fn show_setup_required(
        &mut self,
        attempt_id: u64,
        defaults: LoginDefaults,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let accepted = if let Some(login) = &mut self.login {
            login.require_setup(attempt_id, message)
        } else {
            self.login = Some(LoginFlow::from_failure(
                defaults,
                LoginStep::SetupRequired,
                message,
            ));
            true
        };
        if accepted {
            self.begin_transition(-1.0);
            self.refresh_login_input(window, cx);
        }
    }

    fn show_login_runtime_error(
        &mut self,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(login) = &mut self.login else {
            return false;
        };
        if login.step() == LoginStep::Connecting {
            let defaults = login.defaults();
            self.login = Some(LoginFlow::from_failure(
                defaults,
                LoginStep::Password,
                message,
            ));
            self.refresh_login_input(window, cx);
        } else {
            login.set_error(message);
        }
        true
    }

    fn finish_login(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._login_subscription = None;
        self.login_input = None;
        self.login_input_len = 0;
        self.login = None;
        self.input.focus_handle(cx).focus(window);
        self.begin_transition(1.0);
    }

    fn focus_active_input(&self, window: &mut Window, cx: &mut Context<Self>) {
        if self.microphone_chooser.is_some() {
            self.microphone_focus.focus(window);
        } else if let Some(input) = &self.login_input {
            input.focus_handle(cx).focus(window);
        } else if self.login.is_some() {
            self.login_focus.focus(window);
        } else {
            self.input.focus_handle(cx).focus(window);
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.desktop_switch_pending {
            return;
        }
        if self.microphone_chooser.is_some() {
            self.select_highlighted_microphone(window, cx);
            return;
        }
        if self.login.is_some() {
            self.submit_login(window, cx);
            return;
        }
        if self.voice_draft.is_some() {
            self.finish_dictation(cx);
            return;
        }
        let raw = self.input.read(cx).value().to_string();
        let attachment_only = self.conversation.mode == SurfaceMode::Conversation
            && !self.interaction.is_approval()
            && !self.draft_attachments.is_empty();
        if raw.trim().is_empty() && !attachment_only {
            if !raw.is_empty() {
                match self.conversation.mode {
                    SurfaceMode::Conversation => self.interaction.on_input(String::new()),
                    SurfaceMode::Terminal => self.terminal_draft.clear(),
                }
                self.set_input_value(String::new(), window, cx);
            }
            return;
        }

        match self.conversation.mode {
            SurfaceMode::Terminal => self.submit_terminal(raw, window, cx),
            SurfaceMode::Conversation if self.interaction.is_approval() => {
                self.submit_approval(raw, window, cx);
            }
            SurfaceMode::Conversation => self.submit_conversation(raw, window, cx),
        }
    }

    fn submit_terminal(&mut self, command: String, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .commands
            .send(ClientCommand::Shell(command.clone()))
            .is_err()
        {
            self.terminal.push(TerminalExchange {
                command,
                output: "The native client stopped before this command could run.".to_string(),
                exit_code: None,
                pending: false,
            });
            return;
        }
        self.audio.play(KeySound::Commit);
        self.terminal.push(TerminalExchange {
            command,
            output: String::new(),
            exit_code: None,
            pending: true,
        });
        self.terminal_draft.clear();
        self.set_input_value(String::new(), window, cx);
    }

    fn submit_approval(&mut self, message: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.interaction.layer == CanvasLayer::ApprovalPrompt
            && !self.interaction.approval_draft().is_empty()
        {
            self.interaction.on_input(message);
            cx.notify();
            return;
        }
        let Some(approval) = self.conversation.pending_approval.clone() else {
            return;
        };
        if self.interaction.is_approval_submitting() {
            self.conversation.activity = Some("APPLYING".to_string());
            cx.notify();
            return;
        }
        let Some(decision) = approval_decision(&message) else {
            self.conversation.activity = Some("TYPE ALLOW ONCE, ALWAYS ALLOW, OR DENY".to_string());
            cx.notify();
            return;
        };

        self.apply_approval_decision(approval.request_id, message, decision, window, cx);
    }

    fn apply_approval_decision(
        &mut self,
        expected_request_id: String,
        message: String,
        decision: ApprovalDecision,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(approval) = self.conversation.pending_approval.clone() else {
            return;
        };
        if approval.request_id != expected_request_id {
            return;
        }
        if self.interaction.is_approval_submitting() {
            self.conversation.activity = Some("APPLYING".to_string());
            cx.notify();
            return;
        }

        let request_id = expected_request_id;
        if !self
            .interaction
            .begin_approval_submission(request_id.clone(), message.clone())
        {
            return;
        }
        if self
            .commands
            .send(ClientCommand::Decide {
                request_id: request_id.clone(),
                decision,
            })
            .is_err()
        {
            self.handle_approval_failure(
                &request_id,
                "The native client stopped before that decision could be applied.".to_string(),
                window,
                cx,
            );
            cx.notify();
            return;
        }
        self.audio.play(KeySound::Commit);
        self.conversation.activity = Some("APPLYING".to_string());
        self.set_input_value(String::new(), window, cx);
        cx.notify();
    }

    fn submit_conversation(
        &mut self,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.interaction.layer == CanvasLayer::Moment {
            self.interaction.show_conversation_draft();
            cx.notify();
            return;
        }
        if self.interaction.is_submitting() {
            self.conversation.activity = Some("SENDING PREVIOUS THOUGHT".to_string());
            cx.notify();
            return;
        }

        let attachments = std::mem::take(&mut self.draft_attachments);
        let optimistic_media = attachments
            .iter()
            .map(draft_attachment_media)
            .collect::<Vec<_>>();
        let attachment_ids = attachments
            .iter()
            .map(|attachment| attachment.id)
            .collect::<Vec<_>>();
        let outgoing = attachments
            .iter()
            .map(|attachment| OutgoingAttachment {
                media_id: attachment.media_id.clone(),
                snapshot: attachment.snapshot.clone(),
                kind: attachment.kind,
                mime_type: attachment.mime_type.clone(),
                filename: attachment.filename.clone(),
                size: attachment.size,
            })
            .collect::<Vec<_>>();
        let moment_id = self
            .conversation
            .append_user_with_media(message.clone(), optimistic_media);
        let Some(submission_id) = self.interaction.begin_submission_with_attachments(
            message.clone(),
            moment_id.clone(),
            attachment_ids,
        ) else {
            self.draft_attachments = attachments;
            self.interaction.set_conversation_has_attachments(true);
            self.conversation.remove_moment(&moment_id);
            return;
        };
        self.pending_attachments.insert(submission_id, attachments);

        self.conversation.activity = Some("SENDING".to_string());
        self.begin_transition(1.0);
        self.timeline_scroll
            .scroll_to_item(self.conversation.selected);
        self.set_input_value(String::new(), window, cx);
        if self
            .commands
            .send(ClientCommand::Send {
                submission_id,
                message,
                attachments: outgoing,
            })
            .is_err()
        {
            self.handle_submission_failure(
                submission_id,
                "The native client stopped before that thought could be sent.".to_string(),
                window,
                cx,
            );
        } else {
            self.audio.play(KeySound::Commit);
        }
    }

    fn handle_submission_failure(
        &mut self,
        submission_id: u64,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(failure) = self.interaction.submission_failed(submission_id) else {
            return;
        };
        match failure {
            SubmissionFailure::RestoreDraft {
                moment_id,
                text,
                attachment_ids,
            } => {
                self.conversation.remove_moment(&moment_id);
                if let Some(attachments) = self.pending_attachments.remove(&submission_id) {
                    let restored = attachments
                        .into_iter()
                        .filter(|attachment| attachment_ids.contains(&attachment.id));
                    self.draft_attachments.extend(restored);
                    self.interaction
                        .set_conversation_has_attachments(!self.draft_attachments.is_empty());
                }
                if !self.interaction.is_approval() {
                    self.set_input_value(text, window, cx);
                }
            }
            SubmissionFailure::PreserveFailedMoment { moment_id } => {
                self.cleanup_pending_attachment_snapshots(submission_id);
                self.conversation.fail_user(&moment_id);
            }
        }
        self.reconcile_dictation_after_submission_failure(cx);
        self.conversation.show_error(message);
    }

    fn cleanup_pending_attachment_snapshots(&mut self, submission_id: u64) {
        if let Some(attachments) = self.pending_attachments.remove(&submission_id) {
            for attachment in attachments {
                let _ = std::fs::remove_file(attachment.snapshot);
            }
        }
    }

    fn set_input_value(&mut self, value: String, window: &mut Window, cx: &mut Context<Self>) {
        let cursor = value.len();
        self.set_input_value_at(value, cursor, window, cx);
    }

    fn set_input_value_at(
        &mut self,
        value: String,
        cursor: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.draft_type_size = None;
        self.previous_input = value.clone();
        self.programmatic_input = Some(value.clone());
        let cursor = cursor.min(value.len());
        let cursor = value.floor_char_boundary(cursor);
        let prefix = &value[..cursor];
        let line = prefix
            .chars()
            .filter(|character| *character == '\n')
            .count() as u32;
        let column = prefix
            .rsplit('\n')
            .next()
            .unwrap_or_default()
            .chars()
            .count() as u32;
        self.input.update(cx, |input, cx| {
            input.set_value(value, window, cx);
            input.set_cursor_position(
                gpui_component::input::Position::new(line, column),
                window,
                cx,
            );
        });
        self.input.focus_handle(cx).focus(window);
    }

    fn reveal_voice_draft_if_needed(
        &mut self,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if value.is_empty() || self.interaction.layer != CanvasLayer::Moment {
            return;
        }
        self.interaction.on_input(value.to_string());
        self.timeline_scroll
            .scroll_to_item(self.conversation.moments.len());
        self.begin_transition(1.0);
        self.input.focus_handle(cx).focus(window);
    }

    fn hide_draft(&mut self, _: &HideDraft, window: &mut Window, cx: &mut Context<Self>) {
        if self.close_gesture_guide(cx) {
            return;
        }
        if self.close_microphone_chooser(window, cx) {
            return;
        }
        if self.login.is_some() {
            self.back_login(window, cx);
            return;
        }
        if self.voice_draft.is_some() {
            self.cancel_dictation(true, window, cx);
        }
        if self.conversation.mode == SurfaceMode::Conversation && self.interaction.hide_draft() {
            self.input
                .update(cx, |input, cx| input.unselect(window, cx));
            self.begin_transition(0.0);
            cx.notify();
        }
    }

    fn submit_thought_action(
        &mut self,
        _: &SubmitThought,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.microphone_chooser.is_some() {
            return;
        }
        let modifiers = window.modifiers();
        if modifiers.shift || modifiers.secondary() {
            return;
        }
        self.submit(window, cx);
    }

    fn insert_newline_action(
        &mut self,
        _: &InsertNewline,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.login.is_some() {
            cx.stop_propagation();
            return;
        }
        self.input
            .update(cx, |input, cx| input.insert("\n", window, cx));
    }

    fn abort_run(&mut self, _: &AbortRun, _: &mut Window, _: &mut Context<Self>) {
        if self.login.is_some() {
            return;
        }
        if let Some(run_id) = self.conversation.request_abort() {
            if self
                .commands
                .send(ClientCommand::Abort {
                    run_id: run_id.clone(),
                })
                .is_err()
            {
                self.conversation.abort_failed(&run_id);
            }
        }
    }

    fn copy_selection(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let Some(selected) = self.text_selection.selected_text() else {
            cx.propagate();
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(selected));
        cx.stop_propagation();
    }

    fn toggle_terminal_action(
        &mut self,
        _: &ToggleTerminal,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_terminal(window, cx);
    }

    fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.login.is_some() || self.desktop_switch_pending || self.microphone_chooser.is_some()
        {
            return;
        }
        if self.voice_draft.is_some() {
            self.cancel_dictation(true, window, cx);
        }
        let next = match self.conversation.mode {
            SurfaceMode::Conversation => {
                self.conversation.mode = SurfaceMode::Terminal;
                self.terminal_draft.clone()
            }
            SurfaceMode::Terminal => {
                self.terminal_draft = self.input.read(cx).value().to_string();
                self.conversation.mode = SurfaceMode::Conversation;
                if self.interaction.is_approval() {
                    self.interaction.approval_draft().to_string()
                } else {
                    self.interaction.conversation_draft().to_string()
                }
            }
        };
        self.begin_transition(0.0);
        self.set_input_value(next, window, cx);
        cx.notify();
    }

    fn previous_moment(&mut self, _: &PreviousMoment, window: &mut Window, cx: &mut Context<Self>) {
        self.move_moment(-1, window, cx);
    }

    fn next_moment(&mut self, _: &NextMoment, window: &mut Window, cx: &mut Context<Self>) {
        self.move_moment(1, window, cx);
    }

    fn move_moment(&mut self, direction: i8, window: &mut Window, cx: &mut Context<Self>) {
        if self.login.is_some()
            || self.microphone_chooser.is_some()
            || self.conversation.mode != SurfaceMode::Conversation
            || self.interaction.is_approval()
        {
            return;
        }
        self.interaction.hide_draft();
        self.input
            .update(cx, |input, cx| input.unselect(window, cx));
        let previous = self.conversation.selected;
        if direction < 0 {
            self.conversation.select_previous();
        } else {
            self.conversation.select_next();
        }
        if previous != self.conversation.selected {
            self.audio.play(KeySound::Navigate);
            self.timeline_scroll
                .scroll_to_item(self.conversation.selected);
            self.begin_transition(if direction < 0 { -1.0 } else { 1.0 });
            cx.notify();
        }
    }

    fn select_moment(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.login.is_some()
            || self.microphone_chooser.is_some()
            || self.interaction.is_approval()
            || self.conversation.moments.is_empty()
        {
            return;
        }
        self.interaction.hide_draft();
        self.input
            .update(cx, |input, cx| input.unselect(window, cx));
        let previous = self.conversation.selected;
        self.conversation.select(index);
        self.timeline_scroll
            .scroll_to_item(self.conversation.selected);
        if previous != self.conversation.selected {
            self.audio.play(KeySound::Navigate);
            self.begin_transition(if index < previous { -1.0 } else { 1.0 });
        }
        cx.notify();
    }

    fn show_held_draft(&mut self, cx: &mut Context<Self>) {
        if self.login.is_some()
            || self.microphone_chooser.is_some()
            || self.interaction.is_approval()
        {
            return;
        }
        self.interaction.show_conversation_draft();
        self.timeline_scroll
            .scroll_to_item(self.conversation.moments.len());
        self.begin_transition(1.0);
        cx.notify();
    }

    fn begin_transition(&mut self, direction: f32) {
        self.text_selection.clear();
        self.history_scroll_accumulator = 0.0;
        self.history_scroll_last_event = None;
        self.history_edge_intent = None;
        self.history_edge_feedback_epoch = self.history_edge_feedback_epoch.wrapping_add(1);
        self.transition_epoch = self.transition_epoch.wrapping_add(1);
        self.transition_direction = direction;
        self.message_transition_cost = None;
    }
}

impl Drop for GsvApp {
    fn drop(&mut self) {
        let _ = self.commands.send(ClientCommand::Shutdown);
        let _ = self.voice_commands.send(VoiceCommand::Shutdown);
    }
}

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("secondary-enter", InsertNewline, Some("Input")),
        KeyBinding::new("shift-enter", InsertNewline, Some("Input")),
        KeyBinding::new("enter", SubmitThought, Some("Input")),
        KeyBinding::new("escape", HideDraft, None),
        KeyBinding::new("secondary-.", AbortRun, None),
        KeyBinding::new("secondary-shift-space", ToggleDictation, None),
        KeyBinding::new("secondary-shift-g", ToggleGestureGuide, None),
        KeyBinding::new("secondary-shift-m", ChooseMicrophone, None),
        KeyBinding::new("up", PreviousMicrophone, Some("MicrophoneChooser")),
        KeyBinding::new("down", NextMicrophone, Some("MicrophoneChooser")),
        KeyBinding::new("enter", SelectMicrophone, Some("MicrophoneChooser")),
        KeyBinding::new("secondary-shift-a", AddAttachment, None),
        KeyBinding::new("secondary-`", ToggleTerminal, None),
        KeyBinding::new("alt-up", PreviousMoment, None),
        KeyBinding::new("alt-down", NextMoment, None),
    ]);
}

fn draft_attachment_media(attachment: &DraftAttachment) -> MediaAttachment {
    MediaAttachment {
        kind: attachment.kind,
        mime_type: attachment.mime_type.clone(),
        key: None,
        path: None,
        url: None,
        filename: Some(attachment.filename.clone()),
        size: Some(attachment.size),
        duration: None,
        transcription: None,
        description: None,
    }
}

fn copy_materialized_media(source: &Path, destination: &Path) -> io::Result<()> {
    replace_destination_atomically(destination, |staged| {
        let mut source = std::fs::File::open(source)?;
        io::copy(&mut source, staged)?;
        Ok(())
    })
}

fn replace_destination_atomically(
    destination: &Path,
    write: impl FnOnce(&mut std::fs::File) -> io::Result<()>,
) -> io::Result<()> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut staged = tempfile::Builder::new()
        .prefix(".gsv-save-")
        .tempfile_in(parent)?;

    write(staged.as_file_mut())?;
    staged.as_file_mut().flush()?;
    staged.as_file().sync_all()?;
    // Keep the destination unopened until the staged bytes are durable. `persist`
    // atomically replaces an existing file where the platform supports it, and
    // returns ownership of the staging file so its drop removes it on failure.
    staged
        .persist(destination)
        .map(|_| ())
        .map_err(|error| error.error)
}

fn classify_change(previous: &str, next: &str) -> KeySound {
    let prefix = previous
        .char_indices()
        .zip(next.char_indices())
        .take_while(|((_, left), (_, right))| left == right)
        .last()
        .map_or(0, |((offset, character), _)| offset + character.len_utf8());
    let previous_tail = &previous[prefix..];
    let next_tail = &next[prefix..];
    let common_suffix = previous_tail
        .chars()
        .rev()
        .zip(next_tail.chars().rev())
        .take_while(|(left, right)| left == right)
        .map(|(character, _)| character.len_utf8())
        .sum::<usize>()
        .min(previous_tail.len())
        .min(next_tail.len());
    let inserted_end = next.len().saturating_sub(common_suffix);
    let inserted = &next[prefix..inserted_end];

    if inserted.is_empty() {
        KeySound::Delete
    } else {
        match inserted.chars().last() {
            Some(' ' | '\t') => KeySound::Space,
            Some('\n' | '\r') => KeySound::Commit,
            _ => KeySound::Character,
        }
    }
}

fn approval_decision(input: &str) -> Option<ApprovalDecision> {
    let normalized = input.trim().to_ascii_lowercase().replace(['.', ','], "");
    match normalized.as_str() {
        "allow" | "allow once" | "approve" | "approve once" | "yes" => {
            Some(ApprovalDecision::Approve { remember: false })
        }
        "always" | "always allow" | "approve always" => {
            Some(ApprovalDecision::Approve { remember: true })
        }
        "deny" | "no" | "reject" => Some(ApprovalDecision::Deny),
        _ => None,
    }
}

fn compose_voice_text(before: &str, transcript: &str, after: &str) -> VoiceComposition {
    let transcript = transcript.trim();
    let leading_space =
        needs_voice_boundary_space(before.chars().next_back(), transcript.chars().next());
    let trailing_space =
        needs_voice_boundary_space(transcript.chars().next_back(), after.chars().next());
    let mut value = String::with_capacity(
        before.len()
            + transcript.len()
            + after.len()
            + usize::from(leading_space)
            + usize::from(trailing_space),
    );
    value.push_str(before);
    if leading_space {
        value.push(' ');
    }
    value.push_str(transcript);
    let cursor = value.len();
    if trailing_space {
        value.push(' ');
    }
    value.push_str(after);
    VoiceComposition { value, cursor }
}

fn needs_voice_boundary_space(left: Option<char>, right: Option<char>) -> bool {
    let (Some(left), Some(right)) = (left, right) else {
        return false;
    };
    if left.is_whitespace()
        || right.is_whitespace()
        || is_unspaced_script(left)
        || is_unspaced_script(right)
        || matches!(
            right,
            '.' | ',' | '!' | '?' | ';' | ':' | '%' | ')' | ']' | '}' | '>' | '’' | '”'
        )
        || matches!(
            left,
            '(' | '[' | '{' | '<' | '‘' | '“' | '/' | '\\' | '-' | '–' | '—' | '_'
        )
    {
        return false;
    }
    let left_accepts_space = left.is_alphanumeric()
        || matches!(
            left,
            '.' | ',' | '!' | '?' | ';' | ':' | '%' | ')' | ']' | '}' | '>' | '’' | '”'
        );
    let right_accepts_space =
        right.is_alphanumeric() || matches!(right, '(' | '[' | '{' | '<' | '‘' | '“');
    left_accepts_space && right_accepts_space
}

fn is_unspaced_script(character: char) -> bool {
    matches!(
        character as u32,
        0x0E00..=0x0E7F
            | 0x1100..=0x11FF
            | 0x2E80..=0x2FFF
            | 0x3040..=0x30FF
            | 0x3130..=0x318F
            | 0x31A0..=0x31BF
            | 0x31F0..=0x31FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA960..=0xA97F
            | 0xAC00..=0xD7AF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2FA1F
    )
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{TestAppContext, WindowOptions};
    use gpui_component::Root;

    use super::*;

    #[test]
    fn approvals_are_deliberately_narrow_language() {
        assert!(matches!(
            approval_decision("allow once"),
            Some(ApprovalDecision::Approve { remember: false })
        ));
        assert!(matches!(
            approval_decision("always allow"),
            Some(ApprovalDecision::Approve { remember: true })
        ));
        assert!(matches!(
            approval_decision("deny"),
            Some(ApprovalDecision::Deny)
        ));
        assert!(approval_decision("do whatever seems right").is_none());
    }

    #[test]
    fn edit_sounds_follow_the_changed_range() {
        assert_eq!(classify_change("ac", "a c"), KeySound::Space);
        assert_eq!(classify_change("a c", "ac"), KeySound::Delete);
        assert_eq!(classify_change("tail", "t中ail"), KeySound::Character);
        assert_eq!(classify_change("one", "one\ntwo"), KeySound::Character);
        assert_eq!(classify_change("one", "one\n"), KeySound::Commit);
    }

    #[test]
    fn voice_insertion_adds_only_semantic_boundary_spaces() {
        assert_eq!(
            compose_voice_text("Ask", "GSV", "tomorrow."),
            VoiceComposition {
                value: "Ask GSV tomorrow.".to_string(),
                cursor: "Ask GSV".len(),
            }
        );
        assert_eq!(
            compose_voice_text("Say ", " hello ", ", please"),
            VoiceComposition {
                value: "Say hello, please".to_string(),
                cursor: "Say hello".len(),
            }
        );
        assert_eq!(compose_voice_text("(", "hello", ")").value, "(hello)");
        assert_eq!(compose_voice_text("你好", "世界", "！").value, "你好世界！");
    }

    #[test]
    fn voice_insertion_caret_is_a_unicode_byte_boundary() {
        let composition = compose_voice_text("🙂 café", "encore", "!");
        assert_eq!(composition.value, "🙂 café encore!");
        assert_eq!(&composition.value[..composition.cursor], "🙂 café encore");
        assert!(composition.value.is_char_boundary(composition.cursor));
    }

    #[test]
    fn media_save_atomically_replaces_an_existing_destination() {
        let directory = tempfile::tempdir().expect("create save directory");
        let source = directory.path().join("materialized.bin");
        let destination = directory.path().join("saved.bin");
        std::fs::write(&source, b"new media").expect("write source");
        std::fs::write(&destination, b"previous media").expect("write destination");

        copy_materialized_media(&source, &destination).expect("save media");

        assert_eq!(
            std::fs::read(&destination).expect("read saved media"),
            b"new media"
        );
    }

    #[test]
    fn failed_media_copy_preserves_the_destination_and_cleans_the_staging_file() {
        let directory = tempfile::tempdir().expect("create save directory");
        let destination = directory.path().join("saved.bin");
        std::fs::write(&destination, b"previous media").expect("write destination");

        let result = replace_destination_atomically(&destination, |staged| {
            staged.write_all(b"partial replacement")?;
            Err(io::Error::other("simulated copy failure"))
        });

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(&destination).expect("read preserved media"),
            b"previous media"
        );
        let mut names = std::fs::read_dir(directory.path())
            .expect("read save directory")
            .map(|entry| entry.expect("read directory entry").file_name())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, vec![std::ffi::OsString::from("saved.bin")]);
    }

    #[test]
    fn failed_media_replace_cleans_the_staging_file_after_a_persist_error() {
        let directory = tempfile::tempdir().expect("create save directory");
        let destination = directory.path().join("existing-directory");
        std::fs::create_dir(&destination).expect("create conflicting destination");

        let result =
            replace_destination_atomically(&destination, |staged| staged.write_all(b"replacement"));

        assert!(result.is_err());
        assert!(destination.is_dir());
        let mut names = std::fs::read_dir(directory.path())
            .expect("read save directory")
            .map(|entry| entry.expect("read directory entry").file_name())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, vec![std::ffi::OsString::from("existing-directory")]);
    }

    #[gpui::test]
    fn typing_from_a_moment_enters_the_visible_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "hello");

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.interaction.layer, CanvasLayer::Draft);
            assert_eq!(app.interaction.visible_draft(), Some("hello"));
        });
    }

    #[gpui::test]
    fn password_login_is_isolated_and_dropped_when_connecting(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: Some(crate::startup::LoginDefaults {
                url: Some("ws://localhost:8788/ws".to_string()),
                username: Some("hank".to_string()),
            }),
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, false, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), " exact password ");
        cx.simulate_keystrokes(window.into(), "shift-enter");
        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Password)
            );
            assert_eq!(
                app.login_input
                    .as_ref()
                    .map(|input| input.read(cx).value().to_string())
                    .as_deref(),
                Some(" exact password ")
            );
            assert!(app.previous_input.is_empty());
            assert_eq!(app.interaction.layer, CanvasLayer::Moment);
        });
        cx.simulate_keystrokes(window.into(), "ctrl-enter");
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Password)
            );
        });

        cx.simulate_keystrokes(window.into(), "enter");
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Connecting)
            );
            assert!(app.login_input.is_none());
        });
        let received = command_rx
            .try_recv()
            .ok()
            .and_then(|command| match command {
                ClientCommand::Connect(settings) => match settings.credential {
                    crate::startup::Credential::Password(password) => {
                        Some((settings.attempt_id, password))
                    }
                    crate::startup::Credential::Token(_) => None,
                },
                _ => None,
            });
        assert_eq!(
            received.as_ref().map(|(_, password)| password.as_str()),
            Some(" exact password ")
        );
        let attempt_id = received.map(|(attempt_id, _)| attempt_id).unwrap_or(0);

        cx.simulate_keystrokes(window.into(), "escape");
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Password)
            );
            assert!(app.login_input.is_some());
        });
        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::CancelConnect { attempt_id: cancelled })
                if cancelled == attempt_id
        ));

        let _ = event_tx.send(crate::client::ClientEvent::Connected {
            attempt_id,
            session_id: 9,
            pid: "stale-login".to_string(),
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(
                app.login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Password)
            );
            assert!(app.client_session_id.is_none());
        });

        let _ = event_tx.send(crate::client::ClientEvent::SetupRequired {
            attempt_id: 0,
            defaults: crate::startup::LoginDefaults {
                url: Some("ws://localhost:8788/ws".to_string()),
                username: Some("hank".to_string()),
            },
            message: "Setup is incomplete.".to_string(),
        });
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).login.as_ref().map(LoginFlow::step),
                Some(LoginStep::SetupRequired)
            );
        });
        cx.simulate_keystrokes(window.into(), "enter");
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).login.as_ref().map(LoginFlow::step),
                Some(LoginStep::Url)
            );
        });
    }

    #[gpui::test]
    fn submit_shortcut_is_non_mutating_and_requires_a_visible_held_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "exact thought");
        cx.simulate_keystrokes(window.into(), "escape enter");
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.interaction.layer, CanvasLayer::Draft);
            assert_eq!(app.input.read(cx).value().as_ref(), "exact thought");
        });
        assert!(command_rx.try_recv().is_err());

        cx.simulate_keystrokes(window.into(), "enter");
        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::Send { message, .. }) if message == "exact thought"
        ));
    }

    #[gpui::test]
    fn modified_enter_adds_newlines_and_plain_enter_submits(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "first");
        cx.simulate_keystrokes(window.into(), "ctrl-enter");
        cx.simulate_input(window.into(), "second");
        cx.simulate_keystrokes(window.into(), "shift-enter");
        cx.simulate_input(window.into(), "third");

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            assert_eq!(
                app.read(cx).input.read(cx).value().as_ref(),
                "first\nsecond\nthird"
            );
        });
        assert!(command_rx.try_recv().is_err());

        cx.simulate_keystrokes(window.into(), "enter");
        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::Send { message, .. }) if message == "first\nsecond\nthird"
        ));
    }

    #[gpui::test]
    fn mode_round_trip_keeps_a_hidden_draft_hidden(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "unfinished");
        cx.simulate_keystrokes(window.into(), "escape ctrl-` ctrl-`");
        cx.run_until_parked();

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.interaction.layer, CanvasLayer::Moment);
            assert_eq!(app.interaction.conversation_draft(), "unfinished");
            assert_eq!(app.input.read(cx).value().as_ref(), "unfinished");
        });
    }

    #[gpui::test]
    fn mode_round_trip_restores_a_trailing_newline_caret_at_the_end(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "tail");
        cx.simulate_keystrokes(window.into(), "ctrl-enter escape ctrl-` ctrl-`");
        cx.run_until_parked();
        cx.simulate_input(window.into(), "next");

        let app = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            assert_eq!(app.read(cx).input.read(cx).value().as_ref(), "tail\nnext");
        });
    }

    #[gpui::test]
    fn approval_takeover_restores_the_terminal_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_keystrokes(window.into(), "ctrl-`");
        cx.simulate_input(window.into(), "status --watch");
        let _ = event_tx.send(crate::client::ClientEvent::Connected {
            attempt_id: 0,
            session_id: 7,
            pid: "pid-1".to_string(),
        });
        let _ = event_tx.send(crate::client::ClientEvent::Signal {
            session_id: 7,
            name: "proc.run.hil.requested".to_string(),
            payload: serde_json::json!({
                "pid": "pid-1",
                "runId": "run-1",
                "requestId": "request-1",
                "toolName": "Shell",
                "syscall": "shell.exec",
                "target": "gsv",
                "args": { "input": "deploy" }
            }),
        });
        cx.run_until_parked();

        let app_entity = app.borrow().clone().expect("app entity should be retained");
        cx.update(|cx| {
            let app = app_entity.read(cx);
            assert_eq!(app.conversation.mode, SurfaceMode::Conversation);
            assert!(app.interaction.is_approval());
            assert_eq!(app.terminal_draft, "status --watch");
        });

        let _ = event_tx.send(crate::client::ClientEvent::History {
            session_id: 7,
            history: crate::client::PreparedHistory {
                generation: 1,
                snapshot: std::sync::Arc::new(crate::history::normalize_history(
                    &serde_json::json!({ "messages": [] }),
                )),
            },
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let app = app_entity.read(cx);
            assert_eq!(app.conversation.mode, SurfaceMode::Terminal);
            assert_eq!(app.input.read(cx).value().as_ref(), "status --watch");
        });
    }
}
