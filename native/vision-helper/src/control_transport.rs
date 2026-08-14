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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crossbeam_channel::{bounded, Sender};
use gsv_vision_control::{
    read_frame, write_frame, DesktopCommand, GestureIntent, HelperEvent, LifecycleState, SessionId,
    EVENT_FD, EVENT_FD_MARKER_ENV, PROTOCOL_VERSION, SESSION_HIGH_ENV, SESSION_LOW_ENV,
};

const ENABLED_MARKER: &str = "1";
const EVENT_QUEUE_CAPACITY: usize = 4;
const TERMINAL_ENQUEUE_TIMEOUT: Duration = Duration::from_millis(100);
const TERMINAL_WRITE_TIMEOUT: Duration = Duration::from_millis(500);

struct QueuedEvent {
    event: HelperEvent,
    completion: Option<Sender<bool>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlContext {
    pub voice_request_id: Option<u64>,
    pub held: bool,
    pub revision: u64,
}

impl ControlContext {
    const DISABLED: Self = Self {
        voice_request_id: None,
        held: false,
        revision: 0,
    };
}

#[derive(Clone)]
pub struct HelperControl {
    session_id: SessionId,
    context: Arc<Mutex<ControlContext>>,
    events: Sender<QueuedEvent>,
    next_sequence: Arc<AtomicU64>,
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
        if marker.as_deref() != Some(ENABLED_MARKER) {
            return if marker.is_none() {
                Ok(None)
            } else {
                Err(ControlTransportError::InvalidEnvironment)
            };
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
        thread::Builder::new()
            .name("gsv-vision-events".to_string())
            .spawn(move || write_events(&mut event_output, event_receiver))
            .map_err(|_| ControlTransportError::WorkerUnavailable)?;

        let context = Arc::new(Mutex::new(ControlContext::DISABLED));
        let command_context = Arc::clone(&context);
        thread::Builder::new()
            .name("gsv-vision-parent-watchdog".to_string())
            .spawn(move || supervise_parent_commands(session_id, command_context))
            .map_err(|_| ControlTransportError::WorkerUnavailable)?;

        Ok(Some(Self {
            session_id,
            context,
            events,
            next_sequence: Arc::new(AtomicU64::new(1)),
        }))
    }

    pub fn context(&self) -> ControlContext {
        self.context
            .lock()
            .map_or(ControlContext::DISABLED, |context| *context)
    }

    pub fn publish_lifecycle(&self, state: LifecycleState) -> bool {
        self.publish(HelperEvent::Lifecycle {
            session_id: self.session_id,
            sequence: self.take_sequence(),
            state,
        })
    }

    /// Publishes a terminal state and waits for only the complete frame write.
    /// Parent loss and pipe backpressure remain bounded so shutdown cannot hang.
    pub fn publish_terminal_lifecycle(&self, state: LifecycleState) -> bool {
        let event = HelperEvent::Lifecycle {
            session_id: self.session_id,
            sequence: self.take_sequence(),
            state,
        };
        let (completion, completed) = bounded(1);
        if self
            .events
            .send_timeout(
                QueuedEvent {
                    event,
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

    pub fn publish_intent(&self, voice_request_id: u64, intent: GestureIntent) -> bool {
        self.publish(HelperEvent::Intent {
            session_id: self.session_id,
            sequence: self.take_sequence(),
            voice_request_id,
            intent,
        })
    }

    fn publish(&self, event: HelperEvent) -> bool {
        // Gesture edges are rare and must not be silently replaced. If the
        // Desktop stops draining, bounded backpressure pauses inference in
        // this isolated helper rather than growing memory or losing SEND.
        self.events
            .send(QueuedEvent {
                event,
                completion: None,
            })
            .is_ok()
    }

    fn take_sequence(&self) -> u64 {
        self.next_sequence.fetch_add(1, Ordering::Relaxed)
    }
}

fn write_events(output: &mut impl Write, events: crossbeam_channel::Receiver<QueuedEvent>) {
    for queued in events {
        let written = write_frame(output, &queued.event).is_ok();
        if let Some(completion) = queued.completion {
            let _ = completion.send(written);
        }
        if !written {
            return;
        }
    }
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
        voice_request_id,
        held,
    } = command;
    if session_id != expected_session {
        return false;
    }
    let Ok(mut context) = context.lock() else {
        return false;
    };
    if context.voice_request_id != voice_request_id || context.held != held {
        context.voice_request_id = voice_request_id;
        context.held = held;
        context.revision = context.revision.wrapping_add(1).max(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

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
        let mut event_output = output.clone();
        let writer = thread::spawn(move || write_events(&mut event_output, event_receiver));
        let control = HelperControl {
            session_id: SESSION,
            context: Arc::new(Mutex::new(ControlContext::DISABLED)),
            events,
            next_sequence: Arc::new(AtomicU64::new(1)),
        };

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
            read_frame::<HelperEvent>(&mut input).expect("terminal frame reads"),
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
    fn context_is_session_fenced_and_revisioned_only_on_change() {
        let context = Mutex::new(ControlContext::DISABLED);
        let listening = DesktopCommand::set_context(SESSION, Some(17), false).expect("context");
        assert!(apply_context_command(SESSION, &context, listening));
        assert_eq!(
            *context.lock().expect("context"),
            ControlContext {
                voice_request_id: Some(17),
                held: false,
                revision: 1,
            }
        );
        assert!(apply_context_command(SESSION, &context, listening));
        assert_eq!(context.lock().expect("context").revision, 1);

        let held = DesktopCommand::set_context(SESSION, Some(17), true).expect("held context");
        assert!(apply_context_command(SESSION, &context, held));
        assert_eq!(context.lock().expect("context").revision, 2);

        let wrong = DesktopCommand::set_context(SessionId::new(8, 9), None, false)
            .expect("disabled context");
        assert!(!apply_context_command(SESSION, &context, wrong));
    }
}
