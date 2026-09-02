use clap::Parser;
use gsv::config::CliConfig;
use gsv::kernel_client::GatewayAuth;

use crate::auth_flow::{
    resolve_device_gateway_auth, run_auth_login, run_auth_logout, run_auth_setup,
    run_with_auto_setup_and_login_retry, run_with_auto_setup_retry, AuthSetupOptions,
};
use crate::cli::{
    AuthAction, Cli, Commands, ConfigAction, DaemonAction, DaemonServiceAction, LegacyDeviceAction,
    LocalConfigAction,
};
use crate::commands;
use crate::desktop::run_desktop;
use crate::device::{
    reconnect_daemon, reload_daemon, resolve_device_id, resolve_device_workspace,
    run_daemon_service, run_device_daemon, run_shell, show_daemon_diagnostics,
    show_daemon_live_status,
};
use crate::local_config::run_local_config;
use crate::version::run_version;

pub(crate) async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    // Load config from file
    let cfg = CliConfig::load();

    // Keep explicit CLI overrides so managed device mode can persist them.
    let cli_url_override = cli.url.clone();
    let cli_user_override = cli.user.clone();
    let cli_password_override = cli.password.clone();
    let cli_token_override = cli.token.clone();

    // Merge CLI args with config (CLI takes precedence)
    let url = cli_url_override
        .clone()
        .unwrap_or_else(|| cfg.gateway_url());
    let command = cli.command.unwrap_or(Commands::Tui {
        demo: false,
        pid: None,
        vim: false,
    });
    match command {
        Commands::Tui {
            demo: true,
            pid,
            vim,
        } => commands::run_tui(&url, GatewayAuth::default(), pid, true, vim).await,
        Commands::Tui {
            demo: false,
            pid,
            vim,
        } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "tui",
                |auth| async { commands::run_tui(&url, auth, pid.clone(), false, vim).await },
            )
            .await
        }
        Commands::Chat { message, pid } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "chat",
                |auth| async {
                    commands::run_client(&url, auth, message.clone(), pid.clone()).await
                },
            )
            .await
        }
        Commands::Shell => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "shell",
                |auth| async { run_shell(&url, auth).await },
            )
            .await
        }
        Commands::Proc { action } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "proc",
                |auth| async { commands::run_proc(&url, auth, action.clone()).await },
            )
            .await
        }
        Commands::Adapter { action } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "adapter",
                |auth| async { commands::run_adapter(&url, auth, action.clone()).await },
            )
            .await
        }
        Commands::Auth { action } => match action {
            AuthAction::Login {
                username,
                password,
                ttl_hours,
            } => {
                run_with_auto_setup_retry(
                    &url,
                    &cfg,
                    username.clone().or_else(|| cli_user_override.clone()),
                    password.clone().or_else(|| cli_password_override.clone()),
                    || async {
                        run_auth_login(
                            &url,
                            &cfg,
                            username.clone().or_else(|| cli_user_override.clone()),
                            password.clone().or_else(|| cli_password_override.clone()),
                            ttl_hours,
                        )
                        .await
                    },
                )
                .await
            }
            AuthAction::Logout => run_auth_logout(),
            AuthAction::Setup {
                username,
                new_password,
                root_password,
                ai_provider,
                ai_model,
                ai_api_key,
                device_id,
                device_label,
                device_expires_at,
            } => {
                run_auth_setup(
                    &url,
                    &cfg,
                    AuthSetupOptions {
                        username,
                        password: new_password,
                        root_password,
                        ai_provider,
                        ai_model,
                        ai_api_key,
                        device_id,
                        device_label,
                        device_expires_at,
                    },
                )
                .await
            }
            link_action @ AuthAction::Link { .. }
            | link_action @ AuthAction::LinkList { .. }
            | link_action @ AuthAction::Unlink { .. } => {
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "auth",
                    |auth| async { commands::run_auth(&url, auth, link_action.clone()).await },
                )
                .await
            }
            token_action @ AuthAction::Token { .. } => {
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "auth",
                    |auth| async { commands::run_auth(&url, auth, token_action.clone()).await },
                )
                .await
            }
        },
        Commands::LegacyDevice { action } => match action {
            LegacyDeviceAction::Run { id, workspace } => {
                let device_id = resolve_device_id(id.clone(), &cfg);
                let workspace = resolve_device_workspace(workspace.clone(), &cfg);
                let attempt_cfg = CliConfig::load();
                let auth = resolve_device_gateway_auth(
                    &attempt_cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                )?;
                run_device_daemon(&url, auth, device_id, workspace)
            }
        },
        Commands::Daemon { action } => match action {
            DaemonAction::Install { id, workspace } => run_daemon_service(
                DaemonServiceAction::Install { id, workspace },
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DaemonAction::Start => run_daemon_service(
                DaemonServiceAction::Start,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DaemonAction::Restart => run_daemon_service(
                DaemonServiceAction::Restart,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DaemonAction::Stop => run_daemon_service(
                DaemonServiceAction::Stop,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DaemonAction::Uninstall => run_daemon_service(
                DaemonServiceAction::Uninstall,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DaemonAction::Status => {
                run_daemon_service(
                    DaemonServiceAction::Status,
                    &cfg,
                    cli_url_override.as_deref(),
                    cli_user_override.as_deref(),
                    cli_token_override.as_deref(),
                )?;
                show_daemon_live_status().await
            }
            DaemonAction::Doctor => run_daemon_service(
                DaemonServiceAction::Doctor,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DaemonAction::Reload => reload_daemon().await,
            DaemonAction::Reconnect => reconnect_daemon().await,
            DaemonAction::Diagnostics { json } => show_daemon_diagnostics(json).await,
            DaemonAction::Logs { lines, follow } => run_daemon_service(
                DaemonServiceAction::Logs { lines, follow },
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
        },
        Commands::Desktop { action } => run_desktop(action).await,
        Commands::Config { local, action } => {
            if local {
                match action {
                    ConfigAction::Get { key } => {
                        let key = key.ok_or("`gsv config --local get` requires a key")?;
                        run_local_config(LocalConfigAction::Get { key })
                    }
                    ConfigAction::Set { key, value } => {
                        run_local_config(LocalConfigAction::Set { key, value })
                    }
                }
            } else {
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "config",
                    |auth| async { commands::run_config(&url, auth, action.clone()).await },
                )
                .await
            }
        }
        Commands::Version => run_version(),
    }
}
