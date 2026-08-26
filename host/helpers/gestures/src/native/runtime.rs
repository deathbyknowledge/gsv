#[derive(Clone, Copy)]
pub(crate) struct ModelData {
    pub(crate) palm_detector: &'static [u8],
    pub(crate) landmark_detector: &'static [u8],
}

const PALM_DETECTOR: &[u8] = include_bytes!("../../models/hand_detector.tflite");
const LANDMARK_DETECTOR: &[u8] = include_bytes!("../../models/hand_landmarks_detector.tflite");

pub(crate) const fn embedded_models() -> ModelData {
    ModelData {
        palm_detector: PALM_DETECTOR,
        landmark_detector: LANDMARK_DETECTOR,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_models_match_the_pinned_contract() {
        let models = embedded_models();
        assert_eq!(models.palm_detector.len(), 2_339_878);
        assert_eq!(models.landmark_detector.len(), 5_478_949);
    }
}
