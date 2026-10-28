//! `gsv ship`: the conversation with your Ship, and `gsv work open`, which
//! talks to one piece of work the same way.
//!
//! Replies stream to stdout; progress, approvals and notices go to stderr so
//! a one-shot reply can be piped. `--json` waits for the run and prints the
//! committed replies instead of streaming.

use std::collections::HashMap;
use std::io::{self, BufRead, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gsv::kernel_client::{cli_peer_identity, BinaryBodyLimits, GatewayAuth, KernelClient};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::account::release_hint;
use super::activity_labels;
use super::approvals::render_request;
use crate::cli::ShipAction;
use crate::markdown::{self, Markdown};
use crate::remote::{self, call, items, number, text, DynError, Output};
use crate::render::{self, Style, Tone};

const CHAT_WAIT_TIMEOUT_SECS: u64 = 600;
const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_TICK: std::time::Duration = std::time::Duration::from_millis(80);
/// Erases the current terminal line and returns to its start.
const CLEAR_LINE: &str = "\r\x1b[2K";

/// What is on the terminal while a run streams. One lock covers the spinner
/// and every write, so the spinner never shares a line with the reply.
#[derive(Default)]
struct Screen {
    /// What the spinner says while waiting, such as "Thinking".
    waiting: Option<String>,
    drawn: bool,
    frame: usize,
    /// The reply on stdout ended without a newline.
    mid_line: bool,
    /// Tool calls in flight, by call id, with the line to print when each ends.
    tools: HashMap<String, String>,
    /// Renders the reply when stdout is a terminal.
    markdown: Markdown,
}

impl Screen {
    fn clear_spinner(&mut self) {
        if self.drawn {
            eprint!("{CLEAR_LINE}");
            let _ = io::stderr().flush();
            self.drawn = false;
        }
    }

    fn end_line(&mut self) {
        let rest = self.markdown.finish();
        if !rest.is_empty() {
            print!("{rest}");
            self.mid_line = true;
        }
        if self.mid_line {
            println!();
            let _ = io::stdout().flush();
            self.mid_line = false;
        }
    }
}

/// Stops the spinner's redraw task when the conversation ends.
struct Ticker(tokio::task::JoinHandle<()>);

impl Drop for Ticker {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Which conversation to talk to.
pub(crate) enum Conversation {
    Ship,
    Work(String),
}

#[derive(Clone, Debug)]
struct PendingChatSignal {
    signal: String,
    payload: Value,
}

type StdinLine = Result<String, String>;

fn client_debug_enabled() -> bool {
    std::env::var("GSV_CLIENT_DEBUG")
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !normalized.is_empty() && normalized != "0" && normalized != "false"
        })
        .unwrap_or(false)
}

fn debug_log(enabled: bool, message: impl AsRef<str>) {
    if enabled {
        eprintln!("[gateway-client-debug] {}", message.as_ref());
    }
}

/// How a tool call reads: the line left once it ends, and what the spinner
/// says while it runs. The model's purpose comes first, then the activity
/// label for its syscall, then the raw name.
fn tool_words(payload: &Value) -> (String, String) {
    if let Some(purpose) = super::approvals::purpose(payload) {
        return (purpose.clone(), purpose);
    }
    let syscall = remote::opt_text(payload, "syscall").unwrap_or_default();
    if let Some(label) = activity_labels::label(syscall) {
        let doing = activity_labels::progressive(syscall).unwrap_or_else(|| label.to_string());
        return (label.to_string(), doing);
    }
    let name = remote::opt_text(payload, "name")
        .or_else(|| remote::opt_text(payload, "syscall"))
        .unwrap_or("a tool")
        .to_string();
    (name.clone(), name)
}

/// One plain line for a failed run, with the diagnostic reference when the
/// error carries one. Known causes get their own words; anything else stays
/// generic, and the full error is in `--json`.
fn failure_line(error: &str) -> String {
    let reference = error
        .split("Inference reference:")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .map(|id| id.chars().take(8).collect::<String>());
    let lower = error.to_ascii_lowercase();
    let cause = if lower.contains("managed inference is disabled") {
        Some("managed inference is turned off for this Ship")
    } else {
        None
    };
    match (cause, reference) {
        (Some(cause), Some(reference)) => {
            format!("Your Ship couldn't answer: {cause}. (ref {reference})")
        }
        (Some(cause), None) => format!("Your Ship couldn't answer: {cause}."),
        (None, Some(reference)) => format!("Your Ship couldn't answer. (ref {reference})"),
        (None, None) => format!(
            "Your Ship couldn't answer: {}",
            render::truncate(&render::one_line(error), 160)
        ),
    }
}

fn signal_run_id(payload: &Value) -> Option<String> {
    payload
        .get("runId")
        .or_else(|| {
            payload
                .get("message")
                .and_then(|message| message.get("runId"))
        })
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

/// Everything the signal handler and the prompt loop share about the run
/// being waited for.
struct ChatState {
    debug: bool,
    json: bool,
    notices: Style,
    expected_run_id: Mutex<Option<String>>,
    awaiting_response: AtomicBool,
    emitted_text: AtomicBool,
    completed: AtomicBool,
    pending: Mutex<Vec<PendingChatSignal>>,
    replies: Mutex<Vec<Value>>,
    /// The raw error of the last run that failed, kept for `--json`.
    failure: Mutex<Option<String>>,
    /// Whether to animate progress: stderr is a terminal and not `--json`.
    spinner: bool,
    screen: Mutex<Screen>,
    hil_requests: mpsc::UnboundedSender<Value>,
}

impl ChatState {
    fn new(debug: bool, json: bool, hil_requests: mpsc::UnboundedSender<Value>) -> Self {
        Self {
            debug,
            json,
            notices: Style::stderr(),
            expected_run_id: Mutex::new(None),
            awaiting_response: AtomicBool::new(false),
            emitted_text: AtomicBool::new(false),
            completed: AtomicBool::new(false),
            pending: Mutex::new(Vec::new()),
            replies: Mutex::new(Vec::new()),
            failure: Mutex::new(None),
            spinner: !json
                && io::stderr().is_terminal()
                && std::env::var("TERM").map_or(true, |term| term != "dumb"),
            screen: Mutex::new(Screen {
                markdown: Markdown::new(
                    !json && io::stdout().is_terminal(),
                    Style::stdout().colored(),
                    markdown::hyperlinks_supported(),
                ),
                ..Screen::default()
            }),
            hil_requests,
        }
    }

    fn print(&self, text: &str) {
        if self.json {
            return;
        }
        if let Ok(mut screen) = self.screen.lock() {
            screen.waiting = None;
            screen.clear_spinner();
            let text = screen.markdown.push(text);
            print!("{text}");
            let _ = io::stdout().flush();
            if !text.is_empty() {
                screen.mid_line = !text.ends_with('\n');
            }
        }
        self.emitted_text.store(true, Ordering::SeqCst);
    }

    /// Ends a partly printed reply line, so what follows starts on its own.
    fn end_text(&self) {
        if self.json {
            return;
        }
        if let Ok(mut screen) = self.screen.lock() {
            screen.end_line();
        }
    }

    fn notice(&self, tone: Tone, text: &str) {
        if self.json {
            return;
        }
        if let Ok(mut screen) = self.screen.lock() {
            screen.clear_spinner();
            screen.end_line();
            eprintln!("{}", self.notices.paint(tone, text));
        }
    }

    /// Shows the spinner with this label while waiting, or hides it.
    fn wait_for(&self, label: Option<&str>) {
        if !self.spinner {
            return;
        }
        if let Ok(mut screen) = self.screen.lock() {
            screen.waiting = label.map(str::to_string);
            if label.is_none() {
                screen.clear_spinner();
            }
        }
        if label.is_some() {
            self.tick();
        }
    }

    fn tick(&self) {
        let Ok(mut screen) = self.screen.lock() else {
            return;
        };
        if screen.mid_line {
            return;
        }
        let Some(label) = screen.waiting.clone() else {
            return;
        };
        screen.frame = (screen.frame + 1) % SPINNER_FRAMES.len();
        let frame = SPINNER_FRAMES.get(screen.frame).copied().unwrap_or("·");
        let line = render::truncate(&format!("{label}…"), self.notices.width().saturating_sub(3));
        eprint!(
            "{CLEAR_LINE}{} {}",
            self.notices.paint(Tone::Accent, frame),
            self.notices.dim(&line)
        );
        let _ = io::stderr().flush();
        screen.drawn = true;
    }

    fn tool_started(&self, payload: &Value) {
        let (done, doing) = tool_words(payload);
        let line = render::truncate(&format!("· {done}"), self.notices.width());
        if !self.spinner {
            self.notice(Tone::Dim, &line);
            return;
        }
        self.end_text();
        if let Ok(mut screen) = self.screen.lock() {
            screen
                .tools
                .insert(text(payload, "callId").to_string(), line);
        }
        self.wait_for(Some(&doing));
    }

    /// Leaves the lines of tool calls that never reported their end.
    fn flush_tools(&self) {
        let lines: Vec<String> = self
            .screen
            .lock()
            .map(|mut screen| screen.tools.drain().map(|(_, line)| line).collect())
            .unwrap_or_default();
        for line in lines {
            self.notice(Tone::Dim, &line);
        }
    }

    fn tool_finished(&self, payload: &Value) {
        if !self.spinner {
            return;
        }
        let line = self
            .screen
            .lock()
            .ok()
            .and_then(|mut screen| screen.tools.remove(text(payload, "callId")));
        if let Some(line) = line {
            match text(payload, "outcome") {
                "failed" => self.notice(Tone::Bad, &format!("{line} (failed)")),
                "denied" => self.notice(Tone::Warn, &format!("{line} (blocked)")),
                "cancelled" => self.notice(Tone::Dim, &format!("{line} (stopped)")),
                _ => self.notice(Tone::Dim, &line),
            }
        }
        self.wait_for(Some("Thinking"));
    }

    fn begin_wait(&self) {
        self.completed.store(false, Ordering::SeqCst);
        self.emitted_text.store(false, Ordering::SeqCst);
        self.awaiting_response.store(true, Ordering::SeqCst);
        if let Ok(mut expected) = self.expected_run_id.lock() {
            *expected = None;
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }

    fn expect_run(&self, run_id: String) {
        if let Ok(mut expected) = self.expected_run_id.lock() {
            *expected = Some(run_id.clone());
        }
        self.drain_pending(&run_id);
    }

    /// Signals can arrive before `conversation.send` returns the run id;
    /// they wait here and replay once the id is known.
    fn drain_pending(&self, run_id: &str) {
        let queued = match self.pending.lock() {
            Ok(mut pending) => std::mem::take(&mut *pending),
            Err(_) => return,
        };
        let total = queued.len();
        let mut processed = 0usize;
        for queued_signal in queued {
            if signal_run_id(&queued_signal.payload).as_deref() != Some(run_id) {
                continue;
            }
            processed += 1;
            process_chat_signal(self, &queued_signal.signal, &queued_signal.payload);
            if !self.awaiting_response.load(Ordering::SeqCst) {
                break;
            }
        }
        debug_log(
            self.debug,
            format!("drain pending runId={run_id} total={total} processed={processed}"),
        );
    }

    fn receive(&self, signal: &str, payload: Value) {
        if !signal.starts_with("proc.run.") && !signal.starts_with("message.") {
            return;
        }
        if !self.awaiting_response.load(Ordering::SeqCst) {
            debug_log(self.debug, "signal ignored (awaiting_response=false)");
            return;
        }
        let incoming = signal_run_id(&payload);
        let expected = self
            .expected_run_id
            .lock()
            .ok()
            .and_then(|run_id| run_id.clone());
        let Some(expected) = expected else {
            if incoming.is_some() {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.push(PendingChatSignal {
                        signal: signal.to_string(),
                        payload,
                    });
                }
            }
            return;
        };
        if incoming.as_deref() != Some(expected.as_str()) {
            debug_log(
                self.debug,
                format!("signal ignored (runId mismatch): {incoming:?} expected={expected}"),
            );
            return;
        }
        process_chat_signal(self, signal, &payload);
    }
}

fn process_chat_signal(state: &ChatState, signal: &str, payload: &Value) {
    debug_log(
        state.debug,
        format!(
            "process signal={} runId={}",
            signal,
            signal_run_id(payload).unwrap_or_else(|| "<none>".to_string())
        ),
    );

    match signal {
        "message.committed" => {
            let message = payload.get("message").cloned().unwrap_or(Value::Null);
            let directed_process_message = payload.get("directed").and_then(Value::as_bool)
                == Some(true)
                && message
                    .get("author")
                    .and_then(|author| author.get("kind"))
                    .and_then(Value::as_str)
                    == Some("process");
            if !directed_process_message {
                return;
            }
            if let Ok(mut replies) = state.replies.lock() {
                replies.push(message.clone());
            }
            if !state.emitted_text.load(Ordering::SeqCst) {
                if let Some(text) = message.get("text").and_then(Value::as_str) {
                    state.print(text);
                }
            }
            state.wait_for(None);
        }
        "message.delta" => {
            if let Some(text) = payload.get("delta").and_then(Value::as_str) {
                state.print(text);
            }
        }
        "message.aborted" => {
            state.emitted_text.store(false, Ordering::SeqCst);
            state.end_text();
        }
        "proc.run.tool.started" => {
            state.emitted_text.store(false, Ordering::SeqCst);
            state.tool_started(payload);
        }
        "proc.run.tool.finished" => state.tool_finished(payload),
        "proc.run.hil.requested" => {
            if payload.get("requestId").and_then(Value::as_str).is_some()
                && payload.get("pid").and_then(Value::as_str).is_some()
            {
                state.wait_for(None);
                state.end_text();
                let _ = state.hil_requests.send(payload.clone());
            }
        }
        "proc.run.finished" => {
            state.wait_for(None);
            state.end_text();
            state.flush_tools();
            let aborted = payload.get("status").and_then(Value::as_str) == Some("aborted");
            match payload.get("error").and_then(Value::as_str) {
                Some(error) if !aborted => {
                    state.notice(Tone::Bad, &failure_line(error));
                    if let Ok(mut failure) = state.failure.lock() {
                        *failure = Some(error.to_string());
                    }
                }
                _ if aborted => state.notice(Tone::Dim, "Stopped."),
                _ => {}
            }
            if let Ok(mut run_id) = state.expected_run_id.lock() {
                *run_id = None;
            }
            state.awaiting_response.store(false, Ordering::SeqCst);
            state.emitted_text.store(false, Ordering::SeqCst);
            state.completed.store(true, Ordering::SeqCst);
        }
        _ => {}
    }
}

fn spawn_stdin_reader() -> mpsc::UnboundedReceiver<StdinLine> {
    let (sender, receiver) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let result = line.map_err(|error| error.to_string());
            if sender.send(result).is_err() {
                return;
            }
        }
    });
    receiver
}

async fn handle_hil_request(
    client: &KernelClient,
    payload: Value,
    stdin_lines: &mut mpsc::UnboundedReceiver<StdinLine>,
    interactive_stdin: bool,
) {
    let style = Style::stderr();
    let (Some(pid), Some(request_id)) = (
        payload.get("pid").and_then(Value::as_str),
        payload.get("requestId").and_then(Value::as_str),
    ) else {
        return;
    };
    eprintln!();
    eprint!("{}", render_request(&style, &payload));
    if !interactive_stdin {
        eprintln!(
            "{}",
            style.dim("It waits for you. Answer it in the web app or on your messenger.")
        );
        return;
    }

    let (decision, remember) = loop {
        eprint!(
            "{} ",
            style.strong("Allow once [o], always [a], or block [b]?")
        );
        let _ = io::stderr().flush();
        let Some(line) = stdin_lines.recv().await else {
            eprintln!("\nInput closed; the action is still waiting.");
            return;
        };
        let line = match line {
            Ok(line) => line.trim().to_ascii_lowercase(),
            Err(error) => {
                eprintln!("\nCould not read your answer: {error}");
                return;
            }
        };
        match line.as_str() {
            "o" | "once" | "allow" | "approve" | "y" | "yes" => break ("approve", false),
            "a" | "always" => break ("approve", true),
            "b" | "block" | "d" | "deny" | "n" | "no" => break ("deny", false),
            _ => eprintln!("{}", style.dim("Type o, a, or b.")),
        }
    };

    let answer = client
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
    match answer {
        Ok(result) if result.get("ok").and_then(Value::as_bool) != Some(false) => {
            let said = match (decision, remember) {
                ("approve", true) => "Allowed, and from now on.",
                ("approve", false) => "Allowed once.",
                _ => "Blocked.",
            };
            eprintln!("{}", style.dim(said));
        }
        Ok(result) => eprintln!(
            "{}",
            style.paint(
                Tone::Bad,
                remote::opt_text(&result, "error").unwrap_or("Your answer was not accepted.")
            )
        ),
        Err(error) => eprintln!("{}", style.paint(Tone::Bad, &error.to_string())),
    }
}

async fn wait_for_chat_complete(
    state: &ChatState,
    client: &KernelClient,
    hil_requests: &mut mpsc::UnboundedReceiver<Value>,
    stdin_lines: &mut mpsc::UnboundedReceiver<StdinLine>,
    interactive_stdin: bool,
) -> Result<(), DynError> {
    let timeout = tokio::time::Duration::from_secs(CHAT_WAIT_TIMEOUT_SECS);
    let start = tokio::time::Instant::now();

    while !state.completed.load(Ordering::SeqCst) {
        if client.connection().is_disconnected() {
            return Err(
                "Lost the connection to your Ship. The reply will be in gsv ship history.".into(),
            );
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "Stopped waiting after {} minutes. Your Ship keeps working; see gsv ship history.",
                CHAT_WAIT_TIMEOUT_SECS / 60
            )
            .into());
        }
        tokio::select! {
            request = hil_requests.recv() => {
                if let Some(request) = request {
                    handle_hil_request(client, request, stdin_lines, interactive_stdin).await;
                    if !state.completed.load(Ordering::SeqCst) {
                        state.wait_for(Some("Thinking"));
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {}
        }
    }
    Ok(())
}

async fn conversation_id(
    client: &KernelClient,
    conversation: &Conversation,
) -> Result<(String, String), DynError> {
    match conversation {
        Conversation::Ship => {
            let result = call(client, "conversation.ship", json!({})).await?;
            let summary = result.get("conversation").cloned().unwrap_or(Value::Null);
            let id = text(&summary, "id");
            if id.is_empty() {
                return Err(
                    "Your Ship has no conversation yet. Open it once in the web app.".into(),
                );
            }
            Ok((id.to_string(), "Ship".to_string()))
        }
        Conversation::Work(input) => {
            let pid = super::work::resolve_pid(client, input).await?;
            let id = client.conversation_for_process(&pid).await?;
            Ok((id, format!("Work {}", render::short_id(&pid))))
        }
    }
}

async fn send(
    client: &KernelClient,
    state: &ChatState,
    conversation_id: &str,
    message: &str,
) -> Result<Value, DynError> {
    state.begin_wait();
    let result = call(
        client,
        "conversation.send",
        json!({
            "conversationId": conversation_id,
            "text": message,
            "idempotencyKey": uuid::Uuid::new_v4().to_string(),
        }),
    )
    .await?;
    let run_id = text(&result, "runId");
    if run_id.is_empty() {
        return Err("Your Ship accepted the message but started no reply".into());
    }
    if remote::flag(&result, "queued") {
        state.notice(
            Tone::Dim,
            "Busy with something else; your message is queued.",
        );
    }
    state.wait_for(Some("Thinking"));
    state.expect_run(run_id.to_string());
    Ok(result)
}

pub(crate) async fn run_client(
    url: &str,
    auth: GatewayAuth,
    message: Option<String>,
    conversation: Conversation,
    out: Output,
) -> Result<(), DynError> {
    let debug = client_debug_enabled();
    let message = match message {
        Some(message) => Some(message),
        None => remote::piped_stdin()?,
    };
    if out.json && message.is_none() {
        return Err("--json needs a message, for example: gsv ship --json \"hi\"".into());
    }

    let (hil_sender, mut hil_requests) = mpsc::unbounded_channel::<Value>();
    let state = Arc::new(ChatState::new(debug, out.json, hil_sender));
    let _ticker = state.spinner.then(|| {
        let state = state.clone();
        Ticker(tokio::spawn(async move {
            let mut interval = tokio::time::interval(SPINNER_TICK);
            loop {
                interval.tick().await;
                state.tick();
            }
        }))
    });
    let handler_state = state.clone();
    let client = KernelClient::connect_with_peer(
        url,
        cli_peer_identity(),
        Vec::new(),
        auth,
        BinaryBodyLimits::default(),
        move |frame| {
            if let gsv::protocol::Frame::Sig(sig) = frame {
                let payload = sig.payload.unwrap_or_else(|| json!({}));
                handler_state.receive(&sig.signal, payload);
            }
        },
    )
    .await?;
    if let Some(hint) = client
        .connection()
        .connect_result
        .as_ref()
        .and_then(|result| release_hint(gsv::build_info::PACKAGE_VERSION, &result.server))
    {
        state.notice(Tone::Dim, &hint);
    }
    let interactive_stdin = io::stdin().is_terminal();
    let mut stdin_lines = spawn_stdin_reader();
    let (conversation_id, title) = conversation_id(&client, &conversation).await?;
    debug_log(debug, format!("conversation={conversation_id}"));

    if let Some(message) = message {
        let sent = send(&client, &state, &conversation_id, &message).await?;
        wait_for_chat_complete(
            &state,
            &client,
            &mut hil_requests,
            &mut stdin_lines,
            interactive_stdin,
        )
        .await?;
        let failure = state
            .failure
            .lock()
            .map(|failure| failure.clone())
            .unwrap_or_default();
        if out.json {
            let replies = state
                .replies
                .lock()
                .map(|replies| replies.clone())
                .unwrap_or_default();
            render::print_json(&json!({
                "conversationId": conversation_id,
                "sent": sent,
                "replies": replies,
                "error": failure,
            }))?;
        }
        return match failure {
            Some(_) => Err(Box::new(remote::Exit(1))),
            None => Ok(()),
        };
    }

    let style = Style::stderr();
    let space = crate::auth_flow::space_name(url);
    eprintln!(
        "{} {}",
        style.strong(&title),
        style.dim(&format!("on {space} · /quit to leave"))
    );
    let prompt = || {
        eprint!("\n{} ", style.paint(Tone::Accent, "›"));
        let _ = io::stderr().flush();
    };
    prompt();

    // Input stays open while a reply runs, so a correction or /quit never waits for it.
    let mut replying = false;
    let mut input_open = true;
    loop {
        tokio::select! {
            request = hil_requests.recv() => {
                if let Some(request) = request {
                    handle_hil_request(&client, request, &mut stdin_lines, interactive_stdin).await;
                    if state.completed.load(Ordering::SeqCst) {
                        prompt();
                    } else {
                        state.wait_for(Some("Thinking"));
                    }
                }
            }
            line = stdin_lines.recv(), if input_open => {
                let Some(line) = line else {
                    input_open = false;
                    if replying { continue } else { break }
                };
                let line = line.map_err(DynError::from)?;
                let line = line.trim();
                if matches!(line, "quit" | "exit" | "/quit" | "/exit" | "/q") {
                    break;
                }
                if line.is_empty() {
                    if !replying {
                        prompt();
                    }
                    continue;
                }
                send(&client, &state, &conversation_id, line).await?;
                replying = true;
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)), if replying => {
                if client.connection().is_disconnected() {
                    return Err(
                        "Lost the connection to your Ship. The reply will be in gsv ship history.".into(),
                    );
                }
                if state.completed.load(Ordering::SeqCst) {
                    replying = false;
                    if !input_open {
                        break;
                    }
                    prompt();
                }
            }
        }
    }
    eprintln!();
    Ok(())
}

fn author_label(author: &Value, me: u64) -> (String, Tone) {
    match text(author, "kind") {
        "user" if number(author, "uid") == Some(me as i64) => ("You".to_string(), Tone::Accent),
        "user" => ("Someone".to_string(), Tone::Normal),
        "process" => ("Ship".to_string(), Tone::Strong),
        "contact" => (
            remote::opt_text(author, "displayName")
                .unwrap_or("Contact")
                .to_string(),
            Tone::Strong,
        ),
        _ => ("Ship".to_string(), Tone::Strong),
    }
}

pub(crate) async fn run_action(
    url: &str,
    auth: GatewayAuth,
    action: ShipAction,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let me = remote::me(&client)?.uid;
    let (conversation_id, _) = conversation_id(&client, &Conversation::Ship).await?;
    let style = out.style;
    let now = render::now_ms();
    match action {
        ShipAction::History { limit } => {
            let result = call(
                &client,
                "conversation.history",
                json!({ "conversationId": conversation_id, "limit": limit.clamp(1, 200) }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            let messages = items(&result, "messages");
            if messages.is_empty() {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        "No messages yet.",
                        Some("Say hello: gsv ship \"hi\"")
                    )
                );
                return Ok(());
            }
            for (index, message) in messages.iter().enumerate() {
                if index > 0 {
                    println!();
                }
                let author = message.get("author").cloned().unwrap_or(Value::Null);
                let (name, tone) = author_label(&author, me);
                let when = number(message, "createdAt")
                    .map(|at| render::relative_time(at, now))
                    .unwrap_or_default();
                println!("{}  {}", style.paint(tone, &name), style.dim(&when));
                let body = text(message, "text").trim();
                let attachments = items(message, "media").len();
                if !body.is_empty() {
                    println!("{body}");
                }
                if attachments > 0 {
                    println!(
                        "{}",
                        style.dim(&format!(
                            "[{}]",
                            render::count(attachments, "attachment", "attachments")
                        ))
                    );
                }
            }
            if remote::flag(&result, "hasMore") {
                println!();
                print!(
                    "{}",
                    render::hint(&style, "Older messages: gsv ship history -n 100")
                );
            }
        }
        ShipAction::Search { query } => {
            let query = remote::words(&query).ok_or("Give some words to find")?;
            let result = call(
                &client,
                "conversation.search",
                json!({ "conversationId": conversation_id, "query": query, "limit": 20 }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            let hits = items(&result, "hits");
            if hits.is_empty() {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        &format!("Nothing in your conversation matches \"{query}\"."),
                        Some("Try fewer or different words.")
                    )
                );
                return Ok(());
            }
            let mut table = render::Table::bare().flex(2);
            for hit in hits {
                let author = hit.get("author").cloned().unwrap_or(Value::Null);
                let (name, tone) = author_label(&author, me);
                table.row(vec![
                    render::Cell::new(name, tone),
                    render::Cell::new(
                        number(hit, "createdAt")
                            .map(|at| render::relative_time(at, now))
                            .unwrap_or_default(),
                        Tone::Dim,
                    ),
                    text(hit, "snippet").into(),
                ]);
            }
            print!(
                "{}",
                render::heading(
                    &style,
                    &format!("\"{query}\""),
                    Some(&render::count(hits.len(), "match", "matches"))
                )
            );
            print!("{}", table.render(&style));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_lines_prefer_the_purpose_then_the_label_then_the_name() {
        let purposeful = json!({
            "syscall": "shell.exec", "name": "Shell",
            "purpose": "  Checking your calendar\n for tomorrow  "
        });
        assert_eq!(
            tool_words(&purposeful),
            (
                "Checking your calendar for tomorrow".to_string(),
                "Checking your calendar for tomorrow".to_string()
            )
        );
        let labelled = json!({ "syscall": "shell.exec", "name": "Shell", "purpose": "   " });
        assert_eq!(
            tool_words(&labelled),
            ("ran a command".to_string(), "Running a command".to_string())
        );
        let unknown = json!({ "syscall": "made.up", "name": "Mystery" });
        assert_eq!(
            tool_words(&unknown),
            ("Mystery".to_string(), "Mystery".to_string())
        );
    }

    #[test]
    fn failed_runs_read_as_one_plain_line_with_their_reference() {
        let disabled = "Generation failed: Inference reference: 7afee6a6-1b2c-4d5e\nManaged inference is disabled for this installation";
        assert_eq!(
            failure_line(disabled),
            "Your Ship couldn't answer: managed inference is turned off for this Ship. (ref 7afee6a6)"
        );
        assert_eq!(
            failure_line("Generation failed: Inference reference: 0c1d2e3f\nupstream 503"),
            "Your Ship couldn't answer. (ref 0c1d2e3f)"
        );
        assert_eq!(
            failure_line("Generation failed: context\ntoo long"),
            "Your Ship couldn't answer: Generation failed: context too long"
        );
    }

    fn state() -> (ChatState, mpsc::UnboundedReceiver<Value>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let state = ChatState::new(false, true, sender);
        if let Ok(mut expected) = state.expected_run_id.lock() {
            *expected = Some("run-one".to_string());
        }
        state.awaiting_response.store(true, Ordering::SeqCst);
        (state, receiver)
    }

    #[test]
    fn an_aborted_message_stream_allows_the_committed_replacement_to_print() {
        let (state, _requests) = state();
        state.emitted_text.store(true, Ordering::SeqCst);
        process_chat_signal(
            &state,
            "message.aborted",
            &json!({ "runId": "run-one", "reason": "projection changed" }),
        );
        assert!(!state.emitted_text.load(Ordering::SeqCst));
        assert!(state.awaiting_response.load(Ordering::SeqCst));
        assert!(!state.completed.load(Ordering::SeqCst));
    }

    #[test]
    fn a_committed_user_input_is_not_printed_as_the_answer() {
        let (state, _requests) = state();
        process_chat_signal(
            &state,
            "message.committed",
            &json!({
                "directed": false,
                "message": {
                    "runId": "run-one",
                    "author": { "kind": "user", "uid": 1000 },
                    "text": "hello"
                }
            }),
        );
        assert!(state.replies.lock().expect("replies").is_empty());
        assert!(!state.completed.load(Ordering::SeqCst));
    }

    #[test]
    fn committed_replies_are_kept_for_json_output() {
        let (state, _requests) = state();
        let message = json!({
            "runId": "run-one",
            "author": { "kind": "process", "pid": "proc:1", "uid": 1000 },
            "text": "Two meetings today."
        });
        process_chat_signal(
            &state,
            "message.committed",
            &json!({ "directed": true, "message": message }),
        );
        process_chat_signal(&state, "proc.run.finished", &json!({ "runId": "run-one" }));
        assert_eq!(*state.replies.lock().expect("replies"), vec![message]);
        assert!(state.completed.load(Ordering::SeqCst));
    }

    #[test]
    fn signals_before_the_run_id_wait_and_replay() {
        let (sender, _requests) = mpsc::unbounded_channel();
        let state = ChatState::new(false, true, sender);
        state.begin_wait();
        state.receive("proc.run.finished", json!({ "runId": "run-two" }));
        assert!(!state.completed.load(Ordering::SeqCst));
        state.expect_run("run-two".to_string());
        assert!(state.completed.load(Ordering::SeqCst));
    }

    #[test]
    fn queues_structured_hil_requests_without_parsing_prompt_text() {
        let (state, mut requests) = state();
        let payload = json!({
            "pid": "proc-one",
            "runId": "run-one",
            "requestId": "request-one",
            "syscall": "shell.exec",
            "target": "gsv",
            "args": { "input": "date" }
        });
        process_chat_signal(&state, "proc.run.hil.requested", &payload);
        assert_eq!(requests.try_recv().ok(), Some(payload));
        assert!(state.awaiting_response.load(Ordering::SeqCst));
    }
}
