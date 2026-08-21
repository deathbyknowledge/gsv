use crate::{build_info, logger};
#[cfg(any(test, target_os = "windows"))]
use base64::Engine;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

type DynError = Box<dyn std::error::Error>;

#[cfg(any(test, target_os = "linux"))]
const DEVICE_SYSTEMD_UNIT_NAME: &str = "gsvd.service";
#[cfg(any(test, target_os = "macos"))]
const DEVICE_LAUNCHD_LABEL: &str = "gsvd";
#[cfg(target_os = "windows")]
const DEVICE_WINDOWS_TASK_NAME: &str = "gsvd";
const LOG_POLL_INTERVAL: Duration = Duration::from_millis(250);

struct DeviceServiceInstallSpec {
    description: &'static str,
    exe_path: PathBuf,
    args: Vec<String>,
    path_env: Option<String>,
}

impl DeviceServiceInstallSpec {
    fn current() -> Result<Self, DynError> {
        let exe_path = resolve_gsvd_executable()?;
        Ok(Self {
            description: "gsvd",
            exe_path,
            args: vec!["--foreground".to_string()],
            path_env: device_service_path(),
        })
    }
}

trait DeviceServiceManager {
    fn is_installed(&self) -> Result<bool, DynError>;
    fn install(&self, spec: &DeviceServiceInstallSpec) -> Result<(), DynError>;
    fn uninstall(&self) -> Result<(), DynError>;
    fn start(&self) -> Result<(), DynError>;
    fn restart(&self) -> Result<(), DynError>;
    fn stop(&self) -> Result<(), DynError>;
    fn status(&self) -> Result<(), DynError>;
    fn needs_migration(&self, spec: &DeviceServiceInstallSpec) -> Result<bool, DynError>;
}

pub fn resolve_gsvd_executable() -> Result<PathBuf, DynError> {
    if let Some(explicit) = std::env::var_os("GSV_GSVD_PATH") {
        let path = PathBuf::from(explicit);
        let path = validate_gsvd_executable(path, "GSV_GSVD_PATH")?;
        validate_gsvd_version(&path)?;
        return Ok(path);
    }

    let current = std::env::current_exe()?;
    let executable_name = if cfg!(windows) { "gsvd.exe" } else { "gsvd" };
    if let Some(parent) = current.parent() {
        let sibling = parent.join(executable_name);
        if is_runnable_file(&sibling) {
            let sibling = sibling.canonicalize().unwrap_or(sibling);
            validate_gsvd_version(&sibling)?;
            return Ok(sibling);
        }
    }

    if let Some(path) = find_executable_on_path(executable_name) {
        let path = path.canonicalize().unwrap_or(path);
        validate_gsvd_version(&path)?;
        return Ok(path);
    }

    Err(format!(
        "Could not find the sibling `{executable_name}` executable. Install the complete GSV distribution or set GSV_GSVD_PATH."
    )
    .into())
}

fn validate_gsvd_version(executable: &Path) -> Result<(), DynError> {
    let version_output = read_gsvd_version(executable)?;
    let version = parse_gsvd_version(&version_output).ok_or("Invalid gsvd version output")?;
    if version != build_info::PACKAGE_VERSION {
        return Err(format!(
            "gsv {} cannot control gsvd {version}; install a complete matching GSV distribution",
            build_info::PACKAGE_VERSION,
        )
        .into());
    }
    Ok(())
}

fn validate_gsvd_executable(path: PathBuf, source: &str) -> Result<PathBuf, DynError> {
    if !is_runnable_file(&path) {
        return Err(format!(
            "{source} does not name an executable file: {}",
            path.display()
        )
        .into());
    }
    Ok(path.canonicalize().unwrap_or(path))
}

fn find_executable_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| is_runnable_file(candidate))
}

fn is_runnable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn device_service_management_supported() -> bool {
    platform_service_manager().is_some()
}

pub fn device_service_is_installed() -> Result<bool, DynError> {
    require_platform_service_manager()?.is_installed()
}

pub fn device_service_needs_migration() -> Result<bool, DynError> {
    let manager = require_platform_service_manager()?;
    if !manager.is_installed()? {
        return Ok(false);
    }
    manager.needs_migration(&DeviceServiceInstallSpec::current()?)
}

pub fn install_device_service() -> Result<(), DynError> {
    let spec = DeviceServiceInstallSpec::current()?;
    let manager = require_platform_service_manager()?;
    install_device_service_with_manager(manager.as_ref(), &spec).map(|_| ())
}

fn install_device_service_with_manager(
    manager: &dyn DeviceServiceManager,
    spec: &DeviceServiceInstallSpec,
) -> Result<bool, DynError> {
    let was_legacy = manager.is_installed()? && manager.needs_migration(spec)?;
    manager.install(spec)?;

    // Replacing a running service definition does not necessarily replace its
    // process: systemd's `enable --now` leaves an active unit running, and a
    // Windows task configured with IgnoreNew leaves its old instance alive.
    // Restart only migrations so the established service identity now runs the
    // newly installed gsvd entrypoint.
    if was_legacy {
        manager.restart()?;
    }

    Ok(was_legacy)
}

pub fn uninstall_device_service() -> Result<(), DynError> {
    require_platform_service_manager()?.uninstall()
}

pub fn start_device_service() -> Result<(), DynError> {
    require_platform_service_manager()?.start()
}

pub fn restart_device_service() -> Result<(), DynError> {
    require_platform_service_manager()?.restart()
}

pub fn stop_device_service() -> Result<(), DynError> {
    require_platform_service_manager()?.stop()
}

pub fn status_device_service() -> Result<(), DynError> {
    require_platform_service_manager()?.status()
}

pub fn doctor_device_service() -> Result<(), DynError> {
    let manager = require_platform_service_manager()?;
    let executable = resolve_gsvd_executable()?;
    let installed = manager.is_installed()?;
    let migration_required =
        installed && manager.needs_migration(&DeviceServiceInstallSpec::current()?)?;
    let daemon_version = read_gsvd_version(&executable)?;

    println!("gsvd executable: {}", executable.display());
    println!("gsvd version: {daemon_version}");
    println!("gsv version: {}", build_info::BUILD_VERSION);
    println!(
        "service installed: {}",
        if installed { "yes" } else { "no" }
    );
    println!(
        "service definition: {}",
        if migration_required {
            "legacy (`gsv device run`); run `gsv daemon install` to migrate"
        } else if installed {
            "current"
        } else {
            "not installed"
        }
    );
    println!("logs: {}", logger::device_log_pattern().display());

    if migration_required {
        return Err("The installed gsvd service uses the legacy CLI launcher".into());
    }
    Ok(())
}

fn read_gsvd_version(executable: &Path) -> Result<String, DynError> {
    let output = Command::new(executable).arg("--version").output()?;
    if !output.status.success() {
        return Err(format!("Failed to read gsvd version ({})", output.status).into());
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if parse_gsvd_version(&version).is_none() {
        return Err(format!("gsvd returned an invalid version string: {version}").into());
    }
    Ok(version)
}

fn parse_gsvd_version(output: &str) -> Option<&str> {
    let mut fields = output.split_whitespace();
    (fields.next()? == "gsvd")
        .then(|| fields.next())
        .flatten()
        .filter(|_| fields.next().is_none())
}

pub fn show_device_service_logs(lines: usize, follow: bool) -> Result<(), DynError> {
    let log_path = logger::device_log_path();
    if !log_path.exists() {
        return Err(format!("Log file not found: {}", log_path.display()).into());
    }

    print_log_tail(&log_path, lines)?;

    if !follow {
        return Ok(());
    }

    follow_log_file(&log_path)
}

fn require_platform_service_manager() -> Result<Box<dyn DeviceServiceManager>, DynError> {
    platform_service_manager().ok_or_else(|| unsupported_message().into())
}

fn platform_service_manager() -> Option<Box<dyn DeviceServiceManager>> {
    #[cfg(target_os = "linux")]
    {
        Some(Box::new(SystemdUserServiceManager))
    }

    #[cfg(target_os = "macos")]
    {
        Some(Box::new(LaunchdUserServiceManager))
    }

    #[cfg(target_os = "windows")]
    {
        Some(Box::new(WindowsTaskServiceManager))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

fn unsupported_message() -> &'static str {
    "device daemon management is currently supported on Linux, macOS, and Windows only"
}

fn print_log_tail(path: &Path, lines: usize) -> Result<(), DynError> {
    let text = fs::read_to_string(path)?;
    let tail = last_lines(&text, lines.max(1));
    if !tail.is_empty() {
        print!("{tail}");
        std::io::stdout().flush()?;
    }
    Ok(())
}

fn follow_log_file(path: &Path) -> Result<(), DynError> {
    let mut offset = fs::metadata(path)?.len();

    loop {
        thread::sleep(LOG_POLL_INTERVAL);

        let len = match fs::metadata(path) {
            Ok(meta) => meta.len(),
            Err(_) => {
                offset = 0;
                continue;
            }
        };

        if len < offset {
            offset = 0;
        }

        if len == offset {
            continue;
        }

        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let chunk = String::from_utf8_lossy(&bytes);
        if !chunk.is_empty() {
            print!("{chunk}");
            std::io::stdout().flush()?;
        }
        offset = len;
    }
}

fn last_lines(text: &str, lines: usize) -> String {
    let all_lines: Vec<&str> = text.lines().collect();
    let start = all_lines.len().saturating_sub(lines);
    let mut tail = all_lines[start..].join("\n");
    if !tail.is_empty() && text.ends_with('\n') {
        tail.push('\n');
    }
    tail
}

fn run_command_capture(cmd: &mut Command, context: &str) -> Result<(), DynError> {
    let output = cmd.output()?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        return Err(format!("{} (exit status: {})", context, output.status).into());
    }

    Err(format!("{}: {}", context, detail).into())
}

fn run_command_passthrough(cmd: &mut Command, context: &str) -> Result<(), DynError> {
    let status = cmd.status()?;
    if status.success() {
        return Ok(());
    }

    Err(format!("{} (exit status: {})", context, status).into())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn resolve_login_shell() -> String {
    if let Ok(raw) = std::env::var("SHELL") {
        let candidate = raw.trim();
        if !candidate.is_empty() {
            let path = Path::new(candidate);
            if path.is_absolute() && is_runnable_file(path) {
                return candidate.to_string();
            }
        }
    }
    "/bin/sh".to_string()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn probe_path_from_login_shell() -> Option<OsString> {
    let shell = resolve_login_shell();
    let output = Command::new(shell).arg("-lc").arg("env").output().ok()?;

    if !output.status.success() {
        return None;
    }

    for line in output.stdout.split(|byte| *byte == b'\n') {
        if let Some(path_bytes) = line.strip_prefix(b"PATH=") {
            let path = String::from_utf8_lossy(path_bytes).to_string();
            return Some(OsString::from(path));
        }
    }

    None
}

fn select_service_path(
    probed_path: Option<OsString>,
    env_path: Option<OsString>,
) -> Option<String> {
    let normalize = |path: OsString| {
        let trimmed = path.to_string_lossy().trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    };

    probed_path
        .and_then(normalize)
        .or_else(|| env_path.and_then(normalize))
}

fn device_service_path() -> Option<String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        select_service_path(probe_path_from_login_shell(), std::env::var_os("PATH"))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        select_service_path(None, std::env::var_os("PATH"))
    }
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_escape_environment_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_path_environment_line(path: Option<&str>) -> String {
    path.map(|value| {
        format!(
            "Environment=\"PATH={}\"\n",
            systemd_escape_environment_value(value)
        )
    })
    .unwrap_or_default()
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_exec_start(spec: &DeviceServiceInstallSpec) -> String {
    let mut parts = vec![format!(
        "\"{}\"",
        spec.exe_path.display().to_string().replace('"', "\\\"")
    )];
    for arg in &spec.args {
        parts.push(format!("\"{}\"", arg.replace('"', "\\\"")));
    }
    parts.join(" ")
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_service_needs_migration(unit: &str, spec: &DeviceServiceInstallSpec) -> bool {
    let expected = format!("ExecStart={}", systemd_exec_start(spec));
    !unit.lines().any(|line| line == expected)
}

#[cfg(any(test, target_os = "macos"))]
fn launchd_path_environment_block(path: Option<&str>) -> String {
    path.map(|value| {
        format!(
            "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>{}</string>\n  </dict>\n",
            xml_escape(value)
        )
    })
    .unwrap_or_default()
}

#[cfg(any(test, target_os = "macos"))]
fn launchd_program_arguments_block(spec: &DeviceServiceInstallSpec) -> String {
    let mut lines = vec![format!(
        "    <string>{}</string>",
        xml_escape(&spec.exe_path.display().to_string())
    )];
    for arg in &spec.args {
        lines.push(format!("    <string>{}</string>", xml_escape(arg)));
    }
    lines.join("\n")
}

#[cfg(any(test, target_os = "macos"))]
fn launchd_plist_contents(
    label: &str,
    spec: &DeviceServiceInstallSpec,
    path_env_block: &str,
) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{}</string>\n  <key>ProgramArguments</key>\n  <array>\n{}\n  </array>\n{}  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n</dict>\n</plist>\n",
        label,
        launchd_program_arguments_block(spec),
        path_env_block,
    )
}

#[cfg(any(test, target_os = "macos"))]
fn launchd_service_needs_migration(plist: &str, spec: &DeviceServiceInstallSpec) -> bool {
    !plist.contains(&launchd_program_arguments_block(spec))
}

#[cfg(any(test, target_os = "windows"))]
fn windows_quote_argument(arg: &str) -> String {
    if arg.is_empty() || arg.chars().any(|ch| matches!(ch, ' ' | '\t' | '"')) {
        let mut quoted = String::from("\"");
        let mut backslashes = 0;
        for ch in arg.chars() {
            match ch {
                '\\' => backslashes += 1,
                '"' => {
                    quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                    quoted.push('"');
                    backslashes = 0;
                }
                _ => {
                    if backslashes > 0 {
                        quoted.push_str(&"\\".repeat(backslashes));
                        backslashes = 0;
                    }
                    quoted.push(ch);
                }
            }
        }
        if backslashes > 0 {
            quoted.push_str(&"\\".repeat(backslashes * 2));
        }
        quoted.push('"');
        return quoted;
    }

    arg.to_string()
}

#[cfg(any(test, target_os = "windows"))]
fn windows_arguments_string(args: &[String]) -> String {
    args.iter()
        .map(|arg| windows_quote_argument(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(any(test, target_os = "windows"))]
fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(any(test, target_os = "windows"))]
fn windows_task_registration_script(
    task_name: &str,
    user_id: &str,
    spec: &DeviceServiceInstallSpec,
) -> String {
    let task_name = powershell_single_quote(task_name);
    let user_id = powershell_single_quote(user_id);
    let description = powershell_single_quote(spec.description);
    let exe_path = powershell_single_quote(&spec.exe_path.display().to_string());
    let args = powershell_single_quote(&windows_arguments_string(&spec.args));

    format!(
        "$ErrorActionPreference = 'Stop'\n\
$ProgressPreference = 'SilentlyContinue'\n\
Import-Module ScheduledTasks -ErrorAction Stop\n\
$TaskName = {task_name}\n\
$UserId = {user_id}\n\
$Action = New-ScheduledTaskAction -Execute {exe_path} -Argument {args}\n\
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited\n\
$Settings = $null\n\
try {{\n\
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)\n\
}} catch {{\n\
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew\n\
}}\n\
try {{ $Settings.ExecutionTimeLimit = 'PT0S' }} catch {{}}\n\
function Register-GsvTask($Trigger) {{\n\
  $Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description {description}\n\
  Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null\n\
}}\n\
try {{\n\
  Register-GsvTask (New-ScheduledTaskTrigger -AtLogOn -User $UserId)\n\
}} catch {{\n\
  $ScopedTriggerError = $_.Exception.Message\n\
  try {{\n\
    Register-GsvTask (New-ScheduledTaskTrigger -AtLogOn)\n\
  }} catch {{\n\
    throw \"Could not register scheduled task '$TaskName' for '$UserId'. User-scoped logon trigger failed: $ScopedTriggerError. Generic logon trigger failed: $($_.Exception.Message)\"\n\
  }}\n\
}}\n"
    )
}

#[cfg(any(test, target_os = "windows"))]
fn windows_task_stop_if_running_script(task_name: &str) -> String {
    let task_name = powershell_single_quote(task_name);
    format!(
        "$ErrorActionPreference = 'Stop'\n\
$ProgressPreference = 'SilentlyContinue'\n\
Import-Module ScheduledTasks -ErrorAction Stop\n\
$TaskName = {task_name}\n\
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop\n\
$InitialState = [string]$Task.State\n\
if ($InitialState -eq 'Unknown') {{ throw \"Scheduled task '$TaskName' state is unknown\" }}\n\
if ($InitialState -eq 'Running' -or $InitialState -eq 'Queued') {{\n\
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop\n\
  $Stopped = $false\n\
  for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {{\n\
    $State = [string](Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop).State\n\
    if ($State -eq 'Ready' -or $State -eq 'Disabled') {{\n\
      $Stopped = $true\n\
      break\n\
    }}\n\
    Start-Sleep -Milliseconds 100\n\
  }}\n\
  if (-not $Stopped) {{ throw \"Scheduled task '$TaskName' did not stop\" }}\n\
}}\n"
    )
}

#[cfg(any(test, target_os = "windows"))]
fn encode_powershell_script(script: &str) -> String {
    let mut utf16 = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

#[cfg(target_os = "windows")]
fn run_windows_powershell_script(script: &str, context: &str) -> Result<(), DynError> {
    let encoded = encode_powershell_script(script);
    run_command_capture(
        Command::new("powershell.exe")
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-EncodedCommand")
            .arg(encoded),
        context,
    )
}

#[cfg(target_os = "linux")]
struct SystemdUserServiceManager;

#[cfg(target_os = "linux")]
impl DeviceServiceManager for SystemdUserServiceManager {
    fn is_installed(&self) -> Result<bool, DynError> {
        Ok(systemd_user_unit_path()?.exists())
    }

    fn install(&self, spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
        let unit_path = systemd_user_unit_path()?;
        if let Some(parent) = unit_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let path_env_line = systemd_path_environment_line(spec.path_env.as_deref());
        let unit = format!(
            "[Unit]\nDescription={}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={}\n{}Restart=always\nRestartSec=3\nKillSignal=SIGTERM\n\n[Install]\nWantedBy=default.target\n",
            spec.description,
            systemd_exec_start(spec),
            path_env_line,
        );
        fs::write(&unit_path, unit)?;

        run_command_capture(
            Command::new("systemctl").arg("--user").arg("daemon-reload"),
            "Failed to reload systemd user daemon",
        )?;
        run_command_capture(
            Command::new("systemctl")
                .arg("--user")
                .arg("enable")
                .arg("--now")
                .arg(DEVICE_SYSTEMD_UNIT_NAME),
            "Failed to enable/start gsvd service",
        )?;

        println!("Installed systemd unit: {}", unit_path.display());

        if linger_is_enabled() {
            println!("User linger is enabled - service will persist after logout.");
        } else {
            println!();
            println!("User linger is not enabled.");
            println!("Enabling linger (requires sudo - you may be prompted for password)...");
            match try_enable_linger() {
                Ok(()) => {
                    println!(
                        "✓ Enabled user linger - service will start at boot and persist after logout."
                    );
                }
                Err(err) => {
                    println!();
                    println!("⚠️  Could not enable linger: {}", err);
                    println!();
                    println!("Without linger, the device daemon will stop when you log out.");
                    println!("Run this once with sudo:");
                    println!("  sudo loginctl enable-linger {}", whoami::username());
                }
            }
        }

        println!("Logs: {}", logger::device_log_pattern().display());
        Ok(())
    }

    fn uninstall(&self) -> Result<(), DynError> {
        let _ = run_command_capture(
            Command::new("systemctl")
                .arg("--user")
                .arg("disable")
                .arg("--now")
                .arg(DEVICE_SYSTEMD_UNIT_NAME),
            "Failed to disable/stop gsvd service",
        );

        let unit_path = systemd_user_unit_path()?;
        if unit_path.exists() {
            fs::remove_file(&unit_path)?;
        }

        run_command_capture(
            Command::new("systemctl").arg("--user").arg("daemon-reload"),
            "Failed to reload systemd user daemon",
        )
    }

    fn start(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("systemctl")
                .arg("--user")
                .arg("start")
                .arg(DEVICE_SYSTEMD_UNIT_NAME),
            "Failed to start gsvd service",
        )
    }

    fn restart(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("systemctl")
                .arg("--user")
                .arg("restart")
                .arg(DEVICE_SYSTEMD_UNIT_NAME),
            "Failed to restart gsvd service",
        )
    }

    fn stop(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("systemctl")
                .arg("--user")
                .arg("stop")
                .arg(DEVICE_SYSTEMD_UNIT_NAME),
            "Failed to stop gsvd service",
        )
    }

    fn status(&self) -> Result<(), DynError> {
        run_command_passthrough(
            Command::new("systemctl")
                .arg("--user")
                .arg("status")
                .arg("--no-pager")
                .arg(DEVICE_SYSTEMD_UNIT_NAME),
            "Failed to read gsvd service status",
        )
    }

    fn needs_migration(&self, spec: &DeviceServiceInstallSpec) -> Result<bool, DynError> {
        let unit_path = systemd_user_unit_path()?;
        if !unit_path.exists() {
            return Ok(false);
        }
        let unit = fs::read_to_string(unit_path)?;
        Ok(systemd_service_needs_migration(&unit, spec))
    }
}

#[cfg(target_os = "linux")]
fn systemd_user_unit_path() -> Result<PathBuf, DynError> {
    let config_dir = dirs::config_dir().ok_or("Could not determine config directory")?;
    Ok(config_dir
        .join("systemd")
        .join("user")
        .join(DEVICE_SYSTEMD_UNIT_NAME))
}

#[cfg(target_os = "linux")]
fn linger_is_enabled() -> bool {
    std::path::Path::new("/var/lib/systemd/linger")
        .join(whoami::username())
        .exists()
}

#[cfg(target_os = "linux")]
fn try_enable_linger() -> Result<(), DynError> {
    let username = whoami::username();
    let output = Command::new("sudo")
        .arg("loginctl")
        .arg("enable-linger")
        .arg(&username)
        .output()?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("sudo loginctl enable-linger failed: {}", stderr.trim()).into())
    }
}

#[cfg(target_os = "macos")]
struct LaunchdUserServiceManager;

#[cfg(target_os = "macos")]
impl DeviceServiceManager for LaunchdUserServiceManager {
    fn is_installed(&self) -> Result<bool, DynError> {
        Ok(launchd_plist_path()?.exists())
    }

    fn install(&self, spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
        let plist_path = launchd_plist_path()?;
        if let Some(parent) = plist_path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::create_dir_all(host_config::device_log_dir())?;

        let path_env_block = launchd_path_environment_block(spec.path_env.as_deref());
        let plist = launchd_plist_contents(DEVICE_LAUNCHD_LABEL, spec, &path_env_block);
        fs::write(&plist_path, plist)?;

        let domain = launchd_domain()?;
        let _ = Command::new("launchctl")
            .arg("bootout")
            .arg(&domain)
            .arg(&plist_path)
            .status();

        run_command_capture(
            Command::new("launchctl")
                .arg("bootstrap")
                .arg(&domain)
                .arg(&plist_path),
            "Failed to bootstrap launchd service",
        )?;
        run_command_capture(
            Command::new("launchctl")
                .arg("kickstart")
                .arg("-k")
                .arg(launchd_target()?),
            "Failed to start launchd service",
        )?;

        println!("Installed launchd agent: {}", plist_path.display());
        println!("Logs: {}", logger::device_log_pattern().display());
        Ok(())
    }

    fn uninstall(&self) -> Result<(), DynError> {
        let _ = run_command_capture(
            Command::new("launchctl")
                .arg("bootout")
                .arg(launchd_target()?),
            "Failed to unload launchd service",
        );

        let plist_path = launchd_plist_path()?;
        if plist_path.exists() {
            fs::remove_file(&plist_path)?;
        }

        Ok(())
    }

    fn start(&self) -> Result<(), DynError> {
        if run_command_capture(
            Command::new("launchctl")
                .arg("kickstart")
                .arg("-k")
                .arg(launchd_target()?),
            "Failed to kickstart launchd service",
        )
        .is_ok()
        {
            return Ok(());
        }

        let plist_path = launchd_plist_path()?;
        if !plist_path.exists() {
            return Err(format!(
                "Service not installed. Run 'gsv daemon install' first ({})",
                plist_path.display()
            )
            .into());
        }

        run_command_capture(
            Command::new("launchctl")
                .arg("bootstrap")
                .arg(launchd_domain()?)
                .arg(&plist_path),
            "Failed to bootstrap launchd service",
        )?;
        run_command_capture(
            Command::new("launchctl")
                .arg("kickstart")
                .arg("-k")
                .arg(launchd_target()?),
            "Failed to start launchd service",
        )
    }

    fn restart(&self) -> Result<(), DynError> {
        self.start()
    }

    fn stop(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("launchctl")
                .arg("bootout")
                .arg(launchd_target()?),
            "Failed to stop launchd service",
        )
    }

    fn status(&self) -> Result<(), DynError> {
        run_command_passthrough(
            Command::new("launchctl")
                .arg("print")
                .arg(launchd_target()?),
            "Failed to read launchd service status",
        )
    }

    fn needs_migration(&self, spec: &DeviceServiceInstallSpec) -> Result<bool, DynError> {
        let plist_path = launchd_plist_path()?;
        if !plist_path.exists() {
            return Ok(false);
        }
        let plist = fs::read_to_string(plist_path)?;
        Ok(launchd_service_needs_migration(&plist, spec))
    }
}

#[cfg(target_os = "macos")]
fn launchd_plist_path() -> Result<PathBuf, DynError> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", DEVICE_LAUNCHD_LABEL)))
}

#[cfg(target_os = "macos")]
fn launchd_domain() -> Result<String, DynError> {
    let output = Command::new("id").arg("-u").output()?;
    if !output.status.success() {
        return Err("Failed to resolve current user id".into());
    }
    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() {
        return Err("Failed to resolve current user id".into());
    }
    Ok(format!("gui/{}", uid))
}

#[cfg(target_os = "macos")]
fn launchd_target() -> Result<String, DynError> {
    Ok(format!("{}/{}", launchd_domain()?, DEVICE_LAUNCHD_LABEL))
}

#[cfg(target_os = "windows")]
struct WindowsTaskServiceManager;

#[cfg(target_os = "windows")]
impl DeviceServiceManager for WindowsTaskServiceManager {
    fn is_installed(&self) -> Result<bool, DynError> {
        Ok(Command::new("schtasks")
            .arg("/query")
            .arg("/tn")
            .arg(DEVICE_WINDOWS_TASK_NAME)
            .status()?
            .success())
    }

    fn install(&self, spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
        let user_id = current_windows_user_id();
        let script = windows_task_registration_script(DEVICE_WINDOWS_TASK_NAME, &user_id, spec);
        run_windows_powershell_script(&script, "Failed to register Windows scheduled task")?;

        run_command_capture(
            Command::new("schtasks")
                .arg("/run")
                .arg("/tn")
                .arg(DEVICE_WINDOWS_TASK_NAME),
            "Failed to start Windows scheduled task",
        )?;

        println!(
            "Installed Windows scheduled task: {}",
            DEVICE_WINDOWS_TASK_NAME
        );
        println!("Logs: {}", logger::device_log_pattern().display());
        Ok(())
    }

    fn uninstall(&self) -> Result<(), DynError> {
        let script = windows_task_stop_if_running_script(DEVICE_WINDOWS_TASK_NAME);
        run_windows_powershell_script(&script, "Failed to stop Windows scheduled task")?;
        run_command_capture(
            Command::new("schtasks")
                .arg("/delete")
                .arg("/tn")
                .arg(DEVICE_WINDOWS_TASK_NAME)
                .arg("/f"),
            "Failed to delete Windows scheduled task",
        )
    }

    fn start(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("schtasks")
                .arg("/run")
                .arg("/tn")
                .arg(DEVICE_WINDOWS_TASK_NAME),
            "Failed to start Windows scheduled task",
        )
    }

    fn restart(&self) -> Result<(), DynError> {
        let script = windows_task_stop_if_running_script(DEVICE_WINDOWS_TASK_NAME);
        run_windows_powershell_script(&script, "Failed to stop Windows scheduled task")?;
        self.start()
    }

    fn stop(&self) -> Result<(), DynError> {
        let script = windows_task_stop_if_running_script(DEVICE_WINDOWS_TASK_NAME);
        run_windows_powershell_script(&script, "Failed to stop Windows scheduled task")
    }

    fn status(&self) -> Result<(), DynError> {
        run_command_passthrough(
            Command::new("schtasks")
                .arg("/query")
                .arg("/tn")
                .arg(DEVICE_WINDOWS_TASK_NAME)
                .arg("/fo")
                .arg("LIST")
                .arg("/v"),
            "Failed to read Windows scheduled task status",
        )
    }

    fn needs_migration(&self, spec: &DeviceServiceInstallSpec) -> Result<bool, DynError> {
        let output = Command::new("schtasks")
            .arg("/query")
            .arg("/tn")
            .arg(DEVICE_WINDOWS_TASK_NAME)
            .arg("/xml")
            .output()?;
        if !output.status.success() {
            return Ok(false);
        }
        let xml = String::from_utf8_lossy(&output.stdout);
        let executable = xml_escape(&spec.exe_path.display().to_string());
        let arguments = xml_escape(&windows_arguments_string(&spec.args));
        Ok(!xml.contains(&format!("<Command>{executable}</Command>"))
            || !xml.contains(&format!("<Arguments>{arguments}</Arguments>")))
    }
}

#[cfg(target_os = "windows")]
fn current_windows_user_id() -> String {
    if let Ok(output) = Command::new("whoami").output() {
        if output.status.success() {
            let user_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !user_id.is_empty() {
                return user_id;
            }
        }
    }

    let username = std::env::var("USERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(whoami::username);
    let domain = std::env::var("USERDOMAIN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    match domain {
        Some(domain) => format!(r"{}\{}", domain, username),
        None => username,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct RecordingServiceManager {
        calls: RefCell<Vec<&'static str>>,
    }

    impl RecordingServiceManager {
        fn legacy() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl DeviceServiceManager for RecordingServiceManager {
        fn is_installed(&self) -> Result<bool, DynError> {
            self.calls.borrow_mut().push("is_installed");
            Ok(true)
        }

        fn install(&self, _spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
            self.calls.borrow_mut().push("install");
            Ok(())
        }

        fn uninstall(&self) -> Result<(), DynError> {
            Ok(())
        }

        fn start(&self) -> Result<(), DynError> {
            Ok(())
        }

        fn restart(&self) -> Result<(), DynError> {
            self.calls.borrow_mut().push("restart");
            Ok(())
        }

        fn stop(&self) -> Result<(), DynError> {
            Ok(())
        }

        fn status(&self) -> Result<(), DynError> {
            Ok(())
        }

        fn needs_migration(&self, _spec: &DeviceServiceInstallSpec) -> Result<bool, DynError> {
            self.calls.borrow_mut().push("needs_migration");
            Ok(true)
        }
    }

    fn test_spec() -> DeviceServiceInstallSpec {
        DeviceServiceInstallSpec {
            description: "gsvd",
            exe_path: PathBuf::from("/Applications/GSV/gsvd"),
            args: vec!["--foreground".to_string()],
            path_env: Some("/opt/bin:/usr/bin".to_string()),
        }
    }

    #[test]
    fn test_select_service_path_prefers_probed_path() {
        let selected = select_service_path(
            Some(OsString::from("/probe/bin:/usr/bin")),
            Some(OsString::from("/env/bin:/usr/bin")),
        );
        assert_eq!(selected.as_deref(), Some("/probe/bin:/usr/bin"));
    }

    #[test]
    fn test_select_service_path_falls_back_to_env_path() {
        let selected = select_service_path(None, Some(OsString::from("/env/bin:/usr/bin")));
        assert_eq!(selected.as_deref(), Some("/env/bin:/usr/bin"));
    }

    #[test]
    fn test_select_service_path_falls_back_when_probed_path_is_blank() {
        let selected = select_service_path(
            Some(OsString::from("   ")),
            Some(OsString::from("/env/bin:/usr/bin")),
        );
        assert_eq!(selected.as_deref(), Some("/env/bin:/usr/bin"));
    }

    #[test]
    fn test_select_service_path_rejects_empty_path() {
        let selected = select_service_path(Some(OsString::from("   ")), None);
        assert!(selected.is_none());
    }

    #[test]
    fn test_systemd_path_environment_line_escapes_special_chars() {
        let line = systemd_path_environment_line(Some(r#"/opt/bin:"quoted"\test%path"#));
        assert_eq!(
            line,
            "Environment=\"PATH=/opt/bin:\\\"quoted\\\"\\\\test%%path\"\n"
        );
    }

    #[test]
    fn test_launchd_path_environment_block_escapes_xml() {
        let block = launchd_path_environment_block(Some("/opt/bin:&\"'<>"));
        assert!(block.contains("<key>EnvironmentVariables</key>"));
        assert!(block.contains("<string>/opt/bin:&amp;&quot;&apos;&lt;&gt;</string>"));
    }

    #[test]
    fn test_launchd_plist_contents_uses_gsvd_entrypoint() {
        let plist = launchd_plist_contents(DEVICE_LAUNCHD_LABEL, &test_spec(), "");
        assert!(plist.contains("<string>/Applications/GSV/gsvd</string>"));
        assert!(plist.contains("<string>--foreground</string>"));
        assert!(!plist.contains("<string>device</string>"));
        assert!(!plist.contains("<string>run</string>"));
    }

    #[test]
    fn installing_a_legacy_definition_restarts_its_running_process() {
        let manager = RecordingServiceManager::legacy();

        let migrated = install_device_service_with_manager(&manager, &test_spec())
            .expect("legacy service migration");

        assert!(migrated);
        assert_eq!(
            manager.calls.into_inner(),
            vec!["is_installed", "needs_migration", "install", "restart"]
        );
    }

    #[test]
    fn detects_legacy_systemd_and_launchd_entrypoints() {
        let current = test_spec();
        let legacy = DeviceServiceInstallSpec {
            description: "gsvd",
            exe_path: PathBuf::from("/Applications/GSV/gsv"),
            args: vec!["device".to_string(), "run".to_string()],
            path_env: None,
        };
        let current_unit = format!("ExecStart={}\n", systemd_exec_start(&current));
        let legacy_unit = format!("ExecStart={}\n", systemd_exec_start(&legacy));
        assert!(!systemd_service_needs_migration(&current_unit, &current));
        assert!(systemd_service_needs_migration(&legacy_unit, &current));

        let current_plist = launchd_plist_contents("gsvd", &current, "");
        let legacy_plist = launchd_plist_contents("gsvd", &legacy, "");
        assert!(!launchd_service_needs_migration(&current_plist, &current));
        assert!(launchd_service_needs_migration(&legacy_plist, &current));
    }

    #[test]
    fn test_windows_quote_argument_quotes_spaces_and_quotes() {
        assert_eq!(windows_quote_argument("device"), "device");
        assert_eq!(
            windows_quote_argument(r#"say "hello" now"#),
            r#""say \"hello\" now""#
        );
    }

    #[test]
    fn test_encode_powershell_script_uses_utf16le_base64() {
        assert_eq!(encode_powershell_script("A"), "QQA=");
    }

    #[test]
    fn test_windows_task_registration_script_sets_infinite_execution_time() {
        let mut spec = test_spec();
        spec.exe_path = PathBuf::from(r"C:\Program Files\GSV\gsvd.exe");
        let script = windows_task_registration_script("gsvd", r"ACME\hank", &spec);

        assert!(script.contains("$UserId = 'ACME\\hank'"));
        assert!(script.contains("$ProgressPreference = 'SilentlyContinue'"));
        assert!(
            script.contains("Register-GsvTask (New-ScheduledTaskTrigger -AtLogOn -User $UserId)")
        );
        assert!(script.contains("Register-GsvTask (New-ScheduledTaskTrigger -AtLogOn)"));
        assert!(script.contains(
            "$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited"
        ));
        assert!(script.contains(
            "$Action = New-ScheduledTaskAction -Execute 'C:\\Program Files\\GSV\\gsvd.exe' -Argument '--foreground'"
        ));
        assert!(!script.contains("AllowStartOnDemand"));
        assert!(script.contains("-ExecutionTimeLimit ([TimeSpan]::Zero)"));
        assert!(script.contains("$Settings.ExecutionTimeLimit = 'PT0S'"));
        let fallback_settings = script
            .find("New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew\n")
            .expect("fallback settings constructor");
        let explicit_infinite_limit = script
            .find("$Settings.ExecutionTimeLimit = 'PT0S'")
            .expect("explicit infinite execution time assignment");
        assert!(explicit_infinite_limit > fallback_settings);
        assert!(!script.contains("$Settings.Enabled"));
        assert!(!script.contains("$Settings.Hidden"));
        assert!(script.contains(
            "Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null"
        ));
        assert!(script.contains(
            "User-scoped logon trigger failed: $ScopedTriggerError. Generic logon trigger failed:"
        ));
    }

    #[test]
    fn windows_stop_script_ignores_only_an_explicit_non_running_state() {
        let script = windows_task_stop_if_running_script("gsvd");

        assert!(script.contains("$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop"));
        assert!(script.contains("$InitialState = [string]$Task.State"));
        assert!(script.contains("if ($InitialState -eq 'Unknown')"));
        assert!(script.contains("$InitialState -eq 'Running' -or $InitialState -eq 'Queued'"));
        assert!(script.contains("Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop"));
        assert!(script.contains("$State -eq 'Ready' -or $State -eq 'Disabled'"));
        assert!(script.contains("Scheduled task '$TaskName' did not stop"));
        assert!(!script.contains("SilentlyContinue\n  Stop-ScheduledTask"));
    }

    #[test]
    fn parses_only_the_gsvd_version_shape() {
        assert_eq!(parse_gsvd_version("gsvd 0.4.1"), Some("0.4.1"));
        assert_eq!(parse_gsvd_version("gsv 0.4.1"), None);
        assert_eq!(parse_gsvd_version("gsvd 0.4.1 extra"), None);
        assert_eq!(parse_gsvd_version(""), None);
    }
}
