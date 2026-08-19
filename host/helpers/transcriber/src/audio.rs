use std::collections::BTreeMap;
use std::str::FromStr as _;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
#[cfg(any(target_os = "linux", test))]
use cpal::{BufferSize, SupportedBufferSize};
use cpal::{
    FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig, SupportedStreamConfig,
};
use crossbeam_channel::{Receiver, Sender};
use serde::Serialize;

const CAPTURE_BUFFER_DURATION: Duration = Duration::from_secs(5);
#[cfg(any(target_os = "linux", test))]
const PULSE_CAPTURE_PERIOD: Duration = Duration::from_millis(40);
const SILENT_INPUT_DURATION: Duration = Duration::from_secs(2);
const MAX_INPUT_DEVICES: usize = 32;
const MAX_DEVICE_NAME_BYTES: usize = 256;
const MAX_DEVICE_ID_BYTES: usize = 512;
const MUTED_STATE_BIT: u64 = 1;
const CALLBACK_QUIESCE_TIMEOUT: Duration = Duration::from_secs(1);

const _: () = {
    assert!(MAX_INPUT_DEVICES <= 32);
    assert!(MAX_DEVICE_NAME_BYTES <= 256);
    assert!(MAX_DEVICE_ID_BYTES <= 512);
};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct InputDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputDeviceMatchPolicy {
    UniqueExactPublicName,
    LegacyFuzzyName,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioError {
    Unavailable,
    Overflow,
    Silent,
}

pub enum AudioPacket {
    Samples(BufferedSamples),
    Error(AudioError),
}

pub struct BufferedSamples {
    samples: Vec<f32>,
    capture_state: u64,
    _reservation: SampleReservation,
}

impl BufferedSamples {
    pub fn as_slice(&self) -> &[f32] {
        &self.samples
    }

    pub fn capture_state(&self) -> u64 {
        self.capture_state
    }
}

/// Atomic callback gate for one active capture request. Every state change
/// advances the generation; queued packets retain the generation observed by
/// their callback so work that raced with mute can be rejected downstream.
pub struct CaptureGate {
    state: AtomicU64,
    in_flight_callbacks: AtomicUsize,
}

impl CaptureGate {
    pub fn new() -> Self {
        Self {
            state: AtomicU64::new(0),
            in_flight_callbacks: AtomicUsize::new(0),
        }
    }

    fn admit_callback(&self, capture_state: u64) -> Option<CallbackLease<'_>> {
        if capture_state & MUTED_STATE_BIT != 0 {
            return None;
        }
        // Admission and capture closure form a two-atomic handshake. SeqCst is
        // intentional: either this state recheck observes the closed
        // generation, or the closer's callback-count check observes this
        // lease. AcqRel on independent atomics permits both sides to miss on
        // weakly ordered hosts.
        self.in_flight_callbacks.fetch_add(1, Ordering::SeqCst);
        if self.state.load(Ordering::SeqCst) == capture_state {
            Some(CallbackLease {
                in_flight_callbacks: &self.in_flight_callbacks,
            })
        } else {
            self.in_flight_callbacks.fetch_sub(1, Ordering::SeqCst);
            None
        }
    }

    fn wait_for_callback_quiescence(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.in_flight_callbacks.load(Ordering::SeqCst) == 0 {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::yield_now();
        }
    }

    fn accepting_state(&self) -> Option<u64> {
        let state = self.state.load(Ordering::Acquire);
        (state & MUTED_STATE_BIT == 0).then_some(state)
    }

    pub fn accepts(&self, state: u64) -> bool {
        state & MUTED_STATE_BIT == 0 && self.state.load(Ordering::Acquire) == state
    }

    fn ensure_muted(&self) -> MuteTransition {
        let mut current = self.state.load(Ordering::Acquire);
        loop {
            if current & MUTED_STATE_BIT != 0 {
                return MuteTransition {
                    state: current,
                    changed: false,
                };
            }
            let next = next_capture_state(current, true);
            match self.state.compare_exchange_weak(
                current,
                next,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    return MuteTransition {
                        state: next,
                        changed: true,
                    };
                }
                Err(actual) => current = actual,
            }
        }
    }

    fn invalidate(&self) {
        let mut current = self.state.load(Ordering::Acquire);
        loop {
            let next = next_capture_state(current, true);
            match self.state.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(actual) => current = actual,
            }
        }
    }

    fn close_for_segment_boundary(&self) -> SegmentBoundaryRequest {
        let mut current = self.state.load(Ordering::Acquire);
        loop {
            let next = next_capture_state(current, true);
            match self.state.compare_exchange_weak(
                current,
                next,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    return SegmentBoundaryRequest {
                        previous_state: current,
                        expected_state: next,
                        muted: current & MUTED_STATE_BIT != 0,
                    };
                }
                Err(actual) => current = actual,
            }
        }
    }

    fn apply_segment_boundary(&self, request: SegmentBoundaryRequest) -> Option<bool> {
        if request.muted {
            return (self.state.load(Ordering::Acquire) == request.expected_state).then_some(true);
        }

        let next = next_capture_state(request.expected_state, false);
        self.state
            .compare_exchange(
                request.expected_state,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .ok()
            .map(|_| false)
    }

    fn apply(&self, request: MuteRequest, muted: bool) -> MuteOutcome {
        if muted {
            let current = self.state.load(Ordering::Acquire);
            if current == request.expected_state && current & MUTED_STATE_BIT != 0 {
                return MuteOutcome {
                    muted: true,
                    changed: request.changed,
                };
            }
            let transition = self.ensure_muted();
            return MuteOutcome {
                muted: true,
                changed: transition.changed,
            };
        }

        let expected = request.expected_state;
        if expected & MUTED_STATE_BIT == 0 {
            return MuteOutcome {
                muted: self.state.load(Ordering::Acquire) & MUTED_STATE_BIT != 0,
                changed: false,
            };
        }
        let next = next_capture_state(expected, false);
        match self
            .state
            .compare_exchange(expected, next, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => MuteOutcome {
                muted: false,
                changed: request.changed,
            },
            Err(actual) => MuteOutcome {
                muted: actual & MUTED_STATE_BIT != 0,
                changed: false,
            },
        }
    }
}

struct CallbackLease<'a> {
    in_flight_callbacks: &'a AtomicUsize,
}

impl Drop for CallbackLease<'_> {
    fn drop(&mut self) {
        self.in_flight_callbacks.fetch_sub(1, Ordering::SeqCst);
    }
}

struct MuteTransition {
    state: u64,
    changed: bool,
}

fn next_capture_state(current: u64, muted: bool) -> u64 {
    let generation = (current & !MUTED_STATE_BIT).wrapping_add(2);
    generation | u64::from(muted)
}

#[derive(Clone, Copy, Debug)]
pub struct MuteRequest {
    expected_state: u64,
    changed: bool,
}

/// A request-scoped cut between two model streams. Command ingress closes the
/// callback gate on a fresh generation so samples from the next segment cannot
/// race into the old model stream. The active loop restores the previously
/// acknowledged mute state when it owns the boundary.
#[derive(Clone, Copy, Debug)]
pub struct SegmentBoundaryRequest {
    previous_state: u64,
    expected_state: u64,
    muted: bool,
}

impl SegmentBoundaryRequest {
    pub fn accepts_previous(self, capture_state: u64) -> bool {
        self.previous_state & MUTED_STATE_BIT == 0 && self.previous_state == capture_state
    }
}

impl MuteRequest {
    pub fn changes_state(self) -> bool {
        self.changed
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MuteOutcome {
    pub muted: bool,
    pub changed: bool,
}

#[derive(Clone, Default)]
pub struct CaptureControl {
    active: Arc<Mutex<Option<ActiveCapture>>>,
}

struct ActiveCapture {
    request_id: u64,
    gate: Arc<CaptureGate>,
}

impl CaptureControl {
    pub fn activate(&self, request_id: u64, gate: Arc<CaptureGate>) -> CaptureRegistration {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *active = Some(ActiveCapture {
            request_id,
            gate: Arc::clone(&gate),
        });
        CaptureRegistration {
            control: self.clone(),
            request_id,
            gate,
        }
    }

    pub fn request_mute(&self, request_id: u64, muted: bool) -> Option<MuteRequest> {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let active = active
            .as_ref()
            .filter(|active| active.request_id == request_id)?;
        let (expected_state, changed) = if muted {
            let transition = active.gate.ensure_muted();
            (transition.state, transition.changed)
        } else {
            let expected_state = active.gate.state.load(Ordering::Acquire);
            (expected_state, expected_state & MUTED_STATE_BIT != 0)
        };
        Some(MuteRequest {
            expected_state,
            changed,
        })
    }

    pub fn request_segment_boundary(&self, request_id: u64) -> Option<SegmentBoundaryRequest> {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let active = active
            .as_ref()
            .filter(|active| active.request_id == request_id)?;
        Some(active.gate.close_for_segment_boundary())
    }
}

pub struct CaptureRegistration {
    control: CaptureControl,
    request_id: u64,
    gate: Arc<CaptureGate>,
}

impl Drop for CaptureRegistration {
    fn drop(&mut self) {
        self.gate.invalidate();
        let mut active = self
            .control
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active.as_ref().is_some_and(|active| {
            active.request_id == self.request_id && Arc::ptr_eq(&active.gate, &self.gate)
        }) {
            *active = None;
        }
    }
}

struct SampleReservation {
    samples: usize,
    buffered_samples: Arc<AtomicUsize>,
}

impl Drop for SampleReservation {
    fn drop(&mut self) {
        self.buffered_samples
            .fetch_sub(self.samples, Ordering::AcqRel);
    }
}

struct CaptureWriter {
    packets: Sender<AudioPacket>,
    buffered_samples: Arc<AtomicUsize>,
    max_buffered_samples: usize,
    terminal: Arc<AtomicBool>,
    gate: Arc<CaptureGate>,
    silence: SilenceDetector,
}

impl CaptureWriter {
    fn accepting_state(&self) -> Option<u64> {
        (!self.terminal.load(Ordering::Acquire))
            .then(|| self.gate.accepting_state())
            .flatten()
    }

    fn push(&mut self, capture_state: u64, samples: Vec<f32>) {
        if samples.is_empty() || self.terminal.load(Ordering::Acquire) {
            return;
        }
        let Some(_callback_lease) = self.gate.admit_callback(capture_state) else {
            return;
        };
        let silent = self.silence.observe(capture_state, &samples);
        if !self.gate.accepts(capture_state) {
            return;
        }
        if silent {
            self.fail(AudioError::Silent);
            return;
        }

        let reservation = match self.reserve(samples.len()) {
            Some(reservation) => reservation,
            None => {
                if self.gate.accepts(capture_state) {
                    self.fail(AudioError::Overflow);
                }
                return;
            }
        };
        if !self.gate.accepts(capture_state) {
            return;
        }
        if self
            .packets
            .send(AudioPacket::Samples(BufferedSamples {
                samples,
                capture_state,
                _reservation: reservation,
            }))
            .is_err()
        {
            self.terminal.store(true, Ordering::Release);
        }
    }

    fn reserve(&self, samples: usize) -> Option<SampleReservation> {
        let mut buffered = self.buffered_samples.load(Ordering::Acquire);
        loop {
            let next = buffered.checked_add(samples)?;
            if next > self.max_buffered_samples {
                return None;
            }
            match self.buffered_samples.compare_exchange_weak(
                buffered,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(SampleReservation {
                        samples,
                        buffered_samples: Arc::clone(&self.buffered_samples),
                    });
                }
                Err(actual) => buffered = actual,
            }
        }
    }

    fn fail(&self, error: AudioError) {
        if !self.terminal.swap(true, Ordering::AcqRel) {
            let _ = self.packets.send(AudioPacket::Error(error));
        }
    }
}

struct SilenceDetector {
    zero_samples: usize,
    threshold_samples: usize,
    armed: bool,
    capture_state: Option<u64>,
}

impl SilenceDetector {
    fn new(sample_rate: u32) -> Self {
        Self {
            zero_samples: 0,
            threshold_samples: samples_for_duration(sample_rate, SILENT_INPUT_DURATION),
            armed: true,
            capture_state: None,
        }
    }

    fn observe(&mut self, capture_state: u64, samples: &[f32]) -> bool {
        if self.capture_state != Some(capture_state) {
            self.capture_state = Some(capture_state);
            // Exact-zero startup diagnosis cannot bridge a muted interval. Keep
            // the permanently-disarmed state after any real signal, but restart
            // a still-pending zero window for each capture generation.
            self.zero_samples = 0;
        }
        if !self.armed {
            return false;
        }
        if samples.iter().any(|sample| *sample != 0.0) {
            // Exact-zero detection only diagnoses a dead capture route at startup. Once the
            // device has produced any signal, a later quiet pause is legitimate dictation.
            self.armed = false;
            self.zero_samples = 0;
            return false;
        }
        self.zero_samples = self.zero_samples.saturating_add(samples.len());
        self.zero_samples >= self.threshold_samples
    }
}

pub struct AudioCapture {
    _stream: Stream,
    pub packets: Receiver<AudioPacket>,
    pub sample_rate: u32,
    gate: Arc<CaptureGate>,
}

pub fn list_input_devices() -> Result<Vec<InputDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_id = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    let devices = product_input_devices(&host)?;
    Ok(normalize_input_devices(
        devices.into_iter().filter_map(|device| {
            let id = bounded_device_id(&device.id().ok()?.to_string())?;
            let description = device.description().ok()?;
            let name = bounded_device_name(description.name())?;
            Some((id, name))
        }),
        default_id.as_deref(),
    ))
}

fn product_input_devices(host: &cpal::Host) -> Result<Vec<cpal::Device>, String> {
    Ok(host
        .devices()
        .map_err(|error| format!("microphones are unavailable: {error}"))?
        .filter(|device| {
            device
                .id()
                .is_ok_and(|id| product_input_candidate(device.supports_input(), &id))
        })
        .collect())
}

fn product_input_candidate(supports_input: bool, id: &cpal::DeviceId) -> bool {
    supports_input && product_input_selector(id)
}

#[cfg(target_os = "linux")]
fn product_input_selector(id: &cpal::DeviceId) -> bool {
    if id.host() == cpal::HostId::PulseAudio {
        return pulse_source_selector(id.id());
    }
    if id.host() == cpal::HostId::Alsa {
        return alsa_physical_capture_selector(id.id());
    }
    true
}

#[cfg(target_os = "linux")]
fn pulse_source_selector(id: &str) -> bool {
    id != "@DEFAULT_SOURCE@" && !id.ends_with(".monitor")
}

#[cfg(target_os = "linux")]
fn system_default_input_selector(id: &cpal::DeviceId) -> bool {
    if id.host() == cpal::HostId::PulseAudio {
        return pulse_source_selector(id.id());
    }
    // CPAL's ALSA default is an opaque capture route rather than a physical-device selector.
    // Keep it for SYSTEM DEFAULT and let opening its input configuration prove availability.
    true
}

#[cfg(not(target_os = "linux"))]
fn system_default_input_selector(_id: &cpal::DeviceId) -> bool {
    true
}

#[cfg(not(target_os = "linux"))]
fn product_input_selector(_id: &cpal::DeviceId) -> bool {
    true
}

#[cfg(target_os = "linux")]
fn alsa_physical_capture_selector(id: &str) -> bool {
    let Some(selector) = id.strip_prefix("plughw:CARD=") else {
        return false;
    };
    let Some((card, device)) = selector.split_once(",DEV=") else {
        return false;
    };
    !card.is_empty()
        && !device.is_empty()
        && card.bytes().all(|byte| byte.is_ascii_digit())
        && device.bytes().all(|byte| byte.is_ascii_digit())
}

fn normalize_input_devices<I>(devices: I, default_id: Option<&str>) -> Vec<InputDeviceInfo>
where
    I: IntoIterator<Item = (String, String)>,
{
    let default_id = default_id.and_then(bounded_device_id);
    let mut unique = BTreeMap::<String, InputDeviceInfo>::new();
    for (raw_id, raw_name) in devices {
        let Some(id) = bounded_device_id(&raw_id) else {
            continue;
        };
        let Some(name) = bounded_device_name(&raw_name) else {
            continue;
        };
        let is_default = default_id.as_deref() == Some(id.as_str());
        unique.entry(id.clone()).or_insert(InputDeviceInfo {
            id,
            name,
            is_default,
        });
        if unique.len() > MAX_INPUT_DEVICES {
            let remove = unique
                .iter()
                .max_by(|(_, left), (_, right)| compare_input_devices(left, right))
                .map(|(id, _)| id.clone());
            if let Some(remove) = remove {
                unique.remove(&remove);
            }
        }
    }

    let mut devices = unique.into_values().collect::<Vec<_>>();
    devices.sort_by(compare_input_devices);
    devices
}

fn compare_input_devices(left: &InputDeviceInfo, right: &InputDeviceInfo) -> std::cmp::Ordering {
    right
        .is_default
        .cmp(&left.is_default)
        .then_with(|| left.name.cmp(&right.name))
        .then_with(|| left.id.cmp(&right.id))
}

fn bounded_device_name(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty() && name.len() <= MAX_DEVICE_NAME_BYTES && !name.chars().any(char::is_control))
        .then(|| name.to_string())
}

fn bounded_device_id(id: &str) -> Option<String> {
    (!id.is_empty()
        && id.trim() == id
        && id.len() <= MAX_DEVICE_ID_BYTES
        && !id.chars().any(char::is_control))
    .then(|| id.to_string())
}

fn saved_device_name_matches(current: &str, saved: &str) -> bool {
    bounded_device_name(current).as_deref() == Some(saved)
}

fn saved_device_matches(
    current_id: &str,
    current_name: &str,
    saved_id: &str,
    saved_name: &str,
) -> bool {
    bounded_device_id(current_id).as_deref() == Some(saved_id)
        && saved_device_name_matches(current_name, saved_name)
}

impl AudioCapture {
    pub fn open(
        preferred_name: Option<&str>,
        preferred_id: Option<&str>,
        match_policy: InputDeviceMatchPolicy,
        gate: Arc<CaptureGate>,
    ) -> Result<Self, String> {
        let host = cpal::default_host();
        let devices = select_input_devices(&host, preferred_name, preferred_id, match_policy)?;
        let mut last_error = None;
        for device in devices {
            match Self::open_device(device, Arc::clone(&gate)) {
                Ok(capture) => return Ok(capture),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| "configured microphone is unavailable".to_string()))
    }

    pub fn apply_segment_boundary(&self, request: SegmentBoundaryRequest) -> Option<bool> {
        self.gate.apply_segment_boundary(request)
    }

    pub fn wait_for_callback_quiescence(&self) -> bool {
        self.gate
            .wait_for_callback_quiescence(CALLBACK_QUIESCE_TIMEOUT)
    }

    fn open_device(device: cpal::Device, gate: Arc<CaptureGate>) -> Result<Self, String> {
        let supported = device
            .default_input_config()
            .map_err(|error| format!("microphone is unavailable: {error}"))?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels() as usize;
        let config = input_stream_config(&device, supported);
        // The packet channel itself is unbounded so a terminal error cannot be lost behind
        // audio, but every non-empty sample packet owns a reservation from the fixed-duration
        // budget below. This bounds both queued samples and the number of queued packets.
        let (tx, packets) = crossbeam_channel::unbounded::<AudioPacket>();
        let terminal = Arc::new(AtomicBool::new(false));
        let max_buffered_samples = samples_for_duration(sample_rate, CAPTURE_BUFFER_DURATION);
        let writer = CaptureWriter {
            packets: tx.clone(),
            buffered_samples: Arc::new(AtomicUsize::new(0)),
            max_buffered_samples,
            terminal: Arc::clone(&terminal),
            gate: Arc::clone(&gate),
            silence: SilenceDetector::new(sample_rate),
        };
        let errors = CaptureErrorWriter {
            packets: tx,
            terminal,
        };
        let error_callback = move |_: cpal::Error| errors.fail();

        let stream = match supported.sample_format() {
            SampleFormat::I8 => {
                build_stream::<i8>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::I16 => {
                build_stream::<i16>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::I32 => {
                build_stream::<i32>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::I64 => {
                build_stream::<i64>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::U8 => {
                build_stream::<u8>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::U16 => {
                build_stream::<u16>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::U32 => {
                build_stream::<u32>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::U64 => {
                build_stream::<u64>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::F32 => {
                build_stream::<f32>(&device, &config, channels, writer, error_callback)
            }
            SampleFormat::F64 => {
                build_stream::<f64>(&device, &config, channels, writer, error_callback)
            }
            format => return Err(format!("microphone format {format} is not supported")),
        }
        .map_err(|error| format!("microphone could not start: {error}"))?;
        stream
            .play()
            .map_err(|error| format!("microphone could not start: {error}"))?;
        Ok(Self {
            _stream: stream,
            packets,
            sample_rate,
            gate,
        })
    }

    pub fn set_muted(&self, request: MuteRequest, muted: bool) -> MuteOutcome {
        self.gate.apply(request, muted)
    }

    pub fn is_muted(&self) -> bool {
        self.gate.state.load(Ordering::Acquire) & MUTED_STATE_BIT != 0
    }

    pub fn accepts(&self, capture_state: u64) -> bool {
        self.gate.accepts(capture_state)
    }
}

#[cfg(target_os = "linux")]
fn input_stream_config(device: &cpal::Device, supported: SupportedStreamConfig) -> StreamConfig {
    let mut config = supported.config();
    if device
        .id()
        .is_ok_and(|id| id.host() == cpal::HostId::PulseAudio)
    {
        // Pulse's default record fragment may span seconds, and starting the stream waits for
        // its first fragment. Request a modest callback period so activation is prompt without
        // turning capture into a high-frequency realtime workload.
        config.buffer_size = capture_buffer_size(
            supported.sample_rate(),
            supported.buffer_size(),
            PULSE_CAPTURE_PERIOD,
        );
    }
    config
}

#[cfg(not(target_os = "linux"))]
fn input_stream_config(_device: &cpal::Device, supported: SupportedStreamConfig) -> StreamConfig {
    supported.config()
}

#[cfg(any(target_os = "linux", test))]
fn capture_buffer_size(
    sample_rate: u32,
    supported: &SupportedBufferSize,
    period: Duration,
) -> BufferSize {
    let SupportedBufferSize::Range { min, max } = *supported else {
        return BufferSize::Default;
    };
    let min = min.max(1);
    if min > max {
        return BufferSize::Default;
    }
    let frames = u64::from(sample_rate)
        .saturating_mul(period.as_nanos().min(u64::MAX as u128) as u64)
        .div_ceil(1_000_000_000)
        .clamp(u64::from(min), u64::from(max));
    BufferSize::Fixed(frames as u32)
}

struct CaptureErrorWriter {
    packets: Sender<AudioPacket>,
    terminal: Arc<AtomicBool>,
}

impl CaptureErrorWriter {
    fn fail(&self) {
        if !self.terminal.swap(true, Ordering::AcqRel) {
            let _ = self
                .packets
                .send(AudioPacket::Error(AudioError::Unavailable));
        }
    }
}

fn select_input_devices(
    host: &cpal::Host,
    preferred_name: Option<&str>,
    preferred_id: Option<&str>,
    match_policy: InputDeviceMatchPolicy,
) -> Result<Vec<cpal::Device>, String> {
    if let Some(preferred_id) = preferred_id {
        let preferred_name = preferred_name
            .and_then(bounded_device_name)
            .ok_or_else(|| "configured microphone name is invalid".to_string())?;
        let preferred_id = bounded_device_id(preferred_id)
            .ok_or_else(|| "configured microphone identifier is invalid".to_string())?;
        let id = cpal::DeviceId::from_str(&preferred_id)
            .map_err(|_| "configured microphone identifier is invalid".to_string())?;
        if !product_input_selector(&id) {
            return Err("configured microphone is unavailable".to_string());
        }
        let device = host
            .device_by_id(&id)
            .filter(|device| {
                device.id().is_ok_and(|current_id| {
                    product_input_candidate(device.supports_input(), &current_id)
                })
            })
            .ok_or_else(|| "configured microphone is unavailable".to_string())?;
        let current_id = device
            .id()
            .ok()
            .map(|id| id.to_string())
            .ok_or_else(|| "configured microphone is unavailable".to_string())?;
        let current_name = device
            .description()
            .ok()
            .map(|description| description.name().to_string())
            .ok_or_else(|| "configured microphone is unavailable".to_string())?;
        if !saved_device_matches(&current_id, &current_name, &preferred_id, &preferred_name) {
            return Err("configured microphone is unavailable".to_string());
        }
        return Ok(vec![device]);
    }
    let Some(preferred_name) = preferred_name else {
        return host
            .default_input_device()
            .filter(|device| {
                device
                    .id()
                    .is_ok_and(|id| system_default_input_selector(&id))
            })
            .map(|device| vec![device])
            .ok_or_else(|| "no microphone is available".to_string());
    };
    let devices = product_input_devices(host)?
        .into_iter()
        .filter_map(|device| {
            let name = device.description().ok()?.name().to_string();
            Some((device, name))
        })
        .collect::<Vec<_>>();
    let names = devices
        .iter()
        .map(|(_, name)| name.as_str())
        .collect::<Vec<_>>();
    let selected = match match_policy {
        InputDeviceMatchPolicy::UniqueExactPublicName => {
            select_exact_device_name_indices(preferred_name, &names)
        }
        InputDeviceMatchPolicy::LegacyFuzzyName => {
            select_legacy_device_name_indices(preferred_name, &names)
        }
    }
    .ok_or_else(|| "configured microphone is unavailable or ambiguous".to_string())?;
    let mut devices = devices.into_iter().map(Some).collect::<Vec<_>>();
    let selected = selected
        .into_iter()
        .filter_map(|index| devices.get_mut(index)?.take())
        .map(|(device, _)| device)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        Err("configured microphone is unavailable".to_string())
    } else {
        Ok(selected)
    }
}

#[cfg(test)]
fn select_device_name_index(preferred: &str, names: &[&str]) -> Option<usize> {
    select_legacy_device_name_indices(preferred, names)?
        .first()
        .copied()
}

fn select_exact_device_name_indices(preferred: &str, names: &[&str]) -> Option<Vec<usize>> {
    if preferred.is_empty() {
        return None;
    }
    let selected = names
        .iter()
        .enumerate()
        .filter_map(|(index, name)| {
            (bounded_device_name(name).as_deref() == Some(preferred)).then_some(index)
        })
        .collect::<Vec<_>>();
    (selected.len() == 1).then_some(selected)
}

fn select_legacy_device_name_indices(preferred: &str, names: &[&str]) -> Option<Vec<usize>> {
    if preferred.is_empty() {
        return None;
    }
    let preferred = preferred.to_lowercase();
    let exact = names
        .iter()
        .enumerate()
        .filter_map(|(index, name)| (name.to_lowercase() == preferred).then_some(index))
        .collect::<Vec<_>>();
    let partial = names
        .iter()
        .enumerate()
        .filter(|(_, name)| {
            let name = name.to_lowercase();
            name != preferred && name.contains(&preferred)
        })
        .collect::<Vec<_>>();
    if exact.len() == 1 {
        return Some(exact);
    }
    (exact.is_empty() && partial.len() == 1)
        .then(|| partial.into_iter().map(|(index, _)| index).collect())
}

fn samples_for_duration(sample_rate: u32, duration: Duration) -> usize {
    usize::try_from(u64::from(sample_rate).saturating_mul(duration.as_secs())).unwrap_or(usize::MAX)
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    mut writer: CaptureWriter,
    error_callback: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample + Sample,
    f32: FromSample<T>,
{
    device.build_input_stream(
        *config,
        move |data: &[T], _| {
            let Some(capture_state) = writer.accepting_state() else {
                return;
            };
            let mut mono = Vec::with_capacity(data.len().div_ceil(channels.max(1)));
            for frame in data.chunks(channels.max(1)) {
                let total = frame
                    .iter()
                    .fold(0.0_f32, |sum, sample| sum + f32::from_sample(*sample));
                mono.push(total / frame.len().max(1) as f32);
            }
            writer.push(capture_state, mono);
        },
        error_callback,
        None,
    )
}

pub struct Resampler {
    step: f64,
    next_position: f64,
    input_index: u64,
    previous: Option<f32>,
}

impl Resampler {
    pub fn new(source_rate: u32) -> Result<Self, String> {
        if source_rate == 0 {
            return Err("microphone reported an invalid sample rate".to_string());
        }
        Ok(Self {
            step: source_rate as f64 / 16_000.0,
            next_position: 0.0,
            input_index: 0,
            previous: None,
        })
    }

    pub fn push(&mut self, input: &[f32], output: &mut Vec<f32>) {
        for &current in input {
            let index = self.input_index as f64;
            if let Some(previous) = self.previous {
                let left = index - 1.0;
                while self.next_position <= index {
                    let fraction = (self.next_position - left).clamp(0.0, 1.0) as f32;
                    output.push(previous + (current - previous) * fraction);
                    self.next_position += self.step;
                }
            } else {
                output.push(current);
                self.next_position += self.step;
            }
            self.previous = Some(current);
            self.input_index = self.input_index.saturating_add(1);
        }
    }

    pub fn reset(&mut self) {
        self.next_position = 0.0;
        self.input_index = 0;
        self.previous = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_writer(
        capacity: usize,
        silence_after: usize,
    ) -> (CaptureWriter, Receiver<AudioPacket>, Arc<CaptureGate>) {
        let (packets, receiver) = crossbeam_channel::unbounded();
        let gate = Arc::new(CaptureGate::new());
        (
            CaptureWriter {
                packets,
                buffered_samples: Arc::new(AtomicUsize::new(0)),
                max_buffered_samples: capacity,
                terminal: Arc::new(AtomicBool::new(false)),
                gate: Arc::clone(&gate),
                silence: SilenceDetector {
                    zero_samples: 0,
                    threshold_samples: silence_after,
                    armed: true,
                    capture_state: None,
                },
            },
            receiver,
            gate,
        )
    }

    fn push_samples(writer: &mut CaptureWriter, samples: Vec<f32>) {
        let capture_state = writer.gate.accepting_state().expect("capture gate is open");
        writer.push(capture_state, samples);
    }

    fn receive_samples(receiver: &Receiver<AudioPacket>) -> Vec<f32> {
        let packet = receiver.recv().expect("packet");
        assert!(matches!(&packet, AudioPacket::Samples(_)));
        if let AudioPacket::Samples(samples) = packet {
            samples.as_slice().to_vec()
        } else {
            Vec::new()
        }
    }

    #[test]
    fn capture_buffer_preserves_callback_order() {
        let (mut writer, receiver, _gate) = test_writer(6, usize::MAX);
        push_samples(&mut writer, vec![1.0, 2.0]);
        push_samples(&mut writer, vec![3.0]);
        push_samples(&mut writer, vec![4.0, 5.0, 6.0]);

        let mut actual = Vec::new();
        for _ in 0..3 {
            actual.extend(receive_samples(&receiver));
        }
        assert_eq!(actual, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn low_latency_capture_period_is_clamped_to_the_supported_range() {
        let range = SupportedBufferSize::Range {
            min: 1,
            max: 16_384,
        };
        assert_eq!(
            capture_buffer_size(48_000, &range, PULSE_CAPTURE_PERIOD),
            BufferSize::Fixed(1_920)
        );
        assert_eq!(
            capture_buffer_size(
                48_000,
                &SupportedBufferSize::Range {
                    min: 2_048,
                    max: 16_384,
                },
                PULSE_CAPTURE_PERIOD,
            ),
            BufferSize::Fixed(2_048)
        );
        assert_eq!(
            capture_buffer_size(
                48_000,
                &SupportedBufferSize::Range { min: 1, max: 512 },
                PULSE_CAPTURE_PERIOD,
            ),
            BufferSize::Fixed(512)
        );
    }

    #[test]
    fn capture_period_uses_the_backend_default_without_a_valid_range() {
        assert_eq!(
            capture_buffer_size(48_000, &SupportedBufferSize::Unknown, PULSE_CAPTURE_PERIOD),
            BufferSize::Default
        );
        assert_eq!(
            capture_buffer_size(
                48_000,
                &SupportedBufferSize::Range { min: 2, max: 1 },
                PULSE_CAPTURE_PERIOD,
            ),
            BufferSize::Default
        );
    }

    #[test]
    fn capture_overflow_terminates_instead_of_skipping_a_middle_chunk() {
        let (mut writer, receiver, _gate) = test_writer(4, usize::MAX);
        push_samples(&mut writer, vec![1.0, 2.0, 3.0]);
        push_samples(&mut writer, vec![4.0, 5.0]);
        push_samples(&mut writer, vec![6.0]);

        assert_eq!(receive_samples(&receiver), vec![1.0, 2.0, 3.0]);
        assert!(matches!(
            receiver.recv().expect("terminal error"),
            AudioPacket::Error(AudioError::Overflow)
        ));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn mute_gate_rejects_callbacks_and_packets_from_the_old_generation() {
        let (mut writer, receiver, gate) = test_writer(8, usize::MAX);
        let control = CaptureControl::default();
        let _registration = control.activate(7, Arc::clone(&gate));
        let old_state = writer.accepting_state().expect("capture starts open");
        writer.push(old_state, vec![1.0, 2.0]);

        let request = control.request_mute(7, true).expect("active request");
        assert!(writer.accepting_state().is_none());
        writer.push(old_state, vec![3.0, 4.0]);
        assert_eq!(
            gate.apply(request, true),
            MuteOutcome {
                muted: true,
                changed: true,
            }
        );

        assert_eq!(receive_samples(&receiver), vec![1.0, 2.0]);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn segment_boundary_identifies_the_queued_tail_and_reopens_fresh() {
        let (mut writer, receiver, gate) = test_writer(8, usize::MAX);
        let control = CaptureControl::default();
        let _registration = control.activate(7, Arc::clone(&gate));
        let old_state = writer.accepting_state().expect("capture starts open");
        writer.push(old_state, vec![1.0, 2.0]);

        let boundary = control
            .request_segment_boundary(7)
            .expect("active request boundary");
        assert!(writer.accepting_state().is_none());
        let old_packet = receiver.recv().expect("queued old-generation tail");
        assert!(matches!(&old_packet, AudioPacket::Samples(_)));
        let AudioPacket::Samples(old_samples) = old_packet else {
            return;
        };
        assert!(boundary.accepts_previous(old_samples.capture_state()));

        assert_eq!(gate.apply_segment_boundary(boundary), Some(false));
        let fresh_state = writer.accepting_state().expect("boundary reopens capture");
        assert_ne!(fresh_state, old_state);
        assert!(!boundary.accepts_previous(fresh_state));
        writer.push(fresh_state, vec![3.0, 4.0]);
        assert_eq!(receive_samples(&receiver), vec![3.0, 4.0]);
    }

    #[test]
    fn segment_boundary_preserves_an_existing_mute() {
        let gate = Arc::new(CaptureGate::new());
        let control = CaptureControl::default();
        let _registration = control.activate(11, Arc::clone(&gate));
        let mute = control.request_mute(11, true).expect("mute request");
        assert!(gate.apply(mute, true).muted);

        let boundary = control
            .request_segment_boundary(11)
            .expect("muted request boundary");
        assert_eq!(gate.apply_segment_boundary(boundary), Some(true));
        assert!(gate.accepting_state().is_none());
    }

    #[test]
    fn callback_lease_quiesces_a_closed_capture_boundary() {
        let gate = Arc::new(CaptureGate::new());
        let old_state = gate.accepting_state().expect("capture starts open");
        let worker_gate = Arc::clone(&gate);
        let (acquired, acquired_rx) = crossbeam_channel::bounded(1);
        let (release, release_rx) = crossbeam_channel::bounded(1);
        let worker = std::thread::spawn(move || {
            let lease = worker_gate
                .admit_callback(old_state)
                .expect("old callback admitted");
            acquired.send(()).expect("test owns acquisition receiver");
            release_rx.recv().expect("test releases callback");
            drop(lease);
        });
        acquired_rx.recv().expect("callback lease acquired");

        let boundary = gate.close_for_segment_boundary();
        assert!(!gate.wait_for_callback_quiescence(Duration::ZERO));
        release.send(()).expect("release callback lease");
        assert!(gate.wait_for_callback_quiescence(Duration::from_secs(1)));
        assert_eq!(gate.apply_segment_boundary(boundary), Some(false));
        worker.join().expect("callback worker");
    }

    #[test]
    fn boundary_quiescence_observes_a_late_admitted_enqueue_before_drain() {
        let (writer, receiver, gate) = test_writer(8, usize::MAX);
        let old_state = gate.accepting_state().expect("capture starts open");
        let lease = gate
            .admit_callback(old_state)
            .expect("callback admitted before boundary");
        let boundary = gate.close_for_segment_boundary();
        assert!(receiver.try_recv().is_err());

        let reservation = writer.reserve(2).expect("bounded packet reservation");
        writer
            .packets
            .send(AudioPacket::Samples(BufferedSamples {
                samples: vec![1.0, 2.0],
                capture_state: old_state,
                _reservation: reservation,
            }))
            .expect("admitted callback enqueues its packet");
        drop(lease);

        assert!(gate.wait_for_callback_quiescence(Duration::from_secs(1)));
        let packet = receiver.recv().expect("late old-generation packet");
        let AudioPacket::Samples(samples) = packet else {
            return;
        };
        assert!(boundary.accepts_previous(samples.capture_state()));
        assert_eq!(samples.as_slice(), &[1.0, 2.0]);
        assert_eq!(gate.apply_segment_boundary(boundary), Some(false));
    }

    #[test]
    fn stale_segment_boundary_never_changes_the_active_capture() {
        let gate = Arc::new(CaptureGate::new());
        let control = CaptureControl::default();
        let _registration = control.activate(3, Arc::clone(&gate));
        let state = gate.accepting_state();

        assert!(control.request_segment_boundary(4).is_none());
        assert_eq!(gate.accepting_state(), state);
    }

    #[test]
    fn rapid_mute_unmute_mute_acknowledges_each_fifo_state() {
        let gate = Arc::new(CaptureGate::new());
        let control = CaptureControl::default();
        let _registration = control.activate(11, Arc::clone(&gate));

        let mute = control.request_mute(11, true).expect("mute request");
        assert_eq!(
            gate.apply(mute, true),
            MuteOutcome {
                muted: true,
                changed: true,
            }
        );
        let unmute = control.request_mute(11, false).expect("unmute request");
        assert_eq!(
            gate.apply(unmute, false),
            MuteOutcome {
                muted: false,
                changed: true,
            }
        );
        let mute_again = control.request_mute(11, true).expect("second mute request");
        assert_eq!(
            gate.apply(mute_again, true),
            MuteOutcome {
                muted: true,
                changed: true,
            }
        );

        let state = gate.state.load(Ordering::Acquire);
        let duplicate = control.request_mute(11, true).expect("duplicate mute");
        assert_eq!(
            gate.apply(duplicate, true),
            MuteOutcome {
                muted: true,
                changed: false,
            }
        );
        assert_eq!(gate.state.load(Ordering::Acquire), state);
    }

    #[test]
    fn stale_mute_request_never_changes_the_active_capture() {
        let gate = Arc::new(CaptureGate::new());
        let control = CaptureControl::default();
        let _registration = control.activate(3, Arc::clone(&gate));

        assert!(control.request_mute(4, true).is_none());
        assert!(gate.accepting_state().is_some());
    }

    #[test]
    fn silence_detector_requires_sustained_exact_zero_input_at_startup() {
        let mut detector = SilenceDetector {
            zero_samples: 0,
            threshold_samples: 5,
            armed: true,
            capture_state: None,
        };
        assert!(!detector.observe(0, &[0.0, 0.0, 0.0]));
        assert!(!detector.observe(0, &[0.0]));
        assert!(detector.observe(0, &[0.0]));
    }

    #[test]
    fn any_startup_signal_permanently_disarms_silence_detection() {
        let mut detector = SilenceDetector {
            zero_samples: 0,
            threshold_samples: 5,
            armed: true,
            capture_state: None,
        };
        assert!(!detector.observe(0, &[0.0, 0.0, f32::EPSILON]));
        assert!(!detector.observe(2, &[0.0; 20]));
    }

    #[test]
    fn startup_silence_window_restarts_after_a_capture_generation_change() {
        let mut detector = SilenceDetector {
            zero_samples: 0,
            threshold_samples: 5,
            armed: true,
            capture_state: None,
        };
        assert!(!detector.observe(0, &[0.0; 4]));
        assert!(!detector.observe(2, &[0.0]));
        assert!(detector.observe(2, &[0.0; 4]));
    }

    #[test]
    fn device_selection_prefers_exact_then_unique_case_insensitive_substring() {
        let names = ["Monitor of Shure MV6", "Shure MV6", "Built-in Audio"];
        assert_eq!(select_device_name_index("Shure MV6", &names), Some(1));
        assert_eq!(select_device_name_index("built-IN", &names), Some(2));
        assert_eq!(select_device_name_index("shure", &names), None);
        assert_eq!(select_device_name_index("missing", &names), None);
        assert_eq!(select_device_name_index("", &names), None);
    }

    #[test]
    fn duplicate_exact_device_names_are_ambiguous() {
        assert_eq!(
            select_device_name_index("Microphone", &["Microphone", "Microphone"]),
            None
        );
    }

    #[test]
    fn exact_legacy_match_wins_over_backend_alias_substrings() {
        let names = [
            "Shure MV6",
            "Shure MV6, USB Audio",
            "Shure MV6, USB Audio",
            "Built-in Audio",
        ];
        assert_eq!(select_device_name_index("Shure MV6", &names), Some(0));
        assert_eq!(
            select_legacy_device_name_indices("Shure MV6", &names),
            Some(vec![0])
        );
        assert_eq!(select_device_name_index("audio", &names), None);
    }

    #[test]
    fn exact_device_selection_never_uses_case_or_substring_fallback() {
        let names = ["Shure MV6", "Shure MV6, USB Audio", "Built-in Audio"];
        assert_eq!(
            select_exact_device_name_indices("Shure MV6", &names),
            Some(vec![0])
        );
        assert_eq!(select_exact_device_name_indices("shure mv6", &names), None);
        assert_eq!(select_exact_device_name_indices("Shure", &names), None);
        assert_eq!(select_exact_device_name_indices("", &names), None);
    }

    #[test]
    fn exact_name_selection_rejects_duplicate_devices() {
        let names = [
            "Same microphone",
            "Same microphone",
            "Same microphone (USB)",
        ];
        assert_eq!(
            select_exact_device_name_indices("Same microphone", &names),
            None
        );
        assert_eq!(
            select_exact_device_name_indices("same microphone", &names),
            None
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_product_filter_excludes_outputs_monitors_and_backend_defaults() {
        let source = cpal::DeviceId::from_str("pulseaudio:source-a").expect("valid source ID");
        let monitor =
            cpal::DeviceId::from_str("pulseaudio:sink-a.monitor").expect("valid monitor ID");
        let default =
            cpal::DeviceId::from_str("pulseaudio:@DEFAULT_SOURCE@").expect("valid default ID");

        assert!(product_input_candidate(true, &source));
        assert!(!product_input_candidate(false, &source));
        assert!(!product_input_candidate(true, &monitor));
        assert!(!product_input_candidate(true, &default));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn system_default_rejects_pulse_monitors_but_allows_opaque_alsa_capture() {
        let source = cpal::DeviceId::from_str("pulseaudio:source-a").expect("valid source ID");
        let monitor =
            cpal::DeviceId::from_str("pulseaudio:sink-a.monitor").expect("valid monitor ID");
        let placeholder =
            cpal::DeviceId::from_str("pulseaudio:@DEFAULT_SOURCE@").expect("valid default ID");
        let alsa_default = cpal::DeviceId::from_str("alsa:default").expect("valid ALSA default ID");

        assert!(system_default_input_selector(&source));
        assert!(!system_default_input_selector(&monitor));
        assert!(!system_default_input_selector(&placeholder));
        assert!(system_default_input_selector(&alsa_default));

        let listed = normalize_input_devices(
            [(source.to_string(), "Microphone".to_string())],
            Some(&monitor.to_string()),
        );
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].is_default);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn alsa_product_filter_collapses_four_pcm_aliases_to_one_conversion_selector() {
        let candidates = [
            "alsa:sysdefault:CARD=CardA",
            "alsa:front:CARD=CardA,DEV=0",
            "alsa:hw:CARD=0,DEV=0",
            "alsa:plughw:CARD=0,DEV=0",
        ];
        let listed = normalize_input_devices(
            candidates.into_iter().filter_map(|value| {
                let id = cpal::DeviceId::from_str(value).ok()?;
                product_input_candidate(true, &id)
                    .then(|| (id.to_string(), "Logical microphone".to_string()))
            }),
            None,
        );

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "alsa:plughw:CARD=0,DEV=0");
    }

    #[test]
    fn device_listing_deduplicates_ids_and_places_the_default_first() {
        let devices = [
            ("alsa:z", "Zulu"),
            ("alsa:a", "Alpha"),
            ("alsa:d", "Default microphone"),
            ("alsa:a", "Alpha"),
        ]
        .map(|(id, name)| (id.to_string(), name.to_string()));
        assert_eq!(
            normalize_input_devices(devices, Some("alsa:d")),
            vec![
                InputDeviceInfo {
                    id: "alsa:d".to_string(),
                    name: "Default microphone".to_string(),
                    is_default: true,
                },
                InputDeviceInfo {
                    id: "alsa:a".to_string(),
                    name: "Alpha".to_string(),
                    is_default: false,
                },
                InputDeviceInfo {
                    id: "alsa:z".to_string(),
                    name: "Zulu".to_string(),
                    is_default: false,
                },
            ]
        );
    }

    #[test]
    fn device_listing_keeps_distinct_ids_when_display_names_match() {
        let devices = [
            (
                "alsa:plughw:CARD=0,DEV=0".to_string(),
                "USB microphone".to_string(),
            ),
            (
                "alsa:plughw:CARD=1,DEV=0".to_string(),
                "USB microphone".to_string(),
            ),
        ];

        let listed = normalize_input_devices(devices, Some("alsa:plughw:CARD=1,DEV=0"));

        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "alsa:plughw:CARD=1,DEV=0");
        assert_eq!(listed[1].id, "alsa:plughw:CARD=0,DEV=0");
        assert!(listed[0].is_default);
    }

    #[test]
    fn saved_selector_reopen_requires_the_exact_id_and_name() {
        assert!(saved_device_matches(
            "pulseaudio:source-a",
            "Studio microphone",
            "pulseaudio:source-a",
            "Studio microphone",
        ));
        assert!(!saved_device_matches(
            "pulseaudio:source-b",
            "Studio microphone",
            "pulseaudio:source-a",
            "Studio microphone",
        ));
        assert!(!saved_device_matches(
            "pulseaudio:source-a",
            "Other microphone",
            "pulseaudio:source-a",
            "Studio microphone",
        ));
    }

    #[test]
    fn device_listing_is_deterministic_and_keeps_the_default_within_its_cap() {
        let devices = (0..40)
            .rev()
            .map(|index| {
                (
                    format!("alsa:mic-{index:02}"),
                    format!("Microphone {index:02}"),
                )
            })
            .collect::<Vec<_>>();
        let listed = normalize_input_devices(devices.clone(), Some("alsa:mic-39"));
        let mut reversed = devices;
        reversed.reverse();

        assert_eq!(listed.len(), MAX_INPUT_DEVICES);
        assert_eq!(listed[0].name, "Microphone 39");
        assert!(listed[0].is_default);
        assert_eq!(
            listed,
            normalize_input_devices(reversed, Some("alsa:mic-39"))
        );
    }

    #[test]
    fn invalid_or_overlong_public_device_fields_are_omitted() {
        let long_name = format!("{}é ignored", "a".repeat(MAX_DEVICE_NAME_BYTES - 1));
        assert_eq!(bounded_device_name("  "), None);
        assert_eq!(bounded_device_name(&long_name), None);
        assert_eq!(bounded_device_id("bad\nid"), None);
        assert_eq!(bounded_device_id(" opaque-id"), None);
        assert_eq!(
            bounded_device_id(&"x".repeat(MAX_DEVICE_ID_BYTES + 1)),
            None
        );
        assert!(saved_device_name_matches(
            " USB microphone ",
            "USB microphone"
        ));
        assert!(!saved_device_name_matches(
            "Other microphone",
            "USB microphone"
        ));
    }

    #[test]
    fn resampling_is_continuous_across_callback_boundaries() {
        let input = (0..4_800)
            .map(|index| index as f32 / 4_800.0)
            .collect::<Vec<_>>();
        let mut one_pass = Resampler::new(48_000).expect("valid rate");
        let mut expected = Vec::new();
        one_pass.push(&input, &mut expected);

        let mut chunked = Resampler::new(48_000).expect("valid rate");
        let mut actual = Vec::new();
        for chunk in input.chunks(137) {
            chunked.push(chunk, &mut actual);
        }
        assert_eq!(actual, expected);
        assert!((1_599..=1_601).contains(&actual.len()));
    }

    #[test]
    fn resampling_upsamples_without_unbounded_state() {
        let mut resampler = Resampler::new(8_000).expect("valid rate");
        let mut output = Vec::new();
        resampler.push(&[0.0, 1.0, 0.0], &mut output);
        assert!((5..=6).contains(&output.len()));
        assert!(output.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn resampler_reset_does_not_bridge_audio_across_capture_generations() {
        let mut resampler = Resampler::new(48_000).expect("valid rate");
        let mut output = Vec::new();
        resampler.push(&[1.0, 1.0], &mut output);

        resampler.reset();
        output.clear();
        resampler.push(&[0.0], &mut output);

        assert_eq!(output, vec![0.0]);
    }
}
