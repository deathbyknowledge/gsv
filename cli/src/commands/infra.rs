use std::path::PathBuf;

use cliclack::{intro, log, multiselect, note, outro_cancel, select};
use gsv::config::CliConfig;
use gsv::deploy;
use gsv::device_service;

use crate::auth_flow::{can_prompt_interactively, prompt_secret, prompt_yes_no};
use crate::cli::{DeviceServiceAction, InfraAction};
use crate::device::run_node_service;

struct DeployCommandOptions {
    version: String,
    component: Vec<String>,
    all: bool,
    force_fetch: bool,
    bundle_dir: Option<PathBuf>,
    api_token: Option<String>,
    account_id: Option<String>,
    discord_bot_token: Option<String>,
}

struct DestroyCommandOptions {
    component: Vec<String>,
    all: bool,
    delete_bucket: bool,
    purge_bucket: bool,
    wizard: bool,
    api_token: Option<String>,
    account_id: Option<String>,
    keep_node: bool,
}

struct DestroyDeployOptions {
    component: Vec<String>,
    all: bool,
    delete_bucket: bool,
    purge_bucket: bool,
    wizard: bool,
    api_token: Option<String>,
    account_id: Option<String>,
}

pub(crate) async fn run_infra(
    action: InfraAction,
    cfg: &CliConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        InfraAction::Deploy {
            version,
            component,
            all,
            force_fetch,
            bundle_dir,
            api_token,
            account_id,
            discord_bot_token,
        } => {
            run_deploy_command(
                cfg,
                DeployCommandOptions {
                    version,
                    component,
                    all,
                    force_fetch,
                    bundle_dir,
                    api_token,
                    account_id,
                    discord_bot_token,
                },
            )
            .await
        }
        InfraAction::Upgrade {
            version,
            component,
            all,
            force_fetch,
            bundle_dir,
            api_token,
            account_id,
            discord_bot_token,
        } => {
            run_upgrade_command(
                cfg,
                DeployCommandOptions {
                    version,
                    component,
                    all,
                    force_fetch,
                    bundle_dir,
                    api_token,
                    account_id,
                    discord_bot_token,
                },
            )
            .await
        }
        InfraAction::Destroy {
            component,
            all,
            delete_bucket,
            purge_bucket,
            wizard,
            api_token,
            account_id,
            keep_node,
        } => {
            run_destroy_command(
                cfg,
                DestroyCommandOptions {
                    component,
                    all,
                    delete_bucket,
                    purge_bucket,
                    wizard,
                    api_token,
                    account_id,
                    keep_node,
                },
            )
            .await
        }
    }
}

fn prompt_cloudflare_account_selection(
    accounts: &[deploy::CloudflareAccountSummary],
) -> Result<String, Box<dyn std::error::Error>> {
    if accounts.is_empty() {
        return Err("API token has no accessible Cloudflare accounts".into());
    }

    let mut prompt = select("Select Cloudflare account");
    for account in accounts {
        let name = if account.name.trim().is_empty() {
            "(unnamed account)"
        } else {
            account.name.as_str()
        };
        let label = format!("{} ({})", name, account.id);
        prompt = prompt.item(account.id.clone(), label, "");
    }

    Ok(prompt.interact()?)
}

fn resolve_cloudflare_token_for_deploy(
    cfg: &CliConfig,
    api_token: Option<String>,
    wizard_mode: bool,
    interactive: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    let token = api_token
        .or_else(|| cfg.cloudflare.api_token.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(token) = token {
        return Ok(token);
    }

    if wizard_mode && interactive {
        return prompt_secret("Cloudflare API token")?
            .ok_or("Cloudflare API token is required for deploy wizard".into());
    }

    Err("Cloudflare API token missing. Set --api-token or `gsv config --local set cloudflare.api_token ...`".into())
}

async fn resolve_cloudflare_account_id_for_deploy(
    token: &str,
    configured_account_id: Option<String>,
    wizard_mode: bool,
    interactive: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    if let Some(account_id) = configured_account_id.as_deref() {
        return deploy::resolve_cloudflare_account_id(token, Some(account_id)).await;
    }

    if wizard_mode && interactive {
        let accounts = deploy::list_cloudflare_accounts(token).await?;
        return match accounts.len() {
            0 => Err("API token has no accessible Cloudflare accounts".into()),
            1 => Ok(accounts[0].id.clone()),
            _ => prompt_cloudflare_account_selection(&accounts),
        };
    }

    deploy::resolve_cloudflare_account_id(token, None).await
}

fn component_is_selected(components: &[String], component: &str) -> bool {
    components.iter().any(|c| c == component)
}

fn teardown_component_description(component: &str) -> &'static str {
    match component {
        "ripgit" => "Git-backed storage worker",
        "pds" => "ATProto PDS and repo worker",
        "assembler" => "Package assembly worker",
        "gateway" => "Core API + sessions worker",
        "channel-whatsapp" => "WhatsApp channel worker",
        "channel-discord" => "Discord channel worker",
        _ => "Worker component",
    }
}

fn prompt_down_components(
    default_components: &[String],
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let defaults = deploy::available_components()
        .iter()
        .filter(|component| component_is_selected(default_components, component))
        .map(|component| (*component).to_string())
        .collect::<Vec<_>>();

    let mut prompt = multiselect("Select components to tear down");
    for component in deploy::available_components() {
        prompt = prompt.item(
            (*component).to_string(),
            *component,
            teardown_component_description(component),
        );
    }
    prompt = prompt.required(true);
    if !defaults.is_empty() {
        prompt = prompt.initial_values(defaults);
    }

    Ok(prompt.interact()?)
}

fn normalize_release_channel(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "dev" | "stable" => Some(normalized),
        _ => None,
    }
}

fn release_channel_from_env() -> Option<String> {
    std::env::var("GSV_CHANNEL")
        .ok()
        .and_then(|value| normalize_release_channel(&value))
}

fn release_channel_from_config(cfg: &CliConfig) -> Option<String> {
    cfg.release_channel()
}

fn resolve_channel_aware_version(cfg: &CliConfig, version: &str) -> (String, Option<&'static str>) {
    if version != "latest" {
        return (version.to_string(), None);
    }

    if let Some(channel) = release_channel_from_env() {
        return (channel, Some("GSV_CHANNEL"));
    }

    if let Some(channel) = release_channel_from_config(cfg) {
        return (channel, Some("local config (release.channel)"));
    }

    ("latest".to_string(), None)
}

fn is_mutable_release_ref(version: &str) -> bool {
    let normalized = version.trim().to_ascii_lowercase();
    matches!(normalized.as_str(), "latest" | "dev" | "stable")
}

async fn run_deploy_command(
    cfg: &CliConfig,
    mut options: DeployCommandOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    let (version, version_channel_source) = resolve_channel_aware_version(cfg, &options.version);
    if let Some(source) = version_channel_source {
        println!("Using release channel '{}' from {}.", version, source);
    }
    options.version = version;

    apply_deploy(cfg, options).await
}

async fn run_upgrade_command(
    cfg: &CliConfig,
    mut options: DeployCommandOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    let (version, version_channel_source) = resolve_channel_aware_version(cfg, &options.version);
    if let Some(source) = version_channel_source {
        println!("Using release channel '{}' from {}.", version, source);
    }

    let effective_force_fetch = options.force_fetch || is_mutable_release_ref(&version);
    if effective_force_fetch && !options.force_fetch && is_mutable_release_ref(&version) {
        println!(
            "Refresh enabled for mutable release ref '{}' (dev/stable/latest).",
            version
        );
    }
    options.version = version;
    options.force_fetch = effective_force_fetch;

    apply_deploy(cfg, options).await
}

async fn run_destroy_command(
    cfg: &CliConfig,
    options: DestroyCommandOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    let DestroyCommandOptions {
        component,
        all,
        delete_bucket,
        purge_bucket,
        wizard,
        api_token,
        account_id,
        keep_node,
    } = options;
    let all = if !all && component.is_empty() {
        true
    } else {
        all
    };

    destroy_deploy(
        cfg,
        DestroyDeployOptions {
            component,
            all,
            delete_bucket,
            purge_bucket,
            wizard,
            api_token,
            account_id,
        },
    )
    .await?;

    if keep_node {
        println!("Skipped device daemon uninstall (--keep-node).");
        return Ok(());
    }

    if !device_service::node_service_management_supported() {
        println!(
            "Device daemon management is unsupported on this OS. Local device teardown was skipped."
        );
        return Ok(());
    }

    let refreshed_cfg = CliConfig::load();
    run_node_service(
        DeviceServiceAction::Uninstall,
        &refreshed_cfg,
        None,
        None,
        None,
    )
}

async fn apply_deploy(
    cfg: &CliConfig,
    options: DeployCommandOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    let DeployCommandOptions {
        version,
        component,
        all,
        force_fetch,
        bundle_dir,
        api_token,
        account_id,
        discord_bot_token,
    } = options;
    deploy::set_notification_output(false);

    if all && !component.is_empty() {
        return Err("Use either --all or one/more --component values, not both".into());
    }

    let token = resolve_cloudflare_token_for_deploy(cfg, api_token, false, false)?;
    let configured_account_id = account_id
        .or_else(|| cfg.cloudflare.account_id.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let resolved_account_id =
        resolve_cloudflare_account_id_for_deploy(&token, configured_account_id, false, false)
            .await?;
    println!("Cloudflare account ID: {}", resolved_account_id);

    let components = if all {
        deploy::available_components()
            .iter()
            .map(|c| (*c).to_string())
            .collect::<Vec<_>>()
    } else {
        deploy::normalize_components(&component)?
    };

    let deploying_gateway = components.iter().any(|c| c == "gateway");
    let deploying_discord = components.iter().any(|c| c == "channel-discord");

    let bundle_version = if bundle_dir.is_some() {
        deploy::local_bundle_version_label(&version)
    } else {
        deploy::resolve_release_tag(&version).await?
    };
    println!("Preparing components: {}", components.join(", "));
    if let Some(dir) = bundle_dir {
        println!("Using local bundles from {}", dir.display());
        deploy::install_bundles_from_dir(cfg, &dir, &version, &components, force_fetch)?;
    } else {
        deploy::fetch_bundles(cfg, &version, &components, force_fetch).await?;
    }

    println!();
    println!(
        "Preparation complete. Applying deploy from version {}.",
        bundle_version
    );
    let apply_result = deploy::apply_deploy(
        cfg,
        &resolved_account_id,
        &token,
        &bundle_version,
        &components,
    )
    .await?;

    if deploying_discord {
        if let Some(bot_token) = discord_bot_token.as_deref() {
            println!("Setting DISCORD_BOT_TOKEN secret on Discord channel worker...");
            deploy::set_discord_bot_token_secret(&resolved_account_id, &token, bot_token).await?;
            println!("Configured DISCORD_BOT_TOKEN.");
        } else {
            println!("Note: Discord bot token not configured.");
            println!(
                "Tip: rerun deploy with --discord-bot-token (or DISCORD_BOT_TOKEN env) before `gsv channel discord start`."
            );
        }
    }

    println!();
    println!("Infrastructure deployed successfully.");
    if deploying_gateway {
        if let Some(gateway_url) = apply_result.gateway_url.as_deref() {
            println!("Finish onboarding in the browser:");
            println!("{}", gateway_url);
        } else {
            println!(
                "Gateway URL unavailable after deploy. Check the Cloudflare Workers dashboard for the gateway worker URL."
            );
        }
    }

    Ok(())
}

async fn destroy_deploy(
    cfg: &CliConfig,
    options: DestroyDeployOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    let DestroyDeployOptions {
        component,
        all,
        delete_bucket,
        purge_bucket,
        wizard,
        api_token,
        account_id,
    } = options;
    deploy::set_notification_output(false);

    if all && !component.is_empty() {
        return Err("Use either --all or one/more --component values, not both".into());
    }
    let interactive = can_prompt_interactively();
    let wizard_mode = wizard;

    if wizard_mode && !interactive {
        return Err("--wizard requires an interactive terminal".into());
    }
    deploy::set_notification_output(wizard_mode && interactive);
    if wizard_mode && interactive {
        intro("GSV teardown wizard")?;
    }
    if !all && component.is_empty() && !wizard_mode {
        return Err(
            "Refusing to tear down without explicit targets. Use --all or at least one --component."
                .into(),
        );
    }
    if purge_bucket && !delete_bucket && !wizard_mode {
        return Err("--purge-bucket requires --delete-bucket".into());
    }

    let token = resolve_cloudflare_token_for_deploy(cfg, api_token, wizard_mode, interactive)?;
    let configured_account_id = account_id
        .or_else(|| cfg.cloudflare.account_id.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let resolved_account_id = resolve_cloudflare_account_id_for_deploy(
        &token,
        configured_account_id,
        wizard_mode,
        interactive,
    )
    .await?;
    println!("Cloudflare account ID: {}", resolved_account_id);

    let mut components = if all {
        deploy::available_components()
            .iter()
            .map(|c| (*c).to_string())
            .collect::<Vec<_>>()
    } else if component.is_empty() {
        Vec::new()
    } else {
        deploy::normalize_components(&component)?
    };

    if wizard_mode && interactive && !all && component.is_empty() {
        note(
            "Target",
            format!("Cloudflare account: {}", resolved_account_id),
        )?;
        components = prompt_down_components(&components)?;
    }

    if components.is_empty() {
        return Err("No components selected for teardown.".into());
    }

    let mut delete_bucket_resource = delete_bucket;
    let mut purge_bucket_resource = purge_bucket;

    if wizard_mode && interactive {
        delete_bucket_resource =
            prompt_yes_no("Also delete R2 bucket gsv-storage?", delete_bucket_resource)?;
        if delete_bucket_resource {
            purge_bucket_resource = prompt_yes_no(
                "Purge bucket objects before deletion?",
                purge_bucket_resource,
            )?;
        } else {
            purge_bucket_resource = false;
        }

        let summary = format!(
            "Account: {}\nComponents: {}\nDelete bucket: {}\nPurge bucket objects: {}",
            resolved_account_id,
            components.join(", "),
            if delete_bucket_resource { "yes" } else { "no" },
            if purge_bucket_resource { "yes" } else { "no" }
        );
        note("Teardown summary", summary)?;
        if !prompt_yes_no("Proceed with teardown?", false)? {
            let _ = outro_cancel("Teardown cancelled.");
            return Err("Teardown cancelled.".into());
        }
        log::step("Starting teardown...")?;
    } else if purge_bucket_resource && !delete_bucket_resource {
        return Err("--purge-bucket requires --delete-bucket".into());
    }

    println!("Tearing down components: {}", components.join(", "));
    deploy::destroy_deploy(
        &resolved_account_id,
        &token,
        &components,
        delete_bucket_resource,
        purge_bucket_resource,
    )
    .await
}
