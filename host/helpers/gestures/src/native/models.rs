use std::sync::Mutex;

#[cfg(test)]
use std::time::{Duration, Instant};

use rayon::{ThreadPool, ThreadPoolBuilder};

use super::litert::Model;
use super::runtime::ModelData;
use super::Error;

const PALM_INPUT_SIZE: usize = 192 * 192 * 3;
const PALM_OUTPUT_SIZES: &[usize] = &[2016 * 18, 2016];
const LANDMARK_INPUT_SIZE: usize = 224 * 224 * 3;
const LANDMARK_OUTPUT_SIZES: &[usize] = &[63, 1, 1, 63];

pub(super) struct Models {
    inference_pool: Option<ThreadPool>,
    palm_detector: Mutex<Model>,
    landmark_detectors: Vec<Mutex<Model>>,
    #[cfg(test)]
    source: ModelData,
    #[cfg(test)]
    threads: usize,
}

pub(super) struct LandmarkOutputs {
    pub(super) image: [f32; 63],
    pub(super) presence: f32,
    pub(super) handedness: f32,
    pub(super) world: [f32; 63],
}

#[cfg(test)]
pub(super) struct ModelProfileSamples {
    pub(super) name: &'static str,
    pub(super) total: Vec<Duration>,
    pub(super) nodes: Vec<NodeProfileSamples>,
}

#[cfg(test)]
pub(super) struct NodeProfileSamples {
    pub(super) name: String,
    pub(super) operation: String,
    pub(super) detail: String,
    pub(super) output_facts: Vec<String>,
    pub(super) samples: Vec<Duration>,
}

impl Models {
    pub(super) fn load(models: &ModelData) -> Result<Self, Error> {
        Self::load_with_threads(models, configured_inference_threads())
    }

    fn load_with_threads(models: &ModelData, threads: usize) -> Result<Self, Error> {
        let lanes = threads.min(2);
        let inference_pool = if lanes > 1 {
            Some(
                ThreadPoolBuilder::new()
                    .num_threads(lanes)
                    .thread_name(|index| format!("gsv-vision-hand-{index}"))
                    .build()
                    .map_err(|_| Error::InvalidModel)?,
            )
        } else {
            None
        };
        let landmark_detectors = (0..lanes)
            .map(|_| {
                Model::load(
                    models.landmark_detector,
                    LANDMARK_INPUT_SIZE,
                    LANDMARK_OUTPUT_SIZES,
                    threads / lanes,
                    false,
                )
                .map(Mutex::new)
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            inference_pool,
            palm_detector: Mutex::new(Model::load(
                models.palm_detector,
                PALM_INPUT_SIZE,
                PALM_OUTPUT_SIZES,
                threads,
                false,
            )?),
            landmark_detectors,
            #[cfg(test)]
            source: *models,
            #[cfg(test)]
            threads,
        })
    }

    pub(super) fn inference_pool(&self) -> Option<&ThreadPool> {
        self.inference_pool.as_ref()
    }

    pub(super) fn detect_palms(&self, input: &[f32]) -> Result<(Vec<f32>, Vec<f32>), Error> {
        let mut model = self.palm_detector.lock().map_err(|_| Error::Inference)?;
        let outputs = model.run(input)?;
        let (boxes, scores) = outputs.split_at(PALM_OUTPUT_SIZES[0]);
        Ok((boxes.to_vec(), scores.to_vec()))
    }

    pub(super) fn detect_landmarks(&self, input: &[f32]) -> Result<LandmarkOutputs, Error> {
        // Only this pool's workers select parallel lanes. Other callers use lane
        // zero under the same mutex, so interpreter buffers can never overlap.
        // Two simultaneous hands divide the CPU budget; palm inference uses the
        // full budget in its separate, sequential recognition stage.
        let lane = self
            .inference_pool
            .as_ref()
            .and_then(ThreadPool::current_thread_index)
            .unwrap_or(0);
        let mut model = self.landmark_detectors[lane]
            .lock()
            .map_err(|_| Error::Inference)?;
        let outputs = model.run(input)?;
        Ok(LandmarkOutputs {
            image: outputs[..63].try_into().map_err(|_| Error::Inference)?,
            presence: outputs[63],
            handedness: outputs[64],
            world: outputs[65..].try_into().map_err(|_| Error::Inference)?,
        })
    }

    #[cfg(test)]
    pub(super) fn landmark_threads(&self) -> usize {
        self.threads / self.landmark_detectors.len()
    }

    #[cfg(test)]
    pub(super) fn profile_palms(
        &self,
        input: &[f32],
        warmup_iterations: usize,
        measured_iterations: usize,
    ) -> Result<ModelProfileSamples, Error> {
        let model = Model::load(
            self.source.palm_detector,
            PALM_INPUT_SIZE,
            PALM_OUTPUT_SIZES,
            self.threads,
            true,
        )?;
        profile_one(
            "palmDetector",
            model,
            input,
            warmup_iterations,
            measured_iterations,
        )
    }

    #[cfg(test)]
    pub(super) fn profile_landmarks(
        &self,
        input: &[f32],
        warmup_iterations: usize,
        measured_iterations: usize,
    ) -> Result<ModelProfileSamples, Error> {
        let model = Model::load(
            self.source.landmark_detector,
            LANDMARK_INPUT_SIZE,
            LANDMARK_OUTPUT_SIZES,
            self.landmark_threads(),
            true,
        )?;
        profile_one(
            "landmarkDetector",
            model,
            input,
            warmup_iterations,
            measured_iterations,
        )
    }
}

pub(super) fn configured_inference_threads() -> usize {
    selected_inference_threads(
        std::thread::available_parallelism().map_or(1, usize::from),
        benchmark_thread_override(),
    )
}

fn selected_inference_threads(available: usize, requested: Option<usize>) -> usize {
    let available = available.max(1);
    requested.unwrap_or(available.min(4)).clamp(1, available)
}

#[cfg(test)]
fn benchmark_thread_override() -> Option<usize> {
    std::env::var("GSV_VISION_BENCHMARK_THREADS")
        .ok()
        .and_then(|value| value.parse().ok())
}

#[cfg(not(test))]
fn benchmark_thread_override() -> Option<usize> {
    None
}

#[cfg(test)]
fn profile_one(
    name: &'static str,
    mut model: Model,
    input: &[f32],
    warmup_iterations: usize,
    measured_iterations: usize,
) -> Result<ModelProfileSamples, Error> {
    for _ in 0..warmup_iterations {
        model.run(input)?;
    }
    let mut total = Vec::with_capacity(measured_iterations);
    let mut nodes = std::collections::BTreeMap::new();
    for _ in 0..measured_iterations {
        let started = Instant::now();
        model.run(input)?;
        total.push(started.elapsed());
        for event in model.profile_events()? {
            nodes
                .entry((event.node, event.operation.clone()))
                .or_insert_with(|| NodeProfileSamples {
                    name: format!("xnnpack/{}", event.node),
                    operation: event.operation,
                    detail: "XNNPACK operator".into(),
                    output_facts: Vec::new(),
                    samples: Vec::with_capacity(measured_iterations),
                })
                .samples
                .push(event.duration);
        }
    }
    Ok(ModelProfileSamples {
        name,
        total,
        nodes: nodes.into_values().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::runtime::embedded_models;

    #[test]
    fn embedded_models_load_from_memory() {
        Models::load(&embedded_models()).expect("embedded models");
    }

    #[test]
    fn every_model_output_matches_the_litert_reference() {
        let source = embedded_models();
        for (bytes, input_size, output_sizes, expected) in [
            (
                source.palm_detector,
                PALM_INPUT_SIZE,
                PALM_OUTPUT_SIZES,
                include_bytes!("../../native/testdata/hand_detector.expected.f32").as_slice(),
            ),
            (
                source.landmark_detector,
                LANDMARK_INPUT_SIZE,
                LANDMARK_OUTPUT_SIZES,
                include_bytes!("../../native/testdata/hand_landmarks_detector.expected.f32")
                    .as_slice(),
            ),
        ] {
            let input: Vec<_> = (0..input_size).map(|i| (i % 256) as f32 / 255.0).collect();
            let (chunks, remainder) = expected.as_chunks::<4>();
            assert!(remainder.is_empty());
            let expected: Vec<_> = chunks.iter().copied().map(f32::from_le_bytes).collect();
            for threads in [1, 2, 4] {
                let mut model = Model::load(bytes, input_size, output_sizes, threads, false)
                    .expect("reference model");
                let actual = model.run(&input).expect("reference inference");
                assert_eq!(actual.len(), expected.len());
                for (index, (actual, expected)) in actual.iter().zip(&expected).enumerate() {
                    let tolerance = if input_size == LANDMARK_INPUT_SIZE && index >= 63 {
                        0.00002
                    } else {
                        0.002
                    };
                    assert!(
                        (actual - expected).abs() <= tolerance,
                        "output {index} differs from LiteRT at {threads} threads"
                    );
                }
            }
        }
    }

    #[test]
    fn inference_threads_default_to_four_and_stay_within_hardware_bounds() {
        assert_eq!(selected_inference_threads(1, None), 1);
        assert_eq!(selected_inference_threads(12, None), 4);
        assert_eq!(selected_inference_threads(12, Some(2)), 2);
        assert_eq!(selected_inference_threads(12, Some(0)), 1);
        assert_eq!(selected_inference_threads(12, Some(100)), 12);
    }

    #[test]
    fn invalid_models_and_tensor_sizes_fail_without_inference() {
        let bytes = embedded_models().landmark_detector;
        assert!(matches!(
            Model::load(
                &bytes[..100],
                LANDMARK_INPUT_SIZE,
                LANDMARK_OUTPUT_SIZES,
                1,
                false
            ),
            Err(Error::InvalidModel)
        ));
        assert!(matches!(
            Model::load(bytes, PALM_INPUT_SIZE, LANDMARK_OUTPUT_SIZES, 1, false),
            Err(Error::InvalidModel)
        ));
        assert!(matches!(
            Model::load(bytes, LANDMARK_INPUT_SIZE, &[128], 1, false),
            Err(Error::InvalidModel)
        ));
        let mut model = Model::load(bytes, LANDMARK_INPUT_SIZE, LANDMARK_OUTPUT_SIZES, 1, false)
            .expect("landmark model");
        assert!(matches!(model.run(&[0.0; 8]), Err(Error::Inference)));
        assert!(model.run(&vec![0.0; LANDMARK_INPUT_SIZE]).is_ok());
    }

    #[test]
    fn concurrent_hands_keep_independent_reusable_model_state() {
        let models = Models::load_with_threads(&embedded_models(), 4).expect("models");
        let first = vec![0.0; LANDMARK_INPUT_SIZE];
        let second: Vec<_> = (0..LANDMARK_INPUT_SIZE)
            .map(|i| (i % 256) as f32 / 255.0)
            .collect();
        let expected_first = models.detect_landmarks(&first).expect("first reference");
        let expected_second = models.detect_landmarks(&second).expect("second reference");
        std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for i in 0..4 {
                let (input, expected) = if i % 2 == 0 {
                    (&first, &expected_first)
                } else {
                    (&second, &expected_second)
                };
                let models = &models;
                workers.push(scope.spawn(move || {
                    models
                        .inference_pool()
                        .expect("two hand workers")
                        .install(|| {
                            for _ in 0..8 {
                                let actual = models
                                    .detect_landmarks(input)
                                    .expect("concurrent inference");
                                assert_eq!(actual.image, expected.image);
                                assert_eq!(actual.presence, expected.presence);
                                assert_eq!(actual.handedness, expected.handedness);
                                assert_eq!(actual.world, expected.world);
                            }
                        });
                }));
            }
            for worker in workers {
                worker.join().expect("hand worker");
            }
        });
    }
}
