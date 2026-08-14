use std::ffi::{c_char, c_int, c_void};
use std::path::Path;

use libloading::os::unix::{Library as UnixLibrary, RTLD_LOCAL, RTLD_NOW};
use libloading::Library;

use super::ffi::{
    Bindings, GestureRecognizerOptions, GestureRecognizerResult, ImagePtr, RecognizerPtr,
};
use super::Error;

type RecognizerCreate = unsafe extern "C" fn(
    *const GestureRecognizerOptions,
    *mut RecognizerPtr,
    *mut *mut c_char,
) -> c_int;
type RecognizeForVideo = unsafe extern "C" fn(
    RecognizerPtr,
    ImagePtr,
    *const c_void,
    i64,
    *mut GestureRecognizerResult,
    *mut *mut c_char,
) -> c_int;
type RecognizerCloseResult = unsafe extern "C" fn(*mut GestureRecognizerResult);
type RecognizerClose = unsafe extern "C" fn(RecognizerPtr, *mut *mut c_char) -> c_int;
type ImageCreateFromU8 = unsafe extern "C" fn(
    c_int,
    c_int,
    c_int,
    *const u8,
    c_int,
    *mut ImagePtr,
    *mut *mut c_char,
) -> c_int;
type ImageFree = unsafe extern "C" fn(ImagePtr);
type ErrorFree = unsafe extern "C" fn(*mut c_char);

pub(super) struct DynamicBindings {
    recognizer_create: RecognizerCreate,
    recognize_for_video: RecognizeForVideo,
    recognizer_close_result: RecognizerCloseResult,
    recognizer_close: RecognizerClose,
    image_create_from_u8: ImageCreateFromU8,
    image_free: ImageFree,
    error_free: ErrorFree,
    // Function pointers must never outlive the loaded object.
    _library: Library,
}

impl DynamicBindings {
    pub(super) fn load(path: &Path) -> Result<Self, Error> {
        // SAFETY: loading a native library is inherently unsafe. The artifact
        // contract pins its build and the symbol types are ABI-verified. Any
        // loader diagnostic is discarded because it may contain a private path.
        let library: Library = unsafe { UnixLibrary::open(Some(path), RTLD_NOW | RTLD_LOCAL) }
            .map(Into::into)
            .map_err(|_| Error::LibraryUnavailable)?;

        // SAFETY: each type is the exact v1.0.0 C declaration. Values are copied
        // while `library` is alive and `_library` keeps them valid thereafter.
        let recognizer_create = unsafe {
            load_symbol(
                &library,
                b"MpGestureRecognizerCreate\0",
                "recognizer create",
            )?
        };
        let recognize_for_video = unsafe {
            load_symbol(
                &library,
                b"MpGestureRecognizerRecognizeForVideo\0",
                "video recognition",
            )?
        };
        let recognizer_close_result = unsafe {
            load_symbol(
                &library,
                b"MpGestureRecognizerCloseResult\0",
                "result close",
            )?
        };
        let recognizer_close =
            unsafe { load_symbol(&library, b"MpGestureRecognizerClose\0", "recognizer close")? };
        let image_create_from_u8 =
            unsafe { load_symbol(&library, b"MpImageCreateFromUint8Data\0", "image create")? };
        let image_free = unsafe { load_symbol(&library, b"MpImageFree\0", "image free")? };
        let error_free = unsafe { load_symbol(&library, b"MpErrorFree\0", "error free")? };

        Ok(Self {
            recognizer_create,
            recognize_for_video,
            recognizer_close_result,
            recognizer_close,
            image_create_from_u8,
            image_free,
            error_free,
            _library: library,
        })
    }
}

unsafe fn load_symbol<T: Copy>(
    library: &Library,
    symbol: &'static [u8],
    safe_name: &'static str,
) -> Result<T, Error> {
    // SAFETY: the caller supplies the exact C function type and the returned
    // value cannot outlive `library` in `DynamicBindings`.
    unsafe { library.get::<T>(symbol) }
        .map(|value| *value)
        .map_err(|_| Error::MissingSymbol(safe_name))
}

impl Bindings for DynamicBindings {
    unsafe fn recognizer_create(
        &self,
        options: *const GestureRecognizerOptions,
        recognizer: *mut RecognizerPtr,
        error: *mut *mut c_char,
    ) -> c_int {
        // SAFETY: upheld by the `Bindings` caller.
        unsafe { (self.recognizer_create)(options, recognizer, error) }
    }

    unsafe fn recognize_for_video(
        &self,
        recognizer: RecognizerPtr,
        image: ImagePtr,
        image_processing_options: *const c_void,
        timestamp_ms: i64,
        result: *mut GestureRecognizerResult,
        error: *mut *mut c_char,
    ) -> c_int {
        // SAFETY: upheld by the `Bindings` caller.
        unsafe {
            (self.recognize_for_video)(
                recognizer,
                image,
                image_processing_options,
                timestamp_ms,
                result,
                error,
            )
        }
    }

    unsafe fn recognizer_close_result(&self, result: *mut GestureRecognizerResult) {
        // SAFETY: upheld by the `Bindings` caller.
        unsafe { (self.recognizer_close_result)(result) }
    }

    unsafe fn recognizer_close(&self, recognizer: RecognizerPtr, error: *mut *mut c_char) -> c_int {
        // SAFETY: upheld by the `Bindings` caller.
        unsafe { (self.recognizer_close)(recognizer, error) }
    }

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
    ) -> c_int {
        // SAFETY: upheld by the `Bindings` caller.
        unsafe {
            (self.image_create_from_u8)(format, width, height, pixels, pixels_len, image, error)
        }
    }

    unsafe fn image_free(&self, image: ImagePtr) {
        // SAFETY: upheld by the `Bindings` caller.
        unsafe { (self.image_free)(image) }
    }

    unsafe fn error_free(&self, error: *mut c_char) {
        // SAFETY: upheld by the `Bindings` caller.
        unsafe { (self.error_free)(error) }
    }
}
