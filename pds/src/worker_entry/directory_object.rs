use super::*;
use worker::durable_object;

#[durable_object]
pub struct PdsDirectoryObject {
    sql: SqlStorage,
    #[allow(dead_code)]
    state: State,
    #[allow(dead_code)]
    env: Env,
}

impl DurableObject for PdsDirectoryObject {
    fn new(state: State, env: Env) -> Self {
        let sql = state.storage().sql();
        SqlDirectoryStore::new(sql.clone())
            .init_schema()
            .expect("initialize PDS directory durable object schema");
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

    async fn websocket_message(
        &self,
        _ws: WebSocket,
        _message: WebSocketIncomingMessage,
    ) -> worker::Result<()> {
        Ok(())
    }

    async fn websocket_close(
        &self,
        _ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> worker::Result<()> {
        Ok(())
    }

    async fn websocket_error(&self, _ws: WebSocket, _error: worker::Error) -> worker::Result<()> {
        Ok(())
    }
}

impl PdsDirectoryObject {
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

        if req.method() == Method::Get
            && parts.len() >= 2
            && parts[0] == "xrpc"
            && parts[1] == SYNC_LIST_HOSTS
        {
            return self.xrpc_list_hosts(req, &url);
        }
        if req.method() == Method::Get
            && parts.len() >= 2
            && parts[0] == "xrpc"
            && parts[1] == SYNC_LIST_REPOS
        {
            return self.xrpc_list_repos(&url);
        }
        if req.method() == Method::Get
            && parts.len() >= 2
            && parts[0] == "xrpc"
            && parts[1] == SYNC_LIST_REPOS_BY_COLLECTION
        {
            return self.xrpc_list_repos_by_collection(&url);
        }
        if req.method() == Method::Get
            && parts.len() >= 2
            && parts[0] == "xrpc"
            && parts[1] == SYNC_GET_HOST_STATUS
        {
            return self.xrpc_get_host_status(req, &url);
        }
        if req.method() == Method::Get
            && parts.len() >= 2
            && parts[0] == "xrpc"
            && parts[1] == SYNC_SUBSCRIBE_REPOS
        {
            return self.xrpc_subscribe_repos(req, &url);
        }
        if parts.len() >= 2 && parts[0] == "oauth" {
            return match (req.method(), url.path()) {
                (Method::Get, OAUTH_AUTHORIZE_PATH) => self.oauth_authorize(req, &url),
                (Method::Post, OAUTH_AUTHORIZE_PATH) => {
                    self.oauth_authorize_submit(req, &url).await
                }
                (Method::Post, OAUTH_PAR_PATH) => {
                    self.oauth_pushed_authorization_request(req).await
                }
                (Method::Post, OAUTH_TOKEN_PATH) => self.oauth_token(req).await,
                (_, OAUTH_AUTHORIZE_PATH | OAUTH_PAR_PATH | OAUTH_TOKEN_PATH) => {
                    Err(HttpError::new(405, "method not allowed"))
                }
                _ => Err(HttpError::new(404, "unsupported OAuth endpoint")),
            };
        }
        if parts.len() >= 2 && parts[0] == "xrpc" {
            return match (req.method(), parts[1]) {
                (Method::Post, SERVER_CREATE_ACCOUNT) => self.xrpc_create_account(req, &url).await,
                (Method::Post, SERVER_CREATE_SESSION) => self.xrpc_create_session(req, &url).await,
                (Method::Get, SERVER_GET_SESSION) => self.xrpc_get_session(req, &url),
                (Method::Post, SERVER_REFRESH_SESSION) => {
                    self.xrpc_refresh_session(req, &url).await
                }
                (Method::Post, SERVER_DELETE_SESSION) => self.xrpc_delete_session(req),
                (Method::Post, SERVER_CHANGE_PASSWORD) => self.xrpc_change_password(req).await,
                (Method::Post, SERVER_REQUEST_PASSWORD_RESET) => {
                    self.xrpc_request_password_reset(req).await
                }
                (Method::Post, SERVER_RESET_PASSWORD) => self.xrpc_reset_password(req).await,
                (Method::Post, SERVER_REQUEST_EMAIL_CONFIRMATION) => {
                    self.xrpc_request_email_confirmation(req).await
                }
                (Method::Post, SERVER_CONFIRM_EMAIL) => self.xrpc_confirm_email(req).await,
                (Method::Post, SERVER_REQUEST_EMAIL_UPDATE) => {
                    self.xrpc_request_email_update(req).await
                }
                (Method::Post, SERVER_UPDATE_EMAIL) => self.xrpc_update_email(req, &url).await,
                (Method::Post, SERVER_REQUEST_ACCOUNT_DELETE) => {
                    self.xrpc_request_account_delete(req).await
                }
                (Method::Post, SERVER_DELETE_ACCOUNT) => self.xrpc_delete_account(req).await,
                (Method::Post, SERVER_DEACTIVATE_ACCOUNT) => {
                    self.xrpc_deactivate_account(req).await
                }
                (Method::Post, SERVER_ACTIVATE_ACCOUNT) => {
                    self.xrpc_activate_account(req, &url).await
                }
                (Method::Get, SERVER_CHECK_ACCOUNT_STATUS) => {
                    self.xrpc_check_account_status(req, &url).await
                }
                (Method::Get, SERVER_GET_SERVICE_AUTH) => {
                    self.xrpc_get_service_auth(req, &url).await
                }
                (Method::Post, SERVER_RESERVE_SIGNING_KEY) => {
                    self.xrpc_reserve_signing_key(req).await
                }
                (Method::Post, SERVER_CREATE_INVITE_CODE) => {
                    self.xrpc_create_invite_code(req).await
                }
                (Method::Post, SERVER_CREATE_INVITE_CODES) => {
                    self.xrpc_create_invite_codes(req).await
                }
                (Method::Get, SERVER_GET_ACCOUNT_INVITE_CODES) => {
                    self.xrpc_get_account_invite_codes(req, &url)
                }
                (Method::Post, SERVER_CREATE_APP_PASSWORD) => {
                    self.xrpc_create_app_password(req).await
                }
                (Method::Get, SERVER_LIST_APP_PASSWORDS) => self.xrpc_list_app_passwords(req),
                (Method::Post, SERVER_REVOKE_APP_PASSWORD) => {
                    self.xrpc_revoke_app_password(req).await
                }
                (Method::Get, IDENTITY_RESOLVE_HANDLE) => self.xrpc_resolve_handle(&url),
                (Method::Get, IDENTITY_RESOLVE_IDENTITY) => self.xrpc_resolve_identity(&url),
                (Method::Post, IDENTITY_UPDATE_HANDLE) => self.xrpc_update_handle(req, &url).await,
                (Method::Post, IDENTITY_REFRESH_IDENTITY) => {
                    self.xrpc_refresh_identity(req, &url).await
                }
                (Method::Get, IDENTITY_GET_RECOMMENDED_DID_CREDENTIALS) => {
                    self.xrpc_get_recommended_did_credentials(req, &url)
                }
                (Method::Get, LEXICON_RESOLVE_LEXICON) => self.xrpc_resolve_lexicon(&url).await,
                (Method::Post, IDENTITY_REQUEST_PLC_OPERATION_SIGNATURE) => {
                    self.xrpc_request_plc_operation_signature(req).await
                }
                (Method::Post, IDENTITY_SIGN_PLC_OPERATION) => {
                    self.xrpc_sign_plc_operation(req).await
                }
                (Method::Post, IDENTITY_SUBMIT_PLC_OPERATION) => {
                    self.xrpc_submit_plc_operation(req, &url).await
                }
                (Method::Post, ADMIN_DELETE_ACCOUNT) => self.xrpc_admin_delete_account(req).await,
                (Method::Post, ADMIN_DISABLE_ACCOUNT_INVITES) => {
                    self.xrpc_admin_disable_account_invites(req).await
                }
                (Method::Post, ADMIN_DISABLE_INVITE_CODES) => {
                    self.xrpc_admin_disable_invite_codes(req).await
                }
                (Method::Post, ADMIN_ENABLE_ACCOUNT_INVITES) => {
                    self.xrpc_admin_enable_account_invites(req).await
                }
                (Method::Get, ADMIN_GET_ACCOUNT_INFO) => {
                    self.xrpc_admin_get_account_info(req, &url)
                }
                (Method::Get, ADMIN_GET_ACCOUNT_INFOS) => {
                    self.xrpc_admin_get_account_infos(req, &url)
                }
                (Method::Get, ADMIN_GET_INVITE_CODES) => {
                    self.xrpc_admin_get_invite_codes(req, &url)
                }
                (Method::Get, ADMIN_GET_SUBJECT_STATUS) => {
                    self.xrpc_admin_get_subject_status(req, &url)
                }
                (Method::Get, ADMIN_SEARCH_ACCOUNTS) => self.xrpc_admin_search_accounts(req, &url),
                (Method::Post, ADMIN_SEND_EMAIL) => self.xrpc_admin_send_email(req).await,
                (Method::Post, ADMIN_UPDATE_ACCOUNT_EMAIL) => {
                    self.xrpc_admin_update_account_email(req).await
                }
                (Method::Post, ADMIN_UPDATE_ACCOUNT_HANDLE) => {
                    self.xrpc_admin_update_account_handle(req, &url).await
                }
                (Method::Post, ADMIN_UPDATE_ACCOUNT_PASSWORD) => {
                    self.xrpc_admin_update_account_password(req).await
                }
                (Method::Post, ADMIN_UPDATE_ACCOUNT_SIGNING_KEY) => {
                    self.xrpc_admin_update_account_signing_key(req, &url).await
                }
                (Method::Post, ADMIN_UPDATE_SUBJECT_STATUS) => {
                    self.xrpc_admin_update_subject_status(req).await
                }
                (
                    _,
                    SERVER_CREATE_ACCOUNT
                    | SERVER_CREATE_SESSION
                    | SERVER_GET_SESSION
                    | SERVER_REFRESH_SESSION
                    | SERVER_DELETE_SESSION
                    | SERVER_CHANGE_PASSWORD
                    | SERVER_REQUEST_PASSWORD_RESET
                    | SERVER_RESET_PASSWORD
                    | SERVER_REQUEST_EMAIL_CONFIRMATION
                    | SERVER_CONFIRM_EMAIL
                    | SERVER_REQUEST_EMAIL_UPDATE
                    | SERVER_UPDATE_EMAIL
                    | SERVER_REQUEST_ACCOUNT_DELETE
                    | SERVER_DELETE_ACCOUNT
                    | SERVER_DEACTIVATE_ACCOUNT
                    | SERVER_ACTIVATE_ACCOUNT
                    | SERVER_CHECK_ACCOUNT_STATUS
                    | SERVER_GET_SERVICE_AUTH
                    | SERVER_RESERVE_SIGNING_KEY
                    | SERVER_CREATE_INVITE_CODE
                    | SERVER_CREATE_INVITE_CODES
                    | SERVER_GET_ACCOUNT_INVITE_CODES
                    | SERVER_CREATE_APP_PASSWORD
                    | SERVER_LIST_APP_PASSWORDS
                    | SERVER_REVOKE_APP_PASSWORD
                    | IDENTITY_RESOLVE_HANDLE
                    | IDENTITY_RESOLVE_IDENTITY
                    | IDENTITY_UPDATE_HANDLE
                    | IDENTITY_REFRESH_IDENTITY
                    | IDENTITY_GET_RECOMMENDED_DID_CREDENTIALS
                    | IDENTITY_REQUEST_PLC_OPERATION_SIGNATURE
                    | IDENTITY_SIGN_PLC_OPERATION
                    | IDENTITY_SUBMIT_PLC_OPERATION
                    | LEXICON_RESOLVE_LEXICON
                    | SYNC_LIST_HOSTS
                    | ADMIN_DELETE_ACCOUNT
                    | ADMIN_DISABLE_ACCOUNT_INVITES
                    | ADMIN_DISABLE_INVITE_CODES
                    | ADMIN_ENABLE_ACCOUNT_INVITES
                    | ADMIN_GET_ACCOUNT_INFO
                    | ADMIN_GET_ACCOUNT_INFOS
                    | ADMIN_GET_INVITE_CODES
                    | ADMIN_GET_SUBJECT_STATUS
                    | ADMIN_SEARCH_ACCOUNTS
                    | ADMIN_SEND_EMAIL
                    | ADMIN_UPDATE_ACCOUNT_EMAIL
                    | ADMIN_UPDATE_ACCOUNT_HANDLE
                    | ADMIN_UPDATE_ACCOUNT_PASSWORD
                    | ADMIN_UPDATE_ACCOUNT_SIGNING_KEY
                    | ADMIN_UPDATE_SUBJECT_STATUS
                    | SYNC_LIST_REPOS
                    | SYNC_LIST_REPOS_BY_COLLECTION
                    | SYNC_GET_HOST_STATUS
                    | SYNC_SUBSCRIBE_REPOS,
                ) => Err(HttpError::new(405, "method not allowed")),
                _ => Err(HttpError::new(404, "unsupported XRPC method")),
            };
        }

        let parts = url
            .path()
            .trim_start_matches('/')
            .split('/')
            .collect::<Vec<_>>();
        if let Some(action) = internal_directory_control_action(&parts) {
            return match (req.method(), action) {
                (Method::Get, InternalDirectoryControlAction::Status) => self.internal_status(),
                (Method::Get, InternalDirectoryControlAction::AccountStatus) => {
                    self.internal_account_status(&url)
                }
                (Method::Post, InternalDirectoryControlAction::RepoUpsert) => {
                    self.internal_upsert_repo(req).await
                }
                _ => Err(HttpError::new(404, "not found")),
            };
        }

        Err(HttpError::new(404, "not found"))
    }

    fn store(&self) -> SqlDirectoryStore {
        SqlDirectoryStore::new(self.sql.clone())
    }

    fn internal_status(&self) -> Result<Response, HttpError> {
        let store = self.store();
        json_response(
            200,
            &json!({
                "repos": store.repo_count().map_err(HttpError::worker)?,
                "accounts": store.account_count().map_err(HttpError::worker)?,
                "events": store.event_count().map_err(HttpError::worker)?,
            }),
        )
        .map_err(HttpError::worker)
    }

    fn internal_account_status(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let did = Did::new(required_param(&params, "did").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let Some(account) = self
            .store()
            .get_account_by_did(&did)
            .map_err(HttpError::worker)?
        else {
            return Err(HttpError::new(404, "account not found"));
        };
        json_response(
            200,
            &json!({
                "did": account.did.to_string(),
                "handle": account.handle,
                "active": account.active,
                "status": account.status,
            }),
        )
        .map_err(HttpError::worker)
    }

    fn xrpc_resolve_identity(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let identifier = required_param(&params, "identifier").map_err(HttpError::xrpc)?;
        let Some(account) = self
            .store()
            .get_account_by_identifier(&identifier)
            .map_err(HttpError::worker)?
        else {
            let error = if identifier.starts_with("did:") {
                "DidNotFound"
            } else {
                "HandleNotFound"
            };
            return Err(HttpError::new(404, error));
        };
        if !account.active {
            return Err(HttpError::new(404, "DidDeactivated"));
        }

        json_response(
            200,
            &identity_info_response_body(&request_origin(url), &account),
        )
        .map_err(HttpError::worker)
    }

    fn xrpc_resolve_handle(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let handle = required_param(&params, "handle")
            .map_err(HttpError::xrpc)?
            .to_ascii_lowercase();
        let Some(account) = self
            .store()
            .get_account_by_identifier(&handle)
            .map_err(HttpError::worker)?
        else {
            return Err(HttpError::new(404, "HandleNotFound"));
        };
        if account.handle != handle || !account.active {
            return Err(HttpError::new(404, "HandleNotFound"));
        }
        json_response(
            200,
            &json!({
                "did": account.did.to_string(),
            }),
        )
        .map_err(HttpError::worker)
    }

    fn set_account_active(
        &self,
        did: &Did,
        active: bool,
        status: Option<&str>,
    ) -> Result<(), HttpError> {
        let store = self.store();
        store
            .set_account_active(did, active, status)
            .map_err(HttpError::worker)?;
        store
            .set_repo_active(did, active)
            .map_err(HttpError::worker)?;
        let event = store
            .append_account_event(did, active, status)
            .map_err(HttpError::worker)?;
        self.broadcast_repo_event(&event)
    }

    async fn xrpc_create_account(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let admin_authorized = is_admin_authorized(&self.env, req)?;
        let mut body: XrpcCreateAccountRequest = req.json().await.map_err(HttpError::worker)?;
        body.handle = body.handle.to_ascii_lowercase();
        body.email = normalize_account_email(body.email);
        body.invite_code = body
            .invite_code
            .map(|code| code.trim().to_string())
            .filter(|code| !code.is_empty());
        body.recovery_key = body
            .recovery_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
        let request_host = request_host(req)?;
        let request_origin = request_origin(url);
        let importing_existing_identity = body
            .did
            .as_deref()
            .is_some_and(is_supported_account_import_did);
        if body.plc_op.is_some()
            && !body
                .did
                .as_deref()
                .is_some_and(|did| did.starts_with("did:plc:"))
        {
            return Err(HttpError::new(
                400,
                "InvalidDid: `plcOp` requires an existing did:plc account",
            ));
        }
        if importing_existing_identity {
            let did = body.did.as_deref().unwrap_or_default();
            let service_did = self.host_account_did(req)?;
            verify_create_account_service_auth(
                req,
                did,
                service_did.as_str(),
                SERVER_CREATE_ACCOUNT,
                current_unix_time(),
                &self.env,
            )
            .await?;
        }
        let password = body
            .password
            .as_deref()
            .ok_or_else(|| HttpError::new(400, "InvalidPassword: password is required"))?;
        ensure_password_strength(password)?;
        let store = self.store();
        if store
            .get_account_by_identifier(&body.handle)
            .map_err(HttpError::worker)?
            .is_some()
        {
            return Err(HttpError::new(400, "HandleNotAvailable"));
        }
        if !admin_authorized && body.invite_code.is_none() {
            return Err(HttpError::new(400, "InvalidInviteCode"));
        }
        if let Some(invite_code) = body.invite_code.as_deref() {
            self.ensure_invite_code_usable(&store, invite_code)?;
        }
        if importing_existing_identity {
            let did = Did::new(body.did.as_deref().unwrap_or_default().to_string())
                .map_err(HttpError::bad_request)?;
            if store
                .get_account_by_did(&did)
                .map_err(HttpError::worker)?
                .is_some()
            {
                return Err(HttpError::new(400, "DidNotAvailable"));
            }
        }

        let reserved_signing_key = if importing_existing_identity {
            match (body.did.as_deref(), body.plc_op.as_ref()) {
                (Some(did), Some(operation)) => {
                    let did = Did::new(did.to_string()).map_err(HttpError::bad_request)?;
                    let signing_key = plc_operation_atproto_signing_key(operation)?;
                    Some(self.lookup_reserved_signing_key(&did, &signing_key)?)
                }
                _ => None,
            }
        } else {
            None
        };
        let (signing_key_hex, public_key_multibase) =
            if let Some(reserved) = reserved_signing_key.as_ref() {
                (
                    reserved.signing_key_p256_hex.clone(),
                    reserved.public_key_multibase.clone(),
                )
            } else {
                let signing_key_hex = generate_repo_signing_key_hex()?;
                let signing_key =
                    RepoSigningKey::from_p256_hex(&signing_key_hex).map_err(HttpError::identity)?;
                let public_key_multibase = signing_key
                    .public_key_multibase()
                    .map_err(HttpError::identity)?;
                (signing_key_hex, public_key_multibase)
            };
        RepoSigningKey::from_p256_hex(&signing_key_hex).map_err(HttpError::identity)?;
        let signing_did_key = did_key_from_public_key_multibase(&public_key_multibase)?;
        let identity = if importing_existing_identity {
            account_identity_for_import(
                &self.env,
                &body.handle,
                body.did.as_deref().unwrap_or_default(),
                body.recovery_key.as_deref(),
                body.plc_op.clone(),
                &request_origin,
                &public_key_multibase,
            )?
        } else {
            account_identity_for_creation(
                &self.env,
                &body.handle,
                body.did.as_deref(),
                body.recovery_key.as_deref(),
                &request_host,
                &request_origin,
                &signing_did_key,
            )
            .await?
        };
        if store
            .get_account_by_did(&identity.did)
            .map_err(HttpError::worker)?
            .is_some()
        {
            return Err(HttpError::new(400, "DidNotAvailable"));
        }
        if let Some(reserved) = reserved_signing_key.as_ref() {
            self.consume_reserved_signing_key(&identity.did, &reserved.signing_key)?;
        }
        let init = match self
            .internal_initialize_account_repo(
                url,
                &identity.repo_name,
                identity.did.as_str(),
                &body.handle,
                &signing_key_hex,
            )
            .await
        {
            Ok(init) => init,
            Err(error) if is_repo_already_initialized_error(&error) => {
                self.recover_initialized_account_repo(
                    url,
                    &identity.repo_name,
                    identity.did.as_str(),
                    &body.handle,
                )
                .await?
            }
            Err(error) => return Err(error),
        };
        if let Some(plc_operation) = identity.plc_operation.as_ref() {
            if let Err(error) =
                submit_plc_operation(identity.did.as_str(), plc_operation, &self.env).await
            {
                let _ = self
                    .internal_reset_account_repo(url, &identity.repo_name)
                    .await;
                return Err(error);
            }
            validate_plc_account_did_document(
                &body.handle,
                identity.did.as_str(),
                &request_origin,
                &public_key_multibase,
                &self.env,
            )
            .await?;
        } else if identity.validate_did_document {
            validate_account_did_document(&body.handle, identity.did.as_str(), &self.env).await?;
        }

        let salt = random_bytes::<PASSWORD_SALT_BYTES>()?;
        let account = DirectoryAccountRow {
            did: identity.did.clone(),
            handle: body.handle.clone(),
            email: body.email.clone(),
            email_confirmed: false,
            invites_disabled: false,
            invite_note: None,
            password_hash: hash_password(password, &salt),
            repo_name: identity.repo_name.clone(),
            public_key_multibase: init.public_key_multibase.clone(),
            active: !identity.deactivated,
            status: identity.deactivated.then(|| "deactivated".to_string()),
            created_at: current_datetime_string(),
        };
        store.insert_account(&account).map_err(HttpError::worker)?;
        let repo = DirectoryRepoRow {
            did: identity.did.clone(),
            handle: body.handle.clone(),
            repo_name: identity.repo_name,
            head: parse_cid(&init.latest_commit).map_err(HttpError::bad_request)?,
            rev: RepoRev::new(init.latest_rev).map_err(HttpError::bad_request)?,
            active: !identity.deactivated,
        };
        store.upsert_repo(&repo).map_err(HttpError::worker)?;
        if !identity.deactivated || identity.plc_operation.is_some() {
            let identity_event = store
                .append_identity_event(&identity.did, &body.handle)
                .map_err(HttpError::worker)?;
            self.broadcast_repo_event(&identity_event)?;
        }
        if !identity.deactivated {
            let account_event = store
                .append_account_event(&identity.did, true, None)
                .map_err(HttpError::worker)?;
            self.broadcast_repo_event(&account_event)?;
        } else if identity.plc_operation.is_some() {
            let account_event = store
                .append_account_event(&identity.did, false, Some("deactivated"))
                .map_err(HttpError::worker)?;
            self.broadcast_repo_event(&account_event)?;
        }
        if let Some(invite_code) = body.invite_code.as_deref() {
            self.consume_invite_code(&store, invite_code, &identity.did)?;
        }

        let session = self.create_session_for_account(&account)?;
        store
            .insert_session(&session.row)
            .map_err(HttpError::worker)?;
        json_response(200, &session_response(url, &account, Some(session.tokens)))
            .map_err(HttpError::worker)
    }

    async fn xrpc_create_session(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let mut body: XrpcCreateSessionRequest = req.json().await.map_err(HttpError::worker)?;
        if !body.identifier.starts_with("did:") {
            body.identifier = body.identifier.to_ascii_lowercase();
        }
        let Some(account) = self
            .store()
            .get_account_by_identifier(&body.identifier)
            .map_err(HttpError::worker)?
        else {
            return Err(HttpError::new(401, "invalid identifier or password"));
        };
        if !self.verify_account_or_app_password(&account, &body.password)? {
            return Err(HttpError::new(401, "invalid identifier or password"));
        }
        ensure_account_authentication_allowed(&account)?;

        let session = self.create_session_for_account(&account)?;
        self.store()
            .insert_session(&session.row)
            .map_err(HttpError::worker)?;
        json_response(200, &session_response(url, &account, Some(session.tokens)))
            .map_err(HttpError::worker)
    }

    fn xrpc_get_session(&self, req: &Request, url: &worker::Url) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims_allow_deactivated(&claims)?;
        json_response(200, &session_response(url, &account, None)).map_err(HttpError::worker)
    }

    async fn xrpc_refresh_session(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, REFRESH_SCOPE)?;
        let Some(session) = self
            .store()
            .get_session_by_refresh_jti(&claims.jti)
            .map_err(HttpError::worker)?
        else {
            return Err(HttpError::new(401, "InvalidToken"));
        };
        if !session.active || session.refresh_jti != claims.jti {
            return Err(HttpError::new(401, "InvalidToken"));
        }
        let account = self.account_for_claims_allow_deactivated(&claims)?;
        let refreshed = self.create_session_for_account(&account)?;
        self.store()
            .rotate_session_refresh(&session.session_id, &refreshed.row.refresh_jti)
            .map_err(HttpError::worker)?;
        json_response(
            200,
            &session_response(url, &account, Some(refreshed.tokens)),
        )
        .map_err(HttpError::worker)
    }

    fn xrpc_delete_session(&self, req: &Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, REFRESH_SCOPE)?;
        self.store()
            .delete_session_by_refresh_jti(&claims.jti)
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_change_password(&self, req: &mut Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let body: XrpcChangePasswordRequest = req.json().await.map_err(HttpError::worker)?;
        if !verify_password(&body.old_password, &account.password_hash).map_err(HttpError::auth)? {
            return Err(HttpError::new(401, "invalid password"));
        }
        ensure_password_strength(&body.new_password)?;
        let salt = random_bytes::<PASSWORD_SALT_BYTES>()?;
        self.store()
            .update_account_password(&account.did, &hash_password(&body.new_password, &salt))
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_request_password_reset(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: XrpcRequestPasswordResetRequest = req.json().await.map_err(HttpError::worker)?;
        let email = normalize_required_email(&body.email)?;
        let account = self
            .store()
            .get_account_by_email(&email)
            .map_err(HttpError::worker)?;
        let token = if let Some(account) = account.filter(|account| account.active) {
            Some(self.issue_action_token(&account.did, ACTION_PASSWORD_RESET, Some(&email))?)
        } else {
            None
        };
        action_token_response(&self.env, req, token.as_deref()).map_err(HttpError::worker)
    }

    async fn xrpc_reset_password(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: XrpcResetPasswordRequest = req.json().await.map_err(HttpError::worker)?;
        ensure_password_strength(&body.password)?;
        let token = self.validate_action_token(ACTION_PASSWORD_RESET, &body.token)?;
        let account = self
            .store()
            .get_account_by_did(&token.did)
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(400, "InvalidToken"))?;
        if !account.active {
            return Err(HttpError::new(403, "AccountTakedown"));
        }
        let salt = random_bytes::<PASSWORD_SALT_BYTES>()?;
        let store = self.store();
        store
            .update_account_password(&account.did, &hash_password(&body.password, &salt))
            .map_err(HttpError::worker)?;
        store
            .delete_sessions_for_did(&account.did)
            .map_err(HttpError::worker)?;
        store
            .delete_app_passwords_for_did(&account.did)
            .map_err(HttpError::worker)?;
        self.consume_validated_action_token(&token)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_request_email_confirmation(&self, req: &Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let Some(email) = account.email.as_deref() else {
            return Err(HttpError::new(400, "InvalidEmail"));
        };
        let token =
            self.issue_action_token(&account.did, ACTION_EMAIL_CONFIRMATION, Some(email))?;
        action_token_response(&self.env, req, Some(&token)).map_err(HttpError::worker)
    }

    async fn xrpc_confirm_email(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: XrpcConfirmEmailRequest = req.json().await.map_err(HttpError::worker)?;
        let email = normalize_required_email(&body.email)?;
        let token = self.validate_action_token(ACTION_EMAIL_CONFIRMATION, &body.token)?;
        if token.email.as_deref() != Some(email.as_str()) {
            return Err(HttpError::new(400, "InvalidToken"));
        }
        let account = self
            .store()
            .get_account_by_did(&token.did)
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(400, "AccountNotFound"))?;
        if account.email.as_deref() != Some(email.as_str()) {
            return Err(HttpError::new(400, "InvalidEmail"));
        }
        self.store()
            .set_account_email_confirmed(&account.did, &email, true)
            .map_err(HttpError::worker)?;
        self.consume_validated_action_token(&token)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_request_email_update(&self, req: &Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let token = if account.email_confirmed {
            Some(self.issue_action_token(
                &account.did,
                ACTION_EMAIL_UPDATE,
                account.email.as_deref(),
            )?)
        } else {
            None
        };
        let mut body = json!({ "tokenRequired": account.email_confirmed });
        if is_admin_authorized(&self.env, req)? {
            if let Some(token) = token {
                body["token"] = json!(token);
            }
        }
        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn xrpc_update_email(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let mut account = self.account_for_claims(&claims)?;
        let body: XrpcUpdateEmailRequest = req.json().await.map_err(HttpError::worker)?;
        let email = normalize_required_email(&body.email)?;
        let mut email_update_token = None;
        if account.email_confirmed {
            let Some(token) = body.token.as_deref() else {
                return Err(HttpError::new(400, "TokenRequired"));
            };
            let token = self.validate_action_token(ACTION_EMAIL_UPDATE, token)?;
            if token.did != account.did {
                return Err(HttpError::new(400, "InvalidToken"));
            }
            email_update_token = Some(token);
        }
        account.email = Some(email);
        account.email_confirmed = false;
        self.store()
            .update_account_email(&account.did, account.email.as_deref(), false)
            .map_err(HttpError::worker)?;
        if let Some(token) = email_update_token {
            self.consume_validated_action_token(&token)?;
        }
        json_response(200, &session_response(url, &account, None)).map_err(HttpError::worker)
    }

    async fn xrpc_request_account_delete(&self, req: &Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let token = self.issue_action_token(
            &account.did,
            ACTION_ACCOUNT_DELETE,
            account.email.as_deref(),
        )?;
        action_token_response(&self.env, req, Some(&token)).map_err(HttpError::worker)
    }

    async fn xrpc_delete_account(&self, req: &mut Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let body: XrpcDeleteAccountRequest = req.json().await.map_err(HttpError::worker)?;
        let did = Did::new(body.did).map_err(HttpError::bad_request)?;
        if claims.sub != did.as_str() {
            return Err(HttpError::new(401, "InvalidToken"));
        }
        let account = self.account_for_claims(&claims)?;
        if account.did != did {
            return Err(HttpError::new(401, "InvalidToken"));
        }
        if !verify_password(&body.password, &account.password_hash).map_err(HttpError::auth)? {
            return Err(HttpError::new(401, "invalid password"));
        }
        let token = self.validate_action_token(ACTION_ACCOUNT_DELETE, &body.token)?;
        if token.did != account.did {
            return Err(HttpError::new(400, "InvalidToken"));
        }
        let store = self.store();
        store
            .delete_sessions_for_did(&account.did)
            .map_err(HttpError::worker)?;
        store
            .delete_app_passwords_for_did(&account.did)
            .map_err(HttpError::worker)?;
        store
            .delete_action_tokens_for_did(&account.did)
            .map_err(HttpError::worker)?;
        self.set_account_active(&account.did, false, Some("deleted"))?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_deactivate_account(&self, req: &Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        self.set_account_active(&account.did, false, Some("deactivated"))?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_activate_account(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims_allow_inactive(&claims)?;
        if account.status.as_deref() == Some("deleted") {
            return Err(HttpError::new(403, "AccountDeleted"));
        }
        if !account.active && is_identity_did(account.did.as_str()) {
            let status = self
                .internal_account_repo_status(url, &account.repo_name)
                .await?;
            let public_key_multibase = status
                .public_key_multibase
                .as_deref()
                .unwrap_or(account.public_key_multibase.as_str());
            validate_hosted_account_did_document(
                &account.handle,
                account.did.as_str(),
                &request_origin(url),
                public_key_multibase,
                &self.env,
            )
            .await?;
            if public_key_multibase != account.public_key_multibase {
                self.store()
                    .update_account_public_key(&account.did, public_key_multibase)
                    .map_err(HttpError::worker)?;
            }
        }
        self.set_account_active(&account.did, true, None)?;
        let account = self
            .store()
            .get_account_by_did(&account.did)
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(401, "InvalidToken"))?;
        json_response(200, &session_response(url, &account, None)).map_err(HttpError::worker)
    }

    async fn xrpc_check_account_status(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims_allow_inactive(&claims)?;
        let status = self
            .internal_account_repo_status(url, &account.repo_name)
            .await?;
        json_response(
            200,
            &json!({
                "activated": account.active,
                "validDid": status.did.as_deref() == Some(account.did.as_str()),
                "repoCommit": status.latest_commit.unwrap_or_default(),
                "repoRev": status.latest_rev.unwrap_or_default(),
                "repoBlocks": status.blocks,
                "indexedRecords": status.records,
                "privateStateValues": 0,
                "expectedBlobs": status.expected_blobs,
                "importedBlobs": status.imported_blobs,
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn xrpc_get_service_auth(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let params = query_pairs(url);
        let aud = Did::new(required_param(&params, "aud").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let lxm = optional_param(&params, "lxm")
            .filter(|value| !value.is_empty())
            .map(|value| Nsid::new(value).map_err(HttpError::bad_request))
            .transpose()?;
        let now = current_unix_time();
        let exp = match optional_param(&params, "exp").filter(|value| !value.is_empty()) {
            Some(value) => value
                .parse::<i64>()
                .map_err(|_| HttpError::new(400, "BadExpiration"))?,
            None => now.saturating_add(60),
        };
        if exp <= now || exp > now.saturating_add(60 * 60) {
            return Err(HttpError::new(400, "BadExpiration"));
        }
        let token = self
            .internal_sign_account_service_auth(
                url,
                &account.repo_name,
                aud.as_str(),
                lxm.as_ref(),
                exp,
            )
            .await?;
        json_response(200, &json!({ "token": token })).map_err(HttpError::worker)
    }

    async fn xrpc_reserve_signing_key(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: XrpcReserveSigningKeyRequest = optional_json_body(req).await?;
        let did = body
            .did
            .map(Did::new)
            .transpose()
            .map_err(HttpError::bad_request)?;
        let key_hex = generate_repo_signing_key_hex()?;
        let key = RepoSigningKey::from_p256_hex(&key_hex).map_err(HttpError::identity)?;
        let public_key_multibase = key.public_key_multibase().map_err(HttpError::identity)?;
        let signing_key = did_key_from_public_key_multibase(&public_key_multibase)?;
        self.store()
            .insert_reserved_signing_key(&DirectoryReservedSigningKeyInput {
                signing_key: signing_key.clone(),
                public_key_multibase,
                signing_key_p256_hex: key.to_p256_hex(),
                did,
            })
            .map_err(HttpError::worker)?;
        json_response(
            200,
            &json!({
                "signingKey": signing_key,
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn xrpc_create_invite_code(&self, req: &mut Request) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcCreateInviteCodeRequest = req.json().await.map_err(HttpError::worker)?;
        let for_account = match body.for_account {
            Some(did) => Did::new(did).map_err(HttpError::bad_request)?,
            None => self.host_account_did(req)?,
        };
        let code = self.create_invite_code(&for_account, &for_account, body.use_count)?;
        json_response(200, &json!({ "code": code })).map_err(HttpError::worker)
    }

    async fn xrpc_create_invite_codes(&self, req: &mut Request) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcCreateInviteCodesRequest = req.json().await.map_err(HttpError::worker)?;
        let code_count = body.code_count.unwrap_or(1).clamp(1, 100);
        let accounts = if let Some(accounts) = body.for_accounts {
            accounts
                .into_iter()
                .map(Did::new)
                .collect::<Result<Vec<_>, _>>()
                .map_err(HttpError::bad_request)?
        } else {
            vec![self.host_account_did(req)?]
        };
        let mut rows = Vec::new();
        for account in accounts {
            let mut codes = Vec::new();
            for _ in 0..code_count {
                codes.push(self.create_invite_code(&account, &account, body.use_count)?);
            }
            rows.push(json!({
                "account": account.to_string(),
                "codes": codes,
            }));
        }
        json_response(200, &json!({ "codes": rows })).map_err(HttpError::worker)
    }

    fn xrpc_get_account_invite_codes(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let params = query_pairs(url);
        let include_used = bool_param(&params, "includeUsed", true)?;
        let codes = self
            .store()
            .list_invite_codes_for_account(&account.did, include_used)
            .map_err(HttpError::worker)?;
        let codes = self.invite_code_values(&codes)?;
        json_response(200, &json!({ "codes": codes })).map_err(HttpError::worker)
    }

    async fn xrpc_admin_delete_account(&self, req: &mut Request) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminDidRequest = req.json().await.map_err(HttpError::worker)?;
        let did = Did::new(body.did).map_err(HttpError::bad_request)?;
        self.delete_account_as_admin(&did)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_admin_disable_account_invites(
        &self,
        req: &mut Request,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminAccountInvitesRequest = req.json().await.map_err(HttpError::worker)?;
        let did = Did::new(body.account).map_err(HttpError::bad_request)?;
        self.ensure_account_exists(&did)?;
        self.store()
            .set_account_invites_disabled(&did, true, body.note.as_deref())
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_admin_disable_invite_codes(
        &self,
        req: &mut Request,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminDisableInviteCodesRequest =
            req.json().await.map_err(HttpError::worker)?;
        let accounts = body
            .accounts
            .unwrap_or_default()
            .into_iter()
            .map(Did::new)
            .collect::<Result<Vec<_>, _>>()
            .map_err(HttpError::bad_request)?;
        self.store()
            .disable_invite_codes(&body.codes.unwrap_or_default(), &accounts)
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_admin_enable_account_invites(
        &self,
        req: &mut Request,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminAccountInvitesRequest = req.json().await.map_err(HttpError::worker)?;
        let did = Did::new(body.account).map_err(HttpError::bad_request)?;
        self.ensure_account_exists(&did)?;
        self.store()
            .set_account_invites_disabled(&did, false, body.note.as_deref())
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    fn xrpc_admin_get_account_info(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let params = query_pairs(url);
        let did = Did::new(required_param(&params, "did").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let account = self.account_by_did(&did)?;
        let invites = self
            .store()
            .list_invite_codes_for_account(&did, true)
            .map_err(HttpError::worker)?;
        let invites = self.invite_code_values(&invites)?;
        json_response(200, &account_view_json(&account, Some(invites))).map_err(HttpError::worker)
    }

    fn xrpc_admin_get_account_infos(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let params = query_pairs(url);
        let dids = did_array_param(&params, "dids")?;
        let accounts = self
            .store()
            .list_accounts_by_dids(&dids)
            .map_err(HttpError::worker)?;
        let infos = accounts
            .iter()
            .map(|account| account_view_json(account, None))
            .collect::<Vec<_>>();
        json_response(200, &json!({ "infos": infos })).map_err(HttpError::worker)
    }

    fn xrpc_admin_get_invite_codes(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let params = query_pairs(url);
        let limit = parse_xrpc_limit(optional_param(&params, "limit").as_deref(), 100, 500)?;
        let cursor = optional_param(&params, "cursor").filter(|value| !value.is_empty());
        let (codes, next_cursor) = self
            .store()
            .list_invite_codes(limit, cursor.as_deref())
            .map_err(HttpError::worker)?;
        let mut body = json!({ "codes": self.invite_code_values(&codes)? });
        if let Some(cursor) = next_cursor {
            body["cursor"] = json!(cursor);
        }
        json_response(200, &body).map_err(HttpError::worker)
    }

    fn xrpc_admin_get_subject_status(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let params = query_pairs(url);
        let Some(did) = optional_param(&params, "did").filter(|value| !value.is_empty()) else {
            return Err(HttpError::new(
                400,
                "UnsupportedSubject: only account DID subjects are implemented",
            ));
        };
        let did = Did::new(did).map_err(HttpError::bad_request)?;
        let account = self.account_by_did(&did)?;
        json_response(200, &subject_status_json(&account)).map_err(HttpError::worker)
    }

    fn xrpc_admin_search_accounts(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let params = query_pairs(url);
        let limit = parse_xrpc_limit(optional_param(&params, "limit").as_deref(), 50, 100)?;
        let cursor = optional_param(&params, "cursor").filter(|value| !value.is_empty());
        let email = optional_param(&params, "email")
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        let (accounts, next_cursor) = self
            .store()
            .search_accounts(email.as_deref(), limit, cursor.as_deref())
            .map_err(HttpError::worker)?;
        let mut body = json!({
            "accounts": accounts.iter().map(|account| account_view_json(account, None)).collect::<Vec<_>>(),
        });
        if let Some(cursor) = next_cursor {
            body["cursor"] = json!(cursor);
        }
        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn xrpc_admin_send_email(&self, req: &mut Request) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminSendEmailRequest = req.json().await.map_err(HttpError::worker)?;
        let recipient = Did::new(body.recipient_did).map_err(HttpError::bad_request)?;
        let sender = Did::new(body.sender_did).map_err(HttpError::bad_request)?;
        self.ensure_account_exists(&recipient)?;
        let _ = (sender, body.content, body.subject, body.comment);
        json_response(200, &json!({ "sent": false })).map_err(HttpError::worker)
    }

    async fn xrpc_admin_update_account_email(
        &self,
        req: &mut Request,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminUpdateAccountEmailRequest =
            req.json().await.map_err(HttpError::worker)?;
        let account = self.account_by_identifier(&body.account)?;
        let email = normalize_required_email(&body.email)?;
        self.store()
            .update_account_email(&account.did, Some(&email), false)
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_admin_update_account_handle(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let mut body: XrpcAdminUpdateAccountHandleRequest =
            req.json().await.map_err(HttpError::worker)?;
        body.handle = body.handle.to_ascii_lowercase();
        validate_account_handle_syntax(&self.env, &body.handle)?;
        let request_host = request_host(req)?;
        if body.handle != request_host
            && !configured_account_handle_allowed(&self.env, &body.handle)
        {
            return Err(HttpError::new(
                400,
                format!(
                    "UnsupportedDomain: `{}` is not the request host `{request_host}` and is not allowed by PDS_ALLOWED_ACCOUNT_HANDLES or PDS_ALLOWED_ACCOUNT_HANDLE_SUFFIXES",
                    body.handle
                ),
            ));
        }
        let did = Did::new(body.did).map_err(HttpError::bad_request)?;
        let mut account = self.account_by_did(&did)?;
        if account.handle != body.handle {
            let store = self.store();
            if let Some(existing) = store
                .get_account_by_identifier(&body.handle)
                .map_err(HttpError::worker)?
            {
                if existing.did != did {
                    return Err(HttpError::new(400, "HandleNotAvailable"));
                }
            }
            store
                .update_account_handle(&did, &body.handle)
                .map_err(HttpError::worker)?;
            store
                .update_repo_handle(&did, &body.handle)
                .map_err(HttpError::worker)?;
            self.internal_update_account_repo_identity(url, &account.repo_name, &body.handle)
                .await?;
            let event = store
                .append_identity_event(&did, &body.handle)
                .map_err(HttpError::worker)?;
            self.broadcast_repo_event(&event)?;
            account.handle = body.handle;
        }
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_admin_update_account_password(
        &self,
        req: &mut Request,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminUpdateAccountPasswordRequest =
            req.json().await.map_err(HttpError::worker)?;
        let did = Did::new(body.did).map_err(HttpError::bad_request)?;
        self.ensure_account_exists(&did)?;
        ensure_password_strength(&body.password)?;
        let salt = random_bytes::<PASSWORD_SALT_BYTES>()?;
        let store = self.store();
        store
            .update_account_password(&did, &hash_password(&body.password, &salt))
            .map_err(HttpError::worker)?;
        store
            .delete_sessions_for_did(&did)
            .map_err(HttpError::worker)?;
        store
            .delete_app_passwords_for_did(&did)
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_admin_update_account_signing_key(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminUpdateAccountSigningKeyRequest =
            req.json().await.map_err(HttpError::worker)?;
        let did = Did::new(body.did).map_err(HttpError::bad_request)?;
        let account = self.account_by_did(&did)?;
        let reserved = self.take_reserved_signing_key(&did, &body.signing_key)?;
        self.internal_update_account_repo_signing_key(
            url,
            &account.repo_name,
            &reserved.signing_key_p256_hex,
        )
        .await?;
        self.store()
            .update_account_public_key(&did, &reserved.public_key_multibase)
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_admin_update_subject_status(
        &self,
        req: &mut Request,
    ) -> Result<Response, HttpError> {
        require_admin_with_env(&self.env, req)?;
        let body: XrpcAdminUpdateSubjectStatusRequest =
            req.json().await.map_err(HttpError::worker)?;
        let did = did_from_admin_subject(&body.subject)?;
        self.ensure_account_exists(&did)?;
        let takedown = body.takedown.as_ref().is_some_and(|status| status.applied);
        let deactivated = body
            .deactivated
            .as_ref()
            .is_some_and(|status| status.applied);
        let _status_refs = (
            body.takedown
                .as_ref()
                .and_then(|status| status.ref_value.as_deref()),
            body.deactivated
                .as_ref()
                .and_then(|status| status.ref_value.as_deref()),
        );
        let (active, status) = if takedown {
            (false, Some("takedown"))
        } else if deactivated {
            (false, Some("deactivated"))
        } else {
            (true, None)
        };
        self.set_account_active(&did, active, status)?;
        let account = self.account_by_did(&did)?;
        json_response(200, &subject_status_json(&account)).map_err(HttpError::worker)
    }

    async fn xrpc_create_app_password(&self, req: &mut Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let body: XrpcCreateAppPasswordRequest = req.json().await.map_err(HttpError::worker)?;
        ensure_app_password_name(&body.name)?;
        let password = generate_app_password()?;
        let salt = random_bytes::<PASSWORD_SALT_BYTES>()?;
        let created_at = self
            .store()
            .put_app_password(
                &account.did,
                &body.name,
                &hash_password(&password, &salt),
                body.privileged.unwrap_or(false),
            )
            .map_err(HttpError::worker)?;
        json_response(
            200,
            &json!({
                "name": body.name,
                "password": password,
                "createdAt": created_at,
                "privileged": body.privileged.unwrap_or(false),
            }),
        )
        .map_err(HttpError::worker)
    }

    fn xrpc_list_app_passwords(&self, req: &Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let passwords = self
            .store()
            .list_app_passwords(&account.did)
            .map_err(HttpError::worker)?
            .into_iter()
            .map(|row| {
                json!({
                    "name": row.name,
                    "createdAt": row.created_at,
                    "privileged": row.privileged,
                })
            })
            .collect::<Vec<_>>();
        json_response(200, &json!({ "passwords": passwords })).map_err(HttpError::worker)
    }

    async fn xrpc_revoke_app_password(&self, req: &mut Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let body: XrpcRevokeAppPasswordRequest = req.json().await.map_err(HttpError::worker)?;
        self.store()
            .delete_app_password(&account.did, &body.name)
            .map_err(HttpError::worker)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_update_handle(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let mut account = self.account_for_claims(&claims)?;
        let mut body: XrpcUpdateHandleRequest = req.json().await.map_err(HttpError::worker)?;
        body.handle = body.handle.to_ascii_lowercase();
        self.ensure_handle_update_allowed(req, &account, &body.handle)
            .await?;
        if account.handle != body.handle {
            let store = self.store();
            if let Some(existing) = store
                .get_account_by_identifier(&body.handle)
                .map_err(HttpError::worker)?
            {
                if existing.did != account.did {
                    return Err(HttpError::new(400, "HandleNotAvailable"));
                }
            }
            store
                .update_account_handle(&account.did, &body.handle)
                .map_err(HttpError::worker)?;
            store
                .update_repo_handle(&account.did, &body.handle)
                .map_err(HttpError::worker)?;
            self.internal_update_account_repo_identity(url, &account.repo_name, &body.handle)
                .await?;
            let event = store
                .append_identity_event(&account.did, &body.handle)
                .map_err(HttpError::worker)?;
            self.broadcast_repo_event(&event)?;
            account.handle = body.handle;
        }
        empty_response(200).map_err(HttpError::worker)
    }

    async fn xrpc_refresh_identity(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let body: XrpcRefreshIdentityRequest = req.json().await.map_err(HttpError::worker)?;
        let identifier = normalize_at_identifier(&body.identifier);
        let account = if identifier.starts_with("did:") {
            let did = Did::new(identifier.clone()).map_err(HttpError::bad_request)?;
            self.store()
                .get_account_by_did(&did)
                .map_err(HttpError::worker)?
                .ok_or_else(|| HttpError::new(404, "DidNotFound"))?
        } else {
            match self
                .store()
                .get_account_by_identifier(&identifier)
                .map_err(HttpError::worker)?
            {
                Some(account) => account,
                None => {
                    let Some(did) = resolve_handle_did_with_env(&identifier, &self.env).await?
                    else {
                        return Err(HttpError::new(404, "HandleNotFound"));
                    };
                    let did = Did::new(did).map_err(HttpError::bad_request)?;
                    self.store()
                        .get_account_by_did(&did)
                        .map_err(HttpError::worker)?
                        .ok_or_else(|| HttpError::new(404, "DidNotFound"))?
                }
            }
        };
        if !account.active {
            return Err(HttpError::new(400, "DidDeactivated"));
        }
        json_response(
            200,
            &identity_info_response_body(&request_origin(url), &account),
        )
        .map_err(HttpError::worker)
    }

    fn xrpc_get_recommended_did_credentials(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims_allow_inactive(&claims)?;
        let rotation_keys = recommended_plc_rotation_keys(&self.env)?;
        let body = recommended_did_credentials_body(
            &request_origin(url),
            &account.handle,
            &account.public_key_multibase,
            &rotation_keys,
        )
        .map_err(HttpError::plc)?;
        json_response(200, &body).map_err(HttpError::worker)
    }

    async fn xrpc_resolve_lexicon(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let nsid = Nsid::new(required_param(&params, "nsid").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let Some(record) = fetch_published_lexicon_record(&self.env, nsid.as_str()).await? else {
            return Err(HttpError::new(404, "LexiconNotFound"));
        };
        json_response(
            200,
            &json!({
                "cid": record.cid,
                "uri": record.uri,
                "schema": record.schema,
            }),
        )
        .map_err(HttpError::worker)
    }

    async fn xrpc_request_plc_operation_signature(
        &self,
        req: &Request,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims_allow_inactive(&claims)?;
        if account.email.is_none() && !is_admin_authorized(&self.env, req)? {
            return Err(HttpError::new(
                400,
                "account does not have an email address",
            ));
        }
        let token =
            self.issue_action_token(&account.did, ACTION_PLC_OPERATION, account.email.as_deref())?;
        action_token_response(&self.env, req, Some(&token)).map_err(HttpError::worker)
    }

    async fn xrpc_sign_plc_operation(&self, req: &mut Request) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims_allow_inactive(&claims)?;
        ensure_plc_did(&account.did)?;
        let body: SignPlcOperationRequest = req.json().await.map_err(HttpError::worker)?;
        let token = body
            .token
            .as_deref()
            .ok_or_else(|| HttpError::new(400, "TokenRequired"))?;
        let token = self.validate_action_token(ACTION_PLC_OPERATION, token)?;
        if token.did != account.did {
            return Err(HttpError::new(400, "InvalidToken"));
        }
        let rotation_key = plc_rotation_signing_key_from_env(&self.env)?
            .ok_or_else(|| HttpError::new(501, "PLC rotation key is not configured"))?;
        let rotation_did_key = did_key_from_public_key_multibase(
            &rotation_key
                .public_key_multibase()
                .map_err(HttpError::identity)?,
        )?;
        let last_op = fetch_plc_last_operation(account.did.as_str(), &self.env).await?;
        let operation = sign_plc_update_operation(&last_op, &rotation_key, &rotation_did_key, body)
            .map_err(HttpError::plc)?;
        self.consume_validated_action_token(&token)?;
        json_response(200, &json!({ "operation": operation })).map_err(HttpError::worker)
    }

    async fn xrpc_submit_plc_operation(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims_allow_inactive(&claims)?;
        ensure_plc_did(&account.did)?;
        let body: XrpcSubmitPlcOperationRequest = req.json().await.map_err(HttpError::worker)?;
        let Some(server_rotation_key) = plc_rotation_did_key_from_env(&self.env)? else {
            return Err(HttpError::new(501, "PLC rotation key is not configured"));
        };
        validate_submitted_plc_operation(
            &body.operation,
            &request_origin(url),
            &account.handle,
            &account.public_key_multibase,
            &server_rotation_key,
        )
        .map_err(HttpError::plc)?;
        submit_plc_operation(account.did.as_str(), &body.operation, &self.env).await?;
        let event = self
            .store()
            .append_identity_event(&account.did, &account.handle)
            .map_err(HttpError::worker)?;
        self.broadcast_repo_event(&event)?;
        empty_response(200).map_err(HttpError::worker)
    }

    async fn ensure_handle_update_allowed(
        &self,
        req: &Request,
        account: &DirectoryAccountRow,
        handle: &str,
    ) -> Result<(), HttpError> {
        validate_account_handle_syntax(&self.env, handle)?;
        if handle == account.handle {
            return Ok(());
        }
        let request_host = request_host(req)?;
        if handle != request_host && !configured_account_handle_allowed(&self.env, handle) {
            return Err(HttpError::new(
                400,
                format!(
                    "UnsupportedDomain: `{handle}` is not the request host `{request_host}` and is not allowed by PDS_ALLOWED_ACCOUNT_HANDLES or PDS_ALLOWED_ACCOUNT_HANDLE_SUFFIXES"
                ),
            ));
        }
        let Some(resolved_did) = resolve_handle_did_with_env(handle, &self.env).await? else {
            return Err(HttpError::new(
                400,
                format!("HandleNotResolvable: `{handle}` did not resolve to a DID"),
            ));
        };
        if resolved_did != account.did.as_str() {
            return Err(HttpError::new(
                400,
                format!(
                    "HandleMismatch: `{handle}` resolves to `{resolved_did}`, expected `{}`",
                    account.did
                ),
            ));
        }
        Ok(())
    }

    fn xrpc_list_repos(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let limit = parse_xrpc_limit(optional_param(&params, "limit").as_deref(), 500, 1000)?;
        let cursor = optional_param(&params, "cursor").filter(|value| !value.is_empty());
        let (repos, next_cursor) = self
            .store()
            .list_repos(limit, cursor.as_deref())
            .map_err(HttpError::worker)?;

        let mut body = json!({
            "repos": repos
                .into_iter()
                .map(directory_repo_json)
                .collect::<Vec<_>>()
        });
        if let Some(cursor) = next_cursor {
            body["cursor"] = json!(cursor);
        }

        json_response(200, &body).map_err(HttpError::worker)
    }

    fn xrpc_list_hosts(&self, req: &Request, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let limit = parse_xrpc_limit(optional_param(&params, "limit").as_deref(), 500, 1000)?;
        let cursor = optional_param(&params, "cursor").filter(|value| !value.is_empty());
        let request_host = request_host(req)?;
        let store = self.store();
        let hosts = if cursor.is_none() && limit > 0 {
            vec![json!({
                "hostname": request_host,
                "seq": store.max_event_seq().map_err(HttpError::worker)?,
                "accountCount": store.account_count().map_err(HttpError::worker)?,
                "status": "active",
            })]
        } else {
            Vec::new()
        };

        json_response(200, &json!({ "hosts": hosts })).map_err(HttpError::worker)
    }

    fn xrpc_list_repos_by_collection(&self, url: &worker::Url) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let collection = Nsid::new(required_param(&params, "collection").map_err(HttpError::xrpc)?)
            .map_err(HttpError::bad_request)?;
        let limit = parse_xrpc_limit(optional_param(&params, "limit").as_deref(), 500, 2000)?;
        let cursor = optional_param(&params, "cursor").filter(|value| !value.is_empty());
        let (repos, next_cursor) = self
            .store()
            .list_repos_by_collection(&collection, limit, cursor.as_deref())
            .map_err(HttpError::worker)?;

        let mut body = json!({
            "repos": repos
                .into_iter()
                .map(|did| json!({ "did": did.to_string() }))
                .collect::<Vec<_>>(),
        });
        if let Some(cursor) = next_cursor {
            body["cursor"] = json!(cursor);
        }

        json_response(200, &body).map_err(HttpError::worker)
    }

    fn xrpc_get_host_status(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let params = query_pairs(url);
        let hostname = required_param(&params, "hostname").map_err(HttpError::xrpc)?;
        let request_host = request_host(req)?;
        if hostname != request_host {
            return Err(HttpError::new(404, "HostNotFound"));
        }
        let store = self.store();
        json_response(
            200,
            &json!({
                "hostname": hostname,
                "seq": store.max_event_seq().map_err(HttpError::worker)?,
                "accountCount": store.account_count().map_err(HttpError::worker)?,
                "status": "active",
            }),
        )
        .map_err(HttpError::worker)
    }

    fn oauth_authorize(&self, req: &Request, url: &worker::Url) -> Result<Response, HttpError> {
        let request = match parse_authorization_request(&query_pairs(url)) {
            Ok(request) => request,
            Err(error) => return oauth_request_error_response(error).map_err(HttpError::worker),
        };
        if req
            .headers()
            .get("authorization")
            .map_err(HttpError::worker)?
            .is_some()
        {
            return self.oauth_authorize_with_bearer(req, url, request);
        }

        let now = current_unix_time();
        let store = self.store();
        let par = self.oauth_par_for_authorization(&store, &request, now)?;
        oauth_authorization_form_response(200, &par, None).map_err(HttpError::worker)
    }

    fn oauth_authorize_with_bearer(
        &self,
        req: &Request,
        url: &worker::Url,
        request: crate::oauth::AuthorizationRequest,
    ) -> Result<Response, HttpError> {
        let claims = self.require_bearer_claims(req, ACCESS_SCOPE)?;
        let account = self.account_for_claims(&claims)?;
        let now = current_unix_time();
        let store = self.store();
        let par = self.oauth_par_for_authorization(&store, &request, now)?;
        self.ensure_oauth_login_hint_matches(&par, &account)?;
        self.issue_oauth_authorization_code(url, &store, par, account, now)
    }

    async fn oauth_authorize_submit(
        &self,
        req: &mut Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        if let Err(error) = ensure_form_urlencoded(req) {
            return oauth_error_response(415, "invalid_request", &error.message)
                .map_err(HttpError::worker);
        }
        let body = req.text().await.map_err(HttpError::worker)?;
        let form = match parse_authorization_form(&body) {
            Ok(form) => form,
            Err(error) => return oauth_request_error_response(error).map_err(HttpError::worker),
        };
        let request = crate::oauth::AuthorizationRequest {
            client_id: form.client_id.clone(),
            request_uri: form.request_uri.clone(),
        };
        let now = current_unix_time();
        let store = self.store();
        let par = self.oauth_par_for_authorization(&store, &request, now)?;
        if !form.approved {
            return oauth_authorization_error_redirect(
                &par.redirect_uri,
                "access_denied",
                "authorization was denied",
                &par.state,
                &request_origin(url),
            );
        }

        let Some(account) = store
            .get_account_by_identifier(&form.identifier)
            .map_err(HttpError::worker)?
        else {
            return oauth_authorization_form_response(
                401,
                &par,
                Some("Invalid identifier or password"),
            )
            .map_err(HttpError::worker);
        };
        if !verify_password(&form.password, &account.password_hash).map_err(HttpError::auth)?
            || !account.active
        {
            return oauth_authorization_form_response(
                401,
                &par,
                Some("Invalid identifier or password"),
            )
            .map_err(HttpError::worker);
        }
        self.ensure_oauth_login_hint_matches(&par, &account)?;
        self.issue_oauth_authorization_code(url, &store, par, account, now)
    }

    fn oauth_par_for_authorization(
        &self,
        store: &SqlDirectoryStore,
        request: &crate::oauth::AuthorizationRequest,
        now: i64,
    ) -> Result<DirectoryOauthParRequestRow, HttpError> {
        store
            .purge_expired_oauth_par_requests(now)
            .map_err(HttpError::worker)?;
        store
            .purge_expired_oauth_authorization_codes(now)
            .map_err(HttpError::worker)?;
        let Some(par) = store
            .get_oauth_par_request(&request.request_uri, now)
            .map_err(HttpError::worker)?
        else {
            return Err(HttpError::new(400, "unknown or expired request_uri"));
        };
        if par.client_id != request.client_id {
            return Err(HttpError::new(400, "client_id did not match request_uri"));
        }
        Ok(par)
    }

    fn ensure_oauth_login_hint_matches(
        &self,
        par: &DirectoryOauthParRequestRow,
        account: &DirectoryAccountRow,
    ) -> Result<(), HttpError> {
        if par.login_hint.as_deref().is_some_and(|login_hint| {
            login_hint != account.handle.as_str() && login_hint != account.did.as_str()
        }) {
            return Err(HttpError::new(403, "login_hint did not match account"));
        }
        Ok(())
    }

    fn issue_oauth_authorization_code(
        &self,
        url: &worker::Url,
        store: &SqlDirectoryStore,
        par: DirectoryOauthParRequestRow,
        account: DirectoryAccountRow,
        now: i64,
    ) -> Result<Response, HttpError> {
        let code = random_urlsafe_token::<OAUTH_AUTHORIZATION_CODE_BYTES>()?;
        store
            .insert_oauth_authorization_code(&DirectoryOauthAuthorizationCodeInput {
                code: code.clone(),
                request_uri: par.request_uri.clone(),
                client_id: par.client_id.clone(),
                redirect_uri: par.redirect_uri.clone(),
                scope: par.scope.clone(),
                state: par.state.clone(),
                code_challenge: par.code_challenge.clone(),
                code_challenge_method: par.code_challenge_method.clone(),
                did: account.did,
                handle: account.handle,
                dpop_jkt: par.dpop_jkt.clone(),
                dpop_nonce: par.dpop_nonce,
                client_auth_method: par.client_auth_method,
                client_auth_kid: par.client_auth_kid,
                client_auth_alg: par.client_auth_alg,
                client_auth_jkt: par.client_auth_jkt,
                expires_at: now.saturating_add(OAUTH_AUTHORIZATION_CODE_TTL_SECONDS),
            })
            .map_err(HttpError::worker)?;
        store
            .delete_oauth_par_request(&par.request_uri)
            .map_err(HttpError::worker)?;

        oauth_authorization_redirect(&par.redirect_uri, &code, &par.state, &request_origin(url))
    }

    async fn oauth_pushed_authorization_request(
        &self,
        req: &mut Request,
    ) -> Result<Response, HttpError> {
        if let Err(error) = ensure_form_urlencoded(req) {
            return oauth_error_response(415, "invalid_request", &error.message)
                .map_err(HttpError::worker);
        }
        let body = req.text().await.map_err(HttpError::worker)?;
        let request = match parse_pushed_authorization_request(&body) {
            Ok(request) => request,
            Err(error) => return oauth_request_error_response(error).map_err(HttpError::worker),
        };
        let issuer = request_origin(&req.url().map_err(HttpError::worker)?);
        let client_auth = self.validate_oauth_par_client(&request, &issuer).await?;
        let dpop_proof = match verify_request_dpop(req, None, None, None) {
            Ok(proof) => proof,
            Err(error) => return oauth_dpop_error_response(error, None).map_err(HttpError::worker),
        };

        let now = current_unix_time();
        let store = self.store();
        self.remember_dpop_proof(&store, &dpop_proof, now)?;
        store
            .purge_expired_oauth_par_requests(now)
            .map_err(HttpError::worker)?;
        if store
            .has_oauth_par_state(&request.client_id, &request.state, now)
            .map_err(HttpError::worker)?
        {
            return oauth_error_response(
                400,
                "invalid_request",
                "duplicate OAuth state for this client",
            )
            .map_err(HttpError::worker);
        }

        let request_uri = format!(
            "{OAUTH_REQUEST_URI_PREFIX}{}",
            random_urlsafe_token::<OAUTH_REQUEST_URI_BYTES>()?
        );
        let dpop_nonce = random_urlsafe_token::<OAUTH_DPOP_NONCE_BYTES>()?;
        let expires_at = now.saturating_add(OAUTH_PAR_EXPIRES_IN_SECONDS);
        let params_json = to_string(&request.to_json()).map_err(HttpError::worker)?;
        store
            .insert_oauth_par_request(&DirectoryOauthParRequestInput {
                request_uri: request_uri.clone(),
                client_id: request.client_id,
                redirect_uri: request.redirect_uri,
                scope: request.scope,
                state: request.state,
                code_challenge: request.code_challenge,
                code_challenge_method: request.code_challenge_method,
                login_hint: request.login_hint,
                dpop_jkt: dpop_proof.jkt,
                dpop_nonce: dpop_nonce.clone(),
                client_auth_method: client_auth.method_str().to_string(),
                client_auth_kid: client_auth.kid.clone(),
                client_auth_alg: client_auth.alg.clone(),
                client_auth_jkt: client_auth.jkt.clone(),
                params_json,
                expires_at,
            })
            .map_err(HttpError::worker)?;

        oauth_par_response(&request_uri, OAUTH_PAR_EXPIRES_IN_SECONDS, &dpop_nonce)
            .map_err(HttpError::worker)
    }

    async fn oauth_token(&self, req: &mut Request) -> Result<Response, HttpError> {
        if let Err(error) = ensure_form_urlencoded(req) {
            return oauth_error_response(415, "invalid_request", &error.message)
                .map_err(HttpError::worker);
        }
        let body = req.text().await.map_err(HttpError::worker)?;
        let request = match parse_token_request(&body) {
            Ok(request) => request,
            Err(error) => return oauth_request_error_response(error).map_err(HttpError::worker),
        };
        match request {
            TokenRequest::AuthorizationCode {
                client_id,
                code,
                redirect_uri,
                code_verifier,
                client_auth,
            } => {
                self.oauth_authorization_code_token(
                    req,
                    &client_id,
                    &code,
                    &redirect_uri,
                    &code_verifier,
                    &client_auth,
                )
                .await
            }
            TokenRequest::RefreshToken {
                client_id,
                refresh_token,
                client_auth,
            } => {
                self.oauth_refresh_token(req, &client_id, &refresh_token, &client_auth)
                    .await
            }
        }
    }

    async fn oauth_authorization_code_token(
        &self,
        req: &Request,
        client_id: &str,
        code: &str,
        redirect_uri: &str,
        code_verifier: &str,
        client_auth: &OAuthClientAuth,
    ) -> Result<Response, HttpError> {
        let now = current_unix_time();
        let store = self.store();
        store
            .purge_expired_oauth_authorization_codes(now)
            .map_err(HttpError::worker)?;
        let Some(authorization_code) = store
            .get_oauth_authorization_code(code, now)
            .map_err(HttpError::worker)?
        else {
            return oauth_error_response(
                400,
                "invalid_grant",
                "unknown or expired authorization code",
            )
            .map_err(HttpError::worker);
        };
        if authorization_code.client_id != client_id {
            return oauth_error_response(400, "invalid_grant", "client_id did not match code")
                .map_err(HttpError::worker);
        }
        if authorization_code.redirect_uri != redirect_uri {
            return oauth_error_response(400, "invalid_grant", "redirect_uri did not match code")
                .map_err(HttpError::worker);
        }
        if authorization_code.code_challenge_method != "S256"
            || pkce_s256_challenge(code_verifier) != authorization_code.code_challenge
        {
            return oauth_error_response(400, "invalid_grant", "PKCE verification failed")
                .map_err(HttpError::worker);
        }
        let expected_client_auth = OAuthClientAuthBinding::from_parts(
            &authorization_code.client_auth_method,
            authorization_code.client_auth_kid.clone(),
            authorization_code.client_auth_alg.clone(),
            authorization_code.client_auth_jkt.clone(),
        )?;
        let issuer = request_origin(&req.url().map_err(HttpError::worker)?);
        self.validate_oauth_client_auth(
            client_id,
            Some(&authorization_code.redirect_uri),
            &authorization_code.scope,
            client_auth,
            Some(&expected_client_auth),
            &issuer,
        )
        .await?;
        let dpop_proof = match verify_request_dpop(
            req,
            Some(&authorization_code.dpop_jkt),
            Some(&authorization_code.dpop_nonce),
            None,
        ) {
            Ok(proof) => proof,
            Err(error) => {
                return oauth_dpop_error_response(error, Some(&authorization_code.dpop_nonce))
                    .map_err(HttpError::worker);
            }
        };
        self.remember_dpop_proof(&store, &dpop_proof, now)?;

        let Some(account) = store
            .get_account_by_did(&authorization_code.did)
            .map_err(HttpError::worker)?
            .filter(|account| account.active)
        else {
            return oauth_error_response(
                400,
                "invalid_grant",
                "authorization account is unavailable",
            )
            .map_err(HttpError::worker);
        };
        store
            .consume_oauth_authorization_code(code, now)
            .map_err(HttpError::worker)?;
        let oauth_session = self.create_oauth_session_for_account(
            &account,
            client_id,
            &authorization_code.scope,
            &authorization_code.dpop_jkt,
            &expected_client_auth,
            None,
        )?;
        store
            .insert_session(&oauth_session.row)
            .map_err(HttpError::worker)?;
        oauth_token_response(
            &oauth_session.tokens,
            &authorization_code.scope,
            account.did.as_str(),
            &oauth_session.dpop_nonce,
        )
        .map_err(HttpError::worker)
    }

    async fn oauth_refresh_token(
        &self,
        req: &Request,
        client_id: &str,
        refresh_token: &str,
        client_auth: &OAuthClientAuth,
    ) -> Result<Response, HttpError> {
        let now = current_unix_time();
        let claims = match verify_token(
            &token_secret_from_env(&self.env)?,
            refresh_token,
            REFRESH_SCOPE,
            now,
        ) {
            Ok(claims) => claims,
            Err(_) => {
                return oauth_error_response(400, "invalid_grant", "invalid refresh token")
                    .map_err(HttpError::worker);
            }
        };
        if claims.client_id.as_deref() != Some(client_id) {
            return oauth_error_response(
                400,
                "invalid_grant",
                "client_id did not match refresh token",
            )
            .map_err(HttpError::worker);
        }
        let Some(scope) = claims.oauth_scope.as_deref() else {
            return oauth_error_response(
                400,
                "invalid_grant",
                "refresh token is not an OAuth token",
            )
            .map_err(HttpError::worker);
        };
        let Some(dpop_jkt) = claims.dpop_jkt.as_deref() else {
            return oauth_error_response(400, "invalid_grant", "refresh token is not DPoP-bound")
                .map_err(HttpError::worker);
        };
        let dpop_proof =
            match verify_request_dpop(req, Some(dpop_jkt), claims.dpop_nonce.as_deref(), None) {
                Ok(proof) => proof,
                Err(error) => {
                    return oauth_dpop_error_response(error, claims.dpop_nonce.as_deref())
                        .map_err(HttpError::worker);
                }
            };
        let store = self.store();
        self.remember_dpop_proof(&store, &dpop_proof, now)?;
        let Some(session) = store
            .get_session_by_refresh_jti(&claims.jti)
            .map_err(HttpError::worker)?
        else {
            return oauth_error_response(400, "invalid_grant", "refresh token is no longer active")
                .map_err(HttpError::worker);
        };
        if !session.active {
            return oauth_error_response(400, "invalid_grant", "refresh token is no longer active")
                .map_err(HttpError::worker);
        }
        let expected_client_auth = OAuthClientAuthBinding::from_parts(
            &session.client_auth_method,
            session.client_auth_kid.clone(),
            session.client_auth_alg.clone(),
            session.client_auth_jkt.clone(),
        )?;
        let issuer = request_origin(&req.url().map_err(HttpError::worker)?);
        self.validate_oauth_client_auth(
            client_id,
            None,
            scope,
            client_auth,
            Some(&expected_client_auth),
            &issuer,
        )
        .await?;
        let Some(account) = store
            .get_account_by_did(&session.did)
            .map_err(HttpError::worker)?
            .filter(|account| account.active)
        else {
            return oauth_error_response(
                400,
                "invalid_grant",
                "authorization account is unavailable",
            )
            .map_err(HttpError::worker);
        };
        let oauth_session = self.create_oauth_session_for_account(
            &account,
            client_id,
            scope,
            dpop_jkt,
            &expected_client_auth,
            Some(session.session_id),
        )?;
        store
            .rotate_session_refresh(
                &oauth_session.row.session_id,
                &oauth_session.row.refresh_jti,
            )
            .map_err(HttpError::worker)?;
        oauth_token_response(
            &oauth_session.tokens,
            scope,
            account.did.as_str(),
            &oauth_session.dpop_nonce,
        )
        .map_err(HttpError::worker)
    }

    fn xrpc_subscribe_repos(
        &self,
        req: &Request,
        url: &worker::Url,
    ) -> Result<Response, HttpError> {
        let upgrade = req
            .headers()
            .get("upgrade")
            .map_err(HttpError::worker)?
            .unwrap_or_default();
        if !upgrade.eq_ignore_ascii_case("websocket") {
            return json_response(
                426,
                &json!({
                    "error": "UpgradeRequired",
                    "message": "com.atproto.sync.subscribeRepos requires a WebSocket upgrade",
                }),
            )
            .map_err(HttpError::worker);
        }

        let params = query_pairs(url);
        let requested_cursor = optional_param(&params, "cursor")
            .filter(|value| !value.is_empty())
            .map(|value| {
                value.parse::<i64>().map_err(|_| {
                    HttpError::new(
                        400,
                        format!("invalid cursor `{value}`: expected integer seq"),
                    )
                })
            })
            .transpose()?;
        if requested_cursor.is_some_and(|cursor| cursor < 0) {
            return Err(HttpError::new(
                400,
                "cursor must be zero or a positive integer",
            ));
        }
        let store = self.store();
        let max_seq = store.max_event_seq().map_err(HttpError::worker)?;
        let replay_limit = firehose_replay_limit_from_env(&self.env)?;
        let oldest_replay_cursor = store
            .oldest_event_replay_cursor(replay_limit)
            .map_err(HttpError::worker)?;

        let pair = WebSocketPair::new().map_err(HttpError::worker)?;
        self.state.accept_web_socket(&pair.server);

        if let Some(cursor) = requested_cursor {
            if cursor > max_seq {
                pair.server
                    .send_with_bytes(subscribe_error_frame(
                        "FutureCursor",
                        Some("cursor is ahead of the current stream sequence"),
                    )?)
                    .map_err(HttpError::worker)?;
                pair.server
                    .close(Some(1008), Some("FutureCursor"))
                    .map_err(HttpError::worker)?;
                return Response::from_websocket(pair.client).map_err(HttpError::worker);
            }
            let mut replay_cursor = cursor;
            if cursor == 0 {
                replay_cursor = oldest_replay_cursor;
            } else if cursor < oldest_replay_cursor {
                pair.server
                    .send_with_bytes(subscribe_info_frame(
                        "OutdatedCursor",
                        Some("cursor is older than the available replay window"),
                    )?)
                    .map_err(HttpError::worker)?;
                replay_cursor = oldest_replay_cursor;
            }
            self.send_subscribe_replay(&pair.server, replay_cursor, max_seq, replay_limit)?;
        }

        Response::from_websocket(pair.client).map_err(HttpError::worker)
    }

    fn send_subscribe_replay(
        &self,
        socket: &WebSocket,
        mut cursor: i64,
        max_seq: i64,
        replay_limit: usize,
    ) -> Result<(), HttpError> {
        let store = self.store();
        let mut remaining = replay_limit;
        while cursor < max_seq && remaining > 0 {
            let events = store
                .list_events_after_until(
                    cursor,
                    max_seq,
                    remaining.min(FIREHOSE_REPLAY_BATCH_LIMIT),
                )
                .map_err(HttpError::worker)?;
            if events.is_empty() {
                break;
            }
            for event in events {
                cursor = event.seq;
                let frame = subscribe_event_frame(&event)?;
                socket.send_with_bytes(frame).map_err(HttpError::worker)?;
                remaining = remaining.saturating_sub(1);
            }
        }
        Ok(())
    }

    async fn internal_upsert_repo(&self, req: &mut Request) -> Result<Response, HttpError> {
        let body: DirectoryUpsertRepoRequest = req.json().await.map_err(HttpError::worker)?;
        let records = body.records.map(validate_repo_paths).transpose()?;
        let row = DirectoryRepoRow {
            did: Did::new(body.did).map_err(HttpError::bad_request)?,
            handle: body.handle,
            repo_name: body.repo_name,
            head: parse_cid(&body.head).map_err(HttpError::bad_request)?,
            rev: RepoRev::new(body.rev).map_err(HttpError::bad_request)?,
            active: body.active.unwrap_or(true),
        };
        let store = self.store();
        store.upsert_repo(&row).map_err(HttpError::worker)?;
        if let Some(records) = &records {
            store
                .replace_repo_record_paths(&row.did, records)
                .map_err(HttpError::worker)?;
        }
        let stored_event = if let Some(event) = body.event {
            let event_type = event.event_type;
            let blocks = BASE64_STANDARD
                .decode(event.blocks_base64)
                .map_err(HttpError::bad_request)?;
            let event_record_paths = repo_record_path_ops_from_commit_ops(&event.ops)?;
            let event = DirectoryCommitEventInput {
                did: row.did.clone(),
                commit_cid: row.head,
                rev: row.rev.clone(),
                since: event
                    .since
                    .map(RepoRev::new)
                    .transpose()
                    .map_err(HttpError::bad_request)?,
                prev_data: event
                    .prev_data
                    .map(|cid| parse_cid(&cid))
                    .transpose()
                    .map_err(HttpError::bad_request)?,
                blocks,
                ops_json: to_string(&event.ops).map_err(HttpError::worker)?,
                blobs_json: to_string(&event.blobs.unwrap_or_default())
                    .map_err(HttpError::worker)?,
            };
            let stored = match event_type {
                DirectoryCommitEventType::Sync => {
                    store.append_sync_event(&event).map_err(HttpError::worker)?
                }
                DirectoryCommitEventType::Commit => store
                    .append_commit_event(&event)
                    .map_err(HttpError::worker)?,
            };
            if records.is_none() {
                store
                    .upsert_repo_record_paths(&row.did, &event_record_paths.upserts)
                    .map_err(HttpError::worker)?;
                store
                    .delete_repo_record_paths(&row.did, &event_record_paths.deletes)
                    .map_err(HttpError::worker)?;
            }
            Some(stored)
        } else {
            None
        };
        if let Some(event) = &stored_event {
            self.broadcast_repo_event(event)?;
        }

        json_response(
            200,
            &json!({
                "ok": true,
                "repo": directory_repo_json(row),
                "seq": stored_event.as_ref().map(|event| event.seq),
            }),
        )
        .map_err(HttpError::worker)
    }

    fn broadcast_repo_event(&self, event: &DirectoryEventRow) -> Result<(), HttpError> {
        let frame = subscribe_event_frame(event)?;
        for socket in self.state.get_websockets() {
            let _ = socket.send_with_bytes(&frame);
        }
        Ok(())
    }

    async fn fetch_internal_repo_control(
        &self,
        url: &worker::Url,
        repo_name: &str,
        method: Method,
        action: InternalRepoControlAction,
        body: Option<&Value>,
    ) -> Result<Response, HttpError> {
        let namespace = self
            .env
            .durable_object("REPO_OBJECTS")
            .map_err(HttpError::worker)?;
        let id = namespace
            .id_from_name(repo_name)
            .map_err(HttpError::worker)?;
        let stub = id.get_stub().map_err(HttpError::worker)?;
        let headers = Headers::new();
        headers
            .set("x-pds-admin-token", &admin_token_from_env(&self.env)?)
            .map_err(HttpError::worker)?;
        if body.is_some() {
            headers
                .set("content-type", "application/json")
                .map_err(HttpError::worker)?;
        }
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(headers);
        if let Some(body) = body {
            init.with_body(Some(JsValue::from_str(
                &to_string(body).map_err(HttpError::worker)?,
            )));
        }
        let request =
            Request::new_with_init(&internal_repo_control_url(url, repo_name, action), &init)
                .map_err(HttpError::worker)?;
        stub.fetch_with_request(request)
            .await
            .map_err(HttpError::worker)
    }

    async fn internal_repo_control_response(
        &self,
        url: &worker::Url,
        repo_name: &str,
        method: Method,
        action: InternalRepoControlAction,
        body: Option<&Value>,
        failure_prefix: &str,
    ) -> Result<Response, HttpError> {
        let mut response = self
            .fetch_internal_repo_control(url, repo_name, method, action, body)
            .await?;
        if !(200..=299).contains(&response.status_code()) {
            let text = response.text().await.unwrap_or_else(|_| String::new());
            return Err(HttpError::new(
                response.status_code(),
                format!("{failure_prefix}: {text}"),
            ));
        }
        Ok(response)
    }

    async fn internal_repo_control_json<T: DeserializeOwned>(
        &self,
        url: &worker::Url,
        repo_name: &str,
        method: Method,
        action: InternalRepoControlAction,
        body: Option<&Value>,
        failure_prefix: &str,
    ) -> Result<T, HttpError> {
        let mut response = self
            .internal_repo_control_response(url, repo_name, method, action, body, failure_prefix)
            .await?;
        response.json().await.map_err(HttpError::worker)
    }

    async fn internal_initialize_account_repo(
        &self,
        url: &worker::Url,
        repo_name: &str,
        did: &str,
        handle: &str,
        signing_key_p256_hex: &str,
    ) -> Result<InternalInitRepoResponse, HttpError> {
        let body = json!({
            "did": did,
            "handle": handle,
            "rev": generated_initial_repo_rev()?.to_string(),
            "signingKeyP256Hex": signing_key_p256_hex,
            "reset": false,
            "notifyDirectory": false,
        });
        self.internal_repo_control_json(
            url,
            repo_name,
            Method::Post,
            InternalRepoControlAction::Init,
            Some(&body),
            "failed to initialize repo",
        )
        .await
    }

    async fn internal_reset_account_repo(
        &self,
        url: &worker::Url,
        repo_name: &str,
    ) -> Result<(), HttpError> {
        self.internal_repo_control_response(
            url,
            repo_name,
            Method::Post,
            InternalRepoControlAction::Clear,
            None,
            "failed to clear repo",
        )
        .await?;
        Ok(())
    }

    async fn recover_initialized_account_repo(
        &self,
        url: &worker::Url,
        repo_name: &str,
        expected_did: &str,
        expected_handle: &str,
    ) -> Result<InternalInitRepoResponse, HttpError> {
        let status = self.internal_account_repo_status(url, repo_name).await?;
        init_response_from_repo_status(status, expected_did, expected_handle)
    }

    async fn internal_update_account_repo_identity(
        &self,
        url: &worker::Url,
        repo_name: &str,
        handle: &str,
    ) -> Result<(), HttpError> {
        let body = json!({ "handle": handle });
        self.internal_repo_control_response(
            url,
            repo_name,
            Method::Put,
            InternalRepoControlAction::Identity,
            Some(&body),
            "failed to update repo identity",
        )
        .await?;
        Ok(())
    }

    async fn internal_update_account_repo_signing_key(
        &self,
        url: &worker::Url,
        repo_name: &str,
        signing_key_p256_hex: &str,
    ) -> Result<(), HttpError> {
        let body = json!({ "signingKeyP256Hex": signing_key_p256_hex });
        self.internal_repo_control_response(
            url,
            repo_name,
            Method::Put,
            InternalRepoControlAction::SigningKey,
            Some(&body),
            "failed to update repo signing key",
        )
        .await?;
        Ok(())
    }

    async fn internal_account_repo_status(
        &self,
        url: &worker::Url,
        repo_name: &str,
    ) -> Result<InternalRepoStatusResponse, HttpError> {
        self.internal_repo_control_json(
            url,
            repo_name,
            Method::Get,
            InternalRepoControlAction::Status,
            None,
            "failed to read initialized repo status",
        )
        .await
    }

    async fn internal_sign_account_service_auth(
        &self,
        url: &worker::Url,
        repo_name: &str,
        aud: &str,
        lxm: Option<&Nsid>,
        exp: i64,
    ) -> Result<String, HttpError> {
        let mut body = json!({
            "aud": aud,
            "exp": exp,
        });
        if let Some(lxm) = lxm {
            body["lxm"] = json!(lxm.as_str());
        }
        let body: ServiceAuthResponse = self
            .internal_repo_control_json(
                url,
                repo_name,
                Method::Post,
                InternalRepoControlAction::ServiceAuth,
                Some(&body),
                "failed to sign service auth token",
            )
            .await?;
        Ok(body.token)
    }

    fn create_invite_code(
        &self,
        for_account: &Did,
        created_by: &Did,
        use_count: i64,
    ) -> Result<String, HttpError> {
        if !(1..=100).contains(&use_count) {
            return Err(HttpError::new(400, "InvalidUseCount"));
        }
        let account = self.account_by_did(for_account)?;
        if !account.active {
            return Err(HttpError::new(403, "AccountTakedown"));
        }
        if account.invites_disabled {
            return Err(HttpError::new(403, "InvitesDisabled"));
        }
        let code = format!("gsv-{}", random_urlsafe_token::<INVITE_CODE_BYTES>()?);
        self.store()
            .insert_invite_code(&DirectoryInviteCodeInput {
                code: code.clone(),
                available: use_count,
                for_account: for_account.clone(),
                created_by: created_by.clone(),
            })
            .map_err(HttpError::worker)?;
        Ok(code)
    }

    fn ensure_invite_code_usable(
        &self,
        store: &SqlDirectoryStore,
        code: &str,
    ) -> Result<DirectoryInviteCodeRow, HttpError> {
        let invite = store
            .get_invite_code(code)
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(400, "InvalidInviteCode"))?;
        if invite.disabled || invite.available <= 0 {
            return Err(HttpError::new(400, "InvalidInviteCode"));
        }
        let Some(inviter) = store
            .get_account_by_did(&invite.for_account)
            .map_err(HttpError::worker)?
        else {
            return Err(HttpError::new(400, "InvalidInviteCode"));
        };
        if !inviter.active || inviter.invites_disabled {
            return Err(HttpError::new(400, "InvalidInviteCode"));
        }
        Ok(invite)
    }

    fn consume_invite_code(
        &self,
        store: &SqlDirectoryStore,
        code: &str,
        used_by: &Did,
    ) -> Result<(), HttpError> {
        self.ensure_invite_code_usable(store, code)?;
        store
            .consume_invite_code(code, used_by)
            .map_err(HttpError::worker)
    }

    fn invite_code_values(
        &self,
        codes: &[DirectoryInviteCodeRow],
    ) -> Result<Vec<Value>, HttpError> {
        let code_values = codes
            .iter()
            .map(|code| code.code.clone())
            .collect::<Vec<_>>();
        let uses_by_code = self
            .store()
            .list_invite_code_uses_for_codes(&code_values)
            .map_err(HttpError::worker)?;
        Ok(codes
            .iter()
            .map(|code| {
                let uses = uses_by_code
                    .get(&code.code)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                invite_code_json(code, uses)
            })
            .collect())
    }

    fn host_account_did(&self, req: &Request) -> Result<Did, HttpError> {
        let host = request_host(req)?;
        Did::new(format!("did:web:{host}")).map_err(HttpError::bad_request)
    }

    fn account_by_did(&self, did: &Did) -> Result<DirectoryAccountRow, HttpError> {
        self.store()
            .get_account_by_did(did)
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(404, "AccountNotFound"))
    }

    fn account_by_identifier(&self, identifier: &str) -> Result<DirectoryAccountRow, HttpError> {
        let identifier = normalize_at_identifier(identifier);
        self.store()
            .get_account_by_identifier(&identifier)
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(404, "AccountNotFound"))
    }

    fn ensure_account_exists(&self, did: &Did) -> Result<(), HttpError> {
        self.account_by_did(did).map(|_| ())
    }

    fn delete_account_as_admin(&self, did: &Did) -> Result<(), HttpError> {
        let account = self.account_by_did(did)?;
        let store = self.store();
        store
            .delete_sessions_for_did(&account.did)
            .map_err(HttpError::worker)?;
        store
            .delete_app_passwords_for_did(&account.did)
            .map_err(HttpError::worker)?;
        store
            .delete_action_tokens_for_did(&account.did)
            .map_err(HttpError::worker)?;
        self.set_account_active(&account.did, false, Some("deleted"))
    }

    fn take_reserved_signing_key(
        &self,
        did: &Did,
        signing_key: &str,
    ) -> Result<DirectoryReservedSigningKeyRow, HttpError> {
        let reserved = self.lookup_reserved_signing_key(did, signing_key)?;
        self.consume_reserved_signing_key(did, &reserved.signing_key)?;
        Ok(reserved)
    }

    fn lookup_reserved_signing_key(
        &self,
        did: &Did,
        signing_key: &str,
    ) -> Result<DirectoryReservedSigningKeyRow, HttpError> {
        let signing_key = normalize_did_key(signing_key)?;
        let reserved = self
            .store()
            .get_reserved_signing_key(&signing_key)
            .map_err(HttpError::worker)?
            .ok_or_else(|| HttpError::new(400, "InvalidSigningKey"))?;
        if reserved.consumed_at.is_some() {
            return Err(HttpError::new(400, "InvalidSigningKey"));
        }
        if reserved
            .did
            .as_ref()
            .is_some_and(|reserved_did| reserved_did != did)
        {
            return Err(HttpError::new(400, "InvalidSigningKey"));
        }
        let public_key_multibase = public_key_multibase_from_did_key(&signing_key)?;
        if public_key_multibase != reserved.public_key_multibase {
            return Err(HttpError::new(400, "InvalidSigningKey"));
        }
        Ok(reserved)
    }

    fn consume_reserved_signing_key(&self, did: &Did, signing_key: &str) -> Result<(), HttpError> {
        let signing_key = normalize_did_key(signing_key)?;
        self.store()
            .consume_reserved_signing_key(&signing_key, did)
            .map_err(HttpError::worker)?;
        Ok(())
    }

    fn create_session_for_account(
        &self,
        account: &DirectoryAccountRow,
    ) -> Result<CreatedSession, HttpError> {
        let now = current_unix_time();
        let session_id = random_token_id()?;
        let refresh_jti = random_token_id()?;
        let secret = token_secret_from_env(&self.env)?;
        let access_jwt = sign_token(
            &secret,
            &session_claims(
                account.did.as_str(),
                &account.handle,
                &session_id,
                ACCESS_SCOPE,
                now,
                ACCESS_TOKEN_TTL_SECONDS,
            ),
        )
        .map_err(HttpError::auth)?;
        let refresh_jwt = sign_token(
            &secret,
            &session_claims(
                account.did.as_str(),
                &account.handle,
                &refresh_jti,
                REFRESH_SCOPE,
                now,
                REFRESH_TOKEN_TTL_SECONDS,
            ),
        )
        .map_err(HttpError::auth)?;
        Ok(CreatedSession {
            row: DirectorySessionRow {
                session_id,
                did: account.did.clone(),
                refresh_jti,
                active: true,
                client_auth_method: "none".to_string(),
                client_auth_kid: None,
                client_auth_alg: None,
                client_auth_jkt: None,
            },
            tokens: SessionTokens {
                access_jwt,
                refresh_jwt,
            },
        })
    }

    fn create_oauth_session_for_account(
        &self,
        account: &DirectoryAccountRow,
        client_id: &str,
        oauth_scope: &str,
        dpop_jkt: &str,
        client_auth: &OAuthClientAuthBinding,
        session_id: Option<String>,
    ) -> Result<CreatedOAuthSession, HttpError> {
        let now = current_unix_time();
        let session_id = match session_id {
            Some(session_id) => session_id,
            None => random_token_id()?,
        };
        let access_jti = random_token_id()?;
        let refresh_jti = random_token_id()?;
        let dpop_nonce = random_urlsafe_token::<OAUTH_DPOP_NONCE_BYTES>()?;
        let secret = token_secret_from_env(&self.env)?;
        let access_jwt = sign_token(
            &secret,
            &oauth_session_claims(
                account.did.as_str(),
                &account.handle,
                &access_jti,
                ACCESS_SCOPE,
                now,
                ACCESS_TOKEN_TTL_SECONDS,
                client_id,
                oauth_scope,
                dpop_jkt,
                &dpop_nonce,
            ),
        )
        .map_err(HttpError::auth)?;
        let refresh_jwt = sign_token(
            &secret,
            &oauth_session_claims(
                account.did.as_str(),
                &account.handle,
                &refresh_jti,
                REFRESH_SCOPE,
                now,
                REFRESH_TOKEN_TTL_SECONDS,
                client_id,
                oauth_scope,
                dpop_jkt,
                &dpop_nonce,
            ),
        )
        .map_err(HttpError::auth)?;
        Ok(CreatedOAuthSession {
            row: DirectorySessionRow {
                session_id,
                did: account.did.clone(),
                refresh_jti,
                active: true,
                client_auth_method: client_auth.method_str().to_string(),
                client_auth_kid: client_auth.kid.clone(),
                client_auth_alg: client_auth.alg.clone(),
                client_auth_jkt: client_auth.jkt.clone(),
            },
            tokens: SessionTokens {
                access_jwt,
                refresh_jwt,
            },
            dpop_nonce,
        })
    }

    fn require_bearer_claims(
        &self,
        req: &Request,
        scope: &str,
    ) -> Result<crate::auth::TokenClaims, HttpError> {
        let presented = authorization_token(req)?;
        verify_token(
            &token_secret_from_env(&self.env)?,
            &presented.token,
            scope,
            current_unix_time(),
        )
        .map_err(HttpError::auth)
        .and_then(|claims| {
            if let Some(jkt) = claims.dpop_jkt.as_deref() {
                if presented.scheme != AuthScheme::Dpop {
                    return Err(HttpError::new(
                        401,
                        "DPoP-bound token requires DPoP authorization",
                    ));
                }
                let proof = verify_request_dpop(
                    req,
                    Some(jkt),
                    claims.dpop_nonce.as_deref(),
                    Some(&presented.token),
                )
                .map_err(|error| HttpError::new(401, error.to_string()))?;
                let store = self.store();
                self.remember_dpop_proof(&store, &proof, current_unix_time())?;
            }
            Ok(claims)
        })
    }

    fn account_for_claims(
        &self,
        claims: &crate::auth::TokenClaims,
    ) -> Result<DirectoryAccountRow, HttpError> {
        let account = self.account_for_claims_allow_inactive(claims)?;
        if !account.active {
            return Err(HttpError::new(403, "AccountTakedown"));
        }
        Ok(account)
    }

    fn account_for_claims_allow_deactivated(
        &self,
        claims: &crate::auth::TokenClaims,
    ) -> Result<DirectoryAccountRow, HttpError> {
        let account = self.account_for_claims_allow_inactive(claims)?;
        ensure_account_authentication_allowed(&account)?;
        Ok(account)
    }

    fn account_for_claims_allow_inactive(
        &self,
        claims: &crate::auth::TokenClaims,
    ) -> Result<DirectoryAccountRow, HttpError> {
        let did = Did::new(claims.sub.clone()).map_err(HttpError::bad_request)?;
        let Some(account) = self
            .store()
            .get_account_by_did(&did)
            .map_err(HttpError::worker)?
        else {
            return Err(HttpError::new(401, "InvalidToken"));
        };
        Ok(account)
    }

    fn verify_account_or_app_password(
        &self,
        account: &DirectoryAccountRow,
        password: &str,
    ) -> Result<bool, HttpError> {
        if verify_password(password, &account.password_hash).map_err(HttpError::auth)? {
            return Ok(true);
        }
        for app_password in self
            .store()
            .list_app_passwords(&account.did)
            .map_err(HttpError::worker)?
        {
            if verify_password(password, &app_password.password_hash).map_err(HttpError::auth)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn issue_action_token(
        &self,
        did: &Did,
        purpose: &str,
        email: Option<&str>,
    ) -> Result<String, HttpError> {
        let now = current_unix_time();
        let token = random_urlsafe_token::<ACTION_TOKEN_BYTES>()?;
        self.store()
            .purge_expired_action_tokens(now)
            .map_err(HttpError::worker)?;
        self.store()
            .insert_action_token(&DirectoryActionTokenInput {
                token_digest: action_token_digest(&token),
                did: did.clone(),
                purpose: purpose.to_string(),
                email: email.map(|value| value.to_string()),
                expires_at: now.saturating_add(ACTION_TOKEN_TTL_SECONDS),
            })
            .map_err(HttpError::worker)?;
        Ok(token)
    }

    fn validate_action_token(
        &self,
        purpose: &str,
        token: &str,
    ) -> Result<DirectoryActionTokenRow, HttpError> {
        let now = current_unix_time();
        let digest = action_token_digest(token);
        let Some(row) = self
            .store()
            .get_action_token(purpose, &digest)
            .map_err(HttpError::worker)?
        else {
            return Err(HttpError::new(400, "InvalidToken"));
        };
        if row.consumed_at.is_some() {
            return Err(HttpError::new(400, "InvalidToken"));
        }
        if row.expires_at <= now {
            return Err(HttpError::new(400, "ExpiredToken"));
        }
        Ok(row)
    }

    fn consume_validated_action_token(
        &self,
        token: &DirectoryActionTokenRow,
    ) -> Result<(), HttpError> {
        self.store()
            .consume_action_token(&token.token_digest, current_unix_time())
            .map_err(HttpError::worker)
    }

    async fn validate_oauth_par_client(
        &self,
        request: &crate::oauth::PushedAuthorizationRequest,
        issuer: &str,
    ) -> Result<OAuthClientAuthBinding, HttpError> {
        self.validate_oauth_client_auth(
            &request.client_id,
            Some(&request.redirect_uri),
            &request.scope,
            &request.client_auth,
            None,
            issuer,
        )
        .await
    }

    async fn validate_oauth_client_auth(
        &self,
        client_id: &str,
        redirect_uri: Option<&str>,
        scope: &str,
        client_auth: &OAuthClientAuth,
        expected: Option<&OAuthClientAuthBinding>,
        issuer: &str,
    ) -> Result<OAuthClientAuthBinding, HttpError> {
        let metadata = if is_localhost_client_id(client_id) {
            None
        } else {
            Some(fetch_oauth_client_metadata(client_id).await?)
        };
        if let Some(redirect_uri) = redirect_uri {
            validate_client_metadata(client_id, metadata.as_ref(), redirect_uri, scope)
                .map_err(HttpError::bad_request)?;
        }

        let method = if let Some(metadata) = metadata.as_ref() {
            if metadata.get("client_id").and_then(Value::as_str) != Some(client_id) {
                return Err(HttpError::bad_request(
                    OAuthRequestError::InvalidParameter {
                        parameter: "client_id",
                        message: "client metadata client_id did not match".to_string(),
                    },
                ));
            }
            client_auth_method_from_metadata(metadata).map_err(HttpError::bad_request)?
        } else {
            OAuthClientAuthMethod::None
        };
        if method != client_auth.method() {
            return Err(HttpError::new(
                401,
                format!(
                    "OAuth client authentication method `{}` did not match client metadata `{}`",
                    client_auth.method().as_str(),
                    method.as_str()
                ),
            ));
        }

        let binding = match client_auth {
            OAuthClientAuth::None => OAuthClientAuthBinding::none(),
            OAuthClientAuth::PrivateKeyJwt { assertion } => {
                let metadata = metadata.as_ref().ok_or_else(|| {
                    HttpError::new(401, "localhost clients cannot use private_key_jwt")
                })?;
                let jwks = self.fetch_oauth_client_jwks(metadata).await?;
                let verified = verify_private_key_jwt(
                    assertion,
                    client_id,
                    issuer,
                    &jwks,
                    current_unix_time(),
                )
                .map_err(HttpError::bad_request)?;
                self.remember_oauth_client_assertion(client_id, &verified)?;
                OAuthClientAuthBinding::from_verified(verified)
            }
        };
        if let Some(expected) = expected {
            binding.ensure_matches(expected)?;
        }
        Ok(binding)
    }

    async fn fetch_oauth_client_jwks(&self, metadata: &Value) -> Result<Value, HttpError> {
        let fetched_jwks =
            if let Some(jwks_uri) = client_jwks_uri(metadata).map_err(HttpError::bad_request)? {
                Some(fetch_oauth_jwks(&jwks_uri).await?)
            } else {
                None
            };
        client_jwks_from_metadata(metadata, fetched_jwks.as_ref()).map_err(HttpError::bad_request)
    }

    fn remember_oauth_client_assertion(
        &self,
        client_id: &str,
        assertion: &crate::oauth::VerifiedClientAssertion,
    ) -> Result<(), HttpError> {
        let now = current_unix_time();
        let store = self.store();
        store
            .purge_expired_oauth_client_jtis(now)
            .map_err(HttpError::worker)?;
        if store
            .has_oauth_client_jti(client_id, &assertion.jti)
            .map_err(HttpError::worker)?
        {
            return Err(HttpError::new(401, "OAuth client assertion replay"));
        }
        store
            .insert_oauth_client_jti(client_id, &assertion.jti, assertion.expires_at)
            .map_err(HttpError::worker)?;
        Ok(())
    }

    fn remember_dpop_proof(
        &self,
        store: &SqlDirectoryStore,
        proof: &VerifiedDpopProof,
        now: i64,
    ) -> Result<(), HttpError> {
        store
            .purge_expired_dpop_jtis(now)
            .map_err(HttpError::worker)?;
        if store
            .has_dpop_jti(&proof.jkt, &proof.jti)
            .map_err(HttpError::worker)?
        {
            return Err(HttpError::new(400, "DPoP proof replay"));
        }
        store
            .insert_dpop_jti(&proof.jkt, &proof.jti, now.saturating_add(600))
            .map_err(HttpError::worker)?;
        Ok(())
    }
}
