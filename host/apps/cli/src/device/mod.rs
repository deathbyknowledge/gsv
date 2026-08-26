use std::io;
use std::path::PathBuf;
use std::process::Command;

use daemon_protocol::{ClientOptions, DaemonControlClient, DaemonControlEndpoint, Diagnostics};
use gsv::config::CliConfig;
use gsv::device_service;
use gsv::kernel_client::{cli_peer_identity, BinaryBodyLimits, GatewayAuth, KernelClient};
use gsv::protocol::Frame;
use host_config::ConfigFile;
use serde_json::json;

use crate::cli::DaemonServiceAction;

pub(crate) fn resolve_device_id(cli_device_id: Option<String>, cfg: &CliConfig) -> String {
    cli_device_id
        .or_else(|| cfg.default_device_id())
        .unwrap_or_else(|| {
            let hostname = hostname::get()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string());
            format!("device-{hostname}")
        })
}

pub(crate) fn resolve_device_workspace(cli_workspace: Option<PathBuf>, cfg: &CliConfig) -> PathBuf {
    cli_workspace
        .or_else(|| cfg.default_device_workspace())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn persist_device_defaults(
    cfg: &CliConfig,
    device_id: Option<String>,
    workspace: Option<PathBuf>,
) -> Result<(String, PathBuf, bool), Box<dyn std::error::Error>> {
    let device_id = resolve_device_id(device_id, cfg);
    let workspace = resolve_device_workspace(workspace, cfg);
    let workspace = workspace.canonicalize().unwrap_or(workspace);

    let config_path = CliConfig::config_path().ok_or("Could not determine config directory")?;
    let changed = ConfigFile::<CliConfig>::new(config_path).update(|local_cfg| {
        let mut changed = false;
        if local_cfg.device.id.as_deref() != Some(device_id.as_str()) {
            local_cfg.device.id = Some(device_id.clone());
            changed = true;
        }
        if local_cfg.device.workspace.as_ref() != Some(&workspace) {
            local_cfg.device.workspace = Some(workspace.clone());
            changed = true;
        }
        Ok(changed)
    })?;

    Ok((device_id, workspace, changed))
}

fn persist_gateway_overrides(
    gateway_url_override: Option<&str>,
    gateway_username_override: Option<&str>,
    gateway_token_override: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    if gateway_url_override.is_none()
        && gateway_username_override.is_none()
        && gateway_token_override.is_none()
    {
        return Ok(false);
    }

    let config_path = CliConfig::config_path().ok_or("Could not determine config directory")?;
    let changed = ConfigFile::<CliConfig>::new(config_path).update(|local_cfg| {
        let mut changed = false;
        if let Some(url) = gateway_url_override {
            if local_cfg.gateway.url.as_deref() != Some(url) {
                local_cfg.gateway.url = Some(url.to_string());
                changed = true;
            }
        }
        if let Some(username) = gateway_username_override {
            if local_cfg.gateway.username.as_deref() != Some(username) {
                local_cfg.gateway.username = Some(username.to_string());
                changed = true;
            }
        }
        if let Some(token) = gateway_token_override {
            if local_cfg.device.token.as_deref() != Some(token) {
                local_cfg.device.token = Some(token.to_string());
                changed = true;
            }
        }
        Ok(changed)
    })?;

    Ok(changed)
}

/// Compatibility entry point for `gsv device run`.
///
/// The CLI transfers process ownership to the sibling daemon; it never links or
/// starts the driver runtime in its own Tokio process.
pub(crate) fn run_device_daemon(
    url: &str,
    auth: GatewayAuth,
    device_id: String,
    workspace: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let executable = device_service::resolve_gsvd_executable()?;
    let mut command = build_gsvd_command(executable, url, auth, device_id, workspace);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec().into())
    }

    #[cfg(not(unix))]
    {
        let status = command.status()?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("gsvd exited with {status}").into())
        }
    }
}

fn build_gsvd_command(
    executable: PathBuf,
    url: &str,
    auth: GatewayAuth,
    device_id: String,
    workspace: PathBuf,
) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("--foreground")
        .arg("--id")
        .arg(device_id)
        .arg("--workspace")
        .arg(workspace)
        .env("GSV_URL", url);
    if let Some(username) = auth.username {
        command.env("GSV_USER", username);
    }
    if let Some(token) = auth.token {
        command.env("GSV_TOKEN", token);
    }
    command
}

pub(crate) fn run_daemon_service(
    action: DaemonServiceAction,
    cfg: &CliConfig,
    gateway_url_override: Option<&str>,
    gateway_username_override: Option<&str>,
    gateway_token_override: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        DaemonServiceAction::Install { id, workspace } => {
            let gateway_changed = persist_gateway_overrides(
                gateway_url_override,
                gateway_username_override,
                gateway_token_override,
            )?;
            let (device_id, workspace, defaults_changed) =
                persist_device_defaults(cfg, id, workspace)?;
            let was_legacy = device_service::device_service_needs_migration()?;
            device_service::install_device_service()?;
            if (gateway_changed || defaults_changed) && !was_legacy {
                device_service::restart_device_service()?;
            }

            println!("gsvd installed and started.");
            if was_legacy {
                println!("Migrated the service from `gsv device run` to the `gsvd` executable.");
            }
            if gateway_changed {
                println!("Saved gateway connection overrides to local config.");
            }
            println!(
                "Saved defaults: device.id={}, device.workspace={}",
                device_id,
                workspace.display()
            );
            println!("\nCheck status: gsv daemon status");
            println!("View logs: gsv daemon logs --follow");
        }
        DaemonServiceAction::Uninstall => {
            device_service::uninstall_device_service()?;
            println!("gsvd uninstalled.");
        }
        DaemonServiceAction::Start => {
            let gateway_changed = persist_gateway_overrides(
                gateway_url_override,
                gateway_username_override,
                gateway_token_override,
            )?;
            if device_service::device_service_needs_migration()? {
                device_service::install_device_service()?;
                println!("Migrated the service to the `gsvd` executable.");
            } else if gateway_changed {
                device_service::restart_device_service()?;
            } else {
                device_service::start_device_service()?;
            }
            if gateway_changed {
                println!("Saved gateway connection overrides to local config.");
            }
            println!("gsvd started.");
        }
        DaemonServiceAction::Restart => {
            let gateway_changed = persist_gateway_overrides(
                gateway_url_override,
                gateway_username_override,
                gateway_token_override,
            )?;
            if device_service::device_service_needs_migration()? {
                device_service::install_device_service()?;
                println!("Migrated the service to the `gsvd` executable.");
            } else {
                device_service::restart_device_service()?;
            }
            if gateway_changed {
                println!("Saved gateway connection overrides to local config.");
            }
            println!("gsvd restarted.");
        }
        DaemonServiceAction::Stop => {
            device_service::stop_device_service()?;
            println!("gsvd stopped.");
        }
        DaemonServiceAction::Status => device_service::status_device_service()?,
        DaemonServiceAction::Doctor => device_service::doctor_device_service()?,
        DaemonServiceAction::Logs { lines, follow } => {
            device_service::show_device_service_logs(lines, follow)?;
        }
    }

    Ok(())
}

fn daemon_control_client() -> Result<DaemonControlClient, Box<dyn std::error::Error>> {
    Ok(DaemonControlClient::new(
        DaemonControlEndpoint::current_user()?,
        ClientOptions::default(),
    ))
}

pub(crate) async fn show_daemon_live_status() -> Result<(), Box<dyn std::error::Error>> {
    let client = daemon_control_client()?;
    let status = match client.status().await {
        Ok(status) => status,
        Err(error) => {
            println!("gsvd runtime: unavailable ({error})");
            return Ok(());
        }
    };
    println!("gsvd runtime:");
    println!("  version: {}", status.version);
    println!("  pid: {}", status.process_id);
    println!("  machine: {}", status.machine_id);
    println!("  phase: {:?}", status.phase);
    println!(
        "  connected: {}",
        if status.connected { "yes" } else { "no" }
    );
    println!("  uptime: {}s", status.uptime_seconds);
    println!("  reconnect attempt: {}", status.reconnect_attempt);
    Ok(())
}

pub(crate) async fn reload_daemon() -> Result<(), Box<dyn std::error::Error>> {
    daemon_control_client()?.reload().await?;
    println!("gsvd accepted the configuration reload.");
    Ok(())
}

pub(crate) async fn reconnect_daemon() -> Result<(), Box<dyn std::error::Error>> {
    daemon_control_client()?.reconnect().await?;
    println!("gsvd is reconnecting.");
    Ok(())
}

pub(crate) async fn show_daemon_diagnostics(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let diagnostics = daemon_control_client()?.diagnostics().await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&diagnostics)?);
    } else {
        print_diagnostics(&diagnostics);
    }
    Ok(())
}

fn print_diagnostics(diagnostics: &Diagnostics) {
    let status = &diagnostics.status;
    println!(
        "gsvd {} (pid {}) · {:?} · machine {}",
        status.version, status.process_id, status.phase, status.machine_id
    );
    if diagnostics.notices.is_empty() {
        println!("No diagnostic notices.");
        return;
    }
    for notice in &diagnostics.notices {
        println!("- {:?} {}: {}", notice.level, notice.code, notice.message);
    }
}

pub(crate) async fn run_shell(
    url: &str,
    auth: GatewayAuth,
) -> Result<(), Box<dyn std::error::Error>> {
    let username = auth.username.clone();
    let client = KernelClient::connect_with_peer(
        url,
        cli_peer_identity(),
        Vec::new(),
        auth,
        BinaryBodyLimits::default(),
        |frame| {
            if let Frame::Sig(signal) = frame {
                eprintln!("[signal] {}: {:?}", signal.signal, signal.payload);
            }
        },
    )
    .await?;

    println!(
        "Connected to GSV OS as {}",
        username.unwrap_or_else(|| "setup".to_string())
    );
    println!("Type commands to execute, or :quit to exit\n");
    let stdin = io::stdin();
    loop {
        eprint!("gsv$ ");
        {
            use std::io::Write;
            let _ = std::io::stderr().flush();
        }

        let mut line = String::new();
        if stdin.read_line(&mut line)? == 0 {
            break;
        }
        let input = line.trim();
        if input.is_empty() {
            continue;
        }
        if matches!(input, ":quit" | ":exit" | ":q") {
            break;
        }

        let response = client
            .connection()
            .request("shell.exec", Some(json!({ "input": input })))
            .await?;
        if response.ok {
            if let Some(data) = &response.data {
                if let Some(stdout) = data.get("stdout").and_then(|value| value.as_str()) {
                    print!("{stdout}");
                }
                if let Some(stderr) = data.get("stderr").and_then(|value| value.as_str()) {
                    eprint!("{stderr}");
                }
                if let Some(exit_code) = data.get("exitCode").and_then(|value| value.as_i64()) {
                    if exit_code != 0 {
                        eprintln!("[exit {exit_code}]");
                    }
                }
            }
        } else if let Some(error) = response.error {
            eprintln!("error [{}]: {}", error.code, error.message);
        }
    }
    println!("bye");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatibility_launcher_keeps_credentials_out_of_argv() {
        let command = build_gsvd_command(
            PathBuf::from("/opt/gsv/gsvd"),
            "wss://gateway.example/ws",
            GatewayAuth {
                username: Some("alice".to_string()),
                password: None,
                token: Some("driver-secret".to_string()),
            },
            "laptop".to_string(),
            PathBuf::from("/workspace"),
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(args[0], "--foreground");
        assert!(args.contains(&"laptop".to_string()));
        assert!(!args.iter().any(|arg| arg.contains("gateway.example")));
        assert!(!args.iter().any(|arg| arg.contains("driver-secret")));
        assert!(command.get_envs().any(|(name, value)| {
            name == "GSV_URL" && value.is_some_and(|value| value == "wss://gateway.example/ws")
        }));
        assert!(command.get_envs().any(|(name, value)| {
            name == "GSV_TOKEN" && value.is_some_and(|value| value == "driver-secret")
        }));
    }
}
