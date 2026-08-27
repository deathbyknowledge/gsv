//! Android JNI ownership boundary for local gesture inference.
//!
//! CameraX owns frame acquisition and application code owns authority. This
//! adapter converts one direct RGBA frame into the portable engine's packed
//! RGB contract and returns only bounded semantic control state.

#[cfg(target_os = "android")]
mod jni_adapter;

#[cfg(any(target_os = "android", test))]
mod rgba;

#[cfg(any(target_os = "android", test))]
mod semantic;
