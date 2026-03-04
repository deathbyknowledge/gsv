use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gsv::config;
use gsv::connection::Connection;
use gsv::gateway_client::GatewayClient;
use gsv::protocol::Frame;
use serde_json::json;

use crate::{
    ChannelAction, ConfigAction, DiscordAction, HeartbeatAction, PairAction, RegistryAction,
    RegistryConversationAction, RegistryInviteAction, RegistryMaintenanceAction,
    RegistryMemberAction, RegistryPendingAction, RegistryPrincipalAction, SessionAction,
    SkillsAction, ToolsAction, WhatsAppAction,
};

enum ChatSendResult {
    NoWait,
    Wait,
}

fn chat_event_matches_request(
    payload: &serde_json::Value,
    requested_session_key: Option<&str>,
    requested_thread_id: Option<&str>,
    expected_run_id: Option<&str>,
) -> bool {
    if let Some(run_id) = expected_run_id {
        return payload
            .get("runId")
            .and_then(|r| r.as_str())
            .map(|event_run_id| event_run_id == run_id)
            .unwrap_or(false);
    }

    if let Some(thread_id) = requested_thread_id {
        return payload
            .get("threadId")
            .and_then(|t| t.as_str())
            .map(|event_thread_id| event_thread_id == thread_id)
            .unwrap_or(false);
    }

    if let Some(session_key) = requested_session_key {
        return payload
            .get("sessionKey")
            .and_then(|s| s.as_str())
            .map(|event_session| event_session == session_key)
            .unwrap_or(false);
    }

    true
}

async fn wait_for_chat_response(response_received: &AtomicBool) {
    // Wait up to 120 seconds for LLM + tool execution.
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

fn truncate_for_display(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }

    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }

    format!("{}...", &text[..end])
}

fn normalize_optional_input(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn thread_id_from_ref(thread_ref: Option<&str>) -> Option<String> {
    let thread_ref = thread_ref?.trim();
    if thread_ref.is_empty() {
        return None;
    }

    if let Some(id) = thread_ref.strip_prefix("id:") {
        let normalized = id.trim();
        if normalized.is_empty() {
            None
        } else {
            Some(normalized.to_string())
        }
    } else {
        Some(thread_ref.to_string())
    }
}

pub(crate) async fn run_client(
    url: &str,
    token: Option<String>,
    message: Option<String>,
    session_key: Option<String>,
    thread_ref: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let session_key = normalize_optional_input(session_key);
    let thread_ref = normalize_optional_input(thread_ref);
    if session_key.is_none() && thread_ref.is_none() {
        return Err("sessionKey or threadRef required".into());
    }

    println!("Connecting to {}...", url);
    if let Some(thread_ref) = thread_ref.as_deref() {
        println!("Target thread: {}", thread_ref);
    } else if let Some(session_key) = session_key.as_deref() {
        println!("Target session: {}", session_key);
    }

    // Flag to track when we've received a final/error response
    let response_received = Arc::new(AtomicBool::new(false));
    let response_received_clone = response_received.clone();
    let expected_run_id = Arc::new(Mutex::new(None::<String>));
    let expected_run_id_clone = expected_run_id.clone();
    let session_key_owned = session_key.clone();
    let thread_id_owned = thread_id_from_ref(thread_ref.as_deref());

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
                        let expected_run_id = expected_run_id_clone
                            .lock()
                            .ok()
                            .and_then(|run_id| run_id.clone());

                        // Prefer runId filtering when available (authoritative for this request).
                        // Fall back to sessionKey filtering for older payloads.
                        if !chat_event_matches_request(
                            &payload,
                            session_key_owned.as_deref(),
                            thread_id_owned.as_deref(),
                            expected_run_id.as_deref(),
                        ) {
                            return;
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
                                    if let Ok(mut run_id) = expected_run_id_clone.lock() {
                                        *run_id = None;
                                    }
                                    response_received_clone.store(true, Ordering::SeqCst);
                                }
                                "error" => {
                                    if let Some(err) = payload.get("error").and_then(|e| e.as_str())
                                    {
                                        eprintln!("\nError: {}", err);
                                    }
                                    if let Ok(mut run_id) = expected_run_id_clone.lock() {
                                        *run_id = None;
                                    }
                                    response_received_clone.store(true, Ordering::SeqCst);
                                }
                                "paused" => {
                                    if let Some(msg) = payload.get("message") {
                                        if let Some(content) = msg.get("content") {
                                            println!("\nAssistant: {}", format_content(content));
                                        }
                                    } else {
                                        println!(
                                            "\nAssistant: Run is paused waiting for tool approval. Reply yes/no."
                                        );
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
        response_received.store(false, Ordering::SeqCst);
        if let Ok(mut run_id) = expected_run_id.lock() {
            *run_id = None;
        }

        let run_id = uuid::Uuid::new_v4().to_string();
        if let Ok(mut expected) = expected_run_id.lock() {
            *expected = Some(run_id.clone());
        }

        match send_chat(
            &gateway,
            session_key.clone(),
            thread_ref.clone(),
            &msg,
            &run_id,
        )
        .await?
        {
            ChatSendResult::NoWait => {
                if let Ok(mut expected) = expected_run_id.lock() {
                    *expected = None;
                }
            }
            ChatSendResult::Wait => {
                wait_for_chat_response(response_received.as_ref()).await;
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
            if let Ok(mut run_id) = expected_run_id.lock() {
                *run_id = None;
            }

            let run_id = uuid::Uuid::new_v4().to_string();
            if let Ok(mut expected) = expected_run_id.lock() {
                *expected = Some(run_id.clone());
            }

            match send_chat(
                &gateway,
                session_key.clone(),
                thread_ref.clone(),
                line,
                &run_id,
            )
            .await?
            {
                ChatSendResult::NoWait => {
                    if let Ok(mut expected) = expected_run_id.lock() {
                        *expected = None;
                    }
                }
                ChatSendResult::Wait => {
                    wait_for_chat_response(response_received.as_ref()).await;
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
            let requires_binding = payload
                .get("requiresBinding")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

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

            if requires_binding {
                println!(
                    "Profile binding is still required. Run: gsv registry pending approve <channel> <sender_id>"
                );
            }
        }

        PairAction::Reject { channel, sender_id } => {
            client.pair_reject(channel, sender_id).await?;
            println!("Rejected request removed");
        }
    }

    Ok(())
}

pub(crate) async fn run_registry(
    url: &str,
    token: Option<String>,
    action: RegistryAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = GatewayClient::connect(url, token).await?;

    match action {
        RegistryAction::Principal { action } => match action {
            RegistryPrincipalAction::List { offset, limit } => {
                let payload = client
                    .principal_profile_list(Some(offset), Some(limit))
                    .await?;

                let profiles = payload.get("profiles").and_then(|v| v.as_array());
                let count = payload.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                if let Some(profiles) = profiles {
                    if profiles.is_empty() {
                        println!("No principal profiles found");
                    } else {
                        println!("Principal profiles ({}):", count);
                        for entry in profiles {
                            let principal_id = entry
                                .get("principalId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let home_space = entry
                                .get("profile")
                                .and_then(|v| v.get("homeSpaceId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let home_agent = entry
                                .get("profile")
                                .and_then(|v| v.get("homeAgentId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("main");
                            let status = entry
                                .get("profile")
                                .and_then(|v| v.get("status"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("bound");
                            println!(
                                "  {} -> space={}, agent={}, status={}",
                                principal_id, home_space, home_agent, status
                            );
                        }
                    }
                }
            }
            RegistryPrincipalAction::Get { principal_id } => {
                let payload = client.principal_profile_get(principal_id.clone()).await?;
                if let Some(profile) = payload.get("profile") {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&json!({
                            "principalId": payload
                                .get("principalId")
                                .and_then(|v| v.as_str())
                                .unwrap_or(principal_id.as_str()),
                            "profile": profile
                        }))?
                    );
                } else {
                    println!("Principal profile not found: {}", principal_id);
                }
            }
            RegistryPrincipalAction::Put {
                principal_id,
                home_space_id,
                home_agent_id,
                status,
            } => {
                if let Some(status) = status.as_deref() {
                    if status != "bound" && status != "allowed_unbound" {
                        eprintln!("status must be 'bound' or 'allowed_unbound'");
                        return Ok(());
                    }
                }

                let payload = client
                    .principal_profile_put(
                        principal_id.clone(),
                        home_space_id.clone(),
                        home_agent_id,
                        status,
                    )
                    .await?;

                println!(
                    "Upserted principal profile: {} -> {}",
                    payload
                        .get("principalId")
                        .and_then(|v| v.as_str())
                        .unwrap_or(principal_id.as_str()),
                    payload
                        .get("profile")
                        .and_then(|v| v.get("homeSpaceId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(home_space_id.as_str())
                );
            }
            RegistryPrincipalAction::Delete { principal_id } => {
                let payload = client
                    .principal_profile_delete(principal_id.clone())
                    .await?;
                let removed = payload
                    .get("removed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if removed {
                    println!("Removed principal profile: {}", principal_id);
                } else {
                    println!("No principal profile removed for: {}", principal_id);
                }
            }
        },
        RegistryAction::Member { action } => match action {
            RegistryMemberAction::List {
                space_id,
                offset,
                limit,
            } => {
                let payload = client
                    .space_members_list(space_id.clone(), Some(offset), Some(limit))
                    .await?;
                let members = payload.get("members").and_then(|v| v.as_array());
                let count = payload.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                if let Some(members) = members {
                    if members.is_empty() {
                        if let Some(space_id) = space_id {
                            println!("No members found for space '{}'", space_id);
                        } else {
                            println!("No space members found");
                        }
                    } else {
                        println!("Space members ({}):", count);
                        for entry in members {
                            let space_id =
                                entry.get("spaceId").and_then(|v| v.as_str()).unwrap_or("?");
                            let principal_id = entry
                                .get("principalId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let role = entry
                                .get("member")
                                .and_then(|v| v.get("role"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("member");
                            println!("  {} <- {} ({})", space_id, principal_id, role);
                        }
                    }
                }
            }
            RegistryMemberAction::Put {
                space_id,
                principal_id,
                role,
            } => {
                client
                    .space_member_put(space_id.clone(), principal_id.clone(), role.clone())
                    .await?;
                println!(
                    "Set member: space={} principal={} role={}",
                    space_id, principal_id, role
                );
            }
            RegistryMemberAction::Remove {
                space_id,
                principal_id,
            } => {
                let payload = client
                    .space_member_remove(space_id.clone(), principal_id.clone())
                    .await?;
                let removed = payload
                    .get("removed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if removed {
                    println!(
                        "Removed member: space={} principal={}",
                        space_id, principal_id
                    );
                } else {
                    println!(
                        "No member removed: space={} principal={}",
                        space_id, principal_id
                    );
                }
            }
        },
        RegistryAction::Conversation { action } => match action {
            RegistryConversationAction::List { offset, limit } => {
                let payload = client
                    .conversation_bindings_list(Some(offset), Some(limit))
                    .await?;
                let bindings = payload.get("bindings").and_then(|v| v.as_array());
                let count = payload.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                if let Some(bindings) = bindings {
                    if bindings.is_empty() {
                        println!("No conversation bindings found");
                    } else {
                        println!("Conversation bindings ({}):", count);
                        for entry in bindings {
                            let surface_id = entry
                                .get("surfaceId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let space_id = entry
                                .get("binding")
                                .and_then(|v| v.get("spaceId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let agent_id = entry
                                .get("binding")
                                .and_then(|v| v.get("agentId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("main");
                            let group_mode = entry
                                .get("binding")
                                .and_then(|v| v.get("groupMode"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("group-shared");
                            println!(
                                "  {} -> space={}, agent={}, mode={}",
                                surface_id, space_id, agent_id, group_mode
                            );
                        }
                    }
                }
            }
            RegistryConversationAction::Put {
                surface_id,
                space_id,
                agent_id,
                group_mode,
            } => {
                if let Some(mode) = group_mode.as_deref() {
                    if mode != "group-shared" && mode != "per-user-in-group" && mode != "hybrid" {
                        eprintln!(
                            "group-mode must be one of: group-shared, per-user-in-group, hybrid"
                        );
                        return Ok(());
                    }
                }
                client
                    .conversation_binding_put(
                        surface_id.clone(),
                        space_id.clone(),
                        agent_id.clone(),
                        group_mode.clone(),
                    )
                    .await?;
                println!(
                    "Set conversation binding: {} -> space={}{}{}",
                    surface_id,
                    space_id,
                    agent_id
                        .as_ref()
                        .map(|v| format!(", agent={}", v))
                        .unwrap_or_default(),
                    group_mode
                        .as_ref()
                        .map(|v| format!(", mode={}", v))
                        .unwrap_or_default(),
                );
            }
            RegistryConversationAction::Remove { surface_id } => {
                let payload = client
                    .conversation_binding_remove(surface_id.clone())
                    .await?;
                let removed = payload
                    .get("removed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if removed {
                    println!("Removed conversation binding: {}", surface_id);
                } else {
                    println!("No conversation binding removed for: {}", surface_id);
                }
            }
        },
        RegistryAction::Pending { action } => match action {
            RegistryPendingAction::List => {
                let payload = client.pending_bindings_list().await?;
                let pending = payload.get("pending").and_then(|v| v.as_array());
                let count = payload.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                if let Some(pending) = pending {
                    if pending.is_empty() {
                        println!("No pending bindings");
                    } else {
                        println!("Pending bindings ({}):", count);
                        for entry in pending {
                            let key = entry.get("key").and_then(|v| v.as_str()).unwrap_or("?");
                            let stage = entry
                                .get("pair")
                                .and_then(|v| v.get("stage"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("pairing");
                            let account_id = entry
                                .get("pair")
                                .and_then(|v| v.get("accountId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("default");
                            let principal_id = entry
                                .get("pair")
                                .and_then(|v| v.get("principalId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("-");
                            let sender_name = entry
                                .get("pair")
                                .and_then(|v| v.get("senderName"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            let first_message = entry
                                .get("pair")
                                .and_then(|v| v.get("firstMessage"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            println!(
                                "  {} ({}) stage={} account={} principal={}",
                                key, sender_name, stage, account_id, principal_id
                            );
                            if !first_message.is_empty() {
                                println!("    msg: {}", first_message);
                            }
                        }
                    }
                }
            }
            RegistryPendingAction::Approve {
                channel,
                sender_id,
                account_id,
                principal_id,
                home_space_id,
                home_agent_id,
                role,
            } => {
                let payload = client
                    .pending_binding_resolve(
                        channel.clone(),
                        sender_id.clone(),
                        "approve".to_string(),
                        account_id,
                        principal_id,
                        home_space_id,
                        home_agent_id,
                        role,
                    )
                    .await?;

                println!(
                    "Approved pending binding for {}",
                    payload
                        .get("senderId")
                        .and_then(|v| v.as_str())
                        .unwrap_or(sender_id.as_str())
                );
                if let Some(principal_id) = payload.get("principalId").and_then(|v| v.as_str()) {
                    println!("  principalId: {}", principal_id);
                }
                if let Some(home_space_id) = payload.get("homeSpaceId").and_then(|v| v.as_str()) {
                    println!("  homeSpaceId: {}", home_space_id);
                }
                if let Some(role) = payload.get("role").and_then(|v| v.as_str()) {
                    println!("  role: {}", role);
                }
            }
            RegistryPendingAction::Reject { channel, sender_id } => {
                client
                    .pending_binding_resolve(
                        channel,
                        sender_id.clone(),
                        "reject".to_string(),
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                    .await?;
                println!("Rejected pending binding for {}", sender_id);
            }
        },
        RegistryAction::Invite { action } => match action {
            RegistryInviteAction::List {
                include_inactive,
                offset,
                limit,
            } => {
                let payload = client
                    .invite_list(Some(offset), Some(limit), Some(include_inactive))
                    .await?;
                let invites = payload.get("invites").and_then(|v| v.as_array());
                let count = payload.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                if let Some(invites) = invites {
                    if invites.is_empty() {
                        println!("No invites found");
                    } else {
                        println!("Invites ({}):", count);
                        for entry in invites {
                            let invite_id = entry
                                .get("inviteId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let code = entry
                                .get("invite")
                                .and_then(|v| v.get("code"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let status = entry
                                .get("invite")
                                .and_then(|v| v.get("status"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let home_space = entry
                                .get("invite")
                                .and_then(|v| v.get("homeSpaceId"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let role = entry
                                .get("invite")
                                .and_then(|v| v.get("role"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("member");
                            println!(
                                "  {} code={} status={} space={} role={}",
                                invite_id, code, status, home_space, role
                            );
                        }
                    }
                }
            }
            RegistryInviteAction::Create {
                home_space_id,
                code,
                home_agent_id,
                role,
                principal_id,
                ttl_minutes,
            } => {
                let payload = client
                    .invite_create(
                        home_space_id.clone(),
                        code,
                        home_agent_id,
                        role,
                        principal_id,
                        ttl_minutes,
                    )
                    .await?;
                let invite = payload.get("invite").cloned().unwrap_or_else(|| json!({}));
                println!("{}", serde_json::to_string_pretty(&invite)?);
            }
            RegistryInviteAction::Revoke { invite_id } => {
                let payload = client.invite_revoke(invite_id.clone()).await?;
                let revoked = payload
                    .get("revoked")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if revoked {
                    println!("Revoked invite {}", invite_id);
                } else {
                    println!("No invite revoked for {}", invite_id);
                }
            }
            RegistryInviteAction::Claim {
                code,
                principal_id,
                channel,
                account_id,
                sender_id,
            } => {
                let payload = client
                    .invite_claim(code.clone(), principal_id, channel, account_id, sender_id)
                    .await?;
                println!(
                    "Claimed invite {} for {}",
                    payload
                        .get("inviteId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?"),
                    payload
                        .get("principalId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                );
                if let Some(space) = payload.get("homeSpaceId").and_then(|v| v.as_str()) {
                    println!("  homeSpaceId: {}", space);
                }
                if let Some(role) = payload.get("role").and_then(|v| v.as_str()) {
                    println!("  role: {}", role);
                }
            }
        },
        RegistryAction::Maintenance { action } => match action {
            RegistryMaintenanceAction::Backfill { dry_run, limit } => {
                let payload = client.registry_backfill(Some(dry_run), limit).await?;

                println!(
                    "Registry backfill (dryRun={}): scanned={}, migrated={}, threadMetaCreated={}, sessionsUpdated={}, legacyIndexAdded={}, skipped={}",
                    payload.get("dryRun").and_then(|v| v.as_bool()).unwrap_or(dry_run),
                    payload.get("scanned").and_then(|v| v.as_i64()).unwrap_or(0),
                    payload.get("migrated").and_then(|v| v.as_i64()).unwrap_or(0),
                    payload
                        .get("createdThreadMeta")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("updatedSessions")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("addedLegacyIndex")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload.get("skipped").and_then(|v| v.as_i64()).unwrap_or(0),
                );
            }
            RegistryMaintenanceAction::Repair {
                dry_run,
                prune_dangling_routes,
                prune_dangling_legacy_index,
            } => {
                let payload = client
                    .registry_repair(
                        Some(dry_run),
                        Some(prune_dangling_routes),
                        Some(prune_dangling_legacy_index),
                    )
                    .await?;

                println!(
                    "Registry repair (dryRun={}): sessionsScanned={}, routesScanned={}, legacyScanned={}, threadMetaCreated={}, sessionsUpdated={}, legacyIndexAdded={}, routesRemoved={}, legacyRemoved={}",
                    payload.get("dryRun").and_then(|v| v.as_bool()).unwrap_or(dry_run),
                    payload
                        .get("scannedSessions")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("scannedThreadRoutes")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("scannedLegacyIndex")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("createdThreadMeta")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("updatedSessions")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("addedLegacyIndex")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("removedDanglingRoutes")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    payload
                        .get("removedDanglingLegacyIndex")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                );
            }
        },
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
    let payload = match action {
        SkillsAction::Status { agent_id } => client.skills_status(agent_id).await?,
        SkillsAction::Update { agent_id } => client.skills_update(agent_id).await?,
    };
    let agent_id = payload
        .get("agentId")
        .and_then(|v| v.as_str())
        .unwrap_or("main");
    println!("Agent: {}", agent_id);

    if let Some(nodes) = payload.get("nodes").and_then(|v| v.as_array()) {
        println!("\nNodes:");
        if nodes.is_empty() {
            println!("  (none connected)");
        } else {
            for node in nodes {
                let node_id = node.get("nodeId").and_then(|v| v.as_str()).unwrap_or("?");
                let online = node
                    .get("online")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let capabilities = node
                    .get("hostCapabilities")
                    .and_then(|v| v.as_array())
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| entry.as_str())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                println!(
                    "  - {} ({}) capabilities={}",
                    node_id,
                    if online { "online" } else { "offline" },
                    if capabilities.is_empty() {
                        "none".to_string()
                    } else {
                        capabilities.join(", ")
                    }
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

fn resolve_session_target(
    session_key: String,
    thread_ref: Option<String>,
) -> (Option<String>, Option<String>, String) {
    let normalized_thread_ref = normalize_optional_input(thread_ref);
    if let Some(thread_ref) = normalized_thread_ref {
        let label = format!("thread {}", thread_ref);
        return (None, Some(thread_ref), label);
    }

    let normalized_session = config::normalize_session_key(&session_key);
    let label = format!("session {}", normalized_session);
    (Some(normalized_session), None, label)
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
                        let thread_id = session.get("threadId").and_then(|t| t.as_str());
                        let label = session.get("label").and_then(|l| l.as_str());
                        let last_active = session.get("lastActiveAt").and_then(|t| t.as_i64());

                        let last_active_str = last_active
                            .and_then(|ts| chrono::DateTime::from_timestamp_millis(ts))
                            .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                            .unwrap_or_else(|| "?".to_string());

                        let thread_suffix = thread_id
                            .map(|id| format!(" [id:{}]", id))
                            .unwrap_or_default();
                        if let Some(label) = label {
                            println!(
                                "  {}{} ({}) - last active: {}",
                                key, thread_suffix, label, last_active_str
                            );
                        } else {
                            println!(
                                "  {}{} - last active: {}",
                                key, thread_suffix, last_active_str
                            );
                        }
                    }
                }
            }
        }

        SessionAction::Reset {
            session_key,
            thread_ref,
        } => {
            let (session_key, thread_ref, target_label) =
                resolve_session_target(session_key, thread_ref);
            let payload = client.session_reset(session_key, thread_ref).await?;
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

            println!("Reset {}", target_label);
            if let Some(resolved_session_key) = payload.get("sessionKey").and_then(|s| s.as_str()) {
                println!("  Session key: {}", resolved_session_key);
            }
            if let Some(thread_id) = payload.get("threadId").and_then(|t| t.as_str()) {
                println!("  Thread ref: id:{}", thread_id);
            }
            println!("  Old session ID: {}", &old_id[..8.min(old_id.len())]);
            println!("  New session ID: {}", &new_id[..8.min(new_id.len())]);
            println!("  Archived {} messages ({} tokens)", archived, total_tokens);
            if let Some(path) = payload.get("archivedTo").and_then(|p| p.as_str()) {
                println!("  Archived to: {}", path);
            }
        }

        SessionAction::Get {
            session_key,
            thread_ref,
        } => {
            let (session_key, thread_ref, target_label) =
                resolve_session_target(session_key, thread_ref);
            let payload = client.session_get(session_key, thread_ref).await?;
            println!("Target: {}", target_label);
            if let Some(resolved_session_key) = payload.get("sessionKey").and_then(|s| s.as_str()) {
                println!("  Session key: {}", resolved_session_key);
            }
            if let Some(thread_id) = payload.get("threadId").and_then(|t| t.as_str()) {
                println!("  Thread ref: id:{}", thread_id);
            }
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
        SessionAction::Stats {
            session_key,
            thread_ref,
        } => {
            let (session_key, thread_ref, target_label) =
                resolve_session_target(session_key, thread_ref);
            let payload = client.session_stats(session_key, thread_ref).await?;
            println!("Session stats: {}", target_label);
            if let Some(resolved_session_key) = payload.get("sessionKey").and_then(|s| s.as_str()) {
                println!("  Session key: {}", resolved_session_key);
            }
            if let Some(thread_id) = payload.get("threadId").and_then(|t| t.as_str()) {
                println!("  Thread ref: id:{}", thread_id);
            }
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
            thread_ref,
            path,
            value,
        } => {
            let (session_key, thread_ref, target_label) =
                resolve_session_target(session_key, thread_ref);
            // Build the patch params based on the path
            let parsed_value: serde_json::Value = serde_json::from_str(&value)
                .unwrap_or_else(|_| serde_json::Value::String(value.clone()));

            let mut params = json!({});
            if let Some(session_key) = session_key {
                params["sessionKey"] = json!(session_key);
            }
            if let Some(thread_ref) = thread_ref {
                params["threadRef"] = json!(thread_ref);
            }

            match path.as_str() {
                "label" => {
                    params["label"] = parsed_value;
                }
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

                    params["settings"] = settings;
                }
                p if p.starts_with("resetPolicy.") || p == "resetPolicy" => {
                    let policy_path = if p.starts_with("resetPolicy.") {
                        &p[12..] // Remove "resetPolicy." prefix
                    } else {
                        "mode"
                    };

                    let mut policy = json!({});
                    policy[policy_path] = parsed_value;

                    params["resetPolicy"] = policy;
                }
                _ => {
                    eprintln!("Unknown setting path: {}", path);
                    eprintln!("Valid paths: label, model.provider, model.id, thinkingLevel, systemPrompt, maxTokens, resetPolicy.mode, resetPolicy.atHour, resetPolicy.idleMinutes");
                    return Ok(());
                }
            }

            client.session_patch(params).await?;
            println!("Updated {} = {} for {}", path, value, target_label);
        }

        SessionAction::Compact {
            session_key,
            thread_ref,
            keep,
        } => {
            let (session_key, thread_ref, target_label) =
                resolve_session_target(session_key, thread_ref);
            let payload = client
                .session_compact(session_key, thread_ref, keep)
                .await?;
            let trimmed = payload
                .get("trimmedMessages")
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            let kept = payload
                .get("keptMessages")
                .and_then(|c| c.as_i64())
                .unwrap_or(0);

            if trimmed > 0 {
                println!("Compacted {}", target_label);
                if let Some(thread_id) = payload.get("threadId").and_then(|t| t.as_str()) {
                    println!("  Thread ref: id:{}", thread_id);
                }
                println!("  Trimmed {} messages, kept {}", trimmed, kept);
                if let Some(path) = payload.get("archivedTo").and_then(|p| p.as_str()) {
                    println!("  Archived to: {}", path);
                }
            } else {
                println!(
                    "{} has {} messages (no compaction needed)",
                    target_label, kept
                );
            }
        }

        SessionAction::History {
            session_key,
            thread_ref,
        } => {
            let (session_key, thread_ref, target_label) =
                resolve_session_target(session_key, thread_ref);
            let payload = client.session_history(session_key, thread_ref).await?;
            let current = payload
                .get("currentSessionId")
                .and_then(|s| s.as_str())
                .unwrap_or("?");
            let previous = payload.get("previousSessionIds").and_then(|p| p.as_array());

            println!("Session history: {}", target_label);
            if let Some(thread_id) = payload.get("threadId").and_then(|t| t.as_str()) {
                println!("  Thread ref: id:{}", thread_id);
            }
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

        SessionAction::Preview {
            session_key,
            thread_ref,
            limit,
        } => {
            let (session_key, thread_ref, target_label) =
                resolve_session_target(session_key, thread_ref);
            let payload = client
                .session_preview(session_key, thread_ref, limit)
                .await?;
            let msg_count = payload
                .get("messageCount")
                .and_then(|c| c.as_i64())
                .unwrap_or(0);
            let messages = payload.get("messages").and_then(|m| m.as_array());

            println!("Session: {} ({} messages total)\n", target_label, msg_count);

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
                                            println!("{}", truncate_for_display(text, 200));
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
    session_key: Option<String>,
    thread_ref: Option<String>,
    message: &str,
    run_id: &str,
) -> Result<ChatSendResult, Box<dyn std::error::Error>> {
    let payload = client
        .chat_send(
            session_key,
            thread_ref,
            message.to_string(),
            run_id.to_string(),
        )
        .await?;

    if let Some(session_key) = payload.get("sessionKey").and_then(|s| s.as_str()) {
        if let Some(thread_id) = payload.get("threadId").and_then(|t| t.as_str()) {
            println!("Session: {}  Thread: id:{}", session_key, thread_id);
        }
    }

    if let Some(status) = payload.get("status").and_then(|s| s.as_str()) {
        match status {
            "command" => {
                if let Some(response) = payload.get("response").and_then(|r| r.as_str()) {
                    println!("{}", response);
                }
                if let Some(error) = payload.get("error").and_then(|e| e.as_str()) {
                    eprintln!("Error: {}", error);
                }
                return Ok(ChatSendResult::NoWait);
            }
            "directive-only" => {
                if let Some(response) = payload.get("response").and_then(|r| r.as_str()) {
                    println!("{}", response);
                }
                return Ok(ChatSendResult::NoWait);
            }
            "paused" => {
                if let Some(response) = payload.get("response").and_then(|r| r.as_str()) {
                    println!("{}", response);
                } else {
                    println!("Run is paused waiting for tool approval. Reply yes/no.");
                }
                return Ok(ChatSendResult::NoWait);
            }
            _ => {}
        }
    }

    Ok(ChatSendResult::Wait)
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

#[cfg(test)]
mod tests {
    use super::{chat_event_matches_request, truncate_for_display};
    use serde_json::json;

    #[test]
    fn chat_event_matches_by_run_id_when_present() {
        let payload = json!({
            "runId": "run-123",
            "sessionKey": "agent:main:main",
        });
        assert!(chat_event_matches_request(
            &payload,
            Some("agent:main:cli:dm:main"),
            None,
            Some("run-123"),
        ));
    }

    #[test]
    fn chat_event_rejects_non_matching_run_id() {
        let payload = json!({
            "runId": "run-456",
            "sessionKey": "agent:main:main",
        });
        assert!(!chat_event_matches_request(
            &payload,
            Some("agent:main:cli:dm:main"),
            None,
            Some("run-123"),
        ));
    }

    #[test]
    fn chat_event_falls_back_to_session_key_without_run_id() {
        let payload = json!({
            "sessionKey": "agent:main:cli:dm:main",
        });
        assert!(chat_event_matches_request(
            &payload,
            Some("agent:main:cli:dm:main"),
            None,
            None,
        ));
    }

    #[test]
    fn chat_event_rejects_other_session_without_run_id() {
        let payload = json!({
            "sessionKey": "agent:main:main",
        });
        assert!(!chat_event_matches_request(
            &payload,
            Some("agent:main:cli:dm:main"),
            None,
            None,
        ));
    }

    #[test]
    fn chat_event_matches_thread_id_without_run_id() {
        let payload = json!({
            "threadId": "01abc",
        });
        assert!(chat_event_matches_request(
            &payload,
            None,
            Some("01abc"),
            None,
        ));
    }

    #[test]
    fn truncate_for_display_keeps_short_text_unchanged() {
        let text = "hello";
        assert_eq!(truncate_for_display(text, 200), "hello");
    }

    #[test]
    fn truncate_for_display_respects_utf8_boundaries() {
        let text = "a".repeat(199) + "─tail";
        let truncated = truncate_for_display(&text, 200);

        assert!(truncated.ends_with("..."));
        assert_eq!(truncated, format!("{}...", "a".repeat(199)));
    }
}
