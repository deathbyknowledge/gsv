//! Pure temporal policy for two-hand voice controls.
//!
//! This module consumes only bounded MediaPipe label/score observations. It
//! owns no camera, window, IPC, or application action. In particular, missing
//! tracking is never interpreted as the release of an active hold.

use std::time::{Duration, Instant};

pub use gsv_vision_control::GestureState as ControlState;

const READY_ENTER_SCORE: f32 = 0.50;
const ACTION_ENTER_SCORE: f32 = 0.80;
const CONTINUE_SCORE: f32 = 0.65;
const MIN_SUPPORT_PERCENT: u16 = 80;
const MIN_STRONG_SAMPLES: u16 = 3;
const READY_DWELL: Duration = Duration::from_millis(350);
const HOLD_DWELL: Duration = Duration::from_millis(450);
const SEND_DWELL: Duration = Duration::from_millis(700);
const MAX_FRAME_AGE: Duration = Duration::from_millis(250);
const MAX_SAMPLE_GAP: Duration = Duration::from_millis(250);
const MAX_EVIDENCE_GAP: Duration = Duration::from_millis(180);
const READY_COMMAND_WINDOW: Duration = Duration::from_secs(3);
const MIN_INTENT_SPACING: Duration = Duration::from_millis(750);

/// A semantic request sent to the voice-session owner.
///
/// Hold changes are explicit rather than toggles. `Send` is a one-shot edge;
/// any transport must attach an identity and deduplicate it across retries.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlIntent {
    EngageAutoSendHold,
    ReleaseAutoSendHold,
    Send,
}

/// Fixed local-only vocabulary for explaining the temporal controller in the
/// diagnostic window. Its observation-derived counts, percentages, and
/// timings are bounded and quantized; labels, landmarks, and request IDs are
/// omitted, and the value never crosses GSV IPC or logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlChord {
    Ready,
    Hold,
    Send,
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
    diagnostic: ControlDiagnostic,
    candidate: Option<Candidate>,
    last_frame_sequence: Option<u64>,
    last_captured_at: Option<Instant>,
    last_ready_pose_at: Option<Instant>,
    last_supported_at: Option<Instant>,
    last_intent_at: Option<Instant>,
}

impl Default for GestureControl {
    fn default() -> Self {
        Self::new(false)
    }
}

impl GestureControl {
    /// Creates a controller synchronized with the voice owner's current hold.
    #[must_use]
    pub const fn new(auto_send_held: bool) -> Self {
        Self {
            state: if auto_send_held {
                ControlState::Holding
            } else {
                ControlState::NeedsReady
            },
            diagnostic: ControlDiagnostic::AwaitingPose,
            candidate: None,
            last_frame_sequence: None,
            last_captured_at: None,
            last_ready_pose_at: None,
            last_supported_at: None,
            last_intent_at: None,
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

    /// Re-synchronizes at an explicit voice-session boundary. This never emits
    /// a release; the voice-session owner remains authoritative for its state.
    pub fn reset(&mut self, auto_send_held: bool) {
        *self = Self::new(auto_send_held);
    }

    /// Reconciles an app-owned hold echo without discarding a locally reached
    /// READY state. A real mismatch still resets to the app's authority.
    pub fn synchronize_hold(&mut self, auto_send_held: bool) {
        if (self.state == ControlState::Holding) != auto_send_held {
            self.reset(auto_send_held);
        }
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
        if reading.is_some_and(|reading| reading.quality >= self.tracking_score(reading.chord)) {
            self.last_supported_at = Some(now);
        }
        if self.state == ControlState::Ready
            && reading.is_some_and(|reading| {
                reading.chord == Chord::Ready && reading.quality >= READY_ENTER_SCORE
            })
        {
            self.last_ready_pose_at = Some(now);
        }

        self.expire_ready(now);
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
            self.diagnostic = if self.state == ControlState::Ready && reading.chord == Chord::Ready
            {
                if reading.quality >= READY_ENTER_SCORE {
                    ControlDiagnostic::Accepted {
                        chord: ControlChord::Ready,
                    }
                } else {
                    ControlDiagnostic::LowConfidence {
                        chord: ControlChord::Ready,
                        observed_percent: score_percent(reading.quality),
                        required_percent: score_percent(READY_ENTER_SCORE),
                    }
                }
            } else {
                ControlDiagnostic::UnexpectedPose {
                    chord: reading.chord.into(),
                }
            };
        }

        let mut evidence_gap = None;

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
            (Some(candidate), _) => candidate.record_miss(),
            (None, Some((chord, quality, entry_score))) if quality >= entry_score => {
                self.candidate = Some(Candidate::new(chord, now));
            }
            (None, _) => {}
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

        let ready = self.candidate.as_ref().is_some_and(|candidate| {
            let current_is_strong = target.is_some_and(|(chord, quality, entry_score)| {
                chord == candidate.chord && quality >= entry_score
            });
            current_is_strong && candidate.is_stable(now)
        });
        if !ready {
            return None;
        }

        let chord = self.candidate.as_ref().map(|candidate| candidate.chord)?;
        let produces_intent = matches!(
            (self.state, chord),
            (ControlState::Ready, Chord::Hold | Chord::Send)
                | (ControlState::Holding, Chord::Ready)
        );
        if produces_intent && !self.cooldown_complete(now) {
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
        match (self.state, chord) {
            (ControlState::NeedsReady, Chord::Ready) => {
                self.state = ControlState::Ready;
                self.last_ready_pose_at = Some(now);
                self.last_supported_at = Some(now);
                None
            }
            (ControlState::Ready, Chord::Hold) => {
                self.state = ControlState::Holding;
                self.last_intent_at = Some(now);
                Some(ControlIntent::EngageAutoSendHold)
            }
            (ControlState::Ready, Chord::Send) => {
                self.state = ControlState::NeedsReady;
                self.last_ready_pose_at = None;
                self.last_supported_at = None;
                self.last_intent_at = Some(now);
                Some(ControlIntent::Send)
            }
            (ControlState::Holding, Chord::Ready) => {
                self.state = ControlState::Ready;
                self.last_ready_pose_at = Some(now);
                self.last_supported_at = Some(now);
                self.last_intent_at = Some(now);
                Some(ControlIntent::ReleaseAutoSendHold)
            }
            _ => None,
        }
    }

    fn accepted_target(&self, chord: Chord) -> bool {
        match self.state {
            ControlState::NeedsReady => chord == Chord::Ready,
            ControlState::Ready => matches!(chord, Chord::Hold | Chord::Send),
            ControlState::Holding => chord == Chord::Ready,
        }
    }

    fn entry_score(&self, chord: Chord) -> f32 {
        if self.state == ControlState::NeedsReady && chord == Chord::Ready {
            READY_ENTER_SCORE
        } else {
            ACTION_ENTER_SCORE
        }
    }

    fn tracking_score(&self, chord: Chord) -> f32 {
        if self.state != ControlState::Holding && chord == Chord::Ready {
            READY_ENTER_SCORE
        } else {
            CONTINUE_SCORE
        }
    }

    fn cooldown_complete(&self, now: Instant) -> bool {
        self.last_intent_at
            .is_none_or(|previous| now.saturating_duration_since(previous) >= MIN_INTENT_SPACING)
    }

    fn expire_ready(&mut self, now: Instant) {
        if self.state != ControlState::Ready {
            return;
        }
        let tracking_expired = self
            .last_supported_at
            .is_none_or(|last| now.saturating_duration_since(last) > MAX_SAMPLE_GAP);
        let command_window_expired = self
            .last_ready_pose_at
            .is_none_or(|last| now.saturating_duration_since(last) > READY_COMMAND_WINDOW);
        if tracking_expired || command_window_expired {
            self.state = ControlState::NeedsReady;
            self.last_ready_pose_at = None;
            self.last_supported_at = None;
        }
    }

    fn fence_tracking(&mut self) {
        self.candidate = None;
        if self.state == ControlState::Ready {
            self.state = ControlState::NeedsReady;
            self.last_ready_pose_at = None;
            self.last_supported_at = None;
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Pose {
    OpenPalm,
    ClosedFist,
    ThumbUp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Chord {
    Ready,
    Hold,
    Send,
}

impl From<Chord> for ControlChord {
    fn from(chord: Chord) -> Self {
        match chord {
            Chord::Ready => Self::Ready,
            Chord::Hold => Self::Hold,
            Chord::Send => Self::Send,
        }
    }
}

impl Chord {
    const fn dwell(self) -> Duration {
        match self {
            Self::Ready => READY_DWELL,
            Self::Hold => HOLD_DWELL,
            Self::Send => SEND_DWELL,
        }
    }

    const fn minimum_matches(self) -> u16 {
        match self {
            Self::Ready => 4,
            Self::Hold => 5,
            Self::Send => 7,
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
        (Pose::OpenPalm, Pose::OpenPalm) => Chord::Ready,
        (Pose::OpenPalm, Pose::ClosedFist) | (Pose::ClosedFist, Pose::OpenPalm) => Chord::Hold,
        (Pose::OpenPalm, Pose::ThumbUp) | (Pose::ThumbUp, Pose::OpenPalm) => Chord::Send,
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
        "Closed_Fist" => Some(Pose::ClosedFist),
        "Thumb_Up" => Some(Pose::ThumbUp),
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

    struct Harness {
        control: GestureControl,
        start: Instant,
        sequence: u64,
        elapsed: Duration,
    }

    impl Harness {
        fn new(held: bool) -> Self {
            Self {
                control: GestureControl::new(held),
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

        fn ready(&mut self) {
            assert!(self
                .drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
                .is_empty());
            assert_eq!(self.control.state(), ControlState::Ready);
        }

        fn progress(&self) -> Option<ControlProgress> {
            self.control.progress(self.start + self.elapsed)
        }
    }

    #[test]
    fn send_requires_ready_and_more_than_one_frame() {
        let mut harness = Harness::new(false);
        assert!(harness
            .drive(20, ("Open_Palm", 0.95), ("Thumb_Up", 0.95))
            .is_empty());
        assert_eq!(harness.control.state(), ControlState::NeedsReady);

        harness.ready();
        assert_eq!(
            harness.sample(("Open_Palm", 0.95), ("Thumb_Up", 0.95)),
            None
        );
        assert_eq!(harness.control.state(), ControlState::Ready);
    }

    #[test]
    fn initial_ready_pose_uses_a_lower_non_action_threshold() {
        let mut below = Harness::new(false);
        assert!(below
            .drive(20, ("Open_Palm", 0.49), ("Open_Palm", 0.49))
            .is_empty());
        assert_eq!(below.control.state(), ControlState::NeedsReady);
        assert_eq!(
            below.control.diagnostic(),
            ControlDiagnostic::LowConfidence {
                chord: ControlChord::Ready,
                observed_percent: 49,
                required_percent: 50,
            }
        );

        let mut boundary = Harness::new(false);
        assert!(boundary
            .drive(8, ("Open_Palm", 0.50), ("Open_Palm", 0.50))
            .is_empty());
        assert_eq!(boundary.control.state(), ControlState::Ready);
        assert_eq!(
            boundary.control.diagnostic(),
            ControlDiagnostic::Accepted {
                chord: ControlChord::Ready,
            }
        );

        assert!(boundary
            .drive(70, ("Open_Palm", 0.50), ("Open_Palm", 0.50))
            .is_empty());
        assert_eq!(boundary.control.state(), ControlState::Ready);
        assert_eq!(
            boundary.control.diagnostic(),
            ControlDiagnostic::Accepted {
                chord: ControlChord::Ready,
            }
        );
    }

    #[test]
    fn progress_uses_the_complete_candidate_evidence_gate() {
        let mut harness = Harness::new(false);
        assert_eq!(harness.sample(("Open_Palm", 0.9), ("Open_Palm", 0.9)), None);
        assert_eq!(
            harness.progress(),
            Some(ControlProgress {
                chord: ControlChord::Ready,
                progress_permille: 0,
            })
        );

        assert_eq!(harness.sample(("Open_Palm", 0.9), ("Open_Palm", 0.9)), None);
        assert_eq!(
            harness.progress(),
            Some(ControlProgress {
                chord: ControlChord::Ready,
                progress_permille: 142,
            })
        );
    }

    #[test]
    fn aggregate_complete_weak_sample_stays_pending_below_full() {
        let mut harness = Harness::new(false);
        harness.ready();
        assert!(harness
            .drive(9, ("Open_Palm", 0.9), ("Closed_Fist", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.70), ("Closed_Fist", 0.70)),
            None
        );
        assert_eq!(harness.control.state(), ControlState::Ready);
        assert_eq!(
            harness.progress(),
            Some(ControlProgress {
                chord: ControlChord::Hold,
                progress_permille: 999,
            })
        );

        assert_eq!(
            harness.sample(("Open_Palm", 0.80), ("Closed_Fist", 0.80)),
            Some(ControlIntent::EngageAutoSendHold)
        );
        assert_eq!(harness.control.state(), ControlState::Holding);
        assert_eq!(harness.progress(), None);
    }

    #[test]
    fn lower_ready_threshold_does_not_weaken_commands_or_release() {
        for command in ["Closed_Fist", "Thumb_Up"] {
            let mut harness = Harness::new(false);
            harness.ready();
            assert!(harness
                .drive(20, ("Open_Palm", 0.70), (command, 0.70))
                .is_empty());
            assert_eq!(harness.control.state(), ControlState::Ready);
            assert_eq!(
                harness.control.diagnostic(),
                ControlDiagnostic::LowConfidence {
                    chord: if command == "Closed_Fist" {
                        ControlChord::Hold
                    } else {
                        ControlChord::Send
                    },
                    observed_percent: 70,
                    required_percent: 80,
                }
            );
        }

        let mut held = Harness::new(true);
        assert!(held
            .drive(20, ("Open_Palm", 0.70), ("Open_Palm", 0.70))
            .is_empty());
        assert_eq!(held.control.state(), ControlState::Holding);
        assert_eq!(
            held.control.diagnostic(),
            ControlDiagnostic::LowConfidence {
                chord: ControlChord::Ready,
                observed_percent: 70,
                required_percent: 80,
            }
        );
    }

    #[test]
    fn diagnostics_do_not_round_subthreshold_action_confidence_up() {
        let mut harness = Harness::new(false);
        harness.ready();
        assert_eq!(
            harness.sample(("Open_Palm", 0.795), ("Closed_Fist", 0.795)),
            None
        );
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::LowConfidence {
                chord: ControlChord::Hold,
                observed_percent: 79,
                required_percent: 80,
            }
        );
    }

    #[test]
    fn diagnostic_identifies_an_evidence_cadence_gap() {
        let mut harness = Harness::new(false);
        assert_eq!(harness.sample(("Open_Palm", 0.9), ("Open_Palm", 0.9)), None);
        assert_eq!(
            harness.sample_after(
                Duration::from_millis(181),
                ("Open_Palm", 0.9),
                ("Open_Palm", 0.9),
            ),
            None
        );
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::EvidenceGap { gap_ms: 181 }
        );
    }

    #[test]
    fn stable_send_emits_once_and_disarms() {
        let mut harness = Harness::new(false);
        harness.ready();
        let intents = harness.drive(16, ("Thumb_Up", 0.9), ("Open_Palm", 0.9));
        assert_eq!(intents, [ControlIntent::Send]);
        assert_eq!(harness.control.state(), ControlState::NeedsReady);
        assert!(harness
            .drive(20, ("Thumb_Up", 0.9), ("Open_Palm", 0.9))
            .is_empty());
    }

    #[test]
    fn changing_candidates_cannot_extend_the_ready_window() {
        let mut harness = Harness::new(false);
        harness.ready();

        for index in 0..70 {
            let command = if index % 2 == 0 {
                "Closed_Fist"
            } else {
                "Thumb_Up"
            };
            assert_eq!(harness.sample(("Open_Palm", 0.95), (command, 0.95)), None);
        }

        assert_eq!(harness.control.state(), ControlState::NeedsReady);
        assert!(harness
            .drive(20, ("Open_Palm", 0.95), ("Thumb_Up", 0.95))
            .is_empty());
    }

    #[test]
    fn hold_survives_tracking_loss_and_needs_visible_release() {
        let mut harness = Harness::new(false);
        harness.ready();
        assert_eq!(
            harness.drive(10, ("Open_Palm", 0.9), ("Closed_Fist", 0.9)),
            [ControlIntent::EngageAutoSendHold]
        );
        assert_eq!(harness.control.state(), ControlState::Holding);

        for _ in 0..30 {
            assert_eq!(harness.empty(), None);
        }
        assert_eq!(harness.control.state(), ControlState::Holding);
        assert!(harness
            .drive(20, ("Open_Palm", 0.4), ("Open_Palm", 0.4))
            .is_empty());
        assert_eq!(harness.control.state(), ControlState::Holding);

        assert_eq!(
            harness.drive(16, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::ReleaseAutoSendHold]
        );
        assert_eq!(harness.control.state(), ControlState::Ready);
    }

    #[test]
    fn send_is_unavailable_while_hold_is_active() {
        let mut harness = Harness::new(true);
        assert!(harness
            .drive(30, ("Open_Palm", 0.99), ("Thumb_Up", 0.99))
            .is_empty());
        assert_eq!(harness.control.state(), ControlState::Holding);
    }

    #[test]
    fn one_noisy_frame_does_not_arm_hold_or_send() {
        for command in ["Closed_Fist", "Thumb_Up"] {
            let mut harness = Harness::new(false);
            harness.ready();
            assert_eq!(harness.sample(("Open_Palm", 1.0), (command, 1.0)), None);
            assert!(harness
                .drive(8, ("Victory", 1.0), ("Victory", 1.0))
                .is_empty());
            assert_eq!(harness.control.state(), ControlState::NeedsReady);
        }
    }

    #[test]
    fn a_short_weak_dip_is_tolerated_but_cannot_finish_evidence() {
        let mut harness = Harness::new(false);
        harness.ready();
        assert!(harness
            .drive(5, ("Open_Palm", 0.9), ("Closed_Fist", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample(("Open_Palm", 0.7), ("Closed_Fist", 0.7)),
            None
        );
        assert!(harness
            .drive(2, ("Open_Palm", 0.9), ("Closed_Fist", 0.9))
            .is_empty());
        assert_eq!(
            harness.drive(2, ("Open_Palm", 0.9), ("Closed_Fist", 0.9)),
            [ControlIntent::EngageAutoSendHold]
        );
    }

    #[test]
    fn a_capture_gap_resets_evidence() {
        let mut harness = Harness::new(false);
        assert!(harness
            .drive(6, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
            .is_empty());
        assert_eq!(
            harness.sample_after(
                Duration::from_millis(300),
                ("Open_Palm", 0.9),
                ("Open_Palm", 0.9),
            ),
            None
        );
        assert_eq!(harness.control.state(), ControlState::NeedsReady);
        assert!(harness
            .drive(6, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
            .is_empty());
        assert_eq!(harness.control.state(), ControlState::NeedsReady);
        assert!(harness
            .drive(2, ("Open_Palm", 0.9), ("Open_Palm", 0.9))
            .is_empty());
        assert_eq!(harness.control.state(), ControlState::Ready);
    }

    #[test]
    fn stale_observations_fail_closed_without_releasing_hold() {
        let mut harness = Harness::new(true);
        harness.sequence += 1;
        harness.elapsed += STEP;
        let captured_at = harness.start + harness.elapsed;
        let hands = [
            ControlHand::new("Open_Palm", 1.0),
            ControlHand::new("Open_Palm", 1.0),
        ];
        assert_eq!(
            harness.control.observe(ControlSample {
                frame_sequence: harness.sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(251),
                hands: &hands,
            }),
            None
        );
        assert_eq!(harness.control.state(), ControlState::Holding);
    }

    #[test]
    fn labels_are_exact_and_hand_order_is_irrelevant() {
        let mut harness = Harness::new(false);
        assert!(harness
            .drive(20, ("open_palm", 1.0), ("Open_Palm", 1.0))
            .is_empty());
        assert_eq!(harness.control.state(), ControlState::NeedsReady);

        harness.ready();
        assert_eq!(
            harness.drive(10, ("Closed_Fist", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::EngageAutoSendHold]
        );
    }

    #[test]
    fn reset_synchronizes_hold_without_synthesizing_an_intent() {
        let mut control = GestureControl::default();
        control.reset(true);
        assert_eq!(control.state(), ControlState::Holding);
        control.reset(false);
        assert_eq!(control.state(), ControlState::NeedsReady);
    }

    #[test]
    fn matching_release_echo_preserves_the_locally_rearmed_state() {
        let mut harness = Harness::new(true);
        assert_eq!(
            harness.drive(8, ("Open_Palm", 0.9), ("Open_Palm", 0.9)),
            [ControlIntent::ReleaseAutoSendHold]
        );
        assert_eq!(harness.control.state(), ControlState::Ready);

        harness.control.synchronize_hold(false);

        assert_eq!(harness.control.state(), ControlState::Ready);
    }
}
