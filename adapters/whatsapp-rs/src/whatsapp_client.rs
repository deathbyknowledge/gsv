use crate::platform::{WorkerHttpClient, WorkerRuntime, WorkerWebSocketTransportFactory};
use crate::store::SqliteWhatsAppStore;
use crate::types::{
    ChannelMedia, ChannelOutboundMessage, MediaType as ChannelMediaType, ReactRequest,
    TypingRequest,
};
use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use js_sys::{Function, Reflect, Uint8Array};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wacore::download::MediaType as WhatsAppMediaType;
use wacore::proto_helpers::MessageExt;
use wacore::runtime::Runtime;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use whatsapp_rust::bot::{Bot, BotHandle};
use whatsapp_rust::types::events::Event;
use whatsapp_rust::types::message::MessageInfo;
use whatsapp_rust::waproto::whatsapp as wa;
use whatsapp_rust::{Client, Jid, UploadOptions};
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
                            let message = message.clone();
                            let info = info.clone();
                            wasm_bindgen_futures::spawn_local(async move {
                                let media = match download_inbound_media(&client, &message).await {
                                    Ok(media) => media,
                                    Err(error) => {
                                        worker::console_error!(
                                            "[whatsapp-rs] media download failed: {}",
                                            error
                                        );
                                        Vec::new()
                                    }
                                };
                                if let Some(text) = extract_text(&message).or_else(|| {
                                    if media.is_empty() {
                                        media_placeholder(&message)
                                    } else {
                                        Some("[Media]".to_string())
                                    }
                                }) {
                                    let message = InboundMessage::from_whatsapp(
                                        &account_id,
                                        &message,
                                        &info,
                                        text,
                                        media,
                                    );
                                    if let Err(error) = forward_inbound(env, message, client).await
                                    {
                                        worker::console_error!(
                                            "[whatsapp-rs] adapter.inbound failed: {}",
                                            error
                                        );
                                    }
                                }
                            });
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
        let jid = normalize_outbound_jid(&message.peer.id)?;
        let outgoing = self.build_outbound_message(&message).await?;
        let sent = self
            .inner
            .client
            .send_message(jid, outgoing)
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

    async fn build_outbound_message(
        &self,
        message: &ChannelOutboundMessage,
    ) -> Result<wa::Message> {
        if let Some(media) = message.media.first() {
            return build_media_message(&self.inner.client, media, message.text.trim()).await;
        }

        let text = message.text.trim();
        if text.is_empty() {
            return Err(anyhow!("WhatsApp messages require text or media"));
        }

        Ok(wa::Message {
            conversation: Some(text.to_string()),
            ..Default::default()
        })
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
    actor_jid: String,
    is_group: bool,
    push_name: Option<String>,
    text: String,
    media: Vec<Value>,
    timestamp: i64,
}

impl InboundMessage {
    fn from_whatsapp(
        account_id: &str,
        _message: &wa::Message,
        info: &MessageInfo,
        text: String,
        media: Vec<Value>,
    ) -> Self {
        Self {
            account_id: account_id.to_string(),
            message_id: info.id.clone(),
            chat_jid: stable_chat_jid(info),
            actor_jid: stable_actor_jid(info),
            is_group: info.source.is_group,
            push_name: if info.push_name.trim().is_empty() {
                None
            } else {
                Some(info.push_name.clone())
            },
            text,
            media,
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
                        "id": format!("wa:jid:{}", self.actor_jid),
                        "name": self.push_name,
                        "handle": format!("wa:jid:{}", self.actor_jid)
                    },
                    "text": self.text,
                    "media": self.media,
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
    let base = message.get_base_message();
    base.conversation
        .clone()
        .or_else(|| {
            base.extended_text_message
                .as_ref()
                .and_then(|value| value.text.clone())
        })
        .or_else(|| {
            base.image_message
                .as_ref()
                .and_then(|value| value.caption.clone())
        })
        .or_else(|| {
            base.video_message
                .as_ref()
                .and_then(|value| value.caption.clone())
        })
        .or_else(|| {
            base.document_message
                .as_ref()
                .and_then(|value| value.caption.clone())
        })
        .filter(|value| !value.trim().is_empty())
}

fn media_placeholder(message: &wa::Message) -> Option<String> {
    let base = message.get_base_message();
    if base.image_message.is_some()
        || base.video_message.is_some()
        || base.audio_message.is_some()
        || base.document_message.is_some()
        || base.sticker_message.is_some()
    {
        Some("[Media unavailable]".to_string())
    } else {
        None
    }
}

async fn build_media_message(
    client: &Client,
    media: &ChannelMedia,
    caption: &str,
) -> Result<wa::Message> {
    let (bytes, fetched_mime) = load_media_bytes(media).await?;
    if bytes.is_empty() {
        return Err(anyhow!("WhatsApp media attachment is empty"));
    }

    let media_type = to_whatsapp_media_type(&media.media_type);
    let upload = client
        .upload(bytes, media_type, UploadOptions::new())
        .await
        .context("upload WhatsApp media")?;
    let mimetype = effective_mimetype(media, fetched_mime.as_deref());
    let caption = (!caption.is_empty()).then(|| caption.to_string());

    Ok(match media.media_type {
        ChannelMediaType::Image => wa::Message {
            image_message: Some(Box::new(wa::message::ImageMessage {
                url: Some(upload.url.clone()),
                mimetype: Some(mimetype),
                caption,
                file_sha256: Some(upload.file_sha256_vec()),
                file_length: Some(upload.file_length),
                media_key: Some(upload.media_key_vec()),
                file_enc_sha256: Some(upload.file_enc_sha256_vec()),
                direct_path: Some(upload.direct_path.clone()),
                media_key_timestamp: Some(upload.media_key_timestamp),
                ..Default::default()
            })),
            ..Default::default()
        },
        ChannelMediaType::Video => wa::Message {
            video_message: Some(Box::new(wa::message::VideoMessage {
                url: Some(upload.url.clone()),
                mimetype: Some(mimetype),
                caption,
                file_sha256: Some(upload.file_sha256_vec()),
                file_length: Some(upload.file_length),
                media_key: Some(upload.media_key_vec()),
                file_enc_sha256: Some(upload.file_enc_sha256_vec()),
                direct_path: Some(upload.direct_path.clone()),
                media_key_timestamp: Some(upload.media_key_timestamp),
                ..Default::default()
            })),
            ..Default::default()
        },
        ChannelMediaType::Audio => wa::Message {
            audio_message: Some(Box::new(wa::message::AudioMessage {
                url: Some(upload.url.clone()),
                mimetype: Some(mimetype),
                file_sha256: Some(upload.file_sha256_vec()),
                file_length: Some(upload.file_length),
                media_key: Some(upload.media_key_vec()),
                file_enc_sha256: Some(upload.file_enc_sha256_vec()),
                direct_path: Some(upload.direct_path.clone()),
                media_key_timestamp: Some(upload.media_key_timestamp),
                ..Default::default()
            })),
            ..Default::default()
        },
        ChannelMediaType::Document => wa::Message {
            document_message: Some(Box::new(wa::message::DocumentMessage {
                url: Some(upload.url.clone()),
                mimetype: Some(mimetype),
                title: media.filename.clone(),
                file_sha256: Some(upload.file_sha256_vec()),
                file_length: Some(upload.file_length),
                media_key: Some(upload.media_key_vec()),
                file_name: media
                    .filename
                    .clone()
                    .or_else(|| filename_from_url(media.url.as_deref()))
                    .or_else(|| Some("attachment".to_string())),
                file_enc_sha256: Some(upload.file_enc_sha256_vec()),
                direct_path: Some(upload.direct_path.clone()),
                media_key_timestamp: Some(upload.media_key_timestamp),
                caption,
                ..Default::default()
            })),
            ..Default::default()
        },
    })
}

async fn download_inbound_media(client: &Client, message: &wa::Message) -> Result<Vec<Value>> {
    let base = message.get_base_message();
    let mut media = Vec::new();

    if let Some(image) = base.image_message.as_ref() {
        let bytes = client
            .download(image.as_ref())
            .await
            .context("download WhatsApp image")?;
        media.push(media_attachment(
            "image",
            image.mimetype.as_deref().unwrap_or("image/jpeg"),
            image.caption.clone(),
            image.file_length,
            bytes,
        ));
    }
    if let Some(video) = base.video_message.as_ref() {
        let bytes = client
            .download(video.as_ref())
            .await
            .context("download WhatsApp video")?;
        media.push(media_attachment(
            "video",
            video.mimetype.as_deref().unwrap_or("video/mp4"),
            video.caption.clone(),
            video.file_length,
            bytes,
        ));
    }
    if let Some(audio) = base.audio_message.as_ref() {
        let bytes = client
            .download(audio.as_ref())
            .await
            .context("download WhatsApp audio")?;
        media.push(media_attachment(
            "audio",
            audio.mimetype.as_deref().unwrap_or("audio/ogg"),
            None,
            audio.file_length,
            bytes,
        ));
    }
    if let Some(document) = base.document_message.as_ref() {
        let bytes = client
            .download(document.as_ref())
            .await
            .context("download WhatsApp document")?;
        media.push(media_attachment(
            "document",
            document
                .mimetype
                .as_deref()
                .unwrap_or("application/octet-stream"),
            document.file_name.clone(),
            document.file_length,
            bytes,
        ));
    }
    if let Some(sticker) = base.sticker_message.as_ref() {
        let bytes = client
            .download(sticker.as_ref())
            .await
            .context("download WhatsApp sticker")?;
        media.push(media_attachment(
            "image",
            sticker.mimetype.as_deref().unwrap_or("image/webp"),
            None,
            sticker.file_length,
            bytes,
        ));
    }

    Ok(media)
}

fn media_attachment(
    media_type: &str,
    mime_type: &str,
    filename: Option<String>,
    size: Option<u64>,
    bytes: Vec<u8>,
) -> Value {
    json!({
        "type": media_type,
        "mimeType": mime_type,
        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        "filename": filename,
        "size": size
    })
}

async fn load_media_bytes(media: &ChannelMedia) -> Result<(Vec<u8>, Option<String>)> {
    if let Some(data) = media
        .data
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let (mime, payload) = split_data_url(data);
        let compact = payload
            .chars()
            .filter(|ch| !ch.is_ascii_whitespace())
            .collect::<String>();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(compact.as_bytes())
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(compact.as_bytes()))
            .context("decode media base64 payload")?;
        return Ok((bytes, mime.map(str::to_string)));
    }

    if let Some(url) = media
        .url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return fetch_url_bytes(url).await;
    }

    Err(anyhow!("WhatsApp media requires either data or url"))
}

async fn fetch_url_bytes(url: &str) -> Result<(Vec<u8>, Option<String>)> {
    let req = web_sys::Request::new_with_str(url).map_err(js_error)?;
    let global = js_sys::global();
    let fetch = Reflect::get(&global, &JsValue::from_str("fetch"))
        .map_err(js_error)?
        .dyn_into::<Function>()
        .map_err(|_| anyhow!("global fetch is not callable"))?;
    let response = JsFuture::from(
        fetch
            .call1(&global, req.as_ref())
            .map_err(js_error)?
            .dyn_into::<js_sys::Promise>()
            .map_err(|_| anyhow!("fetch did not return a Promise"))?,
    )
    .await
    .map_err(js_error)?
    .dyn_into::<web_sys::Response>()
    .map_err(|_| anyhow!("fetch did not resolve to a Response"))?;

    if !response.ok() {
        return Err(anyhow!(
            "fetch media failed: HTTP {} {}",
            response.status(),
            response.status_text()
        ));
    }
    let mime = response.headers().get("content-type").map_err(js_error)?;
    let body = JsFuture::from(response.array_buffer().map_err(js_error)?)
        .await
        .map_err(js_error)
        .context("read media response body")?;
    Ok((Uint8Array::new(&body).to_vec(), mime))
}

fn split_data_url(data: &str) -> (Option<&str>, &str) {
    let Some(rest) = data.strip_prefix("data:") else {
        return (None, data);
    };
    let Some((meta, payload)) = rest.split_once(',') else {
        return (None, data);
    };
    let mime = meta
        .split(';')
        .next()
        .filter(|value| !value.trim().is_empty());
    (mime, payload)
}

fn to_whatsapp_media_type(media_type: &ChannelMediaType) -> WhatsAppMediaType {
    match media_type {
        ChannelMediaType::Image => WhatsAppMediaType::Image,
        ChannelMediaType::Video => WhatsAppMediaType::Video,
        ChannelMediaType::Audio => WhatsAppMediaType::Audio,
        ChannelMediaType::Document => WhatsAppMediaType::Document,
    }
}

fn effective_mimetype(media: &ChannelMedia, fetched_mime: Option<&str>) -> String {
    if !media.mime_type.trim().is_empty() && media.mime_type != "application/octet-stream" {
        return media.mime_type.trim().to_string();
    }
    if let Some(mime) = fetched_mime.filter(|value| !value.trim().is_empty()) {
        return mime.trim().to_string();
    }
    if let Some(mime) = media
        .filename
        .as_deref()
        .and_then(guess_mimetype_from_name)
        .or_else(|| media.url.as_deref().and_then(guess_mimetype_from_name))
    {
        return mime.to_string();
    }
    match media.media_type {
        ChannelMediaType::Image => "image/jpeg",
        ChannelMediaType::Video => "video/mp4",
        ChannelMediaType::Audio => "audio/mpeg",
        ChannelMediaType::Document => "application/octet-stream",
    }
    .to_string()
}

fn guess_mimetype_from_name(name: &str) -> Option<&'static str> {
    let lower = name.split('?').next().unwrap_or(name).to_ascii_lowercase();
    let extension = lower.rsplit('.').next()?;
    match extension {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "mp4" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "ogg" | "opus" => Some("audio/ogg"),
        "wav" => Some("audio/wav"),
        "m4a" => Some("audio/mp4"),
        "pdf" => Some("application/pdf"),
        "txt" => Some("text/plain"),
        "json" => Some("application/json"),
        "csv" => Some("text/csv"),
        "zip" => Some("application/zip"),
        _ => None,
    }
}

fn filename_from_url(url: Option<&str>) -> Option<String> {
    let path = url?.split('?').next().unwrap_or_default();
    let name = path.rsplit('/').next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn js_error(value: JsValue) -> anyhow::Error {
    if let Some(message) = value.as_string() {
        anyhow!(message)
    } else {
        anyhow!("{value:?}")
    }
}

fn normalize_outbound_jid(input: &str) -> Result<Jid> {
    let raw = input.trim().strip_prefix("wa:jid:").unwrap_or(input.trim());
    if raw.is_empty() {
        return Err(anyhow!("missing WhatsApp JID or phone number"));
    }
    let normalized = if raw.contains('@') {
        normalize_whatsapp_jid(raw).unwrap_or_else(|| raw.to_ascii_lowercase())
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

fn stable_chat_jid(info: &MessageInfo) -> String {
    if info.source.is_group {
        normalize_whatsapp_jid(&info.source.chat.to_string())
            .unwrap_or_else(|| info.source.chat.to_string())
    } else {
        stable_actor_jid(info)
    }
}

fn stable_actor_jid(info: &MessageInfo) -> String {
    if let Some(sender_alt) = info.source.sender_alt.as_ref() {
        let value = sender_alt.to_string();
        if is_phone_jid(&value) {
            if let Some(normalized) = normalize_whatsapp_jid(&value) {
                return normalized;
            }
        }
    }

    let sender = info.source.sender.to_string();
    normalize_whatsapp_jid(&sender).unwrap_or(sender)
}

fn normalize_whatsapp_jid(input: &str) -> Option<String> {
    let raw = input.trim().strip_prefix("wa:jid:").unwrap_or(input.trim());
    let (user, server) = raw.split_once('@')?;
    let user = user.split(':').next()?.to_ascii_lowercase();
    let server = server.to_ascii_lowercase();
    if user.is_empty() || server.is_empty() {
        return None;
    }
    Some(format!("{user}@{server}"))
}

fn is_phone_jid(input: &str) -> bool {
    let Some((user, server)) = input.trim().split_once('@') else {
        return false;
    };
    let user = user.split(':').next().unwrap_or_default();
    server.eq_ignore_ascii_case("s.whatsapp.net")
        && !user.is_empty()
        && user.chars().all(|ch| ch.is_ascii_digit())
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
