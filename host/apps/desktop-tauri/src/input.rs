use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime};

use desktop_native::transcription::{
    self, VoiceCommand, VoiceCommandSender, VoiceErrorCode, VoiceEvent, VoicePhase,
};
use desktop_native::vision_debug::{self, VisionEvent, VisionHandle};
use gesture_protocol::{
    ControlStatus, GestureCandidate, GestureContext, GestureIntent, GestureProgress,
    LifecycleState, ScrollState, VoiceRequestGestureIntent,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

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
    Mute {
        request_id: u64,
        muted: bool,
    },
    Devices,
    Gestures {
        enabled: bool,
    },
    Arm {
        armed: bool,
    },
    Detach,
}

#[derive(Clone, Serialize)]
pub struct VoiceState {
    pub request_id: u64,
    pub segment_id: u64,
    pub revision: i32,
    pub text: String,
    pub phase: String,
    pub progress: Option<f32>,
    pub muted: Option<bool>,
    pub mute_pending: bool,
    pub pending: Option<SegmentAction>,
    #[serde(skip)]
    mute_revision: Option<u64>,
    #[serde(skip)]
    expected_mute: Option<bool>,
}

#[derive(Clone, Serialize)]
pub struct Device {
    id: String,
    name: String,
    is_default: bool,
}

#[derive(Clone, Serialize)]
pub struct InputEvent {
    pub id: u64,
    pub request_id: u64,
    pub segment_id: u64,
    pub kind: &'static str,
    pub action: Option<SegmentAction>,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub lease: String,
    pub voice: Option<VoiceState>,
    pub gestures_enabled: bool,
    pub armed: bool,
    pub gesture_status: String,
    pub gesture_context: GestureContext,
    pub gesture_progress: Option<GestureProgress>,
    pub gesture_action: Option<GestureCandidate>,
    pub scroll_velocity: i16,
    pub devices: Vec<Device>,
    pub notice: Option<String>,
    pub events: Vec<InputEvent>,
}

enum Request {
    Attach(oneshot::Sender<Result<Snapshot, String>>),
    Poll {
        lease: String,
        ack: u64,
        reply: oneshot::Sender<Result<Snapshot, String>>,
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

    pub async fn attach(&self) -> Result<Snapshot, String> {
        let (reply, received) = oneshot::channel();
        self.sender
            .send(Request::Attach(reply))
            .await
            .map_err(|_| "Native input is closed.")?;
        received.await.map_err(|_| "Native input is closed.")?
    }

    pub async fn poll(&self, lease: String, ack: u64) -> Result<Snapshot, String> {
        let (reply, received) = oneshot::channel();
        self.sender
            .send(Request::Poll { lease, ack, reply })
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

struct State {
    snapshot: Snapshot,
    voice_commands: VoiceCommandSender,
    last_poll: Instant,
    last_poll_wall: SystemTime,
    scroll_at: Instant,
    next_id: u64,
    events: VecDeque<(Instant, InputEvent)>,
    vision: Option<VisionHandle>,
    intent_sequence: u64,
    scroll_sequence: u64,
    status_sequence: u64,
    gesture_progress: Option<(Instant, GestureContext, GestureProgress)>,
    gesture_action: Option<(Instant, GestureCandidate)>,
    device_request: Option<u64>,
    selected_device: Option<String>,
}

impl State {
    fn new(voice_commands: VoiceCommandSender) -> Self {
        Self {
            snapshot: Snapshot {
                lease: String::new(),
                voice: None,
                gestures_enabled: false,
                armed: false,
                gesture_status: "off".into(),
                gesture_context: GestureContext::Disarmed,
                gesture_progress: None,
                gesture_action: None,
                scroll_velocity: 0,
                devices: Vec::new(),
                notice: None,
                events: Vec::new(),
            },
            voice_commands,
            last_poll: Instant::now(),
            last_poll_wall: SystemTime::now(),
            scroll_at: Instant::now(),
            next_id: 0,
            events: VecDeque::new(),
            vision: None,
            intent_sequence: 0,
            scroll_sequence: 0,
            status_sequence: 0,
            gesture_progress: None,
            gesture_action: None,
            device_request: None,
            selected_device: None,
        }
    }

    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn fresh(&self, lease: &str) -> bool {
        !lease.is_empty()
            && self.snapshot.lease == lease
            && self.last_poll.elapsed() <= LEASE_TIMEOUT
            && self
                .last_poll_wall
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
        self.snapshot.armed = false;
        self.snapshot.lease.clear();
        self.cancel_voice();
        self.vision = None;
        self.snapshot.gestures_enabled = false;
        self.snapshot.gesture_status = "off".into();
        self.gesture_progress = None;
        self.gesture_action = None;
        self.device_request = None;
    }

    fn context(&self) -> GestureContext {
        if !self.snapshot.armed {
            return GestureContext::Disarmed;
        }
        if !self.events.is_empty() {
            return GestureContext::Disabled;
        }
        match &self.snapshot.voice {
            None => GestureContext::Standby,
            Some(voice)
                if voice.phase == "listening" && !voice.mute_pending && voice.pending.is_none() =>
            {
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

    fn sync_context(&mut self) {
        let context = self.context();
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
            self.cancel_voice();
            self.snapshot.armed = false;
            self.snapshot.notice =
                Some("Native input stopped because the view could not keep up.".into());
            return;
        }
        event.id = self.id();
        self.events.push_back((Instant::now(), event));
    }

    fn snapshot(&self) -> Snapshot {
        let context = self.context();
        let gesture_progress = self.gesture_progress.and_then(|(at, owner, progress)| {
            (self.snapshot.gesture_status == "ready"
                && self.fresh(&self.snapshot.lease)
                && owner == context
                && at.elapsed() <= STATUS_MAX_AGE
                && progress.is_compatible_with(context))
            .then_some(progress)
        });
        Snapshot {
            gesture_context: context,
            gesture_progress,
            gesture_action: self
                .gesture_action
                .and_then(|(at, action)| (at.elapsed() <= ACTION_FEEDBACK_AGE).then_some(action)),
            events: self.events.iter().map(|(_, event)| event.clone()).collect(),
            ..self.snapshot.clone()
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
            mute_pending: false,
            mute_revision: None,
            expected_mute: None,
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

    fn mute(&mut self, request_id: u64, muted: bool) -> Result<(), String> {
        let voice = self
            .snapshot
            .voice
            .as_mut()
            .filter(|v| v.request_id == request_id)
            .ok_or("This dictation has ended.")?;
        if voice.phase != "listening" || voice.muted.is_none() || voice.mute_pending {
            return Err("Wait for the microphone state.".into());
        }
        if voice.muted == Some(muted) {
            return Ok(());
        }
        self.voice_commands
            .send(VoiceCommand::SetMuted { request_id, muted })
            .map_err(|_| "Voice helper is unavailable.")?;
        voice.mute_pending = true;
        voice.expected_mute = Some(muted);
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

    async fn command(&mut self, command: InputCommand) -> Result<(), String> {
        match command {
            InputCommand::Start { device_id } => self.start_voice(device_id)?,
            InputCommand::Stop { request_id } => self.stop(request_id)?,
            InputCommand::Cancel => self.cancel_voice(),
            InputCommand::Segment {
                request_id,
                segment_id,
                action,
            } => self.segment(request_id, segment_id, action)?,
            InputCommand::Mute { request_id, muted } => self.mute(request_id, muted)?,
            InputCommand::Devices => {
                if self.snapshot.voice.is_some() || self.device_request.is_some() {
                    return Err("Stop dictation before choosing a microphone.".into());
                }
                let request_id = self.id();
                self.voice_commands
                    .send(VoiceCommand::ListDevices { request_id })
                    .map_err(|_| "Voice helper is unavailable.")?;
                self.device_request = Some(request_id);
            }
            InputCommand::Gestures { enabled } => {
                self.snapshot.armed = false;
                self.snapshot.scroll_velocity = 0;
                self.vision = None;
                self.snapshot.gestures_enabled = false;
                self.snapshot.gesture_status = "off".into();
                self.gesture_progress = None;
                self.gesture_action = None;
                if enabled {
                    self.vision = tokio::task::spawn_blocking(vision_debug::start_for_desktop)
                        .await
                        .map_err(|_| "Gesture helper could not start.")?
                        .map_err(|error| error.to_string())?;
                    self.snapshot.gestures_enabled = self.vision.is_some();
                    self.snapshot.gesture_status = if self.vision.is_some() {
                        "starting"
                    } else {
                        "disabled"
                    }
                    .into();
                    self.intent_sequence = 0;
                    self.scroll_sequence = 0;
                    self.status_sequence = 0;
                }
            }
            InputCommand::Arm { armed } => {
                if armed && (self.vision.is_none() || self.snapshot.gesture_status != "ready") {
                    return Err("Enable gestures and wait for the camera to be ready.".into());
                }
                self.snapshot.armed = armed;
                self.snapshot.scroll_velocity = 0;
                self.gesture_progress = None;
                self.gesture_action = None;
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
                    if v.mute_revision.is_some_and(|r| revision <= r)
                        || v.expected_mute.is_some_and(|m| m != muted)
                    {
                        if v.mute_pending {
                            self.cancel_voice();
                            self.snapshot.notice =
                                Some("Microphone mute was not acknowledged. Voice stopped.".into());
                        }
                    } else {
                        v.mute_revision = Some(revision);
                        v.muted = Some(muted);
                        v.mute_pending = false;
                        v.expected_mute = None;
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
            VoiceEvent::Cancelled { request_id } => {
                if self
                    .snapshot
                    .voice
                    .as_ref()
                    .is_some_and(|v| v.request_id == request_id)
                {
                    self.cancel_voice();
                }
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
                    self.snapshot.armed = false;
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
                };
                let result = if received_at.elapsed() > INTENT_MAX_AGE
                    || !self.fresh(&self.snapshot.lease)
                    || self.snapshot.gesture_status != "ready"
                {
                    None
                } else {
                    match intent {
                        GestureIntent::SetArmed { armed } => {
                            self.snapshot.armed = armed;
                            self.snapshot.scroll_velocity = 0;
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
                                VoiceRequestGestureIntent::Mute => {
                                    self.mute(voice_request_id, true)
                                }
                                VoiceRequestGestureIntent::Unmute => {
                                    self.mute(voice_request_id, false)
                                }
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
                    }
                }
                if let Some(vision) = &self.vision {
                    let _ = vision.context.reassert_context(self.context());
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
                self.snapshot.scroll_velocity = if matches!(
                    self.context(),
                    GestureContext::Standby | GestureContext::Active { .. }
                ) && received_at.elapsed() <= SCROLL_MAX_AGE
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
            } => {
                if sequence <= self.status_sequence {
                    return;
                }
                self.status_sequence = sequence;
                let (context, progress) = match status {
                    ControlStatus::Disarmed { progress } => (GestureContext::Disarmed, progress),
                    ControlStatus::Disabled { progress } => (GestureContext::Disabled, progress),
                    ControlStatus::Standby { progress } => (GestureContext::Standby, progress),
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
                if context == self.context() {
                    self.gesture_progress = progress
                        .filter(|progress| progress.is_compatible_with(context))
                        .filter(|_| {
                            self.snapshot.gesture_status == "ready"
                                && self.fresh(&self.snapshot.lease)
                                && received_at.elapsed() <= STATUS_MAX_AGE
                        })
                        .map(|progress| (received_at, context, progress));
                }
            }
        }
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

async fn run(mut requests: mpsc::Receiver<Request>) {
    let mut voice = transcription::start();
    let mut state = State::new(voice.commands.clone());
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            request = requests.recv() => match request {
                Some(Request::Attach(reply)) => {
                    state.reset();
                    state.snapshot.lease = Uuid::new_v4().to_string();
                    state.last_poll = Instant::now();
                    state.last_poll_wall = SystemTime::now();
                    if reply.send(Ok(state.snapshot())).is_err() { state.reset(); }
                }
                Some(Request::Poll { lease, ack, reply }) => {
                    state.watchdog();
                    if !state.fresh(&lease) { let _ = reply.send(Err("Native input session ended. Reconnect input to continue.".into())); continue; }
                    state.last_poll = Instant::now();
                    state.last_poll_wall = SystemTime::now();
                    while state.events.front().is_some_and(|(_, e)| e.id <= ack) { state.events.pop_front(); }
                    state.sync_context();
                    let _ = reply.send(Ok(state.snapshot()));
                }
                Some(Request::Command { lease, command, reply }) => {
                    state.watchdog();
                    let result = if state.fresh(&lease) { state.command(command).await }
                        else { Err("Native input session ended.".into()) };
                    let _ = reply.send(result);
                }
                Some(Request::Reset(reply)) => { state.reset(); let _ = reply.send(()); }
                Some(Request::Shutdown(reply)) => {
                    state.reset();
                    let _ = state.voice_commands.send(VoiceCommand::Shutdown);
                    // Wait for the supervisor's terminal channel close before exiting the host.
                    while voice.events.recv().await.is_some() {}
                    let _ = reply.send(());
                    break;
                }
                None => break,
            },
            event = voice.events.recv() => if let Some(event) = event { state.watchdog(); state.voice_event(event); } else { break; },
            event = async {
                match &mut state.vision {
                    Some(vision) => vision.events.recv().await,
                    None => std::future::pending().await,
                }
            } => if let Some(event) = event { state.vision_event(event); } else {
                state.vision = None;
                state.snapshot.gestures_enabled = false;
                state.snapshot.armed = false;
                state.snapshot.scroll_velocity = 0;
                state.gesture_progress = None;
                state.gesture_action = None;
                if matches!(state.snapshot.gesture_status.as_str(), "ready" | "starting") {
                    state.snapshot.gesture_status = "interrupted".into();
                }
            },
            _ = tick.tick() => state.watchdog(),
        }
    }
    state.reset();
    let _ = state.voice_commands.send(VoiceCommand::Shutdown);
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

    fn attached() -> (State, std::sync::mpsc::Receiver<VoiceCommand>) {
        let (commands, receiver) = VoiceCommandSender::channel_for_test();
        let mut state = State::new(commands);
        state.snapshot.lease = "view-one".into();
        (state, receiver)
    }

    #[test]
    fn watchdog_cancels_voice_and_discards_pending_intents() {
        let (mut state, commands) = attached();
        state.start_voice(None).unwrap();
        let request_id = state.snapshot.voice.as_ref().unwrap().request_id;
        state.snapshot.armed = true;
        state.last_poll_wall = SystemTime::now() - Duration::from_secs(10);
        state.watchdog();
        assert!(state.snapshot.voice.is_none());
        assert!(!state.snapshot.armed);
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
        state.vision_event(VisionEvent::Lifecycle(LifecycleState::Ready));
        let progress = GestureProgress::new(GestureCandidate::Arm, 600).unwrap();
        state.vision_event(VisionEvent::Status {
            sequence: 1,
            received_at: Instant::now(),
            status: ControlStatus::Disarmed {
                progress: Some(progress),
            },
        });
        assert_eq!(state.snapshot().gesture_progress, Some(progress));
        assert!(!state.snapshot.armed);
        assert!(commands.try_recv().is_err());
        assert!(state.events.is_empty());
        state.vision_event(VisionEvent::Status {
            sequence: 1,
            received_at: Instant::now(),
            status: ControlStatus::Disarmed { progress: None },
        });
        assert_eq!(state.snapshot().gesture_progress, Some(progress));
        state.gesture_progress.as_mut().unwrap().0 =
            Instant::now() - STATUS_MAX_AGE - Duration::from_millis(1);
        assert!(state.snapshot().gesture_progress.is_none());
        state.vision_event(VisionEvent::Status {
            sequence: 2,
            received_at: Instant::now(),
            status: ControlStatus::Disarmed {
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
        state.snapshot.armed = true;
        let voice = state.snapshot.voice.as_mut().unwrap();
        voice.phase = "listening".into();
        voice.muted = Some(false);
        let request_id = voice.request_id;
        let progress = GestureProgress::new(GestureCandidate::Mute, 400).unwrap();
        for (sequence, voice_request_id) in [(1, request_id + 1), (2, request_id)] {
            state.vision_event(VisionEvent::Status {
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
        state.snapshot.voice.as_mut().unwrap().mute_pending = true;
        state.sync_context();
        state.snapshot.voice.as_mut().unwrap().mute_pending = false;
        assert!(state.snapshot().gesture_progress.is_none());
    }

    #[test]
    fn only_accepted_gesture_intents_produce_action_feedback() {
        let (mut state, _) = attached();
        state.vision_event(VisionEvent::Lifecycle(LifecycleState::Ready));
        state.vision_event(VisionEvent::Intent {
            sequence: 1,
            received_at: Instant::now() - INTENT_MAX_AGE - Duration::from_millis(1),
            intent: GestureIntent::SetArmed { armed: true },
        });
        assert!(!state.snapshot.armed);
        assert!(state.snapshot().gesture_action.is_none());
        state.vision_event(VisionEvent::Intent {
            sequence: 2,
            received_at: Instant::now(),
            intent: GestureIntent::SetArmed { armed: true },
        });
        assert!(state.snapshot.armed);
        assert_eq!(state.snapshot().gesture_action, Some(GestureCandidate::Arm));
        state.reset();
        assert!(state.snapshot().gesture_action.is_none());
    }
}
