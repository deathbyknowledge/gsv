use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::rc::Rc;

use base64::engine::general_purpose::{
    STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD,
};
use base64::Engine as _;
use futures_util::StreamExt;
use serde::de::{DeserializeOwned, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{from_str, json, to_string, to_vec, Value};
use sha2::{Digest, Sha256};
use wasm_bindgen::{JsCast, JsValue};
use worker::{
    event, Context, DurableObject, Env, Fetch, FixedLengthStream, Headers, HttpMetadata, Method,
    Request, RequestInit, Response, ResponseBody, SqlStorage, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair,
};

use crate::atproto_resolver::{
    did_document_claims_handle, did_document_pds_endpoint, did_web_document_url,
    ensure_did_document_id, handle_did_txt_name, lexicon_authority_did_override,
    lexicon_authority_domain, lexicon_txt_name, prefixed_txt_values, validate_handle_syntax,
};
use crate::auth::{
    hash_password, oauth_session_claims, session_claims, sign_token, verify_password, verify_token,
    ACCESS_SCOPE, REFRESH_SCOPE,
};
use crate::car::{decode_car, encode_car, encode_car_from_store, CarBlock, CarError};
use crate::cbor::encode_dag_cbor;
use crate::cid::{parse_cid, raw_cid, raw_cid_from_sha256_digest};
use crate::commit::{CommitBlock, Did, RepoRev};
use crate::data_model::{Nsid, RecordKey, RepoPath};
use crate::do_store::{
    DirectoryAccountRow, DirectoryActionTokenInput, DirectoryActionTokenRow,
    DirectoryCommitEventInput, DirectoryEventRow, DirectoryInviteCodeInput, DirectoryInviteCodeRow,
    DirectoryInviteCodeUseRow, DirectoryOauthAuthorizationCodeInput, DirectoryOauthParRequestInput,
    DirectoryOauthParRequestRow, DirectoryRepoRow, DirectoryReservedSigningKeyInput,
    DirectoryReservedSigningKeyRow, DirectorySessionRow, RepoBlobRow, RepoCommitEventInput,
    RepoIdentityRow, RepoStateRow, SqlDirectoryStore, SqlRepoStore,
};
use crate::dpop::{dpop_htu, verify_dpop_proof, DpopError, VerifiedDpopProof};
use crate::identity::{IdentityError, RepoSigningKey};
use crate::lexicon::{self, RecordValidationStatus};
use crate::oauth::{
    authorization_server_metadata, client_auth_method_from_metadata, client_jwks_from_metadata,
    client_jwks_uri, is_localhost_client_id, is_oauth_well_known_path, parse_authorization_form,
    parse_authorization_request, parse_pushed_authorization_request, parse_token_request,
    protected_resource_metadata, validate_client_metadata, verify_private_key_jwt, OAuthClientAuth,
    OAuthClientAuthMethod, OAuthRequestError, TokenRequest, OAUTH_AUTHORIZATION_SERVER_PATH,
    OAUTH_AUTHORIZE_PATH, OAUTH_PAR_EXPIRES_IN_SECONDS, OAUTH_PAR_PATH,
    OAUTH_PROTECTED_RESOURCE_PATH, OAUTH_REQUEST_URI_PREFIX, OAUTH_TOKEN_PATH,
};
use crate::plc::{
    create_plc_operation, recommended_did_credentials_body, sign_plc_update_operation,
    validate_submitted_plc_operation, PlcError, SignPlcOperationRequest,
};
use crate::repo::{
    RepoError, RepoMutation, RepoOperation, RepoOperationAction, RepoWrite, SignedRepository,
};
use crate::repo_import::{
    extract_record_blob_refs as extract_import_record_blob_refs, validate_imported_repo,
    RepoImportError,
};
use crate::service_auth::verify_service_auth_jwt;
use crate::storage::{RepoBlockStore, RepoRecordIndex, StorageError};
use crate::xrpc::{
    at_uri, optional_param, parse_get_blocks_params, parse_list_records_params,
    repo_object_name_from_identifier, required_param, route_xrpc_method, strong_ref,
    ADMIN_DELETE_ACCOUNT, ADMIN_DISABLE_ACCOUNT_INVITES, ADMIN_DISABLE_INVITE_CODES,
    ADMIN_ENABLE_ACCOUNT_INVITES, ADMIN_GET_ACCOUNT_INFO, ADMIN_GET_ACCOUNT_INFOS,
    ADMIN_GET_INVITE_CODES, ADMIN_GET_SUBJECT_STATUS, ADMIN_SEARCH_ACCOUNTS, ADMIN_SEND_EMAIL,
    ADMIN_UPDATE_ACCOUNT_EMAIL, ADMIN_UPDATE_ACCOUNT_HANDLE, ADMIN_UPDATE_ACCOUNT_PASSWORD,
    ADMIN_UPDATE_ACCOUNT_SIGNING_KEY, ADMIN_UPDATE_SUBJECT_STATUS,
    IDENTITY_GET_RECOMMENDED_DID_CREDENTIALS, IDENTITY_REFRESH_IDENTITY,
    IDENTITY_REQUEST_PLC_OPERATION_SIGNATURE, IDENTITY_RESOLVE_DID, IDENTITY_RESOLVE_HANDLE,
    IDENTITY_RESOLVE_IDENTITY, IDENTITY_SIGN_PLC_OPERATION, IDENTITY_SUBMIT_PLC_OPERATION,
    IDENTITY_UPDATE_HANDLE, LEXICON_RESOLVE_LEXICON, REPO_APPLY_WRITES, REPO_CREATE_RECORD,
    REPO_DELETE_RECORD, REPO_DESCRIBE_REPO, REPO_GET_RECORD, REPO_IMPORT_REPO,
    REPO_LIST_MISSING_BLOBS, REPO_LIST_RECORDS, REPO_PUT_RECORD, REPO_UPLOAD_BLOB,
    SERVER_ACTIVATE_ACCOUNT, SERVER_CHANGE_PASSWORD, SERVER_CHECK_ACCOUNT_STATUS,
    SERVER_CONFIRM_EMAIL, SERVER_CREATE_ACCOUNT, SERVER_CREATE_APP_PASSWORD,
    SERVER_CREATE_INVITE_CODE, SERVER_CREATE_INVITE_CODES, SERVER_CREATE_SESSION,
    SERVER_DEACTIVATE_ACCOUNT, SERVER_DELETE_ACCOUNT, SERVER_DELETE_SESSION,
    SERVER_DESCRIBE_SERVER, SERVER_GET_ACCOUNT_INVITE_CODES, SERVER_GET_SERVICE_AUTH,
    SERVER_GET_SESSION, SERVER_LIST_APP_PASSWORDS, SERVER_REFRESH_SESSION,
    SERVER_REQUEST_ACCOUNT_DELETE, SERVER_REQUEST_EMAIL_CONFIRMATION, SERVER_REQUEST_EMAIL_UPDATE,
    SERVER_REQUEST_PASSWORD_RESET, SERVER_RESERVE_SIGNING_KEY, SERVER_RESET_PASSWORD,
    SERVER_REVOKE_APP_PASSWORD, SERVER_UPDATE_EMAIL, SYNC_GET_BLOB, SYNC_GET_BLOCKS,
    SYNC_GET_CHECKOUT, SYNC_GET_HEAD, SYNC_GET_HOST_STATUS, SYNC_GET_LATEST_COMMIT,
    SYNC_GET_RECORD, SYNC_GET_REPO, SYNC_GET_REPO_STATUS, SYNC_LIST_BLOBS, SYNC_LIST_HOSTS,
    SYNC_LIST_REPOS, SYNC_LIST_REPOS_BY_COLLECTION, SYNC_SUBSCRIBE_REPOS,
};
use crate::xrpc::{XrpcError, XrpcRoute};

mod config;
mod directory_object;
mod firehose;
mod http;
mod identity_support;
mod models;
mod repo_object;
mod routing;

use config::*;
use firehose::*;
use http::*;
use identity_support::*;
use models::*;
use routing::*;

#[event(fetch)]
async fn fetch(req: Request, env: worker::Env, _ctx: Context) -> worker::Result<Response> {
    let url = req.url()?;
    let parts = url
        .path()
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();

    if req.method() == Method::Options {
        return empty_response(204);
    }

    if req.method() == Method::Get && url.path() == "/xrpc/_health" {
        return health_response();
    }

    if req.method() == Method::Get && is_oauth_well_known_path(url.path()) {
        return oauth_metadata_response(&url);
    }

    if parts.len() >= 2 && parts[0] == "oauth" {
        let Some(host) = url.host_str() else {
            return json_response(
                400,
                &json!({
                    "error": "InvalidRequest",
                    "message": "request host is required",
                }),
            );
        };
        let namespace = env.durable_object("DIRECTORY_OBJECTS")?;
        let id = namespace.id_from_name(host)?;
        let stub = id.get_stub()?;
        return stub.fetch_with_request(req).await;
    }

    if req.method() == Method::Get && is_host_identity_path(url.path()) {
        let Some(host) = url.host_str() else {
            return json_response(
                400,
                &json!({
                    "error": "InvalidRequest",
                    "message": "request host is required",
                }),
            );
        };
        let namespace = env.durable_object("REPO_OBJECTS")?;
        let id = namespace.id_from_name(host)?;
        let stub = id.get_stub()?;
        return stub.fetch_with_request(req).await;
    }

    if parts.len() >= 2 && parts[0] == "xrpc" && !parts[1].is_empty() {
        let query = query_pairs(&url);
        return match route_xrpc_method(parts[1], &query) {
            Ok(XrpcRoute::Worker) => handle_worker_xrpc(req.method(), parts[1], &url),
            Ok(XrpcRoute::DirectoryObject) => {
                let Some(host) = url.host_str() else {
                    return json_response(
                        400,
                        &json!({
                            "error": "InvalidRequest",
                            "message": "request host is required",
                        }),
                    );
                };
                let namespace = env.durable_object("DIRECTORY_OBJECTS")?;
                let id = namespace.id_from_name(host)?;
                let stub = id.get_stub()?;
                stub.fetch_with_request(req).await
            }
            Ok(XrpcRoute::RepoObjectByJsonBodyRepo) => forward_xrpc_json_body_repo(req, &env).await,
            Ok(XrpcRoute::RepoObjectByBearerSubject) => {
                forward_xrpc_bearer_subject(req, &env).await
            }
            Ok(XrpcRoute::RepoObject { name }) => {
                let namespace = env.durable_object("REPO_OBJECTS")?;
                let id = namespace.id_from_name(&name)?;
                let stub = id.get_stub()?;
                stub.fetch_with_request(req).await
            }
            Ok(XrpcRoute::Unsupported) => json_response(
                404,
                &json!({
                    "error": "MethodNotFound",
                    "message": format!("unsupported XRPC method `{}`", parts[1]),
                }),
            ),
            Err(error) => json_response(
                400,
                &json!({
                    "error": "InvalidRequest",
                    "message": error.to_string(),
                }),
            ),
        };
    }

    if url.path() != "/" {
        return json_response(
            404,
            &json!({
                "error": "not found",
            }),
        );
    }

    json_response(
        200,
        &json!({
            "name": "gsv-pds",
            "version": env!("CARGO_PKG_VERSION"),
            "status": "ready",
            "routes": {
                "oauthProtectedResource": "GET /.well-known/oauth-protected-resource",
                "oauthAuthorizationServer": "GET /.well-known/oauth-authorization-server",
                "oauthPar": "POST /oauth/par",
                "oauthAuthorize": "GET /oauth/authorize",
                "oauthToken": "POST /oauth/token",
                "xrpcDescribeServer": "GET /xrpc/com.atproto.server.describeServer",
                "xrpcResolveHandle": "GET /xrpc/com.atproto.identity.resolveHandle?handle=:handle",
                "xrpcResolveDid": "GET /xrpc/com.atproto.identity.resolveDid?did=:did",
                "xrpcResolveIdentity": "GET /xrpc/com.atproto.identity.resolveIdentity?identifier=:handle_or_did",
                "xrpcGetRecommendedDidCredentials": "GET /xrpc/com.atproto.identity.getRecommendedDidCredentials",
                "xrpcRequestPlcOperationSignature": "POST /xrpc/com.atproto.identity.requestPlcOperationSignature",
                "xrpcSignPlcOperation": "POST /xrpc/com.atproto.identity.signPlcOperation",
                "xrpcSubmitPlcOperation": "POST /xrpc/com.atproto.identity.submitPlcOperation",
                "xrpcResolveLexicon": "GET /xrpc/com.atproto.lexicon.resolveLexicon?nsid=:nsid",
                "xrpcCreateAccount": "POST /xrpc/com.atproto.server.createAccount",
                "xrpcCreateSession": "POST /xrpc/com.atproto.server.createSession",
                "xrpcGetSession": "GET /xrpc/com.atproto.server.getSession",
                "xrpcRefreshSession": "POST /xrpc/com.atproto.server.refreshSession",
                "xrpcDeleteSession": "POST /xrpc/com.atproto.server.deleteSession",
                "xrpcChangePassword": "POST /xrpc/com.atproto.server.changePassword",
                "xrpcRequestPasswordReset": "POST /xrpc/com.atproto.server.requestPasswordReset",
                "xrpcResetPassword": "POST /xrpc/com.atproto.server.resetPassword",
                "xrpcRequestEmailConfirmation": "POST /xrpc/com.atproto.server.requestEmailConfirmation",
                "xrpcConfirmEmail": "POST /xrpc/com.atproto.server.confirmEmail",
                "xrpcRequestEmailUpdate": "POST /xrpc/com.atproto.server.requestEmailUpdate",
                "xrpcUpdateEmail": "POST /xrpc/com.atproto.server.updateEmail",
                "xrpcRequestAccountDelete": "POST /xrpc/com.atproto.server.requestAccountDelete",
                "xrpcDeleteAccount": "POST /xrpc/com.atproto.server.deleteAccount",
                "xrpcDeactivateAccount": "POST /xrpc/com.atproto.server.deactivateAccount",
                "xrpcActivateAccount": "POST /xrpc/com.atproto.server.activateAccount",
                "xrpcCheckAccountStatus": "GET /xrpc/com.atproto.server.checkAccountStatus",
                "xrpcGetServiceAuth": "GET /xrpc/com.atproto.server.getServiceAuth?aud=:did",
                "xrpcReserveSigningKey": "POST /xrpc/com.atproto.server.reserveSigningKey",
                "xrpcCreateInviteCode": "POST /xrpc/com.atproto.server.createInviteCode",
                "xrpcCreateInviteCodes": "POST /xrpc/com.atproto.server.createInviteCodes",
                "xrpcGetAccountInviteCodes": "GET /xrpc/com.atproto.server.getAccountInviteCodes",
                "xrpcCreateAppPassword": "POST /xrpc/com.atproto.server.createAppPassword",
                "xrpcListAppPasswords": "GET /xrpc/com.atproto.server.listAppPasswords",
                "xrpcRevokeAppPassword": "POST /xrpc/com.atproto.server.revokeAppPassword",
                "xrpcAdminDeleteAccount": "POST /xrpc/com.atproto.admin.deleteAccount",
                "xrpcAdminDisableAccountInvites": "POST /xrpc/com.atproto.admin.disableAccountInvites",
                "xrpcAdminDisableInviteCodes": "POST /xrpc/com.atproto.admin.disableInviteCodes",
                "xrpcAdminEnableAccountInvites": "POST /xrpc/com.atproto.admin.enableAccountInvites",
                "xrpcAdminGetAccountInfo": "GET /xrpc/com.atproto.admin.getAccountInfo?did=:did",
                "xrpcAdminGetAccountInfos": "GET /xrpc/com.atproto.admin.getAccountInfos?dids=:did",
                "xrpcAdminGetInviteCodes": "GET /xrpc/com.atproto.admin.getInviteCodes",
                "xrpcAdminGetSubjectStatus": "GET /xrpc/com.atproto.admin.getSubjectStatus?did=:did",
                "xrpcAdminSearchAccounts": "GET /xrpc/com.atproto.admin.searchAccounts",
                "xrpcAdminSendEmail": "POST /xrpc/com.atproto.admin.sendEmail",
                "xrpcAdminUpdateAccountEmail": "POST /xrpc/com.atproto.admin.updateAccountEmail",
                "xrpcAdminUpdateAccountHandle": "POST /xrpc/com.atproto.admin.updateAccountHandle",
                "xrpcAdminUpdateAccountPassword": "POST /xrpc/com.atproto.admin.updateAccountPassword",
                "xrpcAdminUpdateAccountSigningKey": "POST /xrpc/com.atproto.admin.updateAccountSigningKey",
                "xrpcAdminUpdateSubjectStatus": "POST /xrpc/com.atproto.admin.updateSubjectStatus",
                "xrpcDescribeRepo": "GET /xrpc/com.atproto.repo.describeRepo?repo=:repo",
                "xrpcGetRecord": "GET /xrpc/com.atproto.repo.getRecord?repo=:repo&collection=:nsid&rkey=:rkey",
                "xrpcListRecords": "GET /xrpc/com.atproto.repo.listRecords?repo=:repo&collection=:nsid",
                "xrpcCreateRecord": "POST /xrpc/com.atproto.repo.createRecord",
                "xrpcPutRecord": "POST /xrpc/com.atproto.repo.putRecord",
                "xrpcDeleteRecord": "POST /xrpc/com.atproto.repo.deleteRecord",
                "xrpcApplyWrites": "POST /xrpc/com.atproto.repo.applyWrites",
                "xrpcImportRepo": "POST /xrpc/com.atproto.repo.importRepo",
                "xrpcUploadBlob": "POST /xrpc/com.atproto.repo.uploadBlob",
                "xrpcListMissingBlobs": "GET /xrpc/com.atproto.repo.listMissingBlobs",
                "xrpcGetLatestCommit": "GET /xrpc/com.atproto.sync.getLatestCommit?did=:did",
                "xrpcGetHead": "GET /xrpc/com.atproto.sync.getHead?did=:did",
                "xrpcGetRepoStatus": "GET /xrpc/com.atproto.sync.getRepoStatus?did=:did",
                "xrpcListHosts": "GET /xrpc/com.atproto.sync.listHosts",
                "xrpcListRepos": "GET /xrpc/com.atproto.sync.listRepos",
                "xrpcListReposByCollection": "GET /xrpc/com.atproto.sync.listReposByCollection?collection=:nsid",
                "xrpcSubscribeRepos": "GET /xrpc/com.atproto.sync.subscribeRepos",
                "xrpcGetHostStatus": "GET /xrpc/com.atproto.sync.getHostStatus?hostname=:hostname",
                "xrpcListBlobs": "GET /xrpc/com.atproto.sync.listBlobs?did=:did",
                "xrpcGetBlob": "GET /xrpc/com.atproto.sync.getBlob?did=:did&cid=:cid",
                "xrpcGetBlocks": "GET /xrpc/com.atproto.sync.getBlocks?did=:did&cids=:cid",
                "xrpcSyncGetRecord": "GET /xrpc/com.atproto.sync.getRecord?did=:did&collection=:nsid&rkey=:rkey",
                "xrpcGetCheckout": "GET /xrpc/com.atproto.sync.getCheckout?did=:did",
                "xrpcSyncGetRepo": "GET /xrpc/com.atproto.sync.getRepo?did=:did",
                "didWeb": "GET /.well-known/did.json",
                "handleDid": "GET /.well-known/atproto-did"
            }
        }),
    )
}

async fn forward_xrpc_json_body_repo(req: Request, env: &Env) -> worker::Result<Response> {
    match try_forward_xrpc_json_body_repo(req, env).await {
        Ok(response) => Ok(response),
        Err(error) => json_response(
            error.status,
            &xrpc_error_body(&error.message, Some(error.message.as_str())),
        ),
    }
}

async fn try_forward_xrpc_json_body_repo(
    mut req: Request,
    env: &Env,
) -> Result<Response, HttpError> {
    let url = req.url().map_err(HttpError::worker)?.to_string();
    let method = req.method().clone();
    let headers = req.headers().clone();
    let body = req.text().await.map_err(HttpError::worker)?;
    let repo = xrpc_body_repo(&body)?;
    let request = request_with_text_body(&url, method, headers, &body)?;
    forward_request_to_repo_name(env, &repo_object_name_from_identifier(&repo), request).await
}

async fn forward_xrpc_bearer_subject(req: Request, env: &Env) -> worker::Result<Response> {
    match try_forward_xrpc_bearer_subject(req, env).await {
        Ok(response) => Ok(response),
        Err(error) => json_response(
            error.status,
            &xrpc_error_body(&error.message, Some(error.message.as_str())),
        ),
    }
}

async fn try_forward_xrpc_bearer_subject(req: Request, env: &Env) -> Result<Response, HttpError> {
    let presented = authorization_token(&req)?;
    let claims = verify_token(
        &token_secret_from_env(env)?,
        &presented.token,
        ACCESS_SCOPE,
        current_unix_time(),
    )
    .map_err(HttpError::auth)?;
    let did = Did::new(claims.sub).map_err(HttpError::bad_request)?;
    forward_request_to_repo_name(env, &repo_object_name_from_identifier(did.as_str()), req).await
}

async fn forward_request_to_repo_name(
    env: &Env,
    repo_name: &str,
    req: Request,
) -> Result<Response, HttpError> {
    let namespace = env
        .durable_object("REPO_OBJECTS")
        .map_err(HttpError::worker)?;
    let id = namespace
        .id_from_name(repo_name)
        .map_err(HttpError::worker)?;
    let stub = id.get_stub().map_err(HttpError::worker)?;
    stub.fetch_with_request(req)
        .await
        .map_err(HttpError::worker)
}

fn request_with_text_body(
    url: &str,
    method: Method,
    headers: Headers,
    body: &str,
) -> Result<Request, HttpError> {
    let mut init = RequestInit::new();
    init.with_method(method)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(body)));
    Request::new_with_init(url, &init).map_err(HttpError::worker)
}

fn xrpc_body_repo(body: &str) -> Result<String, HttpError> {
    let value: Value = from_str(body).map_err(HttpError::bad_request)?;
    value
        .get("repo")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|repo| !repo.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| HttpError::new(400, "MissingRepo"))
}

fn is_repo_already_initialized_error(error: &HttpError) -> bool {
    error.status == 409 && error.message.contains("repo already initialized")
}

fn init_response_from_repo_status(
    status: InternalRepoStatusResponse,
    expected_did: &str,
    expected_handle: &str,
) -> Result<InternalInitRepoResponse, HttpError> {
    if !status.initialized {
        return Err(HttpError::new(
            409,
            "repo initialization conflict, but repo status is uninitialized",
        ));
    }

    let did = status
        .did
        .ok_or_else(|| HttpError::new(409, "initialized repo status is missing DID"))?;
    if did != expected_did {
        return Err(HttpError::new(
            409,
            "repo already initialized for a different DID",
        ));
    }

    let handle = status
        .handle
        .ok_or_else(|| HttpError::new(409, "initialized repo status is missing handle"))?;
    if handle != expected_handle {
        return Err(HttpError::new(
            409,
            "repo already initialized for a different handle",
        ));
    }

    Ok(InternalInitRepoResponse {
        public_key_multibase: status
            .public_key_multibase
            .ok_or_else(|| HttpError::new(409, "initialized repo status is missing public key"))?,
        latest_commit: status.latest_commit.ok_or_else(|| {
            HttpError::new(409, "initialized repo status is missing latest commit")
        })?,
        latest_rev: status
            .latest_rev
            .ok_or_else(|| HttpError::new(409, "initialized repo status is missing latest rev"))?,
    })
}

fn xrpc_record_mutation_response(
    did: &Did,
    path: &RepoPath,
    mutation: &RepoMutation,
    validation_status: RecordValidationStatus,
) -> Result<Value, HttpError> {
    let record_cid = mutation
        .record_cid
        .ok_or_else(|| HttpError::new(500, "record mutation is missing record cid"))?;
    let record = strong_ref(
        did.as_str(),
        path.collection.as_str(),
        path.rkey.as_str(),
        &record_cid.to_string(),
    );
    Ok(json!({
        "uri": record.uri,
        "cid": record.cid,
        "commit": {
            "cid": mutation.commit_cid.to_string(),
            "rev": mutation.commit.rev.to_string(),
        },
        "validationStatus": validation_status.as_str(),
    }))
}

fn xrpc_delete_mutation_response(mutation: &RepoMutation) -> Value {
    json!({
        "commit": {
            "cid": mutation.commit_cid.to_string(),
            "rev": mutation.commit.rev.to_string(),
        },
    })
}

fn xrpc_noop_delete_response(state: &RepoStateRow) -> Value {
    json!({
        "commit": {
            "cid": state.latest_commit.to_string(),
            "rev": state.latest_rev.to_string(),
        },
    })
}

fn xrpc_apply_writes_response(
    did: &Did,
    mutation: &RepoMutation,
    validation_statuses: &BTreeMap<RepoPath, RecordValidationStatus>,
) -> Result<Value, HttpError> {
    let results = mutation
        .ops
        .iter()
        .map(|op| match op.action {
            RepoOperationAction::Create => {
                let cid = op
                    .cid
                    .ok_or_else(|| HttpError::new(500, "create operation is missing record cid"))?;
                let record = strong_ref(
                    did.as_str(),
                    op.path.collection.as_str(),
                    op.path.rkey.as_str(),
                    &cid.to_string(),
                );
                Ok(json!({
                    "$type": "com.atproto.repo.applyWrites#createResult",
                    "uri": record.uri,
                    "cid": record.cid,
                    "validationStatus": validation_statuses
                        .get(&op.path)
                        .copied()
                        .unwrap_or(RecordValidationStatus::Unknown)
                        .as_str(),
                }))
            }
            RepoOperationAction::Update => {
                let cid = op
                    .cid
                    .ok_or_else(|| HttpError::new(500, "update operation is missing record cid"))?;
                let record = strong_ref(
                    did.as_str(),
                    op.path.collection.as_str(),
                    op.path.rkey.as_str(),
                    &cid.to_string(),
                );
                Ok(json!({
                    "$type": "com.atproto.repo.applyWrites#updateResult",
                    "uri": record.uri,
                    "cid": record.cid,
                    "validationStatus": validation_statuses
                        .get(&op.path)
                        .copied()
                        .unwrap_or(RecordValidationStatus::Unknown)
                        .as_str(),
                }))
            }
            RepoOperationAction::Delete => Ok(json!({
                "$type": "com.atproto.repo.applyWrites#deleteResult",
            })),
        })
        .collect::<Result<Vec<_>, HttpError>>()?;

    Ok(json!({
        "commit": {
            "cid": mutation.commit_cid.to_string(),
            "rev": mutation.commit.rev.to_string(),
        },
        "results": results,
    }))
}

fn extract_record_blob_refs(record: &Value) -> Result<Vec<crate::cid::Cid>, HttpError> {
    extract_import_record_blob_refs(record).map_err(HttpError::import)
}

#[allow(dead_code)]
fn ensure_record_envelope(
    collection: &Nsid,
    record: &Value,
    validate: Option<bool>,
    extra_lexicons: &[Value],
) -> Result<RecordValidationStatus, HttpError> {
    ensure_record_shape(collection, record)?;
    if validate == Some(false) {
        return Ok(RecordValidationStatus::Unknown);
    }
    lexicon::validate_record_with_lexicons(
        collection.as_str(),
        record,
        validate == Some(true),
        extra_lexicons,
    )
    .map_err(|error| HttpError::new(400, error.to_string()))
}

fn ensure_record_shape(collection: &Nsid, record: &Value) -> Result<(), HttpError> {
    let Some(object) = record.as_object() else {
        return Err(HttpError::new(400, "record must be a JSON object"));
    };
    match object.get("$type").and_then(Value::as_str) {
        Some(record_type) if record_type == collection.as_str() => {}
        Some(record_type) => {
            return Err(HttpError::new(
                400,
                format!("record $type `{record_type}` does not match collection `{collection}`"),
            ));
        }
        None => return Err(HttpError::new(400, "record must contain a string $type")),
    }
    Ok(())
}

fn ensure_blob_refs_available(
    store: &SqlRepoStore,
    cids: &[crate::cid::Cid],
) -> Result<(), HttpError> {
    for cid in cids {
        if store.get_blob(cid).map_err(HttpError::worker)?.is_none() {
            return Err(HttpError::new(
                400,
                format!("referenced blob `{cid}` is missing"),
            ));
        }
    }
    Ok(())
}

fn ensure_swap_commit(state: &RepoStateRow, swap_commit: Option<&str>) -> Result<(), HttpError> {
    let Some(swap_commit) = swap_commit else {
        return Ok(());
    };
    let cid = parse_cid(swap_commit).map_err(HttpError::bad_request)?;
    if cid == state.latest_commit {
        Ok(())
    } else {
        Err(invalid_swap("swapCommit did not match current repo commit"))
    }
}

fn ensure_optional_swap_record(
    current: Option<crate::cid::Cid>,
    swap_record: Option<&str>,
) -> Result<(), HttpError> {
    let Some(swap_record) = swap_record else {
        return Ok(());
    };
    let expected = parse_cid(swap_record).map_err(HttpError::bad_request)?;
    if current == Some(expected) {
        Ok(())
    } else {
        Err(invalid_swap("swapRecord did not match current record"))
    }
}

fn ensure_swap_record_field(
    current: Option<crate::cid::Cid>,
    swap_record: &SwapRecordField,
) -> Result<(), HttpError> {
    match swap_record {
        SwapRecordField::Missing => Ok(()),
        SwapRecordField::Absent if current.is_none() => Ok(()),
        SwapRecordField::Absent => Err(invalid_swap("swapRecord expected the record to be absent")),
        SwapRecordField::Cid(expected) => ensure_optional_swap_record(current, Some(expected)),
    }
}

fn invalid_swap(message: &str) -> HttpError {
    HttpError::new(400, format!("InvalidSwap: {message}"))
}

fn parse_apply_write_kind(value: &str) -> Result<RepoOperationAction, HttpError> {
    if value.ends_with("#create") || value == "create" {
        Ok(RepoOperationAction::Create)
    } else if value.ends_with("#update") || value == "update" {
        Ok(RepoOperationAction::Update)
    } else if value.ends_with("#delete") || value == "delete" {
        Ok(RepoOperationAction::Delete)
    } else {
        Err(HttpError::new(
            400,
            format!("unsupported applyWrites op type `{value}`"),
        ))
    }
}

fn blob_storage_key(cid: &crate::cid::Cid) -> String {
    format!("blobs/{cid}")
}

fn temporary_blob_storage_key() -> String {
    let random = (js_sys::Math::random() * u64::MAX as f64) as u64;
    format!(
        "blob-uploads/{}-{random:016x}",
        worker::Date::now().as_millis()
    )
}

fn blob_http_metadata(mime_type: &str) -> HttpMetadata {
    HttpMetadata {
        content_type: Some(mime_type.to_string()),
        content_language: None,
        content_disposition: None,
        content_encoding: None,
        cache_control: None,
        cache_expiry: None,
    }
}

fn request_content_length(req: &Request) -> Result<Option<u64>, HttpError> {
    let Some(value) = req
        .headers()
        .get("content-length")
        .map_err(HttpError::worker)?
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| HttpError::new(400, format!("invalid content-length header: {error}")))
}

fn ensure_import_repo_content_type(req: &Request) -> Result<(), HttpError> {
    let content_type = req
        .headers()
        .get("content-type")
        .map_err(HttpError::worker)?
        .and_then(|value| value.split(';').next().map(|part| part.trim().to_string()))
        .unwrap_or_default();
    if content_type == "application/vnd.ipld.car" {
        Ok(())
    } else {
        Err(HttpError::new(
            415,
            "importRepo requires content-type application/vnd.ipld.car",
        ))
    }
}

fn ensure_form_urlencoded(req: &Request) -> Result<(), HttpError> {
    let content_type = req
        .headers()
        .get("content-type")
        .map_err(HttpError::worker)?
        .and_then(|value| value.split(';').next().map(|part| part.trim().to_string()))
        .unwrap_or_default();
    if content_type.eq_ignore_ascii_case("application/x-www-form-urlencoded") {
        Ok(())
    } else {
        Err(HttpError::new(
            415,
            "OAuth endpoint requires content-type application/x-www-form-urlencoded",
        ))
    }
}

fn ensure_import_repo_size_limit(byte_len: u64) -> Result<(), HttpError> {
    if byte_len > MAX_IMPORT_REPO_BYTES as u64 {
        Err(HttpError::new(
            413,
            format!("repo import too large: max {MAX_IMPORT_REPO_BYTES} bytes"),
        ))
    } else {
        Ok(())
    }
}

fn ensure_account_authentication_allowed(account: &DirectoryAccountRow) -> Result<(), HttpError> {
    if account.active || account.status.as_deref() == Some("deactivated") {
        Ok(())
    } else if account.status.as_deref() == Some("deleted") {
        Err(HttpError::new(403, "AccountDeleted"))
    } else {
        Err(HttpError::new(403, "AccountTakedown"))
    }
}

fn ensure_blob_size_limit(byte_len: u64) -> Result<(), HttpError> {
    if byte_len > MAX_BLOB_BYTES as u64 {
        Err(HttpError::new(
            413,
            format!("blob too large: max {MAX_BLOB_BYTES} bytes"),
        ))
    } else {
        Ok(())
    }
}

fn require_admin_with_env(env: &Env, req: &Request) -> Result<(), HttpError> {
    if is_admin_authorized(env, req)? {
        Ok(())
    } else {
        Err(HttpError::new(401, "admin token required"))
    }
}

fn is_admin_authorized(env: &Env, req: &Request) -> Result<bool, HttpError> {
    let token = admin_token_from_env(env)?;
    let authorization = req
        .headers()
        .get("authorization")
        .map_err(HttpError::worker)?;
    let admin_header = req
        .headers()
        .get("x-pds-admin-token")
        .map_err(HttpError::worker)?;
    let expected_authorization = format!("Bearer {token}");
    Ok(
        authorization.as_deref() == Some(expected_authorization.as_str())
            || admin_header.as_deref() == Some(token.as_str()),
    )
}

fn admin_token_from_env(env: &Env) -> Result<String, HttpError> {
    let token = env
        .secret("PDS_ADMIN_TOKEN")
        .or_else(|_| env.var("PDS_ADMIN_TOKEN"))
        .map_err(|_| HttpError::new(500, "PDS_ADMIN_TOKEN binding is required"))?
        .to_string();
    if token.is_empty() {
        Err(HttpError::new(500, "PDS_ADMIN_TOKEN must not be empty"))
    } else {
        Ok(token)
    }
}

fn token_secret_from_env(env: &Env) -> Result<String, HttpError> {
    let token = match env
        .secret("PDS_JWT_SECRET")
        .or_else(|_| env.var("PDS_JWT_SECRET"))
    {
        Ok(value) => value.to_string(),
        Err(_) => admin_token_from_env(env)?,
    };
    if token.is_empty() {
        Err(HttpError::new(500, "PDS_JWT_SECRET must not be empty"))
    } else {
        Ok(token)
    }
}

fn max_account_blob_bytes_from_env(env: &Env) -> Result<i64, HttpError> {
    let Ok(value) = env.var("PDS_MAX_ACCOUNT_BLOB_BYTES") else {
        return Ok(DEFAULT_MAX_ACCOUNT_BLOB_BYTES);
    };
    let value = value.to_string();
    if value.trim().is_empty() {
        return Ok(DEFAULT_MAX_ACCOUNT_BLOB_BYTES);
    }
    value
        .trim()
        .parse::<i64>()
        .map_err(|_| {
            HttpError::new(
                500,
                "PDS_MAX_ACCOUNT_BLOB_BYTES must be a positive integer byte count",
            )
        })
        .and_then(|bytes| {
            if bytes > 0 {
                Ok(bytes)
            } else {
                Err(HttpError::new(
                    500,
                    "PDS_MAX_ACCOUNT_BLOB_BYTES must be greater than zero",
                ))
            }
        })
}

fn firehose_replay_limit_from_env(env: &Env) -> Result<usize, HttpError> {
    let Ok(value) = env.var("PDS_FIREHOSE_REPLAY_LIMIT") else {
        return Ok(DEFAULT_FIREHOSE_REPLAY_LIMIT);
    };
    let value = value.to_string();
    if value.trim().is_empty() {
        return Ok(DEFAULT_FIREHOSE_REPLAY_LIMIT);
    }
    value
        .trim()
        .parse::<usize>()
        .map_err(|_| {
            HttpError::new(
                500,
                "PDS_FIREHOSE_REPLAY_LIMIT must be a positive integer event count",
            )
        })
        .and_then(|limit| {
            if limit > 0 {
                Ok(limit)
            } else {
                Err(HttpError::new(
                    500,
                    "PDS_FIREHOSE_REPLAY_LIMIT must be greater than zero",
                ))
            }
        })
}

fn extra_lexicons_from_env(env: &Env) -> Result<Vec<Value>, HttpError> {
    let Ok(value) = env.var("PDS_LEXICONS_JSON") else {
        return Ok(Vec::new());
    };
    let value = value.to_string();
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    match from_str::<Value>(&value).map_err(|error| {
        HttpError::new(
            500,
            format!("PDS_LEXICONS_JSON must be a Lexicon JSON object or array: {error}"),
        )
    })? {
        Value::Array(values) => Ok(values),
        Value::Object(_) => Ok(vec![from_str(&value).map_err(|error| {
            HttpError::new(
                500,
                format!("PDS_LEXICONS_JSON object could not be parsed: {error}"),
            )
        })?]),
        _ => Err(HttpError::new(
            500,
            "PDS_LEXICONS_JSON must be a Lexicon JSON object or array",
        )),
    }
}

struct PublishedLexiconRecord {
    cid: String,
    uri: String,
    schema: Value,
    normalized_schema: Value,
}

async fn fetch_published_lexicon(env: &Env, collection: &str) -> Result<Option<Value>, HttpError> {
    Ok(fetch_published_lexicon_record(env, collection)
        .await?
        .map(|record| record.normalized_schema))
}

async fn fetch_published_lexicon_record(
    env: &Env,
    collection: &str,
) -> Result<Option<PublishedLexiconRecord>, HttpError> {
    let Some(txt_name) = lexicon_txt_name(collection) else {
        return Ok(None);
    };
    let did = if let Some(did) = lexicon_authority_did_from_env(env, collection)? {
        did
    } else {
        let records = fetch_dns_txt_records(&txt_name).await?;
        let Some(did) = unique_prefixed_txt_value(&records, "did=", &txt_name)? else {
            return Ok(None);
        };
        did
    };
    Did::new(did.clone()).map_err(HttpError::bad_request)?;
    let did_doc = fetch_did_document(&did).await?;
    ensure_did_document_id(&did_doc, &did).map_err(HttpError::bad_request)?;
    let endpoint = did_document_pds_endpoint(&did_doc).ok_or_else(|| {
        HttpError::new(
            502,
            format!("Lexicon authority DID `{did}` has no AtprotoPersonalDataServer service"),
        )
    })?;
    let url = format!(
        "{endpoint}/xrpc/com.atproto.repo.getRecord?repo={}&collection=com.atproto.lexicon.schema&rkey={}",
        encode_query_component(&did),
        encode_query_component(collection),
    );
    let Some(record) = fetch_json_url_optional(&url).await? else {
        return Ok(None);
    };
    let cid = record
        .get("cid")
        .and_then(Value::as_str)
        .ok_or_else(|| HttpError::new(502, "published Lexicon record did not contain `cid`"))?
        .to_string();
    let uri = record
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| HttpError::new(502, "published Lexicon record did not contain `uri`"))?
        .to_string();
    let raw_lexicon = record
        .get("value")
        .cloned()
        .ok_or_else(|| HttpError::new(502, "published Lexicon record did not contain `value`"))?;
    let normalized_schema = lexicon::normalize_schema_record(&raw_lexicon)
        .map_err(|error| HttpError::new(502, error.to_string()))?;
    if lexicon::schema_id(&normalized_schema) != Some(collection) {
        return Err(HttpError::new(
            502,
            format!("published Lexicon record value id did not match `{collection}`"),
        ));
    }
    lexicon::validate_lexicon_schema(&normalized_schema)
        .map_err(|error| HttpError::new(502, error.to_string()))?;
    let schema = lexicon::published_schema_record(&normalized_schema)
        .map_err(|error| HttpError::new(502, error.to_string()))?;
    Ok(Some(PublishedLexiconRecord {
        cid,
        uri,
        schema,
        normalized_schema,
    }))
}

fn lexicon_authority_did_from_env(
    env: &Env,
    collection: &str,
) -> Result<Option<String>, HttpError> {
    let Some(authority_domain) = lexicon_authority_domain(collection) else {
        return Ok(None);
    };
    let Ok(value) = env.var("PDS_LEXICON_AUTHORITY_DIDS") else {
        return Ok(None);
    };
    let did = lexicon_authority_did_override(&value.to_string(), &authority_domain)
        .map_err(HttpError::bad_request)?;
    if let Some(did) = did.as_deref() {
        Did::new(did.to_string()).map_err(HttpError::bad_request)?;
    }
    Ok(did)
}

async fn resolve_handle_did(handle: &str) -> Result<Option<String>, HttpError> {
    validate_handle_syntax(handle).map_err(HttpError::bad_request)?;
    if let Ok(records) = fetch_dns_txt_records(&handle_did_txt_name(handle)).await {
        if let Some(did) = unique_prefixed_txt_value(&records, "did=", handle)? {
            Did::new(did.clone()).map_err(HttpError::bad_request)?;
            return Ok(Some(did));
        }
    }

    let url = format!("https://{handle}/.well-known/atproto-did");
    let Some(text) = fetch_text_url_optional(&url).await? else {
        return Ok(None);
    };
    let did = text.trim().to_string();
    if did.is_empty() {
        return Ok(None);
    }
    Did::new(did.clone()).map_err(HttpError::bad_request)?;
    Ok(Some(did))
}

fn unique_prefixed_txt_value(
    records: &[String],
    prefix: &str,
    label: &str,
) -> Result<Option<String>, HttpError> {
    let values = prefixed_txt_values(records, prefix)
        .into_iter()
        .collect::<BTreeSet<_>>();
    if values.len() > 1 {
        return Err(HttpError::new(
            400,
            format!("ambiguous TXT records for `{label}`"),
        ));
    }
    Ok(values.into_iter().next())
}

async fn fetch_did_document(did: &str) -> Result<Value, HttpError> {
    let url = if did.starts_with("did:web:") {
        did_web_document_url(did).map_err(HttpError::bad_request)?
    } else if did.starts_with("did:plc:") {
        format!("https://plc.directory/{}", encode_query_component(did))
    } else {
        return Err(HttpError::new(
            400,
            format!("unsupported DID method for `{did}`"),
        ));
    };
    let doc = fetch_json_url(&url).await?;
    ensure_did_document_id(&doc, did).map_err(HttpError::bad_request)?;
    Ok(doc)
}

async fn fetch_did_document_with_env(did: &str, env: &Env) -> Result<Value, HttpError> {
    if did.starts_with("did:plc:") {
        fetch_plc_did_document(did, env).await
    } else {
        fetch_did_document(did).await
    }
}

async fn fetch_plc_did_document(did: &str, env: &Env) -> Result<Value, HttpError> {
    if !did.starts_with("did:plc:") {
        return Err(HttpError::new(400, "DID is not a did:plc identity"));
    }
    let url = format!("{}/{}", plc_directory_url(env), encode_query_component(did));
    let doc = fetch_json_url(&url).await?;
    ensure_did_document_id(&doc, did).map_err(HttpError::bad_request)?;
    Ok(doc)
}

fn did_document_has_verification_method(doc: &Value, fragment: &str, did_key: &str) -> bool {
    doc.get("verificationMethod")
        .and_then(Value::as_array)
        .is_some_and(|methods| {
            methods.iter().any(|method| {
                method
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.ends_with(&format!("#{fragment}")))
                    && method.get("publicKeyMultibase").and_then(Value::as_str)
                        == did_key.strip_prefix("did:key:")
            })
        })
}

async fn fetch_dns_txt_records(name: &str) -> Result<Vec<String>, HttpError> {
    let url = format!(
        "https://cloudflare-dns.com/dns-query?name={}&type=TXT",
        encode_query_component(name)
    );
    let headers = Headers::new();
    headers
        .set("accept", "application/dns-json")
        .map_err(HttpError::worker)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(headers);
    let request = Request::new_with_init(&url, &init).map_err(HttpError::worker)?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(HttpError::worker)?;
    if response.status_code() != 200 {
        return Err(HttpError::new(
            502,
            format!(
                "DNS TXT lookup for `{name}` failed with status {}",
                response.status_code()
            ),
        ));
    }
    let body: DnsJsonResponse = response.json().await.map_err(HttpError::worker)?;
    Ok(body
        .answers
        .unwrap_or_default()
        .into_iter()
        .filter(|answer| answer.record_type == 16)
        .map(|answer| answer.data)
        .collect())
}

async fn fetch_json_url(url: &str) -> Result<Value, HttpError> {
    fetch_json_url_optional(url)
        .await?
        .ok_or_else(|| HttpError::new(404, "remote JSON document not found"))
}

async fn post_json_url(url: &str, body: &Value) -> Result<Response, HttpError> {
    let headers = Headers::new();
    headers
        .set("content-type", "application/json")
        .map_err(HttpError::worker)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(
            &to_string(body).map_err(HttpError::worker)?,
        )));
    let request = Request::new_with_init(url, &init).map_err(HttpError::worker)?;
    Fetch::Request(request)
        .send()
        .await
        .map_err(HttpError::worker)
}

async fn fetch_json_url_optional(url: &str) -> Result<Option<Value>, HttpError> {
    let url = ::url::Url::parse(url)
        .map_err(|error| HttpError::new(400, format!("invalid URL: {error}")))?;
    let mut response = Fetch::Url(url).send().await.map_err(HttpError::worker)?;
    let status = response.status_code();
    if status == 404 {
        return Ok(None);
    }
    if !(200..=299).contains(&status) {
        return Err(HttpError::new(
            502,
            format!("remote JSON fetch failed with status {status}"),
        ));
    }
    response.json().await.map(Some).map_err(HttpError::worker)
}

async fn fetch_text_url_optional(url: &str) -> Result<Option<String>, HttpError> {
    let url = ::url::Url::parse(url)
        .map_err(|error| HttpError::new(400, format!("invalid URL: {error}")))?;
    let mut response = Fetch::Url(url).send().await.map_err(HttpError::worker)?;
    let status = response.status_code();
    if status == 404 {
        return Ok(None);
    }
    if !(200..=299).contains(&status) {
        return Err(HttpError::new(
            502,
            format!("remote text fetch failed with status {status}"),
        ));
    }
    response.text().await.map(Some).map_err(HttpError::worker)
}

#[derive(Debug, Deserialize)]
struct DnsJsonResponse {
    #[serde(default, rename = "Answer")]
    answers: Option<Vec<DnsJsonAnswer>>,
}

#[derive(Debug, Deserialize)]
struct DnsJsonAnswer {
    #[serde(rename = "type")]
    record_type: u16,
    data: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthScheme {
    Bearer,
    Dpop,
}

struct PresentedToken {
    scheme: AuthScheme,
    token: String,
}

fn authorization_token(req: &Request) -> Result<PresentedToken, HttpError> {
    let authorization = req
        .headers()
        .get("authorization")
        .map_err(HttpError::worker)?
        .ok_or_else(|| HttpError::new(401, "authorization bearer token required"))?;
    if let Some(token) = authorization
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
    {
        Ok(PresentedToken {
            scheme: AuthScheme::Bearer,
            token: token.to_string(),
        })
    } else if let Some(token) = authorization
        .strip_prefix("DPoP ")
        .filter(|token| !token.is_empty())
    {
        Ok(PresentedToken {
            scheme: AuthScheme::Dpop,
            token: token.to_string(),
        })
    } else {
        Err(HttpError::new(401, "authorization bearer token required"))
    }
}

fn verify_request_dpop(
    req: &Request,
    expected_jkt: Option<&str>,
    expected_nonce: Option<&str>,
    access_token: Option<&str>,
) -> Result<VerifiedDpopProof, DpopError> {
    let proof = req
        .headers()
        .get("dpop")
        .map_err(|_| DpopError::MissingProof)?
        .filter(|value| !value.is_empty())
        .ok_or(DpopError::MissingProof)?;
    let url = req.url().map_err(|_| DpopError::UriMismatch)?;
    verify_dpop_proof(
        &proof,
        http_method_name(&req.method()),
        &dpop_htu(&url),
        current_unix_time(),
        expected_nonce,
        expected_jkt,
        access_token,
    )
}

fn http_method_name(method: &Method) -> &'static str {
    match method {
        Method::Get => "GET",
        Method::Head => "HEAD",
        Method::Post => "POST",
        Method::Put => "PUT",
        Method::Delete => "DELETE",
        Method::Options => "OPTIONS",
        Method::Connect => "CONNECT",
        Method::Patch => "PATCH",
        Method::Trace => "TRACE",
        Method::Report => "REPORT",
    }
}

async fn validate_account_handle_for_creation(
    env: &Env,
    handle: &str,
    request_host: &str,
    expected_did: &str,
) -> Result<(), HttpError> {
    validate_handle_syntax(handle).map_err(HttpError::bad_request)?;
    if handle == request_host {
        return Ok(());
    }
    if !configured_account_handle_allowed(env, handle) {
        return Err(HttpError::new(
            400,
            format!(
                "UnsupportedDomain: `{handle}` is not the request host `{request_host}` and is not allowed by PDS_ALLOWED_ACCOUNT_HANDLES or PDS_ALLOWED_ACCOUNT_HANDLE_SUFFIXES"
            ),
        ));
    }
    let Some(resolved_did) = resolve_handle_did(handle).await? else {
        return Err(HttpError::new(
            400,
            format!("HandleNotResolvable: `{handle}` did not resolve to a DID"),
        ));
    };
    if resolved_did == expected_did {
        Ok(())
    } else {
        Err(HttpError::new(
            400,
            format!("HandleMismatch: `{handle}` resolves to `{resolved_did}`, expected `{expected_did}`"),
        ))
    }
}

async fn validate_account_did_document(handle: &str, did: &str) -> Result<(), HttpError> {
    let doc = fetch_did_document(did).await?;
    if !did_document_claims_handle(&doc, handle) {
        return Err(HttpError::new(
            400,
            format!("HandleMismatch: DID document `{did}` does not claim at://{handle}"),
        ));
    }
    let Some(resolved_did) = resolve_handle_did(handle).await? else {
        return Err(HttpError::new(
            400,
            format!("HandleNotResolvable: `{handle}` did not resolve to a DID"),
        ));
    };
    if resolved_did != did {
        return Err(HttpError::new(
            400,
            format!("HandleMismatch: `{handle}` resolves to `{resolved_did}`, expected `{did}`"),
        ));
    }
    if did_document_pds_endpoint(&doc).is_none() {
        return Err(HttpError::new(
            400,
            format!(
                "InvalidDidDocument: DID document `{did}` has no AtprotoPersonalDataServer service"
            ),
        ));
    }
    Ok(())
}

async fn validate_plc_account_did_document(
    handle: &str,
    did: &str,
    origin: &str,
    public_key_multibase: &str,
    env: &Env,
) -> Result<(), HttpError> {
    let doc = fetch_plc_did_document(did, env).await?;
    if !did_document_claims_handle(&doc, handle) {
        return Err(HttpError::new(
            400,
            format!("HandleMismatch: DID document `{did}` does not claim at://{handle}"),
        ));
    }
    if did_document_pds_endpoint(&doc).as_deref() != Some(origin.trim_end_matches('/')) {
        return Err(HttpError::new(
            400,
            format!("InvalidDidDocument: DID document `{did}` does not point at this PDS"),
        ));
    }
    let expected_signing_key = did_key_from_public_key_multibase(public_key_multibase)?;
    if !did_document_has_verification_method(&doc, "atproto", &expected_signing_key) {
        return Err(HttpError::new(
            400,
            format!(
                "InvalidDidDocument: DID document `{did}` does not publish the repo signing key"
            ),
        ));
    }
    Ok(())
}

fn ensure_repo_identifier(
    state: &RepoStateRow,
    identity: &RepoIdentityRow,
    repo: &str,
) -> Result<(), HttpError> {
    if repo == state.did.as_str() || repo == identity.handle {
        Ok(())
    } else {
        Err(HttpError::new(404, "repo not found"))
    }
}

#[cfg(test)]
mod tests;
