use crate::platform::{WorkerHttpClient, WorkerRuntime, WorkerWebSocketTransportFactory};
use crate::store::SqliteWhatsAppStore;
use crate::types::{ChannelOutboundMessage, ReactRequest, TypingRequest};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wacore::runtime::Runtime;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use whatsapp_rust::bot::{Bot, BotHandle};
use whatsapp_rust::types::events::Event;
use whatsapp_rust::types::message::MessageInfo;
use whatsapp_rust::waproto::whatsapp as wa;
use whatsapp_rust::{Client, Jid};
use worker::{Env, SqlStorage};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(extends = js_sys::Object)]
    #[derive(Clone)]
    type GatewayRpc;

    #[wasm_bindgen(method, js_name = serviceFrame, catch)]
    fn service_frame(
        this: &GatewayRpc,
        frame: JsValue,
    ) -> std::result::Result<js_sys::Promise, JsValue>;
}

#[derive(Debug, Clone, Default)]
pub struct WorkerWhatsAppSnapshot {
    pub connected: bool,
    pub authenticated: bool,
    pub qr: Option<String>,
    pub self_jid: Option<String>,
    pub self_e164: Option<String>,
    pub last_connected_at: Option<i64>,
    pub last_disconnected_at: Option<i64>,
    pub last_message_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct WorkerWhatsAppClient {
    inner: Arc<WorkerWhatsAppClientInner>,
}

struct WorkerWhatsAppClientInner {
    client: Arc<Client>,
    snapshot: Arc<Mutex<WorkerWhatsAppSnapshot>>,
    handle: BotHandle,
}

impl WorkerWhatsAppClient {
    pub async fn start(account_id: &str, env: Env, sql: SqlStorage) -> Result<Self> {
        let snapshot = Arc::new(Mutex::new(WorkerWhatsAppSnapshot::default()));
        let event_snapshot = Arc::clone(&snapshot);
        let event_account_id = account_id.to_string();

        let mut bot = Bot::builder()
            .with_backend(Arc::new(SqliteWhatsAppStore::new(sql)))
            .with_transport_factory(WorkerWebSocketTransportFactory)
            .with_http_client(WorkerHttpClient)
            .with_runtime(WorkerRuntime)
            .with_push_name(format!("GSV {account_id}"))
            .skip_history_sync()
            .on_event(move |event, client| {
                let event_snapshot = Arc::clone(&event_snapshot);
                let env = env.clone();
                let account_id = event_account_id.clone();
                async move {
                    update_snapshot_from_event(&event_snapshot, &event);
                    if let Some((message, info)) = event.as_message() {
                        if !info.source.is_from_me {
                            if let Some(text) = extract_text(message) {
                                let message =
                                    InboundMessage::from_whatsapp(&account_id, message, info, text);
                                wasm_bindgen_futures::spawn_local(async move {
                                    if let Err(error) = forward_inbound(env, message, client).await
                                    {
                                        worker::console_error!(
                                            "[whatsapp-rs] adapter.inbound failed: {}",
                                            error
                                        );
                                    }
                                });
                            }
                        }
                    }
                }
            })
            .build()
            .await
            .context("build whatsapp-rust bot")?;

        let client = bot.client();
        let handle = bot.run().await.context("start whatsapp-rust bot")?;

        Ok(Self {
            inner: Arc::new(WorkerWhatsAppClientInner {
                client,
                snapshot,
                handle,
            }),
        })
    }

    pub fn snapshot(&self) -> WorkerWhatsAppSnapshot {
        let mut snapshot = self
            .inner
            .snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        snapshot.connected = self.inner.client.is_connected();
        snapshot.authenticated = self.inner.client.is_logged_in();
        snapshot
    }

    pub async fn wait_for_login_challenge(&self, timeout: Duration) -> WorkerWhatsAppSnapshot {
        let started_at = js_sys::Date::now();
        let runtime = WorkerRuntime;
        loop {
            let snapshot = self.snapshot();
            if snapshot.connected && snapshot.authenticated || snapshot.qr.is_some() {
                return snapshot;
            }
            if js_sys::Date::now() - started_at >= timeout.as_millis() as f64 {
                return snapshot;
            }
            runtime.sleep(Duration::from_millis(250)).await;
        }
    }

    pub async fn stop(&self) {
        self.inner.handle.abort();
    }

    pub async fn send(&self, message: ChannelOutboundMessage) -> Result<String> {
        if !message.media.is_empty() {
            return Err(anyhow!(
                "media sending is not wired in the Rust WhatsApp adapter yet"
            ));
        }

        let text = message.text.trim();
        if text.is_empty() {
            return Err(anyhow!("WhatsApp messages require text or media"));
        }

        let jid = normalize_outbound_jid(&message.peer.id)?;
        let sent = self
            .inner
            .client
            .send_message(
                jid,
                wa::Message {
                    conversation: Some(text.to_string()),
                    ..Default::default()
                },
            )
            .await
            .context("send WhatsApp message")?;
        Ok(sent.message_id)
    }

    pub async fn react(&self, request: ReactRequest) -> Result<()> {
        let jid = normalize_outbound_jid(&request.peer.id)?;
        let participant = match request.participant.as_deref() {
            Some(value) if !value.trim().is_empty() => {
                Some(normalize_outbound_jid(value)?.to_string())
            }
            _ => None,
        };
        let message = wa::Message {
            reaction_message: Some(wa::message::ReactionMessage {
                key: Some(wa::MessageKey {
                    remote_jid: Some(jid.to_string()),
                    from_me: Some(false),
                    id: Some(request.message_id),
                    participant,
                }),
                text: Some(request.emoji),
                sender_timestamp_ms: Some(now_ms()),
                ..Default::default()
            }),
            ..Default::default()
        };
        self.inner
            .client
            .send_message(jid, message)
            .await
            .context("send WhatsApp reaction")?;
        Ok(())
    }

    pub async fn set_typing(&self, request: TypingRequest) -> Result<()> {
        let jid = normalize_outbound_jid(&request.peer.id)?;
        if request.typing {
            self.inner.client.chatstate().send_composing(&jid).await?;
        } else {
            self.inner.client.chatstate().send_paused(&jid).await?;
        }
        Ok(())
    }
}

fn update_snapshot_from_event(snapshot: &Arc<Mutex<WorkerWhatsAppSnapshot>>, event: &Event) {
    let mut snapshot = snapshot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match event {
        Event::Connected(_) => {
            snapshot.connected = true;
            snapshot.last_connected_at = Some(now_ms());
            snapshot.last_error = None;
        }
        Event::Disconnected(_) => {
            snapshot.connected = false;
            snapshot.last_disconnected_at = Some(now_ms());
        }
        Event::LoggedOut(_) => {
            snapshot.connected = false;
            snapshot.authenticated = false;
            snapshot.self_jid = None;
            snapshot.self_e164 = None;
            snapshot.last_disconnected_at = Some(now_ms());
        }
        Event::PairSuccess(success) => {
            snapshot.authenticated = true;
            snapshot.connected = true;
            snapshot.qr = None;
            snapshot.self_jid = Some(success.id.to_string());
            snapshot.self_e164 = e164_from_jid(&success.id.to_string());
            snapshot.last_connected_at = Some(now_ms());
            snapshot.last_error = None;
        }
        Event::PairingQrCode { code, .. } => {
            snapshot.qr = Some(code.clone());
        }
        Event::PairError(error) => {
            snapshot.last_error = Some(error.error.clone());
        }
        Event::ConnectFailure(error) => {
            snapshot.connected = false;
            snapshot.last_error = Some(format!("{:?}", error.reason));
        }
        Event::StreamError(error) => {
            snapshot.last_error = Some(format!("{error:?}"));
        }
        Event::Message(_, _) => {
            snapshot.last_message_at = Some(now_ms());
        }
        _ => {}
    }
}

struct InboundMessage {
    account_id: String,
    message_id: String,
    chat_jid: String,
    sender_jid: String,
    is_group: bool,
    push_name: Option<String>,
    text: String,
    timestamp: i64,
}

impl InboundMessage {
    fn from_whatsapp(
        account_id: &str,
        _message: &wa::Message,
        info: &MessageInfo,
        text: String,
    ) -> Self {
        Self {
            account_id: account_id.to_string(),
            message_id: info.id.clone(),
            chat_jid: info.source.chat.to_string(),
            sender_jid: info.source.sender.to_string(),
            is_group: info.source.is_group,
            push_name: if info.push_name.trim().is_empty() {
                None
            } else {
                Some(info.push_name.clone())
            },
            text,
            timestamp: info.timestamp.timestamp(),
        }
    }

    fn gateway_frame(&self) -> Value {
        json!({
            "type": "req",
            "id": uuid::Uuid::new_v4().to_string(),
            "call": "adapter.inbound",
            "args": {
                "adapter": "whatsapp",
                "accountId": self.account_id,
                "message": {
                    "messageId": self.message_id,
                    "surface": {
                        "kind": if self.is_group { "group" } else { "dm" },
                        "id": self.chat_jid,
                        "name": self.push_name
                    },
                    "actor": {
                        "id": format!("wa:jid:{}", self.sender_jid),
                        "name": self.push_name,
                        "handle": format!("wa:jid:{}", self.sender_jid)
                    },
                    "text": self.text,
                    "timestamp": self.timestamp
                }
            }
        })
    }
}

async fn forward_inbound(env: Env, inbound: InboundMessage, client: Arc<Client>) -> Result<()> {
    let frame = inbound.gateway_frame();
    let gateway: GatewayRpc = env
        .service("GATEWAY")
        .context("get GATEWAY service binding")?
        .into_rpc();
    let frame = serde_wasm_bindgen::to_value(&frame).context("serialize gateway frame")?;
    let response = JsFuture::from(gateway.service_frame(frame).map_err(js_error)?)
        .await
        .map_err(js_error)
        .context("call gateway serviceFrame")?;
    let response: Value =
        serde_wasm_bindgen::from_value(response).context("decode gateway response")?;
    if !response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let error = response
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| response.get("error").and_then(Value::as_str))
            .unwrap_or("gateway rejected adapter.inbound");
        return Err(anyhow!(error.to_string()));
    }

    if !inbound.is_group {
        if let Some(prompt) = response
            .pointer("/data/challenge/prompt")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            send_plaintext(&client, &inbound.chat_jid, prompt).await?;
        }
        if let Some(reply) = response
            .pointer("/data/reply/text")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            send_plaintext(&client, &inbound.chat_jid, reply).await?;
        }
    }

    Ok(())
}

async fn send_plaintext(client: &Client, chat_jid: &str, text: &str) -> Result<()> {
    let jid = normalize_outbound_jid(chat_jid)?;
    client
        .send_message(
            jid,
            wa::Message {
                conversation: Some(text.to_string()),
                ..Default::default()
            },
        )
        .await?;
    Ok(())
}

fn extract_text(message: &wa::Message) -> Option<String> {
    message
        .conversation
        .clone()
        .or_else(|| {
            message
                .extended_text_message
                .as_ref()
                .and_then(|value| value.text.clone())
        })
        .or_else(|| {
            message
                .image_message
                .as_ref()
                .and_then(|value| value.caption.clone())
        })
        .or_else(|| {
            message
                .video_message
                .as_ref()
                .and_then(|value| value.caption.clone())
        })
        .filter(|value| !value.trim().is_empty())
}

fn js_error(value: JsValue) -> anyhow::Error {
    if let Some(message) = value.as_string() {
        anyhow!(message)
    } else {
        anyhow!("{value:?}")
    }
}

fn normalize_outbound_jid(input: &str) -> Result<Jid> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(anyhow!("missing WhatsApp JID or phone number"));
    }
    let normalized = if raw.contains('@') {
        raw.to_string()
    } else {
        let digits: String = raw.chars().filter(|ch| ch.is_ascii_digit()).collect();
        if digits.is_empty() {
            return Err(anyhow!("invalid WhatsApp JID or phone number: {raw}"));
        }
        format!("{digits}@s.whatsapp.net")
    };
    normalized
        .parse::<Jid>()
        .with_context(|| format!("invalid WhatsApp JID: {normalized}"))
}

fn e164_from_jid(jid: &str) -> Option<String> {
    let user = jid.split('@').next()?;
    let digits = user
        .split(':')
        .next()?
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        None
    } else {
        Some(format!("+{digits}"))
    }
}

fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}
