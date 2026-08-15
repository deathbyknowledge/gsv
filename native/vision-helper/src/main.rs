mod camera;
mod control;
mod control_transport;
mod debug_window;
mod mediapipe;
mod observation;
mod overlay;

use std::env;
use std::error::Error as StdError;
use std::ffi::{OsStr, OsString};
use std::fmt::{self, Display, Formatter};
use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError, TrySendError};
use gsv_vision_control::{ControlStatus, GestureCandidate, GestureContext, GestureProgress};
use sha2::{Digest, Sha256};

use crate::camera::{CameraConfig, CameraStream, FrameReader};
use crate::control::{
    ControlDiagnostic, ControlHand, ControlIntent, ControlSample, GestureControl,
};
use crate::control_transport::{ControlContext, HelperControl};
use crate::debug_window::{DebugWindow, DebugWindowConfig};
use crate::mediapipe::GestureRecognizer;
use crate::observation::{FrameView, Observation};
use crate::overlay::ControlPresentationDiagnostic;

const MODEL_BYTES: u64 = 8_373_440;
const MODEL_SHA256: &str = "97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482";
const PARENT_STDIN_WATCHDOG: &str = "GSV_VISION_PARENT_STDIN";
const DEBUG_WINDOW_MARKER: &str = "GSV_VISION_DEBUG_WINDOW";
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const INFERENCE_POLL: Duration = Duration::from_millis(100);
const CONTROL_STATUS_HEARTBEAT: Duration = Duration::from_millis(500);
const ANNOTATED_PRESENTATION_FRESHNESS: Duration = Duration::from_secs(1);
const MAX_CAMERA_INDEX: u32 = 63;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VisionError {
    AssetsUnavailable,
    InvalidLibraryOverride,
    InvalidModelOverride,
    InvalidModel,
    InvalidCamera,
    CameraUnavailable,
    CameraStopped,
    WindowUnavailable,
    InferenceUnavailable,
    WorkerUnavailable,
    ProtocolUnavailable,
}

impl Display for VisionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AssetsUnavailable => "the pinned local MediaPipe artifact is unavailable",
            Self::InvalidLibraryOverride => "GSV_MEDIAPIPE_LIBRARY does not name a local file",
            Self::InvalidModelOverride => "GSV_VISION_MODEL does not name a local file",
            Self::InvalidModel => "the local gesture model failed verification",
            Self::InvalidCamera => "GSV_VISION_CAMERA must be a camera index from 0 through 63",
            Self::CameraUnavailable => "the local camera could not be opened",
            Self::CameraStopped => "the local camera stopped producing frames",
            Self::WindowUnavailable => "the local gesture debug window is unavailable",
            Self::InferenceUnavailable => "local gesture inference failed",
            Self::WorkerUnavailable => "the local gesture inference worker could not start",
            Self::ProtocolUnavailable => "the local gesture control channel is unavailable",
        })
    }
}

impl StdError for VisionError {}

struct AssetPaths {
    library: PathBuf,
    model: PathBuf,
}

struct AnnotatedFrame {
    frame: Arc<FrameView>,
    observation: Observation,
    control_status: ControlStatus,
    control_diagnostic: ControlDiagnostic,
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
    let assets = resolve_assets(
        env::var_os("GSV_MEDIAPIPE_LIBRARY"),
        env::var_os("GSV_VISION_MODEL"),
        env::current_exe().ok(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    )?;
    verify_model(&assets.model)?;
    let camera_index = parse_camera_index(env::var_os("GSV_VISION_CAMERA").as_deref())?;

    let camera = CameraStream::open(CameraConfig {
        index: camera_index,
        ..CameraConfig::default()
    })
    .map_err(|_| VisionError::CameraUnavailable)?;
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
                assets,
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
            let _ = control.publish_terminal_lifecycle(gsv_vision_control::LifecycleState::Stopped);
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
        .ok_or(VisionError::CameraStopped)?;
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
        if stats.failed {
            return Err(VisionError::CameraStopped);
        }
        let presentation_at = Instant::now();
        let (frame, observation, control_status, control_diagnostic) = match annotated.as_ref() {
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
                )
            }
            None => (
                &*raw_frame,
                None,
                ControlStatus::Disabled,
                ControlPresentationDiagnostic::Controller(ControlDiagnostic::AwaitingPose),
            ),
        };
        window
            .render(
                frame,
                observation,
                control_status,
                control_diagnostic,
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
        ControlStatus::Disabled => ControlStatus::Disabled,
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
    assets: AssetPaths,
    reader: FrameReader,
    stop: Arc<AtomicBool>,
    output: Sender<AnnotatedFrame>,
    replacement_receiver: Receiver<AnnotatedFrame>,
    failure: Sender<VisionError>,
    control_link: Option<HelperControl>,
) {
    let Ok(mut recognizer) = GestureRecognizer::load(&assets.library, &assets.model) else {
        let _ = failure.try_send(VisionError::InferenceUnavailable);
        return;
    };
    let mut last_sequence = 0;
    let first_frame_started = Instant::now();
    let mut ready_published = false;
    let mut first_capture = None;
    let mut last_timestamp = None;
    let mut gesture_control = GestureControl::default();
    let mut control_revision = 0;
    let mut published_control_status = None;
    while !stop.load(Ordering::Acquire) {
        let Some(delivery) = reader.wait_latest(last_sequence, INFERENCE_POLL) else {
            let stats = reader.stats();
            if stats.failed
                || !stats.running
                || first_frame_timed_out(last_sequence, first_frame_started, Instant::now())
            {
                let _ = failure.try_send(VisionError::CameraStopped);
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
                if !control.publish_lifecycle(gsv_vision_control::LifecycleState::Ready) {
                    let _ = failure.try_send(VisionError::ProtocolUnavailable);
                    return;
                }
            }
            ready_published = true;
        }
        let (context_revision, control_status, control_diagnostic) =
            if let Some(control_link) = &control_link {
                match control_link.context() {
                    ControlContext::Uninitialized => (
                        None,
                        ControlStatus::Disabled,
                        ControlDiagnostic::AwaitingPose,
                    ),
                    ControlContext::Authoritative { revision, gesture } => {
                        sync_control_context(
                            &mut gesture_control,
                            &mut control_revision,
                            revision,
                            gesture,
                        );
                        if let Some(intent) = observe_control(
                            &mut gesture_control,
                            &observation,
                            delivery.frame.captured_at,
                        ) {
                            if !control_link.publish_intent(intent) {
                                let _ = failure.try_send(VisionError::ProtocolUnavailable);
                                return;
                            }
                        }
                        (
                            Some(revision),
                            control_status(&gesture_control, delivery.frame.captured_at),
                            gesture_control.diagnostic(),
                        )
                    }
                }
            } else {
                (
                    None,
                    ControlStatus::Disabled,
                    ControlDiagnostic::AwaitingPose,
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
        }
        let annotated = AnnotatedFrame {
            frame: delivery.frame,
            observation,
            control_status,
            control_diagnostic,
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
    control: &mut GestureControl,
    current_revision: &mut u64,
    revision: u64,
    gesture: GestureContext,
) {
    if revision != *current_revision {
        control.synchronize_state(gesture);
        *current_revision = revision;
    }
}

fn control_status(control: &GestureControl, now: Instant) -> ControlStatus {
    let progress = control_progress(control, now);
    match control.state() {
        GestureContext::Disabled => ControlStatus::Disabled,
        GestureContext::Standby => ControlStatus::Standby { progress },
        GestureContext::Active {
            voice_request_id,
            muted,
        } => ControlStatus::Active {
            voice_request_id,
            muted,
            progress,
        },
    }
}

fn control_progress(control: &GestureControl, now: Instant) -> Option<GestureProgress> {
    let progress = control.progress(now)?;
    let candidate = gesture_candidate(control.state(), progress.chord)?;
    GestureProgress::new(candidate, progress.progress_permille).ok()
}

fn gesture_candidate(
    state: crate::control::ControlState,
    chord: crate::control::ControlChord,
) -> Option<GestureCandidate> {
    let candidate = match chord {
        crate::control::ControlChord::StartTranscription => GestureCandidate::StartTranscription,
        crate::control::ControlChord::StopTranscription => GestureCandidate::StopTranscription,
        crate::control::ControlChord::Send => GestureCandidate::Send,
        crate::control::ControlChord::Mute => GestureCandidate::Mute,
        crate::control::ControlChord::Unmute => GestureCandidate::Unmute,
    };
    GestureProgress::new(candidate, 0)
        .expect("zero is bounded")
        .is_compatible_with(state)
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
            || matches!(
                current,
                ControlStatus::Standby { .. } | ControlStatus::Active { .. }
            ) && now.saturating_duration_since(published_at) >= CONTROL_STATUS_HEARTBEAT
    })
}

fn observe_control(
    control: &mut GestureControl,
    observation: &Observation,
    captured_at: Instant,
) -> Option<ControlIntent> {
    match observation.hands.as_slice() {
        [first, second] => {
            let hands = [
                ControlHand::new(&first.gesture, first.gesture_score),
                ControlHand::new(&second.gesture, second.gesture_score),
            ];
            control.observe(ControlSample {
                frame_sequence: observation.frame_sequence,
                captured_at,
                observed_at: observation.observed_at,
                hands: &hands,
            })
        }
        [hand] => {
            let hands = [ControlHand::new(&hand.gesture, hand.gesture_score)];
            control.observe(ControlSample {
                frame_sequence: observation.frame_sequence,
                captured_at,
                observed_at: observation.observed_at,
                hands: &hands,
            })
        }
        _ => control.observe(ControlSample {
            frame_sequence: observation.frame_sequence,
            captured_at,
            observed_at: observation.observed_at,
            hands: &[],
        }),
    }
}

impl VisionError {
    fn lifecycle_state(self) -> gsv_vision_control::LifecycleState {
        match self {
            Self::AssetsUnavailable
            | Self::InvalidLibraryOverride
            | Self::InvalidModelOverride
            | Self::InvalidModel => gsv_vision_control::LifecycleState::AssetsUnavailable,
            Self::InvalidCamera | Self::CameraUnavailable => {
                gsv_vision_control::LifecycleState::CameraUnavailable
            }
            Self::CameraStopped => gsv_vision_control::LifecycleState::CameraStopped,
            Self::WindowUnavailable => gsv_vision_control::LifecycleState::WindowUnavailable,
            Self::InferenceUnavailable => gsv_vision_control::LifecycleState::InferenceUnavailable,
            Self::WorkerUnavailable => gsv_vision_control::LifecycleState::WorkerUnavailable,
            Self::ProtocolUnavailable => gsv_vision_control::LifecycleState::ProtocolError,
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

fn parse_camera_index(value: Option<&OsStr>) -> Result<u32, VisionError> {
    let Some(value) = value else {
        return Ok(0);
    };
    let parsed = value
        .to_str()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value <= MAX_CAMERA_INDEX)
        .ok_or(VisionError::InvalidCamera)?;
    Ok(parsed)
}

fn resolve_assets(
    library_override: Option<OsString>,
    model_override: Option<OsString>,
    current_executable: Option<PathBuf>,
    manifest_dir: &Path,
) -> Result<AssetPaths, VisionError> {
    let (library_candidates, model_candidates) = asset_candidates(current_executable, manifest_dir);
    let library = resolve_asset(
        library_override,
        &library_candidates,
        VisionError::InvalidLibraryOverride,
    )?;
    let model = resolve_asset(
        model_override,
        &model_candidates,
        VisionError::InvalidModelOverride,
    )?;
    Ok(AssetPaths { library, model })
}

fn resolve_asset(
    explicit: Option<OsString>,
    candidates: &[PathBuf],
    invalid_override: VisionError,
) -> Result<PathBuf, VisionError> {
    if let Some(explicit) = explicit {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path).ok_or(invalid_override);
    }
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
        .ok_or(VisionError::AssetsUnavailable)
}

fn asset_candidates(
    current_executable: Option<PathBuf>,
    manifest_dir: &Path,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let library_name = if cfg!(target_os = "macos") {
        "libgesture_recognizer.dylib"
    } else {
        "libgesture_recognizer.so"
    };
    let model_name = "gesture_recognizer.task";
    let mut libraries = Vec::new();
    let mut models = Vec::new();
    if let Some(parent) = current_executable.as_deref().and_then(Path::parent) {
        libraries.push(parent.join(library_name));
        libraries.push(parent.join("lib").join(library_name));
        models.push(parent.join(model_name));
        models.push(parent.join("model").join(model_name));
    }

    if let Some(workspace_root) = manifest_dir.parent().and_then(Path::parent) {
        if let Some(artifact_name) = development_artifact_name() {
            let artifact = workspace_root
                .join("target/vision-mediapipe/artifact")
                .join(artifact_name);
            libraries.push(artifact.join("lib").join(library_name));
            models.push(artifact.join("model").join(model_name));
        }
    }
    (libraries, models)
}

fn development_artifact_name() -> Option<&'static str> {
    match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x86_64-mediapipe-1.0.0"),
        _ => None,
    }
}

fn verify_model(path: &Path) -> Result<(), VisionError> {
    let file = File::open(path).map_err(|_| VisionError::InvalidModel)?;
    if file
        .metadata()
        .map_err(|_| VisionError::InvalidModel)?
        .len()
        != MODEL_BYTES
    {
        return Err(VisionError::InvalidModel);
    }
    if digest_hex(BufReader::new(file)).map_err(|_| VisionError::InvalidModel)? != MODEL_SHA256 {
        return Err(VisionError::InvalidModel);
    }
    Ok(())
}

fn digest_hex(mut input: impl Read) -> io::Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    const ACTIVE: GestureContext = GestureContext::Active {
        voice_request_id: 12,
        muted: false,
    };

    #[test]
    fn camera_index_is_bounded_and_exact() {
        assert_eq!(parse_camera_index(None), Ok(0));
        assert_eq!(parse_camera_index(Some(OsStr::new("7"))), Ok(7));
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
    fn digest_is_streamed_and_stable() {
        assert_eq!(
            digest_hex(Cursor::new(b"abc")).expect("hash input"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
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
    fn known_development_artifact_is_architecture_specific() {
        assert_eq!(
            development_artifact_name().is_some(),
            env::consts::OS == "linux" && env::consts::ARCH == "x86_64"
        );
    }

    #[test]
    fn context_revision_applies_strict_absolute_modes() {
        let mut control = GestureControl::default();
        let mut current_revision = 0;

        sync_control_context(
            &mut control,
            &mut current_revision,
            1,
            GestureContext::Standby,
        );
        assert_eq!(control.state(), GestureContext::Standby);
        assert_eq!(current_revision, 1);

        // An unchanged revision cannot smuggle in a different request.
        sync_control_context(
            &mut control,
            &mut current_revision,
            1,
            GestureContext::Active {
                voice_request_id: 99,
                muted: true,
            },
        );
        assert_eq!(control.state(), GestureContext::Standby);

        sync_control_context(
            &mut control,
            &mut current_revision,
            2,
            GestureContext::Active {
                voice_request_id: 9,
                muted: true,
            },
        );
        assert_eq!(
            control.state(),
            GestureContext::Active {
                voice_request_id: 9,
                muted: true,
            }
        );
    }

    #[test]
    fn semantic_status_mirrors_all_three_authority_modes() {
        let now = Instant::now();
        let mut control = GestureControl::default();
        assert_eq!(control_status(&control, now), ControlStatus::Disabled);

        control.synchronize_state(GestureContext::Standby);
        assert_eq!(
            control_status(&control, now),
            ControlStatus::Standby { progress: None }
        );

        control.synchronize_state(ACTIVE);
        assert_eq!(
            control_status(&control, now),
            ControlStatus::Active {
                voice_request_id: 12,
                muted: false,
                progress: None,
            }
        );

        control.synchronize_state(GestureContext::Active {
            voice_request_id: 12,
            muted: true,
        });
        assert_eq!(
            control_status(&control, now),
            ControlStatus::Active {
                voice_request_id: 12,
                muted: true,
                progress: None,
            }
        );
    }

    #[test]
    fn controller_chords_map_only_to_context_compatible_candidates() {
        use crate::control::{ControlChord, ControlState};

        let cases = [
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
            (ACTIVE, ControlChord::Mute, Some(GestureCandidate::Mute)),
            (
                GestureContext::Active {
                    voice_request_id: 12,
                    muted: true,
                },
                ControlChord::Unmute,
                Some(GestureCandidate::Unmute),
            ),
            (
                GestureContext::Disabled,
                ControlChord::StartTranscription,
                None,
            ),
            (ControlState::Standby, ControlChord::Send, None),
            (
                GestureContext::Active {
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
        let mut control = GestureControl::new(GestureContext::Standby);
        let hands = [
            ControlHand::new("Open_Palm", 0.9),
            ControlHand::new("Open_Palm", 0.9),
        ];
        assert_eq!(
            control.observe(ControlSample {
                frame_sequence: 1,
                captured_at: now,
                observed_at: now + Duration::from_millis(20),
                hands: &hands,
            }),
            None
        );

        assert_eq!(
            control_status(&control, now),
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
            chord: crate::control::ControlChord::Send,
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
    fn one_visible_hand_reaches_the_controller_diagnostic() {
        use crate::observation::{HandObservation, Handedness, Landmark};

        let captured_at = Instant::now();
        let observation = Observation {
            frame_sequence: 1,
            observed_at: captured_at + Duration::from_millis(20),
            hands: vec![HandObservation {
                handedness: Handedness::Left,
                handedness_score: 0.95,
                gesture: "Open_Palm".to_string(),
                gesture_score: 0.95,
                landmarks: [Landmark::default(); 21],
            }],
            inference_time: Duration::from_millis(20),
        };
        let mut control = GestureControl::new(GestureContext::Standby);

        assert_eq!(
            observe_control(&mut control, &observation, captured_at),
            None
        );
        assert_eq!(
            control.diagnostic(),
            ControlDiagnostic::NeedTwoHands { detected: 1 }
        );
    }

    #[test]
    fn actionable_statuses_heartbeat_but_disabled_does_not() {
        let started_at = Instant::now();
        for status in [
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

        let disabled = Some((3, ControlStatus::Disabled, started_at));
        assert!(!control_status_publish_due(
            disabled,
            3,
            ControlStatus::Disabled,
            started_at + CONTROL_STATUS_HEARTBEAT + Duration::from_secs(5),
        ));
        assert!(control_status_publish_due(
            disabled,
            3,
            ControlStatus::Standby { progress: None },
            started_at + Duration::from_millis(1),
        ));
    }
}
