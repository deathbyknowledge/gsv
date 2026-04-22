use crate::protocol::{NodeExecEventParams, ToolDefinition};
use crate::tools::Tool;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use uuid::Uuid;

const DEFAULT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const MIN_YIELD_MS: u64 = 10;
const MAX_YIELD_MS: u64 = 120_000;
const MAX_OUTPUT_CHARS: usize = 200_000;
const TAIL_CHARS: usize = 4_000;

#[derive(Clone)]
struct ProcessHandle {
    state: Arc<AsyncMutex<ProcessState>>,
}

#[derive(Clone)]
struct ProcessSnapshot {
    session_id: String,
    workdir: String,
    pid: Option<u32>,
    started_at: i64,
    ended_at: Option<i64>,
    status: String,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    stdout: String,
    stderr: String,
    output: String,
    tail: String,
    truncated: bool,
}

struct ProcessState {
    session_id: String,
    workdir: String,
    pid: Option<u32>,
    started_at: i64,
    ended_at: Option<i64>,
    status: String,
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    backgrounded: bool,
    stdout: String,
    stderr: String,
    output: String,
    tail: String,
    truncated: bool,
    started_notified: bool,
}

static EXEC_EVENT_BUS: OnceLock<broadcast::Sender<NodeExecEventParams>> = OnceLock::new();

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

#[derive(Clone, Copy)]
enum OutputStream {
    Stdout,
    Stderr,
}

fn append_capped(text: &mut String, chunk: &str) -> bool {
    if chunk.is_empty() {
        return false;
    }
    let combined = format!("{}{}", text, chunk);
    let combined_chars = combined.chars().count();
    if combined_chars > MAX_OUTPUT_CHARS {
        *text = truncate_to_last_chars(&combined, MAX_OUTPUT_CHARS);
        true
    } else {
        *text = combined;
        false
    }
}

fn append_output(state: &mut ProcessState, chunk: &str, stream: OutputStream) {
    let stream_truncated = match stream {
        OutputStream::Stdout => append_capped(&mut state.stdout, chunk),
        OutputStream::Stderr => append_capped(&mut state.stderr, chunk),
    };
    let output_truncated = append_capped(&mut state.output, chunk);
    state.tail = truncate_to_last_chars(&state.output, TAIL_CHARS);
    state.truncated = state.truncated || stream_truncated || output_truncated;
}

fn snapshot_from_state(state: &ProcessState) -> ProcessSnapshot {
    ProcessSnapshot {
        session_id: state.session_id.clone(),
        workdir: state.workdir.clone(),
        pid: state.pid,
        started_at: state.started_at,
        ended_at: state.ended_at,
        status: state.status.clone(),
        exit_code: state.exit_code,
        signal: state.signal.clone(),
        timed_out: state.timed_out,
        stdout: state.stdout.clone(),
        stderr: state.stderr.clone(),
        output: state.output.clone(),
        tail: state.tail.clone(),
        truncated: state.truncated,
    }
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
      "ok": true,
      "pid": snapshot.pid.unwrap_or_default(),
      "stdout": snapshot.stdout,
      "stderr": snapshot.stderr,
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

struct ShellProgram {
    executable: String,
    launch_args: Vec<String>,
}

fn resolve_shell_program() -> ShellProgram {
    #[cfg(windows)]
    {
        ShellProgram {
            executable: "powershell.exe".to_string(),
            launch_args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
            ],
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(raw) = std::env::var("SHELL") {
            let candidate = raw.trim();
            if !candidate.is_empty() {
                let path = Path::new(candidate);
                if path.is_absolute() && is_executable_file(path) {
                    return ShellProgram {
                        executable: candidate.to_string(),
                        launch_args: vec!["-lc".to_string()],
                    };
                }
            }
        }

        ShellProgram {
            executable: "/bin/sh".to_string(),
            launch_args: vec!["-lc".to_string()],
        }
    }
}

fn format_shell_spawn_error(_shell: &str, error: &std::io::Error) -> String {
    #[cfg(windows)]
    {
        if _shell.eq_ignore_ascii_case("powershell.exe")
            && error.kind() == std::io::ErrorKind::NotFound
        {
            return "Failed to execute: powershell.exe not found. Ensure Windows PowerShell is available on PATH.".to_string();
        }
    }

    format!("Failed to execute: {}", error)
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

async fn pump_stream<R>(mut reader: R, state: Arc<AsyncMutex<ProcessState>>, stream: OutputStream)
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
                append_output(&mut lock, &chunk, stream);
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
    let shell = resolve_shell_program();
    let mut cmd = Command::new(&shell.executable);
    cmd.args(&shell.launch_args).arg(&command);
    cmd.current_dir(&workdir);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format_shell_spawn_error(&shell.executable, &e))?;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let session_id = Uuid::new_v4().to_string();
    let started_at = now_ms();

    let state = Arc::new(AsyncMutex::new(ProcessState {
        session_id: session_id.clone(),
        workdir: workdir.display().to_string(),
        pid,
        started_at,
        ended_at: None,
        status: "running".to_string(),
        exit_code: None,
        signal: None,
        timed_out: false,
        backgrounded: false,
        stdout: String::new(),
        stderr: String::new(),
        output: String::new(),
        tail: String::new(),
        truncated: false,
        started_notified: false,
    }));
    let handle = ProcessHandle {
        state: state.clone(),
    };

    if let Some(stdout) = stdout {
        tokio::spawn(pump_stream(stdout, state.clone(), OutputStream::Stdout));
    }
    if let Some(stderr) = stderr {
        tokio::spawn(pump_stream(stderr, state.clone(), OutputStream::Stderr));
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
                    append_output(
                        &mut lock,
                        &format!("\n[wait error] {}", error),
                        OutputStream::Stderr,
                    );
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

        if should_emit_event {
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
            description: "Execute shell commands. Supports async background mode.".to_string(),
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
