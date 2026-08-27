//! Portable hand tracking and gesture interpretation.
//!
//! The crate deliberately stops at semantic events. Camera acquisition,
//! permissions, windows, IPC, application state, and side effects belong to
//! platform adapters. Applications can use the bundled voice-control policy or
//! provide their own [`GesturePolicy`] while retaining the same hand tracker.

pub mod control;
pub mod observation;
pub mod pipeline;
pub mod pose;
#[cfg(feature = "tract")]
pub mod vision;

pub use pipeline::{GesturePipeline, GesturePolicy, HandTracker, PipelineOutput};
