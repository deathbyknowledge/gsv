use crate::body::BinaryBodyLimits;
use crate::connection::{Connection, ConnectionOptions, GatewayRpcError, PeerIdentity};
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
    pub error: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ConversationFileResource {
    pub target: String,
    pub path: String,
    pub revision: String,
    pub content_type: String,
    pub size: u64,
    pub filename: String,
}

pub struct KernelClient {
    conn: Connection,
}

/// Application-neutral name for the shared gateway client. `KernelClient`
/// remains as a source-compatible alias during the host application split.
pub type GsvClient = KernelClient;

impl KernelClient {
    pub async fn connect_with_peer(
        url: &str,
        peer: PeerIdentity,
        implements: Vec<String>,
        auth: GatewayAuth,
        limits: BinaryBodyLimits,
        on_frame: impl Fn(Frame) + Send + Sync + 'static,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        auth.validate()?;
        let conn = Connection::connect_with_options(
            ConnectionOptions {
                url: url.to_string(),
                peer,
                implements,
                auth_username: auth.username,
                auth_password: auth.password,
                auth_token: auth.token,
                limits,
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
            if let Some(error) = response.error {
                return Err(Box::new(GatewayRpcError::new(
                    call.to_string(),
                    error.code,
                    error.message,
                    error.details,
                )));
            }
            return Err(Box::new(GatewayRpcError::new(
                call.to_string(),
                500,
                "Unknown RPC failure",
                None,
            )));
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
        pid: &str,
        message: &str,
    ) -> Result<ProcSendResult, Box<dyn std::error::Error>> {
        let args = json!({ "pid": pid, "message": message });

        let payload = self.request_ok("proc.send", Some(args)).await?;
        let result: ProcSendResult = serde_json::from_value(payload)?;

        if !result.ok {
            return Err("proc.send failed".into());
        }

        Ok(result)
    }

    pub async fn conversation_for_process(
        &self,
        pid: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let payload = self
            .request_ok("conversation.forProcess", Some(json!({ "pid": pid })))
            .await?;
        payload
            .get("conversation")
            .and_then(|conversation| conversation.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "conversation.forProcess returned no conversation id".into())
    }

    pub async fn conversation_send(
        &self,
        conversation_id: &str,
        message: &str,
        idempotency_key: &str,
    ) -> Result<ProcSendResult, Box<dyn std::error::Error>> {
        self.conversation_send_with_resources(conversation_id, message, &[], idempotency_key)
            .await
    }

    pub async fn conversation_send_with_resources(
        &self,
        conversation_id: &str,
        message: &str,
        resources: &[ConversationFileResource],
        idempotency_key: &str,
    ) -> Result<ProcSendResult, Box<dyn std::error::Error>> {
        let payload = self
            .request_ok(
                "conversation.send",
                Some(conversation_send_args(
                    conversation_id,
                    message,
                    resources,
                    idempotency_key,
                )),
            )
            .await?;
        let run_id = payload
            .get("runId")
            .and_then(Value::as_str)
            .ok_or("conversation.send returned no run id")?;
        let queued = payload
            .get("queued")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(ProcSendResult {
            ok: true,
            status: if queued { "queued" } else { "started" }.to_string(),
            run_id: run_id.to_string(),
            queued,
            error: None,
        })
    }
}

fn conversation_send_args(
    conversation_id: &str,
    message: &str,
    resources: &[ConversationFileResource],
    idempotency_key: &str,
) -> Value {
    let mut args = json!({
        "conversationId": conversation_id,
        "text": message,
        "idempotencyKey": idempotency_key,
    });
    if !resources.is_empty() {
        args["media"] = Value::Array(
            resources
                .iter()
                .map(|resource| {
                    json!({
                        "type": "resource",
                        "ref": {
                            "type": "file",
                            "target": resource.target,
                            "path": resource.path,
                            "revision": resource.revision,
                            "contentType": resource.content_type,
                            "size": resource.size,
                        },
                        "mediaType": media_type(&resource.content_type),
                        "filename": resource.filename,
                    })
                })
                .collect(),
        );
    }
    args
}

fn media_type(content_type: &str) -> &'static str {
    if content_type.starts_with("image/") {
        "image"
    } else if content_type.starts_with("audio/") {
        "audio"
    } else if content_type.starts_with("video/") {
        "video"
    } else {
        "document"
    }
}

#[cfg(test)]
mod tests {
    use super::{conversation_send_args, ConversationFileResource};
    use serde_json::json;

    #[test]
    fn conversation_resources_use_the_canonical_resource_shape() {
        let args = conversation_send_args(
            "conversation-one",
            "review @notes.md",
            &[ConversationFileResource {
                target: "macbook".to_string(),
                path: "/Users/sam/notes.md".to_string(),
                revision: "mtime:42".to_string(),
                content_type: "text/markdown".to_string(),
                size: 512,
                filename: "notes.md".to_string(),
            }],
            "once",
        );

        assert_eq!(
            args,
            json!({
                "conversationId": "conversation-one",
                "text": "review @notes.md",
                "idempotencyKey": "once",
                "media": [{
                    "type": "resource",
                    "ref": {
                        "type": "file",
                        "target": "macbook",
                        "path": "/Users/sam/notes.md",
                        "revision": "mtime:42",
                        "contentType": "text/markdown",
                        "size": 512,
                    },
                    "mediaType": "document",
                    "filename": "notes.md",
                }],
            })
        );
    }

    #[test]
    fn text_only_conversation_send_omits_media() {
        let args = conversation_send_args("conversation-one", "hello", &[], "once");
        assert!(args.get("media").is_none());
    }
}
