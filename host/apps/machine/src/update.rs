//! Self-update of the machine daemon, decided at the gateway handshake.
//!
//! The gateway cannot reach a machine, so the daemon decides when it connects.
//! A protocol error 102 names the release the gateway requires; a successful
//! connect against a newer release is a request to catch up. The daemon never
//! replaces its own executable. It starts the same installer a person would
//! run, pinned to the release the gateway named, detached from its own service
//! so that stopping `gsvd` cannot kill the installer, and lets the installer
//! swap the binaries, restart the service, and roll back on failure.

use std::ffi::OsStr;
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
    Deferred {
        since: Duration,
    },
    /// The daemon lives in a directory this user cannot write, so the
    /// installer would need sudo, which an unattended service cannot give.
    Unwritable {
        dir: PathBuf,
    },
    /// The daemon lives inside a macOS application bundle that Desktop owns.
    AppBundle {
        dir: PathBuf,
    },
    /// Nothing would restart the daemon after the installer replaced it.
    NotServiceManaged {
        dir: PathBuf,
    },
    /// The installer could not be kept out of the daemon's own service, so
    /// stopping the service would kill it mid-update.
    NoDetachment {
        dir: PathBuf,
    },
    State(String),
    Download(String),
    Spawn(String),
}

impl UpdateError {
    /// Whether nothing was attempted, so the decision is worth one quiet
    /// line rather than a warning.
    pub fn is_skip(&self) -> bool {
        matches!(
            self,
            Self::Disabled
                | Self::Deferred { .. }
                | Self::Unwritable { .. }
                | Self::AppBundle { .. }
                | Self::NotServiceManaged { .. }
                | Self::NoDetachment { .. }
        )
    }
}

/// The command a person runs to update the installation in `dir` by hand.
pub fn manual_install_command(dir: &Path) -> String {
    if cfg!(windows) {
        format!(
            "$env:GSV_INSTALL_DIR='{}'; irm https://install.gsv.space/install.ps1 | iex",
            dir.display()
        )
    } else {
        format!(
            "curl -fsSL https://install.gsv.space | GSV_INSTALL_DIR=\"{}\" bash",
            dir.display()
        )
    }
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
            Self::Unwritable { dir } => write!(
                f,
                "{} is not writable by this user. Run the installer yourself: {}",
                dir.display(),
                manual_install_command(dir)
            ),
            Self::AppBundle { dir } => write!(
                f,
                "{} is part of the Desktop application, which updates it",
                dir.display()
            ),
            Self::NotServiceManaged { dir } => write!(
                f,
                "this daemon is not run by a service manager, so nothing would restart it after an update. Run the installer yourself: {}",
                manual_install_command(dir)
            ),
            Self::NoDetachment { dir } => write!(
                f,
                "automatic updates need systemd-run on this machine, and it is not installed. Run the installer yourself: {}",
                manual_install_command(dir)
            ),
            Self::State(error) => write!(f, "could not record the update attempt: {error}"),
            Self::Download(error) => write!(f, "could not download the installer: {error}"),
            Self::Spawn(error) => write!(f, "could not start the installer: {error}"),
        }
    }
}

impl std::error::Error for UpdateError {}

/// What the daemon started, for the log line and the diagnostics notice.
#[derive(Debug)]
pub struct UpdateLaunch {
    pub release: String,
    pub log_path: PathBuf,
    pub detach: DetachStrategy,
    /// What to watch to learn that the installer finished without
    /// restarting this daemon.
    pub installer: InstallerHandle,
}

/// The running installer as far as the daemon can see it.
#[derive(Debug)]
pub enum InstallerHandle {
    /// The installer is a direct child; its exit is its outcome. Boxed
    /// because a child carries platform handles (over 270 bytes on Windows)
    /// that would dwarf the other variant.
    Process(Box<tokio::process::Child>),
    /// The installer runs in a transient user unit; `systemctl --user
    /// is-active` says whether it is still going, when `systemctl` resolves.
    TransientUnit {
        unit: String,
        systemctl: Option<PathBuf>,
    },
}

/// How long an installer may stay unobserved before the daemon assumes it
/// ended without restarting the service and lowers its gate.
pub const INSTALLING_WINDOW: Duration = Duration::from_secs(15 * 60);

/// Whether the installing window that started at `since` has run out.
pub fn installing_window_elapsed(since: SystemTime, now: SystemTime) -> bool {
    now.duration_since(since)
        .map(|elapsed| elapsed >= INSTALLING_WINDOW)
        .unwrap_or(false)
}

/// What `systemctl --user is-active` said about the transient unit. Only a
/// query that ran and answered counts; a probe that could not run or reach
/// the user manager proves nothing about the installer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnitState {
    Active,
    Inactive,
    Unknown,
}

/// `systemctl is-active` exits 0 for active, 3 for inactive, and 4 for a
/// unit it does not know; since the transient unit is uniquely named and
/// started with `--collect`, which unloads it once it ran, 4 means finished.
/// Anything else (1 for a failed query, a bus it cannot reach, a signal, a
/// spawn error) proves nothing.
pub fn unit_state_from_status(status: io::Result<std::process::ExitStatus>) -> UnitState {
    match status.ok().and_then(|status| status.code()) {
        Some(0) => UnitState::Active,
        Some(3 | 4) => UnitState::Inactive,
        _ => UnitState::Unknown,
    }
}

/// Ask `systemctl` whether the transient unit is still active.
pub async fn transient_unit_state(systemctl: &Path, unit: &str) -> UnitState {
    unit_state_from_status(
        tokio::process::Command::new(systemctl)
            .args(["--user", "is-active", "--quiet", unit])
            .status()
            .await,
    )
}

/// How the installer escapes the daemon's own service so that stopping
/// `gsvd` cannot stop the update.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DetachStrategy {
    /// A transient `systemd-run --user` unit outside the `gsvd` cgroup,
    /// started through the named `systemd-run` executable.
    SystemdRun { program: PathBuf },
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
            Self::SystemdRun { .. } => "systemd-run",
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
    /// Set once the installer process actually started; a record without it
    /// is a failed attempt that only rate-limits the next one.
    #[serde(default)]
    launched: bool,
}

/// Whether the daemon is inside the hour that follows an update attempt.
/// Alone it means "wait for the next window"; a launched installer for the
/// release the gateway still names means one is presumably running now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttemptState {
    None,
    Cooling { since: Duration },
    InProgress { since: Duration },
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

    /// Take the switch and the channel from `config` again, so a change on
    /// disk applies at the next handshake without a reload. Paths and the
    /// attempt record stay as they are.
    pub fn refresh_from(&mut self, config: &CliConfig) {
        self.enabled = config.device_auto_update();
        self.channel = match config.release_channel().as_deref() {
            Some("dev") => ReleaseChannel::Dev,
            _ => ReleaseChannel::Stable,
        };
    }

    /// Where installer output goes.
    pub fn log_path(&self) -> &Path {
        &self.log_path
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
        let server_release = details
            .get("serverRelease")
            .and_then(|value| value.as_str());
        if self.channel == ReleaseChannel::Stable && server_release == Some(DEV_RELEASE_TAG) {
            return None;
        }
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
        if !self.enabled {
            return Err(UpdateError::Disabled);
        }
        let install_dir = install_dir()?;
        let Some(manager) = detect_service_manager() else {
            return Err(UpdateError::NotServiceManaged { dir: install_dir });
        };
        let Some(strategy) = detach_strategy(manager, systemd_run_path()) else {
            return Err(UpdateError::NoDetachment { dir: install_dir });
        };
        if is_app_bundle_dir(&install_dir) {
            return Err(UpdateError::AppBundle { dir: install_dir });
        }
        if !dir_writable(&install_dir) {
            return Err(UpdateError::Unwritable { dir: install_dir });
        }
        self.check_allowed(SystemTime::now())?;
        self.record_attempt(&target.release, SystemTime::now())?;

        let script = self
            .download_installer(&target.installer_url)
            .await
            .map_err(UpdateError::Download)?;
        let invocation = installer_invocation(&script, &target.release, &install_dir);
        let log = self.open_log()?;
        let unit = format!("gsv-auto-update-{}", unix_seconds(SystemTime::now()));
        let mut command = detached_command(&invocation, &strategy, &self.log_path, log, &unit)
            .map_err(|error| UpdateError::Spawn(error.to_string()))?;
        let mut child = tokio::process::Command::from(command_take(&mut command))
            .kill_on_drop(kill_launcher_on_drop(&strategy))
            .spawn()
            .map_err(|error| UpdateError::Spawn(error.to_string()))?;
        let release = target.release.clone();
        let strategy_for_log = strategy.clone();
        let installer = if matches!(strategy, DetachStrategy::SystemdRun { .. }) {
            // The child is only the launcher: it exits once the transient
            // unit is submitted, and its status says whether that happened.
            let status = child
                .wait()
                .await
                .map_err(|error| UpdateError::Spawn(error.to_string()))?;
            if let Err(detail) = launcher_outcome(status) {
                warn!(event = "update.launcher_failed", release = %release, detach = %strategy_for_log, status = %status);
                return Err(UpdateError::Spawn(detail));
            }
            info!(event = "update.launcher_exited", release = %release, detach = %strategy_for_log);
            InstallerHandle::TransientUnit {
                unit,
                systemctl: systemctl_path(),
            }
        } else {
            InstallerHandle::Process(Box::new(child))
        };
        if let Err(error) = self.mark_launched(&target.release) {
            // The installer is running either way; without the mark the next
            // handshake within the hour reads a cooling attempt and waits.
            warn!(event = "update.record_failed", release = %target.release, error = %error);
        }
        Ok(UpdateLaunch {
            release: target.release.clone(),
            log_path: self.log_path.clone(),
            detach: strategy,
            installer,
        })
    }

    /// How the last recorded attempt relates to `release` at `now`.
    pub fn attempt_state(&self, release: &str, now: SystemTime) -> AttemptState {
        let Some(record) = self.last_attempt() else {
            return AttemptState::None;
        };
        let now = unix_seconds(now);
        let since = Duration::from_secs(now.saturating_sub(record.attempted_at));
        if record.attempted_at > now || since >= MIN_ATTEMPT_INTERVAL {
            return AttemptState::None;
        }
        if record.launched && record.release == release {
            AttemptState::InProgress { since }
        } else {
            AttemptState::Cooling { since }
        }
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

    #[cfg(test)]
    pub(crate) fn record_attempt_for_test(
        &self,
        release: &str,
        now: SystemTime,
        launched: bool,
    ) -> Result<(), UpdateError> {
        self.record_attempt(release, now)?;
        if launched {
            self.mark_launched(release)?;
        }
        Ok(())
    }

    fn record_attempt(&self, release: &str, now: SystemTime) -> Result<(), UpdateError> {
        self.ensure_work_dir()
            .map_err(|error| UpdateError::State(error.to_string()))?;
        self.write_record(&AttemptRecord {
            attempted_at: unix_seconds(now),
            release: release.to_string(),
            launched: false,
        })
    }

    /// Promote the current attempt to a launched one, once the installer
    /// process exists.
    fn mark_launched(&self, release: &str) -> Result<(), UpdateError> {
        let Some(mut record) = self.last_attempt() else {
            return Err(UpdateError::State(
                "the attempt record is missing".to_string(),
            ));
        };
        if record.release != release {
            return Err(UpdateError::State(
                "the attempt record names another release".to_string(),
            ));
        }
        record.launched = true;
        self.write_record(&record)
    }

    /// Demote the attempt for `release` to a plain, cooling one after its
    /// installer ended without restarting the service.
    pub fn clear_launched(&self, release: &str) -> Result<(), UpdateError> {
        let Some(mut record) = self.last_attempt() else {
            return Ok(());
        };
        if record.release != release {
            return Ok(());
        }
        record.launched = false;
        self.write_record(&record)
    }

    fn write_record(&self, record: &AttemptRecord) -> Result<(), UpdateError> {
        let encoded =
            serde_json::to_vec(record).map_err(|error| UpdateError::State(error.to_string()))?;
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
        let mut response = client
            .get(&url)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        check_declared_length(response.content_length(), MAX_INSTALLER_BYTES)?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            push_within_limit(&mut body, &chunk, MAX_INSTALLER_BYTES)?;
        }
        if body.is_empty() {
            return Err("installer script is empty".to_string());
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

/// Whether `dir` sits inside a macOS application bundle (`Foo.app/Contents/`).
/// Desktop owns that distribution; loose binaries must not be mixed into it.
pub fn is_app_bundle_dir(dir: &Path) -> bool {
    let components: Vec<&str> = dir
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect();
    components
        .windows(2)
        .any(|pair| pair[0].ends_with(".app") && pair[1] == "Contents")
}

/// Whether this user can replace files in `dir`, proven by creating and
/// removing a file there rather than by reading permission bits.
pub fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".gsv-update-probe-{}", std::process::id()));
    let created = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .is_ok();
    if created {
        let _ = fs::remove_file(&probe);
    }
    created
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

/// Whether the spawned child dies with the launch future. Under systemd the
/// child is only the launcher, awaited before the launch is confirmed, so a
/// cancelled launch must not let it submit the unit afterwards; once its
/// exit is observed there is nothing left to kill. Elsewhere the child is
/// the detached installer itself and spawning it is the confirmation.
pub fn kill_launcher_on_drop(strategy: &DetachStrategy) -> bool {
    matches!(strategy, DetachStrategy::SystemdRun { .. })
}

/// Whether `systemd-run` managed to submit the transient unit: only a clean
/// exit means the installer exists somewhere the service stop cannot reach.
pub fn launcher_outcome(status: std::process::ExitStatus) -> Result<(), String> {
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "systemd-run did not start the installer ({status})"
        ))
    }
}

/// Reject a response that announces more than `limit` bytes before reading it.
fn check_declared_length(declared: Option<u64>, limit: usize) -> Result<(), String> {
    match declared {
        Some(length) if length > limit as u64 => Err(format!(
            "installer script is too large ({length} bytes, limit {limit})"
        )),
        _ => Ok(()),
    }
}

/// Append `chunk` to `body` unless that would exceed `limit`, so an
/// undeclared or lying length still cannot buffer more than the cap.
fn push_within_limit(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > limit {
        return Err(format!(
            "installer script is too large (over {limit} bytes)"
        ));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

/// What supervises this daemon and would restart it after the installer
/// swaps the binary. Without one, an update would leave old code running.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceManager {
    Systemd,
    Launchd,
    WindowsTask,
}

impl Display for ServiceManager {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Systemd => "systemd",
            Self::Launchd => "launchd",
            Self::WindowsTask => "windows-task",
        })
    }
}

/// The observations `service_manager` decides from, gathered by
/// `detect_service_manager` so the decision itself stays testable.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ServiceContext {
    /// The running daemon executable, which the managed service definition
    /// must name for an update to be restartable.
    pub executable: PathBuf,
    /// systemd sets `INVOCATION_ID` for every unit it starts.
    pub systemd_invocation: bool,
    /// The program the user unit `gsvd.service` runs, if the unit exists.
    pub systemd_unit_program: Option<PathBuf>,
    /// launchd sets `XPC_SERVICE_NAME` to the label of the job it started.
    pub xpc_service_name: Option<String>,
    /// On macOS a process launchd started has launchd (pid 1) as its parent.
    pub parent_is_launchd: bool,
    /// The program `~/Library/LaunchAgents/gsvd.plist` runs, if it exists.
    pub launchd_program: Option<PathBuf>,
    /// The `gsvd` scheduled task reports itself running; the control pipe is
    /// exclusive, so a running task is this process.
    pub windows_task_running: bool,
    /// The program the scheduled task runs, when the listing exposes it.
    pub windows_task_program: Option<PathBuf>,
}

const SERVICE_LABEL: &str = "gsvd";

/// The manager that will restart this daemon after an update: not just any
/// supervisor, but the `gsvd` definition the installer stops and starts, and
/// only when that definition runs this very executable.
pub fn service_manager(context: &ServiceContext) -> Option<ServiceManager> {
    let exe = &context.executable;
    if context.systemd_invocation && same_executable(context.systemd_unit_program.as_deref(), exe) {
        return Some(ServiceManager::Systemd);
    }
    let launchd_label = context
        .xpc_service_name
        .as_deref()
        .is_some_and(|name| name == SERVICE_LABEL || name.starts_with("gsvd."));
    if (launchd_label || context.parent_is_launchd)
        && same_executable(context.launchd_program.as_deref(), exe)
    {
        return Some(ServiceManager::Launchd);
    }
    // schtasks lists the action on most systems; when the listing lacks it
    // the exclusive control pipe still proves a running task is this process.
    if context.windows_task_running
        && context
            .windows_task_program
            .as_deref()
            .is_none_or(|program| same_executable(Some(program), exe))
    {
        return Some(ServiceManager::WindowsTask);
    }
    None
}

fn same_executable(program: Option<&Path>, executable: &Path) -> bool {
    let Some(program) = program else {
        return false;
    };
    let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let (program, executable) = (canonical(program), canonical(executable));
    if cfg!(windows) {
        program
            .to_string_lossy()
            .eq_ignore_ascii_case(&executable.to_string_lossy())
    } else {
        program == executable
    }
}

/// The program a systemd unit's `ExecStart=` runs. The CLI writes it as a
/// double-quoted string with embedded quotes and backslashes escaped.
pub fn exec_start_program(unit: &str) -> Option<PathBuf> {
    let line = unit
        .lines()
        .map(str::trim_start)
        .find_map(|line| line.strip_prefix("ExecStart="))?
        .trim_start();
    let Some(quoted) = line.strip_prefix('"') else {
        return line.split_whitespace().next().map(PathBuf::from);
    };
    let mut program = String::new();
    let mut chars = quoted.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => program.extend(chars.next()),
            '"' => return Some(PathBuf::from(program)),
            other => program.push(other),
        }
    }
    None
}

/// The first `ProgramArguments` entry of a launchd plist, XML entities decoded.
pub fn plist_program(plist: &str) -> Option<PathBuf> {
    let start = plist.find("<key>ProgramArguments</key>")?;
    let rest = &plist[start..];
    let array = &rest[..rest.find("</array>").unwrap_or(rest.len())];
    let open = array.find("<string>")? + "<string>".len();
    let close = array[open..].find("</string>")? + open;
    Some(PathBuf::from(decode_xml_entities(&array[open..close])))
}

fn decode_xml_entities(text: &str) -> String {
    [
        ("&lt;", "<"),
        ("&#60;", "<"),
        ("&gt;", ">"),
        ("&#62;", ">"),
        ("&quot;", "\""),
        ("&#34;", "\""),
        ("&apos;", "'"),
        ("&#39;", "'"),
        ("&#38;", "&"),
        ("&amp;", "&"),
    ]
    .iter()
    .fold(text.to_string(), |decoded, (entity, plain)| {
        decoded.replace(entity, plain)
    })
}

/// The program a `schtasks /query /fo LIST /v` listing shows as the action.
pub fn task_to_run_program(listing: &str) -> Option<PathBuf> {
    let value = listing.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case("Task To Run")
            .then(|| value.trim())
    })?;
    match value.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next().map(PathBuf::from),
        None => value.split_whitespace().next().map(PathBuf::from),
    }
}

/// The program the user unit in `config_dir` runs, if the unit exists.
pub fn systemd_unit_program(config_dir: &Path) -> Option<PathBuf> {
    let unit = config_dir.join("systemd").join("user").join("gsvd.service");
    exec_start_program(&fs::read_to_string(unit).ok()?)
}

/// The program the launch agent under `home` runs, if the plist exists.
pub fn launchd_agent_program(home: &Path) -> Option<PathBuf> {
    let plist = home.join("Library").join("LaunchAgents").join("gsvd.plist");
    plist_program(&fs::read_to_string(plist).ok()?)
}

fn detect_service_manager() -> Option<ServiceManager> {
    let executable = std::env::current_exe().ok()?;
    let listing = windows_task_listing();
    service_manager(&ServiceContext {
        executable,
        systemd_invocation: cfg!(target_os = "linux")
            && std::env::var_os("INVOCATION_ID").is_some(),
        systemd_unit_program: if cfg!(target_os = "linux") {
            dirs::config_dir().and_then(|dir| systemd_unit_program(&dir))
        } else {
            None
        },
        xpc_service_name: if cfg!(target_os = "macos") {
            std::env::var("XPC_SERVICE_NAME").ok()
        } else {
            None
        },
        parent_is_launchd: parent_is_launchd(),
        launchd_program: if cfg!(target_os = "macos") {
            dirs::home_dir().and_then(|home| launchd_agent_program(&home))
        } else {
            None
        },
        windows_task_running: listing.as_deref().is_some_and(task_status_running),
        windows_task_program: listing.as_deref().and_then(task_to_run_program),
    })
}

#[cfg(target_os = "macos")]
fn parent_is_launchd() -> bool {
    // SAFETY: getppid has no preconditions and only reads the parent's id.
    unsafe { libc::getppid() == 1 }
}

#[cfg(not(target_os = "macos"))]
fn parent_is_launchd() -> bool {
    false
}

#[cfg(windows)]
fn windows_task_listing() -> Option<String> {
    Command::new("schtasks")
        .args(["/query", "/tn", SERVICE_LABEL, "/fo", "LIST", "/v"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(windows))]
fn windows_task_listing() -> Option<String> {
    None
}

/// Whether a `schtasks /query /fo LIST /v` listing shows the task running.
pub fn task_status_running(listing: &str) -> bool {
    listing.lines().any(|line| {
        let mut parts = line.splitn(2, ':');
        let key = parts.next().unwrap_or("").trim();
        let value = parts.next().unwrap_or("").trim();
        key.eq_ignore_ascii_case("Status") && value.eq_ignore_ascii_case("Running")
    })
}

/// Where distributions install `systemd-run` when a unit's PATH is too
/// minimal to find it.
/// Where distributions install the systemd tools when a unit's PATH is too
/// minimal to find them.
const SYSTEMD_TOOL_DIRS: &[&str] = &["/usr/bin", "/bin"];

/// Resolve a systemd tool: the service PATH first, then the distribution
/// locations, so a unit with a minimal PATH still gets a working update.
pub fn resolve_systemd_tool(
    name: &str,
    path_env: Option<&OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let from_path: Vec<PathBuf> = path_env
        .map(|path| {
            std::env::split_paths(path)
                .map(|dir| dir.join(name))
                .collect()
        })
        .unwrap_or_default();
    from_path
        .into_iter()
        .chain(
            SYSTEMD_TOOL_DIRS
                .iter()
                .map(|dir| Path::new(dir).join(name)),
        )
        .find(|candidate| exists(candidate))
}

pub fn resolve_systemd_run(
    path_env: Option<&OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    resolve_systemd_tool("systemd-run", path_env, exists)
}

fn systemd_run_path() -> Option<PathBuf> {
    resolve_systemd_run(std::env::var_os("PATH").as_deref(), |candidate| {
        candidate.is_file()
    })
}

fn systemctl_path() -> Option<PathBuf> {
    resolve_systemd_tool(
        "systemctl",
        std::env::var_os("PATH").as_deref(),
        |candidate| candidate.is_file(),
    )
}

/// How to keep the installer alive once it stops this service. Under systemd
/// only a transient unit escapes the cgroup that `systemctl stop` kills, so
/// without `systemd-run` there is no safe way and the answer is `None`.
pub fn detach_strategy(
    manager: ServiceManager,
    systemd_run: Option<PathBuf>,
) -> Option<DetachStrategy> {
    match manager {
        ServiceManager::Systemd => {
            systemd_run.map(|program| DetachStrategy::SystemdRun { program })
        }
        ServiceManager::Launchd => Some(DetachStrategy::NewSession),
        ServiceManager::WindowsTask => Some(DetachStrategy::WindowsDetached),
    }
}

fn detached_command(
    invocation: &InstallerInvocation,
    strategy: &DetachStrategy,
    log_path: &Path,
    log: fs::File,
    unit: &str,
) -> io::Result<Command> {
    let mut command = match strategy {
        DetachStrategy::SystemdRun { program } => {
            let path_env = std::env::var("PATH").ok();
            let mut command = Command::new(program);
            command.args(systemd_run_arguments(
                unit,
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
fn detach(command: &mut Command, strategy: &DetachStrategy) {
    use std::os::unix::process::CommandExt;
    if *strategy != DetachStrategy::NewSession {
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
fn detach(command: &mut Command, _strategy: &DetachStrategy) {
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

    #[tokio::test]
    async fn a_switch_flipped_on_disk_between_handshakes_is_honoured_by_the_second() {
        let dir = std::env::temp_dir().join(format!("gsvd-refresh-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("config dir");
        let config_path = dir.join("config.toml");
        let load = |contents: &str| -> CliConfig {
            fs::write(&config_path, contents).expect("write config");
            host_config::ConfigFile::<CliConfig>::new(&config_path)
                .load()
                .expect("config loads")
        };
        let mut updater = updater(true, ReleaseChannel::Stable, "0.4.1");
        let newer = server("0.5.0", Some("v0.5.0"));
        let target = updater
            .plan_for_server(&newer)
            .expect("newer release plans an update");
        assert_eq!(target.release, "v0.5.0");

        // First handshake: the switch is on and the channel stable.
        updater.refresh_from(&load("[device]\nauto_update = true\n"));
        assert!(updater.enabled());
        assert_eq!(
            updater.plan_for_server(&newer).map(|target| target.release),
            Some("v0.5.0".to_string())
        );

        // Flipped on disk, then the second handshake.
        updater.refresh_from(&load(
            "[device]\nauto_update = false\n\n[release]\nchannel = \"dev\"\n",
        ));
        assert!(!updater.enabled());
        assert!(matches!(
            updater.launch(&target).await,
            Err(UpdateError::Disabled)
        ));
        assert_eq!(
            updater.plan_for_server(&newer).map(|target| target.release),
            Some(DEV_RELEASE_TAG.to_string())
        );
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn a_stable_daemon_does_not_chase_a_dev_gateway_after_a_102() {
        let stable = updater(true, ReleaseChannel::Stable, "0.4.1");
        let mut error = protocol_error(u64::from(PROTOCOL_VERSION) + 1, "0.5.0", None);
        if let Some(details) = error.details.as_mut() {
            details["serverRelease"] = json!("dev");
        }
        assert_eq!(stable.plan_for_protocol_error(&error), None);
        if let Some(details) = error.details.as_mut() {
            details["serverRelease"] = json!("v0.5.0");
        }
        assert_eq!(
            stable
                .plan_for_protocol_error(&error)
                .map(|target| target.release),
            Some("v0.5.0".to_string())
        );
        let dev = updater(true, ReleaseChannel::Dev, "0.4.1");
        if let Some(details) = error.details.as_mut() {
            details["serverRelease"] = json!("dev");
        }
        assert_eq!(
            dev.plan_for_protocol_error(&error)
                .map(|target| target.release),
            Some(DEV_RELEASE_TAG.to_string())
        );
    }

    #[test]
    fn only_the_managed_service_running_this_executable_updates_itself() {
        let exe = PathBuf::from("/opt/gsv/bin/gsvd");
        let other = PathBuf::from("/opt/other/gsvd");
        let base = ServiceContext {
            executable: exe.clone(),
            ..ServiceContext::default()
        };
        assert_eq!(service_manager(&base), None);

        let systemd = ServiceContext {
            systemd_invocation: true,
            systemd_unit_program: Some(exe.clone()),
            ..base.clone()
        };
        assert_eq!(service_manager(&systemd), Some(ServiceManager::Systemd));
        assert_eq!(
            service_manager(&ServiceContext {
                systemd_unit_program: Some(other.clone()),
                ..systemd.clone()
            }),
            None
        );
        assert_eq!(
            service_manager(&ServiceContext {
                systemd_unit_program: None,
                ..systemd.clone()
            }),
            None
        );

        let launchd = ServiceContext {
            xpc_service_name: Some("gsvd".to_string()),
            launchd_program: Some(exe.clone()),
            ..base.clone()
        };
        assert_eq!(service_manager(&launchd), Some(ServiceManager::Launchd));
        assert_eq!(
            service_manager(&ServiceContext {
                xpc_service_name: Some("0".to_string()),
                parent_is_launchd: true,
                ..launchd.clone()
            }),
            Some(ServiceManager::Launchd)
        );
        assert_eq!(
            service_manager(&ServiceContext {
                xpc_service_name: Some("0".to_string()),
                ..launchd.clone()
            }),
            None
        );
        assert_eq!(
            service_manager(&ServiceContext {
                launchd_program: Some(other.clone()),
                ..launchd.clone()
            }),
            None
        );

        let task = ServiceContext {
            windows_task_running: true,
            windows_task_program: Some(exe.clone()),
            ..base.clone()
        };
        assert_eq!(service_manager(&task), Some(ServiceManager::WindowsTask));
        assert_eq!(
            service_manager(&ServiceContext {
                windows_task_program: None,
                ..task.clone()
            }),
            Some(ServiceManager::WindowsTask)
        );
        assert_eq!(
            service_manager(&ServiceContext {
                windows_task_program: Some(other),
                ..task.clone()
            }),
            None
        );
        assert!(task_status_running(
            "TaskName: \\gsvd\r\nStatus:        Running\r\n"
        ));
        assert!(!task_status_running(
            "TaskName: \\gsvd\r\nStatus:        Ready\r\n"
        ));
        assert!(!task_status_running(""));
    }

    #[test]
    fn service_definitions_name_their_program() {
        assert_eq!(
            exec_start_program(
                "[Service]\nType=simple\nExecStart=\"/opt/quoted \\\"GSV\\\" dir/gsvd\" \"--foreground\"\n"
            ),
            Some(PathBuf::from("/opt/quoted \"GSV\" dir/gsvd"))
        );
        assert_eq!(
            exec_start_program("ExecStart=/usr/local/bin/gsv device run\n"),
            Some(PathBuf::from("/usr/local/bin/gsv"))
        );
        assert_eq!(exec_start_program("[Service]\nType=simple\n"), None);
        assert_eq!(exec_start_program("ExecStart=\"/unterminated"), None);

        let plist = "<plist><dict><key>Label</key><string>gsvd</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/Users/me/GSV &amp; Tools/bin/gsvd</string>\n    <string>--foreground</string>\n  </array>\n</dict></plist>";
        assert_eq!(
            plist_program(plist),
            Some(PathBuf::from("/Users/me/GSV & Tools/bin/gsvd"))
        );
        assert_eq!(plist_program("<plist><dict></dict></plist>"), None);

        let listing = "HostName:      PC\r\nTaskName:      \\gsvd\r\nStatus:        Running\r\nTask To Run:   \"C:\\Users\\me\\AppData\\Local\\Programs\\gsv\\bin\\gsvd.exe\" --foreground\r\n";
        assert_eq!(
            task_to_run_program(listing),
            Some(PathBuf::from(
                "C:\\Users\\me\\AppData\\Local\\Programs\\gsv\\bin\\gsvd.exe"
            ))
        );
        assert_eq!(task_to_run_program("Status: Running\r\n"), None);
    }

    #[test]
    fn service_definition_files_are_read_from_their_managed_locations() {
        let root = std::env::temp_dir().join(format!("gsvd-service-{}", uuid::Uuid::new_v4()));
        let unit_dir = root.join("config").join("systemd").join("user");
        fs::create_dir_all(&unit_dir).expect("unit dir");
        fs::write(
            unit_dir.join("gsvd.service"),
            "[Service]\nExecStart=\"/opt/gsv/bin/gsvd\" \"--foreground\"\n",
        )
        .expect("unit file");
        assert_eq!(
            systemd_unit_program(&root.join("config")),
            Some(PathBuf::from("/opt/gsv/bin/gsvd"))
        );
        assert_eq!(systemd_unit_program(&root.join("missing")), None);

        let agents = root.join("home").join("Library").join("LaunchAgents");
        fs::create_dir_all(&agents).expect("agents dir");
        fs::write(
            agents.join("gsvd.plist"),
            "<plist><dict><key>ProgramArguments</key><array><string>/Applications/GSV.app/Contents/MacOS/gsvd</string></array></dict></plist>",
        )
        .expect("plist");
        assert_eq!(
            launchd_agent_program(&root.join("home")),
            Some(PathBuf::from("/Applications/GSV.app/Contents/MacOS/gsvd"))
        );
        assert_eq!(launchd_agent_program(&root.join("nowhere")), None);

        let exe = root.join("gsvd");
        fs::write(&exe, b"").expect("exe");
        assert!(same_executable(Some(&exe), &exe));
        assert!(!same_executable(Some(&root.join("other")), &exe));
        assert!(!same_executable(None, &exe));
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn an_attempt_for_the_named_release_counts_as_in_progress() {
        let updater = updater(true, ReleaseChannel::Stable, "0.4.1");
        let now = SystemTime::now();
        assert_eq!(updater.attempt_state("v0.5.0", now), AttemptState::None);
        updater
            .record_attempt("v0.5.0", now)
            .expect("record attempt");
        let later = now + Duration::from_secs(600);
        // Recorded but never launched: a failed download or spawn only cools.
        assert_eq!(
            updater.attempt_state("v0.5.0", later),
            AttemptState::Cooling {
                since: Duration::from_secs(600)
            }
        );
        assert!(matches!(
            updater.check_allowed(later),
            Err(UpdateError::Deferred { .. })
        ));
        updater.mark_launched("v0.5.0").expect("mark launched");
        assert_eq!(
            updater.attempt_state("v0.5.0", later),
            AttemptState::InProgress {
                since: Duration::from_secs(600)
            }
        );
        // An installer that ended without restarting the service leaves a
        // cooling record again.
        updater.clear_launched("v0.5.0").expect("clear launched");
        assert_eq!(
            updater.attempt_state("v0.5.0", later),
            AttemptState::Cooling {
                since: Duration::from_secs(600)
            }
        );
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(!installing_window_elapsed(
            start,
            start + INSTALLING_WINDOW - Duration::from_secs(1)
        ));
        assert!(installing_window_elapsed(start, start + INSTALLING_WINDOW));
        assert!(!installing_window_elapsed(
            start,
            start - Duration::from_secs(1)
        ));
        assert!(matches!(
            updater.mark_launched("v0.6.0"),
            Err(UpdateError::State(_))
        ));
        assert_eq!(
            updater.attempt_state("v0.6.0", later),
            AttemptState::Cooling {
                since: Duration::from_secs(600)
            }
        );
        assert_eq!(
            updater.attempt_state("v0.5.0", now + MIN_ATTEMPT_INTERVAL),
            AttemptState::None
        );
    }

    #[cfg(unix)]
    #[test]
    fn only_an_answered_probe_says_whether_the_unit_is_active() {
        use std::os::unix::process::ExitStatusExt;
        let status = |code: i32| Ok(std::process::ExitStatus::from_raw(code << 8));
        assert_eq!(unit_state_from_status(status(0)), UnitState::Active);
        assert_eq!(unit_state_from_status(status(3)), UnitState::Inactive);
        assert_eq!(
            unit_state_from_status(status(4)),
            UnitState::Inactive,
            "a collected transient unit is one that finished"
        );
        assert_eq!(unit_state_from_status(status(1)), UnitState::Unknown);
        assert_eq!(unit_state_from_status(status(2)), UnitState::Unknown);
        assert_eq!(unit_state_from_status(status(5)), UnitState::Unknown);
        assert_eq!(
            unit_state_from_status(Ok(std::process::ExitStatus::from_raw(9))),
            UnitState::Unknown,
            "killed by a signal has no exit code"
        );
        assert_eq!(
            unit_state_from_status(Err(io::Error::other("no such file"))),
            UnitState::Unknown
        );
    }

    #[test]
    fn only_the_systemd_launcher_dies_with_a_cancelled_launch() {
        assert!(kill_launcher_on_drop(&DetachStrategy::SystemdRun {
            program: PathBuf::from("/usr/bin/systemd-run"),
        }));
        assert!(!kill_launcher_on_drop(&DetachStrategy::NewSession));
        assert!(!kill_launcher_on_drop(&DetachStrategy::WindowsDetached));
    }

    #[cfg(unix)]
    #[test]
    fn only_a_clean_launcher_exit_counts_as_launched() {
        use std::os::unix::process::ExitStatusExt;
        assert!(launcher_outcome(std::process::ExitStatus::from_raw(0)).is_ok());
        let failed = launcher_outcome(std::process::ExitStatus::from_raw(1 << 8))
            .expect_err("a non-zero exit is a failure");
        assert!(failed.contains("did not start the installer"));
    }

    #[test]
    fn the_installer_download_is_capped_before_it_is_buffered() {
        assert!(check_declared_length(None, 8).is_ok());
        assert!(check_declared_length(Some(8), 8).is_ok());
        assert!(check_declared_length(Some(9), 8).is_err());
        let mut body = Vec::new();
        push_within_limit(&mut body, b"12345", 8).expect("under the cap");
        push_within_limit(&mut body, b"678", 8).expect("exactly the cap");
        assert!(push_within_limit(&mut body, b"9", 8).is_err());
        assert_eq!(body, b"12345678");
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
    fn the_manual_command_keeps_the_installation_where_it_is() {
        let message = UpdateError::Unwritable {
            dir: PathBuf::from("/usr/local/bin"),
        }
        .to_string();
        assert!(message.starts_with("/usr/local/bin is not writable by this user."));
        assert!(message.contains("GSV_INSTALL_DIR"));
        assert!(message.contains("/usr/local/bin"));
    }

    #[test]
    fn app_bundles_belong_to_desktop() {
        assert!(is_app_bundle_dir(Path::new(
            "/Applications/GSV.app/Contents/MacOS"
        )));
        assert!(is_app_bundle_dir(Path::new(
            "/Users/u/Applications/GSV.app/Contents/Helpers"
        )));
        assert!(!is_app_bundle_dir(Path::new("/usr/local/bin")));
        assert!(!is_app_bundle_dir(Path::new("/home/u/my.app/bin")));
        assert!(!is_app_bundle_dir(Path::new("/opt/Contents/bin")));
    }

    #[test]
    fn a_writable_directory_is_proven_by_writing_to_it() {
        let dir = std::env::temp_dir().join(format!("gsvd-writable-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create probe dir");
        assert!(dir_writable(&dir));
        assert!(fs::read_dir(&dir).expect("list probe dir").next().is_none());
        assert!(!dir_writable(&dir.join("missing")));
        fs::remove_dir_all(&dir).expect("remove probe dir");
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_directory_is_not_writable() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: geteuid has no preconditions and only reads the caller's id.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = std::env::temp_dir().join(format!("gsvd-readonly-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create probe dir");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).expect("make read-only");
        assert!(!dir_writable(&dir));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("restore");
        fs::remove_dir_all(&dir).expect("remove probe dir");
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
