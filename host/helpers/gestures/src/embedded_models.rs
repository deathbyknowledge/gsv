use gesture_engine::vision::ModelData;

const PALM_DETECTOR: &[u8] = include_bytes!("../models/hand_detector.tflite");
const LANDMARK_DETECTOR: &[u8] = include_bytes!("../models/hand_landmarks_detector.tflite");

pub(crate) const fn embedded_models() -> ModelData<'static> {
    ModelData::new(PALM_DETECTOR, LANDMARK_DETECTOR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_models_match_the_pinned_contract() {
        let models = embedded_models();
        assert_eq!(models.palm_detector().len(), 2_339_878);
        assert_eq!(models.landmark_detector().len(), 5_478_949);
        gesture_engine::vision::TractHandTracker::load(&models).expect("embedded models");
    }
}
