use clap::Parser;
use gsv::config::CliConfig;

use crate::auth_flow::{
    resolve_device_gateway_auth, run_auth_login, run_auth_logout, run_auth_setup,
    run_with_auto_setup_and_login_retry, run_with_auto_setup_options_retry,
    run_with_auto_setup_retry, AuthSetupOptions,
};
use crate::cli::{
    AuthAction, Cli, Commands, ConfigAction, DeviceAction, DeviceServiceAction, LocalConfigAction,
    UserAction,
};
use crate::commands;
use crate::device::{
    resolve_device_id, resolve_device_workspace, run_device, run_device_service, run_shell,
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
    match cli.command {
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
        Commands::User { action } => match action {
            UserAction::Create {
                username,
                new_password,
            } => {
                let password = commands::resolve_new_user_password(new_password)?;
                let create_action = UserAction::Create {
                    username,
                    new_password: Some(password),
                };
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "user",
                    |auth| async { commands::run_user(&url, auth, create_action.clone()).await },
                )
                .await
            }
            UserAction::Register {
                username,
                new_password,
                ttl_hours,
            } => {
                if ttl_hours == 0 {
                    return Err("--ttl-hours must be greater than 0".into());
                }
                let password = commands::resolve_new_user_password(new_password)?;
                let create_action = UserAction::Create {
                    username: username.clone(),
                    new_password: Some(password.clone()),
                };
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "user",
                    |auth| async { commands::run_user(&url, auth, create_action.clone()).await },
                )
                .await?;

                run_auth_login(&url, &cfg, Some(username), Some(password), ttl_hours).await
            }
            permissions_action @ UserAction::Permissions { .. } => {
                run_with_auto_setup_and_login_retry(
                    &url,
                    &cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                    cli_password_override.clone(),
                    "user",
                    |auth| async {
                        commands::run_user(&url, auth, permissions_action.clone()).await
                    },
                )
                .await
            }
        },
        Commands::Device { action } => match action {
            DeviceAction::Run { id, workspace } => {
                let device_id = resolve_device_id(id.clone(), &cfg);
                let workspace = resolve_device_workspace(workspace.clone(), &cfg);
                run_with_auto_setup_options_retry(
                    &url,
                    &cfg,
                    AuthSetupOptions {
                        username: cli_user_override.clone(),
                        password: cli_password_override.clone(),
                        device_id: Some(device_id.clone()),
                        ..AuthSetupOptions::default()
                    },
                    || async {
                        let attempt_cfg = CliConfig::load();
                        let auth = resolve_device_gateway_auth(
                            &attempt_cfg,
                            cli_token_override.clone(),
                            cli_user_override.clone(),
                        )?;
                        run_device(&url, auth, device_id.clone(), workspace.clone()).await
                    },
                )
                .await
            }
            DeviceAction::Install { id, workspace } => run_device_service(
                DeviceServiceAction::Install { id, workspace },
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DeviceAction::Start => run_device_service(
                DeviceServiceAction::Start,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DeviceAction::Stop => run_device_service(
                DeviceServiceAction::Stop,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DeviceAction::Status => run_device_service(
                DeviceServiceAction::Status,
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
            DeviceAction::Logs { lines, follow } => run_device_service(
                DeviceServiceAction::Logs { lines, follow },
                &cfg,
                cli_url_override.as_deref(),
                cli_user_override.as_deref(),
                cli_token_override.as_deref(),
            ),
        },
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
        Commands::Packages { action } => {
            run_with_auto_setup_and_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                cli_password_override.clone(),
                "packages",
                |auth| async { commands::run_packages(&url, auth, action.clone()).await },
            )
            .await
        }
        Commands::Infra { action } => commands::run_infra(action, &cfg).await,
        Commands::Version => run_version(),
    }
}
