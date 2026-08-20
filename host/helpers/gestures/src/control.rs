//! Pure temporal policy for two-hand voice controls.
//!
//! This module consumes only bounded authored-pose and handedness observations. It
//! owns no camera, window, IPC, or application action. Missing tracking clears
//! temporal evidence but never changes Desktop-owned transcription authority.

use std::time::{Duration, Instant};

use gesture_protocol::VoiceRequestGestureIntent;
pub use gesture_protocol::{
    GestureContext as ControlState, GestureIntent as ControlIntent, ScrollDirection, ScrollState,
};

use crate::observation::{HandObservation, HandPose, Handedness};

const START_ENTER_SCORE: f32 = 0.50;
const ACTION_ENTER_SCORE: f32 = 0.50;
const CONTINUE_SCORE: f32 = 0.50;
const MIN_SUPPORT_PERCENT: u16 = 80;
const MIN_STRONG_SAMPLES: u16 = 3;
const START_DWELL: Duration = Duration::from_millis(350);
const STOP_DWELL: Duration = Duration::from_millis(350);
const SEND_DWELL: Duration = Duration::from_millis(700);
const MUTE_DWELL: Duration = Duration::from_millis(450);
const UNMUTE_DWELL: Duration = Duration::from_millis(700);
const MAX_FRAME_AGE: Duration = Duration::from_millis(250);
const MAX_SAMPLE_GAP: Duration = Duration::from_millis(250);
const MAX_EVIDENCE_GAP: Duration = Duration::from_millis(180);
const MIN_INTENT_SPACING: Duration = Duration::from_millis(750);
const SCROLL_DWELL: Duration = Duration::from_millis(250);
const SCROLL_MIN_MATCHES: u16 = 4;
const SCROLL_TRACKING_GRACE: Duration = Duration::from_millis(180);
const MIN_HANDEDNESS_SCORE: f32 = 0.72;
const MIN_POSE_SCORE: f32 = 0.50;
const SCROLL_VERTICAL_OFFSET: f32 = 0.10;

/// Fixed local-only vocabulary for explaining the temporal controller in the
/// diagnostic window. Its observation-derived counts, percentages, and
/// timings are bounded and quantized; labels, landmarks, and request IDs are
/// omitted, and the value never crosses GSV IPC or logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlChord {
    StartTranscription,
    StopTranscription,
    Send,
    Mute,
    Unmute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlProgress {
    pub chord: ControlChord,
    pub progress_permille: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlDiagnostic {
    AwaitingPose,
    NeedTwoHands {
        detected: u8,
    },
    UnsupportedPose,
    UnexpectedPose {
        chord: ControlChord,
    },
    AlreadySatisfied {
        chord: ControlChord,
    },
    AwaitingAuthority {
        chord: ControlChord,
    },
    AwaitingRelease {
        chord: ControlChord,
    },
    InvalidScore,
    InvalidOrder,
    FrameTooOld {
        age_ms: u16,
    },
    SampleGap {
        gap_ms: u16,
    },
    EvidenceGap {
        gap_ms: u16,
    },
    LowConfidence {
        chord: ControlChord,
        observed_percent: u8,
        required_percent: u8,
    },
    Stabilizing {
        chord: ControlChord,
        confidence_percent: u8,
        progress_percent: u8,
    },
    Cooldown {
        remaining_ms: u16,
    },
    Accepted {
        chord: ControlChord,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HandPreference {
    #[default]
    Auto,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug)]
pub struct ControlHand {
    pub handedness: Handedness,
    pub handedness_score: f32,
    pub pose: HandPose,
    pub score: f32,
    pub palm_x: f32,
    pub palm_y: f32,
    pub index_tip_x: f32,
    pub index_tip_y: f32,
}

impl ControlHand {
    #[must_use]
    pub fn from_observation(hand: &HandObservation) -> Self {
        const PALM: [usize; 5] = [0, 5, 9, 13, 17];
        let (palm_x, palm_y) = PALM.iter().fold((0.0, 0.0), |(x, y), index| {
            (x + hand.landmarks[*index].x, y + hand.landmarks[*index].y)
        });
        Self {
            handedness: hand.handedness,
            handedness_score: hand.handedness_score,
            pose: hand.pose,
            score: hand.pose_score,
            palm_x: palm_x / PALM.len() as f32,
            palm_y: palm_y / PALM.len() as f32,
            index_tip_x: hand.landmarks[8].x,
            index_tip_y: hand.landmarks[8].y,
        }
    }

    #[cfg(test)]
    pub(crate) const fn test(
        handedness: Handedness,
        pose: HandPose,
        score: f32,
        x: f32,
        y: f32,
    ) -> Self {
        Self {
            handedness,
            handedness_score: 0.95,
            pose,
            score,
            palm_x: x,
            palm_y: y,
            index_tip_x: x,
            index_tip_y: y,
        }
    }

    #[cfg(test)]
    const fn test_point(
        handedness: Handedness,
        score: f32,
        palm_x: f32,
        palm_y: f32,
        index_tip_x: f32,
        index_tip_y: f32,
    ) -> Self {
        Self {
            handedness,
            handedness_score: 0.95,
            pose: HandPose::Point,
            score,
            palm_x,
            palm_y,
            index_tip_x,
            index_tip_y,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ControlSample<'a> {
    pub frame_sequence: u64,
    pub captured_at: Instant,
    pub observed_at: Instant,
    pub hands: &'a [ControlHand],
}

/// Independent held-scroll recognizer.
///
/// Scroll state is absolute and low-risk: tracking loss stops motion, while a
/// positively observed different pose is required before the same direction
/// can become a new gesture instance. This prevents a reacquired held pose
/// from crossing a document boundary as though the user had released it.
pub struct ScrollControl {
    state: ScrollState,
    candidate: Option<ScrollCandidate>,
    release_latch: Option<ScrollDirection>,
    last_match_at: Option<Instant>,
    last_frame_sequence: Option<u64>,
    last_captured_at: Option<Instant>,
    next_instance_id: u64,
    preference: HandPreference,
    roles: Option<RoleAssignment>,
}

impl Default for ScrollControl {
    fn default() -> Self {
        Self::new()
    }
}

impl ScrollControl {
    #[must_use]
    pub const fn new() -> Self {
        Self::with_preference(HandPreference::Auto)
    }

    #[must_use]
    pub const fn with_preference(preference: HandPreference) -> Self {
        Self {
            state: ScrollState::Idle,
            candidate: None,
            release_latch: None,
            last_match_at: None,
            last_frame_sequence: None,
            last_captured_at: None,
            next_instance_id: 1,
            preference,
            roles: None,
        }
    }

    #[must_use]
    pub const fn state(&self) -> ScrollState {
        self.state
    }

    /// Returns only state transitions; the inference owner supplies bounded
    /// held-state heartbeats without changing the gesture instance.
    pub fn observe(&mut self, sample: ControlSample<'_>) -> Option<ScrollState> {
        if sample.frame_sequence == 0
            || self
                .last_frame_sequence
                .is_some_and(|previous| sample.frame_sequence <= previous)
            || self
                .last_captured_at
                .is_some_and(|previous| sample.captured_at <= previous)
        {
            return self.stop();
        }

        let gap = self
            .last_captured_at
            .and_then(|previous| sample.captured_at.checked_duration_since(previous));
        self.last_frame_sequence = Some(sample.frame_sequence);
        self.last_captured_at = Some(sample.captured_at);
        let Some(age) = sample
            .observed_at
            .checked_duration_since(sample.captured_at)
        else {
            return self.stop();
        };
        if age > MAX_FRAME_AGE || gap.is_some_and(|gap| gap > MAX_SAMPLE_GAP) {
            return self.stop();
        }

        let now = sample.captured_at;
        let reading = classify_scroll(sample.hands, self.preference, &mut self.roles);
        if self
            .release_latch
            .is_some_and(|latched| reading.positively_releases(latched))
        {
            self.release_latch = None;
        }

        if let ScrollState::Held { direction, .. } = self.state {
            match reading {
                ScrollReading::Gesture {
                    direction: observed,
                    quality,
                } if observed == direction && quality >= ACTION_ENTER_SCORE => {
                    self.last_match_at = Some(now);
                    return None;
                }
                ScrollReading::KnownOther => return self.stop_and_seed(now, reading),
                ScrollReading::Gesture {
                    direction: observed,
                    quality,
                } if observed != direction && quality >= ACTION_ENTER_SCORE => {
                    return self.stop_and_seed(now, reading);
                }
                ScrollReading::Unknown | ScrollReading::Gesture { .. } => {
                    if self.last_match_at.is_some_and(|last_match| {
                        now.saturating_duration_since(last_match) <= SCROLL_TRACKING_GRACE
                    }) {
                        return None;
                    }
                    return self.stop();
                }
            }
        }

        self.advance_scroll_candidate(now, reading)
    }

    fn stop_and_seed(&mut self, now: Instant, reading: ScrollReading) -> Option<ScrollState> {
        let transition = self.stop();
        if let ScrollReading::Gesture { direction, quality } = reading {
            if quality >= ACTION_ENTER_SCORE && self.release_latch != Some(direction) {
                self.candidate = Some(ScrollCandidate::new(direction, now));
            }
        }
        transition
    }

    fn advance_scroll_candidate(
        &mut self,
        now: Instant,
        reading: ScrollReading,
    ) -> Option<ScrollState> {
        let ScrollReading::Gesture { direction, quality } = reading else {
            self.candidate = None;
            return None;
        };
        if quality < ACTION_ENTER_SCORE || self.release_latch == Some(direction) {
            self.candidate = None;
            return None;
        }

        match self.candidate.as_mut() {
            Some(candidate)
                if candidate.direction == direction
                    && now.saturating_duration_since(candidate.last_match_at)
                        <= MAX_EVIDENCE_GAP =>
            {
                candidate.record_match(now);
            }
            Some(candidate) => *candidate = ScrollCandidate::new(direction, now),
            None => self.candidate = Some(ScrollCandidate::new(direction, now)),
        }
        if !self
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.is_stable(now))
        {
            return None;
        }

        self.candidate = None;
        let instance_id = self.next_instance_id;
        self.next_instance_id = self.next_instance_id.wrapping_add(1).max(1);
        self.state = ScrollState::Held {
            instance_id,
            direction,
        };
        self.release_latch = Some(direction);
        self.last_match_at = Some(now);
        Some(self.state)
    }

    fn stop(&mut self) -> Option<ScrollState> {
        self.candidate = None;
        self.last_match_at = None;
        if self.state == ScrollState::Idle {
            return None;
        }
        self.state = ScrollState::Idle;
        Some(ScrollState::Idle)
    }
}

/// Deterministic, allocation-free recognition of the supported two-hand
/// control vocabulary.
pub struct GestureControl {
    state: ControlState,
    pending: Option<ControlIntent>,
    release_latch: Option<ActionPose>,
    diagnostic: ControlDiagnostic,
    candidate: Option<Candidate>,
    last_frame_sequence: Option<u64>,
    last_captured_at: Option<Instant>,
    last_intent_at: Option<Instant>,
    preference: HandPreference,
    roles: Option<RoleAssignment>,
}

impl Default for GestureControl {
    fn default() -> Self {
        Self::new(ControlState::Disabled)
    }
}

impl GestureControl {
    /// Creates a controller synchronized with Desktop's absolute state echo.
    #[must_use]
    pub const fn new(state: ControlState) -> Self {
        Self::with_preference(state, HandPreference::Auto)
    }

    #[must_use]
    pub const fn with_preference(state: ControlState, preference: HandPreference) -> Self {
        Self {
            state,
            pending: None,
            release_latch: None,
            diagnostic: ControlDiagnostic::AwaitingPose,
            candidate: None,
            last_frame_sequence: None,
            last_captured_at: None,
            last_intent_at: None,
            preference,
            roles: None,
        }
    }

    #[must_use]
    pub const fn state(&self) -> ControlState {
        self.state
    }

    #[must_use]
    pub const fn diagnostic(&self) -> ControlDiagnostic {
        self.diagnostic
    }

    /// Returns the complete aggregate evidence for the current candidate.
    /// Pending evidence is capped below completion; the authoritative state
    /// transition or intent is the only completion edge.
    #[must_use]
    pub fn progress(&self, now: Instant) -> Option<ControlProgress> {
        let candidate = self.candidate.as_ref()?;
        if now.saturating_duration_since(candidate.last_match_at) > MAX_EVIDENCE_GAP {
            return None;
        }
        Some(ControlProgress {
            chord: candidate.chord.into(),
            progress_permille: candidate.progress_permille(now).min(999),
        })
    }

    /// Commits or rejects one pending request using Desktop's absolute echo.
    /// Any context revision fences evidence accumulated under the old state.
    pub fn synchronize_state(&mut self, state: ControlState) {
        self.state = state;
        self.pending = None;
        self.candidate = None;
        self.diagnostic = ControlDiagnostic::AwaitingPose;
    }

    /// Consumes one inference result and returns at most one semantic edge.
    ///
    /// Samples must be fresh and strictly ordered. Exactly two hands with
    /// stable, opposite anatomical handedness are required; array order is
    /// irrelevant.
    pub fn observe(&mut self, sample: ControlSample<'_>) -> Option<ControlIntent> {
        if !self.accept_order(&sample) {
            self.diagnostic = ControlDiagnostic::InvalidOrder;
            self.fence_tracking();
            return None;
        }

        let gap = self
            .last_captured_at
            .and_then(|previous| sample.captured_at.checked_duration_since(previous));
        self.last_frame_sequence = Some(sample.frame_sequence);
        self.last_captured_at = Some(sample.captured_at);

        let Some(age) = sample
            .observed_at
            .checked_duration_since(sample.captured_at)
        else {
            self.diagnostic = ControlDiagnostic::InvalidOrder;
            self.fence_tracking();
            return None;
        };
        if age > MAX_FRAME_AGE {
            self.diagnostic = ControlDiagnostic::FrameTooOld {
                age_ms: bounded_millis(age),
            };
            self.fence_tracking();
            return None;
        }
        if let Some(gap) = gap.filter(|gap| *gap > MAX_SAMPLE_GAP) {
            self.diagnostic = ControlDiagnostic::SampleGap {
                gap_ms: bounded_millis(gap),
            };
            self.fence_tracking();
            return None;
        }

        let now = sample.captured_at;
        let physical = match classify_pair(sample.hands, self.preference, &mut self.roles) {
            Ok(reading) => Some(reading),
            Err(failure) => {
                self.diagnostic = failure.diagnostic();
                None
            }
        };

        if self
            .release_latch
            .is_some_and(|latched| physical.is_some_and(|reading| reading.releases(latched)))
        {
            self.release_latch = None;
        }

        let reading = physical.and_then(|reading| reading.chord(self.state));

        if let Some(intent) = self.pending {
            self.candidate = None;
            self.diagnostic = ControlDiagnostic::AwaitingAuthority {
                chord: intent.into(),
            };
            return None;
        }

        if let (Some(latched), Some(reading)) = (self.release_latch, reading) {
            if reading.action == latched {
                self.candidate = None;
                self.diagnostic = ControlDiagnostic::AwaitingRelease {
                    chord: reading.chord.into(),
                };
                return None;
            }
        }

        self.advance_candidate(now, reading)
    }

    fn accept_order(&self, sample: &ControlSample<'_>) -> bool {
        if sample.frame_sequence == 0
            || self
                .last_frame_sequence
                .is_some_and(|previous| sample.frame_sequence <= previous)
            || self
                .last_captured_at
                .is_some_and(|previous| sample.captured_at <= previous)
        {
            return false;
        }
        true
    }

    fn advance_candidate(
        &mut self,
        now: Instant,
        reading: Option<ChordReading>,
    ) -> Option<ControlIntent> {
        let target = reading.and_then(|reading| {
            self.accepted_target(reading.chord).then_some((
                reading.chord,
                reading.action,
                reading.quality,
                self.entry_score(reading.chord),
            ))
        });
        if let Some(reading) = reading.filter(|reading| !self.accepted_target(reading.chord)) {
            self.diagnostic = if self.target_is_satisfied(reading.chord) {
                ControlDiagnostic::AlreadySatisfied {
                    chord: reading.chord.into(),
                }
            } else {
                ControlDiagnostic::UnexpectedPose {
                    chord: reading.chord.into(),
                }
            };
        }

        let mut evidence_gap = None;
        let mut discard_candidate = false;

        match (self.candidate.as_mut(), target) {
            (Some(candidate), Some((chord, action, quality, entry_score)))
                if candidate.chord == chord && candidate.action == action =>
            {
                let gap = now.saturating_duration_since(candidate.last_match_at);
                if gap > MAX_EVIDENCE_GAP {
                    evidence_gap = Some(gap);
                    if quality >= entry_score {
                        *candidate = Candidate::new(chord, action, now);
                    } else {
                        candidate.record_miss();
                    }
                } else if quality >= entry_score.min(CONTINUE_SCORE) {
                    candidate.record_match(now, quality >= entry_score);
                } else {
                    candidate.record_miss();
                }
            }
            (Some(candidate), Some((chord, action, quality, entry_score)))
                if quality >= entry_score =>
            {
                *candidate = Candidate::new(chord, action, now);
            }
            (Some(_), _) => discard_candidate = true,
            (None, Some((chord, action, quality, entry_score))) if quality >= entry_score => {
                self.candidate = Some(Candidate::new(chord, action, now));
            }
            (None, _) => {}
        }

        if discard_candidate {
            self.candidate = None;
        }

        if self.candidate.as_ref().is_some_and(|candidate| {
            now.saturating_duration_since(candidate.last_match_at) > MAX_EVIDENCE_GAP
        }) {
            if let Some(gap) = evidence_gap {
                self.diagnostic = ControlDiagnostic::EvidenceGap {
                    gap_ms: bounded_millis(gap),
                };
            }
            self.candidate = None;
            return None;
        }

        if let Some((chord, _, quality, entry_score)) = target {
            self.diagnostic = if let Some(gap) = evidence_gap {
                ControlDiagnostic::EvidenceGap {
                    gap_ms: bounded_millis(gap),
                }
            } else if quality < entry_score {
                ControlDiagnostic::LowConfidence {
                    chord: chord.into(),
                    observed_percent: score_percent(quality),
                    required_percent: score_percent(entry_score),
                }
            } else {
                ControlDiagnostic::Stabilizing {
                    chord: chord.into(),
                    confidence_percent: score_percent(quality),
                    progress_percent: self.progress(now).map_or(0, |progress| {
                        u8::try_from(progress.progress_permille / 10).unwrap_or(100)
                    }),
                }
            };
        }

        let stable = self.candidate.as_ref().is_some_and(|candidate| {
            let current_is_strong = target.is_some_and(|(chord, action, quality, entry_score)| {
                chord == candidate.chord && action == candidate.action && quality >= entry_score
            });
            current_is_strong && candidate.is_stable(now)
        });
        if !stable {
            return None;
        }

        let (chord, action) = self
            .candidate
            .as_ref()
            .map(|candidate| (candidate.chord, candidate.action))?;
        if !self.cooldown_complete(now) {
            let remaining = self.last_intent_at.map_or(Duration::ZERO, |previous| {
                MIN_INTENT_SPACING.saturating_sub(now.saturating_duration_since(previous))
            });
            self.diagnostic = ControlDiagnostic::Cooldown {
                remaining_ms: bounded_millis(remaining),
            };
            return None;
        }
        self.candidate = None;
        self.diagnostic = ControlDiagnostic::Accepted {
            chord: chord.into(),
        };
        let intent = control_intent(self.state, chord)?;
        self.pending = Some(intent);
        self.release_latch = Some(action);
        self.last_intent_at = Some(now);
        Some(intent)
    }

    fn accepted_target(&self, chord: Chord) -> bool {
        matches!(
            (self.state, chord),
            (ControlState::Standby, Chord::StartTranscription)
                | (
                    ControlState::Active { .. },
                    Chord::StopTranscription | Chord::Send,
                )
                | (ControlState::Active { muted: false, .. }, Chord::Mute)
                | (ControlState::Active { muted: true, .. }, Chord::Unmute)
        )
    }

    fn target_is_satisfied(&self, chord: Chord) -> bool {
        matches!(
            (self.state, chord),
            (ControlState::Active { .. }, Chord::StartTranscription)
                | (ControlState::Standby, Chord::StopTranscription)
                | (ControlState::Active { muted: true, .. }, Chord::Mute)
                | (ControlState::Active { muted: false, .. }, Chord::Unmute)
        )
    }

    const fn entry_score(&self, chord: Chord) -> f32 {
        if matches!(chord, Chord::StartTranscription) {
            START_ENTER_SCORE
        } else {
            ACTION_ENTER_SCORE
        }
    }

    fn cooldown_complete(&self, now: Instant) -> bool {
        self.last_intent_at
            .is_none_or(|previous| now.saturating_duration_since(previous) >= MIN_INTENT_SPACING)
    }

    fn fence_tracking(&mut self) {
        self.candidate = None;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Chord {
    StartTranscription,
    StopTranscription,
    Send,
    Mute,
    Unmute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActionPose {
    PrimaryPinch,
    SendPinch,
    MuteFist,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RoleAssignment {
    modifier: Handedness,
    action: Handedness,
}

#[derive(Clone, Copy)]
struct RoleHands<'a> {
    modifier: &'a ControlHand,
    action: &'a ControlHand,
}

impl From<Chord> for ControlChord {
    fn from(chord: Chord) -> Self {
        match chord {
            Chord::StartTranscription => Self::StartTranscription,
            Chord::StopTranscription => Self::StopTranscription,
            Chord::Send => Self::Send,
            Chord::Mute => Self::Mute,
            Chord::Unmute => Self::Unmute,
        }
    }
}

impl From<ControlIntent> for ControlChord {
    fn from(intent: ControlIntent) -> Self {
        match intent {
            ControlIntent::StartTranscription => Self::StartTranscription,
            ControlIntent::VoiceRequest { action, .. } => match action {
                VoiceRequestGestureIntent::StopTranscription => Self::StopTranscription,
                VoiceRequestGestureIntent::Send => Self::Send,
                VoiceRequestGestureIntent::Mute => Self::Mute,
                VoiceRequestGestureIntent::Unmute => Self::Unmute,
            },
        }
    }
}

fn control_intent(state: ControlState, chord: Chord) -> Option<ControlIntent> {
    match (state, chord) {
        (ControlState::Standby, Chord::StartTranscription) => {
            Some(ControlIntent::StartTranscription)
        }
        (
            ControlState::Active {
                voice_request_id, ..
            },
            chord,
        ) => {
            let action = match chord {
                Chord::StopTranscription => VoiceRequestGestureIntent::StopTranscription,
                Chord::Send => VoiceRequestGestureIntent::Send,
                Chord::Mute => VoiceRequestGestureIntent::Mute,
                Chord::Unmute => VoiceRequestGestureIntent::Unmute,
                Chord::StartTranscription => return None,
            };
            Some(ControlIntent::VoiceRequest {
                voice_request_id,
                action,
            })
        }
        _ => None,
    }
}

impl Chord {
    const fn dwell(self) -> Duration {
        match self {
            Self::StartTranscription => START_DWELL,
            Self::StopTranscription => STOP_DWELL,
            Self::Send => SEND_DWELL,
            Self::Mute => MUTE_DWELL,
            Self::Unmute => UNMUTE_DWELL,
        }
    }

    const fn minimum_matches(self) -> u16 {
        match self {
            Self::StartTranscription | Self::StopTranscription => 4,
            Self::Mute => 5,
            Self::Send | Self::Unmute => 7,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ChordReading {
    chord: Chord,
    action: ActionPose,
    quality: f32,
}

#[derive(Clone, Copy, Debug)]
enum PairReading {
    Action { action: ActionPose, quality: f32 },
    KnownOther { quality: f32 },
}

impl PairReading {
    fn chord(self, state: ControlState) -> Option<ChordReading> {
        let Self::Action { action, quality } = self else {
            return None;
        };
        let chord = match (state, action) {
            (ControlState::Standby, ActionPose::PrimaryPinch) => Chord::StartTranscription,
            (ControlState::Active { .. }, ActionPose::PrimaryPinch) => Chord::StopTranscription,
            (ControlState::Active { .. }, ActionPose::SendPinch) => Chord::Send,
            (ControlState::Active { muted: false, .. }, ActionPose::MuteFist) => Chord::Mute,
            (ControlState::Active { muted: true, .. }, ActionPose::MuteFist) => Chord::Unmute,
            (ControlState::Disabled, _)
            | (ControlState::Standby, ActionPose::SendPinch | ActionPose::MuteFist) => return None,
        };
        Some(ChordReading {
            chord,
            action,
            quality,
        })
    }

    fn releases(self, latched: ActionPose) -> bool {
        match self {
            Self::KnownOther { quality } => quality >= CONTINUE_SCORE,
            Self::Action { action, quality } => action != latched && quality >= CONTINUE_SCORE,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ScrollReading {
    Gesture {
        direction: ScrollDirection,
        quality: f32,
    },
    KnownOther,
    Unknown,
}

impl ScrollReading {
    fn positively_releases(self, latched: ScrollDirection) -> bool {
        match self {
            Self::KnownOther => true,
            Self::Gesture { direction, quality } => {
                direction != latched && quality >= ACTION_ENTER_SCORE
            }
            Self::Unknown => false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ScrollCandidate {
    direction: ScrollDirection,
    started_at: Instant,
    last_match_at: Instant,
    matches: u16,
}

impl ScrollCandidate {
    fn new(direction: ScrollDirection, now: Instant) -> Self {
        Self {
            direction,
            started_at: now,
            last_match_at: now,
            matches: 1,
        }
    }

    fn record_match(&mut self, now: Instant) {
        self.last_match_at = now;
        self.matches = self.matches.saturating_add(1);
    }

    fn is_stable(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started_at) >= SCROLL_DWELL
            && self.matches >= SCROLL_MIN_MATCHES
    }
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    chord: Chord,
    action: ActionPose,
    started_at: Instant,
    last_match_at: Instant,
    samples: u16,
    matches: u16,
    strong_matches: u16,
    consecutive_matches: u16,
}

impl Candidate {
    fn new(chord: Chord, action: ActionPose, now: Instant) -> Self {
        Self {
            chord,
            action,
            started_at: now,
            last_match_at: now,
            samples: 1,
            matches: 1,
            strong_matches: 1,
            consecutive_matches: 1,
        }
    }

    fn record_match(&mut self, now: Instant, strong: bool) {
        self.samples = self.samples.saturating_add(1);
        self.matches = self.matches.saturating_add(1);
        self.strong_matches = self.strong_matches.saturating_add(u16::from(strong));
        self.consecutive_matches = self.consecutive_matches.saturating_add(1);
        self.last_match_at = now;
    }

    fn record_miss(&mut self) {
        self.samples = self.samples.saturating_add(1);
        self.consecutive_matches = 0;
    }

    fn is_stable(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started_at) >= self.chord.dwell()
            && self.matches >= self.chord.minimum_matches()
            && self.strong_matches >= MIN_STRONG_SAMPLES
            && self.consecutive_matches >= 2
            && u32::from(self.matches) * 100
                >= u32::from(self.samples) * u32::from(MIN_SUPPORT_PERCENT)
    }

    fn progress_permille(&self, now: Instant) -> u16 {
        let dwell = duration_progress_permille(
            now.saturating_duration_since(self.started_at),
            self.chord.dwell(),
        );
        let matches = count_progress_permille(self.matches, self.chord.minimum_matches());
        let strong = count_progress_permille(self.strong_matches, MIN_STRONG_SAMPLES);
        let consecutive = count_progress_permille(self.consecutive_matches, 2);
        let required_support = u32::from(self.samples)
            .saturating_mul(u32::from(MIN_SUPPORT_PERCENT))
            .div_ceil(100);
        let support = count_progress_permille(
            self.matches,
            u16::try_from(required_support).unwrap_or(u16::MAX),
        );
        dwell.min(matches).min(strong).min(consecutive).min(support)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClassificationFailure {
    HandCount(usize),
    InvalidScore,
    UnsupportedPose,
    AmbiguousHandedness,
}

impl ClassificationFailure {
    fn diagnostic(self) -> ControlDiagnostic {
        match self {
            Self::HandCount(detected) => ControlDiagnostic::NeedTwoHands {
                detected: u8::try_from(detected).unwrap_or(u8::MAX),
            },
            Self::InvalidScore => ControlDiagnostic::InvalidScore,
            Self::UnsupportedPose => ControlDiagnostic::UnsupportedPose,
            Self::AmbiguousHandedness => ControlDiagnostic::UnsupportedPose,
        }
    }
}

fn classify_pair(
    hands: &[ControlHand],
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> Result<PairReading, ClassificationFailure> {
    let pair = resolve_roles(hands, preference, roles)?;
    if pair.modifier.pose == HandPose::Unknown || pair.action.pose == HandPose::Unknown {
        return Err(ClassificationFailure::UnsupportedPose);
    }
    let quality = pair
        .modifier
        .score
        .min(pair.action.score)
        .min(pair.modifier.handedness_score)
        .min(pair.action.handedness_score);
    if pair.modifier.pose != HandPose::Anchor || quality < MIN_POSE_SCORE {
        return Ok(PairReading::KnownOther { quality });
    }
    let action = match pair.action.pose {
        HandPose::IndexPinch => ActionPose::PrimaryPinch,
        HandPose::MiddlePinch => ActionPose::SendPinch,
        HandPose::SoftFist => ActionPose::MuteFist,
        HandPose::Anchor | HandPose::Point | HandPose::GatheredPinch => {
            return Ok(PairReading::KnownOther { quality });
        }
        HandPose::Unknown => return Err(ClassificationFailure::UnsupportedPose),
    };
    Ok(PairReading::Action { action, quality })
}

fn classify_scroll(
    hands: &[ControlHand],
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> ScrollReading {
    let Ok(pair) = resolve_roles(hands, preference, roles) else {
        return ScrollReading::Unknown;
    };
    if pair.modifier.pose == HandPose::Unknown || pair.action.pose == HandPose::Unknown {
        return ScrollReading::Unknown;
    }
    let quality = pair
        .modifier
        .score
        .min(pair.action.score)
        .min(pair.modifier.handedness_score)
        .min(pair.action.handedness_score);
    if pair.modifier.pose != HandPose::Anchor || pair.action.pose != HandPose::Point {
        return if quality >= ACTION_ENTER_SCORE {
            ScrollReading::KnownOther
        } else {
            ScrollReading::Unknown
        };
    }
    let offset = pair.action.index_tip_y - pair.modifier.palm_y;
    let direction = if offset <= -SCROLL_VERTICAL_OFFSET {
        ScrollDirection::Up
    } else if offset >= SCROLL_VERTICAL_OFFSET {
        ScrollDirection::Down
    } else {
        return ScrollReading::KnownOther;
    };
    ScrollReading::Gesture { direction, quality }
}

fn resolve_roles<'a>(
    hands: &'a [ControlHand],
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> Result<RoleHands<'a>, ClassificationFailure> {
    let [first, second] = hands else {
        return Err(ClassificationFailure::HandCount(hands.len()));
    };
    if !valid_hand(first) || !valid_hand(second) {
        return Err(ClassificationFailure::InvalidScore);
    }
    if first.handedness == Handedness::Unknown
        || second.handedness == Handedness::Unknown
        || first.handedness == second.handedness
        || first.handedness_score < MIN_HANDEDNESS_SCORE
        || second.handedness_score < MIN_HANDEDNESS_SCORE
    {
        return Err(ClassificationFailure::AmbiguousHandedness);
    }

    let assignment = match preference {
        HandPreference::Left => RoleAssignment {
            modifier: Handedness::Right,
            action: Handedness::Left,
        },
        HandPreference::Right => RoleAssignment {
            modifier: Handedness::Left,
            action: Handedness::Right,
        },
        HandPreference::Auto => match *roles {
            Some(assignment) => assignment,
            None => {
                let (modifier, action) = match (
                    first.pose == HandPose::Anchor && first.score >= MIN_POSE_SCORE,
                    second.pose == HandPose::Anchor && second.score >= MIN_POSE_SCORE,
                ) {
                    (true, false) => (first, second),
                    (false, true) => (second, first),
                    _ => return Err(ClassificationFailure::UnsupportedPose),
                };
                let assignment = RoleAssignment {
                    modifier: modifier.handedness,
                    action: action.handedness,
                };
                *roles = Some(assignment);
                assignment
            }
        },
    };
    let modifier = hands
        .iter()
        .find(|hand| hand.handedness == assignment.modifier)
        .ok_or(ClassificationFailure::AmbiguousHandedness)?;
    let action = hands
        .iter()
        .find(|hand| hand.handedness == assignment.action)
        .ok_or(ClassificationFailure::AmbiguousHandedness)?;
    Ok(RoleHands { modifier, action })
}

fn valid_hand(hand: &ControlHand) -> bool {
    valid_score(hand.score)
        && valid_score(hand.handedness_score)
        && [hand.palm_x, hand.palm_y, hand.index_tip_x, hand.index_tip_y]
            .into_iter()
            .all(|value| value.is_finite())
}

fn valid_score(score: f32) -> bool {
    score.is_finite() && (0.0..=1.0).contains(&score)
}

fn bounded_millis(duration: Duration) -> u16 {
    u16::try_from(duration.as_millis()).unwrap_or(u16::MAX)
}

fn score_percent(score: f32) -> u8 {
    (score.clamp(0.0, 1.0) * 100.0).floor() as u8
}

fn count_progress_permille(current: u16, required: u16) -> u16 {
    if required == 0 {
        return 1_000;
    }
    u16::try_from(u32::from(current).saturating_mul(1_000) / u32::from(required))
        .unwrap_or(u16::MAX)
        .min(1_000)
}

fn duration_progress_permille(current: Duration, required: Duration) -> u16 {
    if required.is_zero() {
        return 1_000;
    }
    u16::try_from(
        current
            .as_millis()
            .saturating_mul(1_000)
            .checked_div(required.as_millis())
            .unwrap_or_default(),
    )
    .unwrap_or(u16::MAX)
    .min(1_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEP: Duration = Duration::from_millis(50);
    const STANDBY: ControlState = ControlState::Standby;
    const ACTIVE: ControlState = ControlState::Active {
        voice_request_id: 41,
        muted: false,
    };
    const MUTED: ControlState = ControlState::Active {
        voice_request_id: 41,
        muted: true,
    };

    fn request(action: VoiceRequestGestureIntent) -> ControlIntent {
        ControlIntent::VoiceRequest {
            voice_request_id: 41,
            action,
        }
    }

    fn anchored(action: HandPose, score: f32) -> [ControlHand; 2] {
        [
            ControlHand::test(Handedness::Left, HandPose::Anchor, score, 0.35, 0.55),
            ControlHand::test(Handedness::Right, action, score, 0.65, 0.55),
        ]
    }

    fn mirrored(action: HandPose, score: f32) -> [ControlHand; 2] {
        [
            ControlHand::test(Handedness::Right, HandPose::Anchor, score, 0.65, 0.55),
            ControlHand::test(Handedness::Left, action, score, 0.35, 0.55),
        ]
    }

    struct Harness {
        control: GestureControl,
        start: Instant,
        sequence: u64,
        elapsed: Duration,
    }

    impl Harness {
        fn new(state: ControlState) -> Self {
            Self::with_control(GestureControl::new(state))
        }

        fn with_control(control: GestureControl) -> Self {
            Self {
                control,
                start: Instant::now(),
                sequence: 0,
                elapsed: Duration::ZERO,
            }
        }

        fn sample(&mut self, hands: &[ControlHand]) -> Option<ControlIntent> {
            self.sample_after(STEP, hands)
        }

        fn sample_after(&mut self, step: Duration, hands: &[ControlHand]) -> Option<ControlIntent> {
            self.sequence += 1;
            self.elapsed += step;
            let captured_at = self.start + self.elapsed;
            self.control.observe(ControlSample {
                frame_sequence: self.sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(20),
                hands,
            })
        }

        fn stale(&mut self, hands: &[ControlHand]) -> Option<ControlIntent> {
            self.sequence += 1;
            self.elapsed += STEP;
            let captured_at = self.start + self.elapsed;
            self.control.observe(ControlSample {
                frame_sequence: self.sequence,
                captured_at,
                observed_at: captured_at + MAX_FRAME_AGE + Duration::from_millis(1),
                hands,
            })
        }

        fn drive(&mut self, count: usize, hands: &[ControlHand]) -> Vec<ControlIntent> {
            (0..count).filter_map(|_| self.sample(hands)).collect()
        }

        fn synchronize(&mut self, state: ControlState) {
            self.control.synchronize_state(state);
        }

        fn progress(&self) -> Option<ControlProgress> {
            self.control.progress(self.start + self.elapsed)
        }
    }

    #[test]
    fn authored_pose_grammar_maps_context_to_semantic_actions() {
        let cases = [
            (
                STANDBY,
                HandPose::IndexPinch,
                ControlIntent::StartTranscription,
            ),
            (
                ACTIVE,
                HandPose::IndexPinch,
                request(VoiceRequestGestureIntent::StopTranscription),
            ),
            (
                ACTIVE,
                HandPose::MiddlePinch,
                request(VoiceRequestGestureIntent::Send),
            ),
            (
                ACTIVE,
                HandPose::SoftFist,
                request(VoiceRequestGestureIntent::Mute),
            ),
            (
                MUTED,
                HandPose::SoftFist,
                request(VoiceRequestGestureIntent::Unmute),
            ),
        ];
        for (state, pose, expected) in cases {
            let mut harness = Harness::new(state);
            assert_eq!(harness.drive(20, &anchored(pose, 0.95)), vec![expected]);
        }
    }

    #[test]
    fn modifier_and_action_roles_follow_dominance_not_array_order() {
        let mut roles = None;
        let forward = anchored(HandPose::MiddlePinch, 0.9);
        let reverse = [forward[1], forward[0]];
        assert!(matches!(
            classify_pair(&forward, HandPreference::Auto, &mut roles),
            Ok(PairReading::Action {
                action: ActionPose::SendPinch,
                ..
            })
        ));
        assert!(matches!(
            classify_pair(&reverse, HandPreference::Auto, &mut roles),
            Ok(PairReading::Action {
                action: ActionPose::SendPinch,
                ..
            })
        ));
    }

    #[test]
    fn explicit_left_dominance_accepts_the_mirrored_grammar() {
        let control = GestureControl::with_preference(STANDBY, HandPreference::Left);
        let mut harness = Harness::with_control(control);
        assert_eq!(
            harness.drive(20, &mirrored(HandPose::IndexPinch, 0.95)),
            vec![ControlIntent::StartTranscription]
        );
    }

    #[test]
    fn explicit_right_dominance_rejects_reversed_roles() {
        let control = GestureControl::with_preference(STANDBY, HandPreference::Right);
        let mut harness = Harness::with_control(control);
        assert!(harness
            .drive(20, &mirrored(HandPose::IndexPinch, 0.95))
            .is_empty());
    }

    #[test]
    fn ambiguous_handedness_fails_closed() {
        let hands = [
            ControlHand::test(Handedness::Right, HandPose::Anchor, 0.95, 0.3, 0.5),
            ControlHand::test(Handedness::Right, HandPose::IndexPinch, 0.95, 0.7, 0.5),
        ];
        let mut harness = Harness::new(STANDBY);
        assert!(harness.drive(20, &hands).is_empty());
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::UnsupportedPose
        );
    }

    #[test]
    fn held_primary_pinch_cannot_stop_the_request_it_started() {
        let pinch = anchored(HandPose::IndexPinch, 0.95);
        let neutral = anchored(HandPose::Point, 0.95);
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(10, &pinch),
            vec![ControlIntent::StartTranscription]
        );
        harness.synchronize(ACTIVE);
        assert!(harness.drive(20, &pinch).is_empty());
        assert!(matches!(
            harness.control.diagnostic(),
            ControlDiagnostic::AwaitingRelease { .. }
        ));

        assert_eq!(harness.sample(&neutral), None);
        assert_eq!(
            harness.drive(20, &pinch),
            vec![request(VoiceRequestGestureIntent::StopTranscription)]
        );
    }

    #[test]
    fn missing_tracking_does_not_rearm_an_emitted_pose() {
        let pinch = anchored(HandPose::IndexPinch, 0.95);
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(10, &pinch),
            vec![ControlIntent::StartTranscription]
        );
        harness.synchronize(ACTIVE);
        for _ in 0..5 {
            assert_eq!(harness.sample(&[]), None);
        }
        assert!(harness.drive(20, &pinch).is_empty());
    }

    #[test]
    fn low_confidence_known_pose_does_not_rearm_an_emitted_pose() {
        let pinch = anchored(HandPose::IndexPinch, 0.95);
        let weak_release = anchored(HandPose::Point, 0.49);
        let strong_release = anchored(HandPose::Point, 0.95);
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(10, &pinch),
            vec![ControlIntent::StartTranscription]
        );
        harness.synchronize(ACTIVE);
        assert_eq!(harness.sample(&weak_release), None);
        assert!(harness.drive(20, &pinch).is_empty());

        assert_eq!(harness.sample(&strong_release), None);
        assert_eq!(
            harness.drive(20, &pinch),
            vec![request(VoiceRequestGestureIntent::StopTranscription)]
        );
    }

    #[test]
    fn low_pose_confidence_never_accumulates_evidence() {
        let mut harness = Harness::new(STANDBY);
        assert!(harness
            .drive(20, &anchored(HandPose::IndexPinch, 0.49))
            .is_empty());
        assert_eq!(harness.progress(), None);
    }

    #[test]
    fn stale_frames_clear_in_flight_evidence() {
        let pinch = anchored(HandPose::IndexPinch, 0.95);
        let mut harness = Harness::new(STANDBY);
        assert!(harness.drive(4, &pinch).is_empty());
        assert_eq!(harness.stale(&pinch), None);
        assert_eq!(harness.progress(), None);
        assert!(harness.drive(7, &pinch).is_empty());
        assert_eq!(
            harness.sample(&pinch),
            Some(ControlIntent::StartTranscription)
        );
    }

    #[test]
    fn progress_is_bounded_below_completion_until_the_intent_edge() {
        let pinch = anchored(HandPose::IndexPinch, 0.95);
        let mut harness = Harness::new(STANDBY);
        assert!(harness.drive(5, &pinch).is_empty());
        let progress = harness.progress().expect("candidate progress");
        assert_eq!(progress.chord, ControlChord::StartTranscription);
        assert!(progress.progress_permille < 1_000);
    }

    #[test]
    fn scroll_uses_point_position_relative_to_the_modifier_anchor() {
        let started = Instant::now();
        let anchor = ControlHand::test(Handedness::Left, HandPose::Anchor, 0.95, 0.35, 0.55);
        let up = ControlHand::test_point(Handedness::Right, 0.95, 0.65, 0.35, 0.65, 0.35);
        let down = ControlHand::test_point(Handedness::Right, 0.95, 0.65, 0.75, 0.65, 0.75);
        let neutral = ControlHand::test(Handedness::Right, HandPose::MiddlePinch, 0.95, 0.65, 0.55);
        let mut control = ScrollControl::new();
        let mut sequence = 0_u64;
        let mut elapsed = Duration::ZERO;
        let mut sample = |control: &mut ScrollControl, action: ControlHand| {
            sequence += 1;
            elapsed += STEP;
            let captured_at = started + elapsed;
            let hands = [anchor, action];
            control.observe(ControlSample {
                frame_sequence: sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(20),
                hands: &hands,
            })
        };

        let transitions: Vec<_> = (0..7).filter_map(|_| sample(&mut control, up)).collect();
        assert!(matches!(
            transitions.as_slice(),
            [ScrollState::Held {
                direction: ScrollDirection::Up,
                ..
            }]
        ));
        assert_eq!(sample(&mut control, neutral), Some(ScrollState::Idle));

        let transitions: Vec<_> = (0..7).filter_map(|_| sample(&mut control, down)).collect();
        assert!(matches!(
            transitions.as_slice(),
            [ScrollState::Held {
                direction: ScrollDirection::Down,
                ..
            }]
        ));
    }

    #[test]
    fn scroll_stops_after_tracking_grace_without_rearming() {
        let started = Instant::now();
        let hands = [
            ControlHand::test(Handedness::Left, HandPose::Anchor, 0.95, 0.35, 0.55),
            ControlHand::test_point(Handedness::Right, 0.95, 0.65, 0.35, 0.65, 0.35),
        ];
        let mut control = ScrollControl::new();
        let mut sequence = 0_u64;
        for index in 0..7 {
            sequence += 1;
            let captured_at = started + STEP * (index + 1);
            let _ = control.observe(ControlSample {
                frame_sequence: sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(20),
                hands: &hands,
            });
        }
        assert!(matches!(control.state(), ScrollState::Held { .. }));

        sequence += 1;
        let captured_at = started + Duration::from_millis(600);
        assert_eq!(
            control.observe(ControlSample {
                frame_sequence: sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(20),
                hands: &[],
            }),
            Some(ScrollState::Idle)
        );
    }

    #[test]
    fn unordered_and_future_timestamps_fail_closed() {
        let pinch = anchored(HandPose::IndexPinch, 0.95);
        let now = Instant::now();
        let mut control = GestureControl::new(STANDBY);
        assert_eq!(
            control.observe(ControlSample {
                frame_sequence: 0,
                captured_at: now,
                observed_at: now,
                hands: &pinch,
            }),
            None
        );
        assert_eq!(control.diagnostic(), ControlDiagnostic::InvalidOrder);

        let mut fresh = GestureControl::new(STANDBY);
        assert_eq!(
            fresh.observe(ControlSample {
                frame_sequence: 1,
                captured_at: now + Duration::from_millis(1),
                observed_at: now,
                hands: &pinch,
            }),
            None
        );
        assert_eq!(fresh.diagnostic(), ControlDiagnostic::InvalidOrder);
    }
}
