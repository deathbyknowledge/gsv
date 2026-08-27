mod camera;
mod control_transport;
mod debug_window;
mod embedded_models;
mod overlay;

use std::env;
use std::error::Error as StdError;
use std::ffi::OsStr;
use std::fmt::{self, Display, Formatter};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError, TrySendError};
use gesture_engine::control::{
    ControlChord, ControlDiagnostic, ControlState, HandPreference, VoiceControlPolicy,
};
use gesture_engine::observation::{FrameView, Observation};
use gesture_engine::vision::{ModelData, TractHandTracker};
use gesture_protocol::{
    ControlStatus, GestureCandidate, GestureContext, GestureProgress, ScrollState,
};

use crate::camera::{CameraConfig, CameraError, CameraFailure, CameraStream, FrameReader};
use crate::control_transport::{ControlContext, HelperControl};
use crate::debug_window::{DebugWindow, DebugWindowConfig};
use crate::overlay::ControlPresentationDiagnostic;

const PARENT_STDIN_WATCHDOG: &str = "GSV_VISION_PARENT_STDIN";
const DEBUG_WINDOW_MARKER: &str = "GSV_VISION_DEBUG_WINDOW";
const DOMINANT_HAND: &str = "GSV_GESTURE_DOMINANT_HAND";
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const INFERENCE_POLL: Duration = Duration::from_millis(100);
const CONTROL_STATUS_HEARTBEAT: Duration = Duration::from_millis(500);
const ANNOTATED_PRESENTATION_FRESHNESS: Duration = Duration::from_secs(1);
const MAX_CAMERA_INDEX: u32 = 63;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VisionError {
    InvalidCamera,
    InvalidDominantHand,
    CameraPermissionDenied,
    CameraUnavailable(CameraFailure),
    CameraStopped(Option<CameraFailure>),
    WindowUnavailable,
    InferenceUnavailable,
    WorkerUnavailable,
    ProtocolUnavailable,
}

impl Display for VisionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        if let Self::CameraUnavailable(failure) = self {
            return write!(formatter, "the local camera could not be opened: {failure}");
        }
        if let Self::CameraStopped(Some(failure)) = self {
            return write!(
                formatter,
                "the local camera stopped producing frames: {failure}"
            );
        }
        formatter.write_str(match self {
            Self::InvalidCamera => "GSV_VISION_CAMERA must be a camera index from 0 through 63",
            Self::InvalidDominantHand => "GSV_GESTURE_DOMINANT_HAND must be auto, left, or right",
            Self::CameraPermissionDenied => "camera permission was not granted",
            Self::CameraUnavailable(_) => "the local camera could not be opened",
            Self::CameraStopped(_) => "the local camera stopped producing frames",
            Self::WindowUnavailable => "the local gesture debug window is unavailable",
            Self::InferenceUnavailable => "local gesture inference failed",
            Self::WorkerUnavailable => "the local gesture inference worker could not start",
            Self::ProtocolUnavailable => "the local gesture control channel is unavailable",
        })
    }
}

impl StdError for VisionError {}

struct AnnotatedFrame {
    frame: Arc<FrameView>,
    observation: Observation,
    control_status: ControlStatus,
    control_diagnostic: ControlDiagnostic,
    scroll_state: ScrollState,
}

struct InferenceWorkerConfig {
    models: ModelData<'static>,
    hand_preference: HandPreference,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ControlPresentation {
    status: ControlStatus,
    diagnostic: ControlPresentationDiagnostic,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("gsv-vision: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), VisionError> {
    let supervised = parent_watchdog_enabled(env::var_os(PARENT_STDIN_WATCHDOG).as_deref());
    let control =
        HelperControl::start_from_environment().map_err(|_| VisionError::ProtocolUnavailable)?;
    if supervised != control.is_some() {
        return Err(VisionError::ProtocolUnavailable);
    }
    let debug_window =
        !supervised || exact_marker_enabled(env::var_os(DEBUG_WINDOW_MARKER).as_deref());
    let outcome = run_pipeline(control.clone(), debug_window);
    if let (Some(control), Err(error)) = (&control, outcome) {
        let _ = control.publish_terminal_lifecycle(error.lifecycle_state());
    }
    outcome
}

fn run_pipeline(control: Option<HelperControl>, debug_window: bool) -> Result<(), VisionError> {
    let models = embedded_models::embedded_models();
    let camera_index = parse_camera_index(env::var_os("GSV_VISION_CAMERA").as_deref())?;
    let hand_preference = parse_hand_preference(env::var_os(DOMINANT_HAND).as_deref())?;

    let camera = CameraStream::open(CameraConfig {
        index: camera_index,
        ..CameraConfig::default()
    })
    .map_err(VisionError::from)?;
    let reader = camera.reader();
    let stop = Arc::new(AtomicBool::new(false));
    let (annotated_sender, annotated_receiver) = bounded(1);
    let replacement_receiver = annotated_receiver.clone();
    let (failure_sender, failure_receiver) = bounded(1);
    let worker_stop = Arc::clone(&stop);
    let worker_reader = reader.clone();
    let worker_control = control.clone();
    let worker = thread::Builder::new()
        .name("gsv-vision-inference".to_string())
        .spawn(move || {
            inference_worker(
                InferenceWorkerConfig {
                    models,
                    hand_preference,
                },
                worker_reader,
                worker_stop,
                annotated_sender,
                replacement_receiver,
                failure_sender,
                worker_control,
            );
        })
        .map_err(|_| VisionError::WorkerUnavailable)?;

    let outcome = if debug_window {
        run_window(&reader, &annotated_receiver, &failure_receiver)
    } else {
        run_headless(&failure_receiver)
    };
    stop.store(true, Ordering::Release);
    camera.request_stop();
    let _ = camera.shutdown();
    // Native inference is not uniformly interruptible. Dropping the handle
    // detaches it; returning from this helper process remains the hard bound.
    drop(worker);
    if outcome.is_ok() {
        if let Some(control) = &control {
            let _ = control.publish_terminal_lifecycle(gesture_protocol::LifecycleState::Stopped);
        }
    }
    outcome
}

fn parent_watchdog_enabled(value: Option<&OsStr>) -> bool {
    exact_marker_enabled(value)
}

fn exact_marker_enabled(value: Option<&OsStr>) -> bool {
    value == Some(OsStr::new("1"))
}

fn run_headless(failure_receiver: &Receiver<VisionError>) -> Result<(), VisionError> {
    Err(failure_receiver
        .recv()
        .unwrap_or(VisionError::InferenceUnavailable))
}

fn run_window(
    reader: &FrameReader,
    annotated_receiver: &Receiver<AnnotatedFrame>,
    failure_receiver: &Receiver<VisionError>,
) -> Result<(), VisionError> {
    let first = reader
        .wait_latest(0, FIRST_FRAME_TIMEOUT)
        .ok_or_else(|| VisionError::CameraStopped(reader.stats().failure))?;
    let mut raw_frame = first.frame;
    let mut raw_sequence = raw_frame.sequence;
    let mut annotated: Option<AnnotatedFrame> = None;
    let mut window = DebugWindow::new(DebugWindowConfig::default())
        .map_err(|_| VisionError::WindowUnavailable)?;

    while window.is_open() && !window.should_close() {
        match failure_receiver.try_recv() {
            Ok(error) => return Err(error),
            Err(TryRecvError::Disconnected) => return Err(VisionError::InferenceUnavailable),
            Err(TryRecvError::Empty) => {}
        }

        for next in annotated_receiver.try_iter() {
            annotated = Some(next);
        }
        if annotated.is_none() {
            if let Some(next) = reader.try_latest(raw_sequence) {
                raw_sequence = next.frame.sequence;
                raw_frame = next.frame;
            }
        }

        let stats = reader.stats();
        if stats.failure.is_some() {
            return Err(VisionError::CameraStopped(stats.failure));
        }
        let presentation_at = Instant::now();
        let (frame, observation, control_status, control_diagnostic, scroll_state) =
            match annotated.as_ref() {
                Some(annotated) => {
                    let presentation = control_presentation(
                        annotated.control_status,
                        annotated.control_diagnostic,
                        annotated.observation.observed_at,
                        presentation_at,
                    );
                    (
                        &*annotated.frame,
                        Some(&annotated.observation),
                        presentation.status,
                        presentation.diagnostic,
                        if matches!(
                            presentation.diagnostic,
                            ControlPresentationDiagnostic::AwaitingFreshObservation
                        ) {
                            ScrollState::Idle
                        } else {
                            annotated.scroll_state
                        },
                    )
                }
                None => (
                    &*raw_frame,
                    None,
                    ControlStatus::Disabled { progress: None },
                    ControlPresentationDiagnostic::Controller(ControlDiagnostic::AwaitingPose),
                    ScrollState::Idle,
                ),
            };
        window
            .render(
                frame,
                observation,
                control_status,
                control_diagnostic,
                scroll_state,
                &stats,
            )
            .map_err(|_| VisionError::WindowUnavailable)?;
    }
    Ok(())
}

fn control_presentation(
    status: ControlStatus,
    diagnostic: ControlDiagnostic,
    observed_at: Instant,
    presentation_at: Instant,
) -> ControlPresentation {
    let stale = presentation_at
        .checked_duration_since(observed_at)
        .is_none_or(|age| age > ANNOTATED_PRESENTATION_FRESHNESS);
    if !stale {
        return ControlPresentation {
            status,
            diagnostic: ControlPresentationDiagnostic::Controller(diagnostic),
        };
    }

    let status = match status {
        ControlStatus::Disarmed { .. } => ControlStatus::Disarmed { progress: None },
        ControlStatus::Disabled { .. } => ControlStatus::Disabled { progress: None },
        ControlStatus::Standby { .. } => ControlStatus::Standby { progress: None },
        ControlStatus::Active {
            voice_request_id,
            muted,
            ..
        } => ControlStatus::Active {
            voice_request_id,
            muted,
            progress: None,
        },
    };
    ControlPresentation {
        status,
        diagnostic: ControlPresentationDiagnostic::AwaitingFreshObservation,
    }
}

fn inference_worker(
    config: InferenceWorkerConfig,
    reader: FrameReader,
    stop: Arc<AtomicBool>,
    output: Sender<AnnotatedFrame>,
    replacement_receiver: Receiver<AnnotatedFrame>,
    failure: Sender<VisionError>,
    control_link: Option<HelperControl>,
) {
    let Ok(mut recognizer) = TractHandTracker::load(&config.models) else {
        let _ = failure.try_send(VisionError::InferenceUnavailable);
        return;
    };
    let mut last_sequence = 0;
    let first_frame_started = Instant::now();
    let mut ready_published = false;
    let mut first_capture = None;
    let mut last_timestamp = None;
    let mut gesture_policy = VoiceControlPolicy::with_preference(
        GestureContext::Disabled.into(),
        config.hand_preference,
    );
    let mut control_revision = 0;
    let mut published_control_status = None;
    while !stop.load(Ordering::Acquire) {
        let Some(delivery) = reader.wait_latest(last_sequence, INFERENCE_POLL) else {
            let stats = reader.stats();
            if stats.failure.is_some()
                || !stats.running
                || first_frame_timed_out(last_sequence, first_frame_started, Instant::now())
            {
                let _ = failure.try_send(VisionError::CameraStopped(stats.failure));
                return;
            }
            continue;
        };
        last_sequence = delivery.frame.sequence;
        let timestamp = video_timestamp_ms(
            delivery.frame.captured_at,
            &mut first_capture,
            &mut last_timestamp,
        );
        let Ok(observation) = recognizer.recognize(&delivery.frame, timestamp) else {
            let _ = failure.try_send(VisionError::InferenceUnavailable);
            return;
        };
        if !ready_published {
            if let Some(control) = &control_link {
                if !control.publish_lifecycle(gesture_protocol::LifecycleState::Ready) {
                    let _ = failure.try_send(VisionError::ProtocolUnavailable);
                    return;
                }
            }
            ready_published = true;
        }
        let (context_revision, control_status, control_diagnostic, scroll_state, scroll_update) =
            if let Some(control_link) = &control_link {
                match control_link.context() {
                    ControlContext::Uninitialized => (
                        None,
                        ControlStatus::Disabled { progress: None },
                        ControlDiagnostic::AwaitingPose,
                        ScrollState::Idle,
                        None,
                    ),
                    ControlContext::Authoritative { revision, gesture } => {
                        let synchronized_scroll = sync_control_context(
                            &mut gesture_policy,
                            &mut control_revision,
                            revision,
                            gesture,
                        );
                        let policy_output = gesture_policy.observe(&delivery.frame, &observation);
                        if let Some(intent) = policy_output.intent {
                            if !control_link.publish_intent(intent.into()) {
                                let _ = failure.try_send(VisionError::ProtocolUnavailable);
                                return;
                            }
                        }
                        (
                            Some(revision),
                            control_status(&gesture_policy, delivery.frame.captured_at),
                            policy_output.diagnostic,
                            policy_output.scroll_state.into(),
                            policy_output
                                .scroll_update
                                .map(Into::into)
                                .or(synchronized_scroll),
                        )
                    }
                }
            } else {
                (
                    None,
                    ControlStatus::Disabled { progress: None },
                    ControlDiagnostic::AwaitingPose,
                    ScrollState::Idle,
                    None,
                )
            };
        let publish_at = Instant::now();
        if let (Some(control_link), Some(context_revision)) = (&control_link, context_revision) {
            if control_status_publish_due(
                published_control_status,
                context_revision,
                control_status,
                publish_at,
            ) {
                // Explanatory snapshots are replace-latest and never wait for
                // the event writer. A repeated snapshot only lets a resumed UI
                // recover presentation; it is neither an action nor liveness.
                // Intent edges above retain their reliable bounded path.
                let _ = control_link.publish_status(control_status);
                published_control_status = Some((context_revision, control_status, publish_at));
            }
            if let Some(state) = scroll_update {
                if !control_link.publish_scroll(state) {
                    let _ = failure.try_send(VisionError::ProtocolUnavailable);
                    return;
                }
            }
        }
        let annotated = AnnotatedFrame {
            frame: delivery.frame,
            observation,
            control_status,
            control_diagnostic,
            scroll_state,
        };
        if !publish_latest(&output, &replacement_receiver, annotated) {
            return;
        }
    }
}

fn first_frame_timed_out(last_sequence: u64, started_at: Instant, checked_at: Instant) -> bool {
    last_sequence == 0 && checked_at.saturating_duration_since(started_at) >= FIRST_FRAME_TIMEOUT
}

fn sync_control_context(
    policy: &mut VoiceControlPolicy,
    current_revision: &mut u64,
    revision: u64,
    gesture: GestureContext,
) -> Option<ScrollState> {
    if revision != *current_revision {
        let state = gesture.into();
        let scroll_state = policy.synchronize_state(state).map(Into::into);
        *current_revision = revision;
        return scroll_state;
    }
    None
}

fn control_status(policy: &VoiceControlPolicy, now: Instant) -> ControlStatus {
    let progress = control_progress(policy, now);
    match policy.state() {
        ControlState::Disarmed => ControlStatus::Disarmed { progress },
        ControlState::Disabled => ControlStatus::Disabled { progress },
        ControlState::Standby => ControlStatus::Standby { progress },
        ControlState::Active {
            voice_request_id,
            muted,
        } => ControlStatus::Active {
            voice_request_id,
            muted,
            progress,
        },
    }
}

fn control_progress(policy: &VoiceControlPolicy, now: Instant) -> Option<GestureProgress> {
    let progress = policy.progress(now)?;
    let candidate = gesture_candidate(policy.state(), progress.chord)?;
    GestureProgress::new(candidate, progress.progress_permille).ok()
}

fn gesture_candidate(state: ControlState, chord: ControlChord) -> Option<GestureCandidate> {
    let candidate = match chord {
        ControlChord::Arm => GestureCandidate::Arm,
        ControlChord::Disarm => GestureCandidate::Disarm,
        ControlChord::StartTranscription => GestureCandidate::StartTranscription,
        ControlChord::StopTranscription => GestureCandidate::StopTranscription,
        ControlChord::Send => GestureCandidate::Send,
        ControlChord::DeleteBackward => GestureCandidate::DeleteBackward,
        ControlChord::ClearDictation => GestureCandidate::ClearDictation,
        ControlChord::Mute => GestureCandidate::Mute,
        ControlChord::Unmute => GestureCandidate::Unmute,
        ControlChord::Scroll => return None,
    };
    GestureProgress::new(candidate, 0)
        .expect("zero is bounded")
        .is_compatible_with(state.into())
        .then_some(candidate)
}

fn control_status_publish_due(
    previous: Option<(u64, ControlStatus, Instant)>,
    context_revision: u64,
    current: ControlStatus,
    now: Instant,
) -> bool {
    previous.is_none_or(|(previous_revision, previous, published_at)| {
        previous_revision != context_revision
            || previous != current
            || now.saturating_duration_since(published_at) >= CONTROL_STATUS_HEARTBEAT
    })
}

impl VisionError {
    fn lifecycle_state(self) -> gesture_protocol::LifecycleState {
        match self {
            Self::InvalidCamera | Self::CameraPermissionDenied | Self::CameraUnavailable(_) => {
                gesture_protocol::LifecycleState::CameraUnavailable
            }
            Self::InvalidDominantHand => gesture_protocol::LifecycleState::ProtocolError,
            Self::CameraStopped(_) => gesture_protocol::LifecycleState::CameraStopped,
            Self::WindowUnavailable => gesture_protocol::LifecycleState::WindowUnavailable,
            Self::InferenceUnavailable => gesture_protocol::LifecycleState::InferenceUnavailable,
            Self::WorkerUnavailable => gesture_protocol::LifecycleState::WorkerUnavailable,
            Self::ProtocolUnavailable => gesture_protocol::LifecycleState::ProtocolError,
        }
    }
}

impl From<CameraError> for VisionError {
    fn from(error: CameraError) -> Self {
        match error {
            CameraError::PermissionDenied => Self::CameraPermissionDenied,
            CameraError::Open(failure) => Self::CameraUnavailable(failure),
            CameraError::InvalidConfig(_) | CameraError::Spawn | CameraError::WorkerPanicked => {
                Self::CameraUnavailable(CameraFailure::Initialization)
            }
        }
    }
}

fn publish_latest(
    output: &Sender<AnnotatedFrame>,
    replacement_receiver: &Receiver<AnnotatedFrame>,
    mut value: AnnotatedFrame,
) -> bool {
    loop {
        match output.try_send(value) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(returned)) => {
                value = returned;
                let _ = replacement_receiver.try_recv();
            }
        }
    }
}

fn video_timestamp_ms(
    captured_at: Instant,
    first_capture: &mut Option<Instant>,
    previous: &mut Option<i64>,
) -> i64 {
    let origin = *first_capture.get_or_insert(captured_at);
    let elapsed = captured_at.saturating_duration_since(origin).as_millis();
    let measured = i64::try_from(elapsed).unwrap_or(i64::MAX);
    let timestamp = previous.map_or(measured, |previous| {
        measured.max(previous.saturating_add(1))
    });
    *previous = Some(timestamp);
    timestamp
}

fn parse_camera_index(value: Option<&OsStr>) -> Result<Option<u32>, VisionError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let parsed = value
        .to_str()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value <= MAX_CAMERA_INDEX)
        .ok_or(VisionError::InvalidCamera)?;
    Ok(Some(parsed))
}

fn parse_hand_preference(value: Option<&OsStr>) -> Result<HandPreference, VisionError> {
    match value {
        None => Ok(HandPreference::Right),
        Some(value) if value == OsStr::new("auto") => Ok(HandPreference::Auto),
        Some(value) if value == OsStr::new("left") => Ok(HandPreference::Left),
        Some(value) if value == OsStr::new("right") => Ok(HandPreference::Right),
        Some(_) => Err(VisionError::InvalidDominantHand),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gesture_engine::observation::{HandObservation, HandPose, Handedness, Landmark};

    const ACTIVE: ControlState = ControlState::Active {
        voice_request_id: 12,
        muted: false,
    };

    fn test_frame(sequence: u64, captured_at: Instant) -> FrameView {
        FrameView {
            sequence,
            captured_at,
            width: 1,
            height: 1,
            rgb: Arc::from([0_u8, 0, 0]),
        }
    }

    #[test]
    fn camera_index_is_bounded_and_exact() {
        assert_eq!(parse_camera_index(None), Ok(None));
        assert_eq!(parse_camera_index(Some(OsStr::new("7"))), Ok(Some(7)));
        assert_eq!(
            parse_camera_index(Some(OsStr::new("64"))),
            Err(VisionError::InvalidCamera)
        );
        assert_eq!(
            parse_camera_index(Some(OsStr::new("camera 1"))),
            Err(VisionError::InvalidCamera)
        );
    }

    #[test]
    fn dominant_hand_is_explicit_and_defaults_to_right() {
        assert_eq!(parse_hand_preference(None), Ok(HandPreference::Right));
        assert_eq!(
            parse_hand_preference(Some(OsStr::new("auto"))),
            Ok(HandPreference::Auto)
        );
        assert_eq!(
            parse_hand_preference(Some(OsStr::new("left"))),
            Ok(HandPreference::Left)
        );
        assert_eq!(
            parse_hand_preference(Some(OsStr::new("right"))),
            Ok(HandPreference::Right)
        );
        assert_eq!(
            parse_hand_preference(Some(OsStr::new("Left"))),
            Err(VisionError::InvalidDominantHand)
        );
    }

    #[test]
    fn camera_permission_failure_is_actionable_but_keeps_the_camera_lifecycle() {
        let error = VisionError::from(CameraError::PermissionDenied);
        assert_eq!(error, VisionError::CameraPermissionDenied);
        assert_eq!(error.to_string(), "camera permission was not granted");
        assert_eq!(
            error.lifecycle_state(),
            gesture_protocol::LifecycleState::CameraUnavailable
        );
    }

    #[test]
    fn camera_startup_failure_keeps_a_bounded_diagnostic() {
        let error = VisionError::from(CameraError::Open(CameraFailure::DeviceBusy));
        assert_eq!(
            error,
            VisionError::CameraUnavailable(CameraFailure::DeviceBusy)
        );
        assert_eq!(
            error.to_string(),
            "the local camera could not be opened: device is already in use"
        );
        assert_eq!(
            error.lifecycle_state(),
            gesture_protocol::LifecycleState::CameraUnavailable
        );
    }

    #[test]
    fn parent_watchdog_requires_the_supervisor_marker() {
        assert!(!parent_watchdog_enabled(None));
        assert!(!parent_watchdog_enabled(Some(OsStr::new("true"))));
        assert!(parent_watchdog_enabled(Some(OsStr::new("1"))));
    }

    #[test]
    fn debug_window_is_an_exact_opt_in_for_supervised_runs() {
        assert!(!exact_marker_enabled(None));
        assert!(!exact_marker_enabled(Some(OsStr::new("true"))));
        assert!(exact_marker_enabled(Some(OsStr::new("1"))));
    }

    #[test]
    fn video_timestamps_are_strictly_increasing() {
        let start = Instant::now();
        let mut first = None;
        let mut previous = None;
        assert_eq!(video_timestamp_ms(start, &mut first, &mut previous), 0);
        assert_eq!(video_timestamp_ms(start, &mut first, &mut previous), 1);
        assert_eq!(
            video_timestamp_ms(start + Duration::from_millis(8), &mut first, &mut previous),
            8
        );
    }

    #[test]
    fn first_frame_wait_has_the_same_hard_deadline_in_headless_mode() {
        let started_at = Instant::now();
        assert!(!first_frame_timed_out(
            0,
            started_at,
            started_at + FIRST_FRAME_TIMEOUT - Duration::from_millis(1),
        ));
        assert!(first_frame_timed_out(
            0,
            started_at,
            started_at + FIRST_FRAME_TIMEOUT,
        ));
        assert!(!first_frame_timed_out(
            1,
            started_at,
            started_at + FIRST_FRAME_TIMEOUT + Duration::from_secs(1),
        ));
    }

    #[test]
    fn context_revision_applies_strict_absolute_modes() {
        let mut policy = VoiceControlPolicy::default();
        let mut current_revision = 0;

        sync_control_context(
            &mut policy,
            &mut current_revision,
            1,
            GestureContext::Standby,
        );
        assert_eq!(policy.state(), ControlState::Standby);
        assert_eq!(current_revision, 1);

        // An unchanged revision cannot smuggle in a different request.
        sync_control_context(
            &mut policy,
            &mut current_revision,
            1,
            GestureContext::Active {
                voice_request_id: 99,
                muted: true,
            },
        );
        assert_eq!(policy.state(), ControlState::Standby);

        sync_control_context(
            &mut policy,
            &mut current_revision,
            2,
            GestureContext::Active {
                voice_request_id: 9,
                muted: true,
            },
        );
        assert_eq!(
            policy.state(),
            ControlState::Active {
                voice_request_id: 9,
                muted: true,
            }
        );
    }

    #[test]
    fn semantic_status_mirrors_all_four_authority_modes() {
        let now = Instant::now();
        let mut policy = VoiceControlPolicy::default();
        assert_eq!(
            control_status(&policy, now),
            ControlStatus::Disarmed { progress: None }
        );

        policy.synchronize_state(ControlState::Disabled);
        assert_eq!(
            control_status(&policy, now),
            ControlStatus::Disabled { progress: None }
        );

        policy.synchronize_state(ControlState::Standby);
        assert_eq!(
            control_status(&policy, now),
            ControlStatus::Standby { progress: None }
        );

        policy.synchronize_state(ACTIVE);
        assert_eq!(
            control_status(&policy, now),
            ControlStatus::Active {
                voice_request_id: 12,
                muted: false,
                progress: None,
            }
        );

        policy.synchronize_state(ControlState::Active {
            voice_request_id: 12,
            muted: true,
        });
        assert_eq!(
            control_status(&policy, now),
            ControlStatus::Active {
                voice_request_id: 12,
                muted: true,
                progress: None,
            }
        );
    }

    #[test]
    fn controller_chords_map_only_to_context_compatible_candidates() {
        use gesture_engine::control::{ControlChord, ControlState};

        let cases = [
            (
                ControlState::Disarmed,
                ControlChord::Arm,
                Some(GestureCandidate::Arm),
            ),
            (
                ControlState::Disabled,
                ControlChord::Disarm,
                Some(GestureCandidate::Disarm),
            ),
            (
                ControlState::Standby,
                ControlChord::Disarm,
                Some(GestureCandidate::Disarm),
            ),
            (ACTIVE, ControlChord::Disarm, Some(GestureCandidate::Disarm)),
            (
                ControlState::Standby,
                ControlChord::StartTranscription,
                Some(GestureCandidate::StartTranscription),
            ),
            (
                ACTIVE,
                ControlChord::StopTranscription,
                Some(GestureCandidate::StopTranscription),
            ),
            (ACTIVE, ControlChord::Send, Some(GestureCandidate::Send)),
            (
                ACTIVE,
                ControlChord::DeleteBackward,
                Some(GestureCandidate::DeleteBackward),
            ),
            (
                ACTIVE,
                ControlChord::ClearDictation,
                Some(GestureCandidate::ClearDictation),
            ),
            (ACTIVE, ControlChord::Mute, Some(GestureCandidate::Mute)),
            (
                ControlState::Active {
                    voice_request_id: 12,
                    muted: true,
                },
                ControlChord::Unmute,
                Some(GestureCandidate::Unmute),
            ),
            (
                ControlState::Disabled,
                ControlChord::StartTranscription,
                None,
            ),
            (ControlState::Standby, ControlChord::Send, None),
            (ControlState::Standby, ControlChord::DeleteBackward, None),
            (ControlState::Standby, ControlChord::ClearDictation, None),
            (
                ControlState::Active {
                    voice_request_id: 12,
                    muted: true,
                },
                ControlChord::Mute,
                None,
            ),
        ];
        for (state, chord, expected) in cases {
            assert_eq!(gesture_candidate(state, chord), expected);
        }
    }

    #[test]
    fn standby_status_carries_only_bounded_start_progress() {
        let now = Instant::now();
        let mut policy = VoiceControlPolicy::<u64>::new(ControlState::Standby);
        let frame = test_frame(1, now);
        let observation = Observation {
            frame_sequence: 1,
            observed_at: now + Duration::from_millis(20),
            hands: vec![HandObservation {
                handedness: Handedness::Right,
                handedness_score: 0.95,
                pose: HandPose::OneFinger,
                pose_score: 0.9,
                landmarks: [Landmark::default(); 21],
            }],
            inference_time: Duration::from_millis(20),
        };
        assert_eq!(policy.observe(&frame, &observation).intent, None);

        assert_eq!(
            control_status(&policy, now),
            ControlStatus::Standby {
                progress: Some(
                    GestureProgress::new(GestureCandidate::StartTranscription, 0)
                        .expect("bounded progress")
                ),
            }
        );
    }

    #[test]
    fn annotated_presentation_expires_progress_without_changing_authority() {
        let observed_at = Instant::now();
        let progress = GestureProgress::new(GestureCandidate::Send, 640).expect("bounded");
        let status = ControlStatus::Active {
            voice_request_id: 77,
            muted: false,
            progress: Some(progress),
        };
        let diagnostic = ControlDiagnostic::Stabilizing {
            chord: ControlChord::Send,
            confidence_percent: 88,
            progress_percent: 64,
        };

        assert_eq!(
            control_presentation(
                status,
                diagnostic,
                observed_at,
                observed_at + ANNOTATED_PRESENTATION_FRESHNESS,
            ),
            ControlPresentation {
                status,
                diagnostic: ControlPresentationDiagnostic::Controller(diagnostic),
            }
        );
        assert_eq!(
            control_presentation(
                status,
                diagnostic,
                observed_at,
                observed_at + ANNOTATED_PRESENTATION_FRESHNESS + Duration::from_millis(1),
            ),
            ControlPresentation {
                status: ControlStatus::Active {
                    voice_request_id: 77,
                    muted: false,
                    progress: None,
                },
                diagnostic: ControlPresentationDiagnostic::AwaitingFreshObservation,
            }
        );

        let standby = ControlStatus::Standby {
            progress: Some(
                GestureProgress::new(GestureCandidate::StartTranscription, 500).expect("bounded"),
            ),
        };
        assert_eq!(
            control_presentation(
                standby,
                diagnostic,
                observed_at,
                observed_at + ANNOTATED_PRESENTATION_FRESHNESS + Duration::from_millis(1),
            )
            .status,
            ControlStatus::Standby { progress: None }
        );
    }

    #[test]
    fn the_wrong_visible_hand_reaches_the_controller_diagnostic() {
        let captured_at = Instant::now();
        let observation = Observation {
            frame_sequence: 1,
            observed_at: captured_at + Duration::from_millis(20),
            hands: vec![HandObservation {
                handedness: Handedness::Left,
                handedness_score: 0.95,
                pose: HandPose::Fist,
                pose_score: 0.95,
                landmarks: [Landmark::default(); 21],
            }],
            inference_time: Duration::from_millis(20),
        };
        let mut policy = VoiceControlPolicy::<u64>::new(ControlState::Standby);
        let frame = test_frame(1, captured_at);
        let output = policy.observe(&frame, &observation);
        assert_eq!(output.intent, None);
        assert_eq!(output.scroll_update, None);
        assert_eq!(output.diagnostic, ControlDiagnostic::NeedActionHand);
    }

    #[test]
    fn all_authority_statuses_heartbeat() {
        let started_at = Instant::now();
        for status in [
            ControlStatus::Disarmed { progress: None },
            ControlStatus::Disabled { progress: None },
            ControlStatus::Standby { progress: None },
            ControlStatus::Active {
                voice_request_id: 12,
                muted: false,
                progress: None,
            },
        ] {
            let previous = Some((1, status, started_at));
            assert!(!control_status_publish_due(
                previous,
                1,
                status,
                started_at + CONTROL_STATUS_HEARTBEAT - Duration::from_millis(1),
            ));
            assert!(control_status_publish_due(
                previous,
                1,
                status,
                started_at + CONTROL_STATUS_HEARTBEAT,
            ));
            assert!(control_status_publish_due(
                previous,
                2,
                status,
                started_at + Duration::from_millis(1),
            ));
        }
    }
}
