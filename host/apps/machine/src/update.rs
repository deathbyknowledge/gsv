//! Self-update of the machine daemon, decided at the gateway handshake.
//!
//! The gateway cannot reach a machine, so the daemon decides when it connects.
//! A protocol error 102 names the release the gateway requires; a successful
//! connect against a newer release is a request to catch up. The daemon never
//! replaces its own executable. It starts the same installer a person would
//! run, pinned to the release the gateway named, detached from its own service
//! so that stopping `gsvd` cannot kill the installer, and lets the installer
//! swap the binaries, restart the service, and roll back on failure.

use std::fmt::{self, Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gateway_client::connection::GatewayRpcError;
use gateway_client::protocol::{ServerInfo, PROTOCOL_VERSION};
use host_config::release::{parse_version, stable_tag, ReleaseVersion, DEV_RELEASE_TAG};
use host_config::CliConfig;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// Where the public installer lives when the gateway does not name one.
pub const DEFAULT_INSTALLER_URL: &str = "https://install.gsv.space";
/// The daemon starts at most one installer per hour, whatever the outcome.
pub const MIN_ATTEMPT_INTERVAL: Duration = Duration::from_secs(60 * 60);
const INSTALLER_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_INSTALLER_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleaseChannel {
    Stable,
    Dev,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdateReason {
    /// The gateway rejected the handshake because this build is too old.
    ProtocolUnsupported,
    /// The gateway accepted the handshake but runs a newer release.
    NewerRelease,
}

impl UpdateReason {
    pub fn describe(self) -> &'static str {
        match self {
            Self::ProtocolUnsupported => "the gateway requires a newer protocol",
            Self::NewerRelease => "the gateway runs a newer release",
        }
    }
}

/// A release the gateway named, and why the daemon should move to it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateTarget {
    pub release: String,
    pub reason: UpdateReason,
    pub installer_url: String,
}

#[derive(Debug)]
pub enum UpdateError {
    Disabled,
    Deferred { since: Duration },
    State(String),
    Download(String),
    Spawn(String),
}

impl Display for UpdateError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disabled => write!(f, "automatic updates are off (device.auto_update)"),
            Self::Deferred { since } => write!(
                f,
                "the last update attempt was {} minutes ago; the next one waits until an hour has passed",
                since.as_secs() / 60
            ),
            Self::State(error) => write!(f, "could not record the update attempt: {error}"),
            Self::Download(error) => write!(f, "could not download the installer: {error}"),
            Self::Spawn(error) => write!(f, "could not start the installer: {error}"),
        }
    }
}

impl std::error::Error for UpdateError {}

/// What the daemon started, for the log line and the diagnostics notice.
#[derive(Clone, Debug)]
pub struct UpdateLaunch {
    pub release: String,
    pub log_path: PathBuf,
    pub detach: DetachStrategy,
}

/// How the installer escapes the daemon's own service so that stopping
/// `gsvd` cannot stop the update.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DetachStrategy {
    /// A transient `systemd-run --user` unit outside the `gsvd` cgroup.
    SystemdRun,
    /// A new session and process group; launchd and plain shells only kill
    /// the daemon's own group.
    NewSession,
    /// A detached process in its own group, outside the task's job when the
    /// job allows it.
    WindowsDetached,
}

impl Display for DetachStrategy {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::SystemdRun => "systemd-run",
            Self::NewSession => "new-session",
            Self::WindowsDetached => "detached-process",
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttemptRecord {
    attempted_at: u64,
    release: String,
}

/// The installer process as the daemon would start it, before detachment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallerInvocation {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct AutoUpdater {
    enabled: bool,
    channel: ReleaseChannel,
    current_version: Option<ReleaseVersion>,
    state_path: PathBuf,
    work_dir: PathBuf,
    log_path: PathBuf,
}

impl AutoUpdater {
    pub fn from_config(config: &CliConfig) -> Self {
        let channel = match config.release_channel().as_deref() {
            Some("dev") => ReleaseChannel::Dev,
            _ => ReleaseChannel::Stable,
        };
        Self::new(
            config.device_auto_update(),
            channel,
            env!("CARGO_PKG_VERSION"),
            host_config::gsv_home().join("auto-update"),
            host_config::device_log_dir().join("auto-update.log"),
        )
    }

    pub fn new(
        enabled: bool,
        channel: ReleaseChannel,
        current_version: &str,
        work_dir: PathBuf,
        log_path: PathBuf,
    ) -> Self {
        Self {
            enabled,
            channel,
            current_version: parse_version(current_version),
            state_path: work_dir.join("last-attempt.json"),
            work_dir,
            log_path,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// The release to install after a protocol error 102, if the gateway is
    /// ahead of this build. A gateway that is behind this build cannot be
    /// fixed from the machine, so it yields nothing.
    pub fn plan_for_protocol_error(&self, error: &GatewayRpcError) -> Option<UpdateTarget> {
        if !error.is_protocol_unsupported() {
            return None;
        }
        let details = error.details.as_ref()?;
        let supported = details.get("supportedProtocol")?.as_u64()?;
        if supported <= u64::from(PROTOCOL_VERSION) {
            return None;
        }
        let server_version = parse_version(details.get("serverVersion")?.as_str()?)?;
        let installer_url = details
            .get("installer")
            .and_then(|value| value.as_str())
            .filter(|url| url.starts_with("https://"))
            .unwrap_or(DEFAULT_INSTALLER_URL)
            .to_string();
        Some(UpdateTarget {
            release: self.release_for(server_version),
            reason: UpdateReason::ProtocolUnsupported,
            installer_url,
        })
    }

    /// The release to install after a successful handshake against a newer
    /// gateway. A stable daemon only follows stable releases; a gateway built
    /// from the moving `dev` tag never moves it.
    pub fn plan_for_server(&self, server: &ServerInfo) -> Option<UpdateTarget> {
        let server_version = parse_version(&server.version)?;
        if self
            .current_version
            .is_none_or(|current| server_version <= current)
        {
            return None;
        }
        if self.channel == ReleaseChannel::Stable
            && server.release.as_deref() == Some(DEV_RELEASE_TAG)
        {
            return None;
        }
        Some(UpdateTarget {
            release: self.release_for(server_version),
            reason: UpdateReason::NewerRelease,
            installer_url: DEFAULT_INSTALLER_URL.to_string(),
        })
    }

    fn release_for(&self, version: ReleaseVersion) -> String {
        match self.channel {
            ReleaseChannel::Stable => stable_tag(version),
            ReleaseChannel::Dev => DEV_RELEASE_TAG.to_string(),
        }
    }

    /// Start the installer for `target`, detached from this daemon. Records
    /// the attempt before anything else so a crash cannot turn into a loop.
    pub async fn launch(&self, target: &UpdateTarget) -> Result<UpdateLaunch, UpdateError> {
        self.check_allowed(SystemTime::now())?;
        self.record_attempt(&target.release, SystemTime::now())?;

        let install_dir = install_dir()?;
        let script = self
            .download_installer(&target.installer_url)
            .await
            .map_err(UpdateError::Download)?;
        let invocation = installer_invocation(&script, &target.release, &install_dir);
        let strategy = detach_strategy();
        let log = self.open_log()?;
        let mut command = detached_command(&invocation, strategy, &self.log_path, log)
            .map_err(|error| UpdateError::Spawn(error.to_string()))?;
        let mut child = tokio::process::Command::from(command_take(&mut command))
            .kill_on_drop(false)
            .spawn()
            .map_err(|error| UpdateError::Spawn(error.to_string()))?;
        let release = target.release.clone();
        tokio::spawn(async move {
            match child.wait().await {
                Ok(status) if status.success() => {
                    info!(event = "update.launcher_exited", release = %release, detach = %strategy);
                }
                Ok(status) => {
                    warn!(event = "update.launcher_failed", release = %release, detach = %strategy, status = %status);
                }
                Err(error) => {
                    warn!(event = "update.launcher_failed", release = %release, detach = %strategy, error = %error);
                }
            }
        });
        Ok(UpdateLaunch {
            release: target.release.clone(),
            log_path: self.log_path.clone(),
            detach: strategy,
        })
    }

    fn check_allowed(&self, now: SystemTime) -> Result<(), UpdateError> {
        if !self.enabled {
            return Err(UpdateError::Disabled);
        }
        let Some(record) = self.last_attempt() else {
            return Ok(());
        };
        let now = unix_seconds(now);
        let since = Duration::from_secs(now.saturating_sub(record.attempted_at));
        if record.attempted_at <= now && since < MIN_ATTEMPT_INTERVAL {
            return Err(UpdateError::Deferred { since });
        }
        Ok(())
    }

    fn last_attempt(&self) -> Option<AttemptRecord> {
        let contents = fs::read(&self.state_path).ok()?;
        serde_json::from_slice(&contents).ok()
    }

    fn record_attempt(&self, release: &str, now: SystemTime) -> Result<(), UpdateError> {
        self.ensure_work_dir()
            .map_err(|error| UpdateError::State(error.to_string()))?;
        let record = AttemptRecord {
            attempted_at: unix_seconds(now),
            release: release.to_string(),
        };
        let encoded =
            serde_json::to_vec(&record).map_err(|error| UpdateError::State(error.to_string()))?;
        fs::write(&self.state_path, encoded).map_err(|error| UpdateError::State(error.to_string()))
    }

    fn ensure_work_dir(&self) -> io::Result<()> {
        fs::create_dir_all(&self.work_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.work_dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    async fn download_installer(&self, base_url: &str) -> Result<PathBuf, String> {
        self.ensure_work_dir().map_err(|error| error.to_string())?;
        let url = installer_script_url(base_url);
        let client = reqwest::Client::builder()
            .timeout(INSTALLER_DOWNLOAD_TIMEOUT)
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        let body = response.bytes().await.map_err(|error| error.to_string())?;
        if body.is_empty() || body.len() > MAX_INSTALLER_BYTES {
            return Err(format!(
                "installer script has an unexpected size ({} bytes)",
                body.len()
            ));
        }
        let script = self.work_dir.join(installer_script_name());
        fs::write(&script, &body).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        Ok(script)
    }

    fn open_log(&self) -> Result<fs::File, UpdateError> {
        if let Some(parent) = self.log_path.parent() {
            fs::create_dir_all(parent).map_err(|error| UpdateError::State(error.to_string()))?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .map_err(|error| UpdateError::State(error.to_string()))
    }
}

fn command_take(command: &mut Command) -> Command {
    std::mem::replace(command, Command::new(""))
}

fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// The directory holding the running daemon, which is where the installer
/// must write so this exact installation gets replaced.
fn install_dir() -> Result<PathBuf, UpdateError> {
    let exe = std::env::current_exe().map_err(|error| UpdateError::State(error.to_string()))?;
    let exe = exe.canonicalize().unwrap_or(exe);
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| UpdateError::State("the daemon executable has no parent directory".into()))
}

fn installer_script_name() -> &'static str {
    if cfg!(windows) {
        "install.ps1"
    } else {
        "install.sh"
    }
}

fn installer_script_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if cfg!(windows) {
        format!("{base}/install.ps1")
    } else {
        base.to_string()
    }
}

/// The installer command with the release and destination pinned. The
/// installer's own checksum verification, service handling, health check, and
/// rollback do the rest.
pub fn installer_invocation(
    script: &Path,
    release: &str,
    install_dir: &Path,
) -> InstallerInvocation {
    let env = vec![
        ("GSV_VERSION".to_string(), release.to_string()),
        (
            "GSV_INSTALL_DIR".to_string(),
            install_dir.display().to_string(),
        ),
    ];
    if cfg!(windows) {
        InstallerInvocation {
            program: "powershell.exe".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                script.display().to_string(),
            ],
            env,
        }
    } else {
        InstallerInvocation {
            program: "bash".to_string(),
            args: vec![script.display().to_string()],
            env,
        }
    }
}

/// Arguments that run `invocation` as a transient user unit, so the installer
/// lives outside the `gsvd` cgroup that `systemctl --user stop gsvd` kills.
pub fn systemd_run_arguments(
    unit: &str,
    log_path: &Path,
    path_env: Option<&str>,
    invocation: &InstallerInvocation,
) -> Vec<String> {
    let log = log_path.display();
    let mut args = vec![
        "--user".to_string(),
        "--collect".to_string(),
        "--quiet".to_string(),
        format!("--unit={unit}"),
        format!("--property=StandardOutput=append:{log}"),
        format!("--property=StandardError=append:{log}"),
    ];
    if let Some(path) = path_env {
        args.push(format!("--setenv=PATH={path}"));
    }
    for (key, value) in &invocation.env {
        args.push(format!("--setenv={key}={value}"));
    }
    args.push(invocation.program.clone());
    args.extend(invocation.args.iter().cloned());
    args
}

fn detach_strategy() -> DetachStrategy {
    if cfg!(windows) {
        return DetachStrategy::WindowsDetached;
    }
    let under_systemd = std::env::var_os("INVOCATION_ID").is_some();
    if cfg!(target_os = "linux") && under_systemd && systemd_run_available() {
        DetachStrategy::SystemdRun
    } else {
        DetachStrategy::NewSession
    }
}

fn systemd_run_available() -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| dir.join("systemd-run").is_file())
    })
}

fn detached_command(
    invocation: &InstallerInvocation,
    strategy: DetachStrategy,
    log_path: &Path,
    log: fs::File,
) -> io::Result<Command> {
    let mut command = match strategy {
        DetachStrategy::SystemdRun => {
            let unit = format!("gsv-auto-update-{}", unix_seconds(SystemTime::now()));
            let path_env = std::env::var("PATH").ok();
            let mut command = Command::new("systemd-run");
            command.args(systemd_run_arguments(
                &unit,
                log_path,
                path_env.as_deref(),
                invocation,
            ));
            command
        }
        DetachStrategy::NewSession | DetachStrategy::WindowsDetached => {
            let mut command = Command::new(&invocation.program);
            command.args(&invocation.args);
            command.envs(invocation.env.iter().cloned());
            command
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    detach(&mut command, strategy);
    Ok(command)
}

#[cfg(unix)]
fn detach(command: &mut Command, strategy: DetachStrategy) {
    use std::os::unix::process::CommandExt;
    if strategy != DetachStrategy::NewSession {
        return;
    }
    // SAFETY: setsid only detaches the child from the daemon's session and
    // process group; it allocates nothing and is async-signal-safe, which is
    // all a pre_exec hook may do between fork and exec.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach(command: &mut Command, _strategy: DetachStrategy) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn updater(enabled: bool, channel: ReleaseChannel, version: &str) -> AutoUpdater {
        let dir = std::env::temp_dir().join(format!("gsvd-update-{}", uuid::Uuid::new_v4()));
        AutoUpdater::new(
            enabled,
            channel,
            version,
            dir.join("auto-update"),
            dir.join("auto-update.log"),
        )
    }

    fn protocol_error(
        supported: u64,
        server_version: &str,
        installer: Option<&str>,
    ) -> GatewayRpcError {
        let mut details = json!({
            "requestedProtocol": PROTOCOL_VERSION,
            "supportedProtocol": supported,
            "serverVersion": server_version,
        });
        if let Some(installer) = installer {
            details["installer"] = json!(installer);
        }
        GatewayRpcError::new("sys.connect", 102, "protocol mismatch", Some(details))
    }

    fn server(version: &str, release: Option<&str>) -> ServerInfo {
        ServerInfo {
            version: version.to_string(),
            release: release.map(str::to_string),
            connection_id: "conn-1".to_string(),
        }
    }

    #[test]
    fn a_stable_daemon_follows_the_release_the_gateway_named() {
        let updater = updater(true, ReleaseChannel::Stable, "0.4.1");
        let target = updater
            .plan_for_protocol_error(&protocol_error(
                u64::from(PROTOCOL_VERSION) + 1,
                "0.5.0",
                Some("https://install.example"),
            ))
            .expect("newer gateway plans an update");
        assert_eq!(target.release, "v0.5.0");
        assert_eq!(target.reason, UpdateReason::ProtocolUnsupported);
        assert_eq!(target.installer_url, "https://install.example");
    }

    #[test]
    fn a_dev_daemon_moves_to_the_dev_tag() {
        let updater = updater(true, ReleaseChannel::Dev, "0.4.1");
        let target = updater
            .plan_for_protocol_error(&protocol_error(
                u64::from(PROTOCOL_VERSION) + 1,
                "0.5.0",
                None,
            ))
            .expect("newer gateway plans an update");
        assert_eq!(target.release, DEV_RELEASE_TAG);
        assert_eq!(target.installer_url, DEFAULT_INSTALLER_URL);
    }

    #[test]
    fn an_insecure_installer_url_falls_back_to_the_public_one() {
        let updater = updater(true, ReleaseChannel::Stable, "0.4.1");
        let target = updater
            .plan_for_protocol_error(&protocol_error(
                u64::from(PROTOCOL_VERSION) + 1,
                "0.5.0",
                Some("http://install.example"),
            ))
            .expect("newer gateway plans an update");
        assert_eq!(target.installer_url, DEFAULT_INSTALLER_URL);
    }

    #[test]
    fn a_gateway_behind_this_build_is_not_an_update() {
        let updater = updater(true, ReleaseChannel::Stable, "0.4.1");
        let older = protocol_error(u64::from(PROTOCOL_VERSION) - 1, "0.3.0", None);
        assert_eq!(updater.plan_for_protocol_error(&older), None);
        let other = GatewayRpcError::new("sys.connect", 401, "nope", None);
        assert_eq!(updater.plan_for_protocol_error(&other), None);
    }

    #[test]
    fn a_newer_stable_gateway_requests_a_catch_up() {
        let updater = updater(true, ReleaseChannel::Stable, "0.4.1");
        let target = updater
            .plan_for_server(&server("0.4.2", Some("v0.4.2")))
            .expect("newer release plans an update");
        assert_eq!(target.release, "v0.4.2");
        assert_eq!(target.reason, UpdateReason::NewerRelease);
        assert_eq!(
            updater.plan_for_server(&server("0.4.1", Some("v0.4.1"))),
            None
        );
        assert_eq!(
            updater.plan_for_server(&server("0.3.9", Some("v0.3.9"))),
            None
        );
        assert_eq!(updater.plan_for_server(&server("garbage", None)), None);
    }

    #[test]
    fn a_dev_gateway_never_moves_a_stable_daemon() {
        let updater = updater(true, ReleaseChannel::Stable, "0.4.1");
        assert_eq!(updater.plan_for_server(&server("0.9.0", Some("dev"))), None);
        let dev = updater_with_channel(ReleaseChannel::Dev);
        assert_eq!(
            dev.plan_for_server(&server("0.9.0", Some("dev")))
                .map(|target| target.release),
            Some(DEV_RELEASE_TAG.to_string())
        );
    }

    fn updater_with_channel(channel: ReleaseChannel) -> AutoUpdater {
        updater(true, channel, "0.4.1")
    }

    #[test]
    fn updates_are_off_when_the_switch_is_off() {
        let updater = updater(false, ReleaseChannel::Stable, "0.4.1");
        assert!(matches!(
            updater.check_allowed(SystemTime::now()),
            Err(UpdateError::Disabled)
        ));
    }

    #[test]
    fn at_most_one_attempt_per_hour() {
        let updater = updater(true, ReleaseChannel::Stable, "0.4.1");
        let now = SystemTime::now();
        assert!(updater.check_allowed(now).is_ok());
        updater
            .record_attempt("v0.5.0", now)
            .expect("record attempt");
        assert!(matches!(
            updater.check_allowed(now + Duration::from_secs(600)),
            Err(UpdateError::Deferred { .. })
        ));
        assert!(updater
            .check_allowed(now + MIN_ATTEMPT_INTERVAL + Duration::from_secs(1))
            .is_ok());
        assert_eq!(
            updater.last_attempt().map(|record| record.release),
            Some("v0.5.0".to_string())
        );
    }

    #[test]
    fn the_installer_is_pinned_to_the_release_and_this_installation() {
        let invocation = installer_invocation(
            Path::new("/home/u/.gsv/auto-update/install.sh"),
            "v0.5.0",
            Path::new("/usr/local/bin"),
        );
        assert!(invocation
            .env
            .contains(&("GSV_VERSION".to_string(), "v0.5.0".to_string())));
        assert!(invocation
            .env
            .contains(&("GSV_INSTALL_DIR".to_string(), "/usr/local/bin".to_string())));
        if cfg!(windows) {
            assert_eq!(invocation.program, "powershell.exe");
            assert!(invocation.args.contains(&"-NonInteractive".to_string()));
        } else {
            assert_eq!(invocation.program, "bash");
            assert_eq!(invocation.args, vec!["/home/u/.gsv/auto-update/install.sh"]);
        }
    }

    #[test]
    fn systemd_run_keeps_the_installer_outside_the_service() {
        let invocation = InstallerInvocation {
            program: "bash".to_string(),
            args: vec!["/tmp/install.sh".to_string()],
            env: vec![("GSV_VERSION".to_string(), "v0.5.0".to_string())],
        };
        let args = systemd_run_arguments(
            "gsv-auto-update-1",
            Path::new("/home/u/.gsv/logs/auto-update.log"),
            Some("/usr/bin"),
            &invocation,
        );
        assert_eq!(
            args,
            vec![
                "--user",
                "--collect",
                "--quiet",
                "--unit=gsv-auto-update-1",
                "--property=StandardOutput=append:/home/u/.gsv/logs/auto-update.log",
                "--property=StandardError=append:/home/u/.gsv/logs/auto-update.log",
                "--setenv=PATH=/usr/bin",
                "--setenv=GSV_VERSION=v0.5.0",
                "bash",
                "/tmp/install.sh",
            ]
        );
    }

    #[test]
    fn the_installer_url_matches_the_platform_script() {
        let url = installer_script_url("https://install.gsv.space/");
        if cfg!(windows) {
            assert_eq!(url, "https://install.gsv.space/install.ps1");
        } else {
            assert_eq!(url, "https://install.gsv.space");
        }
    }
}
