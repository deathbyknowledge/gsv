//! Bounded local protocol between GSV Desktop and its vision helper.
//!
//! This boundary carries reliable semantic gesture intents plus replace-latest,
//! bounded semantic control status. Camera frames,
//! landmarks, model labels, raw scores, diagnostics, paths, and user content
//! do not belong in this protocol.

use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};

use serde::{de, de::DeserializeOwned, Deserialize, Deserializer, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 4 * 1024;
pub const EVENT_FD: i32 = 3;
pub const EVENT_FD_MARKER_ENV: &str = "GSV_VISION_EVENT_FD";
/// Exact private launch contract. Rotate this on an incompatible unshipped
/// helper/Desktop cutover so a stale sibling fails before semantic traffic.
pub const EVENT_CHANNEL_CONTRACT_MARKER: &str = "gsv-vision-control-v4-armed-one-hand";
pub const SESSION_HIGH_ENV: &str = "GSV_VISION_SESSION_HIGH";
pub const SESSION_LOW_ENV: &str = "GSV_VISION_SESSION_LOW";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionId {
    high: u64,
    low: u64,
}

impl SessionId {
    #[must_use]
    pub const fn new(high: u64, low: u64) -> Self {
        Self { high, low }
    }

    #[must_use]
    pub const fn high(self) -> u64 {
        self.high
    }

    #[must_use]
    pub const fn low(self) -> u64 {
        self.low
    }
}

/// Absolute Desktop-owned gesture authority.
///
/// `Disarmed` permits only the deliberate two-hand arm gesture. Once armed,
/// `Standby` is the only state in which the helper may request a new
/// transcription. `Disabled` temporarily revokes action authority while still
/// permitting the two-hand disarm gesture. An active context is the complete
/// gesture lease for one exact voice request.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum GestureContext {
    Disarmed,
    Disabled,
    Standby,
    Active { voice_request_id: u64, muted: bool },
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum WireGestureContext {
    Disarmed {},
    Disabled {},
    Standby {},
    Active { voice_request_id: u64, muted: bool },
}

impl<'de> Deserialize<'de> for GestureContext {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match WireGestureContext::deserialize(deserializer)? {
            WireGestureContext::Disarmed {} => Self::Disarmed,
            WireGestureContext::Disabled {} => Self::Disabled,
            WireGestureContext::Standby {} => Self::Standby,
            WireGestureContext::Active {
                voice_request_id,
                muted,
            } => Self::Active {
                voice_request_id,
                muted,
            },
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceRequestGestureIntent {
    StopTranscription,
    Send,
    DeleteBackward,
    ClearDictation,
    Mute,
    Unmute,
}

/// A reliable semantic edge from the helper.
///
/// Starting is fenced by the random helper session on `HelperEvent`. Every
/// action on an existing transcription structurally carries its exact request
/// identity instead of relying on an optional sibling field.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum GestureIntent {
    SetArmed {
        armed: bool,
    },
    StartTranscription,
    VoiceRequest {
        voice_request_id: u64,
        action: VoiceRequestGestureIntent,
    },
}

#[derive(Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case", deny_unknown_fields)]
enum WireGestureIntent {
    SetArmed {
        armed: bool,
    },
    StartTranscription {},
    VoiceRequest {
        voice_request_id: u64,
        action: VoiceRequestGestureIntent,
    },
}

impl<'de> Deserialize<'de> for GestureIntent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match WireGestureIntent::deserialize(deserializer)? {
            WireGestureIntent::SetArmed { armed } => Self::SetArmed { armed },
            WireGestureIntent::StartTranscription {} => Self::StartTranscription,
            WireGestureIntent::VoiceRequest {
                voice_request_id,
                action,
            } => Self::VoiceRequest {
                voice_request_id,
                action,
            },
        })
    }
}

/// The semantic candidate whose bounded temporal evidence is accumulating.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GestureCandidate {
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

pub const MAX_GESTURE_PROGRESS_PERMILLE: u16 = 1_000;

/// Quantized, presentation-only progress through the helper's complete
/// temporal evidence gate. This is not an intent and cannot invoke an action.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct GestureProgress {
    candidate: GestureCandidate,
    progress_permille: u16,
}

impl GestureProgress {
    pub const fn new(
        candidate: GestureCandidate,
        progress_permille: u16,
    ) -> Result<Self, InvalidGestureProgress> {
        if progress_permille > MAX_GESTURE_PROGRESS_PERMILLE {
            return Err(InvalidGestureProgress);
        }
        Ok(Self {
            candidate,
            progress_permille,
        })
    }

    #[must_use]
    pub const fn candidate(self) -> GestureCandidate {
        self.candidate
    }

    #[must_use]
    pub const fn progress_permille(self) -> u16 {
        self.progress_permille
    }

    #[must_use]
    pub const fn is_compatible_with(self, context: GestureContext) -> bool {
        matches!(
            (context, self.candidate),
            (GestureContext::Disarmed, GestureCandidate::Arm)
                | (
                    GestureContext::Disabled
                        | GestureContext::Standby
                        | GestureContext::Active { .. },
                    GestureCandidate::Disarm
                )
                | (
                    GestureContext::Standby,
                    GestureCandidate::StartTranscription
                )
                | (
                    GestureContext::Active { .. },
                    GestureCandidate::StopTranscription
                        | GestureCandidate::Send
                        | GestureCandidate::DeleteBackward
                        | GestureCandidate::ClearDictation,
                )
                | (
                    GestureContext::Active { muted: false, .. },
                    GestureCandidate::Mute
                )
                | (
                    GestureContext::Active { muted: true, .. },
                    GestureCandidate::Unmute
                )
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidGestureProgress;

impl Display for InvalidGestureProgress {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("gesture progress must be from 0 through 1000 permille")
    }
}

impl std::error::Error for InvalidGestureProgress {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireGestureProgress {
    candidate: GestureCandidate,
    progress_permille: u16,
}

impl<'de> Deserialize<'de> for GestureProgress {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let progress = WireGestureProgress::deserialize(deserializer)?;
        Self::new(progress.candidate, progress.progress_permille).map_err(de::Error::custom)
    }
}

/// Complete, presentation-only snapshot of semantic gesture control.
///
/// Authority modes stay wire-distinct, request identity is possible only in
/// the active mode, and progress is bounded and state-compatible.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ControlStatus {
    Disarmed {
        progress: Option<GestureProgress>,
    },
    Disabled {
        progress: Option<GestureProgress>,
    },
    Standby {
        progress: Option<GestureProgress>,
    },
    Active {
        voice_request_id: u64,
        muted: bool,
        progress: Option<GestureProgress>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum WireControlStatus {
    Disarmed {
        progress: Option<GestureProgress>,
    },
    Disabled {
        progress: Option<GestureProgress>,
    },
    Standby {
        progress: Option<GestureProgress>,
    },
    Active {
        voice_request_id: u64,
        muted: bool,
        progress: Option<GestureProgress>,
    },
}

impl<'de> Deserialize<'de> for ControlStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match WireControlStatus::deserialize(deserializer)? {
            WireControlStatus::Disarmed { progress } => {
                if progress
                    .is_some_and(|progress| !progress.is_compatible_with(GestureContext::Disarmed))
                {
                    return Err(de::Error::custom(
                        "gesture candidate is incompatible with controller context",
                    ));
                }
                Self::Disarmed { progress }
            }
            WireControlStatus::Disabled { progress } => {
                if progress
                    .is_some_and(|progress| !progress.is_compatible_with(GestureContext::Disabled))
                {
                    return Err(de::Error::custom(
                        "gesture candidate is incompatible with controller context",
                    ));
                }
                Self::Disabled { progress }
            }
            WireControlStatus::Standby { progress } => {
                if progress
                    .is_some_and(|progress| !progress.is_compatible_with(GestureContext::Standby))
                {
                    return Err(de::Error::custom(
                        "gesture candidate is incompatible with controller context",
                    ));
                }
                Self::Standby { progress }
            }
            WireControlStatus::Active {
                voice_request_id,
                muted,
                progress,
            } => {
                let context = GestureContext::Active {
                    voice_request_id,
                    muted,
                };
                if progress.is_some_and(|progress| !progress.is_compatible_with(context)) {
                    return Err(de::Error::custom(
                        "gesture candidate is incompatible with controller context",
                    ));
                }
                Self::Active {
                    voice_request_id,
                    muted,
                    progress,
                }
            }
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    Ready,
    Stopped,
    AssetsUnavailable,
    CameraUnavailable,
    CameraStopped,
    InferenceUnavailable,
    WindowUnavailable,
    WorkerUnavailable,
    ProtocolError,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopCommand {
    SetContext {
        session_id: SessionId,
        context: GestureContext,
    },
}

impl DesktopCommand {
    #[must_use]
    pub const fn set_context(session_id: SessionId, context: GestureContext) -> Self {
        Self::SetContext {
            session_id,
            context,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WireDesktopCommand {
    SetContext {
        session_id: SessionId,
        context: GestureContext,
    },
}

impl<'de> Deserialize<'de> for DesktopCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let WireDesktopCommand::SetContext {
            session_id,
            context,
        } = WireDesktopCommand::deserialize(deserializer)?;
        Ok(Self::set_context(session_id, context))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum HelperEvent {
    Hello {
        protocol_version: u16,
        session_id: SessionId,
    },
    Lifecycle {
        session_id: SessionId,
        sequence: u64,
        state: LifecycleState,
    },
    Status {
        session_id: SessionId,
        sequence: u64,
        status: ControlStatus,
    },
    Intent {
        session_id: SessionId,
        sequence: u64,
        intent: GestureIntent,
    },
}

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    EmptyFrame,
    FrameTooLarge { actual: usize, maximum: usize },
    TruncatedFrame,
    MalformedFrame(serde_json::Error),
}

impl Display for ProtocolError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(_) => formatter.write_str("vision control I/O failed"),
            Self::EmptyFrame => formatter.write_str("vision control frame is empty"),
            Self::FrameTooLarge { .. } => formatter.write_str("vision control frame is too large"),
            Self::TruncatedFrame => formatter.write_str("vision control frame is truncated"),
            Self::MalformedFrame(_) => formatter.write_str("vision control frame is malformed"),
        }
    }
}

impl std::error::Error for ProtocolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::MalformedFrame(error) => Some(error),
            Self::EmptyFrame | Self::FrameTooLarge { .. } | Self::TruncatedFrame => None,
        }
    }
}

impl From<io::Error> for ProtocolError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Reads one length-prefixed JSON frame. Clean EOF before a new header is
/// distinct from a truncated header or body.
pub fn read_frame<T: DeserializeOwned>(input: &mut impl Read) -> Result<Option<T>, ProtocolError> {
    let mut header = [0_u8; 4];
    let mut header_read = 0;
    while header_read < header.len() {
        match input.read(&mut header[header_read..]) {
            Ok(0) if header_read == 0 => return Ok(None),
            Ok(0) => return Err(ProtocolError::TruncatedFrame),
            Ok(read) => header_read += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(ProtocolError::Io(error)),
        }
    }

    let length = u32::from_be_bytes(header) as usize;
    if length == 0 {
        return Err(ProtocolError::EmptyFrame);
    }
    if length > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: length,
            maximum: MAX_FRAME_BYTES,
        });
    }

    let mut payload = vec![0_u8; length];
    if let Err(error) = input.read_exact(&mut payload) {
        return if error.kind() == io::ErrorKind::UnexpectedEof {
            Err(ProtocolError::TruncatedFrame)
        } else {
            Err(ProtocolError::Io(error))
        };
    }
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(ProtocolError::MalformedFrame)
}

pub fn write_frame<T: Serialize>(output: &mut impl Write, value: &T) -> Result<(), ProtocolError> {
    let payload = serde_json::to_vec(value).map_err(ProtocolError::MalformedFrame)?;
    if payload.is_empty() {
        return Err(ProtocolError::EmptyFrame);
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: payload.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::FrameTooLarge {
        actual: payload.len(),
        maximum: MAX_FRAME_BYTES,
    })?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    output.write_all(&frame)?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde_json::json;

    use super::*;

    const SESSION: SessionId = SessionId::new(7, 11);
    const ACTIVE: GestureContext = GestureContext::Active {
        voice_request_id: 22,
        muted: false,
    };
    const MUTED: GestureContext = GestureContext::Active {
        voice_request_id: 22,
        muted: true,
    };

    fn encoded<T: Serialize>(value: &T) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, value).expect("frame serializes");
        bytes
    }

    fn active_intent(action: VoiceRequestGestureIntent) -> GestureIntent {
        GestureIntent::VoiceRequest {
            voice_request_id: 22,
            action,
        }
    }

    #[derive(Default)]
    struct CountingWriter {
        bytes: Vec<u8>,
        writes: usize,
    }

    impl Write for CountingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn unshipped_hard_cutover_rotates_only_the_private_marker() {
        assert_eq!(PROTOCOL_VERSION, 1);
        assert_eq!(
            EVENT_CHANNEL_CONTRACT_MARKER,
            "gsv-vision-control-v4-armed-one-hand"
        );
        for stale in [
            "1",
            "gsv-vision-control-v1",
            "gsv-vision-control-v1-explicit-modes",
            "gsv-vision-control-v1-transcription-sessions",
            "gsv-vision-control-v1-held-scroll",
            "gsv-vision-control-v2-dictation-editing",
            "gsv-vision-control-v3-finger-counts",
        ] {
            assert_ne!(EVENT_CHANNEL_CONTRACT_MARKER, stale);
        }
    }

    #[test]
    fn strict_commands_and_events_round_trip() {
        for context in [
            GestureContext::Disarmed,
            GestureContext::Disabled,
            GestureContext::Standby,
            ACTIVE,
            MUTED,
        ] {
            let command = DesktopCommand::set_context(SESSION, context);
            let mut bytes = Cursor::new(encoded(&command));
            assert_eq!(
                read_frame(&mut bytes).expect("command reads"),
                Some(command)
            );
            assert_eq!(
                read_frame::<DesktopCommand>(&mut bytes).expect("clean EOF"),
                None
            );
        }

        let values = [
            HelperEvent::Hello {
                protocol_version: PROTOCOL_VERSION,
                session_id: SESSION,
            },
            HelperEvent::Lifecycle {
                session_id: SESSION,
                sequence: 1,
                state: LifecycleState::Ready,
            },
            HelperEvent::Status {
                session_id: SESSION,
                sequence: 2,
                status: ControlStatus::Disarmed {
                    progress: Some(
                        GestureProgress::new(GestureCandidate::Arm, 420).expect("bounded progress"),
                    ),
                },
            },
            HelperEvent::Status {
                session_id: SESSION,
                sequence: 3,
                status: ControlStatus::Disabled {
                    progress: Some(
                        GestureProgress::new(GestureCandidate::Disarm, 420)
                            .expect("bounded progress"),
                    ),
                },
            },
            HelperEvent::Status {
                session_id: SESSION,
                sequence: 4,
                status: ControlStatus::Standby {
                    progress: Some(
                        GestureProgress::new(GestureCandidate::StartTranscription, 420)
                            .expect("bounded progress"),
                    ),
                },
            },
            HelperEvent::Status {
                session_id: SESSION,
                sequence: 5,
                status: ControlStatus::Active {
                    voice_request_id: 22,
                    muted: false,
                    progress: None,
                },
            },
            HelperEvent::Intent {
                session_id: SESSION,
                sequence: 6,
                intent: GestureIntent::SetArmed { armed: true },
            },
            HelperEvent::Intent {
                session_id: SESSION,
                sequence: 7,
                intent: GestureIntent::StartTranscription,
            },
            HelperEvent::Intent {
                session_id: SESSION,
                sequence: 8,
                intent: active_intent(VoiceRequestGestureIntent::Send),
            },
        ];
        for expected in values {
            let mut bytes = Cursor::new(encoded(&expected));
            assert_eq!(read_frame(&mut bytes).expect("frame reads"), Some(expected));
        }
    }

    #[test]
    fn intent_scope_structurally_owns_request_identity() {
        let arm = serde_json::to_value(HelperEvent::Intent {
            session_id: SESSION,
            sequence: 1,
            intent: GestureIntent::SetArmed { armed: true },
        })
        .expect("arm serializes");
        assert_eq!(
            arm,
            json!({
                "type": "intent",
                "session_id": { "high": 7, "low": 11 },
                "sequence": 1,
                "intent": { "scope": "set_armed", "armed": true }
            })
        );

        let start = serde_json::to_value(HelperEvent::Intent {
            session_id: SESSION,
            sequence: 1,
            intent: GestureIntent::StartTranscription,
        })
        .expect("start serializes");
        assert_eq!(
            start,
            json!({
                "type": "intent",
                "session_id": { "high": 7, "low": 11 },
                "sequence": 1,
                "intent": { "scope": "start_transcription" }
            })
        );
        assert!(start.get("voice_request_id").is_none());
        assert!(start["intent"].get("voice_request_id").is_none());

        for (action, label) in [
            (
                VoiceRequestGestureIntent::StopTranscription,
                "stop_transcription",
            ),
            (VoiceRequestGestureIntent::Send, "send"),
            (VoiceRequestGestureIntent::DeleteBackward, "delete_backward"),
            (VoiceRequestGestureIntent::ClearDictation, "clear_dictation"),
            (VoiceRequestGestureIntent::Mute, "mute"),
            (VoiceRequestGestureIntent::Unmute, "unmute"),
        ] {
            let event = HelperEvent::Intent {
                session_id: SESSION,
                sequence: 2,
                intent: active_intent(action),
            };
            let wire = serde_json::to_value(event).expect("active intent serializes");
            assert_eq!(wire["intent"]["scope"], "voice_request");
            assert_eq!(wire["intent"]["voice_request_id"], 22);
            assert_eq!(wire["intent"]["action"], label);
            assert_eq!(
                serde_json::from_value::<HelperEvent>(wire).expect("intent reads"),
                event
            );
        }

        for invalid in [
            json!({
                "type": "intent",
                "session_id": { "high": 7, "low": 11 },
                "sequence": 3,
                "intent": {
                    "scope": "start_transcription",
                    "voice_request_id": 22
                }
            }),
            json!({
                "type": "intent",
                "session_id": { "high": 7, "low": 11 },
                "sequence": 3,
                "intent": {
                    "scope": "voice_request",
                    "action": "send"
                }
            }),
            json!({
                "type": "intent",
                "session_id": { "high": 7, "low": 11 },
                "sequence": 3,
                "voice_request_id": 22,
                "intent": { "scope": "start_transcription" }
            }),
        ] {
            assert!(serde_json::from_value::<HelperEvent>(invalid).is_err());
        }
    }

    #[test]
    fn context_and_status_modes_reject_invalid_combinations() {
        assert_eq!(
            serde_json::to_value(GestureContext::Disarmed).expect("context serializes"),
            json!({ "mode": "disarmed" })
        );
        assert_eq!(
            serde_json::to_value(GestureContext::Disabled).expect("context serializes"),
            json!({ "mode": "disabled" })
        );
        assert_eq!(
            serde_json::to_value(GestureContext::Standby).expect("context serializes"),
            json!({ "mode": "standby" })
        );
        assert_eq!(
            serde_json::to_value(ACTIVE).expect("context serializes"),
            json!({
                "mode": "active",
                "voice_request_id": 22,
                "muted": false
            })
        );

        let disarmed = ControlStatus::Disarmed {
            progress: Some(
                GestureProgress::new(GestureCandidate::Arm, 500).expect("bounded progress"),
            ),
        };
        assert_eq!(
            serde_json::from_value::<ControlStatus>(
                serde_json::to_value(disarmed).expect("status serializes")
            )
            .expect("status reads"),
            disarmed
        );
        let standby = ControlStatus::Standby {
            progress: Some(
                GestureProgress::new(GestureCandidate::StartTranscription, 500)
                    .expect("bounded progress"),
            ),
        };
        assert_eq!(
            serde_json::from_value::<ControlStatus>(
                serde_json::to_value(standby).expect("status serializes")
            )
            .expect("status reads"),
            standby
        );
        let active = ControlStatus::Active {
            voice_request_id: 22,
            muted: true,
            progress: Some(
                GestureProgress::new(GestureCandidate::Unmute, 500).expect("bounded progress"),
            ),
        };
        assert_eq!(
            serde_json::from_value::<ControlStatus>(
                serde_json::to_value(active).expect("status serializes")
            )
            .expect("status reads"),
            active
        );

        for invalid in [
            json!({
                "mode": "disarmed",
                "progress": {
                    "candidate": "send",
                    "progress_permille": 500
                }
            }),
            json!({ "mode": "disabled", "voice_request_id": 22 }),
            json!({ "mode": "standby", "muted": false, "progress": null }),
            json!({ "mode": "active", "muted": false, "progress": null }),
            json!({
                "mode": "active",
                "voice_request_id": 22,
                "muted": false,
                "armed": true,
                "progress": null
            }),
        ] {
            assert!(serde_json::from_value::<ControlStatus>(invalid).is_err());
        }

        assert!(serde_json::from_value::<DesktopCommand>(json!({
            "type": "set_context",
            "session_id": { "high": 7, "low": 11 },
            "context": {
                "mode": "standby",
                "voice_request_id": 22
            }
        }))
        .is_err());
    }

    #[test]
    fn progress_is_bounded_closed_and_context_compatible() {
        for candidate in [
            GestureCandidate::Arm,
            GestureCandidate::Disarm,
            GestureCandidate::StartTranscription,
            GestureCandidate::StopTranscription,
            GestureCandidate::Send,
            GestureCandidate::DeleteBackward,
            GestureCandidate::ClearDictation,
            GestureCandidate::Mute,
            GestureCandidate::Unmute,
        ] {
            let progress = GestureProgress::new(candidate, MAX_GESTURE_PROGRESS_PERMILLE)
                .expect("upper bound is valid");
            assert_eq!(progress.candidate(), candidate);
            assert_eq!(progress.progress_permille(), 1_000);
            assert_eq!(
                serde_json::from_value::<GestureProgress>(
                    serde_json::to_value(progress).expect("progress serializes")
                )
                .expect("progress reads"),
                progress
            );
        }
        assert_eq!(
            GestureProgress::new(
                GestureCandidate::StartTranscription,
                MAX_GESTURE_PROGRESS_PERMILLE + 1
            ),
            Err(InvalidGestureProgress)
        );

        let contexts = [
            GestureContext::Disarmed,
            GestureContext::Disabled,
            GestureContext::Standby,
            ACTIVE,
            MUTED,
        ];
        for context in contexts {
            for candidate in [
                GestureCandidate::Arm,
                GestureCandidate::Disarm,
                GestureCandidate::StartTranscription,
                GestureCandidate::StopTranscription,
                GestureCandidate::Send,
                GestureCandidate::DeleteBackward,
                GestureCandidate::ClearDictation,
                GestureCandidate::Mute,
                GestureCandidate::Unmute,
            ] {
                let expected = matches!(
                    (context, candidate),
                    (GestureContext::Disarmed, GestureCandidate::Arm)
                        | (
                            GestureContext::Disabled
                                | GestureContext::Standby
                                | GestureContext::Active { .. },
                            GestureCandidate::Disarm
                        )
                        | (
                            GestureContext::Standby,
                            GestureCandidate::StartTranscription
                        )
                        | (
                            GestureContext::Active { .. },
                            GestureCandidate::StopTranscription
                                | GestureCandidate::Send
                                | GestureCandidate::DeleteBackward
                                | GestureCandidate::ClearDictation,
                        )
                        | (
                            GestureContext::Active { muted: false, .. },
                            GestureCandidate::Mute
                        )
                        | (
                            GestureContext::Active { muted: true, .. },
                            GestureCandidate::Unmute
                        )
                );
                let progress = GestureProgress::new(candidate, 500).expect("bounded");
                assert_eq!(progress.is_compatible_with(context), expected);
            }
        }

        assert!(serde_json::from_value::<ControlStatus>(json!({
            "mode": "standby",
            "progress": {
                "candidate": "send",
                "progress_permille": 500
            }
        }))
        .is_err());
        assert!(serde_json::from_value::<ControlStatus>(json!({
            "mode": "active",
            "voice_request_id": 22,
            "muted": false,
            "progress": {
                "candidate": "start_transcription",
                "progress_permille": 500
            }
        }))
        .is_err());
    }

    #[test]
    fn protocol_shape_cannot_carry_private_or_extensible_fields() {
        let event = serde_json::to_value(HelperEvent::Intent {
            session_id: SESSION,
            sequence: 4,
            intent: active_intent(VoiceRequestGestureIntent::Mute),
        })
        .expect("event serializes");
        for private in [
            "frame",
            "pixels",
            "landmarks",
            "label",
            "message",
            "path",
            "diagnostics",
            "process_id",
            "draft",
        ] {
            assert!(event.get(private).is_none());
            assert!(event["intent"].get(private).is_none());
        }

        assert!(serde_json::from_value::<HelperEvent>(json!({
            "type": "intent",
            "session_id": { "high": 7, "low": 11 },
            "sequence": 4,
            "intent": {
                "scope": "voice_request",
                "voice_request_id": 22,
                "action": "send",
                "draft": "private"
            }
        }))
        .is_err());
    }

    #[test]
    fn a_small_frame_is_one_pipe_write() {
        let event = HelperEvent::Lifecycle {
            session_id: SESSION,
            sequence: 1,
            state: LifecycleState::AssetsUnavailable,
        };
        let mut output = CountingWriter::default();

        write_frame(&mut output, &event).expect("frame writes");

        assert_eq!(output.writes, 1);
        assert_eq!(
            read_frame::<HelperEvent>(&mut Cursor::new(output.bytes)).expect("frame reads"),
            Some(event)
        );
    }

    #[test]
    fn codec_rejects_empty_oversized_truncated_and_malformed_frames() {
        assert!(matches!(
            read_frame::<HelperEvent>(&mut Cursor::new(0_u32.to_be_bytes())),
            Err(ProtocolError::EmptyFrame)
        ));
        assert!(matches!(
            read_frame::<HelperEvent>(&mut Cursor::new(
                ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes()
            )),
            Err(ProtocolError::FrameTooLarge { .. })
        ));

        let mut truncated = 5_u32.to_be_bytes().to_vec();
        truncated.extend_from_slice(b"{}");
        assert!(matches!(
            read_frame::<HelperEvent>(&mut Cursor::new(truncated)),
            Err(ProtocolError::TruncatedFrame)
        ));

        let mut malformed = 1_u32.to_be_bytes().to_vec();
        malformed.push(b'{');
        assert!(matches!(
            read_frame::<HelperEvent>(&mut Cursor::new(malformed)),
            Err(ProtocolError::MalformedFrame(_))
        ));
    }
}
