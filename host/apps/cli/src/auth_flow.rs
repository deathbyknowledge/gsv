use chrono::{TimeZone, Utc};
use cliclack::{input, password};
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
    cli_password: Option<String>,
    command_name: &'a str,
    has_explicit_token: bool,
}

fn is_auth_failed_error(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<GatewayRpcError>()
        .map(|rpc_error| rpc_error.code == 401)
        .unwrap_or(false)
}

pub(crate) async fn run_with_login_retry<F, Fut>(
    url: &str,
    cfg: &CliConfig,
    cli_token: Option<String>,
    cli_username: Option<String>,
    cli_password: Option<String>,
    command_name: &'static str,
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
            cli_password,
            command_name,
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
        options.cli_password.clone(),
        options.command_name,
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
                options.cli_password,
                options.command_name,
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

async fn issue_and_store_user_session_token(
    url: &str,
    username: String,
    password: String,
    ttl_hours: u32,
) -> Result<GatewayAuth, Box<dyn std::error::Error>> {
    let auth = GatewayAuth {
        username: Some(username.clone()),
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
        .map_err(|error| {
            format!(
                "Failed to parse sys.token.create response for login: {}",
                error
            )
        })?
        .token;

    CliConfig::update(|local_cfg| {
        local_cfg.gateway.username = Some(username.clone());
        local_cfg.gateway.session_token = Some(issued.token.clone());
        local_cfg.gateway.session_token_id = Some(issued.token_id.clone());
        local_cfg.gateway.session_expires_at = issued.expires_at;
    })?;

    if let Some(expires_at) = issued.expires_at {
        println!(
            "Authenticated as {}. Session cached until {}.",
            username,
            format_unix_ms(expires_at),
        );
    } else {
        println!("Authenticated as {}. Session cached.", username);
    }

    Ok(GatewayAuth {
        username: Some(username),
        password: None,
        token: Some(issued.token),
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
    cli_password: Option<String>,
    command_name: &str,
) -> Result<GatewayAuth, Box<dyn std::error::Error>> {
    let fresh_cfg = CliConfig::load();
    let mut username = resolve_gateway_username(&fresh_cfg, cli_username.clone())
        .or_else(|| resolve_gateway_username(cfg, cli_username));
    let mut password = normalize_auth_field(cli_password);
    let explicit_token = normalize_auth_field(token);

    if username.is_none() && (password.is_some() || explicit_token.is_some()) {
        return Err("Username is required when using password/token authentication".into());
    }

    if let Some(token) = explicit_token {
        let auth = GatewayAuth {
            username,
            password: None,
            token: Some(token),
        };
        auth.validate()?;
        return Ok(auth);
    }

    if password.is_none() {
        if let Some(cached_token) = fresh_cfg.gateway_session_token() {
            let auth = GatewayAuth {
                username,
                password: None,
                token: Some(cached_token),
            };
            auth.validate()?;
            return Ok(auth);
        }
    }

    if username.is_none() && can_prompt_interactively() {
        let prompt = format!("Gateway username for `{}`", command_name);
        username = prompt_line(&prompt, None)?;
    }

    if username.is_some() && password.is_none() {
        if can_prompt_interactively() {
            let prompt = format!("Gateway password for `{}`", command_name);
            password = prompt_secret(&prompt)?;
        } else {
            return Err(
                "Missing gateway session token. Run `gsv auth login` first or provide --password in non-interactive mode."
                    .into(),
            );
        }
    }

    let username = username.ok_or("Username required")?;
    let password = password.ok_or("Password required")?;
    issue_and_store_user_session_token(url, username, password, DEFAULT_USER_SESSION_TTL_HOURS)
        .await
}

pub(crate) fn resolve_device_gateway_auth(
    cfg: &CliConfig,
    token: Option<String>,
    cli_username: Option<String>,
) -> Result<GatewayAuth, Box<dyn std::error::Error>> {
    let username = resolve_gateway_username(cfg, cli_username);
    let token =
        normalize_auth_field(token).or_else(|| normalize_auth_field(cfg.default_device_token()));

    if token.is_some() && username.is_none() {
        return Err("Username is required when using --token for device auth".into());
    }

    if username.is_some() && token.is_none() {
        return Err(
            "Missing non-interactive device credential. Set --token or `gsv config --local set device.token ...`."
                .into(),
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

pub(crate) async fn run_auth_login(
    url: &str,
    cfg: &CliConfig,
    username: Option<String>,
    password: Option<String>,
    ttl_hours: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    if ttl_hours == 0 {
        return Err("--ttl-hours must be greater than 0".into());
    }

    let mut username =
        normalize_auth_field(username).or_else(|| normalize_auth_field(cfg.gateway_username()));
    let mut password = normalize_auth_field(password);

    if username.is_none() && can_prompt_interactively() {
        username = prompt_line("Gateway username", None)?;
    }
    if username.is_none() {
        return Err(
            "Gateway username required (pass --username or configure gateway.username)".into(),
        );
    }

    if password.is_none() && can_prompt_interactively() {
        password = prompt_secret("Gateway password")?;
    }
    let password =
        password.ok_or("Gateway password required (pass --password or run interactively)")?;
    let username = username.unwrap_or_default();

    let _ = issue_and_store_user_session_token(url, username, password, ttl_hours).await?;
    Ok(())
}

pub(crate) fn run_auth_logout() -> Result<(), Box<dyn std::error::Error>> {
    let had_session = CliConfig::update(|cfg| {
        let had_session = cfg.gateway.session_token.is_some()
            || cfg.gateway.session_token_id.is_some()
            || cfg.gateway.session_expires_at.is_some();
        cfg.gateway.session_token = None;
        cfg.gateway.session_token_id = None;
        cfg.gateway.session_expires_at = None;
        had_session
    })?;

    if had_session {
        println!("Cleared cached user session token.");
    } else {
        println!("No cached user session token.");
    }

    Ok(())
}

fn prompt_line(
    prompt: &str,
    default: Option<&str>,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let mut prompt = input(prompt).required(false);
    if let Some(value) = default {
        prompt = prompt.default_input(value);
    }
    let value: String = prompt.interact()?;
    let trimmed = value.trim();

    if trimmed.is_empty() {
        if let Some(value) = default {
            return Ok(Some(value.to_string()));
        }
        return Ok(None);
    }

    Ok(Some(trimmed.to_string()))
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
            Some("unused-password".into()),
            "chat",
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
                None,
                "chat",
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
    fn device_auth_keeps_its_saved_credential_and_explicit_override() {
        let mut cfg = CliConfig::default();
        cfg.gateway.username = Some("fixture-owner".into());
        cfg.device.token = Some("saved-device-token".into());
        let saved = resolve_device_gateway_auth(&cfg, None, None).expect("saved device auth");
        assert_eq!(saved.token.as_deref(), Some("saved-device-token"));
        assert_eq!(saved.username.as_deref(), Some("fixture-owner"));
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
