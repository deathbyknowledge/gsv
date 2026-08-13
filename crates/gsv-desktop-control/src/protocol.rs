use std::fmt;

use serde::{de, Deserialize, Deserializer, Serialize};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_PROCESS_ID_BYTES: usize = 256;

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

impl fmt::Display for RequestId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ProcessId(String);

impl ProcessId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidProcessId> {
        let value = value.into();
        if value.is_empty() {
            return Err(InvalidProcessId::Empty);
        }
        if value.len() > MAX_PROCESS_ID_BYTES {
            return Err(InvalidProcessId::TooLong);
        }
        if value.chars().any(char::is_control) {
            return Err(InvalidProcessId::ControlCharacter);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_inner(self) -> String {
        self.0
    }
}

impl fmt::Display for ProcessId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl<'de> Deserialize<'de> for ProcessId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum InvalidProcessId {
    #[error("process id must not be empty")]
    Empty,
    #[error("process id exceeds 256 bytes")]
    TooLong,
    #[error("process id must not contain control characters")]
    ControlCharacter,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Activate,
    Status,
    New,
    Use { process_id: ProcessId },
}

impl<'de> Deserialize<'de> for Command {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let serde_json::Value::Object(mut fields) = serde_json::Value::deserialize(deserializer)?
        else {
            return Err(de::Error::custom("command must be an object"));
        };
        let command_type = fields
            .remove("type")
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .ok_or_else(|| de::Error::custom("command type is required"))?;

        match command_type.as_str() {
            "activate" if fields.is_empty() => Ok(Self::Activate),
            "status" if fields.is_empty() => Ok(Self::Status),
            "new" if fields.is_empty() => Ok(Self::New),
            "use" if fields.len() == 1 && fields.contains_key("processId") => {
                let process_id = fields
                    .remove("processId")
                    .ok_or_else(|| de::Error::custom("processId is required"))?;
                let process_id = serde_json::from_value(process_id)
                    .map_err(|_| de::Error::custom("processId is invalid"))?;
                Ok(Self::Use { process_id })
            }
            "activate" | "status" | "new" | "use" => {
                Err(de::Error::custom("command contains unexpected fields"))
            }
            _ => Err(de::Error::custom("command type is unsupported")),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GatewayState {
    Disconnected,
    Connecting,
    Connected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowState {
    Hidden,
    Visible,
    Focused,
}

/// A deliberately redacted view of Desktop state.
///
/// It contains no account identity, process label, message, draft, attachment,
/// approval, credential, or filesystem information.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopStatus {
    pub gateway: GatewayState,
    pub window: WindowState,
    pub selected_process: Option<ProcessId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Success {
    Activated,
    Status { status: DesktopStatus },
    Created { process_id: ProcessId },
    Selected { process_id: ProcessId },
}

impl<'de> Deserialize<'de> for Success {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let serde_json::Value::Object(mut fields) = serde_json::Value::deserialize(deserializer)?
        else {
            return Err(de::Error::custom("response must be an object"));
        };
        let response_type = fields
            .remove("type")
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .ok_or_else(|| de::Error::custom("response type is required"))?;

        match response_type.as_str() {
            "activated" if fields.is_empty() => Ok(Self::Activated),
            "status" if fields.len() == 1 && fields.contains_key("status") => {
                let status = fields
                    .remove("status")
                    .ok_or_else(|| de::Error::custom("status is required"))?;
                let status = serde_json::from_value(status)
                    .map_err(|_| de::Error::custom("status is invalid"))?;
                Ok(Self::Status { status })
            }
            "created" | "selected" if fields.len() == 1 && fields.contains_key("processId") => {
                let process_id = fields
                    .remove("processId")
                    .ok_or_else(|| de::Error::custom("processId is required"))?;
                let process_id = serde_json::from_value(process_id)
                    .map_err(|_| de::Error::custom("processId is invalid"))?;
                if response_type == "created" {
                    Ok(Self::Created { process_id })
                } else {
                    Ok(Self::Selected { process_id })
                }
            }
            "activated" | "status" | "created" | "selected" => {
                Err(de::Error::custom("response contains unexpected fields"))
            }
            _ => Err(de::Error::custom("response type is unsupported")),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Busy,
    Unavailable,
    ProcessNotFound,
    PermissionDenied,
    Conflict,
    Internal,
    Timeout,
    UnsupportedVersion,
}

impl ErrorCode {
    #[must_use]
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Busy | Self::Unavailable | Self::Timeout)
    }
}

/// Errors an application handler may safely return across the local boundary.
///
/// The absence of a free-form message is intentional: implementation details
/// and user content must not accidentally cross this control channel.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum OperationError {
    #[error("desktop is busy")]
    Busy,
    #[error("desktop is unavailable")]
    Unavailable,
    #[error("process was not found")]
    ProcessNotFound,
    #[error("operation is not permitted")]
    PermissionDenied,
    #[error("operation conflicts with current state")]
    Conflict,
    #[error("desktop operation failed")]
    Internal,
}

impl From<OperationError> for ErrorCode {
    fn from(value: OperationError) -> Self {
        match value {
            OperationError::Busy => Self::Busy,
            OperationError::Unavailable => Self::Unavailable,
            OperationError::ProcessNotFound => Self::ProcessNotFound,
            OperationError::PermissionDenied => Self::PermissionDenied,
            OperationError::Conflict => Self::Conflict,
            OperationError::Internal => Self::Internal,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Outcome {
    Success { response: Success },
    Error { code: ErrorCode },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_wire_shape_has_no_extensible_argument_bag() {
        let request = Request {
            protocol_version: PROTOCOL_VERSION,
            request_id: RequestId::new(),
            command: Command::Use {
                process_id: ProcessId::new("agent:main").expect("valid process id"),
            },
        };

        let encoded = serde_json::to_value(request).expect("request serializes");
        assert_eq!(encoded["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(encoded["command"]["type"], "use");
        assert_eq!(encoded["command"]["process_id"], serde_json::Value::Null);
        assert_eq!(encoded["command"]["processId"], "agent:main");
        assert_eq!(
            encoded["command"].as_object().map(|value| value.len()),
            Some(2)
        );
    }

    #[test]
    fn request_rejects_unknown_fields() {
        let request_id = RequestId::new();
        let encoded = format!(
            r#"{{"protocolVersion":1,"requestId":"{request_id}","command":{{"type":"activate"}},"draft":"secret"}}"#
        );

        assert!(serde_json::from_str::<Request>(&encoded).is_err());

        let encoded = format!(
            r#"{{"protocolVersion":1,"requestId":"{request_id}","command":{{"type":"activate","draft":"secret"}}}}"#
        );
        assert!(serde_json::from_str::<Request>(&encoded).is_err());
    }

    #[test]
    fn process_ids_are_bounded_and_log_safe() {
        assert_eq!(ProcessId::new(""), Err(InvalidProcessId::Empty));
        assert_eq!(
            ProcessId::new("bad\nvalue"),
            Err(InvalidProcessId::ControlCharacter)
        );
        assert_eq!(
            ProcessId::new("x".repeat(MAX_PROCESS_ID_BYTES + 1)),
            Err(InvalidProcessId::TooLong)
        );
        assert!(ProcessId::new("proc:019c").is_ok());
    }

    #[test]
    fn retryability_is_derived_from_the_typed_code() {
        assert!(ErrorCode::Busy.is_retryable());
        assert!(ErrorCode::Timeout.is_retryable());
        assert!(!ErrorCode::PermissionDenied.is_retryable());
        assert!(!ErrorCode::Internal.is_retryable());
    }
}
