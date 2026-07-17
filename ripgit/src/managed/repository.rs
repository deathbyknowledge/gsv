use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use worker::{Request, Response, Result, SqlStorage, SqlStorageValue, State};

use super::codec::{
    assert_replay_hash, clear_rebuildable_tables, create_manifest,
    delete_repository_contents as delete_contents, ensure_fresh_repository, insert_page,
    next_restore_position, read_page, rebuild_derived_tables, validate_restore_page,
    validate_restored_counts, SnapshotManifest, SnapshotPage, TABLES,
};
use super::frame_stream::{
    canonical_json_bytes, encode_record, stream_error, stream_magic, stream_terminator,
    validate_identifier, DataFrameRecord, ObjectSemanticDigestV1, MAX_DATA_FRAME_COUNT,
    MAX_DATA_TOTAL_BODY_BYTES, MAX_FRAME_BODY_BYTES, RIPGIT_MANIFEST_KIND,
    RIPGIT_MANIFEST_MEDIA_TYPE, RIPGIT_PAGE_KIND, RIPGIT_PAGE_MEDIA_TYPE,
};
use super::{
    json_response, read_json, ErasureState, ErasureStatus, GateState, GateStatus, ManagedError,
    ManagedObjectDescriptor, ManagedObjectLifecycle, ManagedResult, RepositoryIdentity,
    INTERNAL_CONTROL_HEADER, INTERNAL_EPOCH_HEADER, INTERNAL_GATE_STATUS_HEADER,
    INTERNAL_MANAGED_HEADER, INTERNAL_OWNER_HEADER, INTERNAL_PROVIDER_ID_HEADER,
    INTERNAL_REPO_HEADER,
};

pub const REPOSITORY_MANAGED_PREFIX: &str = "/__gsv/managed/repository/v1";

pub fn delete_repository_contents(sql: &SqlStorage) -> ManagedResult<()> {
    delete_contents(sql)
}

#[derive(Deserialize)]
struct IdentityRow {
    owner: String,
    repo: String,
    provider_id: String,
}

#[derive(Deserialize)]
struct LifecycleRow {
    status: String,
    epoch: i64,
}

#[derive(Deserialize)]
struct ErasureRow {
    status: String,
    epoch: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryLifecycleResponse {
    pub identity: RepositoryIdentity,
    pub status: GateStatus,
    pub epoch: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryEraseResponse {
    pub identity: RepositoryIdentity,
    pub status: ErasureStatus,
    pub epoch: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPageRequest {
    manifest_hash: String,
    table_index: usize,
    offset: i64,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FramedSnapshotRequest {
    object_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreBeginRequest {
    restore_id: String,
    manifest: SnapshotManifest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreApplyRequest {
    restore_id: String,
    page: SnapshotPage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreSealRequest {
    restore_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreProgress {
    restore_id: String,
    manifest_hash: String,
    status: String,
    next_table_index: usize,
    next_offset: i64,
    applied_pages: i64,
    applied_rows: i64,
    complete: bool,
}

#[derive(Deserialize)]
struct JournalRow {
    restore_id: String,
    manifest_hash: String,
    manifest_json: String,
    status: String,
    next_table_index: i64,
    next_offset: i64,
    applied_pages: i64,
    applied_rows: i64,
}

#[derive(Deserialize)]
struct RestorePageRow {
    page_hash: String,
}

pub fn identity_and_gate_from_headers(
    req: &Request,
) -> ManagedResult<(RepositoryIdentity, GateState)> {
    if req
        .headers()
        .get(INTERNAL_MANAGED_HEADER)
        .map_err(ManagedError::from)?
        .as_deref()
        != Some("1")
    {
        return Err(ManagedError::forbidden(
            "managed_identity_missing",
            "Repository request is missing managed routing identity",
        ));
    }
    let header = |name: &str| -> ManagedResult<String> {
        req.headers()
            .get(name)
            .map_err(ManagedError::from)?
            .ok_or_else(|| {
                ManagedError::bad_request(
                    "managed_identity_missing",
                    format!("Repository request is missing header {}", name),
                )
            })
    };
    let identity = RepositoryIdentity::new(
        &header(INTERNAL_OWNER_HEADER)?,
        &header(INTERNAL_REPO_HEADER)?,
        &header(INTERNAL_PROVIDER_ID_HEADER)?,
    )?;
    let epoch = header(INTERNAL_EPOCH_HEADER)?.parse::<i64>().map_err(|_| {
        ManagedError::bad_request("invalid_managed_epoch", "Managed epoch header is invalid")
    })?;
    if epoch < 0 {
        return Err(ManagedError::bad_request(
            "invalid_managed_epoch",
            "Managed epoch must be non-negative",
        ));
    }
    let status = GateStatus::parse(&header(INTERNAL_GATE_STATUS_HEADER)?)?;
    Ok((identity, GateState { status, epoch }))
}

pub fn ensure_repository_identity(
    sql: &SqlStorage,
    state: &State,
    identity: &RepositoryIdentity,
) -> ManagedResult<()> {
    identity.validate()?;
    if state.id().to_string() != identity.provider_id {
        return Err(ManagedError::conflict(
            "repository_provider_id_mismatch",
            "Repository identity does not match this Durable Object",
        ));
    }
    let rows: Vec<IdentityRow> = sql
        .exec(
            "SELECT owner, repo, provider_id
             FROM managed_repository_identity WHERE singleton = 1",
            None,
        )?
        .to_array()?;
    if let Some(row) = rows.first() {
        if row.owner != identity.owner
            || row.repo != identity.repo
            || row.provider_id != identity.provider_id
        {
            return Err(ManagedError::conflict(
                "repository_identity_conflict",
                "Repository Durable Object identity is immutable",
            ));
        }
        return Ok(());
    }
    sql.exec(
        "INSERT INTO managed_repository_identity
         (singleton, owner, repo, provider_id, created_at)
         VALUES (1, ?, ?, ?, ?)",
        vec![
            SqlStorageValue::from(identity.owner.clone()),
            SqlStorageValue::from(identity.repo.clone()),
            SqlStorageValue::from(identity.provider_id.clone()),
            SqlStorageValue::from(now_millis()),
        ],
    )?;
    Ok(())
}

fn assert_persisted_repository_identity(
    sql: &SqlStorage,
    expected: &RepositoryIdentity,
) -> ManagedResult<()> {
    let rows: Vec<IdentityRow> = sql
        .exec(
            "SELECT owner, repo, provider_id
             FROM managed_repository_identity WHERE singleton = 1",
            None,
        )?
        .to_array()?;
    match rows.first() {
        Some(identity)
            if identity.owner == expected.owner
                && identity.repo == expected.repo
                && identity.provider_id == expected.provider_id =>
        {
            Ok(())
        }
        _ => Err(ManagedError::conflict(
            "repository_identity_conflict",
            "Repository Durable Object identity changed during snapshot",
        )),
    }
}

pub fn synchronize_repository_epoch(sql: &SqlStorage, gate: &GateState) -> ManagedResult<()> {
    let lifecycle = read_lifecycle(sql)?;
    match lifecycle {
        None if gate.status == GateStatus::Active => {
            write_lifecycle(sql, GateStatus::Active, gate.epoch)
        }
        None => Err(ManagedError::conflict(
            "repository_lifecycle_uninitialized",
            "Repository must be explicitly synchronized before managed pause or resume",
        )),
        Some((status, epoch)) if status == GateStatus::Active && epoch == gate.epoch => Ok(()),
        Some((GateStatus::Paused, _)) => Err(ManagedError::unavailable(
            "managed_repository_writes_paused",
            "Managed repository mutations are paused",
        )),
        Some(_) => Err(ManagedError::conflict(
            "stale_managed_epoch",
            "Repository lifecycle does not match the admitted managed epoch",
        )),
    }
}

pub fn assert_repository_mutation_epoch(
    sql: &SqlStorage,
    expected_epoch: i64,
) -> ManagedResult<()> {
    require_mutation_lifecycle(read_lifecycle(sql)?, expected_epoch)
}

fn require_mutation_lifecycle(
    lifecycle: Option<(GateStatus, i64)>,
    expected_epoch: i64,
) -> ManagedResult<()> {
    match lifecycle {
        Some((GateStatus::Active, epoch)) if epoch == expected_epoch => Ok(()),
        Some((GateStatus::Paused, _)) => Err(ManagedError::unavailable(
            "managed_repository_writes_paused",
            "Managed repository mutations are paused",
        )),
        _ => Err(ManagedError::conflict(
            "stale_managed_epoch",
            "Mutation was admitted under a stale managed epoch",
        )),
    }
}

pub fn pause_repository(sql: &SqlStorage, epoch: i64) -> ManagedResult<()> {
    match read_lifecycle(sql)? {
        None => write_lifecycle(sql, GateStatus::Paused, epoch),
        Some((GateStatus::Paused, current)) if current == epoch => Ok(()),
        Some((GateStatus::Paused, current)) if current < epoch => {
            write_lifecycle(sql, GateStatus::Paused, epoch)
        }
        Some((GateStatus::Active, current)) if current < epoch => {
            write_lifecycle(sql, GateStatus::Paused, epoch)
        }
        _ => Err(ManagedError::conflict(
            "stale_managed_epoch",
            "Repository cannot apply the requested pause epoch",
        )),
    }
}

pub fn resume_repository(sql: &SqlStorage, epoch: i64) -> ManagedResult<()> {
    match read_lifecycle(sql)? {
        None => write_lifecycle(sql, GateStatus::Active, epoch),
        Some((GateStatus::Active, current)) if current == epoch => Ok(()),
        Some((GateStatus::Paused, current)) if current < epoch => {
            write_lifecycle(sql, GateStatus::Active, epoch)
        }
        _ => Err(ManagedError::conflict(
            "stale_managed_epoch",
            "Repository cannot apply the requested resume epoch",
        )),
    }
}

pub async fn handle_repository_managed_request(
    state: &State,
    sql: &SqlStorage,
    mut req: Request,
) -> Result<Response> {
    let result = handle_repository_managed(state, sql, &mut req).await;
    match result {
        Ok(response) => Ok(response),
        Err(error) => {
            let _body = req.stream();
            error.into_response()
        }
    }
}

async fn handle_repository_managed(
    state: &State,
    sql: &SqlStorage,
    req: &mut Request,
) -> ManagedResult<Response> {
    let path = req.url().map_err(ManagedError::from)?.path().to_string();
    if req
        .headers()
        .get(INTERNAL_CONTROL_HEADER)
        .map_err(ManagedError::from)?
        .as_deref()
        != Some("1")
    {
        return Err(ManagedError::forbidden(
            "managed_endpoint_forbidden",
            "Managed repository control endpoints are private",
        ));
    }
    if path == "/__gsv/managed/repository/v1/descriptor" {
        let _: serde_json::Value = read_json(req).await?;
        return repository_descriptor(state, sql)?.map_response();
    }
    let (identity, gate) = identity_and_gate_from_headers(req)?;
    let erasure = read_erasure(sql)?;
    if erasure.status == ErasureStatus::Erased {
        identity.validate()?;
        if state.id().to_string() != identity.provider_id {
            return Err(ManagedError::conflict(
                "repository_provider_id_mismatch",
                "Repository identity does not match this Durable Object",
            ));
        }
        if path == format!("{}/erase", REPOSITORY_MANAGED_PREFIX) {
            if gate.status != GateStatus::Paused || gate.epoch != erasure.epoch {
                return Err(ManagedError::conflict(
                    "stale_repository_erase",
                    "Repository erase replay does not match its tombstone epoch",
                ));
            }
            verify_repository_terminal_state(sql)?;
            return RepositoryEraseResponse {
                identity,
                status: ErasureStatus::Erased,
                epoch: erasure.epoch,
            }
            .map_response();
        }
        return Err(ManagedError::new(
            410,
            "managed_repository_erased",
            "Repository has been irreversibly erased",
        ));
    }
    ensure_repository_identity(sql, state, &identity)?;

    match path.as_str() {
        "/__gsv/managed/repository/v1/identity" => {
            match gate.status {
                GateStatus::Active => synchronize_repository_epoch(sql, &gate)?,
                GateStatus::Paused => pause_repository(sql, gate.epoch)?,
                GateStatus::Resuming => {
                    return Err(ManagedError::conflict(
                        "gate_transition_in_progress",
                        "Repository identity cannot be initialized while resume is in progress",
                    ));
                }
            }
            lifecycle_response(sql, identity)?.map_response()
        }
        "/__gsv/managed/repository/v1/pause" => {
            if gate.status != GateStatus::Paused {
                return Err(ManagedError::conflict(
                    "managed_pause_state_mismatch",
                    "Repository pause requires a paused registry gate",
                ));
            }
            pause_repository(sql, gate.epoch)?;
            lifecycle_response(sql, identity)?.map_response()
        }
        "/__gsv/managed/repository/v1/resume" => {
            if gate.status != GateStatus::Resuming {
                return Err(ManagedError::conflict(
                    "managed_resume_state_mismatch",
                    "Repository resume requires a resuming registry gate",
                ));
            }
            resume_repository(sql, gate.epoch)?;
            lifecycle_response(sql, identity)?.map_response()
        }
        "/__gsv/managed/repository/v1/erase" => {
            if gate.status != GateStatus::Paused {
                return Err(ManagedError::conflict(
                    "managed_erase_state_mismatch",
                    "Repository erase requires a paused registry gate",
                ));
            }
            pause_repository(sql, gate.epoch)?;
            erase_repository(sql, identity, gate.epoch)?.map_response()
        }
        "/__gsv/managed/repository/v1/snapshot/manifest" => {
            require_paused(sql, &gate)?;
            create_manifest(sql, &identity, gate.epoch)?.map_response()
        }
        "/__gsv/managed/repository/v1/snapshot/page" => {
            require_paused(sql, &gate)?;
            let request: SnapshotPageRequest = read_json(req).await?;
            require_paused(sql, &gate)?;
            let manifest = create_manifest(sql, &identity, gate.epoch)?;
            if manifest.manifest_hash != request.manifest_hash {
                return Err(ManagedError::conflict(
                    "snapshot_manifest_mismatch",
                    "Repository snapshot manifest no longer matches",
                ));
            }
            read_page(
                sql,
                &manifest,
                request.table_index,
                request.offset,
                request.limit.unwrap_or(100),
            )?
            .map_response()
        }
        "/__gsv/managed/repository/v1/snapshot/framed" => {
            require_paused(sql, &gate)?;
            let request: FramedSnapshotRequest = read_json(req).await?;
            require_paused(sql, &gate)?;
            let manifest = create_manifest(sql, &identity, gate.epoch)?;
            framed_snapshot_response(sql.clone(), identity, gate, request.object_id, manifest)
        }
        "/__gsv/managed/repository/v1/restore/begin" => {
            require_paused(sql, &gate)?;
            let request: RestoreBeginRequest = read_json(req).await?;
            require_paused(sql, &gate)?;
            begin_restore(sql, request)?.map_response()
        }
        "/__gsv/managed/repository/v1/restore/apply" => {
            require_paused(sql, &gate)?;
            let request: RestoreApplyRequest = read_json(req).await?;
            require_paused(sql, &gate)?;
            apply_restore_page(sql, request)?.map_response()
        }
        "/__gsv/managed/repository/v1/restore/seal" => {
            require_paused(sql, &gate)?;
            let request: RestoreSealRequest = read_json(req).await?;
            require_paused(sql, &gate)?;
            seal_restore(sql, request)?.map_response()
        }
        _ => Err(ManagedError::not_found(
            "managed_repository_endpoint_not_found",
            "Managed repository endpoint was not found",
        )),
    }
}

fn repository_descriptor(
    state: &State,
    sql: &SqlStorage,
) -> ManagedResult<ManagedObjectDescriptor> {
    let provider_id = state.id().to_string();
    let erasure = read_erasure(sql)?;
    if erasure.status == ErasureStatus::Erased {
        verify_repository_terminal_state(sql)?;
        return Ok(ManagedObjectDescriptor {
            schema_version: 1,
            kind: "repository".to_string(),
            provider_id,
            logical_name: None,
            classification: "erased".to_string(),
            lifecycle: ManagedObjectLifecycle {
                status: "erased".to_string(),
                epoch: erasure.epoch,
            },
        });
    }
    let identities: Vec<IdentityRow> = sql
        .exec(
            "SELECT owner, repo, provider_id
             FROM managed_repository_identity WHERE singleton = 1",
            None,
        )?
        .to_array()?;
    let Some(identity) = identities.first() else {
        return Ok(ManagedObjectDescriptor {
            schema_version: 1,
            kind: "repository".to_string(),
            provider_id,
            logical_name: None,
            classification: "uninitialized".to_string(),
            lifecycle: ManagedObjectLifecycle {
                status: "uninitialized".to_string(),
                epoch: 0,
            },
        });
    };
    if identity.provider_id != provider_id {
        return Err(ManagedError::internal(
            "repository_identity_corrupt",
            "Persisted repository identity does not match its Durable Object",
        ));
    }
    let lifecycle = read_lifecycle(sql)?;
    let (status, epoch) = match lifecycle {
        Some((status, epoch)) => (status.as_descriptor_status().to_string(), epoch),
        None => ("uninitialized".to_string(), 0),
    };
    Ok(ManagedObjectDescriptor {
        schema_version: 1,
        kind: "repository".to_string(),
        provider_id,
        logical_name: Some(format!("{}/{}", identity.owner, identity.repo)),
        classification: "initialized".to_string(),
        lifecycle: ManagedObjectLifecycle { status, epoch },
    })
}

trait IntoManagedResponse {
    fn map_response(self) -> ManagedResult<Response>;
}

impl<T: Serialize> IntoManagedResponse for T {
    fn map_response(self) -> ManagedResult<Response> {
        json_response(&self, 200).map_err(ManagedError::from)
    }
}

fn lifecycle_response(
    sql: &SqlStorage,
    identity: RepositoryIdentity,
) -> ManagedResult<RepositoryLifecycleResponse> {
    let (status, epoch) = read_lifecycle(sql)?.ok_or_else(|| {
        ManagedError::conflict(
            "repository_lifecycle_uninitialized",
            "Repository lifecycle has not been initialized",
        )
    })?;
    Ok(RepositoryLifecycleResponse {
        identity,
        status,
        epoch,
    })
}

fn erase_repository(
    sql: &SqlStorage,
    identity: RepositoryIdentity,
    epoch: i64,
) -> ManagedResult<RepositoryEraseResponse> {
    let erasure = read_erasure(sql)?;
    if erasure.status == ErasureStatus::Erasing {
        return Err(ManagedError::internal(
            "invalid_repository_erasure_state",
            "Repository cannot persist a transient erasing tombstone",
        ));
    }
    if erasure.status == ErasureStatus::Erased {
        verify_repository_terminal_state(sql)?;
        return Ok(RepositoryEraseResponse {
            identity,
            status: ErasureStatus::Erased,
            epoch: erasure.epoch,
        });
    }

    delete_contents(sql)?;
    verify_repository_contents_empty(sql)?;
    sql.exec("DELETE FROM managed_repository_lifecycle", None)?;
    sql.exec("DELETE FROM managed_repository_identity", None)?;
    sql.exec(
        "UPDATE managed_repository_erasure
         SET status = 'erased', epoch = ?, updated_at = ?
         WHERE singleton = 1 AND status = 'ready'",
        vec![
            SqlStorageValue::from(epoch),
            SqlStorageValue::from(now_millis()),
        ],
    )?;
    let erased = read_erasure(sql)?;
    if erased.status != ErasureStatus::Erased || erased.epoch != epoch {
        return Err(ManagedError::internal(
            "repository_erasure_not_committed",
            "Repository erasure tombstone was not committed",
        ));
    }
    verify_repository_terminal_state(sql)?;
    Ok(RepositoryEraseResponse {
        identity,
        status: erased.status,
        epoch: erased.epoch,
    })
}

fn verify_repository_contents_empty(sql: &SqlStorage) -> ManagedResult<()> {
    ensure_fresh_repository(sql)?;
    #[derive(Deserialize)]
    struct CountRow {
        count: i64,
    }
    for table in [
        "managed_restore_pages",
        "managed_restore_journals",
        "sqlite_sequence",
    ] {
        let row: CountRow = sql
            .exec(&format!("SELECT COUNT(*) AS count FROM {}", table), None)?
            .one()?;
        if row.count != 0 {
            return Err(ManagedError::internal(
                "repository_erasure_incomplete",
                "Repository erase left managed restore state behind",
            ));
        }
    }
    Ok(())
}

fn verify_repository_terminal_state(sql: &SqlStorage) -> ManagedResult<()> {
    verify_repository_contents_empty(sql)?;
    #[derive(Deserialize)]
    struct CountRow {
        count: i64,
    }
    for table in [
        "managed_repository_identity",
        "managed_repository_lifecycle",
    ] {
        let row: CountRow = sql
            .exec(&format!("SELECT COUNT(*) AS count FROM {}", table), None)?
            .one()?;
        if row.count != 0 {
            return Err(ManagedError::internal(
                "repository_erasure_identity_remains",
                "Repository erase left logical identity or lifecycle state behind",
            ));
        }
    }
    Ok(())
}

fn require_paused(sql: &SqlStorage, gate: &GateState) -> ManagedResult<()> {
    if gate.status != GateStatus::Paused {
        return Err(ManagedError::conflict(
            "managed_repository_not_paused",
            "Snapshot and restore operations require a paused registry gate",
        ));
    }
    match read_lifecycle(sql)? {
        Some((GateStatus::Paused, epoch)) if epoch == gate.epoch => Ok(()),
        _ => Err(ManagedError::conflict(
            "repository_pause_not_applied",
            "Repository has not acknowledged the current pause epoch",
        )),
    }
}

fn framed_snapshot_response(
    sql: SqlStorage,
    identity: RepositoryIdentity,
    gate: GateState,
    object_id: String,
    manifest: SnapshotManifest,
) -> ManagedResult<Response> {
    ObjectSemanticDigestV1::new(&object_id)?;
    let manifest_body = canonical_json_bytes(&manifest)?;
    if manifest_body.len() > MAX_FRAME_BODY_BYTES {
        return Err(ManagedError::new(
            413,
            "snapshot_manifest_too_large",
            "Ripgit snapshot manifest exceeds the managed frame limit",
        ));
    }
    let stream = async_stream::try_stream! {
        let typed_stream_result: Result<()> = Ok(());
        typed_stream_result?;
        yield stream_magic();
        let mut frame_count = 0_u64;
        let mut total_body_bytes = 0_u64;
        let manifest_record = DataFrameRecord {
            kind: RIPGIT_MANIFEST_KIND.to_string(),
            object_id: object_id.clone(),
            body_media_type: RIPGIT_MANIFEST_MEDIA_TYPE.to_string(),
            part: 0,
            body: manifest_body,
        };
        total_body_bytes = total_body_bytes
            .checked_add(manifest_record.body.len() as u64)
            .ok_or_else(|| stream_error(ManagedError::internal(
                "snapshot_size_overflow",
                "Ripgit snapshot size overflowed",
            )))?;
        frame_count += 1;
        for chunk in encode_record(manifest_record).map_err(stream_error)? {
            yield chunk;
        }

        let mut part = 0_u32;
        for (table_index, table) in manifest.body.tables.iter().enumerate() {
            let mut offset = 0_i64;
            while offset < table.row_count {
                require_paused(&sql, &gate).map_err(stream_error)?;
                let mut limit = 100_usize;
                let (page, body) = loop {
                    let page = read_page(&sql, &manifest, table_index, offset, limit)
                        .map_err(stream_error)?;
                    let body = canonical_json_bytes(&page).map_err(stream_error)?;
                    if body.len() <= MAX_FRAME_BODY_BYTES {
                        break (page, body);
                    }
                    if limit == 1 {
                        Err(stream_error(ManagedError::new(
                            413,
                            "snapshot_row_too_large",
                            "A ripgit snapshot row exceeds the managed frame limit",
                        )))?;
                    }
                    limit = (limit / 2).max(1);
                };
                if page.body.rows.is_empty() || page.body.next_offset <= offset {
                    Err(stream_error(ManagedError::internal(
                        "snapshot_page_did_not_advance",
                        "Ripgit snapshot page did not advance",
                    )))?;
                }
                let record = DataFrameRecord {
                    kind: RIPGIT_PAGE_KIND.to_string(),
                    object_id: object_id.clone(),
                    body_media_type: RIPGIT_PAGE_MEDIA_TYPE.to_string(),
                    part,
                    body,
                };
                frame_count = frame_count.checked_add(1).ok_or_else(|| {
                    stream_error(ManagedError::internal(
                        "snapshot_frame_count_overflow",
                        "Ripgit snapshot frame count overflowed",
                    ))
                })?;
                total_body_bytes = total_body_bytes
                    .checked_add(record.body.len() as u64)
                    .ok_or_else(|| stream_error(ManagedError::internal(
                        "snapshot_size_overflow",
                        "Ripgit snapshot size overflowed",
                    )))?;
                if frame_count > MAX_DATA_FRAME_COUNT
                    || total_body_bytes > MAX_DATA_TOTAL_BODY_BYTES
                {
                    Err(stream_error(ManagedError::new(
                        413,
                        "snapshot_limit_exceeded",
                        "Ripgit snapshot exceeds the managed stream limits",
                    )))?;
                }
                part = part.checked_add(1).ok_or_else(|| stream_error(ManagedError::new(
                    413,
                    "snapshot_limit_exceeded",
                    "Ripgit snapshot contains too many pages",
                )))?;
                offset = page.body.next_offset;
                for chunk in encode_record(record).map_err(stream_error)? {
                    yield chunk;
                }
            }
        }
        require_paused(&sql, &gate).map_err(stream_error)?;
        assert_persisted_repository_identity(&sql, &identity).map_err(stream_error)?;
        yield stream_terminator();
    };
    let stream = stream.map(|item: Result<Vec<u8>>| item);
    let mut response = Response::from_stream(stream).map_err(ManagedError::from)?;
    response
        .headers_mut()
        .set("Cache-Control", "no-store")
        .map_err(ManagedError::from)?;
    response
        .headers_mut()
        .set(
            "Content-Type",
            super::frame_stream::DATA_FRAME_STREAM_MEDIA_TYPE,
        )
        .map_err(ManagedError::from)?;
    Ok(response)
}

fn begin_restore(sql: &SqlStorage, request: RestoreBeginRequest) -> ManagedResult<RestoreProgress> {
    validate_restore_id(&request.restore_id)?;
    request.manifest.verify()?;
    if let Some(existing) = read_journal(sql, &request.restore_id)? {
        if existing.manifest_hash != request.manifest.manifest_hash {
            return Err(ManagedError::conflict(
                "restore_manifest_mismatch",
                "Restore ID is already bound to a different manifest",
            ));
        }
        return journal_progress(&existing);
    }
    #[derive(Deserialize)]
    struct CountRow {
        count: i64,
    }
    let journals: CountRow = sql
        .exec(
            "SELECT COUNT(*) AS count FROM managed_restore_journals",
            None,
        )?
        .one()?;
    if journals.count != 0 {
        return Err(ManagedError::conflict(
            "restore_journal_exists",
            "Repository already has a restore journal",
        ));
    }
    ensure_fresh_repository(sql)?;
    clear_rebuildable_tables(sql)?;
    let (next_table_index, next_offset) = next_restore_position(&request.manifest, 0, 0)?;
    let now = now_millis();
    sql.exec(
        "INSERT INTO managed_restore_journals
         (restore_id, manifest_hash, manifest_json, status, next_table_index,
          next_offset, applied_pages, applied_rows, created_at, updated_at)
         VALUES (?, ?, ?, 'applying', ?, ?, 0, 0, ?, ?)",
        vec![
            SqlStorageValue::from(request.restore_id.clone()),
            SqlStorageValue::from(request.manifest.manifest_hash.clone()),
            SqlStorageValue::from(
                serde_json::to_string(&request.manifest).map_err(ManagedError::from)?,
            ),
            SqlStorageValue::from(next_table_index as i64),
            SqlStorageValue::from(next_offset),
            SqlStorageValue::from(now),
            SqlStorageValue::from(now),
        ],
    )?;
    let journal = read_journal(sql, &request.restore_id)?.ok_or_else(|| {
        ManagedError::internal(
            "restore_journal_write_failed",
            "Restore journal write failed",
        )
    })?;
    journal_progress(&journal)
}

fn apply_restore_page(
    sql: &SqlStorage,
    request: RestoreApplyRequest,
) -> ManagedResult<RestoreProgress> {
    validate_restore_id(&request.restore_id)?;
    let journal = read_journal(sql, &request.restore_id)?.ok_or_else(|| {
        ManagedError::not_found("restore_not_found", "Restore journal was not found")
    })?;
    let manifest: SnapshotManifest =
        serde_json::from_str(&journal.manifest_json).map_err(|_| {
            ManagedError::internal("restore_journal_invalid", "Restore journal is invalid")
        })?;
    manifest.verify()?;
    request.page.verify()?;
    let page_key = format!(
        "{}:{}",
        request.page.body.table_index, request.page.body.offset
    );
    let existing = read_restore_page(sql, &request.restore_id, &page_key)?;
    if journal.status == "sealed" {
        let existing = existing.ok_or_else(|| {
            ManagedError::conflict(
                "restore_already_sealed",
                "Restore journal is already sealed",
            )
        })?;
        assert_replay_hash(&existing.page_hash, &request.page.page_hash)?;
        return journal_progress(&journal);
    }
    if journal.status != "applying" {
        return Err(ManagedError::internal(
            "restore_journal_invalid",
            "Restore journal has an invalid state",
        ));
    }
    if let Some(existing) = existing {
        assert_replay_hash(&existing.page_hash, &request.page.page_hash)?;
        if (journal.next_table_index, journal.next_offset)
            == (
                request.page.body.table_index as i64,
                request.page.body.offset,
            )
        {
            advance_journal(sql, &journal, &manifest, &request.page)?;
        }
        let current = read_journal(sql, &request.restore_id)?.ok_or_else(|| {
            ManagedError::internal("restore_journal_missing", "Restore journal disappeared")
        })?;
        return journal_progress(&current);
    }

    let table_index = usize::try_from(journal.next_table_index).map_err(|_| {
        ManagedError::internal("restore_journal_invalid", "Restore table index is invalid")
    })?;
    validate_restore_page(&manifest, &request.page, table_index, journal.next_offset)?;
    insert_page(sql, &request.page)?;
    sql.exec(
        "INSERT INTO managed_restore_pages
         (restore_id, page_key, page_hash, row_count, applied_at)
         VALUES (?, ?, ?, ?, ?)",
        vec![
            SqlStorageValue::from(request.restore_id.clone()),
            SqlStorageValue::from(page_key),
            SqlStorageValue::from(request.page.page_hash.clone()),
            SqlStorageValue::from(request.page.body.rows.len() as i64),
            SqlStorageValue::from(now_millis()),
        ],
    )?;
    advance_journal(sql, &journal, &manifest, &request.page)?;
    let current = read_journal(sql, &request.restore_id)?.ok_or_else(|| {
        ManagedError::internal("restore_journal_missing", "Restore journal disappeared")
    })?;
    journal_progress(&current)
}

fn advance_journal(
    sql: &SqlStorage,
    journal: &JournalRow,
    manifest: &SnapshotManifest,
    page: &SnapshotPage,
) -> ManagedResult<()> {
    let (table_index, offset) =
        next_restore_position(manifest, page.body.table_index, page.body.next_offset)?;
    sql.exec(
        "UPDATE managed_restore_journals
         SET next_table_index = ?, next_offset = ?,
             applied_pages = applied_pages + ?, applied_rows = applied_rows + ?,
             updated_at = ?
         WHERE restore_id = ? AND status = 'applying'
           AND next_table_index = ? AND next_offset = ?",
        vec![
            SqlStorageValue::from(table_index as i64),
            SqlStorageValue::from(offset),
            SqlStorageValue::from(1_i64),
            SqlStorageValue::from(page.body.rows.len() as i64),
            SqlStorageValue::from(now_millis()),
            SqlStorageValue::from(journal.restore_id.clone()),
            SqlStorageValue::from(journal.next_table_index),
            SqlStorageValue::from(journal.next_offset),
        ],
    )?;
    Ok(())
}

fn seal_restore(sql: &SqlStorage, request: RestoreSealRequest) -> ManagedResult<RestoreProgress> {
    validate_restore_id(&request.restore_id)?;
    let journal = read_journal(sql, &request.restore_id)?.ok_or_else(|| {
        ManagedError::not_found("restore_not_found", "Restore journal was not found")
    })?;
    if journal.status == "sealed" {
        return journal_progress(&journal);
    }
    let manifest: SnapshotManifest =
        serde_json::from_str(&journal.manifest_json).map_err(|_| {
            ManagedError::internal("restore_journal_invalid", "Restore journal is invalid")
        })?;
    manifest.verify()?;
    if usize::try_from(journal.next_table_index).ok() != Some(TABLES.len())
        || journal.next_offset != 0
    {
        return Err(ManagedError::conflict(
            "restore_incomplete",
            "Restore cannot be sealed before all manifest pages are applied",
        ));
    }
    validate_restored_counts(sql, &manifest)?;
    rebuild_derived_tables(sql)?;
    sql.exec(
        "UPDATE managed_restore_journals
         SET status = 'sealed', updated_at = ? WHERE restore_id = ?",
        vec![
            SqlStorageValue::from(now_millis()),
            SqlStorageValue::from(request.restore_id.clone()),
        ],
    )?;
    let sealed = read_journal(sql, &request.restore_id)?.ok_or_else(|| {
        ManagedError::internal("restore_journal_missing", "Restore journal disappeared")
    })?;
    journal_progress(&sealed)
}

fn read_journal(sql: &SqlStorage, restore_id: &str) -> ManagedResult<Option<JournalRow>> {
    let rows: Vec<JournalRow> = sql
        .exec(
            "SELECT restore_id, manifest_hash, manifest_json, status,
                    next_table_index, next_offset, applied_pages, applied_rows
             FROM managed_restore_journals WHERE restore_id = ?",
            vec![SqlStorageValue::from(restore_id)],
        )?
        .to_array()?;
    Ok(rows.into_iter().next())
}

fn read_restore_page(
    sql: &SqlStorage,
    restore_id: &str,
    page_key: &str,
) -> ManagedResult<Option<RestorePageRow>> {
    let rows: Vec<RestorePageRow> = sql
        .exec(
            "SELECT page_hash FROM managed_restore_pages
             WHERE restore_id = ? AND page_key = ?",
            vec![
                SqlStorageValue::from(restore_id),
                SqlStorageValue::from(page_key),
            ],
        )?
        .to_array()?;
    Ok(rows.into_iter().next())
}

fn journal_progress(journal: &JournalRow) -> ManagedResult<RestoreProgress> {
    let next_table_index = usize::try_from(journal.next_table_index).map_err(|_| {
        ManagedError::internal("restore_journal_invalid", "Restore table index is invalid")
    })?;
    Ok(RestoreProgress {
        restore_id: journal.restore_id.clone(),
        manifest_hash: journal.manifest_hash.clone(),
        status: journal.status.clone(),
        next_table_index,
        next_offset: journal.next_offset,
        applied_pages: journal.applied_pages,
        applied_rows: journal.applied_rows,
        complete: next_table_index == TABLES.len(),
    })
}

fn read_lifecycle(sql: &SqlStorage) -> ManagedResult<Option<(GateStatus, i64)>> {
    let rows: Vec<LifecycleRow> = sql
        .exec(
            "SELECT status, epoch FROM managed_repository_lifecycle WHERE singleton = 1",
            None,
        )?
        .to_array()?;
    rows.into_iter()
        .next()
        .map(|row| Ok((GateStatus::parse(&row.status)?, row.epoch)))
        .transpose()
}

fn read_erasure(sql: &SqlStorage) -> ManagedResult<ErasureState> {
    let row: ErasureRow = sql
        .exec(
            "SELECT status, epoch FROM managed_repository_erasure WHERE singleton = 1",
            None,
        )?
        .one()?;
    let status = ErasureStatus::parse(&row.status)?;
    if status == ErasureStatus::Erasing {
        return Err(ManagedError::internal(
            "invalid_repository_erasure_state",
            "Repository erasure state is invalid",
        ));
    }
    Ok(ErasureState {
        status,
        epoch: row.epoch,
    })
}

fn write_lifecycle(sql: &SqlStorage, status: GateStatus, epoch: i64) -> ManagedResult<()> {
    if status == GateStatus::Resuming || epoch < 0 {
        return Err(ManagedError::internal(
            "invalid_repository_lifecycle",
            "Repository lifecycle state is invalid",
        ));
    }
    sql.exec(
        "INSERT INTO managed_repository_lifecycle (singleton, status, epoch, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE
         SET status = excluded.status, epoch = excluded.epoch,
             updated_at = excluded.updated_at",
        vec![
            SqlStorageValue::from(status.as_str()),
            SqlStorageValue::from(epoch),
            SqlStorageValue::from(now_millis()),
        ],
    )?;
    Ok(())
}

fn validate_restore_id(value: &str) -> ManagedResult<()> {
    validate_identifier(value, 1024, "restore ID").map_err(|_| {
        ManagedError::bad_request(
            "invalid_restore_id",
            "Restore ID must be a non-empty, control-free UTF-8 identifier of at most 1024 bytes",
        )
    })
}

fn now_millis() -> i64 {
    worker::Date::now().as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_fences_stale_epochs() {
        require_mutation_lifecycle(Some((GateStatus::Active, 8)), 8).unwrap();
        assert_eq!(
            require_mutation_lifecycle(Some((GateStatus::Active, 8)), 7)
                .unwrap_err()
                .code,
            "stale_managed_epoch"
        );
        assert_eq!(
            require_mutation_lifecycle(Some((GateStatus::Paused, 8)), 8)
                .unwrap_err()
                .code,
            "managed_repository_writes_paused"
        );
        assert!(require_mutation_lifecycle(None, 8).is_err());
    }

    #[test]
    fn restore_ids_match_the_transport_identifier_contract() {
        validate_restore_id("migration/移行 🚀").unwrap();
        assert!(validate_restore_id("").is_err());
        assert!(validate_restore_id("contains\u{85}control").is_err());
        assert!(validate_restore_id(&"x".repeat(1025)).is_err());
    }
}
