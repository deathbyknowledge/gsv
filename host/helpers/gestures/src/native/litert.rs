use std::ffi::c_void;
use std::ptr::NonNull;

use super::Error;

unsafe extern "C" {
    fn gsv_litert_create(
        model: *const u8,
        model_size: usize,
        input_size: usize,
        output_sizes: *const usize,
        output_count: usize,
        threads: i32,
        profile: bool,
    ) -> *mut c_void;
    fn gsv_litert_destroy(model: *mut c_void);
    fn gsv_litert_run(
        model: *mut c_void,
        input: *const f32,
        input_size: usize,
        output: *mut f32,
        output_size: usize,
    ) -> bool;
    #[cfg(test)]
    fn gsv_litert_profile(
        model: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, *const std::ffi::c_char, i64, u64),
        context: *mut c_void,
    ) -> bool;
}

pub(super) struct Model {
    handle: NonNull<c_void>,
    outputs: Vec<f32>,
}

// LiteRT permits moving an interpreter between threads. Every operation needs
// &mut self, and Models places each interpreter behind its own mutex. Native
// code owns its model bytes and retains no references to Rust input/output data.
unsafe impl Send for Model {}

impl Model {
    pub(super) fn load(
        bytes: &[u8],
        input_size: usize,
        output_sizes: &[usize],
        threads: usize,
        profile: bool,
    ) -> Result<Self, Error> {
        let threads = i32::try_from(threads).map_err(|_| Error::InvalidModel)?;
        // The bridge copies bytes and output_sizes before returning. It verifies
        // the flatbuffer, FP32 tensor sizes and complete XNNPACK delegation.
        let handle = unsafe {
            gsv_litert_create(
                bytes.as_ptr(),
                bytes.len(),
                input_size,
                output_sizes.as_ptr(),
                output_sizes.len(),
                threads,
                profile,
            )
        };
        Ok(Self {
            handle: NonNull::new(handle).ok_or(Error::InvalidModel)?,
            outputs: vec![0.0; output_sizes.iter().sum()],
        })
    }

    pub(super) fn run(&mut self, input: &[f32]) -> Result<&[f32], Error> {
        // Both slices stay alive for this synchronous call. The bridge checks
        // their lengths against the validated tensors before reading or writing.
        let success = unsafe {
            gsv_litert_run(
                self.handle.as_ptr(),
                input.as_ptr(),
                input.len(),
                self.outputs.as_mut_ptr(),
                self.outputs.len(),
            )
        };
        if !success {
            return Err(Error::Inference);
        }
        Ok(&self.outputs)
    }

    #[cfg(test)]
    pub(super) fn profile_events(&mut self) -> Result<Vec<ProfileEvent>, Error> {
        let mut events = Vec::new();
        // The callback copies each model-owned operator name synchronously. Its
        // context remains a valid Vec until all callbacks have returned.
        let success = unsafe {
            gsv_litert_profile(
                self.handle.as_ptr(),
                collect_profile_event,
                (&mut events as *mut Vec<ProfileEvent>).cast(),
            )
        };
        if !success || events.is_empty() {
            return Err(Error::Inference);
        }
        Ok(events)
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        // This is the sole owner; no outstanding inference can borrow it here.
        unsafe { gsv_litert_destroy(self.handle.as_ptr()) };
    }
}

#[cfg(test)]
pub(super) struct ProfileEvent {
    pub(super) operation: String,
    pub(super) node: i64,
    pub(super) duration: std::time::Duration,
}

#[cfg(test)]
unsafe extern "C" fn collect_profile_event(
    context: *mut c_void,
    operation: *const std::ffi::c_char,
    node: i64,
    microseconds: u64,
) {
    // Only gsv_litert_profile calls this with our Vec context and a live,
    // null-terminated operator name. No callback or pointer escapes that call.
    let events = unsafe { &mut *context.cast::<Vec<ProfileEvent>>() };
    let operation = unsafe { std::ffi::CStr::from_ptr(operation) }
        .to_string_lossy()
        .into_owned();
    events.push(ProfileEvent {
        operation,
        node,
        duration: std::time::Duration::from_micros(microseconds),
    });
}
