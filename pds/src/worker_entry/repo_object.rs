use super::*;
use worker::durable_object;

#[durable_object]
pub struct RepoObject {
    sql: SqlStorage,
    #[allow(dead_code)]
    state: State,
    #[allow(dead_code)]
    env: Env,
}

impl DurableObject for RepoObject {
    fn new(state: State, env: Env) -> Self {
        let sql = state.storage().sql();
        SqlRepoStore::new(sql.clone())
            .init_schema()
            .expect("initialize repo durable object schema");
        Self { sql, state, env }
    }

    async fn fetch(&self, mut req: Request) -> worker::Result<Response> {
        match self.handle(&mut req).await {
            Ok(response) => Ok(response),
            Err(error) => json_response(
                error.status,
                &xrpc_error_body(&error.message, Some(error.message.as_str())),
            ),
        }
    }
}

impl RepoObject {
    async fn handle(&self, req: &mut Request) -> Result<Response, HttpError> {
        if req.method() == Method::Options {
            return empty_response(204).map_err(HttpError::worker);
        }

        let url = req.url().map_err(HttpError::worker)?;
        let parts = url
            .path()
            .trim_start_matches('/')
            .split('/')
            .collect::<Vec<_>>();
        if req.method() == Method::Get {
            match url.path() {
                DID_DOCUMENT_PATH => return self.did_document_response(&url),
                ATPROTO_DID_PATH => return self.handle_did_response(),
                _ => {}
            }
        }

        if parts.len() >= 2 && parts[0] == "xrpc" && !parts[1].is_empty() {
            return self.handle_xrpc(req, parts[1], &url).await;
        }

        if let Some((repo_name, action)) = internal_repo_control_parts(&parts) {
            return match (req.method(), action) {
                (Method::Get, InternalRepoControlAction::Status) => self.status(),
                (Method::Post, InternalRepoControlAction::Init) => self.init(req, repo_name).await,
                (Method::Post, InternalRepoControlAction::Clear) => self.clear(req),
                (Method::Put, InternalRepoControlAction::Identity) => {
                    self.update_identity(req).await
                }
                (Method::Put, InternalRepoControlAction::SigningKey) => {
                    self.update_signing_key(req).await
                }
                (Method::Post, InternalRepoControlAction::ServiceAuth) => {
                    self.service_auth(req).await
                }
                _ => Err(HttpError::new(404, "not found")),
            };
        }

        Err(HttpError::new(404, "not found"))
    }

    fn store(&self) -> SqlRepoStore {
        SqlRepoStore::new(self.sql.clone())
    }

    async fn ensure_record_envelope_dynamic(
        &self,
        collection: &Nsid,
        record: &Value,
        validate: Option<bool>,
    ) -> Result<RecordValidationStatus, HttpError> {
        ensure_record_shape(collection, record)?;
        if validate == Some(false) {
            return Ok(RecordValidationStatus::Unknown);
        }
        let lexicons = self
            .lexicons_for_collection(collection, validate == Some(true))
            .await?;
        lexicon::validate_record_with_lexicons(
            collection.as_str(),
            record,
            validate == Some(true),
            &lexicons,
        )
        .map_err(|error| HttpError::new(400, error.to_string()))
    }

    async fn lexicons_for_collection(
        &self,
        collection: &Nsid,
        explicit: bool,
    ) -> Result<Vec<Value>, HttpError> {
        let mut lexicons = extra_lexicons_from_env(&self.env)?;
        for (nsid, cached) in self.store().list_lexicons().map_err(HttpError::worker)? {
            if lexicons
                .iter()
                .any(|lexicon| lexicon.get("id").and_then(Value::as_str) == Some(nsid.as_str()))
            {
                continue;
            }
            lexicons.push(from_str(&cached).map_err(|error| {
                HttpError::new(
                    500,
                    format!("cached Lexicon `{nsid}` could not be parsed: {error}"),
                )
            })?);
        }

        let has_collection = lexicons
            .iter()
            .any(|lexicon| lexicon.get("id").and_then(Value::as_str) == Some(collection.as_str()));

        if !has_collection && explicit {
            if let Some(published) = fetch_published_lexicon(&self.env, collection.as_str()).await?
            {
                let published_json = to_string(&published).map_err(HttpError::worker)?;
                self.store()
                    .put_lexicon(collection.as_str(), &published_json, "published")
                    .map_err(HttpError::worker)?;
                lexicons.push(published);
            }
        }
        if explicit {
            self.resolve_published_lexicon_dependencies(&mut lexicons)
                .await?;
        }

        Ok(lexicons)
    }

    async fn resolve_published_lexicon_dependencies(
        &self,
        lexicons: &mut Vec<Value>,
    ) -> Result<(), HttpError> {
        let mut known = lexicons
            .iter()
            .filter_map(|lexicon| lexicon.get("id").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<BTreeSet<_>>();
        let mut queue = lexicons
            .iter()
            .flat_map(lexicon::referenced_lexicon_ids)
            .filter(|nsid| !known.contains(nsid))
            .collect::<VecDeque<_>>();
        let mut fetched = 0;

        while let Some(nsid) = queue.pop_front() {
            if known.contains(&nsid) {
                continue;
            }
            if fetched >= MAX_DYNAMIC_LEXICON_FETCHES {
                return Err(HttpError::new(
                    400,
                    format!(
                        "Lexicon dependency resolution exceeded {MAX_DYNAMIC_LEXICON_FETCHES} remote fetches"
                    ),
                ));
            }
            fetched += 1;

            let Some(published) = fetch_published_lexicon(&self.env, &nsid).await? else {
                continue;
            };
            let published_json = to_string(&published).map_err(HttpError::worker)?;
            self.store()
                .put_lexicon(&nsid, &published_json, "published")
                .map_err(HttpError::worker)?;
            known.insert(nsid);
            for reference in lexicon::referenced_lexicon_ids(&published) {
                if !known.contains(&reference) {
                    queue.push_back(reference);
                }
            }
            lexicons.push(published);
        }

        Ok(())
    }

    async fn handle_xrpc(
        &self,
        req: &mut Request,
        xrpc_method: &str,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        match (req.method(), xrpc_method) {
            (Method::Get, REPO_DESCRIBE_REPO) => self.xrpc_describe_repo(url).await,
            (Method::Get, REPO_GET_RECORD) => self.xrpc_get_record(url).await,
            (Method::Get, REPO_LIST_RECORDS) => self.xrpc_list_records(url).await,
            (Method::Get, SYNC_GET_LATEST_COMMIT) => self.xrpc_get_latest_commit(url),
            (Method::Get, SYNC_GET_HEAD) => self.xrpc_get_head(url),
            (Method::Get, SYNC_GET_REPO_STATUS) => self.xrpc_get_repo_status(url).await,
            (Method::Get, SYNC_LIST_BLOBS) => self.xrpc_list_blobs(url).await,
            (Method::Get, SYNC_GET_BLOB) => self.xrpc_get_blob(url).await,
            (Method::Get, SYNC_GET_BLOCKS) => self.xrpc_get_blocks(url),
            (Method::Get, SYNC_GET_RECORD) => self.xrpc_get_sync_record(url).await,
            (Method::Get, SYNC_GET_CHECKOUT) => self.xrpc_get_checkout(url).await,
            (Method::Get, SYNC_GET_REPO) => self.xrpc_get_repo(url).await,
            (Method::Get, IDENTITY_RESOLVE_DID) => self.xrpc_resolve_did(url),
            (Method::Get, REPO_LIST_MISSING_BLOBS) => self.xrpc_list_missing_blobs(req, url).await,
            (Method::Get, SERVER_DESCRIBE_SERVER) => {
                describe_server(url).map_err(HttpError::worker)
            }
            (Method::Post, REPO_CREATE_RECORD) => self.xrpc_create_record(req).await,
            (Method::Post, REPO_PUT_RECORD) => self.xrpc_put_record(req).await,
            (Method::Post, REPO_DELETE_RECORD) => self.xrpc_delete_record(req).await,
            (Method::Post, REPO_APPLY_WRITES) => self.xrpc_apply_writes(req).await,
            (Method::Post, REPO_IMPORT_REPO) => self.xrpc_import_repo(req).await,
            (Method::Post, REPO_UPLOAD_BLOB) => self.xrpc_upload_blob(req).await,
            (
                _,
                REPO_DESCRIBE_REPO
                | REPO_GET_RECORD
                | REPO_LIST_RECORDS
                | SYNC_GET_LATEST_COMMIT
                | SYNC_GET_HEAD
                | SYNC_GET_REPO_STATUS
                | SYNC_LIST_BLOBS
                | SYNC_GET_BLOB
                | SYNC_GET_BLOCKS
                | SYNC_GET_RECORD
                | SYNC_GET_CHECKOUT
                | SYNC_GET_REPO
                | IDENTITY_RESOLVE_DID
                | SERVER_DESCRIBE_SERVER
                | REPO_CREATE_RECORD
                | REPO_PUT_RECORD
                | REPO_DELETE_RECORD
                | REPO_APPLY_WRITES
                | REPO_IMPORT_REPO
                | REPO_UPLOAD_BLOB
                | REPO_LIST_MISSING_BLOBS,
            ) => Err(HttpError::new(405, "method not allowed")),
            _ => Err(HttpError::new(404, "unsupported XRPC method")),
        }
    }

    fn status(&self) -> Result<Response, HttpError> {
        let store = self.store();
        let state = store.get_repo_state().map_err(HttpError::worker)?;
        let identity = store.get_repo_identity().map_err(HttpError::worker)?;
        let blocks = store.block_count().map_err(HttpError::worker)?;
        let records = store.record_count().map_err(HttpError::worker)?;
        let blobs = store.blob_count().map_err(HttpError::worker)?;
        let blob_bytes = store.total_blob_bytes().map_err(HttpError::worker)?;
        let expected_blobs = store.expected_blob_count().map_err(HttpError::worker)?;
        let imported_blobs = store.imported_blob_count().map_err(HttpError::worker)?;

        json_response(
            200,
            &json!({
                "initialized": state.is_some(),
                "did": state.as_ref().map(|row| row.did.to_string()),
                "handle": identity.as_ref().map(|row| row.handle.clone()),
                "publicKeyMultibase": identity.as_ref().map(|row| row.public_key_multibase.clone()),
                "latestCommit": state.as_ref().map(|row| row.latest_commit.to_string()),
                "latestRev": state.as_ref().map(|row| row.latest_rev.to_string()),
                "blocks": blocks,
                "records": records,
                "blobs": blobs,
                "blobBytes": blob_bytes,
                "expectedBlobs": expected_blobs,
                "importedBlobs": imported_blobs,
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn service_auth(&self, req: &mut Request) -> Result<Response, HttpError> {
        self.require_admin(req)?;
        let body: ServiceAuthRequest = req.json().await.map_err(HttpError::worker)?;
        let aud = Did::new(body.aud).map_err(HttpError::bad_request)?;
        let lxm = body
            .lxm
            .map(Nsid::new)
            .transpose()
            .map_err(HttpError::bad_request)?;
        if body.exp <= current_unix_time() {
            return Err(HttpError::new(400, "BadExpiration"));
        }

        let state = self.repo_state()?;
        let identity = self.repo_identity()?;
        let signing_key = identity.signing_key().map_err(HttpError::identity)?;
        let token = service_auth_jwt(
            &signing_key,
            state.did.as_str(),
            aud.as_str(),
            lxm.as_ref().map(Nsid::as_str),
            body.exp,
        )?;
        json_response(200, &json!({ "token": token })).map_err(HttpError::worker)
    }

    async fn xrpc_describe_repo(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let repo_param = required_param(&params, "repo").map_err(HttpError::xrpc)?;
        let (state, identity, mut repo) = self.open_repo_with_identity()?;
        let entries = repo.entries().await.map_err(HttpError::repo)?;
        let collections = entries
            .into_iter()
            .map(|entry| entry.path.collection.to_string())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        json_response(
            200,
            &json!({
                "handle": identity.handle.clone(),
                "did": state.did.to_string(),
                "didDoc": did_document(
                    state.did.as_str(),
                    &identity.handle,
                    &identity.public_key_multibase,
                    &request_origin(url),
                ),
                "collections": collections,
                "handleIsCorrect": handle_is_correct(&repo_param, &identity.handle, state.did.as_str()),
            }),
        )
        .map_err(HttpError::worker)
    }

    fn xrpc_resolve_did(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let store = self.store();
        let Some(state) = store.get_repo_state().map_err(HttpError::worker)? else {
            return Err(HttpError::new(404, "DidNotFound"));
        };
        if state.did.as_str() != did {
            return Err(HttpError::new(404, "DidNotFound"));
        }
        let identity = self.repo_identity_from(&store)?;
        json_response(
            200,
            &json!({
                "didDoc": did_document(
                    state.did.as_str(),
                    &identity.handle,
                    &identity.public_key_multibase,
                    &request_origin(url),
                ),
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn xrpc_get_record(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        required_param(&params, "repo").map_err(HttpError::xrpc)?;
        let collection = Nsid::new(required_param(&params, "collection").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let rkey = RecordKey::new(required_param(&params, "rkey").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let expected_cid = optional_param(&params, "cid")
            .filter(|value| !value.is_empty())
            .map(|value| parse_cid(&value).map_err(HttpError::bad_request))
            .transpose()?;
        let path = RepoPath::new(collection, rkey);

        let (state, mut repo) = self.open_repo_with_state()?;
        let Some(stored) = repo
            .get_record::<Value>(&path)
            .await
            .map_err(HttpError::repo)?
        else {
            return Err(HttpError::new(404, "record not found"));
        };
        if expected_cid.is_some_and(|cid| cid != stored.cid) {
            return Err(HttpError::new(404, "record not found"));
        }

        json_response(
            200,
            &json!({
                "uri": at_uri(
                    state.did.as_str(),
                    stored.path.collection.as_str(),
                    stored.path.rkey.as_str()
                ),
                "cid": stored.cid.to_string(),
                "value": stored.record,
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn xrpc_list_records(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        required_param(&params, "repo").map_err(HttpError::xrpc)?;
        let list_params = parse_list_records_params(&params).map_err(HttpError::xrpc)?;
        let collection = Nsid::new(list_params.collection).map_err(HttpError::bad_request)?;
        let (state, mut repo) = self.open_repo_with_state()?;
        let mut entries = repo
            .entries_for_collection(&collection)
            .await
            .map_err(HttpError::repo)?;
        if list_params.reverse {
            entries.reverse();
        }

        let start = list_params
            .cursor
            .as_deref()
            .and_then(|cursor| {
                entries
                    .iter()
                    .position(|entry| entry.path.as_mst_key() == cursor)
            })
            .map(|index| index + 1)
            .unwrap_or(0);
        let entry_count = entries.len();
        let selected = entries
            .into_iter()
            .skip(start)
            .take(list_params.limit)
            .collect::<Vec<_>>();
        let next_cursor = if entry_count > start + selected.len() {
            selected.last().map(|entry| entry.path.as_mst_key())
        } else {
            None
        };

        let mut records = Vec::with_capacity(selected.len());
        for entry in &selected {
            let Some(stored) = repo
                .get_record::<Value>(&entry.path)
                .await
                .map_err(HttpError::repo)?
            else {
                return Err(HttpError::new(
                    500,
                    "record index points to a missing MST entry",
                ));
            };
            records.push(json!({
                "uri": at_uri(
                    state.did.as_str(),
                    stored.path.collection.as_str(),
                    stored.path.rkey.as_str()
                ),
                "cid": stored.cid.to_string(),
                "value": stored.record,
            }));
        }

        let mut body = json!({
            "records": records,
        });
        if let Some(cursor) = next_cursor {
            body["cursor"] = json!(cursor);
        }
        json_response(200, &body).map_err(HttpError::worker)
    }

    fn xrpc_get_latest_commit(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let state = self.repo_state()?;
        ensure_repo_did(&state, &did)?;

        json_response(
            200,
            &json!({
                "cid": state.latest_commit.to_string(),
                "rev": state.latest_rev.to_string(),
            }),
        )
        .map_err(HttpError::worker)
    }

    fn xrpc_get_head(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let state = self.repo_state()?;
        ensure_repo_did(&state, &did)?;

        json_response(
            200,
            &json!({
                "root": state.latest_commit.to_string(),
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn xrpc_get_repo_status(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let Some(state) = self.store().get_repo_state().map_err(HttpError::worker)? else {
            return Err(HttpError::new(404, "RepoNotFound"));
        };
        if state.did.as_str() != did {
            return Err(HttpError::new(404, "RepoNotFound"));
        }

        let account_status = self
            .directory_account_status_for_repo(url, state.did.as_str())
            .await?;
        let active = account_status.as_ref().is_none_or(|status| status.active);
        let mut body = json!({
            "did": state.did.to_string(),
            "active": active,
        });
        if active {
            body["rev"] = json!(state.latest_rev.to_string());
        } else if let Some(status) = account_status.and_then(|status| status.status) {
            body["status"] = json!(status);
        }

        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn directory_account_status_for_repo(
        &self,
        url: &worker::Url,
        did: &str,
    ) -> Result<Option<InternalAccountStatusResponse>, HttpError> {
        let Some(host) = url.host_str() else {
            return Ok(None);
        };
        let path = internal_directory_account_status_path(did);
        let mut response =
            fetch_internal_directory_request(&self.env, host, Method::Get, &path, None).await?;
        let status = response.status_code();
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            let message = response
                .text()
                .await
                .unwrap_or_else(|_| "failed to read directory response".to_string());
            return Err(HttpError::new(
                500,
                format!("account status lookup failed with status {status}: {message}"),
            ));
        }
        response.json().await.map(Some).map_err(HttpError::worker)
    }

    async fn ensure_repo_publicly_active(
        &self,
        url: &worker::Url,
        state: &RepoStateRow,
    ) -> Result<(), HttpError> {
        if self
            .directory_account_status_for_repo(url, state.did.as_str())
            .await?
            .is_some_and(|status| !status.active)
        {
            Err(HttpError::new(403, "RepoDeactivated"))
        } else {
            Ok(())
        }
    }

    async fn xrpc_list_blobs(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let state = self.repo_state()?;
        ensure_repo_did(&state, &did)?;
        self.ensure_repo_publicly_active(url, &state).await?;
        let limit = parse_xrpc_limit(optional_param(&params, "limit").as_deref(), 500, 1000)?;
        let cursor = optional_param(&params, "cursor").filter(|value| !value.is_empty());
        let (cids, next_cursor) = self
            .store()
            .list_blob_cids(limit, cursor.as_deref())
            .map_err(HttpError::worker)?;

        let mut body = json!({
            "cids": cids
                .into_iter()
                .map(|cid| cid.to_string())
                .collect::<Vec<_>>(),
        });
        if let Some(cursor) = next_cursor {
            body["cursor"] = json!(cursor);
        }

        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn xrpc_list_missing_blobs(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let limit = parse_xrpc_limit(optional_param(&params, "limit").as_deref(), 500, 1000)?;
        let cursor = optional_param(&params, "cursor").filter(|value| !value.is_empty());
        let state = self.repo_state()?;
        self.require_repo_maintenance_auth(req, &state.did).await?;
        if let Some(repo) = optional_param(&params, "repo").filter(|value| !value.trim().is_empty())
        {
            ensure_repo_identifier(&state, &self.repo_identity()?, &repo)?;
        }
        let (refs, next_cursor) = self
            .store()
            .list_missing_blob_refs(limit, cursor.as_deref())
            .map_err(HttpError::worker)?;

        let mut body = json!({
            "blobs": refs
                .into_iter()
                .map(|row| json!({
                    "cid": row.cid.to_string(),
                    "recordUri": at_uri(
                        state.did.as_str(),
                        row.path.collection.as_str(),
                        row.path.rkey.as_str()
                    ),
                }))
                .collect::<Vec<_>>(),
        });
        if let Some(cursor) = next_cursor {
            body["cursor"] = json!(cursor);
        }

        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn xrpc_get_blob(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let cid = required_param(&params, "cid").map_err(HttpError::xrpc)?;
        let state = self.repo_state()?;
        ensure_repo_did(&state, &did)?;
        self.ensure_repo_publicly_active(url, &state).await?;
        let cid = parse_cid(&cid).map_err(HttpError::bad_request)?;
        if self
            .store()
            .blob_ref_count(&cid)
            .map_err(HttpError::worker)?
            == 0
        {
            return Err(HttpError::new(404, "BlobNotFound"));
        }
        let Some(blob) = self.store().get_blob(&cid).map_err(HttpError::worker)? else {
            return Err(HttpError::new(404, "BlobNotFound"));
        };

        self.blob_response_for_row(blob).await
    }

    fn xrpc_get_blocks(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = parse_get_blocks_params(&query_pairs(url)).map_err(HttpError::xrpc)?;
        let state = self.repo_state()?;
        ensure_repo_did(&state, &params.did)?;
        let cids = params
            .cids
            .iter()
            .map(|cid| parse_cid(cid).map_err(HttpError::bad_request))
            .collect::<Result<Vec<_>, _>>()?;
        let store = self.store();
        let car = encode_car_from_store(&[], cids, &store).map_err(|error| match error {
            CarError::MissingBlock { cid } => {
                HttpError::new(404, format!("BlockNotFound: block `{cid}` not found"))
            }
            other => HttpError::car(other),
        })?;
        car_response(car).map_err(HttpError::worker)
    }

    async fn xrpc_get_sync_record(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let collection = Nsid::new(required_param(&params, "collection").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let rkey = RecordKey::new(required_param(&params, "rkey").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let path = RepoPath::new(collection, rkey);
        let (state, mut repo) = self.open_repo_with_state()?;
        ensure_repo_did(&state, &did)?;

        let cids = repo
            .extract_record_cids(&path)
            .await
            .map_err(HttpError::repo)?;
        let car = encode_car_from_store(&[state.latest_commit], cids, repo.storage())
            .map_err(HttpError::car)?;
        car_response(car).map_err(HttpError::worker)
    }

    async fn xrpc_get_checkout(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let (state, mut repo) = self.open_repo_with_state()?;
        ensure_repo_did(&state, &did)?;
        let cids = repo.export_cids().await.map_err(HttpError::repo)?;
        let car = encode_car_from_store(&[state.latest_commit], cids, repo.storage())
            .map_err(HttpError::car)?;
        car_response(car).map_err(HttpError::worker)
    }

    async fn xrpc_get_repo(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = required_param(&params, "did").map_err(HttpError::xrpc)?;
        let (state, mut repo) = self.open_repo_with_state()?;
        ensure_repo_did(&state, &did)?;
        let car = if let Some(since) =
            optional_param(&params, "since").filter(|value| !value.is_empty())
        {
            self.repo_diff_car_since(&state, &since).await?
        } else {
            let cids = repo.export_cids().await.map_err(HttpError::repo)?;
            encode_car_from_store(&[state.latest_commit], cids, repo.storage())
                .map_err(HttpError::car)?
        };
        car_response(car).map_err(HttpError::worker)
    }

    async fn init(&self, req: &mut Request, repo_name: &str) -> Result<Response, HttpError> {
        let body: InitRepoRequest = req.json().await.map_err(HttpError::worker)?;
        self.require_admin(req)?;
        let request_host = request_host(req)?;
        let store = self.store();
        let existing = store.get_repo_state().map_err(HttpError::worker)?;
        if existing.is_some() && !body.reset.unwrap_or(false) {
            return Err(HttpError::new(409, "repo already initialized"));
        }
        if body.reset.unwrap_or(false) {
            store.clear_all().map_err(HttpError::worker)?;
        }

        let did = Did::new(body.did).map_err(HttpError::bad_request)?;
        let rev = RepoRev::new(body.rev).map_err(HttpError::bad_request)?;
        let signing_key = RepoSigningKey::from_p256_hex(&body.signing_key_p256_hex)
            .map_err(HttpError::identity)?;
        let identity = RepoIdentityRow {
            handle: body.handle,
            signing_key_p256_hex: signing_key.to_p256_hex(),
            public_key_multibase: signing_key
                .public_key_multibase()
                .map_err(HttpError::identity)?,
        };
        let mut repo = SignedRepository::create(store, did.clone(), rev.clone(), &signing_key)
            .await
            .map_err(HttpError::repo)?;
        let state = RepoStateRow {
            did,
            latest_commit: repo.latest_commit_cid(),
            latest_rev: rev,
        };
        let event = self
            .repo_commit_event_payload(&mut repo, state.latest_commit, None, Vec::new())
            .await?;
        repo.storage()
            .put_repo_state(&state)
            .map_err(HttpError::worker)?;
        repo.storage()
            .put_repo_identity(&identity)
            .map_err(HttpError::worker)?;
        self.persist_commit_event(repo.storage(), &state, &event)
            .map_err(HttpError::worker)?;
        if body.notify_directory.unwrap_or(true) {
            self.notify_directory(
                &request_host,
                repo_name,
                &identity,
                &state,
                true,
                None,
                Some(&event),
            )
            .await?;
        }

        json_response(
            201,
            &json!({
                "did": state.did.to_string(),
                "handle": identity.handle,
                "publicKeyMultibase": identity.public_key_multibase,
                "latestCommit": state.latest_commit.to_string(),
                "latestRev": state.latest_rev.to_string(),
                "mstRoot": repo.mst_root().to_string(),
            }),
        )
        .map_err(HttpError::worker)
    }

    fn clear(&self, req: &Request) -> Result<Response, HttpError> {
        self.require_admin(req)?;
        self.store().clear_all().map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn update_identity(&self, req: &mut Request) -> Result<Response, HttpError> {
        self.require_admin(req)?;
        let body: UpdateRepoIdentityRequest = req.json().await.map_err(HttpError::worker)?;
        let store = self.store();
        let mut identity = self.repo_identity_from(&store)?;
        identity.handle = body.handle.to_ascii_lowercase();
        validate_handle_syntax(&identity.handle).map_err(HttpError::bad_request)?;
        store
            .put_repo_identity(&identity)
            .map_err(HttpError::worker)?;
        json_response(
            200,
            &json!({
                "handle": identity.handle,
                "publicKeyMultibase": identity.public_key_multibase,
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn update_signing_key(&self, req: &mut Request) -> Result<Response, HttpError> {
        self.require_admin(req)?;
        let body: UpdateRepoSigningKeyRequest = req.json().await.map_err(HttpError::worker)?;
        let signing_key = RepoSigningKey::from_p256_hex(&body.signing_key_p256_hex)
            .map_err(HttpError::identity)?;
        let public_key_multibase = signing_key
            .public_key_multibase()
            .map_err(HttpError::identity)?;
        let store = self.store();
        self.repo_identity_from(&store)?;
        store
            .update_repo_signing_key(&signing_key.to_p256_hex(), &public_key_multibase)
            .map_err(HttpError::worker)?;
        json_response(
            200,
            &json!({
                "signingKey": did_key_from_public_key_multibase(&public_key_multibase)?,
                "publicKeyMultibase": public_key_multibase,
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn xrpc_create_record(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: XrpcCreateRecordRequest = req.json().await.map_err(HttpError::worker)?;
        let request_host = request_host(req)?;
        let (previous_state, identity, signing_key, mut repo) =
            self.open_repo_for_write_with_state()?;
        ensure_repo_identifier(&previous_state, &identity, &body.repo)?;
        self.require_repo_write_auth(req, &previous_state.did)
            .await?;
        ensure_swap_commit(&previous_state, body.swap_commit.as_deref())?;

        let collection = Nsid::new(body.collection).map_err(HttpError::bad_request)?;
        let rkey = if let Some(rkey) = body.rkey {
            RecordKey::new(rkey).map_err(HttpError::bad_request)?
        } else {
            generated_record_key(&previous_state.latest_commit)?
        };
        let path = RepoPath::new(collection, rkey);
        let validation_status = self
            .ensure_record_envelope_dynamic(&path.collection, &body.record, body.validate)
            .await?;
        let blob_cids = extract_record_blob_refs(&body.record)?;
        ensure_blob_refs_available(repo.storage(), &blob_cids)?;
        let rev = generated_repo_rev(&previous_state.latest_commit)?;
        let mutation = repo
            .create_record(path.clone(), &body.record, rev, &signing_key)
            .await
            .map_err(HttpError::repo)?;
        let event = self
            .commit_event_payload(
                &mut repo,
                &mutation,
                Some(previous_state.latest_rev.clone()),
                blob_cids.clone(),
            )
            .await?;
        let state = self
            .persist_mutation(repo.storage(), &mutation)
            .map_err(HttpError::worker)?;
        self.persist_commit_event(repo.storage(), &state, &event)
            .map_err(HttpError::worker)?;
        if let Some(record_cid) = mutation.record_cid {
            repo.storage()
                .replace_blob_refs(&path, record_cid, &blob_cids)
                .map_err(HttpError::worker)?;
        }
        self.notify_directory(
            &request_host,
            &identity.handle,
            &identity,
            &state,
            true,
            None,
            Some(&event),
        )
        .await?;

        let body = xrpc_record_mutation_response(&state.did, &path, &mutation, validation_status)?;
        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn xrpc_put_record(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: XrpcPutRecordRequest = req.json().await.map_err(HttpError::worker)?;
        let request_host = request_host(req)?;
        let (previous_state, identity, signing_key, mut repo) =
            self.open_repo_for_write_with_state()?;
        ensure_repo_identifier(&previous_state, &identity, &body.repo)?;
        self.require_repo_write_auth(req, &previous_state.did)
            .await?;
        ensure_swap_commit(&previous_state, body.swap_commit.as_deref())?;

        let path = RepoPath::new(
            Nsid::new(body.collection).map_err(HttpError::bad_request)?,
            RecordKey::new(body.rkey).map_err(HttpError::bad_request)?,
        );
        let existing = repo
            .get_record::<Value>(&path)
            .await
            .map_err(HttpError::repo)?;
        let previous_blob_cids = repo
            .storage()
            .blob_cids_for_path(&path)
            .map_err(HttpError::worker)?;
        ensure_swap_record_field(
            existing.as_ref().map(|record| record.cid),
            &body.swap_record,
        )?;
        let validation_status = self
            .ensure_record_envelope_dynamic(&path.collection, &body.record, body.validate)
            .await?;
        let blob_cids = extract_record_blob_refs(&body.record)?;
        ensure_blob_refs_available(repo.storage(), &blob_cids)?;
        let rev = generated_repo_rev(&previous_state.latest_commit)?;
        let mutation = if existing.is_some() {
            repo.update_record(path.clone(), &body.record, rev, &signing_key)
                .await
        } else {
            repo.create_record(path.clone(), &body.record, rev, &signing_key)
                .await
        }
        .map_err(HttpError::repo)?;
        let event = self
            .commit_event_payload(
                &mut repo,
                &mutation,
                Some(previous_state.latest_rev.clone()),
                blob_cids.clone(),
            )
            .await?;
        let state = self
            .persist_mutation(repo.storage(), &mutation)
            .map_err(HttpError::worker)?;
        self.persist_commit_event(repo.storage(), &state, &event)
            .map_err(HttpError::worker)?;
        if let Some(record_cid) = mutation.record_cid {
            repo.storage()
                .replace_blob_refs(&path, record_cid, &blob_cids)
                .map_err(HttpError::worker)?;
        }
        self.delete_orphan_blobs(repo.storage(), &previous_blob_cids)
            .await?;
        self.notify_directory(
            &request_host,
            &identity.handle,
            &identity,
            &state,
            true,
            None,
            Some(&event),
        )
        .await?;

        let body = xrpc_record_mutation_response(&state.did, &path, &mutation, validation_status)?;
        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn xrpc_delete_record(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: XrpcDeleteRecordRequest = req.json().await.map_err(HttpError::worker)?;
        let request_host = request_host(req)?;
        let (previous_state, identity, signing_key, mut repo) =
            self.open_repo_for_write_with_state()?;
        ensure_repo_identifier(&previous_state, &identity, &body.repo)?;
        self.require_repo_write_auth(req, &previous_state.did)
            .await?;
        ensure_swap_commit(&previous_state, body.swap_commit.as_deref())?;

        let path = RepoPath::new(
            Nsid::new(body.collection).map_err(HttpError::bad_request)?,
            RecordKey::new(body.rkey).map_err(HttpError::bad_request)?,
        );
        let existing = repo
            .get_record::<Value>(&path)
            .await
            .map_err(HttpError::repo)?;
        let previous_blob_cids = repo
            .storage()
            .blob_cids_for_path(&path)
            .map_err(HttpError::worker)?;
        ensure_optional_swap_record(
            existing.as_ref().map(|record| record.cid),
            body.swap_record.as_deref(),
        )?;
        if existing.is_none() {
            return json_response(200, &xrpc_noop_delete_response(&previous_state))
                .map_err(HttpError::worker);
        }
        let rev = generated_repo_rev(&previous_state.latest_commit)?;
        let mutation = repo
            .delete_record(&path, rev, &signing_key)
            .await
            .map_err(HttpError::repo)?;
        let event = self
            .commit_event_payload(
                &mut repo,
                &mutation,
                Some(previous_state.latest_rev.clone()),
                Vec::new(),
            )
            .await?;
        let state = self
            .persist_mutation(repo.storage(), &mutation)
            .map_err(HttpError::worker)?;
        self.persist_commit_event(repo.storage(), &state, &event)
            .map_err(HttpError::worker)?;
        repo.storage()
            .delete_blob_refs(&path)
            .map_err(HttpError::worker)?;
        self.delete_orphan_blobs(repo.storage(), &previous_blob_cids)
            .await?;
        self.notify_directory(
            &request_host,
            &identity.handle,
            &identity,
            &state,
            true,
            None,
            Some(&event),
        )
        .await?;

        json_response(200, &xrpc_delete_mutation_response(&mutation)).map_err(HttpError::worker)
    }

    async fn xrpc_apply_writes(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: XrpcApplyWritesRequest = req.json().await.map_err(HttpError::worker)?;
        let request_host = request_host(req)?;
        let (previous_state, identity, signing_key, mut repo) =
            self.open_repo_for_write_with_state()?;
        ensure_repo_identifier(&previous_state, &identity, &body.repo)?;
        self.require_repo_write_auth(req, &previous_state.did)
            .await?;
        ensure_swap_commit(&previous_state, body.swap_commit.as_deref())?;
        if body.writes.is_empty() {
            return Err(HttpError::new(
                400,
                "applyWrites requires at least one write",
            ));
        }
        if body.writes.len() > MAX_APPLY_WRITES {
            return Err(HttpError::new(
                400,
                format!("applyWrites supports at most {MAX_APPLY_WRITES} writes"),
            ));
        }

        let mut writes = Vec::new();
        let mut blob_ref_updates = Vec::new();
        let mut event_blobs = BTreeSet::new();
        let mut orphan_blob_candidates = BTreeSet::new();
        let mut validation_statuses = BTreeMap::new();
        for (write_index, raw_write) in body.writes.into_iter().enumerate() {
            let kind = parse_apply_write_kind(&raw_write.write_type)?;
            let collection = Nsid::new(raw_write.collection).map_err(HttpError::bad_request)?;
            match kind {
                RepoOperationAction::Create => {
                    let record = raw_write.value.ok_or_else(|| {
                        HttpError::new(400, "applyWrites create requires `value`")
                    })?;
                    let rkey = if let Some(rkey) = raw_write.rkey {
                        RecordKey::new(rkey).map_err(HttpError::bad_request)?
                    } else {
                        generated_record_key_with_offset(
                            &previous_state.latest_commit,
                            write_index,
                        )?
                    };
                    let path = RepoPath::new(collection, rkey);
                    let validation_status = self
                        .ensure_record_envelope_dynamic(&path.collection, &record, body.validate)
                        .await?;
                    let blobs = extract_record_blob_refs(&record)?;
                    ensure_blob_refs_available(repo.storage(), &blobs)?;
                    event_blobs.extend(blobs.iter().copied());
                    blob_ref_updates.push((path.clone(), Some(blobs)));
                    validation_statuses.insert(path.clone(), validation_status);
                    writes.push(RepoWrite::Create { path, record });
                }
                RepoOperationAction::Update => {
                    let record = raw_write.value.ok_or_else(|| {
                        HttpError::new(400, "applyWrites update requires `value`")
                    })?;
                    let rkey = raw_write
                        .rkey
                        .ok_or_else(|| HttpError::new(400, "applyWrites update requires `rkey`"))?;
                    let path = RepoPath::new(
                        collection,
                        RecordKey::new(rkey).map_err(HttpError::bad_request)?,
                    );
                    orphan_blob_candidates.extend(
                        repo.storage()
                            .blob_cids_for_path(&path)
                            .map_err(HttpError::worker)?,
                    );
                    let validation_status = self
                        .ensure_record_envelope_dynamic(&path.collection, &record, body.validate)
                        .await?;
                    let blobs = extract_record_blob_refs(&record)?;
                    ensure_blob_refs_available(repo.storage(), &blobs)?;
                    event_blobs.extend(blobs.iter().copied());
                    blob_ref_updates.push((path.clone(), Some(blobs)));
                    validation_statuses.insert(path.clone(), validation_status);
                    writes.push(RepoWrite::Update { path, record });
                }
                RepoOperationAction::Delete => {
                    let rkey = raw_write
                        .rkey
                        .ok_or_else(|| HttpError::new(400, "applyWrites delete requires `rkey`"))?;
                    let path = RepoPath::new(
                        collection,
                        RecordKey::new(rkey).map_err(HttpError::bad_request)?,
                    );
                    orphan_blob_candidates.extend(
                        repo.storage()
                            .blob_cids_for_path(&path)
                            .map_err(HttpError::worker)?,
                    );
                    blob_ref_updates.push((path.clone(), None));
                    writes.push(RepoWrite::Delete { path });
                }
            }
        }

        let rev = generated_repo_rev(&previous_state.latest_commit)?;
        let mutation = repo
            .apply_writes(writes, rev, &signing_key)
            .await
            .map_err(HttpError::repo)?;
        let event = self
            .commit_event_payload(
                &mut repo,
                &mutation,
                Some(previous_state.latest_rev.clone()),
                event_blobs.into_iter().collect(),
            )
            .await?;
        let state = self
            .persist_mutation(repo.storage(), &mutation)
            .map_err(HttpError::worker)?;
        self.persist_commit_event(repo.storage(), &state, &event)
            .map_err(HttpError::worker)?;
        for (path, blobs) in blob_ref_updates {
            match blobs {
                Some(blobs) => {
                    if let Some(record_cid) = mutation
                        .ops
                        .iter()
                        .rev()
                        .find(|op| op.path == path)
                        .and_then(|op| op.cid)
                    {
                        repo.storage()
                            .replace_blob_refs(&path, record_cid, &blobs)
                            .map_err(HttpError::worker)?;
                    }
                }
                None => {
                    repo.storage()
                        .delete_blob_refs(&path)
                        .map_err(HttpError::worker)?;
                }
            }
        }
        let orphan_blob_candidates = orphan_blob_candidates.into_iter().collect::<Vec<_>>();
        self.delete_orphan_blobs(repo.storage(), &orphan_blob_candidates)
            .await?;
        self.notify_directory(
            &request_host,
            &identity.handle,
            &identity,
            &state,
            true,
            None,
            Some(&event),
        )
        .await?;

        let body = xrpc_apply_writes_response(&state.did, &mutation, &validation_statuses)?;
        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn xrpc_import_repo(&self, req: &mut Request) -> Result<Response, HttpError> {
        let request_host = request_host(req)?;
        let (previous_state, identity, existing_repo) = self.open_repo_with_identity()?;
        let account_status = self
            .require_repo_maintenance_auth(req, &previous_state.did)
            .await?;
        ensure_import_repo_content_type(req)?;
        let content_length = request_content_length(req)?
            .ok_or_else(|| HttpError::new(411, "importRepo requires a content-length header"))?;
        ensure_import_repo_size_limit(content_length)?;

        let previous_blob_cids = existing_repo
            .storage()
            .list_referenced_blob_cids()
            .map_err(HttpError::worker)?;
        let bytes = req.bytes().await.map_err(HttpError::worker)?;
        ensure_import_repo_size_limit(bytes.len() as u64)?;
        let decoded = decode_car(&bytes).map_err(|error| HttpError::new(400, error.to_string()))?;
        let imported = validate_imported_repo(decoded, &previous_state.did)
            .await
            .map_err(HttpError::import)?;
        let event = directory_sync_event_payload_from_blocks(imported.root, &imported.blocks)?;
        let state = RepoStateRow {
            did: previous_state.did.clone(),
            latest_commit: imported.root,
            latest_rev: imported.rev.clone(),
        };
        let record_paths = imported
            .records
            .iter()
            .map(|record| record.path.clone())
            .collect::<Vec<_>>();

        let mut store = self.store();
        store
            .clear_repo_data_for_import()
            .map_err(HttpError::worker)?;
        for block in &imported.blocks {
            store
                .put_block_with_cid(block.cid, block.bytes.clone())
                .map_err(HttpError::storage)?;
        }
        store.put_repo_state(&state).map_err(HttpError::worker)?;
        for record in &imported.records {
            store
                .put_record_pointer(record.path.clone(), record.cid)
                .map_err(HttpError::storage)?;
            store
                .replace_blob_refs(&record.path, record.cid, &record.blob_cids)
                .map_err(HttpError::worker)?;
        }
        self.delete_orphan_blobs(&store, &previous_blob_cids)
            .await?;
        self.persist_commit_event(&store, &state, &event)
            .map_err(HttpError::worker)?;
        let event = account_status.active.then_some(&event);
        self.notify_directory(
            &request_host,
            &identity.handle,
            &identity,
            &state,
            account_status.active,
            Some(&record_paths),
            event,
        )
        .await?;

        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_upload_blob(&self, req: &mut Request) -> Result<Response, HttpError> {
        let state = self.repo_state()?;
        self.require_repo_maintenance_auth(req, &state.did).await?;
        self.purge_expired_unreferenced_blobs(&self.store(), current_unix_time())
            .await?;
        let mime_type = req
            .headers()
            .get("content-type")
            .map_err(HttpError::worker)?
            .and_then(|value| value.split(';').next().map(|part| part.trim().to_string()))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let blob = self.put_blob_request_body(&mime_type, req).await?;

        json_response(
            200,
            &json!({
                "blob": {
                    "$type": "blob",
                    "ref": {"$link": blob.cid.to_string()},
                    "mimeType": blob.mime_type,
                    "size": blob.byte_len,
                },
            }),
        )
        .map_err(HttpError::worker)
    }

    fn open_repo_for_write_with_state(
        &self,
    ) -> Result<
        (
            RepoStateRow,
            RepoIdentityRow,
            RepoSigningKey,
            SignedRepository<SqlRepoStore>,
        ),
        HttpError,
    > {
        let (state, identity, repo) = self.open_repo_with_identity()?;
        let signing_key = identity.signing_key().map_err(HttpError::identity)?;
        Ok((state, identity, signing_key, repo))
    }

    fn open_repo_with_state(
        &self,
    ) -> Result<(RepoStateRow, SignedRepository<SqlRepoStore>), HttpError> {
        let store = self.store();
        let state = self.repo_state_from(&store)?;
        let repo = SignedRepository::open(store, state.latest_commit).map_err(HttpError::repo)?;
        Ok((state, repo))
    }

    fn open_repo_with_identity(
        &self,
    ) -> Result<
        (
            RepoStateRow,
            RepoIdentityRow,
            SignedRepository<SqlRepoStore>,
        ),
        HttpError,
    > {
        let store = self.store();
        let state = self.repo_state_from(&store)?;
        let identity = self.repo_identity_from(&store)?;
        let repo = SignedRepository::open(store, state.latest_commit).map_err(HttpError::repo)?;
        Ok((state, identity, repo))
    }

    fn repo_state(&self) -> Result<RepoStateRow, HttpError> {
        let store = self.store();
        self.repo_state_from(&store)
    }

    fn repo_identity(&self) -> Result<RepoIdentityRow, HttpError> {
        let store = self.store();
        self.repo_identity_from(&store)
    }

    fn repo_state_from(&self, store: &SqlRepoStore) -> Result<RepoStateRow, HttpError> {
        store
            .get_repo_state()
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(404, "repo not initialized"))
    }

    fn repo_identity_from(&self, store: &SqlRepoStore) -> Result<RepoIdentityRow, HttpError> {
        store
            .get_repo_identity()
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(404, "repo identity not initialized"))
    }

    fn did_document_response(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let state = self.repo_state()?;
        let identity = self.repo_identity()?;
        json_response(
            200,
            &did_document(
                state.did.as_str(),
                &identity.handle,
                &identity.public_key_multibase,
                &request_origin(url),
            ),
        )
        .map_err(HttpError::worker)
    }

    fn handle_did_response(&self) -> Result<Response, HttpError> {
        let state = self.repo_state()?;
        text_response(200, state.did.as_str()).map_err(HttpError::worker)
    }

    fn require_admin(&self, req: &Request) -> Result<(), HttpError> {
        require_admin_with_env(&self.env, req)
    }

    async fn require_repo_write_auth(&self, req: &Request, did: &Did) -> Result<(), HttpError> {
        self.require_repo_auth(req, did, false).await.map(|_| ())
    }

    async fn require_repo_maintenance_auth(
        &self,
        req: &Request,
        did: &Did,
    ) -> Result<InternalAccountStatusResponse, HttpError> {
        self.require_repo_auth(req, did, true).await
    }

    async fn require_repo_auth(
        &self,
        req: &Request,
        did: &Did,
        allow_deactivated: bool,
    ) -> Result<InternalAccountStatusResponse, HttpError> {
        let admin_authorized = is_admin_authorized(&self.env, req)?;
        if !admin_authorized {
            let presented = authorization_token(req)?;
            let claims = verify_token(
                &token_secret_from_env(&self.env)?,
                &presented.token,
                ACCESS_SCOPE,
                current_unix_time(),
            )
            .map_err(HttpError::auth)?;
            if let Some(jkt) = claims.dpop_jkt.as_deref() {
                if presented.scheme != AuthScheme::Dpop {
                    return Err(HttpError::new(
                        401,
                        "DPoP-bound token requires DPoP authorization",
                    ));
                }
                verify_request_dpop(
                    req,
                    Some(jkt),
                    claims.dpop_nonce.as_deref(),
                    Some(&presented.token),
                )
                .map_err(|error| HttpError::new(401, error.to_string()))?;
            }
            if claims.sub != did.as_str() {
                return Err(HttpError::new(403, "token does not match repo DID"));
            }
        }

        let request_host = request_host(req)?;
        let account_status = self.directory_account_status(&request_host, did).await?;
        if account_status.active
            || (allow_deactivated && account_status.status.as_deref() == Some("deactivated"))
            || admin_authorized
        {
            Ok(account_status)
        } else {
            Err(HttpError::new(403, "AccountTakedown"))
        }
    }

    async fn directory_account_status(
        &self,
        request_host: &str,
        did: &Did,
    ) -> Result<InternalAccountStatusResponse, HttpError> {
        let path = internal_directory_account_status_path(did.as_str());
        let mut response =
            fetch_internal_directory_request(&self.env, request_host, Method::Get, &path, None)
                .await?;
        let status = response.status_code();
        if status == 404 {
            return Err(HttpError::new(403, "AccountTakedown"));
        }
        if !(200..300).contains(&status) {
            let message = response
                .text()
                .await
                .unwrap_or_else(|_| "failed to read directory response".to_string());
            return Err(HttpError::new(
                500,
                format!("account status lookup failed with status {status}: {message}"),
            ));
        }
        let account_status = response
            .json::<InternalAccountStatusResponse>()
            .await
            .map_err(HttpError::worker)?;
        Ok(account_status)
    }

    async fn notify_directory(
        &self,
        request_host: &str,
        repo_name: &str,
        identity: &RepoIdentityRow,
        state: &RepoStateRow,
        active: bool,
        records: Option<&[RepoPath]>,
        event: Option<&DirectoryCommitEventPayload>,
    ) -> Result<(), HttpError> {
        let mut body = json!({
            "did": state.did.to_string(),
            "handle": identity.handle.clone(),
            "repoName": repo_name,
            "head": state.latest_commit.to_string(),
            "rev": state.latest_rev.to_string(),
            "active": active,
        });
        if let Some(records) = records {
            body["records"] = json!(records
                .iter()
                .map(|path| path.to_string())
                .collect::<Vec<_>>());
        }
        if let Some(event) = event {
            body["event"] = json!({
                "eventType": event.event_type,
                "since": event.since.as_ref().map(|rev| rev.to_string()),
                "prevData": event.prev_data.map(|cid| cid.to_string()),
                "blocksBase64": BASE64_STANDARD.encode(&event.blocks),
                "ops": event.ops,
                "blobs": event.blobs,
            });
        }
        let path = internal_directory_repo_upsert_path();
        let mut response =
            fetch_internal_directory_json(&self.env, request_host, Method::Post, &path, &body)
                .await?;
        let status = response.status_code();
        if !(200..300).contains(&status) {
            let message = response
                .text()
                .await
                .unwrap_or_else(|_| "failed to read directory response".to_string());
            return Err(HttpError::new(
                500,
                format!("directory update failed with status {status}: {message}"),
            ));
        }
        Ok(())
    }

    async fn commit_event_payload(
        &self,
        repo: &mut SignedRepository<SqlRepoStore>,
        mutation: &RepoMutation,
        since: Option<RepoRev>,
        blobs: Vec<crate::cid::Cid>,
    ) -> Result<DirectoryCommitEventPayload, HttpError> {
        let cids = mutation_diff_cids(repo, mutation).await?;
        let prev_data = previous_data_root(repo.storage(), mutation.commit.prev)?;
        self.repo_commit_event_payload_from_cids(
            repo,
            DirectoryCommitEventType::Commit,
            mutation.commit_cid,
            since,
            prev_data,
            directory_commit_ops(&mutation.ops),
            blobs,
            cids,
        )
        .await
    }

    async fn repo_commit_event_payload(
        &self,
        repo: &mut SignedRepository<SqlRepoStore>,
        commit_cid: crate::cid::Cid,
        since: Option<RepoRev>,
        ops: Vec<DirectoryCommitOp>,
    ) -> Result<DirectoryCommitEventPayload, HttpError> {
        let cids = repo.export_cids().await.map_err(HttpError::repo)?;
        self.repo_commit_event_payload_from_cids(
            repo,
            DirectoryCommitEventType::Commit,
            commit_cid,
            since,
            None,
            ops,
            Vec::new(),
            cids,
        )
        .await
    }

    async fn repo_commit_event_payload_from_cids(
        &self,
        repo: &mut SignedRepository<SqlRepoStore>,
        event_type: DirectoryCommitEventType,
        commit_cid: crate::cid::Cid,
        since: Option<RepoRev>,
        prev_data: Option<crate::cid::Cid>,
        ops: Vec<DirectoryCommitOp>,
        blobs: Vec<crate::cid::Cid>,
        cids: Vec<crate::cid::Cid>,
    ) -> Result<DirectoryCommitEventPayload, HttpError> {
        let blocks =
            encode_car_from_store(&[commit_cid], cids, repo.storage()).map_err(HttpError::car)?;
        if event_type == DirectoryCommitEventType::Commit
            && firehose_commit_frame_exceeds_limits(blocks.len(), ops.len())
        {
            return directory_sync_event_payload_from_store(commit_cid, repo.storage());
        }
        Ok(DirectoryCommitEventPayload {
            event_type,
            since,
            prev_data,
            blocks,
            ops,
            blobs: blobs.into_iter().map(|cid| cid.to_string()).collect(),
        })
    }

    fn persist_commit_event(
        &self,
        store: &SqlRepoStore,
        state: &RepoStateRow,
        event: &DirectoryCommitEventPayload,
    ) -> worker::Result<()> {
        store.append_commit_event(&RepoCommitEventInput {
            rev: state.latest_rev.clone(),
            since: event.since.clone(),
            prev_data: event.prev_data,
            commit_cid: state.latest_commit,
            blocks: event.blocks.clone(),
            ops_json: to_string(&event.ops)?,
            blobs_json: to_string(&event.blobs)?,
        })
    }

    async fn blob_response_for_row(&self, blob: RepoBlobRow) -> Result<Response, HttpError> {
        if blob.storage_kind == "r2" {
            let key = blob
                .storage_key
                .clone()
                .unwrap_or_else(|| blob_storage_key(&blob.cid));
            let bucket = self.env.bucket(BLOB_BUCKET_BINDING).map_err(|_| {
                HttpError::new(500, "BLOB_BUCKET binding is required to read this blob")
            })?;
            let Some(object) = bucket.get(key).execute().await.map_err(HttpError::worker)? else {
                return Err(HttpError::new(404, "blob not found"));
            };
            let Some(body) = object.body() else {
                return Err(HttpError::new(
                    500,
                    "R2 blob object returned without a body",
                ));
            };
            let response_body = body.response_body().map_err(HttpError::worker)?;
            blob_stream_response(response_body, &blob.mime_type, blob.byte_len)
                .map_err(HttpError::worker)
        } else {
            blob_response(blob.bytes, &blob.mime_type).map_err(HttpError::worker)
        }
    }

    async fn put_blob_request_body(
        &self,
        mime_type: &str,
        req: &mut Request,
    ) -> Result<RepoBlobRow, HttpError> {
        let content_length = request_content_length(req)?;
        if let Some(content_length) = content_length {
            ensure_blob_size_limit(content_length)?;
        }

        if let (Ok(bucket), Some(content_length)) =
            (self.env.bucket(BLOB_BUCKET_BINDING), content_length)
        {
            let key = temporary_blob_storage_key();
            let hasher = Rc::new(RefCell::new(Sha256::new()));
            let byte_len = Rc::new(Cell::new(0_u64));
            let stream_hasher = Rc::clone(&hasher);
            let stream_byte_len = Rc::clone(&byte_len);
            let metered_stream = req.stream().map_err(HttpError::worker)?.map(
                move |chunk| -> worker::Result<Vec<u8>> {
                    let chunk = chunk?;
                    let next_len = stream_byte_len
                        .get()
                        .saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
                    if next_len > MAX_BLOB_BYTES as u64 {
                        return Err(worker::Error::RustError(format!(
                            "blob too large: max {MAX_BLOB_BYTES} bytes"
                        )));
                    }
                    stream_byte_len.set(next_len);
                    stream_hasher.borrow_mut().update(&chunk);
                    Ok(chunk)
                },
            );

            bucket
                .put(
                    key.clone(),
                    FixedLengthStream::wrap(metered_stream, content_length),
                )
                .http_metadata(blob_http_metadata(mime_type))
                .execute()
                .await
                .map_err(HttpError::worker)?;

            let digest = hasher.borrow().clone().finalize();
            let cid = raw_cid_from_sha256_digest(&digest);
            let byte_len = byte_len.get();
            if byte_len != content_length {
                let _ = bucket.delete(key).await;
                return Err(HttpError::new(
                    400,
                    "blob upload byte count did not match content-length",
                ));
            }
            if let Some(existing) = self.store().get_blob(&cid).map_err(HttpError::worker)? {
                let _ = bucket.delete(key).await;
                return Ok(existing);
            }
            if let Err(error) = self.ensure_blob_quota(&cid, byte_len as i64) {
                let _ = bucket.delete(key).await;
                return Err(error);
            }
            return self
                .store()
                .put_blob_metadata(
                    cid,
                    mime_type,
                    usize::try_from(byte_len).unwrap_or(MAX_BLOB_BYTES),
                    "r2",
                    Some(&key),
                )
                .map_err(HttpError::worker);
        }

        let bytes = req.bytes().await.map_err(HttpError::worker)?;
        ensure_blob_size_limit(bytes.len() as u64)?;
        if content_length.is_some_and(|expected| expected != bytes.len() as u64) {
            return Err(HttpError::new(
                400,
                "blob upload byte count did not match content-length",
            ));
        }
        self.put_blob_bytes(mime_type, bytes).await
    }

    async fn put_blob_bytes(
        &self,
        mime_type: &str,
        bytes: Vec<u8>,
    ) -> Result<RepoBlobRow, HttpError> {
        let cid = raw_cid(&bytes);
        let byte_len = bytes.len();
        self.ensure_blob_quota(&cid, byte_len as i64)?;
        if let Ok(bucket) = self.env.bucket(BLOB_BUCKET_BINDING) {
            let key = blob_storage_key(&cid);
            bucket
                .put(key.clone(), bytes)
                .http_metadata(blob_http_metadata(mime_type))
                .execute()
                .await
                .map_err(HttpError::worker)?;
            self.store()
                .put_blob_metadata(cid, mime_type, byte_len, "r2", Some(&key))
                .map_err(HttpError::worker)
        } else {
            self.store()
                .put_blob_bytes(mime_type, bytes)
                .map_err(HttpError::worker)
        }
    }

    async fn delete_orphan_blobs(
        &self,
        store: &SqlRepoStore,
        cids: &[crate::cid::Cid],
    ) -> Result<(), HttpError> {
        let mut seen = BTreeSet::new();
        for cid in cids {
            if !seen.insert(*cid) || store.blob_ref_count(cid).map_err(HttpError::worker)? > 0 {
                continue;
            }
            let Some(blob) = store.get_blob(cid).map_err(HttpError::worker)? else {
                continue;
            };
            if blob.storage_kind == "r2" {
                if let Ok(bucket) = self.env.bucket(BLOB_BUCKET_BINDING) {
                    let key = blob.storage_key.unwrap_or_else(|| blob_storage_key(cid));
                    let _ = bucket.delete(key).await;
                }
            }
            store
                .delete_unreferenced_blob_metadata(cid)
                .map_err(HttpError::worker)?;
        }
        Ok(())
    }

    fn ensure_blob_quota(&self, cid: &crate::cid::Cid, byte_len: i64) -> Result<(), HttpError> {
        let max_bytes = max_account_blob_bytes_from_env(&self.env)?;
        let store = self.store();
        if store.get_blob(cid).map_err(HttpError::worker)?.is_some() {
            return Ok(());
        }
        let total = store.total_blob_bytes().map_err(HttpError::worker)?;
        if total.saturating_add(byte_len) > max_bytes {
            return Err(HttpError::new(
                400,
                format!("BlobQuotaExceeded: account blob quota is {max_bytes} bytes"),
            ));
        }
        Ok(())
    }

    async fn purge_expired_unreferenced_blobs(
        &self,
        store: &SqlRepoStore,
        now: i64,
    ) -> Result<(), HttpError> {
        let cutoff = now.saturating_sub(TEMP_BLOB_TTL_SECONDS);
        let rows = store
            .list_unreferenced_blobs_older_than(cutoff, BLOB_GC_BATCH_LIMIT)
            .map_err(HttpError::worker)?;
        for blob in rows {
            if blob.storage_kind == "r2" {
                if let Ok(bucket) = self.env.bucket(BLOB_BUCKET_BINDING) {
                    let key = blob
                        .storage_key
                        .unwrap_or_else(|| blob_storage_key(&blob.cid));
                    let _ = bucket.delete(key).await;
                }
            }
            store
                .delete_unreferenced_blob_metadata(&blob.cid)
                .map_err(HttpError::worker)?;
        }
        Ok(())
    }

    async fn repo_diff_car_since(
        &self,
        state: &RepoStateRow,
        since: &str,
    ) -> Result<Vec<u8>, HttpError> {
        let since = RepoRev::new(since.to_string()).map_err(HttpError::bad_request)?;
        if since == state.latest_rev {
            return encode_car(&[state.latest_commit], Vec::<CarBlock>::new())
                .map_err(HttpError::car);
        }
        let store = self.store();
        if !store
            .has_commit_event_rev(&since)
            .map_err(HttpError::worker)?
        {
            return Err(HttpError::new(
                400,
                format!("unknown since revision `{since}`"),
            ));
        }
        let events = store
            .list_commit_events_after_rev(&since)
            .map_err(HttpError::worker)?;
        if events.is_empty() {
            return encode_car(&[state.latest_commit], Vec::<CarBlock>::new())
                .map_err(HttpError::car);
        }
        if events.iter().any(|event| event.since.is_none()) {
            let mut repo = SignedRepository::open(self.store(), state.latest_commit)
                .map_err(HttpError::repo)?;
            let cids = repo.export_cids().await.map_err(HttpError::repo)?;
            return encode_car_from_store(&[state.latest_commit], cids, repo.storage())
                .map_err(HttpError::car);
        }

        let mut seen = BTreeSet::new();
        let mut blocks = Vec::new();
        for event in events {
            let decoded = decode_car(&event.blocks).map_err(HttpError::car)?;
            for block in decoded.blocks {
                if seen.insert(block.cid) {
                    blocks.push(block);
                }
            }
        }

        encode_car(&[state.latest_commit], blocks).map_err(HttpError::car)
    }

    fn persist_mutation(
        &self,
        store: &SqlRepoStore,
        mutation: &RepoMutation,
    ) -> worker::Result<RepoStateRow> {
        let state = RepoStateRow {
            did: mutation.commit.did.clone(),
            latest_commit: mutation.commit_cid,
            latest_rev: mutation.commit.rev.clone(),
        };
        store.put_repo_state(&state)?;
        Ok(state)
    }
}
