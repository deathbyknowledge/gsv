use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use desktop_native::transcription::{
    self, VoiceCommand, VoiceCommandSender, VoiceErrorCode, VoiceEvent, VoicePhase,
};
use desktop_native::vision_debug::{self, VisionEvent, VisionHandle};
use gesture_protocol::{
    ControlStatus, GestureCandidate, GestureContext, GestureIntent, GestureProgress,
    LifecycleState, PracticeGesture, ScrollState, VoiceRequestGestureIntent,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinError, JoinHandle, JoinSet};
use uuid::Uuid;

mod practice;
use practice::{GesturePractice, PracticeTarget, RejectionReason};

const LEASE_TIMEOUT: Duration = Duration::from_secs(3);
const INTENT_MAX_AGE: Duration = Duration::from_millis(500);
const SCROLL_MAX_AGE: Duration = Duration::from_millis(250);
const STATUS_MAX_AGE: Duration = Duration::from_secs(1);
const ACTION_FEEDBACK_AGE: Duration = Duration::from_secs(3);
const MAX_EVENTS: usize = 16;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SegmentAction {
    Send,
    Delete,
    Clear,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputCommand {
    Start {
        device_id: Option<String>,
    },
    Stop {
        request_id: u64,
    },
    Cancel,
    Segment {
        request_id: u64,
        segment_id: u64,
        action: SegmentAction,
    },
    Devices,
    Gestures {
        enabled: bool,
    },
    Practice {
        expected: PracticeTarget,
    },
    Detach,
}

#[derive(Clone, Serialize, PartialEq)]
pub struct VoiceState {
    pub request_id: u64,
    pub segment_id: u64,
    pub revision: i32,
    pub text: String,
    pub phase: String,
    pub progress: Option<f32>,
    pub muted: Option<bool>,
    pub pending: Option<SegmentAction>,
    #[serde(skip)]
    mute_revision: Option<u64>,
}

#[derive(Clone, Serialize, PartialEq)]
pub struct Device {
    id: String,
    name: String,
    is_default: bool,
}

#[derive(Clone, Serialize, PartialEq)]
pub struct InputEvent {
    pub id: u64,
    pub request_id: u64,
    pub segment_id: u64,
    pub kind: &'static str,
    pub action: Option<SegmentAction>,
    pub text: String,
}

#[derive(Clone, Serialize, PartialEq)]
pub struct Snapshot {
    pub lease: String,
    pub voice: Option<VoiceState>,
    pub gestures_enabled: bool,
    pub gesture_status: String,
    pub gesture_context: GestureContext,
    pub gesture_progress: Option<GestureProgress>,
    pub gesture_action: Option<GestureCandidate>,
    pub gesture_action_sequence: u64,
    pub gesture_needs_reset: bool,
    pub gesture_reset_after_action: u64,
    pub gesture_practice: Option<GesturePractice>,
    pub scroll_velocity: i16,
    pub scroll_sequence: u64,
    pub devices: Vec<Device>,
    pub devices_loading: bool,
    pub devices_revision: u64,
    pub notice: Option<String>,
    pub events: Vec<InputEvent>,
}

#[derive(Clone, Serialize)]
pub struct InputUpdate {
    revision: u64,
    sent_at_ms: u64,
    scroll_age_ms: u64,
    snapshot: Snapshot,
}

struct Delivery {
    channel: Channel<InputUpdate>,
    sent: Snapshot,
    revision: u64,
    acknowledged: u64,
    event_ack: u64,
    sent_at: Instant,
}

enum Request {
    Attach {
        updates: Channel<InputUpdate>,
        practice: bool,
        reply: oneshot::Sender<Result<Snapshot, String>>,
    },
    Acknowledge {
        lease: String,
        revision: u64,
        ack: u64,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Command {
        lease: String,
        command: InputCommand,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Reset(oneshot::Sender<()>),
    Shutdown(oneshot::Sender<()>),
}

pub struct InputRuntime {
    sender: mpsc::Sender<Request>,
}

impl InputRuntime {
    pub fn start() -> Self {
        let (sender, receiver) = mpsc::channel(16);
        tauri::async_runtime::spawn(run(receiver));
        Self { sender }
    }

    pub async fn attach(
        &self,
        updates: Channel<InputUpdate>,
        practice: bool,
    ) -> Result<Snapshot, String> {
        let (reply, received) = oneshot::channel();
        self.sender
            .send(Request::Attach {
                updates,
                practice,
                reply,
            })
            .await
            .map_err(|_| "Native input is closed.")?;
        received.await.map_err(|_| "Native input is closed.")?
    }

    pub async fn acknowledge(&self, lease: String, revision: u64, ack: u64) -> Result<(), String> {
        let (reply, received) = oneshot::channel();
        self.sender
            .send(Request::Acknowledge {
                lease,
                revision,
                ack,
                reply,
            })
            .await
            .map_err(|_| "Native input is closed.")?;
        received.await.map_err(|_| "Native input is closed.")?
    }

    pub async fn command(&self, lease: String, command: InputCommand) -> Result<(), String> {
        let (reply, received) = oneshot::channel();
        self.sender
            .send(Request::Command {
                lease,
                command,
                reply,
            })
            .await
            .map_err(|_| "Native input is closed.")?;
        received.await.map_err(|_| "Native input is closed.")?
    }

    pub async fn reset(&self) {
        let (reply, received) = oneshot::channel();
        if self.sender.send(Request::Reset(reply)).await.is_ok() {
            let _ = received.await;
        }
    }

    pub async fn shutdown(&self) {
        let (reply, received) = oneshot::channel();
        if self.sender.send(Request::Shutdown(reply)).await.is_ok() {
            let _ = received.await;
        }
    }
}

type VisionLaunch = Result<Option<VisionHandle>, String>;

struct VisionStartup {
    cancelled: Arc<AtomicBool>,
    task: JoinHandle<VisionLaunch>,
}

struct State {
    snapshot: Snapshot,
    voice_commands: VoiceCommandSender,
    last_seen: Instant,
    last_seen_wall: SystemTime,
    scroll_at: Instant,
    next_id: u64,
    events: VecDeque<(Instant, InputEvent)>,
    vision: Option<VisionHandle>,
    vision_start: Option<VisionStartup>,
    vision_stops: JoinSet<()>,
    intent_sequence: u64,
    scroll_sequence: u64,
    status_sequence: u64,
    reset_sequence: u64,
    gesture_progress: Option<(Instant, GestureContext, GestureProgress)>,
    gesture_action: Option<(Instant, GestureCandidate)>,
    device_request: Option<u64>,
    selected_device: Option<String>,
    delivery: Option<Delivery>,
}

impl State {
    fn new(voice_commands: VoiceCommandSender) -> Self {
        Self {
            snapshot: Snapshot {
                lease: String::new(),
                voice: None,
                gestures_enabled: false,
                gesture_status: "off".into(),
                gesture_context: GestureContext::Disarmed,
                gesture_progress: None,
                gesture_action: None,
                gesture_action_sequence: 0,
                gesture_needs_reset: false,
                gesture_reset_after_action: 0,
                gesture_practice: None,
                scroll_velocity: 0,
                scroll_sequence: 0,
                devices: Vec::new(),
                devices_loading: false,
                devices_revision: 0,
                notice: None,
                events: Vec::new(),
            },
            voice_commands,
            last_seen: Instant::now(),
            last_seen_wall: SystemTime::now(),
            scroll_at: Instant::now(),
            next_id: 0,
            events: VecDeque::new(),
            vision: None,
            vision_start: None,
            vision_stops: JoinSet::new(),
            intent_sequence: 0,
            scroll_sequence: 0,
            status_sequence: 0,
            reset_sequence: 0,
            gesture_progress: None,
            gesture_action: None,
            device_request: None,
            selected_device: None,
            delivery: None,
        }
    }

    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn fresh(&self, lease: &str) -> bool {
        !lease.is_empty()
            && self.snapshot.lease == lease
            && self.last_seen.elapsed() <= LEASE_TIMEOUT
            && self
                .last_seen_wall
                .elapsed()
                .is_ok_and(|elapsed| elapsed <= LEASE_TIMEOUT)
    }

    fn cancel_voice(&mut self) {
        if let Some(voice) = self.snapshot.voice.take() {
            let _ = self.voice_commands.send(VoiceCommand::Cancel {
                request_id: voice.request_id,
            });
        }
        self.events.clear();
        self.snapshot.scroll_velocity = 0;
        self.sync_context();
    }

    fn reset(&mut self) {
        self.delivery = None;
        self.snapshot.lease.clear();
        self.disable_hands_free();
        self.snapshot.gesture_practice = None;
        self.gesture_action = None;
        self.device_request = None;
    }

    fn disable_hands_free(&mut self) {
        // Revoke capture and queued actions together. Already displayed draft text stays in the view.
        self.snapshot.gestures_enabled = false;
        self.snapshot.gesture_status = "off".into();
        self.snapshot.gesture_needs_reset = false;
        self.snapshot.gesture_reset_after_action = 0;
        self.cancel_voice();
        self.stop_vision();
        self.gesture_progress = None;
    }

    fn stop_vision(&mut self) {
        if let Some(vision) = self.vision.take() {
            let _ = vision.context.set_context(GestureContext::Disarmed);
            self.vision_stops.spawn_blocking(move || drop(vision));
        }
        if let Some(startup) = self.vision_start.take() {
            startup.cancelled.store(true, Ordering::Release);
            self.vision_stops.spawn(async move {
                if let Ok(result) = startup.task.await {
                    let _ = tokio::task::spawn_blocking(move || drop(result)).await;
                }
            });
        }
    }

    fn start_vision(&mut self, launch: impl FnOnce() -> VisionLaunch + Send + 'static) {
        self.stop_vision();
        self.snapshot.scroll_velocity = 0;
        self.snapshot.gestures_enabled = true;
        self.snapshot.gesture_status = "starting".into();
        self.snapshot.notice = None;
        self.gesture_progress = None;
        self.gesture_action = None;
        self.intent_sequence = 0;
        self.scroll_sequence = 0;
        self.status_sequence = 0;
        self.reset_sequence = 0;
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let mut stopping = std::mem::take(&mut self.vision_stops);
        let task = tokio::spawn(async move {
            // Serialize capture ownership while acknowledgements and cancellation stay available.
            while stopping.join_next().await.is_some() {}
            tokio::task::spawn_blocking(move || {
                if worker_cancelled.load(Ordering::Acquire) {
                    return Ok(None);
                }
                let result = launch();
                if worker_cancelled.load(Ordering::Acquire) {
                    drop(result);
                    return Ok(None);
                }
                result
            })
            .await
            .map_err(|_| "Gesture helper could not start.")?
        });
        self.vision_start = Some(VisionStartup { cancelled, task });
    }

    fn vision_started(&mut self, result: Result<VisionLaunch, JoinError>) {
        self.vision_start = None;
        self.watchdog();
        let result = result.unwrap_or_else(|_| Err("Gesture helper could not start.".into()));
        if !self.snapshot.gestures_enabled || !self.fresh(&self.snapshot.lease) {
            self.vision_stops.spawn_blocking(move || drop(result));
            return;
        }
        match result {
            Ok(Some(vision)) => self.vision = Some(vision),
            Ok(None) => {
                self.snapshot.gestures_enabled = false;
                self.snapshot.gesture_status = "disabled".into();
            }
            Err(error) => {
                self.snapshot.gestures_enabled = false;
                self.snapshot.gesture_status = "worker_unavailable".into();
                self.snapshot.notice = Some(error);
            }
        }
        self.sync_context();
    }

    fn context(&self) -> GestureContext {
        if !self.snapshot.gestures_enabled || self.snapshot.gesture_status != "ready" {
            return GestureContext::Disarmed;
        }
        if !self.events.is_empty() {
            return GestureContext::Disabled;
        }
        match &self.snapshot.voice {
            None => GestureContext::Standby,
            Some(voice) if voice.phase == "listening" && voice.pending.is_none() => {
                match voice.muted {
                    Some(muted) => GestureContext::Active {
                        voice_request_id: voice.request_id,
                        muted,
                    },
                    None => GestureContext::Disabled,
                }
            }
            Some(_) => GestureContext::Disabled,
        }
    }

    fn helper_context(&self) -> GestureContext {
        if self.snapshot.gestures_enabled && self.snapshot.gesture_status == "ready" {
            if let Some(practice) = &self.snapshot.gesture_practice {
                return GestureContext::Practice {
                    lesson_id: practice.lesson_id,
                };
            }
        }
        self.context()
    }

    fn sync_context(&mut self) {
        let voice_request_id = self.snapshot.voice.as_ref().map(|voice| voice.request_id);
        if self
            .snapshot
            .gesture_practice
            .as_ref()
            .is_some_and(|practice| practice.voice_request_id != voice_request_id)
        {
            let lesson_id = self.id();
            if let Some(practice) = &mut self.snapshot.gesture_practice {
                practice.lesson_id = lesson_id;
                practice.voice_request_id = voice_request_id;
            }
        }
        let context = self.helper_context();
        if self
            .gesture_progress
            .is_some_and(|(_, owner, _)| owner != context)
        {
            self.gesture_progress = None;
        }
        if let Some(vision) = &self.vision {
            let _ = vision.context.set_context(context);
        }
    }

    fn event(&mut self, mut event: InputEvent) {
        if self.events.len() >= MAX_EVENTS || event.text.len() > 128 * 1024 {
            self.disable_hands_free();
            self.snapshot.notice =
                Some("Native input stopped because the view could not keep up.".into());
            return;
        }
        event.id = self.id();
        self.events.push_back((Instant::now(), event));
    }

    fn snapshot(&self) -> Snapshot {
        let context = self.context();
        let helper_context = self.helper_context();
        let gesture_progress = self.gesture_progress.and_then(|(at, owner, progress)| {
            (self.snapshot.gesture_status == "ready"
                && self.fresh(&self.snapshot.lease)
                && owner == helper_context
                && at.elapsed() <= STATUS_MAX_AGE
                && progress.is_compatible_with(helper_context))
            .then_some(progress)
        });
        Snapshot {
            gesture_context: context,
            gesture_progress,
            gesture_action: self
                .gesture_action
                .and_then(|(at, action)| (at.elapsed() <= ACTION_FEEDBACK_AGE).then_some(action)),
            events: self.events.iter().map(|(_, event)| event.clone()).collect(),
            devices_loading: self.device_request.is_some(),
            scroll_sequence: if self.snapshot.scroll_velocity != 0 {
                self.scroll_sequence
            } else {
                0
            },
            ..self.snapshot.clone()
        }
    }

    fn attach(&mut self, channel: Channel<InputUpdate>, practice: bool) -> Snapshot {
        self.reset();
        if practice {
            let lesson_id = self.id();
            self.snapshot.gesture_practice = Some(GesturePractice::new(lesson_id));
        }
        self.snapshot.lease = Uuid::new_v4().to_string();
        self.last_seen = Instant::now();
        self.last_seen_wall = SystemTime::now();
        let initial = self.snapshot();
        self.delivery = Some(Delivery {
            channel,
            sent: initial.clone(),
            revision: 0,
            acknowledged: 0,
            event_ack: 0,
            sent_at: Instant::now(),
        });
        initial
    }

    fn acknowledge(&mut self, lease: &str, revision: u64, ack: u64) -> Result<(), String> {
        self.watchdog();
        if !self.fresh(lease) {
            return Err("Native input session ended. Reconnect input to continue.".into());
        }
        let delivery = self
            .delivery
            .as_mut()
            .ok_or("Native input is disconnected.")?;
        let event_limit = if revision == delivery.revision {
            delivery
                .sent
                .events
                .last()
                .map_or(delivery.event_ack, |event| event.id)
        } else {
            delivery.event_ack
        };
        if revision > delivery.revision || ack > event_limit {
            return Err("Native input acknowledgement is ahead of delivery.".into());
        }
        delivery.acknowledged = delivery.acknowledged.max(revision);
        delivery.event_ack = delivery.event_ack.max(ack);
        delivery.sent.events.retain(|event| event.id > ack);
        self.last_seen = Instant::now();
        self.last_seen_wall = SystemTime::now();
        while self
            .events
            .front()
            .is_some_and(|(_, event)| event.id <= ack)
        {
            self.events.pop_front();
        }
        self.sync_context();
        Ok(())
    }

    fn publish(&mut self) {
        let Some(delivery) = &self.delivery else {
            return;
        };
        // One unacknowledged frame bounds IPC while replace-latest state coalesces here.
        if delivery.revision != delivery.acknowledged {
            return;
        }
        let next = self.snapshot();
        if next == delivery.sent {
            return;
        }
        let delivery = self.delivery.as_mut().unwrap();
        delivery.revision += 1;
        delivery.sent = next.clone();
        delivery.sent_at = Instant::now();
        let update = InputUpdate {
            revision: delivery.revision,
            sent_at_ms: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            scroll_age_ms: self.scroll_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            snapshot: next,
        };
        if delivery.channel.send(update).is_err() {
            self.reset();
        }
    }

    fn start_voice(&mut self, device_id: Option<String>) -> Result<(), String> {
        if self.snapshot.voice.is_some() || self.device_request.is_some() || !self.events.is_empty()
        {
            return Err("Native input is busy.".into());
        }
        if device_id
            .as_ref()
            .is_some_and(|id| !self.snapshot.devices.iter().any(|d| &d.id == id))
        {
            return Err("Select an available microphone.".into());
        }
        self.selected_device = device_id.clone();
        let request_id = self.id();
        self.voice_commands
            .send(VoiceCommand::Start {
                request_id,
                locale: "auto".into(),
                device: None,
                exact_device: device_id.is_some(),
                device_id,
            })
            .map_err(|_| "Voice helper is unavailable.")?;
        self.snapshot.voice = Some(VoiceState {
            request_id,
            segment_id: 0,
            revision: -1,
            text: String::new(),
            phase: "preparing".into(),
            progress: None,
            muted: None,
            mute_revision: None,
            pending: None,
        });
        self.snapshot.notice = None;
        self.event(InputEvent {
            id: 0,
            request_id,
            segment_id: 0,
            kind: "started",
            action: None,
            text: String::new(),
        });
        Ok(())
    }

    fn segment(
        &mut self,
        request_id: u64,
        segment_id: u64,
        action: SegmentAction,
    ) -> Result<(), String> {
        let voice = self
            .snapshot
            .voice
            .as_mut()
            .filter(|v| v.request_id == request_id && v.segment_id == segment_id)
            .ok_or("This dictation has ended.")?;
        if voice.phase != "listening" || voice.pending.is_some() || !self.events.is_empty() {
            return Err("Wait for the current voice operation.".into());
        }
        self.voice_commands
            .send(VoiceCommand::CommitSegment {
                request_id,
                segment_id,
            })
            .map_err(|_| "Voice helper is unavailable.")?;
        voice.pending = Some(action);
        Ok(())
    }

    fn stop(&mut self, request_id: u64) -> Result<(), String> {
        let voice = self
            .snapshot
            .voice
            .as_mut()
            .filter(|v| v.request_id == request_id)
            .ok_or("This dictation has ended.")?;
        if voice.pending.is_some() || !self.events.is_empty() {
            return Err("Wait for the voice segment.".into());
        }
        self.voice_commands
            .send(VoiceCommand::Stop { request_id })
            .map_err(|_| "Voice helper is unavailable.")?;
        voice.phase = "finishing".into();
        Ok(())
    }

    fn command(&mut self, command: InputCommand) -> Result<(), String> {
        match command {
            InputCommand::Start { device_id } => self.start_voice(device_id)?,
            InputCommand::Stop { request_id } => self.stop(request_id)?,
            InputCommand::Cancel => self.cancel_voice(),
            InputCommand::Segment {
                request_id,
                segment_id,
                action,
            } => self.segment(request_id, segment_id, action)?,
            InputCommand::Devices => {
                if self.snapshot.voice.is_some() || self.device_request.is_some() {
                    return Err("Stop dictation before choosing a microphone.".into());
                }
                let request_id = self.id();
                self.voice_commands
                    .send(VoiceCommand::ListDevices { request_id })
                    .map_err(|_| "Voice helper is unavailable.")?;
                self.device_request = Some(request_id);
                self.snapshot.notice = None;
            }
            InputCommand::Gestures { enabled } => {
                if !enabled {
                    self.disable_hands_free();
                    self.gesture_action = None;
                    return Ok(());
                }
                if self.snapshot.gestures_enabled
                    && matches!(self.snapshot.gesture_status.as_str(), "ready" | "starting")
                {
                    return Ok(());
                }
                self.start_vision(|| {
                    vision_debug::start_for_desktop().map_err(|error| error.to_string())
                });
            }
            InputCommand::Practice { expected } => {
                let lesson_id = self.id();
                self.snapshot
                    .gesture_practice
                    .as_mut()
                    .ok_or("Gesture practice is not open.")?
                    .select(lesson_id, expected);
                self.snapshot.scroll_velocity = 0;
                self.gesture_progress = None;
            }
            InputCommand::Detach => self.reset(),
        }
        self.sync_context();
        Ok(())
    }

    fn voice_event(&mut self, event: VoiceEvent) {
        match event {
            VoiceEvent::Devices {
                request_id,
                devices,
            } if self.device_request == Some(request_id) => {
                self.device_request = None;
                self.snapshot.devices_revision += 1;
                self.snapshot.devices = devices
                    .into_iter()
                    .map(|d| Device {
                        id: d.id,
                        name: d.name,
                        is_default: d.is_default,
                    })
                    .collect();
            }
            VoiceEvent::Error { request_id, code } => {
                if request_id.is_none() || request_id == self.device_request {
                    if self.device_request.is_some() {
                        self.snapshot.devices_revision += 1;
                    }
                    self.device_request = None;
                    self.snapshot.notice = Some(voice_error_message(code, None).into());
                }
                if request_id.is_none()
                    || self
                        .snapshot
                        .voice
                        .as_ref()
                        .is_some_and(|v| Some(v.request_id) == request_id)
                {
                    let phase = self
                        .snapshot
                        .voice
                        .as_ref()
                        .map(|voice| voice.phase.as_str());
                    let message = voice_error_message(code, phase);
                    eprintln!(
                        "voice input failed: code={code:?}, phase={}",
                        phase.unwrap_or("idle")
                    );
                    self.cancel_voice();
                    self.snapshot.notice = Some(format!(
                        "{message} Your unsent text is still in the prompt."
                    ));
                }
            }
            VoiceEvent::State {
                request_id,
                phase,
                progress,
            } => {
                if let Some(v) = self
                    .snapshot
                    .voice
                    .as_mut()
                    .filter(|v| v.request_id == request_id)
                {
                    if v.phase != "finishing" {
                        v.phase = match phase {
                            VoicePhase::Downloading => "downloading",
                            VoicePhase::Verifying => "verifying",
                            VoicePhase::Loading => "loading",
                            VoicePhase::Listening => "listening",
                            VoicePhase::Finishing => "finishing",
                        }
                        .into();
                    }
                    v.progress = progress;
                }
            }
            VoiceEvent::Partial {
                request_id,
                segment_id,
                revision,
                committed,
                tentative,
            } => {
                if let Some(v) = self.snapshot.voice.as_mut().filter(|v| {
                    v.request_id == request_id
                        && v.segment_id == segment_id
                        && revision > v.revision
                }) {
                    v.text = format!("{committed}{tentative}");
                    v.revision = revision;
                    if v.phase != "finishing" {
                        v.phase = "listening".into();
                    }
                }
            }
            VoiceEvent::MuteState {
                request_id,
                revision,
                muted,
            } => {
                if let Some(v) = self
                    .snapshot
                    .voice
                    .as_mut()
                    .filter(|v| v.request_id == request_id)
                {
                    if v.mute_revision.is_none_or(|r| revision > r) {
                        if muted {
                            self.cancel_voice();
                            self.snapshot.notice = Some(
                                "Microphone paused. Start listening again to continue.".into(),
                            );
                        } else {
                            v.mute_revision = Some(revision);
                            v.muted = Some(false);
                        }
                    }
                }
            }
            VoiceEvent::SegmentFinal {
                request_id,
                segment_id,
                text,
            } => {
                if let Some(v) = self
                    .snapshot
                    .voice
                    .as_mut()
                    .filter(|v| v.request_id == request_id && v.segment_id == segment_id)
                {
                    if let Some(action) = v.pending.take() {
                        v.segment_id += 1;
                        v.revision = -1;
                        v.text.clear();
                        self.event(InputEvent {
                            id: 0,
                            request_id,
                            segment_id,
                            kind: "segment",
                            action: Some(action),
                            text,
                        });
                    }
                }
            }
            VoiceEvent::Final { request_id, text } => {
                if self
                    .snapshot
                    .voice
                    .as_ref()
                    .is_some_and(|v| v.request_id == request_id)
                {
                    if let Some(v) = self.snapshot.voice.take() {
                        self.event(InputEvent {
                            id: 0,
                            request_id,
                            segment_id: v.segment_id,
                            kind: "final",
                            action: None,
                            text,
                        });
                    }
                }
            }
            VoiceEvent::Cancelled { request_id }
                if self
                    .snapshot
                    .voice
                    .as_ref()
                    .is_some_and(|v| v.request_id == request_id) =>
            {
                self.cancel_voice();
            }
            _ => {}
        }
        self.sync_context();
    }

    fn vision_event(&mut self, event: VisionEvent) {
        match event {
            VisionEvent::Lifecycle(state) => {
                self.snapshot.gesture_status = match state {
                    LifecycleState::Ready => "ready",
                    LifecycleState::Stopped => "stopped",
                    LifecycleState::AssetsUnavailable => "assets_unavailable",
                    LifecycleState::CameraUnavailable => "camera_unavailable",
                    LifecycleState::CameraStopped => "camera_stopped",
                    LifecycleState::InferenceUnavailable => "inference_unavailable",
                    LifecycleState::WindowUnavailable => "window_unavailable",
                    LifecycleState::WorkerUnavailable => "worker_unavailable",
                    LifecycleState::ProtocolError => "protocol_error",
                    LifecycleState::Interrupted => "interrupted",
                }
                .into();
                self.gesture_progress = None;
                if state != LifecycleState::Ready {
                    self.snapshot.gesture_needs_reset = false;
                    self.cancel_voice();
                    self.snapshot.scroll_velocity = 0;
                    self.gesture_action = None;
                }
            }
            VisionEvent::Intent {
                sequence,
                received_at,
                intent,
            } => {
                if sequence <= self.intent_sequence {
                    return;
                }
                self.intent_sequence = sequence;
                if let GestureIntent::Practice { lesson_id, gesture } = intent {
                    if received_at.elapsed() <= INTENT_MAX_AGE
                        && self.fresh(&self.snapshot.lease)
                        && self.helper_context() == (GestureContext::Practice { lesson_id })
                    {
                        self.practice_gesture(gesture);
                    }
                    self.sync_context();
                    if let Some(vision) = &self.vision {
                        let _ = vision.context.reassert_context(self.helper_context());
                    }
                    return;
                }
                if self.snapshot.gesture_practice.is_some()
                    && intent != (GestureIntent::SetArmed { armed: false })
                {
                    return;
                }
                let action = match intent {
                    GestureIntent::SetArmed { armed: true } => GestureCandidate::Arm,
                    GestureIntent::SetArmed { armed: false } => GestureCandidate::Disarm,
                    GestureIntent::StartTranscription => GestureCandidate::StartTranscription,
                    GestureIntent::VoiceRequest { action, .. } => match action {
                        VoiceRequestGestureIntent::StopTranscription => {
                            GestureCandidate::StopTranscription
                        }
                        VoiceRequestGestureIntent::Send => GestureCandidate::Send,
                        VoiceRequestGestureIntent::DeleteBackward => {
                            GestureCandidate::DeleteBackward
                        }
                        VoiceRequestGestureIntent::ClearDictation => {
                            GestureCandidate::ClearDictation
                        }
                        VoiceRequestGestureIntent::Mute => GestureCandidate::Mute,
                        VoiceRequestGestureIntent::Unmute => GestureCandidate::Unmute,
                    },
                    GestureIntent::Practice { .. } => return,
                };
                let result = if received_at.elapsed() > INTENT_MAX_AGE
                    || !self.fresh(&self.snapshot.lease)
                    || self.snapshot.gesture_status != "ready"
                {
                    None
                } else {
                    match intent {
                        GestureIntent::SetArmed { armed: false } => {
                            self.disable_hands_free();
                            Some(Ok(()))
                        }
                        GestureIntent::StartTranscription
                            if self.context() == GestureContext::Standby =>
                        {
                            Some(self.start_voice(self.selected_device.clone()))
                        }
                        GestureIntent::VoiceRequest {
                            voice_request_id,
                            action,
                        } if matches!(self.context(), GestureContext::Active { voice_request_id: id, .. } if id == voice_request_id) => {
                            Some(match action {
                                VoiceRequestGestureIntent::StopTranscription => {
                                    self.stop(voice_request_id)
                                }
                                VoiceRequestGestureIntent::Mute
                                | VoiceRequestGestureIntent::Unmute => return,
                                action => {
                                    let segment_id =
                                        self.snapshot.voice.as_ref().map_or(0, |v| v.segment_id);
                                    let action = match action {
                                        VoiceRequestGestureIntent::Send => SegmentAction::Send,
                                        VoiceRequestGestureIntent::DeleteBackward => {
                                            SegmentAction::Delete
                                        }
                                        _ => SegmentAction::Clear,
                                    };
                                    self.segment(voice_request_id, segment_id, action)
                                }
                            })
                        }
                        _ => None,
                    }
                };
                if let Some(result) = result {
                    self.gesture_progress = None;
                    if let Err(error) = result {
                        self.snapshot.notice = Some(error);
                    } else {
                        self.gesture_action = Some((Instant::now(), action));
                        self.snapshot.gesture_action_sequence += 1;
                        self.snapshot.gesture_needs_reset =
                            !matches!(action, GestureCandidate::Disarm);
                    }
                }
                if let Some(vision) = &self.vision {
                    let _ = vision.context.reassert_context(self.helper_context());
                }
            }
            VisionEvent::Scroll {
                sequence,
                received_at,
                state,
            } => {
                if sequence <= self.scroll_sequence {
                    return;
                }
                self.scroll_sequence = sequence;
                self.scroll_at = received_at;
                let fresh = received_at.elapsed() <= SCROLL_MAX_AGE
                    && self.fresh(&self.snapshot.lease)
                    && self.snapshot.gesture_status == "ready";
                let practice_allows_scroll = if let Some(practice) =
                    &mut self.snapshot.gesture_practice
                {
                    let allowed = practice.expected == PracticeTarget::Scroll;
                    if fresh && !allowed {
                        if let ScrollState::Active {
                            instance_id,
                            velocity_milliunits,
                        } = state
                        {
                            if velocity_milliunits != 0 && instance_id != practice.scroll_instance {
                                practice.scroll_instance = instance_id;
                                practice
                                    .reject(PracticeGesture::Scroll, RejectionReason::WrongGesture);
                            }
                        }
                    }
                    allowed && fresh
                } else {
                    true
                };
                self.snapshot.scroll_velocity = if matches!(
                    self.context(),
                    GestureContext::Standby | GestureContext::Active { .. }
                ) && received_at.elapsed() <= SCROLL_MAX_AGE
                    && practice_allows_scroll
                {
                    match state {
                        ScrollState::Active {
                            velocity_milliunits,
                            ..
                        } => velocity_milliunits,
                        ScrollState::Idle => 0,
                    }
                } else {
                    0
                };
            }
            VisionEvent::Status {
                sequence,
                received_at,
                status,
                reset_sequence,
            } => {
                if sequence <= self.status_sequence {
                    return;
                }
                self.status_sequence = sequence;
                let (context, progress) = match status {
                    ControlStatus::Disarmed { progress } => (GestureContext::Disarmed, progress),
                    ControlStatus::Disabled { progress } => (GestureContext::Disabled, progress),
                    ControlStatus::Standby { progress } => (GestureContext::Standby, progress),
                    ControlStatus::Practice {
                        lesson_id,
                        progress,
                    } => (GestureContext::Practice { lesson_id }, progress),
                    ControlStatus::Active {
                        voice_request_id,
                        muted,
                        progress,
                    } => (
                        GestureContext::Active {
                            voice_request_id,
                            muted,
                        },
                        progress,
                    ),
                };
                if context == self.helper_context() {
                    let fresh = self.snapshot.gesture_status == "ready"
                        && self.fresh(&self.snapshot.lease)
                        && received_at.elapsed() <= STATUS_MAX_AGE;
                    if fresh && reset_sequence > self.reset_sequence {
                        self.reset_sequence = reset_sequence;
                        if sequence > self.intent_sequence && self.snapshot.gesture_needs_reset {
                            self.snapshot.gesture_needs_reset = false;
                            self.snapshot.gesture_reset_after_action =
                                self.snapshot.gesture_action_sequence;
                        }
                    }
                    self.gesture_progress = progress
                        .filter(|progress| progress.is_compatible_with(context))
                        .filter(|_| fresh)
                        .map(|progress| (received_at, context, progress));
                }
            }
        }
        self.sync_context();
    }

    fn watchdog(&mut self) {
        if self.scroll_at.elapsed() > SCROLL_MAX_AGE
            || matches!(
                self.context(),
                GestureContext::Disabled | GestureContext::Disarmed
            )
        {
            self.snapshot.scroll_velocity = 0;
        }
        if (!self.snapshot.lease.is_empty() && !self.fresh(&self.snapshot.lease))
            || self.delivery.as_ref().is_some_and(|delivery| {
                delivery.revision != delivery.acknowledged
                    && delivery.sent_at.elapsed() > LEASE_TIMEOUT
            })
            || self
                .events
                .front()
                .is_some_and(|(at, _)| at.elapsed() > LEASE_TIMEOUT)
        {
            self.reset();
            self.snapshot.notice = Some(
                "Native input paused while the view was unavailable. Start it again when ready."
                    .into(),
            );
        }
    }
}

async fn run(requests: mpsc::Receiver<Request>) {
    let voice = transcription::start();
    let state = State::new(voice.commands.clone());
    run_requests(requests, state, voice.events).await;
}

async fn run_requests(
    mut requests: mpsc::Receiver<Request>,
    mut state: State,
    mut voice_events: mpsc::Receiver<VoiceEvent>,
) {
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            request = requests.recv() => match request {
                Some(Request::Attach { updates, practice, reply }) => {
                    let initial = state.attach(updates, practice);
                    if reply.send(Ok(initial)).is_err() { state.reset(); }
                }
                Some(Request::Acknowledge { lease, revision, ack, reply }) => {
                    let result = state.acknowledge(&lease, revision, ack);
                    let _ = reply.send(result);
                }
                Some(Request::Command { lease, command, reply }) => {
                    state.watchdog();
                    let result = if state.fresh(&lease) { state.command(command) }
                        else { Err("Native input session ended.".into()) };
                    let _ = reply.send(result);
                }
                Some(Request::Reset(reply)) => { state.reset(); let _ = reply.send(()); }
                Some(Request::Shutdown(reply)) => {
                    state.reset();
                    let _ = state.voice_commands.send(VoiceCommand::Shutdown);
                    while state.vision_stops.join_next().await.is_some() {}
                    // Wait for the supervisor's terminal channel close before exiting the host.
                    while voice_events.recv().await.is_some() {}
                    let _ = reply.send(());
                    break;
                }
                None => break,
            },
            event = voice_events.recv() => if let Some(event) = event { state.watchdog(); state.voice_event(event); } else { break; },
            result = async {
                match &mut state.vision_start {
                    Some(startup) => (&mut startup.task).await,
                    None => std::future::pending().await,
                }
            } => state.vision_started(result),
            _ = state.vision_stops.join_next(), if !state.vision_stops.is_empty() => {},
            event = async {
                match &mut state.vision {
                    Some(vision) => vision.events.recv().await,
                    None => std::future::pending().await,
                }
            } => if let Some(event) = event { state.vision_event(event); } else {
                state.stop_vision();
                state.snapshot.gestures_enabled = false;
                state.cancel_voice();
                state.snapshot.scroll_velocity = 0;
                state.gesture_progress = None;
                state.gesture_action = None;
                if matches!(state.snapshot.gesture_status.as_str(), "ready" | "starting") {
                    state.snapshot.gesture_status = "interrupted".into();
                }
            },
            _ = tick.tick() => state.watchdog(),
        }
        state.publish();
    }
    state.reset();
    let _ = state.voice_commands.send(VoiceCommand::Shutdown);
    while state.vision_stops.join_next().await.is_some() {}
}

fn voice_error_message(code: VoiceErrorCode, phase: Option<&str>) -> &'static str {
    match code {
        VoiceErrorCode::NotInstalled => "The voice helper is missing from this build.",
        VoiceErrorCode::HelperUnavailable => "The voice helper could not start. Try voice again.",
        VoiceErrorCode::MicrophoneUnavailable => {
            "The microphone could not open. Choose an available microphone."
        }
        VoiceErrorCode::MicrophoneSilent => {
            "No microphone audio arrived. Check the selected input and its mute setting."
        }
        VoiceErrorCode::AudioOverflow => "Voice input could not keep up. Try voice again.",
        VoiceErrorCode::DownloadFailed => {
            "The speech model could not download. Check your connection and try again."
        }
        VoiceErrorCode::ModelInvalid => {
            "The speech model could not load. Try voice again to verify it."
        }
        VoiceErrorCode::EngineFailed if matches!(phase, Some("listening" | "finishing")) => {
            "The speech engine stopped during transcription. Try voice again."
        }
        VoiceErrorCode::EngineFailed => "The speech engine could not start. Try voice again.",
        VoiceErrorCode::Busy => "Voice input is busy. Try again when it is ready.",
        VoiceErrorCode::NotActive => "Voice input has already stopped.",
        VoiceErrorCode::Interrupted => "Voice input was interrupted. Try voice again.",
        VoiceErrorCode::InvalidCommand => {
            "The voice helper could not accept this action. Restart voice to continue."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn updates() -> (Channel<InputUpdate>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let received = messages.clone();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON input update")
            };
            received
                .lock()
                .unwrap()
                .push(serde_json::from_str(&json).unwrap());
            Ok(())
        });
        (channel, messages)
    }

    fn attached() -> (State, std::sync::mpsc::Receiver<VoiceCommand>) {
        let (commands, receiver) = VoiceCommandSender::channel_for_test();
        let mut state = State::new(commands);
        state.snapshot.lease = "view-one".into();
        (state, receiver)
    }

    #[tokio::test]
    async fn slow_gesture_start_keeps_requests_live_and_cannot_cross_a_replaced_lease() {
        let (mut state, commands) = attached();
        let (channel, _) = updates();
        let initial = state.attach(channel, false);
        let vision = VisionHandle::for_test();
        let context = vision.context.clone();
        let (started, starting) = oneshot::channel();
        let (release, waiting) = std::sync::mpsc::channel();
        state.start_vision(move || {
            let _ = started.send(());
            let _ = waiting.recv();
            Ok(Some(vision))
        });
        let (sender, requests) = mpsc::channel(16);
        let (_voice_sender, voice_events) = mpsc::channel(1);
        let runtime = InputRuntime { sender };
        let task = tokio::spawn(run_requests(requests, state, voice_events));
        let deadline = Duration::from_secs(1);
        tokio::time::timeout(deadline, starting)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(deadline, async {
            runtime
                .acknowledge(initial.lease.clone(), 0, 0)
                .await
                .unwrap();
            runtime
                .command(
                    initial.lease.clone(),
                    InputCommand::Start { device_id: None },
                )
                .await
                .unwrap();
            runtime
                .command(initial.lease.clone(), InputCommand::Cancel)
                .await
                .unwrap();
            runtime
                .command(
                    initial.lease.clone(),
                    InputCommand::Gestures { enabled: false },
                )
                .await
                .unwrap();
            runtime
                .command(initial.lease.clone(), InputCommand::Detach)
                .await
                .unwrap();
        })
        .await
        .unwrap();
        assert!(matches!(
            commands.try_recv(),
            Ok(VoiceCommand::Start { .. })
        ));
        assert!(matches!(
            commands.try_recv(),
            Ok(VoiceCommand::Cancel { .. })
        ));
        let (channel, delivered) = updates();
        let replacement = tokio::time::timeout(deadline, runtime.attach(channel, false))
            .await
            .unwrap()
            .unwrap();
        assert_ne!(initial.lease, replacement.lease);
        release.send(()).unwrap();
        tokio::time::timeout(deadline, async {
            while context.set_context(GestureContext::Disarmed).is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        runtime.acknowledge(replacement.lease, 0, 0).await.unwrap();
        assert!(delivered
            .lock()
            .unwrap()
            .iter()
            .all(|update| { update["snapshot"]["gestures_enabled"] == false }));
        drop(runtime);
        tokio::time::timeout(deadline, task).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancelling_a_queued_restart_does_not_launch_another_helper() {
        let (mut state, _commands) = attached();
        let (started, starting) = oneshot::channel();
        let (release, waiting) = std::sync::mpsc::channel();
        state.start_vision(move || {
            let _ = started.send(());
            let _ = waiting.recv();
            Ok(None)
        });
        starting.await.unwrap();
        state.disable_hands_free();
        let relaunched = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&relaunched);
        state.start_vision(move || {
            observed.store(true, Ordering::Release);
            Ok(None)
        });
        state.disable_hands_free();
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.vision_stops.join_next().await.is_some() {}
        })
        .await
        .unwrap();
        assert!(!relaunched.load(Ordering::Acquire));
        assert!(!state.snapshot.gestures_enabled);
        assert_eq!(state.snapshot.gesture_status, "off");
    }

    #[tokio::test]
    async fn asynchronous_gesture_start_failure_is_reported_to_the_current_view() {
        let (mut state, _commands) = attached();
        state.start_vision(|| Err("Gesture helper could not start.".into()));
        assert_eq!(state.snapshot.gesture_status, "starting");
        let result = (&mut state.vision_start.as_mut().unwrap().task).await;
        state.vision_started(result);
        assert!(!state.snapshot.gestures_enabled);
        assert_eq!(state.snapshot.gesture_status, "worker_unavailable");
        assert_eq!(
            state.snapshot.notice.as_deref(),
            Some("Gesture helper could not start.")
        );
    }

    #[test]
    fn push_delivery_coalesces_partials_until_acknowledged() {
        let (mut state, _commands) = attached();
        let (channel, messages) = updates();
        let initial = state.attach(channel, false);
        state.publish();
        assert!(messages.lock().unwrap().is_empty());
        state.start_voice(None).unwrap();
        let started = state.events.front().unwrap().1.clone();
        state.publish();
        for (revision, text) in [(1, "first"), (2, "latest")] {
            state.voice_event(VoiceEvent::Partial {
                request_id: started.request_id,
                segment_id: 0,
                revision,
                committed: text.into(),
                tentative: String::new(),
            });
            state.publish();
        }
        assert_eq!(messages.lock().unwrap().len(), 1);
        state.acknowledge(&initial.lease, 1, started.id).unwrap();
        state.publish();
        let received = messages.lock().unwrap();
        assert_eq!(received.len(), 2);
        assert_eq!(received[1]["snapshot"]["voice"]["text"], "latest");
        assert_eq!(received[1]["revision"], 2);
        drop(received);
        state.acknowledge(&initial.lease, 2, started.id).unwrap();
        state.publish();
        assert_eq!(messages.lock().unwrap().len(), 2);
    }

    #[test]
    fn heartbeat_cannot_keep_an_unconsumed_update_alive() {
        let (mut state, commands) = attached();
        let (channel, _) = updates();
        state.attach(channel, false);
        state.start_voice(None).unwrap();
        let request_id = state.snapshot.voice.as_ref().unwrap().request_id;
        state.publish();
        state.delivery.as_mut().unwrap().sent_at =
            Instant::now() - LEASE_TIMEOUT - Duration::from_millis(1);
        state.last_seen = Instant::now();
        state.last_seen_wall = SystemTime::now();
        state.watchdog();
        assert!(state.delivery.is_none());
        assert!(state.snapshot.voice.is_none());
        assert!(state.snapshot.lease.is_empty());
        assert!(commands
            .try_iter()
            .any(|command| command == VoiceCommand::Cancel { request_id }));
    }

    #[test]
    fn acknowledgements_cannot_discard_events_not_delivered_to_the_view() {
        let (mut state, _commands) = attached();
        let (channel, _) = updates();
        let initial = state.attach(channel, false);
        state.start_voice(None).unwrap();
        state.publish();
        assert!(state.acknowledge(&initial.lease, 2, 0).is_err());
        assert!(state.acknowledge(&initial.lease, 1, u64::MAX).is_err());
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.delivery.as_ref().unwrap().acknowledged, 0);
    }

    #[test]
    fn steady_scroll_refreshes_freshness_without_idle_heartbeat_updates() {
        let (mut state, _commands) = attached();
        let (channel, messages) = updates();
        let initial = state.attach(channel, false);
        state.snapshot.gestures_enabled = true;
        state.snapshot.gesture_status = "ready".into();
        state.snapshot.scroll_velocity = 600;
        state.scroll_sequence = 1;
        state.publish();
        state.acknowledge(&initial.lease, 1, 0).unwrap();
        state.scroll_sequence = 2;
        state.publish();
        assert_eq!(messages.lock().unwrap().len(), 2);
        state.acknowledge(&initial.lease, 2, 0).unwrap();
        state.snapshot.scroll_velocity = 0;
        state.publish();
        state.acknowledge(&initial.lease, 3, 0).unwrap();
        state.scroll_sequence = 3;
        state.publish();
        assert_eq!(messages.lock().unwrap().len(), 3);
    }

    #[test]
    fn watchdog_cancels_voice_and_discards_pending_intents() {
        let (mut state, commands) = attached();
        state.start_voice(None).unwrap();
        let request_id = state.snapshot.voice.as_ref().unwrap().request_id;
        state.snapshot.gestures_enabled = true;
        state.last_seen_wall = SystemTime::now() - Duration::from_secs(10);
        state.watchdog();
        assert!(state.snapshot.voice.is_none());
        assert!(!state.snapshot.gestures_enabled);
        assert!(state.events.is_empty());
        assert!(!state.fresh("view-one"));
        assert!(commands
            .try_iter()
            .any(|command| command == VoiceCommand::Cancel { request_id }));
    }

    #[test]
    fn terminal_and_partial_events_cannot_cross_request_or_segment_boundaries() {
        let (mut state, _commands) = attached();
        state.start_voice(None).unwrap();
        let request_id = state.snapshot.voice.as_ref().unwrap().request_id;
        state.events.clear();
        state.voice_event(VoiceEvent::State {
            request_id,
            phase: VoicePhase::Listening,
            progress: None,
        });
        state.segment(request_id, 0, SegmentAction::Send).unwrap();
        state.voice_event(VoiceEvent::SegmentFinal {
            request_id,
            segment_id: 0,
            text: "once".into(),
        });
        state.voice_event(VoiceEvent::SegmentFinal {
            request_id,
            segment_id: 0,
            text: "duplicate".into(),
        });
        state.voice_event(VoiceEvent::Partial {
            request_id,
            segment_id: 0,
            revision: 99,
            committed: "old".into(),
            tentative: String::new(),
        });
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.snapshot.voice.as_ref().unwrap().segment_id, 1);
        assert!(state.snapshot.voice.as_ref().unwrap().text.is_empty());
        state.cancel_voice();
        state.voice_event(VoiceEvent::Final {
            request_id,
            text: "late".into(),
        });
        assert!(state.events.is_empty());
    }

    #[test]
    fn changing_lease_revokes_old_view_commands() {
        let (mut state, _commands) = attached();
        assert!(state.fresh("view-one"));
        state.reset();
        state.snapshot.lease = "view-two".into();
        assert!(!state.fresh("view-one"));
        assert!(state.fresh("view-two"));
        assert_eq!(state.context(), GestureContext::Disarmed);
    }

    #[test]
    fn gesture_progress_is_presentation_only_and_expires() {
        let (mut state, commands) = attached();
        state.snapshot.gestures_enabled = true;
        state.vision_event(VisionEvent::Lifecycle(LifecycleState::Ready));
        let progress = GestureProgress::new(GestureCandidate::StartTranscription, 600).unwrap();
        state.vision_event(VisionEvent::Status {
            reset_sequence: 0,
            sequence: 1,
            received_at: Instant::now(),
            status: ControlStatus::Standby {
                progress: Some(progress),
            },
        });
        assert_eq!(state.snapshot().gesture_progress, Some(progress));
        assert!(state.snapshot.gestures_enabled);
        assert!(commands.try_recv().is_err());
        assert!(state.events.is_empty());
        state.vision_event(VisionEvent::Status {
            reset_sequence: 0,
            sequence: 1,
            received_at: Instant::now(),
            status: ControlStatus::Standby { progress: None },
        });
        assert_eq!(state.snapshot().gesture_progress, Some(progress));
        state.gesture_progress.as_mut().unwrap().0 =
            Instant::now() - STATUS_MAX_AGE - Duration::from_millis(1);
        assert!(state.snapshot().gesture_progress.is_none());
        state.vision_event(VisionEvent::Status {
            reset_sequence: 0,
            sequence: 2,
            received_at: Instant::now(),
            status: ControlStatus::Standby {
                progress: Some(progress),
            },
        });
        state.vision_event(VisionEvent::Lifecycle(LifecycleState::CameraStopped));
        assert!(state.snapshot().gesture_progress.is_none());
    }

    #[test]
    fn gesture_progress_cannot_cross_voice_requests_or_authority_changes() {
        let (mut state, _commands) = attached();
        state.vision_event(VisionEvent::Lifecycle(LifecycleState::Ready));
        state.start_voice(None).unwrap();
        state.events.clear();
        state.snapshot.gestures_enabled = true;
        let voice = state.snapshot.voice.as_mut().unwrap();
        voice.phase = "listening".into();
        voice.muted = Some(false);
        let request_id = voice.request_id;
        let progress = GestureProgress::new(GestureCandidate::Send, 400).unwrap();
        for (sequence, voice_request_id) in [(1, request_id + 1), (2, request_id)] {
            state.vision_event(VisionEvent::Status {
                reset_sequence: 0,
                sequence,
                received_at: Instant::now(),
                status: ControlStatus::Active {
                    voice_request_id,
                    muted: false,
                    progress: Some(progress),
                },
            });
            assert_eq!(
                state.snapshot().gesture_progress.is_some(),
                voice_request_id == request_id
            );
        }
        state.snapshot.voice.as_mut().unwrap().pending = Some(SegmentAction::Send);
        state.sync_context();
        state.snapshot.voice.as_mut().unwrap().pending = None;
        assert!(state.snapshot().gesture_progress.is_none());
    }

    #[test]
    fn only_accepted_gesture_intents_produce_action_feedback() {
        let (mut state, _) = attached();
        state.snapshot.gestures_enabled = true;
        state.vision_event(VisionEvent::Lifecycle(LifecycleState::Ready));
        state.vision_event(VisionEvent::Intent {
            sequence: 1,
            received_at: Instant::now() - INTENT_MAX_AGE - Duration::from_millis(1),
            intent: GestureIntent::SetArmed { armed: false },
        });
        assert!(state.snapshot.gestures_enabled);
        assert!(state.snapshot().gesture_action.is_none());
        state.vision_event(VisionEvent::Intent {
            sequence: 2,
            received_at: Instant::now(),
            intent: GestureIntent::SetArmed { armed: false },
        });
        assert!(!state.snapshot.gestures_enabled);
        assert_eq!(
            state.snapshot().gesture_action,
            Some(GestureCandidate::Disarm)
        );
        assert_eq!(state.snapshot().gesture_action_sequence, 1);
        state.reset();
        assert!(state.snapshot().gesture_action.is_none());
    }

    #[test]
    fn camera_ready_grants_standby_without_an_arming_step() {
        let (mut state, _commands) = attached();
        state.snapshot.gestures_enabled = true;
        state.snapshot.gesture_status = "starting".into();
        assert_eq!(state.context(), GestureContext::Disarmed);
        state.vision_event(VisionEvent::Lifecycle(LifecycleState::Ready));
        assert_eq!(state.context(), GestureContext::Standby);
        state.disable_hands_free();
        state.vision_event(VisionEvent::Intent {
            sequence: 1,
            received_at: Instant::now(),
            intent: GestureIntent::SetArmed { armed: true },
        });
        assert_eq!(state.context(), GestureContext::Disarmed);
        assert!(!state.snapshot.gestures_enabled);
    }

    #[test]
    fn leaving_hands_free_cancels_capture_and_rejects_a_late_send() {
        let (mut state, commands) = attached();
        state.snapshot.gestures_enabled = true;
        state.snapshot.gesture_status = "ready".into();
        state.start_voice(None).unwrap();
        state.events.clear();
        let voice = state.snapshot.voice.as_mut().unwrap();
        voice.phase = "listening".into();
        voice.muted = Some(false);
        let request_id = voice.request_id;
        state.segment(request_id, 0, SegmentAction::Send).unwrap();
        state.disable_hands_free();
        state.voice_event(VoiceEvent::SegmentFinal {
            request_id,
            segment_id: 0,
            text: "late".into(),
        });
        assert!(state.events.is_empty());
        assert!(state.snapshot.voice.is_none());
        assert_eq!(state.context(), GestureContext::Disarmed);
        assert!(commands
            .try_iter()
            .any(|command| command == VoiceCommand::Cancel { request_id }));
    }

    #[test]
    fn only_a_fresh_reset_after_the_action_acknowledges_the_fist() {
        let (mut state, _commands) = attached();
        state.snapshot.gestures_enabled = true;
        state.snapshot.gesture_status = "ready".into();
        state.snapshot.gesture_action_sequence = 7;
        state.snapshot.gesture_needs_reset = true;
        state.intent_sequence = 3;
        state.vision_event(VisionEvent::Status {
            sequence: 4,
            received_at: Instant::now() - STATUS_MAX_AGE - Duration::from_millis(1),
            status: ControlStatus::Standby { progress: None },
            reset_sequence: 1,
        });
        assert!(state.snapshot.gesture_needs_reset);
        assert_eq!(state.snapshot.gesture_reset_after_action, 0);
        state.vision_event(VisionEvent::Status {
            sequence: 5,
            received_at: Instant::now(),
            status: ControlStatus::Standby { progress: None },
            reset_sequence: 1,
        });
        assert!(!state.snapshot.gesture_needs_reset);
        assert_eq!(state.snapshot.gesture_reset_after_action, 7);
        state.snapshot.gesture_action_sequence = 8;
        state.snapshot.gesture_needs_reset = true;
        state.vision_event(VisionEvent::Status {
            sequence: 6,
            received_at: Instant::now(),
            status: ControlStatus::Standby { progress: None },
            reset_sequence: 1,
        });
        assert!(state.snapshot.gesture_needs_reset);
        assert_eq!(state.snapshot.gesture_reset_after_action, 7);
    }
}
