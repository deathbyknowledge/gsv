use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BINARY_FRAME_HEADER_BYTES: usize = 5;
pub const BINARY_FRAME_DATA: u8 = 1 << 0;
pub const BINARY_FRAME_END: u8 = 1 << 1;
pub const BINARY_FRAME_ERROR: u8 = 1 << 2;

// ---------------------------------------------------------------------------
//  Core frame types — mirrors gateway/src/protocol/frames.ts
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseFrame {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorShape>,
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
//  sys.connect payload — mirrors gateway/src/syscalls/system.ts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub protocol: u32,
    pub client: ClientInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<DriverInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverInfo {
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
    pub identity: Value,
    pub syscalls: Vec<String>,
    pub signals: Vec<String>,
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
        }
    }
}

pub fn build_binary_frame(stream_id: u32, flags: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(BINARY_FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&stream_id.to_le_bytes());
    frame.push(flags);
    frame.extend_from_slice(payload);
    frame
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
