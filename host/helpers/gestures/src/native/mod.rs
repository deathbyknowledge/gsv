mod geometry;
mod models;
pub(crate) mod runtime;

use std::error::Error as StdError;
use std::fmt::{self, Display, Formatter};
use std::time::Instant;

use crate::observation::{
    FrameView, HandObservation, Handedness, Landmark, Observation, HAND_LANDMARK_COUNT, MAX_HANDS,
};

use self::geometry::{
    decode_hand_rects, map_rect_from_crop, next_hand_rect, overlaps_tracked, project_landmarks,
    rotate_world_landmarks, same_projected_hand, sample_rgb, Rect,
};
use self::models::{LandmarkOutputs, Models};
use self::runtime::ModelPaths;

const MAX_FRAME_WIDTH: u32 = 1_920;
const MAX_FRAME_HEIGHT: u32 = 1_080;
const RGB_CHANNELS: usize = 3;
const LANDMARK_SIZE: usize = 224;
const PRESENCE_THRESHOLD: f32 = 0.5;
const PALM_DISCOVERY_INTERVAL_MS: i64 = 100;
const GESTURE_LABELS: [&str; 8] = [
    "None",
    "Closed_Fist",
    "Open_Palm",
    "Pointing_Up",
    "Thumb_Down",
    "Thumb_Up",
    "Victory",
    "ILoveYou",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Error {
    InvalidModel,
    InvalidFrame,
    InvalidTimestamp,
    Inference,
}

impl Display for Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidModel => "native gesture models are invalid",
            Self::InvalidFrame => "video frame is invalid",
            Self::InvalidTimestamp => "video timestamp is invalid",
            Self::Inference => "native gesture inference failed",
        })
    }
}

impl StdError for Error {}

pub(crate) struct GestureRecognizer {
    models: Models,
    tracked_rects: Vec<Rect>,
    last_timestamp_ms: Option<i64>,
    last_palm_detection_ms: Option<i64>,
}

struct DetectedHand {
    observation: HandObservation,
    next_rect: Rect,
}

#[derive(Clone, Copy)]
#[repr(usize)]
enum RecognitionStage {
    PalmPreprocess,
    PalmInference,
    PalmPostprocess,
    LandmarkPreprocess,
    LandmarkInference,
    LandmarkPostprocess,
    GestureInference,
    GesturePostprocess,
}

#[cfg(test)]
const RECOGNITION_STAGES: [RecognitionStage; 8] = [
    RecognitionStage::PalmPreprocess,
    RecognitionStage::PalmInference,
    RecognitionStage::PalmPostprocess,
    RecognitionStage::LandmarkPreprocess,
    RecognitionStage::LandmarkInference,
    RecognitionStage::LandmarkPostprocess,
    RecognitionStage::GestureInference,
    RecognitionStage::GesturePostprocess,
];

trait RecognitionProfiler: Default + Send {
    type Started;

    fn start(&mut self) -> Self::Started;
    fn finish(&mut self, stage: RecognitionStage, started: Self::Started);
    fn merge_parallel(&mut self, left: Self, right: Self);
}

#[derive(Default)]
struct NoopProfiler;

impl RecognitionProfiler for NoopProfiler {
    type Started = ();

    #[inline(always)]
    fn start(&mut self) {}

    #[inline(always)]
    fn finish(&mut self, _stage: RecognitionStage, _started: ()) {}

    #[inline(always)]
    fn merge_parallel(&mut self, _left: Self, _right: Self) {}
}

#[cfg(test)]
#[derive(Clone, Debug)]
struct RecognitionTimings {
    stages: [std::time::Duration; RECOGNITION_STAGES.len()],
}

#[cfg(test)]
impl Default for RecognitionTimings {
    fn default() -> Self {
        Self {
            stages: [std::time::Duration::ZERO; RECOGNITION_STAGES.len()],
        }
    }
}

#[cfg(test)]
impl RecognitionTimings {
    fn get(&self, stage: RecognitionStage) -> std::time::Duration {
        self.stages[stage as usize]
    }
}

#[cfg(test)]
impl RecognitionProfiler for RecognitionTimings {
    type Started = Instant;

    fn start(&mut self) -> Self::Started {
        Instant::now()
    }

    fn finish(&mut self, stage: RecognitionStage, started: Self::Started) {
        self.stages[stage as usize] += started.elapsed();
    }

    fn merge_parallel(&mut self, left: Self, right: Self) {
        for (index, stage) in self.stages.iter_mut().enumerate() {
            *stage += left.stages[index].max(right.stages[index]);
        }
    }
}

impl GestureRecognizer {
    pub(crate) fn load(paths: &ModelPaths) -> Result<Self, Error> {
        Ok(Self {
            models: Models::load(paths)?,
            tracked_rects: Vec::new(),
            last_timestamp_ms: None,
            last_palm_detection_ms: None,
        })
    }

    pub(crate) fn recognize(
        &mut self,
        frame: &FrameView,
        timestamp_ms: i64,
    ) -> Result<Observation, Error> {
        self.recognize_with_profiler(frame, timestamp_ms, &mut NoopProfiler)
    }

    #[cfg(test)]
    fn recognize_profiled(
        &mut self,
        frame: &FrameView,
        timestamp_ms: i64,
    ) -> Result<(Observation, RecognitionTimings), Error> {
        let mut timings = RecognitionTimings::default();
        let observation = self.recognize_with_profiler(frame, timestamp_ms, &mut timings)?;
        Ok((observation, timings))
    }

    fn recognize_with_profiler<P: RecognitionProfiler>(
        &mut self,
        frame: &FrameView,
        timestamp_ms: i64,
        profiler: &mut P,
    ) -> Result<Observation, Error> {
        validate_frame(frame)?;
        if timestamp_ms < 0
            || self
                .last_timestamp_ms
                .is_some_and(|previous| timestamp_ms <= previous)
        {
            return Err(Error::InvalidTimestamp);
        }
        self.last_timestamp_ms = Some(timestamp_ms);
        let started = Instant::now();

        let mut candidate_rects = self.tracked_rects.clone();
        if should_detect_palms(
            candidate_rects.len(),
            timestamp_ms,
            self.last_palm_detection_ms,
        ) {
            self.last_palm_detection_ms = Some(timestamp_ms);
            let detector_rect = Rect::padded_full_frame(frame.width, frame.height);
            let stage = profiler.start();
            let detector_input = sample_rgb(frame, detector_rect, 192);
            profiler.finish(RecognitionStage::PalmPreprocess, stage);
            let stage = profiler.start();
            let detector_output = self.models.detect_palms(&detector_input);
            profiler.finish(RecognitionStage::PalmInference, stage);
            let (raw_boxes, raw_scores) = detector_output?;
            let stage = profiler.start();
            for detected in decode_hand_rects(&raw_boxes, &raw_scores) {
                let detected =
                    map_rect_from_crop(detected, detector_rect, frame.width, frame.height);
                if !overlaps_tracked(detected, &candidate_rects) {
                    candidate_rects.push(detected);
                }
            }
            profiler.finish(RecognitionStage::PalmPostprocess, stage);
        }

        let candidates = self.detect_candidate_hands(frame, candidate_rects, profiler)?;
        let mut detected_hands = Vec::with_capacity(candidates.len());
        for hand in candidates.into_iter().flatten() {
            if detected_hands.iter().any(|existing: &DetectedHand| {
                same_projected_hand(&existing.observation.landmarks, &hand.observation.landmarks)
            }) {
                continue;
            }
            detected_hands.push(hand);
            if detected_hands.len() == MAX_HANDS {
                break;
            }
        }
        self.tracked_rects = detected_hands.iter().map(|hand| hand.next_rect).collect();
        let hands = detected_hands
            .into_iter()
            .map(|hand| hand.observation)
            .collect();
        let observed_at = Instant::now();
        Ok(Observation {
            frame_sequence: frame.sequence,
            observed_at,
            hands,
            inference_time: observed_at.saturating_duration_since(started),
        })
    }

    fn detect_candidate_hands<P: RecognitionProfiler>(
        &self,
        frame: &FrameView,
        candidate_rects: Vec<Rect>,
        profiler: &mut P,
    ) -> Result<Vec<Option<DetectedHand>>, Error> {
        let [first_rect, second_rect] = candidate_rects.as_slice() else {
            return candidate_rects
                .into_iter()
                .map(|rect| self.detect_hand(frame, rect, profiler))
                .collect();
        };
        let Some(pool) = self.models.inference_pool() else {
            return candidate_rects
                .into_iter()
                .map(|rect| self.detect_hand(frame, rect, profiler))
                .collect();
        };
        let ((first, first_profiler), (second, second_profiler)) = pool.install(|| {
            rayon::join(
                || {
                    let mut profiler = P::default();
                    let result = self.detect_hand(frame, *first_rect, &mut profiler);
                    (result, profiler)
                },
                || {
                    let mut profiler = P::default();
                    let result = self.detect_hand(frame, *second_rect, &mut profiler);
                    (result, profiler)
                },
            )
        });
        profiler.merge_parallel(first_profiler, second_profiler);
        Ok(vec![first?, second?])
    }

    fn detect_hand<P: RecognitionProfiler>(
        &self,
        frame: &FrameView,
        rect: Rect,
        profiler: &mut P,
    ) -> Result<Option<DetectedHand>, Error> {
        let stage = profiler.start();
        let input = sample_rgb(frame, rect, LANDMARK_SIZE);
        profiler.finish(RecognitionStage::LandmarkPreprocess, stage);
        let stage = profiler.start();
        let landmark_output = self.models.detect_landmarks(&input);
        profiler.finish(RecognitionStage::LandmarkInference, stage);
        let output = landmark_output?;
        let stage = profiler.start();
        if !output.presence.is_finite() || output.presence < PRESENCE_THRESHOLD {
            profiler.finish(RecognitionStage::LandmarkPostprocess, stage);
            return Ok(None);
        }
        let (crop_landmarks, crop_world_landmarks) = decode_landmarks(&output)?;
        let landmarks = project_landmarks(&crop_landmarks, rect);
        let world_landmarks = rotate_world_landmarks(&crop_world_landmarks, rect.rotation);
        let next_rect =
            next_hand_rect(&landmarks, frame.width, frame.height).ok_or(Error::Inference)?;
        let right_hand_score = finite_probability(output.handedness)?;
        let handedness = if right_hand_score >= 0.5 {
            Handedness::Right
        } else {
            Handedness::Left
        };
        let handedness_score = right_hand_score.max(1.0 - right_hand_score);
        let normalized_landmarks =
            normalize_landmarks(&landmarks, Some((frame.width, frame.height)))?;
        let normalized_world_landmarks = normalize_landmarks(&world_landmarks, None)?;
        profiler.finish(RecognitionStage::LandmarkPostprocess, stage);
        let stage = profiler.start();
        let classification = self.models.classify_gesture(
            &normalized_landmarks,
            right_hand_score,
            &normalized_world_landmarks,
        );
        profiler.finish(RecognitionStage::GestureInference, stage);
        let scores = classification?;
        let stage = profiler.start();
        let (gesture_index, gesture_score) = scores
            .iter()
            .copied()
            .enumerate()
            .filter(|(_, score)| score.is_finite())
            .max_by(|left, right| left.1.total_cmp(&right.1))
            .ok_or(Error::Inference)?;
        let detected = DetectedHand {
            observation: HandObservation {
                handedness,
                handedness_score,
                gesture: GESTURE_LABELS[gesture_index].to_string(),
                gesture_score,
                landmarks,
            },
            next_rect,
        };
        profiler.finish(RecognitionStage::GesturePostprocess, stage);
        Ok(Some(detected))
    }
}

fn should_detect_palms(
    tracked_hands: usize,
    timestamp_ms: i64,
    last_detection_ms: Option<i64>,
) -> bool {
    match tracked_hands {
        0 => true,
        1 => last_detection_ms
            .is_none_or(|last| timestamp_ms.saturating_sub(last) >= PALM_DISCOVERY_INTERVAL_MS),
        _ => false,
    }
}

fn validate_frame(frame: &FrameView) -> Result<(), Error> {
    if frame.width == 0
        || frame.height == 0
        || frame.width > MAX_FRAME_WIDTH
        || frame.height > MAX_FRAME_HEIGHT
    {
        return Err(Error::InvalidFrame);
    }
    let expected = frame.width as usize * frame.height as usize * RGB_CHANNELS;
    if frame.rgb.len() != expected {
        return Err(Error::InvalidFrame);
    }
    Ok(())
}

fn decode_landmarks(
    output: &LandmarkOutputs,
) -> Result<
    (
        [Landmark; HAND_LANDMARK_COUNT],
        [Landmark; HAND_LANDMARK_COUNT],
    ),
    Error,
> {
    let mut image = [Landmark::default(); HAND_LANDMARK_COUNT];
    let mut world = [Landmark::default(); HAND_LANDMARK_COUNT];
    for index in 0..HAND_LANDMARK_COUNT {
        image[index] = Landmark {
            x: finite(output.image[index * 3])? / LANDMARK_SIZE as f32,
            y: finite(output.image[index * 3 + 1])? / LANDMARK_SIZE as f32,
            z: finite(output.image[index * 3 + 2])? / (LANDMARK_SIZE as f32 * 0.4),
        };
        world[index] = Landmark {
            x: finite(output.world[index * 3])?,
            y: finite(output.world[index * 3 + 1])?,
            z: finite(output.world[index * 3 + 2])?,
        };
    }
    Ok((image, world))
}

fn normalize_landmarks(
    landmarks: &[Landmark; HAND_LANDMARK_COUNT],
    image_size: Option<(u32, u32)>,
) -> Result<[f32; HAND_LANDMARK_COUNT * 3], Error> {
    let mut values = [0.0; HAND_LANDMARK_COUNT * 3];
    let (width_scale, height_scale) = image_size.map_or((1.0, 1.0), |(width, height)| {
        let max_dimension = width.max(height) as f32;
        (width as f32 / max_dimension, height as f32 / max_dimension)
    });
    let origin = landmarks[0];
    let origin_x = if image_size.is_some() {
        (origin.x - 0.5) * width_scale + 0.5
    } else {
        origin.x
    };
    let origin_y = if image_size.is_some() {
        (origin.y - 0.5) * height_scale + 0.5
    } else {
        origin.y
    };
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN_POSITIVE;
    let mut max_y = f32::MIN_POSITIVE;
    for (index, landmark) in landmarks.iter().enumerate() {
        let x = if image_size.is_some() {
            (landmark.x - 0.5) * width_scale + 0.5
        } else {
            landmark.x
        } - origin_x;
        let y = if image_size.is_some() {
            (landmark.y - 0.5) * height_scale + 0.5
        } else {
            landmark.y
        } - origin_y;
        let z = landmark.z - origin.z;
        values[index * 3] = finite(x)?;
        values[index * 3 + 1] = finite(y)?;
        values[index * 3 + 2] = finite(z)?;
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    let scale = (max_x - min_x).max(max_y - min_y) + 1e-5;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(Error::Inference);
    }
    for value in &mut values {
        *value /= scale;
    }
    Ok(values)
}

fn finite(value: f32) -> Result<f32, Error> {
    value.is_finite().then_some(value).ok_or(Error::Inference)
}

fn finite_probability(value: f32) -> Result<f32, Error> {
    let value = finite(value)?;
    ((0.0..=1.0).contains(&value))
        .then_some(value)
        .ok_or(Error::Inference)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Instant;

    use super::*;

    #[test]
    fn normalizing_landmarks_uses_the_wrist_as_origin() {
        let wrist = Landmark {
            x: 0.2,
            y: 0.3,
            z: 0.4,
        };
        let mut landmarks = [wrist; HAND_LANDMARK_COUNT];
        landmarks[1] = Landmark {
            x: 0.4,
            y: 0.7,
            z: 0.5,
        };
        let normalized = normalize_landmarks(&landmarks, None).expect("valid landmarks");
        assert_eq!(&normalized[0..3], &[0.0, 0.0, 0.0]);
        assert!((normalized[3] - 0.5).abs() < 1e-4);
        assert!((normalized[4] - 1.0).abs() < 1e-4);
        assert!((normalized[5] - 0.25).abs() < 1e-4);
    }

    #[test]
    fn malformed_probabilities_fail_closed() {
        assert_eq!(finite_probability(f32::NAN), Err(Error::Inference));
        assert_eq!(finite_probability(1.1), Err(Error::Inference));
    }

    #[test]
    fn palm_discovery_is_immediate_without_tracking_and_bounded_with_one_hand() {
        assert!(should_detect_palms(0, 1, Some(1)));
        assert!(should_detect_palms(1, 1, None));
        assert!(!should_detect_palms(
            1,
            PALM_DISCOVERY_INTERVAL_MS - 1,
            Some(0)
        ));
        assert!(should_detect_palms(1, PALM_DISCOVERY_INTERVAL_MS, Some(0)));
        assert!(!should_detect_palms(2, i64::MAX, None));
    }

    #[test]
    #[ignore = "run with scripts/vision-native/parity.sh"]
    fn matches_mediapipe_gesture_fixtures() {
        let fixture_root = PathBuf::from(
            std::env::var_os("GSV_VISION_PARITY_FIXTURES").expect("parity fixture directory"),
        );
        let model_root = std::env::var_os("GSV_VISION_NATIVE_MODELS")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../target/vision-native/artifact/gesture-recognizer-float16-1")
            });
        let models =
            runtime::resolve_models(Some(model_root.into_os_string()), None, Path::new("."))
                .expect("verified native gesture models");
        let mut recognizer = GestureRecognizer::load(&models).expect("native recognizer");
        for (name, expected_gesture, expected_score, expected_handedness, wrist) in [
            (
                "fist.jpg",
                "Closed_Fist",
                0.900_044_1,
                0.989_296_1,
                (0.477_097, 0.661_291),
            ),
            (
                "pointing_up.jpg",
                "Pointing_Up",
                0.829_581_9,
                0.995_088_8,
                (0.479_238_4, 0.742_612),
            ),
            (
                "thumb_up.jpg",
                "Thumb_Up",
                0.743_600_6,
                0.983_551_7,
                (0.638_752_8, 0.671_340_5),
            ),
            (
                "victory.jpg",
                "Victory",
                0.775_318_4,
                0.995_300_7,
                (0.516_432_1, 0.804_093_7),
            ),
        ] {
            recognizer.tracked_rects.clear();
            recognizer.last_timestamp_ms = None;
            let decoded = image::ImageReader::open(fixture_root.join(name))
                .expect("fixture image")
                .decode()
                .expect("decoded fixture")
                .to_rgb8();
            let frame = FrameView {
                sequence: 1,
                captured_at: Instant::now(),
                width: decoded.width(),
                height: decoded.height(),
                rgb: Arc::from(decoded.into_raw()),
            };
            let observation = recognizer.recognize(&frame, 0).expect("fixture inference");
            assert_eq!(observation.hands.len(), 1, "{name}");
            let hand = &observation.hands[0];
            assert_eq!(hand.handedness, Handedness::Right, "{name}");
            assert_eq!(hand.gesture, expected_gesture, "{name}");
            assert!(
                (hand.gesture_score - expected_score).abs() <= 0.08,
                "{name}"
            );
            assert!(
                (hand.handedness_score - expected_handedness).abs() <= 0.03,
                "{name}"
            );
            assert!((hand.landmarks[0].x - wrist.0).abs() <= 0.04, "{name}");
            assert!((hand.landmarks[0].y - wrist.1).abs() <= 0.04, "{name}");
        }
    }
}

#[cfg(test)]
mod benchmark;
