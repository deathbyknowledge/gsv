use gsv::kernel_client::{GatewayAuth, KernelClient};
use qrcode::{render::unicode, QrCode};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::cli::AdapterAction;

use super::format_unix_ms;

pub(crate) async fn run_adapter(
    url: &str,
    auth: GatewayAuth,
    action: AdapterAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    match action {
        AdapterAction::Connect {
            adapter,
            account_id,
            config_json,
        } => {
            let config = match config_json {
                Some(raw) => {
                    let parsed: Value = serde_json::from_str(&raw)
                        .map_err(|_| "--config-json must be valid JSON")?;
                    if !parsed.is_object() {
                        return Err("--config-json must be a JSON object".into());
                    }
                    parsed
                }
                None => json!({}),
            };

            let payload = client
                .request_ok(
                    "adapter.connect",
                    Some(json!({
                        "adapter": adapter,
                        "accountId": account_id,
                        "config": config,
                    })),
                )
                .await?;

            match serde_json::from_value::<AdapterConnectPayload>(payload.clone()) {
                Ok(result) => {
                    if !result.ok {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "adapter.connect failed".to_string())
                            .into());
                    }
                    print_adapter_connect(&result);
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AdapterAction::Disconnect {
            adapter,
            account_id,
        } => {
            let payload = client
                .request_ok(
                    "adapter.disconnect",
                    Some(json!({
                        "adapter": adapter,
                        "accountId": account_id,
                    })),
                )
                .await?;

            match serde_json::from_value::<AdapterDisconnectPayload>(payload.clone()) {
                Ok(result) => {
                    if !result.ok {
                        return Err(result
                            .error
                            .unwrap_or_else(|| "adapter.disconnect failed".to_string())
                            .into());
                    }
                    print_adapter_disconnect(&result);
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AdapterAction::Status {
            adapter,
            account_id,
        } => {
            let mut args = json!({ "adapter": adapter });
            if let Some(account_id) = account_id {
                args["accountId"] = json!(account_id);
            }
            let payload = client.request_ok("adapter.status", Some(args)).await?;
            match serde_json::from_value::<AdapterStatusPayload>(payload.clone()) {
                Ok(result) => {
                    print_adapter_status(&result);
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
    }

    Ok(())
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterConnectPayload {
    ok: bool,
    adapter: Option<String>,
    account_id: Option<String>,
    connected: Option<bool>,
    authenticated: Option<bool>,
    message: Option<String>,
    challenge: Option<AdapterChallengePayload>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterDisconnectPayload {
    ok: bool,
    adapter: Option<String>,
    account_id: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterStatusPayload {
    adapter: String,
    accounts: Vec<AdapterAccountStatusPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterAccountStatusPayload {
    account_id: String,
    connected: bool,
    authenticated: bool,
    mode: Option<String>,
    last_activity: Option<i64>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterChallengePayload {
    #[serde(rename = "type")]
    challenge_type: String,
    message: Option<String>,
    data: Option<String>,
    expires_at: Option<i64>,
}
fn print_adapter_connect(result: &AdapterConnectPayload) {
    let adapter = result.adapter.as_deref().unwrap_or("<unknown>");
    let account_id = result.account_id.as_deref().unwrap_or("<unknown>");
    println!(
        "Connected adapter {}:{} (connected={} authenticated={})",
        adapter,
        account_id,
        result.connected.unwrap_or(false),
        result.authenticated.unwrap_or(false),
    );
    if let Some(message) = result.message.as_deref() {
        if !message.trim().is_empty() {
            println!("message: {}", message);
        }
    }

    if let Some(challenge) = result.challenge.as_ref() {
        println!("challenge.type: {}", challenge.challenge_type);
        if let Some(message) = challenge.message.as_deref() {
            println!("challenge.message: {}", message);
        }
        if let Some(expires_at) = challenge.expires_at {
            println!("challenge.expires: {}", format_unix_ms(expires_at));
        }
        if let Some(data) = challenge.data.as_deref() {
            if challenge.challenge_type == "qr" {
                if let Some(rendered) = render_terminal_qr(data) {
                    println!("\n{}", rendered);
                } else {
                    println!("challenge.data: {}", data);
                }
            } else {
                println!("challenge.data: {}", data);
            }
        }
    }
}

fn render_terminal_qr(data: &str) -> Option<String> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Binary image/data-url challenges are adapter-specific and cannot be
    // reconstructed into QR payload text safely in the CLI.
    if trimmed.starts_with("data:") {
        return None;
    }

    let qr = QrCode::new(trimmed.as_bytes()).ok()?;
    Some(
        qr.render::<unicode::Dense1x2>()
            .quiet_zone(true)
            .dark_color(unicode::Dense1x2::Dark)
            .light_color(unicode::Dense1x2::Light)
            .build(),
    )
}

fn print_adapter_disconnect(result: &AdapterDisconnectPayload) {
    let adapter = result.adapter.as_deref().unwrap_or("<unknown>");
    let account_id = result.account_id.as_deref().unwrap_or("<unknown>");
    println!("Disconnected adapter {}:{}", adapter, account_id);
    if let Some(message) = result.message.as_deref() {
        if !message.trim().is_empty() {
            println!("message: {}", message);
        }
    }
}

fn print_adapter_status(result: &AdapterStatusPayload) {
    if result.accounts.is_empty() {
        println!("adapter={} (no accounts)", result.adapter);
        return;
    }

    for account in &result.accounts {
        println!(
            "{}:{} connected={} authenticated={} mode={} last_activity={} error={}",
            result.adapter,
            account.account_id,
            account.connected,
            account.authenticated,
            account.mode.as_deref().unwrap_or("-"),
            account
                .last_activity
                .map(format_unix_ms)
                .unwrap_or_else(|| "-".to_string()),
            account.error.as_deref().unwrap_or("-"),
        );
    }
}
