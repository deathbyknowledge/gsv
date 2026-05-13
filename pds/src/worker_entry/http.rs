use super::*;

pub(super) struct HttpError {
    pub(super) status: u16,
    pub(super) message: String,
}

impl HttpError {
    pub(super) fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub(super) fn bad_request(error: impl std::error::Error) -> Self {
        Self::new(400, error.to_string())
    }

    pub(super) fn worker(error: impl std::fmt::Display) -> Self {
        Self::new(500, error.to_string())
    }

    pub(super) fn xrpc(error: XrpcError) -> Self {
        Self::new(400, error.to_string())
    }

    pub(super) fn identity(error: IdentityError) -> Self {
        Self::new(400, error.to_string())
    }

    pub(super) fn plc(error: PlcError) -> Self {
        match error {
            PlcError::BadRequest(message) => Self::new(400, message),
            PlcError::Cbor(error) => Self::worker(error),
            PlcError::Identity(error) => Self::identity(error),
        }
    }

    pub(super) fn auth(error: crate::auth::AuthError) -> Self {
        Self::new(401, error.to_string())
    }

    pub(super) fn storage(error: StorageError) -> Self {
        Self::new(500, error.to_string())
    }

    pub(super) fn import(error: RepoImportError) -> Self {
        Self::new(400, error.to_string())
    }

    pub(super) fn car(error: CarError) -> Self {
        match error {
            CarError::MissingBlock { .. } => Self::new(500, error.to_string()),
            _ => Self::worker(error),
        }
    }

    pub(super) fn repo(error: RepoError) -> Self {
        match error {
            RepoError::RecordAlreadyExists { .. } => Self::new(409, error.to_string()),
            RepoError::RecordNotFound { .. }
            | RepoError::MissingRecordBlock { .. }
            | RepoError::MissingCommit { .. } => Self::new(404, error.to_string()),
            RepoError::Commit(crate::commit::CommitError::InvalidDid { .. })
            | RepoError::Commit(crate::commit::CommitError::InvalidRev { .. }) => {
                Self::new(400, error.to_string())
            }
            _ => Self::worker(error),
        }
    }
}

pub(super) fn car_response(bytes: Vec<u8>) -> worker::Result<Response> {
    let mut response = Response::from_bytes(bytes)?;
    response
        .headers_mut()
        .set("content-type", "application/vnd.ipld.car")?;
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn blob_response(bytes: Vec<u8>, mime_type: &str) -> worker::Result<Response> {
    let mut response = Response::from_bytes(bytes)?;
    response.headers_mut().set("content-type", mime_type)?;
    response
        .headers_mut()
        .set("content-security-policy", "default-src 'none'; sandbox")?;
    response
        .headers_mut()
        .set("x-content-type-options", "nosniff")?;
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn blob_stream_response(
    body: ResponseBody,
    mime_type: &str,
    byte_len: i64,
) -> worker::Result<Response> {
    let mut response = Response::from_body(body)?;
    response.headers_mut().set("content-type", mime_type)?;
    response
        .headers_mut()
        .set("content-security-policy", "default-src 'none'; sandbox")?;
    response
        .headers_mut()
        .set("x-content-type-options", "nosniff")?;
    if byte_len >= 0 {
        response
            .headers_mut()
            .set("content-length", &byte_len.to_string())?;
    }
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn json_response(status: u16, value: &impl Serialize) -> worker::Result<Response> {
    let mut response = Response::from_json(value)?.with_status(status);
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn oauth_error_response(
    status: u16,
    error: &str,
    error_description: &str,
) -> worker::Result<Response> {
    let mut response = Response::from_json(&json!({
        "error": error,
        "error_description": error_description,
    }))?
    .with_status(status);
    response.headers_mut().set("cache-control", "no-store")?;
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn oauth_request_error_response(error: OAuthRequestError) -> worker::Result<Response> {
    oauth_error_response(400, error.error_code(), &error.to_string())
}

pub(super) fn oauth_dpop_error_response(
    error: DpopError,
    nonce: Option<&str>,
) -> worker::Result<Response> {
    let error_code = if matches!(error, DpopError::NonceMismatch) {
        "use_dpop_nonce"
    } else {
        "invalid_dpop_proof"
    };
    let mut response = oauth_error_response(400, error_code, &error.to_string())?;
    if let Some(nonce) = nonce {
        response.headers_mut().set("dpop-nonce", nonce)?;
    }
    Ok(response)
}

pub(super) fn oauth_authorization_redirect(
    redirect_uri: &str,
    code: &str,
    state: &str,
    issuer: &str,
) -> Result<Response, HttpError> {
    let mut redirect = ::url::Url::parse(redirect_uri)
        .map_err(|error| HttpError::new(400, format!("invalid redirect_uri: {error}")))?;
    {
        let mut query = redirect.query_pairs_mut();
        query.append_pair("code", code);
        query.append_pair("state", state);
        query.append_pair("iss", issuer);
    }

    let mut response = Response::empty()
        .map_err(HttpError::worker)?
        .with_status(302);
    response
        .headers_mut()
        .set("location", redirect.as_str())
        .map_err(HttpError::worker)?;
    response
        .headers_mut()
        .set("cache-control", "no-store")
        .map_err(HttpError::worker)?;
    set_cors(&mut response).map_err(HttpError::worker)?;
    Ok(response)
}

pub(super) fn oauth_authorization_error_redirect(
    redirect_uri: &str,
    error: &str,
    error_description: &str,
    state: &str,
    issuer: &str,
) -> Result<Response, HttpError> {
    let mut redirect = ::url::Url::parse(redirect_uri).map_err(|parse_error| {
        HttpError::new(400, format!("invalid redirect_uri: {parse_error}"))
    })?;
    {
        let mut query = redirect.query_pairs_mut();
        query.append_pair("error", error);
        query.append_pair("error_description", error_description);
        query.append_pair("state", state);
        query.append_pair("iss", issuer);
    }

    let mut response = Response::empty()
        .map_err(HttpError::worker)?
        .with_status(302);
    response
        .headers_mut()
        .set("location", redirect.as_str())
        .map_err(HttpError::worker)?;
    response
        .headers_mut()
        .set("cache-control", "no-store")
        .map_err(HttpError::worker)?;
    set_cors(&mut response).map_err(HttpError::worker)?;
    Ok(response)
}

pub(super) fn oauth_authorization_form_response(
    status: u16,
    par: &DirectoryOauthParRequestRow,
    error: Option<&str>,
) -> worker::Result<Response> {
    let login_hint = par.login_hint.as_deref().unwrap_or_default();
    let error_html = error
        .map(|message| {
            format!(
                r#"<div class="error" role="alert">{}</div>"#,
                html_escape(message)
            )
        })
        .unwrap_or_default();
    let scopes = par
        .scope
        .split_whitespace()
        .map(|scope| format!("<li>{}</li>", html_escape(scope)))
        .collect::<String>();
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize client</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #15171a; }}
main {{ width: min(92vw, 440px); background: #fff; border: 1px solid #d9dde3; border-radius: 8px; padding: 24px; box-shadow: 0 16px 48px rgb(20 28 40 / 12%); }}
h1 {{ font-size: 1.35rem; margin: 0 0 12px; }}
p {{ line-height: 1.45; margin: 0 0 16px; }}
code {{ overflow-wrap: anywhere; }}
label {{ display: block; font-weight: 600; margin: 14px 0 6px; }}
input[type="text"], input[type="password"] {{ box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #b8c0cc; border-radius: 6px; font: inherit; }}
.consent {{ display: flex; gap: 10px; align-items: flex-start; margin: 16px 0; font-weight: 500; }}
.consent input {{ margin-top: 3px; }}
.actions {{ display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }}
button {{ border: 0; border-radius: 6px; padding: 10px 14px; font: inherit; cursor: pointer; }}
button.primary {{ background: #175bcc; color: #fff; }}
button.secondary {{ background: #e8ebf0; color: #1f252d; }}
.error {{ border: 1px solid #d83b3b; background: #fff0f0; color: #9b1c1c; padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #111418; color: #f0f3f6; }} main {{ background: #191e24; border-color: #303842; }} input[type="text"], input[type="password"] {{ background: #111418; border-color: #4a5563; color: #f0f3f6; }} button.secondary {{ background: #2b333d; color: #f0f3f6; }} }}
</style>
</head>
<body>
<main>
<h1>Authorize client</h1>
{error_html}
<p><code>{client_id}</code> is requesting access to this account.</p>
<p>Requested scopes:</p>
<ul>{scopes}</ul>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="client_id" value="{client_id_attr}">
<input type="hidden" name="request_uri" value="{request_uri_attr}">
<label for="identifier">Account</label>
<input id="identifier" name="identifier" type="text" autocomplete="username" value="{identifier_attr}" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<label class="consent"><input name="consent" type="checkbox" value="yes" required><span>Approve this client for the requested scopes.</span></label>
<div class="actions">
<button class="secondary" type="submit" name="approve" value="no" formnovalidate>Cancel</button>
<button class="primary" type="submit" name="approve" value="yes">Authorize</button>
</div>
</form>
</main>
</body>
</html>"#,
        client_id = html_escape(&par.client_id),
        client_id_attr = html_attr_escape(&par.client_id),
        request_uri_attr = html_attr_escape(&par.request_uri),
        identifier_attr = html_attr_escape(login_hint),
    );
    html_response(status, &html)
}

pub(super) fn oauth_par_response(
    request_uri: &str,
    expires_in: i64,
    dpop_nonce: &str,
) -> worker::Result<Response> {
    let mut response = Response::from_json(&json!({
        "request_uri": request_uri,
        "expires_in": expires_in,
    }))?
    .with_status(201);
    response.headers_mut().set("cache-control", "no-store")?;
    response.headers_mut().set("dpop-nonce", dpop_nonce)?;
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn oauth_token_response(
    tokens: &SessionTokens,
    scope: &str,
    sub: &str,
    dpop_nonce: &str,
) -> worker::Result<Response> {
    let mut response = Response::from_json(&json!({
        "access_token": &tokens.access_jwt,
        "token_type": "DPoP",
        "expires_in": ACCESS_TOKEN_TTL_SECONDS,
        "refresh_token": &tokens.refresh_jwt,
        "scope": scope,
        "sub": sub,
    }))?;
    response.headers_mut().set("cache-control", "no-store")?;
    response.headers_mut().set("pragma", "no-cache")?;
    response.headers_mut().set("dpop-nonce", dpop_nonce)?;
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn text_response(status: u16, value: &str) -> worker::Result<Response> {
    let mut response = Response::from_bytes(value.as_bytes().to_vec())?.with_status(status);
    response.headers_mut().set("content-type", "text/plain")?;
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn html_response(status: u16, value: &str) -> worker::Result<Response> {
    let mut response = Response::from_bytes(value.as_bytes().to_vec())?.with_status(status);
    response
        .headers_mut()
        .set("content-type", "text/html; charset=utf-8")?;
    response.headers_mut().set("cache-control", "no-store")?;
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn empty_response(status: u16) -> worker::Result<Response> {
    let mut response = Response::empty()?.with_status(status);
    set_cors(&mut response)?;
    Ok(response)
}

pub(super) fn set_cors(response: &mut Response) -> worker::Result<()> {
    let headers = response.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    )?;
    headers.set(
        "Access-Control-Allow-Headers",
        "authorization, content-type, dpop, x-pds-admin-token",
    )?;
    headers.set("Access-Control-Expose-Headers", "dpop-nonce")?;
    Ok(())
}

pub(super) fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(super) fn html_attr_escape(value: &str) -> String {
    html_escape(value).replace('"', "&quot;")
}
