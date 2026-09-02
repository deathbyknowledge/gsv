use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "gsv",
    version = gsv::build_info::BUILD_VERSION,
    about = "GSV CLI - Chat, Device, and Desktop Control Plane"
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
    pub(crate) command: Option<Commands>,
}

#[derive(Subcommand)]
pub(crate) enum Commands {
    /// Open the full-screen GSV interface
    Tui {
        /// Run the interface with local example responses and no account
        #[arg(long)]
        demo: bool,

        /// Process ID to open (defaults to the personal intelligence)
        #[arg(long)]
        pid: Option<String>,
    },

    /// Send a message to the agent (interactive or one-shot)
    Chat {
        /// Message to send (if omitted, enters interactive mode)
        message: Option<String>,

        /// Process ID to continue (creates a new process when omitted)
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

    /// Install, inspect, and control the local gsvd service
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },

    /// Compatibility command for already-installed legacy service definitions
    #[command(name = "device", hide = true)]
    LegacyDevice {
        #[command(subcommand)]
        action: LegacyDeviceAction,
    },

    /// Launch, focus, or control the local GSV Desktop application
    Desktop {
        #[command(subcommand)]
        action: Option<DesktopAction>,
    },

    /// Get or set gateway configuration (use --local for CLI config)
    Config {
        /// Operate on local CLI config instead of remote kernel config
        #[arg(long)]
        local: bool,

        #[command(subcommand)]
        action: ConfigAction,
    },

    /// Show CLI version and build metadata
    Version,
}

#[derive(Subcommand)]
pub(crate) enum DesktopAction {
    /// Show redacted local Desktop state without launching it
    Status {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },

    /// Create and select a new conversation in Desktop
    New,

    /// Select an existing process in Desktop
    Use {
        /// Process ID to select
        pid: String,
    },

    /// List or select the microphone used for voice input
    Microphone {
        #[command(subcommand)]
        action: MicrophoneAction,
    },
}

#[derive(Subcommand)]
pub(crate) enum MicrophoneAction {
    /// List microphones and the current selection
    List,

    /// Select and remember a microphone by name
    Use {
        /// Microphone name to select
        name: String,
    },

    /// Use the operating system's default microphone
    Default,
}

#[derive(Subcommand)]
pub(crate) enum LegacyDeviceAction {
    /// Run gsvd in the foreground (compatibility launcher)
    Run {
        /// Device ID (default: device-<hostname>)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory for file tools
        #[arg(long)]
        workspace: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
pub(crate) enum DaemonAction {
    /// Install and start the gsvd service
    Install {
        /// Machine ID (saved to local config during install)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory (saved to local config during install)
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Start the gsvd service
    Start,

    /// Restart the gsvd service
    Restart,

    /// Stop the gsvd service
    Stop,

    /// Uninstall and stop the gsvd service
    Uninstall,

    /// Show service state and live daemon status
    Status,

    /// Check the daemon executable and installed service definition
    Doctor,

    /// Ask the running daemon to reload config.toml and reconnect
    Reload,

    /// Reconnect the running daemon without changing configuration
    Reconnect,

    /// Show bounded, redacted live diagnostics
    Diagnostics {
        /// Print machine-readable JSON
        #[arg(long)]
        json: bool,
    },

    /// Show gsvd service logs
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
pub(crate) enum DaemonServiceAction {
    /// Install and start the gsvd service
    Install {
        /// Device ID (saved to local config during install)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory (saved to local config during install)
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Uninstall and stop the gsvd service
    Uninstall,

    /// Start the gsvd service
    Start,

    /// Restart the gsvd service
    Restart,

    /// Stop the gsvd service
    Stop,

    /// Show gsvd service status
    Status,

    /// Check the daemon executable and installed service definition
    Doctor,

    /// Show gsvd service logs
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
        /// Account to run the process as a username or uid
        /// (default: personal agent)
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

        /// Process ID
        #[arg(long)]
        pid: String,
    },

    /// Read process message history
    History {
        /// Process ID
        #[arg(long)]
        pid: String,

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

    /// Reset process history
    Reset {
        /// Process ID
        #[arg(long)]
        pid: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_without_a_subcommand_means_activate() {
        let cli = Cli::try_parse_from(["gsv", "desktop"]).expect("desktop command parses");
        assert!(matches!(
            cli.command,
            Some(Commands::Desktop { action: None })
        ));
    }

    #[test]
    fn bare_gsv_selects_the_tui_and_demo_is_explicit() {
        let bare = Cli::try_parse_from(["gsv"]).expect("bare gsv parses");
        assert!(bare.command.is_none());

        let demo = Cli::try_parse_from(["gsv", "tui", "--demo"]).expect("demo tui parses");
        assert!(matches!(
            demo.command,
            Some(Commands::Tui {
                demo: true,
                pid: None
            })
        ));
    }

    #[test]
    fn desktop_commands_accept_only_the_narrow_control_surface() {
        let status =
            Cli::try_parse_from(["gsv", "desktop", "status", "--json"]).expect("status parses");
        assert!(matches!(
            status.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Status { json: true })
            })
        ));

        let new = Cli::try_parse_from(["gsv", "desktop", "new"]).expect("new parses");
        assert!(matches!(
            new.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::New)
            })
        ));

        let use_process =
            Cli::try_parse_from(["gsv", "desktop", "use", "proc:1"]).expect("use parses");
        assert!(matches!(
            use_process.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Use { pid })
            }) if pid == "proc:1"
        ));

        let microphone_list = Cli::try_parse_from(["gsv", "desktop", "microphone", "list"])
            .expect("microphone list parses");
        assert!(matches!(
            microphone_list.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Microphone {
                    action: MicrophoneAction::List
                })
            })
        ));

        let microphone_use =
            Cli::try_parse_from(["gsv", "desktop", "microphone", "use", "Shure MV6"])
                .expect("microphone use parses");
        assert!(matches!(
            microphone_use.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Microphone {
                    action: MicrophoneAction::Use { name }
                })
            }) if name == "Shure MV6"
        ));

        let microphone_default = Cli::try_parse_from(["gsv", "desktop", "microphone", "default"])
            .expect("microphone default parses");
        assert!(matches!(
            microphone_default.command,
            Some(Commands::Desktop {
                action: Some(DesktopAction::Microphone {
                    action: MicrophoneAction::Default
                })
            })
        ));

        assert!(Cli::try_parse_from(["gsv", "desktop", "send", "secret"]).is_err());
        assert!(Cli::try_parse_from(["gsv", "desktop", "new", "--label", "private"]).is_err());
        assert!(Cli::try_parse_from(["gsv", "desktop", "microphone"]).is_err());
        assert!(
            Cli::try_parse_from(["gsv", "desktop", "microphone", "use", "one", "two"]).is_err()
        );
    }

    #[test]
    fn daemon_owns_local_service_and_live_control_commands() {
        let status =
            Cli::try_parse_from(["gsv", "daemon", "status"]).expect("daemon status parses");
        assert!(matches!(
            status.command,
            Some(Commands::Daemon {
                action: DaemonAction::Status
            })
        ));

        let reload =
            Cli::try_parse_from(["gsv", "daemon", "reload"]).expect("daemon reload parses");
        assert!(matches!(
            reload.command,
            Some(Commands::Daemon {
                action: DaemonAction::Reload
            })
        ));
        Cli::try_parse_from(["gsv", "daemon", "run"])
            .err()
            .expect("daemon run must not be public");
    }

    #[test]
    fn legacy_device_namespace_retains_only_the_installed_service_launcher() {
        Cli::try_parse_from(["gsv", "device", "run"]).expect("legacy device run still parses");
        Cli::try_parse_from(["gsv", "device", "status"])
            .err()
            .expect("legacy device status must be removed");
        Cli::try_parse_from(["gsv", "device", "install"])
            .err()
            .expect("legacy device install must be removed");
    }
}
