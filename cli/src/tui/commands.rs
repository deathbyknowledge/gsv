use crate::gateway_client::GatewayClient;
use crate::tui::state::{
    self, AppState, MessageRole, ToolVerbosity,
};

/// Outcome of executing a slash command.
pub enum CommandResult {
    /// Exit the TUI.
    Quit,
    /// Command handled; just redraw.
    Handled,
    /// Not a command -- treat as chat message.
    NotCommand,
    /// Unknown slash command -- forward to gateway via chat.send so the
    /// server can handle commands like /reset, /model, /think, /stop, etc.
    Forward,
}

/// Determine whether the line is a quit alias *before* splitting into parts.
fn is_quit(line: &str) -> bool {
    matches!(
        line,
        "quit" | "exit" | "/quit" | "/exit" | "/q"
    )
}

/// Execute a slash command (or detect it isn't one).
/// Returns `CommandResult` so the caller knows how to proceed.
pub async fn execute(
    line: &str,
    app: &mut AppState,
    gateway: &GatewayClient,
    active_session: &std::sync::Arc<std::sync::Mutex<String>>,
    pending_run_ids: &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
) -> CommandResult {
    if is_quit(line) {
        return CommandResult::Quit;
    }

    if !line.starts_with('/') {
        return CommandResult::NotCommand;
    }

    let parts: Vec<&str> = line.split_whitespace().collect();

    match parts[0] {
        "/help" => {
            app.push_message(
                MessageRole::System,
                "Local: /help /clear /status /info /tools [quiet|normal|verbose|list] /channels /config [path] [value]\nSession: /sessions /session [key|list] /agent [id|list]\nServer: /reset /compact /model <name> /think <level> /stop\nNav: PageUp/PageDown Home/End  Exit: /quit (/q)",
            );
        }

        "/clear" => {
            app.clear_runs();
            app.messages.clear();
            if let Ok(mut runs) = pending_run_ids.lock() {
                runs.clear();
            }
            app.input.clear();
            app.set_status("ready");
            app.push_message(MessageRole::System, "cleared conversation");
        }

        "/status" => {
            let run_status = if app.run_phases.is_empty() {
                "none".to_string()
            } else {
                app.run_phases
                    .iter()
                    .map(|(run_id, phase)| {
                        format!("{} {}", phase.label(), state::short_run_id(run_id))
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            };

            let agent = state::extract_agent_from_session_key(&app.session_key)
                .unwrap_or_else(|| "unknown".to_string());

            app.push_message(
                MessageRole::System,
                format!(
                    "session={} agent={} connected={} runs={}",
                    state::session_display_name(&app.session_key),
                    agent,
                    !gateway.connection().is_disconnected(),
                    run_status
                ),
            );
        }

        "/sessions" => {
            let limit = parts
                .get(1)
                .and_then(|raw| raw.parse::<i64>().ok())
                .unwrap_or(40);

            exec_sessions_list(app, gateway, limit).await;
        }

        "/session" => {
            let subcommand = parts.get(1).copied().unwrap_or("");
            exec_session(app, gateway, active_session, pending_run_ids, &parts, subcommand).await;
        }

        "/info" | "/i" => {
            exec_info(app, gateway).await;
        }

        "/tools" => {
            let level = parts.get(1).copied().unwrap_or("");
            match parts.get(1).copied() {
                Some("list" | "ls") => exec_tools_list(app, gateway).await,
                _ => exec_tools(app, level),
            }
        }

        "/channels" | "/ch" => {
            exec_channels(app, gateway).await;
        }

        "/config" => {
            let path = parts.get(1).copied();
            let value = parts.get(2).copied();
            exec_config(app, gateway, path, value).await;
        }

        "/agent" => {
            let subcommand = parts.get(1).copied().unwrap_or("");
            exec_agent(app, gateway, active_session, pending_run_ids, subcommand).await;
        }

        _ => {
            // Unknown local command -- forward to gateway so server-side
            // commands (/reset, /model, /think, /stop, /compact, etc.) work.
            return CommandResult::Forward;
        }
    }

    CommandResult::Handled
}

// ── /tools ──────────────────────────────────────────────────────────────────

fn exec_tools(app: &mut AppState, level: &str) {
    match level.to_lowercase().as_str() {
        "quiet" | "q" | "off" | "hide" => {
            app.tool_verbosity = ToolVerbosity::Quiet;
            app.push_message(MessageRole::System, "Tool display: quiet (hidden)");
        }
        "normal" | "n" | "default" => {
            app.tool_verbosity = ToolVerbosity::Normal;
            app.push_message(
                MessageRole::System,
                "Tool display: normal (names shown, results truncated)",
            );
        }
        "verbose" | "v" | "full" | "show" => {
            app.tool_verbosity = ToolVerbosity::Verbose;
            app.push_message(
                MessageRole::System,
                "Tool display: verbose (names + args + full results)",
            );
        }
        "" => {
            app.push_message(
                MessageRole::System,
                format!(
                    "Tool display: {} (/tools [quiet|normal|verbose])",
                    app.tool_verbosity.label()
                ),
            );
        }
        _ => {
            app.push_message(
                MessageRole::System,
                "Usage: /tools [quiet|normal|verbose]",
            );
        }
    }
}

// ── /channels ───────────────────────────────────────────────────────────────

async fn exec_channels(app: &mut AppState, gateway: &GatewayClient) {
    match gateway.channels_list().await {
        Ok(payload) => {
            let channels = payload.get("channels").and_then(|v| v.as_array());
            let count = payload
                .get("count")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            match channels {
                Some(channels) if !channels.is_empty() => {
                    let mut lines = vec![format!("Channels ({}):", count)];
                    for ch in channels {
                        let channel = ch
                            .get("channel")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?");
                        let account = ch
                            .get("accountId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("default");
                        let connected_at = ch
                            .get("connectedAt")
                            .and_then(|v| v.as_i64())
                            .and_then(|ts| {
                                chrono::DateTime::from_timestamp_millis(ts)
                                    .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                            })
                            .unwrap_or_else(|| "?".to_string());

                        lines.push(format!(
                            "  {}:{} - connected {}",
                            channel, account, connected_at
                        ));
                    }
                    app.push_message(MessageRole::System, lines.join("\n"));
                }
                _ => {
                    app.push_message(MessageRole::System, "No channels connected");
                }
            }
        }
        Err(error) => {
            app.push_message(
                MessageRole::Error,
                format!("Failed to list channels: {error}"),
            );
        }
    }
}

// ── /config ─────────────────────────────────────────────────────────────────

async fn exec_config(
    app: &mut AppState,
    gateway: &GatewayClient,
    path: Option<&str>,
    value: Option<&str>,
) {
    // /config           → show all config
    // /config <path>    → show specific path
    // /config <path> <value> → set config value
    match (path, value) {
        (Some(path), Some(value)) => {
            // Try to parse value as JSON, fall back to string
            let json_value = serde_json::from_str(value).unwrap_or_else(|_| {
                serde_json::Value::String(value.to_string())
            });

            match gateway.config_set(path.to_string(), json_value).await {
                Ok(_) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Config set: {} = {}", path, value),
                    );
                }
                Err(error) => {
                    app.push_message(
                        MessageRole::Error,
                        format!("Failed to set config: {error}"),
                    );
                }
            }
        }
        (path, _) => {
            match gateway.config_get(path.map(String::from)).await {
                Ok(payload) => {
                    if let Some(path) = path {
                        let value = payload.get("value").unwrap_or(&payload);
                        let formatted = serde_json::to_string_pretty(value)
                            .unwrap_or_else(|_| value.to_string());
                        app.push_message(
                            MessageRole::System,
                            format!("{} = {}", path, formatted),
                        );
                    } else {
                        let config = payload.get("config").unwrap_or(&payload);
                        let formatted = serde_json::to_string_pretty(config)
                            .unwrap_or_else(|_| config.to_string());
                        app.push_message(
                            MessageRole::System,
                            format!("Config:\n{}", formatted),
                        );
                    }
                }
                Err(error) => {
                    app.push_message(
                        MessageRole::Error,
                        format!("Failed to get config: {error}"),
                    );
                }
            }
        }
    }
}

// ── /info ───────────────────────────────────────────────────────────────────

async fn exec_info(app: &mut AppState, gateway: &GatewayClient) {
    match gateway.session_get(app.session_key.clone()).await {
        Ok(payload) => {
            let session_key = payload
                .get("sessionKey")
                .and_then(|v| v.as_str())
                .unwrap_or(&app.session_key);
            let message_count = payload
                .get("messageCount")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            // Settings
            let settings = payload.get("settings");
            let model = settings
                .and_then(|s| s.get("model"))
                .and_then(|v| v.as_str())
                .unwrap_or("default");
            let thinking = settings
                .and_then(|s| s.get("thinkingLevel"))
                .and_then(|v| v.as_str())
                .unwrap_or("default");

            // Tokens
            let tokens = payload.get("tokens");
            let input_tokens = tokens
                .and_then(|t| t.get("input"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let output_tokens = tokens
                .and_then(|t| t.get("output"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            // Label
            let label = payload
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("-");

            // Reset policy
            let reset_policy = settings
                .and_then(|s| s.get("resetPolicy"))
                .and_then(|v| v.as_str())
                .unwrap_or("none");

            app.push_message(
                MessageRole::System,
                format!(
                    "Session: {}\n  label: {}\n  model: {}\n  thinking: {}\n  messages: {}\n  tokens: {} in / {} out\n  reset: {}",
                    state::session_display_name(session_key),
                    label,
                    model,
                    thinking,
                    message_count,
                    format_token_count(input_tokens),
                    format_token_count(output_tokens),
                    reset_policy,
                ),
            );
        }
        Err(error) => {
            app.push_message(
                MessageRole::Error,
                format!("Failed to get session info: {error}"),
            );
        }
    }
}

fn format_token_count(count: i64) -> String {
    if count >= 1_000_000 {
        format!("{:.1}M", count as f64 / 1_000_000.0)
    } else if count >= 1_000 {
        format!("{:.1}K", count as f64 / 1_000.0)
    } else {
        count.to_string()
    }
}

// ── /tools list ─────────────────────────────────────────────────────────────

async fn exec_tools_list(app: &mut AppState, gateway: &GatewayClient) {
    match gateway.tools_list().await {
        Ok(payload) => {
            let tools = payload.get("tools").and_then(|v| v.as_array());
            match tools {
                Some(tools) if !tools.is_empty() => {
                    let mut lines = vec![format!("Available tools ({}):", tools.len())];
                    for tool in tools {
                        let name = tool
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?");
                        let desc = tool
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if desc.is_empty() {
                            lines.push(format!("  {}", name));
                        } else {
                            // Truncate long descriptions
                            let short = if desc.len() > 60 {
                                format!("{}...", &desc[..57])
                            } else {
                                desc.to_string()
                            };
                            lines.push(format!("  {} - {}", name, short));
                        }
                    }
                    app.push_message(MessageRole::System, lines.join("\n"));
                }
                _ => {
                    app.push_message(MessageRole::System, "No tools available (no nodes connected?)");
                }
            }
        }
        Err(error) => {
            app.push_message(
                MessageRole::Error,
                format!("Failed to list tools: {error}"),
            );
        }
    }
}

// ── /sessions ───────────────────────────────────────────────────────────────

async fn exec_sessions_list(app: &mut AppState, gateway: &GatewayClient, limit: i64) {
    match gateway.sessions_list(limit).await {
        Ok(payload) => {
            let sessions = payload
                .get("sessions")
                .and_then(|sessions| sessions.as_array());
            let count = payload
                .get("count")
                .and_then(|count| count.as_i64())
                .unwrap_or(0);

            if let Some(sessions) = sessions {
                if sessions.is_empty() {
                    app.push_message(MessageRole::System, "No sessions found");
                } else {
                    app.push_message(MessageRole::System, format!("Sessions ({}):", count));

                    for session in sessions {
                        let key = session
                            .get("sessionKey")
                            .and_then(|key| key.as_str())
                            .unwrap_or("?");
                        let label = session.get("label").and_then(|label| label.as_str());
                        let active = if state::normalize_session_key_for_match(key)
                            == state::normalize_session_key_for_match(&app.session_key)
                        {
                            " [active]"
                        } else {
                            ""
                        };
                        let last_active = session
                            .get("lastActiveAt")
                            .and_then(|value| value.as_i64())
                            .and_then(|ts| {
                                chrono::DateTime::from_timestamp_millis(ts)
                                    .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                            })
                            .unwrap_or_else(|| "?".to_string());

                        if let Some(label) = label {
                            app.push_message(
                                MessageRole::System,
                                format!(
                                    "  {}{} - {} - last active: {}",
                                    key, active, label, last_active
                                ),
                            );
                        } else {
                            app.push_message(
                                MessageRole::System,
                                format!("  {}{} - last active: {}", key, active, last_active),
                            );
                        }
                    }
                }
            }
        }
        Err(error) => {
            app.push_message(
                MessageRole::Error,
                format!("Failed to list sessions: {error}"),
            );
        }
    }
}

// ── /session ────────────────────────────────────────────────────────────────

async fn exec_session(
    app: &mut AppState,
    gateway: &GatewayClient,
    active_session: &std::sync::Arc<std::sync::Mutex<String>>,
    pending_run_ids: &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
    parts: &[&str],
    subcommand: &str,
) {
    match subcommand {
        "" => {
            app.push_message(
                MessageRole::System,
                format!(
                    "Current session: {}",
                    state::session_display_name(&app.session_key)
                ),
            );
        }
        "list" | "ls" => {
            let limit = parts
                .get(2)
                .and_then(|raw| raw.parse::<i64>().ok())
                .unwrap_or(40);

            match gateway.sessions_list(limit).await {
                Ok(payload) => {
                    let sessions = payload
                        .get("sessions")
                        .and_then(|sessions| sessions.as_array());

                    if let Some(sessions) = sessions {
                        if sessions.is_empty() {
                            app.push_message(MessageRole::System, "No sessions found");
                        } else {
                            app.push_message(MessageRole::System, "Sessions:");

                            for session in sessions {
                                let key = session
                                    .get("sessionKey")
                                    .and_then(|key| key.as_str())
                                    .unwrap_or("?");
                                let active =
                                    if state::normalize_session_key_for_match(key)
                                        == state::normalize_session_key_for_match(&app.session_key)
                                    {
                                        " [active]"
                                    } else {
                                        ""
                                    };

                                app.push_message(
                                    MessageRole::System,
                                    format!("  {}{}", key, active),
                                );
                            }
                        }
                    }
                }
                Err(error) => {
                    app.push_message(
                        MessageRole::Error,
                        format!("Failed to list sessions: {error}"),
                    );
                }
            }
        }
        // "set", "switch", or a raw session key -- all do the same thing
        target => {
            let target_key = if target == "set" || target == "switch" {
                match parts.get(2).copied() {
                    Some(key) => key,
                    None => {
                        app.push_message(
                            MessageRole::Error,
                            format!("Usage: /session {} <session_key>", target),
                        );
                        return;
                    }
                }
            } else {
                target
            };

            switch_session(app, gateway, active_session, pending_run_ids, target_key).await;
        }
    }
}

// ── /agent ──────────────────────────────────────────────────────────────────

async fn exec_agent(
    app: &mut AppState,
    gateway: &GatewayClient,
    active_session: &std::sync::Arc<std::sync::Mutex<String>>,
    pending_run_ids: &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
    subcommand: &str,
) {
    match subcommand {
        "" => {
            app.push_message(
                MessageRole::System,
                format!(
                    "Current agent: {}",
                    state::extract_agent_from_session_key(&app.session_key)
                        .unwrap_or_else(|| "unknown".to_string())
                ),
            );
        }
        "list" | "ls" => {
            match gateway.sessions_list(200).await {
                Ok(payload) => {
                    let mut agents = payload
                        .get("sessions")
                        .and_then(|sessions| sessions.as_array())
                        .into_iter()
                        .flat_map(|sessions| {
                            sessions.iter().filter_map(|session| {
                                session
                                    .get("sessionKey")
                                    .and_then(|key| key.as_str())
                                    .and_then(state::extract_agent_from_session_key)
                            })
                        })
                        .collect::<Vec<_>>();
                    agents.sort();
                    agents.dedup();

                    if agents.is_empty() {
                        app.push_message(MessageRole::System, "No agents found");
                    } else {
                        app.push_message(MessageRole::System, "Agents:");
                        for agent in agents {
                            app.push_message(MessageRole::System, format!("  {}", agent));
                        }
                    }
                }
                Err(error) => {
                    app.push_message(
                        MessageRole::Error,
                        format!("Failed to list agents: {error}"),
                    );
                }
            }
        }
        target => {
            let target = target.trim();
            if target.is_empty() {
                app.push_message(MessageRole::Error, "Usage: /agent <agent_id>");
            } else {
                let session_key = state::build_agent_session_key(target);
                let session_key = state::normalize_session_key_for_match(&session_key);

                do_switch(app, gateway, active_session, pending_run_ids, &session_key).await;

                app.push_message(
                    MessageRole::System,
                    format!(
                        "Switched to agent {} ({})",
                        target,
                        state::session_display_name(&session_key)
                    ),
                );
            }
        }
    }
}

// ── Shared switch logic ─────────────────────────────────────────────────────

async fn switch_session(
    app: &mut AppState,
    gateway: &GatewayClient,
    active_session: &std::sync::Arc<std::sync::Mutex<String>>,
    pending_run_ids: &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
    target: &str,
) {
    let target_session = crate::config::normalize_session_key(target);
    let target_session = state::normalize_session_key_for_match(&target_session);

    if state::normalize_session_key_for_match(&app.session_key) == target_session {
        app.push_message(
            MessageRole::System,
            format!(
                "Already on {}",
                state::session_display_name(&app.session_key)
            ),
        );
        return;
    }

    do_switch(app, gateway, active_session, pending_run_ids, &target_session).await;

    app.push_message(
        MessageRole::System,
        format!(
            "Session switched to {}",
            state::session_display_name(&target_session)
        ),
    );
}

async fn do_switch(
    app: &mut AppState,
    gateway: &GatewayClient,
    active_session: &std::sync::Arc<std::sync::Mutex<String>>,
    pending_run_ids: &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
    target_session: &str,
) {
    app.session_key = target_session.to_string();
    app.clear_runs();
    if let Ok(mut runs) = pending_run_ids.lock() {
        runs.clear();
    }
    if let Ok(mut session) = active_session.lock() {
        *session = target_session.to_string();
    }

    if let Err(error) = super::app::load_session_history(gateway, app, target_session).await {
        app.push_message(
            MessageRole::Error,
            format!("Failed to load session history: {error}"),
        );
    }
}
