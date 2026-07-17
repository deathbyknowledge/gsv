use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use worker::{Env, Method, Request, RequestInit, Response, Result};

use super::codec::{SnapshotManifest, SnapshotPage};
use super::frame_stream::{
    parse_canonical_json, validate_identifier, validate_sha256_base64_url, DataFrameReader,
    ObjectSemanticDigestV1, DATA_FRAME_STREAM_MEDIA_TYPE, MAX_DATA_FRAME_COUNT,
    MAX_DATA_TOTAL_BODY_BYTES, MAX_RESTORE_CONTROL_BODY_BYTES, RESTORE_CONTROL_KIND,
    RESTORE_CONTROL_MEDIA_TYPE, RIPGIT_MANIFEST_KIND, RIPGIT_MANIFEST_MEDIA_TYPE, RIPGIT_PAGE_KIND,
    RIPGIT_PAGE_MEDIA_TYPE,
};
use super::registry::{
    call_registry, AcknowledgeRequest, AdmissionRequest, AdmissionResponse,
    EraseAcknowledgeRequest, EraseProgressResponse, InventoryRequest, InventoryResponse,
    LegacyMappingRequest, ProviderRequest, RegistryRecord, TransitionResponse,
};
use super::repository::{
    RepositoryEraseResponse, RepositoryLifecycleResponse, REPOSITORY_MANAGED_PREFIX,
};
use super::{
    json_request, json_response, read_json, verify_legacy_mapping, ErasureState, ErasureStatus,
    GateState, GateStatus, ManagedError, ManagedErrorBody, ManagedObjectDescriptor,
    ManagedObjectDescriptorBatch, ManagedResult, RepositoryIdentity, INTERNAL_CONTROL_HEADER,
    INTERNAL_EPOCH_HEADER, INTERNAL_GATE_STATUS_HEADER, INTERNAL_MANAGED_HEADER,
    INTERNAL_OWNER_HEADER, INTERNAL_PROVIDER_ID_HEADER, INTERNAL_REPO_HEADER, MANAGED_PREFIX,
    REGISTRY_NAME,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleBatchResponse {
    gate: GateState,
    erasure: ErasureState,
    pending_repositories: i64,
    repositories: Vec<RepositoryLifecycleResponse>,
    next_cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EraseBatchResponse {
    gate: GateState,
    erasure: ErasureState,
    erased_repositories: Vec<RepositoryEraseResponse>,
    next_cursor: Option<String>,
    remaining_repositories: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifestRequest {
    provider_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPagePayload {
    manifest_hash: String,
    table_index: usize,
    offset: i64,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPageRequest {
    provider_id: String,
    #[serde(flatten)]
    payload: SnapshotPagePayload,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreBeginPayload {
    restore_id: String,
    manifest: SnapshotManifest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreBeginRequest {
    provider_id: String,
    #[serde(flatten)]
    payload: RestoreBeginPayload,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreApplyPayload {
    restore_id: String,
    page: SnapshotPage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreApplyRequest {
    provider_id: String,
    #[serde(flatten)]
    payload: RestoreApplyPayload,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreSealPayload {
    restore_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreSealRequest {
    provider_id: String,
    #[serde(flatten)]
    payload: RestoreSealPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DescribeObjectsRequest {
    kind: String,
    provider_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FramedSnapshotRequest {
    component: String,
    kind: String,
    provider_id: String,
    logical_name: String,
    object_id: String,
    fence_epoch: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RestoreControl {
    component: String,
    kind: String,
    logical_name: String,
    object_id: String,
    restore_id: String,
    fence_epoch: i64,
    frame_count: String,
    body_bytes: String,
    semantic_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreProgressResponse {
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FramedRestoreResponse {
    status: &'static str,
    provider_id: String,
    frame_count: String,
    body_bytes: String,
    semantic_sha256: String,
}

pub async fn handle_managed_request(mut req: Request, env: &Env) -> Result<Response> {
    let result = handle_managed(&mut req, env).await;
    match result {
        Ok(response) => Ok(response),
        Err(error) => {
            let _body = req.stream();
            error.into_response()
        }
    }
}

async fn handle_managed(req: &mut Request, env: &Env) -> ManagedResult<Response> {
    authorize_managed_admin(req, env)?;
    if req.method() != Method::Post {
        return Err(ManagedError::not_found(
            "managed_endpoint_not_found",
            "Managed ripgit endpoint was not found",
        ));
    }
    let path = req.url().map_err(ManagedError::from)?.path().to_string();
    match path.as_str() {
        path if path == format!("{}/status", MANAGED_PREFIX) => {
            let _: serde_json::Value = read_json(req).await?;
            let response: TransitionResponse =
                call_registry(env, "/gate/status", &serde_json::json!({})).await?;
            json_response(&response, 200).map_err(ManagedError::from)
        }
        path if path == format!("{}/inventory", MANAGED_PREFIX) => {
            let request: InventoryRequest = read_json(req).await?;
            let response: InventoryResponse = call_registry(env, "/inventory", &request).await?;
            json_response(&response, 200).map_err(ManagedError::from)
        }
        path if path == format!("{}/objects/describe", MANAGED_PREFIX) => {
            let request: DescribeObjectsRequest = read_json(req).await?;
            describe_objects(env, request).await
        }
        path if path == format!("{}/objects/snapshot", MANAGED_PREFIX) => {
            require_content_type(req, "application/json")?;
            let request: FramedSnapshotRequest = read_json(req).await?;
            snapshot_repository_stream(env, request).await
        }
        path if path == format!("{}/objects/restore", MANAGED_PREFIX) => {
            require_content_type(req, DATA_FRAME_STREAM_MEDIA_TYPE)?;
            restore_repository_stream(env, req).await
        }
        path if path == format!("{}/legacy-map", MANAGED_PREFIX) => {
            let request: LegacyMappingRequest = read_json(req).await?;
            map_legacy_repository(env, request).await
        }
        path if path == format!("{}/pause", MANAGED_PREFIX) => {
            let request: InventoryRequest = read_json(req).await?;
            apply_lifecycle_page(env, request, GateStatus::Paused).await
        }
        path if path == format!("{}/resume", MANAGED_PREFIX) => {
            let request: InventoryRequest = read_json(req).await?;
            apply_lifecycle_page(env, request, GateStatus::Resuming).await
        }
        path if path == format!("{}/erase", MANAGED_PREFIX) => {
            let request: InventoryRequest = read_json(req).await?;
            apply_erase_page(env, request).await
        }
        path if path == format!("{}/snapshot/manifest", MANAGED_PREFIX) => {
            let request: SnapshotManifestRequest = read_json(req).await?;
            let (record, gate) = paused_repository(env, &request.provider_id).await?;
            let response: SnapshotManifest = send_repository(
                env,
                &record,
                &gate,
                &format!("{}/snapshot/manifest", REPOSITORY_MANAGED_PREFIX),
                &serde_json::json!({}),
            )
            .await?;
            json_response(&response, 200).map_err(ManagedError::from)
        }
        path if path == format!("{}/snapshot/page", MANAGED_PREFIX) => {
            let request: SnapshotPageRequest = read_json(req).await?;
            let (record, gate) = paused_repository(env, &request.provider_id).await?;
            let response: SnapshotPage = send_repository(
                env,
                &record,
                &gate,
                &format!("{}/snapshot/page", REPOSITORY_MANAGED_PREFIX),
                &request.payload,
            )
            .await?;
            json_response(&response, 200).map_err(ManagedError::from)
        }
        path if path == format!("{}/restore/begin", MANAGED_PREFIX) => {
            let request: RestoreBeginRequest = read_json(req).await?;
            forward_restore(env, &request.provider_id, "restore/begin", &request.payload).await
        }
        path if path == format!("{}/restore/apply", MANAGED_PREFIX) => {
            let request: RestoreApplyRequest = read_json(req).await?;
            forward_restore(env, &request.provider_id, "restore/apply", &request.payload).await
        }
        path if path == format!("{}/restore/seal", MANAGED_PREFIX) => {
            let request: RestoreSealRequest = read_json(req).await?;
            forward_restore(env, &request.provider_id, "restore/seal", &request.payload).await
        }
        _ => Err(ManagedError::not_found(
            "managed_endpoint_not_found",
            "Managed ripgit endpoint was not found",
        )),
    }
}

fn authorize_managed_admin(req: &Request, env: &Env) -> ManagedResult<()> {
    let expected = env
        .secret("GSV_MANAGED_ADMIN_TOKEN_HASH")
        .map(|secret| secret.to_string())
        .map_err(|_| {
            ManagedError::not_found(
                "managed_endpoint_not_found",
                "Managed ripgit endpoint was not found",
            )
        })?;
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ManagedError::forbidden(
            "managed_endpoint_forbidden",
            "Managed ripgit authorization is not configured correctly",
        ));
    }
    let authorization = req
        .headers()
        .get("Authorization")
        .map_err(ManagedError::from)?
        .unwrap_or_default();
    let candidate = authorization
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty() && !token.chars().any(char::is_whitespace))
        .unwrap_or("");
    let actual = Sha256::digest(candidate.as_bytes());
    let expected = decode_hex_digest(&expected)?;
    let difference = actual
        .iter()
        .zip(expected)
        .fold(0_u8, |difference, (actual, expected)| {
            difference | (actual ^ expected)
        });
    if difference != 0 {
        return Err(ManagedError::forbidden(
            "managed_endpoint_forbidden",
            "Managed ripgit authorization failed",
        ));
    }
    Ok(())
}

fn decode_hex_digest(value: &str) -> ManagedResult<[u8; 32]> {
    if value.len() != 64 {
        return Err(ManagedError::forbidden(
            "managed_endpoint_forbidden",
            "Managed ripgit authorization is not configured correctly",
        ));
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).map_err(|_| {
            ManagedError::forbidden(
                "managed_endpoint_forbidden",
                "Managed ripgit authorization is not configured correctly",
            )
        })?;
    }
    Ok(bytes)
}

async fn snapshot_repository_stream(
    env: &Env,
    request: FramedSnapshotRequest,
) -> ManagedResult<Response> {
    require_repository_kind(&request.component, &request.kind)?;
    validate_fence_epoch(request.fence_epoch)?;
    let identity =
        identity_from_logical_name(env, &request.logical_name, Some(&request.provider_id))?;
    ObjectSemanticDigestV1::new(&request.object_id)?;
    let (record, gate) =
        paused_repository_at_epoch(env, &identity.provider_id, request.fence_epoch).await?;
    require_registry_identity(&record, &identity)?;
    let mut response = send_repository_response(
        env,
        &record,
        &gate,
        &format!("{}/snapshot/framed", REPOSITORY_MANAGED_PREFIX),
        &serde_json::json!({ "objectId": request.object_id }),
    )
    .await?;
    if !(200..300).contains(&response.status_code()) {
        let _: serde_json::Value = decode_response(&mut response).await?;
        return Err(ManagedError::internal(
            "managed_repository_invalid_response",
            "Managed repository returned an unexpected snapshot response",
        ));
    }
    let content_type = response
        .headers()
        .get("Content-Type")
        .map_err(ManagedError::from)?
        .unwrap_or_default();
    if content_type != DATA_FRAME_STREAM_MEDIA_TYPE {
        return Err(ManagedError::internal(
            "managed_repository_invalid_response",
            "Managed repository returned an invalid snapshot content type",
        ));
    }
    Ok(response)
}

async fn restore_repository_stream(env: &Env, req: &mut Request) -> ManagedResult<Response> {
    let source = req.stream().map_err(|_| {
        ManagedError::bad_request(
            "managed_restore_body_required",
            "Managed ripgit restore requires a framed request body",
        )
    })?;
    let mut reader = DataFrameReader::with_first_body_limit(source, MAX_RESTORE_CONTROL_BODY_BYTES);
    let control_record = reader.next_record().await?.ok_or_else(|| {
        ManagedError::bad_request(
            "restore_control_required",
            "Managed ripgit restore is missing its control record",
        )
    })?;
    if control_record.kind != RESTORE_CONTROL_KIND
        || control_record.part != 0
        || control_record.body_media_type != RESTORE_CONTROL_MEDIA_TYPE
        || control_record.body.len() > MAX_RESTORE_CONTROL_BODY_BYTES
    {
        return Err(ManagedError::bad_request(
            "invalid_restore_control",
            "Managed ripgit restore must begin with its canonical control record",
        ));
    }
    let control: RestoreControl =
        serde_json::from_value(parse_canonical_json(&control_record.body)?).map_err(|_| {
            ManagedError::bad_request(
                "invalid_restore_control",
                "Managed ripgit restore control record has an invalid shape",
            )
        })?;
    validate_restore_control(&control, &control_record.object_id)?;
    let expected_frames =
        parse_decimal_count(&control.frame_count, "frameCount", MAX_DATA_FRAME_COUNT)?;
    if expected_frames == 0 {
        return Err(ManagedError::bad_request(
            "invalid_restore_control",
            "Managed ripgit restore must contain a manifest frame",
        ));
    }
    let expected_body_bytes =
        parse_decimal_count(&control.body_bytes, "bodyBytes", MAX_DATA_TOTAL_BODY_BYTES)?;

    let identity = identity_from_logical_name(env, &control.logical_name, None)?;
    let target_provider_id = identity.provider_id.clone();

    let mut semantic = ObjectSemanticDigestV1::new(&control.object_id)?;
    let mut observed_frames = 0_u64;
    let mut observed_body_bytes = 0_u64;
    let mut manifest: Option<SnapshotManifest> = None;
    let mut replayed = false;

    while let Some(record) = reader.next_record().await? {
        if record.object_id != control.object_id {
            return Err(ManagedError::bad_request(
                "restore_object_id_mismatch",
                "Ripgit restore frame belongs to a different logical object",
            ));
        }
        observed_frames = observed_frames.checked_add(1).ok_or_else(|| {
            ManagedError::bad_request(
                "managed_frame_limit_exceeded",
                "Ripgit restore contains too many frames",
            )
        })?;
        observed_body_bytes = observed_body_bytes
            .checked_add(record.body.len() as u64)
            .ok_or_else(|| {
                ManagedError::bad_request(
                    "managed_frame_limit_exceeded",
                    "Ripgit restore body bytes overflowed",
                )
            })?;
        if observed_frames > expected_frames || observed_body_bytes > expected_body_bytes {
            return Err(ManagedError::bad_request(
                "restore_inventory_mismatch",
                "Ripgit restore exceeds its declared frame inventory",
            ));
        }
        semantic.append(&record)?;

        match record.kind.as_str() {
            RIPGIT_MANIFEST_KIND => {
                if manifest.is_some()
                    || observed_frames != 1
                    || record.part != 0
                    || record.body_media_type != RIPGIT_MANIFEST_MEDIA_TYPE
                {
                    return Err(ManagedError::bad_request(
                        "invalid_restore_manifest_frame",
                        "Ripgit restore manifest frame is invalid or out of order",
                    ));
                }
                let decoded: SnapshotManifest = decode_canonical_frame_json(&record.body)?;
                decoded.verify()?;
                if decoded.body.identity.do_name() != control.logical_name {
                    return Err(ManagedError::conflict(
                        "restore_logical_identity_mismatch",
                        "Ripgit snapshot identity does not match the restore logical name",
                    ));
                }
                ensure_restore_repository(env, &identity, control.fence_epoch).await?;
                let progress: RestoreProgressResponse = send_restore_at_fence(
                    env,
                    &identity,
                    control.fence_epoch,
                    "restore/begin",
                    &RestoreBeginPayload {
                        restore_id: control.restore_id.clone(),
                        manifest: decoded.clone(),
                    },
                )
                .await?;
                replayed = progress.status == "sealed";
                if progress.status != "applying" && progress.status != "sealed" {
                    return Err(ManagedError::internal(
                        "restore_journal_invalid",
                        "Ripgit restore returned an invalid journal state",
                    ));
                }
                manifest = Some(decoded);
            }
            RIPGIT_PAGE_KIND => {
                if record.body_media_type != RIPGIT_PAGE_MEDIA_TYPE {
                    return Err(ManagedError::bad_request(
                        "invalid_restore_page_frame",
                        "Ripgit restore page frame has an invalid media type",
                    ));
                }
                let expected_manifest = manifest.as_ref().ok_or_else(|| {
                    ManagedError::bad_request(
                        "restore_manifest_required",
                        "Ripgit restore pages must follow the manifest frame",
                    )
                })?;
                let page: SnapshotPage = decode_canonical_frame_json(&record.body)?;
                page.verify()?;
                if page.body.manifest_hash != expected_manifest.manifest_hash {
                    return Err(ManagedError::conflict(
                        "restore_manifest_mismatch",
                        "Ripgit restore page belongs to another manifest",
                    ));
                }
                let _: RestoreProgressResponse = send_restore_at_fence(
                    env,
                    &identity,
                    control.fence_epoch,
                    "restore/apply",
                    &RestoreApplyPayload {
                        restore_id: control.restore_id.clone(),
                        page,
                    },
                )
                .await?;
            }
            _ => {
                return Err(ManagedError::bad_request(
                    "invalid_managed_object_kind",
                    "Ripgit restore accepts repository snapshot frames only",
                ));
            }
        }
    }

    let observed_semantic_sha256 = semantic.digest_base64_url();
    if manifest.is_none()
        || observed_frames != expected_frames
        || observed_body_bytes != expected_body_bytes
        || observed_semantic_sha256 != control.semantic_sha256
    {
        return Err(ManagedError::bad_request(
            "restore_inventory_mismatch",
            "Ripgit restore frames do not match the declared inventory",
        ));
    }
    let sealed: RestoreProgressResponse = send_restore_at_fence(
        env,
        &identity,
        control.fence_epoch,
        "restore/seal",
        &RestoreSealPayload {
            restore_id: control.restore_id,
        },
    )
    .await?;
    if sealed.status != "sealed" {
        return Err(ManagedError::internal(
            "restore_journal_invalid",
            "Ripgit restore did not seal its journal",
        ));
    }
    json_response(
        &FramedRestoreResponse {
            status: if replayed { "replayed" } else { "applied" },
            provider_id: target_provider_id,
            frame_count: control.frame_count,
            body_bytes: control.body_bytes,
            semantic_sha256: control.semantic_sha256,
        },
        200,
    )
    .map_err(ManagedError::from)
}

fn validate_restore_control(control: &RestoreControl, record_object_id: &str) -> ManagedResult<()> {
    require_repository_kind(&control.component, &control.kind)?;
    validate_fence_epoch(control.fence_epoch)?;
    validate_restore_id_value(&control.restore_id)?;
    validate_sha256_base64_url(&control.semantic_sha256)?;
    ObjectSemanticDigestV1::new(&control.object_id)?;
    if control.object_id != record_object_id {
        return Err(ManagedError::bad_request(
            "restore_object_id_mismatch",
            "Ripgit restore control object ID does not match its frame",
        ));
    }
    Ok(())
}

fn decode_canonical_frame_json<T: DeserializeOwned>(body: &[u8]) -> ManagedResult<T> {
    serde_json::from_value(parse_canonical_json(body)?).map_err(|_| {
        ManagedError::bad_request(
            "invalid_restore_frame_json",
            "Ripgit restore frame JSON has an invalid shape",
        )
    })
}

fn parse_decimal_count(value: &str, label: &str, maximum: u64) -> ManagedResult<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ManagedError::bad_request(
            "invalid_restore_control",
            format!(
                "Ripgit restore {} must be a canonical unsigned decimal string",
                label
            ),
        ));
    }
    let parsed = value.parse::<u64>().map_err(|_| {
        ManagedError::bad_request(
            "invalid_restore_control",
            format!("Ripgit restore {} is outside the supported range", label),
        )
    })?;
    if parsed > maximum {
        return Err(ManagedError::bad_request(
            "invalid_restore_control",
            format!("Ripgit restore {} exceeds the managed stream limit", label),
        ));
    }
    Ok(parsed)
}

fn validate_restore_id_value(value: &str) -> ManagedResult<()> {
    validate_identifier(value, 1024, "restore ID").map_err(|_| {
        ManagedError::bad_request(
            "invalid_restore_id",
            "Restore ID must be a non-empty, control-free UTF-8 identifier of at most 1024 bytes",
        )
    })
}

fn require_repository_kind(component: &str, kind: &str) -> ManagedResult<()> {
    if component != "ripgit" || kind != "repository" {
        return Err(ManagedError::bad_request(
            "invalid_managed_object_kind",
            "Ripgit framed portability accepts repository objects only",
        ));
    }
    Ok(())
}

fn validate_fence_epoch(epoch: i64) -> ManagedResult<()> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if !(0..=MAX_SAFE_INTEGER).contains(&epoch) {
        return Err(ManagedError::bad_request(
            "invalid_managed_epoch",
            "Managed fence epoch must be a non-negative safe integer",
        ));
    }
    Ok(())
}

fn identity_from_logical_name(
    env: &Env,
    logical_name: &str,
    supplied_provider_id: Option<&str>,
) -> ManagedResult<RepositoryIdentity> {
    let (owner, repo) = logical_name.split_once('/').ok_or_else(|| {
        ManagedError::bad_request(
            "invalid_repository_identity",
            "Repository logical name must be owner/repository",
        )
    })?;
    if repo.contains('/') {
        return Err(ManagedError::bad_request(
            "invalid_repository_identity",
            "Repository logical name must be owner/repository",
        ));
    }
    let namespace = env
        .durable_object("REPOSITORY")
        .map_err(ManagedError::from)?;
    let provider_id = namespace
        .id_from_name(logical_name)
        .map_err(ManagedError::from)?
        .to_string();
    if let Some(supplied) = supplied_provider_id {
        verify_legacy_mapping(supplied, &provider_id)?;
    }
    RepositoryIdentity::new(owner, repo, &provider_id)
}

fn require_registry_identity(
    record: &RegistryRecord,
    expected: &RepositoryIdentity,
) -> ManagedResult<()> {
    if &record.identity != expected {
        return Err(ManagedError::conflict(
            "repository_identity_conflict",
            "Managed repository registry returned a different logical identity",
        ));
    }
    Ok(())
}

async fn ensure_restore_repository(
    env: &Env,
    identity: &RepositoryIdentity,
    fence_epoch: i64,
) -> ManagedResult<()> {
    let status: TransitionResponse =
        call_registry(env, "/gate/status", &serde_json::json!({})).await?;
    require_paused_epoch(&status.gate, fence_epoch)?;
    let record: RegistryRecord = call_registry(
        env,
        "/legacy-map",
        &LegacyMappingRequest {
            identity: identity.clone(),
        },
    )
    .await?;
    require_registry_identity(&record, identity)?;
    let status: TransitionResponse =
        call_registry(env, "/gate/status", &serde_json::json!({})).await?;
    require_paused_epoch(&status.gate, fence_epoch)?;
    let lifecycle: RepositoryLifecycleResponse = send_repository(
        env,
        &record,
        &status.gate,
        &format!("{}/identity", REPOSITORY_MANAGED_PREFIX),
        &serde_json::json!({}),
    )
    .await?;
    let acknowledged: RegistryRecord = call_registry(
        env,
        "/ack",
        &AcknowledgeRequest {
            provider_id: identity.provider_id.clone(),
            status: lifecycle.status,
            epoch: lifecycle.epoch,
        },
    )
    .await?;
    require_registry_identity(&acknowledged, identity)?;
    let (verified, gate) =
        paused_repository_at_epoch(env, &identity.provider_id, fence_epoch).await?;
    require_registry_identity(&verified, identity)?;
    require_paused_epoch(&gate, fence_epoch)
}

async fn send_restore_at_fence<Req: Serialize, Res: DeserializeOwned>(
    env: &Env,
    identity: &RepositoryIdentity,
    fence_epoch: i64,
    operation: &str,
    payload: &Req,
) -> ManagedResult<Res> {
    let (record, gate) =
        paused_repository_at_epoch(env, &identity.provider_id, fence_epoch).await?;
    require_registry_identity(&record, identity)?;
    send_repository(
        env,
        &record,
        &gate,
        &format!("{}/{}", REPOSITORY_MANAGED_PREFIX, operation),
        payload,
    )
    .await
}

fn require_paused_epoch(gate: &GateState, expected_epoch: i64) -> ManagedResult<()> {
    if gate.status != GateStatus::Paused || gate.epoch != expected_epoch {
        return Err(ManagedError::conflict(
            "stale_managed_epoch",
            "Managed repository fence changed during portability operation",
        ));
    }
    Ok(())
}

fn require_content_type(req: &Request, expected: &str) -> ManagedResult<()> {
    let actual = req
        .headers()
        .get("Content-Type")
        .map_err(ManagedError::from)?
        .unwrap_or_default();
    let media_type = actual
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if media_type != expected {
        return Err(ManagedError::new(
            415,
            "managed_content_type_required",
            format!("Managed ripgit endpoint requires {}", expected),
        ));
    }
    Ok(())
}

async fn describe_objects(env: &Env, request: DescribeObjectsRequest) -> ManagedResult<Response> {
    validate_provider_ids(&request.provider_ids)?;
    let (binding, descriptor_path, logical_singleton) = match request.kind.as_str() {
        "repository" => (
            "REPOSITORY",
            format!("{}/descriptor", REPOSITORY_MANAGED_PREFIX),
            false,
        ),
        "repository_registry" => (
            "MANAGED_REPOSITORY_REGISTRY",
            "/descriptor".to_string(),
            true,
        ),
        _ => {
            return Err(ManagedError::bad_request(
                "invalid_managed_object_kind",
                "Ripgit describes only repository and repository_registry objects",
            ));
        }
    };
    let namespace = env.durable_object(binding).map_err(ManagedError::from)?;
    let mut objects = Vec::with_capacity(request.provider_ids.len());
    for provider_id in &request.provider_ids {
        let stub = namespace
            .id_from_string(provider_id)
            .and_then(|id| id.get_stub())
            .map_err(|_| {
                ManagedError::bad_request(
                    "invalid_provider_id",
                    "Managed provider ID is invalid for the requested namespace",
                )
            })?;
        let mut descriptor_request = json_request(
            &format!("https://managed.invalid{}", descriptor_path),
            &serde_json::json!({}),
        )
        .map_err(ManagedError::from)?;
        descriptor_request
            .headers_mut()
            .map_err(ManagedError::from)?
            .set(INTERNAL_MANAGED_HEADER, "1")
            .map_err(ManagedError::from)?;
        let mut response = stub
            .fetch_with_request(descriptor_request)
            .await
            .map_err(ManagedError::from)?;
        let descriptor: ManagedObjectDescriptor = decode_response(&mut response).await?;
        validate_descriptor(&descriptor, &request.kind, provider_id)?;
        if let Some(logical_name) = descriptor.logical_name.as_deref() {
            if logical_singleton && logical_name != REGISTRY_NAME {
                return Err(ManagedError::internal(
                    "managed_descriptor_identity_mismatch",
                    "Registry descriptor has an invalid logical name",
                ));
            }
            let derived = namespace
                .id_from_name(logical_name)
                .map_err(ManagedError::from)?
                .to_string();
            verify_legacy_mapping(provider_id, &derived)?;
        }
        objects.push(descriptor);
    }
    json_response(
        &ManagedObjectDescriptorBatch {
            schema_version: 1,
            kind: request.kind,
            objects,
        },
        200,
    )
    .map_err(ManagedError::from)
}

fn validate_provider_ids(provider_ids: &[String]) -> ManagedResult<()> {
    if provider_ids.len() > 500 {
        return Err(ManagedError::bad_request(
            "too_many_provider_ids",
            "Managed object lookup accepts at most 500 provider IDs",
        ));
    }
    let mut unique = BTreeSet::new();
    for provider_id in provider_ids {
        if provider_id.is_empty()
            || provider_id.len() > 128
            || provider_id.trim() != provider_id
            || provider_id.chars().any(char::is_control)
            || !unique.insert(provider_id)
        {
            return Err(ManagedError::bad_request(
                "invalid_provider_id",
                "Managed provider IDs must be bounded, unique, and free of whitespace or controls",
            ));
        }
    }
    Ok(())
}

fn validate_descriptor(
    descriptor: &ManagedObjectDescriptor,
    kind: &str,
    provider_id: &str,
) -> ManagedResult<()> {
    let valid_classification = matches!(
        descriptor.classification.as_str(),
        "initialized" | "uninitialized" | "erased"
    );
    let valid_status = matches!(
        descriptor.lifecycle.status.as_str(),
        "active" | "paused" | "updating" | "erasing" | "erased" | "uninitialized"
    );
    if descriptor.schema_version != 1
        || descriptor.kind != kind
        || descriptor.provider_id != provider_id
        || !valid_classification
        || !valid_status
        || descriptor.lifecycle.epoch < 0
        || (descriptor.classification == "initialized" && descriptor.logical_name.is_none())
        || (descriptor.classification == "uninitialized"
            && (descriptor.logical_name.is_some()
                || descriptor.lifecycle.status != "uninitialized"))
        || (descriptor.classification == "erased" && descriptor.lifecycle.status != "erased")
    {
        return Err(ManagedError::internal(
            "invalid_managed_object_descriptor",
            "Managed ripgit object returned an invalid descriptor",
        ));
    }
    Ok(())
}

pub async fn admit_and_forward_named(
    mut req: Request,
    env: &Env,
    identity: RepositoryIdentity,
    target_url: &str,
    mutation: bool,
) -> Result<Response> {
    let result = async {
        let admission: AdmissionResponse = call_registry(
            env,
            "/admit",
            &AdmissionRequest {
                identity: identity.clone(),
                mutation,
            },
        )
        .await?;
        let namespace = env
            .durable_object("REPOSITORY")
            .map_err(ManagedError::from)?;
        let stub = namespace
            .id_from_string(&identity.provider_id)
            .and_then(|id| id.get_stub())
            .map_err(ManagedError::from)?;
        let mut forwarded = if req.url().map_err(ManagedError::from)?.as_str() == target_url {
            req.clone_mut().map_err(ManagedError::from)?
        } else {
            let method = req.method();
            let headers = req.headers().clone();
            let mut init = RequestInit::new();
            init.with_method(method.clone());
            init.with_headers(headers);
            if !matches!(method, Method::Get | Method::Head) {
                let body = req.bytes().await.map_err(ManagedError::from)?;
                init.with_body(Some(js_sys::Uint8Array::from(body.as_slice()).into()));
            }
            Request::new_with_init(target_url, &init).map_err(ManagedError::from)?
        };
        set_identity_headers(
            forwarded.headers_mut().map_err(ManagedError::from)?,
            &admission.identity,
            &admission.gate,
        )
        .map_err(ManagedError::from)?;
        forwarded
            .headers_mut()
            .map_err(ManagedError::from)?
            .set(INTERNAL_CONTROL_HEADER, "0")
            .map_err(ManagedError::from)?;
        stub.fetch_with_request(forwarded)
            .await
            .map_err(ManagedError::from)
    }
    .await;
    match result {
        Ok(response) => Ok(response),
        Err(error) => error.into_response(),
    }
}

async fn map_legacy_repository(
    env: &Env,
    request: LegacyMappingRequest,
) -> ManagedResult<Response> {
    request.identity.validate()?;
    let namespace = env
        .durable_object("REPOSITORY")
        .map_err(ManagedError::from)?;
    let derived = namespace
        .id_from_name(&request.identity.do_name())
        .map_err(ManagedError::from)?
        .to_string();
    verify_legacy_mapping(&request.identity.provider_id, &derived)?;
    let record: RegistryRecord = call_registry(env, "/legacy-map", &request).await?;
    let transition: TransitionResponse =
        call_registry(env, "/gate/status", &serde_json::json!({})).await?;
    if transition.gate.status == GateStatus::Resuming {
        return Err(ManagedError::conflict(
            "gate_transition_in_progress",
            "Legacy repository mappings cannot be added while resume is in progress",
        ));
    }
    let lifecycle: RepositoryLifecycleResponse = send_repository(
        env,
        &record,
        &transition.gate,
        &format!("{}/identity", REPOSITORY_MANAGED_PREFIX),
        &serde_json::json!({}),
    )
    .await?;
    let _: RegistryRecord = call_registry(
        env,
        "/ack",
        &AcknowledgeRequest {
            provider_id: record.identity.provider_id.clone(),
            status: lifecycle.status,
            epoch: lifecycle.epoch,
        },
    )
    .await?;
    json_response(&record, 200).map_err(ManagedError::from)
}

async fn apply_lifecycle_page(
    env: &Env,
    request: InventoryRequest,
    operation: GateStatus,
) -> ManagedResult<Response> {
    let transition_path = match operation {
        GateStatus::Paused => "/gate/pause",
        GateStatus::Resuming => "/gate/resume",
        GateStatus::Active => {
            return Err(ManagedError::internal(
                "invalid_lifecycle_operation",
                "Invalid managed lifecycle operation",
            ));
        }
    };
    let transition: TransitionResponse =
        call_registry(env, transition_path, &serde_json::json!({})).await?;
    if operation == GateStatus::Resuming && transition.gate.status == GateStatus::Active {
        return json_response(
            &LifecycleBatchResponse {
                gate: transition.gate,
                erasure: transition.erasure,
                pending_repositories: 0,
                repositories: Vec::new(),
                next_cursor: None,
            },
            200,
        )
        .map_err(ManagedError::from);
    }
    let inventory: InventoryResponse = call_registry(env, "/inventory", &request).await?;
    transition.gate.require_epoch(inventory.gate.epoch)?;
    if transition.gate.status != inventory.gate.status {
        return Err(ManagedError::conflict(
            "gate_changed_during_lifecycle_page",
            "Managed repository gate changed while applying a lifecycle page",
        ));
    }
    let repository_path = match operation {
        GateStatus::Paused => "pause",
        GateStatus::Resuming => "resume",
        GateStatus::Active => unreachable!(),
    };
    let mut repositories = Vec::with_capacity(inventory.repositories.len());
    for record in &inventory.repositories {
        let lifecycle: RepositoryLifecycleResponse = send_repository(
            env,
            record,
            &transition.gate,
            &format!("{}/{}", REPOSITORY_MANAGED_PREFIX, repository_path),
            &serde_json::json!({}),
        )
        .await?;
        let _: RegistryRecord = call_registry(
            env,
            "/ack",
            &AcknowledgeRequest {
                provider_id: record.identity.provider_id.clone(),
                status: lifecycle.status,
                epoch: lifecycle.epoch,
            },
        )
        .await?;
        repositories.push(lifecycle);
    }

    let mut status: TransitionResponse =
        call_registry(env, "/gate/status", &serde_json::json!({})).await?;
    if operation == GateStatus::Resuming
        && inventory.next_cursor.is_none()
        && status.pending_repositories == 0
    {
        status = call_registry(env, "/gate/resume-seal", &serde_json::json!({})).await?;
    }
    json_response(
        &LifecycleBatchResponse {
            gate: status.gate,
            erasure: status.erasure,
            pending_repositories: status.pending_repositories,
            repositories,
            next_cursor: inventory.next_cursor,
        },
        200,
    )
    .map_err(ManagedError::from)
}

async fn apply_erase_page(env: &Env, request: InventoryRequest) -> ManagedResult<Response> {
    let transition: EraseProgressResponse =
        call_registry(env, "/erase/begin", &serde_json::json!({})).await?;
    if transition.erasure.status == ErasureStatus::Erased {
        return terminal_erase_response(env, transition, Vec::new()).await;
    }
    if transition.erasure.status != ErasureStatus::Erasing
        || transition.gate.status != GateStatus::Paused
        || transition.erasure.epoch != transition.gate.epoch
    {
        return Err(ManagedError::internal(
            "invalid_registry_erase_state",
            "Repository registry returned an invalid erase transition",
        ));
    }

    let inventory: InventoryResponse = call_registry(env, "/inventory", &request).await?;
    if inventory.erasure != transition.erasure || inventory.gate != transition.gate {
        return Err(ManagedError::conflict(
            "registry_changed_during_erase_page",
            "Repository registry changed while applying an erase page",
        ));
    }

    let mut erased_repositories = Vec::with_capacity(inventory.repositories.len());
    let mut progress = transition;
    for record in &inventory.repositories {
        let erased: RepositoryEraseResponse = send_repository(
            env,
            record,
            &inventory.gate,
            &format!("{}/erase", REPOSITORY_MANAGED_PREFIX),
            &serde_json::json!({}),
        )
        .await?;
        if erased.identity != record.identity
            || erased.status != ErasureStatus::Erased
            || erased.epoch != inventory.erasure.epoch
        {
            return Err(ManagedError::internal(
                "invalid_repository_erase_response",
                "Repository did not acknowledge the exact erase identity and epoch",
            ));
        }
        progress = call_registry(
            env,
            "/erase/ack",
            &EraseAcknowledgeRequest {
                provider_id: record.identity.provider_id.clone(),
                epoch: inventory.erasure.epoch,
            },
        )
        .await?;
        if progress.erasure != inventory.erasure || progress.gate != inventory.gate {
            return Err(ManagedError::conflict(
                "registry_changed_during_erase_page",
                "Repository registry changed while acknowledging an erase page",
            ));
        }
        erased_repositories.push(erased);
    }

    if inventory.next_cursor.is_none() {
        progress = call_registry(env, "/erase/seal", &serde_json::json!({})).await?;
        return terminal_erase_response(env, progress, erased_repositories).await;
    }

    json_response(
        &EraseBatchResponse {
            gate: progress.gate,
            erasure: progress.erasure,
            erased_repositories,
            next_cursor: inventory.next_cursor,
            remaining_repositories: progress.remaining_repositories,
        },
        200,
    )
    .map_err(ManagedError::from)
}

async fn terminal_erase_response(
    env: &Env,
    progress: EraseProgressResponse,
    erased_repositories: Vec<RepositoryEraseResponse>,
) -> ManagedResult<Response> {
    let terminal: InventoryResponse = call_registry(
        env,
        "/inventory",
        &InventoryRequest {
            cursor: None,
            limit: Some(1),
        },
    )
    .await?;
    if progress.erasure.status != ErasureStatus::Erased
        || terminal.erasure != progress.erasure
        || terminal.gate != progress.gate
        || progress.remaining_repositories != 0
        || !terminal.repositories.is_empty()
        || terminal.next_cursor.is_some()
    {
        return Err(ManagedError::internal(
            "registry_erase_terminal_inventory_mismatch",
            "Repository registry did not reach an exact empty terminal inventory",
        ));
    }
    json_response(
        &EraseBatchResponse {
            gate: progress.gate,
            erasure: progress.erasure,
            erased_repositories,
            next_cursor: None,
            remaining_repositories: 0,
        },
        200,
    )
    .map_err(ManagedError::from)
}

async fn paused_repository(
    env: &Env,
    provider_id: &str,
) -> ManagedResult<(RegistryRecord, GateState)> {
    let record: RegistryRecord = call_registry(
        env,
        "/lookup",
        &ProviderRequest {
            provider_id: provider_id.to_string(),
        },
    )
    .await?;
    let status: TransitionResponse =
        call_registry(env, "/gate/status", &serde_json::json!({})).await?;
    if status.gate.status != GateStatus::Paused {
        return Err(ManagedError::conflict(
            "managed_repository_not_paused",
            "Snapshot and restore require the managed repository gate to be paused",
        ));
    }
    if record.applied_status != Some(GateStatus::Paused)
        || record.applied_epoch != Some(status.gate.epoch)
    {
        return Err(ManagedError::conflict(
            "repository_pause_not_applied",
            "Repository has not acknowledged the current pause epoch",
        ));
    }
    Ok((record, status.gate))
}

async fn paused_repository_at_epoch(
    env: &Env,
    provider_id: &str,
    expected_epoch: i64,
) -> ManagedResult<(RegistryRecord, GateState)> {
    let (record, gate) = paused_repository(env, provider_id).await?;
    require_paused_epoch(&gate, expected_epoch)?;
    Ok((record, gate))
}

async fn forward_restore<T: Serialize>(
    env: &Env,
    provider_id: &str,
    operation: &str,
    payload: &T,
) -> ManagedResult<Response> {
    let (record, gate) = paused_repository(env, provider_id).await?;
    let value: serde_json::Value = send_repository(
        env,
        &record,
        &gate,
        &format!("{}/{}", REPOSITORY_MANAGED_PREFIX, operation),
        payload,
    )
    .await?;
    json_response(&value, 200).map_err(ManagedError::from)
}

async fn send_repository<Req: Serialize, Res: DeserializeOwned>(
    env: &Env,
    record: &RegistryRecord,
    gate: &GateState,
    path: &str,
    body: &Req,
) -> ManagedResult<Res> {
    let mut response = send_repository_response(env, record, gate, path, body).await?;
    decode_response(&mut response).await
}

async fn send_repository_response<Req: Serialize>(
    env: &Env,
    record: &RegistryRecord,
    gate: &GateState,
    path: &str,
    body: &Req,
) -> ManagedResult<Response> {
    let namespace = env
        .durable_object("REPOSITORY")
        .map_err(ManagedError::from)?;
    let stub = namespace
        .id_from_string(&record.identity.provider_id)
        .and_then(|id| id.get_stub())
        .map_err(ManagedError::from)?;
    let mut request = json_request(&format!("https://managed.invalid{}", path), body)
        .map_err(ManagedError::from)?;
    set_identity_headers(
        request.headers_mut().map_err(ManagedError::from)?,
        &record.identity,
        gate,
    )
    .map_err(ManagedError::from)?;
    stub.fetch_with_request(request)
        .await
        .map_err(ManagedError::from)
}

async fn decode_response<T: DeserializeOwned>(response: &mut Response) -> ManagedResult<T> {
    let status = response.status_code();
    let bytes = response.bytes().await.map_err(ManagedError::from)?;
    if !(200..300).contains(&status) {
        let body: ManagedErrorBody = serde_json::from_slice(&bytes).map_err(|_| {
            ManagedError::internal(
                "managed_repository_invalid_response",
                "Managed repository returned an invalid error response",
            )
        })?;
        return Err(ManagedError::new(status, body.error, body.message));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        ManagedError::internal(
            "managed_repository_invalid_response",
            "Managed repository returned an invalid response",
        )
    })
}

fn set_identity_headers(
    headers: &worker::Headers,
    identity: &RepositoryIdentity,
    gate: &GateState,
) -> Result<()> {
    headers.set(INTERNAL_MANAGED_HEADER, "1")?;
    headers.set(INTERNAL_OWNER_HEADER, &identity.owner)?;
    headers.set(INTERNAL_REPO_HEADER, &identity.repo)?;
    headers.set(INTERNAL_PROVIDER_ID_HEADER, &identity.provider_id)?;
    headers.set(INTERNAL_EPOCH_HEADER, &gate.epoch.to_string())?;
    headers.set(INTERNAL_GATE_STATUS_HEADER, gate.status.as_str())?;
    Ok(())
}

pub fn is_mutation(method: Method, path: &str) -> bool {
    if method == Method::Delete || method == Method::Put {
        return true;
    }
    if method != Method::Post {
        return false;
    }
    path.ends_with("/git-receive-pack")
        || path.ends_with("/hyperspace/apply")
        || path.ends_with("/hyperspace/import")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutation_classification_fences_every_existing_write_route() {
        assert!(is_mutation(Method::Post, "/a/b/git-receive-pack"));
        assert!(is_mutation(Method::Post, "/a/b/hyperspace/apply"));
        assert!(is_mutation(Method::Post, "/a/b/hyperspace/import"));
        assert!(is_mutation(Method::Put, "/a/b/admin/set-ref"));
        assert!(is_mutation(Method::Delete, "/a/b"));
        assert!(!is_mutation(Method::Post, "/a/b/git-upload-pack"));
        assert!(!is_mutation(Method::Get, "/a/b/refs"));
    }

    #[test]
    fn descriptor_validation_keeps_unknown_provider_ids_explicit() {
        let provider_id = "a".repeat(64);
        let descriptor = ManagedObjectDescriptor {
            schema_version: 1,
            kind: "repository".to_string(),
            provider_id: provider_id.clone(),
            logical_name: None,
            classification: "uninitialized".to_string(),
            lifecycle: super::super::ManagedObjectLifecycle {
                status: "uninitialized".to_string(),
                epoch: 0,
            },
        };
        validate_descriptor(&descriptor, "repository", &provider_id).unwrap();
        let mut inconsistent = descriptor;
        inconsistent.logical_name = Some("guessed/name".to_string());
        assert!(validate_descriptor(&inconsistent, "repository", &provider_id).is_err());
    }

    #[test]
    fn managed_token_hash_decoder_is_exact() {
        let digest = decode_hex_digest(&"ab".repeat(32)).unwrap();
        assert_eq!(digest, [0xab; 32]);
        assert!(decode_hex_digest(&"zz".repeat(32)).is_err());
    }

    #[test]
    fn framed_portability_rejects_infrastructure_kinds() {
        require_repository_kind("ripgit", "repository").unwrap();
        for kind in ["repository_registry", "adapter_admission", "kernel"] {
            assert_eq!(
                require_repository_kind("ripgit", kind).unwrap_err().code,
                "invalid_managed_object_kind"
            );
        }
        assert!(require_repository_kind("gateway", "repository").is_err());
    }

    #[test]
    fn restore_inventory_counts_are_canonical_and_bounded() {
        assert_eq!(parse_decimal_count("0", "frameCount", 9).unwrap(), 0);
        assert_eq!(parse_decimal_count("9", "frameCount", 9).unwrap(), 9);
        for value in ["", "00", "01", "-1", "+1", " 1", "10"] {
            assert!(parse_decimal_count(value, "frameCount", 9).is_err());
        }
    }

    #[test]
    fn restore_control_shape_and_digest_are_exact() {
        let value = serde_json::json!({
            "bodyBytes": "12",
            "component": "ripgit",
            "fenceEpoch": 3,
            "frameCount": "2",
            "kind": "repository",
            "logicalName": "alice/memory",
            "objectId": "repository:alice/memory",
            "restoreId": "restore-1",
            "semanticSha256": "QKL2JaX9dDeKVRs8C8pwsXhKXxm-gZj0lLckWHnQ8pg"
        });
        let control: RestoreControl = serde_json::from_value(value.clone()).unwrap();
        validate_restore_control(&control, "repository:alice/memory").unwrap();

        let mut with_extra = value;
        with_extra
            .as_object_mut()
            .unwrap()
            .insert("providerId".to_string(), serde_json::json!("untrusted"));
        assert!(serde_json::from_value::<RestoreControl>(with_extra).is_err());

        let mut invalid = control;
        invalid.semantic_sha256 = "not-a-digest".to_string();
        assert!(validate_restore_control(&invalid, "repository:alice/memory").is_err());
    }
}
