mod camera;
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
use std::process::{self, ExitCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError, TrySendError};
use sha2::{Digest, Sha256};

use crate::camera::{CameraConfig, CameraStream, FrameReader};
use crate::debug_window::{DebugWindow, DebugWindowConfig};
use crate::mediapipe::GestureRecognizer;
use crate::observation::{FrameView, Observation};

const MODEL_BYTES: u64 = 8_373_440;
const MODEL_SHA256: &str = "97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482";
const PARENT_STDIN_WATCHDOG: &str = "GSV_VISION_PARENT_STDIN";
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const INFERENCE_POLL: Duration = Duration::from_millis(100);
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
    start_parent_watchdog(env::var_os(PARENT_STDIN_WATCHDOG).as_deref())?;
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
            );
        })
        .map_err(|_| VisionError::WorkerUnavailable)?;

    let outcome = run_window(&reader, &annotated_receiver, &failure_receiver);
    stop.store(true, Ordering::Release);
    camera.request_stop();
    let _ = camera.shutdown();
    // Native inference is not uniformly interruptible. Dropping the handle
    // detaches it; returning from this helper process remains the hard bound.
    drop(worker);
    outcome
}

fn start_parent_watchdog(value: Option<&OsStr>) -> Result<(), VisionError> {
    if !parent_watchdog_enabled(value) {
        return Ok(());
    }
    thread::Builder::new()
        .name("gsv-vision-parent-watchdog".to_string())
        .spawn(|| {
            let stdin = io::stdin();
            let _ = wait_for_parent_eof(stdin.lock());
            // Parent loss is the hard teardown boundary for native camera and
            // inference calls, which are not uniformly interruptible.
            process::exit(0);
        })
        .map(|_| ())
        .map_err(|_| VisionError::WorkerUnavailable)
}

fn parent_watchdog_enabled(value: Option<&OsStr>) -> bool {
    value == Some(OsStr::new("1"))
}

fn wait_for_parent_eof(mut input: impl Read) -> io::Result<()> {
    let mut ignored = [0_u8; 64];
    loop {
        if input.read(&mut ignored)? == 0 {
            return Ok(());
        }
    }
}

fn run_window(
    reader: &FrameReader,
    annotated_receiver: &Receiver<AnnotatedFrame>,
    failure_receiver: &Receiver<()>,
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
            Ok(()) | Err(TryRecvError::Disconnected) => {
                return Err(VisionError::InferenceUnavailable)
            }
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
        let (frame, observation) = match annotated.as_ref() {
            Some(annotated) => (&*annotated.frame, Some(&annotated.observation)),
            None => (&*raw_frame, None),
        };
        window
            .render(frame, observation, &stats)
            .map_err(|_| VisionError::WindowUnavailable)?;
    }
    Ok(())
}

fn inference_worker(
    assets: AssetPaths,
    reader: FrameReader,
    stop: Arc<AtomicBool>,
    output: Sender<AnnotatedFrame>,
    replacement_receiver: Receiver<AnnotatedFrame>,
    failure: Sender<()>,
) {
    let Ok(mut recognizer) = GestureRecognizer::load(&assets.library, &assets.model) else {
        let _ = failure.try_send(());
        return;
    };

    let mut last_sequence = 0;
    let mut first_capture = None;
    let mut last_timestamp = None;
    while !stop.load(Ordering::Acquire) {
        let Some(delivery) = reader.wait_latest(last_sequence, INFERENCE_POLL) else {
            let stats = reader.stats();
            if stats.failed || !stats.running {
                let _ = failure.try_send(());
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
            let _ = failure.try_send(());
            return;
        };
        let annotated = AnnotatedFrame {
            frame: delivery.frame,
            observation,
        };
        if !publish_latest(&output, &replacement_receiver, annotated) {
            return;
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
    fn parent_watchdog_ignores_pipe_content_until_eof() {
        wait_for_parent_eof(Cursor::new(b"not an IPC message"))
            .expect("finite input should end at EOF");
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
    fn known_development_artifact_is_architecture_specific() {
        assert_eq!(
            development_artifact_name().is_some(),
            env::consts::OS == "linux" && env::consts::ARCH == "x86_64"
        );
    }
}
