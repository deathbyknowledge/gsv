//! Private, bounded control transport to the supervising Desktop process.
//!
//! Standard input remains the parent-death lease and carries only strict
//! Desktop context frames. Semantic helper events leave on the separately
//! inherited event descriptor; stdout and stderr stay diagnostic-only.

use std::env;
use std::fs::File;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::fd::FromRawFd as _;
use std::process;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError, TrySendError};
use gesture_protocol::{
    read_frame, write_frame, ControlStatus, DesktopCommand, GestureContext, GestureIntent,
    HelperEvent, LifecycleState, ScrollState, SessionId, EVENT_CHANNEL_CONTRACT_MARKER, EVENT_FD,
    EVENT_FD_MARKER_ENV, PROTOCOL_VERSION, SESSION_HIGH_ENV, SESSION_LOW_ENV,
};

const EVENT_QUEUE_CAPACITY: usize = 4;
const SNAPSHOT_QUEUE_CAPACITY: usize = 1;
const TERMINAL_ENQUEUE_TIMEOUT: Duration = Duration::from_millis(100);
const TERMINAL_WRITE_TIMEOUT: Duration = Duration::from_millis(500);

enum EventPayload {
    Lifecycle(LifecycleState),
    Intent(GestureIntent),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SnapshotPayload {
    Status(ControlStatus),
    Scroll(ScrollState),
}

struct QueuedEvent {
    payload: EventPayload,
    completion: Option<Sender<bool>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlContext {
    Uninitialized,
    Authoritative {
        revision: u64,
        gesture: GestureContext,
    },
}

#[derive(Clone)]
pub struct HelperControl {
    context: Arc<Mutex<ControlContext>>,
    events: Sender<QueuedEvent>,
    snapshots: Sender<SnapshotPayload>,
    snapshot_replacements: Receiver<SnapshotPayload>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlTransportError {
    InvalidEnvironment,
    EventChannelUnavailable,
    WorkerUnavailable,
}

impl HelperControl {
    /// Starts the supervised protocol when Desktop supplied its exact internal
    /// marker. Direct debug-helper launches deliberately have no app control
    /// channel and return `None`.
    pub fn start_from_environment() -> Result<Option<Self>, ControlTransportError> {
        let marker = env::var(EVENT_FD_MARKER_ENV).ok();
        if !event_channel_enabled(marker.as_deref())? {
            return Ok(None);
        }

        let session_id = SessionId::new(
            parse_session_half(SESSION_HIGH_ENV)?,
            parse_session_half(SESSION_LOW_ENV)?,
        );
        let mut event_output = inherited_event_output()?;
        write_frame(
            &mut event_output,
            &HelperEvent::Hello {
                protocol_version: PROTOCOL_VERSION,
                session_id,
            },
        )
        .map_err(|_| ControlTransportError::EventChannelUnavailable)?;

        let (events, event_receiver) = bounded(EVENT_QUEUE_CAPACITY);
        let (snapshots, snapshot_receiver) = bounded(SNAPSHOT_QUEUE_CAPACITY);
        let snapshot_replacements = snapshot_receiver.clone();
        thread::Builder::new()
            .name("gsv-vision-events".to_string())
            .spawn(move || {
                write_events(
                    &mut event_output,
                    session_id,
                    event_receiver,
                    snapshot_receiver,
                );
            })
            .map_err(|_| ControlTransportError::WorkerUnavailable)?;

        let context = Arc::new(Mutex::new(ControlContext::Uninitialized));
        let command_context = Arc::clone(&context);
        thread::Builder::new()
            .name("gsv-vision-parent-watchdog".to_string())
            .spawn(move || supervise_parent_commands(session_id, command_context))
            .map_err(|_| ControlTransportError::WorkerUnavailable)?;

        Ok(Some(Self {
            context,
            events,
            snapshots,
            snapshot_replacements,
        }))
    }

    pub fn context(&self) -> ControlContext {
        self.context
            .lock()
            .map_or(ControlContext::Uninitialized, |context| *context)
    }

    pub fn publish_lifecycle(&self, state: LifecycleState) -> bool {
        self.publish(EventPayload::Lifecycle(state))
    }

    /// Publishes a terminal state and waits for only the complete frame write.
    /// Parent loss and pipe backpressure remain bounded so shutdown cannot hang.
    pub fn publish_terminal_lifecycle(&self, state: LifecycleState) -> bool {
        let (completion, completed) = bounded(1);
        if self
            .events
            .send_timeout(
                QueuedEvent {
                    payload: EventPayload::Lifecycle(state),
                    completion: Some(completion),
                },
                TERMINAL_ENQUEUE_TIMEOUT,
            )
            .is_err()
        {
            return false;
        }
        completed
            .recv_timeout(TERMINAL_WRITE_TIMEOUT)
            .unwrap_or(false)
    }

    pub fn publish_intent(&self, intent: GestureIntent) -> bool {
        self.publish(EventPayload::Intent(intent))
    }

    pub fn publish_scroll(&self, state: ScrollState) -> bool {
        self.publish_snapshot(SnapshotPayload::Scroll(state))
    }

    /// Replaces an obsolete semantic snapshot without ever waiting for the
    /// event writer. Status is explanatory only; reliable lifecycle and intent
    /// events use a separate, prioritized queue.
    /// Scroll control position is absolute and heartbeated, so it is safe to
    /// share this replace-latest lane without replaying dropped deltas.
    pub fn publish_status(&self, status: ControlStatus) -> bool {
        self.publish_snapshot(SnapshotPayload::Status(status))
    }

    fn publish_snapshot(&self, snapshot: SnapshotPayload) -> bool {
        match self.snapshots.try_send(snapshot) {
            Ok(()) => true,
            Err(TrySendError::Full(snapshot)) => {
                let _ = self.snapshot_replacements.try_recv();
                self.snapshots.try_send(snapshot).is_ok()
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    fn publish(&self, payload: EventPayload) -> bool {
        // Gesture edges are rare and must not be silently replaced. If the
        // Desktop stops draining, bounded backpressure pauses inference in
        // this isolated helper rather than growing memory or losing SEND.
        self.events
            .send(QueuedEvent {
                payload,
                completion: None,
            })
            .is_ok()
    }
}

fn event_channel_enabled(marker: Option<&str>) -> Result<bool, ControlTransportError> {
    match marker {
        None => Ok(false),
        Some(EVENT_CHANNEL_CONTRACT_MARKER) => Ok(true),
        Some(_) => Err(ControlTransportError::InvalidEnvironment),
    }
}

fn write_events(
    output: &mut impl Write,
    session_id: SessionId,
    events: Receiver<QueuedEvent>,
    snapshots: Receiver<SnapshotPayload>,
) {
    let mut next_sequence = 1_u64;
    loop {
        // A ready reliable event always wins over an explanatory snapshot.
        match events.try_recv() {
            Ok(event) => {
                if !write_reliable(output, session_id, &mut next_sequence, event) {
                    return;
                }
                continue;
            }
            Err(TryRecvError::Disconnected) => {
                for snapshot in snapshots {
                    if !write_snapshot(output, session_id, &mut next_sequence, snapshot) {
                        return;
                    }
                }
                return;
            }
            Err(TryRecvError::Empty) => {}
        }

        crossbeam_channel::select_biased! {
            recv(events) -> event => match event {
                Ok(event) => {
                    if !write_reliable(output, session_id, &mut next_sequence, event) {
                        return;
                    }
                }
                Err(_) => {
                    for snapshot in snapshots {
                        if !write_snapshot(output, session_id, &mut next_sequence, snapshot) {
                            return;
                        }
                    }
                    return;
                }
            },
            recv(snapshots) -> snapshot => match snapshot {
                Ok(snapshot) => {
                    if !write_snapshot(output, session_id, &mut next_sequence, snapshot) {
                        return;
                    }
                }
                Err(_) => {
                    for event in events {
                        if !write_reliable(output, session_id, &mut next_sequence, event) {
                            return;
                        }
                    }
                    return;
                }
            },
        }
    }
}

fn write_reliable(
    output: &mut impl Write,
    session_id: SessionId,
    next_sequence: &mut u64,
    queued: QueuedEvent,
) -> bool {
    let sequence = take_sequence(next_sequence);
    let event = match queued.payload {
        EventPayload::Lifecycle(state) => HelperEvent::Lifecycle {
            session_id,
            sequence,
            state,
        },
        EventPayload::Intent(intent) => HelperEvent::Intent {
            session_id,
            sequence,
            intent,
        },
    };
    let written = write_frame(output, &event).is_ok();
    if let Some(completion) = queued.completion {
        let _ = completion.send(written);
    }
    written
}

fn write_snapshot(
    output: &mut impl Write,
    session_id: SessionId,
    next_sequence: &mut u64,
    snapshot: SnapshotPayload,
) -> bool {
    let sequence = take_sequence(next_sequence);
    let event = match snapshot {
        SnapshotPayload::Status(status) => HelperEvent::Status {
            session_id,
            sequence,
            status,
        },
        SnapshotPayload::Scroll(state) => HelperEvent::Scroll {
            session_id,
            sequence,
            state,
        },
    };
    write_frame(output, &event).is_ok()
}

fn take_sequence(next_sequence: &mut u64) -> u64 {
    let sequence = *next_sequence;
    *next_sequence = next_sequence.wrapping_add(1).max(1);
    sequence
}

fn parse_session_half(name: &str) -> Result<u64, ControlTransportError> {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .ok_or(ControlTransportError::InvalidEnvironment)
}

#[cfg(unix)]
fn inherited_event_output() -> Result<File, ControlTransportError> {
    // Reject a missing/closed descriptor before taking ownership. The marker
    // is internal, but this also keeps direct/manual helper launches safe.
    // SAFETY: `fcntl(F_GETFD)` only inspects the integer descriptor.
    if unsafe { libc::fcntl(EVENT_FD, libc::F_GETFD) } < 0 {
        return Err(ControlTransportError::EventChannelUnavailable);
    }
    // SAFETY: the Desktop supervisor installs exactly one owned event-pipe
    // write end at EVENT_FD before exec. This helper takes sole ownership.
    Ok(unsafe { File::from_raw_fd(EVENT_FD) })
}

#[cfg(not(unix))]
fn inherited_event_output() -> Result<File, ControlTransportError> {
    Err(ControlTransportError::EventChannelUnavailable)
}

fn supervise_parent_commands(session_id: SessionId, context: Arc<Mutex<ControlContext>>) -> ! {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let command = match read_frame::<DesktopCommand>(&mut input) {
            Ok(Some(command)) => command,
            Ok(None) | Err(_) => process::exit(0),
        };
        if !apply_context_command(session_id, &context, command) {
            process::exit(0);
        }
    }
}

fn apply_context_command(
    expected_session: SessionId,
    context: &Mutex<ControlContext>,
    command: DesktopCommand,
) -> bool {
    let DesktopCommand::SetContext {
        session_id,
        context: gesture,
    } = command;
    if session_id != expected_session {
        return false;
    }
    let Ok(mut context) = context.lock() else {
        return false;
    };
    let revision = match *context {
        ControlContext::Uninitialized => 1,
        ControlContext::Authoritative { revision, .. } => revision.wrapping_add(1).max(1),
    };
    *context = ControlContext::Authoritative { revision, gesture };
    true
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use gesture_protocol::VoiceRequestGestureIntent;

    use super::*;

    const SESSION: SessionId = SessionId::new(3, 5);

    #[derive(Clone, Default)]
    struct SharedOutput(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedOutput {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .map_err(|_| io::Error::other("test output lock failed"))?
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn test_control(
        events: Sender<QueuedEvent>,
        snapshots: Sender<SnapshotPayload>,
        snapshot_replacements: Receiver<SnapshotPayload>,
    ) -> HelperControl {
        HelperControl {
            context: Arc::new(Mutex::new(ControlContext::Uninitialized)),
            events,
            snapshots,
            snapshot_replacements,
        }
    }

    #[test]
    fn event_channel_requires_the_rotated_exact_contract_marker() {
        assert_eq!(event_channel_enabled(None), Ok(false));
        for stale in [
            "1",
            "gsv-vision-control-v1",
            "gsv-vision-control-v1-explicit-modes",
            "gsv-vision-control-v2-dictation-editing",
            "gsv-vision-control-v4-armed-one-hand",
        ] {
            assert_eq!(
                event_channel_enabled(Some(stale)),
                Err(ControlTransportError::InvalidEnvironment)
            );
        }
        assert_eq!(
            event_channel_enabled(Some(EVENT_CHANNEL_CONTRACT_MARKER)),
            Ok(true)
        );
    }

    #[test]
    fn immediate_terminal_after_hello_is_fully_flushed() {
        let output = SharedOutput::default();
        let mut hello_output = output.clone();
        write_frame(
            &mut hello_output,
            &HelperEvent::Hello {
                protocol_version: PROTOCOL_VERSION,
                session_id: SESSION,
            },
        )
        .expect("hello writes");

        let (events, event_receiver) = bounded(EVENT_QUEUE_CAPACITY);
        let (snapshots, snapshot_receiver) = bounded(SNAPSHOT_QUEUE_CAPACITY);
        let snapshot_replacements = snapshot_receiver.clone();
        let mut event_output = output.clone();
        let writer = thread::spawn(move || {
            write_events(
                &mut event_output,
                SESSION,
                event_receiver,
                snapshot_receiver,
            );
        });
        let control = test_control(events, snapshots, snapshot_replacements);

        assert!(control.publish_terminal_lifecycle(LifecycleState::AssetsUnavailable));
        drop(control);
        writer.join().expect("writer exits");

        let bytes = output.0.lock().expect("output lock").clone();
        let mut input = Cursor::new(bytes);
        assert!(matches!(
            read_frame::<HelperEvent>(&mut input),
            Ok(Some(HelperEvent::Hello { .. }))
        ));
        assert_eq!(
            read_frame::<HelperEvent>(&mut input).expect("terminal reads"),
            Some(HelperEvent::Lifecycle {
                session_id: SESSION,
                sequence: 1,
                state: LifecycleState::AssetsUnavailable,
            })
        );
        assert_eq!(
            read_frame::<HelperEvent>(&mut input).expect("clean eof"),
            None
        );
    }

    #[test]
    fn every_same_session_context_is_an_authority_echo() {
        let context = Mutex::new(ControlContext::Uninitialized);
        for (revision, gesture) in [
            (1_u64, GestureContext::Standby),
            (
                2,
                GestureContext::Active {
                    voice_request_id: 17,
                    muted: false,
                },
            ),
            (
                3,
                GestureContext::Active {
                    voice_request_id: 17,
                    muted: false,
                },
            ),
            (4, GestureContext::Disabled),
        ] {
            let command = DesktopCommand::set_context(SESSION, gesture);
            assert!(apply_context_command(SESSION, &context, command));
            assert_eq!(
                *context.lock().expect("context"),
                ControlContext::Authoritative { revision, gesture }
            );
        }
    }

    #[test]
    fn a_stale_supervisor_session_cannot_change_context_or_ack_pending_work() {
        let context = Mutex::new(ControlContext::Authoritative {
            revision: 7,
            gesture: GestureContext::Standby,
        });
        let command = DesktopCommand::set_context(
            SessionId::new(8, 9),
            GestureContext::Active {
                voice_request_id: 99,
                muted: true,
            },
        );

        assert!(!apply_context_command(SESSION, &context, command));
        assert_eq!(
            *context.lock().expect("context"),
            ControlContext::Authoritative {
                revision: 7,
                gesture: GestureContext::Standby,
            }
        );
    }

    #[test]
    fn semantic_snapshots_are_nonblocking_and_latest_wins() {
        let (events, _event_receiver) = bounded(EVENT_QUEUE_CAPACITY);
        let (snapshots, snapshot_receiver) = bounded(SNAPSHOT_QUEUE_CAPACITY);
        let control = test_control(events, snapshots, snapshot_receiver.clone());

        assert!(control.publish_status(ControlStatus::Standby { progress: None }));
        let latest = ScrollState::Active {
            instance_id: 4,
            offset_millipalms: 325,
        };
        assert!(control.publish_scroll(latest));
        assert_eq!(
            snapshot_receiver.try_recv(),
            Ok(SnapshotPayload::Scroll(latest))
        );
    }

    #[test]
    fn reliable_intents_precede_status_and_share_monotonic_sequence() {
        let output = SharedOutput::default();
        let (events, event_receiver) = bounded(EVENT_QUEUE_CAPACITY);
        let (snapshots, snapshot_receiver) = bounded(SNAPSHOT_QUEUE_CAPACITY);
        let control = test_control(events, snapshots, snapshot_receiver.clone());
        assert!(control.publish_status(ControlStatus::Standby { progress: None }));
        assert!(control.publish_intent(GestureIntent::StartTranscription));
        assert!(control.publish_intent(GestureIntent::VoiceRequest {
            voice_request_id: 91,
            action: VoiceRequestGestureIntent::Send,
        }));

        let mut event_output = output.clone();
        let writer = thread::spawn(move || {
            write_events(
                &mut event_output,
                SESSION,
                event_receiver,
                snapshot_receiver,
            );
        });
        drop(control);
        writer.join().expect("writer exits");

        let bytes = output.0.lock().expect("output lock").clone();
        let mut input = Cursor::new(bytes);
        assert_eq!(
            read_frame::<HelperEvent>(&mut input).expect("start reads"),
            Some(HelperEvent::Intent {
                session_id: SESSION,
                sequence: 1,
                intent: GestureIntent::StartTranscription,
            })
        );
        assert_eq!(
            read_frame::<HelperEvent>(&mut input).expect("send reads"),
            Some(HelperEvent::Intent {
                session_id: SESSION,
                sequence: 2,
                intent: GestureIntent::VoiceRequest {
                    voice_request_id: 91,
                    action: VoiceRequestGestureIntent::Send,
                },
            })
        );
        assert_eq!(
            read_frame::<HelperEvent>(&mut input).expect("status reads"),
            Some(HelperEvent::Status {
                session_id: SESSION,
                sequence: 3,
                status: ControlStatus::Standby { progress: None },
            })
        );
    }

    #[test]
    fn wire_sequence_never_uses_zero_after_wrap() {
        let mut sequence = u64::MAX;
        assert_eq!(take_sequence(&mut sequence), u64::MAX);
        assert_eq!(sequence, 1);
        assert_eq!(take_sequence(&mut sequence), 1);
    }
}
