use std::fmt;

use serde::{de, Deserialize, Deserializer, Serialize};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 2;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_PROCESS_ID_BYTES: usize = 256;
const MAX_MICROPHONE_NAME_BYTES: usize = 256;
pub const MAX_MICROPHONE_DEVICES: usize = 32;

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

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct MicrophoneName(String);

impl MicrophoneName {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidMicrophoneName> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidMicrophoneName::Empty);
        }
        if value.trim() != value {
            return Err(InvalidMicrophoneName::SurroundingWhitespace);
        }
        if value.len() > MAX_MICROPHONE_NAME_BYTES {
            return Err(InvalidMicrophoneName::TooLong);
        }
        if value.chars().any(char::is_control) {
            return Err(InvalidMicrophoneName::ControlCharacter);
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

impl fmt::Display for MicrophoneName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl<'de> Deserialize<'de> for MicrophoneName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum InvalidMicrophoneName {
    #[error("microphone name must not be empty")]
    Empty,
    #[error("microphone name exceeds 256 bytes")]
    TooLong,
    #[error("microphone name must not contain leading or trailing whitespace")]
    SurroundingWhitespace,
    #[error("microphone name must not contain control characters")]
    ControlCharacter,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MicrophoneDevice {
    pub name: MicrophoneName,
    pub is_default: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MicrophoneSelection {
    Ask,
    SystemDefault,
    Device { name: MicrophoneName },
}

impl<'de> Deserialize<'de> for MicrophoneSelection {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let serde_json::Value::Object(mut fields) = serde_json::Value::deserialize(deserializer)?
        else {
            return Err(de::Error::custom("microphone selection must be an object"));
        };
        let selection_type = fields
            .remove("type")
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .ok_or_else(|| de::Error::custom("microphone selection type is required"))?;

        match selection_type.as_str() {
            "ask" if fields.is_empty() => Ok(Self::Ask),
            "systemDefault" if fields.is_empty() => Ok(Self::SystemDefault),
            "device" if fields.len() == 1 && fields.contains_key("name") => {
                let name = fields
                    .remove("name")
                    .ok_or_else(|| de::Error::custom("name is required"))?;
                let name = serde_json::from_value(name)
                    .map_err(|_| de::Error::custom("name is invalid"))?;
                Ok(Self::Device { name })
            }
            "ask" | "systemDefault" | "device" => Err(de::Error::custom(
                "microphone selection contains unexpected fields",
            )),
            _ => Err(de::Error::custom(
                "microphone selection type is unsupported",
            )),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MicrophoneEnvironmentOverride {
    Active { name: MicrophoneName },
    Invalid,
}

impl<'de> Deserialize<'de> for MicrophoneEnvironmentOverride {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let serde_json::Value::Object(mut fields) = serde_json::Value::deserialize(deserializer)?
        else {
            return Err(de::Error::custom(
                "microphone environment override must be an object",
            ));
        };
        let override_type = fields
            .remove("type")
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .ok_or_else(|| de::Error::custom("microphone environment override type is required"))?;

        match override_type.as_str() {
            "active" if fields.len() == 1 && fields.contains_key("name") => {
                let name = fields
                    .remove("name")
                    .ok_or_else(|| de::Error::custom("name is required"))?;
                let name = serde_json::from_value(name)
                    .map_err(|_| de::Error::custom("name is invalid"))?;
                Ok(Self::Active { name })
            }
            "invalid" if fields.is_empty() => Ok(Self::Invalid),
            "active" | "invalid" => Err(de::Error::custom(
                "microphone environment override contains unexpected fields",
            )),
            _ => Err(de::Error::custom(
                "microphone environment override type is unsupported",
            )),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneStatus {
    devices: Vec<MicrophoneDevice>,
    selected: MicrophoneSelection,
    environment_override: Option<MicrophoneEnvironmentOverride>,
}

impl MicrophoneStatus {
    pub fn new(
        devices: Vec<MicrophoneDevice>,
        selected: MicrophoneSelection,
        environment_override: Option<MicrophoneEnvironmentOverride>,
    ) -> Result<Self, InvalidMicrophoneStatus> {
        if devices.len() > MAX_MICROPHONE_DEVICES {
            return Err(InvalidMicrophoneStatus::TooManyDevices);
        }
        Ok(Self {
            devices,
            selected,
            environment_override,
        })
    }

    #[must_use]
    pub fn devices(&self) -> &[MicrophoneDevice] {
        &self.devices
    }

    #[must_use]
    pub fn selected(&self) -> &MicrophoneSelection {
        &self.selected
    }

    #[must_use]
    pub fn environment_override(&self) -> Option<&MicrophoneEnvironmentOverride> {
        self.environment_override.as_ref()
    }
}

impl<'de> Deserialize<'de> for MicrophoneStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct WireStatus {
            devices: Vec<MicrophoneDevice>,
            selected: MicrophoneSelection,
            environment_override: Option<MicrophoneEnvironmentOverride>,
        }

        let value = WireStatus::deserialize(deserializer)?;
        Self::new(value.devices, value.selected, value.environment_override)
            .map_err(de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum InvalidMicrophoneStatus {
    #[error("microphone device list exceeds 32 entries")]
    TooManyDevices,
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
    MicrophoneList,
    MicrophoneUse { name: MicrophoneName },
    MicrophoneDefault,
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
            "microphoneList" if fields.is_empty() => Ok(Self::MicrophoneList),
            "microphoneUse" if fields.len() == 1 && fields.contains_key("name") => {
                let name = fields
                    .remove("name")
                    .ok_or_else(|| de::Error::custom("name is required"))?;
                let name = serde_json::from_value(name)
                    .map_err(|_| de::Error::custom("name is invalid"))?;
                Ok(Self::MicrophoneUse { name })
            }
            "microphoneDefault" if fields.is_empty() => Ok(Self::MicrophoneDefault),
            "activate" | "status" | "new" | "use" | "microphoneList" | "microphoneUse"
            | "microphoneDefault" => Err(de::Error::custom("command contains unexpected fields")),
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
    MicrophonesListed { status: MicrophoneStatus },
    MicrophoneSelected { status: MicrophoneStatus },
    DefaultMicrophoneSelected { status: MicrophoneStatus },
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
            "microphonesListed" | "microphoneSelected" | "defaultMicrophoneSelected"
                if fields.len() == 1 && fields.contains_key("status") =>
            {
                let status = fields
                    .remove("status")
                    .ok_or_else(|| de::Error::custom("status is required"))?;
                let status = serde_json::from_value(status)
                    .map_err(|_| de::Error::custom("status is invalid"))?;
                match response_type.as_str() {
                    "microphonesListed" => Ok(Self::MicrophonesListed { status }),
                    "microphoneSelected" => Ok(Self::MicrophoneSelected { status }),
                    "defaultMicrophoneSelected" => Ok(Self::DefaultMicrophoneSelected { status }),
                    _ => unreachable!("response type was matched above"),
                }
            }
            "activated"
            | "status"
            | "created"
            | "selected"
            | "microphonesListed"
            | "microphoneSelected"
            | "defaultMicrophoneSelected" => {
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
            r#"{{"protocolVersion":{PROTOCOL_VERSION},"requestId":"{request_id}","command":{{"type":"activate"}},"draft":"secret"}}"#
        );

        assert!(serde_json::from_str::<Request>(&encoded).is_err());

        let encoded = format!(
            r#"{{"protocolVersion":{PROTOCOL_VERSION},"requestId":"{request_id}","command":{{"type":"activate","draft":"secret"}}}}"#
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
    fn microphone_names_are_bounded_and_log_safe() {
        assert_eq!(MicrophoneName::new(""), Err(InvalidMicrophoneName::Empty));
        assert_eq!(
            MicrophoneName::new("bad\nvalue"),
            Err(InvalidMicrophoneName::ControlCharacter)
        );
        assert_eq!(
            MicrophoneName::new(" Shure MV6"),
            Err(InvalidMicrophoneName::SurroundingWhitespace)
        );
        assert_eq!(
            MicrophoneName::new("Shure MV6 "),
            Err(InvalidMicrophoneName::SurroundingWhitespace)
        );
        assert_eq!(
            MicrophoneName::new("x".repeat(MAX_MICROPHONE_NAME_BYTES + 1)),
            Err(InvalidMicrophoneName::TooLong)
        );
        assert_eq!(
            MicrophoneName::new("é".repeat(129)),
            Err(InvalidMicrophoneName::TooLong),
            "the bound is measured in encoded bytes"
        );
        assert!(MicrophoneName::new("Shure MV6, USB Audio").is_ok());
    }

    #[test]
    fn microphone_commands_round_trip_and_reject_extra_fields() {
        let name = MicrophoneName::new("Shure MV6").expect("valid microphone name");
        for command in [
            Command::MicrophoneList,
            Command::MicrophoneUse { name },
            Command::MicrophoneDefault,
        ] {
            let encoded = serde_json::to_value(&command).expect("command serializes");
            let decoded: Command = serde_json::from_value(encoded).expect("command deserializes");
            assert_eq!(decoded, command);
        }

        assert!(serde_json::from_value::<Command>(serde_json::json!({
            "type": "microphoneList",
            "scope": "all"
        }))
        .is_err());
        assert!(serde_json::from_value::<Command>(serde_json::json!({
            "type": "microphoneUse",
            "name": "Shure MV6",
            "persist": true
        }))
        .is_err());
        assert!(serde_json::from_value::<Command>(serde_json::json!({
            "type": "microphoneDefault",
            "name": "secret"
        }))
        .is_err());
    }

    #[test]
    fn microphone_status_is_strict_and_device_bounded() {
        let status = microphone_status();
        let encoded = serde_json::to_value(&status).expect("status serializes");
        assert_eq!(
            serde_json::from_value::<MicrophoneStatus>(encoded).expect("status deserializes"),
            status
        );

        assert!(
            serde_json::from_value::<MicrophoneDevice>(serde_json::json!({
                "name": "Built-in Microphone",
                "isDefault": true,
                "id": "private-system-id"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<MicrophoneStatus>(serde_json::json!({
                "devices": [],
                "selected": { "type": "ask" },
                "environmentOverride": null,
                "credential": "secret"
            }))
            .is_err()
        );

        let devices = (0..=MAX_MICROPHONE_DEVICES)
            .map(|index| {
                serde_json::json!({
                    "name": format!("Microphone {index}"),
                    "isDefault": index == 0
                })
            })
            .collect::<Vec<_>>();
        assert!(
            serde_json::from_value::<MicrophoneStatus>(serde_json::json!({
                "devices": devices,
                "selected": { "type": "ask" },
                "environmentOverride": null
            }))
            .is_err()
        );

        let devices = (0..=MAX_MICROPHONE_DEVICES)
            .map(|index| MicrophoneDevice {
                name: MicrophoneName::new(format!("Microphone {index}"))
                    .expect("valid microphone name"),
                is_default: index == 0,
            })
            .collect();
        assert_eq!(
            MicrophoneStatus::new(devices, MicrophoneSelection::Ask, None),
            Err(InvalidMicrophoneStatus::TooManyDevices)
        );
    }

    #[test]
    fn microphone_selections_round_trip_and_are_strict() {
        for selection in [
            MicrophoneSelection::Ask,
            MicrophoneSelection::SystemDefault,
            MicrophoneSelection::Device {
                name: MicrophoneName::new("Shure MV6").expect("valid microphone name"),
            },
        ] {
            let encoded = serde_json::to_value(&selection).expect("selection serializes");
            let decoded: MicrophoneSelection =
                serde_json::from_value(encoded).expect("selection deserializes");
            assert_eq!(decoded, selection);
        }

        assert!(
            serde_json::from_value::<MicrophoneSelection>(serde_json::json!({
                "type": "ask",
                "name": "unexpected"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<MicrophoneSelection>(serde_json::json!({
                "type": "device",
                "name": "Shure MV6",
                "id": "private-system-id"
            }))
            .is_err()
        );
    }

    #[test]
    fn microphone_environment_overrides_round_trip_without_leaking_invalid_values() {
        for environment_override in [
            MicrophoneEnvironmentOverride::Active {
                name: MicrophoneName::new("Shure MV6").expect("valid microphone name"),
            },
            MicrophoneEnvironmentOverride::Invalid,
        ] {
            let encoded = serde_json::to_value(&environment_override).expect("override serializes");
            let decoded: MicrophoneEnvironmentOverride =
                serde_json::from_value(encoded.clone()).expect("override deserializes");
            assert_eq!(decoded, environment_override);
            if environment_override == MicrophoneEnvironmentOverride::Invalid {
                assert_eq!(encoded, serde_json::json!({ "type": "invalid" }));
            }
        }

        assert!(
            serde_json::from_value::<MicrophoneEnvironmentOverride>(serde_json::json!({
                "type": "invalid",
                "value": "private invalid value"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<MicrophoneEnvironmentOverride>(serde_json::json!({
                "type": "active",
                "name": "Shure MV6",
                "value": "unexpected"
            }))
            .is_err()
        );
    }

    #[test]
    fn microphone_successes_round_trip_and_reject_extra_fields() {
        for response in [
            Success::MicrophonesListed {
                status: microphone_status(),
            },
            Success::MicrophoneSelected {
                status: microphone_status(),
            },
            Success::DefaultMicrophoneSelected {
                status: microphone_status(),
            },
        ] {
            let encoded = serde_json::to_value(&response).expect("response serializes");
            let decoded: Success = serde_json::from_value(encoded).expect("response deserializes");
            assert_eq!(decoded, response);
        }

        assert!(serde_json::from_value::<Success>(serde_json::json!({
            "type": "microphonesListed",
            "status": {
                "devices": [],
                "selected": { "type": "ask" },
                "environmentOverride": null
            },
            "path": "/private"
        }))
        .is_err());
    }

    #[test]
    fn desktop_status_never_accepts_microphone_names() {
        assert!(serde_json::from_value::<DesktopStatus>(serde_json::json!({
            "gateway": "connected",
            "window": "focused",
            "selectedProcess": null,
            "selectedMicrophone": "Shure MV6"
        }))
        .is_err());
    }

    fn microphone_status() -> MicrophoneStatus {
        MicrophoneStatus::new(
            vec![MicrophoneDevice {
                name: MicrophoneName::new("Built-in Microphone").expect("valid microphone name"),
                is_default: true,
            }],
            MicrophoneSelection::Device {
                name: MicrophoneName::new("Shure MV6").expect("valid microphone name"),
            },
            None,
        )
        .expect("valid microphone status")
    }

    #[test]
    fn retryability_is_derived_from_the_typed_code() {
        assert!(ErrorCode::Busy.is_retryable());
        assert!(ErrorCode::Timeout.is_retryable());
        assert!(!ErrorCode::PermissionDenied.is_retryable());
        assert!(!ErrorCode::Internal.is_retryable());
    }
}
