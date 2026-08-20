use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cameras::{
    Camera, Device, Error as BackendError, FormatDescriptor, PixelFormat, StreamConfig, Transport,
};

use crate::observation::FrameView;

const CAPTURE_ERROR_BACKOFF: Duration = Duration::from_millis(25);
const CAPTURE_FRAME_TIMEOUT: Duration = Duration::from_millis(250);
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CameraConfig {
    pub index: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub frames_per_second: u32,
    pub max_consecutive_errors: u32,
}

impl Default for CameraConfig {
    fn default() -> Self {
        Self {
            index: None,
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

impl From<BackendError> for CameraError {
    fn from(error: BackendError) -> Self {
        if matches!(error, BackendError::PermissionDenied) {
            Self::PermissionDenied
        } else {
            Self::Open(CameraFailure::from_backend(&error))
        }
    }
}

/// A bounded error category. Backend messages can include device names and paths,
/// so neither the camera API nor the debug surface retains them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CameraFailure {
    Initialization,
    DeviceUnavailable,
    DeviceBusy,
    FormatNegotiation,
    StreamOpen,
    Capture,
    Decode,
    Unsupported,
    Unknown,
}

impl CameraFailure {
    fn from_backend(error: &BackendError) -> Self {
        match error {
            BackendError::PermissionDenied => Self::Initialization,
            BackendError::DeviceNotFound(_) => Self::DeviceUnavailable,
            BackendError::DeviceInUse => Self::DeviceBusy,
            BackendError::FormatNotSupported => Self::FormatNegotiation,
            BackendError::Timeout | BackendError::StreamEnded => Self::Capture,
            BackendError::MjpegDecode(_) => Self::Decode,
            BackendError::BackendNotImplemented { .. } | BackendError::Unsupported { .. } => {
                Self::Unsupported
            }
            BackendError::Backend { .. } => Self::StreamOpen,
            _ => Self::Unknown,
        }
    }
}

impl Display for CameraFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Initialization => "initialization failed",
            Self::DeviceUnavailable => "device unavailable",
            Self::DeviceBusy => "device is already in use",
            Self::FormatNegotiation => "format negotiation failed",
            Self::StreamOpen => "stream could not open",
            Self::Capture => "frame capture failed",
            Self::Decode => "frame decode failed",
            Self::Unsupported => "camera operation unsupported",
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
    pub failure: Option<CameraFailure>,
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
        let device = select_camera_device(config.index)?;
        let shared = Arc::new(LatestFrameSlot::new());
        let stop = Arc::new(AtomicBool::new(false));
        let worker_shared = Arc::clone(&shared);
        let worker_stop = Arc::clone(&stop);
        let (startup_sender, startup_receiver) = sync_channel(1);
        let worker = thread::Builder::new()
            .name("gsv-vision-camera".to_string())
            .spawn(move || {
                camera_worker(
                    config,
                    &device,
                    &worker_shared,
                    &worker_stop,
                    startup_sender,
                );
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

fn select_camera_device(index: Option<u32>) -> Result<Device, CameraError> {
    let devices = cameras::devices().map_err(CameraError::from)?;
    if let Some(index) = index {
        return select_capture_candidate(devices, Some(index as usize), |device| {
            cameras::probe(device)
                .map(|capabilities| !capabilities.formats.is_empty())
                .map_err(CameraError::from)
        });
    }

    let (built_in, other): (Vec<_>, Vec<_>) = devices
        .into_iter()
        .partition(|device| device.transport == Transport::BuiltIn);
    select_capture_candidate(built_in.into_iter().chain(other), None, |device| {
        cameras::probe(device)
            .map(|capabilities| !capabilities.formats.is_empty())
            .map_err(CameraError::from)
    })
}

fn select_capture_candidate<T>(
    candidates: impl IntoIterator<Item = T>,
    selected_index: Option<usize>,
    mut probe: impl FnMut(&T) -> Result<bool, CameraError>,
) -> Result<T, CameraError> {
    let mut first_error = None;
    let mut capture_index = 0;
    for candidate in candidates {
        match probe(&candidate) {
            Ok(true) => {
                if selected_index.is_none_or(|selected| selected == capture_index) {
                    return Ok(candidate);
                }
                capture_index += 1;
            }
            Ok(_) => {}
            Err(error) => {
                if matches!(error, CameraError::PermissionDenied) {
                    return Err(error);
                }
                first_error.get_or_insert(error);
            }
        }
    }
    if capture_index == 0 {
        Err(first_error.unwrap_or(CameraError::Open(CameraFailure::DeviceUnavailable)))
    } else {
        Err(CameraError::Open(CameraFailure::DeviceUnavailable))
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

fn open_camera(device: &Device, config: &CameraConfig) -> Result<Camera, BackendError> {
    let capabilities = cameras::probe(device)?;
    let format = closest_camera_format(&capabilities.formats, config)
        .ok_or(BackendError::FormatNotSupported)?;
    cameras::open(device, stream_config(format, config))
}

fn camera_worker(
    config: CameraConfig,
    device: &Device,
    shared: &LatestFrameSlot,
    stop: &AtomicBool,
    startup_sender: std::sync::mpsc::SyncSender<Result<(), CameraFailure>>,
) {
    let camera = match open_camera(device, &config) {
        Ok(camera) => camera,
        Err(error) => {
            let failure = CameraFailure::from_backend(&error);
            shared.record_error();
            shared.finish(Some(failure));
            let _ = startup_sender.send(Err(failure));
            return;
        }
    };
    shared.mark_started();
    if startup_sender.send(Ok(())).is_err() {
        drop(camera);
        shared.finish(None);
        return;
    }
    let failure = capture_loop(&camera, shared, stop, config.max_consecutive_errors);
    // Some platform capture drivers do not interrupt a blocked native read.
    // Publish terminal state only after the backend has actually released, so
    // CameraStream::shutdown can retain its bounded detach fallback.
    drop(camera);
    shared.finish(failure);
}

fn closest_camera_format<'a>(
    formats: &'a [FormatDescriptor],
    config: &CameraConfig,
) -> Option<&'a FormatDescriptor> {
    formats.iter().min_by(|left, right| {
        format_size_distance(left, config)
            .cmp(&format_size_distance(right, config))
            .then_with(|| {
                format_rate_distance(left, config).total_cmp(&format_rate_distance(right, config))
            })
            .then_with(|| {
                pixel_format_preference(left.pixel_format)
                    .cmp(&pixel_format_preference(right.pixel_format))
            })
    })
}

fn format_size_distance(format: &FormatDescriptor, config: &CameraConfig) -> u64 {
    format_size_distance_from(format.resolution.width, format.resolution.height, config)
}

fn format_size_distance_from(width: u32, height: u32, config: &CameraConfig) -> u64 {
    u64::from(width.abs_diff(config.width)).pow(2)
        + u64::from(height.abs_diff(config.height)).pow(2)
}

fn format_rate_distance(format: &FormatDescriptor, config: &CameraConfig) -> f64 {
    let requested = f64::from(config.frames_per_second);
    if requested < format.framerate_range.min {
        format.framerate_range.min - requested
    } else if requested > format.framerate_range.max {
        requested - format.framerate_range.max
    } else {
        0.0
    }
}

fn pixel_format_preference(format: PixelFormat) -> u8 {
    match format {
        PixelFormat::Nv12 => 0,
        PixelFormat::Yuyv => 1,
        PixelFormat::Bgra8 => 2,
        PixelFormat::Rgb8 => 3,
        PixelFormat::Rgba8 => 4,
        PixelFormat::Mjpeg => 5,
        _ => 6,
    }
}

fn stream_config(format: &FormatDescriptor, config: &CameraConfig) -> StreamConfig {
    StreamConfig {
        resolution: format.resolution,
        framerate: closest_frame_rate(format, config.frames_per_second),
        pixel_format: format.pixel_format,
    }
}

fn closest_frame_rate(format: &FormatDescriptor, requested: u32) -> u32 {
    closest_frame_rate_in_range(
        format.framerate_range.min,
        format.framerate_range.max,
        requested,
    )
}

fn closest_frame_rate_in_range(minimum: f64, maximum: f64, requested: u32) -> u32 {
    let minimum = minimum.ceil().max(1.0) as u32;
    let maximum = maximum.floor().max(f64::from(minimum)) as u32;
    requested.clamp(minimum, maximum)
}

fn capture_loop(
    camera: &Camera,
    shared: &LatestFrameSlot,
    stop: &AtomicBool,
    max_consecutive_errors: u32,
) -> Option<CameraFailure> {
    let mut sequence = 0_u64;
    let mut consecutive_errors = 0_u32;
    let mut terminal_failure = None;

    while !stop.load(Ordering::Acquire) {
        match capture_frame(camera, sequence.wrapping_add(1).max(1)) {
            Ok(frame) => {
                sequence = frame.sequence;
                consecutive_errors = 0;
                shared.publish(frame);
            }
            Err(CaptureFrameError::Timeout) => continue,
            Err(CaptureFrameError::Failure(failure)) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                shared.record_error();
                if consecutive_errors >= max_consecutive_errors {
                    terminal_failure = Some(failure);
                    break;
                }
                thread::sleep(CAPTURE_ERROR_BACKOFF);
            }
        }
    }

    terminal_failure
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CaptureFrameError {
    Timeout,
    Failure(CameraFailure),
}

fn capture_frame(camera: &Camera, sequence: u64) -> Result<FrameView, CaptureFrameError> {
    let frame = cameras::next_frame(camera, CAPTURE_FRAME_TIMEOUT)
        .map_err(|error| capture_frame_error(&error))?;
    let rgb = match cameras::to_rgb8(&frame) {
        Ok(rgb) => rgb,
        Err(BackendError::MjpegDecode(_)) if frame.pixel_format == PixelFormat::Mjpeg => {
            decode_mjpeg(&frame.plane_primary, frame.width, frame.height)?
        }
        Err(error) => {
            return Err(CaptureFrameError::Failure(CameraFailure::from_backend(
                &error,
            )));
        }
    };
    let expected_length = usize::try_from(frame.width)
        .ok()
        .and_then(|width| {
            usize::try_from(frame.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or(CaptureFrameError::Failure(CameraFailure::Decode))?;
    if rgb.len() != expected_length {
        return Err(CaptureFrameError::Failure(CameraFailure::Decode));
    }
    Ok(FrameView {
        sequence,
        captured_at: Instant::now(),
        width: frame.width,
        height: frame.height,
        rgb: Arc::from(rgb.into_boxed_slice()),
    })
}

fn decode_mjpeg(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>, CaptureFrameError> {
    let mut decoder = zune_jpeg::JpegDecoder::new(Cursor::new(bytes));
    decoder.set_options(
        (*decoder.options())
            .set_max_width(width as usize)
            .set_max_height(height as usize),
    );
    decoder
        .decode()
        .map_err(|_| CaptureFrameError::Failure(CameraFailure::Decode))
}

fn capture_frame_error(error: &BackendError) -> CaptureFrameError {
    if matches!(error, BackendError::Timeout) {
        CaptureFrameError::Timeout
    } else {
        CaptureFrameError::Failure(CameraFailure::from_backend(error))
    }
}

struct LatestFrameSlot {
    state: Mutex<LatestFrameState>,
    changed: Condvar,
}

struct LatestFrameState {
    latest: Option<Arc<FrameView>>,
    running: bool,
    failure: Option<CameraFailure>,
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
                failure: None,
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

    fn finish(&self, failure: Option<CameraFailure>) {
        let mut state = self.lock();
        state.running = false;
        state.failure = failure;
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
            failure: state.failure,
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
    use image::codecs::jpeg::JpegEncoder;

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
    fn format_selection_prefers_target_size_rate_and_uncompressed_frames() {
        let config = CameraConfig::default();
        assert_eq!(format_size_distance_from(640, 480, &config), 0);
        assert!(format_size_distance_from(1_280, 720, &config) > 0);
        assert_eq!(closest_frame_rate_in_range(1.0, 30.0, 15), 15);
        assert_eq!(closest_frame_rate_in_range(30.0, 60.0, 15), 30);
        assert_eq!(closest_frame_rate_in_range(1.0, 10.0, 15), 10);
        assert!(
            pixel_format_preference(PixelFormat::Nv12)
                < pixel_format_preference(PixelFormat::Mjpeg)
        );
        assert!(
            pixel_format_preference(PixelFormat::Yuyv)
                < pixel_format_preference(PixelFormat::Mjpeg)
        );
    }

    #[test]
    fn default_selection_skips_devices_without_capture_formats() {
        let mut probed = Vec::new();
        let selected = select_capture_candidate([1_u8, 0], None, |candidate| {
            probed.push(*candidate);
            Ok(*candidate == 0)
        })
        .expect("capture device");

        assert_eq!(selected, 0);
        assert_eq!(probed, [1, 0]);
    }

    #[test]
    fn explicit_indices_count_only_capture_capable_devices() {
        let mut probed = Vec::new();
        let selected = select_capture_candidate([0_u8, 1, 2, 3], Some(1), |candidate| {
            probed.push(*candidate);
            Ok(*candidate == 1 || *candidate == 3)
        })
        .expect("second capture device");

        assert_eq!(selected, 3);
        assert_eq!(probed, [0, 1, 2, 3]);
    }

    #[test]
    fn temporary_capture_timeouts_are_retryable() {
        assert_eq!(
            capture_frame_error(&BackendError::Timeout),
            CaptureFrameError::Timeout
        );
        assert_eq!(
            capture_frame_error(&BackendError::StreamEnded),
            CaptureFrameError::Failure(CameraFailure::Capture)
        );
    }

    #[test]
    fn terminal_capture_failure_remains_available_to_the_caller() {
        let slot = LatestFrameSlot::new();
        slot.finish(Some(CameraFailure::Decode));

        let stats = slot.stats();
        assert!(!stats.running);
        assert_eq!(stats.failure, Some(CameraFailure::Decode));
    }

    #[test]
    fn compatibility_decoder_produces_packed_rgb() {
        let mut encoded = Vec::new();
        JpegEncoder::new(&mut encoded)
            .encode(&[255, 0, 0], 1, 1, image::ExtendedColorType::Rgb8)
            .expect("jpeg fixture");

        let decoded = decode_mjpeg(&encoded, 1, 1).expect("decoded jpeg");
        assert_eq!(decoded.len(), 3);
        assert!(decoded[0] > decoded[1]);
        assert!(decoded[0] > decoded[2]);
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
    fn backend_permission_errors_keep_the_actionable_category() {
        assert!(matches!(
            CameraError::from(BackendError::PermissionDenied),
            CameraError::PermissionDenied
        ));
    }
}
