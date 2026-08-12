use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream};
use crossbeam_channel::{Receiver, Sender};

pub enum AudioPacket {
    Samples(Vec<f32>),
    Error(String),
}

pub struct AudioCapture {
    _stream: Stream,
    pub packets: Receiver<AudioPacket>,
    pub sample_rate: u32,
}

impl AudioCapture {
    pub fn open() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "no microphone is available".to_string())?;
        let supported = device
            .default_input_config()
            .map_err(|error| format!("microphone is unavailable: {error}"))?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels() as usize;
        let config = supported.config();
        let (tx, packets) = crossbeam_channel::bounded::<AudioPacket>(8);
        let errors = tx.clone();
        let error_callback = move |error: cpal::Error| {
            let _ = errors.try_send(AudioPacket::Error(format!("microphone failed: {error}")));
        };

        let stream = match supported.sample_format() {
            SampleFormat::I8 => build_stream::<i8>(&device, &config, channels, tx, error_callback),
            SampleFormat::I16 => {
                build_stream::<i16>(&device, &config, channels, tx, error_callback)
            }
            SampleFormat::I32 => {
                build_stream::<i32>(&device, &config, channels, tx, error_callback)
            }
            SampleFormat::I64 => {
                build_stream::<i64>(&device, &config, channels, tx, error_callback)
            }
            SampleFormat::U8 => build_stream::<u8>(&device, &config, channels, tx, error_callback),
            SampleFormat::U16 => {
                build_stream::<u16>(&device, &config, channels, tx, error_callback)
            }
            SampleFormat::U32 => {
                build_stream::<u32>(&device, &config, channels, tx, error_callback)
            }
            SampleFormat::U64 => {
                build_stream::<u64>(&device, &config, channels, tx, error_callback)
            }
            SampleFormat::F32 => {
                build_stream::<f32>(&device, &config, channels, tx, error_callback)
            }
            SampleFormat::F64 => {
                build_stream::<f64>(&device, &config, channels, tx, error_callback)
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

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    tx: Sender<AudioPacket>,
    error_callback: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample + Sample,
    f32: FromSample<T>,
{
    device.build_input_stream(
        *config,
        move |data: &[T], _| {
            let mut mono = Vec::with_capacity(data.len() / channels.max(1));
            for frame in data.chunks(channels.max(1)) {
                let total = frame
                    .iter()
                    .fold(0.0_f32, |sum, sample| sum + f32::from_sample(*sample));
                mono.push(total / frame.len().max(1) as f32);
            }
            let _ = tx.try_send(AudioPacket::Samples(mono));
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
