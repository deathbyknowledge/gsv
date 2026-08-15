//! Bounded local protocol between GSV Desktop and its vision helper.
//!
//! This boundary carries reliable semantic gesture intents and replace-latest,
//! request-scoped semantic control status. Camera frames, landmarks, model
//! labels, raw scores, diagnostics, paths, and user content do not belong in
//! this protocol.

use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};

use serde::{de, de::DeserializeOwned, Deserialize, Deserializer, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 4 * 1024;
pub const EVENT_FD: i32 = 3;
pub const EVENT_FD_MARKER_ENV: &str = "GSV_VISION_EVENT_FD";
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GestureIntent {
    Hold,
    ReleaseHold,
    Send,
}

/// Stable semantic state of the helper-owned temporal gesture controller.
///
/// This state itself exposes neither model labels nor per-frame evidence. An
/// active status may separately carry bounded, quantized candidate progress.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GestureState {
    /// The user must deliberately show two open palms before commands arm.
    NeedsReady,
    /// Hold or send may be formed while one open palm remains visible.
    Ready,
    /// Auto-send remains held until two open palms are deliberately observed.
    Holding,
}

/// The semantic candidate whose bounded temporal evidence is accumulating.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GestureCandidate {
    Arm,
    Hold,
    ReleaseHold,
    Send,
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
    pub const fn is_compatible_with(self, state: GestureState) -> bool {
        matches!(
            (state, self.candidate),
            (GestureState::NeedsReady, GestureCandidate::Arm)
                | (
                    GestureState::Ready,
                    GestureCandidate::Hold | GestureCandidate::Send
                )
                | (GestureState::Holding, GestureCandidate::ReleaseHold)
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

/// Complete, request-fenced snapshot of semantic gesture control.
///
/// A disabled snapshot cannot accidentally carry a request ID. Conversely, an
/// active snapshot always identifies the one voice request whose actions the
/// helper is allowed to emit.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ControlStatus {
    Disabled,
    Active {
        voice_request_id: u64,
        state: GestureState,
        progress: Option<GestureProgress>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum WireControlStatus {
    Disabled {},
    Active {
        voice_request_id: u64,
        state: GestureState,
        progress: Option<GestureProgress>,
    },
}

impl<'de> Deserialize<'de> for ControlStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match WireControlStatus::deserialize(deserializer)? {
            WireControlStatus::Disabled {} => Self::Disabled,
            WireControlStatus::Active {
                voice_request_id,
                state,
                progress,
            } => {
                if progress.is_some_and(|progress| !progress.is_compatible_with(state)) {
                    return Err(de::Error::custom(
                        "gesture candidate is incompatible with controller state",
                    ));
                }
                Self::Active {
                    voice_request_id,
                    state,
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
        voice_request_id: Option<u64>,
        held: bool,
    },
}

impl DesktopCommand {
    pub fn set_context(
        session_id: SessionId,
        voice_request_id: Option<u64>,
        held: bool,
    ) -> Result<Self, InvalidContext> {
        if voice_request_id.is_none() && held {
            return Err(InvalidContext);
        }
        Ok(Self::SetContext {
            session_id,
            voice_request_id,
            held,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidContext;

impl Display for InvalidContext {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("a disabled vision context cannot be held")
    }
}

impl std::error::Error for InvalidContext {}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WireDesktopCommand {
    SetContext {
        session_id: SessionId,
        voice_request_id: Option<u64>,
        held: bool,
    },
}

impl<'de> Deserialize<'de> for DesktopCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let WireDesktopCommand::SetContext {
            session_id,
            voice_request_id,
            held,
        } = WireDesktopCommand::deserialize(deserializer)?;
        Self::set_context(session_id, voice_request_id, held).map_err(de::Error::custom)
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
        voice_request_id: u64,
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

    #[test]
    fn unshipped_protocol_remains_v1() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }

    fn encoded<T: Serialize>(value: &T) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, value).expect("frame serializes");
        bytes
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
    fn commands_and_events_round_trip_with_strict_types() {
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
                status: ControlStatus::Active {
                    voice_request_id: 19,
                    state: GestureState::NeedsReady,
                    progress: Some(
                        GestureProgress::new(GestureCandidate::Arm, 420).expect("bounded progress"),
                    ),
                },
            },
            HelperEvent::Intent {
                session_id: SESSION,
                sequence: 3,
                voice_request_id: 19,
                intent: GestureIntent::Send,
            },
        ];
        for expected in values {
            let mut bytes = Cursor::new(encoded(&expected));
            assert_eq!(read_frame(&mut bytes).expect("frame reads"), Some(expected));
            assert_eq!(
                read_frame::<HelperEvent>(&mut bytes).expect("EOF reads"),
                None
            );
        }

        let command = DesktopCommand::set_context(SESSION, None, false).expect("valid context");
        let mut bytes = Cursor::new(encoded(&command));
        assert_eq!(
            read_frame(&mut bytes).expect("command reads"),
            Some(command)
        );
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
    fn protocol_shape_cannot_carry_private_or_extensible_fields() {
        let event = serde_json::to_value(HelperEvent::Intent {
            session_id: SESSION,
            sequence: 4,
            voice_request_id: 22,
            intent: GestureIntent::Hold,
        })
        .expect("event serializes");
        assert_eq!(event["type"], "intent");
        assert_eq!(event["intent"], "hold");
        for private in [
            "frame",
            "pixels",
            "landmarks",
            "label",
            "message",
            "path",
            "diagnostics",
            "process_id",
        ] {
            assert!(event.get(private).is_none());
        }

        let unexpected = json!({
            "type": "intent",
            "session_id": { "high": 7, "low": 11 },
            "sequence": 4,
            "voice_request_id": 22,
            "intent": { "type": "send", "draft": "private" }
        });
        assert!(serde_json::from_value::<HelperEvent>(unexpected).is_err());
    }

    #[test]
    fn control_status_shape_enforces_request_ownership() {
        let disabled = serde_json::to_value(ControlStatus::Disabled).expect("status serializes");
        assert_eq!(disabled, json!({ "mode": "disabled" }));

        let active = ControlStatus::Active {
            voice_request_id: 22,
            state: GestureState::Holding,
            progress: Some(
                GestureProgress::new(GestureCandidate::ReleaseHold, 742).expect("bounded progress"),
            ),
        };
        let encoded = serde_json::to_value(active).expect("status serializes");
        assert_eq!(
            encoded,
            json!({
                "mode": "active",
                "voice_request_id": 22,
                "state": "holding",
                "progress": {
                    "candidate": "release_hold",
                    "progress_permille": 742
                }
            })
        );
        assert_eq!(
            serde_json::from_value::<ControlStatus>(json!({
                "mode": "active",
                "voice_request_id": 22,
                "state": "ready",
                "progress": null
            }))
            .expect("explicitly empty progress is valid"),
            ControlStatus::Active {
                voice_request_id: 22,
                state: GestureState::Ready,
                progress: None,
            }
        );

        assert!(serde_json::from_value::<ControlStatus>(json!({
            "mode": "disabled",
            "voice_request_id": 22
        }))
        .is_err());
        assert!(serde_json::from_value::<ControlStatus>(json!({
            "mode": "active",
            "state": "ready"
        }))
        .is_err());
        assert!(serde_json::from_value::<ControlStatus>(json!({
            "mode": "active",
            "voice_request_id": 22,
            "state": "candidate",
            "progress": null
        }))
        .is_err());
    }

    #[test]
    fn gesture_progress_is_bounded_and_closed() {
        for candidate in [
            GestureCandidate::Arm,
            GestureCandidate::Hold,
            GestureCandidate::ReleaseHold,
            GestureCandidate::Send,
        ] {
            let progress = GestureProgress::new(candidate, MAX_GESTURE_PROGRESS_PERMILLE)
                .expect("upper bound is valid");
            assert_eq!(progress.candidate(), candidate);
            assert_eq!(progress.progress_permille(), MAX_GESTURE_PROGRESS_PERMILLE);
            assert_eq!(
                serde_json::from_value::<GestureProgress>(
                    serde_json::to_value(progress).expect("progress serializes")
                )
                .expect("progress deserializes"),
                progress
            );
        }

        assert_eq!(
            GestureProgress::new(GestureCandidate::Arm, MAX_GESTURE_PROGRESS_PERMILLE + 1),
            Err(InvalidGestureProgress)
        );
        assert!(serde_json::from_value::<GestureProgress>(json!({
            "candidate": "arm",
            "progress_permille": 1001
        }))
        .is_err());
        assert!(serde_json::from_value::<GestureProgress>(json!({
            "candidate": "custom",
            "progress_permille": 500
        }))
        .is_err());
        assert!(serde_json::from_value::<GestureProgress>(json!({
            "candidate": "send",
            "progress_permille": 500,
            "label": "private"
        }))
        .is_err());
    }

    #[test]
    fn active_status_rejects_candidates_from_another_state() {
        let valid = [
            (GestureState::NeedsReady, GestureCandidate::Arm),
            (GestureState::Ready, GestureCandidate::Hold),
            (GestureState::Ready, GestureCandidate::Send),
            (GestureState::Holding, GestureCandidate::ReleaseHold),
        ];
        for (state, candidate) in valid {
            let progress = GestureProgress::new(candidate, 500).expect("bounded progress");
            assert!(progress.is_compatible_with(state));
        }

        for (state, candidate) in [
            (GestureState::NeedsReady, GestureCandidate::Send),
            (GestureState::Ready, GestureCandidate::Arm),
            (GestureState::Holding, GestureCandidate::Hold),
        ] {
            let progress = GestureProgress::new(candidate, 500).expect("bounded progress");
            assert!(!progress.is_compatible_with(state));
            assert!(serde_json::from_value::<ControlStatus>(json!({
                "mode": "active",
                "voice_request_id": 22,
                "state": match state {
                    GestureState::NeedsReady => "needs_ready",
                    GestureState::Ready => "ready",
                    GestureState::Holding => "holding",
                },
                "progress": {
                    "candidate": match candidate {
                        GestureCandidate::Arm => "arm",
                        GestureCandidate::Hold => "hold",
                        GestureCandidate::ReleaseHold => "release_hold",
                        GestureCandidate::Send => "send",
                    },
                    "progress_permille": 500
                }
            }))
            .is_err());
        }
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

    #[test]
    fn unknown_top_level_fields_and_free_form_intents_are_rejected() {
        let extra = json!({
            "type": "hello",
            "protocol_version": PROTOCOL_VERSION,
            "session_id": { "high": 7, "low": 11 },
            "message": "diagnostic"
        });
        assert!(serde_json::from_value::<HelperEvent>(extra).is_err());

        let unknown = json!({
            "type": "intent",
            "session_id": { "high": 7, "low": 11 },
            "sequence": 1,
            "voice_request_id": 9,
            "intent": { "type": "wave", "label": "custom" }
        });
        assert!(serde_json::from_value::<HelperEvent>(unknown).is_err());
    }

    #[test]
    fn disabled_context_cannot_claim_an_existing_hold() {
        assert_eq!(
            DesktopCommand::set_context(SESSION, None, true),
            Err(InvalidContext)
        );
        assert!(serde_json::from_value::<DesktopCommand>(json!({
            "type": "set_context",
            "session_id": { "high": 7, "low": 11 },
            "voice_request_id": null,
            "held": true
        }))
        .is_err());
        assert!(DesktopCommand::set_context(SESSION, Some(9), true).is_ok());
    }
}
