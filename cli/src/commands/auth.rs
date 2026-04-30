use chrono::Utc;
use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde::Deserialize;
use serde_json::json;

use crate::cli::{AuthAction, AuthTokenAction};

use super::format_unix_ms;

pub(crate) async fn run_auth(
    url: &str,
    auth: GatewayAuth,
    action: AuthAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    match action {
        AuthAction::Login { .. } => {
            return Err("auth login is handled directly by the CLI entrypoint".into());
        }
        AuthAction::Logout => {
            return Err("auth logout is handled directly by the CLI entrypoint".into());
        }
        AuthAction::Setup { .. } => {
            return Err("auth setup does not use an authenticated kernel session".into());
        }
        AuthAction::Link {
            code,
            adapter,
            account_id,
            actor_id,
            uid,
        } => {
            let has_manual =
                adapter.is_some() || account_id.is_some() || actor_id.is_some() || uid.is_some();
            if code.is_some() && has_manual {
                return Err(
                    "auth link: either provide one-time code OR --adapter/--account-id/--actor-id"
                        .into(),
                );
            }

            if let Some(code) = code {
                let payload = client
                    .request_ok("sys.link.consume", Some(json!({ "code": code })))
                    .await?;
                match serde_json::from_value::<SysLinkConsumePayload>(payload.clone()) {
                    Ok(result) => {
                        if result.linked {
                            if let Some(link) = result.link {
                                println!(
                                    "Linked {}:{}:{} -> uid {}",
                                    link.adapter, link.account_id, link.actor_id, link.uid
                                );
                            } else {
                                println!("linked");
                            }
                        } else {
                            println!("not linked");
                        }
                    }
                    Err(_) => {
                        println!("{}", serde_json::to_string_pretty(&payload)?);
                    }
                }
                return Ok(());
            }

            let adapter = adapter.ok_or("auth link requires --adapter")?;
            let account_id = account_id.ok_or("auth link requires --account-id")?;
            let actor_id = actor_id.ok_or("auth link requires --actor-id")?;

            let mut args = json!({
                "adapter": adapter,
                "accountId": account_id,
                "actorId": actor_id,
            });
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }

            let payload = client.request_ok("sys.link", Some(args)).await?;
            match serde_json::from_value::<SysLinkConsumePayload>(payload.clone()) {
                Ok(result) => {
                    if result.linked {
                        if let Some(link) = result.link {
                            println!(
                                "Linked {}:{}:{} -> uid {}",
                                link.adapter, link.account_id, link.actor_id, link.uid
                            );
                        } else {
                            println!("linked");
                        }
                    } else {
                        println!("not linked");
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AuthAction::LinkList { uid } => {
            let mut args = json!({});
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }
            let payload = client.request_ok("sys.link.list", Some(args)).await?;
            match serde_json::from_value::<SysLinkListPayload>(payload.clone()) {
                Ok(result) => {
                    if result.links.is_empty() {
                        println!("(no links)");
                    } else {
                        print_link_list(&result.links);
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AuthAction::Unlink {
            adapter,
            account_id,
            actor_id,
        } => {
            let payload = client
                .request_ok(
                    "sys.unlink",
                    Some(json!({
                        "adapter": adapter,
                        "accountId": account_id,
                        "actorId": actor_id,
                    })),
                )
                .await?;
            match serde_json::from_value::<SysUnlinkPayload>(payload.clone()) {
                Ok(result) => {
                    if result.removed {
                        println!("unlinked");
                    } else {
                        println!("not found");
                    }
                }
                Err(_) => println!("{}", serde_json::to_string_pretty(&payload)?),
            }
        }
        AuthAction::Token { action } => match action {
            AuthTokenAction::Create {
                kind,
                uid,
                label,
                role,
                device,
                expires_at,
            } => {
                let mut args = json!({
                    "kind": kind.as_str(),
                });
                if let Some(uid) = uid {
                    args["uid"] = json!(uid);
                }
                if let Some(label) = label {
                    args["label"] = json!(label);
                }
                if let Some(role) = role {
                    args["allowedRole"] = json!(role.as_str());
                }
                if let Some(device) = device {
                    args["allowedDeviceId"] = json!(device);
                }
                if let Some(expires_at) = expires_at {
                    args["expiresAt"] = json!(expires_at);
                }
                let payload = client.request_ok("sys.token.create", Some(args)).await?;
                match serde_json::from_value::<SysTokenCreatePayload>(payload.clone()) {
                    Ok(result) => {
                        print_token_create(&result.token);
                    }
                    Err(_) => {
                        println!("{}", serde_json::to_string_pretty(&payload)?);
                    }
                }
            }
            AuthTokenAction::List { uid } => {
                let mut args = json!({});
                if let Some(uid) = uid {
                    args["uid"] = json!(uid);
                }
                let payload = client.request_ok("sys.token.list", Some(args)).await?;
                match serde_json::from_value::<SysTokenListPayload>(payload.clone()) {
                    Ok(result) => {
                        print_token_list(&result.tokens);
                    }
                    Err(_) => {
                        println!("{}", serde_json::to_string_pretty(&payload)?);
                    }
                }
            }
            AuthTokenAction::Revoke {
                token_id,
                reason,
                uid,
            } => {
                let mut args = json!({
                    "tokenId": token_id,
                });
                if let Some(reason) = reason {
                    args["reason"] = json!(reason);
                }
                if let Some(uid) = uid {
                    args["uid"] = json!(uid);
                }
                let payload = client.request_ok("sys.token.revoke", Some(args)).await?;
                match serde_json::from_value::<SysTokenRevokePayload>(payload.clone()) {
                    Ok(result) => {
                        if result.revoked {
                            println!("revoked");
                        } else {
                            println!("not found");
                        }
                    }
                    Err(_) => {
                        println!("{}", serde_json::to_string_pretty(&payload)?);
                    }
                }
            }
        },
    }

    Ok(())
}
#[derive(Debug, Deserialize)]
struct SysTokenCreatePayload {
    token: SysTokenIssuedPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysTokenIssuedPayload {
    token_id: String,
    token: String,
    token_prefix: String,
    uid: u32,
    kind: String,
    label: Option<String>,
    allowed_role: Option<String>,
    allowed_device_id: Option<String>,
    created_at: i64,
    expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SysTokenListPayload {
    tokens: Vec<SysTokenRecordPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysTokenRecordPayload {
    token_id: String,
    uid: u32,
    kind: String,
    label: Option<String>,
    token_prefix: String,
    allowed_role: Option<String>,
    allowed_device_id: Option<String>,
    created_at: i64,
    last_used_at: Option<i64>,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
    revoked_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SysTokenRevokePayload {
    revoked: bool,
}

#[derive(Debug, Deserialize)]
struct SysLinkConsumePayload {
    linked: bool,
    link: Option<SysLinkPayload>,
}

#[derive(Debug, Deserialize)]
struct SysLinkListPayload {
    links: Vec<SysLinkPayload>,
}

#[derive(Debug, Deserialize)]
struct SysUnlinkPayload {
    removed: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SysLinkPayload {
    adapter: String,
    account_id: String,
    actor_id: String,
    uid: u32,
    created_at: Option<i64>,
    linked_by_uid: Option<u32>,
}
fn print_token_create(token: &SysTokenIssuedPayload) {
    println!("Token created.");
    println!("id: {}", token.token_id);
    println!("prefix: {}", token.token_prefix);
    println!("uid: {}", token.uid);
    println!("kind: {}", token.kind);
    println!(
        "role: {}",
        token.allowed_role.as_deref().unwrap_or("<none>")
    );
    println!(
        "device: {}",
        token.allowed_device_id.as_deref().unwrap_or("<none>")
    );
    println!("label: {}", token.label.as_deref().unwrap_or("<none>"));
    println!("created: {}", format_unix_ms(token.created_at));
    println!(
        "expires: {}",
        token
            .expires_at
            .map(format_unix_ms)
            .unwrap_or_else(|| "never".to_string())
    );
    println!("token: {}", token.token);
    println!("Store this token now; it will not be shown again.");
}

fn print_token_list(tokens: &[SysTokenRecordPayload]) {
    if tokens.is_empty() {
        println!("(no tokens)");
        return;
    }

    let now_ms = Utc::now().timestamp_millis();
    for token in tokens {
        let status = if token.revoked_at.is_some() {
            "revoked"
        } else if token
            .expires_at
            .is_some_and(|expires_at| expires_at <= now_ms)
        {
            "expired"
        } else {
            "active"
        };

        println!(
            "{} {} uid={} kind={} role={} device={} status={}",
            token.token_id,
            token.token_prefix,
            token.uid,
            token.kind,
            token.allowed_role.as_deref().unwrap_or("-"),
            token.allowed_device_id.as_deref().unwrap_or("-"),
            status
        );
        println!(
            "  label={} created={} expires={} last_used={}",
            token.label.as_deref().unwrap_or("-"),
            format_unix_ms(token.created_at),
            token
                .expires_at
                .map(format_unix_ms)
                .unwrap_or_else(|| "never".to_string()),
            token
                .last_used_at
                .map(format_unix_ms)
                .unwrap_or_else(|| "never".to_string())
        );
        if let Some(reason) = token.revoked_reason.as_deref() {
            println!("  revoked_reason={}", reason);
        }
    }
}
fn print_link_list(links: &[SysLinkPayload]) {
    for link in links {
        println!(
            "{}:{}:{} -> uid={} created={} linked_by={}",
            link.adapter,
            link.account_id,
            link.actor_id,
            link.uid,
            link.created_at
                .map(format_unix_ms)
                .unwrap_or_else(|| "-".to_string()),
            link.linked_by_uid
                .map(|uid| uid.to_string())
                .unwrap_or_else(|| "-".to_string()),
        );
    }
}
