use chrono::{TimeZone, Utc};
use cliclack::password;
use gsv::config::CliConfig;
use gsv::connection::GatewayRpcError;
use gsv::kernel_client::{cli_peer_identity, BinaryBodyLimits, GatewayAuth, KernelClient};
use serde::Deserialize;
use serde_json::json;
use std::future::Future;
use std::io::{self, IsTerminal};

struct LoginRetryOptions<'a> {
    url: &'a str,
    cfg: &'a CliConfig,
    cli_token: Option<String>,
    cli_username: Option<String>,
    has_explicit_token: bool,
}

fn is_auth_failed_error(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<GatewayRpcError>()
        .map(|rpc_error| rpc_error.code == 401)
        .unwrap_or(false)
}

/// Runs a remote command with the saved session, an explicit `GSV_TOKEN`, or
/// a password prompt. When the saved session has ended, it asks once for the
/// password and retries.
pub(crate) async fn run_with_login_retry<F, Fut>(
    url: &str,
    cfg: &CliConfig,
    cli_token: Option<String>,
    cli_username: Option<String>,
    mut run_with_auth: F,
) -> Result<(), Box<dyn std::error::Error>>
where
    F: FnMut(GatewayAuth) -> Fut,
    Fut: Future<Output = Result<(), Box<dyn std::error::Error>>>,
{
    let has_explicit_token = normalize_auth_field(cli_token.clone()).is_some();
    attempt_user_command_with_login_retry(
        LoginRetryOptions {
            url,
            cfg,
            cli_token,
            cli_username,
            has_explicit_token,
        },
        &mut run_with_auth,
    )
    .await
}

async fn attempt_user_command_with_login_retry<F, Fut>(
    options: LoginRetryOptions<'_>,
    run_with_auth: &mut F,
) -> Result<(), Box<dyn std::error::Error>>
where
    F: FnMut(GatewayAuth) -> Fut,
    Fut: Future<Output = Result<(), Box<dyn std::error::Error>>>,
{
    let auth = resolve_interactive_gateway_auth(
        options.url,
        options.cfg,
        options.cli_token.clone(),
        options.cli_username.clone(),
    )
    .await?;

    match run_with_auth(auth).await {
        Ok(()) => Ok(()),
        Err(error) => {
            if !is_auth_failed_error(error.as_ref()) || options.has_explicit_token {
                return Err(error);
            }

            clear_cached_user_session_token()?;
            let refreshed = resolve_interactive_gateway_auth(
                options.url,
                options.cfg,
                options.cli_token,
                options.cli_username,
            )
            .await?;
            run_with_auth(refreshed).await
        }
    }
}

pub(crate) fn can_prompt_interactively() -> bool {
    io::stdin().is_terminal() && io::stdout().is_terminal()
}

fn normalize_auth_field(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn format_unix_ms(timestamp_ms: i64) -> String {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| timestamp_ms.to_string())
}

/// The host people know their Ship by, such as `me.ship.space`.
pub(crate) fn space_name(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed.host_str().map(|host| match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            })
        })
        .unwrap_or_else(|| url.to_string())
}

/// The WebSocket URL for what a person types after `gsv login`: a bare
/// address such as `me.ship.space`, or a full http(s) or ws(s) URL.
pub(crate) fn space_url(space: &str) -> Result<String, Box<dyn std::error::Error>> {
    let space = space.trim().trim_end_matches('/');
    if space.is_empty() {
        return Err("Give your Ship's address, for example: gsv login me.ship.space".into());
    }
    let with_scheme = if space.contains("://") {
        space.to_string()
    } else {
        let host = space.split(['/', ':']).next().unwrap_or_default();
        let local = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
        format!("{}://{space}", if local { "ws" } else { "wss" })
    };
    let mut parsed = url::Url::parse(&with_scheme)
        .map_err(|error| format!("`{space}` is not a Ship address: {error}"))?;
    let scheme = match parsed.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        other => return Err(format!("`{other}` addresses are not supported").into()),
    };
    if parsed.set_scheme(scheme).is_err() || parsed.host_str().is_none() {
        return Err(format!("`{space}` is not a Ship address").into());
    }
    if parsed.path().is_empty() || parsed.path() == "/" {
        parsed.set_path("/ws");
    }
    Ok(parsed.to_string())
}

fn resolve_gateway_username(cfg: &CliConfig, cli_username: Option<String>) -> Option<String> {
    normalize_auth_field(cli_username).or_else(|| normalize_auth_field(cfg.gateway_username()))
}

const DEFAULT_USER_SESSION_TTL_HOURS: u32 = 8;

#[derive(Debug, Deserialize)]
struct LoginTokenCreatePayload {
    token: LoginIssuedTokenPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginIssuedTokenPayload {
    token_id: String,
    token: String,
    expires_at: Option<i64>,
}

/// A short-lived CLI session issued by `sys.token.create`.
pub(crate) struct Session {
    pub(crate) username: String,
    token: String,
    token_id: String,
    pub(crate) expires_at: Option<i64>,
}

async fn issue_user_session(
    url: &str,
    username: Option<String>,
    password: String,
    ttl_hours: u32,
) -> Result<Session, Box<dyn std::error::Error>> {
    let auth = GatewayAuth {
        username,
        password: Some(password),
        token: None,
    };
    auth.validate()?;

    let client = KernelClient::connect_with_peer(
        url,
        cli_peer_identity(),
        Vec::new(),
        auth,
        BinaryBodyLimits::default(),
        |_| {},
    )
    .await?;
    let username = client
        .connection()
        .connect_result
        .as_ref()
        .ok_or("Your Ship did not say who you are signed in as")?
        .peer
        .principal
        .account
        .username
        .clone();
    let expiry_ms = Utc::now().timestamp_millis() + (i64::from(ttl_hours) * 3_600_000);
    let payload = client
        .request_ok(
            "sys.token.create",
            Some(json!({
                "kind": "human",
                "label": format!("gsv-cli@{}", std::env::consts::OS),
                "expiresAt": expiry_ms,
            })),
        )
        .await?;

    let issued = serde_json::from_value::<LoginTokenCreatePayload>(payload)
        .map_err(|error| format!("Your Ship returned an unreadable session: {error}"))?
        .token;
    Ok(Session {
        username,
        token: issued.token,
        token_id: issued.token_id,
        expires_at: issued.expires_at,
    })
}

/// Saves a session, and the Ship it belongs to when signing in to a
/// different one.
fn save_session(
    session: &Session,
    url: Option<&str>,
) -> Result<GatewayAuth, Box<dyn std::error::Error>> {
    CliConfig::update(|local_cfg| {
        if let Some(url) = url {
            local_cfg.gateway.url = Some(url.to_string());
        }
        local_cfg.gateway.username = Some(session.username.clone());
        local_cfg.gateway.session_token = Some(session.token.clone());
        local_cfg.gateway.session_token_id = Some(session.token_id.clone());
        local_cfg.gateway.session_expires_at = session.expires_at;
    })?;
    Ok(GatewayAuth {
        username: Some(session.username.clone()),
        password: None,
        token: Some(session.token.clone()),
    })
}

fn clear_cached_user_session_token() -> Result<(), Box<dyn std::error::Error>> {
    CliConfig::update(|cfg| {
        cfg.gateway.session_token = None;
        cfg.gateway.session_token_id = None;
        cfg.gateway.session_expires_at = None;
    })?;

    Ok(())
}

async fn resolve_interactive_gateway_auth(
    url: &str,
    cfg: &CliConfig,
    token: Option<String>,
    cli_username: Option<String>,
) -> Result<GatewayAuth, Box<dyn std::error::Error>> {
    let fresh_cfg = CliConfig::load();
    let username = resolve_gateway_username(&fresh_cfg, cli_username.clone())
        .or_else(|| resolve_gateway_username(cfg, cli_username));

    if let Some(token) = normalize_auth_field(token) {
        let auth = GatewayAuth {
            username,
            password: None,
            token: Some(token),
        };
        auth.validate()?;
        return Ok(auth);
    }

    if let Some(cached_token) = fresh_cfg.gateway_session_token() {
        let auth = GatewayAuth {
            username,
            password: None,
            token: Some(cached_token),
        };
        auth.validate()?;
        return Ok(auth);
    }

    if fresh_cfg.gateway.url.is_none() && cfg.gateway.url.is_none() {
        return Err(
            "You're not signed in. Sign in with: gsv login YOUR-SHIP (for example me.ship.space)"
                .into(),
        );
    }
    if !can_prompt_interactively() {
        return Err("You're not signed in. Sign in with: gsv login".into());
    }
    let password = prompt_secret(&format!("Password for {}", space_name(url)))?
        .ok_or("A password is needed to sign in")?;
    let session =
        issue_user_session(url, username, password, DEFAULT_USER_SESSION_TTL_HOURS).await?;
    let auth = save_session(&session, None)?;
    eprintln!(
        "{}",
        crate::render::Style::stderr().dim(&format!("Signed in as {}.", session.username))
    );
    Ok(auth)
}

pub(crate) fn resolve_device_gateway_auth(
    cfg: &CliConfig,
    token: Option<String>,
    cli_username: Option<String>,
) -> Result<GatewayAuth, Box<dyn std::error::Error>> {
    let username = normalize_auth_field(cli_username)
        .or_else(|| normalize_auth_field(cfg.device_gateway_username()));
    let token =
        normalize_auth_field(token).or_else(|| normalize_auth_field(cfg.default_device_token()));

    if token.is_some() && username.is_none() {
        return Err("Username is required when using --token for device auth".into());
    }

    if username.is_some() && token.is_none() {
        return Err(
            "This computer isn't paired. Connect it with an invitation: gsv pair CODE".into(),
        );
    }

    let auth = GatewayAuth {
        username,
        password: None,
        token,
    };
    auth.validate()?;
    Ok(auth)
}

pub(crate) struct LoginRequest {
    pub(crate) space: Option<String>,
    pub(crate) url_override: Option<String>,
    pub(crate) username: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) ttl_hours: u32,
}

/// Signs in. Naming a different Ship switches to it only once the password
/// is accepted, so a typo never loses the current session.
pub(crate) async fn sign_in(
    cfg: &CliConfig,
    request: LoginRequest,
) -> Result<(Session, String), Box<dyn std::error::Error>> {
    if request.ttl_hours == 0 {
        return Err("--ttl-hours must be greater than 0".into());
    }
    let url = match (&request.space, &request.url_override, &cfg.gateway.url) {
        (Some(space), _, _) => space_url(space)?,
        (None, Some(url), _) => url.clone(),
        (None, None, Some(url)) => url.clone(),
        (None, None, None) => {
            return Err("Which Ship? Give its address, for example: gsv login me.ship.space".into())
        }
    };
    let same_ship = cfg.gateway.url.as_deref() == Some(url.as_str());
    let username = normalize_auth_field(request.username).or_else(|| {
        same_ship
            .then(|| normalize_auth_field(cfg.gateway_username()))
            .flatten()
    });
    let password = match normalize_auth_field(request.password) {
        Some(password) => password,
        None if can_prompt_interactively() => {
            prompt_secret(&format!("Password for {}", space_name(&url)))?
                .ok_or("A password is needed to sign in")?
        }
        None => return Err("Give the password with --password when not in a terminal".into()),
    };
    let session = issue_user_session(&url, username, password, request.ttl_hours).await?;
    save_session(&session, Some(&url))?;
    Ok((session, url))
}

/// Ends the saved session on the Ship, then forgets it here. The local copy
/// is cleared even when the Ship can't be reached.
pub(crate) async fn sign_out(cfg: &CliConfig) -> Result<SignOut, Box<dyn std::error::Error>> {
    let (Some(token), Some(token_id)) = (
        cfg.gateway.session_token.clone(),
        cfg.gateway.session_token_id.clone(),
    ) else {
        clear_cached_user_session_token()?;
        return Ok(SignOut::NotSignedIn);
    };
    let auth = GatewayAuth {
        username: cfg.gateway_username(),
        password: None,
        token: Some(token),
    };
    let url = cfg.gateway_url();
    let revoke = async {
        let client = KernelClient::connect_with_peer(
            &url,
            cli_peer_identity(),
            Vec::new(),
            auth,
            BinaryBodyLimits::default(),
            |_| {},
        )
        .await?;
        client
            .request_ok("sys.token.revoke", Some(json!({ "tokenId": token_id })))
            .await?;
        Ok::<(), Box<dyn std::error::Error>>(())
    };
    let revoked = matches!(
        tokio::time::timeout(std::time::Duration::from_secs(8), revoke).await,
        Ok(Ok(()))
    );
    clear_cached_user_session_token()?;
    Ok(if revoked {
        SignOut::Ended
    } else {
        SignOut::ClearedLocally
    })
}

pub(crate) enum SignOut {
    NotSignedIn,
    Ended,
    ClearedLocally,
}

pub(crate) fn prompt_secret(prompt: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let mut prompt = password(prompt).allow_empty();
    let value = prompt.interact()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn explicit_credentials_reach_the_command_without_a_setup_probe() {
        let attempts = Cell::new(0);
        run_with_login_retry(
            "not-a-gateway-url",
            &CliConfig::default(),
            Some("fixture-token".into()),
            Some("fixture-owner".into()),
            |auth| {
                attempts.set(attempts.get() + 1);
                assert_eq!(auth.username.as_deref(), Some("fixture-owner"));
                assert_eq!(auth.token.as_deref(), Some("fixture-token"));
                assert!(auth.password.is_none());
                async { Ok(()) }
            },
        )
        .await
        .expect("the command owns its connection; authentication must not probe first");
        assert_eq!(attempts.get(), 1);
    }

    #[tokio::test]
    async fn explicit_token_and_provisioning_failures_never_start_setup_or_login() {
        for code in [401, 425, 503] {
            let attempts = Cell::new(0);
            let error = run_with_login_retry(
                "not-a-gateway-url",
                &CliConfig::default(),
                Some("fixture-token".into()),
                Some("fixture-owner".into()),
                |_| {
                    attempts.set(attempts.get() + 1);
                    async move {
                        Err(Box::new(GatewayRpcError::new(
                            "sys.connect",
                            code,
                            "fixture denial",
                            None,
                        )) as Box<dyn std::error::Error>)
                    }
                },
            )
            .await
            .expect_err("preserve the original admission failure");
            assert_eq!(error.downcast_ref::<GatewayRpcError>().unwrap().code, code);
            assert_eq!(attempts.get(), 1);
        }
    }

    #[test]
    fn spaces_become_websocket_urls() {
        assert_eq!(
            space_url("me.ship.space").expect("bare host"),
            "wss://me.ship.space/ws"
        );
        assert_eq!(
            space_url("https://me.ship.space/").expect("https"),
            "wss://me.ship.space/ws"
        );
        assert_eq!(
            space_url("wss://me.example/custom/ws").expect("explicit path"),
            "wss://me.example/custom/ws"
        );
        assert_eq!(
            space_url("localhost:8787").expect("local"),
            "ws://localhost:8787/ws"
        );
        space_url("").expect_err("rejected");
        space_url("ftp://me.ship.space").expect_err("rejected");
        assert_eq!(space_name("wss://me.ship.space/ws"), "me.ship.space");
        assert_eq!(space_name("ws://localhost:8787/ws"), "localhost:8787");
    }

    #[test]
    fn device_auth_keeps_its_saved_credential_and_explicit_override() {
        let mut cfg = CliConfig::default();
        cfg.gateway.username = Some("fixture-owner".into());
        cfg.device.token = Some("saved-device-token".into());
        let saved = resolve_device_gateway_auth(&cfg, None, None).expect("saved device auth");
        assert_eq!(saved.token.as_deref(), Some("saved-device-token"));
        assert_eq!(saved.username.as_deref(), Some("fixture-owner"));
        cfg.device.gateway_username = Some("machine-owner".into());
        let saved =
            resolve_device_gateway_auth(&cfg, None, None).expect("independent machine auth");
        assert_eq!(saved.username.as_deref(), Some("machine-owner"));
        cfg.gateway.username = None;
        let saved = resolve_device_gateway_auth(&cfg, None, None).expect("no CLI login needed");
        assert_eq!(saved.username.as_deref(), Some("machine-owner"));
        let explicit = resolve_device_gateway_auth(
            &cfg,
            Some("explicit-device-token".into()),
            Some("explicit-owner".into()),
        )
        .expect("explicit device auth");
        assert_eq!(explicit.token.as_deref(), Some("explicit-device-token"));
        assert_eq!(explicit.username.as_deref(), Some("explicit-owner"));
        assert!(explicit.password.is_none());
    }
}
