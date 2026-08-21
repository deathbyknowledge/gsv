use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use daemon_protocol::{ClientOptions, DaemonControlClient, DaemonControlEndpoint};
use host_config::CliConfig;

const MAX_MACHINE_NAME_CHARS: usize = 80;
const MACHINE_ID_MAX_CHARS: usize = 48;
const DAEMON_READY_ATTEMPTS: usize = 32;
const DAEMON_READY_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfiguredMachine {
    pub machine_id: String,
    pub name: String,
    pub token: String,
    pub workspace: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MachineActivation {
    pub machine_id: String,
    pub name: String,
    pub connected: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MachineSetupPhase {
    Naming,
    Installing,
}

#[derive(Debug)]
pub struct MachineSetupFlow {
    phase: MachineSetupPhase,
    name: String,
    error: Option<String>,
    request_id: Option<u64>,
}

impl MachineSetupFlow {
    pub fn new(name: String) -> Self {
        Self {
            phase: MachineSetupPhase::Naming,
            name,
            error: None,
            request_id: None,
        }
    }

    pub fn phase(&self) -> MachineSetupPhase {
        self.phase
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }

    pub fn begin(&mut self, request_id: u64, name: &str) -> Result<String, String> {
        if self.phase == MachineSetupPhase::Installing {
            return Err("This computer is already being connected.".to_string());
        }
        let name = validate_machine_name(name)?;
        self.name.clone_from(&name);
        self.error = None;
        self.request_id = Some(request_id);
        self.phase = MachineSetupPhase::Installing;
        Ok(name)
    }

    pub fn finish(&mut self, request_id: u64) -> bool {
        if self.request_id != Some(request_id) {
            return false;
        }
        self.request_id = None;
        true
    }

    pub fn fail(&mut self, request_id: u64, message: String) -> bool {
        if !self.finish(request_id) {
            return false;
        }
        self.phase = MachineSetupPhase::Naming;
        self.error = Some(message);
        true
    }
}

pub fn configured_machine(gateway_url: &str, gateway_username: &str) -> Option<ConfiguredMachine> {
    let config = CliConfig::load();
    if config.device.gateway_url.as_deref() != Some(gateway_url)
        || config.device.gateway_username.as_deref() != Some(gateway_username)
    {
        return None;
    }
    let machine_id = nonempty(config.device.id)?;
    let token = config.device.token.filter(|value| !value.is_empty())?;
    let name = nonempty(config.device.label).unwrap_or_else(|| machine_id.clone());
    let workspace = config
        .device
        .workspace
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    Some(ConfiguredMachine {
        machine_id,
        name,
        token,
        workspace,
    })
}

pub fn migrate_legacy_machine_binding() {
    let config = CliConfig::load();
    if config.device.id.as_deref().is_none_or(str::is_empty)
        || config.device.token.as_deref().is_none_or(str::is_empty)
        || (config.device.gateway_url.is_some() && config.device.gateway_username.is_some())
    {
        return;
    }
    let Some(username) = config.gateway_username() else {
        return;
    };
    let gateway_url = config.gateway_url();
    let _ = CliConfig::update(|config| {
        if config.device.gateway_url.is_none() {
            config.device.gateway_url = Some(gateway_url);
        }
        if config.device.gateway_username.is_none() {
            config.device.gateway_username = Some(username);
        }
    });
}

pub fn suggested_machine_name() -> String {
    hostname::get()
        .ok()
        .map(|value| value.to_string_lossy().trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "My computer".to_string())
}

pub fn validate_machine_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("Give this computer a name.".to_string());
    }
    if name.chars().count() > MAX_MACHINE_NAME_CHARS {
        return Err(format!(
            "Use a name no longer than {MAX_MACHINE_NAME_CHARS} characters."
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("The computer name cannot contain control characters.".to_string());
    }
    Ok(name.to_string())
}

pub fn machine_id_from_name(name: &str) -> String {
    let lowercase = name.trim().to_lowercase();
    let mut normalized = String::with_capacity(lowercase.len());
    let mut replacing = false;
    for character in lowercase.chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == '_'
            || character == '-'
        {
            normalized.push(character);
            replacing = false;
        } else if !replacing {
            normalized.push('-');
            replacing = true;
        }
    }
    let machine_id = normalized
        .trim_matches(['-', '_'])
        .chars()
        .take(MACHINE_ID_MAX_CHARS)
        .collect::<String>();
    if machine_id.is_empty() {
        "machine".to_string()
    } else {
        machine_id
    }
}

pub fn save_machine(
    gateway_url: &str,
    gateway_username: &str,
    machine_id: &str,
    name: &str,
    token: &str,
) -> Result<ConfiguredMachine, String> {
    let workspace = CliConfig::load()
        .device
        .workspace
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let workspace = workspace.canonicalize().unwrap_or(workspace);
    CliConfig::update(|config| {
        config.gateway.url = Some(gateway_url.to_string());
        config.gateway.username = Some(gateway_username.to_string());
        config.device.id = Some(machine_id.to_string());
        config.device.label = Some(name.to_string());
        config.device.token = Some(token.to_string());
        config.device.gateway_url = Some(gateway_url.to_string());
        config.device.gateway_username = Some(gateway_username.to_string());
        config.device.workspace = Some(workspace.clone());
    })
    .map_err(|error| format!("The machine configuration could not be saved: {error}"))?;
    Ok(ConfiguredMachine {
        machine_id: machine_id.to_string(),
        name: name.to_string(),
        token: token.to_string(),
        workspace,
    })
}

pub async fn activate_machine(machine: &ConfiguredMachine) -> Result<MachineActivation, String> {
    let client = DaemonControlClient::new(
        DaemonControlEndpoint::current_user()
            .map_err(|error| format!("The local daemon endpoint is unavailable: {error}"))?,
        ClientOptions::default()
            .with_connect_timeout(Duration::from_millis(500))
            .with_io_timeout(Duration::from_secs(2)),
    );
    if client
        .status()
        .await
        .is_ok_and(|status| status.machine_id == machine.machine_id && status.connected)
    {
        return Ok(MachineActivation {
            machine_id: machine.machine_id.clone(),
            name: machine.name.clone(),
            connected: true,
        });
    }

    let machine = machine.clone();
    tokio::task::spawn_blocking({
        let machine = machine.clone();
        move || install_daemon(&machine)
    })
    .await
    .map_err(|_| "The background service installer stopped unexpectedly.".to_string())??;

    let mut observed_matching_daemon = false;
    let mut reload_requested = false;
    for _ in 0..DAEMON_READY_ATTEMPTS {
        match client.status().await {
            Ok(status) if status.machine_id == machine.machine_id => {
                observed_matching_daemon = true;
                if status.connected {
                    return Ok(MachineActivation {
                        machine_id: machine.machine_id,
                        name: machine.name,
                        connected: true,
                    });
                }
                if !reload_requested {
                    reload_requested = client.reload().await.is_ok();
                }
            }
            Ok(_) if !reload_requested => {
                reload_requested = client.reload().await.is_ok();
            }
            Err(_) => {}
            Ok(_) => {}
        }
        tokio::time::sleep(DAEMON_READY_INTERVAL).await;
    }
    if observed_matching_daemon {
        return Ok(MachineActivation {
            machine_id: machine.machine_id,
            name: machine.name,
            connected: false,
        });
    }
    Err("The background service was installed, but gsvd did not become reachable.".to_string())
}

fn install_daemon(machine: &ConfiguredMachine) -> Result<(), String> {
    let executable = resolve_gsv_cli()?;
    let output = Command::new(&executable)
        .arg("daemon")
        .arg("install")
        .arg("--id")
        .arg(&machine.machine_id)
        .arg("--workspace")
        .arg(&machine.workspace)
        .output()
        .map_err(|error| format!("The background service installer could not start: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = bounded_process_detail(&output.stderr)
        .or_else(|| bounded_process_detail(&output.stdout))
        .unwrap_or_else(|| output.status.to_string());
    Err(format!(
        "The background service could not be installed: {detail}"
    ))
}

fn resolve_gsv_cli() -> Result<PathBuf, String> {
    if let Some(explicit) = env::var_os("GSV_CLI_PATH") {
        return validate_executable(PathBuf::from(explicit), "GSV_CLI_PATH");
    }
    let executable_name = if cfg!(windows) { "gsv.exe" } else { "gsv" };
    if let Ok(current) = env::current_exe() {
        if let Some(parent) = current.parent() {
            let sibling = parent.join(executable_name);
            if is_executable(&sibling) {
                return Ok(sibling.canonicalize().unwrap_or(sibling));
            }
        }
    }
    if let Some(path) = env::var_os("PATH") {
        if let Some(candidate) = env::split_paths(&path)
            .map(|directory| directory.join(executable_name))
            .find(|candidate| is_executable(candidate))
        {
            return Ok(candidate.canonicalize().unwrap_or(candidate));
        }
    }
    Err(format!(
        "The bundled {executable_name} command could not be found. Install the complete GSV distribution."
    ))
}

fn validate_executable(path: PathBuf, source: &str) -> Result<PathBuf, String> {
    if !is_executable(&path) {
        return Err(format!(
            "{source} does not name an executable file: {}",
            path.display()
        ));
    }
    Ok(path.canonicalize().unwrap_or(path))
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn bounded_process_detail(bytes: &[u8]) -> Option<String> {
    const MAX_BYTES: usize = 512;
    let value = String::from_utf8_lossy(bytes);
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let mut end = value.len().min(MAX_BYTES);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    Some(value[..end].to_string())
}

fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_human_machine_names() {
        assert_eq!(
            validate_machine_name("  Studio Mac  "),
            Ok("Studio Mac".to_string())
        );
        assert!(validate_machine_name("\n").is_err());
        assert!(validate_machine_name(&"x".repeat(MAX_MACHINE_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn machine_ids_match_web_name_normalization() {
        assert_eq!(
            machine_id_from_name("Studio MacBook Pro"),
            "studio-macbook-pro"
        );
        assert_eq!(machine_id_from_name("  Server_01  "), "server_01");
        assert_eq!(machine_id_from_name("!!!"), "machine");
        assert_eq!(
            machine_id_from_name(&"a".repeat(MACHINE_ID_MAX_CHARS + 10)),
            "a".repeat(MACHINE_ID_MAX_CHARS)
        );
    }

    #[test]
    fn setup_flow_fences_late_results() {
        let mut flow = MachineSetupFlow::new("Laptop".to_string());
        assert_eq!(
            flow.begin(7, "Studio Laptop"),
            Ok("Studio Laptop".to_string())
        );
        assert!(!flow.finish(6));
        assert!(flow.fail(7, "try again".to_string()));
        assert_eq!(flow.phase(), MachineSetupPhase::Naming);
        assert_eq!(flow.error(), Some("try again"));
    }

    #[test]
    fn process_details_are_bounded() {
        let detail = bounded_process_detail("x".repeat(700).as_bytes()).expect("detail");
        assert_eq!(detail.len(), 512);
        assert!(bounded_process_detail(b"").is_none());
    }
}
