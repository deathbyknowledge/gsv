use gateway_client::client::GatewayAuth;
use host_config::CliConfig;

// A rejected credential is no longer a usable enrollment. Retire only the
// exact connection that failed; a concurrent pairing owns its new credential.
pub(super) async fn reject_credential(
    url: &str,
    auth: &GatewayAuth,
    device_id: &str,
) -> Result<bool, &'static str> {
    let url = url.to_owned();
    let auth = auth.clone();
    let device_id = device_id.to_owned();
    tokio::task::spawn_blocking(move || {
        CliConfig::update_if(|config| retire_credential(config, &url, &auth, &device_id))
            .map(|result| result.is_some())
            .map_err(|_| "Could not clear the rejected machine credential. Check local configuration permissions.")
    })
    .await
    .map_err(|_| "Could not reset this computer's connection.")?
}

fn retire_credential(
    config: &mut CliConfig,
    url: &str,
    auth: &GatewayAuth,
    device_id: &str,
) -> Option<()> {
    if auth.token.is_none()
        || config.device.token != auth.token
        || config.device_gateway_url() != url
        || config.device_gateway_username() != auth.username
        || config.device.id.as_deref() != Some(device_id)
    {
        return None;
    }
    config.device.token = None;
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejection_cannot_retire_another_connection_or_a_newer_credential() {
        let mut config = CliConfig::default();
        config.gateway.username = Some("cli-owner".into());
        config.gateway.session_token = Some("cli-session".into());
        config.device.id = Some("laptop".into());
        config.device.label = Some("My laptop".into());
        config.device.gateway_url = Some("wss://space.example/ws".into());
        config.device.gateway_username = Some("human".into());
        config.device.token = Some("current-credential".into());
        let auth = GatewayAuth {
            username: Some("human".into()),
            password: None,
            token: Some("current-credential".into()),
        };
        for (url, username, token, id) in [
            (
                "wss://other.example/ws",
                "human",
                "current-credential",
                "laptop",
            ),
            (
                "wss://space.example/ws",
                "other",
                "current-credential",
                "laptop",
            ),
            (
                "wss://space.example/ws",
                "human",
                "old-credential",
                "laptop",
            ),
            (
                "wss://space.example/ws",
                "human",
                "current-credential",
                "other-laptop",
            ),
        ] {
            let rejected = GatewayAuth {
                username: Some(username.into()),
                token: Some(token.into()),
                password: None,
            };
            assert!(retire_credential(&mut config, url, &rejected, id).is_none());
            assert_eq!(config.device.token, auth.token);
        }
        assert!(
            retire_credential(&mut config, "wss://space.example/ws", &auth, "laptop").is_some()
        );
        assert!(config.device.token.is_none());
        assert_eq!(config.device.label.as_deref(), Some("My laptop"));
        assert_eq!(config.gateway.username.as_deref(), Some("cli-owner"));
        assert_eq!(config.gateway.session_token.as_deref(), Some("cli-session"));
    }
}
