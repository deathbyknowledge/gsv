mod config;
mod connection;
mod protocol;
mod tools;

use clap::{Parser, Subcommand};
use config::CliConfig;
use connection::Connection;
use protocol::{Frame, ToolInvokePayload, ToolResultParams};
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tools::{all_tools_with_workspace, Tool};

#[derive(Parser)]
#[command(name = "gsv", about = "GSV CLI - Client and Node for GSV Gateway")]
struct Cli {
    /// Gateway URL (overrides config file)
    #[arg(short, long, env = "GSV_URL")]
    url: Option<String>,

    /// Auth token (overrides config file, or set GSV_TOKEN env var)
    #[arg(short, long, env = "GSV_TOKEN")]
    token: Option<String>,

    /// Workspace directory (overrides config file, or set GSV_WORKSPACE env)
    #[arg(short, long, env = "GSV_WORKSPACE")]
    workspace: Option<PathBuf>,

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
        
        /// Session key (default from config or "main")
        #[arg(short, long)]
        session: Option<String>,
    },
    
    /// Run as a tool-providing node
    Node {
        /// Node ID (default: hostname)
        #[arg(long)]
        id: Option<String>,
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
    
    /// Manage sessions
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    
    /// List available tools
    Tools,
    
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
        
        /// R2 bucket path prefix (default: agents/main)
        #[arg(long, default_value = "agents/main")]
        prefix: String,
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
enum SessionAction {
    /// List all known sessions
    List {
        /// Maximum number of sessions to show
        #[arg(short, long, default_value = "50")]
        limit: i64,
    },
    /// Reset a session (clear message history, archive to R2)
    Reset {
        /// Session key (default: "main")
        #[arg(default_value = "main")]
        session_key: String,
    },
    /// Get session info
    Get {
        /// Session key (default: "main")
        #[arg(default_value = "main")]
        session_key: String,
    },
    /// Get session stats (token usage)
    Stats {
        /// Session key (default: "main")
        #[arg(default_value = "main")]
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
        /// Session key (default: "main")
        #[arg(default_value = "main")]
        session_key: String,
        /// Number of messages to keep (default: 20)
        #[arg(short, long, default_value = "20")]
        keep: i64,
    },
    /// Show session history (previous session IDs)
    History {
        /// Session key (default: "main")
        #[arg(default_value = "main")]
        session_key: String,
    },
    /// Preview session messages
    Preview {
        /// Session key (default: "main")
        #[arg(default_value = "main")]
        session_key: String,
        /// Number of messages to show (default: all)
        #[arg(short, long)]
        limit: Option<i64>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    
    // Load config from file
    let cfg = CliConfig::load();

    // Merge CLI args with config (CLI takes precedence)
    let url = cli.url.unwrap_or_else(|| cfg.gateway_url());
    let token = cli.token.or_else(|| cfg.gateway_token());
    let workspace = cli.workspace.unwrap_or_else(|| cfg.workspace_path());

    match cli.command {
        Commands::Init { force } => run_init(force),
        Commands::Client { message, session } => {
            let session = session.unwrap_or_else(|| cfg.default_session());
            run_client(&url, token, message, &session).await
        }
        Commands::Node { id } => run_node(&url, token, id, workspace).await,
        Commands::Config { action } => run_config(&url, token, action).await,
        Commands::LocalConfig { action } => run_local_config(action),
        Commands::Session { action } => run_session(&url, token, action).await,
        Commands::Tools => run_tools(&url, token).await,
        Commands::Mount { action } => run_mount(action, workspace, &cfg).await,
        Commands::Heartbeat { action } => run_heartbeat(&url, token, action).await,
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

    Ok(())
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
                        format!("{}...{}", &s[..4], &s[s.len()-4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "workspace.path" => cfg.workspace.path.map(|p| p.display().to_string()),
                "r2.account_id" => cfg.r2.account_id,
                "r2.access_key_id" => cfg.r2.access_key_id.map(|s| {
                    if s.len() > 8 { format!("{}...", &s[..8]) } else { "****".to_string() }
                }),
                "r2.bucket" => cfg.r2.bucket,
                "r2.prefix" => cfg.r2.prefix,
                "session.default_key" => cfg.session.default_key,
                _ => {
                    eprintln!("Unknown config key: {}", key);
                    eprintln!("\nValid keys:");
                    eprintln!("  gateway.url, gateway.token");
                    eprintln!("  workspace.path");
                    eprintln!("  r2.account_id, r2.access_key_id, r2.bucket, r2.prefix");
                    eprintln!("  session.default_key");
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
                "workspace.path" => cfg.workspace.path = Some(PathBuf::from(&value)),
                "r2.account_id" => cfg.r2.account_id = Some(value.clone()),
                "r2.access_key_id" => cfg.r2.access_key_id = Some(value.clone()),
                "r2.secret_access_key" => cfg.r2.secret_access_key = Some(value.clone()),
                "r2.bucket" => cfg.r2.bucket = Some(value.clone()),
                "r2.prefix" => cfg.r2.prefix = Some(value.clone()),
                "session.default_key" => cfg.session.default_key = Some(value.clone()),
                _ => {
                    eprintln!("Unknown config key: {}", key);
                    return Ok(());
                }
            }

            cfg.save()?;
            println!("Set {} = {}", key, if key.contains("token") || key.contains("secret") { "****" } else { &value });
        }

        LocalConfigAction::Path => {
            match CliConfig::config_path() {
                Some(path) => {
                    println!("{}", path.display());
                    if path.exists() {
                        println!("(exists)");
                    } else {
                        println!("(not created yet - run 'gsv init')");
                    }
                }
                None => println!("Could not determine config path"),
            }
        }
    }

    Ok(())
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

    let conn = Connection::connect_with_options(url, "client", None, move |frame| {
        // Handle incoming events
        if let Frame::Evt(evt) = frame {
            if evt.event == "chat" {
                if let Some(payload) = evt.payload {
                    // Filter by sessionKey - ignore events for other sessions
                    if let Some(event_session) = payload.get("sessionKey").and_then(|s| s.as_str()) {
                        if event_session != session_key_owned {
                            return;
                        }
                    }
                    
                    if let Some(state) = payload.get("state").and_then(|s| s.as_str()) {
                        match state {
                            "delta" | "partial" => {
                                if let Some(text) = payload.get("text").and_then(|t| t.as_str()) {
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
                                if let Some(err) = payload.get("error").and_then(|e| e.as_str()) {
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
    }, None, token)
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

async fn run_heartbeat(url: &str, token: Option<String>, action: HeartbeatAction) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::connect_with_options(url, "client", None, |_| {}, None, token).await?;

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
                                
                                if let Some(next) = state.get("nextHeartbeatAt").and_then(|n| n.as_i64()) {
                                    let dt = chrono::DateTime::from_timestamp_millis(next);
                                    if let Some(dt) = dt {
                                        println!("    Next: {}", dt.format("%Y-%m-%d %H:%M:%S"));
                                    }
                                }
                                
                                if let Some(last) = state.get("lastHeartbeatAt").and_then(|n| n.as_i64()) {
                                    let dt = chrono::DateTime::from_timestamp_millis(last);
                                    if let Some(dt) = dt {
                                        println!("    Last: {}", dt.format("%Y-%m-%d %H:%M:%S"));
                                    }
                                }
                                
                                // Show last active channel context
                                if let Some(last_active) = state.get("lastActive") {
                                    if let Some(channel) = last_active.get("channel").and_then(|c| c.as_str()) {
                                        let peer_name = last_active.get("peer")
                                            .and_then(|p| p.get("name"))
                                            .and_then(|n| n.as_str())
                                            .unwrap_or("unknown");
                                        let peer_id = last_active.get("peer")
                                            .and_then(|p| p.get("id"))
                                            .and_then(|i| i.as_str())
                                            .unwrap_or("unknown");
                                        
                                        println!("    Delivery: {} -> {} ({})", channel, peer_name, peer_id);
                                        
                                        if let Some(ts) = last_active.get("timestamp").and_then(|t| t.as_i64()) {
                                            let dt = chrono::DateTime::from_timestamp_millis(ts);
                                            if let Some(dt) = dt {
                                                println!("    Last msg: {}", dt.format("%Y-%m-%d %H:%M:%S"));
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
                            if let Some(next) = state.get("nextHeartbeatAt").and_then(|n| n.as_i64()) {
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

async fn run_config(url: &str, token: Option<String>, action: ConfigAction) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::connect_with_options(url, "client", None, |_| {}, None, token).await?;

    match action {
        ConfigAction::Get { path } => {
            let res = conn
                .request(
                    "config.get",
                    Some(json!({ "path": path })),
                )
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

async fn run_tools(url: &str, token: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::connect_with_options(url, "client", None, |_| {}, None, token).await?;

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
                        let desc = tool.get("description").and_then(|d| d.as_str()).unwrap_or("");
                        println!("  - {}: {}", name, desc);
                    }
                }
            }
        }
    } else {
        if let Some(err) = res.error {
            eprintln!("Error: {}", err.message);
        }
    }

    Ok(())
}

async fn run_session(url: &str, token: Option<String>, action: SessionAction) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::connect_with_options(url, "client", None, |_| {}, None, token).await?;

    match action {
        SessionAction::List { limit } => {
            let res = conn
                .request(
                    "sessions.list",
                    Some(json!({ "limit": limit })),
                )
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
                                let key = session.get("sessionKey").and_then(|k| k.as_str()).unwrap_or("?");
                                let msg_count = session.get("messageCount").and_then(|c| c.as_i64()).unwrap_or(0);
                                let label = session.get("label").and_then(|l| l.as_str());
                                let last_active = session.get("lastActiveAt").and_then(|t| t.as_i64());
                                
                                let last_active_str = last_active
                                    .and_then(|ts| chrono::DateTime::from_timestamp_millis(ts))
                                    .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                                    .unwrap_or_else(|| "?".to_string());
                                
                                if let Some(label) = label {
                                    println!("  {} ({}) - {} msgs, last active: {}", key, label, msg_count, last_active_str);
                                } else {
                                    println!("  {} - {} msgs, last active: {}", key, msg_count, last_active_str);
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
            let res = conn
                .request(
                    "session.reset",
                    Some(json!({ "sessionKey": session_key })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let old_id = payload.get("oldSessionId").and_then(|s| s.as_str()).unwrap_or("?");
                    let new_id = payload.get("newSessionId").and_then(|s| s.as_str()).unwrap_or("?");
                    let archived = payload.get("archivedMessages").and_then(|c| c.as_i64()).unwrap_or(0);
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
            let res = conn
                .request(
                    "session.get",
                    Some(json!({ "sessionKey": session_key })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    println!("Session: {}", session_key);
                    println!("  Session ID: {}", payload.get("sessionId").and_then(|s| s.as_str()).unwrap_or("?"));
                    println!("  Messages: {}", payload.get("messageCount").and_then(|c| c.as_i64()).unwrap_or(0));
                    
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
                        let mode = policy.get("mode").and_then(|m| m.as_str()).unwrap_or("manual");
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
            let res = conn
                .request(
                    "session.stats",
                    Some(json!({ "sessionKey": session_key })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    println!("Session stats: {}", session_key);
                    println!("  Messages: {}", payload.get("messageCount").and_then(|c| c.as_i64()).unwrap_or(0));
                    
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
        
        SessionAction::Set { session_key, path, value } => {
            // Build the patch params based on the path
            let parsed_value: serde_json::Value = serde_json::from_str(&value)
                .unwrap_or_else(|_| serde_json::Value::String(value.clone()));
            
            let params = match path.as_str() {
                "label" => json!({
                    "sessionKey": session_key,
                    "label": parsed_value
                }),
                p if p.starts_with("settings.") || p.starts_with("model.") || p == "thinkingLevel" || p == "systemPrompt" || p == "maxTokens" => {
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
                },
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
                },
                _ => {
                    eprintln!("Unknown setting path: {}", path);
                    eprintln!("Valid paths: label, model.provider, model.id, thinkingLevel, systemPrompt, maxTokens, resetPolicy.mode, resetPolicy.atHour, resetPolicy.idleMinutes");
                    return Ok(());
                }
            };
            
            let res = conn
                .request("session.patch", Some(params))
                .await?;

            if res.ok {
                println!("Updated {} = {} for session '{}'", path, value, session_key);
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }
        
        SessionAction::Compact { session_key, keep } => {
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
                    let trimmed = payload.get("trimmedMessages").and_then(|c| c.as_i64()).unwrap_or(0);
                    let kept = payload.get("keptMessages").and_then(|c| c.as_i64()).unwrap_or(0);
                    
                    if trimmed > 0 {
                        println!("Compacted session '{}'", session_key);
                        println!("  Trimmed {} messages, kept {}", trimmed, kept);
                        if let Some(path) = payload.get("archivedTo").and_then(|p| p.as_str()) {
                            println!("  Archived to: {}", path);
                        }
                    } else {
                        println!("Session '{}' has {} messages (no compaction needed)", session_key, kept);
                    }
                }
            } else if let Some(err) = res.error {
                eprintln!("Error: {}", err.message);
            }
        }
        
        SessionAction::History { session_key } => {
            let res = conn
                .request(
                    "session.history",
                    Some(json!({ "sessionKey": session_key })),
                )
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let current = payload.get("currentSessionId").and_then(|s| s.as_str()).unwrap_or("?");
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
            let mut params = json!({ "sessionKey": session_key });
            if let Some(l) = limit {
                params["limit"] = json!(l);
            }
            
            let res = conn
                .request("session.preview", Some(params))
                .await?;

            if res.ok {
                if let Some(payload) = res.payload {
                    let msg_count = payload.get("messageCount").and_then(|c| c.as_i64()).unwrap_or(0);
                    let messages = payload.get("messages").and_then(|m| m.as_array());
                    
                    println!("Session: {} ({} messages total)\n", session_key, msg_count);
                    
                    if let Some(msgs) = messages {
                        for msg in msgs {
                            let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("?");
                            
                            match role {
                                "user" => {
                                    let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
                                    println!("USER: {}\n", content);
                                }
                                "assistant" => {
                                    print!("ASSISTANT: ");
                                    if let Some(content) = msg.get("content") {
                                        if let Some(text) = content.as_str() {
                                            println!("{}\n", text);
                                        } else if let Some(blocks) = content.as_array() {
                                            for block in blocks {
                                                if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
                                                    match block_type {
                                                        "text" => {
                                                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                                                print!("{}", text);
                                                            }
                                                        }
                                                        "toolCall" => {
                                                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("?");
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
                                    let tool_name = msg.get("toolName").and_then(|n| n.as_str()).unwrap_or("?");
                                    let is_error = msg.get("isError").and_then(|e| e.as_bool()).unwrap_or(false);
                                    let prefix = if is_error { "ERROR" } else { "RESULT" };
                                    
                                    print!("TOOL {} ({}): ", prefix, tool_name);
                                    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                                        for block in content {
                                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
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

async fn run_node(url: &str, token: Option<String>, node_id: Option<String>, workspace: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    // Resolve node ID: use provided, or fall back to hostname
    let node_id = node_id.unwrap_or_else(|| {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        format!("node-{}", hostname)
    });
    
    loop {
        println!("Connecting as node '{}' to {}...", node_id, url);
        println!("Workspace: {}", workspace.display());

        let tools = all_tools_with_workspace(workspace.clone());
        let tool_defs: Vec<_> = tools.iter().map(|t| t.definition()).collect();

        println!(
            "Registering tools: {:?}",
            tool_defs.iter().map(|t| &t.name).collect::<Vec<_>>()
        );

        let tools_for_handler: Arc<Vec<Box<dyn Tool>>> = Arc::new(all_tools_with_workspace(workspace.clone()));

        let conn = match Connection::connect_with_options(url, "node", Some(tool_defs), |_frame| {}, Some(node_id.clone()), token.clone()).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Failed to connect: {}. Retrying in 3s...", e);
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                continue;
            }
        };
        let conn = Arc::new(conn);

        let conn_clone = conn.clone();
        let tools_clone = tools_for_handler.clone();

        conn.set_event_handler(move |frame| {
            let conn = conn_clone.clone();
            let tools = tools_clone.clone();

            tokio::spawn(async move {
                if let Frame::Evt(evt) = frame {
                    if evt.event == "tool.invoke" {
                        if let Some(payload) = evt.payload {
                            if let Ok(invoke) = serde_json::from_value::<ToolInvokePayload>(payload) {
                                println!("Tool invoke: {} ({})", invoke.tool, invoke.call_id);

                                let result = tools
                                    .iter()
                                    .find(|t| t.definition().name == invoke.tool)
                                    .map(|t| t.execute(invoke.args.clone()))
                                    .unwrap_or_else(|| Err(format!("Tool not found: {}", invoke.tool)));

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

                                println!("Tool result: {:?}", params);

                                if let Err(e) = conn
                                    .request("tool.result", Some(serde_json::to_value(&params).unwrap()))
                                    .await
                                {
                                    eprintln!("Failed to send tool result: {}", e);
                                }
                            }
                        }
                    }
                }
            });
        })
        .await;

        println!("Connected as node! Waiting for tool invocations...");

        // Monitor for disconnection or Ctrl+C
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    println!("Shutting down...");
                    return Ok(());
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
                    if conn.is_disconnected() {
                        eprintln!("Connection lost! Reconnecting in 3s...");
                        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                        break; // Break inner loop to reconnect
                    }
                }
            }
        }
    }
}

async fn run_mount(action: MountAction, workspace: PathBuf, cfg: &CliConfig) -> Result<(), Box<dyn std::error::Error>> {
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
            prefix,
        } => {
            // Use CLI args, falling back to config file
            let account_id = if account_id.is_empty() {
                cfg.r2.account_id.clone().ok_or("account_id required (use --account-id or set in config)")?
            } else {
                account_id
            };
            let access_key_id = if access_key_id.is_empty() {
                cfg.r2.access_key_id.clone().ok_or("access_key_id required (use --access-key-id or set in config)")?
            } else {
                access_key_id
            };
            let secret_access_key = if secret_access_key.is_empty() {
                cfg.r2.secret_access_key.clone().ok_or("secret_access_key required (use --secret-access-key or set in config)")?
            } else {
                secret_access_key
            };
            let bucket = if bucket == "gsv-storage" {
                cfg.r2.bucket.clone().unwrap_or_else(|| "gsv-storage".to_string())
            } else {
                bucket
            };
            let prefix = if prefix == "agents/main" {
                cfg.r2.prefix.clone().unwrap_or_else(|| "agents/main".to_string())
            } else {
                prefix
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

            // Generate rclone config with two remotes:
            // 1. gsv-bucket: Full bucket access (for human browsing)
            // 2. gsv-workspace: Agent-specific workspace (scoped to prefix)
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

[gsv-workspace]
type = alias
remote = gsv-r2:{}/{}
"#,
                access_key_id,
                secret_access_key,
                endpoint,
                bucket,
                bucket,
                prefix
            );

            std::fs::write(&rclone_config, &config_content)?;
            
            println!("R2 configuration saved to {}", rclone_config.display());
            println!("\nConfiguration:");
            println!("  Account ID: {}", account_id);
            println!("  Bucket: {}", bucket);
            println!("  Agent prefix: {}", prefix);
            
            // Create mount point directory (needs sudo on macOS for /Volumes)
            #[cfg(target_os = "macos")]
            let bucket_mount = PathBuf::from("/Volumes/gsv-storage");
            
            #[cfg(not(target_os = "macos"))]
            let bucket_mount = dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("gsv-storage");
            
            if !bucket_mount.exists() {
                println!("\nCreating mount point {}...", bucket_mount.display());
                
                #[cfg(target_os = "macos")]
                {
                    // On macOS, /Volumes requires sudo
                    let status = std::process::Command::new("sudo")
                        .arg("mkdir")
                        .arg("-p")
                        .arg(&bucket_mount)
                        .status();
                    
                    if status.is_err() || !status.unwrap().success() {
                        eprintln!("Failed to create mount point. Run manually:");
                        eprintln!("  sudo mkdir -p {}", bucket_mount.display());
                        eprintln!("  sudo chown $USER {}", bucket_mount.display());
                        return Err("Failed to create mount point".into());
                    }
                    
                    // Change ownership to current user
                    let username = std::env::var("USER").unwrap_or_else(|_| "".to_string());
                    if !username.is_empty() {
                        let _ = std::process::Command::new("sudo")
                            .arg("chown")
                            .arg(&username)
                            .arg(&bucket_mount)
                            .status();
                    }
                    
                    println!("Created {}", bucket_mount.display());
                }
                
                #[cfg(not(target_os = "macos"))]
                {
                    std::fs::create_dir_all(&bucket_mount)?;
                    println!("Created {}", bucket_mount.display());
                }
            } else {
                println!("\nMount point {} already exists", bucket_mount.display());
            }
            
            println!("\nMount points:");
            println!("  Full bucket:     {}", bucket_mount.display());
            println!("  Agent workspace: {} -> {}/{}", workspace.display(), bucket_mount.display(), prefix);
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

            // Read agent prefix from rclone config to know where to symlink
            let rclone_content = std::fs::read_to_string(&rclone_config)?;
            let agent_prefix = rclone_content
                .lines()
                .find(|l| l.starts_with("remote = gsv-r2:") && l.contains("/agents/"))
                .and_then(|l| l.split('/').skip(1).collect::<Vec<_>>().join("/").into())
                .unwrap_or_else(|| "agents/main".to_string());

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
                    eprintln!("  curl -O https://downloads.rclone.org/rclone-current-osx-arm64.zip");
                    eprintln!("  unzip rclone-current-osx-arm64.zip");
                    eprintln!("  cd rclone-*-osx-arm64");
                    eprintln!("  sudo cp rclone /usr/local/bin/");
                    eprintln!("  sudo chmod +x /usr/local/bin/rclone");
                    return Err("Homebrew rclone doesn't support mount".into());
                }
            }
            
            // Mount paths
            #[cfg(target_os = "macos")]
            let bucket_mount = PathBuf::from("/Volumes/gsv-storage");
            
            #[cfg(not(target_os = "macos"))]
            let bucket_mount = dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("gsv-storage");
            
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
                .arg("gsv-bucket:/")  // Mount full bucket, not just workspace
                .arg(&bucket_mount)
                .arg("--config").arg(&rclone_config)
                .arg("--vfs-cache-mode").arg("full")
                .arg("--vfs-cache-max-age").arg("1h")
                .arg("--vfs-read-chunk-size").arg("0")  // Disable chunked reads (R2 returns 403 on ranged requests)
                .arg("--dir-cache-time").arg("30s")
                .arg("--allow-non-empty");
            
            // Store agent prefix for symlink creation
            let workspace_target = bucket_mount.join(&agent_prefix);

            if foreground {
                // Create symlink before starting foreground mount
                // Remove old symlink/dir if exists
                let _ = std::fs::remove_file(&workspace);
                let _ = std::fs::remove_dir(&workspace);
                
                #[cfg(unix)]
                if std::os::unix::fs::symlink(&workspace_target, &workspace).is_ok() {
                    println!("Symlinked {} -> {}", workspace.display(), workspace_target.display());
                }
                
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
                
                println!("Full bucket: {}", bucket_mount.display());
                
                // Create symlink from workspace to agent directory in mount
                // Remove old symlink/dir if exists
                let _ = std::fs::remove_file(&workspace);
                let _ = std::fs::remove_dir(&workspace);
                
                #[cfg(unix)]
                if std::os::unix::fs::symlink(&workspace_target, &workspace).is_ok() {
                    println!("Agent workspace: {} -> {}", workspace.display(), workspace_target.display());
                } else {
                    eprintln!("Warning: Could not create symlink {} -> {}", workspace.display(), workspace_target.display());
                }
                
                println!("\nTo stop the mount, run:");
                println!("  gsv mount stop");
            }
        }

        MountAction::Stop => {
            // Mount paths
            #[cfg(target_os = "macos")]
            let bucket_mount = PathBuf::from("/Volumes/gsv-storage");
            
            #[cfg(not(target_os = "macos"))]
            let bucket_mount = dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("gsv-storage");
            
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
                
                // Remove workspace symlink if it exists
                if workspace.is_symlink() {
                    let _ = std::fs::remove_file(&workspace);
                    println!("Removed symlink {}", workspace.display());
                }
                
                return Ok(());
            }

            let pid = std::fs::read_to_string(&pid_file)?.trim().to_string();
            
            // Kill the process
            let status = std::process::Command::new("kill")
                .arg(&pid)
                .status();
            
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
            
            // Remove workspace symlink if it exists
            if workspace.is_symlink() {
                let _ = std::fs::remove_file(&workspace);
                println!("Removed symlink {}", workspace.display());
            }
        }

        MountAction::Status => {
            // Mount paths
            #[cfg(target_os = "macos")]
            let bucket_mount = PathBuf::from("/Volumes/gsv-storage");
            
            #[cfg(not(target_os = "macos"))]
            let bucket_mount = dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("gsv-storage");
            
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
                
                println!("Agent workspace: {}", workspace.display());
                if workspace.is_symlink() {
                    if let Ok(target) = std::fs::read_link(&workspace) {
                        println!("                 -> {}", target.display());
                    }
                }
                
                // List workspace files
                let ws_path = if workspace.is_symlink() {
                    std::fs::read_link(&workspace).unwrap_or(workspace.clone())
                } else {
                    workspace.clone()
                };
                if let Ok(entries) = std::fs::read_dir(&ws_path) {
                    let files: Vec<_> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .collect();
                    if !files.is_empty() {
                        println!("                 Files: {}", files.join(", "));
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
