use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth_flow::{can_prompt_interactively, prompt_secret};
use crate::cli::UserAction;

pub(crate) fn resolve_new_user_password(
    password: Option<String>,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut password = password.filter(|value| !value.is_empty());
    if password.is_none() && can_prompt_interactively() {
        password = prompt_secret("New user password (min 8 chars)")?;
    }

    password.ok_or_else(|| {
        "New user password required (pass --new-password or run interactively)".into()
    })
}

pub(crate) async fn run_user(
    url: &str,
    auth: GatewayAuth,
    action: UserAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    let payload = match action {
        UserAction::Create {
            username,
            new_password,
        } => {
            let password = new_password.ok_or("New user password is required")?;
            client
                .request_ok(
                    "user.admin",
                    Some(json!({
                        "action": "create",
                        "username": username,
                        "password": password,
                    })),
                )
                .await?
        }
        UserAction::Permissions {
            username,
            grant,
            revoke,
            add_groups,
            remove_groups,
        } => {
            client
                .request_ok(
                    "user.admin",
                    Some(json!({
                        "action": "permissions",
                        "username": username,
                        "grant": grant,
                        "revoke": revoke,
                        "addGroups": add_groups,
                        "removeGroups": remove_groups,
                    })),
                )
                .await?
        }
        UserAction::Register { .. } => {
            return Err("user register is handled directly by the CLI entrypoint".into());
        }
    };

    print_user_admin_response(payload)?;
    Ok(())
}

fn print_user_admin_response(payload: Value) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(response) = serde_json::from_value::<UserCreateResponse>(payload.clone()) {
        println!("{}", format_user_create(&response));
    } else if let Ok(response) = serde_json::from_value::<UserPermissionsResponse>(payload.clone())
    {
        println!("{}", format_user_permissions(&response));
    } else {
        println!("{}", serde_json::to_string_pretty(&payload)?);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserCreateResponse {
    account: AccountSummary,
    personal_agent: AccountSummary,
}

#[derive(Debug, Deserialize)]
struct AccountSummary {
    uid: u32,
    gid: u32,
    username: String,
    home: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserPermissionsResponse {
    user: UserSummary,
    groups: Vec<GroupSummary>,
    direct_capabilities: Vec<String>,
    effective_capabilities: Vec<String>,
    changed: bool,
}

#[derive(Debug, Deserialize)]
struct UserSummary {
    username: String,
    uid: u32,
    gid: u32,
}

#[derive(Debug, Deserialize)]
struct GroupSummary {
    name: String,
    gid: u32,
    primary: bool,
}

fn format_user_create(response: &UserCreateResponse) -> String {
    format!(
        "Created human account {} (uid {}, gid {}).\nHome: {}\nPersonal agent: {} (uid {}, gid {})",
        response.account.username,
        response.account.uid,
        response.account.gid,
        response.account.home,
        response.personal_agent.username,
        response.personal_agent.uid,
        response.personal_agent.gid,
    )
}

fn format_user_permissions(response: &UserPermissionsResponse) -> String {
    let groups = if response.groups.is_empty() {
        "(none)".to_string()
    } else {
        response
            .groups
            .iter()
            .map(|group| {
                if group.primary {
                    format!("{} ({}, primary)", group.name, group.gid)
                } else {
                    format!("{} ({})", group.name, group.gid)
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let direct = format_capabilities(&response.direct_capabilities);
    let effective = format_capabilities(&response.effective_capabilities);
    let outcome = if response.changed {
        "Permissions updated."
    } else {
        "Permissions unchanged."
    };

    format!(
        "User: {} (uid {}, gid {})\nGroups: {}\nDirect capabilities:\n{}\nEffective capabilities:\n{}\n{}",
        response.user.username,
        response.user.uid,
        response.user.gid,
        groups,
        direct,
        effective,
        outcome,
    )
}

fn format_capabilities(capabilities: &[String]) -> String {
    if capabilities.is_empty() {
        return "  (none)".to_string();
    }

    capabilities
        .iter()
        .map(|capability| format!("  {}", capability))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_an_explicit_password_verbatim() {
        assert_eq!(
            resolve_new_user_password(Some("  correct horse  ".to_string())).unwrap(),
            "  correct horse  ",
        );
    }

    #[test]
    fn parses_and_formats_create_response() {
        let response = serde_json::from_value::<UserCreateResponse>(json!({
            "action": "create",
            "account": {
                "uid": 1000,
                "gid": 1000,
                "gids": [1000, 100],
                "username": "alice",
                "home": "/home/alice",
                "cwd": "/home/alice"
            },
            "personalAgent": {
                "uid": 1001,
                "gid": 1001,
                "gids": [1001, 1000],
                "username": "alice-agent",
                "home": "/home/alice-agent",
                "cwd": "/home/alice-agent"
            }
        }))
        .expect("create response should parse");

        assert_eq!(
            format_user_create(&response),
            "Created human account alice (uid 1000, gid 1000).\n\
             Home: /home/alice\n\
             Personal agent: alice-agent (uid 1001, gid 1001)"
        );
    }

    #[test]
    fn parses_and_formats_permissions_response() {
        let response = serde_json::from_value::<UserPermissionsResponse>(json!({
            "action": "permissions",
            "user": { "username": "alice", "uid": 1000, "gid": 1000 },
            "groups": [
                { "name": "alice", "gid": 1000, "primary": true },
                { "name": "operators", "gid": 1200, "primary": false }
            ],
            "directCapabilities": ["user.admin"],
            "effectiveCapabilities": ["fs.*", "user.admin"],
            "changed": true
        }))
        .expect("permissions response should parse");

        assert_eq!(
            format_user_permissions(&response),
            "User: alice (uid 1000, gid 1000)\n\
             Groups: alice (1000, primary), operators (1200)\n\
             Direct capabilities:\n  user.admin\n\
             Effective capabilities:\n  fs.*\n  user.admin\n\
             Permissions updated."
        );
    }

    #[test]
    fn formats_empty_permission_sets() {
        let response = UserPermissionsResponse {
            user: UserSummary {
                username: "bob".to_string(),
                uid: 1002,
                gid: 1002,
            },
            groups: Vec::new(),
            direct_capabilities: Vec::new(),
            effective_capabilities: Vec::new(),
            changed: false,
        };

        let output = format_user_permissions(&response);
        assert!(output.contains("Groups: (none)"));
        assert_eq!(output.matches("  (none)").count(), 2);
        assert!(output.ends_with("Permissions unchanged."));
    }
}
