//! Minimal MediaPipe Tasks C ABI surface used by the gesture recognizer.
//!
//! The layout is pinned to MediaPipe v1.0.0. Keep this module in sync with
//! `scripts/vision-mediapipe/verify-abi.cc`.

use std::ffi::{c_char, c_int, c_void};

pub(super) const MP_OK: c_int = 0;
pub(super) const MP_DELEGATE_CPU: c_int = 0;
pub(super) const MP_HOST_ENVIRONMENT_UNKNOWN: c_int = 0;
pub(super) const MP_HOST_SYSTEM_UNKNOWN: c_int = 0;
pub(super) const MP_HOST_SYSTEM_LINUX: c_int = 1;
pub(super) const MP_HOST_SYSTEM_MAC: c_int = 2;
pub(super) const MP_RUNNING_MODE_VIDEO: c_int = 2;
pub(super) const MP_IMAGE_FORMAT_SRGB: c_int = 1;

pub(super) type RecognizerPtr = *mut c_void;
pub(super) type ImagePtr = *mut c_void;

#[repr(C)]
pub(super) struct BaseOptions {
    pub model_asset_buffer: *const c_char,
    pub model_asset_buffer_count: u32,
    pub model_asset_path: *const c_char,
    pub file_descriptor: c_int,
    pub delegate: c_int,
    pub host_environment: c_int,
    pub host_system: c_int,
    pub host_version: *const c_char,
    pub ca_bundle_path: *const c_char,
    pub app_id: *const c_char,
    pub app_version: *const c_char,
}

#[repr(C)]
pub(super) struct ClassifierOptions {
    pub display_names_locale: *const c_char,
    pub max_results: c_int,
    pub score_threshold: f32,
    pub category_allowlist: *const *const c_char,
    pub category_allowlist_count: u32,
    pub category_denylist: *const *const c_char,
    pub category_denylist_count: u32,
}

pub(super) type ResultCallback =
    Option<unsafe extern "C" fn(c_int, *const GestureRecognizerResult, ImagePtr, i64)>;

#[repr(C)]
pub(super) struct GestureRecognizerOptions {
    pub base_options: BaseOptions,
    pub running_mode: c_int,
    pub num_hands: c_int,
    pub min_hand_detection_confidence: f32,
    pub min_hand_presence_confidence: f32,
    pub min_tracking_confidence: f32,
    pub canned_gestures_classifier_options: ClassifierOptions,
    pub custom_gestures_classifier_options: ClassifierOptions,
    pub result_callback: ResultCallback,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub(super) struct Category {
    pub index: c_int,
    pub score: f32,
    pub category_name: *mut c_char,
    pub display_name: *mut c_char,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub(super) struct Categories {
    pub categories: *mut Category,
    pub categories_count: u32,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub(super) struct NormalizedLandmark {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    // C `bool` is one byte on the supported Linux and macOS ABIs. Using `u8`
    // avoids creating an invalid Rust `bool` if native memory is malformed.
    pub has_visibility: u8,
    pub visibility: f32,
    pub has_presence: u8,
    pub presence: f32,
    pub name: *mut c_char,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub(super) struct NormalizedLandmarks {
    pub landmarks: *mut NormalizedLandmark,
    pub landmarks_count: u32,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub(super) struct GestureRecognizerResult {
    pub gestures: *mut Categories,
    pub gestures_count: u32,
    pub handedness: *mut Categories,
    pub handedness_count: u32,
    pub hand_landmarks: *mut NormalizedLandmarks,
    pub hand_landmarks_count: u32,
    pub hand_world_landmarks: *mut c_void,
    pub hand_world_landmarks_count: u32,
}

impl Default for GestureRecognizerResult {
    fn default() -> Self {
        Self {
            gestures: std::ptr::null_mut(),
            gestures_count: 0,
            handedness: std::ptr::null_mut(),
            handedness_count: 0,
            hand_landmarks: std::ptr::null_mut(),
            hand_landmarks_count: 0,
            hand_world_landmarks: std::ptr::null_mut(),
            hand_world_landmarks_count: 0,
        }
    }
}

pub(super) trait Bindings {
    unsafe fn recognizer_create(
        &self,
        options: *const GestureRecognizerOptions,
        recognizer: *mut RecognizerPtr,
        error: *mut *mut c_char,
    ) -> c_int;

    unsafe fn recognize_for_video(
        &self,
        recognizer: RecognizerPtr,
        image: ImagePtr,
        image_processing_options: *const c_void,
        timestamp_ms: i64,
        result: *mut GestureRecognizerResult,
        error: *mut *mut c_char,
    ) -> c_int;

    unsafe fn recognizer_close_result(&self, result: *mut GestureRecognizerResult);

    unsafe fn recognizer_close(&self, recognizer: RecognizerPtr, error: *mut *mut c_char) -> c_int;

    // This mirrors the pinned C ABI exactly; grouping its arguments would make
    // the test binding differ from the dynamically loaded function contract.
    #[allow(clippy::too_many_arguments)]
    unsafe fn image_create_from_u8(
        &self,
        format: c_int,
        width: c_int,
        height: c_int,
        pixels: *const u8,
        pixels_len: c_int,
        image: *mut ImagePtr,
        error: *mut *mut c_char,
    ) -> c_int;

    unsafe fn image_free(&self, image: ImagePtr);

    unsafe fn error_free(&self, error: *mut c_char);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{align_of, size_of};

    #[test]
    fn v1_abi_layout_matches_supported_64_bit_targets() {
        assert_eq!(size_of::<usize>(), 8, "only 64-bit hosts are supported");
        assert_eq!(size_of::<BaseOptions>(), 72);
        assert_eq!(align_of::<BaseOptions>(), 8);
        assert_eq!(size_of::<ClassifierOptions>(), 48);
        assert_eq!(align_of::<ClassifierOptions>(), 8);
        assert_eq!(size_of::<GestureRecognizerOptions>(), 200);
        assert_eq!(align_of::<GestureRecognizerOptions>(), 8);
        assert_eq!(size_of::<Category>(), 24);
        assert_eq!(size_of::<Categories>(), 16);
        assert_eq!(size_of::<NormalizedLandmark>(), 40);
        assert_eq!(size_of::<NormalizedLandmarks>(), 16);
        assert_eq!(size_of::<GestureRecognizerResult>(), 64);
    }
}
