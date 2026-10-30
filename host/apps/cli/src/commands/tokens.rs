//! `gsv auth token`: hidden, kept for one release so CI and service units
//! can still get a token. Computers get theirs from pairing invitations.

use gsv::kernel_client::GatewayAuth;
use serde_json::{json, Value};

use crate::cli::TokenAction;
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Table, Tone};

fn token_state(token: &Value, now: i64) -> Cell {
    if number(token, "revokedAt").is_some() {
        Cell::new("revoked", Tone::Dim)
    } else if number(token, "expiresAt").is_some_and(|at| at <= now) {
        Cell::new("expired", Tone::Dim)
    } else {
        Cell::new("active", Tone::Good)
    }
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: TokenAction,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let style = out.style;
    match action {
        TokenAction::Create {
            kind,
            uid,
            label,
            peer,
            expires_at,
        } => {
            let mut args = json!({ "kind": kind.as_str() });
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }
            if let Some(label) = label {
                args["label"] = json!(label);
            }
            if let Some(peer) = peer {
                args["peerId"] = json!(peer);
            }
            if let Some(expires_at) = expires_at {
                args["expiresAt"] = json!(expires_at);
            }
            let result = call(&client, "sys.token.create", args).await?;
            if out.json {
                return render::print_json(&result);
            }
            let token = result.get("token").cloned().unwrap_or(Value::Null);
            let expires = number(&token, "expiresAt")
                .map(render::local_timestamp)
                .unwrap_or_else(|| "never".to_string());
            // The token prints whole on its own line: it is shown once, so no width may cut it.
            println!("{}", style.paint(Tone::Strong, text(&token, "token")));
            print!(
                "{}",
                render::detail(
                    &style,
                    &[
                        ("Id", Cell::new(text(&token, "tokenId"), Tone::Dim)),
                        ("Kind", text(&token, "kind").into()),
                        ("Peer", opt_text(&token, "peerId").unwrap_or("any").into()),
                        ("Expires", expires.into()),
                    ]
                )
            );
            print!(
                "{}",
                render::hint(&style, "Store it now; it won't be shown again.")
            );
            Ok(())
        }
        TokenAction::List { uid } => {
            let mut args = json!({});
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }
            let result = call(&client, "sys.token.list", args).await?;
            if out.json {
                return render::print_json(&result);
            }
            let tokens = items(&result, "tokens");
            if tokens.is_empty() {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        "No tokens.",
                        Some("Create one: gsv auth token create --kind service")
                    )
                );
                return Ok(());
            }
            let now = render::now_ms();
            let mut table =
                Table::new(&["Id", "Kind", "Label", "State", "Last used", "Prefix"]).flex(2);
            for token in tokens {
                table.row(vec![
                    Cell::new(text(token, "tokenId"), Tone::Accent),
                    text(token, "kind").into(),
                    opt_text(token, "label").unwrap_or("-").into(),
                    token_state(token, now),
                    Cell::new(
                        number(token, "lastUsedAt")
                            .map(|at| render::relative_time(at, now))
                            .unwrap_or_else(|| "never".to_string()),
                        Tone::Dim,
                    ),
                    Cell::new(text(token, "tokenPrefix"), Tone::Dim),
                ]);
            }
            print!(
                "{}",
                render::heading(
                    &style,
                    "Tokens",
                    Some(&render::count(tokens.len(), "token", "tokens"))
                )
            );
            print!("{}", table.render(&style));
            Ok(())
        }
        TokenAction::Revoke {
            token_id,
            reason,
            uid,
        } => {
            let mut args = json!({ "tokenId": token_id });
            if let Some(reason) = reason {
                args["reason"] = json!(reason);
            }
            if let Some(uid) = uid {
                args["uid"] = json!(uid);
            }
            let result = call(&client, "sys.token.revoke", args).await?;
            if out.json {
                render::print_json(&result)?;
            }
            if !remote::flag(&result, "revoked") {
                return Err(format!("No active token has the id {token_id}.").into());
            }
            if out.json {
                return Ok(());
            }
            println!("Revoked {token_id}.");
            Ok(())
        }
    }
}
