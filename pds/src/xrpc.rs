//! XRPC routing and query parameter helpers.

use serde::Serialize;
use thiserror::Error;

pub const SERVER_DESCRIBE_SERVER: &str = "com.atproto.server.describeServer";
pub const SERVER_CREATE_ACCOUNT: &str = "com.atproto.server.createAccount";
pub const SERVER_CREATE_SESSION: &str = "com.atproto.server.createSession";
pub const SERVER_GET_SESSION: &str = "com.atproto.server.getSession";
pub const SERVER_REFRESH_SESSION: &str = "com.atproto.server.refreshSession";
pub const SERVER_DELETE_SESSION: &str = "com.atproto.server.deleteSession";
pub const SERVER_CHANGE_PASSWORD: &str = "com.atproto.server.changePassword";
pub const SERVER_REQUEST_PASSWORD_RESET: &str = "com.atproto.server.requestPasswordReset";
pub const SERVER_RESET_PASSWORD: &str = "com.atproto.server.resetPassword";
pub const SERVER_REQUEST_EMAIL_CONFIRMATION: &str = "com.atproto.server.requestEmailConfirmation";
pub const SERVER_CONFIRM_EMAIL: &str = "com.atproto.server.confirmEmail";
pub const SERVER_REQUEST_EMAIL_UPDATE: &str = "com.atproto.server.requestEmailUpdate";
pub const SERVER_UPDATE_EMAIL: &str = "com.atproto.server.updateEmail";
pub const SERVER_REQUEST_ACCOUNT_DELETE: &str = "com.atproto.server.requestAccountDelete";
pub const SERVER_DELETE_ACCOUNT: &str = "com.atproto.server.deleteAccount";
pub const SERVER_DEACTIVATE_ACCOUNT: &str = "com.atproto.server.deactivateAccount";
pub const SERVER_ACTIVATE_ACCOUNT: &str = "com.atproto.server.activateAccount";
pub const SERVER_CHECK_ACCOUNT_STATUS: &str = "com.atproto.server.checkAccountStatus";
pub const SERVER_GET_SERVICE_AUTH: &str = "com.atproto.server.getServiceAuth";
pub const SERVER_RESERVE_SIGNING_KEY: &str = "com.atproto.server.reserveSigningKey";
pub const SERVER_CREATE_INVITE_CODE: &str = "com.atproto.server.createInviteCode";
pub const SERVER_CREATE_INVITE_CODES: &str = "com.atproto.server.createInviteCodes";
pub const SERVER_GET_ACCOUNT_INVITE_CODES: &str = "com.atproto.server.getAccountInviteCodes";
pub const SERVER_CREATE_APP_PASSWORD: &str = "com.atproto.server.createAppPassword";
pub const SERVER_LIST_APP_PASSWORDS: &str = "com.atproto.server.listAppPasswords";
pub const SERVER_REVOKE_APP_PASSWORD: &str = "com.atproto.server.revokeAppPassword";
pub const ADMIN_DELETE_ACCOUNT: &str = "com.atproto.admin.deleteAccount";
pub const ADMIN_DISABLE_ACCOUNT_INVITES: &str = "com.atproto.admin.disableAccountInvites";
pub const ADMIN_DISABLE_INVITE_CODES: &str = "com.atproto.admin.disableInviteCodes";
pub const ADMIN_ENABLE_ACCOUNT_INVITES: &str = "com.atproto.admin.enableAccountInvites";
pub const ADMIN_GET_ACCOUNT_INFO: &str = "com.atproto.admin.getAccountInfo";
pub const ADMIN_GET_ACCOUNT_INFOS: &str = "com.atproto.admin.getAccountInfos";
pub const ADMIN_GET_INVITE_CODES: &str = "com.atproto.admin.getInviteCodes";
pub const ADMIN_GET_SUBJECT_STATUS: &str = "com.atproto.admin.getSubjectStatus";
pub const ADMIN_SEARCH_ACCOUNTS: &str = "com.atproto.admin.searchAccounts";
pub const ADMIN_SEND_EMAIL: &str = "com.atproto.admin.sendEmail";
pub const ADMIN_UPDATE_ACCOUNT_EMAIL: &str = "com.atproto.admin.updateAccountEmail";
pub const ADMIN_UPDATE_ACCOUNT_HANDLE: &str = "com.atproto.admin.updateAccountHandle";
pub const ADMIN_UPDATE_ACCOUNT_PASSWORD: &str = "com.atproto.admin.updateAccountPassword";
pub const ADMIN_UPDATE_ACCOUNT_SIGNING_KEY: &str = "com.atproto.admin.updateAccountSigningKey";
pub const ADMIN_UPDATE_SUBJECT_STATUS: &str = "com.atproto.admin.updateSubjectStatus";
pub const IDENTITY_RESOLVE_HANDLE: &str = "com.atproto.identity.resolveHandle";
pub const IDENTITY_RESOLVE_DID: &str = "com.atproto.identity.resolveDid";
pub const IDENTITY_RESOLVE_IDENTITY: &str = "com.atproto.identity.resolveIdentity";
pub const IDENTITY_UPDATE_HANDLE: &str = "com.atproto.identity.updateHandle";
pub const IDENTITY_REFRESH_IDENTITY: &str = "com.atproto.identity.refreshIdentity";
pub const IDENTITY_GET_RECOMMENDED_DID_CREDENTIALS: &str =
    "com.atproto.identity.getRecommendedDidCredentials";
pub const IDENTITY_REQUEST_PLC_OPERATION_SIGNATURE: &str =
    "com.atproto.identity.requestPlcOperationSignature";
pub const IDENTITY_SIGN_PLC_OPERATION: &str = "com.atproto.identity.signPlcOperation";
pub const IDENTITY_SUBMIT_PLC_OPERATION: &str = "com.atproto.identity.submitPlcOperation";
pub const LEXICON_RESOLVE_LEXICON: &str = "com.atproto.lexicon.resolveLexicon";
pub const REPO_DESCRIBE_REPO: &str = "com.atproto.repo.describeRepo";
pub const REPO_GET_RECORD: &str = "com.atproto.repo.getRecord";
pub const REPO_LIST_RECORDS: &str = "com.atproto.repo.listRecords";
pub const REPO_CREATE_RECORD: &str = "com.atproto.repo.createRecord";
pub const REPO_PUT_RECORD: &str = "com.atproto.repo.putRecord";
pub const REPO_DELETE_RECORD: &str = "com.atproto.repo.deleteRecord";
pub const REPO_APPLY_WRITES: &str = "com.atproto.repo.applyWrites";
pub const REPO_IMPORT_REPO: &str = "com.atproto.repo.importRepo";
pub const REPO_UPLOAD_BLOB: &str = "com.atproto.repo.uploadBlob";
pub const REPO_LIST_MISSING_BLOBS: &str = "com.atproto.repo.listMissingBlobs";
pub const SYNC_GET_LATEST_COMMIT: &str = "com.atproto.sync.getLatestCommit";
pub const SYNC_GET_HEAD: &str = "com.atproto.sync.getHead";
pub const SYNC_GET_REPO_STATUS: &str = "com.atproto.sync.getRepoStatus";
pub const SYNC_LIST_HOSTS: &str = "com.atproto.sync.listHosts";
pub const SYNC_LIST_REPOS: &str = "com.atproto.sync.listRepos";
pub const SYNC_LIST_REPOS_BY_COLLECTION: &str = "com.atproto.sync.listReposByCollection";
pub const SYNC_SUBSCRIBE_REPOS: &str = "com.atproto.sync.subscribeRepos";
pub const SYNC_GET_HOST_STATUS: &str = "com.atproto.sync.getHostStatus";
pub const SYNC_LIST_BLOBS: &str = "com.atproto.sync.listBlobs";
pub const SYNC_GET_BLOB: &str = "com.atproto.sync.getBlob";
pub const SYNC_GET_BLOCKS: &str = "com.atproto.sync.getBlocks";
pub const SYNC_GET_RECORD: &str = "com.atproto.sync.getRecord";
pub const SYNC_GET_CHECKOUT: &str = "com.atproto.sync.getCheckout";
pub const SYNC_GET_REPO: &str = "com.atproto.sync.getRepo";

const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 100;
const MAX_GET_BLOCKS_CIDS: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum XrpcRoute {
    Worker,
    DirectoryObject,
    RepoObjectByJsonBodyRepo,
    RepoObjectByBearerSubject,
    RepoObject { name: String },
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListRecordsParams {
    pub collection: String,
    pub limit: usize,
    pub cursor: Option<String>,
    pub reverse: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GetBlocksParams {
    pub did: String,
    pub cids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StrongRef {
    pub uri: String,
    pub cid: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum XrpcError {
    #[error("missing required query parameter `{param}`")]
    MissingParam { param: &'static str },

    #[error("empty query parameter `{param}`")]
    EmptyParam { param: &'static str },

    #[error("invalid limit `{value}`: expected an integer from 1 to {max}")]
    InvalidLimit { value: String, max: usize },

    #[error("invalid boolean `{param}` value `{value}`: expected `true` or `false`")]
    InvalidBoolean { param: &'static str, value: String },

    #[error("too many `{param}` values: expected at most {max}")]
    TooManyValues { param: &'static str, max: usize },
}

pub fn route_xrpc_method(method: &str, query: &[(String, String)]) -> Result<XrpcRoute, XrpcError> {
    match method {
        SERVER_DESCRIBE_SERVER => Ok(XrpcRoute::Worker),
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
        | SYNC_LIST_REPOS
        | SYNC_LIST_REPOS_BY_COLLECTION
        | SYNC_GET_HOST_STATUS
        | SYNC_SUBSCRIBE_REPOS => Ok(XrpcRoute::DirectoryObject),
        REPO_CREATE_RECORD | REPO_PUT_RECORD | REPO_DELETE_RECORD | REPO_APPLY_WRITES => {
            Ok(XrpcRoute::RepoObjectByJsonBodyRepo)
        }
        REPO_IMPORT_REPO | REPO_UPLOAD_BLOB | REPO_LIST_MISSING_BLOBS => {
            Ok(XrpcRoute::RepoObjectByBearerSubject)
        }
        REPO_DESCRIBE_REPO | REPO_GET_RECORD | REPO_LIST_RECORDS => {
            let repo = required_param(query, "repo")?;
            Ok(XrpcRoute::RepoObject {
                name: repo_object_name_from_identifier(&repo),
            })
        }
        SYNC_GET_LATEST_COMMIT
        | SYNC_GET_REPO_STATUS
        | SYNC_GET_HEAD
        | SYNC_LIST_BLOBS
        | SYNC_GET_BLOB
        | SYNC_GET_BLOCKS
        | SYNC_GET_RECORD
        | SYNC_GET_CHECKOUT
        | SYNC_GET_REPO
        | IDENTITY_RESOLVE_DID => {
            let did = required_param(query, "did")?;
            Ok(XrpcRoute::RepoObject {
                name: repo_object_name_from_identifier(&did),
            })
        }
        _ => Ok(XrpcRoute::Unsupported),
    }
}

pub fn strong_ref(did: &str, collection: &str, rkey: &str, cid: &str) -> StrongRef {
    StrongRef {
        uri: at_uri(did, collection, rkey),
        cid: cid.to_string(),
    }
}

pub fn parse_list_records_params(
    query: &[(String, String)],
) -> Result<ListRecordsParams, XrpcError> {
    Ok(ListRecordsParams {
        collection: required_param(query, "collection")?,
        limit: parse_limit(optional_param(query, "limit").as_deref())?,
        cursor: optional_param(query, "cursor").filter(|value| !value.is_empty()),
        reverse: parse_bool_param(query, "reverse")?,
    })
}

pub fn parse_get_blocks_params(query: &[(String, String)]) -> Result<GetBlocksParams, XrpcError> {
    let did = required_param(query, "did")?;
    let cids = array_param(query, "cids", MAX_GET_BLOCKS_CIDS)?;
    Ok(GetBlocksParams { did, cids })
}

pub fn required_param(
    query: &[(String, String)],
    param: &'static str,
) -> Result<String, XrpcError> {
    let value = query
        .iter()
        .find(|(key, _)| key == param)
        .map(|(_, value)| value.trim().to_string())
        .ok_or(XrpcError::MissingParam { param })?;
    if value.is_empty() {
        return Err(XrpcError::EmptyParam { param });
    }
    Ok(value)
}

pub fn optional_param(query: &[(String, String)], param: &str) -> Option<String> {
    query
        .iter()
        .find(|(key, _)| key == param)
        .map(|(_, value)| value.to_string())
}

fn array_param(
    query: &[(String, String)],
    param: &'static str,
    max: usize,
) -> Result<Vec<String>, XrpcError> {
    let values = query
        .iter()
        .filter(|(key, _)| key == param)
        .map(|(_, value)| value.trim().to_string())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Err(XrpcError::MissingParam { param });
    }
    if values.iter().any(|value| value.is_empty()) {
        return Err(XrpcError::EmptyParam { param });
    }
    if values.len() > max {
        return Err(XrpcError::TooManyValues { param, max });
    }
    Ok(values)
}

pub fn repo_object_name_from_identifier(identifier: &str) -> String {
    identifier
        .strip_prefix("did:gsv:")
        .or_else(|| identifier.strip_prefix("did:web:"))
        .unwrap_or(identifier)
        .to_string()
}

pub fn at_uri(did: &str, collection: &str, rkey: &str) -> String {
    format!("at://{did}/{collection}/{rkey}")
}

fn parse_limit(value: Option<&str>) -> Result<usize, XrpcError> {
    let Some(value) = value else {
        return Ok(DEFAULT_LIST_LIMIT);
    };

    let limit = value
        .parse::<usize>()
        .map_err(|_| XrpcError::InvalidLimit {
            value: value.to_string(),
            max: MAX_LIST_LIMIT,
        })?;
    if !(1..=MAX_LIST_LIMIT).contains(&limit) {
        return Err(XrpcError::InvalidLimit {
            value: value.to_string(),
            max: MAX_LIST_LIMIT,
        });
    }
    Ok(limit)
}

fn parse_bool_param(query: &[(String, String)], param: &'static str) -> Result<bool, XrpcError> {
    match optional_param(query, param).as_deref() {
        None | Some("") | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(value) => Err(XrpcError::InvalidBoolean {
            param,
            value: value.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(params: &[(&str, &str)]) -> Vec<(String, String)> {
        params
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn routes_server_describe_to_worker() {
        assert_eq!(
            route_xrpc_method(SERVER_DESCRIBE_SERVER, &[]).unwrap(),
            XrpcRoute::Worker
        );
    }

    #[test]
    fn routes_identity_resolve_handle_to_directory() {
        assert_eq!(
            route_xrpc_method(
                IDENTITY_RESOLVE_HANDLE,
                &query(&[("handle", "pds.example.com")])
            )
            .unwrap(),
            XrpcRoute::DirectoryObject
        );
    }

    #[test]
    fn routes_identity_resolve_did_to_repo_object_by_did() {
        assert_eq!(
            route_xrpc_method(IDENTITY_RESOLVE_DID, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
    }

    #[test]
    fn routes_directory_methods_to_directory_object() {
        for method in [
            SERVER_CREATE_ACCOUNT,
            SERVER_CREATE_SESSION,
            SERVER_GET_SESSION,
            SERVER_REFRESH_SESSION,
            SERVER_DELETE_SESSION,
            SERVER_CHANGE_PASSWORD,
            SERVER_REQUEST_PASSWORD_RESET,
            SERVER_RESET_PASSWORD,
            SERVER_REQUEST_EMAIL_CONFIRMATION,
            SERVER_CONFIRM_EMAIL,
            SERVER_REQUEST_EMAIL_UPDATE,
            SERVER_UPDATE_EMAIL,
            SERVER_REQUEST_ACCOUNT_DELETE,
            SERVER_DELETE_ACCOUNT,
            SERVER_DEACTIVATE_ACCOUNT,
            SERVER_ACTIVATE_ACCOUNT,
            SERVER_CHECK_ACCOUNT_STATUS,
            SERVER_GET_SERVICE_AUTH,
            SERVER_RESERVE_SIGNING_KEY,
            SERVER_CREATE_INVITE_CODE,
            SERVER_CREATE_INVITE_CODES,
            SERVER_GET_ACCOUNT_INVITE_CODES,
            SERVER_CREATE_APP_PASSWORD,
            SERVER_LIST_APP_PASSWORDS,
            SERVER_REVOKE_APP_PASSWORD,
            ADMIN_DELETE_ACCOUNT,
            ADMIN_DISABLE_ACCOUNT_INVITES,
            ADMIN_DISABLE_INVITE_CODES,
            ADMIN_ENABLE_ACCOUNT_INVITES,
            ADMIN_GET_ACCOUNT_INFO,
            ADMIN_GET_ACCOUNT_INFOS,
            ADMIN_GET_INVITE_CODES,
            ADMIN_GET_SUBJECT_STATUS,
            ADMIN_SEARCH_ACCOUNTS,
            ADMIN_SEND_EMAIL,
            ADMIN_UPDATE_ACCOUNT_EMAIL,
            ADMIN_UPDATE_ACCOUNT_HANDLE,
            ADMIN_UPDATE_ACCOUNT_PASSWORD,
            ADMIN_UPDATE_ACCOUNT_SIGNING_KEY,
            ADMIN_UPDATE_SUBJECT_STATUS,
            IDENTITY_RESOLVE_IDENTITY,
            IDENTITY_UPDATE_HANDLE,
            IDENTITY_REFRESH_IDENTITY,
            IDENTITY_GET_RECOMMENDED_DID_CREDENTIALS,
            IDENTITY_REQUEST_PLC_OPERATION_SIGNATURE,
            IDENTITY_SIGN_PLC_OPERATION,
            IDENTITY_SUBMIT_PLC_OPERATION,
            LEXICON_RESOLVE_LEXICON,
            SYNC_LIST_HOSTS,
            SYNC_LIST_REPOS,
            SYNC_LIST_REPOS_BY_COLLECTION,
            SYNC_GET_HOST_STATUS,
            SYNC_SUBSCRIBE_REPOS,
        ] {
            assert_eq!(
                route_xrpc_method(method, &[]).unwrap(),
                XrpcRoute::DirectoryObject
            );
        }
    }

    #[test]
    fn routes_json_write_methods_by_body_repo() {
        for method in [
            REPO_CREATE_RECORD,
            REPO_PUT_RECORD,
            REPO_DELETE_RECORD,
            REPO_APPLY_WRITES,
        ] {
            assert_eq!(
                route_xrpc_method(method, &[]).unwrap(),
                XrpcRoute::RepoObjectByJsonBodyRepo
            );
        }
    }

    #[test]
    fn routes_auth_scoped_repo_methods_by_bearer_subject() {
        for method in [REPO_IMPORT_REPO, REPO_UPLOAD_BLOB, REPO_LIST_MISSING_BLOBS] {
            assert_eq!(
                route_xrpc_method(method, &[]).unwrap(),
                XrpcRoute::RepoObjectByBearerSubject
            );
        }
    }

    #[test]
    fn routes_repo_methods_to_repo_object_by_repo() {
        assert_eq!(
            route_xrpc_method(REPO_GET_RECORD, &query(&[("repo", "alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
    }

    #[test]
    fn routes_gsv_dids_to_their_local_repo_name() {
        assert_eq!(
            route_xrpc_method(SYNC_GET_LATEST_COMMIT, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
        assert_eq!(
            route_xrpc_method(SYNC_GET_HEAD, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
    }

    #[test]
    fn routes_hostname_did_web_to_their_local_repo_name() {
        assert_eq!(
            route_xrpc_method(
                SYNC_GET_LATEST_COMMIT,
                &query(&[("did", "did:web:pds.example.com")])
            )
            .unwrap(),
            XrpcRoute::RepoObject {
                name: "pds.example.com".to_string()
            }
        );
    }

    #[test]
    fn routes_sync_car_methods_to_repo_object_by_did() {
        assert_eq!(
            route_xrpc_method(SYNC_GET_REPO, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
        assert_eq!(
            route_xrpc_method(SYNC_GET_CHECKOUT, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
        assert_eq!(
            route_xrpc_method(SYNC_GET_RECORD, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
    }

    #[test]
    fn routes_sync_blob_methods_to_repo_object_by_did() {
        assert_eq!(
            route_xrpc_method(SYNC_LIST_BLOBS, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
        assert_eq!(
            route_xrpc_method(SYNC_GET_BLOB, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
        assert_eq!(
            route_xrpc_method(SYNC_GET_BLOCKS, &query(&[("did", "did:gsv:alice")])).unwrap(),
            XrpcRoute::RepoObject {
                name: "alice".to_string()
            }
        );
    }

    #[test]
    fn routes_repo_status_to_repo_object_by_did() {
        assert_eq!(
            route_xrpc_method(
                SYNC_GET_REPO_STATUS,
                &query(&[("did", "did:web:pds.example.com")])
            )
            .unwrap(),
            XrpcRoute::RepoObject {
                name: "pds.example.com".to_string()
            }
        );
    }

    #[test]
    fn requires_repo_identifier_for_repo_methods() {
        assert_eq!(
            route_xrpc_method(REPO_LIST_RECORDS, &[]).unwrap_err(),
            XrpcError::MissingParam { param: "repo" }
        );
    }

    #[test]
    fn parses_list_records_defaults() {
        assert_eq!(
            parse_list_records_params(&query(&[("collection", "app.gsv.feed.post")])).unwrap(),
            ListRecordsParams {
                collection: "app.gsv.feed.post".to_string(),
                limit: 50,
                cursor: None,
                reverse: false,
            }
        );
    }

    #[test]
    fn parses_list_records_cursor_limit_and_reverse() {
        assert_eq!(
            parse_list_records_params(&query(&[
                ("collection", "app.gsv.feed.post"),
                ("cursor", "app.gsv.feed.post/1"),
                ("limit", "2"),
                ("reverse", "true"),
            ]))
            .unwrap(),
            ListRecordsParams {
                collection: "app.gsv.feed.post".to_string(),
                limit: 2,
                cursor: Some("app.gsv.feed.post/1".to_string()),
                reverse: true,
            }
        );
    }

    #[test]
    fn rejects_out_of_range_list_limits() {
        assert_eq!(
            parse_list_records_params(&query(&[
                ("collection", "app.gsv.feed.post"),
                ("limit", "101"),
            ]))
            .unwrap_err(),
            XrpcError::InvalidLimit {
                value: "101".to_string(),
                max: 100,
            }
        );
    }

    #[test]
    fn parses_get_blocks_repeated_cids() {
        assert_eq!(
            parse_get_blocks_params(&query(&[
                ("did", "did:gsv:alice"),
                ("cids", "bafyfirst"),
                ("cids", "bafysecond"),
            ]))
            .unwrap(),
            GetBlocksParams {
                did: "did:gsv:alice".to_string(),
                cids: vec!["bafyfirst".to_string(), "bafysecond".to_string()],
            }
        );
    }

    #[test]
    fn get_blocks_requires_at_least_one_cid() {
        assert_eq!(
            parse_get_blocks_params(&query(&[("did", "did:gsv:alice")])).unwrap_err(),
            XrpcError::MissingParam { param: "cids" }
        );
        assert_eq!(
            parse_get_blocks_params(&query(&[("did", "did:gsv:alice"), ("cids", "")])).unwrap_err(),
            XrpcError::EmptyParam { param: "cids" }
        );
    }

    #[test]
    fn get_blocks_rejects_too_many_cids() {
        let mut params = vec![("did".to_string(), "did:gsv:alice".to_string())];
        params.extend(
            (0..=MAX_GET_BLOCKS_CIDS)
                .map(|index| ("cids".to_string(), format!("bafy{index:0>12}"))),
        );

        assert_eq!(
            parse_get_blocks_params(&params).unwrap_err(),
            XrpcError::TooManyValues {
                param: "cids",
                max: MAX_GET_BLOCKS_CIDS,
            }
        );
    }

    #[test]
    fn builds_strong_refs() {
        assert_eq!(
            strong_ref("did:gsv:alice", "app.gsv.feed.post", "one", "bafyrecord"),
            StrongRef {
                uri: "at://did:gsv:alice/app.gsv.feed.post/one".to_string(),
                cid: "bafyrecord".to_string(),
            }
        );
    }

    #[test]
    fn builds_at_uris() {
        assert_eq!(
            at_uri("did:gsv:alice", "app.gsv.feed.post", "one"),
            "at://did:gsv:alice/app.gsv.feed.post/one"
        );
    }
}
