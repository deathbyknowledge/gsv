use std::path::Path;
use std::sync::Arc;

use rayon::ThreadPoolBuilder;
use tract_linalg::multithread::Executor;
use tract_tflite::prelude::*;

use super::runtime::ModelPaths;
use super::Error;

type Plan = Arc<TypedRunnableModel>;

pub(super) struct Models {
    palm_detector: Plan,
    landmark_detector: Plan,
    gesture_embedder: Plan,
    gesture_classifier: Plan,
}

pub(super) struct LandmarkOutputs {
    pub(super) image: [f32; 63],
    pub(super) presence: f32,
    pub(super) handedness: f32,
    pub(super) world: [f32; 63],
}

impl Models {
    pub(super) fn load(paths: &ModelPaths) -> Result<Self, Error> {
        let executor = inference_executor()?;
        Ok(Self {
            palm_detector: load(&paths.palm_detector, &executor)?,
            landmark_detector: load(&paths.landmark_detector, &executor)?,
            gesture_embedder: load(&paths.gesture_embedder, &executor)?,
            gesture_classifier: load(&paths.gesture_classifier, &executor)?,
        })
    }

    pub(super) fn detect_palms(&self, input: &[f32]) -> Result<(Vec<f32>, Vec<f32>), Error> {
        let outputs = run_one(&self.palm_detector, &[1, 192, 192, 3], input)?;
        if outputs.len() != 2 {
            return Err(Error::Inference);
        }
        Ok((
            tensor_values(&outputs[0], 2016 * 18)?,
            tensor_values(&outputs[1], 2016)?,
        ))
    }

    pub(super) fn detect_landmarks(&self, input: &[f32]) -> Result<LandmarkOutputs, Error> {
        let outputs = run_one(&self.landmark_detector, &[1, 224, 224, 3], input)?;
        if outputs.len() != 4 {
            return Err(Error::Inference);
        }
        Ok(LandmarkOutputs {
            image: tensor_array(&outputs[0])?,
            presence: tensor_scalar(&outputs[1])?,
            handedness: tensor_scalar(&outputs[2])?,
            world: tensor_array(&outputs[3])?,
        })
    }

    pub(super) fn classify_gesture(
        &self,
        landmarks: &[f32; 63],
        right_hand_score: f32,
        world_landmarks: &[f32; 63],
    ) -> Result<[f32; 8], Error> {
        let inputs = tvec![
            Tensor::from_shape(&[1, 21, 3], landmarks)
                .map_err(|_| Error::Inference)?
                .into_tvalue(),
            Tensor::from_shape(&[1, 1], &[right_hand_score])
                .map_err(|_| Error::Inference)?
                .into_tvalue(),
            Tensor::from_shape(&[1, 21, 3], world_landmarks)
                .map_err(|_| Error::Inference)?
                .into_tvalue(),
        ];
        let embedding = self
            .gesture_embedder
            .run(inputs)
            .map_err(|_| Error::Inference)?;
        if embedding.len() != 1 {
            return Err(Error::Inference);
        }
        let embedding = tensor_values(&embedding[0], 128)?;
        let outputs = run_one(&self.gesture_classifier, &[1, 128], &embedding)?;
        if outputs.len() != 1 {
            return Err(Error::Inference);
        }
        tensor_array(&outputs[0])
    }
}

fn load(path: &Path, executor: &Executor) -> Result<Plan, Error> {
    tract_tflite::tflite()
        .model_for_path(path)
        .and_then(|model| model.into_optimized())
        .and_then(|model| {
            model.into_runnable_with_options(&RunOptions {
                executor: Some(executor.clone()),
                ..RunOptions::default()
            })
        })
        .map_err(|_| Error::InvalidModel)
}

fn inference_executor() -> Result<Executor, Error> {
    let threads = configured_inference_threads();
    if threads == 1 {
        return Ok(Executor::SingleThread);
    }
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("gsv-vision-inference-{index}"))
        .build()
        .map(|pool| Executor::MultiThread(Arc::new(pool)))
        .map_err(|_| Error::InvalidModel)
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

fn run_one(plan: &Plan, shape: &[usize], values: &[f32]) -> Result<TVec<TValue>, Error> {
    let input = Tensor::from_shape(shape, values).map_err(|_| Error::Inference)?;
    plan.run(tvec![input.into_tvalue()])
        .map_err(|_| Error::Inference)
}

fn tensor_scalar(value: &TValue) -> Result<f32, Error> {
    let values = value
        .to_plain_array_view::<f32>()
        .map_err(|_| Error::Inference)?;
    values.iter().copied().next().ok_or(Error::Inference)
}

fn tensor_values(value: &TValue, expected: usize) -> Result<Vec<f32>, Error> {
    let values = value
        .to_plain_array_view::<f32>()
        .map_err(|_| Error::Inference)?;
    if values.len() != expected {
        return Err(Error::Inference);
    }
    Ok(values.iter().copied().collect())
}

fn tensor_array<const N: usize>(value: &TValue) -> Result<[f32; N], Error> {
    tensor_values(value, N)?
        .try_into()
        .map_err(|_| Error::Inference)
}

#[cfg(test)]
mod tests {
    use super::selected_inference_threads;

    #[test]
    fn inference_threads_default_to_four_and_stay_within_hardware_bounds() {
        assert_eq!(selected_inference_threads(1, None), 1);
        assert_eq!(selected_inference_threads(12, None), 4);
        assert_eq!(selected_inference_threads(12, Some(2)), 2);
        assert_eq!(selected_inference_threads(12, Some(0)), 1);
        assert_eq!(selected_inference_threads(12, Some(100)), 12);
    }
}
