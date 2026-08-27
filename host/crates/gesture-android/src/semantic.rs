use std::time::Duration;

use gesture_engine::control::{ControlChord, ControlIntent, VoiceAction, VoiceControlOutput};

const EVENT_BITS: u32 = 4;
const CHORD_SHIFT: u32 = EVENT_BITS;
const PROGRESS_SHIFT: u32 = 8;
const HANDS_SHIFT: u32 = 18;
const INFERENCE_SHIFT: u32 = 20;
const PROGRESS_MASK: u64 = 0x03ff;
const INFERENCE_MASK: u64 = 0x0fff;
const ERROR_FLAG: u64 = 1 << 63;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SemanticResult {
    pub packed: i64,
    pub request_id: Option<u64>,
}

pub fn pack_output(
    output: VoiceControlOutput<u64>,
    hand_count: usize,
    inference_time: Duration,
) -> SemanticResult {
    let (event, request_id): (u8, Option<u64>) = match output.intent {
        None => (0, None),
        Some(ControlIntent::StartTranscription) => (1, None),
        Some(ControlIntent::VoiceRequest {
            voice_request_id,
            action,
        }) => (
            match action {
                VoiceAction::StopTranscription => 2,
                VoiceAction::Send => 3,
                VoiceAction::DeleteBackward => 5,
                VoiceAction::ClearDictation => 6,
                VoiceAction::Mute => 7,
                VoiceAction::Unmute => 8,
            },
            Some(voice_request_id),
        ),
        Some(ControlIntent::SetArmed { .. }) => (4, None),
    };
    let chord = output
        .progress
        .map_or(0, |progress| chord_code(progress.chord));
    let progress = output
        .progress
        .map_or(0, |progress| progress.progress_permille);
    let hands = u64::try_from(hand_count.min(3)).unwrap_or(3);
    let inference_ms = u64::try_from(inference_time.as_millis())
        .unwrap_or(INFERENCE_MASK)
        .min(INFERENCE_MASK);
    let packed = u64::from(event)
        | (u64::from(chord) << CHORD_SHIFT)
        | ((u64::from(progress) & PROGRESS_MASK) << PROGRESS_SHIFT)
        | (hands << HANDS_SHIFT)
        | (inference_ms << INFERENCE_SHIFT);
    SemanticResult {
        packed: packed as i64,
        request_id,
    }
}

pub const fn pack_error(code: u8) -> i64 {
    (ERROR_FLAG | code as u64) as i64
}

const fn chord_code(chord: ControlChord) -> u8 {
    match chord {
        ControlChord::Arm => 1,
        ControlChord::Disarm => 2,
        ControlChord::StartTranscription => 3,
        ControlChord::StopTranscription => 4,
        ControlChord::Send => 5,
        ControlChord::DeleteBackward => 6,
        ControlChord::ClearDictation => 7,
        ControlChord::Mute => 8,
        ControlChord::Unmute => 9,
        ControlChord::Scroll => 10,
    }
}

#[cfg(test)]
mod tests {
    use gesture_engine::control::{ControlDiagnostic, ControlProgress, ScrollState};

    use super::*;

    fn output(intent: Option<ControlIntent<u64>>) -> VoiceControlOutput<u64> {
        VoiceControlOutput {
            intent,
            scroll_update: None,
            scroll_state: ScrollState::Idle,
            diagnostic: ControlDiagnostic::AwaitingPose,
            progress: Some(ControlProgress {
                chord: ControlChord::Send,
                progress_permille: 731,
            }),
        }
    }

    #[test]
    fn packs_only_bounded_semantic_status() {
        let result = pack_output(
            output(Some(ControlIntent::VoiceRequest {
                voice_request_id: 42,
                action: VoiceAction::Send,
            })),
            2,
            Duration::from_millis(37),
        );
        let packed = result.packed as u64;
        assert_eq!(packed & 0x0f, 3);
        assert_eq!((packed >> CHORD_SHIFT) & 0x0f, 5);
        assert_eq!((packed >> PROGRESS_SHIFT) & PROGRESS_MASK, 731);
        assert_eq!((packed >> HANDS_SHIFT) & 0x03, 2);
        assert_eq!((packed >> INFERENCE_SHIFT) & INFERENCE_MASK, 37);
        assert_eq!(result.request_id, Some(42));
    }

    #[test]
    fn errors_are_distinct_from_valid_outputs() {
        assert_ne!((pack_error(3) as u64) & ERROR_FLAG, 0);
        assert_eq!((pack_error(3) as u64) & 0xff, 3);
    }
}
