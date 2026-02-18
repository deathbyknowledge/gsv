use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gsv::config;
use gsv::connection::Connection;
use gsv::gateway_client::GatewayClient;
use gsv::protocol::Frame;
use serde_json::json;

use crate::{
    ChannelAction, ConfigAction, DiscordAction, HeartbeatAction, PairAction, SessionAction,
    SkillsAction, ToolsAction, WhatsAppAction,
};

pub(crate) async fn run_client(
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
    let gateway = GatewayClient::new(conn);

    if let Some(msg) = message {
        // One-shot mode: send message and wait for response
        let was_command = send_chat(&gateway, session_key, &msg).await?;

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

            let was_command = send_chat(&gateway, session_key, line).await?;

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

pub(crate) async fn run_heartbeat(
    url: &str,
    token: Option<String>,
    action: HeartbeatAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    match action {
        HeartbeatAction::Status => {
            let payload = client.heartbeat_status().await?;

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

        HeartbeatAction::Start => {
            let payload = client.heartbeat_start().await?;

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

        HeartbeatAction::Trigger { agent_id } => {
            let payload = client.heartbeat_trigger(agent_id).await?;

            if let Some(msg) = payload.get("message").and_then(|m| m.as_str()) {
                println!("{}", msg);
            }
        }
    }

    Ok(())
}

pub(crate) async fn run_pair(
    url: &str,
    token: Option<String>,
    action: PairAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    match action {
        PairAction::List => {
            let payload = client.pair_list().await?;

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

                        if let Some(requested_at) = pair.get("requestedAt").and_then(|t| t.as_i64())
                        {
                            let dt = chrono::DateTime::from_timestamp_millis(requested_at);
                            if let Some(dt) = dt {
                                println!("  {} ({}) via {}", sender_name, sender_id, channel);
                                println!("    Requested: {}", dt.format("%Y-%m-%d %H:%M:%S"));
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
            } else {
                eprintln!("No pairing data returned");
            }
        }

        PairAction::Approve { channel, sender_id } => {
            let requested_sender_id = sender_id.clone();
            let payload = client.pair_approve(channel, sender_id).await?;

            let approved_id = payload
                .get("senderId")
                .and_then(|s| s.as_str())
                .unwrap_or(requested_sender_id.as_str());
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

        PairAction::Reject { channel, sender_id } => {
            client.pair_reject(channel, sender_id).await?;
            println!("Rejected request removed");
        }
    }

    Ok(())
}

pub(crate) async fn run_channel(
    action: ChannelAction,
    url: &str,
    token: Option<String>,
    _cfg: &gsv::config::CliConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        ChannelAction::Whatsapp { action } => run_whatsapp_via_gateway(url, token, action).await,
        ChannelAction::Discord { action } => run_discord_via_gateway(url, token, action).await,
        ChannelAction::List => run_channels_list(url, token).await,
    }
}

pub(crate) async fn run_channels_list(
    url: &str,
    token: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    let payload = client.channels_list().await?;

    if let Some(channels) = payload.get("channels").and_then(|c| c.as_array()) {
        if channels.is_empty() {
            println!("No channel accounts connected");
        } else {
            println!("Connected channel accounts ({}):\n", channels.len());
            for ch in channels {
                let channel = ch.get("channel").and_then(|c| c.as_str()).unwrap_or("?");
                let account_id = ch.get("accountId").and_then(|a| a.as_str()).unwrap_or("?");
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

    Ok(())
}

pub(crate) async fn run_whatsapp_via_gateway(
    url: &str,
    token: Option<String>,
    action: WhatsAppAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    match action {
        WhatsAppAction::Login { account_id } => {
            println!("Logging in to WhatsApp account: {}", account_id);

            let payload = client
                .channel_login("whatsapp".to_string(), account_id)
                .await?;

            if let Some(qr_data_url) = payload.get("qrDataUrl").and_then(|q| q.as_str()) {
                // qrDataUrl is a data URL, extract the QR data
                println!("\nScan this QR code with WhatsApp:\n");

                // The qrDataUrl from WhatsApp channel is actually the raw QR string
                // Try to render it
                render_qr_terminal(qr_data_url)?;
                println!("\nQR code expires in ~20 seconds. Re-run command if needed.");
            } else if let Some(msg) = payload.get("message").and_then(|m| m.as_str()) {
                println!("{}", msg);
            } else if let Some(msg) = payload.get("status").and_then(|m| m.as_str()) {
                println!("{}", msg);
            }
        }

        WhatsAppAction::Status { account_id } => {
            let payload = client
                .channel_status("whatsapp".to_string(), account_id)
                .await?;

            if let Some(accounts) = payload.get("accounts").and_then(|a| a.as_array()) {
                if accounts.is_empty() {
                    println!("No WhatsApp accounts found");
                } else {
                    for acc in accounts {
                        let acc_id = acc.get("accountId").and_then(|a| a.as_str()).unwrap_or("?");
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
                            if let Some(jid) = extra.get("selfJid").and_then(|e| e.as_str()) {
                                println!("  JID: {}", jid);
                            }
                            if let Some(e164) = extra.get("selfE164").and_then(|e| e.as_str()) {
                                println!("  Phone: {}", e164);
                            }
                        }

                        if let Some(last) = acc.get("lastActivity").and_then(|t| t.as_i64()) {
                            if let Some(dt) = chrono::DateTime::from_timestamp_millis(last) {
                                println!("  Last activity: {}", dt.format("%Y-%m-%d %H:%M:%S"));
                            }
                        }
                    }
                }
            }
        }

        WhatsAppAction::Logout { account_id } => {
            println!("Logging out WhatsApp account: {}", account_id);
            client
                .channel_logout("whatsapp".to_string(), account_id)
                .await?;
            println!("Logged out successfully. Credentials cleared.");
        }

        WhatsAppAction::Stop { account_id } => {
            println!("Stopping WhatsApp account: {}", account_id);
            client
                .channel_stop("whatsapp".to_string(), account_id)
                .await?;
            println!("Stopped.");
        }
    }

    Ok(())
}

pub(crate) async fn run_discord_via_gateway(
    url: &str,
    token: Option<String>,
    action: DiscordAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    match action {
        DiscordAction::Start { account_id } => {
            println!("Starting Discord bot account: {}", account_id);

            client
                .channel_start("discord".to_string(), account_id)
                .await?;
            println!("Discord bot started successfully.");
            println!(
                "\nThe bot will connect using the DISCORD_BOT_TOKEN configured on the channel worker."
            );
        }

        DiscordAction::Status { account_id } => {
            let payload = client
                .channel_status("discord".to_string(), account_id)
                .await?;

            if let Some(accounts) = payload.get("accounts").and_then(|a| a.as_array()) {
                if accounts.is_empty() {
                    println!("No Discord accounts found");
                } else {
                    for acc in accounts {
                        let acc_id = acc.get("accountId").and_then(|a| a.as_str()).unwrap_or("?");
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
                                if let Some(id) = bot_user.get("id").and_then(|i| i.as_str()) {
                                    println!("  Bot ID: {}", id);
                                }
                            }
                        }

                        if let Some(last) = acc.get("lastActivity").and_then(|t| t.as_i64()) {
                            if let Some(dt) = chrono::DateTime::from_timestamp_millis(last) {
                                println!("  Last activity: {}", dt.format("%Y-%m-%d %H:%M:%S"));
                            }
                        }
                    }
                }
            }
        }

        DiscordAction::Stop { account_id } => {
            println!("Stopping Discord bot account: {}", account_id);
            client
                .channel_stop("discord".to_string(), account_id)
                .await?;
            println!("Stopped.");
        }
    }

    Ok(())
}

pub(crate) async fn run_config(
    url: &str,
    token: Option<String>,
    action: ConfigAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    match action {
        ConfigAction::Get { path } => {
            let payload = client.config_get(path).await?;
            println!("{}", serde_json::to_string_pretty(&payload)?);
        }
        ConfigAction::Set { path, value } => {
            // Try to parse value as JSON, fall back to string
            let parsed_value: serde_json::Value = serde_json::from_str(&value)
                .unwrap_or_else(|_| serde_json::Value::String(value.clone()));
            client.config_set(path.clone(), parsed_value).await?;
            println!("Set {} successfully", path);
        }
    }

    Ok(())
}

pub(crate) async fn run_tools(
    url: &str,
    token: Option<String>,
    action: ToolsAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    match action {
        ToolsAction::List => {
            let payload = client.tools_list().await?;
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
            } else {
                println!("No tools available (is a node connected?)");
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

            let payload = client.tool_invoke(tool.clone(), args).await?;
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
    }

    Ok(())
}

pub(crate) async fn run_skills(
    url: &str,
    token: Option<String>,
    action: SkillsAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;
    let (payload, is_update) = match action {
        SkillsAction::Status { agent_id } => (client.skills_status(agent_id).await?, false),
        SkillsAction::Update {
            agent_id,
            force,
            timeout_ms,
        } => (
            client.skills_update(agent_id, force, timeout_ms).await?,
            true,
        ),
    };
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

    if is_update {
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

pub(crate) async fn run_session(
    url: &str,
    token: Option<String>,
    action: SessionAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    match action {
        SessionAction::List { limit } => {
            let payload = client.sessions_list(limit).await?;
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
                        let last_active = session.get("lastActiveAt").and_then(|t| t.as_i64());

                        let last_active_str = last_active
                            .and_then(|ts| chrono::DateTime::from_timestamp_millis(ts))
                            .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                            .unwrap_or_else(|| "?".to_string());

                        if let Some(label) = label {
                            println!("  {} ({}) - last active: {}", key, label, last_active_str);
                        } else {
                            println!("  {} - last active: {}", key, last_active_str);
                        }
                    }
                }
            }
        }

        SessionAction::Reset { session_key } => {
            let session_key = config::normalize_session_key(&session_key);
            let payload = client.session_reset(session_key.clone()).await?;
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

        SessionAction::Get { session_key } => {
            let session_key = config::normalize_session_key(&session_key);
            let payload = client.session_get(session_key.clone()).await?;
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
        SessionAction::Stats { session_key } => {
            let session_key = config::normalize_session_key(&session_key);
            let payload = client.session_stats(session_key.clone()).await?;
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

            client.session_patch(params).await?;
            println!("Updated {} = {} for session '{}'", path, value, session_key);
        }

        SessionAction::Compact { session_key, keep } => {
            let session_key = config::normalize_session_key(&session_key);
            let payload = client.session_compact(session_key.clone(), keep).await?;
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

        SessionAction::History { session_key } => {
            let session_key = config::normalize_session_key(&session_key);
            let payload = client.session_history(session_key.clone()).await?;
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

        SessionAction::Preview { session_key, limit } => {
            let session_key = config::normalize_session_key(&session_key);
            let payload = client.session_preview(session_key.clone(), limit).await?;
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
                                        if let Some(block_type) =
                                            block.get("type").and_then(|t| t.as_str())
                                        {
                                            match block_type {
                                                "text" => {
                                                    if let Some(text) =
                                                        block.get("text").and_then(|t| t.as_str())
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
    }

    Ok(())
}

async fn send_chat(
    client: &GatewayClient,
    session_key: &str,
    message: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let payload = client
        .chat_send(session_key.to_string(), message.to_string())
        .await?;

    if let Some(status) = payload.get("status").and_then(|s| s.as_str()) {
        match status {
            "command" => {
                if let Some(response) = payload.get("response").and_then(|r| r.as_str()) {
                    println!("{}", response);
                }
                if let Some(error) = payload.get("error").and_then(|e| e.as_str()) {
                    eprintln!("Error: {}", error);
                }
                return Ok(true);
            }
            "directive-only" => {
                if let Some(response) = payload.get("response").and_then(|r| r.as_str()) {
                    println!("{}", response);
                }
                return Ok(true);
            }
            _ => {}
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
