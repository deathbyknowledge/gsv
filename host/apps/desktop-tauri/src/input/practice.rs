use std::time::Instant;

use gesture_protocol::{GestureCandidate, GestureContext, PracticeGesture};
use serde::{Deserialize, Serialize};

use super::{SegmentAction, State};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PracticeTarget {
    None,
    Listen,
    Dictate,
    Send,
    Delete,
    Clear,
    Pause,
    Scroll,
    Off,
}

impl PracticeTarget {
    pub fn accepts(self, gesture: PracticeGesture) -> bool {
        matches!(
            (self, gesture),
            (Self::Listen | Self::Pause, PracticeGesture::One)
                | (Self::Send, PracticeGesture::Two)
                | (Self::Delete, PracticeGesture::Three)
                | (Self::Clear, PracticeGesture::Four)
                | (Self::Scroll, PracticeGesture::Scroll)
                | (Self::Off, PracticeGesture::BothFists)
        )
    }
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RejectionReason {
    WrongGesture,
    NotReady,
}

#[derive(Clone, Serialize, PartialEq)]
pub struct PracticeFeedback {
    pub gesture: PracticeGesture,
    pub reason: RejectionReason,
}

#[derive(Clone, Serialize, PartialEq)]
pub struct GesturePractice {
    pub lesson_id: u64,
    pub expected: PracticeTarget,
    pub feedback_sequence: u64,
    pub feedback: Option<PracticeFeedback>,
    #[serde(skip)]
    pub voice_request_id: Option<u64>,
    #[serde(skip)]
    pub scroll_instance: u64,
}

impl GesturePractice {
    pub fn new(lesson_id: u64) -> Self {
        Self {
            lesson_id,
            expected: PracticeTarget::None,
            feedback_sequence: 0,
            feedback: None,
            voice_request_id: None,
            scroll_instance: 0,
        }
    }

    pub fn select(&mut self, lesson_id: u64, expected: PracticeTarget) {
        self.lesson_id = lesson_id;
        self.expected = expected;
        self.feedback = None;
        self.scroll_instance = 0;
    }

    pub fn reject(&mut self, gesture: PracticeGesture, reason: RejectionReason) {
        self.feedback_sequence += 1;
        self.feedback = Some(PracticeFeedback { gesture, reason });
    }
}

impl State {
    pub(super) fn practice_gesture(&mut self, gesture: PracticeGesture) {
        let Some(practice) = &self.snapshot.gesture_practice else {
            return;
        };
        let expected = practice.expected;
        if gesture == PracticeGesture::BothFists {
            // Stopping capture remains available in every lesson, including after a rejected pose.
            self.disable_hands_free();
            self.gesture_action = Some((Instant::now(), GestureCandidate::Disarm));
            self.snapshot.gesture_action_sequence += 1;
            if let Some(practice) = &mut self.snapshot.gesture_practice {
                practice.feedback = None;
            }
            return;
        }

        self.gesture_progress = None;
        self.snapshot.gesture_needs_reset = true;
        if !expected.accepts(gesture) {
            self.snapshot
                .gesture_practice
                .as_mut()
                .unwrap()
                .reject(gesture, RejectionReason::WrongGesture);
            return;
        }

        // A practice pose never carries request authority. Resolve the expected lesson action
        // against the current native voice state only after its lesson identity was checked.
        let (action, result) = match (expected, self.context()) {
            (PracticeTarget::Listen, GestureContext::Standby) => (
                GestureCandidate::StartTranscription,
                self.start_voice(self.selected_device.clone()),
            ),
            (PracticeTarget::Listen, GestureContext::Active { .. }) => {
                (GestureCandidate::StartTranscription, Ok(()))
            }
            (
                PracticeTarget::Pause,
                GestureContext::Active {
                    voice_request_id, ..
                },
            ) => (
                GestureCandidate::StopTranscription,
                self.stop(voice_request_id),
            ),
            (PracticeTarget::Pause, GestureContext::Standby) => {
                (GestureCandidate::StopTranscription, Ok(()))
            }
            (
                PracticeTarget::Send | PracticeTarget::Delete | PracticeTarget::Clear,
                GestureContext::Active {
                    voice_request_id, ..
                },
            ) => {
                let (action, segment_action) = match expected {
                    PracticeTarget::Send => (GestureCandidate::Send, SegmentAction::Send),
                    PracticeTarget::Delete => {
                        (GestureCandidate::DeleteBackward, SegmentAction::Delete)
                    }
                    _ => (GestureCandidate::ClearDictation, SegmentAction::Clear),
                };
                let segment_id = self.snapshot.voice.as_ref().unwrap().segment_id;
                (
                    action,
                    self.segment(voice_request_id, segment_id, segment_action),
                )
            }
            _ => {
                self.snapshot
                    .gesture_practice
                    .as_mut()
                    .unwrap()
                    .reject(gesture, RejectionReason::NotReady);
                return;
            }
        };
        if let Err(error) = result {
            self.snapshot.notice = Some(error);
            self.snapshot
                .gesture_practice
                .as_mut()
                .unwrap()
                .reject(gesture, RejectionReason::NotReady);
            return;
        }
        self.snapshot.gesture_practice.as_mut().unwrap().feedback = None;
        self.gesture_action = Some((Instant::now(), action));
        self.snapshot.gesture_action_sequence += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desktop_native::transcription::{VoiceCommand, VoiceCommandSender};
    use desktop_native::vision_debug::VisionEvent;
    use gesture_protocol::{GestureIntent, ScrollState};

    fn practice(
        expected: PracticeTarget,
        listening: bool,
    ) -> (State, std::sync::mpsc::Receiver<VoiceCommand>) {
        let (sender, receiver) = VoiceCommandSender::channel_for_test();
        let mut state = State::new(sender);
        state.snapshot.lease = "private-practice".into();
        state.snapshot.gestures_enabled = true;
        state.snapshot.gesture_status = "ready".into();
        let lesson_id = state.id();
        let mut practice = GesturePractice::new(lesson_id);
        practice.select(lesson_id, expected);
        state.snapshot.gesture_practice = Some(practice);
        if listening {
            state.start_voice(None).unwrap();
            let voice = state.snapshot.voice.as_mut().unwrap();
            voice.phase = "listening".into();
            voice.muted = Some(false);
            voice.text = "private draft".into();
            state.events.clear();
            state.sync_context();
            assert!(matches!(
                receiver.try_recv(),
                Ok(VoiceCommand::Start { .. })
            ));
        }
        (state, receiver)
    }

    fn observe(state: &mut State, sequence: u64, lesson_id: u64, gesture: PracticeGesture) {
        state.vision_event(VisionEvent::Intent {
            sequence,
            received_at: Instant::now(),
            intent: GestureIntent::Practice { lesson_id, gesture },
        });
    }

    #[test]
    fn tutorial_snapshot_keeps_voice_readiness_separate_from_helper_authority() {
        for listening in [false, true] {
            let (state, _commands) = practice(PracticeTarget::Listen, listening);
            let lesson_id = state.snapshot.gesture_practice.as_ref().unwrap().lesson_id;
            assert_eq!(
                serde_json::to_value(state.helper_context()).unwrap(),
                serde_json::json!({ "mode": "practice", "lesson_id": lesson_id })
            );
            assert_eq!(
                serde_json::to_value(state.snapshot()).unwrap()["gesture_context"]["mode"],
                if listening { "active" } else { "standby" }
            );
        }
    }

    #[test]
    fn wrong_counts_report_feedback_without_starting_or_editing_voice() {
        for listening in [false, true] {
            let (mut state, commands) = practice(PracticeTarget::Listen, listening);
            let lesson_id = state.snapshot.gesture_practice.as_ref().unwrap().lesson_id;
            let before = state.snapshot.voice.clone();
            for (index, gesture) in [
                PracticeGesture::Two,
                PracticeGesture::Three,
                PracticeGesture::Four,
                PracticeGesture::Five,
            ]
            .into_iter()
            .enumerate()
            {
                observe(&mut state, index as u64 + 1, lesson_id, gesture);
                let feedback = state
                    .snapshot
                    .gesture_practice
                    .as_ref()
                    .unwrap()
                    .feedback
                    .as_ref()
                    .unwrap();
                assert!(
                    feedback.gesture == gesture && feedback.reason == RejectionReason::WrongGesture
                );
                assert!(state.snapshot.voice == before);
                assert!(state.events.is_empty());
                assert_eq!(state.snapshot.gesture_action_sequence, 0);
                assert!(state.snapshot.gesture_needs_reset);
                assert!(commands.try_recv().is_err());
            }
        }
    }

    #[test]
    fn a_send_lesson_rejects_pause_and_edit_but_accepts_send() {
        let (mut state, commands) = practice(PracticeTarget::Send, true);
        let lesson_id = state.snapshot.gesture_practice.as_ref().unwrap().lesson_id;
        for (index, gesture) in [
            PracticeGesture::One,
            PracticeGesture::Three,
            PracticeGesture::Four,
        ]
        .into_iter()
        .enumerate()
        {
            observe(&mut state, index as u64 + 1, lesson_id, gesture);
        }
        assert!(commands.try_recv().is_err());
        assert!(state.snapshot.voice.as_ref().unwrap().pending.is_none());
        observe(&mut state, 4, lesson_id, PracticeGesture::Two);
        assert!(matches!(
            commands.try_recv(),
            Ok(VoiceCommand::CommitSegment { .. })
        ));
        assert!(state.snapshot.voice.as_ref().unwrap().pending == Some(SegmentAction::Send));
        assert_eq!(state.snapshot.gesture_action_sequence, 1);
        assert!(state
            .snapshot
            .gesture_practice
            .as_ref()
            .unwrap()
            .feedback
            .is_none());
    }

    #[test]
    fn old_lessons_and_replaced_voice_requests_cannot_act() {
        let (mut state, commands) = practice(PracticeTarget::Send, true);
        let old = state.snapshot.gesture_practice.as_ref().unwrap().lesson_id;
        let next = state.id();
        state
            .snapshot
            .gesture_practice
            .as_mut()
            .unwrap()
            .select(next, PracticeTarget::Send);
        observe(&mut state, 1, old, PracticeGesture::Two);
        assert!(commands.try_recv().is_err());
        let replacement = state.id();
        state.snapshot.voice.as_mut().unwrap().request_id = replacement;
        state.sync_context();
        observe(&mut state, 2, next, PracticeGesture::Two);
        assert!(commands.try_recv().is_err());
        assert!(state.snapshot.voice.as_ref().unwrap().pending.is_none());
        assert_eq!(state.snapshot.gesture_action_sequence, 0);
        assert!(state
            .snapshot
            .gesture_practice
            .as_ref()
            .unwrap()
            .feedback
            .is_none());
    }

    #[test]
    fn both_fists_stop_capture_even_after_a_wrong_gesture() {
        let (mut state, commands) = practice(PracticeTarget::Send, true);
        let lesson_id = state.snapshot.gesture_practice.as_ref().unwrap().lesson_id;
        observe(&mut state, 1, lesson_id, PracticeGesture::Three);
        observe(&mut state, 2, lesson_id, PracticeGesture::BothFists);
        assert!(!state.snapshot.gestures_enabled);
        assert!(state.snapshot.voice.is_none());
        assert!(matches!(
            commands.try_recv(),
            Ok(VoiceCommand::Cancel { .. })
        ));
        assert!(state.snapshot().gesture_action == Some(GestureCandidate::Disarm));
        assert!(!state.snapshot.gesture_needs_reset);
    }

    #[test]
    fn scroll_is_silent_motion_only_in_its_own_lesson() {
        let (mut state, _commands) = practice(PracticeTarget::Listen, false);
        for sequence in 1..=3 {
            state.vision_event(VisionEvent::Scroll {
                sequence,
                received_at: Instant::now(),
                state: ScrollState::Active {
                    instance_id: 1,
                    velocity_milliunits: 500,
                },
            });
            assert_eq!(state.snapshot.scroll_velocity, 0);
        }
        let practice = state.snapshot.gesture_practice.as_ref().unwrap();
        assert_eq!(practice.feedback_sequence, 1);
        assert!(practice.feedback.as_ref().unwrap().gesture == PracticeGesture::Scroll);
        let next = state.id();
        state
            .snapshot
            .gesture_practice
            .as_mut()
            .unwrap()
            .select(next, PracticeTarget::Scroll);
        state.vision_event(VisionEvent::Scroll {
            sequence: 4,
            received_at: Instant::now(),
            state: ScrollState::Active {
                instance_id: 2,
                velocity_milliunits: 500,
            },
        });
        assert_eq!(state.snapshot.scroll_velocity, 500);
        assert!(state
            .snapshot
            .gesture_practice
            .as_ref()
            .unwrap()
            .feedback
            .is_none());
    }
}
