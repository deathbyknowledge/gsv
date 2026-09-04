use std::io::{self, IsTerminal};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossterm::cursor::{SetCursorStyle, Show};
use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, Event as TerminalEvent, EventStream, KeyCode,
    KeyEvent, KeyEventKind, KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures_util::StreamExt;
use gsv::kernel_client::{
    cli_peer_identity, BinaryBodyLimits, ConversationFileResource, GatewayAuth, KernelClient,
};
use gsv::protocol::Frame;
use gsv_tui_core::{
    Action, AgentActionSnapshot, App, Approval, ApprovalDecision, Artifact, CapabilityEnvironment,
    ConnectionState, Effect, FileEntry, FileReference, MediaKind, MessageDeliverySnapshot, Moment,
    Role, Theme,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior};

use super::chat::{implicit_personal_owner_uid, personal_process_id};

mod media;

use media::{ArtifactStore, ImageManager};

const FILE_INSPECTION_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECTION_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(250);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(8);
const HISTORY_PAGE_SIZE: u64 = 200;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileInspectionKind {
    Stat,
    Transfer,
}

enum RuntimeEvent {
    Connected(ConnectionBootstrap),
    ConnectionFailed {
        generation: u64,
        error: String,
    },
    Session {
        generation: u64,
        event: SessionEvent,
    },
    Local(SessionEvent),
}

enum SessionEvent {
    Signal {
        name: String,
        payload: Value,
    },
    SubmissionAccepted {
        id: u64,
        run_id: String,
        queued: bool,
    },
    SubmissionFailed {
        id: u64,
        error: String,
    },
    ShellOutput {
        id: u64,
        output: String,
    },
    ShellFinished {
        id: u64,
        error: Option<String>,
    },
    ApprovalDecided {
        request_id: String,
    },
    ApprovalFailed {
        error: String,
    },
    AbortFinished {
        error: Option<String>,
    },
    ArtifactOpenFailed {
        filename: String,
        error: String,
    },
    FilesListed {
        request_id: u64,
        directory: String,
        entries: Vec<FileEntry>,
    },
    FileResolved {
        request_id: u64,
        reference: FileReference,
    },
    FileOperationFailed {
        request_id: u64,
        error: String,
    },
    HistoryPageLoaded {
        moments: Vec<Moment>,
        has_more: bool,
    },
    HistoryPageFailed,
}

struct ConnectedSession {
    generation: u64,
    client: Arc<KernelClient>,
    pid: String,
    conversation_id: String,
}

#[derive(Clone)]
struct ConnectionConfig {
    url: String,
    auth: GatewayAuth,
    preferred_pid: Option<String>,
    strict_pid: bool,
}

struct ConnectionBootstrap {
    generation: u64,
    session: ConnectedSession,
    principal: String,
    environments: Vec<CapabilityEnvironment>,
    moments: Vec<Moment>,
    history_has_more: bool,
    actions: Vec<AgentActionSnapshot>,
    deliveries: Vec<MessageDeliverySnapshot>,
    active_run_id: Option<String>,
    pending_approval: Option<(Option<String>, Approval)>,
}

struct SignalGate {
    generation: u64,
    sender: mpsc::UnboundedSender<RuntimeEvent>,
    state: Mutex<SignalGateState>,
}

#[derive(Default)]
struct SignalGateState {
    active: bool,
    buffered: Vec<(String, Value)>,
}

impl SignalGate {
    fn new(generation: u64, sender: mpsc::UnboundedSender<RuntimeEvent>) -> Self {
        Self {
            generation,
            sender,
            state: Mutex::new(SignalGateState::default()),
        }
    }

    fn push(&self, name: String, payload: Value) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.active {
            let _ = self.sender.send(RuntimeEvent::Session {
                generation: self.generation,
                event: SessionEvent::Signal { name, payload },
            });
        } else {
            state.buffered.push((name, payload));
        }
    }

    fn activate(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        for (name, payload) in state.buffered.drain(..) {
            let _ = self.sender.send(RuntimeEvent::Session {
                generation: self.generation,
                event: SessionEvent::Signal { name, payload },
            });
        }
        state.active = true;
    }
}

struct TerminalRestore;

impl Drop for TerminalRestore {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            Show,
            SetCursorStyle::DefaultUserShape,
            DisableBracketedPaste,
            LeaveAlternateScreen
        );
    }
}

pub(crate) async fn run_tui(
    url: &str,
    auth: GatewayAuth,
    preferred_pid: Option<String>,
    demo: bool,
    vim: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (runtime_sender, runtime_receiver) = mpsc::unbounded_channel();
    if demo {
        let mut app = App::demo();
        app.set_principal(whoami::username());
        app.set_environments(vec![
            CapabilityEnvironment::gsv(),
            CapabilityEnvironment::new("macbook", "MacBook"),
            CapabilityEnvironment::new("browser", "Browser"),
        ]);
        app.set_vim_enabled(vim);
        return run_interface(app, None, runtime_sender, runtime_receiver).await;
    }

    let mut app = App::new(ConnectionState::Connecting);
    app.set_principal(whoami::username());
    app.set_vim_enabled(vim);
    run_interface(
        app,
        Some(ConnectionConfig {
            url: url.to_string(),
            auth,
            preferred_pid: preferred_pid.clone(),
            strict_pid: preferred_pid.is_some(),
        }),
        runtime_sender,
        runtime_receiver,
    )
    .await
}

async fn run_interface(
    mut app: App,
    mut connection_config: Option<ConnectionConfig>,
    runtime_sender: mpsc::UnboundedSender<RuntimeEvent>,
    mut runtime_receiver: mpsc::UnboundedReceiver<RuntimeEvent>,
) -> Result<(), Box<dyn std::error::Error>> {
    if !io::stdout().is_terminal() {
        return Err("The GSV interface needs an interactive terminal".into());
    }
    app.set_theme(Theme::Terminal);
    let demo = connection_config.is_none();
    let mut session: Option<ConnectedSession> = None;
    let mut connection_generation = 0_u64;
    let mut connecting = false;
    let mut reconnect_attempt = 0_u32;
    let mut next_reconnect_at = Instant::now();
    let mut bootstrapped = false;
    if let Some(config) = connection_config.as_ref().cloned() {
        connection_generation = 1;
        connecting = true;
        spawn_connection_attempt(config, connection_generation, runtime_sender.clone());
    }

    enable_raw_mode()?;
    let _restore = TerminalRestore;
    execute!(io::stdout(), EnterAlternateScreen, EnableBracketedPaste)?;
    let mut image_manager = ImageManager::detect();
    let artifact_store = ArtifactStore::new();
    app.set_inline_images(true);
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;
    let mut terminal_events = EventStream::new();
    let mut insert_cursor = false;
    let mut activity_phase = true;
    let mut animation_active = app.animation_active();
    let mut animation_tick = tokio::time::interval(Duration::from_millis(480));
    animation_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    animation_tick.reset();
    let mut connection_tick = tokio::time::interval(CONNECTION_CHECK_INTERVAL);
    connection_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    connection_tick.tick().await;

    loop {
        let next_animation_active = app.animation_active();
        if next_animation_active && !animation_active {
            activity_phase = true;
            animation_tick.reset();
        }
        animation_active = next_animation_active;
        let next_insert_cursor = app.cursor_visible();
        if insert_cursor != next_insert_cursor {
            let style = if next_insert_cursor {
                SetCursorStyle::BlinkingBlock
            } else {
                SetCursorStyle::DefaultUserShape
            };
            execute!(terminal.backend_mut(), style)?;
            insert_cursor = next_insert_cursor;
        }
        terminal.draw(|frame| {
            app.render_with_animation(frame, activity_phase);
            image_manager.render(frame, app.media_slots());
        })?;
        image_manager.synchronize(
            app.media_slots(),
            session.as_ref().map(|session| &session.client),
        );
        tokio::select! {
            maybe_event = terminal_events.next() => {
                let Some(event) = maybe_event else {
                    break;
                };
                let event = event?;
                let action = terminal_action(&app, event);
                if let Some(action) = action {
                    let effects = app.dispatch(action);
                    if apply_effects(
                        &mut app,
                        effects,
                        session.as_ref(),
                        demo,
                        &artifact_store,
                        &runtime_sender,
                    ) {
                        break;
                    }
                }
            }
            Some(event) = runtime_receiver.recv() => {
                match event {
                    RuntimeEvent::Connected(bootstrap)
                        if bootstrap.generation == connection_generation =>
                    {
                        connecting = false;
                        reconnect_attempt = 0;
                        let ConnectionBootstrap {
                            session: next_session,
                            principal,
                            environments,
                            moments,
                            history_has_more,
                            actions,
                            deliveries,
                            active_run_id,
                            pending_approval,
                            ..
                        } = bootstrap;
                        if let Some(previous) = session.take() {
                            previous.client.connection().close();
                        }
                        if let Some(config) = connection_config.as_mut() {
                            if !config.strict_pid {
                                config.preferred_pid = Some(next_session.pid.clone());
                            }
                        }
                        app.set_principal(principal);
                        app.set_environments(environments);
                        if bootstrapped {
                            app.reconcile_history(moments, history_has_more);
                        } else {
                            if !moments.is_empty() {
                                app.replace_history(moments);
                            }
                            app.set_history_has_more(history_has_more);
                        }
                        for action in actions {
                            app.restore_agent_action(action);
                        }
                        for delivery in deliveries {
                            app.restore_message_delivery(delivery);
                        }
                        app.connection_restored(active_run_id.as_deref());
                        if let Some((run_id, approval)) = pending_approval {
                            app.enter_approval_for(run_id.as_deref(), approval);
                        }
                        session = Some(next_session);
                        bootstrapped = true;
                    }
                    RuntimeEvent::Connected(bootstrap) => {
                        bootstrap.session.client.connection().close();
                    }
                    RuntimeEvent::ConnectionFailed { generation, error }
                        if generation == connection_generation =>
                    {
                        connecting = false;
                        reconnect_attempt = reconnect_attempt.saturating_add(1);
                        next_reconnect_at = Instant::now() + reconnect_delay(reconnect_attempt);
                        app.connection_lost();
                        app.set_activity(Some(format!(
                            "RECONNECTING · {}",
                            truncate_chars(&error, 120)
                        )));
                    }
                    RuntimeEvent::ConnectionFailed { .. } => {}
                    RuntimeEvent::Session { generation, event }
                        if session
                            .as_ref()
                            .is_some_and(|session| session.generation == generation) =>
                    {
                        if let Some(session) = session.as_ref() {
                            apply_session_event(&mut app, event, Some(session));
                        }
                    }
                    RuntimeEvent::Session { .. } => {}
                    RuntimeEvent::Local(event) => {
                        apply_session_event(&mut app, event, session.as_ref());
                    }
                }
            }
            () = image_manager.next_event() => {}
            _ = animation_tick.tick(), if animation_active => {
                activity_phase = !activity_phase;
            }
            _ = connection_tick.tick(), if !demo => {
                let disconnected = session
                    .as_ref()
                    .is_some_and(|session| session.client.connection().is_disconnected());
                if disconnected {
                    if let Some(disconnected) = session.take() {
                        disconnected.client.connection().close();
                    }
                    app.connection_lost();
                    connecting = false;
                    reconnect_attempt = reconnect_attempt.saturating_add(1).max(1);
                    next_reconnect_at = Instant::now() + reconnect_delay(reconnect_attempt);
                }
                if session.is_none() && !connecting && Instant::now() >= next_reconnect_at {
                    if let Some(config) = connection_config.as_ref().cloned() {
                        connection_generation = connection_generation.saturating_add(1);
                        connecting = true;
                        spawn_connection_attempt(
                            config,
                            connection_generation,
                            runtime_sender.clone(),
                        );
                    }
                }
            }
        }
    }

    Ok(())
}

fn spawn_connection_attempt(
    config: ConnectionConfig,
    generation: u64,
    runtime_sender: mpsc::UnboundedSender<RuntimeEvent>,
) {
    let handle = tokio::spawn(async move {
        match establish_connection(config, generation, runtime_sender.clone()).await {
            Ok((bootstrap, signal_gate)) => {
                if runtime_sender
                    .send(RuntimeEvent::Connected(bootstrap))
                    .is_ok()
                {
                    signal_gate.activate();
                }
            }
            Err(error) => {
                let _ = runtime_sender.send(RuntimeEvent::ConnectionFailed { generation, error });
            }
        }
    });
    drop(handle);
}

async fn establish_connection(
    config: ConnectionConfig,
    generation: u64,
    runtime_sender: mpsc::UnboundedSender<RuntimeEvent>,
) -> Result<(ConnectionBootstrap, Arc<SignalGate>), String> {
    let signal_gate = Arc::new(SignalGate::new(generation, runtime_sender));
    let callback_gate = Arc::clone(&signal_gate);
    let connect = KernelClient::connect_with_peer(
        &config.url,
        cli_peer_identity(),
        Vec::new(),
        config.auth,
        BinaryBodyLimits::default(),
        move |frame| {
            if let Frame::Sig(signal) = frame {
                callback_gate.push(signal.signal, signal.payload.unwrap_or_else(|| json!({})));
            }
        },
    );
    let client = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_elapsed| format!("Connecting to {} timed out", config.url))?
        .map_err(|error| error.to_string())?;
    let client = Arc::new(client);
    let account = client
        .connection()
        .connect_result
        .as_ref()
        .ok_or_else(|| "GSV returned no current user".to_string())?
        .peer
        .principal
        .account
        .clone();
    let owner_uid = implicit_personal_owner_uid(account.uid).map_err(|error| error.to_string())?;
    let pid = observe_tui_process(
        &client,
        owner_uid,
        config.preferred_pid.as_deref(),
        config.strict_pid,
    )
    .await?;
    let conversation_id = client
        .conversation_for_process(&pid)
        .await
        .map_err(|error| error.to_string())?;
    let history_request = async {
        client
            .request_ok(
                "conversation.history",
                Some(json!({
                    "conversationId": conversation_id,
                    "limit": HISTORY_PAGE_SIZE,
                })),
            )
            .await
            .map_err(|error| error.to_string())
    };
    let environments_request = available_environments(&client);
    let trace_request = async {
        client
            .request_ok("proc.trace", Some(json!({ "pid": pid, "limit": 1_000 })))
            .await
            .map_err(|error| error.to_string())
    };
    let process_request = async {
        client
            .request_ok(
                "proc.history",
                Some(json!({
                    "pid": pid,
                    "tail": true,
                    "limit": 1,
                })),
            )
            .await
            .map_err(|error| error.to_string())
    };
    let (history, environments, trace, process) = tokio::join!(
        history_request,
        environments_request,
        trace_request,
        process_request,
    );
    let history = history?;
    let trace = trace.ok();
    let process = process.ok();
    let active_run_id = process
        .as_ref()
        .and_then(|payload| payload.get("activeRunId"))
        .or_else(|| {
            trace
                .as_ref()
                .and_then(|payload| payload.get("activeRunId"))
        })
        .and_then(Value::as_str)
        .filter(|run_id| !run_id.is_empty())
        .map(str::to_string);
    let pending_approval = process
        .as_ref()
        .and_then(|payload| payload.get("pendingHil"))
        .filter(|payload| !payload.is_null())
        .and_then(|payload| {
            let run_id = payload
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string);
            approval_from_signal(payload).map(|approval| (run_id, approval))
        });
    let actions = trace.as_ref().map_or_else(Vec::new, trace_actions);
    let deliveries = trace.as_ref().map_or_else(Vec::new, trace_deliveries);
    Ok((
        ConnectionBootstrap {
            generation,
            session: ConnectedSession {
                generation,
                client,
                pid,
                conversation_id,
            },
            principal: account.username,
            environments,
            moments: history_moments(&history),
            history_has_more: history_has_more(&history),
            actions,
            deliveries,
            active_run_id,
            pending_approval,
        },
        signal_gate,
    ))
}

async fn observe_tui_process(
    client: &KernelClient,
    owner_uid: u64,
    preferred_pid: Option<&str>,
    strict_pid: bool,
) -> Result<String, String> {
    if let Some(pid) = preferred_pid {
        match client
            .request_ok("proc.observe", Some(json!({ "pid": pid })))
            .await
        {
            Ok(_) => return Ok(pid.to_string()),
            Err(error) if strict_pid => return Err(error.to_string()),
            Err(_) => {}
        }
    }
    let processes = client
        .request_ok("proc.list", Some(json!({ "uid": owner_uid })))
        .await
        .map_err(|error| error.to_string())?;
    let pid = personal_process_id(&processes, owner_uid)
        .ok_or_else(|| "GSV returned no personal intelligence process".to_string())?;
    client
        .request_ok("proc.observe", Some(json!({ "pid": pid })))
        .await
        .map_err(|error| error.to_string())?;
    Ok(pid)
}

fn reconnect_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(16);
    INITIAL_RECONNECT_DELAY
        .saturating_mul(1_u32 << exponent)
        .min(MAX_RECONNECT_DELAY)
}

fn apply_effects(
    app: &mut App,
    effects: Vec<Effect>,
    session: Option<&ConnectedSession>,
    demo: bool,
    artifact_store: &ArtifactStore,
    runtime_sender: &mpsc::UnboundedSender<RuntimeEvent>,
) -> bool {
    for effect in effects {
        match effect {
            Effect::Submit {
                id,
                text,
                references,
                ..
            } => {
                let Some(session) = session else {
                    if demo {
                        app.complete_demo_submission(id, &text);
                    } else {
                        app.submission_failed(
                            id,
                            "GSV is reconnecting; the request remains in your prompt.",
                        );
                    }
                    continue;
                };
                let client = Arc::clone(&session.client);
                let conversation_id = session.conversation_id.clone();
                let generation = session.generation;
                let sender = runtime_sender.clone();
                let resources = references
                    .into_iter()
                    .map(|reference| ConversationFileResource {
                        target: reference.target,
                        path: reference.path,
                        revision: reference.revision,
                        content_type: reference.content_type,
                        size: reference.size,
                        filename: reference.filename,
                    })
                    .collect::<Vec<_>>();
                let handle = tokio::spawn(async move {
                    let result = client
                        .conversation_send_with_resources(
                            &conversation_id,
                            &text,
                            &resources,
                            &uuid::Uuid::new_v4().to_string(),
                        )
                        .await;
                    let event = match result {
                        Ok(result) => SessionEvent::SubmissionAccepted {
                            id,
                            run_id: result.run_id,
                            queued: result.queued,
                        },
                        Err(error) => SessionEvent::SubmissionFailed {
                            id,
                            error: error.to_string(),
                        },
                    };
                    let _ = sender.send(RuntimeEvent::Session { generation, event });
                });
                drop(handle);
            }
            Effect::BrowseFiles {
                request_id,
                target,
                directory,
            } => {
                let Some(session) = session else {
                    if demo {
                        let entries = demo_file_entries(&directory);
                        app.file_listing_loaded(request_id, directory, entries);
                    } else {
                        app.file_picker_failed(
                            request_id,
                            "GSV is reconnecting; press ctrl+o to retry.",
                        );
                    }
                    continue;
                };
                let client = Arc::clone(&session.client);
                let generation = session.generation;
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    let event = browse_files(client, request_id, target, directory).await;
                    let _ = sender.send(RuntimeEvent::Session { generation, event });
                });
                drop(handle);
            }
            Effect::ResolveFile {
                request_id,
                target,
                path,
                filename,
            } => {
                let Some(session) = session else {
                    if demo {
                        app.file_reference_resolved(
                            request_id,
                            FileReference {
                                target,
                                path: path.clone(),
                                revision: "demo:1".to_string(),
                                content_type: content_type_from_path(&path).to_string(),
                                size: 0,
                                filename,
                            },
                        );
                    } else {
                        app.file_picker_failed(
                            request_id,
                            "GSV is reconnecting; press ctrl+o to retry.",
                        );
                    }
                    continue;
                };
                let client = Arc::clone(&session.client);
                let generation = session.generation;
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    let event = resolve_file(client, request_id, target, path, filename).await;
                    let _ = sender.send(RuntimeEvent::Session { generation, event });
                });
                drop(handle);
            }
            Effect::Shell {
                id,
                input,
                target,
                cwd,
            } => {
                let Some(session) = session else {
                    if demo {
                        app.complete_demo_shell(id, &input);
                    } else {
                        app.finish_shell(id, Some("GSV is reconnecting; the command was not run."));
                    }
                    continue;
                };
                let client = Arc::clone(&session.client);
                let generation = session.generation;
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    run_shell_command(client, sender, generation, id, input, target, cwd).await;
                });
                drop(handle);
            }
            Effect::OpenArtifact { artifact } => {
                let directory = match artifact_store.directory() {
                    Ok(directory) => directory,
                    Err(error) => {
                        app.append_local_output(format!(
                            "Could not open {}.\n\n{error}",
                            artifact.display_name()
                        ));
                        continue;
                    }
                };
                let client = session.map(|session| Arc::clone(&session.client));
                let filename = artifact.display_name().to_string();
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    if let Err(error) = media::open_artifact(directory, client, artifact).await {
                        let _ =
                            sender.send(RuntimeEvent::Local(SessionEvent::ArtifactOpenFailed {
                                filename,
                                error,
                            }));
                    }
                });
                drop(handle);
            }
            Effect::OpenUrl { url } => {
                let display = url.clone();
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    if let Err(error) = media::open_external_url(url).await {
                        let _ =
                            sender.send(RuntimeEvent::Local(SessionEvent::ArtifactOpenFailed {
                                filename: display,
                                error,
                            }));
                    }
                });
                drop(handle);
            }
            Effect::OpenPath {
                target,
                path,
                filename,
            } => {
                let Some(session) = session else {
                    app.append_local_output(format!(
                        "Could not open {filename}.\n\nStored files need a connected GSV session."
                    ));
                    continue;
                };
                let directory = match artifact_store.directory() {
                    Ok(directory) => directory,
                    Err(error) => {
                        app.append_local_output(format!("Could not open {filename}.\n\n{error}"));
                        continue;
                    }
                };
                let client = Arc::clone(&session.client);
                let generation = session.generation;
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    let result =
                        match resolve_file(Arc::clone(&client), 0, target, path, filename.clone())
                            .await
                        {
                            SessionEvent::FileResolved { reference, .. } => {
                                media::open_artifact(directory, Some(client), reference.artifact())
                                    .await
                            }
                            SessionEvent::FileOperationFailed { error, .. } => Err(error),
                            _ => Err("The selected path could not be resolved".to_string()),
                        };
                    if let Err(error) = result {
                        let _ = sender.send(RuntimeEvent::Session {
                            generation,
                            event: SessionEvent::ArtifactOpenFailed { filename, error },
                        });
                    }
                });
                drop(handle);
            }
            Effect::LoadOlderHistory { before_sequence } => {
                let Some(session) = session else {
                    app.history_page_failed();
                    continue;
                };
                let client = Arc::clone(&session.client);
                let conversation_id = session.conversation_id.clone();
                let generation = session.generation;
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    let event = match client
                        .request_ok(
                            "conversation.history",
                            Some(json!({
                                "conversationId": conversation_id,
                                "beforeSequence": before_sequence,
                                "limit": HISTORY_PAGE_SIZE,
                            })),
                        )
                        .await
                    {
                        Ok(history) => SessionEvent::HistoryPageLoaded {
                            moments: history_moments(&history),
                            has_more: history_has_more(&history),
                        },
                        Err(_) => SessionEvent::HistoryPageFailed,
                    };
                    let _ = sender.send(RuntimeEvent::Session { generation, event });
                });
                drop(handle);
            }
            Effect::Abort => {
                let Some(session) = session else {
                    if !demo {
                        app.set_activity(Some("RECONNECTING".to_string()));
                    }
                    continue;
                };
                let client = Arc::clone(&session.client);
                let pid = session.pid.clone();
                let generation = session.generation;
                let sender = runtime_sender.clone();
                let handle = tokio::spawn(async move {
                    let error = client
                        .request_ok("proc.abort", Some(json!({ "pid": pid })))
                        .await
                        .err()
                        .map(|error| error.to_string());
                    let _ = sender.send(RuntimeEvent::Session {
                        generation,
                        event: SessionEvent::AbortFinished { error },
                    });
                });
                drop(handle);
            }
            Effect::DecideApproval {
                request_id,
                decision,
                remember,
            } => {
                let Some(session) = session else {
                    continue;
                };
                let client = Arc::clone(&session.client);
                let pid = session.pid.clone();
                let generation = session.generation;
                let sender = runtime_sender.clone();
                let request_id_for_result = request_id.clone();
                let handle = tokio::spawn(async move {
                    let decision = match decision {
                        ApprovalDecision::Approve => "approve",
                        ApprovalDecision::Deny => "deny",
                    };
                    let result = client
                        .request_ok(
                            "proc.hil",
                            Some(json!({
                                "pid": pid,
                                "requestId": request_id,
                                "decision": decision,
                                "remember": remember,
                            })),
                        )
                        .await;
                    let event = match result {
                        Ok(_) => SessionEvent::ApprovalDecided {
                            request_id: request_id_for_result,
                        },
                        Err(error) => SessionEvent::ApprovalFailed {
                            error: error.to_string(),
                        },
                    };
                    let _ = sender.send(RuntimeEvent::Session { generation, event });
                });
                drop(handle);
            }
            Effect::Quit => return true,
        }
    }
    false
}

fn apply_session_event(app: &mut App, event: SessionEvent, session: Option<&ConnectedSession>) {
    match event {
        SessionEvent::Signal { name, payload } => {
            if let Some(session) = session {
                apply_signal(app, &session.pid, &session.conversation_id, &name, &payload);
            }
        }
        SessionEvent::SubmissionAccepted { id, run_id, queued } => {
            app.submission_accepted(id, run_id, queued);
        }
        SessionEvent::SubmissionFailed { id, error } => {
            app.submission_failed(id, format!("That request was not sent.\n\n{error}"));
        }
        SessionEvent::ShellOutput { id, output } => {
            app.append_shell_output(id, &output);
        }
        SessionEvent::ShellFinished { id, error } => {
            app.finish_shell(id, error.as_deref());
        }
        SessionEvent::ApprovalDecided { request_id } => {
            app.leave_approval(&request_id);
            app.set_activity(Some("APPROVED".to_string()));
        }
        SessionEvent::ApprovalFailed { error } => {
            app.set_activity(Some(format!("APPROVAL FAILED · {error}")));
        }
        SessionEvent::AbortFinished { error } => {
            app.set_activity(Some(match error {
                Some(error) => format!("STOP FAILED · {error}"),
                None => "STOPPING".to_string(),
            }));
        }
        SessionEvent::ArtifactOpenFailed { filename, error } => {
            app.append_local_output(format!("Could not open {filename}.\n\n{error}"));
        }
        SessionEvent::FilesListed {
            request_id,
            directory,
            entries,
        } => {
            app.file_listing_loaded(request_id, directory, entries);
        }
        SessionEvent::FileResolved {
            request_id,
            reference,
        } => {
            app.file_reference_resolved(request_id, reference);
        }
        SessionEvent::FileOperationFailed { request_id, error } => {
            app.file_picker_failed(request_id, error);
        }
        SessionEvent::HistoryPageLoaded { moments, has_more } => {
            app.prepend_history(moments, has_more);
        }
        SessionEvent::HistoryPageFailed => {
            app.history_page_failed();
        }
    }
}

fn apply_signal(app: &mut App, pid: &str, conversation_id: &str, name: &str, payload: &Value) {
    if signal_pid(payload).is_some_and(|actual| actual != pid)
        || signal_conversation_id(payload).is_some_and(|actual| actual != conversation_id)
    {
        return;
    }
    let run_id = signal_run_id(payload);
    match name {
        "proc.run.started" => {
            if let Some(run_id) = run_id {
                app.start_run_at(run_id, payload.get("timestamp").and_then(Value::as_u64));
            }
        }
        "message.started" => {
            if let (Some(run_id), Some(message_id)) =
                (run_id, payload.get("messageId").and_then(Value::as_str))
            {
                app.start_message_stream_at(
                    run_id,
                    message_id,
                    payload.get("timestamp").and_then(Value::as_u64),
                );
            }
        }
        "message.delta" => {
            if let (Some(message_id), Some(delta)) = (
                payload.get("messageId").and_then(Value::as_str),
                payload.get("delta").and_then(Value::as_str),
            ) {
                app.append_message_delta(run_id, message_id, delta);
            }
        }
        "message.aborted" => {
            if let Some(message_id) = payload.get("messageId").and_then(Value::as_str) {
                app.abort_message_stream(message_id);
            }
        }
        "message.committed" => {
            if let Some(message) = payload.get("message") {
                commit_signal_message(app, message);
            }
        }
        "proc.run.tool.started" => {
            let Some(run_id) = run_id else {
                return;
            };
            let Some(execution_id) = payload.get("executionId").and_then(Value::as_str) else {
                return;
            };
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let syscall = payload
                .get("syscall")
                .and_then(Value::as_str)
                .unwrap_or("working");
            let target = payload
                .get("target")
                .or_else(|| payload.get("args").and_then(|args| args.get("target")))
                .and_then(Value::as_str);
            app.start_agent_action_at(
                run_id,
                execution_id,
                name,
                syscall,
                target,
                payload.get("timestamp").and_then(Value::as_u64),
            );
        }
        "proc.run.tool.finished" => {
            if let (Some(run_id), Some(execution_id), Some(outcome)) = (
                run_id,
                payload.get("executionId").and_then(Value::as_str),
                payload.get("outcome").and_then(Value::as_str),
            ) {
                app.finish_agent_action(run_id, execution_id, outcome);
            }
        }
        "proc.run.retrying" => {
            app.set_activity(Some("TRYING ANOTHER PATH".to_string()));
        }
        "proc.run.hil.requested" => {
            if let Some(approval) = approval_from_signal(payload) {
                app.enter_approval_for(run_id, approval);
            }
        }
        "proc.run.finished" => {
            let error = payload.get("error").and_then(Value::as_str);
            app.finish_run(run_id, error);
        }
        _ => {}
    }
}

fn terminal_action(app: &App, event: TerminalEvent) -> Option<Action> {
    match event {
        TerminalEvent::Key(key)
            if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
        {
            key_action(app, key)
        }
        TerminalEvent::Mouse(_) => None,
        TerminalEvent::Paste(text) => Some(Action::Insert(text)),
        TerminalEvent::Resize(_, _)
        | TerminalEvent::FocusGained
        | TerminalEvent::FocusLost
        | TerminalEvent::Key(_) => None,
    }
}

fn key_action(app: &App, key: KeyEvent) -> Option<Action> {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    let command_modifier = key.modifiers.intersects(
        KeyModifiers::CONTROL
            | KeyModifiers::ALT
            | KeyModifiers::SUPER
            | KeyModifiers::HYPER
            | KeyModifiers::META,
    );

    if app.approval().is_some() && !command_modifier {
        return match key.code {
            KeyCode::Char('o' | 'O') => Some(Action::DecideApproval {
                decision: ApprovalDecision::Approve,
                remember: false,
            }),
            KeyCode::Char('a' | 'A') => Some(Action::DecideApproval {
                decision: ApprovalDecision::Approve,
                remember: true,
            }),
            KeyCode::Char('d' | 'D') => Some(Action::DecideApproval {
                decision: ApprovalDecision::Deny,
                remember: false,
            }),
            KeyCode::Char('?') => Some(Action::ToggleHelp),
            _ => None,
        };
    }

    if control && matches!(key.code, KeyCode::Char('r' | 'R')) {
        return Some(Action::BeginCommandSearch);
    }
    if control && matches!(key.code, KeyCode::Char('c' | 'C')) {
        return Some(Action::Abort);
    }

    if app.completion_picker_visible() {
        return match key.code {
            KeyCode::Char('q' | 'Q') if control => Some(Action::Quit),
            KeyCode::Esc => Some(Action::Escape),
            KeyCode::Enter => Some(Action::Submit),
            KeyCode::Backspace | KeyCode::Delete => Some(Action::Backspace),
            KeyCode::Up => Some(Action::PreviousChoice),
            KeyCode::Down => Some(Action::NextChoice),
            KeyCode::Char('p' | 'P') if control => Some(Action::PreviousChoice),
            KeyCode::Char('n' | 'N') if control => Some(Action::NextChoice),
            KeyCode::Char(character) if !command_modifier => {
                Some(Action::Insert(character.to_string()))
            }
            _ => None,
        };
    }

    if control && matches!(key.code, KeyCode::Char('o' | 'O')) {
        return Some(Action::OpenFiles);
    }
    if !command_modifier && key.code == KeyCode::Tab {
        return Some(Action::ToggleShell);
    }
    if key.code == KeyCode::PageUp {
        return Some(Action::ScrollPageUp);
    }
    if key.code == KeyCode::PageDown {
        return Some(Action::ScrollPageDown);
    }
    if !app.draft_visible() && control && matches!(key.code, KeyCode::Char('u' | 'U')) {
        return Some(Action::ScrollPageUp);
    }
    if !app.draft_visible() && control && matches!(key.code, KeyCode::Char('d' | 'D')) {
        return Some(Action::ScrollPageDown);
    }
    if !app.draft_visible() && !command_modifier {
        match key.code {
            KeyCode::Char('t' | 'T') => return Some(Action::ToggleActions),
            KeyCode::Char('m' | 'M') => return Some(Action::ToggleMarkdown),
            KeyCode::Char('v' | 'V') => return Some(Action::ToggleVim),
            _ => {}
        }
    }
    if !app.draft_visible() && !command_modifier && key.code == KeyCode::Char('/') {
        return Some(Action::BeginTranscriptSearch);
    }

    if app.vim_enabled() && !app.draft_visible() && !command_modifier {
        return match key.code {
            KeyCode::Char('i' | 'a') => Some(Action::BeginCompose),
            KeyCode::Char('h') => Some(Action::PreviousMedia),
            KeyCode::Char('j') => Some(Action::ScrollDown),
            KeyCode::Char('k') => Some(Action::ScrollUp),
            KeyCode::Char('l') => Some(Action::NextMedia),
            KeyCode::Char('g') => Some(Action::FirstTurn),
            KeyCode::Char('G') => Some(Action::LastTurn),
            KeyCode::Char('n') => Some(Action::NextTranscriptMatch),
            KeyCode::Char('N') => Some(Action::PreviousTranscriptMatch),
            KeyCode::Char('o') => Some(Action::OpenReferences),
            KeyCode::Enter => Some(Action::ToggleMedia),
            KeyCode::Char('?') => Some(Action::ToggleHelp),
            _ => None,
        };
    }

    match key.code {
        KeyCode::Char('q' | 'Q') if control => Some(Action::Quit),
        KeyCode::Char('p' | 'P') if control => Some(Action::PreviousCommand),
        KeyCode::Char('n' | 'N') if control => Some(Action::NextCommand),
        KeyCode::Char('a' | 'A') if control => Some(Action::MoveCursorHome),
        KeyCode::Char('e' | 'E') if control => Some(Action::MoveCursorEnd),
        KeyCode::Char('b' | 'B') if control => Some(Action::MoveCursorLeft),
        KeyCode::Char('f' | 'F') if control => Some(Action::MoveCursorRight),
        KeyCode::Char('w' | 'W') if control => Some(Action::DeleteWord),
        KeyCode::Char('?') if !app.draft_visible() && !command_modifier => Some(Action::ToggleHelp),
        KeyCode::Char('n') if !app.draft_visible() && !command_modifier => {
            Some(Action::NextTranscriptMatch)
        }
        KeyCode::Char('N') if !app.draft_visible() && !command_modifier => {
            Some(Action::PreviousTranscriptMatch)
        }
        KeyCode::Char('o' | 'O') if !app.draft_visible() && !command_modifier => {
            Some(Action::OpenReferences)
        }
        KeyCode::Char(character) if !command_modifier => {
            Some(Action::Insert(character.to_string()))
        }
        KeyCode::Enter
            if key
                .modifiers
                .intersects(KeyModifiers::SHIFT | KeyModifiers::CONTROL) =>
        {
            Some(Action::Newline)
        }
        KeyCode::Enter if !app.draft_visible() => Some(Action::ToggleMedia),
        KeyCode::Enter => Some(Action::Submit),
        KeyCode::Esc => Some(Action::Escape),
        KeyCode::Backspace => Some(Action::Backspace),
        KeyCode::Delete => Some(Action::Delete),
        KeyCode::Left if !app.draft_visible() => Some(Action::PreviousMedia),
        KeyCode::Right if !app.draft_visible() => Some(Action::NextMedia),
        KeyCode::Left => Some(Action::MoveCursorLeft),
        KeyCode::Right => Some(Action::MoveCursorRight),
        KeyCode::Home => Some(Action::MoveCursorHome),
        KeyCode::End => Some(Action::MoveCursorEnd),
        KeyCode::Up if app.draft_visible() => Some(Action::PreviousCommand),
        KeyCode::Down if app.draft_visible() => Some(Action::NextCommand),
        KeyCode::Up if !app.draft_visible() => Some(Action::ScrollUp),
        KeyCode::Down if !app.draft_visible() => Some(Action::ScrollDown),
        _ => None,
    }
}

async fn browse_files(
    client: Arc<KernelClient>,
    request_id: u64,
    target: String,
    directory: String,
) -> SessionEvent {
    let payload = match client
        .request_ok(
            "fs.read",
            Some(json!({
                "target": target,
                "path": directory,
            })),
        )
        .await
    {
        Ok(payload) => payload,
        Err(error) => {
            return SessionEvent::FileOperationFailed {
                request_id,
                error: error.to_string(),
            };
        }
    };
    match parse_file_listing(&payload) {
        Ok((directory, entries)) => SessionEvent::FilesListed {
            request_id,
            directory,
            entries,
        },
        Err(error) => SessionEvent::FileOperationFailed { request_id, error },
    }
}

async fn resolve_file(
    client: Arc<KernelClient>,
    request_id: u64,
    target: String,
    path: String,
    filename: String,
) -> SessionEvent {
    let (inspection, call, args) = file_inspection_request(&target, &path);
    let payload = match inspection {
        FileInspectionKind::Stat => client
            .request_ok(call, Some(args))
            .await
            .map_err(|error| error.to_string()),
        FileInspectionKind::Transfer => match client
            .connection()
            .request_response(call, Some(args), FILE_INSPECTION_TIMEOUT)
            .await
        {
            Ok(response) => {
                let payload = response.data;
                if let Some(mut body) = response.body {
                    body.cancel("Only file metadata was requested");
                }
                Ok(payload)
            }
            Err(error) => Err(error.to_string()),
        },
    };
    let payload = match payload {
        Ok(payload) => payload,
        Err(error) => {
            return SessionEvent::FileOperationFailed { request_id, error };
        }
    };
    match parse_file_reference(&payload, target, filename, inspection) {
        Ok(reference) => SessionEvent::FileResolved {
            request_id,
            reference,
        },
        Err(error) => SessionEvent::FileOperationFailed { request_id, error },
    }
}

fn file_inspection_request(target: &str, path: &str) -> (FileInspectionKind, &'static str, Value) {
    if target == "gsv" {
        (
            FileInspectionKind::Stat,
            "fs.transfer.stat",
            json!({ "path": path }),
        )
    } else {
        (
            FileInspectionKind::Transfer,
            "fs.transfer.send",
            json!({
                "target": target,
                "path": path,
            }),
        )
    }
}

fn parse_file_listing(payload: &Value) -> Result<(String, Vec<FileEntry>), String> {
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The target could not read this directory")
            .to_string());
    }
    let directory = payload
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "The target returned no directory path".to_string())?;
    let directories = payload
        .get("directories")
        .and_then(Value::as_array)
        .ok_or_else(|| "The selected path is not a directory".to_string())?;
    let files = payload
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| "The selected path is not a directory".to_string())?;
    let entries = directories
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| valid_file_name(name))
        .map(|name| FileEntry {
            name: name.to_string(),
            path: join_unix_path(directory, name),
            is_directory: true,
        })
        .chain(
            files
                .iter()
                .filter_map(Value::as_str)
                .filter(|name| valid_file_name(name))
                .map(|name| FileEntry {
                    name: name.to_string(),
                    path: join_unix_path(directory, name),
                    is_directory: false,
                }),
        )
        .collect();
    Ok((directory.to_string(), entries))
}

fn parse_file_reference(
    payload: &Value,
    target: String,
    filename: String,
    inspection: FileInspectionKind,
) -> Result<FileReference, String> {
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The target could not inspect this file")
            .to_string());
    }
    if inspection == FileInspectionKind::Stat
        && payload.get("isFile").and_then(Value::as_bool) != Some(true)
    {
        return Err("The selected path is not a file".to_string());
    }
    let path = payload
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "The target returned no file path".to_string())?;
    let revision = payload
        .get("revision")
        .and_then(Value::as_str)
        .filter(|revision| !revision.is_empty())
        .ok_or_else(|| "The target returned no immutable file revision".to_string())?;
    let size = payload
        .get("size")
        .and_then(Value::as_u64)
        .filter(|size| *size <= 9_007_199_254_740_991)
        .ok_or_else(|| "The target returned no valid file size".to_string())?;
    let content_type = payload
        .get("contentType")
        .and_then(Value::as_str)
        .filter(|content_type| !content_type.is_empty())
        .unwrap_or("application/octet-stream");
    Ok(FileReference {
        target,
        path: path.to_string(),
        revision: revision.to_string(),
        content_type: content_type.to_string(),
        size,
        filename,
    })
}

fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.chars().any(char::is_control)
}

fn join_unix_path(directory: &str, name: &str) -> String {
    if directory == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", directory.trim_end_matches('/'))
    }
}

fn demo_file_entries(directory: &str) -> Vec<FileEntry> {
    [
        ("projects", true),
        ("notes.md", false),
        ("reference.png", false),
        ("voice.ogg", false),
    ]
    .into_iter()
    .map(|(name, is_directory)| FileEntry {
        name: name.to_string(),
        path: join_unix_path(directory, name),
        is_directory,
    })
    .collect()
}

fn content_type_from_path(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ogg") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("md") => "text/markdown",
        Some("txt") => "text/plain",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Eq, PartialEq)]
enum ShellResponse {
    Running { output: String, session_id: String },
    Completed { output: String },
    Failed { output: String, error: String },
}

async fn run_shell_command(
    client: Arc<KernelClient>,
    sender: mpsc::UnboundedSender<RuntimeEvent>,
    generation: u64,
    id: u64,
    input: String,
    target: String,
    cwd: Option<String>,
) {
    let mut args = json!({
        "input": input,
        "target": target,
    });
    if let Some(cwd) = cwd {
        args["cwd"] = Value::String(cwd);
    }

    loop {
        let payload = match client.request_ok("shell.exec", Some(args)).await {
            Ok(payload) => payload,
            Err(error) => {
                let _ = sender.send(RuntimeEvent::Session {
                    generation,
                    event: SessionEvent::ShellFinished {
                        id,
                        error: Some(error.to_string()),
                    },
                });
                return;
            }
        };
        let response = match parse_shell_response(&payload) {
            Ok(response) => response,
            Err(error) => {
                let _ = sender.send(RuntimeEvent::Session {
                    generation,
                    event: SessionEvent::ShellFinished {
                        id,
                        error: Some(error),
                    },
                });
                return;
            }
        };
        match response {
            ShellResponse::Running { output, session_id } => {
                if !output.is_empty()
                    && sender
                        .send(RuntimeEvent::Session {
                            generation,
                            event: SessionEvent::ShellOutput { id, output },
                        })
                        .is_err()
                {
                    return;
                }
                args = json!({
                    "input": "",
                    "sessionId": session_id,
                });
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            ShellResponse::Completed { output } => {
                if !output.is_empty()
                    && sender
                        .send(RuntimeEvent::Session {
                            generation,
                            event: SessionEvent::ShellOutput { id, output },
                        })
                        .is_err()
                {
                    return;
                }
                let _ = sender.send(RuntimeEvent::Session {
                    generation,
                    event: SessionEvent::ShellFinished { id, error: None },
                });
                return;
            }
            ShellResponse::Failed { output, error } => {
                if !output.is_empty()
                    && sender
                        .send(RuntimeEvent::Session {
                            generation,
                            event: SessionEvent::ShellOutput { id, output },
                        })
                        .is_err()
                {
                    return;
                }
                let _ = sender.send(RuntimeEvent::Session {
                    generation,
                    event: SessionEvent::ShellFinished {
                        id,
                        error: Some(error),
                    },
                });
                return;
            }
        }
    }
}

fn parse_shell_response(payload: &Value) -> Result<ShellResponse, String> {
    let output = payload
        .get("output")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let stdout = payload.get("stdout").and_then(Value::as_str).unwrap_or("");
            let stderr = payload.get("stderr").and_then(Value::as_str).unwrap_or("");
            format!("{stdout}{stderr}")
        });
    match payload.get("status").and_then(Value::as_str) {
        Some("running") => {
            let session_id = payload
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|session_id| !session_id.is_empty())
                .ok_or_else(|| {
                    "shell.exec returned a running command without a session id".to_string()
                })?;
            Ok(ShellResponse::Running {
                output,
                session_id: session_id.to_string(),
            })
        }
        Some("completed") => Ok(ShellResponse::Completed { output }),
        Some("failed") => Ok(ShellResponse::Failed {
            output,
            error: payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Command failed")
                .to_string(),
        }),
        Some(status) => Err(format!("shell.exec returned unknown status: {status}")),
        None if payload.get("stdout").is_some()
            || payload.get("stderr").is_some()
            || payload.get("exitCode").is_some() =>
        {
            match payload.get("exitCode").and_then(Value::as_i64) {
                Some(exit_code) if exit_code != 0 => Ok(ShellResponse::Failed {
                    output,
                    error: format!("Command exited with code {exit_code}"),
                }),
                _ => Ok(ShellResponse::Completed { output }),
            }
        }
        None if payload.get("error").and_then(Value::as_str).is_some() => {
            Ok(ShellResponse::Failed {
                output,
                error: payload["error"]
                    .as_str()
                    .unwrap_or("Command failed")
                    .to_string(),
            })
        }
        None => Err("shell.exec returned no command status".to_string()),
    }
}

async fn available_environments(client: &KernelClient) -> Vec<CapabilityEnvironment> {
    let mut environments = vec![CapabilityEnvironment::gsv()];
    let Ok(payload) = client
        .request_ok("sys.target.list", Some(json!({ "includeOffline": false })))
        .await
    else {
        return environments;
    };
    environments.extend(target_environments(&payload));
    environments
}

fn target_environments(payload: &Value) -> Vec<CapabilityEnvironment> {
    payload
        .get("targets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|target_record| {
            let target = target_record.get("targetId").and_then(Value::as_str)?;
            if target.trim().is_empty() {
                return None;
            }
            let label = target_record
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .unwrap_or(target);
            Some(CapabilityEnvironment::new(target, label))
        })
        .collect()
}

fn history_moments(payload: &Value) -> Vec<Moment> {
    payload
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| {
            let text = message.get("text").and_then(Value::as_str)?;
            let id = value_id(message.get("id"))
                .unwrap_or_else(|| format!("history:{}", message_sequence(message)));
            let role = role_from_author(message.get("author"));
            let mut moment = Moment::complete(id, role, text)
                .with_artifacts(media_artifacts(message.get("media")))
                .with_timeline(
                    message.get("sequence").and_then(Value::as_u64),
                    message.get("createdAt").and_then(Value::as_u64),
                );
            moment.environment = message_environment(message);
            moment.run_id = message
                .get("runId")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(moment)
        })
        .collect()
}

fn history_has_more(payload: &Value) -> bool {
    payload.get("hasMore").and_then(Value::as_bool) == Some(true)
}

fn commit_signal_message(app: &mut App, message: &Value) {
    let Some(text) = message.get("text").and_then(Value::as_str) else {
        return;
    };
    let id = value_id(message.get("id"))
        .unwrap_or_else(|| format!("message:{}", message_sequence(message)));
    let run_id = message
        .get("runId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut moment = Moment::complete(id, role_from_author(message.get("author")), text)
        .with_artifacts(media_artifacts(message.get("media")))
        .with_timeline(
            message.get("sequence").and_then(Value::as_u64),
            message.get("createdAt").and_then(Value::as_u64),
        );
    moment.run_id = run_id;
    moment.environment = message_environment(message);
    app.commit_moment(moment);
}

fn message_environment(message: &Value) -> Option<CapabilityEnvironment> {
    let environment = message.get("origin")?.get("environment")?;
    let target = environment.get("target")?.as_str()?;
    if target.trim().is_empty() {
        return None;
    }
    let mut selected = CapabilityEnvironment::new(target, target);
    selected.cwd = environment
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(selected)
}

fn media_artifacts(value: Option<&Value>) -> Vec<Artifact> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(media_artifact)
        .collect()
}

fn media_artifact(value: &Value) -> Option<Artifact> {
    let object = value.as_object()?;
    if object.get("type").and_then(Value::as_str) == Some("resource") {
        let reference = object.get("ref")?.as_object()?;
        let mime_type = reference.get("contentType")?.as_str()?.to_string();
        let path = reference.get("path")?.as_str()?;
        let target = reference.get("target")?.as_str()?;
        let revision = reference.get("revision")?.as_str()?.to_string();
        return Some(Artifact {
            kind: media_kind(object.get("mediaType").and_then(Value::as_str), &mime_type),
            mime_type,
            filename: object
                .get("filename")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    path.rsplit('/')
                        .find(|part| !part.is_empty())
                        .map(str::to_string)
                }),
            size: reference.get("size").and_then(Value::as_u64),
            duration_ms: duration_millis(object.get("duration")),
            transcription: object
                .get("transcription")
                .and_then(Value::as_str)
                .map(str::to_string),
            source: Some(format!("{target}:{path}")),
            revision: Some(revision),
        });
    }

    let legacy_type = object.get("type")?.as_str()?;
    let mime_type = object
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream")
        .to_string();
    let source = object
        .get("path")
        .or_else(|| object.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            let key = object.get("key")?.as_str()?;
            let conversation = object
                .get("conversationId")
                .and_then(Value::as_str)
                .unwrap_or("process");
            Some(format!("{conversation}:{key}"))
        });
    Some(Artifact {
        kind: media_kind(Some(legacy_type), &mime_type),
        mime_type,
        filename: object
            .get("filename")
            .and_then(Value::as_str)
            .map(str::to_string),
        size: object.get("size").and_then(Value::as_u64),
        duration_ms: duration_millis(object.get("duration")),
        transcription: object
            .get("transcription")
            .and_then(Value::as_str)
            .map(str::to_string),
        source,
        revision: None,
    })
}

fn media_kind(kind: Option<&str>, mime_type: &str) -> MediaKind {
    match kind {
        Some("image") => MediaKind::Image,
        Some("audio") => MediaKind::Audio,
        Some("video") => MediaKind::Video,
        Some("document") => MediaKind::Document,
        _ if mime_type.starts_with("image/") => MediaKind::Image,
        _ if mime_type.starts_with("audio/") => MediaKind::Audio,
        _ if mime_type.starts_with("video/") => MediaKind::Video,
        _ => MediaKind::Document,
    }
}

fn duration_millis(value: Option<&Value>) -> Option<u64> {
    let seconds = value?.as_f64()?;
    std::time::Duration::try_from_secs_f64(seconds)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn role_from_author(author: Option<&Value>) -> Role {
    match author
        .and_then(|author| author.get("kind"))
        .and_then(Value::as_str)
    {
        Some("user") => Role::Human,
        Some("system") => Role::System,
        _ => Role::Intelligence,
    }
}

fn approval_from_signal(payload: &Value) -> Option<Approval> {
    let request_id = payload.get("requestId")?.as_str()?.to_string();
    let syscall = payload
        .get("syscall")
        .and_then(Value::as_str)
        .unwrap_or("unknown action")
        .to_string();
    let target = payload
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("unknown target")
        .to_string();
    let preview = payload
        .get("args")
        .and_then(|args| serde_json::to_string_pretty(args).ok())
        .map(|preview| truncate_chars(&preview, 800))
        .unwrap_or_else(|| "No action preview was provided.".to_string());
    Some(Approval {
        request_id,
        syscall,
        target,
        preview,
    })
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(limit).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn trace_actions(payload: &Value) -> Vec<AgentActionSnapshot> {
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    let active_run_id = payload.get("activeRunId").and_then(Value::as_str);
    payload
        .get("spans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|span| {
            if span.get("kind").and_then(Value::as_str) != Some("tool") {
                return None;
            }
            let id = span.get("id").and_then(Value::as_str)?;
            let fallback_execution_id = id.strip_prefix("tool:")?;
            let run_id = span.get("runId").and_then(Value::as_str)?;
            let execution_id = span
                .get("reference")
                .filter(|reference| reference.get("kind").and_then(Value::as_str) == Some("tool"))
                .and_then(|reference| reference.get("executionId"))
                .and_then(Value::as_str)
                .unwrap_or(fallback_execution_id);
            if run_id.is_empty() || execution_id.is_empty() {
                return None;
            }
            let name = span.get("name").and_then(Value::as_str).unwrap_or("action");
            let syscall = span
                .get("attributes")
                .and_then(|attributes| attributes.get("syscall"))
                .and_then(Value::as_str)
                .unwrap_or(name);
            let target = span
                .get("attributes")
                .and_then(|attributes| attributes.get("target"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let status = span
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("error");
            Some(AgentActionSnapshot {
                run_id: run_id.to_string(),
                execution_id: execution_id.to_string(),
                name: name.to_string(),
                syscall: syscall.to_string(),
                target,
                status: status.to_string(),
                live: active_run_id == Some(run_id) && status == "running",
                started_at: span.get("startedAt").and_then(Value::as_u64),
            })
        })
        .collect()
}

fn trace_deliveries(payload: &Value) -> Vec<MessageDeliverySnapshot> {
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    payload
        .get("spans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|span| {
            if span.get("kind").and_then(Value::as_str) != Some("delivery") {
                return None;
            }
            let reference = span.get("reference")?;
            if reference.get("kind").and_then(Value::as_str) != Some("delivery") {
                return None;
            }
            Some(MessageDeliverySnapshot {
                run_id: span.get("runId").and_then(Value::as_str)?.to_string(),
                message_id: reference
                    .get("messageId")
                    .and_then(Value::as_str)?
                    .to_string(),
                started_at: span.get("startedAt").and_then(Value::as_u64)?,
            })
        })
        .collect()
}

fn signal_run_id(payload: &Value) -> Option<&str> {
    payload
        .get("runId")
        .or_else(|| {
            payload
                .get("message")
                .and_then(|message| message.get("runId"))
        })
        .and_then(Value::as_str)
}

fn signal_pid(payload: &Value) -> Option<&str> {
    payload
        .get("pid")
        .or_else(|| {
            payload
                .get("message")
                .and_then(|message| message.get("pid"))
        })
        .and_then(Value::as_str)
}

fn signal_conversation_id(payload: &Value) -> Option<&str> {
    payload
        .get("conversationId")
        .or_else(|| {
            payload
                .get("message")
                .and_then(|message| message.get("conversationId"))
        })
        .and_then(Value::as_str)
}

fn value_id(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn message_sequence(message: &Value) -> String {
    message
        .get("sequence")
        .map(Value::to_string)
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use gsv_tui_core::{
        Action, App, ConnectionState, FileEntry, MediaKind, MessageDeliverySnapshot, Role,
    };
    use serde_json::json;

    use super::{
        apply_signal, target_environments, file_inspection_request, history_has_more,
        history_moments, key_action, media_artifact, parse_file_listing, parse_file_reference,
        parse_shell_response, reconnect_delay, trace_actions, trace_deliveries, truncate_chars,
        FileInspectionKind, RuntimeEvent, SessionEvent, ShellResponse, SignalGate,
    };

    #[test]
    fn conversation_history_becomes_user_visible_moments() {
        let moments = history_moments(&json!({
            "messages": [
                {
                    "id": 1,
                    "author": { "kind": "user" },
                    "text": "hello",
                    "origin": {
                        "kind": "client",
                        "environment": {
                            "target": "macbook",
                            "cwd": "/Users/sam/Downloads"
                        }
                    }
                },
                {
                    "id": 2,
                    "author": { "kind": "process" },
                    "text": "hi",
                    "runId": "run-one",
                    "media": [
                        {
                            "type": "resource",
                            "ref": {
                                "type": "file",
                                "target": "gsv",
                                "path": "/home/ship/chart.png",
                                "revision": "sha256:one",
                                "contentType": "image/png",
                                "size": 2048
                            },
                            "mediaType": "image",
                            "filename": "chart.png",
                            "transcription": "a chart"
                        }
                    ]
                }
            ]
        }));
        assert_eq!(moments.len(), 2);
        assert_eq!(moments[0].role, Role::Human);
        assert_eq!(
            moments[0]
                .environment
                .as_ref()
                .map(|environment| environment.target.as_str()),
            Some("macbook")
        );
        assert_eq!(
            moments[0]
                .environment
                .as_ref()
                .and_then(|environment| environment.cwd.as_deref()),
            Some("/Users/sam/Downloads")
        );
        assert_eq!(moments[1].role, Role::Intelligence);
        assert_eq!(moments[1].run_id.as_deref(), Some("run-one"));
        assert_eq!(moments[1].artifacts.len(), 1);
        assert_eq!(moments[1].artifacts[0].kind, MediaKind::Image);
        assert_eq!(
            moments[1].artifacts[0].source.as_deref(),
            Some("gsv:/home/ship/chart.png")
        );
        assert_eq!(
            moments[1].artifacts[0].revision.as_deref(),
            Some("sha256:one")
        );
    }

    #[test]
    fn canonical_ogg_message_media_becomes_interactive_audio() {
        let artifact = media_artifact(&json!({
            "type": "resource",
            "ref": {
                "type": "file",
                "target": "gsv",
                "path": "/home/ship/voice.ogg",
                "revision": "sha256:voice",
                "contentType": "audio/ogg",
                "size": 4096
            },
            "mediaType": "audio",
            "filename": "voice.ogg",
            "duration": 1.5
        }))
        .expect("audio artifact");

        assert_eq!(artifact.kind, MediaKind::Audio);
        assert_eq!(artifact.source.as_deref(), Some("gsv:/home/ship/voice.ogg"));
        assert_eq!(artifact.revision.as_deref(), Some("sha256:voice"));
        assert_eq!(artifact.duration_ms, Some(1_500));
    }

    #[test]
    fn signals_from_another_process_do_not_mutate_the_surface() {
        let mut app = App::new(ConnectionState::Ready);
        apply_signal(
            &mut app,
            "proc-one",
            "conversation-one",
            "message.delta",
            &json!({
                "pid": "proc-two",
                "runId": "run-two",
                "delta": "wrong"
            }),
        );
        assert!(app.moments().is_empty());
    }

    #[test]
    fn internal_process_output_never_becomes_conversation_content() {
        let mut app = App::new(ConnectionState::Ready);
        apply_signal(
            &mut app,
            "proc-one",
            "conversation-one",
            "proc.run.output",
            &json!({
                "pid": "proc-one",
                "runId": "run-one",
                "text": "transient model turn",
                "thinking": [{
                    "type": "thinking",
                    "thinking": "private reasoning"
                }]
            }),
        );

        assert!(app.moments().is_empty());
    }

    #[test]
    fn live_message_reconciles_with_its_commit_even_after_run_completion() {
        let mut app = App::new(ConnectionState::Ready);
        let target = ("proc-one", "conversation-one");
        apply_signal(
            &mut app,
            target.0,
            target.1,
            "proc.run.output",
            &json!({
                "pid": target.0,
                "runId": "run-one",
                "text": "internal assistant turn"
            }),
        );
        apply_signal(
            &mut app,
            target.0,
            target.1,
            "message.started",
            &json!({
                "pid": target.0,
                "conversationId": target.1,
                "runId": "run-one",
                "messageId": "draft:run-one:action-one"
            }),
        );
        apply_signal(
            &mut app,
            target.0,
            target.1,
            "message.delta",
            &json!({
                "pid": target.0,
                "conversationId": target.1,
                "runId": "run-one",
                "messageId": "draft:run-one:action-one",
                "delta": "The committed reply."
            }),
        );
        apply_signal(
            &mut app,
            target.0,
            target.1,
            "proc.run.finished",
            &json!({
                "pid": target.0,
                "conversationId": target.1,
                "runId": "run-one"
            }),
        );
        let committed = json!({
            "message": {
                "id": "msg:one",
                "conversationId": target.1,
                "pid": target.0,
                "runId": "run-one",
                "author": { "kind": "process" },
                "text": "The committed reply."
            }
        });
        apply_signal(
            &mut app,
            target.0,
            target.1,
            "message.committed",
            &committed,
        );
        apply_signal(
            &mut app,
            target.0,
            target.1,
            "message.committed",
            &committed,
        );

        assert_eq!(app.moments().len(), 1);
        assert_eq!(app.moments()[0].id, "msg:one");
        assert_eq!(app.moments()[0].text, "The committed reply.");
    }

    #[test]
    fn approval_previews_are_bounded_by_unicode_scalar_count() {
        let value = "é".repeat(805);
        let truncated = truncate_chars(&value, 800);
        assert_eq!(truncated.chars().count(), 801);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn vim_browse_keys_are_opt_in() {
        let mut app = App::new(ConnectionState::Ready);
        let j = KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE);
        assert_eq!(key_action(&app, j), Some(Action::Insert("j".to_string())));

        app.set_vim_enabled(true);
        assert_eq!(key_action(&app, j), Some(Action::ScrollDown));
        let k = KeyEvent::new(KeyCode::Char('k'), KeyModifiers::NONE);
        assert_eq!(key_action(&app, k), Some(Action::ScrollUp));

        let i = KeyEvent::new(KeyCode::Char('i'), KeyModifiers::NONE);
        assert_eq!(key_action(&app, i), Some(Action::BeginCompose));
        let h = KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE);
        let l = KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE);
        assert_eq!(key_action(&app, h), Some(Action::PreviousMedia));
        assert_eq!(key_action(&app, l), Some(Action::NextMedia));
    }

    #[test]
    fn shell_and_page_keys_follow_terminal_conventions() {
        let mut app = App::new(ConnectionState::Ready);
        let tab = KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE);
        let page_up = KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE);
        let page_down = KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE);
        assert_eq!(key_action(&app, tab), Some(Action::ToggleShell));
        assert_eq!(key_action(&app, page_up), Some(Action::ScrollPageUp));
        assert_eq!(key_action(&app, page_down), Some(Action::ScrollPageDown));

        app.dispatch(Action::Escape);
        let control_u = KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL);
        let control_d = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL);
        assert_eq!(key_action(&app, control_u), Some(Action::ScrollPageUp));
        assert_eq!(key_action(&app, control_d), Some(Action::ScrollPageDown));
    }

    #[test]
    fn control_o_opens_file_completion() {
        let app = App::new(ConnectionState::Ready);
        let control_o = KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL);
        assert_eq!(key_action(&app, control_o), Some(Action::OpenFiles));
    }

    #[test]
    fn browse_keys_toggle_presentation_without_stealing_typed_text() {
        let mut app = App::new(ConnectionState::Ready);
        for (key, expected) in [
            ('t', Action::ToggleActions),
            ('m', Action::ToggleMarkdown),
            ('v', Action::ToggleVim),
        ] {
            let event = KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE);
            assert_eq!(
                key_action(&app, event),
                Some(Action::Insert(key.to_string()))
            );

            app.dispatch(Action::Escape);
            assert_eq!(key_action(&app, event), Some(expected));
            app.dispatch(Action::BeginCompose);
        }
    }

    #[test]
    fn control_c_stops_ship() {
        let mut app = App::new(ConnectionState::Ready);
        let control_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(key_action(&app, control_c), Some(Action::Abort));

        app.dispatch(Action::OpenFiles);
        assert!(app.completion_picker_visible());
        assert_eq!(key_action(&app, control_c), Some(Action::Abort));
    }

    #[test]
    fn process_trace_projects_only_parent_tool_actions() {
        let actions = trace_actions(&json!({
            "ok": true,
            "activeRunId": "run-one",
            "spans": [
                {
                    "id": "tool:execution-one",
                    "runId": "run-one",
                    "kind": "tool",
                    "name": "Read",
                    "status": "running",
                    "startedAt": 42,
                    "reference": {
                        "kind": "tool",
                        "callId": "call-one",
                        "executionId": "execution-one"
                    },
                    "attributes": {
                        "syscall": "fs.read",
                        "target": "macbook",
                        "private": "must not be projected"
                    }
                },
                {
                    "id": "execution:execution-one",
                    "runId": "run-one",
                    "kind": "tool",
                    "name": "fs.read",
                    "status": "running"
                },
                {
                    "id": "reasoning:one",
                    "runId": "run-one",
                    "kind": "reasoning",
                    "name": "private reasoning",
                    "status": "ok"
                }
            ]
        }));

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].run_id, "run-one");
        assert_eq!(actions[0].execution_id, "execution-one");
        assert_eq!(actions[0].name, "Read");
        assert_eq!(actions[0].syscall, "fs.read");
        assert_eq!(actions[0].target.as_deref(), Some("macbook"));
        assert_eq!(actions[0].status, "running");
        assert!(actions[0].live);
        assert_eq!(actions[0].started_at, Some(42));
    }

    #[test]
    fn process_trace_correlates_deliveries_with_canonical_messages() {
        let deliveries = trace_deliveries(&json!({
            "ok": true,
            "spans": [
                {
                    "id": "delivery:one",
                    "runId": "run-one",
                    "kind": "delivery",
                    "startedAt": 123,
                    "reference": {
                        "kind": "delivery",
                        "conversationId": "ship:one",
                        "messageId": "message:one"
                    }
                },
                {
                    "id": "delivery:pending",
                    "runId": "run-one",
                    "kind": "delivery",
                    "startedAt": 124,
                    "reference": { "kind": "delivery", "callId": "call:two" }
                }
            ]
        }));

        assert_eq!(
            deliveries,
            vec![MessageDeliverySnapshot {
                run_id: "run-one".to_string(),
                message_id: "message:one".to_string(),
                started_at: 123,
            }]
        );
    }

    #[test]
    fn directory_results_become_exact_target_paths() {
        let (directory, entries) = parse_file_listing(&json!({
            "ok": true,
            "path": "/Users/sam/Downloads",
            "directories": ["projects", "..", "bad/name"],
            "files": ["notes.md", "\u{001b}escape"]
        }))
        .expect("directory listing");

        assert_eq!(directory, "/Users/sam/Downloads");
        assert_eq!(
            entries,
            vec![
                FileEntry {
                    name: "projects".to_string(),
                    path: "/Users/sam/Downloads/projects".to_string(),
                    is_directory: true,
                },
                FileEntry {
                    name: "notes.md".to_string(),
                    path: "/Users/sam/Downloads/notes.md".to_string(),
                    is_directory: false,
                },
            ]
        );
    }

    #[test]
    fn gsv_file_inspection_uses_stat_without_target_metadata() {
        let (inspection, call, args) = file_inspection_request("gsv", "/home/agent/context.md");

        assert_eq!(inspection, FileInspectionKind::Stat);
        assert_eq!(call, "fs.transfer.stat");
        assert_eq!(args, json!({ "path": "/home/agent/context.md" }));
    }

    #[test]
    fn routed_file_inspection_uses_transfer_metadata() {
        let (inspection, call, args) =
            file_inspection_request("macbook", "/Users/sam/Downloads/notes.md");

        assert_eq!(inspection, FileInspectionKind::Transfer);
        assert_eq!(call, "fs.transfer.send");
        assert_eq!(
            args,
            json!({
                "target": "macbook",
                "path": "/Users/sam/Downloads/notes.md"
            })
        );
    }

    #[test]
    fn transfer_stat_becomes_a_revision_bound_file_reference() {
        let reference = parse_file_reference(
            &json!({
                "ok": true,
                "path": "/home/agent/context.md",
                "size": 512,
                "isFile": true,
                "isDirectory": false,
                "contentType": "text/markdown",
                "revision": "mtime:42"
            }),
            "gsv".to_string(),
            "context.md".to_string(),
            FileInspectionKind::Stat,
        )
        .expect("file reference");

        assert_eq!(reference.target, "gsv");
        assert_eq!(reference.path, "/home/agent/context.md");
        assert_eq!(reference.revision, "mtime:42");
        assert_eq!(reference.content_type, "text/markdown");
        assert_eq!(reference.size, 512);
        assert_eq!(reference.filename, "context.md");
    }

    #[test]
    fn transfer_metadata_becomes_a_revision_bound_file_reference() {
        let reference = parse_file_reference(
            &json!({
                "ok": true,
                "path": "/Users/sam/Downloads/notes.md",
                "size": 512,
                "contentType": "text/markdown",
                "revision": "mtime:42"
            }),
            "macbook".to_string(),
            "notes.md".to_string(),
            FileInspectionKind::Transfer,
        )
        .expect("file reference");

        assert_eq!(reference.target, "macbook");
        assert_eq!(reference.path, "/Users/sam/Downloads/notes.md");
        assert_eq!(reference.revision, "mtime:42");
        assert_eq!(reference.content_type, "text/markdown");
        assert_eq!(reference.size, 512);
        assert_eq!(reference.filename, "notes.md");
    }

    #[test]
    fn shell_responses_preserve_stream_chunks_and_legacy_output() {
        assert_eq!(
            parse_shell_response(&json!({
                "status": "running",
                "output": "one\n",
                "sessionId": "shell-one"
            })),
            Ok(ShellResponse::Running {
                output: "one\n".to_string(),
                session_id: "shell-one".to_string(),
            })
        );
        assert_eq!(
            parse_shell_response(&json!({
                "status": "completed",
                "output": "two\n",
                "exitCode": 0
            })),
            Ok(ShellResponse::Completed {
                output: "two\n".to_string(),
            })
        );
        assert_eq!(
            parse_shell_response(&json!({
                "stdout": "old out\n",
                "stderr": "old err\n",
                "exitCode": 7
            })),
            Ok(ShellResponse::Failed {
                output: "old out\nold err\n".to_string(),
                error: "Command exited with code 7".to_string(),
            })
        );
        assert_eq!(
            parse_shell_response(&json!({ "error": "permission denied" })),
            Ok(ShellResponse::Failed {
                output: String::new(),
                error: "permission denied".to_string(),
            })
        );
    }

    #[test]
    fn arrow_keys_choose_media_while_browsing() {
        let mut app = App::new(ConnectionState::Ready);
        app.dispatch(Action::Escape);
        let left = KeyEvent::new(KeyCode::Left, KeyModifiers::NONE);
        let right = KeyEvent::new(KeyCode::Right, KeyModifiers::NONE);
        assert_eq!(key_action(&app, left), Some(Action::PreviousMedia));
        assert_eq!(key_action(&app, right), Some(Action::NextMedia));
    }

    #[test]
    fn arrow_and_control_keys_recall_commands_while_composing() {
        let app = App::new(ConnectionState::Ready);
        let up = KeyEvent::new(KeyCode::Up, KeyModifiers::NONE);
        let down = KeyEvent::new(KeyCode::Down, KeyModifiers::NONE);
        let control_p = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL);
        let control_n = KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL);
        assert_eq!(key_action(&app, up), Some(Action::PreviousCommand));
        assert_eq!(key_action(&app, down), Some(Action::NextCommand));
        assert_eq!(key_action(&app, control_p), Some(Action::PreviousCommand));
        assert_eq!(key_action(&app, control_n), Some(Action::NextCommand));
    }

    #[test]
    fn shell_native_search_and_open_keys_are_available_while_browsing() {
        let mut app = App::new(ConnectionState::Ready);
        assert_eq!(
            key_action(
                &app,
                KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)
            ),
            Some(Action::BeginCommandSearch)
        );
        app.dispatch(Action::Escape);
        assert_eq!(
            key_action(&app, KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE)),
            Some(Action::BeginTranscriptSearch)
        );
        assert_eq!(
            key_action(&app, KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE)),
            Some(Action::NextTranscriptMatch)
        );
        assert_eq!(
            key_action(&app, KeyEvent::new(KeyCode::Char('o'), KeyModifiers::NONE)),
            Some(Action::OpenReferences)
        );
    }

    #[test]
    fn target_discovery_preserves_exact_ids_and_human_labels() {
        let environments = target_environments(&json!({
            "targets": [
                { "targetId": "macbook.local", "label": "Sam's MacBook" },
                { "targetId": "studio", "label": "" }
            ]
        }));
        assert_eq!(environments.len(), 2);
        assert_eq!(environments[0].target, "macbook.local");
        assert_eq!(environments[0].label, "Sam's MacBook");
        assert_eq!(environments[1].target, "studio");
        assert_eq!(environments[1].label, "studio");
    }

    #[test]
    fn conversation_history_exposes_older_pages() {
        assert!(history_has_more(&json!({ "hasMore": true })));
        assert!(!history_has_more(&json!({ "hasMore": false })));
        assert!(!history_has_more(&json!({})));
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_capped() {
        assert_eq!(reconnect_delay(1), std::time::Duration::from_millis(250));
        assert_eq!(reconnect_delay(2), std::time::Duration::from_millis(500));
        assert_eq!(reconnect_delay(6), std::time::Duration::from_secs(8));
        assert_eq!(reconnect_delay(u32::MAX), std::time::Duration::from_secs(8));
    }

    #[test]
    fn signals_wait_behind_the_connection_snapshot() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let gate = SignalGate::new(7, sender);
        gate.push("first".to_string(), json!({ "value": 1 }));
        gate.push("second".to_string(), json!({ "value": 2 }));
        assert!(receiver.try_recv().is_err());

        gate.activate();
        for expected in ["first", "second"] {
            match receiver.try_recv().expect("buffered signal") {
                RuntimeEvent::Session {
                    generation: 7,
                    event: SessionEvent::Signal { name, .. },
                } => assert_eq!(name, expected),
                _ => panic!("unexpected runtime event"),
            }
        }

        gate.push("third".to_string(), json!({ "value": 3 }));
        assert!(matches!(
            receiver.try_recv(),
            Ok(RuntimeEvent::Session {
                generation: 7,
                event: SessionEvent::Signal { name, .. },
            }) if name == "third"
        ));
    }
}
