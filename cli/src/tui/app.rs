use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossterm::{
    cursor::{Hide, Show},
    event::{self, Event as CEvent},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    Terminal,
};
use tokio::sync::mpsc;

use crate::connection::Connection;
use crate::gateway_client::GatewayClient;
use crate::protocol::Frame;

use crate::tui::commands::{self, CommandResult};
use crate::tui::events::{
    self, ParsedChatEventState, UiChatEvent,
};
use crate::tui::input::{self, KeyAction};
use crate::tui::buffer::BufferId;
use crate::tui::state::{
    self, AppState, MessageRole, RunPhase,
};
use crate::tui::theme;
use crate::tui::widgets;

// ── Terminal RAII guard ─────────────────────────────────────────────────────

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Result<Self, Box<dyn std::error::Error>> {
        enable_raw_mode()?;
        execute!(io::stdout(), EnterAlternateScreen, Hide)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(io::stdout(), LeaveAlternateScreen, Show);
        let _ = disable_raw_mode();
    }
}

// ── Public entry point ──────────────────────────────────────────────────────

pub async fn run(
    url: &str,
    token: Option<String>,
    session_key: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let _guard = TerminalGuard::enter()?;
    terminal.clear()?;

    // ── WebSocket connection + event channel ────────────────────────
    let (client_tx, mut client_rx) = mpsc::unbounded_channel::<UiChatEvent>();
    let session_filter = state::normalize_session_key_for_match(session_key);
    let active_session = Arc::new(Mutex::new(session_filter.clone()));
    let pending_run_ids = Arc::new(Mutex::new(HashMap::<String, String>::new()));

    let conn = connect_ws(
        url,
        token,
        client_tx.clone(),
        active_session.clone(),
        pending_run_ids.clone(),
    )
    .await?;
    let gateway = GatewayClient::new(conn);

    // ── App state ───────────────────────────────────────────────────
    let mut app = AppState::new(session_key);
    app.set_status(format!(
        "connected to {} (session {})",
        url,
        state::session_display_name(session_key)
    ));
    if let Err(error) = load_session_history(&gateway, &mut app, session_key).await {
        app.push_message(
            MessageRole::Error,
            format!("Failed to load session history: {error}"),
        );
    }

    // ── Keyboard reader thread ──────────────────────────────────────
    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<CEvent>();
    let stop_ui = Arc::new(AtomicBool::new(false));
    let stop_ui_reader = Arc::clone(&stop_ui);
    let ui_tx_reader = ui_tx.clone();
    let ui_thread = tokio::task::spawn_blocking(move || {
        while !stop_ui_reader.load(Ordering::SeqCst) {
            match event::poll(Duration::from_millis(theme::CROSSTERM_POLL_MS)) {
                Ok(true) => match event::read() {
                    Ok(ui_event) => {
                        if ui_tx_reader.send(ui_event).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Ok(false) => {}
                Err(_) => break,
            }
        }
    });

    // ── Welcome message ─────────────────────────────────────────────
    app.push_message(
        MessageRole::System,
        "GSV TUI client. Type /help for controls. Alt+1/2/3 to switch buffers.",
    );

    // Initial system state poll
    refresh_system_state(&gateway, &mut app).await;
    draw(&mut terminal, &mut app)?;

    // ── Main event loop ─────────────────────────────────────────────
    let mut tick = tokio::time::interval(Duration::from_millis(theme::TICK_MS));
    let mut should_exit = false;

    loop {
        tokio::select! {
            // ── Tick ────────────────────────────────────────────────
            _ = tick.tick() => {
                app.spinner_tick = app.spinner_tick.saturating_add(1);
                if app.waiting && app.timeout_if_needed(Instant::now()) {
                    if let Ok(mut runs) = pending_run_ids.lock() {
                        runs.clear();
                    }
                }

                // Periodic system state refresh (every 30s)
                let needs_refresh = app.system.last_refresh
                    .map(|t| t.elapsed() > Duration::from_secs(theme::SYSTEM_POLL_INTERVAL_SECS))
                    .unwrap_or(false);
                if needs_refresh {
                    refresh_system_state(&gateway, &mut app).await;
                }
            }

            // ── Keyboard ────────────────────────────────────────────
            Some(event) = ui_rx.recv() => {
                if let CEvent::Key(key) = event {
                    match input::handle_key(key.code, key.modifiers, &mut app) {
                        KeyAction::Quit => should_exit = true,
                        KeyAction::Submit(line) => {
                            match commands::execute(&line, &mut app, &gateway, &active_session, &pending_run_ids).await {
                                CommandResult::Quit => should_exit = true,
                                CommandResult::Handled => {}
                                CommandResult::NotCommand | CommandResult::Forward => {
                                    // Not a local command, or an unknown /cmd
                                    // the gateway might handle -- send as chat.
                                    handle_submit(
                                        &line,
                                        &mut app,
                                        &gateway,
                                        &active_session,
                                        &pending_run_ids,
                                    ).await;
                                }
                            }
                        }
                        KeyAction::Consumed | KeyAction::Ignored => {}
                    }
                }
            }

            // ── Chat events from WS ────────────────────────────────
            Some(event) = client_rx.recv() => {
                handle_chat_event(event, &mut app, &pending_run_ids);
            }

            else => should_exit = true,
        }

        draw(&mut terminal, &mut app)?;
        if should_exit {
            break;
        }
    }

    stop_ui.store(true, Ordering::SeqCst);
    drop(ui_tx);
    let _ = ui_thread.await;

    Ok(())
}

// ── Submit handler ──────────────────────────────────────────────────────────

async fn handle_submit(
    line: &str,
    app: &mut AppState,
    gateway: &GatewayClient,
    _active_session: &Arc<Mutex<String>>,
    pending_run_ids: &Arc<Mutex<HashMap<String, String>>>,
) {
    // This is only called for lines that commands::execute returned
    // NotCommand or Forward for, so they should be sent as chat messages.
    app.add_input_history(line);
    app.push_message(MessageRole::User, line);
    app.status = None;
    app.waiting = true;
    app.waiting_started = Some(Instant::now());

    match send_chat(gateway, &app.session_key, line).await {
        Ok(result) => {
            if let Some(response) = result.response {
                app.push_message(MessageRole::System, response);
            }
            if let Some(error) = result.error {
                app.push_message(MessageRole::Error, format!("send failed: {error}"));
            }

            if let Some(run_id) = result.run_id.clone() {
                if let Ok(mut runs) = pending_run_ids.lock() {
                    runs.insert(run_id.clone(), app.session_key.clone());
                }
                app.set_run_state(
                    run_id,
                    result.run_status.unwrap_or(RunPhase::Queued),
                );
            } else if !result.directive {
                app.push_message(
                    MessageRole::System,
                    "assistant state unknown; still waiting for response",
                );
            }

            if result.directive {
                app.waiting = false;
                app.waiting_started = None;
                app.streams.clear();
                app.active_run_id = None;
                if let Some(run_id) = result.run_id.as_deref() {
                    app.pop_run_state(run_id);
                }
            }
        }
        Err(error) => {
            app.waiting = false;
            app.waiting_started = None;
            app.clear_runs();
            if let Ok(mut runs) = pending_run_ids.lock() {
                runs.clear();
            }
            app.push_message(MessageRole::Error, format!("send failed: {error}"));
        }
    }
}

// ── Chat event handler ──────────────────────────────────────────────────────

fn handle_chat_event(
    event: UiChatEvent,
    app: &mut AppState,
    pending_run_ids: &Arc<Mutex<HashMap<String, String>>>,
) {
    // Any incoming event means the agent is alive — reset the silence timer
    // so we only timeout after prolonged *silence*, not wall-clock time.
    app.touch_activity();

    match event {
        UiChatEvent::RunState { run_id, state } => {
            app.set_run_state(run_id.clone(), state);
            if matches!(state, RunPhase::Finalizing | RunPhase::Failed) {
                if let Ok(mut runs) = pending_run_ids.lock() {
                    runs.remove(&run_id);
                }
            }

            if !app.run_phases.values().any(|phase| phase.is_active()) {
                app.waiting = false;
                app.waiting_started = None;
            }
        }
        UiChatEvent::AssistantChunk { run_id, text } => {
            app.append_partial(run_id, text);
        }
        UiChatEvent::AssistantFinal { run_id, text, tool_calls } => {
            if let Ok(mut runs) = pending_run_ids.lock() {
                runs.remove(&run_id);
            }
            app.finalize_run(run_id, text);
            // Emit separate Tool messages for each tool call in this response.
            for tc in tool_calls {
                app.push_tool_call(&tc);
            }
        }
        UiChatEvent::Error { run_id, text } => {
            if let Some(run_id) = run_id {
                app.pop_run_state(&run_id);
                if let Ok(mut runs) = pending_run_ids.lock() {
                    runs.remove(&run_id);
                }
            } else {
                app.clear_runs();
                if let Ok(mut runs) = pending_run_ids.lock() {
                    runs.clear();
                }
            }
            app.streams.clear();
            app.push_message(MessageRole::Error, text);
            app.waiting = false;
            app.waiting_started = None;
            app.active_run_id = None;
        }
        UiChatEvent::SystemEvent { payload } => {
            handle_system_event(app, &payload);
        }
    }
}

// ── System event handler ────────────────────────────────────────────────────

fn handle_system_event(app: &mut AppState, payload: &serde_json::Value) {
    let event = payload.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("");

    match event {
        "system.node" => {
            let node_id = payload
                .get("nodeId")
                .and_then(|v| v.as_str())
                .unwrap_or("?");

            match action {
                "connected" => {
                    let tool_count = payload
                        .get("toolCount")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize;
                    let host_os = payload.get("hostOs").and_then(|v| v.as_str());
                    let host_role = payload.get("hostRole").and_then(|v| v.as_str());

                    app.system
                        .node_connected(node_id, tool_count, host_os, host_role);

                    let is_sys = app.active_buffer == BufferId::System;
                    app.system_buffer.push(
                        state::MessageLine {
                            role: MessageRole::System,
                            text: format!(
                                "node connected: {} ({}, {} tools)",
                                node_id,
                                host_os.unwrap_or("?"),
                                tool_count
                            ),
                        },
                        is_sys,
                    );
                }
                "disconnected" => {
                    app.system.node_disconnected(node_id);

                    let is_sys = app.active_buffer == BufferId::System;
                    app.system_buffer.push(
                        state::MessageLine {
                            role: MessageRole::Error,
                            text: format!("node disconnected: {}", node_id),
                        },
                        is_sys,
                    );
                }
                _ => {}
            }
        }
        "system.channel" => {
            let channel = payload
                .get("channel")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let account_id = payload
                .get("accountId")
                .and_then(|v| v.as_str())
                .unwrap_or("default");
            let connected = payload
                .get("connected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            app.system
                .channel_status(channel, account_id, connected, None);

            let is_sys = app.active_buffer == BufferId::System;
            let msg = if connected {
                format!("channel connected: {}:{}", channel, account_id)
            } else {
                format!("channel disconnected: {}:{}", channel, account_id)
            };
            app.system_buffer.push(
                state::MessageLine {
                    role: if connected {
                        MessageRole::System
                    } else {
                        MessageRole::Error
                    },
                    text: msg,
                },
                is_sys,
            );
        }
        _ => {}
    }
}

// ── Draw ────────────────────────────────────────────────────────────────────

fn draw(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut AppState,
) -> Result<(), Box<dyn std::error::Error>> {
    terminal.draw(|frame| {
        let area = frame.size();
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(theme::TITLE_HEIGHT),
                Constraint::Min(theme::MIN_CHAT_HEIGHT),
                Constraint::Length(theme::STATUS_HEIGHT),
                Constraint::Length(theme::INPUT_HEIGHT),
            ])
            .split(area);

        let content_width = chunks[1].width as usize;
        let content_height = chunks[1].height as usize;

        // Render content area based on active buffer.
        match app.active_buffer {
            BufferId::Chat => {
                let lines = widgets::chat::build_lines(&app.messages, content_width);
                app.ensure_chat_scroll(lines.len(), content_height);
                let max_scroll = app.max_chat_scroll(lines.len(), content_height);
                let clamped_scroll = app.chat_scroll.min(max_scroll);

                frame.render_widget(
                    widgets::chat::render(
                        lines,
                        u16::try_from(clamped_scroll).unwrap_or(u16::MAX),
                    ),
                    chunks[1],
                );
            }
            BufferId::System => {
                let lines = widgets::system::build_lines(app, content_width);
                // System buffer uses its own scroll state.
                let max_scroll = lines.len().saturating_sub(content_height);
                if app.system_buffer.auto_follow {
                    app.system_buffer.scroll = max_scroll;
                }
                let clamped = app.system_buffer.scroll.min(max_scroll);

                frame.render_widget(
                    widgets::system::render(
                        lines,
                        u16::try_from(clamped).unwrap_or(u16::MAX),
                    ),
                    chunks[1],
                );
            }
            BufferId::Logs => {
                let lines =
                    widgets::logs::build_lines(&app.logs_buffer.messages, content_width);
                let max_scroll = lines.len().saturating_sub(content_height);
                if app.logs_buffer.auto_follow {
                    app.logs_buffer.scroll = max_scroll;
                }
                let clamped = app.logs_buffer.scroll.min(max_scroll);

                frame.render_widget(
                    widgets::logs::render(
                        lines,
                        u16::try_from(clamped).unwrap_or(u16::MAX),
                    ),
                    chunks[1],
                );
            }
        }

        frame.render_widget(
            widgets::header::render(app, chunks[0].width),
            chunks[0],
        );
        frame.render_widget(
            widgets::status::render(app, chunks[2].width),
            chunks[2],
        );
        frame.render_widget(widgets::input::render(app), chunks[3]);

        let cx = widgets::input::cursor_x(app, chunks[3].width);
        frame.set_cursor(chunks[3].x + cx, chunks[3].y);
    })?;

    Ok(())
}

// ── WebSocket connection setup ──────────────────────────────────────────────

async fn connect_ws(
    url: &str,
    token: Option<String>,
    client_tx: mpsc::UnboundedSender<UiChatEvent>,
    active_session: Arc<Mutex<String>>,
    pending_run_ids: Arc<Mutex<HashMap<String, String>>>,
) -> Result<Connection, Box<dyn std::error::Error>> {
    Connection::connect_with_options(
        url,
        "client",
        None,
        None,
        move |frame| {
            if let Frame::Evt(evt) = frame {
                // Handle system events
                if evt.event == "system" {
                    if let Some(payload) = evt.payload {
                        let _ = client_tx.send(UiChatEvent::SystemEvent { payload });
                    }
                    return;
                }

                if evt.event != "chat" {
                    return;
                }

                let Some(payload) = evt.payload else {
                    return;
                };

                let run_id = events::parse_run_id(&payload);
                let run_id_for_events = run_id
                    .clone()
                    .unwrap_or_else(|| theme::RUN_DEFAULT_ID.to_string());

                let payload_session = payload
                    .get("sessionKey")
                    .and_then(|s| s.as_str())
                    .map(state::normalize_session_key_for_match);

                let mapped_session = run_id.as_ref().and_then(|run_id| {
                    pending_run_ids
                        .lock()
                        .ok()
                        .and_then(|runs| runs.get(run_id).cloned())
                });

                let active_session =
                    active_session.lock().ok().map(|session| session.clone());
                let active_session = match active_session {
                    Some(active_session) => active_session,
                    None => return,
                };

                match (&payload_session, &mapped_session) {
                    (Some(event_session), _) if event_session == &active_session => {}
                    (_, Some(mapped_session)) if mapped_session == &active_session => {}
                    _ => return,
                }

                let state = ParsedChatEventState::from_raw(
                    payload.get("state").and_then(|s| s.as_str()),
                );
                if let Some(phase) = state.as_run_phase() {
                    let _ = client_tx.send(UiChatEvent::RunState {
                        run_id: run_id_for_events.clone(),
                        state: phase,
                    });
                }

                let extracted = events::extract_content_from_payload(&payload);
                let has_text = extracted.text.as_ref().is_some_and(|t| !t.is_empty());
                let has_content = has_text || !extracted.tool_calls.is_empty();

                if has_content {
                    match state {
                        ParsedChatEventState::Streaming => {
                            // Streaming: only send text chunks (tool calls arrive in
                            // partial/final, not in streaming deltas).
                            if let Some(text) = extracted.text {
                                let _ = client_tx.send(UiChatEvent::AssistantChunk {
                                    run_id: run_id_for_events.clone(),
                                    text,
                                });
                            }
                        }
                        ParsedChatEventState::Final => {
                            let _ = client_tx.send(UiChatEvent::AssistantFinal {
                                run_id: run_id_for_events.clone(),
                                text: extracted.text.unwrap_or_default(),
                                tool_calls: extracted.tool_calls,
                            });
                        }
                        ParsedChatEventState::Error => {
                            let _ = client_tx.send(UiChatEvent::Error {
                                run_id: Some(run_id_for_events.clone()),
                                text: extracted.text.unwrap_or_default(),
                            });
                        }
                        ParsedChatEventState::Unknown => {
                            let _ = client_tx.send(UiChatEvent::AssistantFinal {
                                run_id: run_id_for_events.clone(),
                                text: extracted.text.unwrap_or_default(),
                                tool_calls: extracted.tool_calls,
                            });
                        }
                        ParsedChatEventState::Queued | ParsedChatEventState::Started => {}
                    }
                } else if let ParsedChatEventState::Final = state {
                    let _ = client_tx.send(UiChatEvent::AssistantFinal {
                        run_id: run_id_for_events,
                        text: String::new(),
                        tool_calls: Vec::new(),
                    });
                } else if let Some(err) = payload.get("error").and_then(|e| e.as_str()) {
                    let _ = client_tx.send(UiChatEvent::Error {
                        run_id: Some(run_id_for_events),
                        text: err.to_string(),
                    });
                }
            }
        },
        None,
        token,
    )
    .await
}

// ── Session history loading ─────────────────────────────────────────────────

pub async fn load_session_history(
    gateway: &GatewayClient,
    app: &mut AppState,
    session_key: &str,
) -> Result<usize, Box<dyn std::error::Error>> {
    let payload = gateway
        .session_preview(session_key.to_string(), Some(theme::HISTORY_LOAD_LIMIT))
        .await?;

    app.clear_runs();
    app.waiting = false;
    app.waiting_started = None;
    app.input.clear();
    app.streams.clear();
    app.messages.clear();
    app.status = Some("loading history".to_string());

    let message_count = payload
        .get("messageCount")
        .and_then(|count| count.as_i64())
        .unwrap_or(0);
    let mut loaded = 0;

    if let Some(messages) = payload
        .get("messages")
        .and_then(|messages| messages.as_array())
    {
        for message in messages {
            let items = events::history_message_to_items(message);
            for item in items {
                // Respect verbosity: in quiet mode, skip Tool lines.
                if item.role == MessageRole::Tool
                    && app.tool_verbosity == state::ToolVerbosity::Quiet
                {
                    continue;
                }
                // In normal mode, truncate tool result bodies.
                let text = if item.role == MessageRole::Tool
                    && app.tool_verbosity == state::ToolVerbosity::Normal
                {
                    truncate_tool_result_text(&item.text)
                } else {
                    item.text
                };
                app.messages.push(state::MessageLine { role: item.role, text });
                loaded += 1;
            }
        }
    }

    if loaded == 0 {
        app.push_message(
            MessageRole::System,
            if message_count == 0 {
                "No prior messages".to_string()
            } else {
                format!("No displayable prior messages ({} total)", message_count)
            },
        );
    } else {
        app.push_message(
            MessageRole::System,
            format!("Loaded {} of {} prior messages", loaded, message_count),
        );
    }

    app.status = Some("connected".to_string());

    Ok(loaded)
}

// ── System state polling ────────────────────────────────────────────────────

async fn refresh_system_state(gateway: &GatewayClient, app: &mut AppState) {
    // Poll nodes and channels in sequence (both are fast RPCs).
    if let Ok(payload) = gateway.nodes_list().await {
        app.system.load_from_nodes_list(&payload);
    }
    if let Ok(payload) = gateway.channels_list().await {
        app.system.load_from_channels_list(&payload);
    }
}

/// Truncate tool result text for normal verbosity.
/// Keeps the header line (▸ tool result) and truncates the body.
fn truncate_tool_result_text(text: &str) -> String {
    // Tool result format: "▸ name result\nbody line 1\nbody line 2..."
    // We want to keep the header and truncate the body portion.
    if let Some(newline_pos) = text.find('\n') {
        let header = &text[..newline_pos];
        let body = &text[newline_pos + 1..];
        if body.is_empty() {
            return header.to_string();
        }
        let truncated = state::truncate_lines(body, theme::TOOL_RESULT_TRUNCATE_LINES);
        format!("{}\n{}", header, truncated)
    } else {
        text.to_string()
    }
}

// ── Chat send helper ────────────────────────────────────────────────────────

async fn send_chat(
    client: &GatewayClient,
    session_key: &str,
    message: &str,
) -> Result<events::SendResult, Box<dyn std::error::Error>> {
    let payload = client
        .chat_send(session_key.to_string(), message.to_string())
        .await?;

    Ok(events::parse_send_result(&payload))
}
