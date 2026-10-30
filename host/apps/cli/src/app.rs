use clap::Parser;
use gsv::config::CliConfig;

use crate::auth_flow::{resolve_device_gateway_auth, run_with_login_retry, LoginRequest};
use crate::cli::{
    Cli, Commands, ConfigAction, DaemonAction, DaemonServiceAction, FilesAction,
    LegacyDeviceAction, LocalConfigAction, WorkAction, TOP_HELP,
};
use crate::commands::{
    account, activity, contacts, files, mail, memory, places, requests, routines, run, ship,
    tokens, work,
};
use crate::desktop::run_desktop;
use crate::device::{
    reconnect_daemon, reload_daemon, resolve_device_id, resolve_device_workspace,
    run_daemon_service, run_device_daemon, show_daemon_diagnostics, show_daemon_live_status,
};
use crate::local_config::run_local_config;
use crate::remote::{words, DynError, Output};
use crate::version::run_version;

pub(crate) async fn run() -> Result<(), DynError> {
    let cli = Cli::parse();

    // Load config from file
    let cfg = CliConfig::load();
    let out = Output::new(cli.json);

    // Keep explicit overrides so managed device mode can persist them.
    let cli_url_override = cli.url.clone();
    let cli_user_override = cli.user.clone();
    let cli_token_override = cli.token.clone();

    let url = cli_url_override
        .clone()
        .unwrap_or_else(|| cfg.gateway_url());

    let Some(command) = cli.command else {
        print!("{TOP_HELP}");
        return Ok(());
    };
    if let Some(pointer) = command.removed_pointer() {
        return Err(pointer.into());
    }

    // Every remote command signs in the same way: the saved session, an
    // explicit `GSV_TOKEN`, or a password prompt when the session has ended.
    macro_rules! signed_in {
        (|$auth:ident| $body:expr) => {
            run_with_login_retry(
                &url,
                &cfg,
                cli_token_override.clone(),
                cli_user_override.clone(),
                |$auth| $body,
            )
            .await
        };
    }

    match command {
        Commands::Ship {
            message, action, ..
        } => match action {
            Some(action) => signed_in!(|auth| ship::run_action(&url, auth, action.clone(), out)),
            None => {
                let message = words(&message);
                signed_in!(|auth| ship::run_client(
                    &url,
                    auth,
                    message.clone(),
                    ship::Conversation::Ship,
                    out
                ))
            }
        },
        Commands::Files { action } => {
            let action = action.clone().unwrap_or(FilesAction::Ls { path: None });
            signed_in!(|auth| files::run(&url, auth, action.clone(), out))
        }
        Commands::Contacts { action } => {
            signed_in!(|auth| contacts::run(&url, auth, action.clone(), out))
        }
        Commands::Requests { action } => {
            signed_in!(|auth| requests::run(&url, auth, action.clone(), out))
        }
        Commands::Memory { action } => {
            signed_in!(|auth| memory::run(&url, auth, action.clone(), out))
        }
        Commands::Mail { page, action } => {
            signed_in!(|auth| mail::run(&url, auth, page.clone(), action.clone(), out))
        }
        Commands::Work {
            action: Some(WorkAction::Open { id, message }),
            ..
        } => {
            let message = words(&message);
            signed_in!(|auth| ship::run_client(
                &url,
                auth,
                message.clone(),
                ship::Conversation::Work(id.clone()),
                out
            ))
        }
        Commands::Work { action, all } => {
            signed_in!(|auth| work::run(&url, auth, action.clone(), all, out))
        }
        Commands::Routines { action } => {
            signed_in!(|auth| routines::run(&url, auth, action.clone(), out))
        }
        Commands::Run { on, cwd, command } => {
            signed_in!(|auth| run::run(&url, auth, on.clone(), cwd.clone(), command.clone(), out))
        }
        Commands::Places { action } => {
            signed_in!(|auth| places::run(&url, auth, action.clone(), out))
        }
        Commands::Activity { on, limit } => {
            signed_in!(|auth| activity::run(&url, auth, on.clone(), limit, out))
        }
        Commands::Login {
            space,
            username,
            password,
            ttl_hours,
        } => {
            account::login(
                &cfg,
                LoginRequest {
                    space,
                    url_override: cli_url_override.clone(),
                    username: username.or_else(|| cli_user_override.clone()),
                    password,
                    ttl_hours,
                },
                out,
            )
            .await
        }
        Commands::Logout => account::logout(&cfg, out).await,
        Commands::Status => account::status(&cfg, &url, out).await,
        Commands::Pair {
            code,
            workspace,
            no_install,
            preserve_cli_login,
            no_replace,
        } => {
            crate::pairing::run_pair(
                code,
                workspace,
                crate::pairing::PairOptions {
                    no_install,
                    preserve_cli_login,
                    no_replace,
                },
            )
            .await
        }
        Commands::Unpair { yes } => signed_in!(|auth| account::unpair(&url, auth, yes, out)),
        Commands::Update => signed_in!(|auth| account::update(&url, auth, out)),
        Commands::LegacyDevice { action } => match action {
            LegacyDeviceAction::Run { id, workspace } => {
                let device_id = resolve_device_id(id.clone(), &cfg);
                let workspace = resolve_device_workspace(workspace.clone(), &cfg);
                let attempt_cfg = CliConfig::load();
                let url = cli_url_override
                    .clone()
                    .unwrap_or_else(|| attempt_cfg.device_gateway_url());
                let auth = resolve_device_gateway_auth(
                    &attempt_cfg,
                    cli_token_override.clone(),
                    cli_user_override.clone(),
                )?;
                run_device_daemon(&url, auth, device_id, workspace)
            }
        },
        Commands::Daemon { action } => {
            let service = |action| {
                run_daemon_service(
                    action,
                    &cfg,
                    cli_url_override.as_deref(),
                    cli_user_override.as_deref(),
                    cli_token_override.as_deref(),
                )
            };
            match action {
                #[cfg(windows)]
                DaemonAction::WindowsUpdate { daemon_sha256 } => {
                    gsv::device_service::update_elevated(&daemon_sha256).await
                }
                #[cfg(windows)]
                DaemonAction::WindowsInstall {
                    config,
                    owner_sid,
                    workspace,
                    daemon_source,
                    daemon_sha256,
                    transaction,
                    parent_pid,
                } => gsv::device_service::install_elevated(
                    &config,
                    &owner_sid,
                    &workspace,
                    &daemon_source,
                    &daemon_sha256,
                    transaction.as_deref().zip(parent_pid),
                ),
                DaemonAction::Install { id, workspace } => {
                    service(DaemonServiceAction::Install { id, workspace })
                }
                DaemonAction::Start => service(DaemonServiceAction::Start),
                DaemonAction::Restart => service(DaemonServiceAction::Restart),
                DaemonAction::Stop => service(DaemonServiceAction::Stop),
                DaemonAction::Uninstall => service(DaemonServiceAction::Uninstall),
                DaemonAction::Status => {
                    service(DaemonServiceAction::Status)?;
                    show_daemon_live_status().await
                }
                DaemonAction::Doctor => service(DaemonServiceAction::Doctor),
                DaemonAction::Reload => reload_daemon().await,
                DaemonAction::Reconnect => reconnect_daemon().await,
                DaemonAction::Diagnostics => show_daemon_diagnostics(out.json).await,
                DaemonAction::Logs { lines, follow } => {
                    service(DaemonServiceAction::Logs { lines, follow })
                }
            }
        }
        Commands::Desktop { action } => run_desktop(action, out.json).await,
        Commands::Config { action, .. } => match action {
            ConfigAction::Get { key } => {
                let key = key.ok_or("`gsv config --local get` requires a key")?;
                run_local_config(LocalConfigAction::Get { key })
            }
            ConfigAction::Set { key, value } => {
                run_local_config(LocalConfigAction::Set { key, value })
            }
        },
        Commands::Version => run_version(),
        Commands::Auth { rest } if rest.first().is_some_and(|word| word == "token") => {
            let json = out.json || rest.iter().any(|arg| arg == "--json");
            let action = Commands::token_command(&rest)
                .ok_or("`gsv auth token` needs an action: create, list or revoke")?
                .action;
            signed_in!(|auth| tokens::run(&url, auth, action.clone(), Output::new(json)))
        }
        Commands::Shell { .. }
        | Commands::Proc { .. }
        | Commands::Adapter { .. }
        | Commands::Auth { .. } => {
            Err("This command was removed. Run gsv for the current commands.".into())
        }
    }
}
