use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime};

use desktop_native::transcription::{
    self, VoiceCommand, VoiceCommandSender, VoiceErrorCode, VoiceEvent, VoicePhase,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

const LEASE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_EVENTS: usize = 16;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SegmentAction {
    Send,
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
    Finish {
        request_id: u64,
    },
    Cancel,
    Segment {
        request_id: u64,
        segment_id: u64,
        action: SegmentAction,
    },
    Devices,
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

    pub async fn attach(&self, updates: Channel<InputUpdate>) -> Result<Snapshot, String> {
        let (reply, received) = oneshot::channel();
        self.sender
            .send(Request::Attach { updates, reply })
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

struct State {
    snapshot: Snapshot,
    voice_commands: VoiceCommandSender,
    last_seen: Instant,
    last_seen_wall: SystemTime,
    next_id: u64,
    events: VecDeque<(Instant, InputEvent)>,
    device_request: Option<u64>,
    delivery: Option<Delivery>,
}

impl State {
    fn new(voice_commands: VoiceCommandSender) -> Self {
        Self {
            snapshot: Snapshot {
                lease: String::new(),
                voice: None,

                devices: Vec::new(),
                devices_loading: false,
                devices_revision: 0,
                notice: None,
                events: Vec::new(),
            },
            voice_commands,
            last_seen: Instant::now(),
            last_seen_wall: SystemTime::now(),

            next_id: 0,
            events: VecDeque::new(),

            device_request: None,

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
    }

    fn reset(&mut self) {
        self.delivery = None;
        self.snapshot.lease.clear();
        // Revoke capture and queued actions together. Already displayed draft text stays in the view.
        self.cancel_voice();
        self.device_request = None;
    }

    fn event(&mut self, mut event: InputEvent) {
        if self.events.len() >= MAX_EVENTS || event.text.len() > 128 * 1024 {
            self.cancel_voice();
            self.snapshot.notice =
                Some("Native input stopped because the view could not keep up.".into());
            return;
        }
        event.id = self.id();
        self.events.push_back((Instant::now(), event));
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            events: self.events.iter().map(|(_, event)| event.clone()).collect(),
            devices_loading: self.device_request.is_some(),
            ..self.snapshot.clone()
        }
    }

    fn attach(&mut self, channel: Channel<InputUpdate>) -> Snapshot {
        self.reset();
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
        if next == delivery.sent && delivery.sent_at.elapsed() < Duration::from_secs(1) {
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
            InputCommand::Finish { request_id } => {
                self.stop(request_id)?;
                if let Some(voice) = self.snapshot.voice.as_mut() {
                    voice.pending = Some(SegmentAction::Send);
                }
            }
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
            InputCommand::Detach => self.reset(),
        }
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
                            action: v.pending,
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
    }

    fn watchdog(&mut self) {
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
                Some(Request::Attach { updates, reply }) => {
                    let initial = state.attach(updates);
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

                    // Wait for the supervisor's terminal channel close before exiting the host.
                    while voice_events.recv().await.is_some() {}
                    let _ = reply.send(());
                    break;
                }
                None => break,
            },
            event = voice_events.recv() => if let Some(event) = event { state.watchdog(); state.voice_event(event); } else { break; },
            _ = tick.tick() => state.watchdog(),
        }
        state.publish();
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

    #[test]
    fn shortcut_finish_releases_capture_and_sends_only_the_correlated_final() {
        let (mut state, commands) = attached();
        let (channel, _) = updates();
        let initial = state.attach(channel);
        state.start_voice(None).unwrap();
        let started = state.events.front().unwrap().1.clone();
        state.publish();
        state.acknowledge(&initial.lease, 1, started.id).unwrap();
        assert!(state
            .command(InputCommand::Finish {
                request_id: started.request_id + 1
            })
            .is_err());
        state
            .command(InputCommand::Finish {
                request_id: started.request_id,
            })
            .unwrap();
        assert!(commands.try_iter().any(|command| command
            == VoiceCommand::Stop {
                request_id: started.request_id
            }));
        state.voice_event(VoiceEvent::Final {
            request_id: started.request_id + 1,
            text: "stale".into(),
        });
        assert!(state.events.is_empty());
        state.voice_event(VoiceEvent::Final {
            request_id: started.request_id,
            text: "Hello Ship".into(),
        });
        assert!(state.snapshot.voice.is_none());
        let event = &state.events.front().unwrap().1;
        assert_eq!(event.kind, "final");
        assert!(event.action == Some(SegmentAction::Send));
        assert_eq!(event.text, "Hello Ship");
        state.voice_event(VoiceEvent::Final {
            request_id: started.request_id,
            text: "duplicate".into(),
        });
        assert_eq!(state.events.len(), 1);
    }

    #[test]
    fn push_delivery_coalesces_partials_until_acknowledged() {
        let (mut state, _commands) = attached();
        let (channel, messages) = updates();
        let initial = state.attach(channel);
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
        state.attach(channel);
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
        let initial = state.attach(channel);
        state.start_voice(None).unwrap();
        state.publish();
        assert!(state.acknowledge(&initial.lease, 2, 0).is_err());
        assert!(state.acknowledge(&initial.lease, 1, u64::MAX).is_err());
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.delivery.as_ref().unwrap().acknowledged, 0);
    }

    #[test]
    fn watchdog_cancels_voice_and_discards_pending_intents() {
        let (mut state, commands) = attached();
        state.start_voice(None).unwrap();
        let request_id = state.snapshot.voice.as_ref().unwrap().request_id;
        state.last_seen_wall = SystemTime::now() - Duration::from_secs(10);
        state.watchdog();
        assert!(state.snapshot.voice.is_none());
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
    }
}
