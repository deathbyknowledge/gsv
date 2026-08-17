use std::sync::Arc;
use std::time::{Duration, Instant};

pub const HAND_LANDMARK_COUNT: usize = 21;
pub const MAX_HANDS: usize = 2;
pub const MAX_GESTURE_LABEL_BYTES: usize = 64;

#[derive(Clone, Debug)]
pub struct FrameView {
    pub sequence: u64,
    pub captured_at: Instant,
    pub width: u32,
    pub height: u32,
    pub rgb: Arc<[u8]>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Landmark {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Handedness {
    Left,
    Right,
    #[default]
    Unknown,
}

#[derive(Clone, Debug)]
pub struct HandObservation {
    pub handedness: Handedness,
    pub handedness_score: f32,
    pub gesture: String,
    pub gesture_score: f32,
    pub landmarks: [Landmark; HAND_LANDMARK_COUNT],
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub frame_sequence: u64,
    pub observed_at: Instant,
    pub hands: Vec<HandObservation>,
    pub inference_time: Duration,
}
