use crate::protocol::{NodeExecEventParams, ToolDefinition};
use crate::tools::Tool;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use uuid::Uuid;

const DEFAULT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const MIN_YIELD_MS: u64 = 10;
const MAX_YIELD_MS: u64 = 120_000;
const MAX_OUTPUT_CHARS: usize = 200_000;
const TAIL_CHARS: usize = 4_000;
const FINISHED_TTL_MS: i64 = 30 * 60 * 1000;

#[derive(Clone)]
struct ProcessHandle {
    state: Arc<AsyncMutex<ProcessState>>,
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
}

#[derive(Clone)]
struct FinishedProcess {
    snapshot: ProcessSnapshot,
    ended_at: i64,
}

#[derive(Clone)]
struct ProcessSnapshot {
    session_id: String,
    command: String,
    workdir: String,
    pid: Option<u32>,
    started_at: i64,
    ended_at: Option<i64>,
    status: String,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    backgrounded: bool,
    output: String,
    tail: String,
    truncated: bool,
}

struct ProcessState {
    session_id: String,
    command: String,
    workdir: String,
    pid: Option<u32>,
    started_at: i64,
    ended_at: Option<i64>,
    status: String,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    backgrounded: bool,
    output: String,
    tail: String,
    truncated: bool,
    started_notified: bool,
}

#[derive(Clone)]
struct ProcessEntry {
    session_id: String,
    status: String,
    pid: Option<u32>,
    started_at: i64,
    ended_at: Option<i64>,
    runtime_ms: i64,
    workdir: String,
    command: String,
    tail: String,
    truncated: bool,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
}

static RUNNING_SESSIONS: OnceLock<Mutex<HashMap<String, ProcessHandle>>> = OnceLock::new();
static FINISHED_SESSIONS: OnceLock<Mutex<HashMap<String, FinishedProcess>>> = OnceLock::new();
static EXEC_EVENT_BUS: OnceLock<broadcast::Sender<NodeExecEventParams>> = OnceLock::new();

fn running_sessions() -> &'static Mutex<HashMap<String, ProcessHandle>> {
    RUNNING_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn finished_sessions() -> &'static Mutex<HashMap<String, FinishedProcess>> {
    FINISHED_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn exec_event_bus() -> &'static broadcast::Sender<NodeExecEventParams> {
    EXEC_EVENT_BUS.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(256);
        tx
    })
}

pub fn subscribe_exec_events() -> broadcast::Receiver<NodeExecEventParams> {
    exec_event_bus().subscribe()
}

fn emit_exec_event(event: NodeExecEventParams) {
    let _ = exec_event_bus().send(event);
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_millis(0))
        .as_millis() as i64
}

fn truncate_to_last_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }
    text.chars()
        .skip(char_count.saturating_sub(max_chars))
        .collect()
}

fn append_output(state: &mut ProcessState, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    let combined = format!("{}{}", state.output, chunk);
    let combined_chars = combined.chars().count();
    if combined_chars > MAX_OUTPUT_CHARS {
        state.output = truncate_to_last_chars(&combined, MAX_OUTPUT_CHARS);
        state.truncated = true;
    } else {
        state.output = combined;
    }
    state.tail = truncate_to_last_chars(&state.output, TAIL_CHARS);
}

fn snapshot_from_state(state: &ProcessState) -> ProcessSnapshot {
    ProcessSnapshot {
        session_id: state.session_id.clone(),
        command: state.command.clone(),
        workdir: state.workdir.clone(),
        pid: state.pid,
        started_at: state.started_at,
        ended_at: state.ended_at,
        status: state.status.clone(),
        exit_code: state.exit_code,
        signal: state.signal.clone(),
        timed_out: state.timed_out,
        backgrounded: state.backgrounded,
        output: state.output.clone(),
        tail: state.tail.clone(),
        truncated: state.truncated,
    }
}

fn prune_finished_locked(finished: &mut HashMap<String, FinishedProcess>) {
    let cutoff = now_ms() - FINISHED_TTL_MS;
    finished.retain(|_, session| session.ended_at >= cutoff);
}

fn get_running_session(session_id: &str) -> Option<ProcessHandle> {
    running_sessions()
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(session_id).cloned())
}

fn get_finished_session(session_id: &str) -> Option<FinishedProcess> {
    let mut sessions = finished_sessions().lock().ok()?;
    prune_finished_locked(&mut sessions);
    sessions.get(session_id).cloned()
}

fn list_finished_background_sessions() -> Vec<FinishedProcess> {
    let mut sessions = match finished_sessions().lock() {
        Ok(sessions) => sessions,
        Err(_) => return Vec::new(),
    };
    prune_finished_locked(&mut sessions);
    sessions
        .values()
        .filter(|session| session.snapshot.backgrounded)
        .cloned()
        .collect()
}

fn running_result(snapshot: &ProcessSnapshot) -> Value {
    json!({
      "status": "running",
      "sessionId": snapshot.session_id,
      "pid": snapshot.pid,
      "startedAt": snapshot.started_at,
      "tail": snapshot.tail,
      "workdir": snapshot.workdir,
    })
}

fn completed_result(snapshot: &ProcessSnapshot) -> Value {
    json!({
      "status": if snapshot.status == "completed" { "completed" } else { "failed" },
      "sessionId": snapshot.session_id,
      "exitCode": snapshot.exit_code,
      "signal": snapshot.signal,
      "timedOut": snapshot.timed_out,
      "startedAt": snapshot.started_at,
      "endedAt": snapshot.ended_at,
      "durationMs": snapshot.ended_at.map(|ended| ended.saturating_sub(snapshot.started_at)),
      "output": snapshot.output,
      "tail": snapshot.tail,
      "truncated": snapshot.truncated,
      "workdir": snapshot.workdir,
    })
}

fn entry_from_snapshot(snapshot: &ProcessSnapshot, now: i64) -> ProcessEntry {
    let end = snapshot.ended_at.unwrap_or(now);
    ProcessEntry {
        session_id: snapshot.session_id.clone(),
        status: snapshot.status.clone(),
        pid: snapshot.pid,
        started_at: snapshot.started_at,
        ended_at: snapshot.ended_at,
        runtime_ms: end.saturating_sub(snapshot.started_at),
        workdir: snapshot.workdir.clone(),
        command: snapshot.command.clone(),
        tail: snapshot.tail.clone(),
        truncated: snapshot.truncated,
        exit_code: snapshot.exit_code,
        signal: snapshot.signal.clone(),
        timed_out: snapshot.timed_out,
    }
}

fn entries_to_json(entries: &[ProcessEntry]) -> Value {
    let sessions: Vec<Value> = entries
        .iter()
        .map(|entry| {
            json!({
              "sessionId": entry.session_id,
              "status": entry.status,
              "pid": entry.pid,
              "startedAt": entry.started_at,
              "endedAt": entry.ended_at,
              "runtimeMs": entry.runtime_ms,
              "workdir": entry.workdir,
              "command": entry.command,
              "tail": entry.tail,
              "truncated": entry.truncated,
              "exitCode": entry.exit_code,
              "signal": entry.signal,
              "timedOut": entry.timed_out,
            })
        })
        .collect();
    json!({ "status": "completed", "sessions": sessions })
}

fn slice_log_lines(
    text: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> (String, usize, usize) {
    let lines: Vec<&str> = text.lines().collect();
    let start = offset.unwrap_or(0).min(lines.len());
    let cap = limit.unwrap_or(200).max(1);
    let end = (start + cap).min(lines.len());
    let slice = lines[start..end].join("\n");
    (slice, lines.len(), text.chars().count())
}

fn normalize_signal_name(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return Some(format!("SIG{}", signal));
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path)
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

async fn terminate_pid(pid: u32, force: bool) {
    #[cfg(unix)]
    {
        if force {
            let _ = Command::new("kill")
                .arg("-KILL")
                .arg(pid.to_string())
                .status()
                .await;
            return;
        }
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .await;
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.arg("/PID").arg(pid.to_string()).arg("/T");
        if force {
            command.arg("/F");
        }
        let _ = command.status().await;
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        let _ = force;
    }
}

async fn pump_stream<R>(mut reader: R, state: Arc<AsyncMutex<ProcessState>>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut buf = vec![0u8; 4096];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => return,
            Ok(count) => {
                let chunk = String::from_utf8_lossy(&buf[..count]).to_string();
                let mut lock = state.lock().await;
                append_output(&mut lock, &chunk);
            }
            Err(_) => return,
        }
    }
}

async fn mark_backgrounded(handle: &ProcessHandle, call_id: Option<String>) -> ProcessSnapshot {
    let mut state = handle.state.lock().await;
    state.backgrounded = true;
    if !state.started_notified {
        state.started_notified = true;
        emit_exec_event(NodeExecEventParams {
            event_id: Uuid::new_v4().to_string(),
            session_id: state.session_id.clone(),
            event: "started".to_string(),
            call_id,
            exit_code: None,
            signal: None,
            output_tail: if state.tail.is_empty() {
                None
            } else {
                Some(state.tail.clone())
            },
            started_at: Some(state.started_at),
            ended_at: None,
        });
    }
    snapshot_from_state(&state)
}

async fn launch_managed_process(
    command: String,
    workdir: PathBuf,
    timeout_ms: u64,
) -> Result<ProcessHandle, String> {
    let shell = resolve_login_shell();
    let mut cmd = Command::new(&shell);
    cmd.arg("-lc").arg(&command);
    cmd.current_dir(&workdir);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute: {}", e))?;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    let session_id = Uuid::new_v4().to_string();
    let started_at = now_ms();

    let state = Arc::new(AsyncMutex::new(ProcessState {
        session_id: session_id.clone(),
        command,
        workdir: workdir.display().to_string(),
        pid,
        started_at,
        ended_at: None,
        status: "running".to_string(),
        exit_code: None,
        signal: None,
        timed_out: false,
        backgrounded: false,
        output: String::new(),
        tail: String::new(),
        truncated: false,
        started_notified: false,
    }));
    let stdin = Arc::new(AsyncMutex::new(stdin));

    let handle = ProcessHandle {
        state: state.clone(),
        stdin: stdin.clone(),
    };

    if let Ok(mut sessions) = running_sessions().lock() {
        sessions.insert(session_id.clone(), handle.clone());
    }

    if let Some(stdout) = stdout {
        tokio::spawn(pump_stream(stdout, state.clone()));
    }
    if let Some(stderr) = stderr {
        tokio::spawn(pump_stream(stderr, state.clone()));
    }

    if timeout_ms > 0 {
        let state_for_timeout = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
            let pid_to_kill = {
                let mut lock = state_for_timeout.lock().await;
                if lock.ended_at.is_some() {
                    None
                } else {
                    lock.timed_out = true;
                    lock.pid
                }
            };
            if let Some(pid) = pid_to_kill {
                terminate_pid(pid, false).await;
                tokio::time::sleep(Duration::from_millis(250)).await;
                terminate_pid(pid, true).await;
            }
        });
    }

    tokio::spawn(async move {
        let wait_result = child.wait().await;

        let (snapshot, should_emit_event, event_name) = {
            let mut lock = state.lock().await;
            lock.ended_at = Some(now_ms());
            match wait_result {
                Ok(status) => {
                    lock.exit_code = status.code();
                    lock.signal = normalize_signal_name(&status);
                }
                Err(error) => {
                    lock.exit_code = None;
                    lock.signal = Some("wait_error".to_string());
                    append_output(&mut lock, &format!("\n[wait error] {}", error));
                }
            }

            lock.status = if lock.timed_out {
                "timed_out".to_string()
            } else if lock.exit_code == Some(0) && lock.signal.is_none() {
                "completed".to_string()
            } else {
                "failed".to_string()
            };

            let snapshot = snapshot_from_state(&lock);
            let event_name = if lock.timed_out {
                "timed_out"
            } else if lock.status == "completed" {
                "finished"
            } else {
                "failed"
            };
            (snapshot, lock.backgrounded, event_name.to_string())
        };

        if let Ok(mut sessions) = running_sessions().lock() {
            sessions.remove(&snapshot.session_id);
        }

        {
            let mut stdin_guard = stdin.lock().await;
            *stdin_guard = None;
        }

        if should_emit_event {
            if let Ok(mut finished) = finished_sessions().lock() {
                prune_finished_locked(&mut finished);
                finished.insert(
                    snapshot.session_id.clone(),
                    FinishedProcess {
                        ended_at: snapshot.ended_at.unwrap_or_else(now_ms),
                        snapshot: snapshot.clone(),
                    },
                );
            }

            emit_exec_event(NodeExecEventParams {
                event_id: Uuid::new_v4().to_string(),
                session_id: snapshot.session_id,
                event: event_name,
                call_id: None,
                exit_code: snapshot.exit_code,
                signal: snapshot.signal,
                output_tail: if snapshot.tail.is_empty() {
                    None
                } else {
                    Some(snapshot.tail)
                },
                started_at: Some(snapshot.started_at),
                ended_at: snapshot.ended_at,
            });
        }
    });

    Ok(handle)
}

pub struct BashTool {
    workspace: PathBuf,
}

impl BashTool {
    pub fn new(workspace: PathBuf) -> Self {
        Self { workspace }
    }

    fn resolve_path(&self, path: &str) -> PathBuf {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            self.workspace.join(path)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BashArgs {
    command: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    background: Option<bool>,
    #[serde(default)]
    yield_ms: Option<u64>,
}

#[async_trait]
impl Tool for BashTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Bash".to_string(),
            description:
                "Execute shell commands. Supports async background mode with session tracking."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command to execute"
                    },
                    "workdir": {
                        "type": "string",
                        "description": "Working directory (default: workspace)"
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Timeout in milliseconds (optional)"
                    },
                    "background": {
                        "type": "boolean",
                        "description": "Run in background immediately and return a sessionId"
                    },
                    "yieldMs": {
                        "type": "number",
                        "description": "Wait this many milliseconds, then background if still running"
                    }
                },
                "required": ["command"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let args: BashArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        if args.command.trim().is_empty() {
            return Err("command must not be empty".to_string());
        }

        let workdir = args
            .workdir
            .as_deref()
            .map(|w| self.resolve_path(w))
            .unwrap_or_else(|| self.workspace.clone());

        let timeout_ms = args.timeout.unwrap_or(DEFAULT_TIMEOUT_MS);
        let handle = launch_managed_process(args.command, workdir, timeout_ms).await?;

        if args.background == Some(true) {
            let snapshot = mark_backgrounded(&handle, None).await;
            return Ok(running_result(&snapshot));
        }

        let yield_ms = args
            .yield_ms
            .map(|requested| requested.max(MIN_YIELD_MS).min(MAX_YIELD_MS));

        if let Some(window_ms) = yield_ms {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(window_ms);
            loop {
                let snapshot = {
                    let lock = handle.state.lock().await;
                    snapshot_from_state(&lock)
                };

                if snapshot.ended_at.is_some() {
                    return Ok(completed_result(&snapshot));
                }

                if tokio::time::Instant::now() >= deadline {
                    let running = mark_backgrounded(&handle, None).await;
                    return Ok(running_result(&running));
                }

                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }

        loop {
            let snapshot = {
                let lock = handle.state.lock().await;
                snapshot_from_state(&lock)
            };
            if snapshot.ended_at.is_some() {
                return Ok(completed_result(&snapshot));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

pub struct ProcessTool;

impl ProcessTool {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessArgs {
    action: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[async_trait]
impl Tool for ProcessTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Process".to_string(),
            description: "Manage background Bash sessions: list, poll, log, write, submit, kill."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "One of: list, poll, log, write, submit, kill"
                    },
                    "sessionId": {
                        "type": "string",
                        "description": "Session id for actions other than list"
                    },
                    "data": {
                        "type": "string",
                        "description": "Data to send for write/submit"
                    },
                    "offset": {
                        "type": "number",
                        "description": "Log line offset for log action"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Max log lines for log action"
                    }
                },
                "required": ["action"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let args: ProcessArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;
        let action = args.action.trim().to_lowercase();

        if action == "list" {
            let now = now_ms();
            let running_handles: Vec<ProcessHandle> = running_sessions()
                .lock()
                .ok()
                .map(|sessions| sessions.values().cloned().collect())
                .unwrap_or_default();

            let mut entries: Vec<ProcessEntry> = Vec::new();
            for handle in running_handles {
                let snapshot = {
                    let lock = handle.state.lock().await;
                    snapshot_from_state(&lock)
                };
                if snapshot.backgrounded {
                    entries.push(entry_from_snapshot(&snapshot, now));
                }
            }

            for finished in list_finished_background_sessions() {
                entries.push(entry_from_snapshot(&finished.snapshot, now));
            }

            entries.sort_by(|a, b| b.started_at.cmp(&a.started_at));
            let lines: Vec<String> = entries
                .iter()
                .map(|entry| {
                    format!(
                        "{} {:<9} {}ms :: {}",
                        entry.session_id, entry.status, entry.runtime_ms, entry.command
                    )
                })
                .collect();

            let mut payload = entries_to_json(&entries);
            payload["text"] = Value::String(if lines.is_empty() {
                "No running or recent sessions.".to_string()
            } else {
                lines.join("\n")
            });
            return Ok(payload);
        }

        let session_id = args
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "sessionId is required for this action".to_string())?
            .to_string();

        match action.as_str() {
            "poll" => {
                if let Some(handle) = get_running_session(&session_id) {
                    let snapshot = {
                        let lock = handle.state.lock().await;
                        snapshot_from_state(&lock)
                    };
                    if !snapshot.backgrounded {
                        return Ok(json!({
                          "status": "failed",
                          "error": format!("Session {} is not backgrounded", session_id),
                        }));
                    }
                    return Ok(json!({
                      "status": snapshot.status,
                      "sessionId": snapshot.session_id,
                      "exitCode": snapshot.exit_code,
                      "signal": snapshot.signal,
                      "timedOut": snapshot.timed_out,
                      "tail": snapshot.tail,
                      "running": snapshot.ended_at.is_none(),
                    }));
                }
                if let Some(finished) = get_finished_session(&session_id) {
                    let snapshot = finished.snapshot;
                    return Ok(json!({
                      "status": snapshot.status,
                      "sessionId": snapshot.session_id,
                      "exitCode": snapshot.exit_code,
                      "signal": snapshot.signal,
                      "timedOut": snapshot.timed_out,
                      "tail": snapshot.tail,
                      "running": false,
                    }));
                }
                Ok(json!({
                  "status": "failed",
                  "error": format!("No session found for {}", session_id),
                }))
            }
            "log" => {
                if let Some(handle) = get_running_session(&session_id) {
                    let snapshot = {
                        let lock = handle.state.lock().await;
                        snapshot_from_state(&lock)
                    };
                    if !snapshot.backgrounded {
                        return Ok(json!({
                          "status": "failed",
                          "error": format!("Session {} is not backgrounded", session_id),
                        }));
                    }
                    let (slice, total_lines, total_chars) =
                        slice_log_lines(&snapshot.output, args.offset, args.limit);
                    return Ok(json!({
                      "status": snapshot.status,
                      "sessionId": snapshot.session_id,
                      "log": if slice.is_empty() { "(no output yet)" } else { &slice },
                      "totalLines": total_lines,
                      "totalChars": total_chars,
                      "truncated": snapshot.truncated,
                    }));
                }
                if let Some(finished) = get_finished_session(&session_id) {
                    let snapshot = finished.snapshot;
                    let (slice, total_lines, total_chars) =
                        slice_log_lines(&snapshot.output, args.offset, args.limit);
                    return Ok(json!({
                      "status": snapshot.status,
                      "sessionId": snapshot.session_id,
                      "log": if slice.is_empty() { "(no output recorded)" } else { &slice },
                      "totalLines": total_lines,
                      "totalChars": total_chars,
                      "truncated": snapshot.truncated,
                      "exitCode": snapshot.exit_code,
                      "signal": snapshot.signal,
                    }));
                }
                Ok(json!({
                  "status": "failed",
                  "error": format!("No session found for {}", session_id),
                }))
            }
            "write" | "submit" => {
                let handle = match get_running_session(&session_id) {
                    Some(handle) => handle,
                    None => {
                        return Ok(json!({
                          "status": "failed",
                          "error": format!("No active session found for {}", session_id),
                        }));
                    }
                };

                let snapshot = {
                    let lock = handle.state.lock().await;
                    snapshot_from_state(&lock)
                };
                if !snapshot.backgrounded {
                    return Ok(json!({
                      "status": "failed",
                      "error": format!("Session {} is not backgrounded", session_id),
                    }));
                }
                if snapshot.ended_at.is_some() {
                    return Ok(json!({
                      "status": "failed",
                      "error": format!("Session {} has already exited", session_id),
                    }));
                }

                let mut stdin_guard = handle.stdin.lock().await;
                let stdin = match stdin_guard.as_mut() {
                    Some(stdin) => stdin,
                    None => {
                        return Ok(json!({
                          "status": "failed",
                          "error": format!("Session {} stdin is not writable", session_id),
                        }));
                    }
                };
                let mut payload = args.data.unwrap_or_default();
                if action == "submit" {
                    payload.push('\n');
                }
                stdin
                    .write_all(payload.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write to {}: {}", session_id, e))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| format!("Failed to flush {}: {}", session_id, e))?;

                Ok(json!({
                  "status": "running",
                  "sessionId": session_id,
                  "bytesWritten": payload.len(),
                }))
            }
            "kill" => {
                let handle = match get_running_session(&session_id) {
                    Some(handle) => handle,
                    None => {
                        return Ok(json!({
                          "status": "failed",
                          "error": format!("No active session found for {}", session_id),
                        }));
                    }
                };
                let snapshot = {
                    let lock = handle.state.lock().await;
                    snapshot_from_state(&lock)
                };
                if !snapshot.backgrounded {
                    return Ok(json!({
                      "status": "failed",
                      "error": format!("Session {} is not backgrounded", session_id),
                    }));
                }
                if let Some(pid) = snapshot.pid {
                    terminate_pid(pid, true).await;
                    return Ok(json!({
                      "status": "running",
                      "sessionId": session_id,
                      "message": "Kill signal sent",
                    }));
                }
                Ok(json!({
                  "status": "failed",
                  "error": format!("Session {} has no PID", session_id),
                }))
            }
            _ => Ok(json!({
              "status": "failed",
              "error": format!("Unknown action {}", action),
            })),
        }
    }
}
