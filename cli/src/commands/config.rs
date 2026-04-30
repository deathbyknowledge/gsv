use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde::Deserialize;

use crate::cli::ConfigAction;

pub(crate) async fn run_config(
    url: &str,
    auth: GatewayAuth,
    action: ConfigAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    match action {
        ConfigAction::Get { key } => {
            let payload = client.sys_config_get(key.as_deref()).await?;
            match serde_json::from_value::<SysConfigGetPayload>(payload.clone()) {
                Ok(result) => {
                    if result.entries.is_empty() {
                        if key.is_some() {
                            println!("(not set)");
                        } else {
                            println!("(no entries)");
                        }
                    } else if let Some(requested_key) = key.as_deref() {
                        if result.entries.len() == 1 && result.entries[0].key == requested_key {
                            let entry = &result.entries[0];
                            println!("{}", display_config_value(&entry.key, &entry.value));
                        } else {
                            for entry in result.entries {
                                println!(
                                    "{} = {}",
                                    entry.key,
                                    display_config_value(&entry.key, &entry.value)
                                );
                            }
                        }
                    } else {
                        for entry in result.entries {
                            println!(
                                "{} = {}",
                                entry.key,
                                display_config_value(&entry.key, &entry.value)
                            );
                        }
                    }
                }
                Err(_) => {
                    // Schema drift fallback for debugging and compatibility.
                    println!("{}", serde_json::to_string_pretty(&payload)?);
                }
            }
        }
        ConfigAction::Set { key, value } => {
            client.sys_config_set(&key, &value).await?;
            println!("Set {}.", key);
        }
    }

    Ok(())
}
#[derive(Debug, Deserialize)]
struct SysConfigGetPayload {
    entries: Vec<SysConfigEntryPayload>,
}

#[derive(Debug, Deserialize)]
struct SysConfigEntryPayload {
    key: String,
    value: String,
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
    if value.len() > 8 {
        format!("{}...{}", &value[..4], &value[value.len() - 4..])
    } else {
        "****".to_string()
    }
}
