//! Composition traits for platform adapters and application policies.

use crate::observation::{FrameView, Observation};

/// Turns a packed RGB frame into local hand observations.
///
/// Implementations may use tract, another native runtime, or a platform model
/// API. `timestamp_ms` is a strictly increasing stream-relative timestamp; it
/// is not wall-clock time and must not carry user data.
pub trait HandTracker {
    type Error;

    fn track(&mut self, frame: &FrameView, timestamp_ms: i64) -> Result<Observation, Self::Error>;
}

/// Maps local hand observations into an application-defined output.
///
/// A policy owns temporal evidence and gesture meaning. It must not perform
/// the resulting application side effect; the caller remains the authority
/// that accepts, rejects, or routes its output.
pub trait GesturePolicy {
    type Output;

    fn update(&mut self, frame: &FrameView, observation: &Observation) -> Self::Output;
}

/// One locally interpreted frame.
#[derive(Clone, Debug)]
pub struct PipelineOutput<T> {
    pub observation: Observation,
    pub policy: T,
}

/// Composes any hand tracker with any temporal or application gesture policy.
pub struct GesturePipeline<T, P> {
    tracker: T,
    policy: P,
}

impl<T, P> GesturePipeline<T, P> {
    #[must_use]
    pub const fn new(tracker: T, policy: P) -> Self {
        Self { tracker, policy }
    }

    #[must_use]
    pub const fn tracker(&self) -> &T {
        &self.tracker
    }

    pub fn tracker_mut(&mut self) -> &mut T {
        &mut self.tracker
    }

    #[must_use]
    pub const fn policy(&self) -> &P {
        &self.policy
    }

    pub fn policy_mut(&mut self) -> &mut P {
        &mut self.policy
    }

    #[must_use]
    pub fn into_parts(self) -> (T, P) {
        (self.tracker, self.policy)
    }
}

impl<T, P> GesturePipeline<T, P>
where
    T: HandTracker,
    P: GesturePolicy,
{
    pub fn process(
        &mut self,
        frame: &FrameView,
        timestamp_ms: i64,
    ) -> Result<PipelineOutput<P::Output>, T::Error> {
        let observation = self.tracker.track(frame, timestamp_ms)?;
        let policy = self.policy.update(frame, &observation);
        Ok(PipelineOutput {
            observation,
            policy,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::*;

    struct Tracker;

    impl HandTracker for Tracker {
        type Error = Infallible;

        fn track(
            &mut self,
            frame: &FrameView,
            _timestamp_ms: i64,
        ) -> Result<Observation, Self::Error> {
            Ok(Observation {
                frame_sequence: frame.sequence,
                observed_at: frame.captured_at,
                hands: Vec::new(),
                inference_time: Duration::ZERO,
            })
        }
    }

    struct SequencePolicy;

    impl GesturePolicy for SequencePolicy {
        type Output = u64;

        fn update(&mut self, _frame: &FrameView, observation: &Observation) -> Self::Output {
            observation.frame_sequence
        }
    }

    #[test]
    fn composes_custom_tracker_and_policy_without_platform_state() {
        let frame = FrameView {
            sequence: 7,
            captured_at: Instant::now(),
            width: 1,
            height: 1,
            rgb: Arc::from([0_u8, 0, 0]),
        };
        let output = GesturePipeline::new(Tracker, SequencePolicy)
            .process(&frame, 0)
            .expect("infallible tracker");
        assert_eq!(output.observation.frame_sequence, 7);
        assert_eq!(output.policy, 7);
    }
}
