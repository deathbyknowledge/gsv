use clap::Parser;
use daemon_protocol::{DaemonControlEndpoint, DaemonControlServer, DaemonPhase, ServerOptions};
use gateway_client::client::GatewayAuth;
use host_config::CliConfig;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

use machine::control::{ControlAction, DaemonRuntime};

#[derive(Clone, Parser)]
#[command(name = "gsvd", version, about = "GSV machine driver daemon")]
struct Args {
    /// Gateway URL (overrides local GSV configuration)
    #[arg(long, env = "GSV_URL")]
    url: Option<String>,

    /// Gateway username (overrides local GSV configuration)
    #[arg(short = 'u', long, env = "GSV_USER")]
    user: Option<String>,

    /// Non-interactive driver credential
    #[arg(short = 't', long, env = "GSV_TOKEN", hide_env_values = true)]
    token: Option<String>,

    /// Device ID (defaults to the configured ID or local hostname)
    #[arg(long)]
    id: Option<String>,

    /// Workspace directory exposed by filesystem and shell syscalls
    #[arg(long)]
    workspace: Option<PathBuf>,

    /// Run attached to the invoking process. gsvd always remains in the foreground;
    /// service managers provide detachment and restart policy.
    #[arg(long)]
    foreground: bool,
}

pub(crate) async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let mut settings = resolve_settings(&args, &CliConfig::load())?;
    let _logging_guard = machine::logger::init_device_logging()?;
    let (runtime, mut actions) = DaemonRuntime::new(settings.device_id.clone());
    let endpoint = DaemonControlEndpoint::current_user()?;
    let server_shutdown = CancellationToken::new();
    let server = DaemonControlServer::bind(&endpoint, runtime.clone(), ServerOptions::default())?;
    let mut server_task = tokio::spawn({
        let server_shutdown = server_shutdown.clone();
        async move { server.run_until(server_shutdown.cancelled()).await }
    });
    let signal = wait_for_shutdown_signal();
    tokio::pin!(signal);

    let result = loop {
        runtime.set_machine_id(settings.device_id.clone());
        let driver_shutdown = CancellationToken::new();
        let driver_settings = settings.clone();
        let driver = async {
            if driver_settings.auth.token.is_none() {
                runtime.pairing_required("Connect this computer to a space.");
                driver_shutdown.cancelled().await;
                return Ok(());
            }
            machine::device::run(
                &driver_settings.url,
                driver_settings.auth.clone(),
                driver_settings.device_id.clone(),
                driver_settings.workspace.clone(),
                driver_shutdown.clone(),
                runtime.clone(),
            )
            .await
        };
        tokio::pin!(driver);

        enum SupervisorEvent {
            Action(ControlAction),
            Driver(Result<(), Box<dyn std::error::Error>>),
            Signal,
            Server(Result<Result<(), daemon_protocol::Error>, tokio::task::JoinError>),
        }

        let event = tokio::select! {
            action = actions.recv() => SupervisorEvent::Action(action.unwrap_or(ControlAction::Shutdown)),
            driver = &mut driver => SupervisorEvent::Driver(driver),
            _ = &mut signal => SupervisorEvent::Signal,
            server = &mut server_task => SupervisorEvent::Server(server),
        };

        match event {
            SupervisorEvent::Action(action) => {
                driver_shutdown.cancel();
                if let Err(error) = driver.await {
                    tracing::warn!(event = "daemon.control.driver_stop_failed", error = %error);
                }
                match action {
                    ControlAction::Reload => {
                        runtime.set_phase(DaemonPhase::Reloading);
                        match resolve_settings(&args, &CliConfig::load()) {
                            Ok(reloaded) => settings = reloaded,
                            Err(error) => {
                                runtime.reconnecting(
                                    0,
                                    format!("Configuration reload failed: {error}"),
                                );
                            }
                        }
                    }
                    ControlAction::Reconnect => {}
                    ControlAction::Shutdown => break Ok(()),
                }
            }
            SupervisorEvent::Driver(result) => break result,
            SupervisorEvent::Signal => {
                driver_shutdown.cancel();
                let _ = driver.await;
                break Ok(());
            }
            SupervisorEvent::Server(result) => {
                driver_shutdown.cancel();
                let _ = driver.await;
                break match result {
                    Ok(Ok(())) => Err("gsvd control server stopped unexpectedly".into()),
                    Ok(Err(error)) => Err(Box::new(error) as Box<dyn std::error::Error>),
                    Err(error) => Err(Box::new(error) as Box<dyn std::error::Error>),
                };
            }
        }
    };

    runtime.set_phase(DaemonPhase::ShuttingDown);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    server_shutdown.cancel();
    if !server_task.is_finished() {
        let _ = server_task.await;
    }
    result
}

#[derive(Clone)]
struct Settings {
    url: String,
    auth: GatewayAuth,
    device_id: String,
    workspace: PathBuf,
}

fn resolve_settings(args: &Args, cfg: &CliConfig) -> Result<Settings, Box<dyn std::error::Error>> {
    let url = args.url.clone().unwrap_or_else(|| cfg.device_gateway_url());
    let device_id = args
        .id
        .clone()
        .or_else(|| cfg.default_device_id())
        .unwrap_or_else(default_device_id);
    let workspace = args
        .workspace
        .clone()
        .or_else(|| cfg.default_device_workspace())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let workspace = workspace.canonicalize().unwrap_or(workspace);
    let auth = GatewayAuth {
        username: args.user.clone().or_else(|| cfg.device_gateway_username()),
        password: None,
        token: args.token.clone().or_else(|| cfg.default_device_token()),
    };
    auth.validate()?;

    let _ = args.foreground;
    Ok(Settings {
        url,
        auth,
        device_id,
        workspace,
    })
}

#[cfg(unix)]
async fn wait_for_shutdown_signal() {
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Failed to subscribe to SIGTERM");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to subscribe to Ctrl+C");
}

fn default_device_id() -> String {
    let hostname = hostname::get()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    format!("device-{hostname}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> Args {
        Args {
            url: None,
            user: None,
            token: None,
            id: None,
            workspace: None,
            foreground: true,
        }
    }

    #[test]
    fn enrolled_machine_uses_its_own_identity_without_a_cli_login() {
        let mut cfg = CliConfig::default();
        cfg.device.gateway_url = Some("wss://machine.example/ws".into());
        cfg.device.gateway_username = Some("machine-owner".into());
        cfg.device.token = Some("machine-credential".into());
        cfg.device.id = Some("laptop".into());

        for unrelated_cli_login in [false, true] {
            if unrelated_cli_login {
                cfg.gateway.url = Some("wss://cli.example/ws".into());
                cfg.gateway.username = Some("cli-owner".into());
                cfg.gateway.token = Some("cli-credential".into());
            }
            let settings = resolve_settings(&args(), &cfg).expect("paired machine can start");
            assert_eq!(settings.url, "wss://machine.example/ws");
            assert_eq!(settings.auth.username.as_deref(), Some("machine-owner"));
            assert_eq!(settings.auth.token.as_deref(), Some("machine-credential"));
            assert_eq!(settings.device_id, "laptop");
        }

        let settings = resolve_settings(
            &Args {
                url: Some("wss://override.example/ws".into()),
                user: Some("override-owner".into()),
                token: Some("override-credential".into()),
                ..args()
            },
            &cfg,
        )
        .expect("explicit connection overrides");
        assert_eq!(settings.url, "wss://override.example/ws");
        assert_eq!(settings.auth.username.as_deref(), Some("override-owner"));
        assert_eq!(settings.auth.token.as_deref(), Some("override-credential"));
    }

    #[test]
    fn older_machine_configurations_keep_their_gateway_identity() {
        let mut cfg = CliConfig::default();
        cfg.gateway.url = Some("wss://existing.example/ws".into());
        cfg.gateway.username = Some("existing-owner".into());
        cfg.device.token = Some("machine-credential".into());
        let settings = resolve_settings(&args(), &cfg).expect("legacy configuration");
        assert_eq!(settings.url, "wss://existing.example/ws");
        assert_eq!(settings.auth.username.as_deref(), Some("existing-owner"));
        assert_eq!(settings.auth.token.as_deref(), Some("machine-credential"));
    }

    #[test]
    fn default_id_is_namespaced_as_a_device() {
        assert!(default_device_id().starts_with("device-"));
    }
}
