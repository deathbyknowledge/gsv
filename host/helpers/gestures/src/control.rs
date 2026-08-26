//! Pure temporal policy for armed voice controls.
//!
//! Two fists deliberately arm or disarm control. While armed, the action hand
//! opens fingers sequentially from one through five to select an action, then
//! returns to a fist to rearm. This module owns no camera, window, IPC, or
//! application action.
//!
//! For scrolling, an open control hand acts as the modifier while the angle
//! between its palm center and the action fist supplies continuous velocity.

use std::time::{Duration, Instant};

pub use gesture_protocol::{
    GestureContext as ControlState, GestureIntent as ControlIntent, ScrollState,
};
use gesture_protocol::{VoiceRequestGestureIntent, MAX_SCROLL_VELOCITY_MILLIUNITS};

use crate::observation::{HandObservation, HandPose, Handedness};

const ENTER_SCORE: f32 = 0.50;
const CONTINUE_SCORE: f32 = 0.50;
const MIN_SUPPORT_PERCENT: u16 = 80;
const MIN_STRONG_SAMPLES: u16 = 3;
const STANDARD_DWELL: Duration = Duration::from_millis(350);
const ARM_DWELL: Duration = Duration::from_millis(700);
const CLEAR_DWELL: Duration = Duration::from_millis(1_000);
const MAX_FRAME_AGE: Duration = Duration::from_millis(250);
const MAX_SAMPLE_GAP: Duration = Duration::from_millis(250);
const MAX_EVIDENCE_GAP: Duration = Duration::from_millis(180);
const MIN_HANDEDNESS_SCORE: f32 = 0.72;
const MIN_POSE_SCORE: f32 = 0.50;
const SCROLL_SETTLE_DWELL: Duration = Duration::from_millis(180);
const SCROLL_TRACKING_GRACE: Duration = Duration::from_millis(180);
const SCROLL_MIN_SETTLE_MATCHES: u16 = 4;
const SCROLL_SETTLE_DRIFT_RADIANS: f32 = 4.0 * std::f32::consts::PI / 180.0;
const SCROLL_RADIANS_PER_VELOCITY_UNIT: f32 = 20.0 * std::f32::consts::PI / 180.0;
const MIN_SCROLL_HORIZONTAL_SPAN_PALMS: f32 = 1.25;
const MIN_PALM_SCALE: f32 = 0.01;

/// Fixed local-only vocabulary for explaining the temporal controller in the
/// diagnostic window. Its observation-derived counts, percentages, and
/// timings are bounded and quantized; labels, landmarks, and request IDs are
/// omitted, and the value never crosses GSV IPC or logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlChord {
    Arm,
    Disarm,
    StartTranscription,
    StopTranscription,
    Send,
    DeleteBackward,
    ClearDictation,
    Mute,
    Unmute,
    Scroll,
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
    NeedActionHand,
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
    pub palm_x: f32,
    pub palm_y: f32,
    pub palm_scale: f32,
}

impl ControlHand {
    #[must_use]
    pub fn from_observation(hand: &HandObservation, frame_aspect_ratio: f32) -> Self {
        let wrist = hand.landmarks[0];
        let index_mcp = hand.landmarks[5];
        let middle_mcp = hand.landmarks[9];
        let ring_mcp = hand.landmarks[13];
        let pinky_mcp = hand.landmarks[17];
        let palm_x = (wrist.x + index_mcp.x + middle_mcp.x + ring_mcp.x + pinky_mcp.x) / 5.0;
        let palm_y = (wrist.y + index_mcp.y + middle_mcp.y + ring_mcp.y + pinky_mcp.y) / 5.0;
        let palm_width = distance(
            index_mcp.x * frame_aspect_ratio,
            index_mcp.y,
            pinky_mcp.x * frame_aspect_ratio,
            pinky_mcp.y,
        );
        let palm_length = distance(
            wrist.x * frame_aspect_ratio,
            wrist.y,
            middle_mcp.x * frame_aspect_ratio,
            middle_mcp.y,
        );
        Self {
            handedness: hand.handedness,
            handedness_score: hand.handedness_score,
            pose: hand.pose,
            score: hand.pose_score,
            palm_x,
            palm_y,
            palm_scale: max_f32(palm_width, palm_length),
        }
    }

    #[cfg(test)]
    pub(crate) const fn test(handedness: Handedness, pose: HandPose, score: f32) -> Self {
        let palm_x = match handedness {
            Handedness::Left => 0.30,
            Handedness::Right => 0.70,
            Handedness::Unknown => 0.50,
        };
        Self::test_at(handedness, pose, score, palm_x, 0.5, 0.2)
    }

    #[cfg(test)]
    pub(crate) const fn test_at(
        handedness: Handedness,
        pose: HandPose,
        score: f32,
        palm_x: f32,
        palm_y: f32,
        palm_scale: f32,
    ) -> Self {
        Self {
            handedness,
            handedness_score: 0.95,
            pose,
            score,
            palm_x,
            palm_y,
            palm_scale,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ControlSample<'a> {
    pub frame_sequence: u64,
    pub captured_at: Instant,
    pub observed_at: Instant,
    pub frame_aspect_ratio: f32,
    pub hands: &'a [ControlHand],
}

/// Deterministic, allocation-free recognition of the two-hand scroll chord.
///
/// The control palm must remain open while the action fist settles and changes
/// their inter-hand angle. State is absolute so replace-latest transport can
/// coalesce camera frames without losing or replaying relative scroll deltas.
pub struct ScrollControl {
    authority: ControlState,
    state: ScrollState,
    anchor: Option<ScrollAnchor>,
    last_chord_at: Option<Instant>,
    last_frame_sequence: Option<u64>,
    last_captured_at: Option<Instant>,
    next_instance_id: u64,
    preference: HandPreference,
    roles: Option<RoleAssignment>,
}

impl Default for ScrollControl {
    fn default() -> Self {
        Self::new(ControlState::Disarmed)
    }
}

impl ScrollControl {
    #[must_use]
    pub const fn new(authority: ControlState) -> Self {
        Self::with_preference(authority, HandPreference::Right)
    }

    #[must_use]
    pub const fn with_preference(authority: ControlState, preference: HandPreference) -> Self {
        Self {
            authority,
            state: ScrollState::Idle,
            anchor: None,
            last_chord_at: None,
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

    #[must_use]
    pub const fn is_active(&self) -> bool {
        matches!(self.state, ScrollState::Active { .. })
    }

    /// Synchronizes Desktop's outer armed authority. Transcription context
    /// changes do not interrupt scrolling, while disarming ends it immediately.
    pub fn synchronize_state(&mut self, authority: ControlState) -> Option<ScrollState> {
        self.authority = authority;
        if authority == ControlState::Disarmed {
            return self.stop();
        }
        None
    }

    /// Consumes one fresh, ordered inference result and returns only an
    /// absolute scroll-state change.
    pub fn observe(&mut self, sample: ControlSample<'_>) -> Option<ScrollState> {
        if sample.frame_sequence == 0
            || self
                .last_frame_sequence
                .is_some_and(|previous| sample.frame_sequence <= previous)
            || self
                .last_captured_at
                .is_some_and(|previous| sample.captured_at <= previous)
        {
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
            return self.stop();
        };
        if age > MAX_FRAME_AGE || gap.is_some_and(|gap| gap > MAX_SAMPLE_GAP) {
            return self.stop();
        }
        if self.authority == ControlState::Disarmed {
            return self.stop();
        }

        let reading = classify_scroll_chord(
            sample.hands,
            sample.frame_aspect_ratio,
            self.preference,
            &mut self.roles,
        );
        if self.is_active() {
            return self.observe_active(sample.captured_at, reading);
        }
        self.observe_anchor(sample.captured_at, reading)
    }

    fn observe_anchor(&mut self, now: Instant, reading: ScrollReading) -> Option<ScrollState> {
        let ScrollReading::Chord {
            quality,
            angle_radians,
        } = reading
        else {
            self.anchor = None;
            self.last_chord_at = None;
            return None;
        };
        if quality < ENTER_SCORE || !angle_radians.is_finite() {
            self.anchor = None;
            self.last_chord_at = None;
            return None;
        }
        self.last_chord_at = Some(now);

        let Some(anchor) = self.anchor.as_mut() else {
            self.anchor = Some(ScrollAnchor::new(now, angle_radians));
            return None;
        };
        if !anchor.settled && now.saturating_duration_since(anchor.last_match_at) > MAX_EVIDENCE_GAP
        {
            *anchor = ScrollAnchor::new(now, angle_radians);
            return None;
        }
        if !anchor.settled {
            let drift = (angle_radians - anchor.average_angle()).abs();
            if drift > SCROLL_SETTLE_DRIFT_RADIANS {
                *anchor = ScrollAnchor::new(now, angle_radians);
                return None;
            }
            anchor.record(now, angle_radians);
            if anchor.is_stable(now) {
                anchor.settle();
            } else {
                return None;
            }
        }

        let instance_id = self.next_instance_id;
        self.next_instance_id = self.next_instance_id.wrapping_add(1).max(1);
        self.state = ScrollState::Active {
            instance_id,
            velocity_milliunits: 0,
        };
        Some(self.state)
    }

    fn observe_active(&mut self, now: Instant, reading: ScrollReading) -> Option<ScrollState> {
        let ScrollState::Active { instance_id, .. } = self.state else {
            return None;
        };
        let ScrollReading::Chord {
            quality,
            angle_radians,
        } = reading
        else {
            return match reading {
                ScrollReading::KnownOther => self.stop(),
                ScrollReading::Unknown => {
                    if self.last_chord_at.is_some_and(|last| {
                        now.saturating_duration_since(last) <= SCROLL_TRACKING_GRACE
                    }) {
                        None
                    } else {
                        self.stop()
                    }
                }
                ScrollReading::Chord { .. } => None,
            };
        };
        if quality < CONTINUE_SCORE || !angle_radians.is_finite() {
            if self
                .last_chord_at
                .is_some_and(|last| now.saturating_duration_since(last) <= SCROLL_TRACKING_GRACE)
            {
                return None;
            }
            return self.stop();
        }
        self.last_chord_at = Some(now);
        let Some(anchor) = self.anchor else {
            return self.stop();
        };
        let next = ScrollState::Active {
            instance_id,
            velocity_milliunits: scroll_velocity_milliunits(
                angle_radians,
                anchor.neutral_angle_radians,
            ),
        };
        self.state = next;
        Some(next)
    }

    fn stop(&mut self) -> Option<ScrollState> {
        self.anchor = None;
        self.last_chord_at = None;
        if self.state == ScrollState::Idle {
            return None;
        }
        self.state = ScrollState::Idle;
        Some(ScrollState::Idle)
    }
}

#[derive(Clone, Copy, Debug)]
enum ScrollReading {
    Chord { quality: f32, angle_radians: f32 },
    KnownOther,
    Unknown,
}

#[derive(Clone, Copy, Debug)]
struct ScrollAnchor {
    started_at: Instant,
    last_match_at: Instant,
    samples: u16,
    neutral_angle_radians: f32,
    sum_angle_radians: f32,
    settled: bool,
}

impl ScrollAnchor {
    fn new(now: Instant, angle_radians: f32) -> Self {
        Self {
            started_at: now,
            last_match_at: now,
            samples: 1,
            neutral_angle_radians: angle_radians,
            sum_angle_radians: angle_radians,
            settled: false,
        }
    }

    fn record(&mut self, now: Instant, angle_radians: f32) {
        self.last_match_at = now;
        self.samples = self.samples.saturating_add(1);
        self.sum_angle_radians += angle_radians;
    }

    fn average_angle(self) -> f32 {
        self.sum_angle_radians / f32::from(self.samples)
    }

    fn is_stable(self, now: Instant) -> bool {
        self.samples >= SCROLL_MIN_SETTLE_MATCHES
            && now.saturating_duration_since(self.started_at) >= SCROLL_SETTLE_DWELL
    }

    fn settle(&mut self) {
        self.neutral_angle_radians = self.average_angle();
        self.settled = true;
    }
}

/// Deterministic, allocation-free recognition of the supported two-fist toggle
/// and single-action-hand control vocabulary.
pub struct GestureControl {
    state: ControlState,
    pending: Option<ControlIntent>,
    release_latched: Option<Chord>,
    scroll_release_latched: bool,
    diagnostic: ControlDiagnostic,
    candidate: Option<Candidate>,
    last_frame_sequence: Option<u64>,
    last_captured_at: Option<Instant>,
    preference: HandPreference,
    roles: Option<RoleAssignment>,
}

impl Default for GestureControl {
    fn default() -> Self {
        Self::new(ControlState::Disarmed)
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
            release_latched: None,
            scroll_release_latched: false,
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
        if state == ControlState::Disarmed {
            self.scroll_release_latched = false;
        }
        self.diagnostic = ControlDiagnostic::AwaitingPose;
    }

    /// Prevents an opened action hand used to release scrolling from becoming
    /// a numbered command. A new action-hand fist is the only positive reset.
    pub fn latch_scroll_release(&mut self) {
        self.candidate = None;
        self.scroll_release_latched = true;
        self.diagnostic = ControlDiagnostic::AwaitingRelease {
            chord: ControlChord::Scroll,
        };
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

        if matches!(self.release_latched, Some(Chord::Arm | Chord::Disarm)) {
            if let Some(quality) = toggle_release_quality(sample.hands) {
                self.candidate = None;
                if quality >= ENTER_SCORE {
                    self.release_latched = None;
                    self.diagnostic = ControlDiagnostic::AwaitingPose;
                } else {
                    self.diagnostic = ControlDiagnostic::UnsupportedPose;
                }
                return None;
            }
        }

        let now = sample.captured_at;
        let reading =
            match classify_hands(sample.hands, self.state, self.preference, &mut self.roles) {
                Ok(reading) => reading,
                Err(failure) => {
                    self.diagnostic = failure.diagnostic(self.state);
                    self.candidate = None;
                    return None;
                }
            };

        match reading {
            PairReading::Reset { quality } => {
                self.candidate = None;
                if quality >= ENTER_SCORE {
                    self.release_latched = None;
                    self.scroll_release_latched = false;
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
            PairReading::Toggle { quality } => {
                let chord = if self.state == ControlState::Disarmed {
                    Chord::Arm
                } else {
                    Chord::Disarm
                };
                self.observe_chord(now, ChordReading { chord, quality })
            }
            PairReading::Action { action, quality } => {
                let chord = action.chord(self.state);
                self.observe_chord(now, ChordReading { chord, quality })
            }
        }
    }

    fn observe_chord(&mut self, now: Instant, reading: ChordReading) -> Option<ControlIntent> {
        if let Some(intent) = self.pending {
            self.candidate = None;
            self.diagnostic = ControlDiagnostic::AwaitingAuthority {
                chord: intent.into(),
            };
            return None;
        }
        if let Some(chord) = self.release_latched {
            self.candidate = None;
            self.diagnostic = ControlDiagnostic::AwaitingRelease {
                chord: chord.into(),
            };
            return None;
        }
        if self.scroll_release_latched && !matches!(reading.chord, Chord::Arm | Chord::Disarm) {
            self.candidate = None;
            self.diagnostic = ControlDiagnostic::AwaitingRelease {
                chord: ControlChord::Scroll,
            };
            return None;
        }
        self.advance_candidate(now, reading)
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
            Some(candidate) if candidate.chord == reading.chord => {
                let gap = now.saturating_duration_since(candidate.last_match_at);
                if gap > MAX_EVIDENCE_GAP {
                    evidence_gap = Some(gap);
                    if reading.quality >= ENTER_SCORE {
                        *candidate = Candidate::new(reading.chord, now);
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
                *candidate = Candidate::new(reading.chord, now);
            }
            Some(_) => self.candidate = None,
            None if reading.quality >= ENTER_SCORE => {
                self.candidate = Some(Candidate::new(reading.chord, now));
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
                && reading.quality >= ENTER_SCORE
                && candidate.is_stable(now)
        });
        if !stable {
            return None;
        }

        let chord = self.candidate.as_ref().map(|candidate| candidate.chord)?;
        let intent = control_intent(self.state, chord)?;
        self.candidate = None;
        self.pending = Some(intent);
        self.release_latched = Some(chord);
        self.diagnostic = ControlDiagnostic::Accepted {
            chord: chord.into(),
        };
        Some(intent)
    }

    fn accepted_target(&self, chord: Chord) -> bool {
        matches!(
            (self.state, chord),
            (ControlState::Disarmed, Chord::Arm)
                | (
                    ControlState::Disabled | ControlState::Standby | ControlState::Active { .. },
                    Chord::Disarm
                )
                | (ControlState::Standby, Chord::StartTranscription)
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
            (ControlState::Disarmed, Chord::Disarm)
                | (
                    ControlState::Disabled | ControlState::Standby | ControlState::Active { .. },
                    Chord::Arm
                )
                | (ControlState::Active { .. }, Chord::StartTranscription)
                | (ControlState::Standby, Chord::StopTranscription)
                | (ControlState::Active { muted: true, .. }, Chord::Mute)
                | (ControlState::Active { muted: false, .. }, Chord::Unmute)
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Chord {
    Arm,
    Disarm,
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
            (
                Self::One,
                ControlState::Disarmed | ControlState::Standby | ControlState::Disabled,
            ) => Chord::StartTranscription,
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
    action: Handedness,
}

impl From<Chord> for ControlChord {
    fn from(chord: Chord) -> Self {
        match chord {
            Chord::Arm => Self::Arm,
            Chord::Disarm => Self::Disarm,
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
            ControlIntent::SetArmed { armed: true } => Self::Arm,
            ControlIntent::SetArmed { armed: false } => Self::Disarm,
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
        (ControlState::Disarmed, Chord::Arm) => Some(ControlIntent::SetArmed { armed: true }),
        (
            ControlState::Disabled | ControlState::Standby | ControlState::Active { .. },
            Chord::Disarm,
        ) => Some(ControlIntent::SetArmed { armed: false }),
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
                Chord::Arm | Chord::Disarm => return None,
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
        match self {
            Self::Arm | Self::Disarm => ARM_DWELL,
            Self::ClearDictation => CLEAR_DWELL,
            Self::StartTranscription
            | Self::StopTranscription
            | Self::Send
            | Self::DeleteBackward
            | Self::Mute
            | Self::Unmute => STANDARD_DWELL,
        }
    }

    const fn minimum_matches(self) -> u16 {
        match self {
            Self::Arm | Self::Disarm => 6,
            Self::ClearDictation => 10,
            Self::StartTranscription
            | Self::StopTranscription
            | Self::Send
            | Self::DeleteBackward
            | Self::Mute
            | Self::Unmute => 4,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ChordReading {
    chord: Chord,
    quality: f32,
}

#[derive(Clone, Copy, Debug)]
enum PairReading {
    Action { action: ActionPose, quality: f32 },
    Toggle { quality: f32 },
    Reset { quality: f32 },
    KnownOther,
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
    MissingAction,
    InvalidScore,
    UnsupportedPose,
    AmbiguousHandedness,
}

impl ClassificationFailure {
    fn diagnostic(self, state: ControlState) -> ControlDiagnostic {
        match self {
            Self::HandCount(detected) if state == ControlState::Disarmed => {
                ControlDiagnostic::NeedTwoHands {
                    detected: u8::try_from(detected).unwrap_or(u8::MAX),
                }
            }
            Self::HandCount(_) | Self::MissingAction => ControlDiagnostic::NeedActionHand,
            Self::InvalidScore => ControlDiagnostic::InvalidScore,
            Self::UnsupportedPose | Self::AmbiguousHandedness => ControlDiagnostic::UnsupportedPose,
        }
    }
}

fn classify_hands(
    hands: &[ControlHand],
    state: ControlState,
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> Result<PairReading, ClassificationFailure> {
    if hands.len() > 2 {
        return Err(ClassificationFailure::HandCount(hands.len()));
    }
    if let [first, second] = hands {
        if first.pose == HandPose::Fist && second.pose == HandPose::Fist {
            validate_two_hands(first, second)?;
            return Ok(PairReading::Toggle {
                quality: hand_quality(first).min(hand_quality(second)),
            });
        }
    }
    if state == ControlState::Disarmed {
        return if hands.len() == 2 {
            Ok(PairReading::KnownOther)
        } else {
            Err(ClassificationFailure::HandCount(hands.len()))
        };
    }

    if let [first, second] = hands {
        if unordered_scroll_chord(first.pose, second.pose) {
            let (action, control) = resolve_scroll_hands(first, second, preference, roles)?;
            return Ok(PairReading::Reset {
                quality: hand_quality(action).min(hand_quality(control)),
            });
        }
    }

    let action_hand = resolve_action_hand(hands, preference, roles)?;
    if !valid_hand(action_hand) {
        return Err(ClassificationFailure::InvalidScore);
    }
    if action_hand.handedness == Handedness::Unknown
        || action_hand.handedness_score < MIN_HANDEDNESS_SCORE
    {
        return Err(ClassificationFailure::AmbiguousHandedness);
    }
    let quality = hand_quality(action_hand);
    let action = match action_hand.pose {
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

fn classify_scroll_chord(
    hands: &[ControlHand],
    frame_aspect_ratio: f32,
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> ScrollReading {
    let [first, second] = hands else {
        return ScrollReading::Unknown;
    };
    if first.pose == HandPose::Unknown || second.pose == HandPose::Unknown {
        return ScrollReading::Unknown;
    }
    if !unordered_scroll_chord(first.pose, second.pose) {
        return ScrollReading::KnownOther;
    }
    match resolve_scroll_hands(first, second, preference, roles) {
        Ok((action, control)) => match scroll_angle_radians(action, control, frame_aspect_ratio) {
            Some(angle_radians) => ScrollReading::Chord {
                quality: hand_quality(action).min(hand_quality(control)),
                angle_radians,
            },
            None => ScrollReading::Unknown,
        },
        Err(ClassificationFailure::InvalidScore | ClassificationFailure::AmbiguousHandedness) => {
            ScrollReading::Unknown
        }
        Err(
            ClassificationFailure::HandCount(_)
            | ClassificationFailure::MissingAction
            | ClassificationFailure::UnsupportedPose,
        ) => ScrollReading::KnownOther,
    }
}

fn unordered_scroll_chord(first: HandPose, second: HandPose) -> bool {
    first == HandPose::Fist && is_open_scroll_modifier(second)
        || second == HandPose::Fist && is_open_scroll_modifier(first)
}

const fn is_open_scroll_modifier(pose: HandPose) -> bool {
    matches!(pose, HandPose::FourFingers | HandPose::FiveFingers)
}

fn resolve_scroll_hands<'a>(
    first: &'a ControlHand,
    second: &'a ControlHand,
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> Result<(&'a ControlHand, &'a ControlHand), ClassificationFailure> {
    validate_two_hands(first, second)?;
    let assignment = match preference {
        HandPreference::Left => RoleAssignment {
            action: Handedness::Left,
        },
        HandPreference::Right => RoleAssignment {
            action: Handedness::Right,
        },
        HandPreference::Auto => match *roles {
            Some(assignment) => assignment,
            None => {
                let action = if first.pose == HandPose::Fist && is_open_scroll_modifier(second.pose)
                {
                    first
                } else if second.pose == HandPose::Fist && is_open_scroll_modifier(first.pose) {
                    second
                } else {
                    return Err(ClassificationFailure::UnsupportedPose);
                };
                let assignment = RoleAssignment {
                    action: action.handedness,
                };
                *roles = Some(assignment);
                assignment
            }
        },
    };
    let (action, control) = if first.handedness == assignment.action {
        (first, second)
    } else if second.handedness == assignment.action {
        (second, first)
    } else {
        return Err(ClassificationFailure::MissingAction);
    };
    if action.pose != HandPose::Fist || !is_open_scroll_modifier(control.pose) {
        return Err(ClassificationFailure::UnsupportedPose);
    }
    Ok((action, control))
}

fn toggle_release_quality(hands: &[ControlHand]) -> Option<f32> {
    let [first, second] = hands else {
        return None;
    };
    if first.pose == HandPose::Fist && second.pose == HandPose::Fist
        || first.pose == HandPose::Unknown
        || second.pose == HandPose::Unknown
        || validate_two_hands(first, second).is_err()
    {
        return None;
    }
    Some(hand_quality(first).min(hand_quality(second)))
}

fn validate_two_hands(
    first: &ControlHand,
    second: &ControlHand,
) -> Result<(), ClassificationFailure> {
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

fn resolve_action_hand<'a>(
    hands: &'a [ControlHand],
    preference: HandPreference,
    roles: &mut Option<RoleAssignment>,
) -> Result<&'a ControlHand, ClassificationFailure> {
    if hands.is_empty() || hands.len() > 2 {
        return Err(ClassificationFailure::HandCount(hands.len()));
    }
    let assignment = match preference {
        HandPreference::Left => RoleAssignment {
            action: Handedness::Left,
        },
        HandPreference::Right => RoleAssignment {
            action: Handedness::Right,
        },
        HandPreference::Auto => match *roles {
            Some(assignment) => assignment,
            None => {
                let mut assignable = hands.iter().filter(|hand| assignable_action_hand(hand));
                let first = assignable
                    .next()
                    .ok_or(ClassificationFailure::MissingAction)?;
                let action = match assignable.next() {
                    None => first,
                    Some(second) => match (
                        action_pose(first.pose).is_some(),
                        action_pose(second.pose).is_some(),
                    ) {
                        (true, false) => first,
                        (false, true) => second,
                        _ => return Err(ClassificationFailure::AmbiguousHandedness),
                    },
                };
                let assignment = RoleAssignment {
                    action: action.handedness,
                };
                *roles = Some(assignment);
                assignment
            }
        },
    };
    let mut matching = hands
        .iter()
        .filter(|hand| hand.handedness == assignment.action);
    let action = matching
        .next()
        .ok_or(ClassificationFailure::MissingAction)?;
    if matching.next().is_some() {
        return Err(ClassificationFailure::AmbiguousHandedness);
    }
    Ok(action)
}

fn assignable_action_hand(hand: &ControlHand) -> bool {
    valid_hand(hand)
        && hand.handedness != Handedness::Unknown
        && hand.handedness_score >= MIN_HANDEDNESS_SCORE
        && hand.pose != HandPose::Unknown
        && hand.score >= MIN_POSE_SCORE
}

const fn action_pose(pose: HandPose) -> Option<ActionPose> {
    match pose {
        HandPose::OneFinger => Some(ActionPose::One),
        HandPose::TwoFingers => Some(ActionPose::Two),
        HandPose::ThreeFingers => Some(ActionPose::Three),
        HandPose::FourFingers => Some(ActionPose::Four),
        HandPose::FiveFingers => Some(ActionPose::Five),
        HandPose::Fist | HandPose::Unknown => None,
    }
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

fn scroll_angle_radians(
    action: &ControlHand,
    control: &ControlHand,
    frame_aspect_ratio: f32,
) -> Option<f32> {
    if !valid_scroll_geometry(action)
        || !valid_scroll_geometry(control)
        || !frame_aspect_ratio.is_finite()
        || frame_aspect_ratio <= 0.0
    {
        return None;
    }
    let horizontal_span = (action.palm_x - control.palm_x).abs() * frame_aspect_ratio;
    let average_scale = (action.palm_scale + control.palm_scale) / 2.0;
    if horizontal_span < average_scale * MIN_SCROLL_HORIZONTAL_SPAN_PALMS {
        return None;
    }
    Some((action.palm_y - control.palm_y).atan2(horizontal_span))
}

fn valid_scroll_geometry(hand: &ControlHand) -> bool {
    hand.palm_x.is_finite()
        && hand.palm_y.is_finite()
        && hand.palm_scale.is_finite()
        && (0.0..=1.0).contains(&hand.palm_x)
        && (0.0..=1.0).contains(&hand.palm_y)
        && hand.palm_scale >= MIN_PALM_SCALE
}

fn scroll_velocity_milliunits(angle_radians: f32, neutral_angle_radians: f32) -> i16 {
    let angle_delta = angle_radians - neutral_angle_radians;
    let bounded = (angle_delta / SCROLL_RADIANS_PER_VELOCITY_UNIT * 1_000.0)
        .round()
        .clamp(
            -f32::from(MAX_SCROLL_VELOCITY_MILLIUNITS),
            f32::from(MAX_SCROLL_VELOCITY_MILLIUNITS),
        );
    bounded as i16
}

fn distance(first_x: f32, first_y: f32, second_x: f32, second_y: f32) -> f32 {
    (first_x - second_x).hypot(first_y - second_y)
}

const fn max_f32(first: f32, second: f32) -> f32 {
    if first > second {
        first
    } else {
        second
    }
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

    fn counted(action: HandPose, score: f32) -> [ControlHand; 1] {
        [ControlHand::test(Handedness::Right, action, score)]
    }

    fn mirrored(action: HandPose, score: f32) -> [ControlHand; 1] {
        [ControlHand::test(Handedness::Left, action, score)]
    }

    fn toggle(score: f32) -> [ControlHand; 2] {
        [
            ControlHand::test(Handedness::Right, HandPose::Fist, score),
            ControlHand::test(Handedness::Left, HandPose::Fist, score),
        ]
    }

    fn right_scroll_chord(action_y: f32) -> [ControlHand; 2] {
        right_scroll_chord_with_modifier(action_y, HandPose::FiveFingers)
    }

    fn right_scroll_chord_with_modifier(action_y: f32, modifier: HandPose) -> [ControlHand; 2] {
        right_scroll_chord_at(0.30, 0.30, 0.70, action_y, modifier)
    }

    fn right_scroll_chord_at(
        control_x: f32,
        control_y: f32,
        action_x: f32,
        action_y: f32,
        modifier: HandPose,
    ) -> [ControlHand; 2] {
        [
            ControlHand::test_at(Handedness::Left, modifier, 0.95, control_x, control_y, 0.20),
            ControlHand::test_at(
                Handedness::Right,
                HandPose::Fist,
                0.95,
                action_x,
                action_y,
                0.20,
            ),
        ]
    }

    fn left_scroll_chord(action_y: f32) -> [ControlHand; 2] {
        [
            ControlHand::test_at(
                Handedness::Right,
                HandPose::FiveFingers,
                0.95,
                0.70,
                0.30,
                0.20,
            ),
            ControlHand::test_at(Handedness::Left, HandPose::Fist, 0.95, 0.30, action_y, 0.20),
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
                frame_aspect_ratio: 1.0,
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

    struct ScrollHarness {
        control: ScrollControl,
        start: Instant,
        sequence: u64,
        elapsed: Duration,
    }

    impl ScrollHarness {
        fn new(state: ControlState) -> Self {
            Self::with_control(ScrollControl::new(state))
        }

        fn with_control(control: ScrollControl) -> Self {
            Self {
                control,
                start: Instant::now(),
                sequence: 0,
                elapsed: Duration::ZERO,
            }
        }

        fn sample(&mut self, hands: &[ControlHand]) -> Option<ScrollState> {
            self.sample_after(STEP, hands)
        }

        fn sample_after(&mut self, step: Duration, hands: &[ControlHand]) -> Option<ScrollState> {
            self.sequence += 1;
            self.elapsed += step;
            let captured_at = self.start + self.elapsed;
            self.control.observe(ControlSample {
                frame_sequence: self.sequence,
                captured_at,
                observed_at: captured_at + Duration::from_millis(20),
                frame_aspect_ratio: 1.0,
                hands,
            })
        }

        fn drive(&mut self, count: usize, hands: &[ControlHand]) -> Vec<ScrollState> {
            (0..count).filter_map(|_| self.sample(hands)).collect()
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
    fn a_scroll_release_cannot_become_a_number_without_a_new_fist() {
        let five = counted(HandPose::FiveFingers, 0.95);
        let fist = counted(HandPose::Fist, 0.95);
        let mut harness = Harness::new(ACTIVE);
        harness.control.latch_scroll_release();

        assert!(harness.drive(20, &five).is_empty());
        assert_eq!(
            harness.control.diagnostic(),
            ControlDiagnostic::AwaitingRelease {
                chord: ControlChord::Scroll,
            }
        );
        assert_eq!(harness.sample(&fist), None);
        assert_eq!(
            harness.drive(10, &five),
            vec![request(VoiceRequestGestureIntent::Mute)]
        );
    }

    #[test]
    fn settled_two_hand_chord_emits_immediate_angle_velocity_and_opening_action_releases() {
        let settled = right_scroll_chord(0.50);
        let down = right_scroll_chord(0.60);
        let farther_down = right_scroll_chord(0.64);
        let both_open = [
            ControlHand::test(Handedness::Left, HandPose::FiveFingers, 0.95),
            ControlHand::test(Handedness::Right, HandPose::FiveFingers, 0.95),
        ];
        let mut harness = ScrollHarness::new(STANDBY);

        let updates = harness.drive(5, &settled);
        assert_eq!(updates.len(), 1);
        let update = updates.last().copied();
        assert!(matches!(update, Some(ScrollState::Active { .. })));
        let Some(ScrollState::Active {
            instance_id,
            velocity_milliunits,
        }) = update
        else {
            return;
        };
        assert_ne!(instance_id, 0);
        assert_eq!(velocity_milliunits, 0);
        assert_eq!(harness.sample(&settled), update);
        let moved = harness.sample(&down);
        assert!(matches!(moved, Some(ScrollState::Active { .. })));
        let Some(ScrollState::Active {
            velocity_milliunits: initial_velocity,
            ..
        }) = moved
        else {
            return;
        };
        assert!(initial_velocity > 0);
        let moved_farther = harness.sample(&farther_down);
        assert!(matches!(moved_farther, Some(ScrollState::Active { .. })));
        let Some(ScrollState::Active {
            velocity_milliunits: faster_velocity,
            ..
        }) = moved_farther
        else {
            return;
        };
        assert!(faster_velocity > initial_velocity);
        assert_eq!(harness.sample(&both_open), Some(ScrollState::Idle));
        assert_eq!(harness.control.state(), ScrollState::Idle);
    }

    #[test]
    fn small_angle_changes_apply_immediately_without_a_dead_zone() {
        let settled = right_scroll_chord(0.50);
        let moved = right_scroll_chord(0.52);
        let mut harness = ScrollHarness::new(STANDBY);

        let active = harness.drive(5, &settled);
        assert!(matches!(active.last(), Some(ScrollState::Active { .. })));
        let Some(ScrollState::Active { instance_id, .. }) = active.last() else {
            return;
        };
        let instance_id = *instance_id;
        let update = harness.sample(&moved);
        assert!(matches!(update, Some(ScrollState::Active { .. })));
        let Some(ScrollState::Active {
            instance_id: observed,
            velocity_milliunits,
        }) = update
        else {
            return;
        };
        assert_eq!(observed, instance_id);
        assert!(velocity_milliunits > 0);
        assert_eq!(harness.sample(&moved), update);
    }

    #[test]
    fn moving_both_hands_together_does_not_change_angle_velocity() {
        let neutral = right_scroll_chord_at(0.25, 0.25, 0.65, 0.45, HandPose::FiveFingers);
        let translated = right_scroll_chord_at(0.35, 0.45, 0.75, 0.65, HandPose::FiveFingers);
        let mut harness = ScrollHarness::new(STANDBY);

        let active = harness.drive(5, &neutral);
        assert!(matches!(active.last(), Some(ScrollState::Active { .. })));
        let Some(ScrollState::Active { instance_id, .. }) = active.last() else {
            return;
        };
        assert!(harness.drive(8, &translated).iter().all(|state| {
            *state
                == ScrollState::Active {
                    instance_id: *instance_id,
                    velocity_milliunits: 0,
                }
        }));
    }

    #[test]
    fn horizontally_overlapping_hands_do_not_start_angle_scroll() {
        let overlapping = right_scroll_chord_at(0.45, 0.30, 0.55, 0.50, HandPose::FiveFingers);
        let mut harness = ScrollHarness::new(STANDBY);

        assert!(harness.drive(20, &overlapping).is_empty());
        assert_eq!(harness.control.state(), ScrollState::Idle);
    }

    #[test]
    fn angle_velocity_has_no_dead_zone_or_filter_and_keeps_normalized_scale() {
        let neutral = 0.25;
        const ONE_DEGREE: f32 = std::f32::consts::PI / 180.0;
        assert_eq!(scroll_velocity_milliunits(neutral, neutral), 0);
        assert_eq!(
            scroll_velocity_milliunits(neutral + ONE_DEGREE, neutral),
            50
        );
        assert_eq!(
            scroll_velocity_milliunits(neutral + SCROLL_RADIANS_PER_VELOCITY_UNIT, neutral,),
            1_000
        );
        assert_eq!(
            scroll_velocity_milliunits(neutral - SCROLL_RADIANS_PER_VELOCITY_UNIT, neutral,),
            -1_000
        );
    }

    #[test]
    fn hand_line_angle_accounts_for_camera_aspect_ratio() {
        let square = right_scroll_chord_at(0.25, 0.30, 0.65, 0.50, HandPose::FiveFingers);
        let wide = right_scroll_chord_at(0.35, 0.30, 0.55, 0.50, HandPose::FiveFingers);
        let square_angle = scroll_angle_radians(&square[1], &square[0], 1.0);
        let wide_angle = scroll_angle_radians(&wide[1], &wide[0], 2.0);

        assert!(square_angle.is_some());
        assert!(wide_angle.is_some());
        assert!(square_angle
            .zip(wide_angle)
            .is_some_and(|(square, wide)| (square - wide).abs() < 0.000_001));
    }

    #[test]
    fn tracking_loss_ends_scroll_after_grace_without_making_motion() {
        let settled = right_scroll_chord(0.50);
        let moved = right_scroll_chord(0.60);
        let mut harness = ScrollHarness::new(STANDBY);
        assert_eq!(harness.drive(5, &settled).len(), 1);
        assert!(matches!(
            harness.sample(&moved),
            Some(ScrollState::Active { .. })
        ));

        assert_eq!(harness.sample(&[]), None);
        assert_eq!(
            harness.sample_after(Duration::from_millis(180), &[]),
            Some(ScrollState::Idle)
        );
    }

    #[test]
    fn two_fists_lone_action_fist_and_disarmed_authority_never_start_scroll() {
        let fists = toggle(0.95);
        let lone_action = [ControlHand::test_at(
            Handedness::Right,
            HandPose::Fist,
            0.95,
            0.70,
            0.70,
            0.20,
        )];
        let mut armed = ScrollHarness::new(STANDBY);
        assert!(armed.drive(20, &fists).is_empty());
        assert!(armed.drive(20, &lone_action).is_empty());
        assert_eq!(armed.control.state(), ScrollState::Idle);

        let mut disarmed = ScrollHarness::new(ControlState::Disarmed);
        assert!(disarmed.drive(20, &right_scroll_chord(0.70)).is_empty());
        assert_eq!(disarmed.control.state(), ScrollState::Idle);
    }

    #[test]
    fn scroll_requires_the_role_correct_open_modifier_and_supports_mirrored_users() {
        let mut right = ScrollHarness::new(STANDBY);
        assert_eq!(right.drive(5, &right_scroll_chord(0.50)).len(), 1);
        assert!(matches!(
            right.sample(&right_scroll_chord_with_modifier(
                0.60,
                HandPose::FourFingers
            )),
            Some(ScrollState::Active { .. })
        ));

        let mut left = ScrollHarness::with_control(ScrollControl::with_preference(
            STANDBY,
            HandPreference::Left,
        ));
        assert_eq!(left.drive(5, &left_scroll_chord(0.50)).len(), 1);
        assert!(matches!(
            left.sample(&left_scroll_chord(0.60)),
            Some(ScrollState::Active { .. })
        ));
    }

    #[test]
    fn auto_roles_assign_the_fist_as_action_without_triggering_modifier_five() {
        let chord = right_scroll_chord(0.50);
        let mut gesture = Harness::with_control(GestureControl::with_preference(
            ACTIVE,
            HandPreference::Auto,
        ));
        assert!(gesture.drive(24, &chord).is_empty());

        let mut scroll = ScrollHarness::with_control(ScrollControl::with_preference(
            STANDBY,
            HandPreference::Auto,
        ));
        assert_eq!(scroll.drive(5, &chord).len(), 1);
        assert!(matches!(scroll.control.state(), ScrollState::Active { .. }));
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
    fn both_fists_toggle_without_assigning_auto_roles() {
        let fists = toggle(0.95);
        let mut roles = None;
        assert!(matches!(
            classify_hands(
                &fists,
                ControlState::Disarmed,
                HandPreference::Auto,
                &mut roles
            ),
            Ok(PairReading::Toggle { .. })
        ));
        assert_eq!(roles, None);
    }

    #[test]
    fn auto_roles_follow_the_first_unambiguous_action_and_not_array_order() {
        let mut roles = None;
        let forward = [
            ControlHand::test(Handedness::Left, HandPose::Unknown, 0.9),
            ControlHand::test(Handedness::Right, HandPose::TwoFingers, 0.9),
        ];
        let reverse = [forward[1], forward[0]];
        for hands in [&forward, &reverse] {
            assert!(matches!(
                classify_hands(hands, STANDBY, HandPreference::Auto, &mut roles),
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
    fn two_fists_arm_and_disarm_desktop_owned_control() {
        let fists = toggle(0.95);
        let toggle_release = [
            ControlHand::test(Handedness::Left, HandPose::FiveFingers, 0.95),
            ControlHand::test(Handedness::Right, HandPose::Fist, 0.95),
        ];
        let mut harness = Harness::new(ControlState::Disarmed);

        assert_eq!(
            harness.drive(20, &fists),
            vec![ControlIntent::SetArmed { armed: true }]
        );
        harness.synchronize(STANDBY);
        assert_eq!(harness.sample(&[]), None);
        assert!(harness.drive(20, &fists).is_empty());
        assert!(matches!(
            harness.control.diagnostic(),
            ControlDiagnostic::AwaitingRelease {
                chord: ControlChord::Arm
            }
        ));
        assert_eq!(harness.sample(&toggle_release), None);
        assert_eq!(
            harness.drive(20, &fists),
            vec![ControlIntent::SetArmed { armed: false }]
        );
        harness.synchronize(ControlState::Disarmed);
        assert!(harness.drive(20, &fists).is_empty());
        assert!(matches!(
            harness.control.diagnostic(),
            ControlDiagnostic::AwaitingRelease {
                chord: ControlChord::Disarm
            }
        ));
        assert_eq!(harness.sample(&toggle_release), None);
        assert_eq!(
            harness.drive(20, &fists),
            vec![ControlIntent::SetArmed { armed: true }]
        );
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
                frame_aspect_ratio: 1.0,
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
                frame_aspect_ratio: 1.0,
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
