//! Pure temporal policy for two-hand voice controls.
//!
//! This module consumes only bounded MediaPipe label/score observations. It
//! owns no camera, window, IPC, or application action. Missing tracking clears
//! temporal evidence but never changes Desktop-owned armed or muted state.

use std::time::{Duration, Instant};

pub use gsv_vision_control::GestureState as ControlState;

const ARM_ENTER_SCORE: f32 = 0.50;
const ACTION_ENTER_SCORE: f32 = 0.50;
const CONTINUE_SCORE: f32 = 0.50;
const MIN_SUPPORT_PERCENT: u16 = 80;
const MIN_STRONG_SAMPLES: u16 = 3;
const ARM_DWELL: Duration = Duration::from_millis(350);
const DISARM_DWELL: Duration = Duration::from_millis(350);
const SEND_DWELL: Duration = Duration::from_millis(700);
const MUTE_DWELL: Duration = Duration::from_millis(450);
const UNMUTE_DWELL: Duration = Duration::from_millis(700);
const MAX_FRAME_AGE: Duration = Duration::from_millis(250);
const MAX_SAMPLE_GAP: Duration = Duration::from_millis(250);
const MAX_EVIDENCE_GAP: Duration = Duration::from_millis(180);
const MIN_INTENT_SPACING: Duration = Duration::from_millis(750);

/// A semantic request sent to the voice-session owner.
///
/// Every state change is explicit rather than a toggle. `Send` is a one-shot
/// edge; transport attaches request/session identity and deduplicates retries.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlIntent {
    Arm,
    Disarm,
    Send,
    Mute,
    Unmute,
}

/// Fixed local-only vocabulary for explaining the temporal controller in the
/// diagnostic window. Its observation-derived counts, percentages, and
/// timings are bounded and quantized; labels, landmarks, and request IDs are
/// omitted, and the value never crosses GSV IPC or logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlChord {
    Arm,
    Disarm,
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
    diagnostic: ControlDiagnostic,
    candidate: Option<Candidate>,
    last_frame_sequence: Option<u64>,
    last_captured_at: Option<Instant>,
    last_intent_at: Option<Instant>,
}

impl Default for GestureControl {
    fn default() -> Self {
        Self::new(ControlState::new(false, false))
    }
}

impl GestureControl {
    /// Creates a controller synchronized with Desktop's absolute state echo.
    #[must_use]
    pub const fn new(state: ControlState) -> Self {
        Self {
            state,
            pending: None,
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

    /// Re-synchronizes at an explicit voice-session boundary.
    pub fn reset(&mut self, state: ControlState) {
        *self = Self::new(state);
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

        if let Some(intent) = self.pending {
            self.candidate = None;
            self.diagnostic = ControlDiagnostic::AwaitingAuthority {
                chord: intent.into(),
            };
            return None;
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
        let intent = ControlIntent::from(chord);
        self.pending = Some(intent);
        self.last_intent_at = Some(now);
        Some(intent)
    }

    fn accepted_target(&self, chord: Chord) -> bool {
        match chord {
            Chord::Arm => !self.state.armed(),
            Chord::Disarm | Chord::Send => self.state.armed(),
            Chord::Mute => self.state.armed() && !self.state.muted(),
            Chord::Unmute => self.state.armed() && self.state.muted(),
        }
    }

    fn target_is_satisfied(&self, chord: Chord) -> bool {
        match chord {
            Chord::Arm => self.state.armed(),
            Chord::Disarm => !self.state.armed(),
            Chord::Mute => self.state.muted(),
            Chord::Unmute => !self.state.muted(),
            Chord::Send => false,
        }
    }

    const fn entry_score(&self, chord: Chord) -> f32 {
        if matches!(chord, Chord::Arm) {
            ARM_ENTER_SCORE
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
    PointingUp,
    ThumbDown,
    ThumbUp,
    Victory,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Chord {
    Arm,
    Disarm,
    Send,
    Mute,
    Unmute,
}

impl From<Chord> for ControlChord {
    fn from(chord: Chord) -> Self {
        match chord {
            Chord::Arm => Self::Arm,
            Chord::Disarm => Self::Disarm,
            Chord::Send => Self::Send,
            Chord::Mute => Self::Mute,
            Chord::Unmute => Self::Unmute,
        }
    }
}

impl From<Chord> for ControlIntent {
    fn from(chord: Chord) -> Self {
        match chord {
            Chord::Arm => Self::Arm,
            Chord::Disarm => Self::Disarm,
            Chord::Send => Self::Send,
            Chord::Mute => Self::Mute,
            Chord::Unmute => Self::Unmute,
        }
    }
}

impl From<ControlIntent> for ControlChord {
    fn from(intent: ControlIntent) -> Self {
        match intent {
            ControlIntent::Arm => Self::Arm,
            ControlIntent::Disarm => Self::Disarm,
            ControlIntent::Send => Self::Send,
            ControlIntent::Mute => Self::Mute,
            ControlIntent::Unmute => Self::Unmute,
        }
    }
}

impl Chord {
    const fn dwell(self) -> Duration {
        match self {
            Self::Arm => ARM_DWELL,
            Self::Disarm => DISARM_DWELL,
            Self::Send => SEND_DWELL,
            Self::Mute => MUTE_DWELL,
            Self::Unmute => UNMUTE_DWELL,
        }
    }

    const fn minimum_matches(self) -> u16 {
        match self {
            Self::Arm | Self::Disarm => 4,
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
    let chord = match (first_pose, second_pose) {
        (Pose::OpenPalm, Pose::OpenPalm) => Chord::Arm,
        (Pose::OpenPalm, Pose::Victory) | (Pose::Victory, Pose::OpenPalm) => Chord::Disarm,
        (Pose::OpenPalm, Pose::ThumbUp) | (Pose::ThumbUp, Pose::OpenPalm) => Chord::Send,
        (Pose::OpenPalm, Pose::ThumbDown) | (Pose::ThumbDown, Pose::OpenPalm) => Chord::Mute,
        (Pose::OpenPalm, Pose::PointingUp) | (Pose::PointingUp, Pose::OpenPalm) => Chord::Unmute,
        _ => return Err(ClassificationFailure::UnsupportedPose),
    };
    Ok(ChordReading {
        chord,
        quality: first.score.min(second.score),
    })
}

fn parse_pose(label: &str) -> Option<Pose> {
    match label {
        "Open_Palm" => Some(Pose::OpenPalm),
        "Pointing_Up" => Some(Pose::PointingUp),
        "Thumb_Down" => Some(Pose::ThumbDown),
        "Thumb_Up" => Some(Pose::ThumbUp),
        "Victory" => Some(Pose::Victory),
        _ => None,
    }
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
    const DISARMED: ControlState = ControlState::new(false, false);
    const ARMED: ControlState = ControlState::new(true, false);
    const ARMED_MUTED: ControlState = ControlState::new(true, true);

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
            self.empty_after(STEP)
        }

        fn empty_after(&mut self, step: Duration) -> Option<ControlIntent> {
            self.sequence += 1;
            self.elapsed += step;
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
    }

    #[test]
    fn exact_unordered_canned_grammar_is_closed() {
        let cases = [
            (("Open_Palm", "Open_Palm"), Chord::Arm),
            (("Open_Palm", "Victory"), Chord::Disarm),
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
            (DISARMED, ("Open_Palm", "Open_Palm"), 8, ControlIntent::Arm),
            (ARMED, ("Open_Palm", "Victory"), 8, ControlIntent::Disarm),
            (ARMED, ("Open_Palm", "Thumb_Down"), 10, ControlIntent::Mute),
            (ARMED, ("Open_Palm", "Thumb_Up"), 15, ControlIntent::Send),
            (
                ARMED_MUTED,
                ("Open_Palm", "Pointing_Up"),
                15,
                ControlIntent::Unmute,
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

        let mut arm = Harness::new(DISARMED);
        assert!(arm
            .drive(20, ("Open_Palm", 0.49), ("Open_Palm", 0.49))
            .is_empty());
        assert_eq!(
            arm.control.diagnostic(),
            ControlDiagnostic::LowConfidence {
                chord: ControlChord::Arm,
                observed_percent: 49,
                required_percent: 50,
            }
        );
        let mut arm_boundary = Harness::new(DISARMED);
        assert_eq!(
            arm_boundary.drive(8, ("Open_Palm", 0.50), ("Open_Palm", 0.50)),
            [ControlIntent::Arm]
        );

        for (state, second, chord, expected) in [
            (
                ARMED,
                "Victory",
                ControlChord::Disarm,
                ControlIntent::Disarm,
            ),
            (ARMED, "Thumb_Up", ControlChord::Send, ControlIntent::Send),
            (ARMED, "Thumb_Down", ControlChord::Mute, ControlIntent::Mute),
            (
                ARMED_MUTED,
                "Pointing_Up",
                ControlChord::Unmute,
                ControlIntent::Unmute,
            ),
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

            let mut boundary = Harness::new(state);
            let samples = match expected {
                ControlIntent::Arm | ControlIntent::Disarm => 8,
                ControlIntent::Mute => 10,
                ControlIntent::Send | ControlIntent::Unmute => 15,
            };
            assert_eq!(
                boundary.drive(samples, ("Open_Palm", 0.50), (second, 0.50)),
                [expected]
            );
        }
    }

    #[test]
    fn intent_waits_for_absolute_authority_echo_and_blocks_every_chord() {
        let mut harness = Harness::new(DISARMED);
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::Arm]
        );
        assert_eq!(harness.control.state(), DISARMED);

        for second in ["Victory", "Thumb_Up", "Thumb_Down", "Pointing_Up"] {
            assert!(harness
                .drive(20, ("Open_Palm", 1.0), (second, 1.0))
                .is_empty());
            assert_eq!(
                harness.control.diagnostic(),
                ControlDiagnostic::AwaitingAuthority {
                    chord: ControlChord::Arm,
                }
            );
            assert_eq!(harness.progress(), None);
        }

        harness.control.synchronize_state(ARMED);
        assert_eq!(harness.control.state(), ARMED);
        assert_eq!(harness.control.pending_intent(), None);
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::AwaitingPose
        );
    }

    #[test]
    fn authoritative_rejection_clears_pending_and_old_evidence() {
        let mut harness = Harness::new(DISARMED);
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::Arm]
        );
        harness.control.synchronize_state(DISARMED);
        assert_eq!(harness.control.pending_intent(), None);
        assert_eq!(harness.progress(), None);

        harness.drive_empty(8);
        assert!(harness
            .drive(7, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            Some(ControlIntent::Arm)
        );
    }

    #[test]
    fn tracking_loss_clears_only_candidate_and_never_persistent_state() {
        for state in [ARMED, ARMED_MUTED] {
            let mut harness = Harness::new(state);
            assert!(harness
                .drive(5, ("Open_Palm", 0.9), ("Thumb_Up", 0.9))
                .is_empty());
            assert!(harness.progress().is_some());

            harness.drive_empty(100);
            assert_eq!(harness.control.state(), state);
            assert_eq!(harness.progress(), None);

            assert_eq!(harness.empty_after(Duration::from_millis(251)), None);
            assert_eq!(harness.control.state(), state);
            assert_eq!(
                harness.control.diagnostic(),
                ControlDiagnostic::SampleGap { gap_ms: 251 }
            );

            assert_eq!(harness.stale(("Open_Palm", 0.9), ("Thumb_Up", 0.9)), None);
            assert_eq!(harness.control.state(), state);
            assert_eq!(
                harness.control.diagnostic(),
                ControlDiagnostic::FrameTooOld { age_ms: 251 }
            );
        }
    }

    #[test]
    fn one_missing_frame_requires_complete_fresh_dwell() {
        let mut harness = Harness::new(ARMED);
        assert!(harness
            .drive(5, ("Open_Palm", 0.9), ("Thumb_Down", 0.9))
            .is_empty());
        assert!(harness.progress().is_some());

        assert_eq!(harness.empty(), None);
        assert_eq!(harness.progress(), None);

        assert!(harness
            .drive(9, ("Open_Palm", 0.9), ("Thumb_Down", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.9), ("Thumb_Down", 0.9)),
            Some(ControlIntent::Mute)
        );
    }

    #[test]
    fn unrecognized_frame_requires_complete_fresh_dwell() {
        let mut harness = Harness::new(ARMED);
        assert!(harness
            .drive(6, ("Open_Palm", 0.9), ("Victory", 0.9))
            .is_empty());
        assert!(harness.progress().is_some());

        assert_eq!(
            harness.sample(("Open_Palm", 1.0), ("Closed_Fist", 1.0)),
            None
        );
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::UnsupportedPose
        );
        assert_eq!(harness.progress(), None);

        assert!(harness
            .drive(7, ("Open_Palm", 0.9), ("Victory", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.9), ("Victory", 0.9)),
            Some(ControlIntent::Disarm)
        );
    }

    #[test]
    fn different_chord_cannot_bridge_old_evidence() {
        let mut harness = Harness::new(ARMED);
        assert!(harness
            .drive(5, ("Open_Palm", 0.9), ("Thumb_Down", 0.9))
            .is_empty());

        assert_eq!(harness.sample(("Open_Palm", 0.9), ("Thumb_Up", 0.9)), None);
        assert_eq!(
            harness.progress(),
            Some(ControlProgress {
                chord: ControlChord::Send,
                progress_permille: 0,
            })
        );

        assert!(harness
            .drive(9, ("Open_Palm", 0.9), ("Thumb_Down", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.9), ("Thumb_Down", 0.9)),
            Some(ControlIntent::Mute)
        );
    }

    #[test]
    fn same_chord_continuation_accepts_the_fifty_percent_boundary() {
        let mut harness = Harness::new(ARMED);
        assert!(harness
            .drive(5, ("Open_Palm", 0.9), ("Thumb_Down", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.50), ("Thumb_Down", 0.50)),
            None
        );
        assert!(harness.progress().is_some());
        assert!(harness
            .drive(3, ("Open_Palm", 0.9), ("Thumb_Down", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.9), ("Thumb_Down", 0.9)),
            Some(ControlIntent::Mute)
        );
    }

    #[test]
    fn evidence_gap_restarts_candidate_without_weakening_capture_fence() {
        let mut harness = Harness::new(ARMED);
        assert_eq!(harness.sample(("Open_Palm", 0.9), ("Victory", 0.9)), None);
        assert_eq!(
            harness.sample_after(
                Duration::from_millis(181),
                ("Open_Palm", 0.9),
                ("Victory", 0.9),
            ),
            None
        );
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::EvidenceGap { gap_ms: 181 }
        );
        assert!(harness
            .drive(6, ("Open_Palm", 0.9), ("Victory", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.9), ("Victory", 0.9)),
            Some(ControlIntent::Disarm)
        );

        let mut capture_gap = Harness::new(ARMED);
        assert!(capture_gap
            .drive(5, ("Open_Palm", 0.9), ("Thumb_Down", 0.9))
            .is_empty());
        assert_eq!(
            capture_gap.sample_after(
                Duration::from_millis(251),
                ("Open_Palm", 0.9),
                ("Thumb_Down", 0.9),
            ),
            None
        );
        assert_eq!(capture_gap.control.state(), ARMED);
        assert_eq!(capture_gap.progress(), None);
        assert_eq!(
            capture_gap.control.diagnostic(),
            ControlDiagnostic::SampleGap { gap_ms: 251 }
        );
    }

    #[test]
    fn idempotent_state_commands_are_not_candidates() {
        for (state, second, expected_chord) in [
            (ARMED, "Open_Palm", ControlChord::Arm),
            (DISARMED, "Victory", ControlChord::Disarm),
            (ARMED_MUTED, "Thumb_Down", ControlChord::Mute),
            (ARMED, "Pointing_Up", ControlChord::Unmute),
        ] {
            let mut harness = Harness::new(state);
            assert!(harness
                .drive(20, ("Open_Palm", 1.0), (second, 1.0))
                .is_empty());
            assert_eq!(harness.progress(), None);
            assert_eq!(
                harness.control.diagnostic(),
                ControlDiagnostic::AlreadySatisfied {
                    chord: expected_chord,
                }
            );
        }

        let mut disarmed_send = Harness::new(DISARMED);
        assert!(disarmed_send
            .drive(20, ("Open_Palm", 1.0), ("Thumb_Up", 1.0))
            .is_empty());
        assert_eq!(
            disarmed_send.control.diagnostic(),
            ControlDiagnostic::UnexpectedPose {
                chord: ControlChord::Send,
            }
        );
    }

    #[test]
    fn hand_count_scores_and_order_fail_closed_without_state_mutation() {
        let now = Instant::now();
        let mut control = GestureControl::new(ARMED_MUTED);
        let one = [ControlHand::new("Open_Palm", 1.0)];
        assert_eq!(
            control.observe(ControlSample {
                frame_sequence: 1,
                captured_at: now,
                observed_at: now + Duration::from_millis(20),
                hands: &one,
            }),
            None
        );
        assert_eq!(
            control.diagnostic(),
            ControlDiagnostic::NeedTwoHands { detected: 1 }
        );

        let invalid = [
            ControlHand::new("Open_Palm", f32::NAN),
            ControlHand::new("Pointing_Up", 1.0),
        ];
        assert_eq!(
            control.observe(ControlSample {
                frame_sequence: 2,
                captured_at: now + STEP,
                observed_at: now + STEP + Duration::from_millis(20),
                hands: &invalid,
            }),
            None
        );
        assert_eq!(control.diagnostic(), ControlDiagnostic::InvalidScore);

        assert_eq!(
            control.observe(ControlSample {
                frame_sequence: 2,
                captured_at: now + STEP,
                observed_at: now + STEP + Duration::from_millis(20),
                hands: &invalid,
            }),
            None
        );
        assert_eq!(control.diagnostic(), ControlDiagnostic::InvalidOrder);
        assert_eq!(control.state(), ARMED_MUTED);
    }

    #[test]
    fn reset_is_an_absolute_request_boundary_without_synthetic_intent() {
        let mut harness = Harness::new(ARMED);
        assert!(harness
            .drive(5, ("Open_Palm", 0.9), ("Thumb_Up", 0.9))
            .is_empty());
        harness.control.reset(ARMED_MUTED);
        assert_eq!(harness.control.state(), ARMED_MUTED);
        assert_eq!(harness.control.pending_intent(), None);
        assert_eq!(harness.progress(), None);
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::AwaitingPose
        );
    }
}
