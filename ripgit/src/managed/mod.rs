mod codec;
mod frame_stream;
mod registry;
mod repository;
mod service;

pub use repository::{
    assert_repository_mutation_epoch, delete_repository_contents, ensure_repository_identity,
    handle_repository_managed_request, identity_and_gate_from_headers,
    synchronize_repository_epoch, REPOSITORY_MANAGED_PREFIX,
};
pub use service::{admit_and_forward_named, handle_managed_request, is_mutation};

use futures_util::{Stream, StreamExt};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use worker::{Error, Headers, Request, RequestInit, Response, Result};

pub const MANAGED_PREFIX: &str = "/__gsv/managed/v1/ripgit";
pub const REGISTRY_NAME: &str = "singleton";
pub const INTERNAL_MANAGED_HEADER: &str = "X-GSV-Ripgit-Managed-Internal";
pub const INTERNAL_CONTROL_HEADER: &str = "X-GSV-Ripgit-Control-Internal";
pub const INTERNAL_OWNER_HEADER: &str = "X-GSV-Ripgit-Owner";
pub const INTERNAL_REPO_HEADER: &str = "X-GSV-Ripgit-Repo";
pub const INTERNAL_PROVIDER_ID_HEADER: &str = "X-GSV-Ripgit-Provider-Id";
pub const INTERNAL_EPOCH_HEADER: &str = "X-GSV-Ripgit-Gate-Epoch";
pub const INTERNAL_GATE_STATUS_HEADER: &str = "X-GSV-Ripgit-Gate-Status";
pub const MAX_MANAGED_JSON_BYTES: usize = 12 * 1024 * 1024;

pub fn is_managed_service_path(path: &str) -> bool {
    path == MANAGED_PREFIX
        || path
            .strip_prefix(MANAGED_PREFIX)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub fn is_reserved_managed_path(path: &str) -> bool {
    path == "/__gsv/managed" || path.starts_with("/__gsv/managed/")
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedObjectLifecycle {
    pub status: String,
    pub epoch: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedObjectDescriptor {
    pub schema_version: i64,
    pub kind: String,
    pub provider_id: String,
    pub logical_name: Option<String>,
    pub classification: String,
    pub lifecycle: ManagedObjectLifecycle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedObjectDescriptorBatch {
    pub schema_version: i64,
    pub kind: String,
    pub objects: Vec<ManagedObjectDescriptor>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RepositoryIdentity {
    pub owner: String,
    pub repo: String,
    pub provider_id: String,
}

impl RepositoryIdentity {
    pub fn new(owner: &str, repo: &str, provider_id: &str) -> ManagedResult<Self> {
        let identity = Self {
            owner: owner.to_string(),
            repo: repo.to_string(),
            provider_id: provider_id.to_string(),
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn validate(&self) -> ManagedResult<()> {
        validate_identity_part(&self.owner, "owner")?;
        validate_identity_part(&self.repo, "repository")?;
        if self.provider_id.len() != 64
            || !self
                .provider_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ManagedError::bad_request(
                "invalid_provider_id",
                "Repository provider ID must be 64 lowercase hexadecimal characters",
            ));
        }
        Ok(())
    }

    pub fn do_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

pub(super) fn validate_identity_part(value: &str, label: &str) -> ManagedResult<()> {
    if value.is_empty()
        || value.len() > 512
        || value.contains('/')
        || value.chars().any(char::is_control)
    {
        return Err(ManagedError::bad_request(
            "invalid_repository_identity",
            format!("Repository {} is invalid", label),
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Active,
    Paused,
    Resuming,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErasureStatus {
    Ready,
    Erasing,
    Erased,
}

impl ErasureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Erasing => "erasing",
            Self::Erased => "erased",
        }
    }

    pub fn parse(value: &str) -> ManagedResult<Self> {
        match value {
            "ready" => Ok(Self::Ready),
            "erasing" => Ok(Self::Erasing),
            "erased" => Ok(Self::Erased),
            _ => Err(ManagedError::internal(
                "invalid_erasure_state",
                "Managed repository erasure state is invalid",
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErasureState {
    pub status: ErasureStatus,
    pub epoch: i64,
}

impl GateStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Resuming => "resuming",
        }
    }

    pub fn as_descriptor_status(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Resuming => "updating",
        }
    }

    pub fn parse(value: &str) -> ManagedResult<Self> {
        match value {
            "active" => Ok(Self::Active),
            "paused" => Ok(Self::Paused),
            "resuming" => Ok(Self::Resuming),
            _ => Err(ManagedError::internal(
                "invalid_gate_state",
                "Managed repository gate contains an invalid state",
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateState {
    pub status: GateStatus,
    pub epoch: i64,
}

impl GateState {
    pub fn pause(&self) -> ManagedResult<Self> {
        match self.status {
            GateStatus::Active => Ok(Self {
                status: GateStatus::Paused,
                epoch: checked_next_epoch(self.epoch)?,
            }),
            GateStatus::Paused => Ok(self.clone()),
            GateStatus::Resuming => Err(ManagedError::conflict(
                "gate_transition_in_progress",
                "Managed repository resume is still in progress",
            )),
        }
    }

    pub fn begin_resume(&self) -> ManagedResult<Self> {
        match self.status {
            GateStatus::Paused => Ok(Self {
                status: GateStatus::Resuming,
                epoch: checked_next_epoch(self.epoch)?,
            }),
            GateStatus::Resuming | GateStatus::Active => Ok(self.clone()),
        }
    }

    pub fn require_epoch(&self, expected: i64) -> ManagedResult<()> {
        if self.epoch != expected {
            return Err(ManagedError::conflict(
                "stale_managed_epoch",
                format!(
                    "Managed repository epoch {} does not match current epoch {}",
                    expected, self.epoch
                ),
            ));
        }
        Ok(())
    }
}

fn checked_next_epoch(epoch: i64) -> ManagedResult<i64> {
    epoch.checked_add(1).ok_or_else(|| {
        ManagedError::internal(
            "managed_epoch_exhausted",
            "Managed repository lifecycle epoch is exhausted",
        )
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedErrorBody {
    pub error: String,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

pub type ManagedResult<T> = std::result::Result<T, ManagedError>;

impl ManagedError {
    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(400, code, message)
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(403, code, message)
    }

    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(404, code, message)
    }

    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(409, code, message)
    }

    pub fn unavailable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(503, code, message)
    }

    pub fn internal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(500, code, message)
    }

    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn into_response(self) -> Result<Response> {
        json_response(
            &ManagedErrorBody {
                error: self.code,
                message: self.message,
            },
            self.status,
        )
    }
}

impl From<Error> for ManagedError {
    fn from(_error: Error) -> Self {
        Self::internal(
            "managed_storage_error",
            "Managed repository storage operation failed",
        )
    }
}

impl From<serde_json::Error> for ManagedError {
    fn from(_error: serde_json::Error) -> Self {
        Self::bad_request(
            "invalid_json",
            "Managed repository request contains invalid JSON",
        )
    }
}

pub async fn read_json<T: DeserializeOwned>(req: &mut Request) -> ManagedResult<T> {
    if let Some(length) = req
        .headers()
        .get("Content-Length")
        .map_err(ManagedError::from)?
    {
        let parsed = length.parse::<usize>().map_err(|_| {
            ManagedError::bad_request("invalid_content_length", "Content-Length is invalid")
        })?;
        if parsed > MAX_MANAGED_JSON_BYTES {
            // ByteStream cancels its ReadableStream when dropped. Acquire it
            // before rejecting a declared-oversize body so this boundary owns
            // the body even though no bytes need to be read.
            let _body = req.stream();
            return Err(ManagedError::new(
                413,
                "managed_request_too_large",
                "Managed repository request is too large",
            ));
        }
    }
    let source = req.stream().map_err(ManagedError::from)?;
    let bytes = collect_bounded_bytes(source, MAX_MANAGED_JSON_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(ManagedError::from)
}

async fn collect_bounded_bytes<S>(source: S, limit: usize) -> ManagedResult<Vec<u8>>
where
    S: Stream<Item = Result<Vec<u8>>>,
{
    let mut source = Box::pin(source);
    let mut bytes = Vec::new();
    while let Some(chunk) = source.next().await {
        let chunk = chunk.map_err(ManagedError::from)?;
        let next_len = bytes.len().checked_add(chunk.len()).ok_or_else(|| {
            ManagedError::new(
                413,
                "managed_request_too_large",
                "Managed repository request is too large",
            )
        })?;
        if next_len > limit {
            return Err(ManagedError::new(
                413,
                "managed_request_too_large",
                "Managed repository request is too large",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn json_response<T: Serialize>(value: &T, status: u16) -> Result<Response> {
    let mut response = Response::from_json(value)?.with_status(status);
    response.headers_mut().set("Cache-Control", "no-store")?;
    response
        .headers_mut()
        .set("Content-Type", "application/json; charset=utf-8")?;
    Ok(response)
}

pub fn json_request<T: Serialize>(url: &str, value: &T) -> Result<Request> {
    let body = serde_json::to_string(value).map_err(|error| Error::RustError(error.to_string()))?;
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set(INTERNAL_MANAGED_HEADER, "1")?;
    headers.set(INTERNAL_CONTROL_HEADER, "1")?;
    let mut init = RequestInit::new();
    init.with_method(worker::Method::Post);
    init.with_headers(headers);
    init.with_body(Some(body.into()));
    Request::new_with_init(url, &init)
}

pub fn verify_legacy_mapping(
    supplied_provider_id: &str,
    derived_provider_id: &str,
) -> ManagedResult<()> {
    if supplied_provider_id != derived_provider_id {
        return Err(ManagedError::conflict(
            "legacy_repository_mapping_mismatch",
            "Operator-supplied owner/repository does not derive the supplied provider ID",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    fn identity() -> RepositoryIdentity {
        RepositoryIdentity::new("alice", "memory", &"a".repeat(64)).unwrap()
    }

    #[test]
    fn identity_validation_is_exact() {
        assert_eq!(identity().do_name(), "alice/memory");
        assert!(RepositoryIdentity::new("", "memory", &"a".repeat(64)).is_err());
        assert!(RepositoryIdentity::new("alice", "bad/repo", &"a".repeat(64)).is_err());
        assert!(RepositoryIdentity::new("alice", "memory", &"A".repeat(64)).is_err());
    }

    #[test]
    fn gate_epochs_are_monotonic_and_idempotent() {
        let active = GateState {
            status: GateStatus::Active,
            epoch: 7,
        };
        let paused = active.pause().unwrap();
        assert_eq!(paused.epoch, 8);
        assert_eq!(paused.pause().unwrap(), paused);
        let resuming = paused.begin_resume().unwrap();
        assert_eq!(resuming.status, GateStatus::Resuming);
        assert_eq!(resuming.status.as_descriptor_status(), "updating");
        assert_eq!(resuming.epoch, 9);
        assert!(resuming.require_epoch(8).is_err());
    }

    #[test]
    fn legacy_mapping_requires_provider_id_equality() {
        assert!(verify_legacy_mapping(&"a".repeat(64), &"a".repeat(64)).is_ok());
        let error = verify_legacy_mapping(&"a".repeat(64), &"b".repeat(64)).unwrap_err();
        assert_eq!(error.code, "legacy_repository_mapping_mismatch");
    }

    #[test]
    fn managed_control_paths_cannot_fall_through_to_named_repositories() {
        assert!(is_managed_service_path(
            "/__gsv/managed/v1/ripgit/objects/describe"
        ));
        assert!(is_reserved_managed_path(
            "/__gsv/managed/repository/v1/descriptor"
        ));
        assert!(!is_managed_service_path(
            "/__gsv/managed/v1/ripgit-impersonator"
        ));
        assert!(is_reserved_managed_path(
            "/__gsv/managed/v1/ripgit-impersonator"
        ));
    }

    #[test]
    fn bounded_json_collection_accepts_the_exact_limit() {
        let bytes = futures_executor::block_on(collect_bounded_bytes(
            stream::iter([Ok(vec![1_u8, 2]), Ok(vec![3_u8, 4])]),
            4,
        ))
        .unwrap();
        assert_eq!(bytes, vec![1, 2, 3, 4]);
    }

    #[test]
    fn bounded_json_collection_rejects_chunked_oversize_input() {
        let error = futures_executor::block_on(collect_bounded_bytes(
            stream::iter([Ok(vec![1_u8, 2]), Ok(vec![3_u8, 4, 5])]),
            4,
        ))
        .unwrap_err();
        assert_eq!(error.status, 413);
        assert_eq!(error.code, "managed_request_too_large");
    }
}
