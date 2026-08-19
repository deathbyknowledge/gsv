// Compile-only guard for the Rust declarations in
// host/helpers/gestures/src/mediapipe/ffi.rs.

#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "mediapipe/tasks/c/vision/gesture_recognizer/gesture_recognizer.h"

static_assert(sizeof(void*) == 8, "GSV supports only 64-bit MediaPipe builds");
static_assert(sizeof(bool) == 1, "MpNormalizedLandmark assumes one-byte C bool");

static_assert(std::is_standard_layout_v<MpBaseOptions>);
static_assert(sizeof(MpBaseOptions) == 72);
static_assert(alignof(MpBaseOptions) == 8);
static_assert(offsetof(MpBaseOptions, model_asset_buffer) == 0);
static_assert(offsetof(MpBaseOptions, model_asset_path) == 16);
static_assert(offsetof(MpBaseOptions, delegate) == 28);
static_assert(offsetof(MpBaseOptions, app_version) == 64);

static_assert(std::is_standard_layout_v<MpClassifierOptions>);
static_assert(sizeof(MpClassifierOptions) == 48);
static_assert(alignof(MpClassifierOptions) == 8);
static_assert(offsetof(MpClassifierOptions, max_results) == 8);
static_assert(offsetof(MpClassifierOptions, category_allowlist) == 16);
static_assert(offsetof(MpClassifierOptions, category_denylist_count) == 40);

static_assert(std::is_standard_layout_v<MpGestureRecognizerOptions>);
static_assert(sizeof(MpGestureRecognizerOptions) == 200);
static_assert(alignof(MpGestureRecognizerOptions) == 8);
static_assert(offsetof(MpGestureRecognizerOptions, running_mode) == 72);
static_assert(offsetof(MpGestureRecognizerOptions,
                       canned_gestures_classifier_options) == 96);
static_assert(offsetof(MpGestureRecognizerOptions,
                       custom_gestures_classifier_options) == 144);
static_assert(offsetof(MpGestureRecognizerOptions, result_callback) == 192);

static_assert(std::is_standard_layout_v<MpCategory>);
static_assert(sizeof(MpCategory) == 24);
static_assert(offsetof(MpCategory, category_name) == 8);
static_assert(sizeof(MpCategories) == 16);

static_assert(std::is_standard_layout_v<MpNormalizedLandmark>);
static_assert(sizeof(MpNormalizedLandmark) == 40);
static_assert(offsetof(MpNormalizedLandmark, has_visibility) == 12);
static_assert(offsetof(MpNormalizedLandmark, visibility) == 16);
static_assert(offsetof(MpNormalizedLandmark, has_presence) == 20);
static_assert(offsetof(MpNormalizedLandmark, presence) == 24);
static_assert(offsetof(MpNormalizedLandmark, name) == 32);
static_assert(sizeof(MpNormalizedLandmarks) == 16);

static_assert(std::is_standard_layout_v<MpGestureRecognizerResult>);
static_assert(sizeof(MpGestureRecognizerResult) == 64);
static_assert(offsetof(MpGestureRecognizerResult, gestures_count) == 8);
static_assert(offsetof(MpGestureRecognizerResult, handedness) == 16);
static_assert(offsetof(MpGestureRecognizerResult, hand_landmarks) == 32);
static_assert(offsetof(MpGestureRecognizerResult, hand_world_landmarks) == 48);

int main() { return 0; }
