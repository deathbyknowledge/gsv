use crate::logger;
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

const NODE_SYSTEMD_UNIT_NAME: &str = "gsvd.service";
#[cfg(any(test, target_os = "macos"))]
const NODE_LAUNCHD_LABEL: &str = "gsvd";
#[cfg(target_os = "windows")]
const NODE_WINDOWS_TASK_NAME: &str = "gsvd";
const LOG_POLL_INTERVAL: Duration = Duration::from_millis(250);

struct DeviceServiceInstallSpec {
    description: &'static str,
    exe_path: PathBuf,
    args: Vec<String>,
    path_env: Option<String>,
    log_path: PathBuf,
}

impl DeviceServiceInstallSpec {
    fn current() -> Result<Self, DynError> {
        let exe_path = std::env::current_exe()?;
        let exe_path = exe_path.canonicalize().unwrap_or(exe_path);
        Ok(Self {
            description: "gsvd",
            exe_path,
            args: vec!["device".to_string(), "run".to_string()],
            path_env: node_service_path(),
            log_path: logger::node_log_path()?,
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
}

pub fn node_service_management_supported() -> bool {
    platform_service_manager().is_some()
}

pub fn node_service_is_installed() -> Result<bool, DynError> {
    require_platform_service_manager()?.is_installed()
}

pub fn install_node_service() -> Result<(), DynError> {
    let spec = DeviceServiceInstallSpec::current()?;
    require_platform_service_manager()?.install(&spec)
}

pub fn uninstall_node_service() -> Result<(), DynError> {
    require_platform_service_manager()?.uninstall()
}

pub fn start_node_service() -> Result<(), DynError> {
    require_platform_service_manager()?.start()
}

pub fn restart_node_service() -> Result<(), DynError> {
    require_platform_service_manager()?.restart()
}

pub fn stop_node_service() -> Result<(), DynError> {
    require_platform_service_manager()?.stop()
}

pub fn status_node_service() -> Result<(), DynError> {
    require_platform_service_manager()?.status()
}

pub fn show_node_service_logs(lines: usize, follow: bool) -> Result<(), DynError> {
    let log_path = logger::node_log_path()?;
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

#[allow(unreachable_code)]
fn platform_service_manager() -> Option<Box<dyn DeviceServiceManager>> {
    #[cfg(target_os = "linux")]
    {
        return Some(Box::new(SystemdUserServiceManager));
    }

    #[cfg(target_os = "macos")]
    {
        return Some(Box::new(LaunchdUserServiceManager));
    }

    #[cfg(target_os = "windows")]
    {
        return Some(Box::new(WindowsTaskServiceManager));
    }

    None
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
fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(path)
            .map(|meta| (meta.permissions().mode() & 0o111) != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
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

fn node_service_path() -> Option<String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        return select_service_path(probe_path_from_login_shell(), std::env::var_os("PATH"));
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
Import-Module ScheduledTasks -ErrorAction Stop\n\
$action = New-ScheduledTaskAction -Execute {exe_path} -Argument {args}\n\
$trigger = New-ScheduledTaskTrigger -AtLogOn -User {user_id}\n\
	$principal = New-ScheduledTaskPrincipal -UserId {user_id} -LogonType Interactive -RunLevel Limited\n\
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew\n\
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description {description}\n\
$task.Settings.AllowStartOnDemand = $true\n\
$task.Settings.ExecutionTimeLimit = 'PT0S'\n\
$task.Settings.Enabled = $true\n\
$task.Settings.Hidden = $false\n\
Register-ScheduledTask -TaskName {task_name} -InputObject $task -Force | Out-Null\n"
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
                .arg(NODE_SYSTEMD_UNIT_NAME),
            "Failed to enable/start node service",
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

        println!("Logs: {}", spec.log_path.display());
        Ok(())
    }

    fn uninstall(&self) -> Result<(), DynError> {
        let _ = run_command_capture(
            Command::new("systemctl")
                .arg("--user")
                .arg("disable")
                .arg("--now")
                .arg(NODE_SYSTEMD_UNIT_NAME),
            "Failed to disable/stop node service",
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
                .arg(NODE_SYSTEMD_UNIT_NAME),
            "Failed to start node service",
        )
    }

    fn restart(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("systemctl")
                .arg("--user")
                .arg("restart")
                .arg(NODE_SYSTEMD_UNIT_NAME),
            "Failed to restart node service",
        )
    }

    fn stop(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("systemctl")
                .arg("--user")
                .arg("stop")
                .arg(NODE_SYSTEMD_UNIT_NAME),
            "Failed to stop node service",
        )
    }

    fn status(&self) -> Result<(), DynError> {
        run_command_passthrough(
            Command::new("systemctl")
                .arg("--user")
                .arg("status")
                .arg("--no-pager")
                .arg(NODE_SYSTEMD_UNIT_NAME),
            "Failed to read node service status",
        )
    }
}

#[cfg(target_os = "linux")]
fn systemd_user_unit_path() -> Result<PathBuf, DynError> {
    let config_dir = dirs::config_dir().ok_or("Could not determine config directory")?;
    Ok(config_dir
        .join("systemd")
        .join("user")
        .join(NODE_SYSTEMD_UNIT_NAME))
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

        if let Some(parent) = spec.log_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let path_env_block = launchd_path_environment_block(spec.path_env.as_deref());
        let plist = launchd_plist_contents(NODE_LAUNCHD_LABEL, spec, &path_env_block);
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
        println!("Logs: {}", spec.log_path.display());
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
                "Service not installed. Run 'gsv device install' first ({})",
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
}

#[cfg(target_os = "macos")]
fn launchd_plist_path() -> Result<PathBuf, DynError> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", NODE_LAUNCHD_LABEL)))
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
    Ok(format!("{}/{}", launchd_domain()?, NODE_LAUNCHD_LABEL))
}

#[cfg(target_os = "windows")]
struct WindowsTaskServiceManager;

#[cfg(target_os = "windows")]
impl DeviceServiceManager for WindowsTaskServiceManager {
    fn is_installed(&self) -> Result<bool, DynError> {
        Ok(Command::new("schtasks")
            .arg("/query")
            .arg("/tn")
            .arg(NODE_WINDOWS_TASK_NAME)
            .status()?
            .success())
    }

    fn install(&self, spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
        let user_id = current_windows_user_id();
        let script = windows_task_registration_script(NODE_WINDOWS_TASK_NAME, &user_id, spec);
        run_windows_powershell_script(&script, "Failed to register Windows scheduled task")?;

        run_command_capture(
            Command::new("schtasks")
                .arg("/run")
                .arg("/tn")
                .arg(NODE_WINDOWS_TASK_NAME),
            "Failed to start Windows scheduled task",
        )?;

        println!(
            "Installed Windows scheduled task: {}",
            NODE_WINDOWS_TASK_NAME
        );
        println!("Logs: {}", spec.log_path.display());
        Ok(())
    }

    fn uninstall(&self) -> Result<(), DynError> {
        let _ = run_command_capture(
            Command::new("schtasks")
                .arg("/end")
                .arg("/tn")
                .arg(NODE_WINDOWS_TASK_NAME),
            "Failed to stop Windows scheduled task",
        );
        run_command_capture(
            Command::new("schtasks")
                .arg("/delete")
                .arg("/tn")
                .arg(NODE_WINDOWS_TASK_NAME)
                .arg("/f"),
            "Failed to delete Windows scheduled task",
        )
    }

    fn start(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("schtasks")
                .arg("/run")
                .arg("/tn")
                .arg(NODE_WINDOWS_TASK_NAME),
            "Failed to start Windows scheduled task",
        )
    }

    fn restart(&self) -> Result<(), DynError> {
        let _ = run_command_capture(
            Command::new("schtasks")
                .arg("/end")
                .arg("/tn")
                .arg(NODE_WINDOWS_TASK_NAME),
            "Failed to stop Windows scheduled task",
        );
        self.start()
    }

    fn stop(&self) -> Result<(), DynError> {
        run_command_capture(
            Command::new("schtasks")
                .arg("/end")
                .arg("/tn")
                .arg(NODE_WINDOWS_TASK_NAME),
            "Failed to stop Windows scheduled task",
        )
    }

    fn status(&self) -> Result<(), DynError> {
        run_command_passthrough(
            Command::new("schtasks")
                .arg("/query")
                .arg("/tn")
                .arg(NODE_WINDOWS_TASK_NAME)
                .arg("/fo")
                .arg("LIST")
                .arg("/v"),
            "Failed to read Windows scheduled task status",
        )
    }
}

#[cfg(target_os = "windows")]
fn current_windows_user_id() -> String {
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

    fn test_spec() -> DeviceServiceInstallSpec {
        DeviceServiceInstallSpec {
            description: "gsvd",
            exe_path: PathBuf::from("/Applications/GSV/gsv"),
            args: vec!["device".to_string(), "run".to_string()],
            path_env: Some("/opt/bin:/usr/bin".to_string()),
            log_path: PathBuf::from("/tmp/node.log"),
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
    fn test_launchd_plist_contents_uses_device_run_entrypoint() {
        let plist = launchd_plist_contents(NODE_LAUNCHD_LABEL, &test_spec(), "");
        assert!(plist.contains("<string>device</string>"));
        assert!(plist.contains("<string>run</string>"));
        assert!(!plist.contains("<string>node</string>"));
        assert!(!plist.contains("<string>--foreground</string>"));
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
        spec.exe_path = PathBuf::from(r"C:\Program Files\GSV\gsv.exe");
        let script = windows_task_registration_script("gsvd", r"ACME\hank", &spec);

        assert!(script.contains("$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'ACME\\hank'"));
        assert!(script.contains(
            "$principal = New-ScheduledTaskPrincipal -UserId 'ACME\\hank' -LogonType Interactive -RunLevel Limited"
        ));
        assert!(script.contains(
            "$action = New-ScheduledTaskAction -Execute 'C:\\Program Files\\GSV\\gsv.exe' -Argument 'device run'"
        ));
        assert!(script.contains("$task.Settings.ExecutionTimeLimit = 'PT0S'"));
        assert!(script.contains(
            "Register-ScheduledTask -TaskName 'gsvd' -InputObject $task -Force | Out-Null"
        ));
    }
}
