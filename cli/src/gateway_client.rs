use crate::connection::Connection;
use serde::Serialize;
use serde_json::{json, Map, Value};

pub type GatewayResult<T> = Result<T, Box<dyn std::error::Error>>;

pub struct GatewayClient {
    conn: Connection,
}

impl GatewayClient {
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }

    pub async fn connect(url: &str, token: Option<String>) -> GatewayResult<Self> {
        let conn = Connection::connect_with_options(url, "client", None, None, |_| {}, None, token)
            .await?;

        Ok(Self::new(conn))
    }

    async fn request<TParams: Serialize>(
        &self,
        method: &'static str,
        params: Option<TParams>,
    ) -> GatewayResult<Value> {
        let params = params.map(serde_json::to_value).transpose()?;
        let response = self.conn.request(method, params).await?;

        if !response.ok {
            let message = response
                .error
                .as_ref()
                .map(|error| format!("{} (code {}): {}", method, error.code, error.message))
                .unwrap_or_else(|| format!("{} failed", method));

            return Err(message.into());
        }

        Ok(response.payload.unwrap_or_else(|| json!({})))
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub async fn heartbeat_status(&self) -> GatewayResult<Value> {
        self.request::<()>("heartbeat.status", None).await
    }

    pub async fn heartbeat_start(&self) -> GatewayResult<Value> {
        self.request::<()>("heartbeat.start", None).await
    }

    pub async fn heartbeat_trigger(&self, agent_id: String) -> GatewayResult<Value> {
        if agent_id == "main" {
            self.request::<()>("heartbeat.trigger", None).await
        } else {
            let params = json!({ "agentId": agent_id });
            self.request("heartbeat.trigger", Some(params)).await
        }
    }

    pub async fn pair_list(&self) -> GatewayResult<Value> {
        self.request::<()>("pair.list", None).await
    }

    pub async fn pair_approve(&self, channel: String, sender_id: String) -> GatewayResult<Value> {
        self.request(
            "pair.approve",
            Some(json!({
                "channel": channel,
                "senderId": sender_id,
            })),
        )
        .await
    }

    pub async fn pair_reject(&self, channel: String, sender_id: String) -> GatewayResult<Value> {
        self.request(
            "pair.reject",
            Some(json!({
                "channel": channel,
                "senderId": sender_id,
            })),
        )
        .await
    }

    pub async fn channels_list(&self) -> GatewayResult<Value> {
        self.request::<()>("channels.list", None).await
    }

    pub async fn channel_login(&self, channel: String, account_id: String) -> GatewayResult<Value> {
        self.request(
            "channel.login",
            Some(json!({
                "channel": channel,
                "accountId": account_id,
            })),
        )
        .await
    }

    pub async fn channel_status(
        &self,
        channel: String,
        account_id: String,
    ) -> GatewayResult<Value> {
        self.request(
            "channel.status",
            Some(json!({
                "channel": channel,
                "accountId": account_id,
            })),
        )
        .await
    }

    pub async fn channel_logout(
        &self,
        channel: String,
        account_id: String,
    ) -> GatewayResult<Value> {
        self.request(
            "channel.logout",
            Some(json!({
                "channel": channel,
                "accountId": account_id,
            })),
        )
        .await
    }

    pub async fn channel_stop(&self, channel: String, account_id: String) -> GatewayResult<Value> {
        self.request(
            "channel.stop",
            Some(json!({
                "channel": channel,
                "accountId": account_id,
            })),
        )
        .await
    }

    pub async fn channel_start(&self, channel: String, account_id: String) -> GatewayResult<Value> {
        self.request(
            "channel.start",
            Some(json!({
                "channel": channel,
                "accountId": account_id,
            })),
        )
        .await
    }

    pub async fn tools_list(&self) -> GatewayResult<Value> {
        self.request::<()>("tools.list", None).await
    }

    pub async fn tool_invoke(&self, tool: String, args: Value) -> GatewayResult<Value> {
        self.request("tool.invoke", Some(json!({ "tool": tool, "args": args })))
            .await
    }

    pub async fn config_get(&self, path: Option<String>) -> GatewayResult<Value> {
        match path {
            Some(path) => {
                self.request("config.get", Some(json!({ "path": path })))
                    .await
            }
            None => self.request::<()>("config.get", None).await,
        }
    }

    pub async fn config_set(&self, path: String, value: Value) -> GatewayResult<Value> {
        self.request("config.set", Some(json!({ "path": path, "value": value })))
            .await
    }

    pub async fn skills_status(&self, agent_id: String) -> GatewayResult<Value> {
        if agent_id == "main" {
            self.request::<()>("skills.status", None).await
        } else {
            self.request("skills.status", Some(json!({ "agentId": agent_id })))
                .await
        }
    }

    pub async fn skills_update(
        &self,
        agent_id: String,
        force: bool,
        timeout_ms: Option<u64>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();

        if agent_id != "main" {
            params.insert("agentId".to_string(), json!(agent_id));
        }

        if force {
            params.insert("force".to_string(), json!(true));
        }

        if let Some(timeout_ms) = timeout_ms {
            params.insert("timeoutMs".to_string(), json!(timeout_ms));
        }

        if params.is_empty() {
            self.request::<()>("skills.update", None).await
        } else {
            self.request("skills.update", Some(params)).await
        }
    }

    pub async fn sessions_list(&self, limit: i64) -> GatewayResult<Value> {
        self.request("sessions.list", Some(json!({ "limit": limit })))
            .await
    }

    pub async fn session_reset(&self, session_key: String) -> GatewayResult<Value> {
        self.request("session.reset", Some(json!({ "sessionKey": session_key })))
            .await
    }

    pub async fn session_get(&self, session_key: String) -> GatewayResult<Value> {
        self.request("session.get", Some(json!({ "sessionKey": session_key })))
            .await
    }

    pub async fn session_stats(&self, session_key: String) -> GatewayResult<Value> {
        self.request("session.stats", Some(json!({ "sessionKey": session_key })))
            .await
    }

    pub async fn session_patch(&self, patch: Value) -> GatewayResult<Value> {
        self.request("session.patch", Some(patch)).await
    }

    pub async fn session_compact(&self, session_key: String, keep: i64) -> GatewayResult<Value> {
        self.request(
            "session.compact",
            Some(json!({ "sessionKey": session_key, "keepMessages": keep })),
        )
        .await
    }

    pub async fn session_history(&self, session_key: String) -> GatewayResult<Value> {
        self.request(
            "session.history",
            Some(json!({ "sessionKey": session_key })),
        )
        .await
    }

    pub async fn session_preview(
        &self,
        session_key: String,
        limit: Option<i64>,
    ) -> GatewayResult<Value> {
        if let Some(limit) = limit {
            self.request(
                "session.preview",
                Some(json!({ "sessionKey": session_key, "limit": limit })),
            )
            .await
        } else {
            self.request(
                "session.preview",
                Some(json!({ "sessionKey": session_key })),
            )
            .await
        }
    }

    pub async fn chat_send(&self, session_key: String, message: String) -> GatewayResult<Value> {
        let run_id = uuid::Uuid::new_v4().to_string();
        self.request(
            "chat.send",
            Some(json!({
                "sessionKey": session_key,
                "message": message,
                "runId": run_id,
            })),
        )
        .await
    }
}
