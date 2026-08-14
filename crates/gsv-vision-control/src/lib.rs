//! Bounded local protocol between GSV Desktop and its vision helper.
//!
//! This boundary carries semantic gesture intents only. Camera frames,
//! landmarks, model labels, diagnostics, paths, and user content do not belong
//! in this protocol.

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
            HelperEvent::Intent {
                session_id: SESSION,
                sequence: 2,
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
