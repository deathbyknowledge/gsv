use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use gsv::config::CliConfig;
use gsv::connection::Connection;
use gsv::device_service;
use host_config::{ConfigError, ConfigFile};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use url::Url;
use uuid::Uuid;

const PENDING_KEY: &str = "pairing_pending";
const RECEIPT_KEY: &str = "pairing_id";
type PairResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingCode {
    version: u8,
    gateway_url: String,
    username: String,
    id: String,
    secret: String,
    target_id: String,
    label: String,
    expires_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
struct PendingPairing {
    code: String,
    credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingReceipt {
    pairing: PairedIdentity,
    token_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairedIdentity {
    id: String,
    username: String,
    target_id: String,
    state: String,
}

fn decode(code: &str) -> PairResult<PairingCode> {
    let invalid = || "Invalid GSV pairing code. Copy a new invitation from GSV.";
    let raw = code.trim();
    if raw.len() > 4096 {
        return Err(invalid().into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.strip_prefix("gsv-pair1_").ok_or_else(invalid)?)
        .map_err(|_private_error| invalid())?;
    let mut invite: PairingCode =
        serde_json::from_slice(&bytes).map_err(|_private_error| invalid())?;
    let id_valid = !invite.target_id.is_empty()
        && invite.target_id.len() <= 48
        && invite
            .target_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && invite
            .target_id
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if invite.version != 1
        || Uuid::parse_str(&invite.id).is_err()
        || !id_valid
        || invite.username.trim().is_empty()
        || invite.username.len() > 128
        || invite.label.trim().is_empty()
        || invite.label.chars().count() > 100
        || invite.label.chars().any(char::is_control)
        || invite.expires_at <= 0
        || invite.secret.len() != 64
        || !invite
            .secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid().into());
    }
    let mut gateway = Url::parse(&invite.gateway_url).map_err(|_private_error| invalid())?;
    if !gateway.username().is_empty()
        || gateway.password().is_some()
        || gateway.query().is_some()
        || gateway.fragment().is_some()
    {
        return Err(invalid().into());
    }
    let scheme = match gateway.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return Err(invalid().into()),
    };
    gateway
        .set_scheme(scheme)
        .map_err(|_private_error| invalid())?;
    gateway.set_path("/ws");
    invite.gateway_url = gateway.to_string();
    Ok(invite)
}

fn pending(config: &CliConfig) -> PairResult<Option<PendingPairing>> {
    config.device.extra.get(PENDING_KEY).cloned().map(|value| value.try_into()
        .map_err(|_private_error| "Saved pairing is unreadable. Restore the local GSV configuration before pairing.".into())).transpose()
}

fn already_paired(config: &CliConfig, invite: &PairingCode) -> bool {
    config
        .device
        .extra
        .get(RECEIPT_KEY)
        .and_then(toml::Value::as_str)
        == Some(&invite.id)
        && config.device.id.as_deref() == Some(&invite.target_id)
        && config.device.gateway_url.as_deref() == Some(&invite.gateway_url)
        && config.device.gateway_username.as_deref() == Some(&invite.username)
        && config.device.token.is_some()
}

fn pairing_config_file() -> PairResult<ConfigFile<CliConfig>> {
    let path = CliConfig::config_path().ok_or("Could not find the GSV configuration directory")?;
    Ok(ConfigFile::new(path))
}

fn update_pairing_config<T>(change: impl FnOnce(&mut CliConfig) -> PairResult<T>) -> PairResult<T> {
    Ok(pairing_config_file()?.update(|config| {
        change(config).map_err(|error| ConfigError::Io(std::io::Error::other(error.to_string())))
    })?)
}

pub(crate) async fn run_pair(
    code: Option<String>,
    workspace: Option<PathBuf>,
    no_install: bool,
) -> PairResult<()> {
    let config = pairing_config_file()?.load()?;
    let saved = pending(&config)?;
    let raw = code
        .or_else(|| saved.as_ref().map(|value| value.code.clone()))
        .ok_or("Copy an invitation from GSV and run: gsv pair CODE")?;
    let raw = raw.trim().to_string();
    let invite = decode(&raw)?;
    let workspace = workspace
        .or(config.device.workspace.clone())
        .or_else(dirs::home_dir)
        .ok_or("Could not find the home directory. Pass --workspace PATH.")?
        .canonicalize()?;
    if !workspace.is_dir() {
        return Err("The device workspace must be a directory".into());
    }

    if !already_paired(&config, &invite) {
        let prepared = update_pairing_config(|local| {
            if already_paired(local, &invite) {
                return Ok(PendingPairing {
                    code: raw.clone(),
                    credential: local
                        .device
                        .token
                        .clone()
                        .ok_or("Paired credential disappeared")?,
                });
            }
            if let Some(previous) = pending(local)? {
                if previous.code != raw {
                    return Err(
                        "Run gsv pair without a code to finish the pending pairing first.".into(),
                    );
                }
                return Ok(previous);
            }
            let value = PendingPairing {
                code: raw.clone(),
                credential: format!(
                    "gsv_machine_{}{}",
                    Uuid::new_v4().simple(),
                    Uuid::new_v4().simple()
                ),
            };
            local
                .device
                .extra
                .insert(PENDING_KEY.to_string(), toml::Value::try_from(&value)?);
            Ok(value)
        })?;
        let connection = tokio::time::timeout(
            Duration::from_secs(30),
            Connection::connect_without_handshake(&invite.gateway_url, |_| {}),
        )
        .await
        .map_err(|_elapsed| "Pairing connection timed out. Run gsv pair to retry.")??;
        let response = connection
            .request_with_timeout(
                "sys.pair.redeem",
                Some(json!({
                    "id": invite.id, "secret": invite.secret, "credential": prepared.credential,
                })),
                Duration::from_secs(30),
            )
            .await?;
        drop(connection);
        if !response.ok {
            if let Some(error) = response.error {
                let refused = error
                    .details
                    .as_ref()
                    .and_then(|value| value.get("pairing"))
                    .and_then(serde_json::Value::as_str);
                if matches!(
                    refused,
                    Some("expired" | "cancelled" | "used" | "unavailable")
                ) {
                    update_pairing_config(|local| {
                        if pending(local)?.is_some_and(|value| {
                            value.code == raw && value.credential == prepared.credential
                        }) {
                            local.device.extra.remove(PENDING_KEY);
                        }
                        Ok(())
                    })?;
                }
                return Err(format!("Pairing failed: {}", error.message).into());
            }
            return Err("Pairing failed. Run gsv pair to retry.".into());
        }
        let receipt: PairingReceipt =
            serde_json::from_value(response.data.ok_or("Pairing returned no receipt")?).map_err(
                |_private_error| "GSV returned an invalid pairing receipt. Run gsv pair to retry.",
            )?;
        if receipt.pairing.id != invite.id
            || receipt.pairing.username != invite.username
            || receipt.pairing.target_id != invite.target_id
            || receipt.pairing.state != "paired"
            || receipt.token_id.is_empty()
        {
            return Err("GSV returned a different pairing identity".into());
        }
        update_pairing_config(|local| {
            if already_paired(local, &invite) {
                return Ok(());
            }
            if !pending(local)?
                .is_some_and(|value| value.code == raw && value.credential == prepared.credential)
            {
                return Err(
                    "Local pairing changed while connecting. Retry the original invitation.".into(),
                );
            }
            if local.gateway.url.as_deref() != Some(&invite.gateway_url)
                || local.gateway.username.as_deref() != Some(&invite.username)
            {
                local.gateway.token = None;
                local.gateway.session_token = None;
                local.gateway.session_token_id = None;
                local.gateway.session_expires_at = None;
            }
            local.gateway.url = Some(invite.gateway_url.clone());
            local.gateway.username = Some(invite.username.clone());
            local.device.id = Some(invite.target_id.clone());
            local.device.label = Some(invite.label.clone());
            local.device.gateway_url = Some(invite.gateway_url.clone());
            local.device.gateway_username = Some(invite.username.clone());
            local.device.token = Some(prepared.credential.clone());
            local.device.workspace = Some(workspace.clone());
            local.device.extra.remove(PENDING_KEY);
            local.device.extra.insert(
                RECEIPT_KEY.to_string(),
                toml::Value::String(invite.id.clone()),
            );
            Ok(())
        })?;
    }

    update_pairing_config(|local| {
        if !already_paired(local, &invite) {
            return Err("Device pairing changed before service installation".into());
        }
        local.device.workspace = Some(workspace.clone());
        Ok(())
    })?;
    println!("Paired {} as {}.", invite.label, invite.target_id);
    if !no_install {
        let installed = device_service::device_service_is_installed()?;
        device_service::install_device_service().map_err(|_private_error| "Pairing is saved, but service installation failed. Fix the service setup and run gsv daemon install to retry.")?;
        if installed {
            device_service::restart_device_service()?;
        }
        println!("The GSV background service is running.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(value: serde_json::Value) -> String {
        format!("gsv-pair1_{}", URL_SAFE_NO_PAD.encode(value.to_string()))
    }
    fn payload() -> serde_json::Value {
        json!({ "version": 1, "gatewayUrl": "https://fixture.example", "username": "human", "id": Uuid::new_v4().to_string(),
        "secret": "a".repeat(64), "targetId": "my-macbook", "label": "My macbook", "expiresAt": 1_900_000_000_000_i64 })
    }

    #[test]
    fn decodes_one_payload_and_normalizes_the_gateway() {
        let invite = decode(&code(payload())).expect("valid fixture code");
        assert_eq!(invite.gateway_url, "wss://fixture.example/ws");
        assert_eq!(invite.target_id, "my-macbook");
        assert_eq!(invite.label, "My macbook");
    }

    #[test]
    fn rejects_invalid_authorities_identifiers_and_secrets_without_echoing_them() {
        for (key, value) in [
            ("gatewayUrl", "https://user:password@fixture.example"),
            ("gatewayUrl", "file:///tmp/test"),
            ("targetId", "../wrong"),
            ("secret", "private-invalid-secret"),
            ("label", "control\ntext"),
        ] {
            let mut input = payload();
            input[key] = json!(value);
            let result = decode(&code(input));
            assert!(result.is_err());
            if let Err(error) = result {
                assert!(!error.to_string().contains(value));
            }
        }
    }

    #[test]
    fn a_saved_receipt_is_scoped_to_the_gateway_account_and_target() {
        let invite = decode(&code(payload())).expect("valid fixture code");
        let mut config = CliConfig::default();
        config.device.id = Some(invite.target_id.clone());
        config.device.token = Some("synthetic".to_string());
        config.device.gateway_url = Some(invite.gateway_url.clone());
        config.device.gateway_username = Some(invite.username.clone());
        config.device.extra.insert(
            RECEIPT_KEY.to_string(),
            toml::Value::String(invite.id.clone()),
        );
        assert!(already_paired(&config, &invite));
        config.device.gateway_username = Some("other".to_string());
        assert!(!already_paired(&config, &invite));
    }
}
