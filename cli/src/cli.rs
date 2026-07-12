use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "gsv",
    version = gsv::build_info::BUILD_VERSION,
    about = "GSV CLI - Chat, Device, and Infrastructure Control Plane"
)]
pub(crate) struct Cli {
    /// Gateway URL (overrides config file)
    #[arg(long, env = "GSV_URL")]
    pub(crate) url: Option<String>,

    /// Gateway username (global override for remote commands)
    #[arg(short = 'u', long, global = true)]
    pub(crate) user: Option<String>,

    /// Gateway password credential (global override for remote commands)
    #[arg(short = 'p', long, global = true)]
    pub(crate) password: Option<String>,

    /// Non-interactive credential (legacy token flag; overrides config/env)
    #[arg(short, long, env = "GSV_TOKEN", global = true)]
    pub(crate) token: Option<String>,

    #[command(subcommand)]
    pub(crate) command: Commands,
}

#[derive(Subcommand)]
pub(crate) enum Commands {
    /// Send a message to the agent (interactive or one-shot)
    Chat {
        /// Message to send (if omitted, enters interactive mode)
        message: Option<String>,

        /// Optional process ID (defaults to your personal-agent conversation)
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
pub(crate) enum DeviceAction {
    /// Run the device in the foreground
    Run {
        /// Device ID (default: device-<hostname>)
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
pub(crate) enum InfraAction {
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

        /// Deployment instance prefix for Worker and bucket names
        #[arg(long, env = "GSV_INSTANCE", default_value = "gsv")]
        instance: String,

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

        /// Telegram bot token to upload as worker secret (`TELEGRAM_BOT_TOKEN`)
        #[arg(long, env = "TELEGRAM_BOT_TOKEN")]
        telegram_bot_token: Option<String>,
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

        /// Deployment instance prefix for Worker and bucket names
        #[arg(long, env = "GSV_INSTANCE", default_value = "gsv")]
        instance: String,

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

        /// Telegram bot token to upload as worker secret (`TELEGRAM_BOT_TOKEN`)
        #[arg(long, env = "TELEGRAM_BOT_TOKEN")]
        telegram_bot_token: Option<String>,
    },

    /// Destroy deployed infrastructure and optionally keep local device daemon
    Destroy {
        /// Component to remove (repeat for multiple). Defaults to all when omitted.
        #[arg(short = 'c', long = "component")]
        component: Vec<String>,

        /// Remove all components
        #[arg(long)]
        all: bool,

        /// Deployment instance prefix for Worker and bucket names
        #[arg(long, env = "GSV_INSTANCE", default_value = "gsv")]
        instance: String,

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
        #[arg(long = "keep-device", alias = "keep-node")]
        keep_device: bool,
    },
}

#[derive(Subcommand, Clone)]
pub(crate) enum PackagesAction {
    /// Re-resolve one installed package from its source repo/ref
    Sync {
        /// Package id, manifest name, or unique package alias
        package: String,

        /// Source ref to install. Defaults to the package's recorded source ref.
        #[arg(long)]
        r#ref: Option<String>,
    },
}

#[derive(Subcommand)]
pub(crate) enum DeviceServiceAction {
    /// Install and start device daemon service
    Install {
        /// Device ID (saved to local config during install)
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
pub(crate) enum ConfigAction {
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
pub(crate) enum AuthAction {
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

        /// Optional device id to pre-issue a device token for
        #[arg(long = "device-id", alias = "node-id")]
        device_id: Option<String>,

        /// Optional device token label
        #[arg(long = "device-label", alias = "node-label")]
        device_label: Option<String>,

        /// Optional device token expiry unix ms
        #[arg(long = "device-expires-at", alias = "node-expires-at")]
        device_expires_at: Option<i64>,
    },

    /// Manage auth tokens
    Token {
        #[command(subcommand)]
        action: AuthTokenAction,
    },
}

#[derive(Subcommand, Clone)]
pub(crate) enum AuthTokenAction {
    /// Create a new auth token
    Create {
        /// Token kind
        #[arg(long, value_enum, default_value = "device")]
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

        /// Optional device binding (device tokens only)
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
pub(crate) enum TokenKindArg {
    #[value(alias = "node")]
    Device,
    Service,
    User,
}

impl TokenKindArg {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Device => "node",
            Self::Service => "service",
            Self::User => "user",
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub(crate) enum TokenRoleArg {
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
pub(crate) enum ProcAction {
    /// List visible processes
    List {
        /// Optional uid filter (root only)
        #[arg(long)]
        uid: Option<u32>,
    },

    /// Spawn a new process
    Spawn {
        /// Account to run the process as: a username, uid, or `package#agent`
        /// (defaults to your personal agent)
        #[arg(long = "as", visible_alias = "run-as")]
        run_as: Option<String>,

        /// Optional process label
        #[arg(long)]
        label: Option<String>,

        /// Optional initial prompt/message for the spawned process
        #[arg(long)]
        prompt: Option<String>,

        /// Optional parent process ID
        #[arg(long = "parent")]
        parent_pid: Option<String>,
    },

    /// Send a message to a process
    Send {
        /// Message to deliver
        message: String,

        /// Optional process ID (defaults to your personal-agent conversation)
        #[arg(long)]
        pid: Option<String>,
    },

    /// Read process message history
    History {
        /// Optional process ID (defaults to your personal-agent conversation)
        #[arg(long)]
        pid: Option<String>,

        /// Read the newest messages instead of the oldest page
        #[arg(long)]
        tail: bool,

        /// Maximum number of messages
        #[arg(long)]
        limit: Option<u32>,

        /// Offset into message history
        #[arg(long)]
        offset: Option<u32>,
    },

    /// Reset process conversation history
    Reset {
        /// Optional process ID (defaults to your personal-agent conversation)
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
pub(crate) enum AdapterAction {
    /// Connect/start an adapter account
    Connect {
        /// Adapter id (e.g., whatsapp, discord, telegram)
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
        /// Adapter id (e.g., whatsapp, discord, telegram)
        #[arg(long)]
        adapter: String,

        /// Adapter account id
        #[arg(long = "account-id", default_value = "default")]
        account_id: String,
    },

    /// Show adapter account status
    Status {
        /// Adapter id (e.g., whatsapp, discord, telegram)
        #[arg(long)]
        adapter: String,

        /// Optional adapter account id
        #[arg(long = "account-id")]
        account_id: Option<String>,
    },
}

#[derive(Subcommand)]
pub(crate) enum LocalConfigAction {
    /// Get a config value
    Get {
        /// Config key (e.g., "gateway.url", "gateway.username", "gateway.token", "device.token", "device.workspace")
        key: String,
    },
    /// Set a config value
    Set {
        /// Config key (e.g., "gateway.url", "gateway.username", "gateway.token", "device.token", "device.workspace")
        key: String,
        /// Value to set
        value: String,
    },
}
