use std::num::{NonZeroU16, NonZeroU32};
use std::time::{Duration, Instant};

use rodio::buffer::SamplesBuffer;
use rodio::{DeviceSinkBuilder, MixerDeviceSink};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeySound {
    Character,
    Space,
    Delete,
    Commit,
}

pub struct TypingAudio {
    sink: Option<MixerDeviceSink>,
    playback_gate: PlaybackGate,
    sequence: u64,
}

impl TypingAudio {
    pub fn new(enabled: bool) -> Self {
        Self {
            sink: enabled
                .then(DeviceSinkBuilder::open_default_sink)
                .and_then(Result::ok),
            playback_gate: PlaybackGate::default(),
            sequence: 0,
        }
    }

    pub fn play(&mut self, sound: KeySound) {
        if self.sink.is_none() || !self.playback_gate.allows(sound, Instant::now()) {
            return;
        }

        self.sequence = self.sequence.wrapping_add(1);
        let samples = synthesize_sound(sound, self.sequence);
        let source = SamplesBuffer::new(
            NonZeroU16::new(1).expect("one audio channel is non-zero"),
            NonZeroU32::new(SAMPLE_RATE).expect("sample rate is non-zero"),
            samples,
        );
        if let Some(sink) = &self.sink {
            sink.mixer().add(source);
        }
    }
}

const SAMPLE_RATE: u32 = 48_000;
const MIN_PLAYBACK_INTERVAL: Duration = Duration::from_millis(18);

#[derive(Default)]
struct PlaybackGate {
    last_playback: Option<Instant>,
}

impl PlaybackGate {
    fn allows(&mut self, sound: KeySound, now: Instant) -> bool {
        if sound != KeySound::Commit
            && self
                .last_playback
                .is_some_and(|last| now.saturating_duration_since(last) < MIN_PLAYBACK_INTERVAL)
        {
            return false;
        }

        self.last_playback = Some(now);
        true
    }
}

#[derive(Clone, Copy)]
struct SoundProfile {
    duration_ms: u32,
    gain: f32,
    surface_response: f32,
    body_response: f32,
    grain: f32,
}

impl SoundProfile {
    fn for_sound(sound: KeySound) -> Self {
        match sound {
            KeySound::Character => Self {
                duration_ms: 24,
                gain: 0.028,
                surface_response: 0.28,
                body_response: 0.055,
                grain: 0.07,
            },
            KeySound::Space => Self {
                duration_ms: 31,
                gain: 0.024,
                surface_response: 0.11,
                body_response: 0.032,
                grain: 0.025,
            },
            KeySound::Delete => Self {
                duration_ms: 38,
                gain: 0.025,
                surface_response: 0.19,
                body_response: 0.041,
                grain: 0.11,
            },
            KeySound::Commit => Self {
                duration_ms: 68,
                gain: 0.03,
                surface_response: 0.14,
                body_response: 0.027,
                grain: 0.04,
            },
        }
    }
}

fn synthesize_sound(sound: KeySound, sequence: u64) -> Vec<f32> {
    let profile = SoundProfile::for_sound(sound);
    let sample_count = (SAMPLE_RATE as usize * profile.duration_ms as usize) / 1_000;
    let mut noise = Noise::new(seed_for(sound, sequence));
    let timbre_variation = ((sequence.wrapping_mul(17) % 9) as f32 - 4.0) * 0.004;
    let surface_response = (profile.surface_response + timbre_variation).clamp(0.04, 0.42);
    let mut surface = 0.0;
    let mut body = 0.0;
    let mut samples = Vec::with_capacity(sample_count);

    for index in 0..sample_count {
        let white = noise.next_bipolar();
        surface += surface_response * (white - surface);
        body += profile.body_response * (surface - body);

        let position = index as f32 / sample_count.saturating_sub(1).max(1) as f32;
        let envelope = sound_envelope(sound, position);
        let texture = body * 0.54 + surface * 0.42 + white * profile.grain;
        let fade_out = ((sample_count.saturating_sub(1 + index)) as f32 / 48.0).min(1.0);
        samples.push(texture * envelope * fade_out * profile.gain);
    }

    samples
}

fn sound_envelope(sound: KeySound, position: f32) -> f32 {
    match sound {
        KeySound::Character => {
            pulse(position, 0.0, 0.68, 3.8) + pulse(position, 0.24, 0.52, 3.2) * 0.16
        }
        KeySound::Space => {
            pulse(position, 0.0, 0.9, 2.8) * 0.62 + pulse(position, 0.34, 0.5, 2.5) * 0.15
        }
        KeySound::Delete => {
            pulse(position, 0.0, 0.46, 2.5) * 0.48
                + pulse(position, 0.12, 0.86, 1.7) * 0.58
                + pulse(position, 0.44, 0.34, 2.2) * 0.18
        }
        KeySound::Commit => {
            pulse(position, 0.0, 0.42, 2.9) * 0.78
                + pulse(position, 0.21, 0.46, 2.5) * 0.55
                + pulse(position, 0.46, 0.54, 1.8) * 0.2
        }
    }
}

fn pulse(position: f32, start: f32, span: f32, decay: f32) -> f32 {
    let local = (position - start) / span;
    if !(0.0..=1.0).contains(&local) {
        return 0.0;
    }

    let attack_position = (local / 0.065).min(1.0);
    let attack = attack_position * attack_position * (3.0 - 2.0 * attack_position);
    attack * (1.0 - local).powf(decay)
}

fn seed_for(sound: KeySound, sequence: u64) -> u64 {
    let voice = match sound {
        KeySound::Character => 0x243f_6a88_85a3_08d3,
        KeySound::Space => 0x1319_8a2e_0370_7344,
        KeySound::Delete => 0xa409_3822_299f_31d0,
        KeySound::Commit => 0x082e_fa98_ec4e_6c89,
    };
    let mut value = sequence ^ voice;
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    (value ^ (value >> 31)).max(1)
}

struct Noise {
    state: u64,
}

impl Noise {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_bipolar(&mut self) -> f32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 7;
        self.state ^= self.state << 17;
        let unit = (self.state >> 40) as f32 / ((1_u32 << 24) - 1) as f32;
        unit * 2.0 - 1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn muted_audio_does_not_open_an_output_sink() {
        let audio = TypingAudio::new(false);
        assert!(audio.sink.is_none());
    }

    #[test]
    fn palette_is_deterministic_and_varied() {
        let first = synthesize_sound(KeySound::Character, 7);
        let repeated = synthesize_sound(KeySound::Character, 7);
        let varied = synthesize_sound(KeySound::Character, 8);

        assert_eq!(first, repeated);
        assert_ne!(first, varied);
    }

    #[test]
    fn each_sound_has_a_distinct_duration() {
        let character = synthesize_sound(KeySound::Character, 1);
        let space = synthesize_sound(KeySound::Space, 1);
        let delete = synthesize_sound(KeySound::Delete, 1);
        let commit = synthesize_sound(KeySound::Commit, 1);

        assert!(character.len() < space.len());
        assert!(space.len() < delete.len());
        assert!(delete.len() < commit.len());
    }

    #[test]
    fn transients_are_quiet_finite_and_fade_cleanly() {
        for sound in [
            KeySound::Character,
            KeySound::Space,
            KeySound::Delete,
            KeySound::Commit,
        ] {
            let samples = synthesize_sound(sound, 11);
            let peak = samples.iter().copied().map(f32::abs).fold(0.0, f32::max);

            assert!(samples.iter().all(|sample| sample.is_finite()));
            assert!(peak > 0.001);
            assert!(peak < 0.1);
            assert_eq!(samples.first().copied(), Some(0.0));
            assert_eq!(samples.last().copied(), Some(0.0));
        }
    }

    #[test]
    fn playback_gate_drops_bursts_but_preserves_typing_cadence() {
        let start = Instant::now();
        let mut gate = PlaybackGate::default();

        assert!(gate.allows(KeySound::Character, start));
        assert!(!gate.allows(KeySound::Character, start + Duration::from_millis(4)));
        assert!(gate.allows(KeySound::Commit, start + Duration::from_millis(5)));
        assert!(!gate.allows(
            KeySound::Character,
            start + MIN_PLAYBACK_INTERVAL - Duration::from_millis(1)
        ));
        assert!(gate.allows(
            KeySound::Character,
            start + MIN_PLAYBACK_INTERVAL + Duration::from_millis(5)
        ));
    }
}
