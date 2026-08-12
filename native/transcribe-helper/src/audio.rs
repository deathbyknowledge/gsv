use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream};
use crossbeam_channel::{Receiver, Sender};

const CAPTURE_BUFFER_DURATION: Duration = Duration::from_secs(5);
const SILENT_INPUT_DURATION: Duration = Duration::from_secs(2);

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
    _reservation: SampleReservation,
}

impl BufferedSamples {
    pub fn as_slice(&self) -> &[f32] {
        &self.samples
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
    silence: SilenceDetector,
}

impl CaptureWriter {
    fn push(&mut self, samples: Vec<f32>) {
        if samples.is_empty() || self.terminal.load(Ordering::Acquire) {
            return;
        }
        if self.silence.observe(&samples) {
            self.fail(AudioError::Silent);
            return;
        }

        let Some(reservation) = self.reserve(samples.len()) else {
            self.fail(AudioError::Overflow);
            return;
        };
        if self
            .packets
            .send(AudioPacket::Samples(BufferedSamples {
                samples,
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
}

impl SilenceDetector {
    fn new(sample_rate: u32) -> Self {
        Self {
            zero_samples: 0,
            threshold_samples: samples_for_duration(sample_rate, SILENT_INPUT_DURATION),
            armed: true,
        }
    }

    fn observe(&mut self, samples: &[f32]) -> bool {
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
}

impl AudioCapture {
    pub fn open(preferred_name: Option<&str>) -> Result<Self, String> {
        let host = cpal::default_host();
        let devices = select_input_devices(&host, preferred_name)?;
        let mut last_error = None;
        for device in devices {
            match Self::open_device(device) {
                Ok(capture) => return Ok(capture),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| "configured microphone is unavailable".to_string()))
    }

    fn open_device(device: cpal::Device) -> Result<Self, String> {
        let supported = device
            .default_input_config()
            .map_err(|error| format!("microphone is unavailable: {error}"))?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels() as usize;
        let config = supported.config();
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
        })
    }
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
) -> Result<Vec<cpal::Device>, String> {
    let Some(preferred_name) = preferred_name else {
        return host
            .default_input_device()
            .map(|device| vec![device])
            .ok_or_else(|| "no microphone is available".to_string());
    };
    let devices = host
        .input_devices()
        .map_err(|error| format!("microphones are unavailable: {error}"))?
        .filter_map(|device| {
            let name = device.description().ok()?.name().to_string();
            Some((device, name))
        })
        .collect::<Vec<_>>();
    let names = devices
        .iter()
        .map(|(_, name)| name.as_str())
        .collect::<Vec<_>>();
    let selected = select_device_name_indices(preferred_name, &names)
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
    select_device_name_indices(preferred, names)?
        .first()
        .copied()
}

fn select_device_name_indices(preferred: &str, names: &[&str]) -> Option<Vec<usize>> {
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
    let partial_name = partial.first().map(|(_, name)| name.to_lowercase());
    let one_partial_name = partial_name.as_ref().is_some_and(|first| {
        partial
            .iter()
            .all(|(_, name)| name.to_lowercase() == *first)
    });

    if !exact.is_empty() {
        let mut candidates = exact;
        if one_partial_name {
            candidates.extend(partial.into_iter().map(|(index, _)| index));
        }
        return Some(candidates);
    }
    one_partial_name.then(|| partial.into_iter().map(|(index, _)| index).collect())
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
            let mut mono = Vec::with_capacity(data.len().div_ceil(channels.max(1)));
            for frame in data.chunks(channels.max(1)) {
                let total = frame
                    .iter()
                    .fold(0.0_f32, |sum, sample| sum + f32::from_sample(*sample));
                mono.push(total / frame.len().max(1) as f32);
            }
            writer.push(mono);
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_writer(
        capacity: usize,
        silence_after: usize,
    ) -> (CaptureWriter, Receiver<AudioPacket>) {
        let (packets, receiver) = crossbeam_channel::unbounded();
        (
            CaptureWriter {
                packets,
                buffered_samples: Arc::new(AtomicUsize::new(0)),
                max_buffered_samples: capacity,
                terminal: Arc::new(AtomicBool::new(false)),
                silence: SilenceDetector {
                    zero_samples: 0,
                    threshold_samples: silence_after,
                    armed: true,
                },
            },
            receiver,
        )
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
        let (mut writer, receiver) = test_writer(6, usize::MAX);
        writer.push(vec![1.0, 2.0]);
        writer.push(vec![3.0]);
        writer.push(vec![4.0, 5.0, 6.0]);

        let mut actual = Vec::new();
        for _ in 0..3 {
            actual.extend(receive_samples(&receiver));
        }
        assert_eq!(actual, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn capture_overflow_terminates_instead_of_skipping_a_middle_chunk() {
        let (mut writer, receiver) = test_writer(4, usize::MAX);
        writer.push(vec![1.0, 2.0, 3.0]);
        writer.push(vec![4.0, 5.0]);
        writer.push(vec![6.0]);

        assert_eq!(receive_samples(&receiver), vec![1.0, 2.0, 3.0]);
        assert!(matches!(
            receiver.recv().expect("terminal error"),
            AudioPacket::Error(AudioError::Overflow)
        ));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn silence_detector_requires_sustained_exact_zero_input_at_startup() {
        let mut detector = SilenceDetector {
            zero_samples: 0,
            threshold_samples: 5,
            armed: true,
        };
        assert!(!detector.observe(&[0.0, 0.0, 0.0]));
        assert!(!detector.observe(&[0.0]));
        assert!(detector.observe(&[0.0]));
    }

    #[test]
    fn any_startup_signal_permanently_disarms_silence_detection() {
        let mut detector = SilenceDetector {
            zero_samples: 0,
            threshold_samples: 5,
            armed: true,
        };
        assert!(!detector.observe(&[0.0, 0.0, f32::EPSILON]));
        assert!(!detector.observe(&[0.0; 20]));
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
    fn duplicate_exact_device_aliases_select_the_first() {
        assert_eq!(
            select_device_name_index("Microphone", &["Microphone", "Microphone"]),
            Some(0)
        );
    }

    #[test]
    fn duplicate_backend_aliases_with_one_human_name_are_not_ambiguous() {
        let names = [
            "Shure MV6",
            "Shure MV6, USB Audio",
            "Shure MV6, USB Audio",
            "Built-in Audio",
        ];
        assert_eq!(select_device_name_index("Shure MV6", &names), Some(0));
        assert_eq!(
            select_device_name_indices("Shure MV6", &names),
            Some(vec![0, 1, 2])
        );
        assert_eq!(select_device_name_index("audio", &names), None);
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
}
