use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use daemon_protocol::{ClientOptions, DaemonControlClient, DaemonControlEndpoint};
use host_config::{CliConfig, ConfigFile};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::{watch, Mutex, OwnedMutexGuard};
use url::Url;

use crate::session::{gateway_origin, Session};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub origin: String,
    pub username: String,
}

pub fn session_username(session: &Session) -> Option<String> {
    #[derive(Deserialize)]
    struct Login {
        username: String,
        token: String,
    }
    let login: Login = serde_json::from_str(session.values.get("gsv.ui.session.token.v1")?).ok()?;
    (!login.username.is_empty() && !login.token.is_empty()).then_some(login.username)
}

pub fn scope(session: &Session, generation: &str, username: &str) -> Result<Scope, String> {
    if session.generation != generation || session_username(session).as_deref() != Some(username) {
        return Err("Sign in before connecting this computer.".into());
    }
    Ok(Scope {
        origin: session.origin.clone().ok_or("Choose a space first.")?,
        username: username.to_owned(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub origin: String,
    pub username: String,
    pub target_id: String,
    pub label: String,
}

impl Identity {
    fn matches(&self, scope: &Scope) -> bool {
        self.origin == scope.origin && self.username == scope.username
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub suggested_name: String,
    pub configured: Option<Identity>,
    pub pending: Option<Identity>,
    pub running: bool,
    pub connected: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum MachineCommand {
    Pair { code: String },
    Resume,
    Start,
}

fn normalize_origin(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value).map_err(|_| "Invalid machine connection.")?;
    match url.scheme() {
        "wss" => {
            let _ = url.set_scheme("https");
        }
        "ws" => {
            let _ = url.set_scheme("http");
        }
        _ => {}
    }
    if url.path() == "/ws" {
        url.set_path("/");
    }
    gateway_origin(url.as_str())
}

// Only scope and presentation cross into the webview. The CLI validates and
// redeems the full invitation; driver credentials remain in host configuration.
fn invitation_identity(code: &str) -> Result<Identity, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Invitation {
        version: u8,
        gateway_url: String,
        username: String,
        target_id: String,
        label: String,
    }
    let invalid = || "The saved machine invitation is invalid.".to_owned();
    if code.len() > 4096 {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(code.strip_prefix("gsv-pair1_").ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let value: Invitation = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if value.version != 1
        || value.username.is_empty()
        || value.target_id.is_empty()
        || value.label.is_empty()
    {
        return Err(invalid());
    }
    Ok(Identity {
        origin: normalize_origin(&value.gateway_url)?,
        username: value.username,
        target_id: value.target_id,
        label: value.label,
    })
}

fn configured_identity(config: &CliConfig) -> Result<Option<Identity>, String> {
    let Some(token) = config.device.token.as_deref() else {
        return Ok(None);
    };
    let invalid = "The saved machine connection is incomplete.";
    let id = config
        .device
        .id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(invalid)?;
    if token.is_empty() {
        return Err(invalid.into());
    }
    let origin = config
        .device
        .gateway_url
        .as_deref()
        .or(config.gateway.url.as_deref())
        .ok_or(invalid)?;
    let username = config
        .device
        .gateway_username
        .as_deref()
        .or(config.gateway.username.as_deref())
        .filter(|name| !name.is_empty())
        .ok_or(invalid)?;
    Ok(Some(Identity {
        origin: normalize_origin(origin)?,
        username: username.to_owned(),
        target_id: id.to_owned(),
        label: config.device.label.clone().unwrap_or_else(|| id.to_owned()),
    }))
}

fn pending_identity(config: &CliConfig) -> Result<Option<Identity>, String> {
    config
        .device
        .extra
        .get("pairing_pending")
        .map(|pending| {
            let code = pending
                .get("code")
                .and_then(|value| value.as_str())
                .ok_or("The saved machine invitation is invalid.")?;
            invitation_identity(code)
        })
        .transpose()
}

fn read_config() -> Result<CliConfig, String> {
    let path = CliConfig::config_path().ok_or("Cannot find the machine configuration.")?;
    ConfigFile::<CliConfig>::new(path)
        .load()
        .map_err(|_| "Cannot read the machine configuration.".into())
}

pub async fn inspect() -> Result<Snapshot, String> {
    let config = tokio::task::spawn_blocking(read_config)
        .await
        .map_err(|_| "Could not check this computer.")??;
    let configured = configured_identity(&config)?;
    let pending = pending_identity(&config)?;
    let status = if configured.is_some() {
        match DaemonControlEndpoint::current_user() {
            Ok(endpoint) => DaemonControlClient::new(
                endpoint,
                ClientOptions::default()
                    .with_connect_timeout(Duration::from_millis(500))
                    .with_io_timeout(Duration::from_secs(1)),
            )
            .status()
            .await
            .ok(),
            Err(_) => None,
        }
    } else {
        None
    };
    let running = status.as_ref().is_some_and(|status| {
        configured
            .as_ref()
            .is_some_and(|identity| identity.target_id == status.machine_id)
    });
    Ok(Snapshot {
        suggested_name: hostname::get()
            .ok()
            .and_then(|name| name.into_string().ok())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "My computer".into()),
        configured,
        pending,
        running,
        connected: running && status.is_some_and(|status| status.connected),
    })
}

#[derive(Default)]
pub struct MachineRuntime {
    operation: Arc<Mutex<()>>,
    cancellation: watch::Sender<u64>,
}

pub struct Operation {
    _guard: OwnedMutexGuard<()>,
    cancelled: watch::Receiver<u64>,
}

impl MachineRuntime {
    // Prepare under the session lock, then release that lock for all slow work.
    pub fn prepare(&self) -> Result<Operation, String> {
        let guard = self
            .operation
            .clone()
            .try_lock_owned()
            .map_err(|_| "This computer is already being connected.")?;
        Ok(Operation {
            _guard: guard,
            cancelled: self.cancellation.subscribe(),
        })
    }

    pub fn cancel(&self) {
        self.cancellation
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
    }

    pub async fn shutdown(&self) {
        self.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.operation.lock()).await;
    }

    pub async fn run(
        &self,
        scope: Scope,
        command: MachineCommand,
        mut operation: Operation,
    ) -> Result<Snapshot, String> {
        let snapshot = inspect().await?;
        let (args, input, expected) = command_arguments(&scope, &snapshot, command)?;
        let executable = std::env::current_exe()
            .map_err(|_| "Cannot locate GSV.")?
            .parent()
            .ok_or("Cannot locate GSV.")?
            .join(if cfg!(windows) { "gsv.exe" } else { "gsv" });
        run_cli(
            &executable,
            &args,
            input.as_deref(),
            &mut operation.cancelled,
            Duration::from_secs(90),
        )
        .await?;
        wait_for_connection(
            &expected,
            &mut operation.cancelled,
            Duration::from_secs(20),
            inspect,
        )
        .await
    }
}

fn command_arguments(
    scope: &Scope,
    snapshot: &Snapshot,
    command: MachineCommand,
) -> Result<(Vec<&'static str>, Option<String>, Identity), String> {
    if snapshot
        .configured
        .iter()
        .chain(snapshot.pending.iter())
        .any(|identity| !identity.matches(scope))
    {
        return Err("This computer is connected to another space or account. Its connection was not changed.".into());
    }
    match command {
        MachineCommand::Start => {
            let expected = snapshot
                .configured
                .clone()
                .ok_or("Finish connecting this computer first.")?;
            if snapshot.pending.is_some() {
                return Err("Finish connecting this computer first.".into());
            }
            Ok((vec!["daemon", "install"], None, expected))
        }
        MachineCommand::Resume => {
            let expected = snapshot
                .pending
                .clone()
                .ok_or("There is no unfinished machine setup.")?;
            Ok((
                vec!["pair", "--preserve-cli-login", "--no-replace"],
                None,
                expected,
            ))
        }
        MachineCommand::Pair { code } => {
            if snapshot.configured.is_some() {
                return Err(
                    "This computer is already paired. Start its connection instead.".into(),
                );
            }
            let expected = invitation_identity(&code)?;
            if !expected.matches(scope) {
                return Err("The invitation belongs to another space or account.".into());
            }
            Ok((
                vec!["pair", "-", "--preserve-cli-login", "--no-replace"],
                Some(code),
                expected,
            ))
        }
    }
}

// Service installation only schedules a start. Setup completes after the
// daemon confirms its gateway handshake for this exact saved identity.
async fn wait_for_connection<F, Fut>(
    expected: &Identity,
    cancelled: &mut watch::Receiver<u64>,
    timeout: Duration,
    mut inspect: F,
) -> Result<Snapshot, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Snapshot, String>>,
{
    if cancelled.has_changed().unwrap_or(true) {
        return Err("Machine setup was cancelled.".into());
    }
    let work = async {
        loop {
            let snapshot = inspect().await?;
            if !snapshot.configured.as_ref().is_some_and(|identity| {
                identity.origin == expected.origin
                    && identity.username == expected.username
                    && identity.target_id == expected.target_id
            }) || snapshot.pending.is_some()
            {
                return Err("The saved computer connection changed. Reopen it to check.".into());
            }
            if snapshot.running && snapshot.connected {
                return Ok(snapshot);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("Machine setup was cancelled.".into()),
        result = tokio::time::timeout(timeout, work) => result.map_err(|_| "This computer did not connect. Retry.")?,
    }
}

struct CliProcess(Child);

impl Drop for CliProcess {
    fn drop(&mut self) {
        if let Some(id) = self.0.id() {
            #[cfg(unix)]
            // SAFETY: the child was placed in its own process group. Kill only
            // that owned group, including a service-control subprocess on cancel.
            unsafe {
                libc::kill(-(id as i32), libc::SIGKILL);
            }
            let _ = self.0.start_kill();
        }
    }
}

async fn run_cli(
    executable: &Path,
    args: &[&str],
    input: Option<&str>,
    cancelled: &mut watch::Receiver<u64>,
    timeout: Duration,
) -> Result<(), String> {
    if cancelled.has_changed().unwrap_or(true) {
        return Err("Machine setup was cancelled.".into());
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = CliProcess(
        command
            .spawn()
            .map_err(|_| "Install the complete GSV desktop release to connect this computer.")?,
    );
    let work = async {
        if let Some(input) = input {
            let mut stdin = child
                .0
                .stdin
                .take()
                .ok_or("Could not deliver the machine invitation.")?;
            stdin
                .write_all(input.as_bytes())
                .await
                .map_err(|_| "Could not deliver the machine invitation.")?;
        }
        let status = child
            .0
            .wait()
            .await
            .map_err(|_| "Could not finish machine setup.")?;
        if !status.success() {
            return Err("Could not connect this computer. Retry to finish setup.".to_owned());
        }
        Ok(())
    };
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("Machine setup was cancelled.".into()),
        result = tokio::time::timeout(timeout, work) => result.map_err(|_| "Connecting this computer timed out. Retry to finish setup.")?,
    }
}
