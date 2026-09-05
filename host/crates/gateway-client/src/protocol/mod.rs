use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BINARY_FRAME_HEADER_BYTES: usize = 5;
pub const PROTOCOL_VERSION: u32 = 4;
pub const REQUEST_CANCEL_SIGNAL: &str = "request.cancel";
pub const BINARY_FRAME_DATA: u8 = 1 << 0;
pub const BINARY_FRAME_END: u8 = 1 << 1;
pub const BINARY_FRAME_ERROR: u8 = 1 << 2;
pub const BINARY_FRAME_CANCEL: u8 = 1 << 3;
/// Flow-control credit from a receiver to a sender: a little-endian u32 counting
/// the additional body bytes the sender may put on the wire.
pub const BINARY_FRAME_WINDOW: u8 = 1 << 4;
/// Credit every sender starts with before its receiver has granted anything.
pub const BINARY_INITIAL_WINDOW_BYTES: u64 = 4 * 1024 * 1024;
pub const BINARY_WINDOW_PAYLOAD_BYTES: usize = 4;

// ---------------------------------------------------------------------------
//  Core frame types — mirrors workers/gateway/src/protocol/frames.ts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Frame {
    Req(RequestFrame),
    Res(ResponseFrame),
    Sig(SignalFrame),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestFrame {
    pub id: String,
    pub call: String,
    /// Every request carries `args` on the wire; `None` serializes as `{}` so
    /// argument-free calls still pass the Gateway's frame validation.
    #[serde(default, serialize_with = "serialize_request_args")]
    pub args: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<FrameBodyDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseFrame {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<FrameBodyDescriptor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameBodyDescriptor {
    pub stream_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalFrame {
    pub signal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorShape {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

// ---------------------------------------------------------------------------
//  sys.connect payload — mirrors workers/gateway/src/syscalls/system.ts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub protocol: u32,
    pub peer: PeerInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: String,
    pub version: String,
    pub platform: String,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub implements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthInfo {
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

// ---------------------------------------------------------------------------
//  sys.connect result
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectResult {
    pub protocol: u32,
    pub server: ServerInfo,
    pub peer: ConnectedPeer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedPeer {
    pub id: String,
    pub session_id: String,
    pub principal: PeerPrincipal,
    pub grant: PeerGrant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerPrincipalKind {
    Human,
    Machine,
    Service,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerPrincipal {
    pub kind: PeerPrincipalKind,
    pub account: ProcessIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub uid: u64,
    pub gid: u64,
    pub gids: Vec<u64>,
    pub username: String,
    pub home: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerGrant {
    pub calls: Vec<String>,
    pub signals: Vec<String>,
    pub implements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: String,
    pub connection_id: String,
}

// ---------------------------------------------------------------------------
//  Exec event (device → gateway signal for background process status)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceExecEventParams {
    pub event_id: String,
    pub session_id: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
}

// ---------------------------------------------------------------------------
//  Tool definition (used by local driver syscall implementations)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

impl RequestFrame {
    pub fn new(call: &str, args: Option<Value>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            call: call.to_string(),
            args,
            body: None,
        }
    }
}

fn serialize_request_args<S>(args: &Option<Value>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match args {
        Some(value) => value.serialize(serializer),
        None => serde_json::Map::new().serialize(serializer),
    }
}

pub fn build_binary_frame(stream_id: u32, flags: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(BINARY_FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&stream_id.to_le_bytes());
    frame.push(flags);
    frame.extend_from_slice(payload);
    frame
}

pub fn build_window_frame(stream_id: u32, credit_bytes: u32) -> Vec<u8> {
    build_binary_frame(stream_id, BINARY_FRAME_WINDOW, &credit_bytes.to_le_bytes())
}

/// Returns the credit carried by a WINDOW payload, or `None` when it is malformed.
pub fn parse_window_credit(payload: &[u8]) -> Option<u32> {
    if payload.len() != BINARY_WINDOW_PAYLOAD_BYTES {
        return None;
    }
    let credit = u32::from_le_bytes(payload.try_into().ok()?);
    (credit > 0).then_some(credit)
}

pub fn parse_binary_frame(data: &[u8]) -> Option<(u32, u8, Vec<u8>)> {
    if data.len() < BINARY_FRAME_HEADER_BYTES {
        return None;
    }
    let stream_id = u32::from_le_bytes(data[0..4].try_into().ok()?);
    if stream_id == 0 {
        return None;
    }
    Some((
        stream_id,
        data[4],
        data[BINARY_FRAME_HEADER_BYTES..].to_vec(),
    ))
}

#[cfg(test)]
#[allow(clippy::panic)]
mod tests {
    use super::{Frame, FrameBodyDescriptor, RequestFrame, ResponseFrame};
    use serde_json::json;

    #[test]
    fn request_without_args_serializes_an_empty_object() {
        let frame = RequestFrame::new("sys.target.list", None);
        let value = serde_json::to_value(&frame).expect("request frame");
        assert_eq!(value["args"], json!({}));
        assert_eq!(value.get("body"), None);
    }

    #[test]
    fn request_body_descriptor_deserializes_from_wire_shape() {
        let frame: Frame = serde_json::from_value(json!({
            "type": "req",
            "id": "req-1",
            "call": "fs.transfer.receive",
            "args": { "path": "destination.bin" },
            "body": { "streamId": 41, "length": 3 }
        }))
        .expect("request frame should deserialize");

        let Frame::Req(request) = frame else {
            panic!("expected request frame");
        };
        assert_eq!(
            request.body,
            Some(FrameBodyDescriptor {
                stream_id: 41,
                length: Some(3),
            })
        );
    }

    #[test]
    fn response_body_descriptor_serializes_to_wire_shape() {
        let frame = Frame::Res(ResponseFrame {
            id: "req-1".to_string(),
            ok: true,
            data: Some(json!({ "ok": true })),
            error: None,
            body: Some(FrameBodyDescriptor {
                stream_id: 42,
                length: None,
            }),
        });

        let value = serde_json::to_value(frame).expect("response frame should serialize");
        assert_eq!(value["body"], json!({ "streamId": 42 }));
    }

    #[test]
    fn request_without_body_omits_descriptor() {
        let request = RequestFrame::new("fs.transfer.stat", Some(json!({ "path": "a" })));
        let value = serde_json::to_value(request).expect("request frame should serialize");

        assert!(value.get("body").is_none());
    }
}
