use crate::connection::{ConnectOptions, Connection};
use crate::protocol::Frame;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default)]
pub struct GatewayAuth {
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
}

impl GatewayAuth {
    pub fn has_credential(&self) -> bool {
        self.password.is_some() || self.token.is_some()
    }

    pub fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        if self.has_credential() && self.username.is_none() {
            return Err("Username is required when using password/token authentication".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcSendResult {
    pub ok: bool,
    pub status: String,
    pub run_id: String,
    #[serde(default)]
    pub queued: bool,
    #[allow(dead_code)]
    pub error: Option<String>,
}

pub struct KernelClient {
    conn: Connection,
}

impl KernelClient {
    pub async fn connect_user(
        url: &str,
        auth: GatewayAuth,
        on_frame: impl Fn(Frame) + Send + Sync + 'static,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        auth.validate()?;
        let conn = Connection::connect(
            ConnectOptions {
                url: url.to_string(),
                role: "user".to_string(),
                client_id: None,
                implements: None,
                auth_username: auth.username,
                auth_password: auth.password,
                auth_token: auth.token,
            },
            on_frame,
        )
        .await?;

        Ok(Self { conn })
    }

    pub async fn connect_driver(
        url: &str,
        node_id: String,
        implements: Vec<String>,
        auth: GatewayAuth,
        on_frame: impl Fn(Frame) + Send + Sync + 'static,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        auth.validate()?;
        let conn = Connection::connect(
            ConnectOptions {
                url: url.to_string(),
                role: "driver".to_string(),
                client_id: Some(node_id),
                implements: Some(implements),
                auth_username: auth.username,
                auth_password: auth.password,
                auth_token: auth.token,
            },
            on_frame,
        )
        .await?;

        Ok(Self { conn })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn into_connection(self) -> Connection {
        self.conn
    }

    pub async fn request_ok(
        &self,
        call: &str,
        args: Option<Value>,
    ) -> Result<Value, Box<dyn std::error::Error>> {
        let response = self.conn.request(call, args).await?;
        if !response.ok {
            let message = response
                .error
                .as_ref()
                .map(|error| format!("{} (code {}): {}", call, error.code, error.message))
                .unwrap_or_else(|| format!("{} failed", call));
            return Err(message.into());
        }
        Ok(response.data.unwrap_or_else(|| json!({})))
    }

    pub async fn sys_config_get(
        &self,
        key: Option<&str>,
    ) -> Result<Value, Box<dyn std::error::Error>> {
        let args = key
            .map(|key| json!({ "key": key }))
            .unwrap_or_else(|| json!({}));
        self.request_ok("sys.config.get", Some(args)).await
    }

    pub async fn sys_config_set(
        &self,
        key: &str,
        value: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let _ = self
            .request_ok(
                "sys.config.set",
                Some(json!({
                    "key": key,
                    "value": value,
                })),
            )
            .await?;
        Ok(())
    }

    pub async fn proc_send(
        &self,
        pid: Option<&str>,
        message: &str,
    ) -> Result<ProcSendResult, Box<dyn std::error::Error>> {
        let mut args = json!({ "message": message });
        if let Some(pid) = pid {
            args["pid"] = Value::String(pid.to_string());
        }

        let payload = self.request_ok("proc.send", Some(args)).await?;
        let result: ProcSendResult = serde_json::from_value(payload)?;

        if !result.ok {
            return Err("proc.send failed".into());
        }

        Ok(result)
    }
}
