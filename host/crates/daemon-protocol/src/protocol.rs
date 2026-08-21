use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024;
pub const MAX_DIAGNOSTIC_NOTICES: usize = 32;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RequestId(Uuid);

impl RequestId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for RequestId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DaemonPhase {
    Starting,
    Connecting,
    Connected,
    Reconnecting,
    Reloading,
    ShuttingDown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonStatus {
    pub version: String,
    pub process_id: u32,
    pub machine_id: String,
    pub phase: DaemonPhase,
    pub connected: bool,
    pub uptime_seconds: u64,
    pub reconnect_attempt: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticNotice {
    pub level: DiagnosticLevel,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagnostics {
    pub status: DaemonStatus,
    pub notices: Vec<DiagnosticNotice>,
}

impl Diagnostics {
    pub fn new(
        status: DaemonStatus,
        notices: Vec<DiagnosticNotice>,
    ) -> Result<Self, OperationShapeError> {
        if notices.len() > MAX_DIAGNOSTIC_NOTICES {
            return Err(OperationShapeError::TooManyDiagnosticNotices);
        }
        Ok(Self { status, notices })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum OperationShapeError {
    #[error("daemon diagnostics exceed 32 notices")]
    TooManyDiagnosticNotices,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Status,
    Reload,
    Reconnect,
    Diagnostics,
    Shutdown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Success {
    Status { status: DaemonStatus },
    ReloadAccepted,
    ReconnectAccepted,
    Diagnostics { diagnostics: Diagnostics },
    ShutdownAccepted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    UnsupportedVersion,
    Busy,
    InvalidConfiguration,
    Internal,
    Timeout,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub protocol_version: u16,
    pub request_id: RequestId,
    pub command: Command,
}

impl Request {
    pub(crate) fn new(command: Command) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: RequestId::new(),
            command,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Response {
    pub protocol_version: u16,
    pub request_id: RequestId,
    pub outcome: Outcome,
}

impl Response {
    pub(crate) fn success(request_id: RequestId, response: Success) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            outcome: Outcome::Success { response },
        }
    }

    pub(crate) fn error(request_id: RequestId, code: ErrorCode) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            outcome: Outcome::Error { code },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Outcome {
    Success { response: Success },
    Error { code: ErrorCode },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_and_response_shapes_reject_extension_fields() {
        let request = Request::new(Command::Reload);
        let mut value = serde_json::to_value(&request).expect("request serializes");
        value["credential"] = serde_json::Value::String("must-not-cross-ipc".to_string());
        assert!(serde_json::from_value::<Request>(value).is_err());

        let response = Response::success(request.request_id, Success::ReloadAccepted);
        let encoded = serde_json::to_value(response).expect("response serializes");
        assert_eq!(encoded["protocolVersion"], PROTOCOL_VERSION);
    }

    #[test]
    fn diagnostics_are_bounded() {
        let status = DaemonStatus {
            version: "1.0.0".to_string(),
            process_id: 1,
            machine_id: "machine".to_string(),
            phase: DaemonPhase::Connected,
            connected: true,
            uptime_seconds: 2,
            reconnect_attempt: 0,
        };
        let notice = DiagnosticNotice {
            level: DiagnosticLevel::Info,
            code: "ok".to_string(),
            message: "healthy".to_string(),
        };
        assert!(Diagnostics::new(status, vec![notice; MAX_DIAGNOSTIC_NOTICES + 1]).is_err());
    }
}
