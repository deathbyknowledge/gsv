use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::geometry::{Point, Rect};
use super::{
    runtime, GestureRecognizer, NoopProfiler, RecognitionStage, RecognitionTimings,
    RECOGNITION_STAGES,
};
use crate::observation::FrameView;

const WARMUP_ITERATIONS: usize = 6;
const MEASURED_ITERATIONS: usize = 30;

const FIXTURES: [Fixture; 4] = [
    Fixture {
        name: "fist.jpg",
        expected_gesture: "Closed_Fist",
    },
    Fixture {
        name: "pointing_up.jpg",
        expected_gesture: "Pointing_Up",
    },
    Fixture {
        name: "thumb_up.jpg",
        expected_gesture: "Thumb_Up",
    },
    Fixture {
        name: "victory.jpg",
        expected_gesture: "Victory",
    },
];

#[derive(Clone, Copy)]
struct Fixture {
    name: &'static str,
    expected_gesture: &'static str,
}

struct LoadedFixture {
    fixture: Fixture,
    frame: FrameView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema_version: u32,
    git_revision: String,
    working_tree_dirty: bool,
    rustc_version: String,
    system: SystemReport,
    warmup_iterations: usize,
    measured_iterations: usize,
    scenarios: Vec<ScenarioReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemReport {
    operating_system: &'static str,
    architecture: &'static str,
    logical_cpus: usize,
    processor: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioReport {
    name: &'static str,
    description: &'static str,
    samples: usize,
    frames_per_second: f64,
    total: Statistics,
    stages: BTreeMap<&'static str, Statistics>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Statistics {
    executions: usize,
    minimum_us: u64,
    median_us: u64,
    p95_us: u64,
    maximum_us: u64,
    mean_us: u64,
}

struct SampleSet {
    total: Vec<Duration>,
    stages: BTreeMap<&'static str, Vec<Duration>>,
}

impl SampleSet {
    fn new(capacity: usize) -> Self {
        Self {
            total: Vec::with_capacity(capacity),
            stages: RECOGNITION_STAGES
                .into_iter()
                .map(|stage| (stage.name(), Vec::with_capacity(capacity)))
                .collect(),
        }
    }

    fn push(&mut self, total: Duration, timings: &RecognitionTimings) {
        self.total.push(total);
        for stage in RECOGNITION_STAGES {
            self.stages
                .get_mut(stage.name())
                .expect("known recognition stage")
                .push(timings.get(stage));
        }
    }

    fn report(self, name: &'static str, description: &'static str) -> ScenarioReport {
        ScenarioReport {
            name,
            description,
            samples: self.total.len(),
            frames_per_second: frames_per_second(&self.total),
            total: statistics(&self.total),
            stages: self
                .stages
                .into_iter()
                .map(|(stage, samples)| (stage, statistics(&samples)))
                .collect(),
        }
    }
}

impl RecognitionStage {
    const fn name(self) -> &'static str {
        match self {
            Self::PalmPreprocess => "palmPreprocess",
            Self::PalmInference => "palmInference",
            Self::PalmPostprocess => "palmPostprocess",
            Self::LandmarkPreprocess => "landmarkPreprocess",
            Self::LandmarkInference => "landmarkInference",
            Self::LandmarkPostprocess => "landmarkPostprocess",
            Self::GestureInference => "gestureInference",
            Self::GesturePostprocess => "gesturePostprocess",
        }
    }
}

#[test]
#[ignore = "run with scripts/vision-native/benchmark.sh"]
fn benchmarks_native_pipeline() {
    let fixture_root = PathBuf::from(
        std::env::var_os("GSV_VISION_BENCHMARK_FIXTURES").expect("benchmark fixture directory"),
    );
    let model_root = std::env::var_os("GSV_VISION_NATIVE_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/vision-native/artifact/gesture-recognizer-float16-1")
        });
    let models = runtime::resolve_models(Some(model_root.into_os_string()), None, Path::new("."))
        .expect("verified native gesture models");
    let fixtures: Vec<_> = FIXTURES
        .into_iter()
        .enumerate()
        .map(|(index, fixture)| LoadedFixture {
            fixture,
            frame: load_frame(&fixture_root.join(fixture.name), index as u64),
        })
        .collect();
    let (two_hand_frame, two_hand_rects) =
        compose_tracked_frames(&models, &fixtures[3].frame, &fixtures[2].frame);

    let mut timestamp_ms = 0_i64;
    let full_detection = benchmark_detection(&models, &fixtures, &mut timestamp_ms);
    let continuous_tracking = benchmark_tracking(&models, &fixtures[3], &mut timestamp_ms);
    let two_hand_tracking =
        benchmark_two_hand_tracking(&models, &two_hand_frame, &two_hand_rects, &mut timestamp_ms);
    let report = BenchmarkReport {
        schema_version: 1,
        git_revision: benchmark_environment("GSV_VISION_BENCHMARK_REVISION", "unknown"),
        working_tree_dirty: benchmark_environment("GSV_VISION_BENCHMARK_DIRTY", "false") == "true",
        rustc_version: benchmark_environment("GSV_VISION_BENCHMARK_RUSTC", "unknown"),
        system: SystemReport {
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            logical_cpus: std::thread::available_parallelism().map_or(1, usize::from),
            processor: benchmark_environment("GSV_VISION_BENCHMARK_CPU", "unknown"),
        },
        warmup_iterations: WARMUP_ITERATIONS,
        measured_iterations: MEASURED_ITERATIONS,
        scenarios: vec![full_detection, continuous_tracking, two_hand_tracking],
    };
    let encoded = serde_json::to_string_pretty(&report).expect("serialized benchmark report");
    if let Some(output) = std::env::var_os("GSV_VISION_BENCHMARK_OUTPUT") {
        let output = PathBuf::from(output);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("benchmark output directory");
        }
        fs::write(&output, format!("{encoded}\n")).expect("benchmark report");
        println!("native gesture benchmark: {}", output.display());
    } else {
        println!("{encoded}");
    }
}

fn benchmark_detection(
    models: &runtime::ModelPaths,
    fixtures: &[LoadedFixture],
    timestamp_ms: &mut i64,
) -> ScenarioReport {
    let mut recognizer = GestureRecognizer::load(models).expect("native recognizer");
    for index in 0..WARMUP_ITERATIONS {
        recognize_fixture(
            &mut recognizer,
            &fixtures[index % fixtures.len()],
            timestamp_ms,
            true,
        );
    }
    let mut samples = SampleSet::new(MEASURED_ITERATIONS);
    for index in 0..MEASURED_ITERATIONS {
        let (total, timings) = recognize_fixture(
            &mut recognizer,
            &fixtures[index % fixtures.len()],
            timestamp_ms,
            true,
        );
        samples.push(total, &timings);
    }
    samples.report(
        "fullDetection",
        "Palm discovery and one-hand landmark and gesture inference",
    )
}

fn benchmark_tracking(
    models: &runtime::ModelPaths,
    fixture: &LoadedFixture,
    timestamp_ms: &mut i64,
) -> ScenarioReport {
    let mut recognizer = GestureRecognizer::load(models).expect("native recognizer");
    for _ in 0..WARMUP_ITERATIONS {
        recognize_fixture(&mut recognizer, fixture, timestamp_ms, false);
    }
    let mut samples = SampleSet::new(MEASURED_ITERATIONS);
    for _ in 0..MEASURED_ITERATIONS {
        let (total, timings) = recognize_fixture(&mut recognizer, fixture, timestamp_ms, false);
        samples.push(total, &timings);
    }
    samples.report(
        "continuousTracking",
        "One tracked hand while palm discovery continues looking for a second hand",
    )
}

fn benchmark_two_hand_tracking(
    models: &runtime::ModelPaths,
    frame: &FrameView,
    tracked_rects: &[Rect],
    timestamp_ms: &mut i64,
) -> ScenarioReport {
    let mut recognizer = GestureRecognizer::load(models).expect("native recognizer");
    for _ in 0..WARMUP_ITERATIONS {
        recognize_two_hands(&mut recognizer, frame, tracked_rects, timestamp_ms);
    }
    let mut samples = SampleSet::new(MEASURED_ITERATIONS);
    for _ in 0..MEASURED_ITERATIONS {
        let (total, timings) =
            recognize_two_hands(&mut recognizer, frame, tracked_rects, timestamp_ms);
        samples.push(total, &timings);
    }
    samples.report(
        "twoHandProcessing",
        "Two known hand regions without repeating full-frame palm discovery",
    )
}

fn recognize_fixture(
    recognizer: &mut GestureRecognizer,
    fixture: &LoadedFixture,
    timestamp_ms: &mut i64,
    force_detection: bool,
) -> (Duration, RecognitionTimings) {
    if force_detection {
        recognizer.tracked_rects.clear();
    }
    *timestamp_ms += 33;
    let (observation, timings) = recognizer
        .recognize_profiled(&fixture.frame, *timestamp_ms)
        .expect("fixture inference");
    assert_eq!(observation.hands.len(), 1, "{}", fixture.fixture.name);
    assert_eq!(
        observation.hands[0].gesture, fixture.fixture.expected_gesture,
        "{}",
        fixture.fixture.name
    );
    (observation.inference_time, timings)
}

fn recognize_two_hands(
    recognizer: &mut GestureRecognizer,
    frame: &FrameView,
    tracked_rects: &[Rect],
    timestamp_ms: &mut i64,
) -> (Duration, RecognitionTimings) {
    recognizer.tracked_rects = tracked_rects.to_vec();
    *timestamp_ms += 33;
    let (observation, timings) = recognizer
        .recognize_profiled(frame, *timestamp_ms)
        .expect("two-hand fixture inference");
    assert_eq!(observation.hands.len(), 2, "two-hand fixture");
    (observation.inference_time, timings)
}

fn load_frame(path: &Path, sequence: u64) -> FrameView {
    let decoded = image::ImageReader::open(path)
        .expect("fixture image")
        .decode()
        .expect("decoded fixture")
        .to_rgb8();
    FrameView {
        sequence,
        captured_at: Instant::now(),
        width: decoded.width(),
        height: decoded.height(),
        rgb: Arc::from(decoded.into_raw()),
    }
}

fn compose_tracked_frames(
    models: &runtime::ModelPaths,
    left: &FrameView,
    right: &FrameView,
) -> (FrameView, Vec<Rect>) {
    const PADDING: u32 = 128;
    let width = left.width + right.width + PADDING * 3;
    let content_height = left.height.max(right.height);
    let height = content_height + PADDING * 2;
    let left_x = PADDING;
    let right_x = left_x + left.width + PADDING;
    let left_y = PADDING + (content_height - left.height) / 2;
    let right_y = PADDING + (content_height - right.height) / 2;
    let mut rgb = vec![0_u8; width as usize * height as usize * 3];
    copy_frame(left, &mut rgb, width, left_x, left_y);
    copy_frame(right, &mut rgb, width, right_x, right_y);
    let frame = FrameView {
        sequence: u64::try_from(FIXTURES.len()).unwrap_or(u64::MAX),
        captured_at: Instant::now(),
        width,
        height,
        rgb: Arc::from(rgb),
    };
    let left_rect = tracked_rect(models, left);
    let right_rect = tracked_rect(models, right);
    let rects = vec![
        map_tracked_rect(left_rect, left, &frame, left_x, left_y),
        map_tracked_rect(right_rect, right, &frame, right_x, right_y),
    ];
    let recognizer = GestureRecognizer::load(models).expect("native recognizer");
    let hands: Vec<_> = rects
        .iter()
        .map(|rect| {
            recognizer
                .detect_hand(&frame, *rect, &mut NoopProfiler)
                .expect("tracked fixture inference")
                .expect("tracked fixture in composite frame")
        })
        .collect();
    assert!(
        !super::same_projected_hand(
            &hands[0].observation.landmarks,
            &hands[1].observation.landmarks
        ),
        "composite fixtures must represent distinct hands"
    );
    (frame, rects)
}

fn copy_frame(source: &FrameView, target: &mut [u8], target_width: u32, x: u32, y: u32) {
    let source_row_bytes = source.width as usize * 3;
    for row in 0..source.height as usize {
        let source_start = row * source_row_bytes;
        let target_start = ((row + y as usize) * target_width as usize + x as usize) * 3;
        target[target_start..target_start + source_row_bytes]
            .copy_from_slice(&source.rgb[source_start..source_start + source_row_bytes]);
    }
}

fn tracked_rect(models: &runtime::ModelPaths, frame: &FrameView) -> Rect {
    let mut recognizer = GestureRecognizer::load(models).expect("native recognizer");
    let observation = recognizer.recognize(frame, 0).expect("fixture inference");
    assert_eq!(observation.hands.len(), 1, "tracked fixture");
    recognizer.tracked_rects[0]
}

fn map_tracked_rect(rect: Rect, source: &FrameView, target: &FrameView, x: u32, y: u32) -> Rect {
    Rect {
        center: Point {
            x: (rect.center.x * source.width as f32 + x as f32) / target.width as f32,
            y: (rect.center.y * source.height as f32 + y as f32) / target.height as f32,
        },
        width: rect.width * source.width as f32 / target.width as f32,
        height: rect.height * source.height as f32 / target.height as f32,
        rotation: rect.rotation,
    }
}

fn statistics(samples: &[Duration]) -> Statistics {
    assert!(!samples.is_empty(), "benchmark samples");
    let mut values: Vec<u64> = samples.iter().copied().map(duration_us).collect();
    values.sort_unstable();
    let total: u128 = values.iter().copied().map(u128::from).sum();
    let mean_us = u64::try_from(total / values.len() as u128).unwrap_or(u64::MAX);
    Statistics {
        executions: samples
            .iter()
            .filter(|duration| !duration.is_zero())
            .count(),
        minimum_us: values[0],
        median_us: percentile(&values, 50),
        p95_us: percentile(&values, 95),
        maximum_us: values[values.len() - 1],
        mean_us,
    }
}

fn frames_per_second(samples: &[Duration]) -> f64 {
    let total_us: u128 = samples.iter().map(Duration::as_micros).sum();
    if total_us == 0 {
        0.0
    } else {
        samples.len() as f64 * 1_000_000.0 / total_us as f64
    }
}

fn benchmark_environment(name: &str, fallback: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn duration_us(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

fn percentile(sorted: &[u64], percentile: usize) -> u64 {
    sorted[(sorted.len() - 1) * percentile / 100]
}
