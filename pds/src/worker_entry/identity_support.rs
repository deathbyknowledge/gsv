use super::*;
use crate::atproto_resolver::ResolverError;

pub(super) async fn validate_hosted_account_did_document(
    handle: &str,
    did: &str,
    origin: &str,
    public_key_multibase: &str,
    env: &Env,
) -> Result<(), HttpError> {
    let doc = fetch_did_document_with_env(did, env).await?;
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

pub(super) fn is_identity_did(did: &str) -> bool {
    did.starts_with("did:plc:") || did.starts_with("did:web:")
}

pub(super) async fn account_identity_for_creation(
    env: &Env,
    handle: &str,
    requested_did: Option<&str>,
    requested_recovery_key: Option<&str>,
    request_host: &str,
    pds_origin: &str,
    signing_did_key: &str,
) -> Result<AccountCreationIdentity, HttpError> {
    validate_account_handle_syntax(env, handle)?;
    let Some(requested_did) = requested_did else {
        if let Some(rotation_signing_key) = plc_rotation_signing_key_from_env(env)? {
            validate_local_account_handle_for_creation(env, handle, request_host)?;
            let rotation_did_key = did_key_from_public_key_multibase(
                &rotation_signing_key
                    .public_key_multibase()
                    .map_err(HttpError::identity)?,
            )?;
            let mut rotation_keys = Vec::new();
            if let Some(recovery_key) = requested_recovery_key {
                validate_did_key_syntax(recovery_key)?;
                rotation_keys.push(recovery_key.to_string());
            } else {
                rotation_keys.extend(recommended_plc_recovery_keys(env)?);
            }
            rotation_keys.push(rotation_did_key);
            let created = create_plc_operation(
                handle,
                pds_origin,
                signing_did_key,
                &rotation_keys,
                &rotation_signing_key,
            )
            .map_err(HttpError::plc)?;
            let did = Did::new(created.did).map_err(HttpError::bad_request)?;
            return Ok(AccountCreationIdentity {
                repo_name: repo_object_name_from_identifier(did.as_str()),
                did,
                validate_did_document: false,
                plc_operation: Some(created.operation),
                deactivated: false,
            });
        }
        let did = Did::new(format!("did:web:{handle}")).map_err(HttpError::bad_request)?;
        validate_account_handle_for_creation(env, handle, request_host, did.as_str()).await?;
        return Ok(AccountCreationIdentity {
            repo_name: handle.to_string(),
            did,
            validate_did_document: true,
            plc_operation: None,
            deactivated: false,
        });
    };

    let did = Did::new(requested_did.to_string()).map_err(HttpError::bad_request)?;
    if requested_recovery_key.is_some() {
        return Err(HttpError::new(
            400,
            "Unsupported input: `recoveryKey` is only supported for locally-created did:plc accounts",
        ));
    }
    if !did.as_str().starts_with("did:gsv:") {
        return Err(HttpError::new(
            400,
            "UnsupportedDid: admin-created custom accounts currently support did:gsv DIDs only",
        ));
    }
    let repo_name = repo_object_name_from_identifier(did.as_str());
    if repo_name.is_empty() {
        return Err(HttpError::new(400, "InvalidDid"));
    }
    Ok(AccountCreationIdentity {
        did,
        repo_name,
        validate_did_document: false,
        plc_operation: None,
        deactivated: false,
    })
}

pub(super) fn account_identity_for_import(
    env: &Env,
    handle: &str,
    requested_did: &str,
    requested_recovery_key: Option<&str>,
    plc_operation: Option<Value>,
    pds_origin: &str,
    public_key_multibase: &str,
) -> Result<AccountCreationIdentity, HttpError> {
    validate_account_handle_syntax(env, handle)?;
    if requested_recovery_key.is_some() {
        return Err(HttpError::new(
            400,
            "Unsupported input: `recoveryKey` is only supported for locally-created did:plc accounts",
        ));
    }
    let did = Did::new(requested_did.to_string()).map_err(HttpError::bad_request)?;
    if !is_supported_account_import_did(did.as_str()) {
        return Err(HttpError::new(
            400,
            "UnsupportedDid: imported accounts require did:plc or did:web",
        ));
    }
    if let Some(operation) = plc_operation.as_ref() {
        ensure_plc_did(&did)?;
        let Some(server_rotation_key) = plc_rotation_did_key_from_env(env)? else {
            return Err(HttpError::new(501, "PLC rotation key is not configured"));
        };
        validate_submitted_plc_operation(
            operation,
            pds_origin,
            handle,
            public_key_multibase,
            &server_rotation_key,
        )
        .map_err(HttpError::plc)?;
    }
    let repo_name = repo_object_name_from_identifier(did.as_str());
    if repo_name.is_empty() {
        return Err(HttpError::new(400, "InvalidDid"));
    }
    Ok(AccountCreationIdentity {
        did,
        repo_name,
        validate_did_document: false,
        plc_operation,
        deactivated: true,
    })
}

pub(super) fn is_supported_account_import_did(did: &str) -> bool {
    did.starts_with("did:plc:") || did.starts_with("did:web:")
}

pub(super) struct AccountCreationIdentity {
    pub(super) did: Did,
    pub(super) repo_name: String,
    pub(super) validate_did_document: bool,
    pub(super) plc_operation: Option<Value>,
    pub(super) deactivated: bool,
}

pub(super) fn validate_local_account_handle_for_creation(
    env: &Env,
    handle: &str,
    request_host: &str,
) -> Result<(), HttpError> {
    validate_account_handle_syntax(env, handle)?;
    if handle == request_host || configured_account_handle_allowed(env, handle) {
        Ok(())
    } else {
        Err(HttpError::new(
            400,
            format!(
                "UnsupportedDomain: `{handle}` is not the request host `{request_host}` and is not allowed by PDS_ALLOWED_ACCOUNT_HANDLES or PDS_ALLOWED_ACCOUNT_HANDLE_SUFFIXES"
            ),
        ))
    }
}

pub(super) fn configured_account_handle_allowed(env: &Env, handle: &str) -> bool {
    env_list(env, "PDS_ALLOWED_ACCOUNT_HANDLES")
        .iter()
        .any(|allowed| allowed == "*" || allowed.eq_ignore_ascii_case(handle))
        || env_list(env, "PDS_ALLOWED_ACCOUNT_HANDLE_SUFFIXES")
            .iter()
            .any(|suffix| handle_matches_suffix(handle, suffix))
        || (gsv_dev_mode(env) && local_dev_handle_port(handle).is_some())
}

pub(super) fn validate_account_handle_syntax(env: &Env, handle: &str) -> Result<(), HttpError> {
    match validate_handle_syntax(handle) {
        Ok(()) => Ok(()),
        Err(ResolverError::ReservedHandleTld(tld))
            if tld == "local" && gsv_dev_mode(env) && local_dev_handle_port(handle).is_some() =>
        {
            Ok(())
        }
        Err(error) => Err(HttpError::bad_request(error)),
    }
}

pub(super) fn handle_matches_suffix(handle: &str, suffix: &str) -> bool {
    let suffix = suffix.trim_start_matches('.');
    handle.eq_ignore_ascii_case(suffix)
        || handle
            .strip_suffix(suffix)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

pub(super) fn normalize_at_identifier(identifier: &str) -> String {
    if identifier.starts_with("did:") {
        identifier.to_string()
    } else {
        identifier.to_ascii_lowercase()
    }
}

pub(super) fn env_list(env: &Env, name: &str) -> Vec<String> {
    env.var(name)
        .ok()
        .map(|value| value.to_string())
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub(super) fn gsv_dev_mode(env: &Env) -> bool {
    env.var("GSV_DEV")
        .ok()
        .map(|value| {
            matches!(
                value.to_string().trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub(super) fn dev_social_origin_for_handle(env: &Env, handle: &str) -> Option<String> {
    if !gsv_dev_mode(env) {
        return None;
    }
    let handle = handle.trim().to_ascii_lowercase();
    for entry in env_list(env, "GSV_DEV_SOCIAL_ORIGINS") {
        let Some((entry_handle, entry_origin)) = entry.split_once('=') else {
            continue;
        };
        if entry_handle.trim().eq_ignore_ascii_case(&handle) {
            let origin = entry_origin.trim().trim_end_matches('/').to_string();
            if !origin.is_empty() {
                return Some(origin);
            }
        }
    }
    local_dev_handle_port(&handle).map(|port| format!("http://localhost:{port}"))
}

pub(super) fn dev_social_origin_for_did(env: &Env, did: &str) -> Option<String> {
    let handle = did_web_handle(did)?;
    dev_social_origin_for_handle(env, &handle)
}

fn did_web_handle(did: &str) -> Option<String> {
    did.strip_prefix("did:web:")
        .map(|handle| handle.replace(':', ".").to_ascii_lowercase())
}

fn local_dev_handle_port(handle: &str) -> Option<u16> {
    let port = handle.strip_prefix("gsv-")?.strip_suffix(".gsv.local")?;
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    match port.parse::<u16>().ok()? {
        0 => None,
        parsed => Some(parsed),
    }
}

pub(super) fn ensure_password_strength(password: &str) -> Result<(), HttpError> {
    if password.len() < 8 {
        Err(HttpError::new(
            400,
            "InvalidPassword: password must be at least 8 characters",
        ))
    } else {
        Ok(())
    }
}

pub(super) fn ensure_app_password_name(name: &str) -> Result<(), HttpError> {
    let len = name.chars().count();
    if name.trim().is_empty() || len > 64 {
        return Err(HttpError::new(
            400,
            "InvalidName: app password name must be 1-64 characters",
        ));
    }
    Ok(())
}

pub(super) fn generate_app_password() -> Result<String, HttpError> {
    random_urlsafe_token::<APP_PASSWORD_BYTES>()
}

pub(super) fn action_token_digest(token: &str) -> String {
    BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

pub(super) fn action_token_response(
    env: &Env,
    req: &Request,
    token: Option<&str>,
) -> worker::Result<Response> {
    if is_admin_authorized(env, req).unwrap_or(false) {
        let mut body = json!({});
        if let Some(token) = token {
            body["token"] = json!(token);
        }
        json_response(200, &body)
    } else {
        empty_response(200)
    }
}

pub(super) fn normalize_required_email(email: &str) -> Result<String, HttpError> {
    let email = email.trim().to_ascii_lowercase();
    let Some((local, domain)) = email.split_once('@') else {
        return Err(HttpError::new(400, "InvalidEmail"));
    };
    if email.len() > 254
        || local.is_empty()
        || domain.is_empty()
        || domain.starts_with('.')
        || domain.ends_with('.')
        || !domain.contains('.')
    {
        return Err(HttpError::new(400, "InvalidEmail"));
    }
    Ok(email)
}

pub(super) fn normalize_account_email(email: Option<String>) -> Option<String> {
    email
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

pub(super) fn session_response(
    url: &worker::Url,
    account: &DirectoryAccountRow,
    tokens: Option<SessionTokens>,
) -> Value {
    let mut body = json!({
        "did": account.did.to_string(),
        "handle": account.handle.clone(),
        "active": account.active,
        "didDoc": did_document(
            account.did.as_str(),
            &account.handle,
            &account.public_key_multibase,
            &request_origin(url),
        ),
    });
    if let Some(status) = &account.status {
        body["status"] = json!(status);
    }
    if let Some(email) = &account.email {
        body["email"] = json!(email);
        body["emailConfirmed"] = json!(account.email_confirmed);
        body["emailAuthFactor"] = json!(false);
    }
    if let Some(tokens) = tokens {
        body["accessJwt"] = json!(tokens.access_jwt);
        body["refreshJwt"] = json!(tokens.refresh_jwt);
    }
    body
}

pub(super) fn identity_info_response_body(origin: &str, account: &DirectoryAccountRow) -> Value {
    json!({
        "did": account.did.to_string(),
        "handle": account.handle.clone(),
        "didDoc": did_document(
            account.did.as_str(),
            &account.handle,
            &account.public_key_multibase,
            origin,
        ),
    })
}

pub(super) fn recommended_plc_rotation_keys(env: &Env) -> Result<Vec<String>, HttpError> {
    let mut keys = recommended_plc_recovery_keys(env)?;
    if let Some(did_key) = plc_rotation_did_key_from_env(env)? {
        keys.push(did_key);
    }
    for key in &keys {
        validate_did_key_syntax(key)?;
    }
    Ok(keys)
}

pub(super) fn recommended_plc_recovery_keys(env: &Env) -> Result<Vec<String>, HttpError> {
    let mut keys = Vec::new();
    keys.extend(env_list(env, "PDS_PLC_RECOVERY_DID_KEYS"));
    if let Ok(value) = env.var("PDS_PLC_RECOVERY_DID_KEY") {
        let value = value.to_string();
        if !value.trim().is_empty() {
            keys.push(value.trim().to_string());
        }
    }
    let keys = keys
        .into_iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    for key in &keys {
        validate_did_key_syntax(key)?;
    }
    Ok(keys)
}

pub(super) fn plc_rotation_signing_key_from_env(
    env: &Env,
) -> Result<Option<RepoSigningKey>, HttpError> {
    let Ok(value) = env.var("PDS_PLC_ROTATION_KEY_P256_HEX") else {
        return Ok(None);
    };
    let value = value.to_string();
    if value.trim().is_empty() {
        return Ok(None);
    }
    RepoSigningKey::from_p256_hex(value.trim())
        .map(Some)
        .map_err(HttpError::identity)
}

pub(super) fn plc_rotation_did_key_from_env(env: &Env) -> Result<Option<String>, HttpError> {
    let Some(key) = plc_rotation_signing_key_from_env(env)? else {
        return Ok(None);
    };
    did_key_from_public_key_multibase(&key.public_key_multibase().map_err(HttpError::identity)?)
        .map(Some)
}

pub(super) fn ensure_plc_did(did: &Did) -> Result<(), HttpError> {
    if did.as_str().starts_with("did:plc:") {
        Ok(())
    } else {
        Err(HttpError::new(400, "DID is not a did:plc identity"))
    }
}

pub(super) async fn fetch_plc_last_operation(did: &str, env: &Env) -> Result<Value, HttpError> {
    let url = format!(
        "{}/{}/log/last",
        plc_directory_url(env),
        encode_query_component(did)
    );
    fetch_json_url(&url).await
}

pub(super) async fn submit_plc_operation(
    did: &str,
    operation: &Value,
    env: &Env,
) -> Result<(), HttpError> {
    let url = format!("{}/{}", plc_directory_url(env), encode_query_component(did));
    let mut response = post_json_url(&url, operation).await?;
    let status = response.status_code();
    if !(200..300).contains(&status) {
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "failed to read PLC response".to_string());
        return Err(HttpError::new(
            502,
            format!("PLC directory rejected operation with status {status}: {text}"),
        ));
    }
    Ok(())
}

pub(super) async fn verify_create_account_service_auth(
    req: &Request,
    expected_iss: &str,
    expected_aud: &str,
    expected_lxm: &str,
    now: i64,
    env: &Env,
) -> Result<(), HttpError> {
    let presented = authorization_token(req)?;
    if presented.scheme != AuthScheme::Bearer {
        return Err(HttpError::new(401, "service auth requires a bearer token"));
    }
    let did_doc = fetch_did_document_with_env(expected_iss, env).await?;
    verify_service_auth_jwt(
        &presented.token,
        expected_iss,
        expected_aud,
        expected_lxm,
        now,
        &did_doc,
    )
    .map_err(|error| HttpError::new(401, error.to_string()))
}

pub(super) fn plc_directory_url(env: &Env) -> String {
    env.var("PDS_PLC_DIRECTORY_URL")
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://plc.directory".to_string())
        .trim_end_matches('/')
        .to_string()
}

pub(super) fn validate_did_key_syntax(value: &str) -> Result<(), HttpError> {
    crate::plc::validate_did_key_syntax(value).map_err(HttpError::plc)
}

pub(super) fn did_from_admin_subject(subject: &Value) -> Result<Did, HttpError> {
    let Some(did) = subject.get("did").and_then(Value::as_str) else {
        return Err(HttpError::new(
            400,
            "UnsupportedSubject: only account DID subjects are implemented",
        ));
    };
    Did::new(did.to_string()).map_err(HttpError::bad_request)
}

pub(super) async fn optional_json_body<T>(req: &mut Request) -> Result<T, HttpError>
where
    T: for<'de> Deserialize<'de> + Default,
{
    let body = req.text().await.map_err(HttpError::worker)?;
    if body.trim().is_empty() {
        return Ok(T::default());
    }
    from_str(&body).map_err(HttpError::bad_request)
}

pub(super) fn did_key_from_public_key_multibase(
    public_key_multibase: &str,
) -> Result<String, HttpError> {
    crate::plc::did_key_from_public_key_multibase(public_key_multibase).map_err(HttpError::plc)
}

pub(super) fn normalize_did_key(signing_key: &str) -> Result<String, HttpError> {
    let signing_key = signing_key.trim();
    if let Some(public_key_multibase) = signing_key.strip_prefix("did:key:") {
        validate_public_key_multibase(public_key_multibase)?;
        return Ok(format!("did:key:{public_key_multibase}"));
    }
    validate_public_key_multibase(signing_key)?;
    Ok(format!("did:key:{signing_key}"))
}

pub(super) fn plc_operation_atproto_signing_key(operation: &Value) -> Result<String, HttpError> {
    operation
        .get("verificationMethods")
        .and_then(Value::as_object)
        .and_then(|methods| methods.get("atproto"))
        .and_then(Value::as_str)
        .map(normalize_did_key)
        .transpose()?
        .ok_or_else(|| HttpError::new(400, "InvalidSigningKey"))
}

pub(super) fn public_key_multibase_from_did_key(signing_key: &str) -> Result<String, HttpError> {
    let signing_key = normalize_did_key(signing_key)?;
    signing_key
        .strip_prefix("did:key:")
        .map(ToString::to_string)
        .ok_or_else(|| HttpError::new(400, "InvalidSigningKey"))
}

pub(super) fn validate_public_key_multibase(public_key_multibase: &str) -> Result<(), HttpError> {
    if !public_key_multibase.starts_with('z') {
        return Err(HttpError::new(400, "InvalidSigningKey"));
    }
    let decoded = bs58::decode(public_key_multibase.trim_start_matches('z'))
        .into_vec()
        .map_err(|_| HttpError::new(400, "InvalidSigningKey"))?;
    if decoded.len() == 35 && decoded.starts_with(&[0x80, 0x24]) {
        Ok(())
    } else {
        Err(HttpError::new(400, "InvalidSigningKey"))
    }
}

pub(super) fn service_auth_jwt(
    signing_key: &RepoSigningKey,
    iss: &str,
    aud: &str,
    lxm: Option<&str>,
    exp: i64,
) -> Result<String, HttpError> {
    let header = json!({
        "typ": "JWT",
        "alg": "ES256",
        "kid": format!("{iss}#atproto"),
    });
    let mut payload = json!({
        "iss": iss,
        "aud": aud,
        "exp": exp,
    });
    if let Some(lxm) = lxm {
        payload["lxm"] = json!(lxm);
    }
    let header = BASE64_URL_SAFE_NO_PAD.encode(to_vec(&header).map_err(HttpError::worker)?);
    let payload = BASE64_URL_SAFE_NO_PAD.encode(to_vec(&payload).map_err(HttpError::worker)?);
    let signing_input = format!("{header}.{payload}");
    let signature = signing_key
        .sign_sha256(signing_input.as_bytes())
        .map_err(HttpError::identity)?;
    Ok(format!(
        "{signing_input}.{}",
        BASE64_URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub(super) fn generate_repo_signing_key_hex() -> Result<String, HttpError> {
    for _ in 0..16 {
        let bytes = random_bytes::<REPO_SIGNING_KEY_BYTES>()?;
        let hex = hex_encode(&bytes);
        if RepoSigningKey::from_p256_hex(&hex).is_ok() {
            return Ok(hex);
        }
    }
    Err(HttpError::new(500, "failed to generate repo signing key"))
}

pub(super) fn random_token_id() -> Result<String, HttpError> {
    Ok(BASE64_STANDARD.encode(random_bytes::<SESSION_ID_BYTES>()?))
}

pub(super) fn random_urlsafe_token<const N: usize>() -> Result<String, HttpError> {
    Ok(BASE64_URL_SAFE_NO_PAD.encode(random_bytes::<N>()?))
}

pub(super) fn pkce_s256_challenge(verifier: &str) -> String {
    BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub(super) fn random_bytes<const N: usize>() -> Result<[u8; N], HttpError> {
    let mut bytes = [0_u8; N];
    fill_random_bytes(&mut bytes)?;
    Ok(bytes)
}

#[cfg(target_arch = "wasm32")]
pub(super) fn fill_random_bytes(bytes: &mut [u8]) -> Result<(), HttpError> {
    let array = js_sys::Uint8Array::new_with_length(bytes.len() as u32);
    let crypto = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("crypto"))
        .map_err(js_value_error)?;
    let get_random_values = js_sys::Reflect::get(&crypto, &JsValue::from_str("getRandomValues"))
        .map_err(js_value_error)?
        .dyn_into::<js_sys::Function>()
        .map_err(js_value_error)?;
    get_random_values
        .call1(&crypto, &array)
        .map_err(js_value_error)?;
    array.copy_to(bytes);
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn fill_random_bytes(bytes: &mut [u8]) -> Result<(), HttpError> {
    getrandom::fill(bytes).map_err(|error| HttpError::new(500, error.to_string()))
}

#[cfg(target_arch = "wasm32")]
pub(super) fn js_value_error(value: JsValue) -> HttpError {
    HttpError::new(
        500,
        value
            .as_string()
            .unwrap_or_else(|| "JavaScript error".to_string()),
    )
}

pub(super) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

pub(super) fn current_unix_time() -> i64 {
    (worker::Date::now().as_millis() / 1000) as i64
}

pub(super) fn current_datetime_string() -> String {
    js_sys::Date::new_0()
        .to_iso_string()
        .as_string()
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

pub(super) fn generated_initial_repo_rev() -> Result<RepoRev, HttpError> {
    let entropy = u64::from_le_bytes(random_bytes::<8>()?);
    RepoRev::new(generated_tid_from_entropy(entropy, 0)).map_err(HttpError::bad_request)
}

pub(super) fn generated_record_key(seed: &crate::cid::Cid) -> Result<RecordKey, HttpError> {
    RecordKey::new(generated_tid(seed)).map_err(HttpError::bad_request)
}

pub(super) fn generated_record_key_with_offset(
    seed: &crate::cid::Cid,
    offset: usize,
) -> Result<RecordKey, HttpError> {
    RecordKey::new(generated_tid_with_offset(seed, offset as u64)).map_err(HttpError::bad_request)
}

pub(super) fn generated_repo_rev(seed: &crate::cid::Cid) -> Result<RepoRev, HttpError> {
    RepoRev::new(generated_tid(seed)).map_err(HttpError::bad_request)
}

pub(super) fn generated_tid(seed: &crate::cid::Cid) -> String {
    generated_tid_with_offset(seed, 0)
}

pub(super) fn generated_tid_with_offset(seed: &crate::cid::Cid, offset: u64) -> String {
    let entropy = seed.hash().digest().last().copied().unwrap_or_default() as u64;
    generated_tid_from_entropy(entropy, offset)
}

pub(super) fn generated_tid_from_entropy(entropy: u64, offset: u64) -> String {
    const TID_ALPHABET: &[u8; 32] = b"234567abcdefghijklmnopqrstuvwxyz";
    let mut value = worker::Date::now()
        .as_millis()
        .saturating_mul(1000)
        .saturating_add(entropy)
        .saturating_add(offset);
    let mut bytes = [b'2'; 13];
    for byte in bytes.iter_mut().rev() {
        *byte = TID_ALPHABET[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8(bytes.to_vec()).expect("TID alphabet is ASCII")
}
