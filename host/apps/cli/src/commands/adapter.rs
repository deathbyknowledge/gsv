use std::io::IsTerminal;

use gsv::kernel_client::{cli_peer_identity, BinaryBodyLimits, GatewayAuth, KernelClient};
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
    let client = KernelClient::connect_with_peer(
        url,
        cli_peer_identity(),
        Vec::new(),
        auth,
        BinaryBodyLimits::default(),
        |_| {},
    )
    .await?;

    match action {
        AdapterAction::Connect {
            adapter,
            account_id,
            config_json,
        } => {
            let config = match config_json {
                Some(raw) => {
                    let parsed: Value = serde_json::from_str(&raw)
                        .map_err(|error| format!("--config-json must be valid JSON: {}", error))?;
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

            let result = parse_adapter_connect_payload(payload)?;
            if !result.ok {
                return Err(result
                    .error
                    .unwrap_or_else(|| "adapter.connect failed".to_string())
                    .into());
            }
            print_adapter_connect(&result);
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

            let result = parse_adapter_disconnect_payload(payload)?;
            if !result.ok {
                return Err(result
                    .error
                    .unwrap_or_else(|| "adapter.disconnect failed".to_string())
                    .into());
            }
            print_adapter_disconnect(&result);
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
            let result = parse_adapter_status_payload(payload)?;
            print_adapter_status(&result);
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
    format: Option<AdapterChallengeFormat>,
    expires_at: Option<i64>,
}

#[derive(Debug, Deserialize, Clone, Copy, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum AdapterChallengeFormat {
    Raw,
    DataUrl,
}

fn parse_adapter_connect_payload(
    payload: Value,
) -> Result<AdapterConnectPayload, Box<dyn std::error::Error>> {
    let result: AdapterConnectPayload = serde_json::from_value(payload)
        .map_err(|_error| "adapter.connect returned an invalid response shape")?;
    let challenge_valid = result.challenge.as_ref().is_none_or(|challenge| {
        !challenge.challenge_type.trim().is_empty()
            && (challenge.challenge_type != "qr"
                || challenge
                    .data
                    .as_deref()
                    .is_some_and(|data| !data.is_empty()))
    });
    let shape_valid = if result.ok {
        result
            .adapter
            .as_deref()
            .is_some_and(|adapter| !adapter.trim().is_empty())
            && result
                .account_id
                .as_deref()
                .is_some_and(|account_id| !account_id.trim().is_empty())
            && result.connected.is_some()
            && result.authenticated.is_some()
            && result.error.is_none()
            && challenge_valid
    } else {
        result
            .error
            .as_deref()
            .is_some_and(|error| !error.trim().is_empty())
            && challenge_valid
    };
    if !shape_valid {
        return Err("adapter.connect returned an invalid response shape".into());
    }
    Ok(result)
}

fn parse_adapter_disconnect_payload(
    payload: Value,
) -> Result<AdapterDisconnectPayload, Box<dyn std::error::Error>> {
    let result: AdapterDisconnectPayload = serde_json::from_value(payload)
        .map_err(|_error| "adapter.disconnect returned an invalid response shape")?;
    let valid = if result.ok {
        result
            .adapter
            .as_deref()
            .is_some_and(|adapter| !adapter.trim().is_empty())
            && result
                .account_id
                .as_deref()
                .is_some_and(|account_id| !account_id.trim().is_empty())
            && result.error.is_none()
    } else {
        result
            .error
            .as_deref()
            .is_some_and(|error| !error.trim().is_empty())
    };
    if !valid {
        return Err("adapter.disconnect returned an invalid response shape".into());
    }
    Ok(result)
}

fn parse_adapter_status_payload(
    payload: Value,
) -> Result<AdapterStatusPayload, Box<dyn std::error::Error>> {
    let result: AdapterStatusPayload = serde_json::from_value(payload)
        .map_err(|_error| "adapter.status returned an invalid response shape")?;
    if result.adapter.trim().is_empty()
        || result
            .accounts
            .iter()
            .any(|account| account.account_id.trim().is_empty())
    {
        return Err("adapter.status returned an invalid response shape".into());
    }
    Ok(result)
}

fn print_adapter_connect(result: &AdapterConnectPayload) {
    let adapter = result.adapter.as_deref().unwrap_or("<unknown>");
    let account_id = result.account_id.as_deref().unwrap_or("<unknown>");
    println!(
        "Adapter {}:{} connected={} authenticated={}",
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
                if let Some(rendered) =
                    render_qr_challenge(challenge, data, std::io::stdout().is_terminal())
                {
                    println!("\n{}", rendered);
                } else {
                    eprintln!(
                        "Unable to render the QR challenge safely; its private pairing payload was hidden. Retry in an interactive UTF-8 terminal or use the web UI."
                    );
                }
            } else {
                println!("challenge.data: available (hidden)");
            }
        }
    }
}

fn render_qr_challenge(
    challenge: &AdapterChallengePayload,
    data: &str,
    output_is_terminal: bool,
) -> Option<String> {
    if !output_is_terminal {
        return None;
    }

    match challenge.format {
        Some(AdapterChallengeFormat::DataUrl) => None,
        Some(AdapterChallengeFormat::Raw) => render_terminal_qr(data),
        None => {
            // Compatibility for older adapters that predate explicit challenge
            // formats. New responses must set `format` at the protocol boundary.
            if data.trim().starts_with("data:") {
                None
            } else {
                render_terminal_qr(data)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn qr_challenge(format: Option<AdapterChallengeFormat>) -> AdapterChallengePayload {
        AdapterChallengePayload {
            challenge_type: "qr".to_string(),
            message: None,
            data: None,
            format,
            expires_at: None,
        }
    }

    #[test]
    fn qr_rendering_respects_explicit_and_legacy_formats() {
        let raw = qr_challenge(Some(AdapterChallengeFormat::Raw));
        assert!(render_qr_challenge(&raw, "private-pairing-payload", true).is_some());
        assert!(render_qr_challenge(&raw, "private-pairing-payload", false).is_none());

        let image = qr_challenge(Some(AdapterChallengeFormat::DataUrl));
        assert!(render_qr_challenge(&image, "private-pairing-payload", true).is_none());

        let legacy = qr_challenge(None);
        assert!(render_qr_challenge(&legacy, "data:image/png;base64,cHJpdmF0ZQ==", true).is_none());
        assert!(render_qr_challenge(&legacy, "", true).is_none());
    }

    #[test]
    fn malformed_connect_payload_error_never_echoes_challenge_data() {
        let private_payload = "private-pairing-payload-must-not-leak";
        let error = parse_adapter_connect_payload(json!({
            "ok": "not-a-boolean",
            "challenge": {
                "type": "qr",
                "data": private_payload,
                "format": "raw"
            }
        }))
        .unwrap_err()
        .to_string();

        assert_eq!(error, "adapter.connect returned an invalid response shape");
        assert!(!error.contains(private_payload));
    }

    #[test]
    fn connect_payload_validation_matches_the_public_protocol_union() {
        for invalid in [
            json!({
                "ok": true,
                "accountId": "default",
                "connected": true,
                "authenticated": true
            }),
            json!({
                "ok": true,
                "adapter": "whatsapp",
                "accountId": "default",
                "connected": true
            }),
            json!({ "ok": false, "error": "" }),
            json!({
                "ok": true,
                "adapter": "whatsapp",
                "accountId": "default",
                "connected": false,
                "authenticated": false,
                "challenge": { "type": "qr", "format": "raw" }
            }),
        ] {
            assert_eq!(
                parse_adapter_connect_payload(invalid)
                    .unwrap_err()
                    .to_string(),
                "adapter.connect returned an invalid response shape"
            );
        }

        parse_adapter_connect_payload(json!({
            "ok": true,
            "adapter": "whatsapp",
            "accountId": "default",
            "connected": false,
            "authenticated": false,
            "challenge": { "type": "qr", "data": "secret", "format": "raw" }
        }))
        .unwrap();
    }

    #[test]
    fn malformed_disconnect_and_status_payloads_are_not_echoed() {
        let private_payload = "private-worker-payload-must-not-leak";
        let disconnect_error = parse_adapter_disconnect_payload(json!({
            "ok": "invalid",
            "privatePayload": private_payload,
        }))
        .unwrap_err()
        .to_string();
        let status_error = parse_adapter_status_payload(json!({
            "adapter": "whatsapp",
            "accounts": [{ "accountId": "", "privatePayload": private_payload }],
        }))
        .unwrap_err()
        .to_string();

        assert_eq!(
            disconnect_error,
            "adapter.disconnect returned an invalid response shape",
        );
        assert_eq!(
            status_error,
            "adapter.status returned an invalid response shape"
        );
        assert!(!disconnect_error.contains(private_payload));
        assert!(!status_error.contains(private_payload));
    }
}
