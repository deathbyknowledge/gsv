//! Pure temporal policy for two-hand voice controls.
//!
//! This module consumes only bounded MediaPipe label/score observations. It
//! owns no camera, window, IPC, or application action. Missing tracking clears
//! temporal evidence but never changes Desktop-owned transcription authority.

use std::time::{Duration, Instant};

use gsv_vision_control::VoiceRequestGestureIntent;
pub use gsv_vision_control::{GestureContext as ControlState, GestureIntent as ControlIntent};

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

#[derive(Clone, Copy, Debug)]
pub struct ControlHand<'a> {
    pub gesture: &'a str,
    pub score: f32,
}

impl<'a> ControlHand<'a> {
    #[must_use]
    pub const fn new(gesture: &'a str, score: f32) -> Self {
        Self { gesture, score }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ControlSample<'a> {
    pub frame_sequence: u64,
    pub captured_at: Instant,
    pub observed_at: Instant,
    pub hands: &'a [ControlHand<'a>],
}

/// Deterministic, allocation-free recognition of the supported two-hand
/// control vocabulary.
pub struct GestureControl {
    state: ControlState,
    pending: Option<ControlIntent>,
    release_latch: Option<Chord>,
    diagnostic: ControlDiagnostic,
    candidate: Option<Candidate>,
    last_frame_sequence: Option<u64>,
    last_captured_at: Option<Instant>,
    last_intent_at: Option<Instant>,
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
        Self {
            state,
            pending: None,
            release_latch: None,
            diagnostic: ControlDiagnostic::AwaitingPose,
            candidate: None,
            last_frame_sequence: None,
            last_captured_at: None,
            last_intent_at: None,
        }
    }

    #[must_use]
    pub const fn state(&self) -> ControlState {
        self.state
    }

    #[cfg(test)]
    #[must_use]
    pub const fn pending_intent(&self) -> Option<ControlIntent> {
        self.pending
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
    /// Samples must be fresh and strictly ordered. Exactly two hands are
    /// required, but their array order and anatomical handedness are ignored.
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
        let reading = match classify_chord(sample.hands) {
            Ok(reading) => Some(reading),
            Err(failure) => {
                self.diagnostic = failure.diagnostic();
                None
            }
        };

        if self
            .release_latch
            .is_some_and(|latched| positively_observes_release(sample.hands, latched))
        {
            self.release_latch = None;
        }

        if let Some(intent) = self.pending {
            self.candidate = None;
            self.diagnostic = ControlDiagnostic::AwaitingAuthority {
                chord: intent.into(),
            };
            return None;
        }

        if let (Some(latched), Some(reading)) = (self.release_latch, reading) {
            if reading.chord == latched {
                self.candidate = None;
                self.diagnostic = ControlDiagnostic::AwaitingRelease {
                    chord: latched.into(),
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
            (Some(candidate), Some((chord, quality, entry_score))) if candidate.chord == chord => {
                let gap = now.saturating_duration_since(candidate.last_match_at);
                if gap > MAX_EVIDENCE_GAP {
                    evidence_gap = Some(gap);
                    if quality >= entry_score {
                        *candidate = Candidate::new(chord, now);
                    } else {
                        candidate.record_miss();
                    }
                } else if quality >= entry_score.min(CONTINUE_SCORE) {
                    candidate.record_match(now, quality >= entry_score);
                } else {
                    candidate.record_miss();
                }
            }
            (Some(candidate), Some((chord, quality, entry_score))) if quality >= entry_score => {
                *candidate = Candidate::new(chord, now);
            }
            (Some(_), _) => discard_candidate = true,
            (None, Some((chord, quality, entry_score))) if quality >= entry_score => {
                self.candidate = Some(Candidate::new(chord, now));
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

        if let Some((chord, quality, entry_score)) = target {
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
            let current_is_strong = target.is_some_and(|(chord, quality, entry_score)| {
                chord == candidate.chord && quality >= entry_score
            });
            current_is_strong && candidate.is_stable(now)
        });
        if !stable {
            return None;
        }

        let chord = self.candidate.as_ref().map(|candidate| candidate.chord)?;
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
        self.release_latch = Some(chord);
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
enum Pose {
    OpenPalm,
    ClosedFist,
    ILoveYou,
    None,
    PointingUp,
    ThumbDown,
    ThumbUp,
    Victory,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Chord {
    StartTranscription,
    StopTranscription,
    Send,
    Mute,
    Unmute,
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
    quality: f32,
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    chord: Chord,
    started_at: Instant,
    last_match_at: Instant,
    samples: u16,
    matches: u16,
    strong_matches: u16,
    consecutive_matches: u16,
}

impl Candidate {
    fn new(chord: Chord, now: Instant) -> Self {
        Self {
            chord,
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
}

impl ClassificationFailure {
    fn diagnostic(self) -> ControlDiagnostic {
        match self {
            Self::HandCount(detected) => ControlDiagnostic::NeedTwoHands {
                detected: u8::try_from(detected).unwrap_or(u8::MAX),
            },
            Self::InvalidScore => ControlDiagnostic::InvalidScore,
            Self::UnsupportedPose => ControlDiagnostic::UnsupportedPose,
        }
    }
}

fn classify_chord(hands: &[ControlHand<'_>]) -> Result<ChordReading, ClassificationFailure> {
    let [first, second] = hands else {
        return Err(ClassificationFailure::HandCount(hands.len()));
    };
    if !valid_score(first.score) || !valid_score(second.score) {
        return Err(ClassificationFailure::InvalidScore);
    }
    let first_pose = parse_pose(first.gesture).ok_or(ClassificationFailure::UnsupportedPose)?;
    let second_pose = parse_pose(second.gesture).ok_or(ClassificationFailure::UnsupportedPose)?;
    let chord =
        chord_for_poses(first_pose, second_pose).ok_or(ClassificationFailure::UnsupportedPose)?;
    Ok(ChordReading {
        chord,
        quality: first.score.min(second.score),
    })
}

fn parse_pose(label: &str) -> Option<Pose> {
    match label {
        "Open_Palm" => Some(Pose::OpenPalm),
        "Closed_Fist" => Some(Pose::ClosedFist),
        "ILoveYou" => Some(Pose::ILoveYou),
        "None" => Some(Pose::None),
        "Pointing_Up" => Some(Pose::PointingUp),
        "Thumb_Down" => Some(Pose::ThumbDown),
        "Thumb_Up" => Some(Pose::ThumbUp),
        "Victory" => Some(Pose::Victory),
        _ => None,
    }
}

fn chord_for_poses(first: Pose, second: Pose) -> Option<Chord> {
    match (first, second) {
        (Pose::OpenPalm, Pose::OpenPalm) => Some(Chord::StartTranscription),
        (Pose::OpenPalm, Pose::Victory) | (Pose::Victory, Pose::OpenPalm) => {
            Some(Chord::StopTranscription)
        }
        (Pose::OpenPalm, Pose::ThumbUp) | (Pose::ThumbUp, Pose::OpenPalm) => Some(Chord::Send),
        (Pose::OpenPalm, Pose::ThumbDown) | (Pose::ThumbDown, Pose::OpenPalm) => Some(Chord::Mute),
        (Pose::OpenPalm, Pose::PointingUp) | (Pose::PointingUp, Pose::OpenPalm) => {
            Some(Chord::Unmute)
        }
        _ => None,
    }
}

/// A release must be a fresh, confident observation of two known canned
/// poses which no longer form the emitted chord. Missing, stale, invalid, or
/// unknown tracking never clears the cross-context rearm latch.
fn positively_observes_release(hands: &[ControlHand<'_>], latched: Chord) -> bool {
    let [first, second] = hands else {
        return false;
    };
    if !valid_score(first.score)
        || !valid_score(second.score)
        || first.score < CONTINUE_SCORE
        || second.score < CONTINUE_SCORE
    {
        return false;
    }
    let (Some(first), Some(second)) = (parse_pose(first.gesture), parse_pose(second.gesture))
    else {
        return false;
    };
    chord_for_poses(first, second) != Some(latched)
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
    const DISABLED: ControlState = ControlState::Disabled;
    const STANDBY: ControlState = ControlState::Standby;
    const ACTIVE: ControlState = ControlState::Active {
        voice_request_id: 41,
        muted: false,
    };
    const ACTIVE_MUTED: ControlState = ControlState::Active {
        voice_request_id: 41,
        muted: true,
    };

    fn request(voice_request_id: u64, action: VoiceRequestGestureIntent) -> ControlIntent {
        ControlIntent::VoiceRequest {
            voice_request_id,
            action,
        }
    }

    struct Harness {
        control: GestureControl,
        start: Instant,
        sequence: u64,
        elapsed: Duration,
    }

    impl Harness {
        fn new(state: ControlState) -> Self {
            Self {
                control: GestureControl::new(state),
                start: Instant::now(),
                sequence: 0,
                elapsed: Duration::ZERO,
            }
        }

        fn sample(&mut self, first: (&str, f32), second: (&str, f32)) -> Option<ControlIntent> {
            self.sample_after(STEP, first, second)
        }

        fn sample_after(
            &mut self,
            step: Duration,
            first: (&str, f32),
            second: (&str, f32),
        ) -> Option<ControlIntent> {
            self.sequence += 1;
            self.elapsed += step;
            let captured_at = self.start + self.elapsed;
            let hands = [
                ControlHand::new(first.0, first.1),
                ControlHand::new(second.0, second.1),
            ];
            self.control.observe(ControlSample {
                frame_sequence: self.sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(20),
                hands: &hands,
            })
        }

        fn empty(&mut self) -> Option<ControlIntent> {
            self.sequence += 1;
            self.elapsed += STEP;
            let captured_at = self.start + self.elapsed;
            self.control.observe(ControlSample {
                frame_sequence: self.sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(20),
                hands: &[],
            })
        }

        fn stale(&mut self, first: (&str, f32), second: (&str, f32)) -> Option<ControlIntent> {
            self.sequence += 1;
            self.elapsed += STEP;
            let captured_at = self.start + self.elapsed;
            let hands = [
                ControlHand::new(first.0, first.1),
                ControlHand::new(second.0, second.1),
            ];
            self.control.observe(ControlSample {
                frame_sequence: self.sequence,
                captured_at,
                observed_at: captured_at + MAX_FRAME_AGE + Duration::from_millis(1),
                hands: &hands,
            })
        }

        fn drive(
            &mut self,
            count: usize,
            first: (&str, f32),
            second: (&str, f32),
        ) -> Vec<ControlIntent> {
            (0..count)
                .filter_map(|_| self.sample(first, second))
                .collect()
        }

        fn drive_empty(&mut self, count: usize) {
            for _ in 0..count {
                assert_eq!(self.empty(), None);
            }
        }

        fn progress(&self) -> Option<ControlProgress> {
            self.control.progress(self.start + self.elapsed)
        }

        fn synchronize(&mut self, state: ControlState) {
            self.control.synchronize_state(state);
        }

        fn release(&mut self) {
            assert_eq!(
                self.sample(("Closed_Fist", 0.9), ("Closed_Fist", 0.9)),
                None
            );
        }
    }

    #[test]
    fn exact_unordered_canned_grammar_is_closed() {
        let cases = [
            (("Open_Palm", "Open_Palm"), Chord::StartTranscription),
            (("Open_Palm", "Victory"), Chord::StopTranscription),
            (("Open_Palm", "Thumb_Up"), Chord::Send),
            (("Open_Palm", "Thumb_Down"), Chord::Mute),
            (("Open_Palm", "Pointing_Up"), Chord::Unmute),
        ];
        for ((first, second), expected) in cases {
            for (first, second) in [(first, second), (second, first)] {
                let hands = [ControlHand::new(first, 0.9), ControlHand::new(second, 0.8)];
                let reading = classify_chord(&hands).expect("supported chord");
                assert_eq!(reading.chord, expected);
                assert_eq!(reading.quality, 0.8);
            }
        }

        for (first, second) in [
            ("Open_Palm", "Closed_Fist"),
            ("Open_Palm", "ILoveYou"),
            ("Victory", "Victory"),
            ("open_palm", "Open_Palm"),
        ] {
            let hands = [ControlHand::new(first, 1.0), ControlHand::new(second, 1.0)];
            assert!(matches!(
                classify_chord(&hands),
                Err(ClassificationFailure::UnsupportedPose)
            ));
        }
    }

    #[test]
    fn confidence_and_dwell_matrix_is_exact() {
        let cases = [
            (
                STANDBY,
                ("Open_Palm", "Open_Palm"),
                8,
                ControlIntent::StartTranscription,
            ),
            (
                ACTIVE,
                ("Open_Palm", "Victory"),
                8,
                request(41, VoiceRequestGestureIntent::StopTranscription),
            ),
            (
                ACTIVE,
                ("Open_Palm", "Thumb_Down"),
                10,
                request(41, VoiceRequestGestureIntent::Mute),
            ),
            (
                ACTIVE,
                ("Open_Palm", "Thumb_Up"),
                15,
                request(41, VoiceRequestGestureIntent::Send),
            ),
            (
                ACTIVE_MUTED,
                ("Open_Palm", "Pointing_Up"),
                15,
                request(41, VoiceRequestGestureIntent::Unmute),
            ),
        ];

        for (state, (first, second), samples, expected) in cases {
            let mut harness = Harness::new(state);
            assert!(harness
                .drive(samples - 1, (first, 0.9), (second, 0.9))
                .is_empty());
            assert_eq!(harness.sample((first, 0.9), (second, 0.9)), Some(expected));
            assert_eq!(harness.control.state(), state);
            assert_eq!(harness.control.pending_intent(), Some(expected));
        }

        for (state, second, chord) in [
            (STANDBY, "Open_Palm", ControlChord::StartTranscription),
            (ACTIVE, "Victory", ControlChord::StopTranscription),
            (ACTIVE, "Thumb_Up", ControlChord::Send),
            (ACTIVE, "Thumb_Down", ControlChord::Mute),
            (ACTIVE_MUTED, "Pointing_Up", ControlChord::Unmute),
        ] {
            let mut below = Harness::new(state);
            assert!(below
                .drive(20, ("Open_Palm", 0.499), (second, 0.499))
                .is_empty());
            assert_eq!(
                below.control.diagnostic(),
                ControlDiagnostic::LowConfidence {
                    chord,
                    observed_percent: 49,
                    required_percent: 50,
                }
            );
        }
    }

    #[test]
    fn disabled_standby_and_active_accept_only_their_own_vocabulary() {
        let chords = [
            ("Open_Palm", "Open_Palm"),
            ("Open_Palm", "Victory"),
            ("Open_Palm", "Thumb_Up"),
            ("Open_Palm", "Thumb_Down"),
            ("Open_Palm", "Pointing_Up"),
        ];
        let mut disabled = Harness::new(DISABLED);
        for (first, second) in chords {
            assert!(disabled.drive(20, (first, 1.0), (second, 1.0)).is_empty());
        }

        let mut standby = Harness::new(STANDBY);
        for second in ["Victory", "Thumb_Up", "Thumb_Down", "Pointing_Up"] {
            assert!(standby
                .drive(20, ("Open_Palm", 1.0), (second, 1.0))
                .is_empty());
        }

        let mut active = Harness::new(ACTIVE);
        assert!(active
            .drive(20, ("Open_Palm", 1.0), ("Open_Palm", 1.0))
            .is_empty());
        let mut muted = Harness::new(ACTIVE_MUTED);
        assert!(muted
            .drive(20, ("Open_Palm", 1.0), ("Thumb_Down", 1.0))
            .is_empty());
        let mut unmuted = Harness::new(ACTIVE);
        assert!(unmuted
            .drive(20, ("Open_Palm", 1.0), ("Pointing_Up", 1.0))
            .is_empty());
    }

    #[test]
    fn pending_authority_serializes_all_intents_until_a_fresh_echo() {
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::StartTranscription]
        );

        for second in [
            "Open_Palm",
            "Victory",
            "Thumb_Up",
            "Thumb_Down",
            "Pointing_Up",
        ] {
            assert!(harness
                .drive(20, ("Open_Palm", 1.0), (second, 1.0))
                .is_empty());
            assert_eq!(
                harness.control.diagnostic(),
                ControlDiagnostic::AwaitingAuthority {
                    chord: ControlChord::StartTranscription,
                }
            );
            assert_eq!(harness.progress(), None);
        }

        harness.synchronize(DISABLED);
        assert_eq!(harness.control.pending_intent(), None);
        assert_eq!(harness.progress(), None);
    }

    #[test]
    fn rejected_start_requires_positive_release_and_tracking_loss_does_not_rearm() {
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::StartTranscription]
        );
        harness.synchronize(STANDBY);

        assert!(harness
            .drive(20, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
            .is_empty());
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::AwaitingRelease {
                chord: ControlChord::StartTranscription,
            }
        );

        harness.drive_empty(20);
        assert_eq!(harness.stale(("Victory", 1.0), ("Victory", 1.0)), None);
        assert_eq!(harness.sample(("unknown", 1.0), ("unknown", 1.0)), None);
        assert!(harness
            .drive(20, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
            .is_empty());

        harness.release();
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::StartTranscription]
        );
    }

    #[test]
    fn held_start_latch_survives_full_request_context_lifetime() {
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::StartTranscription]
        );

        for state in [
            DISABLED,
            ControlState::Active {
                voice_request_id: 77,
                muted: false,
            },
            DISABLED,
            STANDBY,
        ] {
            harness.synchronize(state);
            assert!(harness
                .drive(20, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
                .is_empty());
            assert_eq!(
                harness.control.diagnostic(),
                ControlDiagnostic::AwaitingRelease {
                    chord: ControlChord::StartTranscription,
                }
            );
        }

        harness.release();
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::StartTranscription]
        );
    }

    #[test]
    fn held_stop_cannot_loop_after_an_active_authority_echo() {
        let mut harness = Harness::new(ACTIVE);
        let stop = request(41, VoiceRequestGestureIntent::StopTranscription);
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Victory", 0.9)),
            [stop]
        );
        harness.synchronize(ACTIVE);
        assert!(harness
            .drive(20, ("Open_Palm", 0.9), ("Victory", 0.9))
            .is_empty());
        harness.drive_empty(20);
        assert!(harness
            .drive(20, ("Open_Palm", 0.9), ("Victory", 0.9))
            .is_empty());

        harness.release();
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Victory", 0.9)),
            [stop]
        );
    }

    #[test]
    fn a_release_observed_while_pending_is_retained_across_the_echo() {
        let mut harness = Harness::new(STANDBY);
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::StartTranscription]
        );
        harness.release();
        harness.synchronize(STANDBY);
        assert_eq!(
            harness.drive(14, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::StartTranscription]
        );
    }

    #[test]
    fn request_identity_is_captured_from_each_authoritative_active_context() {
        let mut harness = Harness::new(ControlState::Active {
            voice_request_id: 10,
            muted: false,
        });
        assert_eq!(
            harness.drive(15, ("Open_Palm", 0.9), ("Thumb_Up", 0.9)),
            [request(10, VoiceRequestGestureIntent::Send)]
        );

        harness.synchronize(ControlState::Active {
            voice_request_id: 11,
            muted: false,
        });
        harness.release();
        assert_eq!(
            harness.drive(15, ("Open_Palm", 0.9), ("Thumb_Up", 0.9)),
            [request(11, VoiceRequestGestureIntent::Send)]
        );
    }

    #[test]
    fn same_shaped_active_authority_echo_fences_old_evidence() {
        let mut harness = Harness::new(ACTIVE);
        assert!(harness
            .drive(10, ("Open_Palm", 0.9), ("Thumb_Up", 0.9))
            .is_empty());
        assert!(harness.progress().is_some());

        harness.synchronize(ACTIVE);
        assert_eq!(harness.progress(), None);
        assert!(harness
            .drive(14, ("Open_Palm", 0.9), ("Thumb_Up", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.9), ("Thumb_Up", 0.9)),
            Some(request(41, VoiceRequestGestureIntent::Send))
        );
    }

    #[test]
    fn send_is_nonterminal_and_an_unchanged_active_echo_reauthorizes_actions() {
        let mut harness = Harness::new(ACTIVE);
        let send = request(41, VoiceRequestGestureIntent::Send);
        assert_eq!(
            harness.drive(15, ("Open_Palm", 0.9), ("Thumb_Up", 0.9)),
            [send]
        );
        assert_eq!(harness.control.state(), ACTIVE);

        harness.synchronize(ACTIVE);
        assert_eq!(harness.control.state(), ACTIVE);
        harness.release();
        assert_eq!(
            harness.drive(15, ("Open_Palm", 0.9), ("Thumb_Up", 0.9)),
            [send]
        );
        assert_eq!(harness.control.state(), ACTIVE);
    }

    #[test]
    fn tracking_loss_clears_evidence_but_never_starts_or_stops() {
        let mut start = Harness::new(STANDBY);
        assert!(start
            .drive(5, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
            .is_empty());
        assert!(start.progress().is_some());
        start.drive_empty(50);
        assert_eq!(start.progress(), None);
        assert!(start
            .drive(7, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
            .is_empty());
        assert_eq!(
            start.sample(("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            Some(ControlIntent::StartTranscription)
        );

        let mut stop = Harness::new(ACTIVE);
        assert!(stop
            .drive(5, ("Open_Palm", 0.9), ("Victory", 0.9))
            .is_empty());
        stop.drive_empty(50);
        assert!(stop
            .drive(7, ("Open_Palm", 0.9), ("Victory", 0.9))
            .is_empty());
        assert_eq!(
            stop.sample(("Open_Palm", 0.9), ("Victory", 0.9)),
            Some(request(41, VoiceRequestGestureIntent::StopTranscription))
        );
    }

    #[test]
    fn gaps_invalid_order_and_unknown_tracking_fail_closed() {
        let mut harness = Harness::new(ACTIVE);
        assert!(harness
            .drive(5, ("Open_Palm", 0.9), ("Thumb_Down", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample_after(
                Duration::from_millis(251),
                ("Open_Palm", 0.9),
                ("Thumb_Down", 0.9),
            ),
            None
        );
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::SampleGap { gap_ms: 251 }
        );
        assert_eq!(harness.progress(), None);

        let captured_at = harness.start + harness.elapsed;
        let hands = [
            ControlHand::new("Open_Palm", 1.0),
            ControlHand::new("Thumb_Down", 1.0),
        ];
        assert_eq!(
            harness.control.observe(ControlSample {
                frame_sequence: harness.sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(20),
                hands: &hands,
            }),
            None
        );
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::InvalidOrder
        );
        assert_eq!(harness.control.state(), ACTIVE);
    }

    #[test]
    fn candidate_progress_is_aggregate_bounded_and_never_completes_before_intent() {
        let now = Instant::now();
        let mut control = GestureControl::new(STANDBY);
        let hands = [
            ControlHand::new("Open_Palm", 0.9),
            ControlHand::new("Open_Palm", 0.9),
        ];
        assert_eq!(
            control.observe(ControlSample {
                frame_sequence: 1,
                captured_at: now,
                observed_at: now + Duration::from_millis(20),
                hands: &hands,
            }),
            None
        );
        assert_eq!(
            control.progress(now),
            Some(ControlProgress {
                chord: ControlChord::StartTranscription,
                progress_permille: 0,
            })
        );
        assert!(control
            .progress(now)
            .is_some_and(|progress| progress.progress_permille < 1_000));
    }
}
