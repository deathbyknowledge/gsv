//! Pure temporal policy for two-hand voice controls.
//!
//! One hand is a closed-fist modifier. The other opens fingers sequentially
//! from one through five to select an action, then returns to a fist to rearm.
//! This module owns no camera, window, IPC, or application action.

use std::time::{Duration, Instant};

use gesture_protocol::VoiceRequestGestureIntent;
pub use gesture_protocol::{GestureContext as ControlState, GestureIntent as ControlIntent};

use crate::observation::{HandObservation, HandPose, Handedness};

const ENTER_SCORE: f32 = 0.50;
const CONTINUE_SCORE: f32 = 0.50;
const MIN_SUPPORT_PERCENT: u16 = 80;
const MIN_STRONG_SAMPLES: u16 = 3;
const STANDARD_DWELL: Duration = Duration::from_millis(350);
const CLEAR_DWELL: Duration = Duration::from_millis(1_000);
const MAX_FRAME_AGE: Duration = Duration::from_millis(250);
const MAX_SAMPLE_GAP: Duration = Duration::from_millis(250);
const MAX_EVIDENCE_GAP: Duration = Duration::from_millis(180);
const MIN_HANDEDNESS_SCORE: f32 = 0.72;
const MIN_POSE_SCORE: f32 = 0.50;

/// Fixed local-only vocabulary for explaining the temporal controller in the
/// diagnostic window. Its observation-derived counts, percentages, and
/// timings are bounded and quantized; labels, landmarks, and request IDs are
/// omitted, and the value never crosses GSV IPC or logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlChord {
    StartTranscription,
    StopTranscription,
    Send,
    DeleteBackward,
    ClearDictation,
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
    Accepted {
        chord: ControlChord,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HandPreference {
    Auto,
    Left,
    #[default]
    Right,
}

#[derive(Clone, Copy, Debug)]
pub struct ControlHand {
    pub handedness: Handedness,
    pub handedness_score: f32,
    pub pose: HandPose,
    pub score: f32,
}

impl ControlHand {
    #[must_use]
    pub const fn from_observation(hand: &HandObservation) -> Self {
        Self {
            handedness: hand.handedness,
            handedness_score: hand.handedness_score,
            pose: hand.pose,
            score: hand.pose_score,
        }
    }

    #[cfg(test)]
    pub(crate) const fn test(handedness: Handedness, pose: HandPose, score: f32) -> Self {
        Self {
            handedness,
            handedness_score: 0.95,
            pose,
            score,
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

/// Deterministic, allocation-free recognition of the supported two-hand
/// control vocabulary.
pub struct GestureControl {
    state: ControlState,
    pending: Option<ControlIntent>,
    release_latched: bool,
    diagnostic: ControlDiagnostic,
    candidate: Option<Candidate>,
    last_frame_sequence: Option<u64>,
    last_captured_at: Option<Instant>,
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
        Self::with_preference(state, HandPreference::Right)
    }

    #[must_use]
    pub const fn with_preference(state: ControlState, preference: HandPreference) -> Self {
        Self {
            state,
            pending: None,
            release_latched: false,
            diagnostic: ControlDiagnostic::AwaitingPose,
            candidate: None,
            last_frame_sequence: None,
            last_captured_at: None,
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

    /// Returns aggregate evidence for the current candidate. Pending evidence
    /// is capped below completion; only an emitted intent completes it.
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
    /// Context changes fence evidence but deliberately preserve the fist-reset
    /// latch, so a held count cannot act again in the new context.
    pub fn synchronize_state(&mut self, state: ControlState) {
        self.state = state;
        self.pending = None;
        self.candidate = None;
        self.diagnostic = ControlDiagnostic::AwaitingPose;
    }

    /// Consumes one fresh, ordered inference result and returns at most one
    /// semantic edge.
    pub fn observe(&mut self, sample: ControlSample<'_>) -> Option<ControlIntent> {
        if !self.accept_order(&sample) {
            self.diagnostic = ControlDiagnostic::InvalidOrder;
            self.candidate = None;
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
            self.candidate = None;
            return None;
        };
        if age > MAX_FRAME_AGE {
            self.diagnostic = ControlDiagnostic::FrameTooOld {
                age_ms: bounded_millis(age),
            };
            self.candidate = None;
            return None;
        }
        if let Some(gap) = gap.filter(|gap| *gap > MAX_SAMPLE_GAP) {
            self.diagnostic = ControlDiagnostic::SampleGap {
                gap_ms: bounded_millis(gap),
            };
            self.candidate = None;
            return None;
        }

        let now = sample.captured_at;
        let reading = match classify_pair(sample.hands, self.preference, &mut self.roles) {
            Ok(reading) => reading,
            Err(failure) => {
                self.diagnostic = failure.diagnostic();
                self.candidate = None;
                return None;
            }
        };

        match reading {
            PairReading::Reset { quality } => {
                self.candidate = None;
                if quality >= ENTER_SCORE {
                    self.release_latched = false;
                    self.diagnostic = ControlDiagnostic::AwaitingPose;
                } else {
                    self.diagnostic = ControlDiagnostic::UnsupportedPose;
                }
                None
            }
            PairReading::KnownOther => {
                self.candidate = None;
                self.diagnostic = ControlDiagnostic::UnsupportedPose;
                None
            }
            PairReading::Action { action, quality } => {
                let chord = action.chord(self.state);
                if let Some(intent) = self.pending {
                    self.candidate = None;
                    self.diagnostic = ControlDiagnostic::AwaitingAuthority {
                        chord: intent.into(),
                    };
                    return None;
                }
                if self.release_latched {
                    self.candidate = None;
                    self.diagnostic = ControlDiagnostic::AwaitingRelease {
                        chord: chord.into(),
                    };
                    return None;
                }
                self.advance_candidate(
                    now,
                    ChordReading {
                        chord,
                        action,
                        quality,
                    },
                )
            }
        }
    }

    fn accept_order(&self, sample: &ControlSample<'_>) -> bool {
        sample.frame_sequence != 0
            && self
                .last_frame_sequence
                .is_none_or(|previous| sample.frame_sequence > previous)
            && self
                .last_captured_at
                .is_none_or(|previous| sample.captured_at > previous)
    }

    fn advance_candidate(&mut self, now: Instant, reading: ChordReading) -> Option<ControlIntent> {
        if !self.accepted_target(reading.chord) {
            self.candidate = None;
            self.diagnostic = if self.target_is_satisfied(reading.chord) {
                ControlDiagnostic::AlreadySatisfied {
                    chord: reading.chord.into(),
                }
            } else {
                ControlDiagnostic::UnexpectedPose {
                    chord: reading.chord.into(),
                }
            };
            return None;
        }

        let mut evidence_gap = None;
        match self.candidate.as_mut() {
            Some(candidate)
                if candidate.chord == reading.chord && candidate.action == reading.action =>
            {
                let gap = now.saturating_duration_since(candidate.last_match_at);
                if gap > MAX_EVIDENCE_GAP {
                    evidence_gap = Some(gap);
                    if reading.quality >= ENTER_SCORE {
                        *candidate = Candidate::new(reading.chord, reading.action, now);
                    } else {
                        self.candidate = None;
                    }
                } else if reading.quality >= CONTINUE_SCORE {
                    candidate.record_match(now, reading.quality >= ENTER_SCORE);
                } else {
                    candidate.record_miss();
                }
            }
            Some(candidate) if reading.quality >= ENTER_SCORE => {
                *candidate = Candidate::new(reading.chord, reading.action, now);
            }
            Some(_) => self.candidate = None,
            None if reading.quality >= ENTER_SCORE => {
                self.candidate = Some(Candidate::new(reading.chord, reading.action, now));
            }
            None => {}
        }

        self.diagnostic = if let Some(gap) = evidence_gap {
            ControlDiagnostic::EvidenceGap {
                gap_ms: bounded_millis(gap),
            }
        } else if reading.quality < ENTER_SCORE {
            ControlDiagnostic::LowConfidence {
                chord: reading.chord.into(),
                observed_percent: score_percent(reading.quality),
                required_percent: score_percent(ENTER_SCORE),
            }
        } else {
            ControlDiagnostic::Stabilizing {
                chord: reading.chord.into(),
                confidence_percent: score_percent(reading.quality),
                progress_percent: self.progress(now).map_or(0, |progress| {
                    u8::try_from(progress.progress_permille / 10).unwrap_or(100)
                }),
            }
        };

        let stable = self.candidate.as_ref().is_some_and(|candidate| {
            candidate.chord == reading.chord
                && candidate.action == reading.action
                && reading.quality >= ENTER_SCORE
                && candidate.is_stable(now)
        });
        if !stable {
            return None;
        }

        let (chord, action) = self
            .candidate
            .as_ref()
            .map(|candidate| (candidate.chord, candidate.action))?;
        let intent = control_intent(self.state, chord)?;
        self.candidate = None;
        self.pending = Some(intent);
        self.release_latched = true;
        self.diagnostic = ControlDiagnostic::Accepted {
            chord: chord.into(),
        };
        debug_assert_eq!(action.chord(self.state), chord);
        Some(intent)
    }

    fn accepted_target(&self, chord: Chord) -> bool {
        matches!(
            (self.state, chord),
            (ControlState::Standby, Chord::StartTranscription)
                | (
                    ControlState::Active { .. },
                    Chord::StopTranscription
                        | Chord::Send
                        | Chord::DeleteBackward
                        | Chord::ClearDictation,
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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Chord {
    StartTranscription,
    StopTranscription,
    Send,
    DeleteBackward,
    ClearDictation,
    Mute,
    Unmute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActionPose {
    One,
    Two,
    Three,
    Four,
    Five,
}

impl ActionPose {
    const fn chord(self, state: ControlState) -> Chord {
        match (self, state) {
            (Self::One, ControlState::Standby | ControlState::Disabled) => {
                Chord::StartTranscription
            }
            (Self::One, ControlState::Active { .. }) => Chord::StopTranscription,
            (Self::Two, _) => Chord::Send,
            (Self::Three, _) => Chord::DeleteBackward,
            (Self::Four, _) => Chord::ClearDictation,
            (Self::Five, ControlState::Active { muted: true, .. }) => Chord::Unmute,
            (Self::Five, _) => Chord::Mute,
        }
    }
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
            Chord::DeleteBackward => Self::DeleteBackward,
            Chord::ClearDictation => Self::ClearDictation,
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
                VoiceRequestGestureIntent::DeleteBackward => Self::DeleteBackward,
                VoiceRequestGestureIntent::ClearDictation => Self::ClearDictation,
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
                Chord::DeleteBackward => VoiceRequestGestureIntent::DeleteBackward,
                Chord::ClearDictation => VoiceRequestGestureIntent::ClearDictation,
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
        if matches!(self, Self::ClearDictation) {
            CLEAR_DWELL
        } else {
            STANDARD_DWELL
        }
    }

    const fn minimum_matches(self) -> u16 {
        if matches!(self, Self::ClearDictation) {
            10
        } else {
            4
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
    Reset { quality: f32 },
    KnownOther,
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
            Self::UnsupportedPose | Self::AmbiguousHandedness => ControlDiagnostic::UnsupportedPose,
        }
    }
}

fn classify_pair(
    hands: &[ControlHand],
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> Result<PairReading, ClassificationFailure> {
    validate_pair(hands)?;
    let [first, second] = hands else {
        unreachable!("validate_pair requires exactly two hands")
    };
    let pair_quality = hand_quality(first).min(hand_quality(second));
    if first.pose == HandPose::Fist && second.pose == HandPose::Fist {
        return Ok(PairReading::Reset {
            quality: pair_quality,
        });
    }

    let pair = resolve_roles(hands, preference, roles)?;
    if pair.modifier.pose == HandPose::Unknown || pair.action.pose == HandPose::Unknown {
        return Err(ClassificationFailure::UnsupportedPose);
    }
    let quality = hand_quality(pair.modifier).min(hand_quality(pair.action));
    if pair.modifier.pose != HandPose::Fist {
        return Ok(PairReading::KnownOther);
    }
    let action = match pair.action.pose {
        HandPose::Fist => return Ok(PairReading::Reset { quality }),
        HandPose::OneFinger => ActionPose::One,
        HandPose::TwoFingers => ActionPose::Two,
        HandPose::ThreeFingers => ActionPose::Three,
        HandPose::FourFingers => ActionPose::Four,
        HandPose::FiveFingers => ActionPose::Five,
        HandPose::Unknown => return Err(ClassificationFailure::UnsupportedPose),
    };
    Ok(PairReading::Action { action, quality })
}

fn validate_pair(hands: &[ControlHand]) -> Result<(), ClassificationFailure> {
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
    Ok(())
}

fn resolve_roles<'a>(
    hands: &'a [ControlHand],
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> Result<RoleHands<'a>, ClassificationFailure> {
    let [first, second] = hands else {
        return Err(ClassificationFailure::HandCount(hands.len()));
    };
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
                    first.pose == HandPose::Fist && first.score >= MIN_POSE_SCORE,
                    second.pose == HandPose::Fist && second.score >= MIN_POSE_SCORE,
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

fn hand_quality(hand: &ControlHand) -> f32 {
    hand.score.min(hand.handedness_score)
}

fn valid_hand(hand: &ControlHand) -> bool {
    valid_score(hand.score) && valid_score(hand.handedness_score)
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
    u16::try_from(u32::from(current).saturating_mul(1_000) / u32::from(required))
        .unwrap_or(u16::MAX)
        .min(1_000)
}

fn duration_progress_permille(current: Duration, required: Duration) -> u16 {
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

    fn counted(action: HandPose, score: f32) -> [ControlHand; 2] {
        [
            ControlHand::test(Handedness::Left, HandPose::Fist, score),
            ControlHand::test(Handedness::Right, action, score),
        ]
    }

    fn mirrored(action: HandPose, score: f32) -> [ControlHand; 2] {
        [
            ControlHand::test(Handedness::Right, HandPose::Fist, score),
            ControlHand::test(Handedness::Left, action, score),
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

        fn drive(&mut self, count: usize, hands: &[ControlHand]) -> Vec<ControlIntent> {
            (0..count).filter_map(|_| self.sample(hands)).collect()
        }

        fn synchronize(&mut self, state: ControlState) {
            self.control.synchronize_state(state);
        }
    }

    #[test]
    fn finger_counts_map_context_to_semantic_actions() {
        let cases = [
            (
                STANDBY,
                HandPose::OneFinger,
                ControlIntent::StartTranscription,
            ),
            (
                ACTIVE,
                HandPose::OneFinger,
                request(VoiceRequestGestureIntent::StopTranscription),
            ),
            (
                ACTIVE,
                HandPose::TwoFingers,
                request(VoiceRequestGestureIntent::Send),
            ),
            (
                ACTIVE,
                HandPose::ThreeFingers,
                request(VoiceRequestGestureIntent::DeleteBackward),
            ),
            (
                ACTIVE,
                HandPose::FourFingers,
                request(VoiceRequestGestureIntent::ClearDictation),
            ),
            (
                ACTIVE,
                HandPose::FiveFingers,
                request(VoiceRequestGestureIntent::Mute),
            ),
            (
                MUTED,
                HandPose::FiveFingers,
                request(VoiceRequestGestureIntent::Unmute),
            ),
        ];
        for (state, pose, expected) in cases {
            let mut harness = Harness::new(state);
            assert_eq!(harness.drive(24, &counted(pose, 0.95)), vec![expected]);
        }
    }

    #[test]
    fn fist_is_the_only_reset_and_all_counts_stay_blocked_until_it() {
        let one = counted(HandPose::OneFinger, 0.95);
        let two = counted(HandPose::TwoFingers, 0.95);
        let reset = counted(HandPose::Fist, 0.95);
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(10, &one),
            vec![ControlIntent::StartTranscription]
        );
        harness.synchronize(ACTIVE);
        assert!(harness.drive(20, &two).is_empty());
        assert!(matches!(
            harness.control.diagnostic(),
            ControlDiagnostic::AwaitingRelease { .. }
        ));
        assert_eq!(harness.sample(&reset), None);
        assert_eq!(
            harness.drive(10, &two),
            vec![request(VoiceRequestGestureIntent::Send)]
        );
    }

    #[test]
    fn missing_unknown_and_weak_fists_do_not_rearm() {
        let one = counted(HandPose::OneFinger, 0.95);
        let reset = counted(HandPose::Fist, 0.95);
        let unknown = counted(HandPose::Unknown, 0.95);
        let weak_reset = counted(HandPose::Fist, 0.49);
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(10, &one),
            vec![ControlIntent::StartTranscription]
        );
        harness.synchronize(ACTIVE);
        assert_eq!(harness.sample(&[]), None);
        assert_eq!(harness.sample(&unknown), None);
        assert_eq!(harness.sample(&weak_reset), None);
        assert!(harness.drive(10, &one).is_empty());
        assert_eq!(harness.sample(&reset), None);
        assert_eq!(
            harness.drive(10, &one),
            vec![request(VoiceRequestGestureIntent::StopTranscription)]
        );
    }

    #[test]
    fn both_fists_reset_without_assigning_auto_roles() {
        let fists = counted(HandPose::Fist, 0.95);
        let mut roles = None;
        assert!(matches!(
            classify_pair(&fists, HandPreference::Auto, &mut roles),
            Ok(PairReading::Reset { .. })
        ));
        assert_eq!(roles, None);
    }

    #[test]
    fn roles_follow_the_fist_and_not_array_order() {
        let mut roles = None;
        let forward = counted(HandPose::TwoFingers, 0.9);
        let reverse = [forward[1], forward[0]];
        for hands in [&forward, &reverse] {
            assert!(matches!(
                classify_pair(hands, HandPreference::Auto, &mut roles),
                Ok(PairReading::Action {
                    action: ActionPose::Two,
                    ..
                })
            ));
        }
    }

    #[test]
    fn explicit_action_handedness_supports_mirrored_users() {
        let mut left = Harness::with_control(GestureControl::with_preference(
            STANDBY,
            HandPreference::Left,
        ));
        assert_eq!(
            left.drive(10, &mirrored(HandPose::OneFinger, 0.95)),
            vec![ControlIntent::StartTranscription]
        );

        let mut right = Harness::with_control(GestureControl::with_preference(
            STANDBY,
            HandPreference::Right,
        ));
        assert!(right
            .drive(10, &mirrored(HandPose::OneFinger, 0.95))
            .is_empty());
    }

    #[test]
    fn stale_and_out_of_order_samples_fence_evidence() {
        let hands = counted(HandPose::OneFinger, 0.95);
        let mut harness = Harness::new(STANDBY);
        assert_eq!(harness.sample(&hands), None);

        harness.sequence += 1;
        harness.elapsed += STEP;
        let captured_at = harness.start + harness.elapsed;
        assert_eq!(
            harness.control.observe(ControlSample {
                frame_sequence: harness.sequence,
                captured_at,
                observed_at: captured_at + MAX_FRAME_AGE + Duration::from_millis(1),
                hands: &hands,
            }),
            None
        );
        assert!(matches!(
            harness.control.diagnostic(),
            ControlDiagnostic::FrameTooOld { .. }
        ));

        assert_eq!(
            harness.control.observe(ControlSample {
                frame_sequence: harness.sequence,
                captured_at,
                observed_at: captured_at,
                hands: &hands,
            }),
            None
        );
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::InvalidOrder
        );
    }

    #[test]
    fn clear_requires_the_long_hold() {
        let four = counted(HandPose::FourFingers, 0.95);
        let mut harness = Harness::new(ACTIVE);
        assert!(harness.drive(20, &four).is_empty());
        assert_eq!(
            harness.sample(&four),
            Some(request(VoiceRequestGestureIntent::ClearDictation))
        );
    }
}
