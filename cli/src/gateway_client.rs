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

    pub async fn principal_profile_get(&self, principal_id: String) -> GatewayResult<Value> {
        self.request(
            "principal.profile.get",
            Some(json!({
                "principalId": principal_id,
            })),
        )
        .await
    }

    pub async fn principal_profile_list(
        &self,
        offset: Option<i64>,
        limit: Option<i64>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        if let Some(offset) = offset {
            params.insert("offset".to_string(), json!(offset));
        }
        if let Some(limit) = limit {
            params.insert("limit".to_string(), json!(limit));
        }

        if params.is_empty() {
            self.request::<()>("principal.profile.list", None).await
        } else {
            self.request("principal.profile.list", Some(params)).await
        }
    }

    pub async fn principal_profile_put(
        &self,
        principal_id: String,
        home_space_id: String,
        home_agent_id: Option<String>,
        status: Option<String>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        params.insert("principalId".to_string(), json!(principal_id));
        params.insert("homeSpaceId".to_string(), json!(home_space_id));
        if let Some(home_agent_id) = home_agent_id {
            params.insert("homeAgentId".to_string(), json!(home_agent_id));
        }
        if let Some(status) = status {
            params.insert("status".to_string(), json!(status));
        }

        self.request("principal.profile.put", Some(params)).await
    }

    pub async fn principal_profile_delete(&self, principal_id: String) -> GatewayResult<Value> {
        self.request(
            "principal.profile.delete",
            Some(json!({
                "principalId": principal_id,
            })),
        )
        .await
    }

    pub async fn space_members_list(
        &self,
        space_id: Option<String>,
        offset: Option<i64>,
        limit: Option<i64>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        if let Some(space_id) = space_id {
            params.insert("spaceId".to_string(), json!(space_id));
        }
        if let Some(offset) = offset {
            params.insert("offset".to_string(), json!(offset));
        }
        if let Some(limit) = limit {
            params.insert("limit".to_string(), json!(limit));
        }

        if params.is_empty() {
            self.request::<()>("space.members.list", None).await
        } else {
            self.request("space.members.list", Some(params)).await
        }
    }

    pub async fn space_member_put(
        &self,
        space_id: String,
        principal_id: String,
        role: String,
    ) -> GatewayResult<Value> {
        self.request(
            "space.member.put",
            Some(json!({
                "spaceId": space_id,
                "principalId": principal_id,
                "role": role,
            })),
        )
        .await
    }

    pub async fn space_member_remove(
        &self,
        space_id: String,
        principal_id: String,
    ) -> GatewayResult<Value> {
        self.request(
            "space.member.remove",
            Some(json!({
                "spaceId": space_id,
                "principalId": principal_id,
            })),
        )
        .await
    }

    pub async fn conversation_bindings_list(
        &self,
        offset: Option<i64>,
        limit: Option<i64>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        if let Some(offset) = offset {
            params.insert("offset".to_string(), json!(offset));
        }
        if let Some(limit) = limit {
            params.insert("limit".to_string(), json!(limit));
        }

        if params.is_empty() {
            self.request::<()>("conversation.bindings.list", None).await
        } else {
            self.request("conversation.bindings.list", Some(params))
                .await
        }
    }

    pub async fn conversation_binding_put(
        &self,
        surface_id: String,
        space_id: String,
        agent_id: Option<String>,
        group_mode: Option<String>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        params.insert("surfaceId".to_string(), json!(surface_id));
        params.insert("spaceId".to_string(), json!(space_id));
        if let Some(agent_id) = agent_id {
            params.insert("agentId".to_string(), json!(agent_id));
        }
        if let Some(group_mode) = group_mode {
            params.insert("groupMode".to_string(), json!(group_mode));
        }

        self.request("conversation.binding.put", Some(params)).await
    }

    pub async fn conversation_binding_remove(&self, surface_id: String) -> GatewayResult<Value> {
        self.request(
            "conversation.binding.remove",
            Some(json!({
                "surfaceId": surface_id,
            })),
        )
        .await
    }

    pub async fn pending_bindings_list(&self) -> GatewayResult<Value> {
        self.request::<()>("pending.bindings.list", None).await
    }

    pub async fn pending_binding_resolve(
        &self,
        channel: String,
        sender_id: String,
        action: String,
        account_id: Option<String>,
        principal_id: Option<String>,
        home_space_id: Option<String>,
        home_agent_id: Option<String>,
        role: Option<String>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        params.insert("channel".to_string(), json!(channel));
        params.insert("senderId".to_string(), json!(sender_id));
        params.insert("action".to_string(), json!(action));
        if let Some(account_id) = account_id {
            params.insert("accountId".to_string(), json!(account_id));
        }
        if let Some(principal_id) = principal_id {
            params.insert("principalId".to_string(), json!(principal_id));
        }
        if let Some(home_space_id) = home_space_id {
            params.insert("homeSpaceId".to_string(), json!(home_space_id));
        }
        if let Some(home_agent_id) = home_agent_id {
            params.insert("homeAgentId".to_string(), json!(home_agent_id));
        }
        if let Some(role) = role {
            params.insert("role".to_string(), json!(role));
        }

        self.request("pending.binding.resolve", Some(params)).await
    }

    pub async fn invite_list(
        &self,
        offset: Option<i64>,
        limit: Option<i64>,
        include_inactive: Option<bool>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        if let Some(offset) = offset {
            params.insert("offset".to_string(), json!(offset));
        }
        if let Some(limit) = limit {
            params.insert("limit".to_string(), json!(limit));
        }
        if let Some(include_inactive) = include_inactive {
            params.insert("includeInactive".to_string(), json!(include_inactive));
        }

        if params.is_empty() {
            self.request::<()>("invite.list", None).await
        } else {
            self.request("invite.list", Some(params)).await
        }
    }

    pub async fn invite_create(
        &self,
        home_space_id: String,
        code: Option<String>,
        home_agent_id: Option<String>,
        role: Option<String>,
        principal_id: Option<String>,
        ttl_minutes: Option<i64>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        params.insert("homeSpaceId".to_string(), json!(home_space_id));
        if let Some(code) = code {
            params.insert("code".to_string(), json!(code));
        }
        if let Some(home_agent_id) = home_agent_id {
            params.insert("homeAgentId".to_string(), json!(home_agent_id));
        }
        if let Some(role) = role {
            params.insert("role".to_string(), json!(role));
        }
        if let Some(principal_id) = principal_id {
            params.insert("principalId".to_string(), json!(principal_id));
        }
        if let Some(ttl_minutes) = ttl_minutes {
            params.insert("ttlMinutes".to_string(), json!(ttl_minutes));
        }
        self.request("invite.create", Some(params)).await
    }

    pub async fn invite_revoke(&self, invite_id: String) -> GatewayResult<Value> {
        self.request(
            "invite.revoke",
            Some(json!({
                "inviteId": invite_id,
            })),
        )
        .await
    }

    pub async fn invite_claim(
        &self,
        code: String,
        principal_id: Option<String>,
        channel: Option<String>,
        account_id: Option<String>,
        sender_id: Option<String>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        params.insert("code".to_string(), json!(code));
        if let Some(principal_id) = principal_id {
            params.insert("principalId".to_string(), json!(principal_id));
        }
        if let Some(channel) = channel {
            params.insert("channel".to_string(), json!(channel));
        }
        if let Some(account_id) = account_id {
            params.insert("accountId".to_string(), json!(account_id));
        }
        if let Some(sender_id) = sender_id {
            params.insert("senderId".to_string(), json!(sender_id));
        }
        self.request("invite.claim", Some(params)).await
    }

    pub async fn registry_backfill(
        &self,
        dry_run: Option<bool>,
        limit: Option<i64>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        if let Some(dry_run) = dry_run {
            params.insert("dryRun".to_string(), json!(dry_run));
        }
        if let Some(limit) = limit {
            params.insert("limit".to_string(), json!(limit));
        }

        if params.is_empty() {
            self.request::<()>("registry.backfill", None).await
        } else {
            self.request("registry.backfill", Some(params)).await
        }
    }

    pub async fn registry_repair(
        &self,
        dry_run: Option<bool>,
        prune_dangling_routes: Option<bool>,
        prune_dangling_legacy_index: Option<bool>,
    ) -> GatewayResult<Value> {
        let mut params = Map::new();
        if let Some(dry_run) = dry_run {
            params.insert("dryRun".to_string(), json!(dry_run));
        }
        if let Some(prune_dangling_routes) = prune_dangling_routes {
            params.insert(
                "pruneDanglingRoutes".to_string(),
                json!(prune_dangling_routes),
            );
        }
        if let Some(prune_dangling_legacy_index) = prune_dangling_legacy_index {
            params.insert(
                "pruneDanglingLegacyIndex".to_string(),
                json!(prune_dangling_legacy_index),
            );
        }

        if params.is_empty() {
            self.request::<()>("registry.repair", None).await
        } else {
            self.request("registry.repair", Some(params)).await
        }
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

    pub async fn skills_update(&self, agent_id: String) -> GatewayResult<Value> {
        let mut params = Map::new();

        if agent_id != "main" {
            params.insert("agentId".to_string(), json!(agent_id));
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

    fn build_session_target_params(
        session_key: Option<String>,
        thread_ref: Option<String>,
    ) -> GatewayResult<Map<String, Value>> {
        let mut params = Map::new();
        if let Some(session_key) = session_key {
            params.insert("sessionKey".to_string(), json!(session_key));
        }
        if let Some(thread_ref) = thread_ref {
            params.insert("threadRef".to_string(), json!(thread_ref));
        }

        if params.is_empty() {
            return Err("sessionKey or threadRef required".into());
        }

        Ok(params)
    }

    pub async fn session_reset(
        &self,
        session_key: Option<String>,
        thread_ref: Option<String>,
    ) -> GatewayResult<Value> {
        let params = Self::build_session_target_params(session_key, thread_ref)?;
        self.request("session.reset", Some(params)).await
    }

    pub async fn session_get(
        &self,
        session_key: Option<String>,
        thread_ref: Option<String>,
    ) -> GatewayResult<Value> {
        let params = Self::build_session_target_params(session_key, thread_ref)?;
        self.request("session.get", Some(params)).await
    }

    pub async fn session_stats(
        &self,
        session_key: Option<String>,
        thread_ref: Option<String>,
    ) -> GatewayResult<Value> {
        let params = Self::build_session_target_params(session_key, thread_ref)?;
        self.request("session.stats", Some(params)).await
    }

    pub async fn session_patch(&self, patch: Value) -> GatewayResult<Value> {
        self.request("session.patch", Some(patch)).await
    }

    pub async fn session_compact(
        &self,
        session_key: Option<String>,
        thread_ref: Option<String>,
        keep: i64,
    ) -> GatewayResult<Value> {
        let mut params = Self::build_session_target_params(session_key, thread_ref)?;
        params.insert("keepMessages".to_string(), json!(keep));
        self.request("session.compact", Some(params)).await
    }

    pub async fn session_history(
        &self,
        session_key: Option<String>,
        thread_ref: Option<String>,
    ) -> GatewayResult<Value> {
        let params = Self::build_session_target_params(session_key, thread_ref)?;
        self.request("session.history", Some(params)).await
    }

    pub async fn session_preview(
        &self,
        session_key: Option<String>,
        thread_ref: Option<String>,
        limit: Option<i64>,
    ) -> GatewayResult<Value> {
        let mut params = Self::build_session_target_params(session_key, thread_ref)?;
        if let Some(limit) = limit {
            params.insert("limit".to_string(), json!(limit));
        }

        self.request("session.preview", Some(params)).await
    }

    pub async fn chat_send(
        &self,
        session_key: Option<String>,
        thread_ref: Option<String>,
        message: String,
        run_id: String,
    ) -> GatewayResult<Value> {
        let mut params = Self::build_session_target_params(session_key, thread_ref)?;
        params.insert("message".to_string(), json!(message));
        params.insert("runId".to_string(), json!(run_id));

        self.request("chat.send", Some(params)).await
    }
}
