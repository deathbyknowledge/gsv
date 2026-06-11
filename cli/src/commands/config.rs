use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde::Deserialize;
use serde_json::json;

use crate::cli::ConfigAction;

pub(crate) async fn run_config(
    url: &str,
    auth: GatewayAuth,
    action: ConfigAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    match action {
        ConfigAction::Get { key } => {
            let entries = if let Some(requested_key) = key.as_deref() {
                read_config_entries(&client, vec![config_key_to_path(requested_key)?], true).await?
            } else {
                read_config_entries(
                    &client,
                    vec!["/sys/config".to_string(), "/sys/users".to_string()],
                    false,
                )
                .await?
            };

            if entries.is_empty() {
                if key.is_some() {
                    println!("(not set)");
                } else {
                    println!("(no entries)");
                }
            } else if let Some(requested_key) = key.as_deref() {
                if entries.len() == 1 && entries[0].key == requested_key {
                    let entry = &entries[0];
                    println!("{}", display_config_value(&entry.key, &entry.value));
                } else {
                    for entry in entries {
                        println!(
                            "{} = {}",
                            entry.key,
                            display_config_value(&entry.key, &entry.value)
                        );
                    }
                }
            } else {
                for entry in entries {
                    println!(
                        "{} = {}",
                        entry.key,
                        display_config_value(&entry.key, &entry.value)
                    );
                }
            }
        }
        ConfigAction::Set { key, value } => {
            let payload = client
                .request_ok(
                    "fs.write",
                    Some(json!({
                        "path": config_key_to_path(&key)?,
                        "content": value,
                    })),
                )
                .await?;
            let result = serde_json::from_value::<FsWritePayload>(payload)?;
            if result.ok == Some(false) {
                return Err(result.error.unwrap_or_else(|| "write failed".to_string()).into());
            }
            println!("Set {}.", key);
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
struct FsReadPayload {
    ok: Option<bool>,
    content: Option<String>,
    files: Option<Vec<String>>,
    directories: Option<Vec<String>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConfigEntryPayload {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct FsWritePayload {
    ok: Option<bool>,
    error: Option<String>,
}

async fn read_config_entries(
    client: &KernelClient,
    roots: Vec<String>,
    strict_roots: bool,
) -> Result<Vec<ConfigEntryPayload>, Box<dyn std::error::Error>> {
    let mut entries = Vec::new();
    let mut stack = roots
        .into_iter()
        .map(|path| (path, strict_roots))
        .collect::<Vec<_>>();

    while let Some((path, strict)) = stack.pop() {
        let payload = client
            .request_ok("fs.read", Some(json!({ "path": path })))
            .await?;
        let result = serde_json::from_value::<FsReadPayload>(payload)?;
        if result.ok == Some(false) {
            let error = result.error.unwrap_or_else(|| "read failed".to_string());
            if strict && is_missing_config_read_error(&error) {
                continue;
            }
            if strict {
                return Err(error.into());
            }
            continue;
        }

        if let Some(content) = result.content {
            if let Some(key) = config_path_to_key(&path) {
                entries.push(ConfigEntryPayload {
                    key,
                    value: strip_read_text(&content),
                });
            }
            continue;
        }

        for name in result.files.unwrap_or_default() {
            stack.push((join_path(&path, &name), false));
        }
        for name in result.directories.unwrap_or_default() {
            stack.push((join_path(&path, &name), false));
        }
    }

    entries.sort_by(|left, right| left.key.cmp(&right.key));
    Ok(entries)
}

fn config_key_to_path(key: &str) -> Result<String, Box<dyn std::error::Error>> {
    let normalized = key.trim().trim_start_matches('/');
    if let Some(rest) = normalized.strip_prefix("config/") {
        return Ok(format!("/sys/config/{}", rest));
    }
    if let Some(rest) = normalized.strip_prefix("users/") {
        return Ok(format!("/sys/users/{}", rest));
    }
    if normalized.starts_with("sys/config/") || normalized.starts_with("sys/users/") {
        return Ok(format!("/{}", normalized));
    }
    Err(format!("Unsupported remote config key: {}", key).into())
}

fn config_path_to_key(path: &str) -> Option<String> {
    path.strip_prefix("/sys/config/")
        .map(|rest| format!("config/{}", rest))
        .or_else(|| {
            path.strip_prefix("/sys/users/")
                .map(|rest| format!("users/{}", rest))
        })
}

fn join_path(parent: &str, child: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), child)
}

fn strip_read_text(content: &str) -> String {
    content
        .split('\n')
        .map(|line| {
            line.split_once('\t')
                .map(|(_, rest)| rest)
                .unwrap_or(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_missing_config_read_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("enoent") ||
        lower.contains("not found") ||
        lower.contains("no such file or directory") ||
        lower.contains("no such config key namespace")
}

fn display_config_value(key: &str, value: &str) -> String {
    if is_sensitive_config_key(key) {
        mask_secret(value)
    } else {
        value.to_string()
    }
}

fn is_sensitive_config_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("api_key")
        || lower.contains("access_key")
}

fn mask_secret(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= 8 {
        return "****".to_string();
    }

    let prefix = chars.iter().take(4).copied().collect::<String>();
    let suffix = chars
        .iter()
        .skip(chars.len() - 4)
        .copied()
        .collect::<String>();
    format!("{}...{}", prefix, suffix)
}
