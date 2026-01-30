mod connection;
mod protocol;
mod tools;

use clap::{Parser, Subcommand};
use connection::Connection;
use protocol::{Frame, ToolInvokePayload, ToolResultParams};
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tools::{all_tools, Tool};

#[derive(Parser)]
#[command(name = "gsv", about = "GSV CLI - Client and Node for GSV Gateway")]
struct Cli {
    #[arg(short, long, default_value = "ws://localhost:8787/ws")]
    url: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Send a message to the agent (interactive or one-shot)
    Client {
        /// Message to send (if omitted, enters interactive mode)
        message: Option<String>,
        
        /// Session key (default: "main")
        #[arg(short, long, default_value = "main")]
        session: String,
    },
    
    /// Run as a tool-providing node
    Node {
        /// Node ID (default: hostname)
        #[arg(long)]
        id: Option<String>,
    },
    
    /// Get or set configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    
    /// Manage sessions
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    
    /// List available tools
    Tools,
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
enum SessionAction {
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
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Client { message, session } => run_client(&cli.url, message, &session).await,
        Commands::Node { id } => run_node(&cli.url, id).await,
        Commands::Config { action } => run_config(&cli.url, action).await,
        Commands::Session { action } => run_session(&cli.url, action).await,
        Commands::Tools => run_tools(&cli.url).await,
    }
}

async fn run_client(
    url: &str,
    message: Option<String>,
    session_key: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("Connecting to {}...", url);

    // Flag to track when we've received a final/error response
    let response_received = Arc::new(AtomicBool::new(false));
    let response_received_clone = response_received.clone();
    let session_key_owned = session_key.to_string();

    let conn = Connection::connect(url, "client", None, move |frame| {
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
    })
    .await?;

    if let Some(msg) = message {
        // One-shot mode: send message and wait for response
        send_chat(&conn, session_key, &msg).await?;
        
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
            
            send_chat(&conn, session_key, line).await?;
            
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
            
            print!("\n> ");
            let _ = io::stdout().flush();
        }
    }

    Ok(())
}

async fn send_chat(
    conn: &Connection,
    session_key: &str,
    message: &str,
) -> Result<(), Box<dyn std::error::Error>> {
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
    }

    Ok(())
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

async fn run_config(url: &str, action: ConfigAction) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::connect(url, "client", None, |_| {}).await?;

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

async fn run_tools(url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::connect(url, "client", None, |_| {}).await?;

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

async fn run_session(url: &str, action: SessionAction) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::connect(url, "client", None, |_| {}).await?;

    match action {
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
    }

    Ok(())
}

async fn run_node(url: &str, node_id: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    // Resolve node ID: use provided, or fall back to hostname
    let node_id = node_id.unwrap_or_else(|| {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        format!("node-{}", hostname)
    });
    
    loop {
        println!("Connecting as node '{}' to {}...", node_id, url);

        let tools = all_tools();
        let tool_defs: Vec<_> = tools.iter().map(|t| t.definition()).collect();

        println!(
            "Registering tools: {:?}",
            tool_defs.iter().map(|t| &t.name).collect::<Vec<_>>()
        );

        let tools_for_handler: Arc<Vec<Box<dyn Tool>>> = Arc::new(all_tools());

        let conn = match Connection::connect_with_id(url, "node", Some(tool_defs), |_frame| {}, Some(node_id.clone())).await {
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
