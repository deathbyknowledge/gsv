use chrono::{TimeZone, Utc};
use clap::{Parser, Subcommand, ValueEnum};
use cliclack::{confirm, input, intro, log, multiselect, note, outro_cancel, password, select};
use gsv::config::{self, CliConfig};
use gsv::connection::{Connection, GatewayRpcError};
use gsv::deploy;
use gsv::device_service;
use gsv::kernel_client::{GatewayAuth, KernelClient};
use gsv::logger::{self, NodeLogger};
use gsv::protocol::{
    ErrorShape, Frame, NodeExecEventParams, RequestFrame, ResponseFrame, SignalFrame,
};
use gsv::tools::{all_tools_with_workspace, subscribe_exec_events, Tool};
use serde::Deserialize;
use serde_json::json;
use std::collections::VecDeque;
use std::future::Future;
use std::io::{self, IsTerminal};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
mod commands;

#[derive(Parser)]
#[command(
    name = "gsv",
    version = gsv::build_info::BUILD_VERSION,
    about = "GSV CLI - Chat, Device, and Infrastructure Control Plane"
)]
struct Cli {
    /// Gateway URL (overrides config file)
    #[arg(long, env = "GSV_URL")]
    url: Option<String>,

    /// Gateway username (global override for remote commands)
    #[arg(short = 'u', long, global = true)]
    user: Option<String>,

    /// Gateway password credential (global override for remote commands)
    #[arg(short = 'p', long, global = true)]
    password: Option<String>,

    /// Non-interactive credential (legacy token flag; overrides config/env)
    #[arg(short, long, env = "GSV_TOKEN", global = true)]
    token: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Send a message to the agent (interactive or one-shot)
    Chat {
        /// Message to send (if omitted, enters interactive mode)
        message: Option<String>,

        /// Optional process ID (defaults to your init process)
        #[arg(long)]
        pid: Option<String>,
    },

    /// Interactive shell connected to the gateway OS
    Shell,

    /// Process management (`proc.*`)
    Proc {
        #[command(subcommand)]
        action: ProcAction,
    },

    /// Adapter account lifecycle (`adapter.*`)
    Adapter {
        #[command(subcommand)]
        action: AdapterAction,
    },

    /// Authentication and onboarding
    Auth {
        #[command(subcommand)]
        action: AuthAction,
    },

    /// Run and manage the device daemon
    Device {
        #[command(subcommand)]
        action: DeviceAction,
    },

    /// Get or set gateway configuration (use --local for CLI config)
    Config {
        /// Operate on local CLI config instead of remote kernel config
        #[arg(long)]
        local: bool,

        #[command(subcommand)]
        action: ConfigAction,
    },

    /// Package lifecycle and source management
    Packages {
        #[command(subcommand)]
        action: PackagesAction,
    },

    /// Cloudflare infrastructure lifecycle
    Infra {
        #[command(subcommand)]
        action: InfraAction,
    },

    /// Show CLI version and build metadata
    Version,
}

#[derive(Subcommand)]
enum DeviceAction {
    /// Run the device in the foreground
    Run {
        /// Device ID (default: hostname)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory for file tools
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Install and start device daemon service
    Install {
        /// Device ID (saved to local config during install)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory (saved to local config during install)
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Start device daemon service
    Start,

    /// Stop device daemon service
    Stop,

    /// Show device daemon service status
    Status,

    /// Show device daemon service logs
    Logs {
        /// Number of lines to show
        #[arg(short, long, default_value = "100")]
        lines: usize,

        /// Follow logs
        #[arg(long)]
        follow: bool,
    },
}

#[derive(Subcommand)]
enum InfraAction {
    /// Deploy infrastructure and finish onboarding in the web app
    Deploy {
        /// Release ref (e.g., stable, dev, v0.2.0, or latest stable)
        #[arg(long, default_value = "latest")]
        version: String,

        /// Component to include (repeat for multiple)
        #[arg(short = 'c', long = "component")]
        component: Vec<String>,

        /// Include all components
        #[arg(long)]
        all: bool,

        /// Overwrite existing extracted bundle directories
        #[arg(long)]
        force_fetch: bool,

        /// Use local Cloudflare bundle directory instead of downloading from release assets
        #[arg(long)]
        bundle_dir: Option<PathBuf>,

        /// Cloudflare API token (falls back to config `cloudflare.api_token`)
        #[arg(long, env = "CF_API_TOKEN")]
        api_token: Option<String>,

        /// Cloudflare account ID override (falls back to config `cloudflare.account_id`)
        #[arg(long, env = "CF_ACCOUNT_ID")]
        account_id: Option<String>,

        /// Discord bot token to upload as worker secret (`DISCORD_BOT_TOKEN`)
        #[arg(long, env = "DISCORD_BOT_TOKEN")]
        discord_bot_token: Option<String>,
    },

    /// Upgrade deployed infrastructure components
    Upgrade {
        /// Release ref (e.g., stable, dev, v0.2.0, or latest stable)
        #[arg(long, default_value = "latest")]
        version: String,

        /// Component to include (repeat for multiple)
        #[arg(short = 'c', long = "component")]
        component: Vec<String>,

        /// Include all components
        #[arg(long)]
        all: bool,

        /// Overwrite existing extracted bundle directories (auto-enabled for mutable refs like dev/stable/latest)
        #[arg(long)]
        force_fetch: bool,

        /// Use local Cloudflare bundle directory instead of downloading from release assets
        #[arg(long)]
        bundle_dir: Option<PathBuf>,

        /// Cloudflare API token (falls back to config `cloudflare.api_token`)
        #[arg(long, env = "CF_API_TOKEN")]
        api_token: Option<String>,

        /// Cloudflare account ID override (falls back to config `cloudflare.account_id`)
        #[arg(long, env = "CF_ACCOUNT_ID")]
        account_id: Option<String>,

        /// Discord bot token to upload as worker secret (`DISCORD_BOT_TOKEN`)
        #[arg(long, env = "DISCORD_BOT_TOKEN")]
        discord_bot_token: Option<String>,
    },

    /// Destroy deployed infrastructure and optionally keep local device daemon
    Destroy {
        /// Component to remove (repeat for multiple). Defaults to all when omitted.
        #[arg(short = 'c', long = "component")]
        component: Vec<String>,

        /// Remove all components
        #[arg(long)]
        all: bool,

        /// Also delete the shared R2 storage bucket
        #[arg(long)]
        delete_bucket: bool,

        /// Purge all objects from the shared R2 bucket before deleting it (requires --delete-bucket)
        #[arg(long)]
        purge_bucket: bool,

        /// Run interactive teardown wizard
        #[arg(long)]
        wizard: bool,

        /// Cloudflare API token (falls back to config `cloudflare.api_token`)
        #[arg(long, env = "CF_API_TOKEN")]
        api_token: Option<String>,

        /// Cloudflare account ID override (falls back to config `cloudflare.account_id`)
        #[arg(long, env = "CF_ACCOUNT_ID")]
        account_id: Option<String>,

        /// Keep local device daemon installed
        #[arg(long)]
        keep_node: bool,
    },
}

#[derive(Subcommand, Clone)]
enum PackagesAction {
    /// Re-seed builtin packages from the mirrored system/gsv repo
    Sync,
}

#[derive(Subcommand)]
enum DeviceServiceAction {
    /// Install and start device daemon service
    Install {
        /// Node ID (saved to local config during install)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory (saved to local config during install)
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Uninstall and stop device daemon service
    Uninstall,

    /// Start device daemon service
    Start,

    /// Stop device daemon service
    Stop,

    /// Show device daemon service status
    Status,

    /// Show device daemon service logs
    Logs {
        /// Number of lines to show
        #[arg(short, long, default_value = "100")]
        lines: usize,

        /// Follow logs
        #[arg(long)]
        follow: bool,
    },
}

#[derive(Subcommand, Clone)]
enum ConfigAction {
    /// Get configuration value
    Get {
        /// Config key (or omit to list all visible keys)
        key: Option<String>,
    },
    /// Set configuration value
    Set {
        /// Config key
        key: String,
        /// Value to set
        value: String,
    },
}

#[derive(Subcommand, Clone)]
enum AuthAction {
    /// Log in and cache a short-lived user session token locally
    Login {
        /// Gateway username (defaults to local config)
        #[arg(long)]
        username: Option<String>,

        /// Gateway password (if omitted, prompts interactively)
        #[arg(long)]
        password: Option<String>,

        /// Session lifetime in hours (default: 8)
        #[arg(long, default_value_t = 8)]
        ttl_hours: u32,
    },

    /// Clear cached local user session token
    Logout,

    /// Link an adapter identity to a local user.
    /// Use either a one-time code positional argument or explicit adapter/account/actor flags.
    Link {
        /// One-time link code (e.g., ABCD-1234)
        code: Option<String>,

        /// Adapter id (manual link mode)
        #[arg(long)]
        adapter: Option<String>,

        /// Adapter account id (manual link mode)
        #[arg(long = "account-id")]
        account_id: Option<String>,

        /// Adapter actor id (manual link mode)
        #[arg(long = "actor-id")]
        actor_id: Option<String>,

        /// Optional target uid (root only for other users)
        #[arg(long)]
        uid: Option<u32>,
    },

    /// List linked adapter identities
    LinkList {
        /// Optional uid filter (root only for other users)
        #[arg(long)]
        uid: Option<u32>,
    },

    /// Remove an existing adapter identity link
    Unlink {
        /// Adapter id
        #[arg(long)]
        adapter: String,

        /// Adapter account id
        #[arg(long = "account-id")]
        account_id: String,

        /// Adapter actor id
        #[arg(long = "actor-id")]
        actor_id: String,
    },

    /// Initialize gateway identity/auth (setup mode only)
    Setup {
        /// First user username
        #[arg(long)]
        username: Option<String>,

        /// First user password
        #[arg(long = "new-password")]
        new_password: Option<String>,

        /// Optional root password (omit to keep root locked)
        #[arg(long)]
        root_password: Option<String>,

        /// Optional AI provider
        #[arg(long)]
        ai_provider: Option<String>,

        /// Optional AI model
        #[arg(long)]
        ai_model: Option<String>,

        /// Optional AI API key
        #[arg(long)]
        ai_api_key: Option<String>,

        /// Optional node id to pre-issue a driver token for
        #[arg(long)]
        node_id: Option<String>,

        /// Optional node token label
        #[arg(long)]
        node_label: Option<String>,

        /// Optional node token expiry unix ms
        #[arg(long)]
        node_expires_at: Option<i64>,
    },

    /// Manage auth tokens
    Token {
        #[command(subcommand)]
        action: AuthTokenAction,
    },
}

#[derive(Subcommand, Clone)]
enum AuthTokenAction {
    /// Create a new auth token
    Create {
        /// Token kind
        #[arg(long, value_enum, default_value = "node")]
        kind: TokenKindArg,

        /// Optional owner uid (root only)
        #[arg(long)]
        uid: Option<u32>,

        /// Optional token label
        #[arg(long)]
        label: Option<String>,

        /// Optional explicit role binding (defaults from kind)
        #[arg(long, value_enum)]
        role: Option<TokenRoleArg>,

        /// Optional device binding (driver/node tokens only)
        #[arg(long)]
        device: Option<String>,

        /// Optional expiry timestamp (unix ms)
        #[arg(long)]
        expires_at: Option<i64>,
    },

    /// List auth tokens
    List {
        /// Optional uid filter (root only)
        #[arg(long)]
        uid: Option<u32>,
    },

    /// Revoke an auth token
    Revoke {
        /// Token ID to revoke
        token_id: String,

        /// Optional revoke reason
        #[arg(long)]
        reason: Option<String>,

        /// Optional uid filter (root only)
        #[arg(long)]
        uid: Option<u32>,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum TokenKindArg {
    Node,
    Service,
    User,
}

impl TokenKindArg {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Service => "service",
            Self::User => "user",
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum TokenRoleArg {
    Driver,
    Service,
    User,
}

impl TokenRoleArg {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Driver => "driver",
            Self::Service => "service",
            Self::User => "user",
        }
    }
}

#[derive(Subcommand, Clone)]
enum ProcAction {
    /// List visible processes
    List {
        /// Optional uid filter (root only)
        #[arg(long)]
        uid: Option<u32>,
    },

    /// Spawn a child process
    Spawn {
        /// Optional process label
        #[arg(long)]
        label: Option<String>,

        /// Optional initial prompt/message for the spawned process
        #[arg(long)]
        prompt: Option<String>,

        /// Optional parent process ID (defaults to your init process)
        #[arg(long = "parent")]
        parent_pid: Option<String>,
    },

    /// Send a message to a process
    Send {
        /// Message to deliver
        message: String,

        /// Optional process ID (defaults to your init process)
        #[arg(long)]
        pid: Option<String>,
    },

    /// Read process message history
    History {
        /// Optional process ID (defaults to your init process)
        #[arg(long)]
        pid: Option<String>,

        /// Maximum number of messages
        #[arg(long)]
        limit: Option<u32>,

        /// Offset into message history
        #[arg(long)]
        offset: Option<u32>,
    },

    /// Reset process conversation history
    Reset {
        /// Optional process ID (defaults to your init process)
        #[arg(long)]
        pid: Option<String>,
    },

    /// Kill a process
    Kill {
        /// Process ID
        pid: String,

        /// Skip archival before kill
        #[arg(long)]
        no_archive: bool,
    },
}

#[derive(Subcommand, Clone)]
enum AdapterAction {
    /// Connect/start an adapter account
    Connect {
        /// Adapter id (e.g., whatsapp, discord)
        #[arg(long)]
        adapter: String,

        /// Adapter account id
        #[arg(long = "account-id", default_value = "default")]
        account_id: String,

        /// Adapter-specific config JSON object
        #[arg(long = "config-json")]
        config_json: Option<String>,
    },

    /// Disconnect/stop an adapter account
    Disconnect {
        /// Adapter id (e.g., whatsapp, discord)
        #[arg(long)]
        adapter: String,

        /// Adapter account id
        #[arg(long = "account-id", default_value = "default")]
        account_id: String,
    },

    /// Show adapter account status
    Status {
        /// Adapter id (e.g., whatsapp, discord)
        #[arg(long)]
        adapter: String,

        /// Optional adapter account id
        #[arg(long = "account-id")]
        account_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum LocalConfigAction {
    /// Get a config value
    Get {
        /// Config key (e.g., "gateway.url", "gateway.username", "gateway.token", "node.token", "node.workspace")
        key: String,
    },
    /// Set a config value
    Set {
        /// Config key (e.g., "gateway.url", "gateway.username", "gateway.token", "node.token", "node.workspace")
        key: String,
        /// Value to set
        value: String,
    },
}

#[derive(Subcommand)]
enum DeployAction {
    /// Deploy prebuilt Cloudflare bundles (fetch/install + apply)
    Up {
        /// Release ref (e.g., stable, dev, v0.2.0, or latest stable)
        #[arg(long, default_value = "latest")]
        version: String,

        /// Component to include (repeat for multiple)
        #[arg(short = 'c', long = "component")]
        component: Vec<String>,

        /// Include all components
        #[arg(long)]
        all: bool,

        /// Overwrite existing extracted bundle directories
        #[arg(long)]
        force_fetch: bool,

        /// Use local Cloudflare bundle directory instead of downloading from release assets
        #[arg(long)]
        bundle_dir: Option<PathBuf>,

        /// Cloudflare API token (falls back to config `cloudflare.api_token`)
        #[arg(long, env = "CF_API_TOKEN")]
        api_token: Option<String>,

        /// Cloudflare account ID override (falls back to config `cloudflare.account_id`)
        #[arg(long, env = "CF_ACCOUNT_ID")]
        account_id: Option<String>,

        /// Discord bot token to upload as worker secret (`DISCORD_BOT_TOKEN`)
        #[arg(long, env = "DISCORD_BOT_TOKEN")]
        discord_bot_token: Option<String>,
    },

    /// Tear down deployed Cloudflare workers for selected components
    Down {
        /// Component to remove (repeat for multiple)
        #[arg(short = 'c', long = "component")]
        component: Vec<String>,

        /// Remove all components
        #[arg(long)]
        all: bool,

        /// Also delete the shared R2 storage bucket
        #[arg(long)]
        delete_bucket: bool,

        /// Purge all objects from the shared R2 bucket before deleting it (requires --delete-bucket)
        #[arg(long)]
        purge_bucket: bool,

        /// Run interactive teardown wizard
        #[arg(long)]
        wizard: bool,

        /// Cloudflare API token (falls back to config `cloudflare.api_token`)
        #[arg(long, env = "CF_API_TOKEN")]
        api_token: Option<String>,

        /// Cloudflare account ID override (falls back to config `cloudflare.account_id`)
        #[arg(long, env = "CF_ACCOUNT_ID")]
        account_id: Option<String>,
    },

    /// Show deployment status for selected components
    Status {
        /// Component to inspect (repeat for multiple)
        #[arg(short = 'c', long = "component")]
        component: Vec<String>,

        /// Inspect all components
        #[arg(long)]
        all: bool,

        /// Cloudflare API token (falls back to config `cloudflare.api_token`)
        #[arg(long, env = "CF_API_TOKEN")]
        api_token: Option<String>,

        /// Cloudflare account ID override (falls back to config `cloudflare.account_id`)
        #[arg(long, env = "CF_ACCOUNT_ID")]
        account_id: Option<String>,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Install rustls crypto provider BEFORE tokio runtime starts
    // (required for rustls 0.23+ - must happen before any TLS operations)
    #[cfg(feature = "rustls")]
    {
        rustls_crate::crypto::ring::default_provider()
            .install_default()
            .expect("Failed to install rustls crypto provider");
    }

    // Now start tokio runtime and run async main
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async_main())
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

async fn run_with_auto_setup_retry<F, Fut>(
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
            setup_username.clone(),
            setup_password.clone(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
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
                setup_username,
                setup_password,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await?;

            attempt().await
        }
    }
}

async fn run_with_auto_setup_and_login_retry<F, Fut>(
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
            cli_username.clone(),
            cli_password.clone(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await?;
    }

    match attempt_user_command_with_login_retry(
        url,
        cfg,
        cli_token.clone(),
        cli_username.clone(),
        cli_password.clone(),
        command_name,
        has_explicit_token,
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
                cli_username.clone(),
                cli_password.clone(),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await?;

            attempt_user_command_with_login_retry(
                url,
                cfg,
                cli_token,
                cli_username,
                cli_password,
                command_name,
                has_explicit_token,
                &mut run_with_auth,
            )
            .await
        }
    }
}

async fn attempt_user_command_with_login_retry<F, Fut>(
    url: &str,
    cfg: &CliConfig,
    cli_token: Option<String>,
    cli_username: Option<String>,
    cli_password: Option<String>,
    command_name: &str,
    has_explicit_token: bool,
    run_with_auth: &mut F,
) -> Result<(), Box<dyn std::error::Error>>
where
    F: FnMut(GatewayAuth) -> Fut,
    Fut: Future<Output = Result<(), Box<dyn std::error::Error>>>,
{
    let auth = resolve_interactive_gateway_auth(
        url,
        cfg,
        cli_token.clone(),
        cli_username.clone(),
        cli_password.clone(),
        command_name,
    )
    .await?;

    match run_with_auth(auth).await {
        Ok(()) => Ok(()),
        Err(error) => {
            if !is_auth_failed_error(error.as_ref()) || has_explicit_token {
                return Err(error);
            }

            clear_cached_user_session_token()?;
            let refreshed = resolve_interactive_gateway_auth(
                url,
                cfg,
                cli_token,
                cli_username,
                cli_password,
                command_name,
            )
            .await?;
            run_with_auth(refreshed).await
        }
    }
}

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    // Load config from file
    let cfg = CliConfig::load();

    // Keep explicit CLI overrides so managed device mode can persist them.
    let cli_url_override = cli.url.clone();
    let cli_user_override = cli.user.clone();
    let cli_password_override = cli.password.clone();
    let cli_token_override = cli.token.clone();

    // Merge CLI args with config (CLI takes precedence)
    let url = cli_url_override
        .clone()
        .unwrap_or_else(|| cfg.gateway_url());
    match cli.command {
        Commands::Chat { message, pid } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "chat",
                |auth| async {
                    commands::run_client(&url, auth, message.clone(), pid.clone()).await
                },
            )
            .await
        }
        Commands::Shell => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "shell",
                |auth| async { run_shell(&url, auth).await },
            )
            .await
        }
        Commands::Proc { action } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "proc",
                |auth| async { commands::run_proc(&url, auth, action.clone()).await },
            )
            .await
        }
        Commands::Adapter { action } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "adapter",
                |auth| async { commands::run_adapter(&url, auth, action.clone()).await },
            )
            .await
        }
        Commands::Auth { action } => match action {
            AuthAction::Login {
                username,
                password,
                ttl_hours,
            } => {
                run_with_auto_setup_retry(
                    &url,
                    &cfg,
                    username.clone().or_else(|| cli_user_override.clone()),
                    password.clone().or_else(|| cli_password_override.clone()),
                    || async {
                        run_auth_login(
                            &url,
                            &cfg,
                            username.clone().or_else(|| cli_user_override.clone()),
                            password.clone().or_else(|| cli_password_override.clone()),
                            ttl_hours,
                        )
                        .await
                    },
                )
                .await
            }
            AuthAction::Logout => run_auth_logout(),
            AuthAction::Setup {
                username,
                new_password,
                root_password,
                ai_provider,
                ai_model,
                ai_api_key,
                node_id,
                node_label,
                node_expires_at,
            } => {
                run_auth_setup(
                    &url,
                    &cfg,
                    username,
                    new_password,
                    root_password,
                    ai_provider,
                    ai_model,
                    ai_api_key,
                    node_id,
                    node_label,
                    node_expires_at,
                )
                .await
            }
            link_action @ AuthAction::Link { .. }
            | link_action @ AuthAction::LinkList { .. }
            | link_action @ AuthAction::Unlink { .. } => {
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "auth",
                    |auth| async { commands::run_auth(&url, auth, link_action.clone()).await },
                )
                .await
            }
            token_action @ AuthAction::Token { .. } => {
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "auth",
                    |auth| async { commands::run_auth(&url, auth, token_action.clone()).await },
                )
                .await
            }
        },
        Commands::Device { action } => match action {
            DeviceAction::Run { id, workspace } => {
                run_with_auto_setup_retry(
                    &url,
                    &cfg,
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    || async {
                        let node_id = resolve_node_id(id.clone(), &cfg);
                        let workspace = resolve_node_workspace(workspace.clone(), &cfg);
                        let auth = resolve_node_gateway_auth(
                            &cfg,
                            cli_token_override.clone(),
                            cli_user_override.clone(),
                        )?;
                        run_node(&url, auth, node_id, workspace).await
                    },
                )
                .await
            }
            DeviceAction::Install { id, workspace } => run_node_service(
                DeviceServiceAction::Install { id, workspace },
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DeviceAction::Start => run_node_service(
                DeviceServiceAction::Start,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DeviceAction::Stop => run_node_service(
                DeviceServiceAction::Stop,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DeviceAction::Status => run_node_service(
                DeviceServiceAction::Status,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DeviceAction::Logs { lines, follow } => run_node_service(
                DeviceServiceAction::Logs { lines, follow },
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
        },
        Commands::Config { local, action } => {
            if local {
                match action {
                    ConfigAction::Get { key } => {
                        let key = key.ok_or("`gsv config --local get` requires a key")?;
                        run_local_config(LocalConfigAction::Get { key })
                    }
                    ConfigAction::Set { key, value } => {
                        run_local_config(LocalConfigAction::Set { key, value })
                    }
                }
            } else {
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "config",
                    |auth| async { commands::run_config(&url, auth, action.clone()).await },
                )
                .await
            }
        }
        Commands::Packages { action } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "packages",
                |auth| async { commands::run_packages(&url, auth, action.clone()).await },
            )
            .await
        }
        Commands::Infra { action } => match action {
            InfraAction::Deploy {
                version,
                component,
                all,
                force_fetch,
                bundle_dir,
                api_token,
                account_id,
                discord_bot_token,
            } => {
                run_setup(
                    &cfg,
                    version,
                    component,
                    all,
                    force_fetch,
                    bundle_dir,
                    api_token,
                    account_id,
                    discord_bot_token,
                )
                .await
            }
            InfraAction::Upgrade {
                version,
                component,
                all,
                force_fetch,
                bundle_dir,
                api_token,
                account_id,
                discord_bot_token,
            } => {
                run_upgrade(
                    &cfg,
                    version,
                    component,
                    all,
                    force_fetch,
                    bundle_dir,
                    api_token,
                    account_id,
                    discord_bot_token,
                )
                .await
            }
            InfraAction::Destroy {
                component,
                all,
                delete_bucket,
                purge_bucket,
                wizard,
                api_token,
                account_id,
                keep_node,
            } => {
                run_uninstall(
                    &cfg,
                    component,
                    all,
                    delete_bucket,
                    purge_bucket,
                    wizard,
                    api_token,
                    account_id,
                    keep_node,
                )
                .await
            }
        },
        Commands::Version => run_version(),
    }
}

fn run_version() -> Result<(), Box<dyn std::error::Error>> {
    println!("gsv {}", gsv::build_info::version_display());
    println!("package version: {}", gsv::build_info::PACKAGE_VERSION);
    if gsv::build_info::is_ci_build() {
        if !gsv::build_info::BUILD_CHANNEL.is_empty() {
            println!("channel: {}", gsv::build_info::BUILD_CHANNEL);
        }
        if !gsv::build_info::BUILD_SHA.is_empty() {
            println!("commit: {}", gsv::build_info::BUILD_SHA);
        }
        if !gsv::build_info::BUILD_RUN_NUMBER.is_empty() {
            println!("run: {}", gsv::build_info::BUILD_RUN_NUMBER);
        }
        if !gsv::build_info::BUILD_TAG.is_empty() {
            println!("release tag: {}", gsv::build_info::BUILD_TAG);
        }
    }
    println!("build timestamp: {}", gsv::build_info::BUILD_TIMESTAMP);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_logger() -> NodeLogger {
        let log_path =
            std::env::temp_dir().join(format!("gsv-node-test-{}.log", uuid::Uuid::new_v4()));
        NodeLogger::with_path("test-node", "/tmp", &log_path, 1024 * 1024, 1)
            .expect("create test logger")
    }

    fn test_exec_event(index: usize) -> NodeExecEventParams {
        NodeExecEventParams {
            event_id: format!("event-{index}"),
            session_id: format!("session-{index}"),
            event: "finished".to_string(),
            call_id: Some(format!("call-{index}")),
            exit_code: Some(0),
            signal: None,
            output_tail: Some("ok".to_string()),
            started_at: Some(1),
            ended_at: Some(2),
        }
    }

    #[test]
    fn test_queue_exec_event_for_retry_drops_oldest_when_full() {
        let logger = test_logger();
        let outbox: Arc<Mutex<VecDeque<NodeExecEventParams>>> =
            Arc::new(Mutex::new(VecDeque::new()));

        for i in 0..=MAX_NODE_EXEC_EVENT_OUTBOX {
            queue_exec_event_for_retry(&outbox, test_exec_event(i), &logger);
        }

        let queue = outbox.lock().expect("outbox lock");
        assert_eq!(queue.len(), MAX_NODE_EXEC_EVENT_OUTBOX);
        assert_eq!(
            queue.front().map(|event| event.event_id.as_str()),
            Some("event-1")
        );
        let expected_last = format!("event-{MAX_NODE_EXEC_EVENT_OUTBOX}");
        assert_eq!(
            queue.back().map(|event| event.event_id.as_str()),
            Some(expected_last.as_str())
        );
    }

    #[tokio::test]
    async fn test_flush_exec_event_outbox_retry_keeps_event_queued() {
        let logger = test_logger();
        let outbox: Arc<Mutex<VecDeque<NodeExecEventParams>>> =
            Arc::new(Mutex::new(VecDeque::new()));
        queue_exec_event_for_retry(&outbox, test_exec_event(1), &logger);

        let sent = flush_exec_event_outbox_with_sender(&outbox, &logger, |_event| async {
            ExecEventSendOutcome::Retry("simulated send failure".to_string())
        })
        .await;

        assert_eq!(sent, 0);
        let queue = outbox.lock().expect("outbox lock");
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue.front().map(|event| event.event_id.as_str()),
            Some("event-1")
        );
    }
}

fn run_local_config(action: LocalConfigAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LocalConfigAction::Get { key } => {
            let cfg = CliConfig::load();
            let value = match key.as_str() {
                "gateway.url" => cfg.gateway.url.map(|s| s.to_string()),
                "gateway.username" => cfg.gateway.username.map(|s| s.to_string()),
                "gateway.token" => cfg.gateway.token.map(|s| {
                    // Mask token for security
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "gateway.session_token" => cfg.gateway.session_token.map(|s| {
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "gateway.session_token_id" => cfg.gateway.session_token_id,
                "gateway.session_expires_at" => cfg.gateway.session_expires_at.map(format_unix_ms),
                "gateway.session_expires_at_ms" => cfg
                    .gateway
                    .session_expires_at
                    .map(|value| value.to_string()),
                "cloudflare.account_id" => cfg.cloudflare.account_id,
                "cloudflare.api_token" => cfg.cloudflare.api_token.map(|s| {
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "release.channel" => cfg.release.channel,
                "r2.account_id" => cfg.r2.account_id,
                "r2.access_key_id" => cfg.r2.access_key_id.map(|s| {
                    if s.len() > 8 {
                        format!("{}...", &s[..8])
                    } else {
                        "****".to_string()
                    }
                }),
                "r2.bucket" => cfg.r2.bucket,
                "session.default_key" => cfg.session.default_key,
                "node.id" => cfg.node.id,
                "node.token" => cfg.node.token.map(|s| {
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "node.workspace" => cfg.node.workspace.map(|path| path.display().to_string()),
                _ => {
                    eprintln!("Unknown config key: {}", key);
                    eprintln!("\nValid keys:");
                    eprintln!("  gateway.url, gateway.username, gateway.token");
                    eprintln!("  gateway.session_token, gateway.session_token_id, gateway.session_expires_at");
                    eprintln!("  cloudflare.account_id, cloudflare.api_token");
                    eprintln!("  release.channel");
                    eprintln!("  r2.account_id, r2.access_key_id, r2.bucket");
                    eprintln!("  session.default_key");
                    eprintln!("  node.id, node.token, node.workspace");
                    return Ok(());
                }
            };

            match value {
                Some(v) => println!("{}", v),
                None => println!("(not set)"),
            }
        }

        LocalConfigAction::Set { key, value } => {
            let mut cfg = CliConfig::load();

            match key.as_str() {
                "gateway.url" => cfg.gateway.url = Some(value.clone()),
                "gateway.username" => cfg.gateway.username = Some(value.clone()),
                "gateway.token" => cfg.gateway.token = Some(value.clone()),
                "gateway.session_token" => cfg.gateway.session_token = Some(value.clone()),
                "gateway.session_token_id" => cfg.gateway.session_token_id = Some(value.clone()),
                "gateway.session_expires_at" | "gateway.session_expires_at_ms" => {
                    let parsed = value
                        .trim()
                        .parse::<i64>()
                        .map_err(|_| "gateway.session_expires_at must be unix ms integer")?;
                    cfg.gateway.session_expires_at = Some(parsed);
                }
                "cloudflare.account_id" => cfg.cloudflare.account_id = Some(value.clone()),
                "cloudflare.api_token" => cfg.cloudflare.api_token = Some(value.clone()),
                "release.channel" => {
                    let normalized = value.trim().to_ascii_lowercase();
                    if normalized != "stable" && normalized != "dev" {
                        eprintln!("release.channel must be 'stable' or 'dev'");
                        return Ok(());
                    }
                    cfg.release.channel = Some(normalized);
                }
                "r2.account_id" => cfg.r2.account_id = Some(value.clone()),
                "r2.access_key_id" => cfg.r2.access_key_id = Some(value.clone()),
                "r2.secret_access_key" => cfg.r2.secret_access_key = Some(value.clone()),
                "r2.bucket" => cfg.r2.bucket = Some(value.clone()),
                "session.default_key" => {
                    cfg.session.default_key = Some(config::normalize_session_key(&value))
                }
                "node.id" => cfg.node.id = Some(value.clone()),
                "node.token" => cfg.node.token = Some(value.clone()),
                "node.workspace" => cfg.node.workspace = Some(PathBuf::from(value.clone())),
                "channels.whatsapp.url" => cfg.channels.whatsapp.url = Some(value.clone()),
                "channels.whatsapp.token" => cfg.channels.whatsapp.token = Some(value.clone()),
                _ => {
                    eprintln!("Unknown config key: {}", key);
                    return Ok(());
                }
            }

            cfg.save()?;
            let display_value = if key == "session.default_key" {
                cfg.session.default_key.as_deref().unwrap_or(&value)
            } else {
                &value
            };
            println!(
                "Set {} = {}",
                key,
                if key.contains("token") || key.contains("secret") {
                    "****"
                } else {
                    display_value
                }
            );
        }
    }

    Ok(())
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

fn can_prompt_interactively() -> bool {
    io::stdin().is_terminal() && io::stdout().is_terminal()
}

fn normalize_auth_field(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn format_unix_ms(timestamp_ms: i64) -> String {
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
        .map_err(|_| "Failed to parse sys.token.create response for login")?
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

fn resolve_node_gateway_auth(
    cfg: &CliConfig,
    token: Option<String>,
    cli_username: Option<String>,
) -> Result<GatewayAuth, Box<dyn std::error::Error>> {
    let username = resolve_gateway_username(cfg, cli_username);
    let token =
        normalize_auth_field(token).or_else(|| normalize_auth_field(cfg.default_node_token()));

    if token.is_some() && username.is_none() {
        return Err("Username is required when using --token for device auth".into());
    }

    if username.is_some() && token.is_none() {
        return Err(
            "Missing non-interactive device credential. Set --token or `gsv config --local set node.token ...`."
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

async fn run_auth_setup(
    url: &str,
    cfg: &CliConfig,
    username: Option<String>,
    password: Option<String>,
    root_password: Option<String>,
    ai_provider: Option<String>,
    ai_model: Option<String>,
    ai_api_key: Option<String>,
    node_id: Option<String>,
    node_label: Option<String>,
    node_expires_at: Option<i64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let cli_username = normalize_auth_field(username);
    let cfg_username = normalize_auth_field(cfg.gateway_username());
    let mut username = cli_username.clone().or_else(|| cfg_username.clone());
    let mut password = normalize_auth_field(password);
    let mut root_password = normalize_auth_field(root_password);
    let mut ai_provider = normalize_auth_field(ai_provider).map(|p| p.to_ascii_lowercase());
    let mut ai_model = normalize_auth_field(ai_model);
    let mut ai_api_key = ai_api_key.filter(|value| !value.trim().is_empty());
    let mut node_id = normalize_auth_field(node_id).or_else(|| cfg.node.id.clone());
    let mut node_label = normalize_auth_field(node_label);
    let mut node_expires_at = node_expires_at;

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
            node_id.is_some() || node_label.is_some() || node_expires_at.is_some();
        if !wants_device_token {
            wants_device_token = prompt_yes_no("Issue a device token now?", true)?;
        }
        if wants_device_token {
            if node_id.is_none() {
                let default_device_id = cfg.node.id.clone().unwrap_or_else(|| {
                    format!(
                        "device-{}",
                        whoami::fallible::hostname().unwrap_or_else(|_| "local".to_string())
                    )
                });
                node_id = prompt_line("Device ID for token binding", Some(&default_device_id))?;
            }

            if node_label.is_none() {
                node_label = prompt_line("Device token label (optional)", None)?;
            }

            if node_expires_at.is_none() {
                let expiry_days = prompt_line(
                    "Device token expiry in days (leave empty for no expiry)",
                    None,
                )?;
                if let Some(days_raw) = expiry_days {
                    let days: i64 = days_raw
                        .parse()
                        .map_err(|_| "Expiry days must be a positive integer")?;
                    if days <= 0 {
                        return Err("Expiry days must be greater than zero".into());
                    }
                    node_expires_at =
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

    if let Some(node_id) = node_id {
        let mut node = json!({
            "deviceId": node_id,
        });
        if let Some(label) = node_label {
            node["label"] = json!(label);
        }
        if let Some(expires_at) = node_expires_at {
            node["expiresAt"] = json!(expires_at);
        }
        payload["node"] = node;
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

    if let Some(node_token) = setup.node_token.as_ref() {
        if local_cfg.node.token.as_deref() != Some(node_token.token.as_str()) {
            local_cfg.node.token = Some(node_token.token.clone());
            saved_fields.push("node.token");
        }
        if let Some(device_id) = node_token.allowed_device_id.as_deref() {
            if local_cfg.node.id.as_deref() != Some(device_id) {
                local_cfg.node.id = Some(device_id.to_string());
                saved_fields.push("node.id");
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

    if let Some(node_token) = setup.node_token {
        println!(
            "Node token issued: {} ({})",
            node_token.token_id, node_token.token_prefix
        );
        println!(
            "Node binding: {}",
            node_token.allowed_device_id.as_deref().unwrap_or("<none>")
        );
        println!(
            "Node token expires: {}",
            node_token
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

async fn run_auth_login(
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

fn run_auth_logout() -> Result<(), Box<dyn std::error::Error>> {
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
    node_token: Option<SysSetupNodeToken>,
}

#[derive(Debug, Deserialize)]
struct SysSetupUser {
    uid: u32,
    username: String,
    home: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysSetupNodeToken {
    token_id: String,
    token: String,
    token_prefix: String,
    allowed_device_id: Option<String>,
    expires_at: Option<i64>,
}

fn prompt_yes_no(prompt: &str, default_yes: bool) -> Result<bool, Box<dyn std::error::Error>> {
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

fn prompt_secret(prompt: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let mut prompt = password(prompt).allow_empty();
    let value = prompt.interact()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.to_string()))
}

fn prompt_cloudflare_account_selection(
    accounts: &[deploy::CloudflareAccountSummary],
) -> Result<String, Box<dyn std::error::Error>> {
    if accounts.is_empty() {
        return Err("API token has no accessible Cloudflare accounts".into());
    }

    let mut prompt = select("Select Cloudflare account");
    for account in accounts {
        let name = if account.name.trim().is_empty() {
            "(unnamed account)"
        } else {
            account.name.as_str()
        };
        let label = format!("{} ({})", name, account.id);
        prompt = prompt.item(account.id.clone(), label, "");
    }

    Ok(prompt.interact()?)
}

fn resolve_cloudflare_token_for_deploy(
    cfg: &CliConfig,
    api_token: Option<String>,
    wizard_mode: bool,
    interactive: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    let token = api_token
        .or_else(|| cfg.cloudflare.api_token.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(token) = token {
        return Ok(token);
    }

    if wizard_mode && interactive {
        return prompt_secret("Cloudflare API token")?
            .ok_or("Cloudflare API token is required for deploy wizard".into());
    }

    Err("Cloudflare API token missing. Set --api-token or `gsv config --local set cloudflare.api_token ...`".into())
}

async fn resolve_cloudflare_account_id_for_deploy(
    token: &str,
    configured_account_id: Option<String>,
    wizard_mode: bool,
    interactive: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    if let Some(account_id) = configured_account_id.as_deref() {
        return deploy::resolve_cloudflare_account_id(token, Some(account_id)).await;
    }

    if wizard_mode && interactive {
        let accounts = deploy::list_cloudflare_accounts(token).await?;
        return match accounts.len() {
            0 => Err("API token has no accessible Cloudflare accounts".into()),
            1 => Ok(accounts[0].id.clone()),
            _ => prompt_cloudflare_account_selection(&accounts),
        };
    }

    deploy::resolve_cloudflare_account_id(token, None).await
}

fn component_is_selected(components: &[String], component: &str) -> bool {
    components.iter().any(|c| c == component)
}

fn teardown_component_description(component: &str) -> &'static str {
    match component {
        "ripgit" => "Git-backed storage worker",
        "assembler" => "Package assembly worker",
        "gateway" => "Core API + sessions worker",
        "channel-whatsapp" => "WhatsApp channel worker",
        "channel-discord" => "Discord channel worker",
        _ => "Worker component",
    }
}

fn prompt_down_components(
    default_components: &[String],
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let defaults = deploy::available_components()
        .iter()
        .filter(|component| component_is_selected(default_components, component))
        .map(|component| (*component).to_string())
        .collect::<Vec<_>>();

    let mut prompt = multiselect("Select components to tear down");
    for component in deploy::available_components() {
        prompt = prompt.item(
            (*component).to_string(),
            *component,
            teardown_component_description(component),
        );
    }
    prompt = prompt.required(true);
    if !defaults.is_empty() {
        prompt = prompt.initial_values(defaults);
    }

    Ok(prompt.interact()?)
}

fn normalize_release_channel(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "dev" | "stable" => Some(normalized),
        _ => None,
    }
}

fn release_channel_from_env() -> Option<String> {
    std::env::var("GSV_CHANNEL")
        .ok()
        .and_then(|value| normalize_release_channel(&value))
}

fn release_channel_from_config(cfg: &CliConfig) -> Option<String> {
    cfg.release_channel()
}

fn resolve_channel_aware_version(cfg: &CliConfig, version: &str) -> (String, Option<&'static str>) {
    if version != "latest" {
        return (version.to_string(), None);
    }

    if let Some(channel) = release_channel_from_env() {
        return (channel, Some("GSV_CHANNEL"));
    }

    if let Some(channel) = release_channel_from_config(cfg) {
        return (channel, Some("local config (release.channel)"));
    }

    ("latest".to_string(), None)
}

fn is_mutable_release_ref(version: &str) -> bool {
    let normalized = version.trim().to_ascii_lowercase();
    matches!(normalized.as_str(), "latest" | "dev" | "stable")
}

async fn run_setup(
    cfg: &CliConfig,
    version: String,
    component: Vec<String>,
    all: bool,
    force_fetch: bool,
    bundle_dir: Option<PathBuf>,
    api_token: Option<String>,
    account_id: Option<String>,
    discord_bot_token: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let (version, version_channel_source) = resolve_channel_aware_version(cfg, &version);
    if let Some(source) = version_channel_source {
        println!("Using release channel '{}' from {}.", version, source);
    }

    run_deploy(
        DeployAction::Up {
            version,
            component,
            all,
            force_fetch,
            bundle_dir,
            api_token,
            account_id,
            discord_bot_token,
        },
        cfg,
    )
    .await
}

async fn run_upgrade(
    cfg: &CliConfig,
    version: String,
    component: Vec<String>,
    all: bool,
    force_fetch: bool,
    bundle_dir: Option<PathBuf>,
    api_token: Option<String>,
    account_id: Option<String>,
    discord_bot_token: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let (version, version_channel_source) = resolve_channel_aware_version(cfg, &version);
    if let Some(source) = version_channel_source {
        println!("Using release channel '{}' from {}.", version, source);
    }

    let effective_force_fetch = force_fetch || is_mutable_release_ref(&version);
    if effective_force_fetch && !force_fetch && is_mutable_release_ref(&version) {
        println!(
            "Refresh enabled for mutable release ref '{}' (dev/stable/latest).",
            version
        );
    }

    run_deploy(
        DeployAction::Up {
            version,
            component,
            all,
            force_fetch: effective_force_fetch,
            bundle_dir,
            api_token,
            account_id,
            discord_bot_token,
        },
        cfg,
    )
    .await
}

async fn run_uninstall(
    cfg: &CliConfig,
    component: Vec<String>,
    all: bool,
    delete_bucket: bool,
    purge_bucket: bool,
    wizard: bool,
    api_token: Option<String>,
    account_id: Option<String>,
    keep_node: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let all = if !all && component.is_empty() {
        true
    } else {
        all
    };

    run_deploy(
        DeployAction::Down {
            component,
            all,
            delete_bucket,
            purge_bucket,
            wizard,
            api_token,
            account_id,
        },
        cfg,
    )
    .await?;

    if keep_node {
        println!("Skipped device daemon uninstall (--keep-node).");
        return Ok(());
    }

    if !device_service::node_service_management_supported() {
        println!(
            "Device daemon management is unsupported on this OS. Local device teardown was skipped."
        );
        return Ok(());
    }

    let refreshed_cfg = CliConfig::load();
    run_node_service(
        DeviceServiceAction::Uninstall,
        &refreshed_cfg,
        None,
        None,
        None,
    )
}

async fn run_deploy(
    action: DeployAction,
    cfg: &CliConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    deploy::set_notification_output(false);
    match action {
        DeployAction::Up {
            version,
            component,
            all,
            force_fetch,
            bundle_dir,
            api_token,
            account_id,
            discord_bot_token,
        } => {
            if all && !component.is_empty() {
                return Err("Use either --all or one/more --component values, not both".into());
            }

            let token = resolve_cloudflare_token_for_deploy(cfg, api_token, false, false)?;
            let configured_account_id = account_id
                .or_else(|| cfg.cloudflare.account_id.clone())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let resolved_account_id = resolve_cloudflare_account_id_for_deploy(
                &token,
                configured_account_id,
                false,
                false,
            )
            .await?;
            println!("Cloudflare account ID: {}", resolved_account_id);

            let components = if all {
                deploy::available_components()
                    .iter()
                    .map(|c| (*c).to_string())
                    .collect::<Vec<_>>()
            } else {
                deploy::normalize_components(&component)?
            };

            let deploying_gateway = components.iter().any(|c| c == "gateway");
            let deploying_discord = components.iter().any(|c| c == "channel-discord");

            let bundle_version = if bundle_dir.is_some() {
                deploy::local_bundle_version_label(&version)
            } else {
                deploy::resolve_release_tag(&version).await?
            };
            println!("Preparing components: {}", components.join(", "));
            if let Some(dir) = bundle_dir {
                println!("Using local bundles from {}", dir.display());
                deploy::install_bundles_from_dir(cfg, &dir, &version, &components, force_fetch)?;
            } else {
                deploy::fetch_bundles(cfg, &version, &components, force_fetch).await?;
            }

            println!();
            println!(
                "Preparation complete. Applying deploy from version {}.",
                bundle_version
            );
            let apply_result = deploy::apply_deploy(
                cfg,
                &resolved_account_id,
                &token,
                &bundle_version,
                &components,
            )
            .await?;

            if deploying_discord {
                if let Some(bot_token) = discord_bot_token.as_deref() {
                    println!("Setting DISCORD_BOT_TOKEN secret on Discord channel worker...");
                    deploy::set_discord_bot_token_secret(&resolved_account_id, &token, bot_token)
                        .await?;
                    println!("Configured DISCORD_BOT_TOKEN.");
                } else {
                    println!("Note: Discord bot token not configured.");
                    println!(
                        "Tip: rerun deploy with --discord-bot-token (or DISCORD_BOT_TOKEN env) before `gsv channel discord start`."
                    );
                }
            }

            println!();
            println!("Infrastructure deployed successfully.");
            if deploying_gateway {
                if let Some(gateway_url) = apply_result.gateway_url.as_deref() {
                    println!("Finish onboarding in the browser:");
                    println!("{}", gateway_url);
                } else {
                    println!(
                        "Gateway URL unavailable after deploy. Run `gsv infra status --component gateway` to inspect the worker URL."
                    );
                }
            }

            Ok(())
        }
        DeployAction::Down {
            component,
            all,
            delete_bucket,
            purge_bucket,
            wizard,
            api_token,
            account_id,
        } => {
            if all && !component.is_empty() {
                return Err("Use either --all or one/more --component values, not both".into());
            }
            let interactive = can_prompt_interactively();
            let wizard_mode = wizard;

            if wizard_mode && !interactive {
                return Err("--wizard requires an interactive terminal".into());
            }
            deploy::set_notification_output(wizard_mode && interactive);
            if wizard_mode && interactive {
                intro("GSV teardown wizard")?;
            }
            if !all && component.is_empty() && !wizard_mode {
                return Err(
                    "Refusing to tear down without explicit targets. Use --all or at least one --component."
                        .into(),
                );
            }
            if purge_bucket && !delete_bucket && !wizard_mode {
                return Err("--purge-bucket requires --delete-bucket".into());
            }

            let token =
                resolve_cloudflare_token_for_deploy(cfg, api_token, wizard_mode, interactive)?;
            let configured_account_id = account_id
                .or_else(|| cfg.cloudflare.account_id.clone())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let resolved_account_id = resolve_cloudflare_account_id_for_deploy(
                &token,
                configured_account_id,
                wizard_mode,
                interactive,
            )
            .await?;
            println!("Cloudflare account ID: {}", resolved_account_id);

            let mut components = if all {
                deploy::available_components()
                    .iter()
                    .map(|c| (*c).to_string())
                    .collect::<Vec<_>>()
            } else if component.is_empty() {
                Vec::new()
            } else {
                deploy::normalize_components(&component)?
            };

            if wizard_mode && interactive && !all && component.is_empty() {
                note(
                    "Target",
                    format!("Cloudflare account: {}", resolved_account_id),
                )?;
                components = prompt_down_components(&components)?;
            }

            if components.is_empty() {
                return Err("No components selected for teardown.".into());
            }

            let mut delete_bucket_resource = delete_bucket;
            let mut purge_bucket_resource = purge_bucket;

            if wizard_mode && interactive {
                delete_bucket_resource =
                    prompt_yes_no("Also delete R2 bucket gsv-storage?", delete_bucket_resource)?;
                if delete_bucket_resource {
                    purge_bucket_resource = prompt_yes_no(
                        "Purge bucket objects before deletion?",
                        purge_bucket_resource,
                    )?;
                } else {
                    purge_bucket_resource = false;
                }

                let summary = format!(
                    "Account: {}\nComponents: {}\nDelete bucket: {}\nPurge bucket objects: {}",
                    resolved_account_id,
                    components.join(", "),
                    if delete_bucket_resource { "yes" } else { "no" },
                    if purge_bucket_resource { "yes" } else { "no" }
                );
                note("Teardown summary", summary)?;
                if !prompt_yes_no("Proceed with teardown?", false)? {
                    let _ = outro_cancel("Teardown cancelled.");
                    return Err("Teardown cancelled.".into());
                }
                log::step("Starting teardown...")?;
            } else if purge_bucket_resource && !delete_bucket_resource {
                return Err("--purge-bucket requires --delete-bucket".into());
            }

            println!("Tearing down components: {}", components.join(", "));
            deploy::destroy_deploy(
                &resolved_account_id,
                &token,
                &components,
                delete_bucket_resource,
                purge_bucket_resource,
            )
            .await
        }
        DeployAction::Status {
            component,
            all,
            api_token,
            account_id,
        } => {
            if all && !component.is_empty() {
                return Err("Use either --all or one/more --component values, not both".into());
            }

            let token = api_token
                .or_else(|| cfg.cloudflare.api_token.clone())
                .ok_or("Cloudflare API token missing. Set --api-token or `gsv config --local set cloudflare.api_token ...`")?;
            let configured_account_id = account_id
                .or_else(|| cfg.cloudflare.account_id.clone())
                .filter(|v| !v.trim().is_empty());

            let resolved_account_id =
                deploy::resolve_cloudflare_account_id(&token, configured_account_id.as_deref())
                    .await?;
            println!("Cloudflare account ID: {}", resolved_account_id);

            let components = if all {
                deploy::available_components()
                    .iter()
                    .map(|c| (*c).to_string())
                    .collect::<Vec<_>>()
            } else {
                deploy::normalize_components(&component)?
            };

            println!("Checking components: {}", components.join(", "));
            deploy::print_deploy_status(&resolved_account_id, &token, &components).await
        }
    }
}

const MAX_NODE_EXEC_EVENT_OUTBOX: usize = 2048;

#[cfg(unix)]
async fn wait_for_shutdown_signal() -> &'static str {
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Failed to subscribe to SIGTERM");

    tokio::select! {
        _ = tokio::signal::ctrl_c() => "SIGINT",
        _ = sigterm.recv() => "SIGTERM",
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown_signal() -> &'static str {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to subscribe to Ctrl+C");
    "SIGINT"
}

fn resolve_node_id(cli_node_id: Option<String>, cfg: &CliConfig) -> String {
    cli_node_id
        .or_else(|| cfg.default_node_id())
        .unwrap_or_else(|| {
            let hostname = hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string());
            format!("node-{}", hostname)
        })
}

fn resolve_node_workspace(cli_workspace: Option<PathBuf>, cfg: &CliConfig) -> PathBuf {
    cli_workspace
        .or_else(|| cfg.default_node_workspace())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn persist_node_defaults(
    cfg: &CliConfig,
    node_id: Option<String>,
    workspace: Option<PathBuf>,
) -> Result<(String, PathBuf, bool), Box<dyn std::error::Error>> {
    let node_id = resolve_node_id(node_id, cfg);
    let workspace = resolve_node_workspace(workspace, cfg);
    let workspace = workspace.canonicalize().unwrap_or(workspace);

    let mut local_cfg = CliConfig::load();
    let mut changed = false;

    if local_cfg.node.id.as_deref() != Some(node_id.as_str()) {
        local_cfg.node.id = Some(node_id.clone());
        changed = true;
    }

    if local_cfg.node.workspace.as_ref() != Some(&workspace) {
        local_cfg.node.workspace = Some(workspace.clone());
        changed = true;
    }

    if changed {
        local_cfg.save()?;
    }

    Ok((node_id, workspace, changed))
}

fn persist_gateway_overrides(
    gateway_url_override: Option<&str>,
    gateway_username_override: Option<&str>,
    gateway_token_override: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    if gateway_url_override.is_none()
        && gateway_username_override.is_none()
        && gateway_token_override.is_none()
    {
        return Ok(false);
    }

    let mut local_cfg = CliConfig::load();
    let mut changed = false;

    if let Some(url) = gateway_url_override {
        if local_cfg.gateway.url.as_deref() != Some(url) {
            local_cfg.gateway.url = Some(url.to_string());
            changed = true;
        }
    }

    if let Some(username) = gateway_username_override {
        if local_cfg.gateway.username.as_deref() != Some(username) {
            local_cfg.gateway.username = Some(username.to_string());
            changed = true;
        }
    }

    if let Some(token) = gateway_token_override {
        if local_cfg.gateway.token.as_deref() != Some(token) {
            local_cfg.gateway.token = Some(token.to_string());
            changed = true;
        }
    }

    if changed {
        local_cfg.save()?;
    }

    Ok(changed)
}

fn run_node_service(
    action: DeviceServiceAction,
    cfg: &CliConfig,
    gateway_url_override: Option<&str>,
    gateway_username_override: Option<&str>,
    gateway_token_override: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        DeviceServiceAction::Install { id, workspace } => {
            let gateway_overrides_changed = persist_gateway_overrides(
                gateway_url_override,
                gateway_username_override,
                gateway_token_override,
            )?;
            let (node_id, workspace, node_defaults_changed) =
                persist_node_defaults(cfg, id, workspace)?;

            device_service::install_node_service()?;

            if gateway_overrides_changed || node_defaults_changed {
                device_service::restart_node_service()?;
            }

            println!("Device daemon installed and started.");
            if gateway_overrides_changed {
                println!("Saved gateway connection overrides to local config.");
            }
            println!(
                "Saved defaults: node.id={}, node.workspace={}",
                node_id,
                workspace.display()
            );
            println!("\nCheck status:");
            println!("  gsv device status");
            println!("View logs:");
            println!("  gsv device logs --follow");
        }
        DeviceServiceAction::Uninstall => {
            device_service::uninstall_node_service()?;

            println!("Device daemon uninstalled.");
        }
        DeviceServiceAction::Start => {
            let gateway_overrides_changed = persist_gateway_overrides(
                gateway_url_override,
                gateway_username_override,
                gateway_token_override,
            )?;

            if gateway_overrides_changed {
                device_service::restart_node_service()?;
                println!("Saved gateway connection overrides to local config.");
                println!("Device daemon restarted.");
                return Ok(());
            }

            device_service::start_node_service()?;

            println!("Device daemon started.");
        }
        DeviceServiceAction::Stop => {
            device_service::stop_node_service()?;

            println!("Device daemon stopped.");
        }
        DeviceServiceAction::Status => {
            device_service::status_node_service()?;
        }
        DeviceServiceAction::Logs { lines, follow } => {
            device_service::show_node_service_logs(lines, follow)?;
        }
    }

    Ok(())
}

fn exec_event_outbox_len(outbox: &Arc<Mutex<VecDeque<NodeExecEventParams>>>) -> usize {
    outbox.lock().map(|queue| queue.len()).unwrap_or(0)
}

enum ExecEventSendOutcome {
    Sent,
    Retry(String),
    Drop(String),
}

fn queue_exec_event_for_retry(
    outbox: &Arc<Mutex<VecDeque<NodeExecEventParams>>>,
    event: NodeExecEventParams,
    logger: &NodeLogger,
) {
    let mut queue = match outbox.lock() {
        Ok(queue) => queue,
        Err(error) => {
            logger.error(
                "node.exec.event.outbox_lock_failed",
                json!({
                    "error": error.to_string(),
                }),
            );
            return;
        }
    };

    if queue.len() >= MAX_NODE_EXEC_EVENT_OUTBOX {
        if let Some(dropped) = queue.pop_front() {
            logger.warn(
                "node.exec.event.outbox_drop_oldest",
                json!({
                    "eventId": dropped.event_id,
                    "sessionId": dropped.session_id,
                    "event": dropped.event,
                    "maxOutbox": MAX_NODE_EXEC_EVENT_OUTBOX,
                }),
            );
        }
    }

    queue.push_back(event);
}

async fn flush_exec_event_outbox_with_sender<F, Fut>(
    outbox: &Arc<Mutex<VecDeque<NodeExecEventParams>>>,
    logger: &NodeLogger,
    mut send_event: F,
) -> usize
where
    F: FnMut(NodeExecEventParams) -> Fut,
    Fut: Future<Output = ExecEventSendOutcome>,
{
    let mut sent = 0usize;

    loop {
        let next_event = match outbox.lock() {
            Ok(queue) => queue.front().cloned(),
            Err(error) => {
                logger.error(
                    "node.exec.event.outbox_lock_failed",
                    json!({
                        "error": error.to_string(),
                    }),
                );
                return sent;
            }
        };

        let Some(event) = next_event else {
            return sent;
        };

        match send_event(event.clone()).await {
            ExecEventSendOutcome::Sent => {
                if let Ok(mut queue) = outbox.lock() {
                    let _ = queue.pop_front();
                }
                sent += 1;
            }
            ExecEventSendOutcome::Drop(error) => {
                logger.error(
                    "node.exec.event.serialize_failed",
                    json!({
                        "eventId": event.event_id,
                        "sessionId": event.session_id,
                        "event": event.event,
                        "error": error,
                    }),
                );
                if let Ok(mut queue) = outbox.lock() {
                    let _ = queue.pop_front();
                }
                continue;
            }
            ExecEventSendOutcome::Retry(error) => {
                logger.warn(
                    "node.exec.event.send_failed",
                    json!({
                        "eventId": event.event_id,
                        "sessionId": event.session_id,
                        "event": event.event,
                        "error": error,
                        "outboxDepth": exec_event_outbox_len(outbox),
                    }),
                );
                return sent;
            }
        }
    }
}

async fn flush_exec_event_outbox(
    conn: &Arc<Connection>,
    outbox: &Arc<Mutex<VecDeque<NodeExecEventParams>>>,
    logger: &NodeLogger,
) -> usize {
    flush_exec_event_outbox_with_sender(outbox, logger, |event| {
        let conn = Arc::clone(conn);
        async move {
            let payload = match serde_json::to_value(&event) {
                Ok(value) => value,
                Err(error) => return ExecEventSendOutcome::Drop(error.to_string()),
            };

            let frame = Frame::Sig(SignalFrame {
                signal: "exec.status".to_string(),
                payload: Some(payload),
                seq: None,
            });

            match serde_json::to_string(&frame) {
                Ok(text) => match conn.send_raw(text).await {
                    Ok(_) => ExecEventSendOutcome::Sent,
                    Err(error) => ExecEventSendOutcome::Retry(error.to_string()),
                },
                Err(error) => ExecEventSendOutcome::Drop(error.to_string()),
            }
        }
    })
    .await
}

fn syscall_to_tool_name(call: &str) -> Option<&'static str> {
    match call {
        "fs.read" => Some("Read"),
        "fs.write" => Some("Write"),
        "fs.edit" => Some("Edit"),
        "fs.search" => Some("Grep"),
        "fs.delete" => Some("Delete"),
        "shell.exec" => Some("Bash"),
        _ => None,
    }
}

async fn handle_driver_request(
    conn: &Arc<Connection>,
    tools: &[Box<dyn Tool>],
    req: &RequestFrame,
    logger: &NodeLogger,
) {
    let args = req.args.clone().unwrap_or(serde_json::Value::Null);

    let result: Result<serde_json::Value, String> = match req.call.as_str() {
        call => {
            if let Some(tool_name) = syscall_to_tool_name(call) {
                execute_tool_by_name(tools, tool_name, args).await
            } else {
                Err(format!("unknown syscall: {}", call))
            }
        }
    };

    let response = match result {
        Ok(data) => Frame::Res(ResponseFrame {
            id: req.id.clone(),
            ok: true,
            data: Some(data),
            error: None,
        }),
        Err(message) => {
            if req.call.starts_with("fs.") {
                Frame::Res(ResponseFrame {
                    id: req.id.clone(),
                    ok: true,
                    data: Some(json!({
                        "ok": false,
                        "error": message,
                    })),
                    error: None,
                })
            } else {
                Frame::Res(ResponseFrame {
                    id: req.id.clone(),
                    ok: false,
                    data: None,
                    error: Some(ErrorShape {
                        code: -1,
                        message: message.clone(),
                        details: None,
                        retryable: None,
                    }),
                })
            }
        }
    };

    match serde_json::to_string(&response) {
        Ok(text) => {
            if let Err(e) = conn.send_raw(text).await {
                logger.error(
                    "driver.response.send_failed",
                    json!({
                        "requestId": req.id,
                        "call": req.call,
                        "error": e.to_string(),
                    }),
                );
            }
        }
        Err(e) => {
            logger.error(
                "driver.response.serialize_failed",
                json!({
                    "requestId": req.id,
                    "call": req.call,
                    "error": e.to_string(),
                }),
            );
        }
    }
}

async fn execute_tool_by_name(
    tools: &[Box<dyn Tool>],
    name: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    for tool in tools {
        if tool.definition().name == name {
            return tool.execute(args).await;
        }
    }
    Err(format!("tool not found: {}", name))
}

async fn run_shell(url: &str, auth: GatewayAuth) -> Result<(), Box<dyn std::error::Error>> {
    let username = auth.username.clone();
    let client = KernelClient::connect_user(url, auth, |frame| {
        if let Frame::Sig(sig) = frame {
            eprintln!("[signal] {}: {:?}", sig.signal, sig.payload);
        }
    })
    .await?;

    let username = username.unwrap_or_else(|| "setup".to_string());
    println!("Connected to GSV OS as {}", username);
    println!("Type commands to execute, or :quit to exit");
    println!();

    let stdin = io::stdin();

    loop {
        eprint!("gsv$ ");
        {
            use std::io::Write;
            std::io::stderr().flush().ok();
        }

        let mut line = String::new();
        if stdin.read_line(&mut line)? == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == ":quit" || trimmed == ":exit" || trimmed == ":q" {
            break;
        }

        let res = client
            .connection()
            .request("shell.exec", Some(json!({ "command": trimmed })))
            .await?;

        if res.ok {
            if let Some(data) = &res.data {
                if let Some(stdout) = data.get("stdout").and_then(|v| v.as_str()) {
                    if !stdout.is_empty() {
                        print!("{}", stdout);
                    }
                }
                if let Some(stderr) = data.get("stderr").and_then(|v| v.as_str()) {
                    if !stderr.is_empty() {
                        eprint!("{}", stderr);
                    }
                }
                if let Some(exit_code) = data.get("exitCode").and_then(|v| v.as_i64()) {
                    if exit_code != 0 {
                        eprintln!("[exit {}]", exit_code);
                    }
                }
            }
        } else if let Some(err) = &res.error {
            eprintln!("error [{}]: {}", err.code, err.message);
        }
    }

    println!("bye");
    Ok(())
}

async fn run_node(
    url: &str,
    auth: GatewayAuth,
    node_id: String,
    workspace: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let logger = NodeLogger::new(&node_id, &workspace)?;
    let log_path = logger::node_log_path()?;
    logger.info(
        "node.start",
        json!({
            "url": url,
            "logPath": log_path.display().to_string(),
            "logMaxBytes": logger::node_log_max_bytes(),
            "logMaxFiles": logger::node_log_max_files(),
        }),
    );

    let shutdown = wait_for_shutdown_signal();
    tokio::pin!(shutdown);

    let exec_event_outbox: Arc<Mutex<VecDeque<NodeExecEventParams>>> =
        Arc::new(Mutex::new(VecDeque::new()));
    let outbox_for_exec_events = exec_event_outbox.clone();
    let logger_for_exec_events = logger.clone();
    let mut exec_events = subscribe_exec_events();
    let exec_event_collector = tokio::spawn(async move {
        loop {
            match exec_events.recv().await {
                Ok(event) => {
                    queue_exec_event_for_retry(
                        &outbox_for_exec_events,
                        event,
                        &logger_for_exec_events,
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    logger_for_exec_events.warn(
                        "node.exec.event.lagged",
                        json!({
                            "skipped": skipped,
                        }),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    const CONNECT_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(30);
    const INITIAL_RETRY_DELAY: tokio::time::Duration = tokio::time::Duration::from_secs(3);
    const MAX_RETRY_DELAY: tokio::time::Duration = tokio::time::Duration::from_secs(300);
    let mut retry_delay = INITIAL_RETRY_DELAY;

    loop {
        logger.info("connect.attempt", json!({ "url": url }));

        let tools_for_handler: Arc<Vec<Box<dyn Tool>>> =
            Arc::new(all_tools_with_workspace(workspace.clone()));

        let conn = match tokio::time::timeout(
            CONNECT_TIMEOUT,
            KernelClient::connect_driver(
                url,
                node_id.clone(),
                vec!["fs.*".to_string(), "shell.exec".to_string()],
                auth.clone(),
                |_frame| {},
            ),
        )
        .await
        {
            Ok(Ok(c)) => {
                retry_delay = INITIAL_RETRY_DELAY;
                c.into_connection()
            }
            Ok(Err(e)) => {
                if let Some(rpc_error) = e.downcast_ref::<GatewayRpcError>() {
                    if rpc_error.is_setup_required() {
                        logger.error(
                            "connect.setup_required",
                            json!({
                                "error": rpc_error.to_string(),
                            }),
                        );
                        return Err(e);
                    }
                }
                logger.error(
                    "connect.failed",
                    json!({
                        "error": e.to_string(),
                        "retrySeconds": retry_delay.as_secs(),
                    }),
                );
                tokio::time::sleep(retry_delay).await;
                retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                continue;
            }
            Err(_) => {
                logger.error(
                    "connect.timeout",
                    json!({
                        "timeoutSeconds": CONNECT_TIMEOUT.as_secs(),
                        "retrySeconds": retry_delay.as_secs(),
                    }),
                );
                tokio::time::sleep(retry_delay).await;
                retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                continue;
            }
        };

        logger.info(
            "connect.ok",
            json!({
                "implements": ["fs.*", "shell.*"],
            }),
        );

        let conn = Arc::new(conn);

        let conn_clone = conn.clone();
        let tools_clone = tools_for_handler.clone();
        let logger_clone = logger.clone();

        // In the new OS architecture, the kernel sends req frames directly to
        // the driver. We dispatch based on `call` and respond with a res frame.
        conn.set_frame_handler(move |frame| {
            let conn = conn_clone.clone();
            let tools = tools_clone.clone();
            let logger = logger_clone.clone();

            tokio::spawn(async move {
                if let Frame::Req(req) = frame {
                    handle_driver_request(&conn, &tools, &req, &logger).await;
                }
            });
        })
        .await;

        let flushed = flush_exec_event_outbox(&conn, &exec_event_outbox, &logger).await;
        if flushed > 0 {
            logger.info(
                "node.exec.event.flushed",
                json!({
                    "sent": flushed,
                    "remaining": exec_event_outbox_len(&exec_event_outbox),
                }),
            );
        }

        let keepalive_interval = tokio::time::Duration::from_secs(240);
        let keepalive_timeout = tokio::time::Duration::from_secs(10);
        logger.info(
            "connect.ok",
            json!({
                "keepaliveSeconds": keepalive_interval.as_secs(),
            }),
        );
        let mut next_keepalive_at = tokio::time::Instant::now() + keepalive_interval;

        // Monitor for disconnection or Ctrl+C
        loop {
            tokio::select! {
                signal = &mut shutdown => {
                    exec_event_collector.abort();
                    logger.info("shutdown", json!({ "signal": signal }));
                    return Ok(());
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
                    if conn.is_disconnected() {
                        logger.warn(
                            "connect.lost",
                            json!({
                                "retrySeconds": 3,
                            }),
                        );
                        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                        break; // Break inner loop to reconnect
                    }

                    let flushed = flush_exec_event_outbox(&conn, &exec_event_outbox, &logger).await;
                    if flushed > 0 {
                        logger.info(
                            "node.exec.event.flushed",
                            json!({
                                "sent": flushed,
                                "remaining": exec_event_outbox_len(&exec_event_outbox),
                            }),
                        );
                    }

                    if tokio::time::Instant::now() >= next_keepalive_at {
                        let keepalive = tokio::time::timeout(
                            keepalive_timeout,
                            conn.request(
                                "shell.exec",
                                Some(json!({
                                    "command": "echo gsv-keepalive",
                                })),
                            ),
                        )
                        .await;

                        match keepalive {
                            Ok(Ok(res)) if res.ok => {
                                next_keepalive_at = tokio::time::Instant::now() + keepalive_interval;
                            }
                            Ok(Ok(res)) => {
                                let message = res
                                    .error
                                    .map(|e| e.message)
                                    .unwrap_or_else(|| "unknown response".to_string());
                                logger.warn(
                                    "keepalive.failed",
                                    json!({
                                        "error": message,
                                        "retrySeconds": 3,
                                    }),
                                );
                                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                                break;
                            }
                            Ok(Err(e)) => {
                                logger.warn(
                                    "keepalive.request_error",
                                    json!({
                                        "error": e.to_string(),
                                        "retrySeconds": 3,
                                    }),
                                );
                                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                                break;
                            }
                            Err(_) => {
                                logger.warn(
                                    "keepalive.timeout",
                                    json!({
                                        "timeoutSeconds": 10,
                                        "retrySeconds": 3,
                                    }),
                                );
                                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
}
