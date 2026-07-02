use chrono::{TimeZone, Utc};
use cliclack::{confirm, input, password, select};
use gsv::config::CliConfig;
use gsv::connection::{Connection, GatewayRpcError};
use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde::Deserialize;
use serde_json::json;
use std::future::Future;
use std::io::{self, IsTerminal};

#[derive(Default)]
pub(crate) struct AuthSetupOptions {
    pub(crate) username: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) root_password: Option<String>,
    pub(crate) ai_provider: Option<String>,
    pub(crate) ai_model: Option<String>,
    pub(crate) ai_api_key: Option<String>,
    pub(crate) device_id: Option<String>,
    pub(crate) device_label: Option<String>,
    pub(crate) device_expires_at: Option<i64>,
}

struct LoginRetryOptions<'a> {
    url: &'a str,
    cfg: &'a CliConfig,
    cli_token: Option<String>,
    cli_username: Option<String>,
    cli_password: Option<String>,
    command_name: &'a str,
    has_explicit_token: bool,
}

fn is_setup_required_error(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<GatewayRpcError>()
        .map(|rpc_error| rpc_error.is_setup_required())
        .unwrap_or(false)
}

fn is_auth_failed_error(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<GatewayRpcError>()
        .map(|rpc_error| rpc_error.code == 401)
        .unwrap_or(false)
}

async fn gateway_is_in_setup_mode(url: &str) -> Result<bool, Box<dyn std::error::Error>> {
    let probe_conn = Connection::connect_without_handshake(url, |_| {}).await?;
    let response = probe_conn
        .request(
            "sys.connect",
            Some(json!({
                "protocol": 1,
                "client": {
                    "id": format!("gsv-setup-probe-{}", uuid::Uuid::new_v4()),
                    "version": gsv::build_info::BUILD_VERSION,
                    "platform": std::env::consts::OS,
                    "role": "user",
                },
            })),
        )
        .await?;

    if response.ok {
        return Ok(false);
    }

    let is_setup_mode = response
        .error
        .as_ref()
        .map(|error| {
            error.code == 425
                || error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("setupMode"))
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
        })
        .unwrap_or(false);

    Ok(is_setup_mode)
}

pub(crate) async fn run_with_auto_setup_retry<F, Fut>(
    url: &str,
    cfg: &CliConfig,
    setup_username: Option<String>,
    setup_password: Option<String>,
    mut attempt: F,
) -> Result<(), Box<dyn std::error::Error>>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(), Box<dyn std::error::Error>>>,
{
    if gateway_is_in_setup_mode(url).await? {
        if !can_prompt_interactively() && (setup_username.is_none() || setup_password.is_none()) {
            return Err(
                "Gateway is in setup mode. Provide --user and --password to bootstrap automatically in non-interactive mode."
                    .into(),
            );
        }

        println!("Gateway is in setup mode. Starting setup wizard...");
        run_auth_setup(
            url,
            cfg,
            AuthSetupOptions {
                username: setup_username.clone(),
                password: setup_password.clone(),
                ..AuthSetupOptions::default()
            },
        )
        .await?;
    }

    match attempt().await {
        Ok(()) => Ok(()),
        Err(error) => {
            if !is_setup_required_error(error.as_ref()) {
                return Err(error);
            }

            if !can_prompt_interactively() && (setup_username.is_none() || setup_password.is_none())
            {
                return Err(
                    "Gateway is in setup mode. Provide --user and --password to bootstrap automatically in non-interactive mode."
                        .into(),
                );
            }

            println!("Gateway is in setup mode. Starting setup wizard...");
            run_auth_setup(
                url,
                cfg,
                AuthSetupOptions {
                    username: setup_username,
                    password: setup_password,
                    ..AuthSetupOptions::default()
                },
            )
            .await?;

            attempt().await
        }
    }
}

pub(crate) async fn run_with_auto_setup_and_login_retry<F, Fut>(
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

    if gateway_is_in_setup_mode(url).await? {
        if !can_prompt_interactively() && (cli_username.is_none() || cli_password.is_none()) {
            return Err(
                "Gateway is in setup mode. Provide --user and --password to bootstrap automatically in non-interactive mode."
                    .into(),
            );
        }

        println!("Gateway is in setup mode. Starting setup wizard...");
        run_auth_setup(
            url,
            cfg,
            AuthSetupOptions {
                username: cli_username.clone(),
                password: cli_password.clone(),
                ..AuthSetupOptions::default()
            },
        )
        .await?;
    }

    match attempt_user_command_with_login_retry(
        LoginRetryOptions {
            url,
            cfg,
            cli_token: cli_token.clone(),
            cli_username: cli_username.clone(),
            cli_password: cli_password.clone(),
            command_name,
            has_explicit_token,
        },
        &mut run_with_auth,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(error) => {
            if !is_setup_required_error(error.as_ref()) {
                return Err(error);
            }

            if !can_prompt_interactively() && (cli_username.is_none() || cli_password.is_none()) {
                return Err(
                    "Gateway is in setup mode. Provide --user and --password to bootstrap automatically in non-interactive mode."
                        .into(),
                );
            }

            println!("Gateway is in setup mode. Starting setup wizard...");
            run_auth_setup(
                url,
                cfg,
                AuthSetupOptions {
                    username: cli_username.clone(),
                    password: cli_password.clone(),
                    ..AuthSetupOptions::default()
                },
            )
            .await?;

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
    }
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

fn default_llm_model_for_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("claude-sonnet-4-20250514"),
        "openai" => Some("gpt-4.1"),
        "google" => Some("gemini-2.5-flash"),
        "openrouter" => Some("anthropic/claude-sonnet-4"),
        _ => None,
    }
}

fn env_api_key_for_provider(provider: &str) -> Option<String> {
    match provider {
        "anthropic" => std::env::var("ANTHROPIC_API_KEY").ok(),
        "openai" => std::env::var("OPENAI_API_KEY").ok(),
        "google" => std::env::var("GOOGLE_API_KEY")
            .ok()
            .or_else(|| std::env::var("GEMINI_API_KEY").ok()),
        "openrouter" => std::env::var("OPENROUTER_API_KEY").ok(),
        _ => None,
    }
    .filter(|value| !value.trim().is_empty())
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

    let client = KernelClient::connect_user(url, auth, |_| {}).await?;
    let expiry_ms = Utc::now().timestamp_millis() + (i64::from(ttl_hours) * 3_600_000);
    let payload = client
        .request_ok(
            "sys.token.create",
            Some(json!({
                "kind": "user",
                "label": format!("gsv-cli@{}", std::env::consts::OS),
                "allowedRole": "user",
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

    let mut local_cfg = CliConfig::load();
    local_cfg.gateway.username = Some(username.clone());
    local_cfg.gateway.session_token = Some(issued.token.clone());
    local_cfg.gateway.session_token_id = Some(issued.token_id);
    local_cfg.gateway.session_expires_at = issued.expires_at;
    local_cfg.save()?;

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
    let mut cfg = CliConfig::load();
    let changed = cfg.gateway.session_token.is_some()
        || cfg.gateway.session_token_id.is_some()
        || cfg.gateway.session_expires_at.is_some();

    cfg.gateway.session_token = None;
    cfg.gateway.session_token_id = None;
    cfg.gateway.session_expires_at = None;

    if changed {
        cfg.save()?;
    }

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

pub(crate) async fn run_auth_setup(
    url: &str,
    cfg: &CliConfig,
    options: AuthSetupOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    let AuthSetupOptions {
        username,
        password,
        root_password,
        ai_provider,
        ai_model,
        ai_api_key,
        device_id,
        device_label,
        device_expires_at,
    } = options;
    let cli_username = normalize_auth_field(username);
    let cfg_username = normalize_auth_field(cfg.gateway_username());
    let mut username = cli_username.clone().or_else(|| cfg_username.clone());
    let mut password = normalize_auth_field(password);
    let mut root_password = normalize_auth_field(root_password);
    let mut ai_provider = normalize_auth_field(ai_provider).map(|p| p.to_ascii_lowercase());
    let mut ai_model = normalize_auth_field(ai_model);
    let mut ai_api_key = ai_api_key.filter(|value| !value.trim().is_empty());
    let mut device_id = normalize_auth_field(device_id).or_else(|| cfg.device.id.clone());
    let mut device_label = normalize_auth_field(device_label);
    let mut device_expires_at = device_expires_at;

    if can_prompt_interactively() && cli_username.is_none() {
        let default_username = match cfg_username.as_deref() {
            Some("root") | None => Some("admin"),
            Some(value) => Some(value),
        };
        username = prompt_line("First gateway username", default_username)?;
    }
    if password.is_none() && can_prompt_interactively() {
        password = prompt_secret("First gateway password (min 8 chars)")?;
    }

    if can_prompt_interactively() {
        if root_password.is_none() && prompt_yes_no("Set a root password now?", false)? {
            root_password = prompt_secret("Root password (min 8 chars)")?;
        }
        if root_password
            .as_ref()
            .map(|value| value.trim().len() < 8)
            .unwrap_or(false)
        {
            return Err("Root password must be at least 8 characters".into());
        }

        let mut wants_ai = ai_provider.is_some() || ai_model.is_some() || ai_api_key.is_some();
        if !wants_ai {
            wants_ai = prompt_yes_no("Configure AI provider/model now?", true)?;
        }
        if wants_ai {
            if ai_provider.is_none() {
                let provider_choice = select("AI provider")
                    .item("openrouter".to_string(), "openrouter", "recommended")
                    .item("anthropic".to_string(), "anthropic", "")
                    .item("openai".to_string(), "openai", "")
                    .item("google".to_string(), "google", "")
                    .item("custom".to_string(), "custom", "")
                    .interact()?;
                if provider_choice == "custom" {
                    ai_provider = prompt_line("Custom AI provider ID", None)?;
                } else {
                    ai_provider = Some(provider_choice);
                }
                ai_provider = ai_provider.map(|provider| provider.to_ascii_lowercase());
            }

            if ai_model.is_none() {
                let default_model = ai_provider
                    .as_deref()
                    .and_then(default_llm_model_for_provider);
                ai_model = prompt_line("AI model", default_model)?;
            }

            if ai_api_key.is_none() {
                if let Some(provider) = ai_provider.as_deref() {
                    if let Some(env_key) = env_api_key_for_provider(provider) {
                        if prompt_yes_no(
                            "Use AI API key from environment for selected provider?",
                            true,
                        )? {
                            ai_api_key = Some(env_key);
                        }
                    }
                }
            }

            if ai_api_key.is_none() {
                ai_api_key = prompt_secret("AI API key (leave empty to skip for now)")?;
            }
        }

        let mut wants_device_token =
            device_id.is_some() || device_label.is_some() || device_expires_at.is_some();
        if !wants_device_token {
            wants_device_token = prompt_yes_no("Issue a device token now?", true)?;
        }
        if wants_device_token {
            if device_id.is_none() {
                let default_device_id = cfg.device.id.clone().unwrap_or_else(|| {
                    format!(
                        "device-{}",
                        whoami::fallible::hostname().unwrap_or_else(|_| "local".to_string())
                    )
                });
                device_id = prompt_line("Device ID for token binding", Some(&default_device_id))?;
            }

            if device_label.is_none() {
                device_label = prompt_line("Device token label (optional)", None)?;
            }

            if device_expires_at.is_none() {
                let expiry_days = prompt_line(
                    "Device token expiry in days (leave empty for no expiry)",
                    None,
                )?;
                if let Some(days_raw) = expiry_days {
                    let days: i64 = days_raw.parse().map_err(|error| {
                        format!("Expiry days must be a positive integer: {}", error)
                    })?;
                    if days <= 0 {
                        return Err("Expiry days must be greater than zero".into());
                    }
                    device_expires_at =
                        Some(Utc::now().timestamp_millis() + (days * 24 * 60 * 60 * 1000));
                }
            }
        }
    }

    let username =
        username.ok_or("Missing username. Pass --username or run in interactive mode.")?;
    if username == "root" {
        return Err(
            "First gateway username cannot be `root`; root is bootstrapped separately. Use a regular username and optionally set a root password in the wizard."
                .into(),
        );
    }
    let password =
        password.ok_or("Missing password. Pass --new-password (or run interactively).")?;

    let mut payload = json!({
        "username": username,
        "password": password,
    });

    if let Some(root_password) = root_password {
        payload["rootPassword"] = json!(root_password);
    }

    if ai_provider.is_some() || ai_model.is_some() || ai_api_key.is_some() {
        let mut ai = json!({});
        if let Some(provider) = ai_provider {
            ai["provider"] = json!(provider);
        }
        if let Some(model) = ai_model {
            ai["model"] = json!(model);
        }
        if let Some(api_key) = ai_api_key {
            ai["apiKey"] = json!(api_key);
        }
        payload["ai"] = ai;
    }

    if let Some(device_id) = device_id {
        let mut device = json!({
            "deviceId": device_id,
        });
        if let Some(label) = device_label {
            device["label"] = json!(label);
        }
        if let Some(expires_at) = device_expires_at {
            device["expiresAt"] = json!(expires_at);
        }
        // Gateway setup still accepts the original compatibility field name.
        payload["node"] = device;
    }

    let conn = Connection::connect_without_handshake(url, |_| {}).await?;
    let response = conn.request("sys.setup", Some(payload)).await?;
    if !response.ok {
        if let Some(error) = response.error {
            return Err(Box::new(GatewayRpcError::new(
                "sys.setup",
                error.code,
                error.message,
                error.details,
            )));
        }
        return Err("sys.setup failed".into());
    }

    let data = response.data.unwrap_or_else(|| json!({}));
    let setup = match serde_json::from_value::<SysSetupPayload>(data.clone()) {
        Ok(parsed) => parsed,
        Err(_) => {
            // Schema drift fallback for debugging and compatibility.
            println!("{}", serde_json::to_string_pretty(&data)?);
            return Ok(());
        }
    };

    let mut local_cfg = CliConfig::load();
    let mut saved_fields: Vec<&str> = Vec::new();

    if local_cfg.gateway.username.as_deref() != Some(setup.user.username.as_str()) {
        local_cfg.gateway.username = Some(setup.user.username.clone());
        saved_fields.push("gateway.username");
    }

    if let Some(device_token) = setup.device_token.as_ref() {
        if local_cfg.device.token.as_deref() != Some(device_token.token.as_str()) {
            local_cfg.device.token = Some(device_token.token.clone());
            saved_fields.push("device.token");
        }
        if let Some(device_id) = device_token.allowed_device_id.as_deref() {
            if local_cfg.device.id.as_deref() != Some(device_id) {
                local_cfg.device.id = Some(device_id.to_string());
                saved_fields.push("device.id");
            }
        }
    }

    if !saved_fields.is_empty() {
        local_cfg.save()?;
    }

    println!("Setup complete.");
    println!("User: {} (uid {})", setup.user.username, setup.user.uid);
    println!("Home: {}", setup.user.home);
    println!(
        "Root account: {}",
        if setup.root_locked {
            "locked"
        } else {
            "password set"
        }
    );

    if let Some(device_token) = setup.device_token {
        println!(
            "Device token issued: {} ({})",
            device_token.token_id, device_token.token_prefix
        );
        println!(
            "Device binding: {}",
            device_token
                .allowed_device_id
                .as_deref()
                .unwrap_or("<none>")
        );
        println!(
            "Device token expires: {}",
            device_token
                .expires_at
                .map(format_unix_ms)
                .unwrap_or_else(|| "never".to_string())
        );
    }

    if saved_fields.is_empty() {
        println!("Local config unchanged.");
    } else {
        println!("Saved local config: {}.", saved_fields.join(", "));
    }

    Ok(())
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
    let mut cfg = CliConfig::load();
    let had_session = cfg.gateway.session_token.is_some()
        || cfg.gateway.session_token_id.is_some()
        || cfg.gateway.session_expires_at.is_some();

    cfg.gateway.session_token = None;
    cfg.gateway.session_token_id = None;
    cfg.gateway.session_expires_at = None;

    if had_session {
        cfg.save()?;
        println!("Cleared cached user session token.");
    } else {
        println!("No cached user session token.");
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysSetupPayload {
    user: SysSetupUser,
    root_locked: bool,
    #[serde(rename = "nodeToken")]
    device_token: Option<SysSetupDeviceToken>,
}

#[derive(Debug, Deserialize)]
struct SysSetupUser {
    uid: u32,
    username: String,
    home: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysSetupDeviceToken {
    token_id: String,
    token: String,
    token_prefix: String,
    allowed_device_id: Option<String>,
    expires_at: Option<i64>,
}

pub(crate) fn prompt_yes_no(
    prompt: &str,
    default_yes: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    let mut prompt = confirm(prompt).initial_value(default_yes);
    Ok(prompt.interact()?)
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
