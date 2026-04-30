use std::path::PathBuf;

use gsv::config::{self, CliConfig};

use crate::auth_flow::format_unix_ms;
use crate::cli::LocalConfigAction;

pub(crate) fn run_local_config(
    action: LocalConfigAction,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LocalConfigAction::Get { key } => {
            let cfg = CliConfig::load();
            let value = match key.as_str() {
                "gateway.url" => cfg.gateway.url.map(|s| s.to_string()),
                "gateway.username" => cfg.gateway.username.map(|s| s.to_string()),
                "gateway.token" => cfg.gateway.token.map(|s| {
                    // Mask token for security
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "gateway.session_token" => cfg.gateway.session_token.map(|s| {
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "gateway.session_token_id" => cfg.gateway.session_token_id,
                "gateway.session_expires_at" => cfg.gateway.session_expires_at.map(format_unix_ms),
                "gateway.session_expires_at_ms" => cfg
                    .gateway
                    .session_expires_at
                    .map(|value| value.to_string()),
                "cloudflare.account_id" => cfg.cloudflare.account_id,
                "cloudflare.api_token" => cfg.cloudflare.api_token.map(|s| {
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "release.channel" => cfg.release.channel,
                "r2.account_id" => cfg.r2.account_id,
                "r2.access_key_id" => cfg.r2.access_key_id.map(|s| {
                    if s.len() > 8 {
                        format!("{}...", &s[..8])
                    } else {
                        "****".to_string()
                    }
                }),
                "r2.bucket" => cfg.r2.bucket,
                "session.default_key" => cfg.session.default_key,
                "node.id" => cfg.node.id,
                "node.token" => cfg.node.token.map(|s| {
                    if s.len() > 8 {
                        format!("{}...{}", &s[..4], &s[s.len() - 4..])
                    } else {
                        "****".to_string()
                    }
                }),
                "node.workspace" => cfg.node.workspace.map(|path| path.display().to_string()),
                _ => {
                    eprintln!("Unknown config key: {}", key);
                    eprintln!("\nValid keys:");
                    eprintln!("  gateway.url, gateway.username, gateway.token");
                    eprintln!("  gateway.session_token, gateway.session_token_id, gateway.session_expires_at");
                    eprintln!("  cloudflare.account_id, cloudflare.api_token");
                    eprintln!("  release.channel");
                    eprintln!("  r2.account_id, r2.access_key_id, r2.bucket");
                    eprintln!("  session.default_key");
                    eprintln!("  node.id, node.token, node.workspace");
                    return Ok(());
                }
            };

            match value {
                Some(v) => println!("{}", v),
                None => println!("(not set)"),
            }
        }

        LocalConfigAction::Set { key, value } => {
            let mut cfg = CliConfig::load();

            match key.as_str() {
                "gateway.url" => cfg.gateway.url = Some(value.clone()),
                "gateway.username" => cfg.gateway.username = Some(value.clone()),
                "gateway.token" => cfg.gateway.token = Some(value.clone()),
                "gateway.session_token" => cfg.gateway.session_token = Some(value.clone()),
                "gateway.session_token_id" => cfg.gateway.session_token_id = Some(value.clone()),
                "gateway.session_expires_at" | "gateway.session_expires_at_ms" => {
                    let parsed = value
                        .trim()
                        .parse::<i64>()
                        .map_err(|_| "gateway.session_expires_at must be unix ms integer")?;
                    cfg.gateway.session_expires_at = Some(parsed);
                }
                "cloudflare.account_id" => cfg.cloudflare.account_id = Some(value.clone()),
                "cloudflare.api_token" => cfg.cloudflare.api_token = Some(value.clone()),
                "release.channel" => {
                    let normalized = value.trim().to_ascii_lowercase();
                    if normalized != "stable" && normalized != "dev" {
                        eprintln!("release.channel must be 'stable' or 'dev'");
                        return Ok(());
                    }
                    cfg.release.channel = Some(normalized);
                }
                "r2.account_id" => cfg.r2.account_id = Some(value.clone()),
                "r2.access_key_id" => cfg.r2.access_key_id = Some(value.clone()),
                "r2.secret_access_key" => cfg.r2.secret_access_key = Some(value.clone()),
                "r2.bucket" => cfg.r2.bucket = Some(value.clone()),
                "session.default_key" => {
                    cfg.session.default_key = Some(config::normalize_session_key(&value))
                }
                "node.id" => cfg.node.id = Some(value.clone()),
                "node.token" => cfg.node.token = Some(value.clone()),
                "node.workspace" => cfg.node.workspace = Some(PathBuf::from(value.clone())),
                "channels.whatsapp.url" => cfg.channels.whatsapp.url = Some(value.clone()),
                "channels.whatsapp.token" => cfg.channels.whatsapp.token = Some(value.clone()),
                _ => {
                    eprintln!("Unknown config key: {}", key);
                    return Ok(());
                }
            }

            cfg.save()?;
            let display_value = if key == "session.default_key" {
                cfg.session.default_key.as_deref().unwrap_or(&value)
            } else {
                &value
            };
            println!(
                "Set {} = {}",
                key,
                if key.contains("token") || key.contains("secret") {
                    "****"
                } else {
                    display_value
                }
            );
        }
    }

    Ok(())
}
