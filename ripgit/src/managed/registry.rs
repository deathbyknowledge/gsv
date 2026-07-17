use serde::{de::DeserializeOwned, Deserialize, Serialize};
use worker::{Env, Method, Request, Response, Result, SqlStorageValue};

use super::{
    json_request, json_response, read_json, ErasureState, ErasureStatus, GateState, GateStatus,
    ManagedError, ManagedObjectDescriptor, ManagedObjectLifecycle, ManagedResult,
    RepositoryIdentity, INTERNAL_CONTROL_HEADER, REGISTRY_NAME,
};
use crate::ManagedRepositoryRegistry;

const MAX_INVENTORY_PAGE: usize = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionRequest {
    pub identity: RepositoryIdentity,
    pub mutation: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionResponse {
    pub identity: RepositoryIdentity,
    pub gate: GateState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    pub provider_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMappingRequest {
    pub identity: RepositoryIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRecord {
    pub identity: RepositoryIdentity,
    pub applied_status: Option<GateStatus>,
    pub applied_epoch: Option<i64>,
    pub registered_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRequest {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryResponse {
    pub gate: GateState,
    pub erasure: ErasureState,
    pub repositories: Vec<RegistryRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeRequest {
    pub provider_id: String,
    pub status: GateStatus,
    pub epoch: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EraseAcknowledgeRequest {
    pub provider_id: String,
    pub epoch: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionResponse {
    pub gate: GateState,
    pub erasure: ErasureState,
    pub pending_repositories: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EraseProgressResponse {
    pub gate: GateState,
    pub erasure: ErasureState,
    pub remaining_repositories: i64,
}

#[derive(Deserialize)]
struct GateRow {
    status: String,
    epoch: i64,
}

#[derive(Deserialize)]
struct ErasureRow {
    status: String,
    epoch: i64,
}

#[derive(Deserialize)]
struct RegistryRow {
    provider_id: String,
    owner: String,
    repo: String,
    applied_status: Option<String>,
    applied_epoch: Option<i64>,
    registered_at: i64,
    updated_at: i64,
}

impl RegistryRow {
    fn into_record(self) -> ManagedResult<RegistryRecord> {
        let identity = RepositoryIdentity::new(&self.owner, &self.repo, &self.provider_id)?;
        let applied_status = self
            .applied_status
            .as_deref()
            .map(GateStatus::parse)
            .transpose()?;
        Ok(RegistryRecord {
            identity,
            applied_status,
            applied_epoch: self.applied_epoch,
            registered_at: self.registered_at,
            updated_at: self.updated_at,
        })
    }
}

impl ManagedRepositoryRegistry {
    pub(crate) async fn fetch_request(&self, mut req: Request) -> Result<Response> {
        if req.headers().get(INTERNAL_CONTROL_HEADER)?.as_deref() != Some("1") {
            let _body = req.stream();
            return ManagedError::forbidden(
                "managed_endpoint_forbidden",
                "Managed repository registry endpoints are private",
            )
            .into_response();
        }

        let result: ManagedResult<Response> = async {
            let path = req.url().map_err(ManagedError::from)?.path().to_string();
            match (req.method(), path.as_str()) {
                (Method::Post, "/admit") => self.admit(read_json(&mut req).await?).map_response(),
                (Method::Post, "/lookup") => self.lookup(read_json(&mut req).await?).map_response(),
                (Method::Post, "/legacy-map") => {
                    self.legacy_map(read_json(&mut req).await?).map_response()
                }
                (Method::Post, "/inventory") => {
                    self.inventory(read_json(&mut req).await?).map_response()
                }
                (Method::Post, "/gate/status") => {
                    let _: serde_json::Value = read_json(&mut req).await?;
                    self.status().map_response()
                }
                (Method::Post, "/descriptor") => {
                    let _: serde_json::Value = read_json(&mut req).await?;
                    self.descriptor().map_response()
                }
                (Method::Post, "/gate/pause") => {
                    let _: serde_json::Value = read_json(&mut req).await?;
                    self.pause().map_response()
                }
                (Method::Post, "/gate/resume") => {
                    let _: serde_json::Value = read_json(&mut req).await?;
                    self.begin_resume().map_response()
                }
                (Method::Post, "/gate/resume-seal") => {
                    let _: serde_json::Value = read_json(&mut req).await?;
                    self.seal_resume().map_response()
                }
                (Method::Post, "/erase/begin") => {
                    let _: serde_json::Value = read_json(&mut req).await?;
                    self.begin_erase().map_response()
                }
                (Method::Post, "/erase/ack") => self
                    .acknowledge_erase(read_json(&mut req).await?)
                    .map_response(),
                (Method::Post, "/erase/seal") => {
                    let _: serde_json::Value = read_json(&mut req).await?;
                    self.seal_erase().map_response()
                }
                (Method::Post, "/ack") => {
                    self.acknowledge(read_json(&mut req).await?).map_response()
                }
                _ => Err(ManagedError::not_found(
                    "managed_registry_endpoint_not_found",
                    "Managed repository registry endpoint was not found",
                )),
            }
        }
        .await;

        match result {
            Ok(response) => Ok(response),
            Err(error) => {
                let _body = req.stream();
                error.into_response()
            }
        }
    }
}

trait IntoManagedResponse<T> {
    fn map_response(self) -> ManagedResult<Response>;
}

impl<T: Serialize> IntoManagedResponse<T> for ManagedResult<T> {
    fn map_response(self) -> ManagedResult<Response> {
        let value = self?;
        json_response(&value, 200).map_err(ManagedError::from)
    }
}

impl ManagedRepositoryRegistry {
    fn gate(&self) -> ManagedResult<GateState> {
        let row: GateRow = self
            .sql
            .exec(
                "SELECT status, epoch FROM managed_gate WHERE singleton = 1",
                None,
            )?
            .one()?;
        Ok(GateState {
            status: GateStatus::parse(&row.status)?,
            epoch: row.epoch,
        })
    }

    fn erasure(&self) -> ManagedResult<ErasureState> {
        let row: ErasureRow = self
            .sql
            .exec(
                "SELECT status, epoch FROM managed_registry_erasure WHERE singleton = 1",
                None,
            )?
            .one()?;
        Ok(ErasureState {
            status: ErasureStatus::parse(&row.status)?,
            epoch: row.epoch,
        })
    }

    fn status(&self) -> ManagedResult<TransitionResponse> {
        let gate = self.gate()?;
        let pending_repositories = self.pending_count(&gate)?;
        Ok(TransitionResponse {
            gate,
            erasure: self.erasure()?,
            pending_repositories,
        })
    }

    fn descriptor(&self) -> ManagedResult<ManagedObjectDescriptor> {
        if !self.is_singleton {
            return Ok(ManagedObjectDescriptor {
                schema_version: 1,
                kind: "repository_registry".to_string(),
                provider_id: self.provider_id.clone(),
                logical_name: None,
                classification: "uninitialized".to_string(),
                lifecycle: ManagedObjectLifecycle {
                    status: "uninitialized".to_string(),
                    epoch: 0,
                },
            });
        }
        let gate = self.gate()?;
        let erasure = self.erasure()?;
        if erasure.status != ErasureStatus::Ready {
            return Ok(ManagedObjectDescriptor {
                schema_version: 1,
                kind: "repository_registry".to_string(),
                provider_id: self.provider_id.clone(),
                logical_name: Some(REGISTRY_NAME.to_string()),
                classification: if erasure.status == ErasureStatus::Erased {
                    "erased".to_string()
                } else {
                    "initialized".to_string()
                },
                lifecycle: ManagedObjectLifecycle {
                    status: erasure.status.as_str().to_string(),
                    epoch: erasure.epoch,
                },
            });
        }
        Ok(ManagedObjectDescriptor {
            schema_version: 1,
            kind: "repository_registry".to_string(),
            provider_id: self.provider_id.clone(),
            logical_name: Some(REGISTRY_NAME.to_string()),
            classification: "initialized".to_string(),
            lifecycle: ManagedObjectLifecycle {
                status: gate.status.as_descriptor_status().to_string(),
                epoch: gate.epoch,
            },
        })
    }

    fn admit(&self, request: AdmissionRequest) -> ManagedResult<AdmissionResponse> {
        request.identity.validate()?;
        require_operational(&self.erasure()?)?;
        let gate = self.gate()?;
        let existing = self.find_by_provider(&request.identity.provider_id)?;

        if let Some(existing) = existing {
            assert_identity_immutable(&existing.identity, &request.identity)?;
        } else {
            if gate.status != GateStatus::Active {
                return Err(ManagedError::unavailable(
                    "managed_repository_registration_paused",
                    "New repositories cannot be registered while the managed fleet is paused",
                ));
            }
            self.register(&request.identity)?;
        }

        if request.mutation && gate.status != GateStatus::Active {
            return Err(ManagedError::unavailable(
                "managed_repository_writes_paused",
                "Managed repository mutations are paused",
            ));
        }

        Ok(AdmissionResponse {
            identity: request.identity,
            gate,
        })
    }

    fn lookup(&self, request: ProviderRequest) -> ManagedResult<RegistryRecord> {
        validate_provider_id(&request.provider_id)?;
        require_registered(self.find_by_provider(&request.provider_id)?)
    }

    fn legacy_map(&self, request: LegacyMappingRequest) -> ManagedResult<RegistryRecord> {
        request.identity.validate()?;
        require_operational(&self.erasure()?)?;
        if self.gate()?.status == GateStatus::Resuming {
            return Err(ManagedError::conflict(
                "gate_transition_in_progress",
                "Legacy repository mappings cannot be added while resume is in progress",
            ));
        }
        if let Some(existing) = self.find_by_provider(&request.identity.provider_id)? {
            assert_identity_immutable(&existing.identity, &request.identity)?;
            return Ok(existing);
        }
        self.register(&request.identity)?;
        self.find_by_provider(&request.identity.provider_id)?
            .ok_or_else(|| ManagedError::internal("registry_write_failed", "Registry write failed"))
    }

    fn register(&self, identity: &RepositoryIdentity) -> ManagedResult<()> {
        if let Some(existing) = self.find_by_name(&identity.owner, &identity.repo)? {
            assert_identity_immutable(&existing.identity, identity)?;
            return Ok(());
        }
        let now = now_millis();
        self.sql.exec(
            "INSERT INTO managed_repositories
             (provider_id, owner, repo, do_name, applied_status, applied_epoch,
              registered_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)",
            vec![
                SqlStorageValue::from(identity.provider_id.clone()),
                SqlStorageValue::from(identity.owner.clone()),
                SqlStorageValue::from(identity.repo.clone()),
                SqlStorageValue::from(identity.do_name()),
                SqlStorageValue::from(now),
                SqlStorageValue::from(now),
            ],
        )?;
        Ok(())
    }

    fn inventory(&self, request: InventoryRequest) -> ManagedResult<InventoryResponse> {
        if let Some(cursor) = request.cursor.as_deref() {
            validate_provider_id(cursor)?;
        }
        let limit = request
            .limit
            .unwrap_or(MAX_INVENTORY_PAGE)
            .clamp(1, MAX_INVENTORY_PAGE);
        let cursor = request.cursor.unwrap_or_default();
        let rows: Vec<RegistryRow> = self
            .sql
            .exec(
                "SELECT provider_id, owner, repo, applied_status, applied_epoch,
                        registered_at, updated_at
                 FROM managed_repositories
                 WHERE provider_id > ?
                 ORDER BY provider_id
                 LIMIT ?",
                vec![
                    SqlStorageValue::from(cursor),
                    SqlStorageValue::from((limit + 1) as i64),
                ],
            )?
            .to_array()?;
        let has_more = rows.len() > limit;
        let mut repositories = rows
            .into_iter()
            .take(limit)
            .map(RegistryRow::into_record)
            .collect::<ManagedResult<Vec<_>>>()?;
        let next_cursor = has_more
            .then(|| {
                repositories
                    .last()
                    .map(|record| record.identity.provider_id.clone())
            })
            .flatten();

        Ok(InventoryResponse {
            gate: self.gate()?,
            erasure: self.erasure()?,
            repositories: std::mem::take(&mut repositories),
            next_cursor,
        })
    }

    fn pause(&self) -> ManagedResult<TransitionResponse> {
        require_operational(&self.erasure()?)?;
        let current = self.gate()?;
        let gate = current.pause()?;
        if gate != current {
            self.write_gate(&gate)?;
        }
        Ok(TransitionResponse {
            pending_repositories: self.pending_count(&gate)?,
            gate,
            erasure: self.erasure()?,
        })
    }

    fn begin_resume(&self) -> ManagedResult<TransitionResponse> {
        require_operational(&self.erasure()?)?;
        let current = self.gate()?;
        let gate = current.begin_resume()?;
        if gate != current {
            self.write_gate(&gate)?;
        }
        Ok(TransitionResponse {
            pending_repositories: self.pending_count(&gate)?,
            gate,
            erasure: self.erasure()?,
        })
    }

    fn seal_resume(&self) -> ManagedResult<TransitionResponse> {
        require_operational(&self.erasure()?)?;
        let gate = self.gate()?;
        if gate.status == GateStatus::Active {
            return self.status();
        }
        if gate.status != GateStatus::Resuming {
            return Err(ManagedError::conflict(
                "managed_resume_not_started",
                "Managed repository gate is not resuming",
            ));
        }
        let pending = self.pending_count(&gate)?;
        if pending != 0 {
            return Err(ManagedError::conflict(
                "managed_resume_incomplete",
                format!("{} repositories have not acknowledged resume", pending),
            ));
        }
        let active = GateState {
            status: GateStatus::Active,
            epoch: gate.epoch,
        };
        self.write_gate(&active)?;
        Ok(TransitionResponse {
            gate: active,
            erasure: self.erasure()?,
            pending_repositories: 0,
        })
    }

    fn acknowledge(&self, request: AcknowledgeRequest) -> ManagedResult<RegistryRecord> {
        validate_provider_id(&request.provider_id)?;
        require_operational(&self.erasure()?)?;
        let gate = self.gate()?;
        gate.require_epoch(request.epoch)?;
        let expected_status = match gate.status {
            GateStatus::Paused => GateStatus::Paused,
            GateStatus::Resuming | GateStatus::Active => GateStatus::Active,
        };
        if request.status != expected_status {
            return Err(ManagedError::conflict(
                "managed_acknowledgement_mismatch",
                "Repository acknowledgement does not match the current gate transition",
            ));
        }
        if self.find_by_provider(&request.provider_id)?.is_none() {
            return Err(ManagedError::not_found(
                "unknown_legacy_repository",
                "Repository provider ID is not present in the authoritative registry",
            ));
        }
        self.sql.exec(
            "UPDATE managed_repositories
             SET applied_status = ?, applied_epoch = ?, updated_at = ?
             WHERE provider_id = ?",
            vec![
                SqlStorageValue::from(request.status.as_str()),
                SqlStorageValue::from(request.epoch),
                SqlStorageValue::from(now_millis()),
                SqlStorageValue::from(request.provider_id.clone()),
            ],
        )?;
        self.find_by_provider(&request.provider_id)?
            .ok_or_else(|| ManagedError::internal("registry_write_failed", "Registry write failed"))
    }

    fn begin_erase(&self) -> ManagedResult<EraseProgressResponse> {
        let erasure = self.erasure()?;
        if erasure.status == ErasureStatus::Erased {
            let remaining_repositories = self.remaining_count()?;
            if remaining_repositories != 0 {
                return Err(ManagedError::internal(
                    "erased_registry_not_empty",
                    "Erased repository registry still contains identities",
                ));
            }
            return Ok(EraseProgressResponse {
                gate: self.require_erase_gate(&erasure)?,
                erasure,
                remaining_repositories,
            });
        }

        let current_gate = self.gate()?;
        let erase_epoch = if erasure.status == ErasureStatus::Erasing {
            erasure.epoch
        } else {
            match current_gate.status {
                GateStatus::Paused => current_gate.epoch,
                GateStatus::Active | GateStatus::Resuming => next_erase_epoch(current_gate.epoch)?,
            }
        };

        if erasure.status == ErasureStatus::Ready {
            let now = now_millis();
            self.sql.exec(
                "UPDATE managed_registry_erasure
                 SET status = 'erasing', epoch = ?, started_at = ?,
                     completed_at = NULL, updated_at = ?
                 WHERE singleton = 1 AND status = 'ready'",
                vec![
                    SqlStorageValue::from(erase_epoch),
                    SqlStorageValue::from(now),
                    SqlStorageValue::from(now),
                ],
            )?;
        }

        let erasure = self.erasure()?;
        if erasure.status != ErasureStatus::Erasing || erasure.epoch != erase_epoch {
            return Err(ManagedError::internal(
                "registry_erasure_not_started",
                "Repository registry erasure did not enter the expected state",
            ));
        }
        if current_gate.status != GateStatus::Paused || current_gate.epoch != erase_epoch {
            if current_gate.epoch > erase_epoch {
                return Err(ManagedError::internal(
                    "registry_erasure_epoch_regressed",
                    "Repository registry erase epoch regressed",
                ));
            }
            self.write_gate(&GateState {
                status: GateStatus::Paused,
                epoch: erase_epoch,
            })?;
        }
        let gate = self.require_erase_gate(&erasure)?;
        Ok(EraseProgressResponse {
            gate,
            erasure,
            remaining_repositories: self.remaining_count()?,
        })
    }

    fn acknowledge_erase(
        &self,
        request: EraseAcknowledgeRequest,
    ) -> ManagedResult<EraseProgressResponse> {
        validate_provider_id(&request.provider_id)?;
        let erasure = self.erasure()?;
        if erasure.status != ErasureStatus::Erasing || erasure.epoch != request.epoch {
            return Err(ManagedError::conflict(
                "stale_registry_erase",
                "Repository registry erase acknowledgement is stale",
            ));
        }
        let gate = self.gate()?;
        if gate.status != GateStatus::Paused || gate.epoch != request.epoch {
            return Err(ManagedError::conflict(
                "registry_erase_not_fenced",
                "Repository registry is not fenced at the erase epoch",
            ));
        }
        self.sql.exec(
            "DELETE FROM managed_repositories WHERE provider_id = ?",
            vec![SqlStorageValue::from(request.provider_id)],
        )?;
        Ok(EraseProgressResponse {
            gate,
            erasure,
            remaining_repositories: self.remaining_count()?,
        })
    }

    fn seal_erase(&self) -> ManagedResult<EraseProgressResponse> {
        let erasure = self.erasure()?;
        let remaining_repositories = self.remaining_count()?;
        if erasure.status == ErasureStatus::Erased {
            if remaining_repositories != 0 {
                return Err(ManagedError::internal(
                    "erased_registry_not_empty",
                    "Erased repository registry still contains identities",
                ));
            }
            return Ok(EraseProgressResponse {
                gate: self.require_erase_gate(&erasure)?,
                erasure,
                remaining_repositories,
            });
        }
        if erasure.status != ErasureStatus::Erasing {
            return Err(ManagedError::conflict(
                "registry_erase_not_started",
                "Repository registry erasure has not started",
            ));
        }
        if remaining_repositories != 0 {
            return Err(ManagedError::conflict(
                "registry_erase_incomplete",
                format!(
                    "{} repository identities remain during erase",
                    remaining_repositories
                ),
            ));
        }
        let gate = self.gate()?;
        if gate.status != GateStatus::Paused || gate.epoch != erasure.epoch {
            return Err(ManagedError::conflict(
                "registry_erase_not_fenced",
                "Repository registry is not fenced at the erase epoch",
            ));
        }
        let now = now_millis();
        self.sql.exec(
            "UPDATE managed_registry_erasure
             SET status = 'erased', completed_at = ?, updated_at = ?
             WHERE singleton = 1 AND status = 'erasing' AND epoch = ?",
            vec![
                SqlStorageValue::from(now),
                SqlStorageValue::from(now),
                SqlStorageValue::from(erasure.epoch),
            ],
        )?;
        let erased = self.erasure()?;
        if erased.status != ErasureStatus::Erased || erased.epoch != erasure.epoch {
            return Err(ManagedError::internal(
                "registry_erasure_not_committed",
                "Repository registry erasure tombstone was not committed",
            ));
        }
        Ok(EraseProgressResponse {
            gate,
            erasure: erased,
            remaining_repositories: 0,
        })
    }

    fn require_erase_gate(&self, erasure: &ErasureState) -> ManagedResult<GateState> {
        let gate = self.gate()?;
        if gate.status != GateStatus::Paused || gate.epoch != erasure.epoch {
            return Err(ManagedError::internal(
                "registry_erasure_not_fenced",
                "Repository registry erasure is not fenced at its tombstone epoch",
            ));
        }
        Ok(gate)
    }

    fn remaining_count(&self) -> ManagedResult<i64> {
        #[derive(Deserialize)]
        struct CountRow {
            count: i64,
        }
        let row: CountRow = self
            .sql
            .exec("SELECT COUNT(*) AS count FROM managed_repositories", None)?
            .one()?;
        Ok(row.count)
    }

    fn pending_count(&self, gate: &GateState) -> ManagedResult<i64> {
        if gate.status == GateStatus::Active {
            return Ok(0);
        }
        #[derive(Deserialize)]
        struct CountRow {
            count: i64,
        }
        let expected = match gate.status {
            GateStatus::Paused => "paused",
            GateStatus::Resuming | GateStatus::Active => "active",
        };
        let row: CountRow = self
            .sql
            .exec(
                "SELECT COUNT(*) AS count
                 FROM managed_repositories
                 WHERE applied_status IS NULL OR applied_status != ?
                    OR applied_epoch IS NULL OR applied_epoch != ?",
                vec![
                    SqlStorageValue::from(expected),
                    SqlStorageValue::from(gate.epoch),
                ],
            )?
            .one()?;
        Ok(row.count)
    }

    fn write_gate(&self, gate: &GateState) -> ManagedResult<()> {
        self.sql.exec(
            "UPDATE managed_gate SET status = ?, epoch = ?, updated_at = ?
             WHERE singleton = 1",
            vec![
                SqlStorageValue::from(gate.status.as_str()),
                SqlStorageValue::from(gate.epoch),
                SqlStorageValue::from(now_millis()),
            ],
        )?;
        Ok(())
    }

    fn find_by_provider(&self, provider_id: &str) -> ManagedResult<Option<RegistryRecord>> {
        let rows: Vec<RegistryRow> = self
            .sql
            .exec(
                "SELECT provider_id, owner, repo, applied_status, applied_epoch,
                        registered_at, updated_at
                 FROM managed_repositories WHERE provider_id = ?",
                vec![SqlStorageValue::from(provider_id)],
            )?
            .to_array()?;
        rows.into_iter()
            .next()
            .map(RegistryRow::into_record)
            .transpose()
    }

    fn find_by_name(&self, owner: &str, repo: &str) -> ManagedResult<Option<RegistryRecord>> {
        let rows: Vec<RegistryRow> = self
            .sql
            .exec(
                "SELECT provider_id, owner, repo, applied_status, applied_epoch,
                        registered_at, updated_at
                 FROM managed_repositories WHERE owner = ? AND repo = ?",
                vec![SqlStorageValue::from(owner), SqlStorageValue::from(repo)],
            )?
            .to_array()?;
        rows.into_iter()
            .next()
            .map(RegistryRow::into_record)
            .transpose()
    }
}

pub async fn call_registry<Req: Serialize, Res: DeserializeOwned>(
    env: &Env,
    path: &str,
    request: &Req,
) -> ManagedResult<Res> {
    let namespace = env
        .durable_object("MANAGED_REPOSITORY_REGISTRY")
        .map_err(ManagedError::from)?;
    let stub = namespace
        .id_from_name(REGISTRY_NAME)
        .and_then(|id| id.get_stub())
        .map_err(ManagedError::from)?;
    let request = json_request(&format!("https://managed.invalid{}", path), request)
        .map_err(ManagedError::from)?;
    let mut response = stub
        .fetch_with_request(request)
        .await
        .map_err(ManagedError::from)?;
    let status = response.status_code();
    let bytes = response.bytes().await.map_err(ManagedError::from)?;
    if !(200..300).contains(&status) {
        #[derive(Deserialize)]
        struct ErrorBody {
            error: String,
            message: String,
        }
        let body: ErrorBody = serde_json::from_slice(&bytes).map_err(|_| {
            ManagedError::internal(
                "managed_registry_invalid_response",
                "Managed repository registry returned an invalid error response",
            )
        })?;
        return Err(ManagedError::new(status, body.error, body.message));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        ManagedError::internal(
            "managed_registry_invalid_response",
            "Managed repository registry returned an invalid response",
        )
    })
}

fn assert_identity_immutable(
    existing: &RepositoryIdentity,
    requested: &RepositoryIdentity,
) -> ManagedResult<()> {
    if existing != requested {
        return Err(ManagedError::conflict(
            "repository_identity_conflict",
            "Repository identity is immutable once registered",
        ));
    }
    Ok(())
}

fn validate_provider_id(provider_id: &str) -> ManagedResult<()> {
    RepositoryIdentity::new("validation", "validation", provider_id).map(|_| ())
}

fn require_operational(erasure: &ErasureState) -> ManagedResult<()> {
    match erasure.status {
        ErasureStatus::Ready => Ok(()),
        ErasureStatus::Erasing => Err(ManagedError::unavailable(
            "managed_repository_erasing",
            "Repository fleet erasure is in progress",
        )),
        ErasureStatus::Erased => Err(ManagedError::new(
            410,
            "managed_repository_registry_erased",
            "Repository fleet has been irreversibly erased",
        )),
    }
}

fn next_erase_epoch(epoch: i64) -> ManagedResult<i64> {
    epoch.checked_add(1).ok_or_else(|| {
        ManagedError::internal(
            "managed_epoch_exhausted",
            "Managed repository lifecycle epoch is exhausted",
        )
    })
}

fn require_registered<T>(record: Option<T>) -> ManagedResult<T> {
    record.ok_or_else(|| {
        ManagedError::not_found(
            "unknown_legacy_repository",
            "Repository provider ID is not present in the authoritative registry",
        )
    })
}

fn now_millis() -> i64 {
    worker::Date::now().as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(owner: &str, repo: &str, byte: char) -> RepositoryIdentity {
        RepositoryIdentity::new(owner, repo, &byte.to_string().repeat(64)).unwrap()
    }

    #[test]
    fn registry_identity_is_immutable() {
        let original = identity("alice", "memory", 'a');
        assert_identity_immutable(&original, &original).unwrap();
        let renamed = identity("alice", "other", 'a');
        assert_eq!(
            assert_identity_immutable(&original, &renamed)
                .unwrap_err()
                .code,
            "repository_identity_conflict"
        );
        let rebound = identity("alice", "memory", 'b');
        assert!(assert_identity_immutable(&original, &rebound).is_err());
    }

    #[test]
    fn unknown_legacy_provider_ids_fail_closed() {
        let error = require_registered::<RepositoryIdentity>(None).unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.code, "unknown_legacy_repository");
    }

    #[test]
    fn erased_registry_can_never_become_operational_again() {
        assert!(require_operational(&ErasureState {
            status: ErasureStatus::Ready,
            epoch: 1,
        })
        .is_ok());
        assert_eq!(
            require_operational(&ErasureState {
                status: ErasureStatus::Erasing,
                epoch: 2,
            })
            .unwrap_err()
            .code,
            "managed_repository_erasing"
        );
        let erased = require_operational(&ErasureState {
            status: ErasureStatus::Erased,
            epoch: 2,
        })
        .unwrap_err();
        assert_eq!(erased.status, 410);
        assert_eq!(erased.code, "managed_repository_registry_erased");
    }
}
