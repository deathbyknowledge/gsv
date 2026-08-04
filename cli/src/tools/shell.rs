use crate::protocol::{DeviceExecEventParams, ToolDefinition};
use crate::tools::{Tool, ToolOutput};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use uuid::Uuid;

const DEFAULT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const DEFAULT_YIELD_MS: u64 = 5_000;
const MIN_YIELD_MS: u64 = 250;
const MAX_YIELD_MS: u64 = 30_000;
const MAX_OUTPUT_CHARS: usize = 200_000;
const TAIL_CHARS: usize = 4_000;
const COMPLETED_SESSION_RETENTION_MS: u64 = 10 * 60 * 1000;

#[derive(Clone)]
struct ProcessHandle {
    state: Arc<AsyncMutex<ProcessState>>,
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
}

#[derive(Clone)]
struct ProcessSnapshot {
    session_id: String,
    cwd: String,
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
    cwd: String,
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
    pending_output: String,
    tail: String,
    truncated: bool,
    started_notified: bool,
}

static EXEC_EVENT_BUS: OnceLock<broadcast::Sender<DeviceExecEventParams>> = OnceLock::new();
static PROCESS_REGISTRY: OnceLock<Arc<AsyncMutex<HashMap<String, ProcessHandle>>>> =
    OnceLock::new();

fn exec_event_bus() -> &'static broadcast::Sender<DeviceExecEventParams> {
    EXEC_EVENT_BUS.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(256);
        tx
    })
}

pub fn subscribe_exec_events() -> broadcast::Receiver<DeviceExecEventParams> {
    exec_event_bus().subscribe()
}

fn emit_exec_event(event: DeviceExecEventParams) {
    let _ = exec_event_bus().send(event);
}

fn process_registry() -> &'static Arc<AsyncMutex<HashMap<String, ProcessHandle>>> {
    PROCESS_REGISTRY.get_or_init(|| Arc::new(AsyncMutex::new(HashMap::new())))
}

async fn store_process(handle: ProcessHandle) {
    let session_id = {
        let state = handle.state.lock().await;
        state.session_id.clone()
    };
    let mut registry = process_registry().lock().await;
    registry.insert(session_id, handle);
}

async fn get_process(session_id: &str) -> Option<ProcessHandle> {
    let registry = process_registry().lock().await;
    registry.get(session_id).cloned()
}

async fn remove_process(session_id: &str) {
    let mut registry = process_registry().lock().await;
    registry.remove(session_id);
}

fn schedule_process_removal(session_id: String, delay: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        remove_process(&session_id).await;
    });
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
    let pending_truncated = append_capped(&mut state.pending_output, chunk);
    state.tail = truncate_to_last_chars(&state.output, TAIL_CHARS);
    state.truncated = state.truncated || stream_truncated || output_truncated || pending_truncated;
}

fn snapshot_from_state(state: &ProcessState) -> ProcessSnapshot {
    ProcessSnapshot {
        session_id: state.session_id.clone(),
        cwd: state.cwd.clone(),
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

fn snapshot_and_drain_from_state(state: &mut ProcessState) -> ProcessSnapshot {
    let output = std::mem::take(&mut state.pending_output);
    ProcessSnapshot {
        session_id: state.session_id.clone(),
        cwd: state.cwd.clone(),
        pid: state.pid,
        started_at: state.started_at,
        ended_at: state.ended_at,
        status: state.status.clone(),
        exit_code: state.exit_code,
        signal: state.signal.clone(),
        timed_out: state.timed_out,
        stdout: state.stdout.clone(),
        stderr: state.stderr.clone(),
        output,
        tail: state.tail.clone(),
        truncated: state.truncated,
    }
}

async fn snapshot_and_drain(handle: &ProcessHandle) -> ProcessSnapshot {
    let mut state = handle.state.lock().await;
    snapshot_and_drain_from_state(&mut state)
}

fn running_result(snapshot: &ProcessSnapshot) -> Value {
    json!({
        "status": "running",
        "sessionId": snapshot.session_id,
        "output": snapshot.output,
        "pid": snapshot.pid,
        "startedAt": snapshot.started_at,
        "tail": snapshot.tail,
        "cwd": snapshot.cwd,
        "truncated": snapshot.truncated,
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
        "error": if snapshot.status == "completed" {
            Value::Null
        } else if snapshot.timed_out {
            json!("Command timed out")
        } else if let Some(signal) = &snapshot.signal {
            json!(format!("Command failed: {}", signal))
        } else {
            json!(format!("Command exited with code {}", snapshot.exit_code.unwrap_or(-1)))
        },
        "signal": snapshot.signal,
        "timedOut": snapshot.timed_out,
      "startedAt": snapshot.started_at,
      "endedAt": snapshot.ended_at,
      "durationMs": snapshot.ended_at.map(|ended| ended.saturating_sub(snapshot.started_at)),
      "output": snapshot.output,
      "tail": snapshot.tail,
      "truncated": snapshot.truncated,
      "cwd": snapshot.cwd,
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
        std::fs::metadata(path)
            .map(|meta| (meta.permissions().mode() & 0o111) != 0)
            .unwrap_or(false)
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
        let Ok(group) = i32::try_from(pid) else {
            return;
        };
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: the negative, checked PID targets only the child-owned process group.
        let _ = unsafe { libc::kill(-group, signal) };
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

fn force_terminate_pid(pid: u32) {
    #[cfg(unix)]
    {
        let Ok(group) = i32::try_from(pid) else {
            return;
        };
        // SAFETY: the negative, checked PID targets only the child-owned process group.
        let _ = unsafe { libc::kill(-group, libc::SIGKILL) };
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .args(["/T", "/F"])
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
    }
}

async fn terminate_process(handle: &ProcessHandle) {
    let pid = {
        let state = handle.state.lock().await;
        state.ended_at.is_none().then_some(state.pid).flatten()
    };
    let Some(pid) = pid else {
        return;
    };
    terminate_pid(pid, false).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    terminate_pid(pid, true).await;
}

struct ForegroundProcessGuard {
    pid: Option<u32>,
    session_id: String,
}

impl ForegroundProcessGuard {
    fn new(pid: Option<u32>, session_id: String) -> Self {
        Self { pid, session_id }
    }

    fn disarm(&mut self) {
        self.pid = None;
    }
}

impl Drop for ForegroundProcessGuard {
    fn drop(&mut self) {
        let Some(pid) = self.pid.take() else {
            return;
        };
        force_terminate_pid(pid);
        let session_id = self.session_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                remove_process(&session_id).await;
            });
        }
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
        emit_exec_event(DeviceExecEventParams {
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
    snapshot_and_drain_from_state(&mut state)
}

async fn launch_managed_process(
    command: String,
    cwd: PathBuf,
    timeout_ms: u64,
) -> Result<(ProcessHandle, ForegroundProcessGuard), String> {
    let shell = resolve_shell_program();
    let mut cmd = Command::new(&shell.executable);
    cmd.args(&shell.launch_args).arg(&command);
    cmd.current_dir(&cwd);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format_shell_spawn_error(&shell.executable, &e))?;

    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let session_id = Uuid::new_v4().to_string();
    let started_at = now_ms();

    let state = Arc::new(AsyncMutex::new(ProcessState {
        session_id: session_id.clone(),
        cwd: cwd.display().to_string(),
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
        pending_output: String::new(),
        tail: String::new(),
        truncated: false,
        started_notified: false,
    }));
    let handle = ProcessHandle {
        state: state.clone(),
        stdin: Arc::new(AsyncMutex::new(stdin)),
    };
    let foreground = ForegroundProcessGuard::new(pid, session_id);

    if let Some(stdout) = stdout {
        tokio::spawn(pump_stream(stdout, state.clone(), OutputStream::Stdout));
    }
    if let Some(stderr) = stderr {
        tokio::spawn(pump_stream(stderr, state.clone(), OutputStream::Stderr));
    }

    if timeout_ms > 0 {
        let handle_for_timeout = handle.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
            let should_terminate = {
                let mut lock = handle_for_timeout.state.lock().await;
                if lock.ended_at.is_some() {
                    false
                } else {
                    lock.timed_out = true;
                    true
                }
            };
            if should_terminate {
                terminate_process(&handle_for_timeout).await;
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

        let session_id = snapshot.session_id.clone();

        if should_emit_event {
            emit_exec_event(DeviceExecEventParams {
                event_id: Uuid::new_v4().to_string(),
                session_id: session_id.clone(),
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

        schedule_process_removal(
            session_id,
            Duration::from_millis(COMPLETED_SESSION_RETENTION_MS),
        );
    });

    store_process(handle.clone()).await;

    Ok((handle, foreground))
}

pub struct ShellTool {
    workspace: PathBuf,
}

async fn wait_for_shell_result(handle: &ProcessHandle, yield_ms: u64) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(yield_ms);
    loop {
        let snapshot = {
            let lock = handle.state.lock().await;
            snapshot_from_state(&lock)
        };

        if snapshot.ended_at.is_some() {
            let drained = snapshot_and_drain(handle).await;
            remove_process(&drained.session_id).await;
            return completed_result(&drained);
        }

        if tokio::time::Instant::now() >= deadline {
            let running = mark_backgrounded(handle, None).await;
            return running_result(&running);
        }

        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn normalize_yield_ms(yield_ms: Option<u64>) -> u64 {
    yield_ms
        .unwrap_or(DEFAULT_YIELD_MS)
        .clamp(MIN_YIELD_MS, MAX_YIELD_MS)
}

impl ShellTool {
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
struct ShellArgs {
    #[serde(default)]
    input: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    background: Option<bool>,
    #[serde(default)]
    yield_ms: Option<u64>,
}

#[async_trait]
impl Tool for ShellTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Shell".to_string(),
            description: "Run a shell command or continue a running shell session.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "input": {
                        "type": "string",
                        "description": "Command to start, stdin for an existing session, or empty string to poll an existing session"
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Working directory for a new command (default: workspace)"
                    },
                    "sessionId": {
                        "type": "string",
                        "description": "Existing session to poll or write stdin to"
                    }
                },
                "required": ["input"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, String> {
        let args: ShellArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        if let Some(session_id) = args
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            let handle = get_process(session_id)
                .await
                .ok_or_else(|| format!("Unknown shell session: {}", session_id))?;
            let input = args.input.unwrap_or_default();
            if !input.is_empty() {
                let mut stdin = handle.stdin.lock().await;
                let Some(writer) = stdin.as_mut() else {
                    return Err(format!("stdin is closed for shell session: {}", session_id));
                };
                writer
                    .write_all(input.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write stdin: {}", e))?;
                writer
                    .flush()
                    .await
                    .map_err(|e| format!("Failed to flush stdin: {}", e))?;
            }
            return Ok(ToolOutput::json(
                wait_for_shell_result(&handle, normalize_yield_ms(args.yield_ms)).await,
            ));
        }

        let command = args.input.unwrap_or_default();
        if command.trim().is_empty() {
            return Err("input must not be empty".to_string());
        }

        let cwd = args
            .cwd
            .as_deref()
            .map(|w| self.resolve_path(w))
            .unwrap_or_else(|| self.workspace.clone());

        let timeout_ms = args.timeout.unwrap_or(DEFAULT_TIMEOUT_MS);
        let (handle, mut foreground) = launch_managed_process(command, cwd, timeout_ms).await?;

        if args.background == Some(true) {
            let snapshot = mark_backgrounded(&handle, None).await;
            foreground.disarm();
            return Ok(ToolOutput::json(running_result(&snapshot)));
        }

        let result = wait_for_shell_result(&handle, normalize_yield_ms(args.yield_ms)).await;
        foreground.disarm();
        Ok(ToolOutput::json(result))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn process_exists(pid: u32) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks whether the test-owned process still exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    async fn wait_for_file(path: &Path) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("shell did not write child PID");
    }

    #[tokio::test]
    async fn dropping_foreground_request_terminates_its_process_tree() {
        let pid_file = std::env::temp_dir().join(format!("gsv-shell-{}.pid", Uuid::new_v4()));
        let command = format!(
            "trap \"\" TERM; sh -c 'trap \"\" TERM; echo $$ > {}; exec sleep 30' & wait",
            pid_file.display()
        );
        let request = tokio::spawn(async move {
            ShellTool::new(std::env::temp_dir())
                .execute(json!({ "input": command, "yieldMs": 30_000 }))
                .await
        });
        wait_for_file(&pid_file).await;
        let child_pid = tokio::fs::read_to_string(&pid_file)
            .await
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(process_exists(child_pid));

        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(3), async {
            while process_exists(child_pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("foreground child survived request cancellation");
        let _ = tokio::fs::remove_file(pid_file).await;
    }

    #[tokio::test]
    async fn termination_escalates_after_the_shell_leader_exits() {
        let pid_file = std::env::temp_dir().join(format!("gsv-shell-{}.pid", Uuid::new_v4()));
        let command = format!(
            "sh -c 'trap \"\" TERM; echo $$ > {}; exec sleep 30' & wait",
            pid_file.display()
        );
        let (handle, mut foreground) =
            launch_managed_process(command, std::env::temp_dir(), 30_000)
                .await
                .unwrap();
        foreground.disarm();
        wait_for_file(&pid_file).await;
        let child_pid = tokio::fs::read_to_string(&pid_file)
            .await
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        terminate_process(&handle).await;

        tokio::time::timeout(Duration::from_secs(3), async {
            while process_exists(child_pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("foreground child survived SIGKILL escalation");
        let _ = tokio::fs::remove_file(pid_file).await;
    }

    #[test]
    fn runtime_shutdown_still_terminates_foreground_processes() {
        let pid_file = std::env::temp_dir().join(format!("gsv-shell-{}.pid", Uuid::new_v4()));
        let command = format!(
            "sh -c 'trap \"\" TERM; echo $$ > {}; exec sleep 30' & wait",
            pid_file.display()
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (request, child_pid) = runtime.block_on(async {
            let request = tokio::spawn(async move {
                ShellTool::new(std::env::temp_dir())
                    .execute(json!({ "input": command, "yieldMs": 30_000 }))
                    .await
            });
            wait_for_file(&pid_file).await;
            let child_pid = tokio::fs::read_to_string(&pid_file)
                .await
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            (request, child_pid)
        });
        assert!(process_exists(child_pid));

        request.abort();
        drop(runtime);

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while process_exists(child_pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!process_exists(child_pid));
        let _ = std::fs::remove_file(pid_file);
    }

    #[tokio::test]
    async fn dropping_session_poll_does_not_terminate_background_process() {
        let tool = ShellTool::new(std::env::temp_dir());
        let started = tool
            .execute(json!({
                "input": "sleep 30",
                "background": true,
                "timeout": 30_000,
            }))
            .await
            .unwrap();
        let session_id = started.data["sessionId"].as_str().unwrap().to_string();
        let handle = get_process(&session_id).await.unwrap();
        let pid = started.data["pid"].as_u64().unwrap() as u32;

        let poll = tokio::spawn(async move {
            ShellTool::new(std::env::temp_dir())
                .execute(json!({
                    "sessionId": session_id,
                    "input": "",
                    "yieldMs": 30_000,
                }))
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        poll.abort();
        assert!(poll.await.unwrap_err().is_cancelled());
        assert!(handle.state.lock().await.ended_at.is_none());
        assert!(process_exists(pid));

        terminate_process(&handle).await;
    }
}
