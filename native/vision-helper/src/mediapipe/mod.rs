//! Local, dynamically loaded MediaPipe gesture recognition.
//!
//! This module deliberately exposes neither MediaPipe's native diagnostics nor
//! the configured library/model paths. Native diagnostics can contain private
//! filesystem information; callers get only a bounded operation and status.

mod dynamic;
mod ffi;

use std::error::Error as StdError;
use std::ffi::{c_char, c_void, CString};
use std::fmt::{self, Display, Formatter};
use std::path::Path;
use std::ptr;
use std::time::Instant;

use crate::observation::{
    FrameView, HandObservation, Handedness, Landmark, Observation, HAND_LANDMARK_COUNT,
    MAX_GESTURE_LABEL_BYTES, MAX_HANDS,
};

use self::dynamic::DynamicBindings;
use self::ffi::{
    BaseOptions, Bindings, Categories, ClassifierOptions, GestureRecognizerOptions,
    GestureRecognizerResult, ImagePtr, NormalizedLandmark, RecognizerPtr, MP_DELEGATE_CPU,
    MP_HOST_ENVIRONMENT_UNKNOWN, MP_HOST_SYSTEM_LINUX, MP_HOST_SYSTEM_MAC, MP_HOST_SYSTEM_UNKNOWN,
    MP_IMAGE_FORMAT_SRGB, MP_OK, MP_RUNNING_MODE_VIDEO,
};

const MAX_FRAME_WIDTH: u32 = 1_920;
const MAX_FRAME_HEIGHT: u32 = 1_080;
const RGB_CHANNELS: usize = 3;

/// Path-free failures from the local MediaPipe boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    LibraryUnavailable,
    MissingSymbol(&'static str),
    InvalidModelPath,
    InvalidFrame(&'static str),
    InvalidTimestamp,
    NativeFailure {
        operation: &'static str,
        status: i32,
    },
    MalformedResult(&'static str),
}

impl Display for Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::LibraryUnavailable => formatter.write_str("MediaPipe library is unavailable"),
            Self::MissingSymbol(symbol) => {
                write!(formatter, "MediaPipe library is missing {symbol}")
            }
            Self::InvalidModelPath => formatter.write_str("MediaPipe model path is invalid"),
            Self::InvalidFrame(reason) => write!(formatter, "invalid video frame: {reason}"),
            Self::InvalidTimestamp => {
                formatter.write_str("video timestamp must be non-negative and strictly increasing")
            }
            Self::NativeFailure { operation, status } => {
                write!(
                    formatter,
                    "MediaPipe {operation} failed with status {status}"
                )
            }
            Self::MalformedResult(reason) => {
                write!(formatter, "MediaPipe returned a malformed result: {reason}")
            }
        }
    }
}

impl StdError for Error {}

/// A CPU Gesture Recognizer configured for at most two hands in video mode.
///
/// Calls are synchronous and timestamps must strictly increase. The helper can
/// keep this object on its inference worker; no camera or network capability is
/// owned by this type.
pub struct GestureRecognizer {
    bindings: Box<dyn Bindings>,
    recognizer: RecognizerPtr,
    last_timestamp_ms: Option<i64>,
}

impl GestureRecognizer {
    /// Loads the pinned C API artifact and opens the supplied local task model.
    ///
    /// Neither path is retained as text or included in an error.
    pub fn load(library_path: &Path, model_path: &Path) -> Result<Self, Error> {
        let bindings = Box::new(DynamicBindings::load(library_path)?);
        Self::create(bindings, model_path)
    }

    /// Recognizes gestures in one tightly packed RGB frame.
    pub fn recognize(
        &mut self,
        frame: &FrameView,
        timestamp_ms: i64,
    ) -> Result<Observation, Error> {
        let (width, height, pixels_len) = validate_frame(frame)?;
        if timestamp_ms < 0
            || self
                .last_timestamp_ms
                .is_some_and(|previous| timestamp_ms <= previous)
        {
            return Err(Error::InvalidTimestamp);
        }

        let bindings = &*self.bindings;
        let mut image = ptr::null_mut();
        let mut native_error = ptr::null_mut();
        // SAFETY: frame validation proves the pointer covers exactly
        // `pixels_len` bytes. MediaPipe copies the bytes before returning.
        let status = unsafe {
            bindings.image_create_from_u8(
                MP_IMAGE_FORMAT_SRGB,
                width,
                height,
                frame.rgb.as_ptr(),
                pixels_len,
                &mut image,
                &mut native_error,
            )
        };
        free_native_error(bindings, native_error);
        if status != MP_OK {
            return Err(Error::NativeFailure {
                operation: "image creation",
                status,
            });
        }
        if image.is_null() {
            return Err(Error::MalformedResult("image creation returned no image"));
        }
        let _image_guard = ImageGuard { bindings, image };

        let started = Instant::now();
        let mut result = GestureRecognizerResult::default();
        native_error = ptr::null_mut();
        // The timestamp is consumed once the recognizer is called, including
        // when the native call fails; retrying it would violate VIDEO mode.
        self.last_timestamp_ms = Some(timestamp_ms);
        // SAFETY: recognizer and image are live native handles. A null image
        // processing options pointer requests the full, unrotated image.
        let status = unsafe {
            bindings.recognize_for_video(
                self.recognizer,
                image,
                ptr::null::<c_void>(),
                timestamp_ms,
                &mut result,
                &mut native_error,
            )
        };
        free_native_error(bindings, native_error);
        if status != MP_OK {
            return Err(Error::NativeFailure {
                operation: "video recognition",
                status,
            });
        }
        let _result_guard = ResultGuard {
            bindings,
            result: &mut result,
        };

        // SAFETY: a successful C call owns the result until the guard closes it.
        let hands = unsafe { convert_result(&result)? };
        let observed_at = Instant::now();
        Ok(Observation {
            frame_sequence: frame.sequence,
            observed_at,
            hands,
            inference_time: observed_at.saturating_duration_since(started),
        })
    }

    fn create(bindings: Box<dyn Bindings>, model_path: &Path) -> Result<Self, Error> {
        let model_path = path_to_c_string(model_path)?;
        let base_options = BaseOptions {
            model_asset_buffer: ptr::null(),
            model_asset_buffer_count: 0,
            model_asset_path: model_path.as_ptr(),
            file_descriptor: 0,
            delegate: MP_DELEGATE_CPU,
            host_environment: MP_HOST_ENVIRONMENT_UNKNOWN,
            host_system: host_system(),
            host_version: ptr::null(),
            ca_bundle_path: ptr::null(),
            app_id: ptr::null(),
            app_version: ptr::null(),
        };
        let canned_options = classifier_options(1);
        // No custom classifier exists in the canned task bundle. A negative
        // limit is the C API's valid "all" default; zero is invalid.
        let custom_options = classifier_options(-1);
        let options = GestureRecognizerOptions {
            base_options,
            running_mode: MP_RUNNING_MODE_VIDEO,
            num_hands: MAX_HANDS as i32,
            min_hand_detection_confidence: 0.5,
            min_hand_presence_confidence: 0.5,
            min_tracking_confidence: 0.5,
            canned_gestures_classifier_options: canned_options,
            custom_gestures_classifier_options: custom_options,
            result_callback: None,
        };

        let mut recognizer = ptr::null_mut();
        let mut native_error = ptr::null_mut();
        // SAFETY: all option pointers remain valid for the duration of create;
        // MediaPipe converts them into owned C++ options before returning.
        let status =
            unsafe { bindings.recognizer_create(&options, &mut recognizer, &mut native_error) };
        free_native_error(&*bindings, native_error);
        if status != MP_OK {
            return Err(Error::NativeFailure {
                operation: "recognizer creation",
                status,
            });
        }
        if recognizer.is_null() {
            return Err(Error::MalformedResult(
                "recognizer creation returned no recognizer",
            ));
        }

        Ok(Self {
            bindings,
            recognizer,
            last_timestamp_ms: None,
        })
    }
}

impl Drop for GestureRecognizer {
    fn drop(&mut self) {
        if self.recognizer.is_null() {
            return;
        }
        let mut native_error = ptr::null_mut();
        // SAFETY: this object uniquely owns the live recognizer handle.
        let _ = unsafe {
            self.bindings
                .recognizer_close(self.recognizer, &mut native_error)
        };
        self.recognizer = ptr::null_mut();
        free_native_error(&*self.bindings, native_error);
    }
}

fn classifier_options(max_results: i32) -> ClassifierOptions {
    ClassifierOptions {
        display_names_locale: ptr::null(),
        max_results,
        score_threshold: 0.0,
        category_allowlist: ptr::null(),
        category_allowlist_count: 0,
        category_denylist: ptr::null(),
        category_denylist_count: 0,
    }
}

fn host_system() -> i32 {
    if cfg!(target_os = "linux") {
        MP_HOST_SYSTEM_LINUX
    } else if cfg!(target_os = "macos") {
        MP_HOST_SYSTEM_MAC
    } else {
        MP_HOST_SYSTEM_UNKNOWN
    }
}

fn path_to_c_string(path: &Path) -> Result<CString, Error> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;

        let bytes = path.as_os_str().as_bytes();
        if bytes.is_empty() {
            return Err(Error::InvalidModelPath);
        }
        CString::new(bytes).map_err(|_| Error::InvalidModelPath)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(Error::InvalidModelPath)
    }
}

fn validate_frame(frame: &FrameView) -> Result<(i32, i32, i32), Error> {
    if frame.width == 0 || frame.height == 0 {
        return Err(Error::InvalidFrame("dimensions must be non-zero"));
    }
    if frame.width > MAX_FRAME_WIDTH || frame.height > MAX_FRAME_HEIGHT {
        return Err(Error::InvalidFrame("dimensions exceed the local limit"));
    }
    let expected_len = usize::try_from(frame.width)
        .ok()
        .and_then(|width| {
            usize::try_from(frame.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(RGB_CHANNELS))
        .ok_or(Error::InvalidFrame("dimensions overflow"))?;
    if expected_len != frame.rgb.len() {
        return Err(Error::InvalidFrame(
            "RGB byte length does not match dimensions",
        ));
    }
    Ok((
        i32::try_from(frame.width).map_err(|_| Error::InvalidFrame("width overflows C int"))?,
        i32::try_from(frame.height).map_err(|_| Error::InvalidFrame("height overflows C int"))?,
        i32::try_from(expected_len)
            .map_err(|_| Error::InvalidFrame("byte length overflows C int"))?,
    ))
}

unsafe fn convert_result(result: &GestureRecognizerResult) -> Result<Vec<HandObservation>, Error> {
    let hand_count = usize::try_from(result.hand_landmarks_count)
        .map_err(|_| Error::MalformedResult("hand count overflows"))?;
    if hand_count > MAX_HANDS {
        return Err(Error::MalformedResult("too many hands"));
    }
    if usize::try_from(result.gestures_count).ok() != Some(hand_count)
        || usize::try_from(result.handedness_count).ok() != Some(hand_count)
    {
        return Err(Error::MalformedResult(
            "per-hand arrays have different lengths",
        ));
    }

    // SAFETY: counts have been bounded and a successful MediaPipe call owns
    // these arrays for the duration of conversion.
    let gestures = unsafe { bounded_slice(result.gestures, hand_count)? };
    // SAFETY: same ownership and bounds as above.
    let handedness = unsafe { bounded_slice(result.handedness, hand_count)? };
    // SAFETY: same ownership and bounds as above.
    let hand_landmarks = unsafe { bounded_slice(result.hand_landmarks, hand_count)? };

    let mut hands = Vec::with_capacity(hand_count);
    for index in 0..hand_count {
        // SAFETY: category group counts are checked before dereferencing.
        let (gesture, gesture_score) = unsafe { convert_gesture(&gestures[index])? };
        // SAFETY: category group counts are checked before dereferencing.
        let (hand, handedness_score) = unsafe { convert_handedness(&handedness[index])? };
        // SAFETY: landmark count is checked before dereferencing.
        let landmarks = unsafe { convert_landmarks(&hand_landmarks[index])? };
        hands.push(HandObservation {
            handedness: hand,
            handedness_score,
            gesture: gesture.to_owned(),
            gesture_score,
            landmarks,
        });
    }
    Ok(hands)
}

unsafe fn bounded_slice<'a, T>(pointer: *const T, count: usize) -> Result<&'a [T], Error> {
    if count == 0 {
        return Ok(&[]);
    }
    if pointer.is_null() {
        return Err(Error::MalformedResult("non-empty array has a null pointer"));
    }
    // SAFETY: the native result contract supplies `count` initialized values;
    // every caller bounds `count` before reaching this helper.
    Ok(unsafe { std::slice::from_raw_parts(pointer, count) })
}

unsafe fn convert_gesture(group: &Categories) -> Result<(&'static str, f32), Error> {
    let count = usize::try_from(group.categories_count)
        .map_err(|_| Error::MalformedResult("gesture count overflows"))?;
    if count > 1 {
        return Err(Error::MalformedResult("too many gesture categories"));
    }
    if count == 0 {
        return Ok(("None", 0.0));
    }
    // SAFETY: the group count is bounded to one.
    let categories = unsafe { bounded_slice(group.categories, count)? };
    let category = &categories[0];
    validate_score(category.score, "invalid gesture score")?;
    // SAFETY: MediaPipe documents category_name as a C string. Scanning is
    // capped so malformed native output cannot cause an unbounded read.
    let label = unsafe { bounded_label(category.category_name)? };
    let known = match label.as_slice() {
        b"None" => "None",
        b"Closed_Fist" => "Closed_Fist",
        b"Open_Palm" => "Open_Palm",
        b"Pointing_Up" => "Pointing_Up",
        b"Thumb_Down" => "Thumb_Down",
        b"Thumb_Up" => "Thumb_Up",
        b"Victory" => "Victory",
        b"ILoveYou" => "ILoveYou",
        _ => return Err(Error::MalformedResult("unknown canned gesture label")),
    };
    Ok((known, category.score))
}

unsafe fn convert_handedness(group: &Categories) -> Result<(Handedness, f32), Error> {
    let count = usize::try_from(group.categories_count)
        .map_err(|_| Error::MalformedResult("handedness count overflows"))?;
    if count > 1 {
        return Err(Error::MalformedResult("too many handedness categories"));
    }
    if count == 0 {
        return Ok((Handedness::Unknown, 0.0));
    }
    // SAFETY: the group count is bounded to one.
    let categories = unsafe { bounded_slice(group.categories, count)? };
    let category = &categories[0];
    validate_score(category.score, "invalid handedness score")?;
    // SAFETY: see `convert_gesture`.
    let label = unsafe { bounded_label(category.category_name)? };
    let hand = match label.as_slice() {
        b"Left" => Handedness::Left,
        b"Right" => Handedness::Right,
        _ => Handedness::Unknown,
    };
    Ok((hand, category.score))
}

unsafe fn convert_landmarks(
    group: &ffi::NormalizedLandmarks,
) -> Result<[Landmark; HAND_LANDMARK_COUNT], Error> {
    let count = usize::try_from(group.landmarks_count)
        .map_err(|_| Error::MalformedResult("landmark count overflows"))?;
    if count != HAND_LANDMARK_COUNT {
        return Err(Error::MalformedResult(
            "hand must contain exactly 21 landmarks",
        ));
    }
    // SAFETY: the count is exactly the fixed public output size.
    let native = unsafe { bounded_slice(group.landmarks, count)? };
    let mut landmarks = [Landmark::default(); HAND_LANDMARK_COUNT];
    for (output, input) in landmarks.iter_mut().zip(native) {
        validate_landmark(input)?;
        *output = Landmark {
            x: input.x,
            y: input.y,
            z: input.z,
        };
    }
    Ok(landmarks)
}

fn validate_score(score: f32, reason: &'static str) -> Result<(), Error> {
    if !score.is_finite() || !(0.0..=1.0).contains(&score) {
        return Err(Error::MalformedResult(reason));
    }
    Ok(())
}

fn validate_landmark(landmark: &NormalizedLandmark) -> Result<(), Error> {
    if !landmark.x.is_finite() || !landmark.y.is_finite() || !landmark.z.is_finite() {
        return Err(Error::MalformedResult("non-finite landmark"));
    }
    Ok(())
}

unsafe fn bounded_label(pointer: *const c_char) -> Result<Vec<u8>, Error> {
    if pointer.is_null() {
        return Err(Error::MalformedResult("category has no label"));
    }
    let mut bytes = Vec::with_capacity(MAX_GESTURE_LABEL_BYTES);
    for offset in 0..MAX_GESTURE_LABEL_BYTES {
        // SAFETY: category_name is a native C string by contract. The loop cap
        // prevents scanning beyond the maximum accepted label length.
        let byte = unsafe { pointer.add(offset).read() } as u8;
        if byte == 0 {
            return Ok(bytes);
        }
        bytes.push(byte);
    }
    Err(Error::MalformedResult("category label is too long"))
}

fn free_native_error(bindings: &dyn Bindings, error: *mut c_char) {
    if error.is_null() {
        return;
    }
    // SAFETY: every error pointer returned by this C API is released exactly
    // once and is intentionally never read or converted to text.
    unsafe { bindings.error_free(error) };
}

struct ImageGuard<'a> {
    bindings: &'a dyn Bindings,
    image: ImagePtr,
}

impl Drop for ImageGuard<'_> {
    fn drop(&mut self) {
        // SAFETY: the guard uniquely owns a successful image handle.
        unsafe { self.bindings.image_free(self.image) };
    }
}

struct ResultGuard<'a> {
    bindings: &'a dyn Bindings,
    result: *mut GestureRecognizerResult,
}

impl Drop for ResultGuard<'_> {
    fn drop(&mut self) {
        // SAFETY: the guard is armed only after successful recognition and
        // closes the result's nested native allocations exactly once.
        unsafe { self.bindings.recognizer_close_result(self.result) };
    }
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::ffi::CString;
    use std::rc::Rc;
    use std::sync::Arc;

    const FAKE_RECOGNIZER: RecognizerPtr = 1_usize as RecognizerPtr;
    const FAKE_IMAGE: ImagePtr = 2_usize as ImagePtr;

    #[derive(Default)]
    struct FakeState {
        create_status: Cell<i32>,
        recognize_status: Cell<i32>,
        malformed_hand_count: Cell<Option<u32>>,
        creates: Cell<usize>,
        closes: Cell<usize>,
        image_creates: Cell<usize>,
        image_frees: Cell<usize>,
        result_closes: Cell<usize>,
        error_frees: Cell<usize>,
        result: RefCell<Option<ResultStorage>>,
    }

    struct FakeBindings {
        state: Rc<FakeState>,
    }

    impl Bindings for FakeBindings {
        unsafe fn recognizer_create(
            &self,
            options: *const GestureRecognizerOptions,
            recognizer: *mut RecognizerPtr,
            error: *mut *mut c_char,
        ) -> i32 {
            self.state.creates.set(self.state.creates.get() + 1);
            // SAFETY: the wrapper provides initialized output/options pointers.
            let options = unsafe { &*options };
            assert_eq!(options.running_mode, MP_RUNNING_MODE_VIDEO);
            assert_eq!(options.num_hands, 2);
            assert_eq!(options.base_options.delegate, MP_DELEGATE_CPU);
            let status = self.state.create_status.get();
            if status == MP_OK {
                // SAFETY: output pointer is live for this call.
                unsafe { recognizer.write(FAKE_RECOGNIZER) };
            } else {
                // SAFETY: output pointer is live for this call.
                unsafe { error.write(secret_native_error()) };
            }
            status
        }

        unsafe fn recognize_for_video(
            &self,
            recognizer: RecognizerPtr,
            image: ImagePtr,
            image_processing_options: *const c_void,
            _timestamp_ms: i64,
            result: *mut GestureRecognizerResult,
            error: *mut *mut c_char,
        ) -> i32 {
            assert_eq!(recognizer, FAKE_RECOGNIZER);
            assert_eq!(image, FAKE_IMAGE);
            assert!(image_processing_options.is_null());
            let status = self.state.recognize_status.get();
            if status != MP_OK {
                // SAFETY: output pointer is live for this call.
                unsafe { error.write(secret_native_error()) };
                return status;
            }
            let mut storage = ResultStorage::two_hands();
            if let Some(count) = self.state.malformed_hand_count.get() {
                storage.raw.hand_landmarks_count = count;
            }
            // SAFETY: output pointer is live and storage remains owned by state
            // until `recognizer_close_result`.
            unsafe { result.write(storage.raw) };
            self.state.result.replace(Some(storage));
            status
        }

        unsafe fn recognizer_close_result(&self, _result: *mut GestureRecognizerResult) {
            self.state
                .result_closes
                .set(self.state.result_closes.get() + 1);
            self.state.result.borrow_mut().take();
        }

        unsafe fn recognizer_close(
            &self,
            recognizer: RecognizerPtr,
            _error: *mut *mut c_char,
        ) -> i32 {
            assert_eq!(recognizer, FAKE_RECOGNIZER);
            self.state.closes.set(self.state.closes.get() + 1);
            MP_OK
        }

        #[allow(clippy::too_many_arguments)]
        unsafe fn image_create_from_u8(
            &self,
            format: i32,
            width: i32,
            height: i32,
            pixels: *const u8,
            pixels_len: i32,
            image: *mut ImagePtr,
            _error: *mut *mut c_char,
        ) -> i32 {
            assert_eq!(format, MP_IMAGE_FORMAT_SRGB);
            assert!(width > 0 && height > 0 && pixels_len > 0);
            assert!(!pixels.is_null());
            self.state
                .image_creates
                .set(self.state.image_creates.get() + 1);
            // SAFETY: output pointer is live for this call.
            unsafe { image.write(FAKE_IMAGE) };
            MP_OK
        }

        unsafe fn image_free(&self, image: ImagePtr) {
            assert_eq!(image, FAKE_IMAGE);
            self.state.image_frees.set(self.state.image_frees.get() + 1);
        }

        unsafe fn error_free(&self, error: *mut c_char) {
            self.state.error_frees.set(self.state.error_frees.get() + 1);
            // SAFETY: fake errors are created by `CString::into_raw` once and
            // this callback receives unique ownership.
            drop(unsafe { CString::from_raw(error) });
        }
    }

    struct ResultStorage {
        raw: GestureRecognizerResult,
        _gesture_categories: Box<[[ffi::Category; 1]]>,
        _gesture_groups: Box<[Categories]>,
        _handedness_categories: Box<[[ffi::Category; 1]]>,
        _handedness_groups: Box<[Categories]>,
        _landmarks: Box<[[NormalizedLandmark; HAND_LANDMARK_COUNT]]>,
        _landmark_groups: Box<[ffi::NormalizedLandmarks]>,
    }

    impl ResultStorage {
        fn two_hands() -> Self {
            let mut gesture_categories = vec![
                [category(b"Open_Palm\0", 0.91)],
                [category(b"Victory\0", 0.82)],
            ]
            .into_boxed_slice();
            let mut gesture_groups = gesture_categories
                .iter_mut()
                .map(|items| Categories {
                    categories: items.as_mut_ptr(),
                    categories_count: 1,
                })
                .collect::<Vec<_>>()
                .into_boxed_slice();

            let mut handedness_categories =
                vec![[category(b"Left\0", 0.97)], [category(b"Right\0", 0.96)]].into_boxed_slice();
            let mut handedness_groups = handedness_categories
                .iter_mut()
                .map(|items| Categories {
                    categories: items.as_mut_ptr(),
                    categories_count: 1,
                })
                .collect::<Vec<_>>()
                .into_boxed_slice();

            let point = NormalizedLandmark {
                x: 0.25,
                y: 0.5,
                z: -0.1,
                has_visibility: 0,
                visibility: 0.0,
                has_presence: 0,
                presence: 0.0,
                name: ptr::null_mut(),
            };
            let mut landmarks = vec![[point; HAND_LANDMARK_COUNT]; MAX_HANDS].into_boxed_slice();
            let mut landmark_groups = landmarks
                .iter_mut()
                .map(|items| ffi::NormalizedLandmarks {
                    landmarks: items.as_mut_ptr(),
                    landmarks_count: HAND_LANDMARK_COUNT as u32,
                })
                .collect::<Vec<_>>()
                .into_boxed_slice();

            let raw = GestureRecognizerResult {
                gestures: gesture_groups.as_mut_ptr(),
                gestures_count: MAX_HANDS as u32,
                handedness: handedness_groups.as_mut_ptr(),
                handedness_count: MAX_HANDS as u32,
                hand_landmarks: landmark_groups.as_mut_ptr(),
                hand_landmarks_count: MAX_HANDS as u32,
                hand_world_landmarks: ptr::null_mut(),
                hand_world_landmarks_count: 0,
            };
            Self {
                raw,
                _gesture_categories: gesture_categories,
                _gesture_groups: gesture_groups,
                _handedness_categories: handedness_categories,
                _handedness_groups: handedness_groups,
                _landmarks: landmarks,
                _landmark_groups: landmark_groups,
            }
        }
    }

    fn category(label: &'static [u8], score: f32) -> ffi::Category {
        ffi::Category {
            index: 0,
            score,
            category_name: label.as_ptr().cast_mut().cast(),
            display_name: ptr::null_mut(),
        }
    }

    fn secret_native_error() -> *mut c_char {
        CString::new("failed to mmap /private/alice/gesture_recognizer.task")
            .expect("static fake error has no NUL")
            .into_raw()
    }

    fn recognizer(state: &Rc<FakeState>) -> Result<GestureRecognizer, Error> {
        GestureRecognizer::create(
            Box::new(FakeBindings {
                state: Rc::clone(state),
            }),
            Path::new("/private/alice/gesture_recognizer.task"),
        )
    }

    fn frame(bytes: usize) -> FrameView {
        FrameView {
            sequence: 7,
            captured_at: Instant::now(),
            width: 2,
            height: 2,
            rgb: Arc::from(vec![0_u8; bytes]),
        }
    }

    #[test]
    fn converts_two_hands_and_closes_every_native_owner() {
        let state = Rc::new(FakeState::default());
        {
            let mut recognizer = recognizer(&state).expect("fake create should succeed");
            let input = frame(12);
            let observation = recognizer
                .recognize(&input, 100)
                .expect("fake recognition should succeed");
            assert_eq!(observation.frame_sequence, 7);
            assert!(observation.observed_at >= input.captured_at);
            assert_eq!(observation.hands.len(), 2);
            assert_eq!(observation.hands[0].gesture, "Open_Palm");
            assert_eq!(observation.hands[0].handedness, Handedness::Left);
            assert_eq!(observation.hands[1].gesture, "Victory");
            assert_eq!(observation.hands[1].handedness, Handedness::Right);
            assert_eq!(observation.hands[1].landmarks[20].z, -0.1);
            assert_eq!(state.result_closes.get(), 1);
            assert_eq!(state.image_frees.get(), 1);
        }
        assert_eq!(state.creates.get(), 1);
        assert_eq!(state.closes.get(), 1);
    }

    #[test]
    fn rejects_repeated_timestamp_before_allocating_another_image() {
        let state = Rc::new(FakeState::default());
        let mut recognizer = recognizer(&state).expect("fake create should succeed");
        recognizer
            .recognize(&frame(12), 100)
            .expect("first frame should succeed");
        assert!(matches!(
            recognizer.recognize(&frame(12), 100),
            Err(Error::InvalidTimestamp)
        ));
        assert_eq!(state.image_creates.get(), 1);
    }

    #[test]
    fn malformed_native_count_is_bounded_and_result_is_closed() {
        let state = Rc::new(FakeState::default());
        state.malformed_hand_count.set(Some(3));
        let mut recognizer = recognizer(&state).expect("fake create should succeed");
        assert!(matches!(
            recognizer.recognize(&frame(12), 100),
            Err(Error::MalformedResult("too many hands"))
        ));
        assert_eq!(state.result_closes.get(), 1);
        assert_eq!(state.image_frees.get(), 1);
    }

    #[test]
    fn invalid_rgb_length_never_crosses_native_boundary() {
        let state = Rc::new(FakeState::default());
        let mut recognizer = recognizer(&state).expect("fake create should succeed");
        assert!(matches!(
            recognizer.recognize(&frame(11), 100),
            Err(Error::InvalidFrame(_))
        ));
        assert_eq!(state.image_creates.get(), 0);
    }

    #[test]
    fn native_diagnostic_is_freed_without_exposing_its_text() {
        let state = Rc::new(FakeState::default());
        state.recognize_status.set(13);
        let mut recognizer = recognizer(&state).expect("fake create should succeed");
        let error = recognizer
            .recognize(&frame(12), 100)
            .expect_err("fake recognition should fail");
        let visible = error.to_string();
        assert!(!visible.contains("alice"));
        assert!(!visible.contains("gesture_recognizer.task"));
        assert_eq!(visible, "MediaPipe video recognition failed with status 13");
        assert_eq!(state.error_frees.get(), 1);
        assert_eq!(state.image_frees.get(), 1);
        assert_eq!(state.result_closes.get(), 0);
    }

    #[test]
    fn create_diagnostic_is_also_freed_and_redacted() {
        let state = Rc::new(FakeState::default());
        state.create_status.set(5);
        let error = match recognizer(&state) {
            Ok(_) => panic!("fake create should fail"),
            Err(error) => error,
        };
        assert_eq!(
            error.to_string(),
            "MediaPipe recognizer creation failed with status 5"
        );
        assert_eq!(state.error_frees.get(), 1);
        assert_eq!(state.closes.get(), 0);
    }
}
