use clap::{Parser, Subcommand};
use cliclack::{confirm, input, intro, log, multiselect, note, outro_cancel, password, select};
use gsv::config::{self, CliConfig};
use gsv::connection::Connection;
use gsv::deploy;
use gsv::protocol::{
    Frame, LogsGetPayload, LogsResultParams, NodeExecEventParams, NodeProbePayload,
    NodeProbeResultParams, NodeRuntimeInfo, ToolDefinition, ToolInvokePayload, ToolResultParams,
};
use gsv::tools::{all_tools_with_workspace, subscribe_exec_events, Tool};
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Parser)]
#[command(
    name = "gsv",
    version,
    about = "GSV CLI - Client and Node for GSV Gateway"
)]
struct Cli {
    /// Gateway URL (overrides config file)
    #[arg(short, long, env = "GSV_URL")]
    url: Option<String>,

    /// Auth token (overrides config file, or set GSV_TOKEN env var)
    #[arg(short, long, env = "GSV_TOKEN")]
    token: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize CLI config file (~/.config/gsv/config.toml)
    Init {
        /// Overwrite existing config
        #[arg(long)]
        force: bool,
    },

    /// Send a message to the agent (interactive or one-shot)
    Client {
        /// Message to send (if omitted, enters interactive mode)
        message: Option<String>,

        /// Session key (default from config or "agent:main:cli:dm:main")
        #[arg(short, long)]
        session: Option<String>,
    },

    /// Run as a tool-providing node
    Node {
        /// Run in foreground (default: managed daemon/service mode)
        #[arg(long)]
        foreground: bool,

        /// Node ID (default: hostname) - used as namespace prefix for tools
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory for file tools (default: config, else current directory)
        #[arg(long)]
        workspace: Option<PathBuf>,

        /// Optional daemon management action (install/start/stop/status/logs)
        #[command(subcommand)]
        action: Option<NodeAction>,
    },

    /// Get or set gateway configuration (remote)
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },

    /// Get or set local CLI configuration
    LocalConfig {
        #[command(subcommand)]
        action: LocalConfigAction,
    },

    /// Cloudflare deployment commands (up/down/status)
    Deploy {
        #[command(subcommand)]
        action: DeployAction,
    },

    /// Manage sessions
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },

    /// Manage tools (list, call)
    Tools {
        #[command(subcommand)]
        action: ToolsAction,
    },

    /// Inspect and refresh skill runtime eligibility
    Skills {
        #[command(subcommand)]
        action: SkillsAction,
    },

    /// Mount R2 bucket to local workspace using rclone
    Mount {
        #[command(subcommand)]
        action: MountAction,
    },

    /// Manage heartbeat (proactive check-ins)
    Heartbeat {
        #[command(subcommand)]
        action: HeartbeatAction,
    },

    /// Manage pairing requests (approve/reject new senders)
    Pair {
        #[command(subcommand)]
        action: PairAction,
    },

    /// Manage channel accounts (WhatsApp, Discord, etc.)
    Channel {
        #[command(subcommand)]
        action: ChannelAction,
    },
}

#[derive(Subcommand)]
enum HeartbeatAction {
    /// Show heartbeat status for all agents
    Status,

    /// Start the heartbeat scheduler
    Start,

    /// Manually trigger a heartbeat
    Trigger {
        /// Agent ID (default: main)
        #[arg(default_value = "main")]
        agent_id: String,
    },
}

#[derive(Subcommand)]
enum PairAction {
    /// List pending pairing requests
    List,

    /// Approve a pairing request
    Approve {
        /// Channel name (e.g., "whatsapp")
        channel: String,

        /// Sender ID (e.g., "+1234567890")
        sender_id: String,
    },

    /// Reject a pairing request
    Reject {
        /// Channel name (e.g., "whatsapp")
        channel: String,

        /// Sender ID (e.g., "+1234567890")
        sender_id: String,
    },
}

#[derive(Subcommand)]
enum ChannelAction {
    /// WhatsApp channel management
    Whatsapp {
        #[command(subcommand)]
        action: WhatsAppAction,
    },

    /// Discord channel management
    Discord {
        #[command(subcommand)]
        action: DiscordAction,
    },

    /// List all channel accounts
    List,
}

#[derive(Subcommand)]
enum WhatsAppAction {
    /// Login to WhatsApp (displays QR code in terminal)
    Login {
        /// Account ID (arbitrary name for this WhatsApp account)
        #[arg(default_value = "default")]
        account_id: String,
    },

    /// Check WhatsApp account status
    Status {
        /// Account ID
        #[arg(default_value = "default")]
        account_id: String,
    },

    /// Logout from WhatsApp (clears credentials)
    Logout {
        /// Account ID
        #[arg(default_value = "default")]
        account_id: String,
    },

    /// Stop WhatsApp connection
    Stop {
        /// Account ID
        #[arg(default_value = "default")]
        account_id: String,
    },
}

#[derive(Subcommand)]
enum DiscordAction {
    /// Start Discord bot connection
    Start {
        /// Account ID (arbitrary name for this Discord bot)
        #[arg(default_value = "default")]
        account_id: String,
    },

    /// Check Discord bot status
    Status {
        /// Account ID
        #[arg(default_value = "default")]
        account_id: String,
    },

    /// Stop Discord bot connection
    Stop {
        /// Account ID
        #[arg(default_value = "default")]
        account_id: String,
    },
}

#[derive(Subcommand)]
enum MountAction {
    /// Configure rclone with R2 credentials (reads from config if not provided)
    Setup {
        /// Cloudflare Account ID (or set r2.account_id in config)
        #[arg(long, env = "CF_ACCOUNT_ID", default_value = "")]
        account_id: String,

        /// R2 Access Key ID (or set r2.access_key_id in config)
        #[arg(long, env = "R2_ACCESS_KEY_ID", default_value = "")]
        access_key_id: String,

        /// R2 Secret Access Key (or set r2.secret_access_key in config)
        #[arg(long, env = "R2_SECRET_ACCESS_KEY", default_value = "")]
        secret_access_key: String,

        /// R2 bucket name (default: gsv-storage)
        #[arg(long, default_value = "gsv-storage")]
        bucket: String,
    },

    /// Start the mount (requires setup first)
    Start {
        /// Run in foreground (default: background)
        #[arg(long)]
        foreground: bool,
    },

    /// Stop the mount
    Stop,

    /// Show mount status
    Status,
}

#[derive(Subcommand)]
enum NodeAction {
    /// Install and start node daemon service
    Install {
        /// Node ID (saved to local config during install)
        #[arg(long)]
        id: Option<String>,

        /// Workspace directory (saved to local config during install)
        #[arg(long)]
        workspace: Option<PathBuf>,
    },

    /// Uninstall and stop node daemon service
    Uninstall,

    /// Start node daemon service
    Start,

    /// Stop node daemon service
    Stop,

    /// Show node daemon service status
    Status,

    /// Show node daemon service logs
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
enum ToolsAction {
    /// List available tools from connected nodes
    List,

    /// Call a tool directly
    Call {
        /// Tool name (e.g., "macbook:Bash")
        tool: String,

        /// Arguments as JSON object (e.g., '{"command": "ls -la"}')
        #[arg(default_value = "{}")]
        args: String,
    },
}

#[derive(Subcommand)]
enum SkillsAction {
    /// Show skill eligibility status for an agent
    Status {
        /// Agent ID (default: main)
        #[arg(default_value = "main")]
        agent_id: String,
    },

    /// Refresh node bin checks and show updated status
    Update {
        /// Agent ID (default: main)
        #[arg(default_value = "main")]
        agent_id: String,

        /// Force re-probing even when cache is fresh
        #[arg(long)]
        force: bool,

        /// Probe timeout in milliseconds
        #[arg(long)]
        timeout_ms: Option<u64>,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Get configuration value
    Get {
        /// Config path (e.g., "apiKeys.anthropic", "model.provider")
        path: Option<String>,
    },
    /// Set configuration value
    Set {
        /// Config path (e.g., "apiKeys.anthropic", "model.provider")
        path: String,
        /// Value to set
        value: String,
    },
}

#[derive(Subcommand)]
enum LocalConfigAction {
    /// Show current local config
    Show,
    /// Get a config value
    Get {
        /// Config key (e.g., "gateway.url", "gateway.token", "workspace.path")
        key: String,
    },
    /// Set a config value
    Set {
        /// Config key (e.g., "gateway.url", "gateway.token", "workspace.path")
        key: String,
        /// Value to set
        value: String,
    },
    /// Show config file path
    Path,
}

#[derive(Subcommand)]
enum DeployAction {
    /// Deploy prebuilt Cloudflare bundles (fetch/install + apply)
    Up {
        /// Release tag (e.g., v0.2.0) or "latest"
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

        /// Run interactive setup prompts (first-time guided flow)
        #[arg(long)]
        wizard: bool,

        /// Cloudflare API token (falls back to config `cloudflare.api_token`)
        #[arg(long, env = "CF_API_TOKEN")]
        api_token: Option<String>,

        /// Cloudflare account ID override (falls back to config `cloudflare.account_id`)
        #[arg(long, env = "CF_ACCOUNT_ID")]
        account_id: Option<String>,

        /// Gateway auth token to set in gateway config (`auth.token`)
        #[arg(long, env = "GSV_GATEWAY_AUTH_TOKEN")]
        gateway_auth_token: Option<String>,

        /// LLM provider to configure on gateway (`anthropic`, `openai`, `google`, `openrouter`, or custom)
        #[arg(long)]
        llm_provider: Option<String>,

        /// LLM model ID to configure on gateway
        #[arg(long)]
        llm_model: Option<String>,

        /// LLM API key to configure on gateway (`apiKeys.<provider>`)
        #[arg(long)]
        llm_api_key: Option<String>,

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

    /// Manage prebuilt Cloudflare bundles from GitHub releases
    #[command(hide = true)]
    Bundle {
        #[command(subcommand)]
        action: DeployBundleAction,
    },

    /// Cloudflare account helpers used by deploy workflows
    #[command(hide = true)]
    Account {
        #[command(subcommand)]
        action: DeployAccountAction,
    },
}

#[derive(Subcommand)]
enum DeployBundleAction {
    /// Download and verify prebuilt Cloudflare bundles
    Fetch {
        /// Release tag (e.g., v0.2.0) or "latest"
        #[arg(long, default_value = "latest")]
        version: String,

        /// Component to fetch (repeat for multiple)
        #[arg(short = 'c', long = "component")]
        component: Vec<String>,

        /// Fetch all components
        #[arg(long)]
        all: bool,

        /// Overwrite existing extracted bundle directories
        #[arg(long)]
        force: bool,

        /// Use local Cloudflare bundle directory instead of downloading from release assets
        #[arg(long)]
        from_dir: Option<PathBuf>,
    },

    /// Show bundle manifest details from local extracted bundles
    Inspect {
        /// Release tag (e.g., v0.2.0) or "latest"
        #[arg(long, default_value = "latest")]
        version: String,

        /// Component to inspect
        #[arg(short = 'c', long = "component")]
        component: String,
    },

    /// List valid component names
    ListComponents,
}

#[derive(Subcommand)]
enum DeployAccountAction {
    /// Resolve Cloudflare account ID from API token (auto-picks if exactly one account)
    Resolve {
        /// Cloudflare API token (falls back to config `cloudflare.api_token`)
        #[arg(long, env = "CF_API_TOKEN")]
        api_token: Option<String>,

        /// Cloudflare account ID override (falls back to config `cloudflare.account_id`)
        #[arg(long, env = "CF_ACCOUNT_ID")]
        account_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum SessionAction {
    /// List all known sessions
    List {
        /// Maximum number of sessions to show
        #[arg(short, long, default_value = "50")]
        limit: i64,
    },
    /// Reset a session (clear message history, archive to R2)
    Reset {
        /// Session key (default: "agent:main:cli:dm:main")
        #[arg(default_value = "agent:main:cli:dm:main")]
        session_key: String,
    },
    /// Get session info
    Get {
        /// Session key (default: "agent:main:cli:dm:main")
        #[arg(default_value = "agent:main:cli:dm:main")]
        session_key: String,
    },
    /// Get session stats (token usage)
    Stats {
        /// Session key (default: "agent:main:cli:dm:main")
        #[arg(default_value = "agent:main:cli:dm:main")]
        session_key: String,
    },
    /// Update session settings
    Set {
        /// Session key
        session_key: String,
        /// Path to set (e.g., "model.provider", "thinkingLevel", "resetPolicy.mode")
        path: String,
        /// Value to set
        value: String,
    },
    /// Compact session (trim to last N messages)
    Compact {
        /// Session key (default: "agent:main:cli:dm:main")
        #[arg(default_value = "agent:main:cli:dm:main")]
        session_key: String,
        /// Number of messages to keep (default: 20)
        #[arg(short, long, default_value = "20")]
        keep: i64,
    },
    /// Show session history (previous session IDs)
    History {
        /// Session key (default: "agent:main:cli:dm:main")
        #[arg(default_value = "agent:main:cli:dm:main")]
        session_key: String,
    },
    /// Preview session messages
    Preview {
        /// Session key (default: "agent:main:cli:dm:main")
        #[arg(default_value = "agent:main:cli:dm:main")]
        session_key: String,
        /// Number of messages to show (default: all)
        #[arg(short, long)]
        limit: Option<i64>,
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

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    // Load config from file
    let cfg = CliConfig::load();

    // Keep explicit CLI overrides so managed node mode can persist them.
    let cli_url_override = cli.url.clone();
    let cli_token_override = cli.token.clone();

    // Merge CLI args with config (CLI takes precedence)
    let url = cli_url_override
        .clone()
        .unwrap_or_else(|| cfg.gateway_url());
    let token = cli_token_override.clone().or_else(|| cfg.gateway_token());

    match cli.command {
        Commands::Init { force } => run_init(force),
        Commands::Client { message, session } => {
            let session = session.unwrap_or_else(|| cfg.default_session());
            let session = config::normalize_session_key(&session);
            run_client(&url, token, message, &session).await
        }
        Commands::Node {
            foreground,
            id,
            workspace,
            action,
        } => {
            if let Some(action) = action {
                if foreground {
                    return Err(
                        "--foreground cannot be combined with node management subcommands".into(),
                    );
                }
                run_node_service(
                    action,
                    &cfg,
                    cli_url_override.as_deref(),
                    cli_token_override.as_deref(),
                )
            } else if foreground {
                let node_id = resolve_node_id(id, &cfg);
                let workspace = resolve_node_workspace(workspace, &cfg);
                run_node(&url, token, node_id, workspace).await
            } else {
                run_node_default_managed(
                    &cfg,
                    id,
                    workspace,
                    cli_url_override.as_deref(),
                    cli_token_override.as_deref(),
                )
            }
        }
        Commands::Config { action } => run_config(&url, token, action).await,
        Commands::LocalConfig { action } => run_local_config(action),
        Commands::Deploy { action } => run_deploy(action, &cfg).await,
        Commands::Session { action } => run_session(&url, token, action).await,
        Commands::Tools { action } => run_tools(&url, token, action).await,
        Commands::Skills { action } => run_skills(&url, token, action).await,
        Commands::Mount { action } => run_mount(action, &cfg).await,
        Commands::Heartbeat { action } => run_heartbeat(&url, token, action).await,
        Commands::Pair { action } => run_pair(&url, token, action).await,
        Commands::Channel { action } => run_channel(action, &url, token, &cfg).await,
    }
}

fn run_init(force: bool) -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = CliConfig::config_path() else {
        return Err("Could not determine config directory".into());
    };

    if path.exists() && !force {
        println!("Config file already exists at: {}", path.display());
        println!("\nUse --force to overwrite, or edit directly:");
        println!("  $EDITOR {}", path.display());
        return Ok(());
    }

    // Create parent directory
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Write sample config
    std::fs::write(&path, config::sample_config())?;

    println!("Created config file: {}", path.display());
    println!("\nEdit it to set your gateway URL and token:");
    println!("  $EDITOR {}", path.display());
    println!("\nOr use 'gsv local-config set' to update values:");
    println!("  gsv local-config set gateway.url wss://gateway.example.com/ws");
    println!("  gsv local-config set gateway.token your-secret-token");
    println!("  gsv local-config set node.id my-node");
    println!("  gsv local-config set node.workspace /path/to/workspace");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_logger() -> NodeLogger {
        let log_path =
            std::env::temp_dir().join(format!("gsv-node-test-{}.log", uuid::Uuid::new_v4()));
        let inner = NodeLoggerInner::open(&log_path, 1024 * 1024, 1).expect("create test logger");
        NodeLogger {
            inner: Arc::new(Mutex::new(inner)),
            node_id: "test-node".to_string(),
            workspace: "/tmp".to_string(),
        }
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
    fn test_normalize_host_env_keys_trims_and_dedups() {
        let keys = vec![
            OsString::from(" PATH "),
            OsString::from("PATH"),
            OsString::from("HOME"),
            OsString::from(""),
            OsString::from("   "),
        ];

        let normalized = normalize_host_env_keys(keys);
        assert_eq!(normalized, vec!["HOME".to_string(), "PATH".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn test_normalize_host_env_keys_skips_non_utf8() {
        use std::os::unix::ffi::OsStringExt;

        let invalid = OsString::from_vec(vec![0xff, 0xfe, 0xfd]);
        let keys = vec![OsString::from("FOO"), invalid, OsString::from("BAR")];

        let normalized = normalize_host_env_keys(keys);
        assert_eq!(normalized, vec!["BAR".to_string(), "FOO".to_string()]);
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
        LocalConfigAction::Show => {
            let cfg = CliConfig::load();
            let toml_str = toml::to_string_pretty(&cfg)?;
            println!("{}", toml_str);
        }

        LocalConfigAction::Get { key } => {
            let cfg = CliConfig::load();
            let value = match key.as_str() {
                "gateway.url" => cfg.gateway.url.map(|s| s.to_string()),
                "gateway.token" => cfg.gateway.token.map(|s| {
                    // Mask token for security
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "cloudflare.account_id" => cfg.cloudflare.account_id,
                "cloudflare.api_token" => cfg.cloudflare.api_token.map(|s| {
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
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
                "node.workspace" => cfg.node.workspace.map(|path| path.display().to_string()),
                _ => {
                    eprintln!("Unknown config key: {}", key);
                    eprintln!("\nValid keys:");
                    eprintln!("  gateway.url, gateway.token");
                    eprintln!("  cloudflare.account_id, cloudflare.api_token");
                    eprintln!("  r2.account_id, r2.access_key_id, r2.bucket");
                    eprintln!("  session.default_key");
                    eprintln!("  node.id, node.workspace");
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
                "gateway.token" => cfg.gateway.token = Some(value.clone()),
                "cloudflare.account_id" => cfg.cloudflare.account_id = Some(value.clone()),
                "cloudflare.api_token" => cfg.cloudflare.api_token = Some(value.clone()),
                "r2.account_id" => cfg.r2.account_id = Some(value.clone()),
                "r2.access_key_id" => cfg.r2.access_key_id = Some(value.clone()),
                "r2.secret_access_key" => cfg.r2.secret_access_key = Some(value.clone()),
                "r2.bucket" => cfg.r2.bucket = Some(value.clone()),
                "session.default_key" => {
                    cfg.session.default_key = Some(config::normalize_session_key(&value))
                }
                "node.id" => cfg.node.id = Some(value.clone()),
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

        LocalConfigAction::Path => match CliConfig::config_path() {
            Some(path) => {
                println!("{}", path.display());
                if path.exists() {
                    println!("(exists)");
                } else {
                    println!("(not created yet - run 'gsv init')");
                }
            }
            None => println!("Could not determine config path"),
        },
    }

    Ok(())
}

fn normalize_llm_provider(provider: &str) -> Option<String> {
    let normalized = provider.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn is_builtin_llm_provider(provider: &str) -> bool {
    matches!(provider, "anthropic" | "openai" | "google" | "openrouter")
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

fn generate_gateway_auth_token() -> String {
    format!(
        "gsv_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn can_prompt_interactively() -> bool {
    io::stdin().is_terminal() && io::stdout().is_terminal()
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

    Err("Cloudflare API token missing. Set --api-token or `gsv local-config set cloudflare.api_token ...`".into())
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

fn prompt_up_components(
    default_components: &[String],
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let default_all = default_components.is_empty();
    let mut defaults = Vec::new();
    if default_all || component_is_selected(default_components, "gateway") {
        defaults.push("gateway".to_string());
    }
    if default_all || component_is_selected(default_components, "channel-whatsapp") {
        defaults.push("channel-whatsapp".to_string());
    }
    if default_all || component_is_selected(default_components, "channel-discord") {
        defaults.push("channel-discord".to_string());
    }

    let mut prompt = multiselect("Select components to deploy")
        .item(
            "gateway".to_string(),
            "gateway",
            "Core API + sessions + shared infra",
        )
        .item(
            "channel-whatsapp".to_string(),
            "channel-whatsapp",
            "WhatsApp channel worker",
        )
        .item(
            "channel-discord".to_string(),
            "channel-discord",
            "Discord channel worker",
        )
        .required(true);
    if !defaults.is_empty() {
        prompt = prompt.initial_values(defaults);
    }

    Ok(prompt.interact()?)
}

fn prompt_down_components(
    default_components: &[String],
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let mut defaults = Vec::new();
    if component_is_selected(default_components, "gateway") {
        defaults.push("gateway".to_string());
    }
    if component_is_selected(default_components, "channel-whatsapp") {
        defaults.push("channel-whatsapp".to_string());
    }
    if component_is_selected(default_components, "channel-discord") {
        defaults.push("channel-discord".to_string());
    }

    let mut prompt = multiselect("Select components to tear down")
        .item(
            "gateway".to_string(),
            "gateway",
            "Core API + sessions worker",
        )
        .item(
            "channel-whatsapp".to_string(),
            "channel-whatsapp",
            "WhatsApp channel worker",
        )
        .item(
            "channel-discord".to_string(),
            "channel-discord",
            "Discord channel worker",
        )
        .required(true);
    if !defaults.is_empty() {
        prompt = prompt.initial_values(defaults);
    }

    Ok(prompt.interact()?)
}

fn prompt_llm_provider(
    default_provider: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let normalized_default = default_provider.and_then(normalize_llm_provider);
    let initial_value = match normalized_default.as_deref() {
        Some(provider) if is_builtin_llm_provider(provider) => provider.to_string(),
        Some(_) => "custom".to_string(),
        None => "anthropic".to_string(),
    };

    let mut prompt = select("LLM provider")
        .item("anthropic".to_string(), "anthropic", "Claude models")
        .item("openai".to_string(), "openai", "GPT models")
        .item("google".to_string(), "google", "Gemini models")
        .item(
            "openrouter".to_string(),
            "openrouter",
            "Routed provider access",
        )
        .item(
            "custom".to_string(),
            "custom",
            "Type a provider id manually",
        )
        .initial_value(initial_value);
    let selection = prompt.interact()?;
    if selection == "custom" {
        let custom_default = normalized_default
            .as_deref()
            .filter(|provider| !is_builtin_llm_provider(provider));
        let custom =
            prompt_line("Custom provider ID", custom_default)?.ok_or("Provider is required")?;
        return normalize_llm_provider(&custom).ok_or("Provider is required".into());
    }

    Ok(selection)
}

fn gateway_http_url_to_ws_url(gateway_url: &str) -> String {
    let mut ws_url = if let Some(rest) = gateway_url.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else if let Some(rest) = gateway_url.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else {
        gateway_url.to_string()
    };

    if !ws_url.ends_with("/ws") {
        ws_url = ws_url.trim_end_matches('/').to_string();
        ws_url.push_str("/ws");
    }

    ws_url
}

fn save_gateway_local_config(
    gateway_url: &str,
    auth_token: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut local_cfg = CliConfig::load();
    local_cfg.gateway.url = Some(gateway_http_url_to_ws_url(gateway_url));
    if let Some(token) = auth_token {
        local_cfg.gateway.token = Some(token.to_string());
    }
    local_cfg.save()?;
    Ok(())
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
            wizard,
            api_token,
            account_id,
            gateway_auth_token,
            llm_provider,
            llm_model,
            llm_api_key,
            discord_bot_token,
        } => {
            if all && !component.is_empty() {
                return Err("Use either --all or one/more --component values, not both".into());
            }

            let interactive = can_prompt_interactively();
            let wizard_mode = wizard;
            let local_account_id_configured = cfg
                .cloudflare
                .account_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty());

            if wizard_mode && !interactive {
                return Err("--wizard requires an interactive terminal".into());
            }
            deploy::set_notification_output(wizard_mode && interactive);
            if wizard_mode && interactive {
                intro("GSV deploy wizard")?;
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
            } else {
                deploy::normalize_components(&component)?
            };

            if wizard_mode && interactive && !all && component.is_empty() {
                components = prompt_up_components(&components)?;
                if components.is_empty() {
                    return Err("No components selected for deployment.".into());
                }
            }

            let deploying_gateway = components.iter().any(|c| c == "gateway");
            let deploying_whatsapp = components.iter().any(|c| c == "channel-whatsapp");
            let deploying_discord = components.iter().any(|c| c == "channel-discord");

            if wizard_mode && interactive {
                note(
                    "Target",
                    format!(
                        "Cloudflare account: {}\nComponents: {}",
                        resolved_account_id,
                        components.join(", ")
                    ),
                )?;
                note(
                    "Security notice",
                    "GSV agents may execute shell commands and access external services.\nEnsure you trust the environment and connected channels/nodes.",
                )?;
                if !prompt_yes_no("I understand the risks and want to proceed", false)? {
                    let _ = outro_cancel("Deployment cancelled.");
                    return Err("Deployment cancelled.".into());
                }
            }

            if !local_account_id_configured {
                if wizard_mode
                    && interactive
                    && prompt_yes_no(
                        "Save this Cloudflare account ID for future deploy commands?",
                        true,
                    )?
                {
                    if persist_cloudflare_account_id(&resolved_account_id)? {
                        println!("Saved cloudflare.account_id to local config.");
                    }
                } else {
                    println!(
                        "Tip: persist it with `gsv local-config set cloudflare.account_id {}`",
                        resolved_account_id
                    );
                }
            }

            let mut resolved_provider = match llm_provider {
                Some(provider) => Some(
                    normalize_llm_provider(&provider).ok_or("--llm-provider must not be empty")?,
                ),
                None => None,
            };
            let mut resolved_llm_model = llm_model;
            let mut resolved_llm_api_key = llm_api_key;
            let mut resolved_discord_bot_token = discord_bot_token;
            let explicit_gateway_auth_token = gateway_auth_token.clone();
            let mut desired_gateway_auth_token = explicit_gateway_auth_token.clone();
            let connect_gateway_auth_token = explicit_gateway_auth_token
                .clone()
                .or_else(|| cfg.gateway.token.clone());

            if !deploying_gateway
                && (explicit_gateway_auth_token.is_some()
                    || resolved_provider.is_some()
                    || resolved_llm_model.is_some()
                    || resolved_llm_api_key.is_some())
            {
                return Err(
                    "Gateway bootstrap options require deploying the `gateway` component.".into(),
                );
            }

            if resolved_llm_model.is_some() && resolved_provider.is_none() {
                return Err("--llm-model requires --llm-provider".into());
            }
            if resolved_llm_api_key.is_some() && resolved_provider.is_none() {
                return Err("--llm-api-key requires --llm-provider".into());
            }

            if deploying_gateway
                && resolved_provider.is_none()
                && resolved_llm_model.is_none()
                && resolved_llm_api_key.is_none()
                && wizard_mode
                && interactive
                && prompt_yes_no("Configure gateway auth + LLM settings now?", true)?
            {
                resolved_provider = Some(prompt_llm_provider(Some("anthropic"))?);
            }

            if let Some(provider) = resolved_provider.as_deref() {
                if resolved_llm_model.is_none() {
                    if let Some(default_model) = default_llm_model_for_provider(provider) {
                        if interactive && wizard_mode {
                            resolved_llm_model = prompt_line("LLM model", Some(default_model))?;
                        } else {
                            resolved_llm_model = Some(default_model.to_string());
                        }
                    } else if interactive && wizard_mode {
                        resolved_llm_model = prompt_line("LLM model", None)?;
                    } else {
                        return Err(format!(
                            "--llm-model is required for custom provider '{}'",
                            provider
                        )
                        .into());
                    }
                }
                if resolved_llm_model
                    .as_deref()
                    .map(|model| model.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err(format!("LLM model is required for provider '{}'", provider).into());
                }

                if resolved_llm_api_key.is_none() {
                    resolved_llm_api_key = env_api_key_for_provider(provider);
                }
                if resolved_llm_api_key.is_none() && interactive && wizard_mode {
                    resolved_llm_api_key = prompt_secret(&format!("{} API key", provider))?;
                }
                if resolved_llm_api_key.is_none() {
                    return Err(format!(
                        "Missing API key for provider '{}'. Use --llm-api-key or set the provider env var.",
                        provider
                    )
                    .into());
                }
            }

            if deploying_discord
                && resolved_discord_bot_token.is_none()
                && wizard_mode
                && interactive
            {
                note(
                    "Discord setup checklist",
                    "1. https://discord.com/developers/applications -> New Application\n2. Bot tab -> Add Bot -> Reset Token\n3. Enable MESSAGE CONTENT INTENT in Bot tab\n4. Invite URL: https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=101376&scope=bot",
                )?;
                if prompt_yes_no(
                    "Configure Discord bot token on deployed channel worker now?",
                    true,
                )? {
                    resolved_discord_bot_token = prompt_secret("Discord bot token")?;
                }
            }

            if wizard_mode && interactive {
                let mut summary = format!(
                    "Account: {}\nComponents: {}",
                    resolved_account_id,
                    components.join(", ")
                );
                if deploying_gateway {
                    if let (Some(provider), Some(model)) =
                        (resolved_provider.as_deref(), resolved_llm_model.as_deref())
                    {
                        summary.push_str(&format!("\nGateway model: {}/{}", provider, model));
                    } else {
                        summary.push_str("\nGateway model: unchanged");
                    }
                }
                if deploying_discord {
                    summary.push_str(&format!(
                        "\nDiscord bot token: {}",
                        if resolved_discord_bot_token.is_some() {
                            "provided"
                        } else {
                            "not provided"
                        }
                    ));
                }
                note("Deployment summary", summary)?;
                if !prompt_yes_no("Ready to deploy?", true)? {
                    let _ = outro_cancel("Deployment cancelled.");
                    return Err("Deployment cancelled.".into());
                }
                log::step("Starting deployment...")?;
            }

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

            if deploying_gateway
                && desired_gateway_auth_token.is_none()
                && !apply_result.gateway_existed_before_deploy
            {
                desired_gateway_auth_token = cfg
                    .gateway
                    .token
                    .clone()
                    .or_else(|| Some(generate_gateway_auth_token()));
            }

            if deploying_gateway {
                if let Some(gateway_url) = apply_result.gateway_url.as_deref() {
                    let set_whatsapp_pairing =
                        deploying_whatsapp && !apply_result.gateway_existed_before_deploy;
                    let gateway_bootstrap = deploy::GatewayBootstrapConfig {
                        auth_token: desired_gateway_auth_token.clone(),
                        llm_provider: resolved_provider.clone(),
                        llm_model: resolved_llm_model.clone(),
                        llm_api_key: resolved_llm_api_key.clone(),
                        set_whatsapp_pairing,
                    };

                    let should_bootstrap = gateway_bootstrap.auth_token.is_some()
                        || gateway_bootstrap.llm_provider.is_some()
                        || gateway_bootstrap.llm_model.is_some()
                        || gateway_bootstrap.llm_api_key.is_some()
                        || gateway_bootstrap.set_whatsapp_pairing;

                    let mut bootstrap_applied = false;
                    if should_bootstrap {
                        println!();
                        println!("Applying gateway runtime configuration...");
                        match deploy::bootstrap_gateway_config(
                            gateway_url,
                            connect_gateway_auth_token
                                .as_deref()
                                .or(desired_gateway_auth_token.as_deref()),
                            &gateway_bootstrap,
                        )
                        .await
                        {
                            Ok(()) => {
                                bootstrap_applied = true;
                                if let Some(token_value) = gateway_bootstrap.auth_token.as_deref() {
                                    if cfg.gateway.token.as_deref() != Some(token_value) {
                                        println!(
                                            "Gateway auth token: {}...{}",
                                            &token_value[..4.min(token_value.len())],
                                            &token_value[token_value.len().saturating_sub(4)..]
                                        );
                                    }
                                }
                            }
                            Err(error) => {
                                println!(
                                    "Warning: gateway runtime configuration failed: {}",
                                    error
                                );
                                println!("You can apply settings manually with:");
                                println!("  gsv config set auth.token <token>");
                                println!("  gsv config set model.provider <provider>");
                                println!("  gsv config set model.id <model>");
                                println!("  gsv config set apiKeys.<provider> <api-key>");
                            }
                        }
                    }

                    let token_to_save = if bootstrap_applied {
                        desired_gateway_auth_token.as_deref()
                    } else {
                        None
                    };
                    save_gateway_local_config(gateway_url, token_to_save)?;
                    if bootstrap_applied {
                        println!("Saved gateway URL/token to local config.");
                    } else {
                        println!("Saved gateway URL to local config.");
                        if should_bootstrap {
                            println!(
                                "Gateway token was not saved because runtime configuration did not complete."
                            );
                        }
                    }
                } else {
                    println!(
                        "Warning: gateway URL was unavailable, skipping runtime configuration step."
                    );
                }
            }

            if deploying_discord {
                if let Some(bot_token) = resolved_discord_bot_token.as_deref() {
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
                .ok_or("Cloudflare API token missing. Set --api-token or `gsv local-config set cloudflare.api_token ...`")?;
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
        DeployAction::Bundle { action } => match action {
            DeployBundleAction::Fetch {
                version,
                component,
                all,
                force,
                from_dir,
            } => {
                if all && !component.is_empty() {
                    return Err("Use either --all or one/more --component values, not both".into());
                }

                let components = if all {
                    deploy::available_components()
                        .iter()
                        .map(|c| (*c).to_string())
                        .collect::<Vec<_>>()
                } else {
                    deploy::normalize_components(&component)?
                };

                println!("Fetching components: {}", components.join(", "));
                if let Some(dir) = from_dir {
                    println!("Installing bundles from local directory: {}", dir.display());
                    deploy::install_bundles_from_dir(cfg, &dir, &version, &components, force)
                } else {
                    deploy::fetch_bundles(cfg, &version, &components, force).await
                }
            }
            DeployBundleAction::Inspect { version, component } => {
                deploy::inspect_bundle(cfg, &version, &component).await
            }
            DeployBundleAction::ListComponents => {
                println!("Available components:");
                for component in deploy::available_components() {
                    println!("  {}", component);
                }
                Ok(())
            }
        },
        DeployAction::Account { action } => match action {
            DeployAccountAction::Resolve {
                api_token,
                account_id,
            } => {
                let token = api_token
                    .or_else(|| cfg.cloudflare.api_token.clone())
                    .ok_or("Cloudflare API token missing. Set --api-token or `gsv local-config set cloudflare.api_token ...`")?;
                let configured_account_id = account_id
                    .or_else(|| cfg.cloudflare.account_id.clone())
                    .filter(|v| !v.trim().is_empty());

                let resolved =
                    deploy::resolve_cloudflare_account_id(&token, configured_account_id.as_deref())
                        .await?;
                if configured_account_id.is_some() {
                    println!("Using configured Cloudflare account ID: {}", resolved);
                } else {
                    println!("Resolved Cloudflare account ID: {}", resolved);
                    println!(
                        "Tip: persist it with `gsv local-config set cloudflare.account_id {}`",
                        resolved
                    );
                }
                Ok(())
            }
        },
    }
}

#[cfg(target_os = "linux")]
const NODE_SYSTEMD_UNIT_NAME: &str = "gsv-node.service";
#[cfg(target_os = "macos")]
const NODE_LAUNCHD_LABEL: &str = "dev.gsv.node";

const DEFAULT_NODE_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_NODE_LOG_MAX_FILES: usize = 5;

fn node_log_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".gsv").join("logs").join("node.log"))
}

fn parse_env_u64(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
}

fn parse_env_usize(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| *v > 0)
}

fn node_log_max_bytes() -> u64 {
    parse_env_u64("GSV_NODE_LOG_MAX_BYTES").unwrap_or(DEFAULT_NODE_LOG_MAX_BYTES)
}

fn node_log_max_files() -> usize {
    parse_env_usize("GSV_NODE_LOG_MAX_FILES").unwrap_or(DEFAULT_NODE_LOG_MAX_FILES)
}

fn rotated_log_path(base: &PathBuf, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{}", base.to_string_lossy(), index))
}

#[derive(Clone)]
struct NodeLogger {
    inner: Arc<Mutex<NodeLoggerInner>>,
    node_id: String,
    workspace: String,
}

struct NodeLoggerInner {
    path: PathBuf,
    file: fs::File,
    current_size: u64,
    max_bytes: u64,
    max_files: usize,
}

impl NodeLoggerInner {
    fn open(
        path: &PathBuf,
        max_bytes: u64,
        max_files: usize,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let current_size = file.metadata().map(|m| m.len()).unwrap_or(0);

        Ok(Self {
            path: path.clone(),
            file,
            current_size,
            max_bytes,
            max_files: max_files.max(1),
        })
    }

    fn rotate_if_needed(&mut self, incoming: usize) -> Result<(), Box<dyn std::error::Error>> {
        let incoming = incoming as u64;
        if self.current_size + incoming <= self.max_bytes {
            return Ok(());
        }

        self.file.flush()?;

        let oldest = rotated_log_path(&self.path, self.max_files);
        if oldest.exists() {
            let _ = fs::remove_file(&oldest);
        }

        if self.max_files > 1 {
            for i in (1..self.max_files).rev() {
                let src = rotated_log_path(&self.path, i);
                if src.exists() {
                    let dst = rotated_log_path(&self.path, i + 1);
                    let _ = fs::rename(&src, &dst);
                }
            }
        }

        if self.path.exists() {
            let _ = fs::rename(&self.path, rotated_log_path(&self.path, 1));
        }

        self.file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)?;
        self.current_size = 0;

        Ok(())
    }

    fn write_line(&mut self, line: &str) -> Result<(), Box<dyn std::error::Error>> {
        let incoming = line.len() + 1;
        self.rotate_if_needed(incoming)?;
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.file.flush()?;
        self.current_size += incoming as u64;
        Ok(())
    }
}

impl NodeLogger {
    fn new(node_id: &str, workspace: &PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let path = node_log_path()?;
        let inner = NodeLoggerInner::open(&path, node_log_max_bytes(), node_log_max_files())?;
        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            node_id: node_id.to_string(),
            workspace: workspace.display().to_string(),
        })
    }

    fn info(&self, event: &str, fields: serde_json::Value) {
        self.log("INFO", event, fields);
    }

    fn warn(&self, event: &str, fields: serde_json::Value) {
        self.log("WARN", event, fields);
    }

    fn error(&self, event: &str, fields: serde_json::Value) {
        self.log("ERROR", event, fields);
    }

    fn log(&self, level: &str, event: &str, fields: serde_json::Value) {
        let mut obj = serde_json::Map::new();
        obj.insert(
            "ts".to_string(),
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
        obj.insert("level".to_string(), json!(level));
        obj.insert("component".to_string(), json!("node"));
        obj.insert("event".to_string(), json!(event));
        obj.insert("nodeId".to_string(), json!(self.node_id));
        obj.insert("workspace".to_string(), json!(self.workspace));

        match fields {
            serde_json::Value::Object(map) => {
                for (k, v) in map {
                    obj.insert(k, v);
                }
            }
            serde_json::Value::Null => {}
            other => {
                obj.insert("data".to_string(), other);
            }
        }

        let line = serde_json::Value::Object(obj).to_string();

        if level == "ERROR" {
            eprintln!("{}", line);
        } else {
            println!("{}", line);
        }

        let mut guard = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => {
                eprintln!("Failed to acquire node log writer lock");
                return;
            }
        };

        if let Err(err) = guard.write_line(&line) {
            eprintln!("Failed to write node log file: {}", err);
        }
    }
}

fn node_logs_file(lines: usize, follow: bool) -> Result<(), Box<dyn std::error::Error>> {
    let log_path = node_log_path()?;
    if !log_path.exists() {
        return Err(format!("Log file not found: {}", log_path.display()).into());
    }

    let mut cmd = std::process::Command::new("tail");
    cmd.arg("-n").arg(lines.to_string());
    if follow {
        cmd.arg("-F");
    }
    cmd.arg(&log_path);

    run_command_passthrough(&mut cmd, "Failed to read node log file")
}

const DEFAULT_NODE_LOG_GET_LINES: usize = 100;
const MAX_NODE_LOG_GET_LINES: usize = 5000;
const MAX_NODE_EXEC_EVENT_OUTBOX: usize = 2048;

fn resolve_logs_get_line_limit(lines: Option<usize>) -> usize {
    lines
        .unwrap_or(DEFAULT_NODE_LOG_GET_LINES)
        .max(1)
        .min(MAX_NODE_LOG_GET_LINES)
}

fn read_recent_node_log_lines(limit: usize) -> Result<(Vec<String>, bool), String> {
    let path = node_log_path().map_err(|e| format!("Failed to resolve log path: {}", e))?;
    let file =
        fs::File::open(&path).map_err(|e| format!("Failed to open '{}': {}", path.display(), e))?;
    let reader = io::BufReader::new(file);

    let mut total_lines = 0usize;
    let mut recent = VecDeque::with_capacity(limit.min(1024));

    for line in reader.lines() {
        let line = line.map_err(|e| format!("Failed to read '{}': {}", path.display(), e))?;
        total_lines += 1;

        if recent.len() == limit {
            recent.pop_front();
        }
        recent.push_back(line);
    }

    let truncated = total_lines > limit;
    Ok((recent.into_iter().collect(), truncated))
}

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
    gateway_token_override: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    if gateway_url_override.is_none() && gateway_token_override.is_none() {
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

fn persist_cloudflare_account_id(account_id: &str) -> Result<bool, Box<dyn std::error::Error>> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    let mut local_cfg = CliConfig::load();
    if local_cfg.cloudflare.account_id.as_deref() == Some(trimmed) {
        return Ok(false);
    }

    local_cfg.cloudflare.account_id = Some(trimmed.to_string());
    local_cfg.save()?;
    Ok(true)
}

fn node_service_is_installed() -> Result<bool, Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        return Ok(systemd_user_unit_path()?.exists());
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(launchd_plist_path()?.exists());
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err("node daemon management is currently supported on macOS and Linux only".into())
    }
}

fn restart_node_service() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        return systemd_restart_service();
    }

    #[cfg(target_os = "macos")]
    {
        return launchd_start_service();
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err("node daemon management is currently supported on macOS and Linux only".into())
    }
}

fn run_node_default_managed(
    cfg: &CliConfig,
    node_id: Option<String>,
    workspace: Option<PathBuf>,
    gateway_url_override: Option<&str>,
    gateway_token_override: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    if node_service_is_installed()? {
        let gateway_overrides_changed =
            persist_gateway_overrides(gateway_url_override, gateway_token_override)?;
        let (node_id, workspace, node_defaults_changed) =
            persist_node_defaults(cfg, node_id, workspace)?;
        if gateway_overrides_changed || node_defaults_changed {
            restart_node_service()?;
        } else {
            run_node_service(NodeAction::Start, cfg, None, None)?;
        }
        if gateway_overrides_changed {
            println!("Saved gateway connection overrides to local config.");
        }
        println!(
            "Using defaults: node.id={}, node.workspace={}",
            node_id,
            workspace.display()
        );
    } else {
        run_node_service(
            NodeAction::Install {
                id: node_id,
                workspace,
            },
            cfg,
            gateway_url_override,
            gateway_token_override,
        )?;
    }

    Ok(())
}

fn run_node_service(
    action: NodeAction,
    cfg: &CliConfig,
    gateway_url_override: Option<&str>,
    gateway_token_override: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        NodeAction::Install { id, workspace } => {
            let gateway_overrides_changed =
                persist_gateway_overrides(gateway_url_override, gateway_token_override)?;
            let (node_id, workspace, node_defaults_changed) =
                persist_node_defaults(cfg, id, workspace)?;

            let exe_path = std::env::current_exe()?;
            let exe_path = exe_path.canonicalize().unwrap_or(exe_path);

            #[cfg(target_os = "linux")]
            install_systemd_user_service(&exe_path)?;

            #[cfg(target_os = "macos")]
            install_launchd_user_service(&exe_path)?;

            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                return Err(
                    "node daemon management is currently supported on macOS and Linux only".into(),
                );
            }

            if gateway_overrides_changed || node_defaults_changed {
                restart_node_service()?;
            }

            println!("Node daemon installed and started.");
            if gateway_overrides_changed {
                println!("Saved gateway connection overrides to local config.");
            }
            println!(
                "Saved defaults: node.id={}, node.workspace={}",
                node_id,
                workspace.display()
            );
            println!("\nCheck status:");
            println!("  gsv node status");
            println!("View logs:");
            println!("  gsv node logs --follow");
        }
        NodeAction::Uninstall => {
            #[cfg(target_os = "linux")]
            uninstall_systemd_user_service()?;

            #[cfg(target_os = "macos")]
            uninstall_launchd_user_service()?;

            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                return Err(
                    "node daemon management is currently supported on macOS and Linux only".into(),
                );
            }

            println!("Node daemon uninstalled.");
        }
        NodeAction::Start => {
            let gateway_overrides_changed =
                persist_gateway_overrides(gateway_url_override, gateway_token_override)?;

            if gateway_overrides_changed {
                restart_node_service()?;
                println!("Saved gateway connection overrides to local config.");
                println!("Node daemon restarted.");
                return Ok(());
            }

            #[cfg(target_os = "linux")]
            systemd_start_service()?;

            #[cfg(target_os = "macos")]
            launchd_start_service()?;

            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                return Err(
                    "node daemon management is currently supported on macOS and Linux only".into(),
                );
            }

            println!("Node daemon started.");
        }
        NodeAction::Stop => {
            #[cfg(target_os = "linux")]
            systemd_stop_service()?;

            #[cfg(target_os = "macos")]
            launchd_stop_service()?;

            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                return Err(
                    "node daemon management is currently supported on macOS and Linux only".into(),
                );
            }

            println!("Node daemon stopped.");
        }
        NodeAction::Status => {
            #[cfg(target_os = "linux")]
            systemd_status_service()?;

            #[cfg(target_os = "macos")]
            launchd_status_service()?;

            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                return Err(
                    "node daemon management is currently supported on macOS and Linux only".into(),
                );
            }
        }
        NodeAction::Logs { lines, follow } => {
            node_logs_file(lines, follow)?;
        }
    }

    Ok(())
}

fn run_command_capture(
    cmd: &mut std::process::Command,
    context: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let output = cmd.output()?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        return Err(format!("{} (exit status: {})", context, output.status).into());
    }

    Err(format!("{}: {}", context, detail).into())
}

fn run_command_passthrough(
    cmd: &mut std::process::Command,
    context: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let status = cmd.status()?;
    if status.success() {
        return Ok(());
    }

    Err(format!("{} (exit status: {})", context, status).into())
}

#[cfg(target_os = "linux")]
fn systemd_user_unit_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let config_dir = dirs::config_dir().ok_or("Could not determine config directory")?;
    Ok(config_dir
        .join("systemd")
        .join("user")
        .join(NODE_SYSTEMD_UNIT_NAME))
}

#[cfg(target_os = "linux")]
fn install_systemd_user_service(exe_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let unit_path = systemd_user_unit_path()?;
    if let Some(parent) = unit_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let exe_path = exe_path.display().to_string().replace('"', "\\\"");
    let unit = format!(
        "[Unit]\nDescription=GSV Node daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=\"{}\" node --foreground\nRestart=always\nRestartSec=3\nKillSignal=SIGTERM\n\n[Install]\nWantedBy=default.target\n",
        exe_path
    );
    std::fs::write(&unit_path, unit)?;

    run_command_capture(
        std::process::Command::new("systemctl")
            .arg("--user")
            .arg("daemon-reload"),
        "Failed to reload systemd user daemon",
    )?;
    run_command_capture(
        std::process::Command::new("systemctl")
            .arg("--user")
            .arg("enable")
            .arg("--now")
            .arg(NODE_SYSTEMD_UNIT_NAME),
        "Failed to enable/start node service",
    )?;

    println!("Installed systemd unit: {}", unit_path.display());
    Ok(())
}

#[cfg(target_os = "linux")]
fn uninstall_systemd_user_service() -> Result<(), Box<dyn std::error::Error>> {
    let _ = run_command_capture(
        std::process::Command::new("systemctl")
            .arg("--user")
            .arg("disable")
            .arg("--now")
            .arg(NODE_SYSTEMD_UNIT_NAME),
        "Failed to disable/stop node service",
    );

    let unit_path = systemd_user_unit_path()?;
    if unit_path.exists() {
        std::fs::remove_file(&unit_path)?;
    }

    run_command_capture(
        std::process::Command::new("systemctl")
            .arg("--user")
            .arg("daemon-reload"),
        "Failed to reload systemd user daemon",
    )?;

    Ok(())
}

#[cfg(target_os = "linux")]
fn systemd_start_service() -> Result<(), Box<dyn std::error::Error>> {
    run_command_capture(
        std::process::Command::new("systemctl")
            .arg("--user")
            .arg("start")
            .arg(NODE_SYSTEMD_UNIT_NAME),
        "Failed to start node service",
    )
}

#[cfg(target_os = "linux")]
fn systemd_restart_service() -> Result<(), Box<dyn std::error::Error>> {
    run_command_capture(
        std::process::Command::new("systemctl")
            .arg("--user")
            .arg("restart")
            .arg(NODE_SYSTEMD_UNIT_NAME),
        "Failed to restart node service",
    )
}

#[cfg(target_os = "linux")]
fn systemd_stop_service() -> Result<(), Box<dyn std::error::Error>> {
    run_command_capture(
        std::process::Command::new("systemctl")
            .arg("--user")
            .arg("stop")
            .arg(NODE_SYSTEMD_UNIT_NAME),
        "Failed to stop node service",
    )
}

#[cfg(target_os = "linux")]
fn systemd_status_service() -> Result<(), Box<dyn std::error::Error>> {
    run_command_passthrough(
        std::process::Command::new("systemctl")
            .arg("--user")
            .arg("status")
            .arg("--no-pager")
            .arg(NODE_SYSTEMD_UNIT_NAME),
        "Failed to read node service status",
    )
}

#[cfg(target_os = "macos")]
fn launchd_plist_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", NODE_LAUNCHD_LABEL)))
}

#[cfg(target_os = "macos")]
fn launchd_log_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    node_log_path()
}

#[cfg(target_os = "macos")]
fn launchd_domain() -> Result<String, Box<dyn std::error::Error>> {
    let output = std::process::Command::new("id").arg("-u").output()?;
    if !output.status.success() {
        return Err("Failed to resolve current user id".into());
    }
    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() {
        return Err("Failed to resolve current user id".into());
    }
    Ok(format!("gui/{}", uid))
}

#[cfg(target_os = "macos")]
fn launchd_target() -> Result<String, Box<dyn std::error::Error>> {
    Ok(format!("{}/{}", launchd_domain()?, NODE_LAUNCHD_LABEL))
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn install_launchd_user_service(exe_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let plist_path = launchd_plist_path()?;
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let log_path = launchd_log_path()?;
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{}</string>\n    <string>node</string>\n    <string>--foreground</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n</dict>\n</plist>\n",
        NODE_LAUNCHD_LABEL,
        xml_escape(&exe_path.display().to_string()),
    );
    std::fs::write(&plist_path, plist)?;

    let domain = launchd_domain()?;
    let _ = std::process::Command::new("launchctl")
        .arg("bootout")
        .arg(&domain)
        .arg(&plist_path)
        .status();

    run_command_capture(
        std::process::Command::new("launchctl")
            .arg("bootstrap")
            .arg(&domain)
            .arg(&plist_path),
        "Failed to bootstrap launchd service",
    )?;
    run_command_capture(
        std::process::Command::new("launchctl")
            .arg("kickstart")
            .arg("-k")
            .arg(launchd_target()?),
        "Failed to start launchd service",
    )?;

    println!("Installed launchd agent: {}", plist_path.display());
    println!("Logs: {}", log_path.display());
    Ok(())
}

#[cfg(target_os = "macos")]
fn uninstall_launchd_user_service() -> Result<(), Box<dyn std::error::Error>> {
    let _ = run_command_capture(
        std::process::Command::new("launchctl")
            .arg("bootout")
            .arg(launchd_target()?),
        "Failed to unload launchd service",
    );

    let plist_path = launchd_plist_path()?;
    if plist_path.exists() {
        std::fs::remove_file(&plist_path)?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn launchd_start_service() -> Result<(), Box<dyn std::error::Error>> {
    if run_command_capture(
        std::process::Command::new("launchctl")
            .arg("kickstart")
            .arg("-k")
            .arg(launchd_target()?),
        "Failed to kickstart launchd service",
    )
    .is_ok()
    {
        return Ok(());
    }

    let plist_path = launchd_plist_path()?;
    if !plist_path.exists() {
        return Err(format!(
            "Service not installed. Run 'gsv node install' first ({})",
            plist_path.display()
        )
        .into());
    }

    run_command_capture(
        std::process::Command::new("launchctl")
            .arg("bootstrap")
            .arg(launchd_domain()?)
            .arg(&plist_path),
        "Failed to bootstrap launchd service",
    )?;
    run_command_capture(
        std::process::Command::new("launchctl")
            .arg("kickstart")
            .arg("-k")
            .arg(launchd_target()?),
        "Failed to start launchd service",
    )?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn launchd_stop_service() -> Result<(), Box<dyn std::error::Error>> {
    run_command_capture(
        std::process::Command::new("launchctl")
            .arg("bootout")
            .arg(launchd_target()?),
        "Failed to stop launchd service",
    )
}

#[cfg(target_os = "macos")]
fn launchd_status_service() -> Result<(), Box<dyn std::error::Error>> {
    run_command_passthrough(
        std::process::Command::new("launchctl")
            .arg("print")
            .arg(launchd_target()?),
        "Failed to read launchd service status",
    )
}

async fn run_client(
    url: &str,
    token: Option<String>,
    message: Option<String>,
    session_key: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("Connecting to {}...", url);

    // Flag to track when we've received a final/error response
    let response_received = Arc::new(AtomicBool::new(false));
    let response_received_clone = response_received.clone();
    let session_key_owned = session_key.to_string();

    let conn = Connection::connect_with_options(
        url,
        "client",
        None,
        None,
        move |frame| {
            // Handle incoming events
            if let Frame::Evt(evt) = frame {
                if evt.event == "chat" {
                    if let Some(payload) = evt.payload {
                        // Filter by sessionKey - ignore events for other sessions
                        if let Some(event_session) =
                            payload.get("sessionKey").and_then(|s| s.as_str())
                        {
                            if event_session != session_key_owned {
                                return;
                            }
                        }

                        if let Some(state) = payload.get("state").and_then(|s| s.as_str()) {
                            match state {
                                "delta" | "partial" => {
                                    if let Some(text) = payload.get("text").and_then(|t| t.as_str())
                                    {
                                        print!("{}", text);
                                        let _ = io::stdout().flush();
                                    }
                                }
                                "final" => {
                                    if let Some(msg) = payload.get("message") {
                                        if let Some(content) = msg.get("content") {
                                            println!("\nAssistant: {}", format_content(content));
                                        }
                                    }
                                    response_received_clone.store(true, Ordering::SeqCst);
                                }
                                "error" => {
                                    if let Some(err) = payload.get("error").and_then(|e| e.as_str())
                                    {
                                        eprintln!("\nError: {}", err);
                                    }
                                    response_received_clone.store(true, Ordering::SeqCst);
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        },
        None,
        token,
    )
    .await?;

    if let Some(msg) = message {
        // One-shot mode: send message and wait for response
        let was_command = send_chat(&conn, session_key, &msg).await?;

        // Only wait for chat event if this wasn't a command/directive
        if !was_command {
            // Wait for response (up to 120 seconds for LLM + tool execution)
            let timeout = tokio::time::Duration::from_secs(120);
            let start = tokio::time::Instant::now();

            while !response_received.load(Ordering::SeqCst) {
                if start.elapsed() > timeout {
                    eprintln!("Timeout waiting for response");
                    break;
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }
    } else {
        // Interactive mode
        println!("Connected! Type your message and press Enter. Type 'quit' to exit.\n");

        let stdin = io::stdin();
        print!("> ");
        let _ = io::stdout().flush();

        for line in stdin.lock().lines() {
            let line = line?;
            let line = line.trim();

            if line == "quit" || line == "exit" {
                break;
            }

            if line.is_empty() {
                print!("> ");
                let _ = io::stdout().flush();
                continue;
            }

            // Reset response flag
            response_received.store(false, Ordering::SeqCst);

            let was_command = send_chat(&conn, session_key, line).await?;

            // Only wait for chat event if this wasn't a command/directive
            if !was_command {
                // Wait for response (up to 120 seconds)
                let timeout = tokio::time::Duration::from_secs(120);
                let start = tokio::time::Instant::now();

                while !response_received.load(Ordering::SeqCst) {
                    if start.elapsed() > timeout {
                        eprintln!("Timeout waiting for response");
                        break;
                    }
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }

            print!("\n> ");
            let _ = io::stdout().flush();
        }
    }

    Ok(())
}

async fn run_heartbeat(
    url: &str,
    token: Option<String>,
    action: HeartbeatAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    match action {
        HeartbeatAction::Status => {
            let res = conn.request("heartbeat.status", None).await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(agents) = payload.get("agents").and_then(|a| a.as_object()) {
                        if agents.is_empty() {
                            println!("No heartbeat state (scheduler not started)");
                            println!("\nTo start the heartbeat scheduler, run:");
                            println!("  gsv heartbeat start");
                        } else {
                            println!("Heartbeat status:");
                            for (agent_id, state) in agents {
                                println!("\n  Agent: {}", agent_id);

                                if let Some(next) =
                                    state.get("nextHeartbeatAt").and_then(|n| n.as_i64())
                                {
                                    let dt = chrono::DateTime::from_timestamp_millis(next);
                                    if let Some(dt) = dt {
                                        println!("    Next: {}", dt.format("%Y-%m-%d %H:%M:%S"));
                                    }
                                }

                                if let Some(last) =
                                    state.get("lastHeartbeatAt").and_then(|n| n.as_i64())
                                {
                                    let dt = chrono::DateTime::from_timestamp_millis(last);
                                    if let Some(dt) = dt {
                                        println!("    Last: {}", dt.format("%Y-%m-%d %H:%M:%S"));
                                    }
                                }

                                // Show last active channel context
                                if let Some(last_active) = state.get("lastActive") {
                                    if let Some(channel) =
                                        last_active.get("channel").and_then(|c| c.as_str())
                                    {
                                        let peer_name = last_active
                                            .get("peer")
                                            .and_then(|p| p.get("name"))
                                            .and_then(|n| n.as_str())
                                            .unwrap_or("unknown");
                                        let peer_id = last_active
                                            .get("peer")
                                            .and_then(|p| p.get("id"))
                                            .and_then(|i| i.as_str())
                                            .unwrap_or("unknown");

                                        println!(
                                            "    Delivery: {} -> {} ({})",
                                            channel, peer_name, peer_id
                                        );

                                        if let Some(ts) =
                                            last_active.get("timestamp").and_then(|t| t.as_i64())
                                        {
                                            let dt = chrono::DateTime::from_timestamp_millis(ts);
                                            if let Some(dt) = dt {
                                                println!(
                                                    "    Last msg: {}",
                                                    dt.format("%Y-%m-%d %H:%M:%S")
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        HeartbeatAction::Start => {
            let res = conn.request("heartbeat.start", None).await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(msg) = payload.get("message").and_then(|m| m.as_str()) {
                        println!("{}", msg);
                    }

                    if let Some(agents) = payload.get("agents").and_then(|a| a.as_object()) {
                        for (agent_id, state) in agents {
                            if let Some(next) =
                                state.get("nextHeartbeatAt").and_then(|n| n.as_i64())
                            {
                                let dt = chrono::DateTime::from_timestamp_millis(next);
                                if let Some(dt) = dt {
                                    println!("  {}: next at {}", agent_id, dt.format("%H:%M:%S"));
                                }
                            }
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        HeartbeatAction::Trigger { agent_id } => {
            let res = conn
                .request("heartbeat.trigger", Some(json!({ "agentId": agent_id })))
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(msg) = payload.get("message").and_then(|m| m.as_str()) {
                        println!("{}", msg);
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }
    }

    Ok(())
}

async fn run_pair(
    url: &str,
    token: Option<String>,
    action: PairAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    match action {
        PairAction::List => {
            let res = conn.request("pair.list", None).await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(pairs) = payload.get("pairs").and_then(|p| p.as_object()) {
                        if pairs.is_empty() {
                            println!("No pending pairing requests");
                        } else {
                            println!("Pending pairing requests ({}):\n", pairs.len());
                            for (key, pair) in pairs {
                                let sender_id = pair
                                    .get("senderId")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("unknown");
                                let sender_name = pair
                                    .get("senderName")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("unknown");
                                let channel = pair
                                    .get("channel")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("unknown");
                                let first_msg = pair
                                    .get("firstMessage")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("");

                                if let Some(requested_at) =
                                    pair.get("requestedAt").and_then(|t| t.as_i64())
                                {
                                    let dt = chrono::DateTime::from_timestamp_millis(requested_at);
                                    if let Some(dt) = dt {
                                        println!(
                                            "  {} ({}) via {}",
                                            sender_name, sender_id, channel
                                        );
                                        println!(
                                            "    Requested: {}",
                                            dt.format("%Y-%m-%d %H:%M:%S")
                                        );
                                        if !first_msg.is_empty() {
                                            println!("    Message: \"{}\"", first_msg);
                                        }
                                        println!();
                                    }
                                } else {
                                    println!("  {}: {} ({})", key, sender_name, sender_id);
                                }
                            }
                            println!("To approve: gsv pair approve <channel> <sender_id>");
                            println!("To reject:  gsv pair reject <channel> <sender_id>");
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        PairAction::Approve { channel, sender_id } => {
            let res = conn
                .request(
                    "pair.approve",
                    Some(json!({ "channel": channel, "senderId": sender_id })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let approved_id = payload
                        .get("senderId")
                        .and_then(|s| s.as_str())
                        .unwrap_or(&sender_id);
                    let sender_name = payload.get("senderName").and_then(|s| s.as_str());

                    if let Some(name) = sender_name {
                        println!(
                            "Approved {} ({}) - they can now message the bot",
                            name, approved_id
                        );
                    } else {
                        println!("Approved {} - they can now message the bot", approved_id);
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        PairAction::Reject { channel, sender_id } => {
            let res = conn
                .request(
                    "pair.reject",
                    Some(json!({ "channel": channel, "senderId": sender_id })),
                )
                .await?;

            if res.ok {
                println!("Rejected {} - their request has been removed", sender_id);
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }
    }

    Ok(())
}

async fn run_channel(
    action: ChannelAction,
    url: &str,
    token: Option<String>,
    _cfg: &CliConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        ChannelAction::Whatsapp { action } => run_whatsapp_via_gateway(url, token, action).await,
        ChannelAction::Discord { action } => run_discord_via_gateway(url, token, action).await,
        ChannelAction::List => run_channels_list(url, token).await,
    }
}

async fn run_channels_list(
    url: &str,
    token: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    let res = conn.request("channels.list", None).await?;

    if res.ok {
        if let Some(payload) = res.payload {
            if let Some(channels) = payload.get("channels").and_then(|c| c.as_array()) {
                if channels.is_empty() {
                    println!("No channel accounts connected");
                } else {
                    println!("Connected channel accounts ({}):\n", channels.len());
                    for ch in channels {
                        let channel = ch.get("channel").and_then(|c| c.as_str()).unwrap_or("?");
                        let account_id =
                            ch.get("accountId").and_then(|a| a.as_str()).unwrap_or("?");
                        let connected_at = ch.get("connectedAt").and_then(|t| t.as_i64());
                        let last_msg = ch.get("lastMessageAt").and_then(|t| t.as_i64());

                        print!("  {}:{}", channel, account_id);

                        if let Some(ts) = connected_at {
                            if let Some(dt) = chrono::DateTime::from_timestamp_millis(ts) {
                                print!(" (connected {})", dt.format("%Y-%m-%d %H:%M"));
                            }
                        }

                        if let Some(ts) = last_msg {
                            if let Some(dt) = chrono::DateTime::from_timestamp_millis(ts) {
                                print!(", last msg {}", dt.format("%H:%M:%S"));
                            }
                        }
                        println!();
                    }
                }
            }
        }
    } else if let Some(err) = res.error {
        eprintln!("Error: {}", err.message);
    }

    Ok(())
}

async fn run_whatsapp_via_gateway(
    url: &str,
    token: Option<String>,
    action: WhatsAppAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    match action {
        WhatsAppAction::Login { account_id } => {
            println!("Logging in to WhatsApp account: {}", account_id);

            let res = conn
                .request(
                    "channel.login",
                    Some(json!({
                        "channel": "whatsapp",
                        "accountId": account_id,
                    })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(qr_data_url) = payload.get("qrDataUrl").and_then(|q| q.as_str()) {
                        // qrDataUrl is a data URL, extract the QR data
                        println!("\nScan this QR code with WhatsApp:\n");

                        // The qrDataUrl from WhatsApp channel is actually the raw QR string
                        // Try to render it
                        render_qr_terminal(qr_data_url)?;
                        println!("\nQR code expires in ~20 seconds. Re-run command if needed.");
                    } else if let Some(msg) = payload.get("message").and_then(|m| m.as_str()) {
                        println!("{}", msg);
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        WhatsAppAction::Status { account_id } => {
            let res = conn
                .request(
                    "channel.status",
                    Some(json!({
                        "channel": "whatsapp",
                        "accountId": account_id,
                    })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(accounts) = payload.get("accounts").and_then(|a| a.as_array()) {
                        if accounts.is_empty() {
                            println!("WhatsApp account '{}': not found", account_id);
                        } else {
                            for acc in accounts {
                                let acc_id = acc
                                    .get("accountId")
                                    .and_then(|a| a.as_str())
                                    .unwrap_or(&account_id);
                                let connected = acc
                                    .get("connected")
                                    .and_then(|c| c.as_bool())
                                    .unwrap_or(false);
                                let authenticated = acc
                                    .get("authenticated")
                                    .and_then(|a| a.as_bool())
                                    .unwrap_or(false);

                                println!("WhatsApp account: {}", acc_id);
                                println!("  Connected: {}", connected);
                                println!("  Authenticated: {}", authenticated);

                                if let Some(error) = acc.get("error").and_then(|e| e.as_str()) {
                                    println!("  Error: {}", error);
                                }

                                if let Some(extra) = acc.get("extra") {
                                    if let Some(jid) = extra.get("selfJid").and_then(|j| j.as_str())
                                    {
                                        println!("  JID: {}", jid);
                                    }
                                    if let Some(e164) =
                                        extra.get("selfE164").and_then(|e| e.as_str())
                                    {
                                        println!("  Phone: {}", e164);
                                    }
                                }

                                if let Some(last) = acc.get("lastActivity").and_then(|t| t.as_i64())
                                {
                                    if let Some(dt) = chrono::DateTime::from_timestamp_millis(last)
                                    {
                                        println!(
                                            "  Last activity: {}",
                                            dt.format("%Y-%m-%d %H:%M:%S")
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        WhatsAppAction::Logout { account_id } => {
            println!("Logging out WhatsApp account: {}", account_id);

            let res = conn
                .request(
                    "channel.logout",
                    Some(json!({
                        "channel": "whatsapp",
                        "accountId": account_id,
                    })),
                )
                .await?;

            if res.ok {
                println!("Logged out successfully. Credentials cleared.");
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        WhatsAppAction::Stop { account_id } => {
            println!("Stopping WhatsApp account: {}", account_id);

            let res = conn
                .request(
                    "channel.stop",
                    Some(json!({
                        "channel": "whatsapp",
                        "accountId": account_id,
                    })),
                )
                .await?;

            if res.ok {
                println!("Stopped.");
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }
    }

    Ok(())
}

async fn run_discord_via_gateway(
    url: &str,
    token: Option<String>,
    action: DiscordAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    match action {
        DiscordAction::Start { account_id } => {
            println!("Starting Discord bot account: {}", account_id);

            let res = conn
                .request(
                    "channel.start",
                    Some(json!({
                        "channel": "discord",
                        "accountId": account_id,
                    })),
                )
                .await?;

            if res.ok {
                println!("Discord bot started successfully.");
                println!("\nThe bot will connect using the DISCORD_BOT_TOKEN configured on the channel worker.");
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        DiscordAction::Status { account_id } => {
            let res = conn
                .request(
                    "channel.status",
                    Some(json!({
                        "channel": "discord",
                        "accountId": account_id,
                    })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(accounts) = payload.get("accounts").and_then(|a| a.as_array()) {
                        if accounts.is_empty() {
                            println!("Discord account '{}': not found", account_id);
                        } else {
                            for acc in accounts {
                                let acc_id = acc
                                    .get("accountId")
                                    .and_then(|a| a.as_str())
                                    .unwrap_or(&account_id);
                                let connected = acc
                                    .get("connected")
                                    .and_then(|c| c.as_bool())
                                    .unwrap_or(false);
                                let authenticated = acc
                                    .get("authenticated")
                                    .and_then(|a| a.as_bool())
                                    .unwrap_or(false);

                                println!("Discord account: {}", acc_id);
                                println!("  Connected: {}", connected);
                                println!("  Authenticated: {}", authenticated);

                                if let Some(error) = acc.get("error").and_then(|e| e.as_str()) {
                                    println!("  Error: {}", error);
                                }

                                if let Some(extra) = acc.get("extra") {
                                    if let Some(bot_user) = extra.get("botUser") {
                                        if let Some(username) =
                                            bot_user.get("username").and_then(|u| u.as_str())
                                        {
                                            println!("  Bot username: {}", username);
                                        }
                                        if let Some(id) =
                                            bot_user.get("id").and_then(|i| i.as_str())
                                        {
                                            println!("  Bot ID: {}", id);
                                        }
                                    }
                                }

                                if let Some(last) = acc.get("lastActivity").and_then(|t| t.as_i64())
                                {
                                    if let Some(dt) = chrono::DateTime::from_timestamp_millis(last)
                                    {
                                        println!(
                                            "  Last activity: {}",
                                            dt.format("%Y-%m-%d %H:%M:%S")
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        DiscordAction::Stop { account_id } => {
            println!("Stopping Discord bot account: {}", account_id);

            let res = conn
                .request(
                    "channel.stop",
                    Some(json!({
                        "channel": "discord",
                        "accountId": account_id,
                    })),
                )
                .await?;

            if res.ok {
                println!("Stopped.");
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }
    }

    Ok(())
}

fn render_qr_terminal(data: &str) -> Result<(), Box<dyn std::error::Error>> {
    use qrcode::render::unicode;
    use qrcode::QrCode;

    let code = QrCode::new(data.as_bytes())?;
    let image = code
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Light)
        .light_color(unicode::Dense1x2::Dark)
        .build();

    println!("{}", image);
    Ok(())
}

/// Returns true if the response was a command/directive (no need to wait for chat event)
async fn send_chat(
    conn: &Connection,
    session_key: &str,
    message: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let run_id = uuid::Uuid::new_v4().to_string();

    let res = conn
        .request(
            "chat.send",
            Some(json!({
                "sessionKey": session_key,
                "message": message,
                "runId": run_id
            })),
        )
        .await?;

    if !res.ok {
        if let Some(err) = res.error {
            eprintln!("Error: {}", err.message);
        }
        return Ok(true); // Don't wait for event on error
    }

    // Check if this was a command or directive-only response
    if let Some(payload) = &res.payload {
        if let Some(status) = payload.get("status").and_then(|s| s.as_str()) {
            match status {
                "command" => {
                    // Command was handled - print response
                    if let Some(response) = payload.get("response").and_then(|r| r.as_str()) {
                        println!("{}", response);
                    }
                    if let Some(error) = payload.get("error").and_then(|e| e.as_str()) {
                        eprintln!("Error: {}", error);
                    }
                    return Ok(true); // Don't wait for chat event
                }
                "directive-only" => {
                    // Directive acknowledged
                    if let Some(response) = payload.get("response").and_then(|r| r.as_str()) {
                        println!("{}", response);
                    }
                    return Ok(true); // Don't wait for chat event
                }
                _ => {}
            }
        }
    }

    Ok(false) // Wait for chat event
}

fn format_content(content: &serde_json::Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }

    if let Some(arr) = content.as_array() {
        let mut result = String::new();
        for block in arr {
            if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
                match block_type {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            result.push_str(text);
                        }
                    }
                    "toolCall" => {
                        if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                            result.push_str(&format!("[Tool: {}]", name));
                        }
                    }
                    _ => {}
                }
            }
        }
        return result;
    }

    content.to_string()
}

async fn run_config(
    url: &str,
    token: Option<String>,
    action: ConfigAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    match action {
        ConfigAction::Get { path } => {
            let res = conn
                .request("config.get", Some(json!({ "path": path })))
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    println!("{}", serde_json::to_string_pretty(&payload)?);
                }
            } else {
                if let Some(err) = res.error {
                    eprintln!("Error: {}", err.message);
                }
            }
        }
        ConfigAction::Set { path, value } => {
            // Try to parse value as JSON, fall back to string
            let parsed_value: serde_json::Value = serde_json::from_str(&value)
                .unwrap_or_else(|_| serde_json::Value::String(value.clone()));

            let res = conn
                .request(
                    "config.set",
                    Some(json!({
                        "path": path,
                        "value": parsed_value
                    })),
                )
                .await?;

            if res.ok {
                println!("Set {} successfully", path);
            } else {
                if let Some(err) = res.error {
                    eprintln!("Error: {}", err.message);
                }
            }
        }
    }

    Ok(())
}

async fn run_tools(
    url: &str,
    token: Option<String>,
    action: ToolsAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    match action {
        ToolsAction::List => {
            let res = conn.request("tools.list", None).await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(tools) = payload.get("tools").and_then(|t| t.as_array()) {
                        if tools.is_empty() {
                            println!("No tools available (is a node connected?)");
                        } else {
                            println!("Available tools ({}):", tools.len());
                            for tool in tools {
                                let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                                let desc = tool
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("");
                                println!("  {} - {}", name, desc);
                            }
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        ToolsAction::Call { tool, args } => {
            // Parse args as JSON
            let args: serde_json::Value = serde_json::from_str(&args).map_err(|e| {
                format!(
                    "Invalid JSON args: {}. Expected format: '{{\"key\": \"value\"}}'",
                    e
                )
            })?;

            println!("Calling tool: {}", tool);
            println!("Args: {}", serde_json::to_string_pretty(&args)?);
            println!();

            let res = conn
                .request(
                    "tool.invoke",
                    Some(json!({
                        "tool": tool,
                        "args": args,
                    })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    if let Some(result) = payload.get("result") {
                        println!("Result:");
                        // Try to print as pretty JSON, fall back to raw
                        if let Some(s) = result.as_str() {
                            println!("{}", s);
                        } else {
                            println!("{}", serde_json::to_string_pretty(result)?);
                        }
                    } else {
                        println!("Result: {}", serde_json::to_string_pretty(&payload)?);
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }
    }

    Ok(())
}

async fn run_skills(
    url: &str,
    token: Option<String>,
    action: SkillsAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    let (method, params) = match action {
        SkillsAction::Status { agent_id } => ("skills.status", json!({ "agentId": agent_id })),
        SkillsAction::Update {
            agent_id,
            force,
            timeout_ms,
        } => (
            "skills.update",
            json!({
                "agentId": agent_id,
                "force": force,
                "timeoutMs": timeout_ms,
            }),
        ),
    };

    let res = conn.request(method, Some(params)).await?;
    if !res.ok {
        if let Some(err) = res.error {
            return Err(format!("Error: {}", err.message).into());
        }
        return Err("Unknown skills RPC error".into());
    }

    let payload = res.payload.unwrap_or_else(|| json!({}));
    let agent_id = payload
        .get("agentId")
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    println!("Agent: {}", agent_id);

    let required_bins = payload
        .get("requiredBins")
        .and_then(|v| v.as_array())
        .map(|bins| {
            bins.iter()
                .filter_map(|entry| entry.as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    println!(
        "Required bins: {}",
        if required_bins.is_empty() {
            "none".to_string()
        } else {
            required_bins.join(", ")
        }
    );

    if method == "skills.update" {
        let updated_nodes = payload
            .get("updatedNodeCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        println!("Updated nodes: {}", updated_nodes);
        if let Some(errors) = payload.get("errors").and_then(|v| v.as_array()) {
            if !errors.is_empty() {
                println!("Probe errors:");
                for error in errors {
                    if let Some(msg) = error.as_str() {
                        println!("  - {}", msg);
                    }
                }
            }
        }
    }

    if let Some(nodes) = payload.get("nodes").and_then(|v| v.as_array()) {
        println!("\nNodes:");
        if nodes.is_empty() {
            println!("  (none connected)");
        } else {
            for node in nodes {
                let node_id = node.get("nodeId").and_then(|v| v.as_str()).unwrap_or("?");
                let role = node.get("hostRole").and_then(|v| v.as_str()).unwrap_or("?");
                let os = node
                    .get("hostOs")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let bins = node
                    .get("hostBins")
                    .and_then(|v| v.as_array())
                    .map(|entries| entries.len())
                    .unwrap_or(0);
                let can_probe = node
                    .get("canProbeBins")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                println!(
                    "  - {} ({}) os={} bins={} probe={}",
                    node_id,
                    role,
                    os,
                    bins,
                    if can_probe { "yes" } else { "no" }
                );
            }
        }
    }

    if let Some(skills) = payload.get("skills").and_then(|v| v.as_array()) {
        println!("\nSkills:");
        if skills.is_empty() {
            println!("  (none)");
        } else {
            for skill in skills {
                let name = skill.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                let eligible = skill
                    .get("eligible")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let reasons = skill
                    .get("reasons")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|entry| entry.as_str())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();

                if eligible {
                    println!("  - {}: eligible", name);
                } else if reasons.is_empty() {
                    println!("  - {}: ineligible", name);
                } else {
                    println!("  - {}: ineligible ({})", name, reasons.join("; "));
                }
            }
        }
    }

    Ok(())
}

async fn run_session(
    url: &str,
    token: Option<String>,
    action: SessionAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn =
        Connection::connect_with_options(url, "client", None, None, |_| {}, None, token).await?;

    match action {
        SessionAction::List { limit } => {
            let res = conn
                .request("sessions.list", Some(json!({ "limit": limit })))
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let sessions = payload.get("sessions").and_then(|s| s.as_array());
                    let count = payload.get("count").and_then(|c| c.as_i64()).unwrap_or(0);

                    if let Some(sessions) = sessions {
                        if sessions.is_empty() {
                            println!("No sessions found");
                        } else {
                            println!("Sessions ({}):", count);
                            for session in sessions {
                                let key = session
                                    .get("sessionKey")
                                    .and_then(|k| k.as_str())
                                    .unwrap_or("?");
                                let label = session.get("label").and_then(|l| l.as_str());
                                let last_active =
                                    session.get("lastActiveAt").and_then(|t| t.as_i64());

                                let last_active_str = last_active
                                    .and_then(|ts| chrono::DateTime::from_timestamp_millis(ts))
                                    .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                                    .unwrap_or_else(|| "?".to_string());

                                if let Some(label) = label {
                                    println!(
                                        "  {} ({}) - last active: {}",
                                        key, label, last_active_str
                                    );
                                } else {
                                    println!("  {} - last active: {}", key, last_active_str);
                                }
                            }
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        SessionAction::Reset { session_key } => {
            let session_key = config::normalize_session_key(&session_key);
            let res = conn
                .request("session.reset", Some(json!({ "sessionKey": session_key })))
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let old_id = payload
                        .get("oldSessionId")
                        .and_then(|s| s.as_str())
                        .unwrap_or("?");
                    let new_id = payload
                        .get("newSessionId")
                        .and_then(|s| s.as_str())
                        .unwrap_or("?");
                    let archived = payload
                        .get("archivedMessages")
                        .and_then(|c| c.as_i64())
                        .unwrap_or(0);
                    let empty_obj = json!({});
                    let tokens = payload.get("tokensCleared").unwrap_or(&empty_obj);
                    let total_tokens = tokens.get("total").and_then(|t| t.as_i64()).unwrap_or(0);

                    println!("Reset session '{}'", session_key);
                    println!("  Old session ID: {}", &old_id[..8.min(old_id.len())]);
                    println!("  New session ID: {}", &new_id[..8.min(new_id.len())]);
                    println!("  Archived {} messages ({} tokens)", archived, total_tokens);
                    if let Some(path) = payload.get("archivedTo").and_then(|p| p.as_str()) {
                        println!("  Archived to: {}", path);
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        SessionAction::Get { session_key } => {
            let session_key = config::normalize_session_key(&session_key);
            let res = conn
                .request("session.get", Some(json!({ "sessionKey": session_key })))
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    println!("Session: {}", session_key);
                    println!(
                        "  Session ID: {}",
                        payload
                            .get("sessionId")
                            .and_then(|s| s.as_str())
                            .unwrap_or("?")
                    );
                    println!(
                        "  Messages: {}",
                        payload
                            .get("messageCount")
                            .and_then(|c| c.as_i64())
                            .unwrap_or(0)
                    );

                    if let Some(tokens) = payload.get("tokens") {
                        let input = tokens.get("input").and_then(|t| t.as_i64()).unwrap_or(0);
                        let output = tokens.get("output").and_then(|t| t.as_i64()).unwrap_or(0);
                        let total = tokens.get("total").and_then(|t| t.as_i64()).unwrap_or(0);
                        println!("  Tokens: {} in / {} out ({} total)", input, output, total);
                    }

                    if let Some(settings) = payload.get("settings") {
                        if !settings.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                            println!("  Settings: {}", serde_json::to_string(settings)?);
                        }
                    }

                    if let Some(policy) = payload.get("resetPolicy") {
                        let mode = policy
                            .get("mode")
                            .and_then(|m| m.as_str())
                            .unwrap_or("manual");
                        print!("  Reset policy: {}", mode);
                        if mode == "daily" {
                            if let Some(hour) = policy.get("atHour").and_then(|h| h.as_i64()) {
                                print!(" (at {}:00)", hour);
                            }
                        } else if mode == "idle" {
                            if let Some(mins) = policy.get("idleMinutes").and_then(|m| m.as_i64()) {
                                print!(" (after {} min)", mins);
                            }
                        }
                        println!();
                    }

                    if let Some(label) = payload.get("label").and_then(|l| l.as_str()) {
                        println!("  Label: {}", label);
                    }

                    let prev_ids = payload.get("previousSessionIds").and_then(|p| p.as_array());
                    if let Some(ids) = prev_ids {
                        if !ids.is_empty() {
                            println!("  Previous sessions: {}", ids.len());
                        }
                    }

                    if let Some(created) = payload.get("createdAt").and_then(|c| c.as_i64()) {
                        let dt = chrono::DateTime::from_timestamp_millis(created);
                        if let Some(dt) = dt {
                            println!("  Created: {}", dt.format("%Y-%m-%d %H:%M:%S"));
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        SessionAction::Stats { session_key } => {
            let session_key = config::normalize_session_key(&session_key);
            let res = conn
                .request("session.stats", Some(json!({ "sessionKey": session_key })))
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    println!("Session stats: {}", session_key);
                    println!(
                        "  Messages: {}",
                        payload
                            .get("messageCount")
                            .and_then(|c| c.as_i64())
                            .unwrap_or(0)
                    );

                    if let Some(tokens) = payload.get("tokens") {
                        let input = tokens.get("input").and_then(|t| t.as_i64()).unwrap_or(0);
                        let output = tokens.get("output").and_then(|t| t.as_i64()).unwrap_or(0);
                        let total = tokens.get("total").and_then(|t| t.as_i64()).unwrap_or(0);
                        println!("  Input tokens: {}", input);
                        println!("  Output tokens: {}", output);
                        println!("  Total tokens: {}", total);
                    }

                    if let Some(uptime) = payload.get("uptime").and_then(|u| u.as_i64()) {
                        let hours = uptime / 3600000;
                        let minutes = (uptime % 3600000) / 60000;
                        println!("  Uptime: {}h {}m", hours, minutes);
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        SessionAction::Set {
            session_key,
            path,
            value,
        } => {
            let session_key = config::normalize_session_key(&session_key);
            // Build the patch params based on the path
            let parsed_value: serde_json::Value = serde_json::from_str(&value)
                .unwrap_or_else(|_| serde_json::Value::String(value.clone()));

            let params = match path.as_str() {
                "label" => json!({
                    "sessionKey": session_key,
                    "label": parsed_value
                }),
                p if p.starts_with("settings.")
                    || p.starts_with("model.")
                    || p == "thinkingLevel"
                    || p == "systemPrompt"
                    || p == "maxTokens" =>
                {
                    // Handle settings paths
                    let settings_path = if p.starts_with("settings.") {
                        &p[9..] // Remove "settings." prefix
                    } else {
                        p
                    };

                    // Build nested settings object
                    let mut settings = json!({});
                    let parts: Vec<&str> = settings_path.split('.').collect();
                    if parts.len() == 1 {
                        settings[parts[0]] = parsed_value;
                    } else if parts.len() == 2 {
                        settings[parts[0]] = json!({ parts[1]: parsed_value });
                    }

                    json!({
                        "sessionKey": session_key,
                        "settings": settings
                    })
                }
                p if p.starts_with("resetPolicy.") || p == "resetPolicy" => {
                    let policy_path = if p.starts_with("resetPolicy.") {
                        &p[12..] // Remove "resetPolicy." prefix
                    } else {
                        "mode"
                    };

                    let mut policy = json!({});
                    policy[policy_path] = parsed_value;

                    json!({
                        "sessionKey": session_key,
                        "resetPolicy": policy
                    })
                }
                _ => {
                    eprintln!("Unknown setting path: {}", path);
                    eprintln!("Valid paths: label, model.provider, model.id, thinkingLevel, systemPrompt, maxTokens, resetPolicy.mode, resetPolicy.atHour, resetPolicy.idleMinutes");
                    return Ok(());
                }
            };

            let res = conn.request("session.patch", Some(params)).await?;

            if res.ok {
                println!("Updated {} = {} for session '{}'", path, value, session_key);
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        SessionAction::Compact { session_key, keep } => {
            let session_key = config::normalize_session_key(&session_key);
            let res = conn
                .request(
                    "session.compact",
                    Some(json!({
                        "sessionKey": session_key,
                        "keepMessages": keep
                    })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let trimmed = payload
                        .get("trimmedMessages")
                        .and_then(|c| c.as_i64())
                        .unwrap_or(0);
                    let kept = payload
                        .get("keptMessages")
                        .and_then(|c| c.as_i64())
                        .unwrap_or(0);

                    if trimmed > 0 {
                        println!("Compacted session '{}'", session_key);
                        println!("  Trimmed {} messages, kept {}", trimmed, kept);
                        if let Some(path) = payload.get("archivedTo").and_then(|p| p.as_str()) {
                            println!("  Archived to: {}", path);
                        }
                    } else {
                        println!(
                            "Session '{}' has {} messages (no compaction needed)",
                            session_key, kept
                        );
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        SessionAction::History { session_key } => {
            let session_key = config::normalize_session_key(&session_key);
            let res = conn
                .request(
                    "session.history",
                    Some(json!({ "sessionKey": session_key })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let current = payload
                        .get("currentSessionId")
                        .and_then(|s| s.as_str())
                        .unwrap_or("?");
                    let previous = payload.get("previousSessionIds").and_then(|p| p.as_array());

                    println!("Session history: {}", session_key);
                    println!("  Current session: {}", &current[..8.min(current.len())]);

                    if let Some(ids) = previous {
                        if ids.is_empty() {
                            println!("  No previous sessions");
                        } else {
                            println!("  Previous sessions ({}):", ids.len());
                            for id in ids.iter().rev().take(10) {
                                if let Some(s) = id.as_str() {
                                    println!("    - {}", &s[..8.min(s.len())]);
                                }
                            }
                            if ids.len() > 10 {
                                println!("    ... and {} more", ids.len() - 10);
                            }
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }

        SessionAction::Preview { session_key, limit } => {
            let session_key = config::normalize_session_key(&session_key);
            let mut params = json!({ "sessionKey": session_key });
            if let Some(l) = limit {
                params["limit"] = json!(l);
            }

            let res = conn.request("session.preview", Some(params)).await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let msg_count = payload
                        .get("messageCount")
                        .and_then(|c| c.as_i64())
                        .unwrap_or(0);
                    let messages = payload.get("messages").and_then(|m| m.as_array());

                    println!("Session: {} ({} messages total)\n", session_key, msg_count);

                    if let Some(msgs) = messages {
                        for msg in msgs {
                            let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("?");

                            match role {
                                "user" => {
                                    let content =
                                        msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
                                    println!("USER: {}\n", content);
                                }
                                "assistant" => {
                                    print!("ASSISTANT: ");
                                    if let Some(content) = msg.get("content") {
                                        if let Some(text) = content.as_str() {
                                            println!("{}\n", text);
                                        } else if let Some(blocks) = content.as_array() {
                                            for block in blocks {
                                                if let Some(block_type) =
                                                    block.get("type").and_then(|t| t.as_str())
                                                {
                                                    match block_type {
                                                        "text" => {
                                                            if let Some(text) = block
                                                                .get("text")
                                                                .and_then(|t| t.as_str())
                                                            {
                                                                print!("{}", text);
                                                            }
                                                        }
                                                        "toolCall" => {
                                                            let name = block
                                                                .get("name")
                                                                .and_then(|n| n.as_str())
                                                                .unwrap_or("?");
                                                            println!("\n[Tool call: {}]", name);
                                                        }
                                                        _ => {}
                                                    }
                                                }
                                            }
                                            println!("\n");
                                        }
                                    }
                                }
                                "toolResult" => {
                                    let tool_name =
                                        msg.get("toolName").and_then(|n| n.as_str()).unwrap_or("?");
                                    let is_error = msg
                                        .get("isError")
                                        .and_then(|e| e.as_bool())
                                        .unwrap_or(false);
                                    let prefix = if is_error { "ERROR" } else { "RESULT" };

                                    print!("TOOL {} ({}): ", prefix, tool_name);
                                    if let Some(content) =
                                        msg.get("content").and_then(|c| c.as_array())
                                    {
                                        for block in content {
                                            if let Some(text) =
                                                block.get("text").and_then(|t| t.as_str())
                                            {
                                                // Truncate long results
                                                if text.len() > 200 {
                                                    println!("{}...", &text[..200]);
                                                } else {
                                                    println!("{}", text);
                                                }
                                            }
                                        }
                                    }
                                    println!();
                                }
                                _ => {
                                    println!("{}: {:?}\n", role.to_uppercase(), msg);
                                }
                            }
                        }
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }
    }

    Ok(())
}

fn capabilities_for_tool(tool_name: &str) -> Result<Vec<&'static str>, String> {
    match tool_name {
        "Read" => Ok(vec!["filesystem.read"]),
        "Write" => Ok(vec!["filesystem.write"]),
        "Edit" => Ok(vec![
            "filesystem.edit",
            "filesystem.read",
            "filesystem.write",
        ]),
        "Glob" => Ok(vec!["filesystem.list"]),
        "Grep" => Ok(vec!["text.search", "filesystem.read"]),
        "Bash" => Ok(vec!["shell.exec"]),
        "Process" => Ok(vec!["shell.exec"]),
        _ => Err(format!("No capability mapping for tool '{}'", tool_name)),
    }
}

fn is_valid_probe_bin(bin: &str) -> bool {
    !bin.is_empty()
        && bin
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '+' | '-'))
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(path)
            .map(|meta| (meta.permissions().mode() & 0o111) != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn resolve_login_shell() -> String {
    if let Ok(raw) = std::env::var("SHELL") {
        let candidate = raw.trim();
        if !candidate.is_empty() {
            let path = Path::new(candidate);
            if path.is_absolute() && is_executable_file(path) {
                return candidate.to_string();
            }
        }
    }
    "/bin/sh".to_string()
}

fn probe_path_from_login_shell() -> Option<OsString> {
    let shell = resolve_login_shell();
    let output = std::process::Command::new(shell)
        .arg("-lc")
        .arg("env")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    for line in output.stdout.split(|byte| *byte == b'\n') {
        if let Some(path_bytes) = line.strip_prefix(b"PATH=") {
            let path = String::from_utf8_lossy(path_bytes).to_string();
            return Some(OsString::from(path));
        }
    }
    None
}

fn is_bin_available_with_path(bin: &str, path_var: &OsStr) -> bool {
    if bin.contains('/') || bin.contains('\\') {
        return is_executable_file(Path::new(bin));
    }

    for dir in std::env::split_paths(path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(bin);
        if is_executable_file(&candidate) {
            return true;
        }
    }
    false
}

fn is_bin_available(bin: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    is_bin_available_with_path(bin, &path_var)
}

fn probe_node_bins(bins: &[String]) -> HashMap<String, bool> {
    let login_shell_path = probe_path_from_login_shell();
    let mut statuses = HashMap::new();
    for raw_bin in bins {
        let bin = raw_bin.trim();
        if !is_valid_probe_bin(bin) {
            continue;
        }
        let available = if let Some(path) = login_shell_path.as_deref() {
            is_bin_available_with_path(bin, path)
        } else {
            is_bin_available(bin)
        };
        statuses.insert(bin.to_string(), available);
    }
    statuses
}

fn normalize_host_env_keys<I>(keys: I) -> Vec<String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut env_keys: Vec<String> = keys
        .into_iter()
        .filter_map(|key| key.into_string().ok())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect();
    env_keys.sort();
    env_keys.dedup();
    env_keys
}

fn build_execution_node_runtime(
    tool_defs: &[ToolDefinition],
) -> Result<NodeRuntimeInfo, Box<dyn std::error::Error>> {
    let mut seen_tool_names = HashSet::new();
    let mut host_capabilities = HashSet::new();
    let mut tool_capabilities: HashMap<String, Vec<String>> = HashMap::new();

    for tool in tool_defs {
        if !seen_tool_names.insert(tool.name.clone()) {
            return Err(format!("Duplicate tool name: {}", tool.name).into());
        }

        let capabilities = capabilities_for_tool(&tool.name)?;
        for capability in &capabilities {
            host_capabilities.insert((*capability).to_string());
        }

        let mut normalized_caps: Vec<String> = capabilities
            .into_iter()
            .map(|capability| capability.to_string())
            .collect();
        normalized_caps.sort();
        normalized_caps.dedup();
        tool_capabilities.insert(tool.name.clone(), normalized_caps);
    }

    // Ensure execution baseline exists for strict node runtime validation.
    for capability in [
        "filesystem.list",
        "filesystem.read",
        "filesystem.write",
        "shell.exec",
    ] {
        host_capabilities.insert(capability.to_string());
    }

    let mut normalized_host_capabilities: Vec<String> = host_capabilities.into_iter().collect();
    normalized_host_capabilities.sort();

    let host_env = normalize_host_env_keys(std::env::vars_os().map(|(key, _)| key));

    Ok(NodeRuntimeInfo {
        host_role: "execution".to_string(),
        host_capabilities: normalized_host_capabilities,
        tool_capabilities,
        host_os: Some(std::env::consts::OS.to_string()),
        host_env: Some(host_env),
        host_bin_status: None,
        host_bin_status_updated_at: None,
    })
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
            let params = match serde_json::to_value(&event) {
                Ok(value) => value,
                Err(error) => return ExecEventSendOutcome::Drop(error.to_string()),
            };

            match conn.request("node.exec.event", Some(params)).await {
                Ok(response) if response.ok => ExecEventSendOutcome::Sent,
                Ok(response) => {
                    let message = response
                        .error
                        .map(|error| error.message)
                        .unwrap_or_else(|| "unknown response".to_string());
                    ExecEventSendOutcome::Retry(message)
                }
                Err(error) => ExecEventSendOutcome::Retry(error.to_string()),
            }
        }
    })
    .await
}

async fn run_node(
    url: &str,
    token: Option<String>,
    node_id: String,
    workspace: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let logger = NodeLogger::new(&node_id, &workspace)?;
    let log_path = node_log_path()?;
    logger.info(
        "node.start",
        json!({
            "url": url,
            "logPath": log_path.display().to_string(),
            "logMaxBytes": node_log_max_bytes(),
            "logMaxFiles": node_log_max_files(),
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

    loop {
        logger.info("connect.attempt", json!({ "url": url }));

        let tools = all_tools_with_workspace(workspace.clone());
        let tool_defs: Vec<_> = tools.iter().map(|t| t.definition()).collect();
        let tool_names: Vec<String> = tool_defs.iter().map(|t| t.name.clone()).collect();
        let node_runtime = build_execution_node_runtime(&tool_defs)?;

        logger.info(
            "tools.register",
            json!({
                "toolCount": tool_names.len(),
                "tools": tool_names,
            }),
        );

        let tools_for_handler: Arc<Vec<Box<dyn Tool>>> =
            Arc::new(all_tools_with_workspace(workspace.clone()));

        let conn = match Connection::connect_with_options(
            url,
            "node",
            Some(tool_defs),
            Some(node_runtime),
            |_frame| {},
            Some(node_id.clone()),
            token.clone(),
        )
        .await
        {
            Ok(c) => c,
            Err(e) => {
                logger.error(
                    "connect.failed",
                    json!({
                        "error": e.to_string(),
                        "retrySeconds": 3,
                    }),
                );
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                continue;
            }
        };
        let conn = Arc::new(conn);

        let conn_clone = conn.clone();
        let tools_clone = tools_for_handler.clone();
        let logger_clone = logger.clone();

        conn.set_event_handler(move |frame| {
            let conn = conn_clone.clone();
            let tools = tools_clone.clone();
            let logger = logger_clone.clone();

            tokio::spawn(async move {
                if let Frame::Evt(evt) = frame {
                    if evt.event == "tool.invoke" {
                        if let Some(payload) = evt.payload {
                            let invoke = match serde_json::from_value::<ToolInvokePayload>(payload)
                            {
                                Ok(invoke) => invoke,
                                Err(e) => {
                                    logger.warn(
                                        "tool.invoke.parse_failed",
                                        json!({
                                            "error": e.to_string(),
                                        }),
                                    );
                                    return;
                                }
                            };

                            let tool_name = invoke.tool.clone();
                            let call_id = invoke.call_id.clone();
                            logger.info(
                                "tool.invoke",
                                json!({
                                    "tool": tool_name.clone(),
                                    "callId": call_id.clone(),
                                }),
                            );

                            let result =
                                match tools.iter().find(|t| t.definition().name == invoke.tool) {
                                    Some(tool) => tool.execute(invoke.args.clone()).await,
                                    None => Err(format!("Tool not found: {}", invoke.tool)),
                                };

                            match &result {
                                Ok(_) => {
                                    logger.info(
                                        "tool.execute.ok",
                                        json!({
                                            "tool": tool_name.clone(),
                                            "callId": call_id.clone(),
                                        }),
                                    );
                                }
                                Err(err) => {
                                    logger.warn(
                                        "tool.execute.error",
                                        json!({
                                            "tool": tool_name.clone(),
                                            "callId": call_id.clone(),
                                            "error": err,
                                        }),
                                    );
                                }
                            }

                            let params = match result {
                                Ok(res) => ToolResultParams {
                                    call_id: invoke.call_id,
                                    result: Some(res),
                                    error: None,
                                },
                                Err(e) => ToolResultParams {
                                    call_id: invoke.call_id,
                                    result: None,
                                    error: Some(e),
                                },
                            };

                            if let Err(e) = conn
                                .request(
                                    "tool.result",
                                    Some(serde_json::to_value(&params).unwrap()),
                                )
                                .await
                            {
                                logger.error(
                                    "tool.result.send_failed",
                                    json!({
                                        "tool": tool_name,
                                        "callId": call_id,
                                        "error": e.to_string(),
                                    }),
                                );
                            }
                        }
                    } else if evt.event == "logs.get" {
                        if let Some(payload) = evt.payload {
                            let request = match serde_json::from_value::<LogsGetPayload>(payload) {
                                Ok(request) => request,
                                Err(e) => {
                                    logger.warn(
                                        "logs.get.parse_failed",
                                        json!({
                                            "error": e.to_string(),
                                        }),
                                    );
                                    return;
                                }
                            };

                            let requested_lines =
                                request.lines.unwrap_or(DEFAULT_NODE_LOG_GET_LINES);
                            let resolved_lines = resolve_logs_get_line_limit(request.lines);
                            if requested_lines != resolved_lines {
                                logger.warn(
                                    "logs.get.limit_clamped",
                                    json!({
                                        "callId": request.call_id,
                                        "requestedLines": requested_lines,
                                        "resolvedLines": resolved_lines,
                                        "maxLines": MAX_NODE_LOG_GET_LINES,
                                    }),
                                );
                            }

                            logger.info(
                                "logs.get",
                                json!({
                                    "callId": request.call_id,
                                    "requestedLines": requested_lines,
                                    "resolvedLines": resolved_lines,
                                }),
                            );

                            let response = match read_recent_node_log_lines(resolved_lines) {
                                Ok((lines, truncated)) => LogsResultParams {
                                    call_id: request.call_id.clone(),
                                    lines: Some(lines),
                                    truncated: Some(truncated),
                                    error: None,
                                },
                                Err(error) => LogsResultParams {
                                    call_id: request.call_id.clone(),
                                    lines: None,
                                    truncated: None,
                                    error: Some(error),
                                },
                            };

                            if let Some(error) = response.error.clone() {
                                logger.warn(
                                    "logs.get.error",
                                    json!({
                                        "callId": request.call_id,
                                        "error": error,
                                    }),
                                );
                            }

                            if let Err(e) = conn
                                .request(
                                    "logs.result",
                                    Some(serde_json::to_value(&response).unwrap()),
                                )
                                .await
                            {
                                logger.error(
                                    "logs.result.send_failed",
                                    json!({
                                        "callId": response.call_id,
                                        "error": e.to_string(),
                                    }),
                                );
                            }
                        }
                    } else if evt.event == "node.probe" {
                        if let Some(payload) = evt.payload {
                            let request = match serde_json::from_value::<NodeProbePayload>(payload)
                            {
                                Ok(request) => request,
                                Err(e) => {
                                    logger.warn(
                                        "node.probe.parse_failed",
                                        json!({
                                            "error": e.to_string(),
                                        }),
                                    );
                                    return;
                                }
                            };

                            logger.info(
                                "node.probe",
                                json!({
                                    "probeId": request.probe_id.clone(),
                                    "kind": request.kind.clone(),
                                    "binsCount": request.bins.len(),
                                }),
                            );

                            let response = if request.kind == "bins" {
                                let statuses = probe_node_bins(&request.bins);
                                NodeProbeResultParams {
                                    probe_id: request.probe_id.clone(),
                                    ok: true,
                                    bins: Some(statuses),
                                    error: None,
                                }
                            } else {
                                NodeProbeResultParams {
                                    probe_id: request.probe_id.clone(),
                                    ok: false,
                                    bins: None,
                                    error: Some(format!(
                                        "Unsupported probe kind: {}",
                                        request.kind
                                    )),
                                }
                            };

                            if let Err(e) = conn
                                .request(
                                    "node.probe.result",
                                    Some(serde_json::to_value(&response).unwrap()),
                                )
                                .await
                            {
                                logger.error(
                                    "node.probe.result.send_failed",
                                    json!({
                                        "probeId": response.probe_id,
                                        "error": e.to_string(),
                                    }),
                                );
                            }
                        }
                    }
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

        logger.info(
            "connect.ok",
            json!({
                "keepaliveSeconds": 300,
            }),
        );
        let keepalive_interval = tokio::time::Duration::from_secs(60 * 5);
        let keepalive_timeout = tokio::time::Duration::from_secs(10);
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
                            conn.request("tools.list", None),
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

async fn run_mount(action: MountAction, cfg: &CliConfig) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("gsv");
    let rclone_config = config_dir.join("rclone.conf");
    let pid_file = config_dir.join("mount.pid");

    match action {
        MountAction::Setup {
            account_id,
            access_key_id,
            secret_access_key,
            bucket,
        } => {
            // Use CLI args, falling back to config file
            let account_id = if account_id.is_empty() {
                cfg.r2
                    .account_id
                    .clone()
                    .ok_or("account_id required (use --account-id or set in config)")?
            } else {
                account_id
            };
            let access_key_id = if access_key_id.is_empty() {
                cfg.r2
                    .access_key_id
                    .clone()
                    .ok_or("access_key_id required (use --access-key-id or set in config)")?
            } else {
                access_key_id
            };
            let secret_access_key = if secret_access_key.is_empty() {
                cfg.r2.secret_access_key.clone().ok_or(
                    "secret_access_key required (use --secret-access-key or set in config)",
                )?
            } else {
                secret_access_key
            };
            let bucket = if bucket == "gsv-storage" {
                cfg.r2
                    .bucket
                    .clone()
                    .unwrap_or_else(|| "gsv-storage".to_string())
            } else {
                bucket
            };

            // Check if rclone is installed
            let rclone_check = std::process::Command::new("rclone")
                .arg("--version")
                .output();

            if rclone_check.is_err() {
                eprintln!("rclone is not installed. Install it first:");
                eprintln!("  macOS:  brew install rclone");
                eprintln!("  Linux:  curl https://rclone.org/install.sh | sudo bash");
                return Err("rclone not found".into());
            }

            // Create config directory
            std::fs::create_dir_all(&config_dir)?;

            // Generate rclone config
            let endpoint = format!("{}.r2.cloudflarestorage.com", account_id);
            let config_content = format!(
                r#"[gsv-r2]
type = s3
provider = Cloudflare
access_key_id = {}
secret_access_key = {}
endpoint = https://{}
acl = private

[gsv-bucket]
type = alias
remote = gsv-r2:{}
"#,
                access_key_id, secret_access_key, endpoint, bucket
            );

            std::fs::write(&rclone_config, &config_content)?;

            println!("R2 configuration saved to {}", rclone_config.display());
            println!("\nConfiguration:");
            println!("  Account ID: {}", account_id);
            println!("  Bucket: {}", bucket);

            // Create mount point directory (~/.gsv/r2)
            let bucket_mount = cfg.r2_mount_path();

            if !bucket_mount.exists() {
                println!("\nCreating mount point {}...", bucket_mount.display());
                std::fs::create_dir_all(&bucket_mount)?;
                println!("Created {}", bucket_mount.display());
            } else {
                println!("\nMount point {} already exists", bucket_mount.display());
            }

            let r2_mount = cfg.r2_mount_path();
            println!("\nMount location:");
            println!("  R2 bucket will be mounted at: {}", r2_mount.display());
            println!("  Agent configs at: {}/agents/", r2_mount.display());
            println!("\nTo start the mount, run:");
            println!("  gsv mount start");
        }

        MountAction::Start { foreground } => {
            if !rclone_config.exists() {
                eprintln!("rclone not configured. Run 'gsv mount setup' first.");
                return Err("rclone not configured".into());
            }

            // Check if already mounted
            if pid_file.exists() {
                let pid = std::fs::read_to_string(&pid_file)?;
                eprintln!("Mount may already be running (PID: {})", pid.trim());
                eprintln!("Run 'gsv mount stop' first if you want to restart.");
                return Ok(());
            }

            // Check for FUSE support (kernel extension mode)
            #[cfg(target_os = "macos")]
            {
                // Check for macFUSE by looking for the filesystem bundle
                let macfuse_fs = std::path::Path::new("/Library/Filesystems/macfuse.fs");

                if !macfuse_fs.exists() {
                    eprintln!("Error: macFUSE is required for mounting on macOS.");
                    eprintln!("");
                    eprintln!("Install it with:");
                    eprintln!("  brew install --cask macfuse");
                    return Err("macFUSE not installed".into());
                }

                // Check if rclone is from Homebrew (which doesn't support mount)
                let rclone_path = std::process::Command::new("which")
                    .arg("rclone")
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .unwrap_or_default();

                if rclone_path.contains("/homebrew/") {
                    eprintln!("Error: Homebrew rclone doesn't support FUSE mounting on macOS.");
                    eprintln!("");
                    eprintln!("Install rclone from official binaries instead:");
                    eprintln!("  brew uninstall rclone");
                    eprintln!(
                        "  curl -O https://downloads.rclone.org/rclone-current-osx-arm64.zip"
                    );
                    eprintln!("  unzip rclone-current-osx-arm64.zip");
                    eprintln!("  cd rclone-*-osx-arm64");
                    eprintln!("  sudo cp rclone /usr/local/bin/");
                    eprintln!("  sudo chmod +x /usr/local/bin/rclone");
                    return Err("Homebrew rclone doesn't support mount".into());
                }
            }

            // Mount to ~/.gsv/r2
            let bucket_mount = cfg.r2_mount_path();

            #[cfg(target_os = "linux")]
            {
                let has_fuse = std::process::Command::new("which")
                    .arg("fusermount")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
                    || std::process::Command::new("which")
                        .arg("fusermount3")
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);

                if !has_fuse {
                    eprintln!("Error: FUSE is required for mounting on Linux.");
                    eprintln!("");
                    eprintln!("Install it with:");
                    eprintln!("  Ubuntu/Debian: sudo apt install fuse3");
                    eprintln!("  Fedora/RHEL:   sudo dnf install fuse3");
                    eprintln!("  Arch:          sudo pacman -S fuse3");
                    return Err("FUSE not installed".into());
                }
            }

            // Check mount point exists (created during setup)
            if !bucket_mount.exists() {
                eprintln!("Mount point {} does not exist.", bucket_mount.display());
                eprintln!("Run 'gsv mount setup' first to create it.");
                return Err("Mount point not found".into());
            }

            println!("Mounting R2 bucket to {}...", bucket_mount.display());

            let mut cmd = std::process::Command::new("rclone");
            cmd.arg("mount")
                .arg("gsv-bucket:/") // Mount full bucket, not just workspace
                .arg(&bucket_mount)
                .arg("--config")
                .arg(&rclone_config)
                .arg("--vfs-cache-mode")
                .arg("full")
                .arg("--vfs-cache-max-age")
                .arg("1h")
                .arg("--vfs-read-chunk-size")
                .arg("0") // Disable chunked reads (R2 returns 403 on ranged requests)
                .arg("--dir-cache-time")
                .arg("30s")
                .arg("--allow-non-empty");

            if foreground {
                println!("Running in foreground. Press Ctrl+C to stop.");
                let status = cmd.status()?;
                if !status.success() {
                    return Err("rclone mount failed".into());
                }
            } else {
                cmd.arg("--daemon");

                let output = cmd.output()?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("rclone mount failed: {}", stderr);
                    return Err("rclone mount failed".into());
                }

                // Find the PID (rclone --daemon doesn't return it directly)
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                let pgrep = std::process::Command::new("pgrep")
                    .arg("-f")
                    .arg(format!("rclone mount.*gsv-bucket"))
                    .output();

                if let Ok(output) = pgrep {
                    let pid = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !pid.is_empty() {
                        std::fs::write(&pid_file, &pid)?;
                        println!("Mount started (PID: {})", pid);
                    }
                }

                println!("R2 bucket mounted at: {}", bucket_mount.display());
                println!("Agent configs: {}/agents/", bucket_mount.display());
                println!("\nTo initialize a workspace, run:");
                println!("  gsv workspace init [agent_id]");
                println!("\nTo stop the mount, run:");
                println!("  gsv mount stop");
            }
        }

        MountAction::Stop => {
            let bucket_mount = cfg.r2_mount_path();

            if !pid_file.exists() {
                println!("No mount PID file found. Mount may not be running.");

                // Try to find and kill anyway
                let _ = std::process::Command::new("pkill")
                    .arg("-f")
                    .arg("rclone mount.*gsv-bucket")
                    .status();

                // Try to unmount
                #[cfg(target_os = "macos")]
                {
                    let _ = std::process::Command::new("umount")
                        .arg(&bucket_mount)
                        .status();
                }
                #[cfg(target_os = "linux")]
                {
                    let _ = std::process::Command::new("fusermount")
                        .arg("-u")
                        .arg(&bucket_mount)
                        .status();
                }

                return Ok(());
            }

            let pid = std::fs::read_to_string(&pid_file)?.trim().to_string();

            // Kill the process
            let status = std::process::Command::new("kill").arg(&pid).status();

            if status.is_ok() {
                println!("Mount stopped (PID: {})", pid);
            } else {
                eprintln!("Failed to stop mount (PID: {})", pid);
            }

            // Clean up PID file
            let _ = std::fs::remove_file(&pid_file);

            // Clean up mount point
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("umount")
                    .arg(&bucket_mount)
                    .status();

                // macFUSE removes the mount point after umount, recreate it
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                if !bucket_mount.exists() {
                    let _ = std::fs::create_dir_all(&bucket_mount);
                }
            }
            #[cfg(target_os = "linux")]
            {
                let _ = std::process::Command::new("fusermount")
                    .arg("-u")
                    .arg(&bucket_mount)
                    .status();
            }
        }

        MountAction::Status => {
            let bucket_mount = cfg.r2_mount_path();

            let mut is_running = false;

            if pid_file.exists() {
                let pid = std::fs::read_to_string(&pid_file)?.trim().to_string();

                // Check if process is still running
                let status = std::process::Command::new("ps")
                    .arg("-p")
                    .arg(&pid)
                    .output();

                if let Ok(output) = status {
                    if output.status.success() {
                        println!("Mount is running (PID: {})", pid);
                        is_running = true;
                    }
                }

                if !is_running {
                    // Process not running, clean up stale PID file
                    let _ = std::fs::remove_file(&pid_file);
                }
            }

            if is_running {
                println!("\nFull bucket:     {}", bucket_mount.display());

                // List top-level directories
                if let Ok(entries) = std::fs::read_dir(&bucket_mount) {
                    let dirs: Vec<_> = entries
                        .filter_map(|e| e.ok())
                        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .collect();
                    if !dirs.is_empty() {
                        println!("                 Contains: {}", dirs.join(", "));
                    }
                }

                // List agent directories
                let agents_path = bucket_mount.join("agents");
                if agents_path.exists() {
                    if let Ok(entries) = std::fs::read_dir(&agents_path) {
                        let agents: Vec<_> = entries
                            .filter_map(|e| e.ok())
                            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .collect();
                        if !agents.is_empty() {
                            println!("\nAgents found: {}", agents.join(", "));
                            println!("\nUse 'gsv workspace status <agent>' for workspace details");
                        }
                    }
                }
            } else {
                println!("Mount is not running");
                println!("\nTo start the mount, run:");
                println!("  gsv mount start");
            }
        }
    }

    Ok(())
}
