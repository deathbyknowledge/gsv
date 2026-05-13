use super::*;

pub(super) fn health_response() -> worker::Result<Response> {
    json_response(
        200,
        &json!({
            "version": env!("CARGO_PKG_VERSION"),
            "status": "ok",
        }),
    )
}

pub(super) fn xrpc_error_body(error: &str, message: Option<&str>) -> Value {
    let mut body = json!({ "error": error });
    if let Some(message) = message.filter(|message| !message.is_empty()) {
        body["message"] = json!(message);
    }
    body
}

pub(super) fn handle_worker_xrpc(
    http_method: Method,
    xrpc_method: &str,
    url: &worker::Url,
) -> worker::Result<Response> {
    match (http_method, xrpc_method) {
        (Method::Get, SERVER_DESCRIBE_SERVER) => describe_server(url),
        (Method::Get, IDENTITY_RESOLVE_HANDLE) => match xrpc_resolve_handle(url) {
            Ok(response) => Ok(response),
            Err(error) => json_response(
                error.status,
                &xrpc_error_body(&error.message, Some(error.message.as_str())),
            ),
        },
        (_, SERVER_DESCRIBE_SERVER | IDENTITY_RESOLVE_HANDLE) => json_response(
            405,
            &xrpc_error_body("MethodNotAllowed", Some("method not allowed")),
        ),
        _ => json_response(
            404,
            &json!({
                "error": "MethodNotFound",
                "message": format!("unsupported XRPC method `{xrpc_method}`"),
            }),
        ),
    }
}

pub(super) fn describe_server(url: &worker::Url) -> worker::Result<Response> {
    let Some(host) = url.host_str() else {
        return json_response(
            400,
            &xrpc_error_body("InvalidRequest", Some("request host is required")),
        );
    };
    json_response(
        200,
        &json!({
            "did": format!("did:web:{host}"),
            "availableUserDomains": [host],
            "inviteCodeRequired": true,
            "phoneVerificationRequired": false,
            "links": {},
            "contact": {},
        }),
    )
}

pub(super) fn xrpc_resolve_handle(url: &worker::Url) -> Result<Response, HttpError> {
    let params = query_pairs(url);
    let handle = required_param(&params, "handle")
        .map_err(HttpError::xrpc)?
        .to_ascii_lowercase();
    let Some(host) = url.host_str() else {
        return Err(HttpError::new(400, "request host is required"));
    };
    if handle != host {
        return Err(HttpError::new(404, "HandleNotFound"));
    }
    json_response(
        200,
        &json!({
            "did": format!("did:web:{handle}"),
        }),
    )
    .map_err(HttpError::worker)
}

pub(super) fn oauth_metadata_response(url: &worker::Url) -> worker::Result<Response> {
    let origin = request_origin(url);
    let metadata = match url.path() {
        OAUTH_PROTECTED_RESOURCE_PATH => protected_resource_metadata(&origin),
        OAUTH_AUTHORIZATION_SERVER_PATH => authorization_server_metadata(&origin),
        _ => json!({}),
    };
    let mut response = Response::from_json(&metadata)?.with_status(200);
    response
        .headers_mut()
        .set("cache-control", "public, max-age=300")?;
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn did_document(
    did: &str,
    handle: &str,
    public_key_multibase: &str,
    service_endpoint: &str,
) -> Value {
    json!({
        "@context": [
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/multikey/v1"
        ],
        "id": did,
        "alsoKnownAs": [format!("at://{handle}")],
        "verificationMethod": [{
            "id": "#atproto",
            "type": "Multikey",
            "controller": did,
            "publicKeyMultibase": public_key_multibase,
        }],
        "service": [{
            "id": "#atproto_pds",
            "type": "AtprotoPersonalDataServer",
            "serviceEndpoint": service_endpoint,
        }],
    })
}

pub(super) async fn fetch_internal_directory_json(
    env: &Env,
    directory_name: &str,
    method: Method,
    path: &str,
    body: &Value,
) -> Result<Response, HttpError> {
    fetch_internal_directory_request(env, directory_name, method, path, Some(body)).await
}

pub(super) async fn fetch_internal_directory_request(
    env: &Env,
    directory_name: &str,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Response, HttpError> {
    let namespace = env
        .durable_object("DIRECTORY_OBJECTS")
        .map_err(HttpError::worker)?;
    let id = namespace
        .id_from_name(directory_name)
        .map_err(HttpError::worker)?;
    let stub = id.get_stub().map_err(HttpError::worker)?;

    let headers = Headers::new();
    headers
        .set("content-type", "application/json")
        .map_err(HttpError::worker)?;
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(JsValue::from_str(
            &to_string(body).map_err(HttpError::worker)?,
        )));
    }
    let request = Request::new_with_init(&format!("https://pds.internal{path}"), &init)
        .map_err(HttpError::worker)?;

    stub.fetch_with_request(request)
        .await
        .map_err(HttpError::worker)
}

pub(super) async fn fetch_oauth_client_metadata(client_id: &str) -> Result<Value, HttpError> {
    let url = ::url::Url::parse(client_id)
        .map_err(|error| HttpError::new(400, format!("invalid client_id: {error}")))?;
    let mut response = Fetch::Url(url).send().await.map_err(HttpError::worker)?;
    if response.status_code() != 200 {
        return Err(HttpError::new(
            400,
            format!(
                "client metadata fetch failed with status {}",
                response.status_code()
            ),
        ));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .map_err(HttpError::worker)?
        .and_then(|value| value.split(';').next().map(|part| part.trim().to_string()))
        .unwrap_or_default();
    if !content_type.eq_ignore_ascii_case("application/json") {
        return Err(HttpError::new(
            400,
            "client metadata response must have content-type application/json",
        ));
    }
    response.json().await.map_err(HttpError::worker)
}

pub(super) async fn fetch_oauth_jwks(jwks_uri: &str) -> Result<Value, HttpError> {
    let url = ::url::Url::parse(jwks_uri)
        .map_err(|error| HttpError::new(400, format!("invalid jwks_uri: {error}")))?;
    let mut response = Fetch::Url(url).send().await.map_err(HttpError::worker)?;
    if response.status_code() != 200 {
        return Err(HttpError::new(
            400,
            format!("JWKS fetch failed with status {}", response.status_code()),
        ));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .map_err(HttpError::worker)?
        .and_then(|value| value.split(';').next().map(|part| part.trim().to_string()))
        .unwrap_or_default();
    if !content_type.eq_ignore_ascii_case("application/json") {
        return Err(HttpError::new(
            400,
            "JWKS response must have content-type application/json",
        ));
    }
    response.json().await.map_err(HttpError::worker)
}

pub(super) fn directory_repo_json(row: DirectoryRepoRow) -> Value {
    json!({
        "did": row.did.to_string(),
        "head": row.head.to_string(),
        "rev": row.rev.to_string(),
        "active": row.active,
        "handle": row.handle,
        "repoName": row.repo_name,
    })
}

pub(super) fn invite_code_json(
    row: &DirectoryInviteCodeRow,
    uses: &[DirectoryInviteCodeUseRow],
) -> Value {
    json!({
        "code": row.code.clone(),
        "available": row.available,
        "disabled": row.disabled,
        "forAccount": row.for_account.to_string(),
        "createdBy": row.created_by.to_string(),
        "createdAt": row.created_at.clone(),
        "uses": uses.iter().map(invite_code_use_json).collect::<Vec<_>>(),
    })
}

pub(super) fn invite_code_use_json(row: &DirectoryInviteCodeUseRow) -> Value {
    json!({
        "usedBy": row.used_by.to_string(),
        "usedAt": row.used_at.clone(),
    })
}

pub(super) fn account_view_json(
    account: &DirectoryAccountRow,
    invites: Option<Vec<Value>>,
) -> Value {
    let mut body = json!({
        "did": account.did.to_string(),
        "handle": account.handle.clone(),
        "email": account.email.clone(),
        "relatedRecords": [],
        "indexedAt": account.created_at.clone(),
        "invitesDisabled": account.invites_disabled,
    });
    if account.email_confirmed {
        body["emailConfirmedAt"] = json!(account.created_at.clone());
    }
    if let Some(note) = account.invite_note.as_deref() {
        body["inviteNote"] = json!(note);
    }
    if !account.active {
        body["deactivatedAt"] = json!(account.created_at.clone());
    }
    if let Some(invites) = invites {
        body["invites"] = json!(invites);
    }
    body
}

pub(super) fn subject_status_json(account: &DirectoryAccountRow) -> Value {
    let mut body = json!({
        "subject": {
            "$type": "com.atproto.admin.defs#repoRef",
            "did": account.did.to_string(),
        },
        "takedown": {
            "applied": account.status.as_deref() == Some("takedown"),
        },
        "deactivated": {
            "applied": !account.active && account.status.as_deref() != Some("takedown"),
        },
    });
    if let Some(status) = account
        .status
        .as_deref()
        .filter(|status| !status.is_empty())
    {
        body["status"] = json!(status);
    }
    body
}

pub(super) fn query_pairs(url: &worker::Url) -> Vec<(String, String)> {
    url.query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

pub(super) fn did_array_param(
    query: &[(String, String)],
    param: &'static str,
) -> Result<Vec<Did>, HttpError> {
    let values = query
        .iter()
        .filter(|(key, _)| key == param)
        .flat_map(|(_, value)| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Did::new(value.to_string()).map_err(HttpError::bad_request))
        .collect::<Result<Vec<_>, _>>()?;
    if values.is_empty() {
        return Err(HttpError::new(
            400,
            format!("missing required param `{param}`"),
        ));
    }
    Ok(values)
}

pub(super) fn encode_query_component(value: &str) -> String {
    ::url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum InternalRepoControlAction {
    Status,
    Init,
    Clear,
    Identity,
    SigningKey,
    ServiceAuth,
}

impl InternalRepoControlAction {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Status => INTERNAL_REPO_CONTROL_STATUS,
            Self::Init => INTERNAL_REPO_CONTROL_INIT,
            Self::Clear => INTERNAL_REPO_CONTROL_CLEAR,
            Self::Identity => INTERNAL_REPO_CONTROL_IDENTITY,
            Self::SigningKey => INTERNAL_REPO_CONTROL_SIGNING_KEY,
            Self::ServiceAuth => INTERNAL_REPO_CONTROL_SERVICE_AUTH,
        }
    }

    pub(super) fn from_str(value: &str) -> Option<Self> {
        match value {
            INTERNAL_REPO_CONTROL_STATUS => Some(Self::Status),
            INTERNAL_REPO_CONTROL_INIT => Some(Self::Init),
            INTERNAL_REPO_CONTROL_CLEAR => Some(Self::Clear),
            INTERNAL_REPO_CONTROL_IDENTITY => Some(Self::Identity),
            INTERNAL_REPO_CONTROL_SIGNING_KEY => Some(Self::SigningKey),
            INTERNAL_REPO_CONTROL_SERVICE_AUTH => Some(Self::ServiceAuth),
            _ => None,
        }
    }
}

pub(super) fn internal_repo_control_url(
    url: &worker::Url,
    repo_name: &str,
    action: InternalRepoControlAction,
) -> String {
    format!(
        "{}/{}/{}/{}/{}",
        request_origin(url),
        INTERNAL_REPO_CONTROL_ROOT,
        INTERNAL_REPO_CONTROL_REPOS,
        encode_query_component(repo_name),
        action.as_str(),
    )
}

pub(super) fn internal_repo_control_parts<'a>(
    parts: &'a [&'a str],
) -> Option<(&'a str, InternalRepoControlAction)> {
    if parts.len() == 4
        && parts[0] == INTERNAL_REPO_CONTROL_ROOT
        && parts[1] == INTERNAL_REPO_CONTROL_REPOS
        && !parts[2].is_empty()
    {
        Some((parts[2], InternalRepoControlAction::from_str(parts[3])?))
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum InternalDirectoryControlAction {
    Status,
    AccountStatus,
    RepoUpsert,
}

pub(super) fn internal_directory_account_status_path(did: &str) -> String {
    format!(
        "/{}/{}/{}/{}?did={}",
        INTERNAL_REPO_CONTROL_ROOT,
        INTERNAL_DIRECTORY_CONTROL_DIRECTORY,
        INTERNAL_DIRECTORY_CONTROL_ACCOUNTS,
        INTERNAL_DIRECTORY_CONTROL_STATUS,
        encode_query_component(did),
    )
}

pub(super) fn internal_directory_repo_upsert_path() -> String {
    format!(
        "/{}/{}/{}/{}",
        INTERNAL_REPO_CONTROL_ROOT,
        INTERNAL_DIRECTORY_CONTROL_DIRECTORY,
        INTERNAL_DIRECTORY_CONTROL_REPOS,
        INTERNAL_DIRECTORY_CONTROL_UPSERT,
    )
}

pub(super) fn internal_directory_control_action(
    parts: &[&str],
) -> Option<InternalDirectoryControlAction> {
    match parts {
        [root, directory, status]
            if *root == INTERNAL_REPO_CONTROL_ROOT
                && *directory == INTERNAL_DIRECTORY_CONTROL_DIRECTORY
                && *status == INTERNAL_DIRECTORY_CONTROL_STATUS =>
        {
            Some(InternalDirectoryControlAction::Status)
        }
        [root, directory, accounts, status]
            if *root == INTERNAL_REPO_CONTROL_ROOT
                && *directory == INTERNAL_DIRECTORY_CONTROL_DIRECTORY
                && *accounts == INTERNAL_DIRECTORY_CONTROL_ACCOUNTS
                && *status == INTERNAL_DIRECTORY_CONTROL_STATUS =>
        {
            Some(InternalDirectoryControlAction::AccountStatus)
        }
        [root, directory, repos, upsert]
            if *root == INTERNAL_REPO_CONTROL_ROOT
                && *directory == INTERNAL_DIRECTORY_CONTROL_DIRECTORY
                && *repos == INTERNAL_DIRECTORY_CONTROL_REPOS
                && *upsert == INTERNAL_DIRECTORY_CONTROL_UPSERT =>
        {
            Some(InternalDirectoryControlAction::RepoUpsert)
        }
        _ => None,
    }
}

pub(super) fn request_host(req: &Request) -> Result<String, HttpError> {
    req.url()
        .map_err(HttpError::worker)?
        .host_str()
        .map(|host| host.to_string())
        .ok_or_else(|| HttpError::new(400, "request host is required"))
}

pub(super) fn is_host_identity_path(path: &str) -> bool {
    matches!(path, DID_DOCUMENT_PATH | ATPROTO_DID_PATH)
}

pub(super) fn parse_xrpc_limit(
    value: Option<&str>,
    default: usize,
    max: usize,
) -> Result<usize, HttpError> {
    let Some(value) = value else {
        return Ok(default);
    };
    if value.is_empty() {
        return Ok(default);
    }
    let limit = value
        .parse::<usize>()
        .map_err(|_| HttpError::new(400, format!("invalid limit `{value}`")))?;
    if !(1..=max).contains(&limit) {
        return Err(HttpError::new(
            400,
            format!("invalid limit `{value}`: expected an integer from 1 to {max}"),
        ));
    }
    Ok(limit)
}

pub(super) fn bool_param(
    query: &[(String, String)],
    param: &str,
    default: bool,
) -> Result<bool, HttpError> {
    let Some(value) = optional_param(query, param) else {
        return Ok(default);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "" => Ok(default),
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(HttpError::new(
            400,
            format!("invalid boolean query parameter `{param}`"),
        )),
    }
}

pub(super) fn request_origin(url: &worker::Url) -> String {
    let mut origin = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or("localhost")
    );
    if let Some(port) = url.port() {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    origin
}

pub(super) fn handle_is_correct(repo_param: &str, handle: &str, did: &str) -> bool {
    (repo_param == handle || repo_param == did)
        && did
            .strip_prefix("did:web:")
            .is_some_and(|host| host == handle)
}

pub(super) fn ensure_repo_did(state: &RepoStateRow, did: &str) -> Result<(), HttpError> {
    if state.did.as_str() == did {
        Ok(())
    } else {
        Err(HttpError::new(404, "repo not found"))
    }
}
