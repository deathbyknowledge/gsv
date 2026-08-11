use std::f32::consts::TAU;
use std::num::{NonZeroU16, NonZeroU32};

use rodio::buffer::SamplesBuffer;
use rodio::{DeviceSinkBuilder, MixerDeviceSink};

#[derive(Clone, Copy)]
pub enum KeySound {
    Character,
    Space,
    Delete,
    Commit,
}

pub struct TypingAudio {
    sink: Option<MixerDeviceSink>,
    sequence: u64,
}

impl TypingAudio {
    pub fn new(enabled: bool) -> Self {
        Self {
            sink: enabled
                .then(DeviceSinkBuilder::open_default_sink)
                .and_then(Result::ok),
            sequence: 0,
        }
    }

    pub fn play(&mut self, sound: KeySound) {
        let Some(sink) = &self.sink else {
            return;
        };
        self.sequence = self.sequence.wrapping_add(1);
        let samples = synthesize_click(sound, self.sequence);
        let source = SamplesBuffer::new(
            NonZeroU16::new(1).expect("one audio channel is non-zero"),
            NonZeroU32::new(SAMPLE_RATE).expect("sample rate is non-zero"),
            samples,
        );
        sink.mixer().add(source);
    }
}

const SAMPLE_RATE: u32 = 48_000;

fn synthesize_click(sound: KeySound, sequence: u64) -> Vec<f32> {
    let (duration, body_frequency, amplitude) = match sound {
        KeySound::Character => (0.022, 1_760.0, 0.032),
        KeySound::Space => (0.027, 1_120.0, 0.027),
        KeySound::Delete => (0.018, 720.0, 0.025),
        KeySound::Commit => (0.045, 1_360.0, 0.038),
    };
    let sample_count = (SAMPLE_RATE as f32 * duration) as usize;
    let variation = ((sequence % 7) as f32 - 3.0) * 9.0;

    (0..sample_count)
        .map(|index| {
            let t = index as f32 / SAMPLE_RATE as f32;
            let position = index as f32 / sample_count.max(1) as f32;
            let envelope = (1.0 - position).powf(4.8);
            let transient = if index < 14 {
                (1.0 - index as f32 / 14.0) * 0.65
            } else {
                0.0
            };
            let tone = (TAU * (body_frequency + variation) * t).sin() * 0.52
                + (TAU * (body_frequency * 0.47) * t).sin() * 0.18;
            (tone + transient) * envelope * amplitude
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_is_short_and_fades_to_silence() {
        let samples = synthesize_click(KeySound::Character, 1);
        assert!(samples.len() < 2_000);
        assert!(samples.last().copied().unwrap_or_default().abs() < 0.000_1);
    }
}
