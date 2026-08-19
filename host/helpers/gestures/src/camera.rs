use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType};
use nokhwa::{Camera, FormatDecoder, NokhwaError};

use crate::observation::FrameView;

const CAPTURE_ERROR_BACKOFF: Duration = Duration::from_millis(25);
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CameraConfig {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub frames_per_second: u32,
    pub max_consecutive_errors: u32,
}

impl Default for CameraConfig {
    fn default() -> Self {
        Self {
            index: 0,
            width: 640,
            height: 480,
            frames_per_second: 15,
            max_consecutive_errors: 8,
        }
    }
}

impl CameraConfig {
    fn validate(&self) -> Result<(), CameraError> {
        if self.width == 0 || self.height == 0 {
            return Err(CameraError::InvalidConfig(
                "camera width and height must be non-zero",
            ));
        }
        if self.frames_per_second == 0 {
            return Err(CameraError::InvalidConfig(
                "camera frame rate must be non-zero",
            ));
        }
        if self.max_consecutive_errors == 0 {
            return Err(CameraError::InvalidConfig(
                "maximum consecutive camera errors must be non-zero",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum CameraError {
    InvalidConfig(&'static str),
    PermissionDenied,
    Open(CameraFailure),
    Spawn,
    WorkerPanicked,
}

impl Display for CameraError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(formatter, "invalid camera config: {message}"),
            Self::PermissionDenied => formatter.write_str("camera permission was not granted"),
            Self::Open(failure) => write!(formatter, "camera could not be opened: {failure}"),
            Self::Spawn => formatter.write_str("camera worker could not start"),
            Self::WorkerPanicked => formatter.write_str("camera worker panicked"),
        }
    }
}

impl Error for CameraError {}

impl From<NokhwaError> for CameraError {
    fn from(error: NokhwaError) -> Self {
        Self::Open(CameraFailure::from_nokhwa(&error))
    }
}

/// A bounded error category. Backend messages can include device names and paths,
/// so neither the camera API nor the debug surface retains them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CameraFailure {
    Initialization,
    DeviceUnavailable,
    FormatNegotiation,
    StreamOpen,
    Capture,
    Decode,
    Unsupported,
    Shutdown,
    Unknown,
}

impl CameraFailure {
    fn from_nokhwa(error: &NokhwaError) -> Self {
        match error {
            NokhwaError::UnitializedError | NokhwaError::InitializeError { .. } => {
                Self::Initialization
            }
            NokhwaError::OpenDeviceError(..) => Self::DeviceUnavailable,
            NokhwaError::GetPropertyError { .. }
            | NokhwaError::SetPropertyError { .. }
            | NokhwaError::StructureError { .. } => Self::FormatNegotiation,
            NokhwaError::OpenStreamError(_) => Self::StreamOpen,
            NokhwaError::ReadFrameError(_) => Self::Capture,
            NokhwaError::ProcessFrameError { .. } => Self::Decode,
            NokhwaError::UnsupportedOperationError(_) | NokhwaError::NotImplementedError(_) => {
                Self::Unsupported
            }
            NokhwaError::ShutdownError { .. } | NokhwaError::StreamShutdownError(_) => {
                Self::Shutdown
            }
            NokhwaError::GeneralError(_) => Self::Unknown,
        }
    }
}

impl Display for CameraFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Initialization => "initialization failed",
            Self::DeviceUnavailable => "device unavailable",
            Self::FormatNegotiation => "format negotiation failed",
            Self::StreamOpen => "stream could not open",
            Self::Capture => "frame capture failed",
            Self::Decode => "frame decode failed",
            Self::Unsupported => "camera operation unsupported",
            Self::Shutdown => "stream shutdown failed",
            Self::Unknown => "camera backend failed",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CameraShutdown {
    Stopped,
    TimedOut,
}

#[derive(Clone, Debug)]
pub struct CameraStats {
    pub running: bool,
    pub failed: bool,
    pub published_frames: u64,
    pub slot_replacements: u64,
    pub capture_errors: u64,
    pub started_at: Instant,
    pub last_frame_at: Option<Instant>,
    pub sampled_at: Instant,
}

impl CameraStats {
    #[must_use]
    pub fn average_frames_per_second(&self) -> f32 {
        let end = self.last_frame_at.unwrap_or(self.sampled_at);
        let elapsed = end.saturating_duration_since(self.started_at).as_secs_f32();
        if elapsed <= f32::EPSILON {
            0.0
        } else {
            self.published_frames as f32 / elapsed
        }
    }
}

#[derive(Clone, Debug)]
pub struct FrameDelivery {
    pub frame: Arc<FrameView>,
}

#[derive(Clone)]
pub struct FrameReader {
    shared: Arc<LatestFrameSlot>,
}

impl FrameReader {
    /// Returns the newest frame only when it is newer than `after_sequence`.
    #[must_use]
    pub fn try_latest(&self, after_sequence: u64) -> Option<FrameDelivery> {
        self.shared.latest_after(after_sequence)
    }

    /// Waits for a frame newer than `after_sequence`, without allowing a queue to build.
    /// A stopped stream or timeout returns `None`; inspect [`Self::stats`] to distinguish them.
    #[must_use]
    pub fn wait_latest(&self, after_sequence: u64, timeout: Duration) -> Option<FrameDelivery> {
        self.shared.wait_latest(after_sequence, timeout)
    }

    #[must_use]
    pub fn stats(&self) -> CameraStats {
        self.shared.stats()
    }
}

pub struct CameraStream {
    reader: FrameReader,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl CameraStream {
    pub fn open(config: CameraConfig) -> Result<Self, CameraError> {
        config.validate()?;
        initialize_camera_backend()?;
        let shared = Arc::new(LatestFrameSlot::new());
        let stop = Arc::new(AtomicBool::new(false));
        let worker_shared = Arc::clone(&shared);
        let worker_stop = Arc::clone(&stop);
        let (startup_sender, startup_receiver) = sync_channel(1);
        let worker = thread::Builder::new()
            .name("gsv-vision-camera".to_string())
            .spawn(move || {
                camera_worker(config, &worker_shared, &worker_stop, startup_sender);
            })
            .map_err(|_| CameraError::Spawn)?;

        match startup_receiver.recv() {
            Ok(Ok(())) => {}
            Ok(Err(failure)) => {
                let _ = worker.join();
                return Err(CameraError::Open(failure));
            }
            Err(_) => {
                let _ = worker.join();
                return Err(CameraError::WorkerPanicked);
            }
        }

        Ok(Self {
            reader: FrameReader { shared },
            stop,
            worker: Some(worker),
        })
    }

    #[must_use]
    pub fn reader(&self) -> FrameReader {
        self.reader.clone()
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
    }

    /// Requests shutdown and waits for a bounded interval. Native capture calls
    /// are not uniformly interruptible; on timeout the worker is detached and
    /// the supervising helper process remains the hard teardown boundary.
    pub fn shutdown(self) -> Result<CameraShutdown, CameraError> {
        self.shutdown_timeout(DEFAULT_SHUTDOWN_TIMEOUT)
    }

    pub fn shutdown_timeout(mut self, timeout: Duration) -> Result<CameraShutdown, CameraError> {
        self.request_stop();
        if !self.reader.shared.wait_stopped(timeout) {
            // Dropping a JoinHandle detaches it. The process supervisor owns the
            // terminal fallback if a backend remains blocked in `frame()`.
            self.worker.take();
            return Ok(CameraShutdown::TimedOut);
        }
        if self
            .worker
            .take()
            .is_some_and(|worker| worker.join().is_err())
        {
            return Err(CameraError::WorkerPanicked);
        }
        Ok(CameraShutdown::Stopped)
    }
}

fn initialize_camera_backend() -> Result<(), CameraError> {
    let (sender, receiver) = sync_channel(1);
    nokhwa::nokhwa_initialize(move |authorized| {
        let _ = sender.send(authorized);
    });
    let authorized = receiver
        .recv()
        .map_err(|_| CameraError::Open(CameraFailure::Initialization))?;
    validate_camera_authorization(authorized)
}

fn validate_camera_authorization(authorized: bool) -> Result<(), CameraError> {
    if authorized {
        Ok(())
    } else {
        Err(CameraError::PermissionDenied)
    }
}

impl Drop for CameraStream {
    fn drop(&mut self) {
        self.request_stop();
        // Never wait indefinitely in Drop: several native camera APIs expose no
        // portable way to interrupt a currently blocked frame read.
        self.worker.take();
    }
}

fn open_camera(config: &CameraConfig) -> Result<Camera, NokhwaError> {
    let request = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
    let mut camera = Camera::new(CameraIndex::Index(config.index), request)?;

    // Some native backends do not expose a format list. Their initially selected,
    // RGB-decodable format remains usable in that case.
    if let Ok(formats) = camera.compatible_camera_formats() {
        if let Some(format) = closest_decodable_format(&formats, config) {
            let accepted_format = [format.format()];
            camera.set_camera_requset(RequestedFormat::with_formats(
                RequestedFormatType::Exact(format),
                &accepted_format,
            ))?;
        }
    }

    Ok(camera)
}

fn camera_worker(
    config: CameraConfig,
    shared: &LatestFrameSlot,
    stop: &AtomicBool,
    startup_sender: std::sync::mpsc::SyncSender<Result<(), CameraFailure>>,
) {
    let mut camera = match open_camera(&config).and_then(|mut camera| {
        camera.open_stream()?;
        Ok(camera)
    }) {
        Ok(camera) => camera,
        Err(error) => {
            let failure = CameraFailure::from_nokhwa(&error);
            shared.record_error();
            shared.finish(true);
            let _ = startup_sender.send(Err(failure));
            return;
        }
    };
    shared.mark_started();
    if startup_sender.send(Ok(())).is_err() {
        let _ = camera.stop_stream();
        shared.finish(false);
        return;
    }
    capture_loop(&mut camera, shared, stop, config.max_consecutive_errors);
}

fn closest_decodable_format(
    formats: &[CameraFormat],
    config: &CameraConfig,
) -> Option<CameraFormat> {
    formats
        .iter()
        .filter(|format| <RgbFormat as FormatDecoder>::FORMATS.contains(&format.format()))
        .min_by_key(|format| {
            let resolution = format.resolution();
            let size_distance = u64::from(resolution.width().abs_diff(config.width)).pow(2)
                + u64::from(resolution.height().abs_diff(config.height)).pow(2);
            let rate_distance = format.frame_rate().abs_diff(config.frames_per_second);
            (
                size_distance,
                rate_distance,
                frame_format_preference(format.format()),
            )
        })
        .copied()
}

fn frame_format_preference(format: FrameFormat) -> u8 {
    match format {
        FrameFormat::MJPEG => 0,
        FrameFormat::NV12 => 1,
        FrameFormat::YUYV => 2,
        FrameFormat::RAWRGB => 3,
        FrameFormat::RAWBGR => 4,
        FrameFormat::GRAY => 5,
    }
}

fn capture_loop(
    camera: &mut Camera,
    shared: &LatestFrameSlot,
    stop: &AtomicBool,
    max_consecutive_errors: u32,
) {
    let mut sequence = 0_u64;
    let mut consecutive_errors = 0_u32;
    let mut failed = false;

    while !stop.load(Ordering::Acquire) {
        match capture_frame(camera, sequence.wrapping_add(1).max(1)) {
            Ok(frame) => {
                sequence = frame.sequence;
                consecutive_errors = 0;
                shared.publish(frame);
            }
            Err(_) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                shared.record_error();
                if consecutive_errors >= max_consecutive_errors {
                    failed = true;
                    break;
                }
                thread::sleep(CAPTURE_ERROR_BACKOFF);
            }
        }
    }

    let _ = camera.stop_stream();
    shared.finish(failed);
}

fn capture_frame(camera: &mut Camera, sequence: u64) -> Result<FrameView, NokhwaError> {
    let frame = camera.frame()?;
    let resolution = frame.resolution();
    let rgb = frame.decode_image::<RgbFormat>()?.into_raw();
    Ok(FrameView {
        sequence,
        captured_at: Instant::now(),
        width: resolution.width(),
        height: resolution.height(),
        rgb: Arc::from(rgb.into_boxed_slice()),
    })
}

struct LatestFrameSlot {
    state: Mutex<LatestFrameState>,
    changed: Condvar,
}

struct LatestFrameState {
    latest: Option<Arc<FrameView>>,
    running: bool,
    failed: bool,
    published_frames: u64,
    slot_replacements: u64,
    capture_errors: u64,
    started_at: Instant,
    last_frame_at: Option<Instant>,
}

impl LatestFrameSlot {
    fn new() -> Self {
        Self {
            state: Mutex::new(LatestFrameState {
                latest: None,
                running: true,
                failed: false,
                published_frames: 0,
                slot_replacements: 0,
                capture_errors: 0,
                started_at: Instant::now(),
                last_frame_at: None,
            }),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, LatestFrameState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn publish(&self, frame: FrameView) {
        let mut state = self.lock();
        if state.latest.is_some() {
            state.slot_replacements = state.slot_replacements.saturating_add(1);
        }
        state.last_frame_at = Some(frame.captured_at);
        state.published_frames = state.published_frames.saturating_add(1);
        state.latest = Some(Arc::new(frame));
        drop(state);
        self.changed.notify_all();
    }

    fn mark_started(&self) {
        let mut state = self.lock();
        state.started_at = Instant::now();
    }

    fn record_error(&self) {
        let mut state = self.lock();
        state.capture_errors = state.capture_errors.saturating_add(1);
    }

    fn finish(&self, failed: bool) {
        let mut state = self.lock();
        state.running = false;
        state.failed = failed;
        drop(state);
        self.changed.notify_all();
    }

    fn latest_after(&self, after_sequence: u64) -> Option<FrameDelivery> {
        let state = self.lock();
        delivery_after(state.latest.as_ref(), after_sequence)
    }

    fn wait_latest(&self, after_sequence: u64, timeout: Duration) -> Option<FrameDelivery> {
        let started = Instant::now();
        let mut state = self.lock();
        loop {
            if let Some(delivery) = delivery_after(state.latest.as_ref(), after_sequence) {
                return Some(delivery);
            }
            if !state.running {
                return None;
            }
            let remaining = timeout.checked_sub(started.elapsed())?;
            let wait = self.changed.wait_timeout(state, remaining);
            let (next_state, result) = wait.unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next_state;
            if result.timed_out() {
                return delivery_after(state.latest.as_ref(), after_sequence);
            }
        }
    }

    fn wait_stopped(&self, timeout: Duration) -> bool {
        let started = Instant::now();
        let mut state = self.lock();
        while state.running {
            let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
                return false;
            };
            let wait = self.changed.wait_timeout(state, remaining);
            let (next_state, result) = wait.unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next_state;
            if result.timed_out() && state.running {
                return false;
            }
        }
        true
    }

    fn stats(&self) -> CameraStats {
        let state = self.lock();
        CameraStats {
            running: state.running,
            failed: state.failed,
            published_frames: state.published_frames,
            slot_replacements: state.slot_replacements,
            capture_errors: state.capture_errors,
            started_at: state.started_at,
            last_frame_at: state.last_frame_at,
            sampled_at: Instant::now(),
        }
    }
}

fn delivery_after(frame: Option<&Arc<FrameView>>, after_sequence: u64) -> Option<FrameDelivery> {
    let frame = frame?.clone();
    if frame.sequence <= after_sequence {
        return None;
    }
    Some(FrameDelivery { frame })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera_format(width: u32, height: u32, format: FrameFormat, fps: u32) -> CameraFormat {
        CameraFormat::new_from(width, height, format, fps)
    }

    fn frame(sequence: u64) -> FrameView {
        FrameView {
            sequence,
            captured_at: Instant::now(),
            width: 1,
            height: 1,
            rgb: Arc::from([0_u8, 0, 0]),
        }
    }

    #[test]
    fn format_selection_prefers_target_size_then_rate() {
        let formats = [
            camera_format(1_280, 720, FrameFormat::MJPEG, 15),
            camera_format(640, 480, FrameFormat::YUYV, 30),
            camera_format(640, 480, FrameFormat::MJPEG, 15),
        ];
        let config = CameraConfig::default();

        assert_eq!(
            closest_decodable_format(&formats, &config),
            Some(camera_format(640, 480, FrameFormat::MJPEG, 15))
        );
    }

    #[test]
    fn latest_slot_never_accumulates_a_frame_queue() {
        let slot = LatestFrameSlot::new();
        slot.publish(frame(1));
        slot.publish(frame(2));
        slot.publish(frame(3));

        let delivery = slot.latest_after(0).expect("latest frame");
        assert_eq!(delivery.frame.sequence, 3);
        assert_eq!(slot.stats().slot_replacements, 2);
    }

    #[test]
    fn reader_does_not_redeliver_an_observed_sequence() {
        let slot = Arc::new(LatestFrameSlot::new());
        slot.publish(frame(7));
        let reader = FrameReader { shared: slot };

        assert_eq!(reader.try_latest(6).expect("new frame").frame.sequence, 7);
        assert!(reader.try_latest(7).is_none());
    }

    #[test]
    fn camera_authorization_must_be_granted_before_device_access() {
        assert!(validate_camera_authorization(true).is_ok());
        assert!(matches!(
            validate_camera_authorization(false),
            Err(CameraError::PermissionDenied)
        ));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn camera_backend_initialization_is_a_noop_without_avfoundation() {
        assert!(initialize_camera_backend().is_ok());
    }
}
