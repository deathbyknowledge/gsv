use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::time::{Duration, Instant};

use gesture_protocol::{ControlStatus, ScrollState};
use minifb::{Key, ScaleMode, Window, WindowOptions};

use crate::camera::CameraStats;
use crate::observation::{FrameView, Observation};
use crate::overlay::{draw_overlay, ControlOverlay, ControlPresentationDiagnostic, PerfText};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DebugWindowConfig {
    pub title: String,
    pub width: usize,
    pub height: usize,
    pub target_frames_per_second: usize,
    pub mirror: bool,
}

impl Default for DebugWindowConfig {
    fn default() -> Self {
        Self {
            title: "GSV local vision debug".to_string(),
            width: 960,
            height: 720,
            target_frames_per_second: 30,
            mirror: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DebugWindowError {
    InvalidConfig,
    InvalidFrame,
    CreateFailed,
    PresentFailed,
}

impl Display for DebugWindowError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidConfig => "invalid debug window configuration",
            Self::InvalidFrame => "invalid RGB debug frame",
            Self::CreateFailed => "debug window could not be created",
            Self::PresentFailed => "debug frame could not be presented",
        })
    }
}

impl Error for DebugWindowError {}

/// A main-thread debug surface. It owns no capture or inference resources and
/// retains only the most recently converted framebuffer in memory.
pub struct DebugWindow {
    window: Window,
    pixels: Vec<u32>,
    mirror: bool,
    last_frame_sequence: Option<u64>,
    last_observation_sequence: Option<u64>,
    skipped_frames: u64,
    observation_rate: RateMeter,
    render_rate: RateMeter,
}

impl DebugWindow {
    pub fn new(config: DebugWindowConfig) -> Result<Self, DebugWindowError> {
        if config.width == 0
            || config.height == 0
            || config.target_frames_per_second == 0
            || config.title.is_empty()
        {
            return Err(DebugWindowError::InvalidConfig);
        }
        let options = WindowOptions {
            resize: true,
            scale_mode: ScaleMode::AspectRatioStretch,
            ..WindowOptions::default()
        };
        let mut window = Window::new(&config.title, config.width, config.height, options)
            .map_err(|_| DebugWindowError::CreateFailed)?;
        window.set_target_fps(config.target_frames_per_second);

        Ok(Self {
            window,
            pixels: Vec::new(),
            mirror: config.mirror,
            last_frame_sequence: None,
            last_observation_sequence: None,
            skipped_frames: 0,
            observation_rate: RateMeter::default(),
            render_rate: RateMeter::default(),
        })
    }

    #[must_use]
    pub fn is_open(&self) -> bool {
        self.window.is_open()
    }

    #[must_use]
    pub fn should_close(&self) -> bool {
        !self.window.is_open() || self.window.is_key_down(Key::Escape)
    }

    /// Presents one RGB frame. Hand geometry is drawn only for an observation
    /// produced from this exact frame sequence, avoiding a convincing but stale
    /// skeleton over a newer camera image.
    pub fn render(
        &mut self,
        frame: &FrameView,
        observation: Option<&Observation>,
        control_status: ControlStatus,
        control_diagnostic: ControlPresentationDiagnostic,
        scroll_state: ScrollState,
        camera_stats: &CameraStats,
    ) -> Result<(), DebugWindowError> {
        let width = usize::try_from(frame.width).map_err(|_| DebugWindowError::InvalidFrame)?;
        let height = usize::try_from(frame.height).map_err(|_| DebugWindowError::InvalidFrame)?;
        rgb_to_pixels(&mut self.pixels, frame, self.mirror)?;

        if self.last_frame_sequence != Some(frame.sequence) {
            if let Some(previous) = self.last_frame_sequence {
                self.skipped_frames = self
                    .skipped_frames
                    .saturating_add(frame.sequence.saturating_sub(previous).saturating_sub(1));
            }
            self.last_frame_sequence = Some(frame.sequence);
        }

        if let Some(observation) = observation {
            if self.last_observation_sequence != Some(observation.frame_sequence) {
                self.observation_rate.record(observation.observed_at);
                self.last_observation_sequence = Some(observation.frame_sequence);
            }
        }
        let now = Instant::now();
        self.render_rate.record(now);

        let aligned_observation =
            observation.filter(|observation| observation.frame_sequence == frame.sequence);
        let observation_latency = aligned_observation.and_then(|observation| {
            observation
                .observed_at
                .checked_duration_since(frame.captured_at)
        });
        let perf = PerfText {
            camera_running: camera_stats.running,
            camera_frames_per_second: camera_stats.average_frames_per_second(),
            observation_frames_per_second: self.observation_rate.frames_per_second(),
            render_frames_per_second: self.render_rate.frames_per_second(),
            inference_time: aligned_observation.map(|observation| observation.inference_time),
            frame_age: now.saturating_duration_since(frame.captured_at),
            observation_latency,
            frame_sequence: frame.sequence,
            observation_sequence: observation.map(|observation| observation.frame_sequence),
            skipped_frames: self.skipped_frames,
            slot_replacements: camera_stats.slot_replacements,
            capture_errors: camera_stats.capture_errors,
        };
        draw_overlay(
            &mut self.pixels,
            width,
            height,
            aligned_observation,
            ControlOverlay {
                status: control_status,
                diagnostic: control_diagnostic,
                scroll_state,
            },
            &perf,
            self.mirror,
        );
        self.window
            .update_with_buffer(&self.pixels, width, height)
            .map_err(|_| DebugWindowError::PresentFailed)
    }
}

fn rgb_to_pixels(
    output: &mut Vec<u32>,
    frame: &FrameView,
    mirror: bool,
) -> Result<(), DebugWindowError> {
    let width = usize::try_from(frame.width).map_err(|_| DebugWindowError::InvalidFrame)?;
    let height = usize::try_from(frame.height).map_err(|_| DebugWindowError::InvalidFrame)?;
    let pixel_count = width
        .checked_mul(height)
        .ok_or(DebugWindowError::InvalidFrame)?;
    let expected_bytes = pixel_count
        .checked_mul(3)
        .ok_or(DebugWindowError::InvalidFrame)?;
    if width == 0 || height == 0 || frame.rgb.len() != expected_bytes {
        return Err(DebugWindowError::InvalidFrame);
    }

    output.resize(pixel_count, 0);
    for y in 0..height {
        for display_x in 0..width {
            let source_x = if mirror {
                width - display_x - 1
            } else {
                display_x
            };
            let source = (y * width + source_x) * 3;
            let destination = y * width + display_x;
            output[destination] = u32::from(frame.rgb[source]) << 16
                | u32::from(frame.rgb[source + 1]) << 8
                | u32::from(frame.rgb[source + 2]);
        }
    }
    Ok(())
}

#[derive(Default)]
struct RateMeter {
    last_at: Option<Instant>,
    frames_per_second: f32,
}

impl RateMeter {
    fn record(&mut self, at: Instant) {
        let Some(previous) = self.last_at else {
            self.last_at = Some(at);
            return;
        };
        let Some(elapsed) = at.checked_duration_since(previous) else {
            return;
        };
        if elapsed < Duration::from_micros(100) {
            return;
        }
        self.last_at = Some(at);
        let sample = 1.0 / elapsed.as_secs_f32();
        if self.frames_per_second <= f32::EPSILON {
            self.frames_per_second = sample;
        } else {
            self.frames_per_second = self.frames_per_second * 0.8 + sample * 0.2;
        }
    }

    fn frames_per_second(&self) -> f32 {
        self.frames_per_second
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn frame(width: u32, height: u32, rgb: &[u8]) -> FrameView {
        FrameView {
            sequence: 1,
            captured_at: Instant::now(),
            width,
            height,
            rgb: Arc::from(rgb),
        }
    }

    #[test]
    fn rgb_conversion_preserves_channel_order() {
        let frame = frame(1, 1, &[0x12, 0x34, 0x56]);
        let mut output = Vec::new();
        rgb_to_pixels(&mut output, &frame, false).expect("valid RGB");
        assert_eq!(output, [0x12_34_56]);
    }

    #[test]
    fn mirrored_conversion_reverses_each_row() {
        let frame = frame(2, 1, &[0xFF, 0, 0, 0, 0xFF, 0]);
        let mut output = Vec::new();
        rgb_to_pixels(&mut output, &frame, true).expect("valid RGB");
        assert_eq!(output, [0x00_FF_00, 0xFF_00_00]);
    }

    #[test]
    fn malformed_rgb_frame_is_rejected() {
        let frame = frame(2, 1, &[0, 0, 0]);
        assert_eq!(
            rgb_to_pixels(&mut Vec::new(), &frame, false),
            Err(DebugWindowError::InvalidFrame)
        );
    }

    #[test]
    fn rate_meter_smooths_timestamped_events() {
        let start = Instant::now();
        let mut meter = RateMeter::default();
        meter.record(start);
        meter.record(start + Duration::from_millis(100));
        assert!((meter.frames_per_second() - 10.0).abs() < 0.01);
    }
}
